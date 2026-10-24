import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChannelConnectAction,
  DesktopConfig,
  ElectronAPI,
  ModelProbeRequest,
  ModelProbeResult,
  ModelsSyncResult,
  NanobotModelsSnapshot,
  NanobotToolsSnapshot,
  PlatformName,
  ToolsSyncResult,
} from '../src/platform/types';
import type { DeepLinkAction } from '../src/types/deepLink';
import type { UpdateStatus } from '../src/types/update';
import type { EngineInstallState } from '../src/types/engine';

/**
 * preload：通过 contextBridge 安全地暴露 window.electronAPI。
 * 渲染层只经此桥访问存储与通知，绝不直接 require('electron')。
 */
const api: ElectronAPI = {
  storageGet: (key: string) => ipcRenderer.invoke('storage:get', key),
  storageSet: (key: string, value: string) => ipcRenderer.invoke('storage:set', key, value),
  storageRemove: (key: string) => ipcRenderer.invoke('storage:remove', key),
  storageClear: () => ipcRenderer.invoke('storage:clear'),
  // —— 事件流桥（D2）——
  eventsAppend: (params) => ipcRenderer.invoke('events:append', params),
  eventsRead: (sessionId: string, workdir?: string | null) =>
    ipcRenderer.invoke('events:read', sessionId, workdir),
  eventsRemove: (sessionId: string, workdir?: string | null) =>
    ipcRenderer.invoke('events:remove', sessionId, workdir),
  eventsTombstone: (meta) => ipcRenderer.invoke('events:tombstone', meta),
  readSessionMeta: (sessionId: string, workdir?: string | null) =>
    ipcRenderer.invoke('meta:read', sessionId, workdir),
  writeSessionMeta: (meta) => ipcRenderer.invoke('meta:write', meta),
  listSessionMetas: () => ipcRenderer.invoke('meta:list'),
  readSessionIndex: () => ipcRenderer.invoke('index:read'),
  rebuildSessionIndex: () => ipcRenderer.invoke('index:rebuild'),
  putFileBackup: (hash: string, content: string) =>
    ipcRenderer.invoke('file-backup:put', hash, content),
  getFileBackup: (hash: string) => ipcRenderer.invoke('file-backup:get', hash),
  notify: (title: string, body: string) => ipcRenderer.send('app:notify', title, body),
  writeTextFile: (path: string, content: string) =>
    ipcRenderer.invoke('fs:writeTextFile', path, content),
  // —— 工作区记忆目录（`<workdir>/.nanowork/memory/`）——
  // 与 `writeTextFile` 是两条**不同能力**的通道：那条只放行 home / userData /
  // ~/.nanowork，这条落在用户的工作目录里，因此文件名白名单卡得更死
  // （只有 MEMORY.md 与 YYYY-MM-DD.md，见 src/lib/workspaceMemory.ts）。
  memoryListFiles: (workdir: string | null) => ipcRenderer.invoke('memory:list', workdir),
  memoryReadFile: (workdir: string | null, name: string) =>
    ipcRenderer.invoke('memory:read', workdir, name),
  memoryWriteFile: (workdir: string | null, name: string, content: string) =>
    ipcRenderer.invoke('memory:write', workdir, name, content),
  memoryRemoveFile: (workdir: string | null, name: string) =>
    ipcRenderer.invoke('memory:remove', workdir, name),
  memoryRemoveAll: (workdir: string | null) => ipcRenderer.invoke('memory:removeAll', workdir),
  memoryMigrateLegacy: (workdir: string | null) =>
    ipcRenderer.invoke('memory:migrate', workdir),
  // —— 记忆 v2 的目录后端（两类存储根 + 子目录 + 原子替换 + JSONL 追行）——
  // `dirRef` 是 `{kind:'workspace'|'user', …}` 的普通对象，可结构化克隆；
  // 主进程重新解析绝对路径并做越界断言，渲染层传什么都越不过白名单。
  memoryListDir: (dirRef: unknown, subdir?: string) =>
    ipcRenderer.invoke('memory:listDir', dirRef, subdir),
  memoryReadDirFile: (dirRef: unknown, name: string, subdir?: string) =>
    ipcRenderer.invoke('memory:readDirFile', dirRef, name, subdir),
  memoryWriteDirFile: (dirRef: unknown, name: string, content: string, subdir?: string) =>
    ipcRenderer.invoke('memory:writeDirFile', dirRef, name, content, subdir),
  memoryRemoveDirFile: (dirRef: unknown, name: string, subdir?: string) =>
    ipcRenderer.invoke('memory:removeDirFile', dirRef, name, subdir),
  memoryReplaceDirFile: (dirRef: unknown, name: string, content: string, subdir?: string) =>
    ipcRenderer.invoke('memory:replaceDirFile', dirRef, name, content, subdir),
  memoryAppendDirLine: (dirRef: unknown, name: string, line: string, subdir?: string) =>
    ipcRenderer.invoke('memory:appendDirLine', dirRef, name, line, subdir),
  memoryReadDirLines: (dirRef: unknown, name: string, subdir?: string) =>
    ipcRenderer.invoke('memory:readDirLines', dirRef, name, subdir),
  artifactIndexPut: (entry: unknown) => ipcRenderer.invoke('artifactIndex:put', entry),
  artifactIndexRemove: (id: string) => ipcRenderer.invoke('artifactIndex:remove', id),
  nanobotStart: () => ipcRenderer.invoke('nanobot:start'),
  nanobotStop: () => ipcRenderer.invoke('nanobot:stop'),
  nanobotStatus: () => ipcRenderer.invoke('nanobot:status'),
  nanobotGatewayInfo: () => ipcRenderer.invoke('nanobot:gatewayInfo'),
  nanobotSyncChannels: (channelsJson: string) =>
    ipcRenderer.invoke('nanobot:syncChannels', channelsJson),
  nanobotGetChannels: () => ipcRenderer.invoke('nanobot:getChannels'),
  nanobotGetChannelRuntimeStatus: () =>
    ipcRenderer.invoke('nanobot:getChannelRuntimeStatus'),
  nanobotSyncMcp: (mcpJson: string) =>
    ipcRenderer.invoke('nanobot:syncMcp', mcpJson),
  nanobotGetMcp: () => ipcRenderer.invoke('nanobot:getMcp'),
  /** MCP 连接探针：真实握手拿连接结果与工具清单（凭据由主进程从保险库补齐） */
  mcpProbe: (request) => ipcRenderer.invoke('mcp:probe', request),
  // —— 模型设置（config.json 的 modelPresets + providers）——
  nanobotGetModels: (): Promise<NanobotModelsSnapshot | null> =>
    ipcRenderer.invoke('nanobot:getModels'),
  nanobotSyncModels: (mutationJson: string): Promise<ModelsSyncResult> =>
    ipcRenderer.invoke('nanobot:syncModels', mutationJson),
  // —— FR-8.4 写策略（config.json 的 tools.file）——
  nanobotGetTools: (): Promise<NanobotToolsSnapshot | null> =>
    ipcRenderer.invoke('nanobot:getTools'),
  nanobotSyncTools: (mutationJson: string): Promise<ToolsSyncResult> =>
    ipcRenderer.invoke('nanobot:syncTools', mutationJson),
  probeModel: (request: ModelProbeRequest): Promise<ModelProbeResult> =>
    ipcRenderer.invoke('model:probe', request),
  /** 凭据保险库：可用性 / key 名清单 / 写入 / 删除（**密钥值不回传**） */
  secretsStatus: () => ipcRenderer.invoke('secrets:status'),
  secretsKeys: () => ipcRenderer.invoke('secrets:keys'),
  secretsSet: (name: string, secrets: Record<string, string>) =>
    ipcRenderer.invoke('secrets:set', name, secrets),
  secretsDelete: (name: string) => ipcRenderer.invoke('secrets:delete', name),
  nanobotSyncSkills: (overridesJson: string) =>
    ipcRenderer.invoke('nanobot:syncSkills', overridesJson),
  nanobotSyncTasks: (tasksJson: string) =>
    ipcRenderer.invoke('nanobot:syncTasks', tasksJson),
  nanobotListCronRuns: () => ipcRenderer.invoke('nanobot:listCronRuns'),
  nanobotGetCronSession: (taskId: string) =>
    ipcRenderer.invoke('nanobot:getCronSession', taskId),
  nanobotDeleteCronHistory: (taskId: string) =>
    ipcRenderer.invoke('nanobot:deleteCronHistory', taskId),
  nanobotListChannelSessions: () => ipcRenderer.invoke('nanobot:listChannelSessions'),
  nanobotGetChannelSession: (key: string) =>
    ipcRenderer.invoke('nanobot:getChannelSession', key),
  nanobotSendChannelMessage: (params) =>
    ipcRenderer.invoke('nanobot:sendChannelMessage', params),
  nanobotRunChannelTurn: (params) =>
    ipcRenderer.invoke('nanobot:runChannelTurn', params),
  nanobotGetChannelTurnProgress: (params) =>
    ipcRenderer.invoke('nanobot:getChannelTurnProgress', params),
  /** 读取某个 IM 会话当前挂着的待裁决审批（gateway /v1/approvals） */
  nanobotGetChannelApprovals: (params) =>
    ipcRenderer.invoke('nanobot:getChannelApprovals', params),
  /** 裁决一条 IM 会话里的待裁决审批（gateway /v1/approvals/resolve） */
  nanobotResolveChannelApproval: (params) =>
    ipcRenderer.invoke('nanobot:resolveChannelApproval', params),
  nanobotChannelConnect: (action: ChannelConnectAction, channel: string, params: Record<string, string>) =>
    ipcRenderer.invoke('nanobot:channelConnect', action, channel, params),
  nanobotRestartGateway: (engineChannel?: string) =>
    ipcRenderer.invoke('nanobot:restartGateway', engineChannel),
  nanobotDisconnectChannel: (kind: string) =>
    ipcRenderer.invoke('nanobot:disconnectChannel', kind),
  /** 在系统文件管理器中打开路径（资源管理器/Finder） */
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  showItemInFolder: (path: string) => ipcRenderer.invoke('shell:showItemInFolder', path),
  /** 用系统默认浏览器打开 http(s) 链接（主进程侧有协议白名单） */
  openUrl: (url: string) => ipcRenderer.invoke('shell:openUrl', url),
  /** 读取本地文件为 base64（复制消息粘贴恢复附件用） */
  readFileAsBase64: (path: string) =>
    ipcRenderer.invoke('fs:readFileAsBase64', path),
  // ⚠️ `workspace` 必须透传：丢掉它主进程就只会扫用户级目录，
  // 项目级技能（`<workspace>/skills`）会静默消失（界面上看不出任何异常）。
  loadUserSkills: (workspace?: string) =>
    ipcRenderer.invoke('skills:loadUser', workspace),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  // —— 插件包生命周期（FR-3.4）：只做文件系统那一半 ——
  // 激活状态走引擎的 /v1/plugins，不经 IPC——引擎才是权威。
  pluginsScan: () => ipcRenderer.invoke('plugins:scan'),
  pluginsInstall: (sourceDir: string, overwrite?: boolean) =>
    ipcRenderer.invoke('plugins:install', sourceDir, overwrite),
  pluginsUninstall: (name: string) => ipcRenderer.invoke('plugins:uninstall', name),
  // —— 市场注册表与版本化缓存（FR-3.7 / FR-3.8）——
  pluginsMarkets: () => ipcRenderer.invoke('plugins:markets'),
  pluginsMarketsUpsert: (entry: unknown) => ipcRenderer.invoke('plugins:marketsUpsert', entry),
  pluginsMarketsRemove: (id: string) => ipcRenderer.invoke('plugins:marketsRemove', id),
  pluginsMarketsSync: (id: string) => ipcRenderer.invoke('plugins:marketsSync', id),
  pluginsMarketPackages: (market: string) => ipcRenderer.invoke('plugins:marketPackages', market),
  pluginsMarketInstall: (market: string, name: string, version: string) =>
    ipcRenderer.invoke('plugins:marketInstall', market, name, version),
  pluginsMarketGc: (referenced: string[], keepDays?: number) =>
    ipcRenderer.invoke('plugins:marketGc', referenced, keepDays),
  // —— 可观测性（FR-11.2 / FR-11.3）——
  // 日志与 trace 都是 **fire-and-forget**（`send` 而不是 `invoke`）：它们是旁路，
  // 不该给渲染层造出 await 点；主进程侧全部自行吞错（写不进去就是写不进去，
  // 不能回头把用户的这一轮对话打挂）。
  appendLog: (entry) => ipcRenderer.send('log:append', entry),
  writeTrace: (file) => ipcRenderer.send('trace:write', file),
  // 会话首字延迟采样（FR-11.7）：同样是 fire-and-forget，主进程追加一行 JSONL。
  recordSessionLatency: (sample) => ipcRenderer.send('perf:latency', sample),
  diagnosticsStats: () => ipcRenderer.invoke('diagnostics:stats'),
  /** FR-13.6 引擎运行时自检：返回**结构化报告**（三项逐项），`true` 强制重跑 */
  engineSelfCheck: (refresh?: boolean) => ipcRenderer.invoke('engine:selfCheck', refresh === true),
  // —— 一键修复（B4-03）——
  engineInstall: () => ipcRenderer.invoke('engine:install'),
  engineInstallCancel: () => ipcRenderer.invoke('engine:install:cancel'),
  engineInstallState: () => ipcRenderer.invoke('engine:install:state'),
  onEngineInstallProgress: (cb: (state: EngineInstallState) => void) => {
    const listener = (_e: unknown, state: EngineInstallState) => cb(state);
    ipcRenderer.on('engine:install-progress', listener);
    return () => ipcRenderer.removeListener('engine:install-progress', listener);
  },
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  /** FR-8.9 工具网关审计日志：读 `<data_dir>/audit/tool-gateway.ndjson` 的 NDJSON 文本 */
  auditRead: () => ipcRenderer.invoke('audit:read'),
  /** FR-8.9 应用操作审计（第二条来源）：追加已序列化的单行 JSON / 读回全文 */
  auditAppendApp: (lines: string[]) => ipcRenderer.invoke('audit:append-app', lines),
  auditReadApp: () => ipcRenderer.invoke('audit:read-app'),
  /** 引擎侧应用操作审计（与工具审计同目录） */
  auditReadAppEngine: () => ipcRenderer.invoke('audit:read-app-engine'),
  // ——— 窗口控制（自绘标题栏）———
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  windowReload: () => ipcRenderer.send('window:reload'),
  windowToggleDevTools: () => ipcRenderer.send('window:toggle-devtools'),
  windowToggleFullScreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  getPlatform: () => process.platform as PlatformName,
  onWindowMaximizeChange: (cb: (maximized: boolean) => void) =>
    ipcRenderer.on('window:maximize-change', (_e, maximized: boolean) => cb(maximized)),
  appGetInfo: () => ipcRenderer.invoke('app:getInfo'),
  /** 本地存储信息（缓存目录 / 占用 / 卷容量）；ensureDefaultWorkspace 见 platform/types */
  appGetStorageInfo: (ensureDefaultWorkspace?: boolean) =>
    ipcRenderer.invoke('app:getStorageInfo', ensureDefaultWorkspace),
  // —— 桌面端集成：系统托盘 & 全局快捷键 ——
  appGetDesktopConfig: () => ipcRenderer.invoke('app:getDesktopConfig'),
  appSetDesktopConfig: (patch) => ipcRenderer.invoke('app:setDesktopConfig', patch),
  appShowWindow: () => ipcRenderer.send('app:showWindow'),
  appQuit: () => ipcRenderer.send('app:quit'),
  onAppNavigate: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string) => cb(path);
    ipcRenderer.on('app:navigate', listener);
    return () => ipcRenderer.removeListener('app:navigate', listener);
  },
  // —— 深链（B4-02）——
  onAppDeepLink: (cb: (action: DeepLinkAction) => void) => {
    const listener = (_e: unknown, action: DeepLinkAction) => cb(action);
    ipcRenderer.on('app:deep-link', listener);
    return () => ipcRenderer.removeListener('app:deep-link', listener);
  },
  appRendererReady: () => ipcRenderer.invoke('app:renderer-ready'),
  // —— 自动更新（B4-01）——
  updaterGetStatus: () => ipcRenderer.invoke('updater:getStatus'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (cb: (status: UpdateStatus) => void) => {
    const listener = (_e: unknown, status: UpdateStatus) => cb(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  onAppOpenAbout: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('app:open-about', listener);
    return () => ipcRenderer.removeListener('app:open-about', listener);
  },
  onDesktopConfigChange: (cb: (config: DesktopConfig) => void) => {
    const listener = (_e: unknown, config: DesktopConfig) => cb(config);
    ipcRenderer.on('app:desktop-config-changed', listener);
    return () => ipcRenderer.removeListener('app:desktop-config-changed', listener);
  },
  onSkillsChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('skills:changed', listener);
    return () => ipcRenderer.removeListener('skills:changed', listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
