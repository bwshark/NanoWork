import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parsePluginIndex,
  readPluginIndex,
  setPluginEnabledInEngine,
} from '@/ai/runtime/nanobotHttp/plugins';

/**
 * 插件域 HTTP 客户端测试（`/v1/plugins`，FR-3.4）。
 *
 * ## 为什么起真服务器而不是 mock fetch
 *
 * 被测的东西**就是线格式**：URL 怎么拼（`POST /v1/plugins/{name}`）、
 * body 长什么样（`{"action": "enable"}`）、响应怎么解（`data: [...]`）。
 * mock 掉 fetch 只能证明「函数被调用了」，证明不了对方读得懂我们发的东西。
 * 对齐 `tests/electron/mcpProbe.test.ts` 的做法（那条纪律写在门禁 skill §7.9）。
 *
 * ## 两条必须钉住的失败语义
 *
 * 1. **读侧绝不抛异常**——「网关没起」是常态，抛出去会让整个插件页崩掉；
 * 2. **写侧 409 不是服务端故障**——引擎拒绝签发激活标记（包内容被换过），
 *    用户可自解，文案必须与 500 区分开。
 */

/** 服务器记录下来的请求，供断言线格式 */
interface Recorded {
  method: string;
  url: string;
  body: string;
}

let server: Server;
let baseUrl = '';
let recorded: Recorded[] = [];
/** 由各用例设置的响应策略 */
let respond: (req: Recorded, res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      const entry: Recorded = { method: req.method ?? '', url: req.url ?? '', body };
      recorded.push(entry);
      respond(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function ctx(timeoutMs?: number) {
  return { endpoint: baseUrl, headers: { Authorization: 'Bearer t' }, timeoutMs };
}

function reset(strategy: (req: Recorded, res: ServerResponse) => void): void {
  recorded = [];
  respond = strategy;
}

// ---------------------------------------------------------------------------
// parsePluginIndex：响应体解析
// ---------------------------------------------------------------------------

describe('parsePluginIndex', () => {
  it('解析 data 数组，字段缺失一律降级（不猜测）', () => {
    const entries = parsePluginIndex({
      object: 'list',
      data: [
        {
          name: 'demo-plugin',
          displayName: '演示插件',
          description: '说明',
          category: 'Development',
          enabled: true,
          mcpServers: ['demo--fs'],
        },
        { name: 'bare' },
      ],
    });

    // 引擎说不上来源时归一成 null（空串 → null），而不是渲染一个空的「市场」后缀
    expect(entries).toEqual([
      {
        name: 'demo-plugin',
        displayName: '演示插件',
        description: '说明',
        category: 'Development',
        enabled: true,
        mcpServers: ['demo--fs'],
        market: null,
        version: null,
        hooks: { active: 0, events: {}, dropped: 0 },
      },
      // displayName 回落 name，其余降级成空串 / false / 空数组
      {
        name: 'bare',
        displayName: 'bare',
        description: '',
        category: '',
        enabled: false,
        mcpServers: [],
        market: null,
        version: null,
        hooks: { active: 0, events: {}, dropped: 0 },
      },
    ]);
  });

  it('非对象 / data 不是数组 → 空数组', () => {
    expect(parsePluginIndex(null)).toEqual([]);
    expect(parsePluginIndex({ data: 'nope' })).toEqual([]);
    expect(parsePluginIndex({ object: 'list' })).toEqual([]);
  });

  it('没有 name 的条目被丢掉（无法寻址的条目渲染出来是幽灵卡片）', () => {
    expect(parsePluginIndex({ data: [{ enabled: true }, { name: 'ok' }] })).toHaveLength(1);
  });

  it('mcpServers 里的非字符串元素被过滤', () => {
    const entries = parsePluginIndex({ data: [{ name: 'p', mcpServers: ['a', 1, null] }] });
    expect(entries[0]?.mcpServers).toEqual(['a']);
  });

  // FR-3.6：钩子生效情况。**缺字段一律归 0，不从「磁盘上有 hooks 文件」推断** ——
  // 猜一个「已生效」比不显示更糟：用户会据此以为插件在管着他。
  it('hooks 缺失 → 全 0（不猜「已生效」）', () => {
    const entries = parsePluginIndex({ data: [{ name: 'p' }] });
    expect(entries[0]?.hooks).toEqual({ active: 0, events: {}, dropped: 0 });
  });

  it('hooks 按事件分布解析，非法计数归 0 且不保留空项', () => {
    const entries = parsePluginIndex({
      data: [
        {
          name: 'p',
          hooks: {
            active: 2,
            events: { before_tool: 1, session_start: 1, after_tool: 0, junk: 'x' },
            dropped: -3,
          },
        },
      ],
    });
    expect(entries[0]?.hooks).toEqual({
      active: 2,
      events: { before_tool: 1, session_start: 1 },
      dropped: 0,
    });
  });

  it('hooks 形状不对（数组 / 字符串）→ 全 0，不抛异常', () => {
    for (const hooks of [[], 'nope', 42]) {
      const entries = parsePluginIndex({ data: [{ name: 'p', hooks }] });
      expect(entries[0]?.hooks).toEqual({ active: 0, events: {}, dropped: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// readPluginIndex：读侧
// ---------------------------------------------------------------------------

describe('readPluginIndex', () => {
  it('200 → available=true 并带回条目，且请求打到 /v1/plugins 并带上鉴权头', async () => {
    reset((_req, res) => json(res, 200, { object: 'list', data: [{ name: 'demo', enabled: true }] }));

    const index = await readPluginIndex(ctx());

    expect(index.available).toBe(true);
    expect(index.entries).toHaveLength(1);
    expect(recorded[0]?.method).toBe('GET');
    expect(recorded[0]?.url).toBe('/v1/plugins');
  });

  it('HTTP 500 → available=false 且原因里带状态码（不抛异常）', async () => {
    reset((_req, res) => json(res, 500, { error: 'boom' }));

    const index = await readPluginIndex(ctx());

    expect(index.available).toBe(false);
    expect(index.entries).toEqual([]);
    expect(index.error).toContain('500');
  });

  it('连不上（端口没人听）→ available=false，不抛异常', async () => {
    const index = await readPluginIndex({
      endpoint: 'http://127.0.0.1:1/v1',
      headers: {},
      timeoutMs: 800,
    });

    expect(index.available).toBe(false);
    expect(index.error).toBeTruthy();
  });

  it('超时 → available=false 且提示网关可能未启动', async () => {
    reset(() => {
      // 故意不响应，让客户端超时
    });

    const index = await readPluginIndex(ctx(30));

    expect(index.available).toBe(false);
    expect(index.error).toContain('超时');
  });
});

// ---------------------------------------------------------------------------
// setPluginEnabledInEngine：写侧
// ---------------------------------------------------------------------------

describe('setPluginEnabledInEngine', () => {
  it('enable → POST /v1/plugins/{name}，body 是 {"action":"enable"}', async () => {
    reset((_req, res) => json(res, 200, { ok: true }));

    const outcome = await setPluginEnabledInEngine(ctx(), 'demo-plugin', true);

    expect(outcome.ok).toBe(true);
    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[0]?.url).toBe('/v1/plugins/demo-plugin');
    expect(JSON.parse(recorded[0]?.body ?? '{}')).toEqual({ action: 'enable' });
  });

  it('disable → action 变成 disable', async () => {
    reset((_req, res) => json(res, 200, { ok: true }));

    await setPluginEnabledInEngine(ctx(), 'demo-plugin', false);

    expect(JSON.parse(recorded[0]?.body ?? '{}')).toEqual({ action: 'disable' });
  });

  it('插件名被 URL 编码（名字里理论上不该有特殊字符，但别把路径拼坏）', async () => {
    reset((_req, res) => json(res, 200, { ok: true }));

    await setPluginEnabledInEngine(ctx(), 'a b/c', true);

    expect(recorded[0]?.url).toBe('/v1/plugins/a%20b%2Fc');
  });

  it('409 → 解释成「包内容已变更」，与 500 区分开（不是服务端故障）', async () => {
    reset((_req, res) => json(res, 409, { error: 'plugin changed' }));

    const outcome = await setPluginEnabledInEngine(ctx(), 'demo', true);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('变更');
  });

  it('404 → 说明引擎没找到该插件', async () => {
    reset((_req, res) => json(res, 404, { error: 'unknown' }));

    const outcome = await setPluginEnabledInEngine(ctx(), 'ghost', true);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('引擎未找到');
  });

  it('其他 HTTP 错误 → 带状态码，且不抛异常', async () => {
    reset((_req, res) => json(res, 503, { error: 'no workspace' }));

    const outcome = await setPluginEnabledInEngine(ctx(), 'demo', true);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('503');
  });

  it('超时 → ok=false，不抛异常', async () => {
    reset(() => {});

    const outcome = await setPluginEnabledInEngine(ctx(30), 'demo', true);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('超时');
  });
});
