import { createJSONStorage, type StateStorage } from 'zustand/middleware';
import { electronBridge, isElectron, webPlatformOs } from './env';
import {
  WebArtifactIndexFiles,
  WebFileBackup,
  WebMemoryDirFiles,
  WebStorageAdapter,
  WebWorkspaceMemoryFiles,
  webPickDirectory,
  webPickFile,
  webWriteTextFile,
} from './storage.web';
import {
  ElectronArtifactIndexFiles,
  ElectronFileBackup,
  ElectronMemoryDirFiles,
  ElectronStorageAdapter,
  ElectronWorkspaceMemoryFiles,
} from './storage.electron';
import { notify } from './notification';
import type {
  AppInfo,
  AuditLogReadResult,
  ChannelConnectAction,
  ChannelSyncResult,
  CredentialVaultStatus,
  DesktopConfig,
  DesktopConfigResult,
  GatewayRestartResult,
  MCPSyncResult,
  McpProbeRequest,
  McpProbeResult,
  ModelProbeRequest,
  ModelProbeResult,
  ModelsSyncResult,
  NanobotCronHistoryDeleteResult,
  NanobotCronRunRecord,
  NanobotMcpSnapshot,
  NanobotModelsSnapshot,
  NanobotToolsSnapshot,
  PlatformAdapter,
  PlatformName,
  ToolsSyncResult,
  SecretWriteResult,
  SkillOverrideSyncResult,
  TaskSyncResult,
} from './types';
import type { ChannelConnectResponse } from './types';

/**
 * 运行时选择 web / electron 实现并导出统一 API。
 * 渲染层其余代码一律从这里拿 platform，禁止直接依赖 electron。
 */
const storage = isElectron() ? new ElectronStorageAdapter() : new WebStorageAdapter();

export const platform: PlatformAdapter = {
  env: isElectron() ? 'electron' : 'web',
  storage,
  // 工作区记忆目录：与 storage 并列的另一条通道（一个 key 一个文件的契约表达不了
  // 「一个目录、若干日期文件」，见 types.ts 的 WorkspaceMemoryFiles 注释）。
  memoryFiles: isElectron()
    ? new ElectronWorkspaceMemoryFiles()
    : new WebWorkspaceMemoryFiles(),
  // 记忆 v2 的目录后端（子目录 / 原子替换 / JSONL 追行）。与 `memoryFiles` 分开的理由
  // 见 types.ts 的 `PlatformAdapter.memoryDirs`：v1 面与 v2 面在两端各有一组独立的
  // 存储载体（IPC 通道 / localStorage 前缀），合成一个对象会让「v1 面写、v2 面读」
  // 这类不一致有机会发生。
  memoryDirs: isElectron() ? new ElectronMemoryDirFiles() : new WebMemoryDirFiles(),
  // 产物索引（FR-7.2）：与 storage 并列的目录后端，Electron 落到
  // `<userData>/artifact-index/<id>.json`，Web 端是 no-op（权威在 store 索引切片）
  artifactIndex: isElectron()
    ? new ElectronArtifactIndexFiles()
    : new WebArtifactIndexFiles(),
  // 内容寻址文件备份（FR-7.3）：Electron 落 `<userData>/file-history/<hash>.bak`，
  // Web 端 no-op（无文件系统，回滚 UI 据此禁用）
  fileBackup: isElectron() ? new ElectronFileBackup() : new WebFileBackup(),
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
  pickFile: () => {
    if (isElectron() && storage instanceof ElectronStorageAdapter) {
      return window.electronAPI!.pickFile();
    }
    return webPickFile();
  },
  getNanobotChannels: () => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetChannels();
    }
    // Web 端无文件系统权限：无法回读 nanobot 配置
    return Promise.resolve(null);
  },
  getChannelRuntimeStatus: () => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetChannelRuntimeStatus();
    }
    // Web 端无网关：无实时状态可查
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
  /** 只读回读 config.json 的模型预设与供应商凭据（Web 端无文件系统权限 → null） */
  getNanobotModels: async (): Promise<NanobotModelsSnapshot | null> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetModels();
    }
    return null;
  },
  /** 只读回读 `tools.file` 的写策略（FR-8.4 默认拒绝写入） */
  getNanobotTools: async (): Promise<NanobotToolsSnapshot | null> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotGetTools();
    }
    return null;
  },
  /** 提交一次写策略变更：合并写入 config.json.tools.file 并按需重启 serve */
  syncNanobotTools: async (mutationJson: string): Promise<ToolsSyncResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotSyncTools(mutationJson);
    }
    // Web 端无文件系统权限：降级为下载片段，由用户手动合并进 tools.file
    await webWriteTextFile('nanowork.tools.json', mutationJson);
    return {
      ok: true,
      changed: true,
      message: '已下载工具策略片段，请手动合并进 nanobot config.json 的 tools.file 并重启网关',
      needsRestart: true,
    };
  },
  /** 提交一次模型变更：合并写入 config.json 并按需重启 serve */
  syncNanobotModels: async (mutationJson: string): Promise<ModelsSyncResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.nanobotSyncModels(mutationJson);
    }
    // Web 端无文件系统权限：降级为下载片段文件，由用户手动合并进 config.json
    await webWriteTextFile('nanowork.models.json', mutationJson);
    return {
      ok: true,
      changed: true,
      message:
        '已下载模型配置片段，请手动合并进 nanobot config.json 的 modelPresets / providers 并重启网关',
      needsRestart: true,
    };
  },
  /**
   * 供应商连接测试。
   *
   * Web 端**明确返回不可用**：浏览器发不出去（CORS），而 CORS 失败与
   * 「key 无效」在界面上长得一样，降级成"看起来连上了"只会误导排查方向。
   */
  probeModel: async (request: ModelProbeRequest): Promise<ModelProbeResult> => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.probeModel(request);
    }
    return {
      ok: false,
      error: 'Web 端不支持连接测试（浏览器跨域限制），请使用桌面端',
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
  /**
   * 用系统默认浏览器打开 http(s) 链接。
   *
   * Web 端刻意**不用** `window.open`：浏览器会拦下没有用户手势的弹窗，返回值也
   * 只是一张可能已被拦截的句柄（既不能证实打开成功，也无法报告失败）。开着
   * `noopener` 新开一个标签页是这里唯一能诚实表达的动作。
   */
  openUrl: (url: string) => {
    if (!/^https?:\/\//i.test(url)) {
      return Promise.resolve({ ok: false, error: `不支持的链接协议：${url}` });
    }
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.openUrl(url);
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve({ ok: true });
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
  // —— 插件包生命周期（FR-3.4）——
  /**
   * 扫描已安装插件。Web 端返回**空结果但不算错误**：
   * 浏览器里没有 `~/.nanowork/plugins` 可扫，这不是故障。
   * 返回值带 `pluginsRoot`，界面据此显示「插件目录在哪 / 为什么是空的」。
   */
  scanPlugins: () => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsScan();
    }
    return Promise.resolve({ plugins: [], skipped: [], pluginsRoot: '' });
  },
  /**
   * 安装插件。Web 端**拒绝**而不是假装成功：安装要往产品自有目录写文件，
   * 浏览器做不到；报 ok=false 至少能让用户知道该换桌面端。
   */
  installPlugin: (sourceDir: string, overwrite?: boolean) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsInstall(sourceDir, overwrite);
    }
    return Promise.resolve({
      ok: false,
      error: 'Web 端无法安装插件包，请使用桌面端',
      errorKind: 'io' as const,
    });
  },
  uninstallPlugin: (name: string) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsUninstall(name);
    }
    return Promise.resolve({ ok: false, error: 'Web 端无法卸载插件包，请使用桌面端' });
  },
  // —— 市场注册表与版本化缓存（FR-3.7 / FR-3.8）——
  // Web 端一律**如实拒绝**而不是返回空结果：市场要读写 `~/.nanowork/plugins`，
  // 浏览器做不到；返回空列表会让界面显示「没有市场」——那是假话。
  pluginsMarkets: () => {
    if (isElectron() && window.electronAPI) return window.electronAPI.pluginsMarkets();
    return Promise.resolve({
      version: 1,
      markets: [],
      error: 'Web 端不支持市场功能，请使用桌面端',
    });
  },
  pluginsMarketsUpsert: (entry) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsMarketsUpsert(entry);
    }
    return Promise.resolve({ ok: false, error: 'Web 端不支持市场功能，请使用桌面端' });
  },
  pluginsMarketsRemove: (id) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsMarketsRemove(id);
    }
    return Promise.resolve({ ok: false, error: 'Web 端不支持市场功能，请使用桌面端' });
  },
  pluginsMarketsSync: (id) => {
    if (isElectron() && window.electronAPI) return window.electronAPI.pluginsMarketsSync(id);
    return Promise.resolve({
      ok: false,
      result: { ok: false, market: id, synced: 0, skipped: [], error: 'Web 端不支持市场功能' },
      entry: {
        id,
        name: id,
        type: 'directory',
        location: '',
        isBuiltIn: false,
        autoUpdate: false,
        lastSyncAt: null,
        lastError: 'Web 端不支持市场功能',
      },
      error: 'Web 端不支持市场功能，请使用桌面端',
    });
  },
  pluginsMarketPackages: (market) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsMarketPackages(market);
    }
    return Promise.resolve({ market, packages: [], skipped: [] });
  },
  pluginsMarketInstall: (market, name, version) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsMarketInstall(market, name, version);
    }
    return Promise.resolve({
      ok: false,
      market,
      name,
      version: '',
      path: '',
      error: 'Web 端无法安装插件包，请使用桌面端',
    });
  },
  pluginsMarketGc: (referenced, keepDays) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.pluginsMarketGc(referenced, keepDays);
    }
    return Promise.resolve({ removed: [], kept: [] });
  },
  // —— 可观测性（FR-11.2 / FR-11.3）——
  // 两条写入都是 fire-and-forget：日志与 trace 是旁路，不能给业务调用造出 await 点。
  // Web 端 no-op —— 没有 `<userData>`，写进 localStorage 只会让设置页显示一个
  // 「已记录 N 条」的假象，而磁盘上什么都没有。
  appendLog: (entry) => {
    if (isElectron() && window.electronAPI) window.electronAPI.appendLog(entry);
  },
  writeTrace: (file) => {
    if (isElectron() && window.electronAPI) window.electronAPI.writeTrace(file);
  },
  diagnosticsStats: () => {
    if (isElectron() && window.electronAPI) return window.electronAPI.diagnosticsStats();
    return Promise.resolve(null);
  },
  exportDiagnostics: () => {
    if (isElectron() && window.electronAPI) return window.electronAPI.exportDiagnostics();
    return Promise.resolve({
      ok: false,
      error: '浏览器环境没有本地数据目录与保存对话框，无法导出诊断包',
    });
  },
  /** FR-8.9 读取工具网关审计日志（NDJSON 文本）；Web 端无文件系统权限 → exists:false */
  auditRead: (): Promise<AuditLogReadResult> => {
    if (isElectron() && window.electronAPI) return window.electronAPI.auditRead();
    return Promise.resolve({ path: '', exists: false, content: '' });
  },
  // —— 桌面端集成（窗口控制 / 托盘配置 / 主进程指令）——
  // 这一组统一走 `electronBridge()`（而非上面那种 `isElectron() && window.electronAPI`
  // 的写法）：桥不在就是「Web 降级」，判据只有一处。
  platformOs: () => electronBridge()?.getPlatform() ?? webPlatformOs(),
  getDesktopConfig: () => {
    const api = electronBridge();
    return api ? api.appGetDesktopConfig() : Promise.resolve(null);
  },
  setDesktopConfig: (patch) => {
    const api = electronBridge();
    return api ? api.appSetDesktopConfig(patch) : Promise.resolve(null);
  },
  onDesktopConfigChange: (cb) => {
    const api = electronBridge();
    return api ? api.onDesktopConfigChange(cb) : () => undefined;
  },
  appQuit: () => {
    electronBridge()?.appQuit();
  },
  onAppNavigate: (cb) => {
    const api = electronBridge();
    return api ? api.onAppNavigate(cb) : () => undefined;
  },
  onAppOpenAbout: (cb) => {
    const api = electronBridge();
    return api ? api.onAppOpenAbout(cb) : () => undefined;
  },
  windowMinimize: () => {
    electronBridge()?.windowMinimize();
  },
  windowToggleMaximize: () => {
    electronBridge()?.windowToggleMaximize();
  },
  windowClose: () => {
    electronBridge()?.windowClose();
  },
  windowToggleFullScreen: () => {
    electronBridge()?.windowToggleFullScreen();
  },
  windowIsMaximized: () => {
    const api = electronBridge();
    return api ? api.windowIsMaximized() : Promise.resolve(false);
  },
  onWindowMaximizeChange: (cb) => {
    electronBridge()?.onWindowMaximizeChange(cb);
  },
  /** 应用元信息：Web 端没有「应用版本」这个概念，如实返回 null */
  appInfo: () => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.appGetInfo();
    }
    return Promise.resolve(null);
  },
  /**
   * 本地存储信息。Web 端返回 `null` 而不是「全 0 的假数据」：
   * 浏览器里既没有「应用缓存目录」也没有磁盘容量可读，卡片据此显示不可用，
   * 比画一根恒为空、恒为满的占用条诚实得多。
   */
  storageInfo: (ensureDefaultWorkspace?: boolean) => {
    if (isElectron() && window.electronAPI) {
      return window.electronAPI.appGetStorageInfo(ensureDefaultWorkspace);
    }
    return Promise.resolve(null);
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
