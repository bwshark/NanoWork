/**
 * 跨会话全文检索（FR-1.7 的「全文」维度）。
 *
 * ## 为什么是异步、且只服务于搜索窗
 *
 * 侧边栏列表启动时**只读索引、消息留白**（`sessionsStore.loadSessions` 不读正文），
 * 「全文」必须读每条会话的事件流（JSONL）才能拿到消息正文；把 IO 塞进同步的
 * `filterTasks` 会破坏它「纯函数、侧边栏与搜索窗共用」的契约，且让侧边栏每次渲染
 * 都去读盘——而侧边栏本来就不接受关键词输入，没必要。因此本模块只接管「搜索窗
 * 关键词」这一条异步链路：
 *
 * 1. 先由 `filterTasks`（同步）按状态 / 时间 / Agent / 工作空间收窄；
 * 2. 再对候选会话按需读事件流，投影出消息正文做全文匹配。
 *
 * 标题 / 工作空间路径的匹配仍走同步的 `matchQuery`（这两个字段在列表态就有），
 * 只有「消息正文」这一项需要读盘。
 *
 * ## 缓存策略
 *
 * 按 `sessionId + updatedAt` 缓存「已投影的正文小写串」：同一轮检索里每敲一个字符
 * 不必重读一遍 JSONL（未点开的会话尤其贵）。会话落了新消息后 `updatedAt` 变化，
 * 缓存自动失效；点开会话后的内存水合内容与事件流内容等价，缓存命中结果一致。
 */
import { getEventStore } from '@/events';
import { project } from '@/events/project';
import { filterTasks, matchQuery, type TaskFilters } from '@/lib/task/taskQuery';
import type { StreamStatus } from '@/stores/sessionsStore';
import type { Session } from '@/types';

/** 搜索窗一次最多展示的结果数（与 `TaskSearchDialog` 的 `SEARCH_LIMIT` 对齐） */
const SEARCH_LIMIT = 60;

/** 投影正文缓存：`sessionId + updatedAt` → 小写拼接的正文。容量闸避免长会话无限增长 */
const bodyTextCache = new Map<string, string>();
const BODY_CACHE_MAX = 2000;

function bodyCacheKey(session: Session): string {
  return `${session.id}\u0000${session.updatedAt}`;
}

/**
 * 取会话的正文小写串：已水合用内存消息；未水合按需读事件流再投影。
 * 结果按 `updatedAt` 缓存（见模块头部说明）。
 */
async function loadBodyText(session: Session): Promise<string> {
  const key = bodyCacheKey(session);
  const cached = bodyTextCache.get(key);
  if (cached !== undefined) return cached;

  let text: string;
  if (session.messages.length > 0) {
    text = session.messages.map((m) => m.content ?? '').join('\n').toLowerCase();
  } else {
    try {
      const shard = session.streamWorkdir ?? session.workdir;
      const events = await getEventStore().readEvents(session.id, shard);
      text = project(events)
        .messages.map((m) => m.content ?? '')
        .join('\n')
        .toLowerCase();
    } catch {
      // 读不到事件流（磁盘损坏 / Web 分片缺失）：退化为「只有标题 / 工作空间可搜」
      text = '';
    }
  }

  if (bodyTextCache.size >= BODY_CACHE_MAX) bodyTextCache.clear();
  bodyTextCache.set(key, text);
  return text;
}

/** 仅清缓存（测试与「重置筛选」时调用，避免跨会话残留过期正文） */
export function clearSearchBodyCache(): void {
  bodyTextCache.clear();
}

export interface SessionSearchOptions {
  query: string;
  filters: TaskFilters;
  streams?: Record<string, { status: StreamStatus }>;
  now?: number;
  defaultWorkspacePath?: string;
  /** 结果上限，默认 {@link SEARCH_LIMIT} */
  limit?: number;
}

/**
 * 跨会话检索：维度筛选（同步）+ 关键词（标题 / 工作空间 / 全文）。
 *
 * - 无关键词：直接返回 `filterTasks` 的结果（维度筛选 + 倒序），不读盘；
 * - 有关键词：先按维度同步收窄，再对候选做标题 / 工作空间（同步）+ 正文（异步）匹配；
 *   候选已按 `updatedAt` 倒序，命中结果保持该顺序（与 `filterTasks` 一致）。
 *
 * `streams[].status` 沿用 `filterTasks` 的 `StreamStatus` 类型：本模块只负责透传，
 * 实际取值来自 `sessionsStore.streams`。
 */
export async function searchSessions(
  sessions: Session[],
  opts: SessionSearchOptions,
): Promise<Session[]> {
  const q = opts.query.trim().toLowerCase();
  const limit = opts.limit ?? SEARCH_LIMIT;

  // 无关键词：纯维度筛选，无需 IO
  if (!q) {
    return filterTasks(sessions, {
      filters: opts.filters,
      streams: opts.streams,
      now: opts.now,
      defaultWorkspacePath: opts.defaultWorkspacePath,
    }).slice(0, limit);
  }

  // 先同步按维度收窄，只对候选做全文 IO（控制读盘范围）
  const candidates = filterTasks(sessions, {
    filters: opts.filters,
    streams: opts.streams,
    now: opts.now,
    defaultWorkspacePath: opts.defaultWorkspacePath,
  });

  const matched: Session[] = [];
  for (const s of candidates) {
    // 标题 / 工作空间命中（同步，已在 matchQuery 内）优先，避免无谓读盘
    if (matchQuery(s, q)) {
      matched.push(s);
      continue;
    }
    const body = await loadBodyText(s);
    if (body.includes(q)) matched.push(s);
  }
  return matched.slice(0, limit);
}
