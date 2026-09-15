import type { Skill } from '@/types';
import type { ElectronAPI, StorageAdapter } from './types';

/**
 * Electron 存储适配器：通过 window.electronAPI 桥接主进程，
 * 主进程负责将 JSON 落盘到 userData 目录。
 */
export class ElectronStorageAdapter implements StorageAdapter {
  private api(): ElectronAPI {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI 未注入，无法使用 Electron 存储');
    }
    return api;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.api().storageGet(key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.api().storageSet(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    await this.api().storageRemove(key);
  }

  async clear(): Promise<void> {
    await this.api().storageClear();
  }

  /** 经主进程写入磁盘真实路径 */
  async writeTextFile(path: string, content: string): Promise<void> {
    await this.api().writeTextFile(path, content);
  }

  /** 经主进程扫描并解析 ~/.nanowork/skills */
  async loadUserSkills() {
    return this.api().loadUserSkills();
  }
}
