/**
 * 工作空间路径的展示名解析。
 *
 * 侧边栏分组标题、输入框工具条的工作空间按钮、窗口标题栏的搜索任务结果、产物
 * 面板都要显示同一份工作空间名，各处各写一遍必然漂移（历史上就出现过「分组标题
 * 用别名、面板用末级目录名」的不一致），因此集中到这里。
 */

/**
 * 「默认工作空间」的展示名。
 *
 * 它同时是**一个语义分组**：组内是「落在设置里那个默认工作空间路径上」的任务。
 * 用户没配就是内置的 `<home>/NanoWork`（见 `storageInfoStore`）。
 */
export const DEFAULT_WORKSPACE_LABEL = '默认工作空间';

/** 从路径取末级目录名作为默认标题（跨平台分隔符兼容） */
export function dirBasename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 判定两个路径是否指向同一个目录。
 *
 * 需要它，是因为同一个目录会有**两种字面量来源**：会话里存的 `workdir` 是当时
 * 用户（或目录选择器）给的原始串；默认工作空间的路径是主进程用 `path.join` 拼出来
 * 的。两者可能差一个大小写、一条多余的尾部分隔符或正反斜杠混用，直接 `===` 比较
 * 会判定成「两个不同的工作空间」，于是侧边栏并排出现两个组——一个叫「默认工作空间」、
 * 一个叫默认目录的名字，指向的却是同一个地方。
 *
 * 任一侧为空一律 `false`：`undefined` 的语义是「未指定」，不是一个空路径。
 */
export function isSameWorkspacePath(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) return false;
  const normalize = (p: string): string => {
    const unified = p.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '') || '/';
    // Windows 盘符（`C:/…`）与 UNC（`//server/share`）大小写不敏感；
    // POSIX 路径大小写敏感，不能一并折成小写。
    const caseInsensitive = /^[a-z]:\//i.test(unified) || unified.startsWith('//');
    return caseInsensitive ? unified.toLowerCase() : unified;
  };
  return normalize(a) === normalize(b);
}

/**
 * 解析工作空间展示名：默认工作空间 > 用户别名 > 路径末级目录名。
 *
 * **默认工作空间优先于别名**：别名是给「用户指定的某个目录」起的名字，而默认工作
 * 空间的名字由它的语义决定——组内就是设置里那个默认路径下的任务，用户改了设置之后
 * 这个名字依然成立。若让别名压过它，就会出现「改一个设置，分组名一会儿是别名、
 * 一会儿是默认名」的漂移；而这个分组不提供重命名入口，那条别名也就永远没有入口
 * 去维护。（别名与默认名一致时 `setWorkspaceAlias` 会把它从表里删掉，无需再判等。）
 */
export function resolveWorkspaceLabel(
  path: string,
  aliases: Record<string, string> | undefined,
  defaultPath?: string,
): string {
  if (defaultPath && isSameWorkspacePath(path, defaultPath)) {
    return DEFAULT_WORKSPACE_LABEL;
  }
  return aliases?.[path] ?? dirBasename(path);
}
