/**
 * `SyncEngine` 的产物同步通道接线单测（批次 6，判据 J-9）。
 *
 * 用**假** `ArtifactsAdapter`（本文件只验引擎的接线，适配器的合并语义由
 * `tests/sync/artifacts.test.ts` 覆盖）：
 *
 * - **hydrate 必须在 pull 之前**——`collect()` 阶段要补 `updatedBy` 设备 id，未水合
 *   则 `collect()` 返回空，本轮 push 会漏掉产物；
 * - **collect 并入 push**，与 LWW 实体 / C 类资产同批上行；
 * - **pull 下来的产物变更走适配器落地**并计入 `pulled`（未登记进 registry，故
 *   `applyPull` 不会重复计数）；
 * - **未注入** = 既有行为不变（push 里没有产物条目）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine } from '@/sync/SyncEngine';
import { SyncRegistry } from '@/sync/syncRegistry';
import { resetSyncStatus } from '@/sync/useSyncStatus';
import type { ArtifactsAdapter } from '@/sync/artifacts';
import type { SyncAccount } from '@/sync/syncAccount';
import type { SyncChange } from '@/sync/types';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

function makeClient(handler: Handler): {
  client: SyncClient;
  calls: Array<{ url: string; body: Record<string, unknown> | null }>;
} {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ url, body });
    return handler(url, init ?? {});
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
    deleteAccount: async () => undefined,
    subscribe: () => () => undefined,
  };
}

/** 假适配器：记录调用顺序，可配置「collect 产出」与「apply 返回值」。 */
class FakeArtifacts implements ArtifactsAdapter {
  readonly order: string[] = [];
  readonly applied: SyncChange[] = [];

  constructor(
    private readonly outgoing: SyncChange[] = [],
    private readonly applyResult = 1,
  ) {}

  async hydrate(): Promise<void> {
    this.order.push('hydrate');
  }

  collect(): SyncChange[] {
    this.order.push('collect');
    return this.outgoing;
  }

  async apply(change: SyncChange): Promise<number> {
    this.order.push('apply');
    this.applied.push(change);
    return this.applyResult;
  }
}

const ART_CHANGE: SyncChange = {
  collection: 'artifactIndex',
  entity: { id: 'a1', contentHash: 'h', rev: 1, updatedAt: '2026-09-29T10:00:00.000Z', deletedAt: null },
};

beforeEach(() => {
  resetSyncStatus();
});

describe('J-9：产物同步通道的引擎接线', () => {
  it('hydrate 在 pull **之前**；collect 并入 push；pull 的产物变更走适配器落地', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.includes('/pull')) {
        return jsonResponse({ cursor: 7, changes: [ART_CHANGE], events: [] });
      }
      return jsonResponse({ accepted: ['a1'], conflicts: [], cursor: 7, accepted_events: 0 });
    });
    const adapter = new FakeArtifacts([ART_CHANGE]);
    const engine = new SyncEngine({ client, account: authAccount(), registry: new SyncRegistry(), artifacts: adapter });

    const result = await engine.syncNow();

    // 顺序：hydrate →（pull）→ apply → collect →（push）→（second pull）→ apply
    expect(adapter.order[0]).toBe('hydrate');
    expect(adapter.order).toContain('collect');
    expect(adapter.applied).toHaveLength(2); // first pull + accepted 后的 second pull
    expect(result.pulled).toBe(2);

    // 产物条目确实进了 push 负载（与 LWW 实体同批）
    const push = calls.find((c) => c.url.includes('/push'));
    const changes = (push?.body?.changes as Array<{ collection: string }>) ?? [];
    expect(changes.some((c) => c.collection === 'artifactIndex')).toBe(true);
  });

  it('未注入适配器 → push 里没有产物条目（既有行为不变）', async () => {
    const { client, calls } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 1, changes: [ART_CHANGE], events: [] })
        : jsonResponse({ accepted: [], conflicts: [], cursor: 1, accepted_events: 0 }),
    );
    const engine = new SyncEngine({ client, account: authAccount(), registry: new SyncRegistry() });

    const result = await engine.syncNow();
    // 未登记 → 静默跳过，不崩、不计数
    expect(result.pulled).toBe(0);

    const push = calls.find((c) => c.url.includes('/push'));
    const changes = (push?.body?.changes as Array<{ collection: string }>) ?? [];
    expect(changes.some((c) => c.collection === 'artifactIndex')).toBe(false);
  });

  it('适配器抛错不吞掉整轮同步（落地失败 → 仍走 push）', async () => {
    const { client, calls } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 1, changes: [], events: [] })
        : jsonResponse({ accepted: ['a1'], conflicts: [], cursor: 1, accepted_events: 0 }),
    );
    const adapter = new FakeArtifacts([ART_CHANGE]);
    const engine = new SyncEngine({ client, account: authAccount(), registry: new SyncRegistry(), artifacts: adapter });

    await engine.syncNow();
    expect(calls.some((c) => c.url.includes('/push'))).toBe(true);
    expect(adapter.order).toContain('collect');
  });
});
