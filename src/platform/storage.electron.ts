import type { Skill } from '@/types';
import type { ElectronAPI, StorageAdapter, WorkspaceMemoryFiles } from './types';

/**
 * Electron 存储适配器：通过 window.electronAPI 桥接主进程。
 *
 * 落盘位置由主进程按 key 路由（见 electron/storageRoutes.ts）：用户资产落
 * `~/.nanowork/`，运行时数据落 Electron userData，且**一个 key 一个文件**。
 *
 * 桥接层按**文本**传递，适配器不做二次编码——`platform.storage` 的调用方
 * （zustand persist / MemoryService）本来就传字符串，再 `JSON.stringify`
 * 一次只会让落盘多出一层转义，把 `settings.json` 变成 `"{\"state\":...}"`，
 * 既不可读，也让主进程读主题偏好时不得不「试着多解一层」。
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
    return raw as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    // 正常路径是字符串透传；非字符串兜底序列化，避免落盘成 "[object Object]"
    await this.api().storageSet(
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
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

  /** 经主进程扫描并解析用户级 / 项目级技能目录 */
  async loadUserSkills(workspace?: string) {
    return this.api().loadUserSkills(workspace);
  }

  /** 经主进程把三态覆盖合并进 nanobot config.json */
  async syncNanobotSkills(overridesJson: string) {
    return this.api().nanobotSyncSkills(overridesJson);
  }
}

/**
 * Electron 的工作区记忆后端：一个方法一次 IPC，主进程负责路径解析与安全校验。
 *
 * 适配层**不做任何路径拼接**：`<workdir>/.nanowork/memory/` 的拼法在 Windows 与
 * POSIX 上不同（分隔符、大小写、UNC），渲染层既拿不到 `path` 模块也不该复刻
 * 这套规则。所以传的是「工作目录 + 单段文件名」，由主进程现算。
 */
export class ElectronWorkspaceMemoryFiles implements WorkspaceMemoryFiles {
  private api(): ElectronAPI {
    const api = window.electronAPI;
    if (!api) {
      throw new Error('electronAPI 未注入，无法访问工作区记忆目录');
    }
    return api;
  }

  list(workdir: string | null): Promise<string[]> {
    return this.api().memoryListFiles(workdir);
  }

  read(workdir: string | null, name: string): Promise<string | null> {
    return this.api().memoryReadFile(workdir, name);
  }

  write(workdir: string | null, name: string, content: string): Promise<void> {
    return this.api().memoryWriteFile(workdir, name, content);
  }

  remove(workdir: string | null, name: string): Promise<void> {
    return this.api().memoryRemoveFile(workdir, name);
  }

  removeAll(workdir: string | null): Promise<number> {
    return this.api().memoryRemoveAll(workdir);
  }

  migrateLegacy(workdir: string | null): Promise<string[]> {
    return this.api().memoryMigrateLegacy(workdir);
  }
}
