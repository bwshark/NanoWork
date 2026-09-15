/**
 * nanobot **定时任务域**：领域对象 ⇄ 引擎 `cron/jobs.json` 与运行审计。
 *
 * 背景：nanobot 的定时任务由 gateway 进程内的 CronService 消费
 * （nanobot/cron/service.py），存储于 `{workspace}/cron/jobs.json`：
 * - CronSchedule：kind ∈ at / every / cron（atMs / everyMs / expr+tz，camelCase 存储）；
 * - CronPayload：kind='agent_turn' + message（触发提示词）；
 * - CronJob：id / name / enabled / schedule / payload / state / deleteAfterRun。
 *
 * 引擎侧关键约束（排查定时任务不执行的根因后确认）：
 * 1. **会话绑定**：payload 缺少 sessionKey / originChannel / originChatId 的
 *    agent_turn 任务会被 `_enforce_agent_binding` 直接禁用（见
 *    nanobot/cron/session_turns.py 的 is_bound_cron_job）；
 * 2. **下次运行时间**：引擎仅在 start() 时重算 nextRunAtMs，运行期热加载
 *    jobs.json 时直接采用磁盘值，因此前端写入时必须自行计算
 *    `state.nextRunAtMs`，否则任务永不到期；
 * 3. **托管标记**：jobs.json 中可能并存系统任务（dream/heartbeat）与聊天会话
 *    创建的任务，前端生成的任务以 `originMetadata.managedBy='smartagent'`
 *    标记，主进程合并时仅管理带此标记的任务，绝不影响其他任务。
 *
 * 本模块把前端 TaskConfig[] 映射为可合并进 jobs.json 的片段并经
 * platform.syncNanobotTasks 落盘，同时承担运行审计
 * （`cron/runs/*.json`）→ `TaskRunRecord` 的映射——后者此前抄在
 * tasksStore 里，属于同一知识的两份实现，现统一收口到本文件。
 */
import { platform } from '@/platform';
import { nextCronRunMs } from '@/lib/cron';
import type { RunQuery } from '../types';
import type { NanobotCronRunRecord, TaskSyncResult } from '@/platform/types';
import type { TaskConfig, TaskRunRecord, TaskSchedule } from '@/types';

/** 托管标记值：主进程据此识别「由智能体应用管理」的定时任务 */
export const MANAGED_BY_SMARTAGENT = 'smartagent';

/** 定时任务绑定的投递渠道：api 未注册为出站渠道，仅记日志不报错，
 * 任务 turn 正常执行且结果持久化到会话与 cron/runs 审计记录 */
const CRON_ORIGIN_CHANNEL = 'api';

/** nanobot CronSchedule 存储形态（camelCase） */
export interface NanobotSchedule {
  kind: 'at' | 'every' | 'cron';
  atMs?: number;
  everyMs?: number;
  expr?: string;
  tz?: string;
}

/** nanobot CronJobState 存储形态（前端仅产出 nextRunAtMs，其余由引擎维护） */
export interface NanobotJobState {
  nextRunAtMs?: number | null;
}

/** nanobot CronJob 存储形态（camelCase，与 CronService._save_store 对齐） */
export interface NanobotJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: NanobotSchedule;
  payload: {
    kind: 'agent_turn';
    message: string;
    /** 绑定字段置空：is_bound_cron_job 要求不存在 legacy 投递上下文 */
    deliver: false;
    channel: null;
    to: null;
    channelMeta: Record<string, never>;
    /** 任务专属会话键（api:cron-{taskId}），执行历史彼此隔离 */
    sessionKey: string;
    originChannel: string;
    originChatId: string;
    /** 透传元数据：agentId / runOptions / managedBy 托管标记 */
    originMetadata: Record<string, unknown>;
  };
  state: NanobotJobState;
  createdAtMs: number;
  updatedAtMs: number;
  /** 单次任务执行后自动删除（nanobot at 语义） */
  deleteAfterRun: boolean;
}

/** 前端 TaskSchedule → nanobot CronSchedule */
export function toNanobotSchedule(schedule: TaskSchedule): NanobotSchedule {
  switch (schedule.kind) {
    case 'cron':
      return {
        kind: 'cron',
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
      };
    case 'interval':
      return { kind: 'every', everyMs: schedule.minutes * 60_000 };
    case 'once':
      return { kind: 'at', atMs: Date.parse(schedule.at) };
  }
}

/**
 * 计算调度下次触发时间戳（毫秒），与引擎 _compute_next_run 语义对齐：
 * - interval：now + everyMs；
 * - once：atMs（已过期返回 null，引擎将禁用该任务）；
 * - cron：严格晚于 now 的最近匹配分钟（本地时区；指定 tz 时以引擎
 *   reload 端点的 croniter 重算为准）。
 * @param schedule 前端调度配置
 * @param fromMs 基准时间戳（毫秒）
 * @returns 下次触发时间戳；无法计算（如单次任务已过期）返回 null
 */
export function computeNextRunMs(schedule: TaskSchedule, fromMs: number): number | null {
  switch (schedule.kind) {
    case 'interval':
      return schedule.minutes > 0 ? fromMs + schedule.minutes * 60_000 : null;
    case 'once': {
      const atMs = Date.parse(schedule.at);
      return Number.isNaN(atMs) || atMs <= fromMs ? null : atMs;
    }
    case 'cron':
      return nextCronRunMs(schedule.expr, fromMs);
  }
}

/**
 * 前端 TaskConfig → nanobot CronJob（含会话绑定与下次运行时间）。
 * @param task 前端任务配置
 * @param nowMs 生成时刻基准时间戳（缺省取当前时间）
 * @returns 可合并进 jobs.json 的 CronJob 存储形态
 */
export function toNanobotJob(task: TaskConfig, nowMs: number = Date.now()): NanobotJob {
  const meta: Record<string, unknown> = {
    managedBy: MANAGED_BY_SMARTAGENT,
    agentId: task.agentId,
    ...(task.runOptions ? { runOptions: task.runOptions } : {}),
  };
  return {
    id: task.id,
    name: task.name,
    enabled: task.status === 'enabled',
    schedule: toNanobotSchedule(task.schedule),
    payload: {
      kind: 'agent_turn',
      message: task.prompt,
      deliver: false,
      channel: null,
      to: null,
      channelMeta: {},
      sessionKey: `${CRON_ORIGIN_CHANNEL}:cron-${task.id}`,
      originChannel: CRON_ORIGIN_CHANNEL,
      originChatId: `cron-${task.id}`,
      originMetadata: meta,
    },
    state: { nextRunAtMs: computeNextRunMs(task.schedule, nowMs) },
    createdAtMs: Date.parse(task.createdAt) || nowMs,
    updatedAtMs: nowMs,
    deleteAfterRun: task.schedule.kind === 'once',
  };
}

/** 生成可合并进 nanobot jobs.json 的完整片段 */
export function buildNanobotJobsFragment(tasks: TaskConfig[]): string {
  const nowMs = Date.now();
  return JSON.stringify(
    { version: 1, jobs: tasks.map((t) => toNanobotJob(t, nowMs)) },
    null,
    2,
  );
}

/**
 * 同步任务配置到引擎运行时（自动，无需用户手动操作）：
 * - electron：主进程将任务幂等合并进 `{workspace}/cron/jobs.json`，
 *   并通知 gateway 热加载立即生效（无需重启网关）；
 * - web：无文件系统权限，降级为下载片段文件并提示手动合并。
 *
 * 两条路径都在 platform 层实现（此前本函数自带一份 `isElectron()` 分支，
 * 用 `nanobot.jobs.json` 作为下载名，与 channels / mcp 两个域的
 * `nanowork.<域>.json` 命名不一致，属于重复实现，已删除）。
 */
export async function syncTasksToRuntime(tasks: TaskConfig[]): Promise<TaskSyncResult> {
  return platform.syncNanobotTasks(buildNanobotJobsFragment(tasks));
}

/**
 * 将 nanobot cron 执行审计记录映射为前端运行记录。
 * @param rec 引擎侧审计记录（queued/ok/error）
 * @returns 前端 TaskRunRecord（trigger='scheduled'，id 带 cron- 前缀防冲突）
 */
export function toTaskRunRecord(rec: NanobotCronRunRecord): TaskRunRecord {
  const status =
    rec.status === 'queued' ? 'running' : rec.status === 'ok' ? 'success' : 'error';
  return {
    id: `cron-${rec.runId}`,
    taskId: rec.jobId,
    taskName: rec.jobName || rec.jobId || '定时任务',
    trigger: 'scheduled',
    startedAt: new Date(rec.updatedAtMs || Date.now()).toISOString(),
    status,
    // 引擎执行会话键：展开记录时据此只读拉取完整执行过程
    ...(rec.sessionKey ? { sessionKey: rec.sessionKey } : {}),
    // 引擎原始运行 id（每次执行唯一，用于区分循环任务的多次运行）
    runId: rec.runId,
    ...(rec.error ? { error: rec.error } : {}),
    ...(rec.response ? { response: rec.response } : {}),
  };
}

/**
 * 列出引擎侧定时任务运行记录（审计目录 `cron/runs/`）。
 * 按 `RunQuery` 过滤：`taskId` 精确匹配任务、`sessionKey` 精确匹配会话键、
 * `sinceMs` 按开始时间下界过滤、`limit` 取最新的 N 条。
 *
 * 与 tasksStore.fetchCronRuns 的分工：后者在本函数之上做「自动创建执行会话」
 * 等产品行为；此处只负责「取数 + 映射 + 过滤」，保持无副作用。
 *
 * **不吞错**：审计目录不可读时应由调用方决定是「静默跳过」还是「提示用户」，
 * Adapter 不预设错误策略。
 */
export async function listRunsFromRuntime(query: RunQuery = {}): Promise<TaskRunRecord[]> {
  const records = await platform.listNanobotCronRuns();
  let runs = records.map(toTaskRunRecord);
  if (query.taskId !== undefined) runs = runs.filter((r) => r.taskId === query.taskId);
  if (query.sessionKey !== undefined) {
    runs = runs.filter((r) => r.sessionKey === query.sessionKey);
  }
  if (query.sinceMs !== undefined) {
    const since = query.sinceMs;
    runs = runs.filter((r) => Date.parse(r.startedAt) >= since);
  }
  if (query.limit !== undefined && runs.length > query.limit) {
    runs = runs.slice(runs.length - query.limit);
  }
  return runs;
}
