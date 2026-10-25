/**
 * 任务级工作目录（FR-5.8）的展示。
 *
 * 单独成模块是为了让**判据只有一处**：侧边栏分组、ComposerControls、产物面板都在回答
 * 「这个工作空间叫什么、是不是默认那个」，任务卡片是第四个问同一件事的地方。各写一遍
 * 必然漂移（历史上就出现过「分组标题用别名、面板用末级目录名」），所以复用
 * `workspace/workspaceLabel.ts` 的 `isSameWorkspacePath` / `resolveWorkspaceLabel`。
 */

import { isSameWorkspacePath, resolveWorkspaceLabel } from '@/lib/workspace/workspaceLabel';

/**
 * 任务卡片上的工作目录摘要；**未绑定**或**绑定到默认工作空间**时返回 `null`。
 *
 * 后一种情况是刻意的：绑定到默认目录与不绑定是同一个意思（任务本来就在那里跑），
 * 显示出来只会把那一行撑长。判据与侧边栏分组用的是同一个 `isSameWorkspacePath`——
 * 路径字面量可能差一个尾部分隔符或大小写，直接 `===` 会误判成「两个不同的工作空间」。
 */
export function describeTaskWorkdir(
  workdir: string | undefined,
  defaultPath: string | undefined,
  aliases?: Record<string, string>,
): string | null {
  if (!workdir || !workdir.trim()) return null;
  if (isSameWorkspacePath(workdir, defaultPath)) return null;
  return `工作目录：${resolveWorkspaceLabel(workdir, aliases, defaultPath)}`;
}
