import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authHeaders,
  isTransportMismatchStatus,
  parseSseData,
  parseSseEndpoint,
  probeHttp,
  probeMcpServer,
  probeStdio,
  splitCommand,
} from '../../electron/mcpProbe';

/**
 * MCP 连接探针测试。
 *
 * 探针的价值全在"它真的发了请求"这一条上——所以这里**不 mock 传输层**，
 * 而是真的 spawn 一个说 JSON-RPC 的 stub 子进程、真的起一个 HTTP 服务器。
 * mock 掉传输的测试只能证明"函数被调用了"，证明不了握手逻辑对。
 */

// ——————————————————————————————————————————————
// 纯函数
// ——————————————————————————————————————————————

describe('splitCommand: 命令行拆分', () => {
  it('按空白拆分', () => {
    expect(splitCommand('npx -y @playwright/mcp@latest')).toEqual([
      'npx',
      '-y',
      '@playwright/mcp@latest',
    ]);
  });

  it('双引号内保留空格', () => {
    expect(splitCommand('python "C:/my tools/server.py" --port 1')).toEqual([
      'python',
      'C:/my tools/server.py',
      '--port',
      '1',
    ]);
  });

  it('单引号内保留空格', () => {
    expect(splitCommand("node '/tmp/a b.js'")).toEqual(['node', '/tmp/a b.js']);
  });

  it('空引号保留为空参数（不是被丢弃）', () => {
    expect(splitCommand('cmd "" tail')).toEqual(['cmd', '', 'tail']);
  });

  it('引号内的转义引号是字面量', () => {
    expect(splitCommand('cmd "a\\"b"')).toEqual(['cmd', 'a"b']);
  });

  it('多余空白不产生空参数', () => {
    expect(splitCommand('  node   server.js  ')).toEqual(['node', 'server.js']);
  });

  it('空串得到空数组', () => {
    expect(splitCommand('   ')).toEqual([]);
  });
});

describe('parseSseData: SSE 负载提取', () => {
  it('取出单条 data', () => {
    expect(parseSseData('event: message\ndata: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('多条帧各自成项', () => {
    expect(parseSseData('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('多行 data 按规范以换行拼接', () => {
    expect(parseSseData('data: line1\ndata: line2\n\n')).toEqual(['line1\nline2']);
  });

  it('无 data 的帧不产出', () => {
    expect(parseSseData('event: ping\n\n')).toEqual([]);
  });
});

describe('parseSseEndpoint: 老式 HTTP+SSE 的消息地址', () => {
  it('取出 endpoint 事件的 data', () => {
    expect(parseSseEndpoint('event: endpoint\ndata: /messages?session=1\n\n')).toBe(
      '/messages?session=1',
    );
  });

  it('非 endpoint 事件不误取', () => {
    expect(parseSseEndpoint('event: message\ndata: /nope\n\n')).toBeNull();
  });
});

describe('authHeaders: 凭据 → 请求头', () => {
  it('token 映射为 Bearer Authorization', () => {
    expect(authHeaders({ token: 'abc' })).toEqual({ authorization: 'Bearer abc' });
  });

  it('其余键作为同名头（小写）', () => {
    expect(authHeaders({ 'X-Api-Key': 'k' })).toEqual({ 'x-api-key': 'k' });
  });

  it('空值被跳过', () => {
    expect(authHeaders({ token: '', other: 'v' })).toEqual({ other: 'v' });
  });

  it('undefined 得到空对象', () => {
    expect(authHeaders(undefined)).toEqual({});
  });
});

// ——————————————————————————————————————————————
// stdio：对真实子进程握手
// ——————————————————————————————————————————————

/** stub MCP server：按行读 JSON-RPC，回 initialize / tools/list */
const STUB_SERVER = `
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf-8');
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const reply = (payload) =>
      process.stdout.write(JSON.stringify(payload) + '\\n');
    if (msg.method === 'initialize') {
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'stub-server', version: '9.9.9' },
        },
      });
    } else if (msg.method === 'tools/list') {
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            { name: 'echo', description: '回声' },
            { name: 'ping' },
            { name: 42 },
          ],
        },
      });
    }
    // notifications/initialized 无 id，按规范不回复
  }
});
`;

/** 直接退出 / 报错的 stub */
const CRASH_SERVER = `process.stderr.write('boom: missing api key\\n'); process.exit(3);`;

/** 只回 initialize、对 tools/list 静默（模拟卡死） */
const SILENT_SERVER = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n');
    }
  }
});
`;

let tempDir = '';

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanowork-mcp-probe-'));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响断言
  }
});

function writeStub(name: string, source: string): string {
  const file = join(tempDir, `${name}.cjs`);
  writeFileSync(file, source, 'utf-8');
  return file;
}

describe('probeStdio: 真实子进程握手', () => {
  it('成功握手并列出工具（非对象条目被丢弃）', async () => {
    const stub = writeStub('ok', STUB_SERVER);
    const result = await probeStdio({
      command: `"${process.execPath}" "${stub}"`,
      timeoutMs: 15000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('connected');
    expect(result.serverName).toBe('stub-server');
    expect(result.serverVersion).toBe('9.9.9');
    expect(result.tools.map((t) => t.name)).toEqual(['echo', 'ping']);
    expect(result.tools[0].description).toBe('回声');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('无启动命令 → 直接失败而不是挂起', async () => {
    const result = await probeStdio({ command: '   ', timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未配置启动命令');
    expect(result.tools).toEqual([]);
  });

  it('子进程提前退出 → 回传 stderr 摘要', async () => {
    const stub = writeStub('crash', CRASH_SERVER);
    const result = await probeStdio({
      command: `"${process.execPath}" "${stub}"`,
      timeoutMs: 15000,
    });

    expect(result.ok).toBe(false);
    // 关键：stderr 必须带回来，否则界面只能显示"握手失败"，等于没说
    expect(result.error).toContain('boom: missing api key');
  });

  it('命令不存在 → 报启动失败而不是抛异常', async () => {
    const result = await probeStdio({
      command: 'definitely-not-a-real-binary-xyz',
      timeoutMs: 15000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('tools/list 无响应 → 超时且带可读原因', async () => {
    const stub = writeStub('silent', SILENT_SERVER);
    const result = await probeStdio({
      command: `"${process.execPath}" "${stub}"`,
      timeoutMs: 800,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });

  it('凭据作为环境变量注入子进程', async () => {
    const file = join(tempDir, 'env-echo.cjs');
    writeFileSync(
      file,
      `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {
        serverInfo: { name: process.env.MY_TOKEN || 'MISSING' }
      } }) + '\\n');
    } else if (m.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\\n');
    }
  }
});
`,
      'utf-8',
    );

    const result = await probeStdio({
      command: `"${process.execPath}" "${file}"`,
      secrets: { MY_TOKEN: 'injected-token' },
      timeoutMs: 15000,
    });

    expect(result.ok).toBe(true);
    expect(result.serverName).toBe('injected-token');
  });
});

// ——————————————————————————————————————————————
// http：对真实 HTTP 服务器握手
// ——————————————————————————————————————————————

interface HttpStub {
  url: string;
  server: Server;
  close: () => Promise<void>;
  seen: {
    method: string;
    body: { id?: number; method?: string };
    headers: IncomingMessage['headers'];
  }[];
}

/**
 * 起一个 JSON-RPC over HTTP 的 stub；`asSse` 决定响应用 SSE 还是 JSON。
 *
 * 每个请求**先记后判**（含被 `status` 短路掉的）：这样测试才能断言
 * 「客户端没有多做一次无谓的 GET」（老式 SSE 降级只该在 405 类状态码上发生）。
 */
function startHttpStub(options: { asSse?: boolean; status?: number } = {}): Promise<HttpStub> {
  const seen: HttpStub['seen'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const entry: HttpStub['seen'][number] = {
      method: req.method ?? '',
      body: {},
      headers: req.headers,
    };
    seen.push(entry);
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (options.status && options.status >= 400) {
        res.writeHead(options.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
      }
      try {
        entry.body = JSON.parse(raw) as { id?: number; method?: string };
      } catch {
        // 忽略非法 JSON：下面的分支会走"未知方法"
      }
      const body = entry.body;

      const payload =
        body.method === 'initialize'
          ? {
              jsonrpc: '2.0',
              id: body.id,
              result: { protocolVersion: '2024-11-05', serverInfo: { name: 'http-stub' } },
            }
          : {
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: [{ name: 'search' }, { name: 'fetch' }] },
            };

      if (options.asSse) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
        seen,
      });
    });
  });
}

describe('probeHttp: 真实 HTTP 握手', () => {
  it('application/json 响应可解析', async () => {
    const stub = await startHttpStub();
    try {
      const result = await probeHttp({ endpoint: stub.url, timeoutMs: 5000 });
      expect(result.ok).toBe(true);
      expect(result.serverName).toBe('http-stub');
      expect(result.tools.map((t) => t.name)).toEqual(['search', 'fetch']);
      expect(stub.seen).toHaveLength(2);
      expect(stub.seen[0].body.method).toBe('initialize');
      expect(stub.seen[1].body.method).toBe('tools/list');
    } finally {
      await stub.close();
    }
  });

  it('text/event-stream 响应同样可解析（streamableHttp 常两种都回）', async () => {
    const stub = await startHttpStub({ asSse: true });
    try {
      const result = await probeHttp({ endpoint: stub.url, timeoutMs: 5000 });
      expect(result.ok).toBe(true);
      expect(result.tools).toHaveLength(2);
    } finally {
      await stub.close();
    }
  });

  it('凭据以 Authorization: Bearer 发出', async () => {
    const stub = await startHttpStub();
    try {
      await probeHttp({
        endpoint: stub.url,
        secrets: { token: 'secret-token' },
        timeoutMs: 5000,
      });
      expect(stub.seen[0].headers.authorization).toBe('Bearer secret-token');
    } finally {
      await stub.close();
    }
  });

  it('HTTP 405 → 补试一次老式 SSE 仍不通时，ok:false 且保留原状态码', async () => {
    const stub = await startHttpStub({ status: 405 });
    try {
      const result = await probeHttp({ endpoint: stub.url, timeoutMs: 5000 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('405');
    } finally {
      await stub.close();
    }
  });

  it('HTTP 401 不做 SSE 降级（鉴权问题与传输类型无关，重试只是白等一个超时）', async () => {
    const stub = await startHttpStub({ status: 401 });
    try {
      const result = await probeHttp({ endpoint: stub.url, timeoutMs: 5000 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('401');
      // 关键：只有 POST 这一次请求，没有补一发 GET
      expect(stub.seen.map((s) => s.method)).toEqual(['POST']);
    } finally {
      await stub.close();
    }
  });

  it('空地址 → 立即失败', async () => {
    const result = await probeHttp({ endpoint: '', timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未配置地址');
  });

  it('连不上的地址 → 返回错误而不是抛异常', async () => {
    const result = await probeHttp({
      endpoint: 'http://127.0.0.1:1/mcp',
      timeoutMs: 3000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('probeHttp: 老式 HTTP+SSE 降级（2024-11-05）', () => {
  interface LegacyStub {
    url: string;
    close: () => Promise<void>;
  }

  /**
   * 老式 SSE stub：`GET /sse` 建长连接并首推 `event: endpoint`；
   * 对 `/sse` 的 POST 一律 405（老式 server 都是 GET-only），
   * 消息走 `POST /messages` → 202，真正的响应推回那条长连接。
   */
  function startLegacyStub(): Promise<LegacyStub> {
    let stream: ServerResponse | null = null;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        stream = res;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: endpoint\ndata: /messages\n\n');
        return;
      }
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf-8');
      });
      req.on('end', () => {
        if ((req.url ?? '') !== '/messages') {
          // 对 /sse 的 POST：老式端点不认，必须 405 才会触发降级
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'GET only' }));
          return;
        }
        let body: { id?: number; method?: string } = {};
        try {
          body = JSON.parse(raw) as { id?: number; method?: string };
        } catch {
          // 非法 JSON 走未知方法分支
        }
        res.writeHead(202).end();
        const payload =
          body.method === 'initialize'
            ? {
                jsonrpc: '2.0',
                id: body.id,
                result: { protocolVersion: '2024-11-05', serverInfo: { name: 'legacy-stub' } },
              }
            : {
                jsonrpc: '2.0',
                id: body.id,
                result: { tools: [{ name: 'legacy_tool' }] },
              };
        stream?.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      });
    });

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}/sse`,
          close: () =>
            new Promise<void>((done) => {
              stream?.end();
              server.close(() => done());
            }),
        });
      });
    });
  }

  it('POST 405 且 urlType=sse 时降级走 GET 握手并拿到工具', async () => {
    const stub = await startLegacyStub();
    try {
      const result = await probeHttp({
        endpoint: stub.url,
        urlType: 'sse',
        timeoutMs: 8000,
      });
      expect(result.ok).toBe(true);
      expect(result.serverName).toBe('legacy-stub');
      expect(result.tools.map((t) => t.name)).toEqual(['legacy_tool']);
      expect(result.transport).toBe('sse');
    } finally {
      await stub.close();
    }
  });

  it('**未声明** urlType 时也自动降级（用户粘一个 /mcp 就该能用，不该逼他选类型）', async () => {
    const stub = await startLegacyStub();
    try {
      const result = await probeHttp({ endpoint: stub.url, timeoutMs: 8000 });
      expect(result.ok).toBe(true);
      expect(result.tools.map((t) => t.name)).toEqual(['legacy_tool']);
      // 实测结论要回传：调用方据此把配置里的 urlType 写对，否则引擎会用错 client
      expect(result.transport).toBe('sse');
    } finally {
      await stub.close();
    }
  });

  it('**显式**声明 streamableHttp 则不降级（用户已表态，不再发起无谓长连接）', async () => {
    const stub = await startLegacyStub();
    try {
      const result = await probeHttp({
        endpoint: stub.url,
        urlType: 'streamableHttp',
        timeoutMs: 3000,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('405');
    } finally {
      await stub.close();
    }
  });
});

describe('isTransportMismatchStatus: 哪些状态码才值得补试老式 SSE', () => {
  it('「地址不接受 POST」类 → true', () => {
    for (const status of [404, 405, 406, 415, 501]) {
      expect(isTransportMismatchStatus(status)).toBe(true);
    }
  });

  it('鉴权 / 限流 / 参数类 → false（与传输类型无关，重试只会盖掉真实原因）', () => {
    for (const status of [400, 401, 403, 409, 422, 429, 500, 503]) {
      expect(isTransportMismatchStatus(status)).toBe(false);
    }
  });
});

describe('probeMcpServer: 分派', () => {
  it('command 走 stdio（子进程提前退出即失败）', async () => {
    const stub = writeStub('dispatch', CRASH_SERVER);
    const result = await probeMcpServer({
      name: 'x',
      transport: 'command',
      command: `"${process.execPath}" "${stub}"`,
      timeoutMs: 15000,
    });
    expect(result.ok).toBe(false);
  });

  it('url 走 http', async () => {
    const stub = await startHttpStub();
    try {
      const result = await probeMcpServer({
        name: 'x',
        transport: 'url',
        endpoint: stub.url,
        timeoutMs: 5000,
      });
      expect(result.ok).toBe(true);
    } finally {
      await stub.close();
    }
  });
});
