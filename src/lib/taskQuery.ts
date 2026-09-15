/**
 * 任务的检索与筛选（窗口标题栏的「搜索任务 / 筛选任务」共用）。
 *
 * 设计原则：**全部指标都从真实会话字段派生**，不引入任何存储侧的新字段。
 * - 状态：由「流式状态 + 末条消息角色 + 中断标记」推导（见 `deriveTaskStatus`）；
 * - 时间：直接用 `updatedAt`；
 * - 关键词：标题 / 工作空间路径 / 消息正文。
 *
 * 之所以把派生逻辑放 lib 而不是组件内：侧边栏列表与居中搜索窗要给出**完全一致**
 * 的筛选结果，两处各写一份必然漂移。
 */
import type { Session } from '@/types';
import type { StreamStatus } from '@/stores/sessionsStore';

/** 任务状态（筛选面板「状态」维度的取值） */
export type TaskStatusKey =
  | 'running' // 进行中：正在流式执行
  | 'done' // 已完成：末条是助手回复且未被中断
  | 'failed' // 失败：末条助手回复被中断（当前数据模型里唯一可判定的异常终止信号）
  | 'pending' // 待处理：末条是用户提问，助手尚未回复
  | 'planning'; // 规划中：还没有任何消息（刚建的任务）

/** 状态筛选：具体状态或「全部状态」 */
export type TaskStatusFilter = TaskStatusKey | 'all';

/** 时间筛选 */
export type TaskTimeFilter = 'all' | 'today' | 'week' | 'month';

/** 任务筛选条件（搜索关键词单独存放，因为它只作用于搜索窗） */
export interface TaskFilters {
  status: TaskStatusFilter;
  time: TaskTimeFilter;
}

/** 筛选面板「筛选状态」的选项表（顺序即面板中的展示顺序） */
export const TASK_STATUS_OPTIONS: ReadonlyArray<{
  value: TaskStatusFilter;
  label: string;
}> = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'pending', label: '待处理' },
  { value: 'planning', label: '规划中' },
];

/** 筛选面板「筛选时间」的选项表 */
export const TASK_TIME_OPTIONS: ReadonlyArray<{
  value: TaskTimeFilter;
  label: string;
}> = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '最近 7 天' },
  { value: 'month', label: '最近 30 天' },
];

/** 各状态的展示元信息（供搜索结果列表的状态点使用） */
export const TASK_STATUS_META: Record<
  TaskStatusKey,
  { label: string; color: string }
> = {
  running: { label: '进行中', color: '#22c55e' },
  done: { label: '已完成', color: '#64748b' },
  failed: { label: '失败', color: '#ef4444' },
  pending: { label: '待处理', color: '#f59e0b' },
  planning: { label: '规划中', color: '#8b5cf6' },
};

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  status: 'all',
  time: 'all',
};

/** 判断筛选条件是否为「默认（未筛选）」状态 */
export function isFilterDefault(filters: TaskFilters): boolean {
  return filters.status === 'all' && filters.time === 'all';
}

/** 生效的筛选维度个数（用于筛选图标的激活态提示） */
export function activeFilterCount(filters: TaskFilters): number {
  return (
    (filters.status === 'all' ? 0 : 1) + (filters.time === 'all' ? 0 : 1)
  );
}

/**
 * 由会话推导任务状态。
 *
 * 判定优先级（自上而下，先命中先返回）：
 * 1. 流式进行中 → `running`（正在跑的任务优先级最高，即便历史消息看起来像已完成）
 * 2. 无任何消息 → `planning`
 * 3. 末条是 user → `pending`（已提问、助手未答）
 * 4. 末条 assistant 带 `aborted` 标记 → `failed`
 * 5. 其余（末条是 assistant / tool）→ `done`
 *
 * 注意：数据模型里没有独立的「错误」字段，`aborted` 是唯一可判定的异常终止信号，
 * 因此把「失败」映射到它；若后续会话引入 error 字段，只需改这一处。
 */
export function deriveTaskStatus(
  session: Session,
  streamStatus?: StreamStatus,
): TaskStatusKey {
  if (streamStatus && streamStatus !== 'idle' && streamStatus !== 'done') {
    return 'running';
  }
  const messages = session.messages;
  if (messages.length === 0) return 'planning';
  const last = messages[messages.length - 1];
  if (last.role === 'user') return 'pending';
  if (last.role === 'assistant' && last.aborted) return 'failed';
  return 'done';
}

/** 判断会话是否通过状态维度 */
export function matchStatus(
  session: Session,
  status: TaskStatusFilter,
  streamStatus?: StreamStatus,
): boolean {
  if (status === 'all') return true;
  return deriveTaskStatus(session, streamStatus) === status;
}

/** 取某时刻所在自然日的 00:00:00（本地时区） */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 判断会话是否通过时间维度（基于 `updatedAt`）。
 *
 * - `today`：与当前时刻同一自然日；
 * - `week`：含今天在内的最近 7 个自然日；
 * - `month`：含今天在内的最近 30 个自然日。
 *
 * `updatedAt` 不可解析时**不淘汰**该会话——时间维度是收窄条件，
 * 不应因为脏数据把任务从列表里彻底藏掉。
 */
export function matchTime(
  session: Session,
  time: TaskTimeFilter,
  now: number = Date.now(),
): boolean {
  if (time === 'all') return true;
  const t = Date.parse(session.updatedAt);
  if (Number.isNaN(t)) return true;
  const todayStart = startOfDay(now);
  if (time === 'today') return t >= todayStart;
  const days = time === 'week' ? 7 : 30;
  return t >= todayStart - (days - 1) * 86_400_000;
}

/**
 * 关键词匹配：标题 / 工作空间路径 / 消息正文。
 *
 * 命中消息正文是刻意为之——只匹配标题时「搜任务」几乎没用（用户记不住标题原文）。
 */
export function matchQuery(session: Session, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (session.title.toLowerCase().includes(q)) return true;
  if (session.workdir && session.workdir.toLowerCase().includes(q)) return true;
  return session.messages.some((m) =>
    (m.content ?? '').toLowerCase().includes(q),
  );
}

/** 单个任务的完整判定（关键词 + 筛选条件） */
export function matchTask(
  session: Session,
  opts: {
    query?: string;
    filters: TaskFilters;
    streamStatus?: StreamStatus;
    now?: number;
  },
): boolean {
  const { query = '', filters, streamStatus, now } = opts;
  if (!matchQuery(session, query)) return false;
  if (!matchStatus(session, filters.status, streamStatus)) return false;
  if (!matchTime(session, filters.time, now)) return false;
  return true;
}

/**
 * 批量筛选并按「最近更新」倒序返回。
 *
 * 置顶不参与排序：搜索/筛选结果是「查找视图」，按时间倒序最符合查找预期。
 */
export function filterTasks(
  sessions: Session[],
  opts: {
    query?: string;
    filters: TaskFilters;
    streams?: Record<string, { status: StreamStatus }>;
    now?: number;
  },
): Session[] {
  const { query = '', filters, streams, now } = opts;
  // 时间不可解析的会话排到最后，避免 NaN 让整个排序退化
  const updatedAtOf = (s: Session) => {
    const v = Date.parse(s.updatedAt);
    return Number.isNaN(v) ? 0 : v;
  };
  return sessions
    .filter((s) =>
      matchTask(s, {
        query,
        filters,
        streamStatus: streams?.[s.id]?.status,
        now,
      }),
    )
    .sort((a, b) => updatedAtOf(b) - updatedAtOf(a));
}
