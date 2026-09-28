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
