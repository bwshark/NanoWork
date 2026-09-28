/**
 * `SyncEngine`：批次 2 的三条完成判据 + 裁决函数。
 *
 * ## 三条批次判据（§七 批次 2）
 * 1. **未登录时 fetch 调用次数 = 0**（local-first 守卫），并补正向对照防「恒不请求」也通过；
 * 2. **push 组装含墓碑且过裁剪**（走 `spec.payload`；超 30 天墓碑被挡下）；
 * 3. **pull 落地后墓碑条目不出现在列表**（浅合并保本机事实；本地更新丢弃远端；新条采用）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine, compareVersions, pickWinner } from '@/sync/SyncEngine';
import { SyncRegistry, createDefaultRegistry } from '@/sync/syncRegistry';
import { getSyncStatus, resetSyncStatus } from '@/sync/useSyncStatus';
import { pickSyncable } from '@/lib/syncSelect';
import { useAgentsStore } from '@/stores/agentsStore';
import type { SyncAccount } from '@/sync/syncAccount';
import type { PushConflict, VersionStamp } from '@/sync/types';
import type { Agent } from '@/types';

const DAY = 24 * 60 * 60 * 1000;

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

/** 可计数的假 fetch（引擎的 fetch 次数断言靠它）。 */
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

/** 假账户：只关心「登录没登录」。 */
function authAccount(authed: boolean): SyncAccount {
  return {
    isAuthenticated: () => authed,
    getAccessToken: () => (authed ? 'tok' : null),
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
    subscribe: () => () => undefined,
  };
}

function makeClient(handler: Handler): { client: SyncClient; calls: Array<{ url: string; init: RequestInit }> } {
  const { impl, calls } = makeFetch(handler);
  const client = new SyncClient({ baseUrl: 'http://x', fetchImpl: impl, getAccessToken: () => 'tok' });
  return { client, calls };
}

/** 空响应 fetch：pull 返回空、push 返回空 accepted。 */
function emptyHandler(): Handler {
  return (url) =>
    url.includes('/pull')
      ? jsonResponse({ cursor: 0, changes: [] })
      : jsonResponse({ accepted: [], conflicts: [], cursor: 0 });
}

/** 记录 addEventListener / removeEventListener 调用的假 online 目标。 */
function fakeOnlineTarget(): {
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(ev: Event) => void>();
  const addEventListener = vi.fn((_type: string, cb: (ev: Event) => void) => {
    listeners.add(cb);
  });
  const removeEventListener = vi.fn((_type: string, cb: (ev: Event) => void) => {
    listeners.delete(cb);
  });
  const target = { addEventListener, removeEventListener } as unknown as Pick<
    Window,
    'addEventListener' | 'removeEventListener'
  >;
  return { target, addEventListener, removeEventListener };
}

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    systemPrompt: '',
    skillIds: [],
    imBinding: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'user',
    ...over,
  };
}

beforeEach(() => {
  resetSyncStatus();
  useAgentsStore.setState({ agents: [], tombstones: {} });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────── 裁决函数 ───────────────────────────

describe('compareVersions / pickWinner：三级 tie-break', () => {
  const stamp = (over: Partial<VersionStamp> = {}): VersionStamp => ({
    id: 'a',
    rev: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  });

  it('第一级：updatedAt 大者胜', () => {
    expect(
      compareVersions(stamp({ updatedAt: '2026-01-02T00:00:00.000Z' }), stamp()),
    ).toBe(1);
    expect(
      compareVersions(stamp(), stamp({ updatedAt: '2026-01-02T00:00:00.000Z' })),
    ).toBe(-1);
  });

  it('第二级：时间相等则 rev 大者胜', () => {
    expect(compareVersions(stamp({ rev: 2 }), stamp({ rev: 1 }))).toBe(1);
    expect(compareVersions(stamp({ rev: 1 }), stamp({ rev: 2 }))).toBe(-1);
  });

  it('第三级：时间与 rev 都相等则 id 字典序大者胜', () => {
    expect(compareVersions(stamp({ id: 'b' }), stamp({ id: 'a' }))).toBe(1);
    expect(compareVersions(stamp({ id: 'a' }), stamp({ id: 'b' }))).toBe(-1);
  });

  it('三级全等 → 0', () => {
    expect(compareVersions(stamp(), stamp())).toBe(0);
  });

  it('缺 updatedAt 的老数据按零值时间读，不因 NaN 乱判', () => {
    expect(compareVersions(stamp({ updatedAt: '' }), stamp({ updatedAt: '' }))).toBe(0);
    expect(
      compareVersions(stamp({ updatedAt: '2026-01-01T00:00:00.000Z' }), stamp({ updatedAt: '' })),
    ).toBe(1);
  });

  it('pickWinner：远端更新 → remote；相等 / 本地更新 → local（等下次 push）', () => {
    expect(pickWinner(stamp({ rev: 1 }), stamp({ rev: 2 }))).toBe('remote');
    expect(pickWinner(stamp(), stamp())).toBe('local');
    expect(pickWinner(stamp({ rev: 3 }), stamp({ rev: 1 }))).toBe('local');
  });
});

// ─────────────────────── 判据 1：未登录 fetch = 0 ───────────────────────

describe('判据 1：未登录时零网络请求（local-first 守卫）', () => {
  it('未登录 start() 不注册任何定时器 / 监听器', async () => {
    const { client, calls } = makeClient(emptyHandler());
    const online = fakeOnlineTarget();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const engine = new SyncEngine({
      client,
      account: authAccount(false),
      registry: createDefaultRegistry(),
      onlineTarget: online.target,
    });

    engine.start();

    expect(online.addEventListener).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled(); // 连定时器都不注册，不只是「不发请求」
    expect(calls).toHaveLength(0); // start 的「立即同步」也不发请求
    engine.stop();
    // 推进时间后依然 0 次请求，排除「定时器注册了但回调被跳过」
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);
  });

  it('未登录 syncNow() 返回 skipped 且 fetch 0 次、状态落 local', async () => {
    const { client, calls } = makeClient(emptyHandler());
    const engine = new SyncEngine({
      client,
      account: authAccount(false),
      registry: createDefaultRegistry(),
    });

    const result = await engine.syncNow();

    expect(result).toEqual({
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      skipped: true,
      // 批次 5 新增字段（未注入事件通道 → 恒 0）。行为未变，仅形状扩展。
      pulledEvents: 0,
      pushedEvents: 0,
    });
    expect(calls).toHaveLength(0);
    expect(getSyncStatus().status).toBe('local');
  });

  it('未登录 notifyLocalChange() + 推进时间 → 仍 0 次 fetch', async () => {
    const { client, calls } = makeClient(emptyHandler());
    const engine = new SyncEngine({
      client,
      account: authAccount(false),
      registry: createDefaultRegistry(),
      debounceMs: 50,
    });

    engine.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(5000);

    expect(calls).toHaveLength(0);
  });

  it('正向对照：登录后确实发请求（防「恒不请求」也通过）', async () => {
    const { client, calls } = makeClient(emptyHandler());
    const engine = new SyncEngine({
      client,
      account: authAccount(true),
      registry: createDefaultRegistry(),
    });

    const result = await engine.syncNow();

    expect(result.skipped).toBe(false);
    expect(calls.some((c) => c.url.includes('/api/sync/pull'))).toBe(true);
  });

  it('登录后 start() 注册 online 监听 + 定时器；stop() 后不再请求', async () => {
    const { client, calls } = makeClient(emptyHandler());
    const online = fakeOnlineTarget();
    const engine = new SyncEngine({
      client,
      account: authAccount(true),
      registry: createDefaultRegistry(),
      onlineTarget: online.target,
      intervalMs: 1000,
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(online.addEventListener).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThan(0);

    const before = calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBeGreaterThan(before);

    engine.stop();
    expect(online.removeEventListener).toHaveBeenCalledTimes(1);
    const afterStop = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(afterStop);
  });
});

// ─────────────────── 判据 2：push 组装含墓碑且过裁剪 ───────────────────

describe('判据 2：push 组装含墓碑且过裁剪', () => {
  it('真实 agents：存活 + 墓碑都进负载，墓碑四要素齐全', () => {
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
    const fresh = new Date(nowMs - 3 * DAY).toISOString();
    useAgentsStore.setState({
      agents: [agent('a1')],
      tombstones: { a2: { rev: 4, updatedAt: fresh, updatedBy: 'dev-b', deletedAt: fresh } },
    });
    const { client } = makeClient(emptyHandler());
    const engine = new SyncEngine({
      client,
      account: authAccount(true),
      registry: createDefaultRegistry(),
      now: () => nowMs,
    });

    const changes = engine.collectChanges();
    const a1 = changes.find((c) => c.entity.id === 'a1');
    const a2 = changes.find((c) => c.entity.id === 'a2');

    expect(a1).toBeTruthy();
    expect(a2).toBeTruthy();
    expect(a2!.entity).toMatchObject({
      rev: 4,
      updatedAt: fresh,
      updatedBy: 'dev-b',
      deletedAt: fresh,
    });
    expect(a2!.entity.deletedAt).not.toBeNull();
  });

  it('引擎确实走 spec.payload（合成 collection 删字段）', () => {
    const registry = new SyncRegistry();
    registry.register<Record<string, unknown>>({
      collection: 'widgets',
      keyOf: (e) => String(e.id),
      read: () => ({ entities: [{ id: 'w1', name: 'x', secret: 's3cr3t' }], tombstones: {} }),
      apply: () => undefined,
      payload: (e) => pickSyncable(e, ['secret']),
    });
    const { client } = makeClient(emptyHandler());
    const engine = new SyncEngine({ client, account: authAccount(true), registry });

    const changes = engine.collectChanges();

    expect(changes).toHaveLength(1);
    expect(changes[0].collection).toBe('widgets');
    expect(changes[0].entity).toEqual({ id: 'w1', name: 'x' });
    expect(changes[0].entity).not.toHaveProperty('secret');
  });

  it('墓碑也确实过 spec.payload（防「存活裁剪了、墓碑没裁」）', () => {
    // 反面：agents 的 payload 是 `pickSyncable(e, [])`（恒等），因此「墓碑绕过 payload」
    // 在真实 agents 用例里**不可观测**——必须用合成 collection 才能证伪。这里 payload
    // 打一个可观测标记 `viaPayload`：引擎若在墓碑分支里不调 spec.payload，此断言必红。
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
    const freshIso = new Date(nowMs - 1 * DAY).toISOString();
    const registry = new SyncRegistry();
    const payloadCalls: string[] = [];
    registry.register<Record<string, unknown>>({
      collection: 'gadgets',
      keyOf: (e) => String(e.id),
      read: () => ({
        entities: [],
        tombstones: { g1: { rev: 2, updatedAt: freshIso, updatedBy: 'd', deletedAt: freshIso } },
      }),
      apply: () => undefined,
      payload: (e) => {
        payloadCalls.push(String(e.id));
        return { ...pickSyncable(e, []), viaPayload: true };
      },
    });
    const { client } = makeClient(emptyHandler());
    const engine = new SyncEngine({
      client,
      account: authAccount(true),
      registry,
      now: () => nowMs,
    });

    const changes = engine.collectChanges();

    expect(changes).toHaveLength(1);
    expect(payloadCalls).toEqual(['g1']); // 墓碑确实经过裁剪入口
    expect(changes[0].entity).toMatchObject({
      id: 'g1',
      rev: 2,
      updatedAt: freshIso,
      updatedBy: 'd',
      deletedAt: freshIso,
      viaPayload: true, // 绕过 payload 则此键缺失
    });
  });

  it('超 30 天墓碑被挡在门外：40 天前不在、29 天在', () => {
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
    const oldIso = new Date(nowMs - 40 * DAY).toISOString();
    const freshIso = new Date(nowMs - 29 * DAY).toISOString();
    useAgentsStore.setState({
      agents: [],
      tombstones: {
        old1: { rev: 2, updatedAt: oldIso, updatedBy: 'd', deletedAt: oldIso },
        fresh1: { rev: 2, updatedAt: freshIso, updatedBy: 'd', deletedAt: freshIso },
      },
    });
    const { client } = makeClient(emptyHandler());
    const engine = new SyncEngine({
      client,
      account: authAccount(true),
      registry: createDefaultRegistry(),
      now: () => nowMs,
    });

    const changes = engine.collectChanges();

    expect(changes.find((c) => c.entity.id === 'old1')).toBeUndefined();
    const fresh = changes.find((c) => c.entity.id === 'fresh1');
    expect(fresh).toBeTruthy();
    expect(fresh!.entity).toMatchObject({
      rev: 2,
      updatedAt: freshIso,
      updatedBy: 'd',
      deletedAt: freshIso,
    });
  });
});

// ────────────── 判据 3：pull 落地后墓碑条目不出现在列表 ──────────────

describe('判据 3：pull 落地语义', () => {
  const OLDER = '2026-01-01T00:00:00.000Z';
  const NEWER = '2026-06-01T00:00:00.000Z';

  it('本地存活 A → pull A 墓碑 → 列表不含 A、墓碑表含 A', async () => {
    useAgentsStore.setState({
      agents: [agent('a1', { rev: 2, updatedAt: OLDER, updatedBy: 'dev', deletedAt: null })],
      tombstones: {},
    });
    let pullCall = 0;
    const { client } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullCall += 1;
        if (pullCall === 1) {
          return jsonResponse({
            cursor: 1,
            changes: [
              { collection: 'agents', entity: { id: 'a1', rev: 3, updatedAt: NEWER, updatedBy: 'dev-b', deletedAt: NEWER } },
            ],
          });
        }
        return jsonResponse({ cursor: 1, changes: [] });
      }
      return jsonResponse({ accepted: ['a1'], conflicts: [], cursor: 1 });
    });
    const engine = new SyncEngine({ client, account: authAccount(true), registry: createDefaultRegistry() });

    const result = await engine.syncNow();

    const state = useAgentsStore.getState();
    expect(state.agents.find((a) => a.id === 'a1')).toBeUndefined();
    expect(state.tombstones.a1).toMatchObject({ rev: 3, deletedAt: NEWER });
    expect(result.pulled).toBeGreaterThanOrEqual(1);
  });

  it('浅合并：远端更新覆盖声明字段、保留本机事实字段、元数据以 payload 为准', async () => {
    const localAgent = {
      ...agent('a1', { name: '旧名', rev: 2, updatedAt: OLDER, updatedBy: 'dev', deletedAt: null }),
      runtimeFact: 'local-only',
    } as Agent;
    useAgentsStore.setState({ agents: [localAgent], tombstones: {} });
    let pullCall = 0;
    const { client } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullCall += 1;
        if (pullCall === 1) {
          return jsonResponse({
            cursor: 1,
            changes: [
              { collection: 'agents', entity: { id: 'a1', name: '新名', rev: 5, updatedAt: NEWER, updatedBy: 'dev-b', deletedAt: null } },
            ],
          });
        }
        return jsonResponse({ cursor: 1, changes: [] });
      }
      return jsonResponse({ accepted: ['a1'], conflicts: [], cursor: 1 });
    });
    const engine = new SyncEngine({ client, account: authAccount(true), registry: createDefaultRegistry() });

    await engine.syncNow();

    const merged = useAgentsStore.getState().agents.find((a) => a.id === 'a1') as
      | (Agent & { runtimeFact?: string })
      | undefined;
    expect(merged?.name).toBe('新名'); // 声明字段被远端覆盖
    expect(merged?.rev).toBe(5); // 元数据以 payload 为准
    expect(merged?.runtimeFact).toBe('local-only'); // 本机事实字段未被抹掉
  });

  it('本地更新时丢弃远端（等下次 push）', async () => {
    useAgentsStore.setState({
      agents: [agent('a1', { name: '本地新', rev: 9, updatedAt: NEWER, updatedBy: 'dev', deletedAt: null })],
      tombstones: {},
    });
    let pullCall = 0;
    const { client } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullCall += 1;
        if (pullCall === 1) {
          return jsonResponse({
            cursor: 1,
            changes: [
              { collection: 'agents', entity: { id: 'a1', name: '远端旧', rev: 1, updatedAt: OLDER, updatedBy: 'dev-b', deletedAt: null } },
            ],
          });
        }
        return jsonResponse({ cursor: 1, changes: [] });
      }
      return jsonResponse({ accepted: ['a1'], conflicts: [], cursor: 1 });
    });
    const engine = new SyncEngine({ client, account: authAccount(true), registry: createDefaultRegistry() });

    await engine.syncNow();

    const a1 = useAgentsStore.getState().agents.find((a) => a.id === 'a1');
    expect(a1?.name).toBe('本地新');
    expect(a1?.rev).toBe(9);
  });

  it('pull 新条直接采用', async () => {
    let pullCall = 0;
    const { client } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullCall += 1;
        if (pullCall === 1) {
          return jsonResponse({
            cursor: 1,
            changes: [
              { collection: 'agents', entity: { id: 'new1', name: '远端新增', rev: 1, updatedAt: NEWER, updatedBy: 'dev-b', deletedAt: null } },
            ],
          });
        }
        return jsonResponse({ cursor: 1, changes: [] });
      }
      return jsonResponse({ accepted: ['new1'], conflicts: [], cursor: 1 });
    });
    const engine = new SyncEngine({ client, account: authAccount(true), registry: createDefaultRegistry() });

    await engine.syncNow();

    expect(useAgentsStore.getState().agents.find((a) => a.id === 'new1')?.name).toBe('远端新增');
  });

  it('未知 collection 静默跳过（前向兼容，不抛错）', async () => {
    let pullCall = 0;
    const { client } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullCall += 1;
        if (pullCall === 1) {
          return jsonResponse({
            cursor: 1,
            changes: [{ collection: 'unknownKind', entity: { id: 'z', rev: 1 } }],
          });
        }
        return jsonResponse({ cursor: 1, changes: [] });
      }
      return jsonResponse({ accepted: [], conflicts: [], cursor: 1 });
    });
    const engine = new SyncEngine({ client, account: authAccount(true), registry: createDefaultRegistry() });

    await expect(engine.syncNow()).resolves.toMatchObject({ skipped: false });
  });

  it('push 冲突：应用服务端版本、置 conflict 状态并存内存快照', async () => {
    useAgentsStore.setState({
      agents: [agent('a1', { name: '本地', rev: 1, updatedAt: OLDER, updatedBy: 'dev', deletedAt: null })],
      tombstones: {},
    });
    const conflict: PushConflict = {
      collection: 'agents',
      id: 'a1',
      server: { id: 'a1', name: '服务端', rev: 8, updatedAt: NEWER, updatedBy: 'srv', deletedAt: null },
      resolution: 'server_newer_rev',
    };
    const { client } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [] })
        : jsonResponse({ accepted: [], conflicts: [conflict], cursor: 0 }),
    );
    const engine = new SyncEngine({ client, account: authAccount(true), registry: createDefaultRegistry() });

    const result = await engine.syncNow();

    expect(result.conflicts).toBe(1);
    expect(getSyncStatus().status).toBe('conflict');
    expect(useAgentsStore.getState().agents.find((a) => a.id === 'a1')?.name).toBe('服务端');
    expect(engine.getConflicts()).toHaveLength(1);
  });
});
