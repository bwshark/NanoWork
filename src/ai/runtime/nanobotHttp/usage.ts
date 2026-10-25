/**
 * nanobot **用量域**：`/v1/usage` 的读取与解码（nanowork FR-11.1）。
 *
 * ## 为什么只读不重算
 *
 * 报表的口径全在引擎里：按**本地日**分组、30 天窗口、连续使用天数、缓存命中率的
 * 分母（只算「渠道真的上报了缓存字段」的那些请求）。渲染层复制一份就是两份真相
 * —— 引擎改一次，这边静默偏一次，而偏的是数字、不是报错，没人会在第一时间发现。
 *
 * ## 为什么走 HTTP 而不是让主进程直读 `llm_usage.sqlite3`
 *
 * PRD §20.2 原案是「主进程 Open 用量库」。前置条件不成立：Electron 31 内置
 * Node 20，**没有 `node:sqlite`**，直读要引入原生依赖（better-sqlite3 + 
 * electron-rebuild）或 WASM 版；而且上面那些派生指标得用 JS 重写一遍。
 * 走 HTTP 则引擎保持单一真相，Web 端也照样能用（开发态经 vite 代理）。
 *
 * ## 绝不抛异常（与插件域一致）
 *
 * 「问不到引擎」是**常态**：用户可能根本没开网关。任何失败都收敛成
 * `{ available: false, error }` —— 抛出去只会让整页崩掉，而用户只是想看一眼用量。
 */

import type { UsageCounters, UsageDay, UsageProviderRow, UsageStats } from '@/types';
import { emptyUsageStats } from '@/lib/ui/usageReport';
import { isAbortError } from './httpError';

/**
 * 一次用量请求的连接参数（由 transport 层解析后传入）。
 *
 * 形状与 `PluginRequestContext` 一致但**刻意不共用那个类型**：它绑着插件域的语义，
 * 借来用会让「用量为什么依赖插件」成为一个需要解释的问题。等到第三个域出现、
 * 这份形状真的稳定了，再抽成公共类型。
 */
export interface UsageRequestContext {
  /** 已归一化的 `/v1` 前缀地址 */
  endpoint: string;
  /** 鉴权头（`Authorization: Bearer ...`，token 为空时为空对象） */
  headers: Record<string, string>;
  /** 超时（毫秒）；缺省 8000 —— 这是本地网关，聚合是纯 SQL，慢到这个量级基本是没起 */
  timeoutMs?: number;
}

const DEFAULT_USAGE_TIMEOUT_MS = 8000;

/**
 * 读取失败时的空报表。
 *
 * 形状只有一份（`@/lib/ui/usageReport`）：这里再写一遍的话，将来给报表加字段时
 * 必然漏改一处，而漏掉的那个字段会让 UI 读到 `undefined` 并渲染出 `NaN`。
 */
function emptyStats(error?: string): UsageStats {
  return emptyUsageStats(error);
}

/** 非负有限数收敛到整数；其余一律 0（引擎漏字段时不能渲染出 `NaN`） */
function intOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** 比例：只接受 0-1 的有限数，其余（含 `undefined`）→ `null` */
function rateOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 从聚合行里读出一组计量（引擎的 `_AGGREGATE_SQL` 别名） */
function readCounters(entry: Record<string, unknown>): UsageCounters {
  return {
    inputTokens: intOf(entry.input_tokens),
    outputTokens: intOf(entry.output_tokens),
    totalTokens: intOf(entry.total_tokens),
    cacheReadTokens: intOf(entry.cache_read_tokens),
    cacheWriteTokens: intOf(entry.cache_write_tokens),
    requests: intOf(entry.requests),
    failedRequests: intOf(entry.failed_requests),
    durationMs: intOf(entry.duration_ms),
    // 引擎的 `_AGGREGATE_SQL` 里这两项是 `COALESCE(SUM(...), 0)`（实测
    // `llm_usage/store.py` 的 `_USAGE_COLUMNS` 含 `ttft_ms` / `timed_requests`，
    // 且被 `_as_int_row` 全量映射进 `days` 与 `providers_30d` 两侧）。
    // 缺字段时 `intOf` 收敛到 0，即「没测到」—— 与引擎的 `timed_requests=0` 同义。
    ttftMs: intOf(entry.ttft_ms),
    timedRequests: intOf(entry.timed_requests),
  };
}

function decodeDay(raw: unknown): UsageDay | null {
  const entry = asRecord(raw);
  const date = entry.date;
  // 没有日期的行无法归位——引擎侧 `_daily_rows` 已经跳过 null，这里只是不信任
  if (typeof date !== 'string' || date === '') return null;

  const bySource: Record<string, UsageCounters> = {};
  for (const [source, value] of Object.entries(asRecord(entry.sources))) {
    // 空来源名不可能出现（引擎按 source 分组），但仍收敛一次，免得字典里出现 '' 键
    if (source === '') continue;
    bySource[source] = readCounters(asRecord(value));
  }

  return { date, bySource, ...readCounters(entry) };
}

function decodeProviderRow(raw: unknown): UsageProviderRow | null {
  const entry = asRecord(raw);
  const provider = entry.provider;
  const model = entry.model;
  if (typeof provider !== 'string' || typeof model !== 'string') return null;
  return { provider, model, ...readCounters(entry) };
}

/** 把引擎 payload 解码成领域报表（不做任何计算，只做形状收敛） */
export function decodeUsagePayload(raw: unknown): UsageStats {
  const entry = asRecord(raw);
  const days = (Array.isArray(entry.days) ? entry.days : [])
    .map(decodeDay)
    .filter((d): d is UsageDay => d !== null);
  const providers = (Array.isArray(entry.providers_30d) ? entry.providers_30d : [])
    .map(decodeProviderRow)
    .filter((p): p is UsageProviderRow => p !== null);

  const updatedAt = entry.updated_at;
  return {
    available: true,
    days,
    totalTokens: intOf(entry.total_tokens),
    providers,
    updatedAt: typeof updatedAt === 'string' && updatedAt !== '' ? updatedAt : null,
    summary: {
      tokens30d: intOf(entry.total_tokens_30d),
      tokens365d: intOf(entry.total_tokens_365d),
      reportedTokens30d: intOf(entry.reported_tokens_30d),
      estimatedTokens30d: intOf(entry.estimated_tokens_30d),
      cacheReadTokens30d: intOf(entry.cache_read_tokens_30d),
      cacheReadRate30d: rateOf(entry.cache_read_rate_30d),
      peakDayTokens: intOf(entry.peak_day_tokens),
      currentStreakDays: intOf(entry.current_streak_days),
      longestStreakDays: intOf(entry.longest_streak_days),
      activeDays30d: intOf(entry.active_days_30d),
      requests30d: intOf(entry.requests_30d),
      failedRequests30d: intOf(entry.failed_requests_30d),
    },
  };
}

/** 读引擎侧用量聚合。**不抛异常**：失败 → `available: false` + 原因。 */
export async function readUsageFromRuntime(
  ctx: UsageRequestContext,
): Promise<UsageStats> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ctx.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${ctx.endpoint}/usage`, {
      headers: ctx.headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      // 404 单独解释：老版本网关没有这条路由（它是 [LOCAL PATCH] 加的）
      return emptyStats(
        res.status === 404
          ? '当前网关不支持用量查询（引擎版本较旧，需升级或重启网关）'
          : `读取用量失败：HTTP ${res.status}`,
      );
    }
    return decodeUsagePayload(await res.json());
  } catch (err) {
    return emptyStats(
      isAbortError(err)
        ? '读取用量超时（网关未启动？）'
        : err instanceof Error
          ? err.message
          : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}
