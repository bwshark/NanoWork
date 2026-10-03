/**
 * 渲染层到 `MemoryStore` 的**适配器**与**用户作用域**的本地来源。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M4 / FR-M4a / FR-M24；设计：`docs/architecture-memory-v2.md` §4.7.0 / §5。
 *
 * ## 这一层解决两件事
 *
 * 1. **把平台能力包成仓储端口**：`platform.memoryDirs` 的名字是 `dirRef + name + subdir`
 *    三段式，而 `MemoryStoreIo` 是「已经把根定好」的一段式（`name + subdir`）。适配器
 *    把根闭包进去，于是仓储代码不需要知道自己是工作区级还是用户级。
 * 2. **产生 `userScope`**：全仓没有这个标识（唯一的用户身份是云端登录态，未登录是空串）。
 *    把记忆目录挂在登录态上会得到「未登录没有记忆 / 登录后记忆不可读」，所以它必须
 *    **与账户解耦**、本机首次使用时生成并持久化（见下）。
 *
 * ## `userScope` 的三条规则
 *
 * | 规则 | 内容 |
 * |---|---|
 * | 生成 | 首次需要用户级记忆时生成 `u_<12hex>`，存进 `localStorage`（**不进 `settings.json`**，理由见下） |
 * | 账户绑定 | 登录**只做绑定映射**，不换目录、不迁数据。这样登录/登出永远不会让本地记忆变成不可读 |
 * | 校验 | canonical JSON 内保存同一个 `userScope`，读取不匹配即拒绝（发现错误复制或调用方传错用户） |
 *
 * 为什么存 `localStorage` 而不是 `settings.json`：`Settings` 会经同步上行、也会被
 * 「镜像进引擎 config」。`userScope` 是**本机身份**，上行会让两台设备抢同一个目录名，
 * 而它进了引擎配置则完全没有读者——两者都是纯负担。`localStorage` 的语义正好是
 * 「这台设备上的这个浏览器/客户端」。
 */

import { platform } from '@/platform';
import type { MemoryDirRef } from '@/platform/types';
import type { MemoryStoreIo } from '@/lib/memoryStore';
import { scopeIdFor } from '@/lib/memoryPaths';
import { hashContent } from '@/lib/workspaceKey';

/** 本地用户作用域的存储 key（**刻意不进 `settings.json`**，见文件头注释） */
export const LOCAL_MEMORY_SCOPE_KEY = 'nanowork.memoryScope';

/** 是否长得像一个由本模块生成的 scope（防手工塞进来的任意串） */
export function isLocalMemoryScope(value: unknown): value is string {
  return typeof value === 'string' && /^u_[0-9a-f]{8,32}$/.test(value);
}

/**
 * 生成一个新的本地用户作用域。
 *
 * 形态 `u_<12hex>`：与 `scopeIdFor()` 产出的目录名（`u_<hash8>`）**不同**——那个是
 * 目录名（由 scope 推出），这个是 scope 本身。两者都带 `u_` 前缀是刻意的：一眼能看出
 * 「这是本地用户身份」而不是工作区标识（`w_...`）或事实 id（`f_...`）。
 */
export function generateLocalMemoryScope(): string {
  const seed = [
    globalThis.crypto?.randomUUID?.() ?? '',
    String(Date.now()),
    String(Math.random()),
  ].join('\u0000');
  return `u_${hashContent(seed)}${hashContent(`${seed}\u0000salt`).slice(0, 4)}`.slice(0, 14);
}

/**
 * 取本机的用户作用域；**不存在则生成并持久化**（幂等）。
 *
 * 读失败（隐私模式、配额）时**不抛错**：退回一个进程内稳定的临时 scope，
 * 让本次会话仍可用。代价是「这次会话的用户级记忆下次读不到」，但这比「功能整个不可用」
 * 好，且失败本身由 `console` 之外无处可报——故只在返回值上体现（调用方可记日志）。
 */
export async function ensureLocalMemoryScope(): Promise<string> {
  try {
    const existing = await platform.storage.get<string>(LOCAL_MEMORY_SCOPE_KEY);
    if (isLocalMemoryScope(existing)) return existing;
    const created = generateLocalMemoryScope();
    await platform.storage.set(LOCAL_MEMORY_SCOPE_KEY, created);
    return created;
  } catch {
    return ephemeralScope();
  }
}

/** 进程内稳定的兜底 scope（存储不可用时用） */
let ephemeral: string | null = null;
function ephemeralScope(): string {
  if (!ephemeral) ephemeral = generateLocalMemoryScope();
  return ephemeral;
}

// —— 仓储端口 ——

/**
 * 把 `platform.memoryDirs` 的一个**存储根**包成 `MemoryStoreIo`。
 *
 * 端点做两件平台相关的事：
 * - `replace` 走原子替换（canonical 状态必须）；`write` 走普通覆盖（派生视图用）；
 * - 所有调用都带同一个 `dirRef`，越界与白名单由主进程再校验一次（渲染层的校验只是
 *   一致性，不是安全边界）。
 */
export function platformMemoryIo(dirRef: MemoryDirRef): MemoryStoreIo {
  const dirs = platform.memoryDirs;
  return {
    list: (subdir) => dirs.listDir(dirRef, subdir),
    read: (name, subdir) => dirs.readDirFile(dirRef, name, subdir),
    replace: (name, content, subdir) => dirs.replaceDirFile(dirRef, name, content, subdir),
    write: (name, content, subdir) => dirs.writeDirFile(dirRef, name, content, subdir),
    appendLine: (name, line, subdir) => dirs.appendDirLine(dirRef, name, line, subdir),
    readLines: (name, subdir) => dirs.readDirLines(dirRef, name, subdir),
    remove: (name, subdir) => dirs.removeDirFile(dirRef, name, subdir),
  };
}

/** 工作区级存储根 */
export function workspaceMemoryRef(workdir: string | null): MemoryDirRef {
  return { kind: 'workspace', workdir };
}

/** 用户级存储根 */
export function userMemoryRef(userScope: string): MemoryDirRef {
  return { kind: 'user', userScope };
}

/**
 * 记忆目录的**展示路径**（记忆页要如实告诉用户「存在哪」）。
 *
 * 与 `MemoryService` 的 `memoryDiskPath` 同口径，但支持用户级目录形态。
 * 走 `memoryDirDisplayPath` 而不是自己拼，避免两端各拼一个不同形态。
 */
export { memoryDirDisplayPath } from '@/lib/memoryPaths';

/** `scopeIdFor` 的转出（记忆页展示用户级目录名用） */
export { scopeIdFor };
