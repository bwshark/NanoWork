import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { isElectron } from './env';
import { WebStorageAdapter, webPickDirectory, webWriteTextFile } from './storage.web';
import { ElectronStorageAdapter } from './storage.electron';
import { notify } from './notification';
import type {
  ChannelConnectAction,
  ChannelSyncResult,
  GatewayRestartResult,
  MCPSyncResult,
  NanobotCronHistoryDeleteResult,
  NanobotCronRunRecord,
  NanobotMcpSnapshot,
  PlatformAdapter,
  TaskSyncResult,
} from './types';
import type { ChannelConnectResponse } from '@/types';

/**
 * 运行时选择 web / electron 实现并导出统一 API。
 * 渲染层其余代码一律从这里拿 platform，禁止直接依赖 electron。
 */
const storage = isElectron() ? new ElectronStorageAdapter() : new WebStorageAdapter();

export const platform: PlatformAdapter = {
  env: isElectron() ? 'electron' : 'web',
  storage,
  notify,
  writeTextFile: (path: string, content: string) => {
    if (isElectron() && storage instanceof ElectronStorageAdapter) {
      return storage.writeTextFile(path, content);
    }
    return webWriteTextFile(path, content);
  },
  loadUserSkills: () => {
    if (isElectron() && storage instanceof ElectronStorageAdapter) {
      return storage.loadUserSkills();
    }
    return Promise.resolve([]);
  },
  pickDirectory: () => {
    if (isElectron() && storage instanceof ElectronStorageAdapter) {
      return window.electronAPI!.pickDirectory();
    }
    return webPickDirectory();
  },
  getNanobotChannels: () => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetChannels();
    }
    // Web 端无文件系统权限：无法回读 nanobot 配置
    return Promise.resolve(null);
  },
  syncNanobotChannels: async (channelsJson: string): Promise<ChannelSyncResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotSyncChannels(channelsJson);
    }
    // Web 端无文件系统权限：降级为下载片段文件，由用户手动合并进 config.json
    await webWriteTextFile('nanowork.channels.json', channelsJson);
    return {
      ok: true,
      message: '已下载 channels 配置片段，请手动合并进 nanobot config.json 并重启网关',
      needsRestart: true,
    };
  },
  /** 将 MCP Server 片段同步进 nanobot（合并到 tools.mcpServers + 必要时重启 serve） */
  syncNanobotMcp: async (mcpJson: string): Promise<MCPSyncResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotSyncMcp(mcpJson);
    }
    // Web 端：下载 mcpServers 字典片段，供用户手动合并进 config.json
    await webWriteTextFile('nanowork.mcp.json', mcpJson);
    return {
      ok: true,
      changed: true,
      message:
        '已下载 MCP 配置片段（tools.mcpServers 字典），请将其整体合并到 nanobot config.json 的 tools.mcpServers 中，并重启网关后生效',
      needsRestart: true,
    };
  },
  /** 回读 nanobot config.json 的 tools.mcpServers 段；外部进程环境返回 null */
  getNanobotMcp: async (): Promise<NanobotMcpSnapshot | null> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetMcp();
    }
    // Web 端无文件系统权限：无法回读
    return null;
  },
  syncNanobotTasks: async (tasksJson: string): Promise<TaskSyncResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotSyncTasks(tasksJson);
    }
    // Web 端无文件系统权限：降级为下载片段文件，由用户手动合并进 jobs.json
    await webWriteTextFile('nanowork.jobs.json', tasksJson);
    return {
      ok: true,
      changed: true,
      message: '已下载任务配置片段，请手动合并进 nanobot jobs.json',
    };
  },
  listNanobotCronRuns: (): Promise<NanobotCronRunRecord[]> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotListCronRuns();
    }
    // Web 端无文件系统权限：cron 运行记录不可用，返回空
    return Promise.resolve([]);
  },
  getCronSession: (taskId: string) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetCronSession(taskId);
    }
    // Web 端无文件系统权限：cron 执行会话不可读
    return Promise.resolve(null);
  },
  deleteNanobotCronHistory: (taskId: string): Promise<NanobotCronHistoryDeleteResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotDeleteCronHistory(taskId);
    }
    // Web 端无文件系统权限：引擎侧没有可删的留痕，视为已删（本地会话由调用方清）
    return Promise.resolve({ ok: true, removed: 0 });
  },
  listNanobotChannelSessions: () => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotListChannelSessions();
    }
    // Web 端无文件系统权限：频道会话列表不可用，返回空
    return Promise.resolve([]);
  },
  getNanobotChannelSession: (key: string) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetChannelSession(key);
    }
    return Promise.resolve(null);
  },
  sendChannelMessage: (params) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotSendChannelMessage(params);
    }
    // Web 端无法访问本地 gateway：主动出站不可用
    return Promise.resolve({
      ok: false,
      error: 'Web 端不支持主动发送，请使用桌面端',
    });
  },
  channelConnect: (
    action: ChannelConnectAction,
    channel: string,
    params?: Record<string, string>,
  ): Promise<ChannelConnectResponse> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotChannelConnect(action, channel, params ?? {});
    }
    // Web 端无法访问本地网关：扫码接入不可用（对齐 sendChannelMessage 降级范式）
    return Promise.resolve({
      ok: false,
      error: 'Web 端不支持扫码接入，请使用桌面端',
    });
  },
  restartNanobotGateway: (engineChannel?: string): Promise<GatewayRestartResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotRestartGateway(engineChannel);
    }
    // Web 端无网关控制权：重启不可用（忽略 engineChannel 参数）
    return Promise.resolve({
      ok: false,
      message: 'Web 端无法重启本地网关，请使用桌面端',
    });
  },
  disconnectChannel: (kind: string): Promise<GatewayRestartResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotDisconnectChannel(kind);
    }
    // Web 端无文件系统权限：断开连接不可用（对齐 channelConnect 降级范式）
    return Promise.resolve({
      ok: false,
      message: 'Web 端不支持断开连接，请使用桌面端',
    });
  },
  /** 在系统文件管理器中打开路径（桌面端专属） */
  openPath: (path: string) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.openPath(path);
    }
    return Promise.resolve({
      ok: false,
      error: 'Web 端不支持此操作，请使用桌面端',
    });
  },
  /** 读取本地文件为 base64（桌面端专属；Web 无文件系统权限） */
  readFileAsBase64: (path: string) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.readFileAsBase64(path);
    }
    return Promise.resolve({
      ok: false,
      error: 'Web 端不支持读取本地文件，请使用桌面端',
    });
  },
};

/**
 * 适配 Zustand persist 的异步存储。
 * 包装 platform.storage 的泛型 get/set 为 StateStorage 的 string 接口。
 */
const zustandStateStorage: StateStorage = {
  getItem: (name) => platform.storage.get<string>(name),
  setItem: (name, value) => platform.storage.set(name, value),
  removeItem: (name) => platform.storage.remove(name),
};

export const zustandStorage = createJSONStorage(() => zustandStateStorage);

export * from './types';
