/**
 * LLM 用量报表的领域类型（FR-11.1）。
 *
 * 这里是**渲染层唯一消费的形态**：camelCase、字段全部存在（数字收敛到 0、
 * 缺失的可选值收敛到 `null`）。引擎的 snake_case wire 形态只允许出现在
 * `@/ai/runtime/nanobotHttp/usage.ts`（ADR-020 / CI 检查二）。
 *
 * 为什么不自己算聚合：口径（按**本地日**分组、30 天窗口、连续使用天数、
 * 缓存命中率的分母只算「真的观测到缓存」的请求）全都写在引擎的
 * `nanobot.llm_usage` 里。渲染层复制一份就是两份真相 —— 引擎改一次，
 * 这边静默偏一次，而偏的是数字，不是报错。
 */

/** 一组可加的计量（token / 请求 / 耗时） */
export interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 缓存命中读取的 token；渠道不上报时为 0（与「上报了 0」在本层不可区分） */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  /** 以 `finish_reason ∈ {error, cancelled}` 判定为失败的那部分 */
  failedRequests: number;
  durationMs: number;
}

/** 单日聚合。`date` 是**引擎按配置时区算好的本地日**（`YYYY-MM-DD`） */
export interface UsageDay extends UsageCounters {
  date: string;
  /** 按来源（`user` / `cron` / `dream` / `api` / `system`）拆分的当日计量 */
  bySource: Record<string, UsageCounters>;
}

/** 近 30 天的 `(provider, model)` 二维聚合，引擎已按 token 降序 */
export interface UsageProviderRow extends UsageCounters {
  provider: string;
  model: string;
}

/** 近 30 天 / 长周期的派生指标（引擎算好，客户端只展示） */
export interface UsageSummary {
  tokens30d: number;
  tokens365d: number;
  /** 由渠道真实上报（非估算）的那部分 token */
  reportedTokens30d: number;
  /** 由本地估算补出来的那部分 token */
  estimatedTokens30d: number;
  cacheReadTokens30d: number;
  /** 缓存命中率（0-1）；引擎无法计算时为 `null`——**不是 0** */
  cacheReadRate30d: number | null;
  /** 历史上单日最高的 token 量 */
  peakDayTokens: number;
  /** 连续使用天数（含今天；今天还没用则为 0） */
  currentStreakDays: number;
  longestStreakDays: number;
  activeDays30d: number;
  requests30d: number;
  failedRequests30d: number;
}

/**
 * 一份用量报表。
 *
 * `available=false` 表示**没读到**（网关没起 / 超时 / 非 2xx），此时其余字段
 * 一律为空 —— 与「读到了但确实没有用量」是两个不同的状态：后者
 * `available=true` 且 `days: []`，UI 该说「还没有用量记录」而不是「读取失败」。
 */
export interface UsageStats {
  available: boolean;
  /** `available=false` 时的原因（直接展示给用户） */
  error?: string;
  /** 引擎给出的完整窗口（默认 371 天），按日期升序 */
  days: UsageDay[];
  /** 全窗口 token 合计 */
  totalTokens: number;
  providers: UsageProviderRow[];
  /** 最后一次真实调用时刻（ISO）；从未调用过时为 `null` */
  updatedAt: string | null;
  summary: UsageSummary;
}
