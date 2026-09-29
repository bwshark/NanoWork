/**
 * `SyncEngine` 的 C 类资产接线单测（批次 6b，判据 J-8）。
 *
 * 用**假** `FileAssetsAdapter`（本文件只验引擎的接线，资产的合并语义由
 * `tests/sync/fileAssets.test.ts` 与 `tests/lib/memoryMerge.test.ts` 覆盖）：
 *
 * - **hydrate 必须在 pull 之前**——「内容即版本」要先于组装上行负载生效，
 *   挪到 pull 之后 → 本轮 push 用的是上一轮的版本号（红）；
 * - **collect 并入 push**，与 LWW 实体同批上行；
 * - **pull 下来的 C 类变更走适配器落地**并计入 `pulled`（未登记进 registry，
 *   故 `applyPull` 不会重复计数）；
 * - **未注入** = 既有行为不变（push 里没有 C 类条目）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine } from '@/sync/SyncEngine';
import { SyncRegistry } from '@/sync/syncRegistry';
import { resetSyncStatus } from '@/sync/useSyncStatus';
import type { FileAssetsAdapter } from '@/sync/fileAssets';
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
class FakeFileAssets implements FileAssetsAdapter {
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

const MEMORY_CHANGE: SyncChange = {
  collection: 'memoryUser',
  entity: { id: 'user', content: 'x', rev: 1, updatedAt: '2026-09-29T10:00:00.000Z', deletedAt: null },
};

beforeEach(() => {
  resetSyncStatus();
});

describe('J-8：C 类资产通道的引擎接线', () => {
  it('hydrate 在 pull **之前**；collect 并入 push；pull 的 C 类变更走适配器落地', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.includes('/pull')) {
        return jsonResponse({ cursor: 7, changes: [MEMORY_CHANGE], events: [] });
      }
      return jsonResponse({ accepted: ['user'], conflicts: [], cursor: 7, accepted_events: 0 });
    });
    const adapter = new FakeFileAssets([MEMORY_CHANGE]);
    const engine = new SyncEngine({
      client,
      account: authAccount(),
      registry: new SyncRegistry(),
      fileAssets: adapter,
    });

    const result = await engine.syncNow();

    // 顺序：hydrate →（pull）→ apply → collect →（push）→（second pull）→ apply
    expect(adapter.order[0]).toBe('hydrate');
    expect(adapter.order).toContain('collect');
    expect(adapter.applied).toHaveLength(2); // first pull + accepted 后的 second pull
    expect(result.pulled).toBe(2);

    // C 类条目确实进了 push 负载（与 LWW 实体同批）
    const push = calls.find((c) => c.url.includes('/push'));
    const changes = (push?.body?.changes as Array<{ collection: string }>) ?? [];
    expect(changes.some((c) => c.collection === 'memoryUser')).toBe(true);
  });

  it('未注入适配器 → push 里没有 C 类条目（既有行为不变）', async () => {
    const { client, calls } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 1, changes: [MEMORY_CHANGE], events: [] })
        : jsonResponse({ accepted: [], conflicts: [], cursor: 1, accepted_events: 0 }),
    );
    const engine = new SyncEngine({
      client,
      account: authAccount(),
      registry: new SyncRegistry(),
    });

    const result = await engine.syncNow();
    // 未登记 → 静默跳过，不崩、不计数
    expect(result.pulled).toBe(0);

    const push = calls.find((c) => c.url.includes('/push'));
    const changes = (push?.body?.changes as Array<{ collection: string }>) ?? [];
    expect(changes.some((c) => c.collection === 'memoryUser')).toBe(false);
  });

  it('适配器抛错不吞掉整轮同步（落地失败 → 仍走 push）', async () => {
    const { client, calls } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 1, changes: [], events: [] })
        : jsonResponse({ accepted: ['user'], conflicts: [], cursor: 1, accepted_events: 0 }),
    );
    const adapter = new FakeFileAssets([MEMORY_CHANGE]);
    const engine = new SyncEngine({
      client,
      account: authAccount(),
      registry: new SyncRegistry(),
      fileAssets: adapter,
    });

    await engine.syncNow();
    expect(calls.some((c) => c.url.includes('/push'))).toBe(true);
    expect(adapter.order).toContain('collect');
  });
});
