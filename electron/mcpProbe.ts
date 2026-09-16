/**
 * MCP 连接探针（Electron 主进程）。
 *
 * ## 为什么需要它
 *
 * 渲染层原来根本没有"连接测试"：`mcpStore.testConfig` 只是 `delay(700)` 之后
 * 把状态写成 `connected`——它**从不发起任何请求**，是一句谎话。同时，工具级授权
 * 需要知道"这个 server 到底暴露了哪些工具"，而这个清单只能由一次真实握手给出。
 * 两件事共用一个探针：真实握手 → 拿到 `initialize` 结果与 `tools/list`。
 *
 * ## 覆盖的传输
 *
 * - `command`（stdio）：spawn 子进程，按**行分隔 JSON-RPC** 走
 *   `initialize` → `notifications/initialized` → `tools/list`。
 * - `url`（streamableHttp）：POST JSON-RPC，响应既可能是 `application/json`，
 *   也可能是 `text/event-stream`（同一 POST 里边握手边流式返回），两种都解。
 *   服务器若在响应头给出 `mcp-session-id`，后续请求带上它。
 * - 老式 HTTP+SSE（2024-11-05：`GET` 长连接拿 `event: endpoint` 消息地址，再
 *   POST 过去、响应仍走那条长连接）：POST 若明确失败且配置写的是 `sse`，
 *   降级走一次 GET 握手。
 *
 * ## 两条纪律
 *
 * 1. **绝不抛异常**。探针是给 UI 用的"体检"，任何失败都要变成
 *    `{ ok: false, error }`，让界面能显示原因；抛出去只会变成一个未捕获拒绝。
 * 2. **不读保险库**。凭据由调用方（`main.ts`）解析后通过 `secrets` 传入。
 *    这样本模块不 import `electron`（只 `import type` 契约层），可以直接被单测
 *    覆盖（对齐 `electron/storageRoutes.ts` 的做法）。
 */
import { spawn } from 'node:child_process';
import type {
  McpProbeRequest as McpProbeWireRequest,
  McpProbeResult,
  McpProbeTool,
} from '../src/platform/types';

// 契约层（`src/platform/types.ts`）是探针类型的**唯一声明处**：主进程与渲染层
// 各写一份必然漂移，而漂移的症状是"界面按 A 读、主进程按 B 写"。
// 这里只把主进程侧多出来的 `secrets`（从保险库解析、绝不来自渲染层）扩进来。
export type { McpProbeResult, McpProbeTool };

/** 主进程侧探测请求：线上契约 + 已解析的凭据 */
export type McpProbeRequest = McpProbeWireRequest & {
  /**
   * 已解析的凭据。
   * - stdio：整体作为环境变量注入；
   * - http：`token` 注入 `Authorization: Bearer`，其余键作为同名请求头。
   */
  secrets?: Record<string, string>;
};

/** 默认超时：MCP server 冷启动（npx 拉包）可能偏慢，给到 8s */
export const DEFAULT_MCP_PROBE_TIMEOUT_MS = 8000;

const CLIENT_INFO = { name: 'nanowork', version: '0.1.0' } as const;
/** 探针声明的协议版本：取一个广泛实现的稳定版，避免服务端因版本过新回退 */
const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** 统一的"失败结果"构造，保证 latencyMs 一定存在 */
function failure(startedAt: number, error: string): McpProbeResult {
  return {
    ok: false,
    status: 'error',
    tools: [],
    error,
    latencyMs: Date.now() - startedAt,
  };
}

function success(
  startedAt: number,
  parts: Partial<Omit<McpProbeResult, 'ok' | 'status' | 'latencyMs'>>,
): McpProbeResult {
  return {
    ok: true,
    status: 'connected',
    tools: parts.tools ?? [],
    serverName: parts.serverName,
    serverVersion: parts.serverVersion,
    protocolVersion: parts.protocolVersion,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * 把命令行拆成 `[command, ...args]`。
 *
 * 支持单 / 双引号包裹；引号内的 `\<quote>` 是字面引号。刻意不做完整的 shell
 * 解析（管道、重定向、变量展开一律不认），因为用途是"spawn 一个 MCP server"，
 * 而不是模拟一个 shell。
 */
export function splitCommand(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === '\\' && i + 1 < input.length && input[i + 1] === quote) {
        current += quote;
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      // 进入引号即视为"这一段有内容"，`""` 这类空参要保留
      quote = char;
      hasContent = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasContent) {
        parts.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) parts.push(current);
  return parts;
}

/** 从 JSON-RPC 响应里抽出可读错误 */
function describeRpcError(message: JsonRpcMessage | null): string | null {
  if (!message?.error) return null;
  const code = message.error.code;
  const text = message.error.message ?? '未知错误';
  return typeof code === 'number' ? `服务端返回错误 ${code}：${text}` : `服务端返回错误：${text}`;
}

/** 归一 `initialize` 结果 */
function readInitialize(
  result: unknown,
): { serverName?: string; serverVersion?: string; protocolVersion?: string } {
  if (!result || typeof result !== 'object') return {};
  const payload = result as Record<string, unknown>;
  const serverInfo =
    payload.serverInfo && typeof payload.serverInfo === 'object'
      ? (payload.serverInfo as Record<string, unknown>)
      : {};
  return {
    serverName: typeof serverInfo.name === 'string' ? serverInfo.name : undefined,
    serverVersion: typeof serverInfo.version === 'string' ? serverInfo.version : undefined,
    protocolVersion:
      typeof payload.protocolVersion === 'string' ? payload.protocolVersion : undefined,
  };
}

/** 归一 `tools/list` 结果 */
function readTools(result: unknown): McpProbeTool[] {
  if (!result || typeof result !== 'object') return [];
  const list = (result as Record<string, unknown>).tools;
  if (!Array.isArray(list)) return [];
  const out: McpProbeTool[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.name === '') continue;
    out.push({
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : undefined,
    });
  }
  return out;
}

/** 把一行文本解析为 JSON-RPC 消息；非 JSON / 非对象返回 null */
function parseRpcLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as JsonRpcMessage) : null;
  } catch {
    return null;
  }
}

function messageId(message: JsonRpcMessage): number | null {
  return typeof message.id === 'number' ? message.id : null;
}

/** 从文本中取出 SSE 帧的 `data:` 负载（多行 data 按规范拼接） */
export function parseSseData(chunk: string): string[] {
  const payloads: string[] = [];
  for (const block of chunk.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (dataLines.length > 0) payloads.push(dataLines.join('\n'));
  }
  return payloads;
}

/** 从一段 SSE 文本里抽出 `event: endpoint` 的 data（老式 HTTP+SSE 的消息地址） */
export function parseSseEndpoint(chunk: string): string | null {
  for (const block of chunk.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    if (event !== 'endpoint') continue;
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).replace(/^ /, '').trim();
      if (data) return data;
    }
  }
  return null;
}

// ——————————————————————————————————————————————
// stdio 传输
// ——————————————————————————————————————————————

export interface StdioProbeOptions {
  command: string;
  secrets?: Record<string, string>;
  timeoutMs: number;
}

/**
 * stdio 传输探针。
 *
 * 子进程的 stderr 会被收集起来——MCP server 连不上时错误几乎都写在 stderr，
 * 不回传的话界面只能显示一句"握手失败"，等于没说。
 */
export function probeStdio(options: StdioProbeOptions): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const parts = splitCommand(options.command);
  if (parts.length === 0) {
    return Promise.resolve(failure(startedAt, '未配置启动命令'));
  }
  const [executable, ...args] = parts;

  return new Promise<McpProbeResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let stderrTail = '';
    const pending = new Map<number, (message: JsonRpcMessage) => void>();
    let child: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.clear();
      try {
        child?.kill();
      } catch {
        // 子进程可能已退出；杀不掉不影响结果
      }
      resolve(result);
    };

    const failWith = (error: string) => {
      const detail = stderrTail.trim();
      finish(failure(startedAt, detail ? `${error}（${detail.slice(-300)}）` : error));
    };

    const send = (payload: Record<string, unknown>) => {
      try {
        child?.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        failWith(`写入子进程失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    /**
     * 等待指定 id 的响应。
     *
     * 只挂载 resolver，不自己计时：超时由外层那一个 timer 统一管，
     * 多条 await 各自计时会让"谁先超时"变得不可预测。
     */
    const awaitId = (id: number) =>
      new Promise<JsonRpcMessage>((res) => {
        pending.set(id, res);
      });

    const drainLines = () => {
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = parseRpcLine(line);
        const id = message ? messageId(message) : null;
        if (message && id !== null) {
          const resolver = pending.get(id);
          if (resolver) {
            pending.delete(id);
            resolver(message);
          }
        }
        index = buffer.indexOf('\n');
      }
      // 有些 server 不补行尾换行：缓冲超长时尝试把整段当一条消息解析
      if (buffer.length > 1_000_000) {
        const message = parseRpcLine(buffer);
        const id = message ? messageId(message) : null;
        if (message && id !== null) {
          const resolver = pending.get(id);
          if (resolver) {
            pending.delete(id);
            resolver(message);
          }
          buffer = '';
        }
      }
    };

    try {
      child = spawn(executable, args, {
        // shell: Windows 上 `npx` 实际是 `npx.cmd`，不走 shell 会 ENOENT。
        // 命令与参数由 Node 负责转义，不是把用户输入直接拼进 shell 字符串。
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(options.secrets ?? {}) },
      });
    } catch (err) {
      failWith(`启动命令失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    timer = setTimeout(() => {
      failWith(`连接超时（${options.timeoutMs}ms 内未完成握手）`);
    }, options.timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString('utf-8');
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    child.on('error', (err: Error) => {
      // ENOENT 是最常见的一种：命令写错或工具没装
      failWith(`启动命令失败：${err.message}`);
    });

    child.on('exit', (code: number | null) => {
      if (!settled) failWith(`MCP server 进程提前退出（exit=${code ?? 'null'}）`);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      drainLines();
    });

    void (async () => {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      });
      const initMessage = await awaitId(1);
      if (settled) return;
      if (initMessage.error) {
        failWith(describeRpcError(initMessage) ?? 'initialize 失败');
        return;
      }
      const init = readInitialize(initMessage.result);

      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const toolMessage = await awaitId(2);
      if (settled) return;
      // 能握手但列不出工具：连接本身是通的，如实标记失败原因即可
      if (toolMessage.error) {
        failWith(describeRpcError(toolMessage) ?? 'tools/list 失败');
        return;
      }
      finish(success(startedAt, { ...init, tools: readTools(toolMessage.result) }));
    })().catch((err: unknown) => {
      failWith(`探测异常：${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

// ——————————————————————————————————————————————
// url 传输
// ——————————————————————————————————————————————

interface HttpProbeState {
  /** 服务端在响应头给出的会话 id（streamableHttp 有状态模式） */
  sessionId: string | null;
}

/** 把凭据映射为请求头：`token` → Bearer，其余键原样作为同名头 */
export function authHeaders(secrets: Record<string, string> | undefined): Record<string, string> {
  if (!secrets) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) continue;
    headers[key === 'token' ? 'authorization' : key.toLowerCase()] =
      key === 'token' ? `Bearer ${value}` : value;
  }
  return headers;
}

/** 发一次 JSON-RPC POST，返回状态码、内容类型与响应文本 */
async function postRpc(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  state: HttpProbeState,
  signal: AbortSignal,
): Promise<{ status: number; contentType: string; text: string }> {
  const requestHeaders: Record<string, string> = {
    'content-type': 'application/json',
    // streamableHttp 规范要求客户端同时接受两种响应形态
    accept: 'application/json, text/event-stream',
    ...headers,
  };
  if (state.sessionId) requestHeaders['mcp-session-id'] = state.sessionId;
  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
    signal,
  });
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId) state.sessionId = sessionId;
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

/** 从一次 POST 响应里挑出目标 id 的 JSON-RPC 消息 */
function pickMessage(
  contentType: string,
  text: string,
  id: number,
): { message: JsonRpcMessage | null } {
  const candidates = contentType.includes('text/event-stream') ? parseSseData(text) : [text];
  for (const candidate of candidates) {
    const message = parseRpcLine(candidate);
    if (message && messageId(message) === id) return { message };
  }
  return { message: null };
}

/** 老式 HTTP+SSE：只支持"POST 明确不可用"时的降级尝试 */
async function probeLegacySse(
  endpoint: string,
  headers: Record<string, string>,
  controller: AbortController,
  startedAt: number,
): Promise<McpProbeResult> {
  const streamResponse = await fetch(endpoint, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  if (!streamResponse.ok || !streamResponse.body) {
    return failure(startedAt, `老式 SSE 握手失败（HTTP ${streamResponse.status}）`);
  }

  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let messageUrl: string | null = null;
  const seen: JsonRpcMessage[] = [];

  /** 读一段流，直到谓词满足或流结束 */
  const readUntil = async (predicate: () => boolean): Promise<boolean> => {
    while (!predicate()) {
      const { value, done } = await reader.read();
      if (done) return false;
      raw += decoder.decode(value, { stream: true });
      const blocks = raw.split(/\r?\n\r?\n/);
      // 保留最后一个可能不完整的块
      raw = blocks.pop() ?? '';
      for (const block of blocks) {
        const chunk = `${block}\n\n`;
        if (!messageUrl) messageUrl = parseSseEndpoint(chunk);
        for (const payload of parseSseData(chunk)) {
          const message = parseRpcLine(payload);
          if (message) seen.push(message);
        }
      }
      if (controller.signal.aborted) return false;
    }
    return true;
  };

  const post = async (body: Record<string, unknown>) => {
    const target = messageUrl;
    if (!target) return;
    const absolute = new URL(target, endpoint).toString();
    await fetch(absolute, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  };

  if (!(await readUntil(() => messageUrl !== null))) {
    return failure(startedAt, '老式 SSE 未收到 endpoint 事件');
  }

  await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  if (!(await readUntil(() => seen.some((m) => messageId(m) === 1)))) {
    return failure(startedAt, '老式 SSE 未收到 initialize 响应');
  }
  const init = seen.find((m) => messageId(m) === 1)!;
  if (init.error) return failure(startedAt, describeRpcError(init) ?? 'initialize 失败');

  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  if (!(await readUntil(() => seen.some((m) => messageId(m) === 2)))) {
    return failure(startedAt, '老式 SSE 未收到 tools/list 响应');
  }
  const toolMessage = seen.find((m) => messageId(m) === 2)!;
  if (toolMessage.error) {
    return failure(startedAt, describeRpcError(toolMessage) ?? 'tools/list 失败');
  }
  return success(startedAt, { ...readInitialize(init.result), tools: readTools(toolMessage.result) });
}

export interface HttpProbeOptions {
  endpoint: string;
  urlType?: 'sse' | 'streamableHttp';
  secrets?: Record<string, string>;
  timeoutMs: number;
}

/** url 传输探针：POST 为主，POST 不可用且类型为 sse 时降级一次 GET 握手 */
export function probeHttp(options: HttpProbeOptions): Promise<McpProbeResult> {
  const startedAt = Date.now();
  if (!options.endpoint) return Promise.resolve(failure(startedAt, '未配置地址 (URL)'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const state: HttpProbeState = { sessionId: null };
  const headers = authHeaders(options.secrets);

  const finish = (result: McpProbeResult) => {
    clearTimeout(timer);
    return result;
  };

  return (async () => {
    try {
      const initResponse = await postRpc(
        options.endpoint,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
        },
        headers,
        state,
        controller.signal,
      );

      if (initResponse.status >= 400) {
        // 老式 HTTP+SSE 端点对 POST 通常回 4xx/405：只有明确声明 sse 才降级
        if (options.urlType === 'sse') {
          return finish(await probeLegacySse(options.endpoint, headers, controller, startedAt));
        }
        return finish(
          failure(
            startedAt,
            `服务端返回 HTTP ${initResponse.status}${
              initResponse.text ? `：${initResponse.text.slice(0, 200)}` : ''
            }`,
          ),
        );
      }

      const initPick = pickMessage(initResponse.contentType, initResponse.text, 1);
      if (!initPick.message) {
        return finish(failure(startedAt, '响应不是合法 JSON-RPC（可能不是 MCP 端点）'));
      }
      if (initPick.message.error) {
        return finish(failure(startedAt, describeRpcError(initPick.message) ?? 'initialize 失败'));
      }
      const init = readInitialize(initPick.message.result);

      const toolResponse = await postRpc(
        options.endpoint,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        headers,
        state,
        controller.signal,
      );
      if (toolResponse.status >= 400) {
        return finish(failure(startedAt, `tools/list 返回 HTTP ${toolResponse.status}`));
      }
      const toolPick = pickMessage(toolResponse.contentType, toolResponse.text, 2);
      if (!toolPick.message) {
        return finish(failure(startedAt, '未收到 tools/list 响应'));
      }
      if (toolPick.message.error) {
        return finish(failure(startedAt, describeRpcError(toolPick.message) ?? 'tools/list 失败'));
      }
      return finish(success(startedAt, { ...init, tools: readTools(toolPick.message.result) }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return finish(
        failure(
          startedAt,
          controller.signal.aborted
            ? `连接超时（${options.timeoutMs}ms 内未完成握手）`
            : `请求失败：${reason}`,
        ),
      );
    }
  })();
}

/** 探针入口：按传输类型分派，**永不抛异常** */
export function probeMcpServer(request: McpProbeRequest): Promise<McpProbeResult> {
  const timeoutMs =
    typeof request.timeoutMs === 'number' && request.timeoutMs > 0
      ? request.timeoutMs
      : DEFAULT_MCP_PROBE_TIMEOUT_MS;

  if (request.transport === 'command') {
    return probeStdio({
      command: request.command ?? '',
      secrets: request.secrets,
      timeoutMs,
    });
  }
  return probeHttp({
    endpoint: request.endpoint ?? '',
    urlType: request.urlType,
    secrets: request.secrets,
    timeoutMs,
  });
}
