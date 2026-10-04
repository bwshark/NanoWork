/**
 * 设置弹窗「用量」分区（FR-11.1）。
 *
 * 锁的是三种「没有数据」必须分开说这件事——它们长得像，但用户该做的下一步
 * 完全不同：
 *
 * 1. 还没读 → 「正在读取用量…」；
 * 2. 读不到（网关没起 / 引擎版本旧） → 报原因，并说明数据在哪；
 * 3. 读到了但确实没用量 → 「还没有用量记录」。
 *
 * 混成一句「暂无数据」，用户分不清「我没用过」和「应用坏了」。
 *
 * 另外钉住窗口切换：点了「7 天」，图与合计文案必须真的换成 7 天。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setRuntimeForTest } from '@/ai/runtime';
import { UsageSection } from '@/components/settings/sections/UsageSection';
import { emptyUsageStats, todayLocalIso, zeroCounters } from '@/lib/usageReport';
import { useUsageStore } from '@/stores/usageStore';
import type { AgentRuntime } from '@/ai/runtime/types';
import type { UsageDay, UsageStats } from '@/types';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';

const readUsageStats = vi.fn();

function stubRuntime(): void {
  __setRuntimeForTest({ readUsageStats } as unknown as AgentRuntime);
}

/** 以**本机今天**为基准往前推 n 天（引擎按本地日归日，fixture 必须同口径） */
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayLocalIso(d);
}

function day(date: string, totalTokens: number, source = 'user'): UsageDay {
  return {
    date,
    bySource: { [source]: { ...zeroCounters(), totalTokens, requests: 1 } },
    ...zeroCounters(),
    totalTokens,
    requests: 1,
  };
}

function fixture(patch: Partial<UsageStats> = {}): UsageStats {
  return {
    ...emptyUsageStats(),
    available: true,
    days: [
      day(isoDaysAgo(2), 3_000, 'user'),
      day(isoDaysAgo(1), 9_000, 'cron'),
      day(isoDaysAgo(0), 345, 'user'),
    ],
    totalTokens: 12_345,
    providers: [
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        ...zeroCounters(),
        inputTokens: 8_000,
        outputTokens: 4_345,
        totalTokens: 12_345,
        requests: 3,
      },
    ],
    updatedAt: '2026-10-03T10:20:00Z',
    summary: {
      tokens30d: 12_345,
      tokens365d: 12_345,
      reportedTokens30d: 10_000,
      estimatedTokens30d: 2_345,
      cacheReadTokens30d: 1_000,
      cacheReadRate30d: 0.123,
      peakDayTokens: 9_000,
      currentStreakDays: 3,
      longestStreakDays: 5,
      activeDays30d: 3,
      requests30d: 3,
      failedRequests30d: 0,
    },
    ...patch,
  };
}

beforeEach(() => {
  unmount();
  readUsageStats.mockReset();
  stubRuntime();
  useUsageStore.setState({
    stats: emptyUsageStats(),
    loaded: false,
    refreshing: false,
    windowDays: 30,
  });
});

describe('设置「用量」分区', () => {
  it('挂载即读取，并把引擎的数字显示出来', async () => {
    readUsageStats.mockResolvedValue(fixture());

    const host = mount(<UsageSection />);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('近 30 天概览');
    expect(text, '近 30 天 token 未显示').toContain('1.2 万');
    expect(text, '按来源拆分未渲染').toContain('定时任务');
    expect(text, '模型用量未渲染').toContain('openai · gpt-4o-mini');
    expect(text, '缓存命中率未渲染').toContain('12%');
  });

  it('读不到时报原因，并说明数据在哪（不假装「没用过」）', async () => {
    readUsageStats.mockResolvedValue(emptyUsageStats('读取用量超时（网关未启动？）'));

    const host = mount(<UsageSection />);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('读不到用量数据');
    expect(text).toContain('网关未启动');
    expect(text, '要提示数据来自引擎的 /v1/usage').toContain('/v1/usage');
    expect(text, '读不到时不该显示概览').not.toContain('近 30 天概览');
  });

  it('读到了但确实没用量：说「还没有用量记录」', async () => {
    readUsageStats.mockResolvedValue(fixture({ days: [], providers: [], totalTokens: 0 }));

    const host = mount(<UsageSection />);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('还没有用量记录');
    expect(text).toContain('金额暂不统计');
  });

  it('切换窗口：合计文案与图表跟着变', async () => {
    readUsageStats.mockResolvedValue(fixture());
    const host = mount(<UsageSection />);
    await flush();
    expect(host.textContent).toContain('近 30 天 ·');

    const seven = buttonByText(host, '7 天');
    expect(seven, '未找到「7 天」切换按钮').toBeTruthy();
    // 必须走 act 包裹的 click：MUI 的 ToggleButton 带 TouchRipple，
    // 裸 click 会让状态更新落在 act 之外（控制台告警 + 断言可能早于重渲染）
    click(seven);
    await flush();

    expect(useUsageStore.getState().windowDays).toBe(7);
    expect(host.textContent, '切窗口后合计文案没变').toContain('近 7 天 ·');
  });

  it('最后一次更新时间落到界面上（数据新鲜度）', async () => {
    readUsageStats.mockResolvedValue(fixture());

    const host = mount(<UsageSection />);
    await flush();

    expect(host.textContent ?? '').toContain('最后更新：');
  });
});
