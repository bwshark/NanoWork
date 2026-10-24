/**
 * `syncAccount`：登录 / 注册 / 刷新轮换 / 登出 + 会话持久化。
 *
 * 锁三条容易做错、且做错的后果不直观的行为：
 * 1. **持久化用字符串 JSON**：`platform.storage` 存的是 `JSON.stringify(session)`，
 *    不是对象（Electron 桥按文本传递，存对象会变成 `[object Object]`）；
 * 2. **refresh 轮换成功 / 失败都不清会话**：失败时若把用户踢回未登录，会连带丢掉
 *    本地状态；
 * 3. **登出即使网络失败也要清本地会话**：票据终会过期，本地先断干净更重要。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import {
  createMemorySyncAccount,
  createStorageSyncAccount,
  SyncAuthError,
} from '@/sync/syncAccount';
import { SYNC_ACCOUNT_STORAGE_KEY } from '@/sync/types';
import type { AccountSession } from '@/sync/types';

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

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

/** 服务端 `TokenPair`。 */
function pair(access = 'a1', refresh = 'r1', id = 'u1', email = 'u@example.com') {
  return { access, refresh, user: { id, email } };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const SESSION: AccountSession = {
  userId: 'u1',
  email: 'u@example.com',
  access: 'a1',
  refresh: 'r1',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncAccount：登录 / 注册 / 基本读数', () => {
  it('未登录：isAuthenticated=false、access=null、session=null', () => {
    const { impl } = makeFetch(() => jsonResponse(pair()));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    expect(account.isAuthenticated()).toBe(false);
    expect(account.getAccessToken()).toBeNull();
    expect(account.getSession()).toBeNull();
  });

  it('login：POST /api/auth/login，映射 TokenPair → AccountSession', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse(pair()));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    const session = await account.login('u@example.com', 'pw');

    expect(session).toEqual(SESSION);
    expect(calls[0].url).toBe('http://x/api/auth/login');
    expect(bodyOf(calls[0].init)).toEqual({ email: 'u@example.com', password: 'pw' });
    expect(account.isAuthenticated()).toBe(true);
    expect(account.getAccessToken()).toBe('a1');
  });

  it('register：POST /api/auth/register，同样写入会话', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse(pair('acc', 'ref', 'u2', 'n@example.com')));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    const session = await account.register('n@example.com', 'pw123456');

    expect(session.userId).toBe('u2');
    expect(calls[0].url).toBe('http://x/api/auth/register');
    expect(account.getAccessToken()).toBe('acc');
  });

  it('login 失败抛 SyncAuthError（带 status）', async () => {
    const { impl } = makeFetch(() => jsonResponse({ detail: '邮箱或密码错误' }, 401));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    const error = await account.login('u@example.com', 'bad').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncAuthError);
    expect((error as SyncAuthError).status).toBe(401);
  });

  it('subscribe：登录 / 登出时收到会话变更', async () => {
    const { impl } = makeFetch(() => jsonResponse(pair()));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    const seen: Array<AccountSession | null> = [];
    const unsubscribe = account.subscribe((s) => seen.push(s));

    await account.login('u@example.com', 'pw');
    await account.clearSession();
    unsubscribe();
    await account.login('u@example.com', 'pw'); // 取消后不再通知

    expect(seen).toHaveLength(2);
    expect(seen[0]?.userId).toBe('u1');
    expect(seen[1]).toBeNull();
  });
});

describe('syncAccount：refresh 轮换', () => {
  it('刷新成功：轮换出新 access/refresh，且不清会话（userId/email 不变）', async () => {
    const { impl, calls } = makeFetch((_url, _init, call) =>
      call === 0 ? jsonResponse(pair('a1', 'r1')) : jsonResponse(pair('a2', 'r2')),
    );
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    const ok = await account.refresh();

    expect(ok).toBe(true);
    expect(account.getSession()).toEqual({
      userId: 'u1',
      email: 'u@example.com',
      access: 'a2',
      refresh: 'r2',
    });
    // 用的是旧 refresh（r1）去换新票
    expect(calls[1].url).toBe('http://x/api/auth/refresh');
    expect(bodyOf(calls[1].init)).toEqual({ refresh: 'r1' });
    expect(account.isAuthenticated()).toBe(true);
  });

  it('刷新失败（401）：返回 false 且**不清会话**', async () => {
    const { impl } = makeFetch((_url, _init, call) =>
      call === 0 ? jsonResponse(pair('a1', 'r1')) : jsonResponse({ detail: '已被使用过' }, 401),
    );
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    const ok = await account.refresh();

    expect(ok).toBe(false);
    // 会话仍在：批次 4 的 UI 据此提示「重新登录」，而不是把用户踢回未登录
    expect(account.getSession()).toEqual(SESSION);
    expect(account.isAuthenticated()).toBe(true);
  });

  it('未登录时 refresh 直接返回 false，不发请求', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse(pair()));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    await expect(account.refresh()).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  /**
   * 并发刷新必须**单飞**。
   *
   * 服务端的 `/api/auth/refresh` 是轮换 + 重用检测制：旧票换掉后标记 revoked 并指向
   * 新票，同一张旧票**再用第二次即判定为重放、整条链吊销**。所以这里不是「省一次
   * 请求」的性能优化，而是「点开知识库会不会被退出登录」的正确性问题 —— 知识库页
   * 首屏就是 3~4 个并发请求，过期时它们会一起回 401。
   */
  it('并发 refresh 合并成一次请求（第二次用旧票会被服务端判成重放）', async () => {
    let resolveRefresh: ((value: Response) => void) | null = null;
    const { impl, calls } = makeFetch((_url, _init, call) => {
      if (call === 0) return jsonResponse(pair('a1', 'r1'));
      // 挂住刷新响应，保证三个调用者都落在同一个在途请求上
      return new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    const first = account.refresh();
    const second = account.refresh();
    const third = account.refresh();
    await vi.waitFor(() => expect(resolveRefresh).not.toBeNull());
    resolveRefresh!(jsonResponse(pair('a2', 'r2')));

    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true]);
    // 登录 1 次 + 刷新 1 次：三次调用只打了一次 /api/auth/refresh
    expect(calls.filter((call) => call.url === 'http://x/api/auth/refresh')).toHaveLength(1);
    expect(account.getAccessToken()).toBe('a2');
  });

  it('刷新失败之后再刷新会重新发请求（闸门不能永久焊死）', async () => {
    const { impl, calls } = makeFetch((_url, _init, call) => {
      if (call === 0) return jsonResponse(pair('a1', 'r1'));
      if (call === 1) return jsonResponse({ detail: '网络抖动' }, 500);
      return jsonResponse(pair('a2', 'r2'));
    });
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    await expect(account.refresh()).resolves.toBe(false);
    await expect(account.refresh()).resolves.toBe(true);
    expect(calls.filter((call) => call.url === 'http://x/api/auth/refresh')).toHaveLength(2);
  });
});

describe('syncAccount：登出', () => {
  it('调用 /api/auth/logout 并清空本地会话', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse(pair()));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    await account.logout();

    expect(calls.some((c) => c.url === 'http://x/api/auth/logout')).toBe(true);
    expect(account.getSession()).toBeNull();
    expect(account.isAuthenticated()).toBe(false);
  });

  it('登出网络失败也要清本地会话（本地先断干净）', async () => {
    const { impl } = makeFetch((url) => {
      if (url.endsWith('/api/auth/logout')) throw new Error('网络断了');
      return jsonResponse(pair());
    });
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    await expect(account.logout()).resolves.toBeUndefined();
    expect(account.getSession()).toBeNull();
  });
});

describe('syncAccount：彻底删除账户（批次 6a，J-D1 / J-D2）', () => {
  it('J-D1：204 → 清空本地会话、订阅者收到 null，且请求是 DELETE /api/account 带 Bearer', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/api/account') ? jsonResponse(null, 204) : jsonResponse(pair()),
    );
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    const seen: Array<AccountSession | null> = [];
    account.subscribe((s) => seen.push(s));

    await account.deleteAccount();

    const del = calls.find((c) => c.url === 'http://x/api/account');
    expect(del, '未向 /api/account 发起请求').toBeTruthy();
    // 断言方法与路径：只断言「发了一次请求」的话，把方法写成 POST 也照样绿
    expect(del!.init.method).toBe('DELETE');
    expect((del!.init.headers as Record<string, string>).Authorization).toBe('Bearer a1');

    expect(account.getSession()).toBeNull();
    expect(account.isAuthenticated()).toBe(false);
    expect(seen.at(-1)).toBeNull();
  });

  it('J-D2：服务端 500 → 抛错且不清本地会话', async () => {
    const { impl } = makeFetch((url) =>
      url.endsWith('/api/account') ? jsonResponse({ detail: 'boom' }, 500) : jsonResponse(pair()),
    );
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });
    await account.login('u@example.com', 'pw');

    const error = await account.deleteAccount().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncAuthError);
    expect((error as SyncAuthError).status).toBe(500);
    // 云端还在 → 本机必须保留会话（最坏状态是「云端还在、本机以为删了」）
    expect(account.getSession()).toEqual(SESSION);
    expect(account.isAuthenticated()).toBe(true);
  });

  it('未登录时 deleteAccount 抛错且不发请求', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse(pair()));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    await expect(account.deleteAccount()).rejects.toBeInstanceOf(SyncAuthError);
    expect(calls).toHaveLength(0);
  });
});

describe('syncAccount：持久化（字符串 JSON）', () => {
  it('storage 变体：setSession 写入字符串 JSON', async () => {
    const setSpy = vi.spyOn(platform.storage, 'set');
    const { impl } = makeFetch(() => jsonResponse(pair()));
    const account = createStorageSyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    await account.setSession(SESSION);

    expect(setSpy).toHaveBeenCalledWith(SYNC_ACCOUNT_STORAGE_KEY, JSON.stringify(SESSION));
    // 传进去的是字符串，不是对象
    expect(typeof setSpy.mock.calls[0][1]).toBe('string');
  });

  it('storage 变体：load 读回字符串 JSON 并解析', async () => {
    vi.spyOn(platform.storage, 'get').mockResolvedValue(JSON.stringify(SESSION));
    const { impl } = makeFetch(() => jsonResponse(pair()));
    const account = createStorageSyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    await account.load();

    expect(account.getSession()).toEqual(SESSION);
    expect(account.isAuthenticated()).toBe(true);
  });

  it('storage 变体：坏值 / 非字符串一律按未登录处理，不抛错', async () => {
    vi.spyOn(platform.storage, 'get').mockResolvedValue('{ 不是 JSON');
    const { impl } = makeFetch(() => jsonResponse(pair()));
    const account = createStorageSyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    await expect(account.load()).resolves.toBeUndefined();
    expect(account.getSession()).toBeNull();
  });

  it('memory 变体：不触碰 platform.storage', async () => {
    const setSpy = vi.spyOn(platform.storage, 'set');
    const removeSpy = vi.spyOn(platform.storage, 'remove');
    const { impl } = makeFetch(() => jsonResponse(pair()));
    const account = createMemorySyncAccount({ baseUrl: 'http://x', fetchImpl: impl });

    await account.setSession(SESSION);
    await account.clearSession();

    expect(setSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });
});
