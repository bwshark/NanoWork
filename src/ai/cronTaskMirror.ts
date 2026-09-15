/**
 * 聊天 cron 工具执行结果 → 任务列表镜像层。
 *
 * 背景：聊天中智能体调用内置 `cron` 工具（action=add）创建定时任务，
 * 引擎成功结果字符串契约：`Created job '<name>' (id: <id>)`（8 位 id）；
 * 工具执行事件经 SSE 流式聚合进 `message.process`（ProcessToolRow）。
 * 本模块解析这类「cron add 成功」行，将其镜像为 TaskConfig 写入
 * tasksStore（任务唯一数据源），使智能体创建的任务无缝出现在任务列表，
 * 并经 addTask 后的防抖机制走既有自动同步链路（无额外同步逻辑）。
 *
 * 幂等原则（宁可不镜像，绝不自造 id 造成双份调度）：
 * 1. callId 级去重：模块级 Set，同一次工具调用只镜像一次；
 * 2. tasksStore 同 id 存在性检查：历史消息重放（持久化恢复）的第二道闸；
 * 3. tasksStore.addTask 对带 id 写入本身做幂等合并（第三道闸）。
 */

import { validateCron } from '@/lib/cron';
import { makeTaskName } from '@/lib/taskDraft';
import { useTasksStore } from '@/stores/tasksStore';
import type { TaskConfig, TaskSchedule } from '@/types';

/** 已成功镜像过的工具调用 id（进程内去重；重启后由第二/三道闸兜底） */
const mirroredCallIds = new Set<string>();

/** 清空镜像去重集（仅供测试重置；生产链路无需调用） */
export function resetMirrorDedup(): void {
  mirroredCallIds.clear();
}

/**
 * 从引擎工具成功结果字符串中提取 job id。
 * 契约形态：`Created job '<name>' (id: <id>)`。
 * @param result 工具执行结果字符串（可能缺失/为空）
 * @returns 解析出的 job id；无法解析（含缺前缀 / 缺 id 段）一律返回 null——
 *          宁可不镜像，绝不猜测或自造 id，避免与引擎任务形成双份调度
 */
export function parseCronJobId(result: string | undefined): string | null {
  if (!result) return null;
  // 名称前缀校验：排除其他工具/自由文本里偶然出现的 `(id: xxx)` 片段
  if (!result.startsWith('Created job')) return null;
  const m = result.match(/\(id:\s*([^)\s]+)\)/);
  return m ? m[1] : null;
}

/**
 * 解析 `at` 调度时间为毫秒时间戳。
 * 带时区（Z / ±hh:mm / ±hhmm）按字面时区解释；
 * 无时区字符串按**本地时区**解释（与引擎 Asia/Shanghai 语义一致：
 * 用户在对话中说的时刻即本地时刻），并保证输出完整 ISO。
 * @param at 引擎传入的 ISO/类 ISO 时间字符串
 * @returns 毫秒时间戳；无法解析返回 null
 */
function parseAtToMs(at: string): number | null {
  const s = at.trim();
  if (!s) return null;
  const hasExplicitTz = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (hasExplicitTz) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  // 无时区：逐段解析后按本地时区构造（规避各引擎对无时区 ISO 的解释差异）
  const m = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (m) {
    const [, y, mo, d, h, mi, se = '0', frac = '0'] = m;
    const ms = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(se),
      Number(frac.padEnd(3, '0')),
    ).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  // 其他形态兜底交给 Date.parse（其日期时间形态默认按本地时区解释）
  const fallback = Date.parse(s);
  return Number.isNaN(fallback) ? null : fallback;
}

/**
 * 将聊天中 `cron` 工具的入参映射为前端任务草稿。
 * 仅当 `action === 'add'` 且 `message` 非空时返回草稿，否则 null。
 * 调度映射互斥，优先级：at > cron_expr > every_seconds：
 * - `at`（ISO）→ once（无时区按本地时区解释，输出完整 ISO）；
 * - `cron_expr` → cron（经 validateCron 校验，失败不镜像）；
 * - `every_seconds` → interval（秒换算为分钟，至少 1 分钟）。
 * @param args 工具入参（来自 ProcessToolRow.args）
 * @returns 任务草稿（name / schedule / prompt）；不满足镜像条件返回 null
 */
export function cronToolArgsToTaskDraft(
  args: Record<string, unknown>,
): Partial<TaskConfig> | null {
  if (args.action !== 'add') return null;
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) return null;

  // —— 调度映射（互斥，优先级 at > cron_expr > every_seconds）——
  let schedule: TaskSchedule | null = null;

  if (typeof args.at === 'string' && args.at.trim() !== '') {
    const atMs = parseAtToMs(args.at);
    if (atMs === null) return null; // 时间无法解析：宁可不镜像
    schedule = { kind: 'once', at: new Date(atMs).toISOString() };
  } else if (typeof args.cron_expr === 'string' && args.cron_expr.trim() !== '') {
    const expr = args.cron_expr.trim();
    if (!validateCron(expr).valid) return null; // 表达式非法：宁可不镜像
    const tz = typeof args.tz === 'string' && args.tz.trim() !== '' ? args.tz.trim() : undefined;
    schedule = { kind: 'cron', expr, ...(tz ? { tz } : {}) };
  } else if (typeof args.every_seconds === 'number' && Number.isFinite(args.every_seconds)) {
    if (args.every_seconds <= 0) return null;
    schedule = { kind: 'interval', minutes: Math.max(1, Math.round(args.every_seconds / 60)) };
  } else {
    return null; // 无任何可识别调度：宁可不镜像
  }

  // 名称：缺省时复用既有命名工具，由 message 截断生成
  const name =
    typeof args.name === 'string' && args.name.trim() !== ''
      ? args.name.trim()
      : makeTaskName(message);

  return { name, schedule, prompt: message };
}

/** cron 工具执行行 → 镜像入参（ProcessToolRow 的最小子集） */
export interface CronToolEventLike {
  /** 工具调用 id（ProcessToolRow.id；镜像去重键） */
  callId: string;
  /** 工具入参 */
  args: Record<string, unknown>;
  /** 成功结果字符串（契约：`Created job '<name>' (id: <id>)`） */
  result?: string;
  /** 错误信息（存在时不镜像） */
  error?: string;
}

/**
 * 将一次「cron 工具执行成功（action=add）」镜像进任务列表。
 * 条件：无 error、result 能解析出 jobId、入参能映射出有效草稿。
 * 三道幂等闸：callId 去重 → tasksStore 同 id 存在性 → addTask 幂等合并。
 * @param ev 工具执行事件（行 id 作为 callId）
 * @returns 镜像产出/既有的任务；不满足镜像条件返回 null
 */
export function mirrorCronToolEvent(ev: CronToolEventLike): TaskConfig | null {
  if (ev.error) return null;
  const jobId = parseCronJobId(ev.result);
  if (!jobId) return null;
  const draft = cronToolArgsToTaskDraft(ev.args);
  if (!draft) return null;

  const findExisting = () => useTasksStore.getState().tasks.find((t) => t.id === jobId) ?? null;

  // 第一道闸：同一工具调用只镜像一次（重放/重复订阅兜底为返回既有任务）
  if (mirroredCallIds.has(ev.callId)) return findExisting();
  mirroredCallIds.add(ev.callId);

  // 第二道闸：任务列表已含同 id（历史消息重放/恢复），直接返回既有任务
  const existing = findExisting();
  if (existing) return existing;

  // 第三道闸在 addTask 内部：带 id 写入做幂等合并，绝不重复追加
  return useTasksStore.getState().addTask({ id: jobId, ...draft });
}
