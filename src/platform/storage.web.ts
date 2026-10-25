import {
  dailyMemoryFileName,
  isMemoryFileName,
  isWritableMemoryFileName,
  sortMemoryFileNames,
} from '@/lib/memory/workspaceMemory';
import {
  appendJsonlLine,
  CURATED_MEMORY_FILE,
  isMemoryContentFileName,
  isMemoryEntryName,
  isMemoryFileName as isMemoryFileNameV2,
  isWritableMemoryEntryName,
  memoryEntryName,
  splitJsonlLines,
  webMemoryDirKey,
} from '@/lib/memory/memoryPaths';
import { workspaceKeyFor } from '@/lib/workspace/workspaceKey';
import { MEMORY_KEY_PREFIX } from '@/lib/core/constants';
import type { ArtifactIndexEntry } from '@/types';
import type {
  ArtifactIndexFiles,
  FileBackup,
  MemoryDirFiles,
  MemoryDirRef,
  StorageAdapter,
  WorkspaceMemoryFiles,
} from './types';

/**
 * Web 存储适配器：使用浏览器 localStorage。
 * 所有值以 JSON 序列化存储，读取失败安全降级为 null。
 */
export class WebStorageAdapter implements StorageAdapter {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    window.localStorage.setItem(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    window.localStorage.removeItem(key);
  }

  async clear(): Promise<void> {
    window.localStorage.clear();
  }

  /** Web 端无法直接扫描本地文件系统，返回空数组 */
  async loadUserSkills(_workspace?: string) {
    return [];
  }
}

/**
 * 工作区记忆「目录」在 localStorage 里的 key 前缀。
 *
 * 刻意与 `MEMORY_KEY_PREFIX`（`nanowork.memory.`）不同：后者是**旧**单文件形态的
 * 键，前缀相同时新键会被旧键的前缀匹配吃掉（迁移判断会误以为「旧数据还在」）。
 */
export const WORKSPACE_MEMORY_STORAGE_PREFIX = 'nanowork.wsmem.';

/** 某个工作区在 localStorage 里的「目录」key */
function memoryDirKey(workdir: string | null): string {
  return `${WORKSPACE_MEMORY_STORAGE_PREFIX}${workspaceKeyFor(workdir)}`;
}

/** 读出整个「目录」（`{ 文件名: 正文 }`）；解析失败当成空目录 */
function readMemoryDir(workdir: string | null): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(memoryDirKey(workdir));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const dir: Record<string, string> = {};
    for (const [name, content] of Object.entries(parsed as Record<string, unknown>)) {
      if (isMemoryFileName(name) && typeof content === 'string') dir[name] = content;
    }
    return dir;
  } catch {
    return {};
  }
}

/** 写回整个「目录」；目录空了就把 key 删掉，不留一个 `{}` 孤儿 */
function writeMemoryDir(workdir: string | null, dir: Record<string, string>): void {
  const key = memoryDirKey(workdir);
  if (Object.keys(dir).length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(dir));
}

// —— 记忆 v2 的 localStorage 面（`nanowork.mem2.*`，见 WebMemoryDirFiles 的类头注释） ——

/** 读出 v2 记忆目录映射（键是**带子目录的相对名**，如 `daily/2026-09-19.jsonl`） */
function readMemoryDirV2(dirRef: MemoryDirRef): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(webMemoryDirKey(dirRef));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const dir: Record<string, string> = {};
    for (const [entry, content] of Object.entries(parsed as Record<string, unknown>)) {
      if (isMemoryEntryName(entry) && typeof content === 'string') dir[entry] = content;
    }
    return dir;
  } catch {
    return {};
  }
}

/** 写回 v2 记忆目录映射；空了就删 key（不留 `{}` 孤儿） */
function writeMemoryDirV2(dirRef: MemoryDirRef, dir: Record<string, string>): void {
  const key = webMemoryDirKey(dirRef);
  if (Object.keys(dir).length === 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(dir));
}

/**
 * 精炼记忆（`MEMORY.md`）的**唯一物理落点**：v2 的目录存储（`nanowork.mem2.*`）。
 *
 * ## 为什么要有这条「转发」
 *
 * Web 端把同一个记忆目录拆成两个 localStorage key（v1 `nanowork.wsmem.*` /
 * v2 `nanowork.mem2.*`，理由见 `WebMemoryDirFiles` 的类头注释）。拆开之后
 * **`MEMORY.md` 被两边同时认领**：
 * - 保存路径走 v2（`applyManualMemoryEdit` → `platform.memoryDirs`，投影由 `distill` 重写）；
 * - 而 v1 的读路径（`MemoryService.readFile` / `loadForInjection`）仍从 `nanowork.wsmem.*` 取。
 *
 * 于是保存后 v1 面读回来是**上一版**。实测症状：手编保存 → toast 说已登记，投影也写对了，
 * 但文件编辑器显示空、注入的 legacy 段落也是旧内容（v2 键里有 `MEMORY.md`，v1 键根本不存在）。
 * Electron 端两套能力落在**同一个真实目录**，所以这条裂缝只在 Web 暴露。
 *
 * 处置：把 `MEMORY.md` 收敛到 v2 一侧，v1 面对它**转发**；日期 `.md` 文件仍然留在 v1，
 * 两者的物理落点因此各自唯一。
 */
function readCuratedProjectionText(workdir: string | null): string | null {
  const ref: MemoryDirRef = { kind: 'workspace', workdir };
  const v2 = readMemoryDirV2(ref);
  if (Object.prototype.hasOwnProperty.call(v2, CURATED_MEMORY_FILE)) {
    return v2[CURATED_MEMORY_FILE];
  }
  // 读宽回落：v2 之前写入的 `MEMORY.md` 只存在于 v1 键里。只读回落，下一次写入即迁到 v2。
  const v1 = readMemoryDir(workdir);
  return Object.prototype.hasOwnProperty.call(v1, CURATED_MEMORY_FILE)
    ? v1[CURATED_MEMORY_FILE]
    : null;
}

/** 把 `MEMORY.md` 写进/删除出 v2 侧；若 v1 侧还残留同一份，一并清掉（同一个文件不留两处） */
function writeCuratedProjectionText(workdir: string | null, content: string | null): void {
  const ref: MemoryDirRef = { kind: 'workspace', workdir };
  const v2 = readMemoryDirV2(ref);
  if (content === null) delete v2[CURATED_MEMORY_FILE];
  else v2[CURATED_MEMORY_FILE] = content;
  writeMemoryDirV2(ref, v2);

  const v1 = readMemoryDir(workdir);
  if (Object.prototype.hasOwnProperty.call(v1, CURATED_MEMORY_FILE)) {
    delete v1[CURATED_MEMORY_FILE];
    writeMemoryDir(workdir, v1);
  }
}

/**
 * Web 端的工作区记忆后端：用**一个 localStorage key 装整个目录**
 * （值是 `{ 文件名: 正文 }`）。
 *
 * 为什么不一个文件一个 key：枚举是这一层的核心操作（读取要合并全部文件、
 * 记忆页要列出全部文件），一个 key 一个文件就必须再维护一份文件名索引，
 * 而两份数据的一致性没有任何东西保证——索引与内容对不上时，症状是
 * 「界面上有这个文件、点进去是空的」。
 *
 * 落点语义与 Electron 端**刻意保持一致**（同名的日期文件、同样的排序与合并），
 * 差异只在「没有文件系统，所以没有真实路径」这一点上，由 `memoryDiskPath`
 * 如实告知用户。
 */
export class WebWorkspaceMemoryFiles implements WorkspaceMemoryFiles {
  list(workdir: string | null): Promise<string[]> {
    const names = new Set(Object.keys(readMemoryDir(workdir)));
    // `MEMORY.md` 的权威落点在 v2 一侧（见 `readCuratedProjectionText`），列目录要把它带上
    if (readCuratedProjectionText(workdir) !== null) names.add(CURATED_MEMORY_FILE);
    return Promise.resolve(sortMemoryFileNames([...names]));
  }

  read(workdir: string | null, name: string): Promise<string | null> {
    if (!isMemoryFileName(name)) return Promise.resolve(null);
    if (name === CURATED_MEMORY_FILE) {
      return Promise.resolve(readCuratedProjectionText(workdir));
    }
    const dir = readMemoryDir(workdir);
    return Promise.resolve(Object.prototype.hasOwnProperty.call(dir, name) ? dir[name] : null);
  }

  write(workdir: string | null, name: string, content: string): Promise<void> {
    // 与主进程同一条能力边界：Web 端也不允许应用发明文件名
    if (!isWritableMemoryFileName(name)) {
      return Promise.reject(new Error(`不允许写入该记忆文件名：${String(name)}`));
    }
    if (name === CURATED_MEMORY_FILE) {
      writeCuratedProjectionText(workdir, content ?? '');
      return Promise.resolve();
    }
    const dir = readMemoryDir(workdir);
    dir[name] = content ?? '';
    writeMemoryDir(workdir, dir);
    return Promise.resolve();
  }

  remove(workdir: string | null, name: string): Promise<void> {
    if (!isMemoryFileName(name)) return Promise.resolve();
    if (name === CURATED_MEMORY_FILE) {
      writeCuratedProjectionText(workdir, null);
      return Promise.resolve();
    }
    const dir = readMemoryDir(workdir);
    if (!Object.prototype.hasOwnProperty.call(dir, name)) return Promise.resolve();
    delete dir[name];
    writeMemoryDir(workdir, dir);
    return Promise.resolve();
  }

  removeAll(workdir: string | null): Promise<number> {
    // 计数把 v2 侧的 `MEMORY.md` 算上：用户点「清空」在意的是「清掉了几份」，
    // 少算一份会让人以为漏清了
    const hasCurated = readCuratedProjectionText(workdir) !== null;
    const count = Object.keys(readMemoryDir(workdir)).length + (hasCurated ? 1 : 0);
    writeMemoryDir(workdir, {});
    writeCuratedProjectionText(workdir, null);
    return Promise.resolve(count);
  }

  /**
   * 旧单文件记忆（`nanowork.memory.<key>` 里的一整段字符串）搬进新「目录」。
   *
   * 与 Electron 端的一处差异：浏览器里拿不到文件的最后修改时间，故按**今天**
   * 归档而不是「旧内容的最后修改日」。Web 端的 localStorage 本就与浏览器配置
   * 同生命周期，回溯精度不值得为它引入额外的元数据存储。
   */
  migrateLegacy(workdir: string | null): Promise<string[]> {
    if (Object.keys(readMemoryDir(workdir)).length > 0) return Promise.resolve([]);
    let legacy: string;
    try {
      const raw = window.localStorage.getItem(`${MEMORY_KEY_PREFIX}${workspaceKeyFor(workdir)}`);
      if (raw === null) return Promise.resolve([]);
      const parsed: unknown = JSON.parse(raw);
      legacy = typeof parsed === 'string' ? parsed : '';
    } catch {
      return Promise.resolve([]);
    }
    if (legacy.trim() === '') return Promise.resolve([]);
    const name = dailyMemoryFileName();
    const dir = readMemoryDir(workdir);
    dir[name] = legacy.endsWith('\n') ? legacy : `${legacy}\n`;
    writeMemoryDir(workdir, dir);
    window.localStorage.removeItem(`${MEMORY_KEY_PREFIX}${workspaceKeyFor(workdir)}`);
    return Promise.resolve([name]);
  }
}

/**
 * Web 端的记忆 v2 目录后端（**子目录 + canonical JSON / JSONL**）。
 *
 * ## 与 `WebWorkspaceMemoryFiles`（v1）的关系
 *
 * 同一个物理「记忆目录」在 Web 端由**两个 localStorage key** 承担：
 * v1 的 `nanowork.wsmem.<key>` 存 `{ 文件名: 正文 }`（日期 `.md`），
 * v2 的 `nanowork.mem2.<…>` 存**带子目录的相对名**（`{ 'daily/2026-09-19.jsonl': … }`）。
 *
 * ⚠️ **`MEMORY.md` 不在这条划分里**：它两边都认领，只落一处会读不到（2026-10-03 修）。
 * 权威落点是**本类这一侧**（v2），v1 面对它转发——见 `readCuratedProjectionText` 的注释。
 *
 * 为什么不合并成一个 key：v1 的 `readMemoryDir` 用 `isMemoryFileName` 过滤，带 `/` 的
 * 名字会被静默丢掉，于是 v2 的事实日志在 Web 端永远读不到；而改那个过滤器就要动
 * v1 的既有测试（`tests/electron/workspaceMemoryStore.test.ts` 一族的 Web 对应物）。
 * 分开之后两面各自完整，与 Electron 端「同一目录里既有 legacy `.md` 又有新 JSON」
 * 的形态是一致的。
 *
 * ## 如实说明三条降级（NFR-M9）
 *
 * 1. `appendDirLine` 没有追加语义：只能「读整份映射 → 改 → 写回」；
 * 2. 同理 `replaceDirFile` 是读-改-写，**多标签页会丢更新**；
 * 3. 没有 `fsync` 级崩溃安全，`NFR-M5` 的八个写入边界在 Web 端**不可验证**。
 * 因此 Web 端的语义是「结构化记忆可用，原子性与崩溃恢复为 best-effort」。
 */
export class WebMemoryDirFiles implements MemoryDirFiles {
  listDir(dirRef: MemoryDirRef, subdir?: string): Promise<string[]> {
    const dir = readMemoryDirV2(dirRef);
    const prefix = subdir ? `${subdir}/` : '';
    const names = Object.keys(dir)
      .filter((entry) =>
        prefix === ''
          ? !entry.includes('/') && isMemoryContentFileName(entry)
          : entry.startsWith(prefix),
      )
      .map((entry) => (prefix === '' ? entry : entry.slice(prefix.length)))
      // ⚠️ 这里必须用 **v2** 的文件名判据：v1 的 `isMemoryFileName` 只认 `.md`，
      // 用它过滤会让 `daily/*.jsonl` 永远列不出来（症状是「事实写进去了，读回来 0 条」，
      // 而 appendLine/read 都正常——实施时踩过）。
      .filter((name) => name !== '' && !name.includes('/') && isMemoryFileNameV2(name));
    // 与记忆 v1 的排序规则一致：`MEMORY.md` → 日期文件升序 → 其它升序
    return Promise.resolve(sortMemoryFileNames(names));
  }

  readDirFile(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<string | null> {
    const entry = memoryEntryName(name, subdir);
    if (!isMemoryEntryName(entry)) return Promise.resolve(null);
    const dir = readMemoryDirV2(dirRef);
    return Promise.resolve(
      Object.prototype.hasOwnProperty.call(dir, entry) ? dir[entry] : null,
    );
  }

  writeDirFile(
    dirRef: MemoryDirRef,
    name: string,
    content: string,
    subdir?: string,
  ): Promise<void> {
    const entry = memoryEntryName(name, subdir);
    // 与主进程同一条能力边界：Web 端也不允许应用发明文件名
    if (!isWritableMemoryEntryName(entry)) {
      return Promise.reject(new Error(`不允许写入该记忆文件：${entry}`));
    }
    const dir = readMemoryDirV2(dirRef);
    dir[entry] = content ?? '';
    writeMemoryDirV2(dirRef, dir);
    return Promise.resolve();
  }

  removeDirFile(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<void> {
    const entry = memoryEntryName(name, subdir);
    if (!isMemoryEntryName(entry)) return Promise.resolve();
    const dir = readMemoryDirV2(dirRef);
    if (!Object.prototype.hasOwnProperty.call(dir, entry)) return Promise.resolve();
    delete dir[entry];
    writeMemoryDirV2(dirRef, dir);
    return Promise.resolve();
  }

  /** Web 端无临时文件：退化为一次写（best-effort，见类头注释） */
  replaceDirFile(
    dirRef: MemoryDirRef,
    name: string,
    content: string,
    subdir?: string,
  ): Promise<void> {
    return this.writeDirFile(dirRef, name, content, subdir);
  }

  appendDirLine(dirRef: MemoryDirRef, name: string, line: string, subdir?: string): Promise<void> {
    const entry = memoryEntryName(name, subdir);
    if (!isWritableMemoryEntryName(entry)) {
      return Promise.reject(new Error(`不允许追加该记忆文件：${entry}`));
    }
    const dir = readMemoryDirV2(dirRef);
    const current = Object.prototype.hasOwnProperty.call(dir, entry) ? dir[entry] : '';
    dir[entry] = appendJsonlLine(current, line);
    writeMemoryDirV2(dirRef, dir);
    return Promise.resolve();
  }

  readDirLines(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<string[]> {
    const entry = memoryEntryName(name, subdir);
    if (!isMemoryEntryName(entry)) return Promise.resolve([]);
    const dir = readMemoryDirV2(dirRef);
    const raw = Object.prototype.hasOwnProperty.call(dir, entry) ? dir[entry] : '';
    return Promise.resolve(splitJsonlLines(raw));
  }
}

/** 从路径提取文件名（Web 端下载用） */
function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || 'download.json';
}

/**
 * Web 端文本文件写入：降级为浏览器下载（无文件系统权限）。
 * path 仅作为下载文件名使用。返回 Promise 以便统一调用签名。
 */
/**
 * Web 端目录选择：优先 File System Access API（showDirectoryPicker）。
 * 不支持的浏览器 / 用户取消时返回 null（UI 侧保持原工作空间不变）。
 */
export async function webPickDirectory(): Promise<string | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<{ name: string }>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== 'function') return null;
  try {
    const handle = await picker({ mode: 'readwrite' });
    return handle?.name ?? null;
  } catch {
    // 用户取消或权限被拒
    return null;
  }
}

/**
 * Web 端文件选择：动态插入 `<input type=file accept=".json">`，监听 change，
 * 用 `file.text()` 读取 UTF-8 内容并返回 `{ name, content }`。
 * 用户取消 / 不支持时返回 null（UI 侧保持原状）。
 *
 * 与 `webPickDirectory`（File System Access API，只返目录名）不同：这里必须拿内容，
 * 因为导入归档需要文本；Web 端拿不到本地路径，故返回形态是内容而非路径。
 */
export async function webPickFile(): Promise<{ name: string; content: string } | null> {
  if (typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    const cleanup = (): void => {
      input.remove();
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      try {
        const content = await file.text();
        resolve({ name: file.name, content });
      } catch {
        // 读取失败按取消处理
        resolve(null);
      } finally {
        cleanup();
      }
    });
    // 用户关闭系统文件对话框不会触发 change：用取消钩子兜底返回 null
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function webWriteTextFile(path: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = basename(path);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 释放需稍候，确保下载已触发
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 产物索引的 Web 后端：**no-op**。
 *
 * Web 端没有文件系统，`artifact-index/` 落不下去。这不影响功能——产物索引的
 * 权威是 store 索引切片（随 `artifacts.json` 持久化），镜像只是 Electron 的额外副本。
 */
export class WebArtifactIndexFiles implements ArtifactIndexFiles {
  put(_entry: ArtifactIndexEntry): Promise<void> {
    return Promise.resolve();
  }

  remove(_id: string): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 内容寻址文件备份的 Web 后端：**no-op**。
 *
 * Web 端没有文件系统，`file-history/` 落不下去，`get` 返回 `null`。记忆页据此
 * 禁用回滚 UI 并提示「仅桌面端支持文件级回滚」。
 */
export class WebFileBackup implements FileBackup {
  put(_hash: string, _content: string): Promise<void> {
    return Promise.resolve();
  }

  get(_hash: string): Promise<string | null> {
    return Promise.resolve(null);
  }
}
