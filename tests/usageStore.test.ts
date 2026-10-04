/**
 * 用量 store（FR-11.1）。
 *
 * 三条必须钉住的语义：
 *
 * 1. **读不到不是异常**：网关没起是常态，`available=false` + 原因要如实落到 state，
 *    不能让设置弹窗整块崩掉；
 * 2. **「还没读」与「读到了但没有用量」是两件事**：靠 `loaded` 区分，
 *    界面据此分别显示「正在读取」与「还没有用量记录」；
 * 3. **并发去重**：分区挂载触发一次读取，StrictMode 还会再来一次，
 *    不该把同一份聚合 SQL 打两遍。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setRuntimeForTest } from '@/ai/runtime';
import { emptyUsageStats, type UsageWindow } from '@/lib/usageReport';
import { useUsageStore } from '@/stores/usageStore';
import type { AgentRuntime } from '@/ai/runtime/types';
import type { UsageStats } from '@/types';

const readUsageStats = vi.fn();

function stubRuntime(overrides: Record<string, unknown> = {}): void {
  __setRuntimeForTest({
    readUsageStats,
    ...overrides,
  } as unknown as AgentRuntime);
}

function stats(patch: Partial<UsageStats> = {}): UsageStats {
  return {
    ...emptyUsageStats(),
    available: true,
    ...patch,
  };
}

beforeEach(() => {
  readUsageStats.mockReset();
  useUsageStore.setState({
    stats: emptyUsageStats(),
    loaded: false,
    refreshing: false,
    windowDays: 30,
  });
});

describe('用量 store 读取', () => {
  it('读成功：报表原样落到 state，并标记已读过', async () => {
    const payload = stats({ totalTokens: 1234 });
    readUsageStats.mockResolvedValue(payload);
    stubRuntime();

    await useUsageStore.getState().refresh();

    expect(useUsageStore.getState().stats).toEqual(payload);
    expect(useUsageStore.getState().loaded).toBe(true);
    expect(useUsageStore.getState().refreshing).toBe(false);
  });

  it('引擎说读不到（网关没起）：不算崩溃，原因原样保留', async () => {
    readUsageStats.mockResolvedValue(emptyUsageStats('读取用量超时（网关未启动？）'));
    stubRuntime();

    await useUsageStore.getState().refresh();

    expect(useUsageStore.getState().loaded).toBe(true);
    expect(useUsageStore.getState().stats.available).toBe(false);
    expect(useUsageStore.getState().stats.error).toContain('网关未启动');
  });

  it('实现违约抛异常：收敛成空报表而不是把调用方炸掉', async () => {
    readUsageStats.mockRejectedValue(new Error('boom'));
    stubRuntime();

    await useUsageStore.getState().refresh();

    expect(useUsageStore.getState().loaded).toBe(true);
    expect(useUsageStore.getState().stats.available).toBe(false);
    expect(useUsageStore.getState().stats.error).toBe('boom');
    expect(useUsageStore.getState().refreshing).toBe(false);
  });

  it('运行时根本没有这个能力（Web 端）也收敛成空报表', async () => {
    __setRuntimeForTest({} as unknown as AgentRuntime);

    await useUsageStore.getState().refresh();

    expect(useUsageStore.getState().loaded).toBe(true);
    expect(useUsageStore.getState().stats.available).toBe(false);
  });

  it('并发只读一次（StrictMode 双挂载不会打两次）', async () => {
    // 用对象属性而不是局部 `let` 存 resolve：赋值发生在 Promise 的 executor 回调里，
    // TS 的流分析看不见它，会把变量收窄成 `null`（进而判成「不可调用」）
    const gate: { resolve: ((value: UsageStats) => void) | null } = { resolve: null };
    readUsageStats.mockReturnValue(
      new Promise<UsageStats>((r) => {
        gate.resolve = r;
      }),
    );
    stubRuntime();

    const first = useUsageStore.getState().refresh();
    const second = useUsageStore.getState().refresh();
    // 第二次必须在**还没拿到结果**时就退出，否则只是「运气好没并发」
    expect(readUsageStats).toHaveBeenCalledTimes(1);

    gate.resolve?.(stats());
    await Promise.all([first, second]);
    expect(readUsageStats).toHaveBeenCalledTimes(1);
    expect(useUsageStore.getState().loaded).toBe(true);
  });
});

describe('用量 store 窗口', () => {
  it('只接受登记过的档位（点了 90 天，图不能还是 7 天）', () => {
    useUsageStore.getState().setWindowDays(90);
    expect(useUsageStore.getState().windowDays).toBe(90);

    // 45 天不是登记过的档位：类型上要靠断言才写得出来，
    // 而运行期它完全可能来自一处拼错的字面量——store 必须无视它
    useUsageStore.getState().setWindowDays(45 as unknown as UsageWindow);
    expect(useUsageStore.getState().windowDays).toBe(90);
  });
});
