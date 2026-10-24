/**
 * `kbClient` 的鉴权自愈：401 → 换票 → 重放一次。
 *
 * 锁的是那条**用户可见**的坏状态：access token 只有 30 分钟寿命
 * （`cloud/app/auth/security.py` 的 `ACCESS_TTL`），过期后知识库页原来会把 401
 * 直接读成「未登录」——于是侧边栏显示着登录邮箱，页面却要求「去登录」。
 *
 * 四个判据：
 * 1. 401 且换票成功 → 用**新票**重放一次，调用方拿到正常数据；
 * 2. 换票后仍 401 → 认输（只重试一次），而不是把无效凭据反复打上去；
 * 3. 换票失败 → 不重放，`unauthorized` 保留（页面据此说「登录已过期」）；
 * 4. `getToken` 优先于 `token` 快照 —— 否则「配置建一次」就等于「30 分钟后必然 401」。
 */

import { describe, expect, it, vi } from 'vitest';
import { createKbGateway, listMyOrgs } from '@/lib/kbClient';
import type { KbClientConfig } from '@/lib/kbClient';

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

/** 按调用次数返回不同响应的假 fetch，并记下每次带来的 Authorization 头。 */
function makeFetch(handler: (call: number) => Response) {
  const calls: Array<{ url: string; authorization: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = calls.length;
    calls.push({ url: String(input), authorization: headers.Authorization ?? '' });
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ORGS = [{ id: 'o1', name: 'Acme', role: 'member', memberCount: 1, createdAt: 'x' }];

describe('kbClient：401 → 换票 → 重放一次', () => {
  it('过期票换票成功后用新票重放，调用方拿到正常数据', async () => {
    const { impl, calls } = makeFetch((call) =>
      call === 0 ? jsonResponse({ detail: 'access token 无效或已过期' }, 401) : jsonResponse(ORGS),
    );
    let token = 'stale';
    const refreshToken = vi.fn(async () => {
      token = 'fresh';
      return true;
    });
    const config: KbClientConfig = {
      baseUrl: 'http://x',
      token: null,
      getToken: () => token,
      refreshToken,
      fetchImpl: impl,
    };

    const result = await createKbGateway(config).listOrgs();

    expect(result.ok).toBe(true);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    // 重放**必须**带新票：拿旧快照重放等于再 401 一次
    expect(calls[0].authorization).toBe('Bearer stale');
    expect(calls[1].authorization).toBe('Bearer fresh');
  });

  it('换票后仍 401 → 只重试一次并保留 unauthorized', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({ detail: 'refresh 已吊销' }, 401));
    const refreshToken = vi.fn(async () => true);
    const result = await createKbGateway({
      baseUrl: 'http://x',
      token: 'stale',
      refreshToken,
      fetchImpl: impl,
    }).listOrgs();

    expect(result).toEqual(
      expect.objectContaining({ ok: false, status: 401, unauthorized: true }),
    );
    expect(refreshToken).toHaveBeenCalledTimes(1);
    // 1 次原请求 + 1 次重放，不无限重试
    expect(calls).toHaveLength(2);
  });

  it('换票失败 → 不重放，unauthorized 留给页面说「登录已过期」', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({ detail: 'access token 无效' }, 401));
    const result = await createKbGateway({
      baseUrl: 'http://x',
      token: 'stale',
      refreshToken: async () => false,
      fetchImpl: impl,
    }).listOrgs();

    expect(result).toEqual(
      expect.objectContaining({ ok: false, status: 401, unauthorized: true }),
    );
    expect(calls).toHaveLength(1);
  });

  it('没有 refreshToken 时 401 语义不变（不尝试换票）', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({ detail: 'access token 无效' }, 401));
    const result = await listMyOrgs({ baseUrl: 'http://x', token: 't', fetchImpl: impl });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, status: 401, unauthorized: true }),
    );
    expect(calls).toHaveLength(1);
  });

  it('403 不触发换票（是权限问题，不是票过期）', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({ detail: '无权访问' }, 403));
    const refreshToken = vi.fn(async () => true);
    const result = await createKbGateway({
      baseUrl: 'http://x',
      token: 't',
      refreshToken,
      fetchImpl: impl,
    }).listOrgs();

    expect(result).toEqual(
      expect.objectContaining({ ok: false, status: 403, unauthorized: false }),
    );
    expect(refreshToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('getToken 每次请求实时取票（配置只建一次也不会用旧快照）', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse(ORGS));
    let token = 'a1';
    const config: KbClientConfig = {
      baseUrl: 'http://x',
      token: 'frozen-at-mount',
      getToken: () => token,
      fetchImpl: impl,
    };
    const gateway = createKbGateway(config);

    await gateway.listOrgs();
    token = 'a2';
    await gateway.listOrgs();

    expect(calls.map((call) => call.authorization)).toEqual(['Bearer a1', 'Bearer a2']);
  });
});
