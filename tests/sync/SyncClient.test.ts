/**
 * `SyncClient`：`push` / `pull` 的 HTTP 组装、鉴权头、以及刷新重试策略。
 *
 * 三件必须锁死的行为（否则线上会以「静默」方式出错）：
 * 1. **`pull` 的 `since` 是 number**（服务端 `server_seq`），不是 ISO 时间——混用会漏数据；
 * 2. **401 → refresh → 仅重试一次**：重试无限次 = 401 风暴并掩盖真正原因；
 * 3. **非 2xx 抛带 `status` 的错误**：调用方据 `status`（401 落离线、其它落错误）分支。
 */

import { describe, expect, it } from 'vitest';
import { SyncClient, SyncHttpError } from '@/sync/SyncClient';
import type { SyncChange } from '@/sync/types';

/** 伪 Response（只需要 `ok` / `status` / `json`）。 */
function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;

/** 可计数的假 fetch：记录每次调用的 url / init，便于断言。 */
function makeFetch(handler: Handler): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = calls.length;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {}, call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

const CHANGE: SyncChange = { collection: 'agents', entity: { id: 'a1', rev: 1 } };

describe('SyncClient.push / pull 的请求组装', () => {
  it('push：POST /api/sync/push，带 Bearer 头与 JSON 体', async () => {
    const { impl, calls } = makeFetch(() =>
      jsonResponse({ accepted: ['a1'], conflicts: [], cursor: 7 }),
    );
    const client = new SyncClient({
      baseUrl: 'http://x',
      fetchImpl: impl,
      getAccessToken: () => 'tok',
    });

    const result = await client.push([CHANGE]);

    expect(result).toEqual({ accepted: ['a1'], conflicts: [], cursor: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://x/api/sync/push');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0].init).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ changes: [CHANGE], events: [] });
  });

  it('pull：GET /api/sync/pull?since=<number>，不是 ISO 时间', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({ cursor: 12, changes: [] }));
    const client = new SyncClient({
      baseUrl: 'http://x/', // 尾部斜杠应被规整掉，不出现 //api
      fetchImpl: impl,
      getAccessToken: () => 'tok',
    });

    const result = await client.pull(11);

    expect(result).toEqual({ cursor: 12, changes: [] });
    expect(calls[0].url).toBe('http://x/api/sync/pull?since=11');
    expect(calls[0].init.method).toBe('GET');
  });

  it('无 token 时不带 Authorization 头', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({ cursor: 0, changes: [] }));
    const client = new SyncClient({ baseUrl: 'http://x', fetchImpl: impl, getAccessToken: () => null });

    await client.pull(0);

    expect(headersOf(calls[0].init).Authorization).toBeUndefined();
  });
});

describe('SyncClient 的 401 → refresh → 仅重试一次', () => {
  it('刷新成功则重放一次原请求并成功（fetch 2 次、refresh 1 次）', async () => {
    const { impl, calls } = makeFetch((_url, _init, call) =>
      call === 0 ? jsonResponse({}, 401) : jsonResponse({ cursor: 0, changes: [] }),
    );
    let refreshCount = 0;
    const client = new SyncClient({
      baseUrl: 'http://x',
      fetchImpl: impl,
      getAccessToken: () => 'tok',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return true;
      },
    });

    await expect(client.pull(0)).resolves.toEqual({ cursor: 0, changes: [] });
    expect(calls).toHaveLength(2);
    expect(refreshCount).toBe(1);
  });

  it('刷新失败则抛 401 且不重试（fetch 仅 1 次）', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({}, 401));
    const client = new SyncClient({
      baseUrl: 'http://x',
      fetchImpl: impl,
      getAccessToken: () => 'tok',
      refreshAccessToken: async () => false,
    });

    await expect(client.pull(0)).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('刷新成功但重试仍 401 → 抛错，且只重试一次（fetch 2 次）', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({}, 401));
    let refreshCount = 0;
    const client = new SyncClient({
      baseUrl: 'http://x',
      fetchImpl: impl,
      getAccessToken: () => 'tok',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return true;
      },
    });

    await expect(client.pull(0)).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2);
    expect(refreshCount).toBe(1);
  });

  it('非 2xx 非 401 → 直接抛错，不触发 refresh', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({}, 500));
    let refreshCount = 0;
    const client = new SyncClient({
      baseUrl: 'http://x',
      fetchImpl: impl,
      getAccessToken: () => 'tok',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return true;
      },
    });

    const error = await client.pull(0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncHttpError);
    expect((error as SyncHttpError).status).toBe(500);
    expect(calls).toHaveLength(1);
    expect(refreshCount).toBe(0);
  });

  it('刷新回调抛错时按失败处理，不把异常泄漏成「未分类错误」', async () => {
    const { impl } = makeFetch(() => jsonResponse({}, 401));
    const client = new SyncClient({
      baseUrl: 'http://x',
      fetchImpl: impl,
      getAccessToken: () => 'tok',
      refreshAccessToken: async () => {
        throw new Error('refresh 端点挂了');
      },
    });

    await expect(client.pull(0)).rejects.toMatchObject({ status: 401 });
  });
});
