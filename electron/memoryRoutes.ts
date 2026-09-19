import { isAbsolute, join, resolve } from 'node:path';
import {
  CURATED_MEMORY_FILE,
  WORKSPACE_MEMORY_DIR,
  WORKSPACE_MEMORY_SUBDIR,
  isMemoryFileName,
} from '../src/lib/workspaceMemory';
import { DEFAULT_WORKSPACE_KEY, workspaceKeyFor } from '../src/lib/workspaceKey';
import { memoryDir, type StorageRoots } from './storageRoutes';

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
