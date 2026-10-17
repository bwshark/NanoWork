/**
 * 用量报表的展示层换算（FR-11.1）。
 *
 * 这里锁的都是「数字给人看」这件事上真实会出错的点：
 *
 * 1. **窗口右端必须是今天**：`sliceUsageDays` 曾经可能用 UTC 日算今天，
 *    东八区早上 8 点前会把「今天」算成昨天，图表整整少一天；
 * 2. **算不出来的东西不能显示 0%**：缓存命中率 `null` 与「命中率真的是 0」
 *    在界面上必须是两个说法（— vs 0%），否则用户会以为缓存完全没生效；
 * 3. **排序必须稳定**：来源拆分直接渲染 `Object.entries` 会随引擎返回顺序抖动。
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateBySource,
  averageTtftMs,
  dateAxisLabel,
  emptyUsageStats,
  formatRate,
  formatTokens,
  formatTtft,
  sliceUsageDays,
  sumDays,
  todayLocalIso,
  zeroCounters,
} from '@/lib/usageReport';
import type { UsageCounters, UsageDay } from '@/types';

function counters(patch: Partial<UsageCounters> = {}): UsageCounters {
  return { ...zeroCounters(), ...patch };
}

function day(date: string, patch: Partial<UsageCounters> = {}): UsageDay {
  return { date, bySource: {}, ...counters(patch) };
}

function dayWithSource(
  date: string,
  sources: Record<string, Partial<UsageCounters>>,
): UsageDay {
  const bySource: Record<string, UsageCounters> = {};
  for (const [source, patch] of Object.entries(sources)) bySource[source] = counters(patch);
  return { date, bySource, ...counters() };
}

describe('formatTokens', () => {
  it('一万以下给精确值（这个量级用户会拿去对账）', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(9_999)).toBe('9,999');
  });

  it('一万以上用「万 / 亿」而不是 K / M（中文界面）', () => {
    expect(formatTokens(10_000)).toBe('1 万');
    expect(formatTokens(12_345)).toBe('1.2 万');
    expect(formatTokens(100_000_000)).toBe('1 亿');
    expect(formatTokens(123_456_789)).toBe('1.2 亿');
  });

  it('负数 / 非有限值收敛到 0（不渲染出 NaN / -1）', () => {
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('小数截断而不是四舍五入（token 是整数）', () => {
    expect(formatTokens(9_999.9)).toBe('9,999');
  });
});

describe('formatRate', () => {
  it('算不出来显示破折号，而不是 0%', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(Number.NaN)).toBe('—');
  });

  it('0-1 的比例取整成百分比', () => {
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.123)).toBe('12%');
    expect(formatRate(1)).toBe('100%');
  });
});

describe('todayLocalIso', () => {
  it('取本机日而不是 UTC 日（东八区凌晨不会被算成昨天）', () => {
    // 本地 2026-01-01 00:30 —— 同一时刻的 UTC 是 2025-12-31 16:30
    expect(todayLocalIso(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
    expect(todayLocalIso(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01');
  });
});

describe('sliceUsageDays', () => {
  const days = [
    day('2026-03-01', { totalTokens: 1 }),
    day('2026-03-05', { totalTokens: 2 }),
    day('2026-03-09', { totalTokens: 3 }),
    day('2026-03-10', { totalTokens: 4 }),
  ];

  it('窗口含今天，左端是「今天往前 N-1 天」', () => {
    const sliced = sliceUsageDays(days, 7, '2026-03-10');
    expect(sliced.map((d) => d.date)).toEqual([
      '2026-03-05',
      '2026-03-09',
      '2026-03-10',
    ]);
  });

  it('窗口外的天被切掉（7 天窗口装不下 10 天前的记录）', () => {
    expect(sliceUsageDays(days, 2, '2026-03-10').map((d) => d.date)).toEqual([
      '2026-03-09',
      '2026-03-10',
    ]);
  });

  it('「今天」非法时原样返回全部（日期串拼错不该让图表变空）', () => {
    expect(sliceUsageDays(days, 7, 'not-a-date')).toHaveLength(days.length);
  });
});

describe('aggregateBySource', () => {
  it('跨天合并同一来源并按 token 降序', () => {
    const rows = aggregateBySource([
      dayWithSource('2026-03-09', { user: { totalTokens: 100 }, cron: { totalTokens: 900 } }),
      dayWithSource('2026-03-10', { user: { totalTokens: 300 }, api: { totalTokens: 50 } }),
    ]);
    expect(rows.map((r) => r.source)).toEqual(['cron', 'user', 'api']);
    expect(rows[1].counters.totalTokens).toBe(400);
    expect(rows[1].label).toBe('对话');
  });

  it('未登记的来源原样显示（引擎新增来源时不该显示空白）', () => {
    const rows = aggregateBySource([dayWithSource('2026-03-10', { unknown_src: { totalTokens: 1 } })]);
    expect(rows[0].label).toBe('unknown_src');
  });

  it('token 相同时按来源名排序（顺序稳定，图例不会抖）', () => {
    const rows = aggregateBySource([
      dayWithSource('2026-03-10', { user: { totalTokens: 5 }, cron: { totalTokens: 5 } }),
    ]);
    expect(rows.map((r) => r.source)).toEqual(['cron', 'user']);
  });
});

describe('sumDays', () => {
  it('逐日合计（含缓存与耗时）', () => {
    const total = sumDays([
      day('2026-03-09', { totalTokens: 10, requests: 2, durationMs: 100 }),
      day('2026-03-10', { totalTokens: 5, requests: 1, durationMs: 250, failedRequests: 1 }),
    ]);
    expect(total.totalTokens).toBe(15);
    expect(total.requests).toBe(3);
    expect(total.failedRequests).toBe(1);
    expect(total.durationMs).toBe(350);
  });

  it('空窗口是全 0 而不是 undefined', () => {
    expect(sumDays([])).toEqual(zeroCounters());
  });
});

describe('dateAxisLabel', () => {
  it('取月日（90 天窗口里年份不会变，带上只会挤成一团）', () => {
    expect(dateAxisLabel('2026-03-05')).toBe('3/5');
    expect(dateAxisLabel('2026-12-31')).toBe('12/31');
  });

  it('非标准日期原样返回（不编一个出来）', () => {
    expect(dateAxisLabel('2026-03')).toBe('2026-03');
  });
});

describe('emptyUsageStats', () => {
  it('无参数时不带 error 键（「还没读」≠「读失败」）', () => {
    const stats = emptyUsageStats();
    expect(stats.available).toBe(false);
    expect('error' in stats).toBe(false);
    expect(stats.days).toEqual([]);
    // 命中率必须是 null：0% 会被读成「缓存完全没生效」
    expect(stats.summary.cacheReadRate30d).toBeNull();
  });

  it('带原因时把原因带上（界面要显示它）', () => {
    expect(emptyUsageStats('网关未启动').error).toBe('网关未启动');
  });
});

/**
 * 平均首字延迟（FR-11.7）。
 *
 * **分母不是请求数**：只有流式请求量得到首字。拿总请求数当分母会把平均值摊薄成
 * 一个偏小的假数字 —— 而「偏小的错数」比「—」危险得多，因为没人会去怀疑一个
 * 更好看的数字。这批用例钉的就是这两条：分母是 `timedRequests`、未测到显示「—」。
 */
describe('平均首字延迟', () => {
  it('分母是「量到过首字的请求数」，不是请求总数', () => {
    // 10 次请求里只有 2 次是流式（量得到首字），合计 2000ms
    const c = counters({ requests: 10, timedRequests: 2, ttftMs: 2000 });
    expect(averageTtftMs(c)).toBe(1000);
    expect(formatTtft(c)).toBe('1 s');
  });

  it('一次都没量到 → null /「—」，绝不是 0 ms', () => {
    const c = counters({ requests: 42 });
    expect(averageTtftMs(c)).toBeNull();
    expect(formatTtft(c)).toBe('—');
  });

  it('量到的是真的 0 毫秒 → 显示 0 ms（与「未测到」区分开）', () => {
    // 首字节即首 token 时会得到这个值：它是一条真实的测量结果。
    const c = counters({ timedRequests: 1, ttftMs: 0 });
    expect(averageTtftMs(c)).toBe(0);
    expect(formatTtft(c)).toBe('0 ms');
  });

  it('亚秒级按毫秒展示，秒级以上按秒展示', () => {
    expect(formatTtft(counters({ timedRequests: 2, ttftMs: 980 }))).toBe('490 ms');
    expect(formatTtft(counters({ timedRequests: 4, ttftMs: 9600 }))).toBe('2.4 s');
  });

  it('多日累加后仍按同一口径求平均（sumDays 把两个字段一起加）', () => {
    const total = sumDays([
      day('2026-10-15', { timedRequests: 1, ttftMs: 400 }),
      day('2026-10-16', { timedRequests: 3, ttftMs: 2600 }),
    ]);
    expect(total.timedRequests).toBe(4);
    expect(total.ttftMs).toBe(3000);
    expect(formatTtft(total)).toBe('750 ms');
  });
});
