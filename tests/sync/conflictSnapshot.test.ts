/**
 * `SyncEngine` 冲突快照持久化单测（批次 6a §2.6，判据 J-E1~E3）。
 *
 * 锁三条容易做错、且做错的后果不直观的行为：
 * - **J-E1 重启后仍有快照**：进程内 `conflicts` 之外还要落盘，新引擎实例仍能读回；
 * - **J-E2 快照按账户隔离**：值形状一旦不带 `userId`，换号后 B 会看到 A 的冲突
 *   （批次 5 水位踩过的同一个坑）；
 * - **J-E3 上限仍然生效**：内存与盘上都裁到 `MAX_CONFLICT_SNAPSHOTS`（50）。
 *
 * 载入时机与事件水位一致：`syncNow` → `ensureAccountState` 后惰性从 `platform.storage`
 * 按当前账户分片载入。故「重启」用例在新建引擎后走一次 `syncNow` 触发载入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine } from '@/sync/SyncEngine';
import { SyncRegistry } from '@/sync/syncRegistry';
import { resetSyncStatus } from '@/sync/useSyncStatus';
import { CONFLICT_SNAPSHOT_STORAGE_KEY } from '@/sync/types';
import type { PushConflict } from '@/sync/types';
import type { SyncAccount } from '@/sync/syncAccount';

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

function makeClient(handler: Handler): { client: SyncClient } {
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return handler(url, init ?? {}, 0);
  }) as unknown as typeof fetch;
  return { client: new SyncClient({ baseUrl: 'http://x', fetchImpl: impl, getAccessToken: () => 'tok' }) };
}

/** 空注册表会导致 push 永不发生（无变更）——注册一个常驻实体让每轮都 push。 */
function oneWidgetRegistry(): SyncRegistry {
  const registry = new SyncRegistry();
  registry.register<Record<string, unknown>>({
    collection: 'widgets',
    keyOf: (e) => String(e.id),
    read: () => ({ entities: [{ id: 'w1' }], tombstones: {} }),
    apply: () => undefined,
    payload: (e) => e,
  });
  return registry;
}

function conflict(id: string): PushConflict {
  return { collection: 'widgets', id, server: { id, rev: 9 }, resolution: 'remote-wins' };
}

/** 固定账户桩（`getSession` 返回 null → scope 归一为 `''`）。 */
function fixedAccount(): SyncAccount {
  return {
    isAuthenticated: () => true,
    getAccessToken: () => 'tok',
    getSession: () => null,
    load: async () => undefined,
    setSession: async () => undefined,
    clearSession: async () => undefined,
    login: async () => {
      throw new Error('unused');
    },
    register: async () => {
      throw new Error('unused');
    },
    refresh: async () => false,
    logout: async () => undefined,
    deleteAccount: async () => undefined,
    subscribe: () => () => undefined,
  };
}

/** 可切换账户的桩：`setUser` 模拟「同一引擎实例下 A 登出 / B 登录 / 切回 A」。 */
function switchableAccount(initialUserId: string): {
  account: SyncAccount;
  setUser: (userId: string | null) => void;
} {
  let userId: string | null = initialUserId;
  const account: SyncAccount = {
    isAuthenticated: () => userId !== null,
    getAccessToken: () => (userId !== null ? 'tok' : null),
    getSession: () =>
      userId !== null
        ? { userId, email: `${userId}@example.com`, access: 'tok', refresh: 'r' }
        : null,
    load: async () => undefined,
    setSession: async () => undefined,
    clearSession: async () => undefined,
    login: async () => {
      throw new Error('unused');
    },
    register: async () => {
      throw new Error('unused');
    },
    refresh: async () => false,
    logout: async () => undefined,
    deleteAccount: async () => undefined,
    subscribe: () => () => undefined,
  };
  return { account, setUser: (next) => (userId = next) };
}

/** 读盘上某账户分片（用于断言「落盘的那份」也受上限约束）。 */
async function persistedShard(scope = ''): Promise<PushConflict[]> {
  const raw = await platform.storage.get<string>(CONFLICT_SNAPSHOT_STORAGE_KEY);
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const parsed = JSON.parse(raw) as Record<string, PushConflict[]>;
  return parsed[scope] ?? [];
}

beforeEach(async () => {
  resetSyncStatus();
  await platform.storage.remove(CONFLICT_SNAPSHOT_STORAGE_KEY).catch(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('J-E1：重启后仍有冲突快照', () => {
  it('首个引擎造冲突落盘 → 新建引擎 + 同一 storage 仍能读回', async () => {
    let conflictsOnPush: PushConflict[] = [conflict('a1')];
    const { client } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [], events: [] })
        : jsonResponse({ accepted: [], conflicts: conflictsOnPush, cursor: 0, accepted_events: 0 }),
    );

    const first = new SyncEngine({
      client,
      account: fixedAccount(),
      registry: oneWidgetRegistry(),
    });
    await first.syncNow();
    expect(first.getConflicts().map((c) => c.id)).toEqual(['a1']);

    // 「重启」：新实例、同一 storage 后端。让服务端本轮不再回冲突，隔离出「读盘」这条路径。
    conflictsOnPush = [];
    const { client: client2 } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [], events: [] })
        : jsonResponse({ accepted: [], conflicts: [], cursor: 0, accepted_events: 0 }),
    );
    const reloaded = new SyncEngine({
      client: client2,
      account: fixedAccount(),
      registry: oneWidgetRegistry(),
    });
    await reloaded.syncNow();

    expect(reloaded.getConflicts().map((c) => c.id)).toEqual(['a1']);
  });
});

describe('J-E2：快照按账户隔离（换号不泄漏、切回可恢复）', () => {
  it('A 造冲突 → 切到 B 只看到 B 的 → 切回 A 仍看到 A 的', async () => {
    let conflictsOnPush: PushConflict[] = [];
    const { client } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [], events: [] })
        : jsonResponse({ accepted: [], conflicts: conflictsOnPush, cursor: 0, accepted_events: 0 }),
    );
    const { account, setUser } = switchableAccount('user-a');
    const engine = new SyncEngine({ client, account, registry: oneWidgetRegistry() });

    // —— 账户 A ——
    conflictsOnPush = [conflict('a1')];
    await engine.syncNow();
    expect(engine.getConflicts().map((c) => c.id)).toEqual(['a1']);

    // —— 切到 B：B 的推送回 B 自己的冲突 ——
    setUser('user-b');
    conflictsOnPush = [conflict('b1')];
    await engine.syncNow();
    // 值形状不带 userId → 这里会看到 a1（泄漏）→ 红
    expect(engine.getConflicts().map((c) => c.id)).toEqual(['b1']);
    expect(await persistedShard('user-a')).toHaveLength(1);
    expect(await persistedShard('user-b')).toHaveLength(1);

    // —— 切回 A：A 的分片应恢复 ——
    setUser('user-a');
    conflictsOnPush = [];
    await engine.syncNow();
    expect(engine.getConflicts().map((c) => c.id)).toEqual(['a1']);
  });
});

describe('J-E3：上限仍然生效', () => {
  it('造 60 次冲突 → 内存与盘上都是 50', async () => {
    const many = Array.from({ length: 60 }, (_, i) => conflict(`c${i + 1}`));
    const { client } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [], events: [] })
        : jsonResponse({ accepted: [], conflicts: many, cursor: 0, accepted_events: 0 }),
    );
    const engine = new SyncEngine({ client, account: fixedAccount(), registry: oneWidgetRegistry() });

    await engine.syncNow();

    expect(engine.getConflicts()).toHaveLength(50);
    // 保留的是**最近** 50 条（从头部裁掉 c1..c10）
    expect(engine.getConflicts()[0].id).toBe('c11');
    expect(await persistedShard()).toHaveLength(50);
  });
});
