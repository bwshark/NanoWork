/**
 * 项目空间的**归属投影**（FR-12.7）：纯函数，不碰 store，因此可逐条单测。
 *
 * ## 为什么产物不存 `projectId`
 *
 * 产物属于会话（`ArtifactIndexEntry.sessionId`），会话属于项目（`Session.projectId`）。
 * 若再给产物冗余一份 `projectId`，就出现了**两份归属**：会话被移到另一个项目时，
 * 产物的那份快照留在原地，于是「项目 A 的看板里还挂着已经属于 B 的文件」——
 * 而这不会报错，只会让归属慢慢烂掉。
 *
 * 所以归属一律**派生**：`产物 → 会话 → 项目`。代价是一次 join，收益是只有一份真相。
 *
 * 同理任务：`TaskConfig.projectId` 是**用户直接选的**（任务可以不属于任何会话），
 * 所以它必须自己存一份；这与产物的情况不同，不是不一致。
 *
 * ## 两个边界
 *
 * 1. **会话被删 → 它的产物从项目里消失**（`sessionId` 解不出项目）。
 *    这符合直觉：会话没了，它的产物也不再是「这个项目的工作成果」。
 * 2. **项目被删 → 会话 / 任务上的 `projectId` 变成悬空引用**。
 *    这里刻意**不清理**：清理要在删除项目时批量改写本机数据，而删除是服务端动作、
 *    本机可能离线。界面按「项目已不存在」渲染即可（见 `projectExists`）。
 */

import type { ArtifactIndexEntry, Session, TaskConfig } from '@/types';

/** 只取活着的会话（墓碑不该出现在任何项目的看板里） */
function isLive(session: Session): boolean {
  // 会话是内联形态：`deletedAt` 不在类型上（删除走「三件套全删」+ 兄弟表墓碑），
  // 这里仍然容错读一下 —— 从远端落地过来的记录可能带着它
  const deletedAt = (session as { deletedAt?: string | null }).deletedAt;
  return deletedAt == null || deletedAt === '';
}

/** 该项目的会话（按最近更新倒序） */
export function sessionsOfProject(
  sessions: readonly Session[] | undefined,
  projectId: string,
): Session[] {
  if (!sessions || !projectId) return [];
  return sessions
    .filter((s) => s.projectId === projectId && isLive(s))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/** 该项目的任务（按创建时间倒序） */
export function tasksOfProject(
  tasks: readonly TaskConfig[] | undefined,
  projectId: string,
): TaskConfig[] {
  if (!tasks || !projectId) return [];
  return tasks
    .filter((t) => t.projectId === projectId && t.deletedAt == null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * 该项目的产物：**派生**（产物 → 会话 → 项目），不读产物上的任何归属字段。
 *
 * 墓碑不算（`deletedAt` 非空 = 跨端删除传播中的条目）。
 */
export function artifactsOfProject(
  sessions: readonly Session[] | undefined,
  entries: readonly ArtifactIndexEntry[] | undefined,
  projectId: string,
): ArtifactIndexEntry[] {
  if (!sessions || !entries || !projectId) return [];
  const sessionIds = new Set(
    sessions.filter((s) => s.projectId === projectId && isLive(s)).map((s) => s.id),
  );
  if (sessionIds.size === 0) return [];
  return entries
    .filter((e) => sessionIds.has(e.sessionId) && e.deletedAt == null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * 项目 id 在本机已知项目里是否存在。
 *
 * 用来把「悬空引用」如实说成「项目已不存在」：会话 / 任务上的 `projectId` 在项目被删后
 * 不会自动清空（见文件头第 2 条），界面不能凭这个字符串去反推项目名。
 */
export function projectExists(
  projects: readonly { id: string }[] | undefined,
  projectId: string | undefined,
): boolean {
  if (!projectId) return false;
  if (!projects) return false;
  return projects.some((p) => p.id === projectId);
}
