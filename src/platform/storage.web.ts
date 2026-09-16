import type { StorageAdapter } from './types';

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
