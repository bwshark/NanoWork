import {
  dailyMemoryFileName,
  isMemoryFileName,
  isWritableMemoryFileName,
  sortMemoryFileNames,
} from '@/lib/workspaceMemory';
import { workspaceKeyFor } from '@/lib/workspaceKey';
import { MEMORY_KEY_PREFIX } from '@/lib/constants';
import type { StorageAdapter, WorkspaceMemoryFiles } from './types';

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
    return Promise.resolve(sortMemoryFileNames(Object.keys(readMemoryDir(workdir))));
  }

  read(workdir: string | null, name: string): Promise<string | null> {
    if (!isMemoryFileName(name)) return Promise.resolve(null);
    const dir = readMemoryDir(workdir);
    return Promise.resolve(Object.prototype.hasOwnProperty.call(dir, name) ? dir[name] : null);
  }

  write(workdir: string | null, name: string, content: string): Promise<void> {
    // 与主进程同一条能力边界：Web 端也不允许应用发明文件名
    if (!isWritableMemoryFileName(name)) {
      return Promise.reject(new Error(`不允许写入该记忆文件名：${String(name)}`));
    }
    const dir = readMemoryDir(workdir);
    dir[name] = content ?? '';
    writeMemoryDir(workdir, dir);
    return Promise.resolve();
  }

  remove(workdir: string | null, name: string): Promise<void> {
    if (!isMemoryFileName(name)) return Promise.resolve();
    const dir = readMemoryDir(workdir);
    if (!Object.prototype.hasOwnProperty.call(dir, name)) return Promise.resolve();
    delete dir[name];
    writeMemoryDir(workdir, dir);
    return Promise.resolve();
  }

  removeAll(workdir: string | null): Promise<number> {
    const count = Object.keys(readMemoryDir(workdir)).length;
    writeMemoryDir(workdir, {});
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
