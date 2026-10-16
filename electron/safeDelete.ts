/**
 * 应用数据删除统一走系统回收站（FR-8.11）。
 *
 * ## 抄的是什么
 *
 * WorkBuddy 的分析② B4 指出：主进程删除用户资产（插件包、会话数据、凭据副本）
 * 应当走「回收站」而非物理删除——误删可在回收站找回。本项目原先是裸 `fs.rm`，
 * 删了就是删了，零可恢复性。
 *
 * ## fail-closed（核心不变量）
 *
 * 一旦决定走回收站，「回收站失败」**绝不**降级成「物理删除」。理由：回收站是用户资产的
 * 最后一道可恢复屏障；一旦在 trashItem 失败后回退 `fs.rm`，误删就变成永久销毁，
 * 而且这个回退是**静默**的——用户永远不会知道数据被物理删了。所以：trashItem 抛错
 * 就让它抛，让上层把错误暴露给用户（或走别的恢复路径），也不要偷偷物理销毁。
 *
 * ## 为什么不用静态 `import { shell } from 'electron'`
 *
 * 本模块会被 `eventStore.ts`（纯 node IO 层，测试里不启 Electron）依赖。若静态
 * import 'electron'，那些测试会因 `Cannot find module 'electron'` 集体红。所以 shell
 * 用**惰性 require** 解析：Electron 主进程内解析到 `shell.trashItem`；node/测试环境
 * 解析不到就回落到 `nodeFallback`（物理删除）。注意——这个回落**不是** fail-closed 的
 * 降级分支，它只在「根本没有回收站概念」的测试环境生效，与「shell 在但 trashItem 失败」
 * 是两回事。
 */

import { stat, rm } from 'node:fs/promises';

/** 送回收站的函数签名；默认实现见 `resolveTrash`。 */
export type TrashFn = (path: string) => Promise<void>;

/**
 * 非 Electron 环境兜底：没有回收站概念，直接物理删除。
 * 仅当惰性解析不到 `shell` 时使用（测试 / node 脚本）。
 */
const nodeFallback: TrashFn = (path) => rm(path, { recursive: true, force: true });

let cachedTrash: TrashFn | null | undefined;

/**
 * 惰性解析「生产回收站函数」：Electron 主进程内返回 `shell.trashItem`，
 * 解析不到返回 `null`（调用方回落 `nodeFallback`）。只解析一次。
 */
function resolveTrash(): TrashFn | null {
  if (cachedTrash !== undefined) return cachedTrash;
  cachedTrash = null;
  try {
    // 用 globalThis.require 兜底：esbuild 产出的 cjs 里有 require；
    // vitest(ESM) 里 require 为 undefined → 走 catch → 回落 null。
    const req = (globalThis as unknown as { require?: NodeRequire }).require;
    const electron = req?.('electron');
    const shell = electron?.shell;
    const trash = shell?.trashItem;
    if (typeof trash === 'function') {
      cachedTrash = (path: string) =>
        (shell as { trashItem: (p: string) => Promise<void> }).trashItem(path);
    }
  } catch {
    cachedTrash = null;
  }
  return cachedTrash;
}

/**
 * 把文件或目录送进系统回收站（fail-closed）。
 *
 * @param path  目标路径（文件或目录皆可）
 * @param trash 自定义回收站实现；缺省时优先用 `shell.trashItem`，否则回落 `nodeFallback`
 * @returns 路径不存在视为已删除（幂等成功，与原有 `{ force: true }` 语义一致）
 * @throws trashItem 失败时**原样抛出**，绝不回退物理删除
 */
export async function safeDelete(path: string, trash?: TrashFn): Promise<void> {
  const useTrash = trash ?? resolveTrash() ?? nodeFallback;
  // 先 stat：不存在 → 幂等成功（catch 吞掉）；存在 → 送回收站。
  // useTrash 抛错时**不**进 catch 物理删除——只吞「不存在」这一种。
  try {
    await stat(path);
  } catch {
    return; // 路径不存在：无事发生
  }
  await useTrash(path);
}
