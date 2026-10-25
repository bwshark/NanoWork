/**
 * SSE（Server-Sent Events）解析工具。
 *
 * 通过 fetch + ReadableStream 读取 OpenAI 兼容流式接口，
 * 按 SSE 标准事件边界（双换行）解析 `data:` 负载并回调；遇到 `[DONE]` 结束。
 *
 * 注意：本模块只负责传输层解析，不关心业务字段；
 * 业务字段映射（content / tool_call / artifact）由 aiClient 负责。
 */

export interface SSEOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * 活跃信号：链路上每有一点动静（响应头到达、读到任何字节）就回调一次。
   *
   * 供调用方做**静默超时**判定——长任务的总时长可以任意长，只要数据一直在
   * 流动就不该被判死；反之连续收不到任何字节才说明链路断了。
   * 判定必须落在字节层而不是事件层：`data:` 负载之间的 keep-alive 注释帧
   * 不产生事件，却恰好是「对端还活着」的证据（见 nanobotHttp/chat.ts）。
   */
  onActivity?: SSEActivityHandler;
  /**
   * **首个字节**到达时回调一次（且仅一次）。
   *
   * 与 `onActivity` 的区别是**语义**而非实现，但足以让指标算错：`onActivity`
   * 每次读到数据都回调（供静默超时归零），且 `fetchSSE` 在**拿到响应头**时就会
   * 先回调一次 —— 那一刻一个字节都还没读到。拿它的第一次调用当「首字节」，
   * `ttftMs` 就会凭空多出「等待响应头」那一段（本地网关可忽略，远端网关几十毫秒）。
   */
  onFirstByte?: SSEActivityHandler;
}

/**
 * 一次 SSE 读取的结束形态——调用方据此判断「本轮是否正常收尾」。
 *
 * - `'done'`：读到了 `[DONE]`，对端明确宣告结束；
 * - `'eof'`：body 先没了、`[DONE]` 从未出现。上游断流、进程被杀、代理超时都是这个形态，
 *   而它**与正常收尾在字节上无法区分**——所以必须显式回传，不能靠调用方猜。
 *   2026-09-29 的断流事故就是缺了这个信号：客户端把一次被掐断的流当成了正常完成。
 */
export type SSEStreamEnd = 'done' | 'eof';

export type SSEMessageHandler = (data: string) => void;
export type SSEErrorHandler = (error: Error) => void;
/** 活跃信号回调（无参、无返回，仅表示「链路还在动」） */
export type SSEActivityHandler = () => void;

/**
 * 标准 SSE 缓冲解析：按事件边界（双换行）分割，收集每个事件内所有 `data:` 行，
 * 兼容 `\n` 与 `\r\n`。返回完整事件 payload 列表与未结束的尾部。
 *
 * 背景：OpenAI / nanobot 的 SSE 单条消息通常是 `data: {...}\n\n`，
 * 但网关 [LOCAL PATCH] 注入的进度事件可能在 payload 内部包含未转义的换行（如工具结果），
 * 按单换行逐行解析会错误拆分；按双换行事件边界解析更可靠。
 */
export function parseSSEBuffer(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  let pos = 0;
  while (true) {
    const end = normalized.indexOf('\n\n', pos);
    if (end === -1) break;
    const block = normalized.slice(pos, end);
    pos = end + 2;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        dataLines.push(trimmed.slice('data:'.length).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'));
    }
  }
  return { events, rest: normalized.slice(pos) };
}

/** SSE 流结束标记 */
export function isSSEDone(payload: string): boolean {
  return payload.trim() === '[DONE]';
}

/**
 * 消费 ReadableStream 并逐条回调 SSE 数据事件。
 * 流结束时会自动处理尾部未完整数据，避免最后一条消息被丢弃。
 *
 * 返回值区分两种结束形态（见 `SSEStreamEnd`）：读到 `[DONE]` 回 `'done'`，
 * body 先结束回 `'eof'`。**这是判断本轮是否正常收尾的唯一依据**，调用方不得省略。
 *
 * `onActivity` 在**每次读到字节**时回调（在解析之前），因此 keep-alive 注释帧、
 * 被丢弃的脏帧同样算「链路活着」——调用方的静默超时据此归零。
 */
export async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  onMessage: (payload: string) => void,
  onActivity?: SSEActivityHandler,
  onFirstByte?: SSEActivityHandler,
): Promise<SSEStreamEnd> {
  const decoder = new TextDecoder();
  let buffer = '';
  let sawFirstByte = false;
  while (true) {
    if (signal?.aborted) return 'eof';
    const { done, value } = await reader.read();
    // 字节层活跃信号：先于 done 判断，让调用方在任何读到数据的时刻都能重新计时
    if (value && value.length > 0) {
      onActivity?.();
      // 首字节只报一次（`sawFirstByte` 而非「回调是否为空」做守卫：调用方可能
      // 在流中途才把回调接上，那种情况下重复上报会把首字节时刻推后）。
      if (!sawFirstByte) {
        sawFirstByte = true;
        onFirstByte?.();
      }
    }
    if (done) {
      // 流自然结束：追加一个事件边界，尝试消费缓冲区里的尾部数据
      const { events } = parseSSEBuffer(buffer + '\n\n');
      for (const payload of events) {
        if (signal?.aborted) return 'eof';
        if (isSSEDone(payload)) return 'done';
        onMessage(payload);
      }
      // 尾部消化完仍没见到 [DONE]：这一轮是被掐断的，不是正常收尾
      return 'eof';
    }
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSSEBuffer(buffer);
    buffer = rest;
    for (const payload of events) {
      if (signal?.aborted) return 'eof';
      if (isSSEDone(payload)) return 'done';
      onMessage(payload);
    }
  }
}

/**
 * 发起一次 SSE 请求并逐条回调 data 负载。
 * 当收到 `[DONE]` 时提前返回（视为正常结束）。
 *
 * 中断语义：当 `options.signal` 已 `aborted` 或在请求进行中触发 abort，
 * 本函数**不再**调用 `onError`，视为调用方主动取消的正常结束。
 *
 * `options.onActivity`：响应头到达与每次读到字节都回调一次，
 * 供调用方做静默超时（见 `SSEOptions.onActivity`）。
 *
 * 返回值即 `readSSEStream` 的结束形态；出错路径（HTTP 非 2xx / 缺 body / 解析抛错）
 * 一律回 `'eof'`，且已通过 `onError` 报过一次，调用方不应重复上报。
 * `204 / 205`（网关明确表示无内容）回 `'done'`：那是「没有可读的东西」，不是链路故障。
 */
export async function fetchSSE(
  url: string,
  options: SSEOptions,
  onMessage: SSEMessageHandler,
  onError: SSEErrorHandler,
): Promise<SSEStreamEnd> {
  if (options.signal?.aborted) return 'eof';
  try {
    const response = await fetch(url, {
      method: options.method ?? 'POST',
      headers: {
        Accept: 'text/event-stream',
        ...(options.headers ?? {}),
      },
      body: options.body,
      signal: options.signal,
    });

    // 服务端已应答（哪怕随后 4xx）：这说明链路通，静默计时从这里重新起算——
    // 否则「首字节前的等待」会与「首字节后的静默」共用同一个死线。
    options.onActivity?.();

    if (response.status === 204 || response.status === 205) {
      return 'done';
    }

    if (!response.ok) {
      throw new Error(`SSE 请求失败：HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('SSE 响应缺少 body 流');
    }

    return await readSSEStream(
      response.body.getReader(),
      options.signal,
      onMessage,
      options.onActivity,
      options.onFirstByte,
    );
  } catch (err) {
    if (options.signal?.aborted) return 'eof';
    if (err instanceof DOMException && err.name === 'AbortError') return 'eof';
    onError(err instanceof Error ? err : new Error(String(err)));
    return 'eof';
  }
}
