/**
 * 工作区记忆的磁盘读写（Electron 主进程）。
 *
 * 路径解析与安全校验在 `electron/memoryRoutes.ts`（纯映射，可单测）；
 * 这里只做 fs 那一半：列目录 / 读 / 写 / 删 / 旧数据懒迁移。
 *
 * ## 为什么记忆必须由主进程写，而不能复用 `fs:writeTextFile`
 *
 * `resolveWriteTarget` 只放行 `home` / `userData` / `~/.nanowork` 三个根——
 * 这是**刻意的**：`fs:writeTextFile` 是给「导出用户可见文件」用的，不该成为
 * 往任意路径写文件的能力。工作区记忆的落点在 `<workdir>/.nanowork/memory/`，
 * 天然在三个根之外，所以它需要一条**专用且能力面更窄**的通道：
 * 只能写 `MEMORY.md` 与 `YYYY-MM-DD.md`，只能写在自己那个记忆目录里。
 *
 * 把这条通道与 `fs:writeTextFile` 分开，而不是放宽后者的白名单，是因为
 * 一旦放宽，「导出」这个动作就同时获得了「写进任意工作目录」的能力——
 * 而它只需要写一个文件到产品目录。
 *
 * ## 符号链接与特殊文件
 *
 * 读写前都用 `lstat`（**不跟随**链接）确认目标是普通文件：
 * `MEMORY.md` 若被替换成一个指向工作区外的链接，`writeFile` 会老老实实沿着
 * 链接写出去。读侧同理——读一个指向 `~/.ssh/id_rsa` 的链接会把私钥塞进 system
 * 提示词再发给模型。成本是一次 lstat，值得。
 *
 * ## 不 import electron
 *
 * 对齐 `credentialVault` / `pluginPackage` / `storageRoutes`：根目录由调用方传入，
 * vitest 可以直接拿真机临时目录覆盖。
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  dailyMemoryFileName,
  isMemoryFileName,
  isWritableMemoryFileName,
  sortMemoryFileNames,
} from '../src/lib/memory/workspaceMemory';
import {
  appendJsonlLine,
  isMemoryContentFileName,
  isMemoryFileName as isMemoryFileNameV2,
  isMemorySubdirName,
  isWritableMemoryEntryName,
  memoryEntryName,
  splitJsonlLines,
} from '../src/lib/memory/memoryPaths';
import {
  resolveLegacyMemoryFile,
  resolveMemoryFile,
  resolveMemoryFileIn,
  resolveMemoryListDir,
  resolveWorkspaceMemoryDir,
} from './memoryRoutes';
import type { StorageRoots } from './storageRoutes';

/** 记忆存储的根标识（与 `src/platform/types.ts` 的 `MemoryDirRef` 同形） */
export type MemoryDirRef =
  | { kind: 'workspace'; workdir: string | null }
  | { kind: 'user'; userScope: string };

/** 旧文件迁移后留下的后缀（保留备查；不会被再次当成记忆读入） */
export const LEGACY_ARCHIVE_SUFFIX = '.migrated';

/**
 * 列出工作区记忆目录里的记忆文件名（已按注入顺序排好）。
 *
 * 目录不存在返回空数组——「这个工作区还没有记忆」是正常状态，不是错误。
 * 注意**不创建目录**：只是读一下就凭空在工作区里留一个 `.nanowork/` 目录，
 * 会让每个被打开过的项目都多出一个空文件夹。
 */
export async function listMemoryFiles(
  workdir: string | null | undefined,
  roots: StorageRoots,
): Promise<string[]> {
  const dir = resolveWorkspaceMemoryDir(workdir, roots);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return sortMemoryFileNames(
    // `isFile()` 对符号链接为 false，故链接一并被排除（见文件头注释）
    entries.filter((entry) => entry.isFile() && isMemoryFileName(entry.name)).map((e) => e.name),
  );
}

/** 读取单个记忆文件；不存在 / 不是普通文件 / 读取失败一律返回 null */
export async function readMemoryFile(
  workdir: string | null | undefined,
  name: string,
  roots: StorageRoots,
): Promise<string | null> {
  const target = resolveMemoryFile(workdir, name, roots);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) return null;
    return await fs.readFile(target, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 写入单个记忆文件（覆盖写）。
 *
 * 只接受 `MEMORY.md` 与 `YYYY-MM-DD.md`：这个断言是**这条 IPC 的能力边界**，
 * 不是给调用方看的提示——它在非法名字上抛错，而不是静默降级成别的文件名。
 */
export async function writeMemoryFile(
  workdir: string | null | undefined,
  name: string,
  content: string,
  roots: StorageRoots,
): Promise<void> {
  if (!isWritableMemoryFileName(name)) {
    throw new Error(`不允许写入该记忆文件名：${String(name)}`);
  }
  const target = resolveMemoryFile(workdir, name, roots);
  await fs.mkdir(dirname(target), { recursive: true });
  const stat = await lstatOrNull(target);
  if (stat && !stat.isFile()) {
    throw new Error(`记忆文件位置已被非普通文件占用：${name}`);
  }
  await fs.writeFile(target, content ?? '', 'utf-8');
}

/** 删除单个记忆文件（幂等；不存在视为已删） */
export async function removeMemoryFile(
  workdir: string | null | undefined,
  name: string,
  roots: StorageRoots,
): Promise<void> {
  const target = resolveMemoryFile(workdir, name, roots);
  await fs.rm(target, { force: true });
}

/**
 * 清空某个工作区的全部记忆文件；返回删除个数。
 *
 * 只删 `.md`（即 `listMemoryFiles` 认得的那批），**不删目录本身**，也不动用户
 * 放在同目录下的其它文件——「清空记忆」不该顺带清理别人的目录。
 */
export async function clearMemoryFiles(
  workdir: string | null | undefined,
  roots: StorageRoots,
): Promise<number> {
  const dir = resolveWorkspaceMemoryDir(workdir, roots);
  const names = await listMemoryFiles(workdir, roots);
  await Promise.all(names.map((name) => fs.rm(join(dir, name), { force: true })));
  return names.length;
}

/**
 * 把旧单文件落点（`~/.nanowork/memory/<workspaceKey>.md`）的内容搬进新目录。
 *
 * 幂等条件「目录里已有记忆就跳过」承担两个职责：
 * 1. 同一进程里被调多次不会重复搬；
 * 2. **不覆盖用户在新目录里的后续编辑**——迁移是一次性动作，此后新旧两处
 *    各自演进，旧文件只作为留档。
 *
 * 搬到哪个文件名：按旧文件的**最后修改日期**归档成日期文件。旧文件是
 * 「精炼记忆 + 追加日志」混在一起的形态（那时只有一个文件），放进 `MEMORY.md`
 * 会把一堆带时间戳的日志块当成精炼记忆；按日子归档更贴近它的真实内容。
 *
 * 旧文件不删，改名为 `<key>.md.migrated` 留在原处：迁移逻辑一旦有偏差，
 * 用户手上还有原件。`.migrated` 不是 `.md`，所以不会被当成记忆读回来。
 *
 * @returns 本次新写入的文件名（没有可迁移的内容时为空数组）
 */
export async function migrateLegacyMemory(
  workdir: string | null | undefined,
  roots: StorageRoots,
): Promise<string[]> {
  const existing = await listMemoryFiles(workdir, roots);
  if (existing.length > 0) return [];

  const legacy = resolveLegacyMemoryFile(workdir, roots);
  let content: string;
  let at: Date;
  try {
    const stat = await fs.lstat(legacy);
    if (!stat.isFile()) return [];
    content = await fs.readFile(legacy, 'utf-8');
    at = stat.mtime;
  } catch {
    return [];
  }

  if (content.trim() !== '') {
    const name = dailyMemoryFileName(at);
    await writeMemoryFile(workdir, name, content.endsWith('\n') ? content : `${content}\n`, roots);
    await archiveLegacyFile(legacy);
    return [name];
  }

  // 空文件也留档：否则它会在每次启动时被重新检查一遍，永远悬在那里
  await archiveLegacyFile(legacy);
  return [];
}

/** 把旧文件改名为留档名（目标已存在时直接覆盖——它是同一份文件的上一轮留档） */
async function archiveLegacyFile(legacyPath: string): Promise<void> {
  const archive = `${legacyPath}${LEGACY_ARCHIVE_SUFFIX}`;
  try {
    await fs.rm(archive, { force: true });
    await fs.rename(legacyPath, archive);
  } catch {
    /* 留档失败不该让记忆整体不可用：新目录里的内容已经写好了 */
  }
}

/** `lstat` 的 null 版本（不存在返回 null；其它错误照抛） */
async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// —— 记忆 v2：两类存储根 + 子目录 + 原子替换 + JSONL 追行 ——
//
// 与上面 v1 那批函数的关系：v1 的函数签名是 `(workdir, name, roots)`，只能操作
// **一个工作区目录的根级文件**；下面这批是 `(dirRef, name, roots, subdir?)`，能到
// 用户级根与 `daily/`、`archive/` 子目录。两批共用同一套名字策略与同一条
// 「lstat 拒绝符号链接、路径必须落在记忆目录内」的安全口径。

/**
 * 列出某个记忆目录（v2）里的文件名。
 *
 * 与 v1 的 `listMemoryFiles` 的差别只有两处：支持子目录；读取宽但**排除产品文件**
 * （`index.json` 是旧工作区索引、`.migrated` 是留档）——否则它们会被当成记忆内容
 * 注入 prompt。
 */
export async function listMemoryFilesIn(
  dirRef: MemoryDirRef,
  roots: StorageRoots,
  subdir?: string,
): Promise<string[]> {
  const dir = resolveMemoryListDir(dirRef, roots, subdir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    // `isFile()` 对符号链接为 false，故链接一并被排除（见文件头注释）
    .filter((entry) => entry.isFile() && isMemoryFileNameV2(entry.name))
    .map((entry) => entry.name)
    .filter((name) => (subdir ? true : isMemoryContentFileName(name)));
  return sortMemoryFileNames(names);
}

/** 读取单个记忆文件（v2）；不存在 / 不是普通文件 / 读取失败一律返回 null */
export async function readMemoryFileIn(
  dirRef: MemoryDirRef,
  name: string,
  roots: StorageRoots,
  subdir?: string,
): Promise<string | null> {
  const target = resolveMemoryFileIn(dirRef, name, roots, subdir);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) return null;
    return await fs.readFile(target, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 覆盖写入单个记忆文件（v2，**非原子**）。
 *
 * 用于「可重建的派生视图」（`MEMORY.md` / `user.md`）与用户显式编辑——它们被读到半截
 * 只影响一次展示。canonical 状态（`curated.json` / `conflicts.json` / `profile.json` /
 * `preferences.json`）必须用 `replaceMemoryFileIn`。
 */
export async function writeMemoryFileIn(
  dirRef: MemoryDirRef,
  name: string,
  content: string,
  roots: StorageRoots,
  subdir?: string,
): Promise<void> {
  const entry = memoryEntryName(name, subdir);
  if (!isWritableMemoryEntryName(entry)) {
    throw new Error(`不允许写入该记忆文件：${entry}`);
  }
  const target = resolveMemoryFileIn(dirRef, name, roots, subdir);
  await fs.mkdir(dirname(target), { recursive: true });
  const stat = await lstatOrNull(target);
  if (stat && !stat.isFile()) {
    throw new Error(`记忆文件位置已被非普通文件占用：${entry}`);
  }
  await fs.writeFile(target, content ?? '', 'utf-8');
}

/** 删除单个记忆文件（v2，幂等；不存在视为已删） */
export async function removeMemoryFileIn(
  dirRef: MemoryDirRef,
  name: string,
  roots: StorageRoots,
  subdir?: string,
): Promise<void> {
  const target = resolveMemoryFileIn(dirRef, name, roots, subdir);
  await fs.rm(target, { force: true });
}

/** 原子替换的重试参数：Windows 上目标被占用时 `rename` 会抛 EPERM/EBUSY */
const REPLACE_RETRY_DELAYS_MS = [0, 20, 50, 120];

/**
 * **原子替换**一个记忆文件：写同目录临时文件 → 落盘 → `rename` 覆盖目标。
 *
 * ## 为什么必须是同目录临时文件
 *
 * `rename` 的原子性只在**同一卷**上成立。把临时文件写到系统 temp 目录再 rename，跨卷时
 * 会退化成「复制 + 删除」，中途失败就留下半个目标文件——那正是本函数要避免的。
 *
 * ## 为什么带重试
 *
 * Windows 上 `fs.rename` 覆盖一个**正被其他进程打开**的目标会抛 `EPERM` / `EBUSY`
 * （POSIX 不会）。这不是理论问题：记忆页、注入路径与会话结束的沉淀可能并发读同一份
 * `curated.json`。重试几次即可覆盖绝大多数瞬时占用。**最终失败时删掉临时文件、保留
 * 旧版本**——这是本函数的契约（「失败时旧版本保持不变」）。
 *
 * ## 不承诺什么
 *
 * 不做目录项 `fsync`（Windows 不可移植），因此**不承诺断电级持久性**；只承诺
 * 「不暴露半写状态」。Web 端没有临时文件，退化为一次 set（best-effort，见 NFR-M9）。
 */
export async function replaceMemoryFileIn(
  dirRef: MemoryDirRef,
  name: string,
  content: string,
  roots: StorageRoots,
  subdir?: string,
): Promise<void> {
  const entry = memoryEntryName(name, subdir);
  if (!isWritableMemoryEntryName(entry)) {
    throw new Error(`不允许写入该记忆文件：${entry}`);
  }
  const target = resolveMemoryFileIn(dirRef, name, roots, subdir);
  await fs.mkdir(dirname(target), { recursive: true });
  const stat = await lstatOrNull(target);
  if (stat && !stat.isFile()) {
    throw new Error(`记忆文件位置已被非普通文件占用：${entry}`);
  }

  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content ?? '', 'utf-8');
    let lastErr: unknown = null;
    for (const delay of REPLACE_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        await fs.rename(tmp, target);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`替换记忆文件失败：${entry}`);
  } catch (err) {
    // 清理临时文件失败不该掩盖真正的错误（调用方要看的是替换失败的原因）
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 单行追加（v2）：`O_APPEND` 语义，读-改-写**不是**这里的行为 */
export async function appendMemoryFileLine(
  dirRef: MemoryDirRef,
  name: string,
  line: string,
  roots: StorageRoots,
  subdir?: string,
): Promise<void> {
  const entry = memoryEntryName(name, subdir);
  if (!isWritableMemoryEntryName(entry)) {
    throw new Error(`不允许追加该记忆文件：${entry}`);
  }
  const target = resolveMemoryFileIn(dirRef, name, roots, subdir);
  await fs.mkdir(dirname(target), { recursive: true });
  const stat = await lstatOrNull(target);
  if (stat && !stat.isFile()) {
    throw new Error(`记忆文件位置已被非普通文件占用：${entry}`);
  }
  // 单次 write 追加，不读全文——这是 append-only 日志的要点（设计 §4.2）
  await fs.appendFile(target, appendJsonlLine('', line), 'utf-8');
}

/** 读取整份 JSONL（v2）；不存在返回空数组 */
export async function readMemoryFileLines(
  dirRef: MemoryDirRef,
  name: string,
  roots: StorageRoots,
  subdir?: string,
): Promise<string[]> {
  const target = resolveMemoryFileIn(dirRef, name, roots, subdir);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) return [];
    return splitJsonlLines(await fs.readFile(target, 'utf-8'));
  } catch {
    return [];
  }
}

/** 子目录名合法性（导出给 IPC 层做前置校验，避免把非法值传进路径拼接） */
export { isMemorySubdirName };
