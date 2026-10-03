import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  CURATED_MEMORY_FILE,
  WORKSPACE_MEMORY_DIR,
  WORKSPACE_MEMORY_SUBDIR,
  isMemoryFileName,
} from '../src/lib/workspaceMemory';
import {
  READABLE_SUBDIRS,
  USER_MEMORY_DIR,
  isMemoryFileName as isMemoryFileNameV2,
  isMemorySubdirName,
  scopeIdFor,
} from '../src/lib/memoryPaths';
import { DEFAULT_WORKSPACE_KEY, workspaceKeyFor } from '../src/lib/workspaceKey';
import { memoryDir, productDir, type StorageRoots } from './storageRoutes';

/**
 * 工作区记忆的**路径解析与安全校验**（主进程专用，纯映射、不碰 fs）。
 *
 * ## 落点
 *
 * | 情形 | 目录 |
 * |---|---|
 * | 会话绑定了工作目录 | `<workdir>/.nanowork/memory/` |
 * | 没有工作目录（IM 会话、存储设置之前建的旧会话） | `~/.nanowork/memory/default/` |
 *
 * 与 WorkBuddy 的 `.workbuddy/memory/` 同构：**记忆跟着工作区走**。用户把项目
 * 目录拷到另一台机器，记忆跟着过去；反过来说，「这个工作区的记忆在哪」这个
 * 问题有了一个可以自己找到的答案，而不是要去产品目录里按哈希名猜。
 *
 * 兜底情形刻意仍留在产品目录：没有工作目录就没有「跟着走」的载体，
 * 硬折算到默认工作空间会让它和真正绑定那个目录的会话**共用一份记忆**。
 *
 * ## 这一层为什么必须存在
 *
 * 渲染层的 `isMemoryFileName` 是**一致性校验**（让界面列出的文件名与磁盘上的
 * 一致），不是安全边界——`window.electronAPI.memoryWriteFile` 是渲染层可达的
 * IPC，一个被注入的脚本可以直接调它。所以真正的把关在这里：文件名过白名单，
 * 且最终路径必须**逐字符等于** `<记忆目录>/<文件名>`。
 *
 * 本模块**不 import electron**，因而可被单测直接覆盖。
 */

/** 旧落点所在的目录名：`~/.nanowork/memory/`（迁移来源，不再写入） */
export const LEGACY_MEMORY_DIR_NAME = 'memory';

/** 无工作目录时的兜底记忆目录：`~/.nanowork/memory/default/` */
export function fallbackMemoryDir(roots: StorageRoots): string {
  return join(memoryDir(roots), DEFAULT_WORKSPACE_KEY);
}

/**
 * 工作目录 → 记忆目录的绝对路径。
 *
 * 非绝对路径**按「没有工作目录」处理**，而不是抛错：`session.workdir` 的来源是
 * 目录选择器或主进程的 `path.join`，本该永远是绝对路径；真收到相对路径说明上游
 * 有 bug，但此时「记忆整体不可用」比「记忆落到进程 cwd 下的一个意外目录」更难
 * 排查——前者至少是稳定的、可解释的行为。
 */
export function resolveWorkspaceMemoryDir(
  workdir: string | null | undefined,
  roots: StorageRoots,
): string {
  const raw = (workdir ?? '').trim();
  if (raw === '' || raw.includes('\0')) return fallbackMemoryDir(roots);
  if (!isAbsolute(raw)) return fallbackMemoryDir(roots);
  return join(resolve(raw), WORKSPACE_MEMORY_DIR, WORKSPACE_MEMORY_SUBDIR);
}

/**
 * 旧落点文件：`~/.nanowork/memory/<workspaceKey>.md`（`workspaceKeyFor` 推导）。
 *
 * 懒迁移要读它、迁移后要把它改名成 `.migrated` 留档，两处都需要这条路径。
 */
export function resolveLegacyMemoryFile(
  workdir: string | null | undefined,
  roots: StorageRoots,
): string {
  return join(memoryDir(roots), `${workspaceKeyFor(workdir)}.md`);
}

/**
 * 记忆文件的绝对路径；名字非法或解析结果越界一律**抛错**。
 *
 * 抛错而不是返回 null：调用方（IPC handler）本来就要把失败传达给渲染层，
 * 一个「静默返回空串」的实现会让「文件名写错」表现成「记忆是空的」。
 */
export function resolveMemoryFile(
  workdir: string | null | undefined,
  name: string,
  roots: StorageRoots,
): string {
  if (!isMemoryFileName(name)) {
    throw new Error(`非法记忆文件名：${String(name)}`);
  }
  const dir = resolveWorkspaceMemoryDir(workdir, roots);
  const target = join(dir, name);
  // 双保险：`isMemoryFileName` 已经排除了分隔符，这里再断言一次「解析结果确实
  // 是该目录的直接子文件」。加它是因为前一道校验的规则将来可能被放宽
  // （比如允许子目录分组），而那正是穿越漏洞最容易被引入的时刻。
  if (resolve(target) !== resolve(dir, name)) {
    throw new Error(`记忆文件越界：${String(name)}`);
  }
  return target;
}

/** 精炼记忆文件的绝对路径（记忆页默认编辑目标） */
export function resolveCuratedMemoryFile(
  workdir: string | null | undefined,
  roots: StorageRoots,
): string {
  return resolveMemoryFile(workdir, CURATED_MEMORY_FILE, roots);
}

/**
 * 写入用的文件名白名单（`MEMORY.md` / 日期文件）。
 *
 * **实现在 `src/lib/workspaceMemory.ts`**，这里只做转出：Web 端有同一条边界，
 * 而 Web 端 import 不到主进程（那是 `node:path` 世界）。两端共用一个判据，
 * 才不会出现「界面上能存、Electron 上存不了」这类只在某一端复现的差异。
 */
export { isWritableMemoryFileName } from '../src/lib/workspaceMemory';

// —— 记忆 v2 的路径解析（两类存储根 + 子目录） ——

/**
 * 用户级记忆的目录：`~/.nanowork/user-memory/<scope-id>/`。
 *
 * 刻意不落在 `~/.nanowork/MEMORY.md`（那是 v1 的单文件，**必须原地保留**：
 * 它是跨端同步资产，改名会在其他设备上删除用户记忆，见设计 §9 / NFR-M11）。
 */
export function userMemoryDir(userScope: string, roots: StorageRoots): string {
  return join(productDir(roots), USER_MEMORY_DIR, scopeIdFor(userScope));
}

/** 记忆 v2 的存储根目录（`MemoryDirRef` 的两种情形） */
export function resolveMemoryRootDir(
  dirRef: { kind: 'workspace'; workdir: string | null } | { kind: 'user'; userScope: string },
  roots: StorageRoots,
): string {
  if (dirRef !== null && typeof dirRef === 'object' && dirRef.kind === 'user') {
    return userMemoryDir(dirRef.userScope ?? '', roots);
  }
  const workdir =
    dirRef !== null && typeof dirRef === 'object' && 'workdir' in dirRef
      ? (dirRef.workdir ?? null)
      : null;
  return resolveWorkspaceMemoryDir(workdir, roots);
}

/**
 * 断言 `target` 确实落在 `base` 之内（含 base 自身）。
 *
 * 用 `sep` 收尾比较而不是裸 `startsWith`：后者会让 `/a/memory-evil` 通过
 * 「前缀是 `/a/memory`」这一检查——差一个分隔符就是一次越界写。
 */
function assertInside(base: string, target: string): void {
  const b = resolve(base);
  const t = resolve(target);
  if (t === b) return;
  if (t.startsWith(b.endsWith(sep) ? b : `${b}${sep}`)) return;
  throw new Error(`记忆路径越界：${target}`);
}

/**
 * 记忆文件（v2）的绝对路径；名字或子目录非法、解析结果越界一律**抛错**。
 *
 * 与 v1 的 `resolveMemoryFile` 的差别：多了 `subdir`（只允许 `daily/` 与 `archive/`）。
 * 抛错而不是返回 null 的理由同 v1：一个「静默返回空串」的实现会让「文件名写错」
 * 表现成「记忆是空的」。
 */
export function resolveMemoryFileIn(
  dirRef: { kind: 'workspace'; workdir: string | null } | { kind: 'user'; userScope: string },
  name: string,
  roots: StorageRoots,
  subdir?: string,
): string {
  const sub = (subdir ?? '').trim();
  if (sub !== '') {
    if (!isMemorySubdirName(sub) || !READABLE_SUBDIRS.includes(sub)) {
      throw new Error(`非法记忆子目录：${sub}`);
    }
  }
  if (!isMemoryFileNameV2(name)) {
    throw new Error(`非法记忆文件名：${String(name)}`);
  }
  const rootDir = resolveMemoryRootDir(dirRef, roots);
  const dir = sub === '' ? rootDir : join(rootDir, sub);
  const target = join(dir, name);
  // 双保险：名字与子目录都已经过白名单，这里再断言一次「解析结果确实落在根之内」。
  // 加它是因为前一道校验的规则将来可能被放宽（比如允许更多子目录），
  // 而那正是穿越漏洞最容易被引入的时刻。
  assertInside(rootDir, target);
  return target;
}

/** 记忆目录（v2）本身的绝对路径（列表 / 清空用）；子目录非法时抛错 */
export function resolveMemoryListDir(
  dirRef: { kind: 'workspace'; workdir: string | null } | { kind: 'user'; userScope: string },
  roots: StorageRoots,
  subdir?: string,
): string {
  const sub = (subdir ?? '').trim();
  const rootDir = resolveMemoryRootDir(dirRef, roots);
  if (sub === '') return rootDir;
  if (!isMemorySubdirName(sub) || !READABLE_SUBDIRS.includes(sub)) {
    throw new Error(`非法记忆子目录：${sub}`);
  }
  const dir = join(rootDir, sub);
  assertInside(rootDir, dir);
  return dir;
}

/** 产品目录名（v2 导入检查用；与 `storageRoutes` 的 `PRODUCT_DIR_NAME` 同值） */
export { WORKSPACE_MEMORY_DIR as MEMORY_PRODUCT_DIR_NAME };
