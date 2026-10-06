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
import { isSameWorkspacePath } from '@/lib/workspaceLabel';

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
  /** Agent 维度：`'all'` 表示不按 Agent 筛选；其余为具体 Agent id（空串 `''` = 未绑定专家） */
  agentId: string;
  /**
   * 工作空间维度：`'all'` 表示不按工作空间筛选；其余为工作空间分组键——
   * 空串 `''` 表示「默认工作空间」分组，非空前为 `Session.workdir`（语义工作空间路径）。
   * 取值与 `SidebarNav.groupSessionsByWorkdir` 的分组键同源，保证筛选与列表分组一致。
   */
  workspace: string;
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
  agentId: 'all',
  workspace: 'all',
};

/** 判断筛选条件是否为「默认（未筛选）」状态 */
export function isFilterDefault(filters: TaskFilters): boolean {
  return (
    filters.status === 'all' &&
    filters.time === 'all' &&
    filters.agentId === 'all' &&
    filters.workspace === 'all'
  );
}

/** 生效的筛选维度个数（用于筛选图标的激活态提示） */
export function activeFilterCount(filters: TaskFilters): number {
  return (
    (filters.status === 'all' ? 0 : 1) +
    (filters.time === 'all' ? 0 : 1) +
    (filters.agentId === 'all' ? 0 : 1) +
    (filters.workspace === 'all' ? 0 : 1)
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
 * Agent 维度筛选。
 *
 * 空串 `''` 是「未绑定专家」的合法取值（新建任务的默认态），与「全部」(`'all'`)
 * 必须区分——两者语义不同，不能互相替代。
 */
export function matchAgent(session: Session, agentId: string): boolean {
  if (agentId === 'all') return true;
  return session.agentId === agentId;
}

/**
 * 取会话的工作空间分组键（与 `SidebarNav.groupSessionsByWorkdir` 同源）。
 *
 * 落到默认工作空间上的会话与没绑工作空间的会话合并成同一个组（key `''`）——
 * 两者在语义上都是「设置里那个默认工作空间下的任务」，否则侧边栏会并排出
 * 两个指向同一目录的组。
 */
export function workspaceKeyOf(
  session: Session,
  defaultWorkspacePath?: string,
): string {
  if (isSameWorkspacePath(session.workdir, defaultWorkspacePath)) return '';
  return session.workdir ?? '';
}

/**
 * 工作空间维度筛选。
 *
 * `'all'` 表示不筛选；空串 `''` 表示筛选「默认工作空间」分组（与 `workspaceKeyOf`
 * 的默认组键一致）。`Session.workdir` 是**语义工作空间**（`meta.workspace ?? meta.workdir`，
 * 见 `project.metaToSession`），因此与侧边栏分组口径一致。
 */
export function matchWorkspace(
  session: Session,
  workspace: string,
  defaultWorkspacePath?: string,
): boolean {
  if (workspace === 'all') return true;
  return workspaceKeyOf(session, defaultWorkspacePath) === workspace;
}

/**
 * 关键词匹配：标题 / 工作空间路径 / 消息正文。
 *
 * 命中消息正文是刻意为之——只匹配标题时「搜任务」几乎没用（用户记不住标题原文）。
 * 注意：本函数只搜**已水合**消息（`session.messages`）；未点开过的会话消息留白，
 * 它们的正文全文检索由 `@/lib/sessionSearch` 异步接管（见 FR-1.7）。
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
    defaultWorkspacePath?: string;
  },
): boolean {
  const { query = '', filters, streamStatus, now, defaultWorkspacePath } = opts;
  if (!matchQuery(session, query)) return false;
  if (!matchStatus(session, filters.status, streamStatus)) return false;
  if (!matchTime(session, filters.time, now)) return false;
  if (!matchAgent(session, filters.agentId)) return false;
  if (!matchWorkspace(session, filters.workspace, defaultWorkspacePath)) return false;
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
    defaultWorkspacePath?: string;
  },
): Session[] {
  const { query = '', filters, streams, now, defaultWorkspacePath } = opts;
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
        defaultWorkspacePath,
      }),
    )
    .sort((a, b) => updatedAtOf(b) - updatedAtOf(a));
}
