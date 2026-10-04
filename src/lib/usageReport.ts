/**
 * 用量报表的展示层纯函数（FR-11.1）。
 *
 * 这里只做**渲染用**的换算：切片、格式化、按来源合并。**不做任何统计口径**
 * —— 成功率、缓存命中率、连续天数都由引擎算好（见 `nanobot.llm_usage`），
 * 客户端重算一遍就是两份真相。
 */

import type { UsageCounters, UsageDay, UsageStats } from '@/types';

/**
 * 一份「没有数据」的报表。
 *
 * 两处都要用：解码层（读取失败时）与 store（实现违约抛错时）。放在这里
 * 而不是各自写一遍——空形状一旦有两份，加字段时必然漏一处，而漏掉的那个
 * 字段会让 UI 读到 `undefined` 并渲染出 `NaN`。
 *
 * `available=false` 与「读到了但确实没有用量」（`available=true, days: []`）
 * 是**两个不同的状态**：前者该提示「读取失败」，后者该说「还没有用量记录」。
 */
export function emptyUsageStats(error?: string): UsageStats {
  return {
    available: false,
    ...(error !== undefined ? { error } : {}),
    days: [],
    totalTokens: 0,
    providers: [],
    updatedAt: null,
    summary: {
      tokens30d: 0,
      tokens365d: 0,
      reportedTokens30d: 0,
      estimatedTokens30d: 0,
      cacheReadTokens30d: 0,
      cacheReadRate30d: null,
      peakDayTokens: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      activeDays30d: 0,
      requests30d: 0,
      failedRequests30d: 0,
    },
  };
}

/** 可切换的时间窗（天）。与引擎的 30 天派生指标对齐，多出 7 / 90 用于看图 */
export const USAGE_WINDOWS = [7, 30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/**
 * 来源展示名。`api` / `system` 刻意分开写：
 * 「外部接口调的」与「系统自己调的」在排查用量异常时是完全不同的两条线索。
 *
 * 未登记的来源原样显示 —— 引擎新增一类来源时，界面不该先崩掉或显示空白。
 */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  user: '对话',
  cron: '定时任务',
  dream: '记忆沉淀',
  api: '外部接口',
  system: '系统',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** 空计量（同日无该来源时用，省得调用方到处写 `?? 0`） */
export function zeroCounters(): UsageCounters {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
    failedRequests: 0,
    durationMs: 0,
  };
}

/**
 * token 数的紧凑展示。
 *
 * 用「万 / 亿」而不是「K / M」：这是中文界面，用户对「12.3 万」的直觉
 * 远强于「123K」。一万以下保留原数并加千分位 —— 精确数字在这个量级上是
 * 有意义的（用户会拿它对账）。
 */
export function formatTokens(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (n < 10_000) return n.toLocaleString('zh-CN');
  if (n < 100_000_000) return `${trimZero(n / 10_000)} 万`;
  return `${trimZero(n / 100_000_000)} 亿`;
}

/** 1 位小数，且丢掉无意义的 `.0`（`1.0 万` 读起来像另有精度） */
function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 比例（0-1）→ 百分比文案；`null`（引擎算不出）显示破折号而不是 `0%` */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/**
 * 按 `windowDays` 切出窗口内的天。
 *
 * `todayIso` 由调用方给出（渲染层的「今天」），**不在这里取 `new Date()`**：
 * 纯函数才可测。要注意引擎按**引擎配置的时区**归日，而浏览器用本机时区，
 * 两者可能差一天 —— 边界上极端情况会少/多算一天，这是知情取舍：把「今天」
 * 显式传进来，比在这里偷偷读系统时间更容易发现这类不一致。
 */
export function sliceUsageDays(
  days: readonly UsageDay[],
  windowDays: number,
  todayIso: string,
): UsageDay[] {
  const end = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(end)) return [...days];
  const startMs = end - (Math.max(1, windowDays) - 1) * 86_400_000;
  const startIso = new Date(startMs).toISOString().slice(0, 10);
  return days.filter((d) => d.date >= startIso && d.date <= todayIso);
}

/**
 * 本机时区的今天（`YYYY-MM-DD`）。
 *
 * 用 `getFullYear/Month/Date` 拼而**不是** `toISOString().slice(0,10)`：后者是
 * **UTC 日**，东八区在早上 8 点前会算成「昨天」，窗口右端因此整整少一天。
 *
 * 由调用方传 `now`（默认当前时间）以便测试——时间源一旦藏进纯函数里，
 * 「跨天」这种只在特定时刻复现的问题就没法在单测里钉住。
 */
export function todayLocalIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 按键合并一组计量（`out` 为累加目标，便于逐日折叠） */
export function addCounters(target: UsageCounters, next: UsageCounters): UsageCounters {
  return {
    inputTokens: target.inputTokens + next.inputTokens,
    outputTokens: target.outputTokens + next.outputTokens,
    totalTokens: target.totalTokens + next.totalTokens,
    cacheReadTokens: target.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + next.cacheWriteTokens,
    requests: target.requests + next.requests,
    failedRequests: target.failedRequests + next.failedRequests,
    durationMs: target.durationMs + next.durationMs,
  };
}

export interface SourceUsage {
  source: string;
  label: string;
  counters: UsageCounters;
}

/**
 * 把逐日 `bySource` 合并成「来源 → 计量」，按 token 降序。
 *
 * 排序在这里做而不是交给 UI：`Object.entries` 的顺序是插入序，直接渲染会
 * 随引擎返回顺序抖动；图表与图例都要求稳定顺序。
 */
export function aggregateBySource(days: readonly UsageDay[]): SourceUsage[] {
  const merged = new Map<string, UsageCounters>();
  for (const day of days) {
    for (const [source, counters] of Object.entries(day.bySource)) {
      merged.set(source, addCounters(merged.get(source) ?? zeroCounters(), counters));
    }
  }
  return [...merged.entries()]
    .map(([source, counters]) => ({ source, label: sourceLabel(source), counters }))
    .sort(
      (a, b) => b.counters.totalTokens - a.counters.totalTokens || a.source.localeCompare(b.source),
    );
}

/** 把逐日总量合并成一条计量（窗口内的合计） */
export function sumDays(days: readonly UsageDay[]): UsageCounters {
  return days.reduce((acc, day) => addCounters(acc, day), zeroCounters());
}

/**
 * 图表的 X 轴标签：`M-D`。
 * 只取月日是因为窗口最长 90 天，年份在同一次对比里不会变；
 * 带上年份只会让 90 个标签挤成一团。
 */
export function dateAxisLabel(date: string): string {
  const [, month, day] = date.split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : date;
}
