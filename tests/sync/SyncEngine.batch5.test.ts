/**
 * `SyncEngine` 事件通道单测（批次 5 §2.1）。
 *
 * 覆盖规格可证伪判据（水位语义是核心）：
 * - **J1-c** 「push 成功后水位推进到本批最大 `seq`」——推进挪到 push 之前 / 干脆不推进 → 红；
 * - **J1-b** 「拉取落地**不**推进水位（本机未推事件不丢）」——在 `applyPulledEvents` 里
 *   加一行 `eventSeqs.set(...)` → 红；
 * - 未注入 `eventStream` = **纯 LWW 引擎**：push body 恒带 `events`，计数恒 0。
 *
 * 关键裁决（规格 §2.1）：水位 `eventSeqs[sid]` = 「`seq ≤ 该值的本机事件都已上行」的
 * 最大值，**只在 push 成功后**推进到本批实际推送的最大 `seq`；pull 落地绝不推进。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine } from '@/sync/SyncEngine';
import { SyncRegistry } from '@/sync/syncRegistry';
import { resetSyncStatus } from '@/sync/useSyncStatus';
import { EVENT_CURSOR_STORAGE_KEY } from '@/sync/types';
import type { SessionEventStreamAdapter } from '@/sync/eventStream';
import type { SyncAccount } from '@/sync/syncAccount';
import type { SessionEvent } from '@/types/event';

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

/** 可计数的假 fetch，并记录每次请求体（用于断言 push 携带的事件）。 */
function makeClient(handler: Handler): {
  client: SyncClient;
  calls: Array<{ url: string; body: Record<string, unknown> | null }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const call = calls.length;
    calls.push({ url, body });
    return handler(url, init ?? {}, call);
  }) as unknown as typeof fetch;
  return {
    client: new SyncClient({ baseUrl: 'http://x', fetchImpl: impl, getAccessToken: () => 'tok' }),
    calls,
  };
}

function authAccount(): SyncAccount {
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
    subscribe: () => () => undefined,
  };
}

/** 一条简单事件（`ai-title` 载荷最小，够表达 id / seq / sessionId）。 */
function evt(id: string, seq: number, sessionId = 's1'): SessionEvent {
  return { id, sessionId, parentId: null, seq, type: 'ai-title', timestamp: 1000 + seq, title: id };
}

function compareEvents(a: SessionEvent, b: SessionEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 引擎视角的假适配器：记录落地调用，并在内存里累积事件（供下一轮 readEventsSince）。 */
class FakeAdapter implements SessionEventStreamAdapter {
  readonly appended: Array<{ sessionId: string; events: SessionEvent[] }> = [];

  constructor(
    private readonly rooms: Array<{ id: string; shard?: string }>,
    private readonly store: Record<string, SessionEvent[]>,
  ) {}

  localSessions(): Array<{ id: string; shard: string | undefined }> {
    return this.rooms.map((r) => ({ id: r.id, shard: r.shard }));
  }

  /** 换装某会话的本机事件（模拟「换号后本机事件从头开始」）。 */
  setEvents(sessionId: string, events: SessionEvent[]): void {
    this.store[sessionId] = events;
  }

  async readEventsSince(sessionId: string, sinceSeq: number): Promise<SessionEvent[]> {
    return (this.store[sessionId] ?? []).filter((e) => e.seq > sinceSeq).sort(compareEvents);
  }

  async appendRemoteEvents(sessionId: string, events: SessionEvent[]): Promise<number> {
    const existing = new Set((this.store[sessionId] ?? []).map((e) => e.id));
    const fresh = events.filter((e) => !existing.has(e.id));
    this.appended.push({ sessionId, events: fresh });
    this.store[sessionId] = [...(this.store[sessionId] ?? []), ...fresh];
    return fresh.length;
  }
}

function pushBodies(calls: Array<{ url: string; body: Record<string, unknown> | null }>): unknown[][] {
  return calls
    .filter((c) => c.url.includes('/push'))
    .map((c) => (c.body?.events as unknown[]) ?? []);
}

beforeEach(async () => {
  resetSyncStatus();
  // 水位持久化走 platform.storage：上个用例的残留会污染本轮载入（→ 用例串扰）
  await platform.storage.remove(EVENT_CURSOR_STORAGE_KEY).catch(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────── J1-c：水位只在 push 成功后推进 ───────────────────

describe('J1-c：push 成功后水位推进到本批最大 seq', () => {
  it('首轮推送本机事件 → 次轮不再重推', async () => {
    const adapter = new FakeAdapter([{ id: 's1', shard: '/ws' }], {
      s1: [evt('e1', 1), evt('e2', 2), evt('e3', 3)],
    });
    const { client, calls } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [], events: [] })
        : jsonResponse({ accepted: [], conflicts: [], cursor: 0, accepted_events: 3 }),
    );
    const engine = new SyncEngine({
      client,
      account: authAccount(),
      registry: new SyncRegistry(),
      eventStream: adapter,
    });

    const first = await engine.syncNow();
    expect(first.pushedEvents).toBe(3);
    expect(pushBodies(calls)[0]).toHaveLength(3);

    // 水位已推进到 3 → 次轮无事件、无实体 → 不再 push
    const before = calls.filter((c) => c.url.includes('/push')).length;
    const second = await engine.syncNow();
    expect(second.pushedEvents).toBe(0);
    expect(calls.filter((c) => c.url.includes('/push')).length).toBe(before);
  });

  it('push 失败不推进水位（下一轮仍会重推，不丢事件）', async () => {
    const adapter = new FakeAdapter([{ id: 's1', shard: '/ws' }], {
      s1: [evt('e1', 1), evt('e2', 2), evt('e3', 3)],
    });
    let pushCount = 0;
    const { client, calls } = makeClient((url) => {
      if (url.includes('/pull')) return jsonResponse({ cursor: 0, changes: [], events: [] });
      pushCount += 1;
      if (pushCount === 1) throw new TypeError('push down (simulated)');
      return jsonResponse({ accepted: [], conflicts: [], cursor: 0, accepted_events: 3 });
    });
    const engine = new SyncEngine({
      client,
      account: authAccount(),
      registry: new SyncRegistry(),
      eventStream: adapter,
    });

    const first = await engine.syncNow();
    expect(first.pushedEvents).toBe(0); // push 失败

    // 把推进挪到 push 之前 → 首轮失败也推进 → 次轮读 seq>3 → 0 事件 → 红
    const second = await engine.syncNow();
    const bodies = pushBodies(calls);
    expect(bodies[1]).toHaveLength(3);
    expect(second.pushedEvents).toBe(3);
  });
});

// ─────────────────── J1-b：pull 落地不推进水位 ───────────────────

describe('J1-b：拉取落地不推进水位', () => {
  it('本机 seq1..5 未推 + 拉来 seq1..3 → push 失败后次轮本机 5 条仍在', async () => {
    // A 离线攒了 seq1..5；B 攒了 seq1..3（不同 id）并先推
    const adapter = new FakeAdapter([{ id: 's1', shard: '/ws' }], {
      s1: [evt('a1', 1), evt('a2', 2), evt('a3', 3), evt('a4', 4), evt('a5', 5)],
    });
    const remote = [evt('b1', 1), evt('b2', 2), evt('b3', 3)];
    let pullCount = 0;
    let pushCount = 0;
    const { client, calls } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullCount += 1;
        return jsonResponse({
          cursor: 1,
          changes: [],
          events: pullCount === 1 ? remote : [],
        });
      }
      pushCount += 1;
      // 首轮 push 失败：隔离「pull 是否推进了水位」——若 pull 推进，本机 a1..a3 将丢失
      if (pushCount === 1) throw new TypeError('push down (pull 已落地)');
      return jsonResponse({ accepted: [], conflicts: [], cursor: 1, accepted_events: 8 });
    });
    const engine = new SyncEngine({
      client,
      account: authAccount(),
      registry: new SyncRegistry(),
      eventStream: adapter,
    });

    const first = await engine.syncNow();
    expect(first.pushedEvents).toBe(0); // push 失败
    expect(adapter.appended.at(-1)?.events.map((e) => e.id)).toEqual(['b1', 'b2', 'b3']);

    // 验收：次轮 push 必须带上**本机全部 5 条**（a1..a5）——pull 若推进水位则只剩 a4/a5
    const second = await engine.syncNow();
    const ids = (pushBodies(calls)[1] as Array<{ id: string }>).map((e) => e.id);
    expect([...ids].sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3']);
    expect(second.pushedEvents).toBe(8);
  });
});

// ─────────────────── 纯 LWW 引擎：不注入事件通道 ───────────────────

describe('未注入 eventStream = 纯 LWW 引擎', () => {
  it('push body 恒带 events，计数恒 0（行为不变）', async () => {
    const registry = new SyncRegistry();
    registry.register<Record<string, unknown>>({
      collection: 'widgets',
      keyOf: (e) => String(e.id),
      read: () => ({ entities: [{ id: 'w1' }], tombstones: {} }),
      apply: () => undefined,
      payload: (e) => e,
    });
    const { client, calls } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [], events: [] })
        : jsonResponse({ accepted: ['w1'], conflicts: [], cursor: 0, accepted_events: 0 }),
    );
    const engine = new SyncEngine({ client, account: authAccount(), registry });

    const result = await engine.syncNow();

    expect(result.pushedEvents).toBe(0);
    expect(result.pulledEvents).toBe(0);
    const push = calls.find((c) => c.url.includes('/push'));
    expect(push?.body).toEqual({
      changes: [{ collection: 'widgets', entity: { id: 'w1' } }],
      events: [],
    });
  });
});

// ─────────────────── 水位按账户隔离（换号不泄漏、切回可恢复） ───────────────────

/**
 * 可切换账户的桩：`setUser(id)` 模拟「同一引擎实例下 A 登出 / B 登录 / 切回 A」。
 *
 * 场景要点是**引擎实例被复用**（`runtime` 全应用一个 engine），故这里复用同一个
 * `engine`、同一个 `FakeAdapter`，只改 `getSession().userId` 与 adapter 的本机事件。
 */
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
    subscribe: () => () => undefined,
  };
  return { account, setUser: (next) => (userId = next) };
}

describe('账户态按账户隔离：同一引擎换号不泄漏、切回可恢复', () => {
  it('A 推完后切到 B → B 的事件照常上行；切回 A → A 水位仍在（不重推）', async () => {
    // 同一会话 id `s1`，A / B 各自的本机事件 seq 都从 1 开始（模拟换号后复用会话 id）
    const adapter = new FakeAdapter([{ id: 's1', shard: '/ws' }], {
      s1: [evt('a1', 1), evt('a2', 2), evt('a3', 3)],
    });
    // `accepted_events` 如实回传本批事件数 → `pushedEvents` 可用于断言
    const { client, calls } = makeClient((url, init) => {
      if (url.includes('/pull')) return jsonResponse({ cursor: 0, changes: [], events: [] });
      const body =
        typeof init.body === 'string' ? (JSON.parse(init.body) as { events?: unknown[] }) : {};
      const count = Array.isArray(body.events) ? body.events.length : 0;
      return jsonResponse({ accepted: [], conflicts: [], cursor: 0, accepted_events: count });
    });
    const { account, setUser } = switchableAccount('user-a');
    const engine = new SyncEngine({
      client,
      account,
      registry: new SyncRegistry(), // 空注册表：push 只可能由事件通道触发
      eventStream: adapter,
    });
    const pushCount = (): number => calls.filter((c) => c.url.includes('/push')).length;

    // —— 账户 A：推完 s1 的 seq1..3 ——
    const first = await engine.syncNow();
    expect(first.pushedEvents, 'A 应上行 3 条').toBe(3);
    expect((pushBodies(calls).at(-1) as Array<{ id: string }>).map((e) => e.id)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);

    // —— 切到账户 B：本机 s1 换成 B 的 seq1..2（水位未隔离则被 A 的 s1→3 挡住）——
    setUser('user-b');
    adapter.setEvents('s1', [evt('b1', 1), evt('b2', 2)]);
    const beforeB = pushCount();

    const second = await engine.syncNow();
    // 泄漏水位（继承 A 的 s1→3）→ readEventsSince(s1, 3) = [] → pushedEvents=0 → 红
    expect(second.pushedEvents, 'B 应上行 2 条（不被 A 的水位挡住）').toBe(2);
    expect(pushCount(), 'B 应发出一次 push').toBe(beforeB + 1);
    expect((pushBodies(calls).at(-1) as Array<{ id: string }>).map((e) => e.id).sort()).toEqual([
      'b1',
      'b2',
    ]);

    // —— 切回账户 A：水位应恢复（seq1..3 已上行）→ 本轮不重推 ——
    setUser('user-a');
    adapter.setEvents('s1', [evt('a1', 1), evt('a2', 2), evt('a3', 3)]);
    const beforeBack = pushCount();

    const third = await engine.syncNow();
    expect(third.pushedEvents, '切回 A 不应重推已上行的事件').toBe(0);
    expect(pushCount(), '切回 A 不应发出 push').toBe(beforeBack);
  });

  it('pull 游标按账户隔离：切到 B 后 B 的首次 pull() 收到 since=0（不沿用 A 前进后的游标）', async () => {
    // 记录每次 /pull 的 since，验证换号后从 0 全量重拉（B 的 server_seq 是独立空间）
    const pullSinces: number[] = [];
    const { client } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullSinces.push(Number(new URL(url).searchParams.get('since')));
        // 首轮 pull 返回 cursor=100 → 引擎 pull 游标推进到 100
        return jsonResponse({ cursor: 100, changes: [], events: [] });
      }
      return jsonResponse({ accepted: [], conflicts: [], cursor: 100, accepted_events: 0 });
    });
    const { account, setUser } = switchableAccount('user-a');
    const engine = new SyncEngine({ client, account, registry: new SyncRegistry() });

    await engine.syncNow();
    expect(pullSinces, 'A 首轮 pull 从 0 起').toEqual([0]);

    // 换到账户 B：若沿用 A 的游标（100）→ B 的 pull(since=100) 拉不到本账户任何数据 → 红
    setUser('user-b');
    await engine.syncNow();
    expect(pullSinces.at(-1), 'B 首次 pull 的 since 应为 0（账户态已按账户隔离）').toBe(0);
  });
});
