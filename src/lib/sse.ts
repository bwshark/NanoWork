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
}

export type SSEMessageHandler = (data: string) => void;
export type SSEErrorHandler = (error: Error) => void;

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
 */
export async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  onMessage: (payload: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) {
      // 流自然结束：追加一个事件边界，尝试消费缓冲区里的尾部数据
      const { events } = parseSSEBuffer(buffer + '\n\n');
      for (const payload of events) {
        if (signal?.aborted) return;
        if (isSSEDone(payload)) return;
        onMessage(payload);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSSEBuffer(buffer);
    buffer = rest;
    for (const payload of events) {
      if (signal?.aborted) return;
      if (isSSEDone(payload)) return;
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
 */
export async function fetchSSE(
  url: string,
  options: SSEOptions,
  onMessage: SSEMessageHandler,
  onError: SSEErrorHandler,
): Promise<void> {
  if (options.signal?.aborted) return;
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

    if (response.status === 204 || response.status === 205) {
      return;
    }

    if (!response.ok) {
      throw new Error(`SSE 请求失败：HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('SSE 响应缺少 body 流');
    }

    await readSSEStream(response.body.getReader(), options.signal, onMessage);
  } catch (err) {
    if (options.signal?.aborted) return;
    if (err instanceof DOMException && err.name === 'AbortError') return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
