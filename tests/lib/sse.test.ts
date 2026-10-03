/**
 * SSE 结束形态判定：`[DONE]` 与「body 自然结束」必须能分开。
 *
 * 这条区分是「本轮是否正常收尾」的**唯一**依据。2026-09-29 的断流事故里没有它：
 * 引擎进程被杀后 body 直接断掉，客户端只看到「流没了」，于是把一次被掐断的回合
 * 渲染成「已完成」，用户要等发现文件不存在才回头怀疑程序出错。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSSE, readSSEStream } from '@/lib/sse';

/** 用若干字节块拼一个可读流的 reader（不依赖真实 Response 的实现） */
function readerOf(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    read: async () =>
      i < chunks.length
        ? ({ done: false, value: encoder.encode(chunks[i++]) } as const)
        : ({ done: true, value: undefined } as const),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** 最小可用的 `Response` 替身：只实现 fetchSSE 真正读到的字段 */
function fakeResponse(init: {
  status?: number;
  body?: string | null;
  contentType?: string;
}) {
  const status = init.status ?? 200;
  const bodyText = init.body === undefined ? 'data: [DONE]\n\n' : init.body;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type'
          ? (init.contentType ?? 'text/event-stream')
          : null,
    },
    body: bodyText === null ? null : { getReader: () => readerOf([bodyText]) },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readSSEStream: 结束形态', () => {
  it('读到 [DONE] → done，且 [DONE] 本身不作为负载回调', async () => {
    const payloads: string[] = [];
    const end = await readSSEStream(
      readerOf(['data: {"a":1}\n\n', 'data: [DONE]\n\n']),
      undefined,
      (p) => payloads.push(p),
    );

    expect(payloads).toEqual(['{"a":1}']);
    expect(end).toBe('done');
  });

  it('body 先结束、从未见到 [DONE] → eof（这就是断流的形状）', async () => {
    const payloads: string[] = [];
    const end = await readSSEStream(
      readerOf(['data: {"a":1}\n\n']),
      undefined,
      (p) => payloads.push(p),
    );

    expect(payloads).toEqual(['{"a":1}']);
    expect(end).toBe('eof');
  });

  it('尾部残缺数据照旧消化，但结束形态仍是 eof', async () => {
    const payloads: string[] = [];
    const end = await readSSEStream(readerOf(['data: {"a":1}']), undefined, (p) =>
      payloads.push(p),
    );

    expect(payloads).toEqual(['{"a":1}']);
    expect(end).toBe('eof');
  });

  it('keep-alive 注释帧算活跃信号，且不影响结束形态', async () => {
    let activity = 0;
    const end = await readSSEStream(
      readerOf([': ping\n\n', 'data: [DONE]\n\n']),
      undefined,
      () => undefined,
      () => {
        activity += 1;
      },
    );

    // 每一块字节都算一次活跃（注释帧不产生负载，却恰好是「对端还活着」的证据）
    expect(activity).toBe(2);
    expect(end).toBe('done');
  });
});

describe('fetchSSE: 结束形态与错误上报', () => {
  it('读到 [DONE] → done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({})));

    const end = await fetchSSE(
      'http://gw/v1/chat/completions',
      {},
      () => undefined,
      () => undefined,
    );

    expect(end).toBe('done');
  });

  it('204（网关明确表示无内容）算正常收尾，不是断流', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ status: 204, body: null })),
    );

    const end = await fetchSSE(
      'http://gw/v1/chat/completions',
      {},
      () => undefined,
      () => undefined,
    );

    expect(end).toBe('done');
  });

  it('HTTP 非 2xx → 报错一次并回 eof（交给调用方判断是否叠加中断提示）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ status: 500, body: 'boom' })),
    );

    const errors: string[] = [];
    const end = await fetchSSE(
      'http://gw/v1/chat/completions',
      {},
      () => undefined,
      (err) => errors.push(err.message),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('500');
    expect(end).toBe('eof');
  });

  it('响应缺 body → 报错一次并回 eof', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ status: 200, body: null })),
    );

    const errors: string[] = [];
    const end = await fetchSSE(
      'http://gw/v1/chat/completions',
      {},
      () => undefined,
      (err) => errors.push(err.message),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('body');
    expect(end).toBe('eof');
  });
});