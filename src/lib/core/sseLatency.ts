/**
 * 会话延迟埋点：SSE **首字节 → 首 token**（FR-11.7）。
 *
 * ## 为什么单独抽一层
 *
 * 「首字延迟 ≤ 3s」是本项目的非功能需求，但在本轮之前它**根本不可测**：
 * 引擎侧 `llm_usage` 只对**流式**调用记 `ttft_ms`，而客户端这边连观察点都没有。
 * 这里补的是**客户端视角**的那一段：从「网关开始吐第一个字节」到「用户看到第一个字」。
 *
 * 与 FR-11.2 的回合 trace 刻意不同：trace 是**回合级**（谁调用了什么、多久），
 * 本条是**延迟级**（用户的等待感）。两者不重复采集，也不要合并。
 *
 * ## 三个时刻，两个派生量
 *
 * ```
 * startedAt ──(等待上游)──► firstByte ──(首帧解析)──► firstToken
 *                └──────────── firstTokenLatencyMs ───────┘
 *                          └─ ttftMs ─┘
 * ```
 *
 * - `ttftMs`（首字节→首 token）是**纯客户端**能观测的那一段，用它判断延迟来自
 *   「上游慢」还是「本地解析慢」；
 * - `firstTokenLatencyMs`（响应头→首 token）是**用户真实感受到**的等待。
 *
 * ## 唯一的硬规则：缺失必须是 `null`，不是 `0`
 *
 * 「没测到」与「测得 0 毫秒」是两件完全不同的事，而它们都表现为 0 时，
 * 报表会把一批未采集的样本算成一个极快的成绩 —— 于是「首字延迟 ≤ 3s」
 * 这个指标会**因为采集坏了而变好看**。故任一时刻缺失 → 派生量一律 `null`。
 *
 * 例外只有一条（见 `markFirstToken`）：首 token 到达而字节层从未打点，说明调用方
 * 没在传输层埋点，而 token 必然经由字节到达 —— 此时把首字节认作同一时刻，
 * 得到 `ttftMs = 0` 并**不是**「缺失」，而是「首字节即首 token」这条边界。
 */

/** 一次会话的首字延迟采样。字段全部显式存在，缺失用 `null` 表达。 */
export interface SessionLatencySample {
  /** 响应头到达时刻（epoch ms）；未打点为 `null` */
  startedAtMs: number | null;
  /** 首个字节到达时刻；未打点为 `null` */
  firstByteAtMs: number | null;
  /** 首个内容 token 到达时刻；未打点为 `null` */
  firstTokenAtMs: number | null;
  /** 首字节 → 首 token（毫秒）；任一缺失为 `null` */
  ttftMs: number | null;
  /** 响应头 → 首 token（毫秒），即用户实际感受到的等待；任一缺失为 `null` */
  firstTokenLatencyMs: number | null;
}

export interface SseLatencyTracker {
  /** 响应头到达。重复调用以**第一次**为准 */
  markStart(atMs?: number): void;
  /** 收到首个字节。重复调用以**第一次**为准 */
  markFirstByte(atMs?: number): void;
  /** 首条内容 token。重复调用以**第一次**为准（第二次起不是「首」了） */
  markFirstToken(atMs?: number): void;
  /** 当前采样值。随时可读，流结束时读一次即可 */
  sample(): SessionLatencySample;
  /** 是否已经拿到首 token（调用方据此决定要不要继续打点） */
  readonly hasFirstToken: boolean;
}

/** 差值：把时钟回拨钳到 0，绝不产出负数（负的延迟会污染后续所有平均值）。 */
function delta(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  return Math.max(0, to - from);
}

export function createSseLatencyTracker(now: () => number = Date.now): SseLatencyTracker {
  let startedAtMs: number | null = null;
  let firstByteAtMs: number | null = null;
  let firstTokenAtMs: number | null = null;

  return {
    markStart(atMs) {
      if (startedAtMs === null) startedAtMs = atMs ?? now();
    },
    markFirstByte(atMs) {
      if (firstByteAtMs === null) firstByteAtMs = atMs ?? now();
    },
    markFirstToken(atMs) {
      if (firstTokenAtMs !== null) return;
      firstTokenAtMs = atMs ?? now();
      // 边界：token 到达却从未在字节层打点 —— 两者其实是同一次读取，
      // 认作同一时刻（ttft = 0），而不是留成 null。见模块 docstring 末段。
      if (firstByteAtMs === null) firstByteAtMs = firstTokenAtMs;
    },
    sample() {
      return {
        startedAtMs,
        firstByteAtMs,
        firstTokenAtMs,
        ttftMs: delta(firstByteAtMs, firstTokenAtMs),
        firstTokenLatencyMs: delta(startedAtMs, firstTokenAtMs),
      };
    },
    get hasFirstToken() {
      return firstTokenAtMs !== null;
    },
  };
}
