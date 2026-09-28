/**
 * 批次 4 引擎侧判据：F（`pulled` 语义）+ E（先 pull 后 push）+ B-1（channels 删除不复活）。
 *
 * 覆盖 §I.3 变异清单：
 * - **F-1** `applyChange` 恒 `return true` → 「本地更新时 `pulled` 不 +1」变红；
 * - **E-②** 先 push 再 pull → 本文件的调用顺序断言变红；
 * - **B-1** channels `keyOf` 改成 `id` → 「删除渠道不复活」变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncClient } from '@/sync/SyncClient';
import { SyncEngine } from '@/sync/SyncEngine';
import { createDefaultRegistry } from '@/sync/syncRegistry';
import { resetSyncStatus } from '@/sync/useSyncStatus';
import { useAgentsStore } from '@/stores/agentsStore';
import { useChannelsStore } from '@/stores/channelsStore';
import type { SyncAccount } from '@/sync/syncAccount';
import type { Agent, ChannelConfig } from '@/types';

const OLDER = '2026-01-01T00:00:00.000Z';
const NEWER = '2026-06-01T00:00:00.000Z';

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as unknown as Response;
}

function makeClient(handler: Handler): { client: SyncClient; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = calls.length;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {}, call);
  }) as unknown as typeof fetch;
  return { client: new SyncClient({ baseUrl: 'http://x', fetchImpl: impl, getAccessToken: () => 'tok' }), calls };
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

function channel(id: string, kind: ChannelConfig['kind'], over: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id, kind, enabled: true, allowFrom: [], syncStatus: 'idle', ...over };
}

beforeEach(() => {
  resetSyncStatus();
  useAgentsStore.setState({ agents: [], tombstones: {} });
  useChannelsStore.setState({ configs: [], tombstones: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────── F：pulled 语义 ───────────────────────────

describe('F / F-1：pulled 只计「真正落地」的条数', () => {
  it('一批含「1 条新 + 1 条本地更新（远端更旧）」→ pulled === 1', async () => {
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
              { collection: 'agents', entity: { id: 'new1', name: '远端新增', rev: 1, updatedAt: NEWER, updatedBy: 'dev-b', deletedAt: null } },
              { collection: 'agents', entity: { id: 'a1', name: '远端旧', rev: 1, updatedAt: OLDER, updatedBy: 'dev-b', deletedAt: null } },
            ],
          });
        }
        return jsonResponse({ cursor: 1, changes: [] });
      }
      return jsonResponse({ accepted: [], conflicts: [], cursor: 1 });
    });
    const engine = new SyncEngine({ client, account: authAccount(), registry: createDefaultRegistry() });

    const result = await engine.syncNow();

    expect(result.pulled).toBe(1); // 改回恒 return true 会得到 2
    expect(useAgentsStore.getState().agents.find((a) => a.id === 'new1')).toBeTruthy();
    expect(useAgentsStore.getState().agents.find((a) => a.id === 'a1')?.name).toBe('本地新');
  });
});

// ─────────────────────────── E：先 pull 后 push ───────────────────────────

describe('E / E-②：先 pull 再 push', () => {
  it('syncNow 的首次 /pull 调用早于首次 /push', async () => {
    useAgentsStore.setState({ agents: [agent('a1')], tombstones: {} });
    const { client, calls } = makeClient((url) =>
      url.includes('/pull')
        ? jsonResponse({ cursor: 0, changes: [] })
        : jsonResponse({ accepted: [], conflicts: [], cursor: 0 }),
    );
    const engine = new SyncEngine({ client, account: authAccount(), registry: createDefaultRegistry() });

    await engine.syncNow();

    const firstPull = calls.findIndex((c) => c.url.includes('/api/sync/pull'));
    const firstPush = calls.findIndex((c) => c.url.includes('/api/sync/push'));
    expect(firstPull).toBeGreaterThanOrEqual(0);
    expect(firstPush).toBeGreaterThanOrEqual(0);
    expect(firstPull).toBeLessThan(firstPush); // 先 push 再 pull → 变红
  });
});

// ─────────────────────────── B-1：删除渠道不复活 ───────────────────────────

describe('B / B-1：本机已删渠道不被对端旧副本复活', () => {
  it('本地墓碑更新 → pull 回同 kind 的旧存活副本 → 该 kind 不出现在 configs', async () => {
    // 本机删除 feishu：configs 已无它，墓碑表留下（更新版本）
    useChannelsStore.setState({
      configs: [],
      tombstones: { feishu: { rev: 5, updatedAt: NEWER, updatedBy: 'dev-a', deletedAt: NEWER } },
    });
    let pullCall = 0;
    const { client } = makeClient((url) => {
      if (url.includes('/pull')) {
        pullCall += 1;
        if (pullCall === 1) {
          return jsonResponse({
            cursor: 1,
            changes: [
              {
                collection: 'channels',
                entity: { id: 'remote-random', kind: 'feishu', enabled: true, allowFrom: [], rev: 1, updatedAt: OLDER, updatedBy: 'dev-b', deletedAt: null },
              },
            ],
          });
        }
        return jsonResponse({ cursor: 1, changes: [] });
      }
      return jsonResponse({ accepted: [], conflicts: [], cursor: 1 });
    });
    const engine = new SyncEngine({ client, account: authAccount(), registry: createDefaultRegistry() });

    await engine.syncNow();

    // keyOf 取 id → 墓碑（键=kind）与实体（键=id）对不上 → 判成新条落地 → 复活 → 变红
    expect(useChannelsStore.getState().configs.find((c) => c.kind === 'feishu')).toBeUndefined();
    expect(useChannelsStore.getState().tombstones.feishu).toMatchObject({ rev: 5 });
  });

  it('feishu 与 lark 是两条独立条目（各自落地、不互相覆盖）', () => {
    useChannelsStore.setState({ configs: [channel('id-f', 'feishu')], tombstones: {} });
    const spec = createDefaultRegistry().get('channels')!;
    spec.apply({ id: 'x', kind: 'lark', enabled: true, allowFrom: [], syncStatus: 'idle', rev: 1, updatedAt: NEWER, updatedBy: 'dev-b', deletedAt: null });
    const kinds = useChannelsStore.getState().configs.map((c) => c.kind).sort();
    expect(kinds).toEqual(['feishu', 'lark']);
  });
});
