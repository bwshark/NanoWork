"use strict";

// electron/preload.ts
var import_electron = require("electron");
var api = {
  storageGet: (key) => import_electron.ipcRenderer.invoke("storage:get", key),
  storageSet: (key, value) => import_electron.ipcRenderer.invoke("storage:set", key, value),
  storageRemove: (key) => import_electron.ipcRenderer.invoke("storage:remove", key),
  storageClear: () => import_electron.ipcRenderer.invoke("storage:clear"),
  // —— 事件流桥（D2）——
  eventsAppend: (params) => import_electron.ipcRenderer.invoke("events:append", params),
  eventsRead: (sessionId, workdir) => import_electron.ipcRenderer.invoke("events:read", sessionId, workdir),
  eventsRemove: (sessionId, workdir) => import_electron.ipcRenderer.invoke("events:remove", sessionId, workdir),
  eventsTombstone: (meta) => import_electron.ipcRenderer.invoke("events:tombstone", meta),
  readSessionMeta: (sessionId, workdir) => import_electron.ipcRenderer.invoke("meta:read", sessionId, workdir),
  writeSessionMeta: (meta) => import_electron.ipcRenderer.invoke("meta:write", meta),
  listSessionMetas: () => import_electron.ipcRenderer.invoke("meta:list"),
  readSessionIndex: () => import_electron.ipcRenderer.invoke("index:read"),
  rebuildSessionIndex: () => import_electron.ipcRenderer.invoke("index:rebuild"),
  putFileBackup: (hash, content) => import_electron.ipcRenderer.invoke("file-backup:put", hash, content),
  getFileBackup: (hash) => import_electron.ipcRenderer.invoke("file-backup:get", hash),
  notify: (title, body) => import_electron.ipcRenderer.send("app:notify", title, body),
  writeTextFile: (path, content) => import_electron.ipcRenderer.invoke("fs:writeTextFile", path, content),
  // —— 工作区记忆目录（`<workdir>/.nanowork/memory/`）——
  // 与 `writeTextFile` 是两条**不同能力**的通道：那条只放行 home / userData /
  // ~/.nanowork，这条落在用户的工作目录里，因此文件名白名单卡得更死
  // （只有 MEMORY.md 与 YYYY-MM-DD.md，见 src/lib/workspaceMemory.ts）。
  memoryListFiles: (workdir) => import_electron.ipcRenderer.invoke("memory:list", workdir),
  memoryReadFile: (workdir, name) => import_electron.ipcRenderer.invoke("memory:read", workdir, name),
  memoryWriteFile: (workdir, name, content) => import_electron.ipcRenderer.invoke("memory:write", workdir, name, content),
  memoryRemoveFile: (workdir, name) => import_electron.ipcRenderer.invoke("memory:remove", workdir, name),
  memoryRemoveAll: (workdir) => import_electron.ipcRenderer.invoke("memory:removeAll", workdir),
  memoryMigrateLegacy: (workdir) => import_electron.ipcRenderer.invoke("memory:migrate", workdir),
  // —— 记忆 v2 的目录后端（两类存储根 + 子目录 + 原子替换 + JSONL 追行）——
  // `dirRef` 是 `{kind:'workspace'|'user', …}` 的普通对象，可结构化克隆；
  // 主进程重新解析绝对路径并做越界断言，渲染层传什么都越不过白名单。
  memoryListDir: (dirRef, subdir) => import_electron.ipcRenderer.invoke("memory:listDir", dirRef, subdir),
  memoryReadDirFile: (dirRef, name, subdir) => import_electron.ipcRenderer.invoke("memory:readDirFile", dirRef, name, subdir),
  memoryWriteDirFile: (dirRef, name, content, subdir) => import_electron.ipcRenderer.invoke("memory:writeDirFile", dirRef, name, content, subdir),
  memoryRemoveDirFile: (dirRef, name, subdir) => import_electron.ipcRenderer.invoke("memory:removeDirFile", dirRef, name, subdir),
  memoryReplaceDirFile: (dirRef, name, content, subdir) => import_electron.ipcRenderer.invoke("memory:replaceDirFile", dirRef, name, content, subdir),
  memoryAppendDirLine: (dirRef, name, line, subdir) => import_electron.ipcRenderer.invoke("memory:appendDirLine", dirRef, name, line, subdir),
  memoryReadDirLines: (dirRef, name, subdir) => import_electron.ipcRenderer.invoke("memory:readDirLines", dirRef, name, subdir),
  artifactIndexPut: (entry) => import_electron.ipcRenderer.invoke("artifactIndex:put", entry),
  artifactIndexRemove: (id) => import_electron.ipcRenderer.invoke("artifactIndex:remove", id),
  nanobotStart: () => import_electron.ipcRenderer.invoke("nanobot:start"),
  nanobotStop: () => import_electron.ipcRenderer.invoke("nanobot:stop"),
  nanobotStatus: () => import_electron.ipcRenderer.invoke("nanobot:status"),
  nanobotGatewayInfo: () => import_electron.ipcRenderer.invoke("nanobot:gatewayInfo"),
  nanobotSyncChannels: (channelsJson) => import_electron.ipcRenderer.invoke("nanobot:syncChannels", channelsJson),
  nanobotGetChannels: () => import_electron.ipcRenderer.invoke("nanobot:getChannels"),
  nanobotGetChannelRuntimeStatus: () => import_electron.ipcRenderer.invoke("nanobot:getChannelRuntimeStatus"),
  nanobotSyncMcp: (mcpJson) => import_electron.ipcRenderer.invoke("nanobot:syncMcp", mcpJson),
  nanobotGetMcp: () => import_electron.ipcRenderer.invoke("nanobot:getMcp"),
  /** MCP 连接探针：真实握手拿连接结果与工具清单（凭据由主进程从保险库补齐） */
  mcpProbe: (request) => import_electron.ipcRenderer.invoke("mcp:probe", request),
  // —— 模型设置（config.json 的 modelPresets + providers）——
  nanobotGetModels: () => import_electron.ipcRenderer.invoke("nanobot:getModels"),
  nanobotSyncModels: (mutationJson) => import_electron.ipcRenderer.invoke("nanobot:syncModels", mutationJson),
  // —— FR-8.4 写策略（config.json 的 tools.file）——
  nanobotGetTools: () => import_electron.ipcRenderer.invoke("nanobot:getTools"),
  nanobotSyncTools: (mutationJson) => import_electron.ipcRenderer.invoke("nanobot:syncTools", mutationJson),
  probeModel: (request) => import_electron.ipcRenderer.invoke("model:probe", request),
  /** 凭据保险库：可用性 / key 名清单 / 写入 / 删除（**密钥值不回传**） */
  secretsStatus: () => import_electron.ipcRenderer.invoke("secrets:status"),
  secretsKeys: () => import_electron.ipcRenderer.invoke("secrets:keys"),
  secretsSet: (name, secrets) => import_electron.ipcRenderer.invoke("secrets:set", name, secrets),
  secretsDelete: (name) => import_electron.ipcRenderer.invoke("secrets:delete", name),
  nanobotSyncSkills: (overridesJson) => import_electron.ipcRenderer.invoke("nanobot:syncSkills", overridesJson),
  nanobotSyncTasks: (tasksJson) => import_electron.ipcRenderer.invoke("nanobot:syncTasks", tasksJson),
  nanobotListCronRuns: () => import_electron.ipcRenderer.invoke("nanobot:listCronRuns"),
  nanobotGetCronSession: (taskId) => import_electron.ipcRenderer.invoke("nanobot:getCronSession", taskId),
  nanobotDeleteCronHistory: (taskId) => import_electron.ipcRenderer.invoke("nanobot:deleteCronHistory", taskId),
  nanobotListChannelSessions: () => import_electron.ipcRenderer.invoke("nanobot:listChannelSessions"),
  nanobotGetChannelSession: (key) => import_electron.ipcRenderer.invoke("nanobot:getChannelSession", key),
  nanobotSendChannelMessage: (params) => import_electron.ipcRenderer.invoke("nanobot:sendChannelMessage", params),
  nanobotChannelConnect: (action, channel, params) => import_electron.ipcRenderer.invoke("nanobot:channelConnect", action, channel, params),
  nanobotRestartGateway: (engineChannel) => import_electron.ipcRenderer.invoke("nanobot:restartGateway", engineChannel),
  nanobotDisconnectChannel: (kind) => import_electron.ipcRenderer.invoke("nanobot:disconnectChannel", kind),
  /** 在系统文件管理器中打开路径（资源管理器/Finder） */
  openPath: (path) => import_electron.ipcRenderer.invoke("shell:openPath", path),
  /** 用系统默认浏览器打开 http(s) 链接（主进程侧有协议白名单） */
  openUrl: (url) => import_electron.ipcRenderer.invoke("shell:openUrl", url),
  /** 读取本地文件为 base64（复制消息粘贴恢复附件用） */
  readFileAsBase64: (path) => import_electron.ipcRenderer.invoke("fs:readFileAsBase64", path),
  // ⚠️ `workspace` 必须透传：丢掉它主进程就只会扫用户级目录，
  // 项目级技能（`<workspace>/skills`）会静默消失（界面上看不出任何异常）。
  loadUserSkills: (workspace) => import_electron.ipcRenderer.invoke("skills:loadUser", workspace),
  pickDirectory: () => import_electron.ipcRenderer.invoke("dialog:pickDirectory"),
  pickFile: () => import_electron.ipcRenderer.invoke("dialog:pickFile"),
  // —— 插件包生命周期（FR-3.4）：只做文件系统那一半 ——
  // 激活状态走引擎的 /v1/plugins，不经 IPC——引擎才是权威。
  pluginsScan: () => import_electron.ipcRenderer.invoke("plugins:scan"),
  pluginsInstall: (sourceDir, overwrite) => import_electron.ipcRenderer.invoke("plugins:install", sourceDir, overwrite),
  pluginsUninstall: (name) => import_electron.ipcRenderer.invoke("plugins:uninstall", name),
  // —— 市场注册表与版本化缓存（FR-3.7 / FR-3.8）——
  pluginsMarkets: () => import_electron.ipcRenderer.invoke("plugins:markets"),
  pluginsMarketsUpsert: (entry) => import_electron.ipcRenderer.invoke("plugins:marketsUpsert", entry),
  pluginsMarketsRemove: (id) => import_electron.ipcRenderer.invoke("plugins:marketsRemove", id),
  pluginsMarketsSync: (id) => import_electron.ipcRenderer.invoke("plugins:marketsSync", id),
  pluginsMarketPackages: (market) => import_electron.ipcRenderer.invoke("plugins:marketPackages", market),
  pluginsMarketInstall: (market, name, version) => import_electron.ipcRenderer.invoke("plugins:marketInstall", market, name, version),
  pluginsMarketGc: (referenced, keepDays) => import_electron.ipcRenderer.invoke("plugins:marketGc", referenced, keepDays),
  // —— 可观测性（FR-11.2 / FR-11.3）——
  // 日志与 trace 都是 **fire-and-forget**（`send` 而不是 `invoke`）：它们是旁路，
  // 不该给渲染层造出 await 点；主进程侧全部自行吞错（写不进去就是写不进去，
  // 不能回头把用户的这一轮对话打挂）。
  appendLog: (entry) => import_electron.ipcRenderer.send("log:append", entry),
  writeTrace: (file) => import_electron.ipcRenderer.send("trace:write", file),
  diagnosticsStats: () => import_electron.ipcRenderer.invoke("diagnostics:stats"),
  exportDiagnostics: () => import_electron.ipcRenderer.invoke("diagnostics:export"),
  /** FR-8.9 工具网关审计日志：读 `<data_dir>/audit/tool-gateway.ndjson` 的 NDJSON 文本 */
  auditRead: () => import_electron.ipcRenderer.invoke("audit:read"),
  // ——— 窗口控制（自绘标题栏）———
  windowMinimize: () => import_electron.ipcRenderer.send("window:minimize"),
  windowToggleMaximize: () => import_electron.ipcRenderer.send("window:toggle-maximize"),
  windowClose: () => import_electron.ipcRenderer.send("window:close"),
  windowIsMaximized: () => import_electron.ipcRenderer.invoke("window:isMaximized"),
  windowReload: () => import_electron.ipcRenderer.send("window:reload"),
  windowToggleDevTools: () => import_electron.ipcRenderer.send("window:toggle-devtools"),
  windowToggleFullScreen: () => import_electron.ipcRenderer.send("window:toggle-fullscreen"),
  getPlatform: () => process.platform,
  onWindowMaximizeChange: (cb) => import_electron.ipcRenderer.on("window:maximize-change", (_e, maximized) => cb(maximized)),
  appGetInfo: () => import_electron.ipcRenderer.invoke("app:getInfo"),
  /** 本地存储信息（缓存目录 / 占用 / 卷容量）；ensureDefaultWorkspace 见 platform/types */
  appGetStorageInfo: (ensureDefaultWorkspace) => import_electron.ipcRenderer.invoke("app:getStorageInfo", ensureDefaultWorkspace),
  // —— 桌面端集成：系统托盘 & 全局快捷键 ——
  appGetDesktopConfig: () => import_electron.ipcRenderer.invoke("app:getDesktopConfig"),
  appSetDesktopConfig: (patch) => import_electron.ipcRenderer.invoke("app:setDesktopConfig", patch),
  appShowWindow: () => import_electron.ipcRenderer.send("app:showWindow"),
  appQuit: () => import_electron.ipcRenderer.send("app:quit"),
  onAppNavigate: (cb) => {
    const listener = (_e, path) => cb(path);
    import_electron.ipcRenderer.on("app:navigate", listener);
    return () => import_electron.ipcRenderer.removeListener("app:navigate", listener);
  },
  onAppOpenAbout: (cb) => {
    const listener = () => cb();
    import_electron.ipcRenderer.on("app:open-about", listener);
    return () => import_electron.ipcRenderer.removeListener("app:open-about", listener);
  },
  onDesktopConfigChange: (cb) => {
    const listener = (_e, config) => cb(config);
    import_electron.ipcRenderer.on("app:desktop-config-changed", listener);
    return () => import_electron.ipcRenderer.removeListener("app:desktop-config-changed", listener);
  },
  onSkillsChanged: (cb) => {
    const listener = () => cb();
    import_electron.ipcRenderer.on("skills:changed", listener);
    return () => import_electron.ipcRenderer.removeListener("skills:changed", listener);
  }
};
import_electron.contextBridge.exposeInMainWorld("electronAPI", api);
