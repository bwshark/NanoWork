/**
 * 运行留痕的**统计与失败原因分类**（FR-5.3）。
 *
 * ## 为什么分类只能靠文本特征
 *
 * `TaskRunRecord.error` 的内容来自两个完全不同的产地，且**都不是结构化枚举**：
 * - **引擎侧**（定时触发）：nanobot `CronService` 把 `str(e)` 或两位固定文案写进
 *   `cron/runs/*.json` 的 `error` 字段。固定文案两条，其余是任意 Python 异常文本；
 * - **客户端**（测试运行 / 会话层）：`'已中断'`、`runTask` 抛出的 `e.message`，
 *   以及聊天层的「响应超时：…」这类中文提示。
 *
 * 引擎仓库是只读的（`nanobot/` 有独立 git，且约定不新增 `[LOCAL PATCH]`），
 * 所以拿不到结构化错误码。**结论：分类必然是「尽力而为的启发式」**，因此本模块遵守两条纪律：
 *
 * 1. **永不吞掉原文**：分类只用来分组与统计，原始 `error` 必须照原样展示
 *    （用户排查时要看到引擎到底说了什么）；
 * 2. **fail-open 到「未知」**：认不出来就归 `unknown`，**不许猜**——猜错类别比说「未知」
 *    更坏，因为它会把人引到错误的排查方向。
 *
 * 判据里的特征串都取自**实际会被写入的文案**（见文件头的两个产地），不是凭空设计的。
 */

import type { TaskRunRecord } from '@/types';

/** 失败原因分类（`unknown` 是合法结果，不是「没分类成功」） */
export type RunFailureKind =
  | 'unbound' // 引擎：agent_turn 任务缺少绑定的投递上下文（任务的创建方式不对）
  | 'timeout' // 静默超时 / 网关无响应
  | 'model' // 模型调用失败：模型不存在、配额、限流、鉴权
  | 'permission' // 权限被拒 / 未获批准
  | 'tool' // 工具或命令执行失败
  | 'interrupted' // 被中断（用户停止 / 会话被删）
  | 'network' // 连不上网关 / 网络层错误
  | 'unknown'; // 认不出来——照实说，不猜

/** 分类的中文标签（UI 展示与统计条共用一份，避免两处漂移） */
export const RUN_FAILURE_LABELS: Record<RunFailureKind, string> = {
  unbound: '任务未绑定会话',
  timeout: '超时无响应',
  model: '模型调用失败',
  permission: '权限被拒',
  tool: '工具执行失败',
  interrupted: '被中断',
  network: '连接失败',
  unknown: '其他原因',
};

/**
 * 判据表：**顺序即优先级**。
 *
 * 顺序有讲究：`unbound` 放在最前，因为引擎那两条固定文案里也含 "session"，若不先判，
 * 会被后面的宽松规则（如含 `session` 的工具/网络规则）抢走——那会让「任务创建方式不对」
 * 这个**唯一可自愈**的原因被归到「其他」，用户就永远找不到解法。
 */
const FAILURE_RULES: ReadonlyArray<{ kind: RunFailureKind; test: RegExp }> = [
  { kind: 'unbound', test: /missing bound session delivery context|missing channel\/to/i },
  { kind: 'interrupted', test: /^(已中断|interrupted|cancell?ed|aborted)$/i },
  { kind: 'timeout', test: /响应超时|超时|timed?\s?out|timeout/i },
  { kind: 'permission', test: /权限|未获批准|已拒绝|denied|permission|not approved|unauthorized/i },
  { kind: 'model', test: /(model|模型)[^。]{0,40}(not exist|does not exist|不存在|not found)|model_not_found|quota|arrearage|rate.?limit|欠费|配额|限流|error calling llm/i },
  { kind: 'network', test: /connection|econnrefused|econnreset|fetch failed|socket|连接失败|网络/i },
  { kind: 'tool', test: /tool|工具|exec\b|command|命令|shell|script/i },
];

/**
 * 把一段自由文本的错误归到某一类。
 *
 * @param error 运行记录里的 `error` 原文；空 / 全空白视为「被中断」之外的未知
 *   （调用方只在 `status==='error'` 时调用，空 error 属异常数据，归 `unknown` 而不是乱猜）
 */
export function classifyRunFailure(error?: string): RunFailureKind {
  const text = (error ?? '').trim();
  if (text === '') return 'unknown';
  for (const rule of FAILURE_RULES) {
    if (rule.test.test(text)) return rule.kind;
  }
  return 'unknown';
}

/** 一组运行记录的统计结果 */
export interface RunStats {
  total: number;
  success: number;
  error: number;
  /** 仍在执行中的条数（**不计入成功率分母**，见下） */
  running: number;
  /**
   * 成功率（0-1）；分母是**已结束**的运行（success + error）。
   * 进行中的运行既不算成功也不算失败——把它算进分母会让「刚点了一下」把成功率压低，
   * 而那是用户自己的操作，不是任务质量的信号。
   * 没有已结束运行时返回 `null`（「—」而不是 0%）。
   */
  successRate: number | null;
  /** 平均耗时（毫秒，只统计有 `durationMs` 的已结束运行）；无样本返回 null */
  avgDurationMs: number | null;
  /** 失败原因分布，按条数降序、同数按类别名升序（保证渲染稳定） */
  failures: Array<{ kind: RunFailureKind; label: string; count: number; sample: string }>;
}

/** 空统计（`runs` 为空时直接用，避免调用方到处判 null） */
const EMPTY_STATS: RunStats = {
  total: 0,
  success: 0,
  error: 0,
  running: 0,
  successRate: null,
  avgDurationMs: null,
  failures: [],
};

/** 统计一组运行记录 */
export function summarizeRuns(runs: readonly TaskRunRecord[]): RunStats {
  if (runs.length === 0) return EMPTY_STATS;

  let success = 0;
  let error = 0;
  let running = 0;
  let durationSum = 0;
  let durationCount = 0;
  /** 每个分类的条数与**一条样例原文**（统计条要能回答「这个失败大概长什么样」） */
  const byKind = new Map<RunFailureKind, { count: number; sample: string }>();

  for (const run of runs) {
    if (run.status === 'running') {
      running += 1;
      continue;
    }
    if (run.status === 'success') success += 1;
    else error += 1;

    if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)) {
      durationSum += run.durationMs;
      durationCount += 1;
    }

    if (run.status === 'error') {
      const kind = classifyRunFailure(run.error);
      const prev = byKind.get(kind);
      if (prev) prev.count += 1;
      else byKind.set(kind, { count: 1, sample: (run.error ?? '').trim() });
    }
  }

  const finished = success + error;
  const failures = [...byKind.entries()]
    .map(([kind, v]) => ({ kind, label: RUN_FAILURE_LABELS[kind], count: v.count, sample: v.sample }))
    // 同数时按 label 排序：否则 Map 迭代顺序会让「每次渲染顺序都变」
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));

  return {
    total: runs.length,
    success,
    error,
    running,
    successRate: finished === 0 ? null : success / finished,
    avgDurationMs: durationCount === 0 ? null : Math.round(durationSum / durationCount),
    failures,
  };
}

/**
 * 按任务汇总（列表里给每条任务显示自己的成功率）。
 *
 * 只收 `taskId` 有值的记录；顺序按 `taskId` 升序，便于调用方直接比较。
 */
export function summarizeRunsByTask(
  runs: readonly TaskRunRecord[],
): Map<string, RunStats> {
  const grouped = new Map<string, TaskRunRecord[]>();
  for (const run of runs) {
    if (!run.taskId) continue;
    const list = grouped.get(run.taskId);
    if (list) list.push(run);
    else grouped.set(run.taskId, [run]);
  }
  return new Map(
    [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([taskId, list]) => [taskId, summarizeRuns(list)]),
  );
}

/** 成功率文案（`null` → `—`，不把「没有样本」说成 0%） */
export function formatSuccessRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}
