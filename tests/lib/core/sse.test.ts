/**
 * SSE 结束形态判定：`[DONE]` 与「body 自然结束」必须能分开。
 *
 * 这条区分是「本轮是否正常收尾」的**唯一**依据。2026-09-29 的断流事故里没有它：
 * 引擎进程被杀后 body 直接断掉，客户端只看到「流没了」，于是把一次被掐断的回合
 * 渲染成「已完成」，用户要等发现文件不存在才回头怀疑程序出错。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSSE, readSSEStream } from '@/lib/core/sse';

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

/**
 * 首字节信号（FR-11.7）。
 *
 * 它与 `onActivity` 的差别只有一处，但足以让 `ttftMs` 整段算错：
 * `fetchSSE` 在**拿到响应头**时就会先调一次 `onActivity`，而那一个字节都还没读到。
 * 拿 `onActivity` 的首次调用当首字节，等于把「等待响应头」也算进首字延迟。
 */
describe('首字节信号', () => {
  it('只回调一次，且只在真的读到字节时——响应头到达不算', async () => {
    const activity: number[] = [];
    const firstByte: number[] = [];
    await readSSEStream(
      readerOf(['data: a\n\n', 'data: b\n\n', 'data: [DONE]\n\n']),
      undefined,
      () => undefined,
      () => activity.push(activity.length),
      // ③ 首字节
      () => firstByte.push(firstByte.length),
    );

    // 活跃信号会随每个 chunk 增加；首字节无论读多少块都只有一次
    expect(activity.length).toBeGreaterThan(1);
    expect(firstByte).toHaveLength(1);
  });

  it('空 chunk 不算首字节（读到 0 字节不是「收到数据」）', async () => {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [encoder.encode(''), encoder.encode('data: [DONE]\n\n')];
    let i = 0;
    const reader = {
      read: async () =>
        i < chunks.length
          ? ({ done: false, value: chunks[i++] } as const)
          : ({ done: true, value: undefined } as const),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    let fired = 0;
    await readSSEStream(reader, undefined, () => undefined, undefined, () => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  it('流一开始就结束（一个字节都没有）→ 首字节永不触发', async () => {
    let fired = 0;
    await readSSEStream(readerOf([]), undefined, () => undefined, undefined, () => {
      fired += 1;
    });
    expect(fired).toBe(0);
  });

  it('fetchSSE 把 onFirstByte 透传给读取层', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ status: 200, body: 'data: [DONE]\n\n', contentType: 'text/event-stream' }),
      ),
    );
    let fired = 0;
    await fetchSSE(
      'http://gw/v1/chat/completions',
      { onFirstByte: () => { fired += 1; } },
      () => undefined,
      () => undefined,
    );
    expect(fired).toBe(1);
  });
});