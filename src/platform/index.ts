import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { isElectron } from './env';
import { WebStorageAdapter, webPickDirectory, webWriteTextFile } from './storage.web';
import { ElectronStorageAdapter } from './storage.electron';
import { notify } from './notification';
import type {
  ChannelConnectAction,
  ChannelSyncResult,
  CredentialVaultStatus,
  GatewayRestartResult,
  MCPSyncResult,
  McpProbeRequest,
  McpProbeResult,
  NanobotCronHistoryDeleteResult,
  NanobotCronRunRecord,
  NanobotMcpSnapshot,
  PlatformAdapter,
  SecretWriteResult,
  SkillOverrideSyncResult,
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
  loadUserSkills: (workspace?: string) => {
    if (isElectron() && storage instanceof ElectronStorageAdapter) {
      return storage.loadUserSkills(workspace);
    }
    return Promise.resolve([]);
  },
  onSkillsChanged: (cb: () => void): (() => void) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.onSkillsChanged(cb);
    }
    // Web 端没有可监听的本地目录：返回空取消函数，调用方无需分支
    return () => {};
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
  /**
   * MCP 连接探针。
   *
   * Web 端**明确返回不可用**而不是假装成功：探针需要 spawn 本地进程 / 携带
   * OS 凭据库里的密钥发起请求，浏览器两样都没有。降级成"看起来连上了"会让
   * 用户在一个永远不会真的连上的端点后面排查半天。
   */
  probeMcpServer: async (request: McpProbeRequest): Promise<McpProbeResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.mcpProbe(request);
    }
    return {
      ok: false,
      status: 'error',
      tools: [],
      error: 'Web 端不支持连接测试（需要本地进程与系统凭据库），请使用桌面端',
      latencyMs: 0,
    };
  },
  secretsStatus: async (): Promise<CredentialVaultStatus> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.secretsStatus();
    }
    // 浏览器没有 OS 凭据库：如实报告不可用，界面据此提示"不加密存储"
    return { available: false, path: '' };
  },
  secretsKeys: async (): Promise<Record<string, string[]>> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.secretsKeys();
    }
    return {};
  },
  secretsSet: async (
    name: string,
    secrets: Record<string, string>,
  ): Promise<SecretWriteResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.secretsSet(name, secrets);
    }
    // Web 端无保险库：拒绝写入（fail-closed）。Web 端的凭据编辑仍走本地
    // 明文持久化——这是浏览器环境的既有限制，界面会明确标注。
    return { ok: false, error: 'Web 端没有系统凭据库，凭据未加密保存' };
  },
  secretsDelete: async (name: string): Promise<SecretWriteResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.secretsDelete(name);
    }
    return { ok: true };
  },
  /** 技能三态覆盖同步：合并进 config.json 的 agents.defaults.skillOverrides */
  syncNanobotSkills: async (
    overridesJson: string,
  ): Promise<SkillOverrideSyncResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotSyncSkills(overridesJson);
    }
    // Web 端无文件系统权限：降级为下载片段文件，由用户手动合并进 config.json
    await webWriteTextFile('nanowork.skills.json', overridesJson);
    return {
      ok: true,
      changed: true,
      message:
        '已下载技能覆盖片段，请将其合并到 nanobot config.json 的 agents.defaults.skillOverrides 中',
      needsRestart: true,
    };
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
