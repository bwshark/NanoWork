/**
 * `src/sync/runtime.ts`：装配 + 生命周期 + 抑制机制。
 *
 * 覆盖 §I.3 变异清单：
 * - **G-1** 去掉 `suppress` → 「pull 落地不再触发额外同步」的自激环用例变红
 *   （本轮 pull 落地 N 条 = N 次 `set`；有 `suppress` 时订阅只置 `missed`，
 *   结束时**合并成 1 次** `notifyLocalChange()`；无 `suppress` 则 N 次）；
 * - **G-3** 去掉 store 订阅 → 「`createAgent` 后 1s 内 fetch 被调用」变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncRuntime } from '@/sync/runtime';
import { useAgentsStore } from '@/stores/agentsStore';

type Handler = (url: string, init: RequestInit, call: number) => Response | Promise<Response>;

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function makeFetch(handler: Handler): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init ?? {}, calls.length - 1);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SESSION = { userId: 'u1', email: 'e@x', access: 'tok', refresh: 'r' };

/**
 * 排空微任务 + 让「自动同步」（`setSession` → `start` → `syncNow`）跑完。
 *
 * 每轮同步至少两跳 fetch（pull + push）；轮询到 `calls` 达到基线即可确定自动同步
 * 已过网络阶段，再多排几个微任务让 `running=false` 落地，后续手动同步才不会被判
 * 「并发重复调用」而返回 skipped。
 */
async function settleAuto(calls: string[], baseline = 2): Promise<void> {
  for (let i = 0; i < 30 && calls.length < baseline; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  useAgentsStore.setState({ agents: [], tombstones: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('G-1：suppress 抑制 pull 落地触发的再同步', () => {
  it('一轮 pull 落地 N 条 → notifyLocalChange 只被调用 1 次（合并）', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.includes('/pull')
        ? jsonResponse({
            cursor: 1,
            changes: [
              { collection: 'agents', entity: { id: 'a1', name: 'A1', rev: 1, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-b', deletedAt: null } },
              { collection: 'agents', entity: { id: 'a2', name: 'A2', rev: 1, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-b', deletedAt: null } },
              { collection: 'agents', entity: { id: 'a3', name: 'A3', rev: 1, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-b', deletedAt: null } },
            ],
          })
        : jsonResponse({ accepted: [], conflicts: [], cursor: 1 }),
    );
    const runtime = createSyncRuntime({ fetchImpl: impl });

    await runtime.account.setSession(SESSION);
    await settleAuto(calls);
    runtime.engine.stop(); // 只留受控的手动同步

    // 目标 store 清空：让下一次 pull 的 3 条各自真正落地（各触发一次 set）
    useAgentsStore.setState({ agents: [], tombstones: {} });

    const notifySpy = vi.spyOn(runtime.engine, 'notifyLocalChange');
    await runtime.engine.syncNow();

    expect(useAgentsStore.getState().agents.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3']);
    // 有 suppress：3 次落地 set 合并成 1 次 notify；去掉 suppress → 3 次 → 变红
    expect(notifySpy).toHaveBeenCalledTimes(1);

    runtime.dispose();
  });
});

describe('G-3：store 订阅把本地改动转成同步（防抖 1s）', () => {
  it('createAgent 后推进 1s → fetch 被调用（去掉订阅则 0 次）', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.includes('/pull') ? jsonResponse({ cursor: 0, changes: [] }) : jsonResponse({ accepted: [], conflicts: [], cursor: 0 }),
    );
    const runtime = createSyncRuntime({ fetchImpl: impl });

    await runtime.account.setSession(SESSION);
    await settleAuto(calls);
    runtime.engine.stop();
    const before = calls.length;

    // 本地改动 → 订阅捕获 → 防抖 1s → 同步
    useAgentsStore.getState().createAgent({ name: '新 Agent' });
    await vi.advanceTimersByTimeAsync(1100);

    expect(calls.length).toBeGreaterThan(before);

    runtime.dispose();
  });
});

describe('生命周期：登录启动 / 登出停止 / dispose', () => {
  it('未登录时 notifyLocalChange + 推进时间 → 0 次 fetch', async () => {
    const { impl, calls } = makeFetch(() => jsonResponse({ cursor: 0, changes: [] }));
    const runtime = createSyncRuntime({ fetchImpl: impl });

    runtime.engine.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);

    runtime.dispose();
  });

  it('dispose 取消订阅：之后 store 改动不再触发同步', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.includes('/pull') ? jsonResponse({ cursor: 0, changes: [] }) : jsonResponse({ accepted: [], conflicts: [], cursor: 0 }),
    );
    const runtime = createSyncRuntime({ fetchImpl: impl });
    await runtime.account.setSession(SESSION);
    await settleAuto(calls);

    runtime.dispose();
    const after = calls.length;

    useAgentsStore.getState().createAgent({ name: 'after-dispose' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.length).toBe(after);
  });
});
