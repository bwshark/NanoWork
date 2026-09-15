/**
 * 工作空间路径的展示名解析。
 *
 * 侧边栏分组标题、产物面板「概览」、窗口标题栏的搜索任务结果都要显示同一份
 * 工作空间名，三处各写一遍必然漂移（历史上就出现过「分组标题用别名、面板用
 * 末级目录名」的不一致），因此集中到这里。
 */

/** 未设置工作空间时的展示名（侧边栏「默认工作空间」分组同名） */
export const DEFAULT_WORKSPACE_LABEL = '默认工作空间';

/** 从路径取末级目录名作为默认标题（跨平台分隔符兼容） */
export function dirBasename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 解析工作空间展示名：优先取用户在 `settingsStore.workspaceAliases` 中设置的别名，
 * 否则回退到 `dirBasename`。
 *
 * 别名与默认名一致时 `setWorkspaceAlias` 会把它从表里删掉，所以这里不需要再判等。
 */
export function resolveWorkspaceLabel(
  path: string,
  aliases: Record<string, string> | undefined,
): string {
  return aliases?.[path] ?? dirBasename(path);
}
