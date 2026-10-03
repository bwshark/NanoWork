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
import { lowerRrule } from '@/lib/rrule';
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

/**
 * nanobot CronDelivery 存储形态（FR-5.6，引擎侧 `[LOCAL PATCH]` 新增字段）。
 *
 * `chatId` 是必需的：投递必须知道「发到哪个会话」，光有渠道名推不出去。
 */
export interface NanobotDelivery {
  targets: Array<{ channel: string; chatId: string }>;
  on: 'complete' | 'error';
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
    /**
     * 结果推送（FR-5.6）。⚠️ 与上面那三个 legacy 字段**无关**——任务必须保持
     * 「绑定了自己的 api:cron-{id} 会话」这个形态，推送走本字段另发一份，
     * 借用 legacy 字段会让 `is_bound_cron_job` 判 False、任务被禁用。
     */
    delivery?: NanobotDelivery;
  };
  state: NanobotJobState;
  createdAtMs: number;
  updatedAtMs: number;
  /** 单次任务执行后自动删除（nanobot at 语义） */
  deleteAfterRun: boolean;
}

/**
 * 降级失败的 RRULE 落成什么。
 *
 * 取「2 月 31 日」这个**永不存在的日期**，于是 croniter 永远算不出下次触发，
 * 配合 `computeNextRunMs` 返回 null，任务是「存在但永不到期」。
 *
 * 为什么不在这里抛错：本函数在**同步链路**上（`buildNanobotJobsFragment` →
 * 主进程合并 jobs.json）。同步链路上抛一个 RRULE 的错，会把**其它任务的同步一起带崩**——
 * 一条写坏的规则不该让整批自动化停摆。真正该拦住它的是录入侧：表单必须用
 * `lowerRrule` 先校验，用户根本存不下不可降级的规则（见 `docs/prd-tasks*.md` 的后续批次）。
 */
const NEVER_FIRING_CRON = '0 0 31 2 *';

/** 前端 TaskSchedule → nanobot CronSchedule（`rrule` 在此降级） */
export function toNanobotSchedule(schedule: TaskSchedule): NanobotSchedule {
  switch (schedule.kind) {
    case 'cron':
      return {
        kind: 'cron',
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
      };
    case 'rrule': {
      const lowered = lowerRrule(schedule.rrule);
      if (!lowered.ok) {
        console.warn(`[tasks] RRULE 无法降级，该任务将永不触发：${lowered.reason}（${schedule.rrule}）`);
        return { kind: 'cron', expr: NEVER_FIRING_CRON, ...(schedule.tz ? { tz: schedule.tz } : {}) };
      }
      // 降级结果可能是 cron，也可能落到引擎原生的 interval 形态——递归一次即可，
      // 不复制「interval → everyMs」的换算（那条规则只有一处才对）
      const inner = toNanobotSchedule(lowered.schedule);
      // ⚠️ tz 必须**随降级结果一起搬过去**：降级只产出「分 时 日 月 周」，
      // 时区不在其中。漏掉它不会报错，只会让任务在错误时区触发（实测由用例抓到）。
      // 只有 cron 有时区语义（`everyMs` 是纯间隔），所以仅对 cron 附加。
      return schedule.tz && inner.kind === 'cron' ? { ...inner, tz: schedule.tz } : inner;
    }
    case 'interval':
      return { kind: 'every', everyMs: schedule.minutes * 60_000 };
    case 'once':
      return { kind: 'at', atMs: Date.parse(schedule.at) };
  }
}

/** 有效期窗口（ISO 字符串，缺省即无界） */
export interface ValidityWindow {
  from?: string;
  until?: string;
}

/**
 * 计算调度下次触发时间戳（毫秒），与引擎 _compute_next_run 语义对齐：
 * - interval：now + everyMs；
 * - once：atMs（已过期返回 null，引擎将禁用该任务）；
 * - cron：严格晚于 now 的最近匹配分钟（本地时区；指定 tz 时以引擎
 *   reload 端点的 croniter 重算为准）；
 * - rrule：先降级再按上面的口径算（降级失败返回 null）。
 *
 * **有效期窗口**（FR-5.4）由本函数体现：下界取 `max(fromMs, validFrom)`（窗口还没到就
 * 从窗口起点开始找），算出的时刻晚于 `validUntil`（或窗口外无解）则返回 null。
 * 引擎本身没有窗口概念，所以这是窗口唯一的生效点。
 *
 * @param schedule 前端调度配置
 * @param fromMs 基准时间戳（毫秒）
 * @param window 有效期窗口；缺省即两侧都不限
 * @returns 下次触发时间戳；无法计算（单次任务已过期 / 降级失败 / 落在窗口外）返回 null
 */
export function computeNextRunMs(
  schedule: TaskSchedule,
  fromMs: number,
  window: ValidityWindow = {},
): number | null {
  const from = Date.parse(window.from ?? '');
  const floor = Number.isNaN(from) ? fromMs : Math.max(fromMs, from);
  const until = Date.parse(window.until ?? '');
  const ceiling = Number.isNaN(until) ? Number.POSITIVE_INFINITY : until;

  const next = computeRaw(schedule, floor);
  if (next === null || next > ceiling) return null;
  return next;
}

/** 不看窗口的「原始下次触发」（窗口判定收在 `computeNextRunMs` 一处） */
function computeRaw(schedule: TaskSchedule, fromMs: number): number | null {
  switch (schedule.kind) {
    case 'interval':
      return schedule.minutes > 0 ? fromMs + schedule.minutes * 60_000 : null;
    case 'once': {
      const atMs = Date.parse(schedule.at);
      return Number.isNaN(atMs) || atMs <= fromMs ? null : atMs;
    }
    case 'cron':
      return nextCronRunMs(schedule.expr, fromMs);
    case 'rrule': {
      const lowered = lowerRrule(schedule.rrule);
      if (!lowered.ok) return null;
      // 降级结果里若带 `UNTIL`，它是**调度自带**的上界，与任务级窗口取交集
      return computeRaw(lowered.schedule, fromMs);
    }
  }
}

/**
 * 从调度里抽出「随调度一起表达的窗口下界」——目前只有 RRULE 的 `UNTIL=`
 * （它不改变触发时刻，只限定截止）。任务级 `validUntil` 与它取**更早**的那个。
 */
export function untilFromSchedule(schedule: TaskSchedule): string | undefined {
  if (schedule.kind !== 'rrule') return undefined;
  const lowered = lowerRrule(schedule.rrule);
  return lowered.ok ? lowered.until : undefined;
}

/**
 * 任务的有效期窗口：**任务级窗口与调度自带窗口取交集**。
 *
 * 上界可能出现两处：`TaskConfig.validUntil`（用户直接填的）与 RRULE 里的 `UNTIL=`
 * （循环规则自带的截止）。两者都要尊重，取**更早**的那个才对（否则用户写了
 * `UNTIL=` 却被任务级窗口放宽，规则就不再是他写的规则了）。
 */
export function effectiveValidityWindow(task: Pick<TaskConfig, 'schedule' | 'validFrom' | 'validUntil'>): ValidityWindow {
  const candidates = [task.validUntil, untilFromSchedule(task.schedule)].filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  const sorted = candidates.slice().sort((a, b) => Date.parse(a) - Date.parse(b));
  const until = sorted[0];
  return {
    ...(task.validFrom ? { from: task.validFrom } : {}),
    ...(until ? { until } : {}),
  };
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
    // 有效期窗口透传进元数据：引擎不消费它（它没有窗口概念），但把「这条任务当时
    // 是按什么窗口算出来的」留在 job 上，排查「为什么这条没跑」时能一眼看到
    ...(task.validFrom || task.validUntil
      ? { validity: { ...(task.validFrom ? { from: task.validFrom } : {}), ...(task.validUntil ? { until: task.validUntil } : {}) } }
      : {}),
    /*
     * 任务级工作目录（FR-5.8）：写进 `workspace_scope`。引擎是在**每个 turn 的会话作用域**
     * 里读它的——`WorkspaceScopeResolver.for_turn` 先看 message metadata 的
     * `workspace_scope`（`WORKSPACE_SCOPE_METADATA_KEY`），而 cron 的 `originMetadata`
     * 会被 `bound_runner` 原样搬成该 turn 的 message metadata，所以这条链路**不需要
     * 引擎侧新增字段**（这是 FR-5.8 能纯客户端落地的原因）。
     *
     * ⚠️ 引擎只在 `channel ∈ {websocket, api}` 时解析它，其余渠道**直接回落默认工作空间**
     * 且不报错。任务的 origin channel 正是 `api`——别为了别的目的把它改成 IM 渠道名。
     */
    ...(task.workdir ? { workspace_scope: { project_path: task.workdir } } : {}),
  };
  // 结果推送（FR-5.6）：只在真的有目标时才下发。空配置**不写键**——保持 payload
  // 干净，也让主进程的幂等合并不至于在「有键但空」与「没键」两态之间来回抖。
  const delivery =
    task.delivery && task.delivery.targets.length > 0
      ? {
          targets: task.delivery.targets.map((t) => ({ channel: t.channel, chatId: t.chatId })),
          on: task.delivery.on,
        }
      : undefined;
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
      ...(delivery ? { delivery } : {}),
    },
    state: { nextRunAtMs: computeNextRunMs(task.schedule, nowMs, effectiveValidityWindow(task)) },
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
