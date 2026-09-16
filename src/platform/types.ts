import type { ChannelConnectResponse, McpToolInfo, Skill } from '@/types';
import type {
  SessionEvent,
  SessionIndexFile,
  SessionMeta,
} from '@/types/event';

/** nanobot channels 同步结果（主进程返回） */
export interface ChannelSyncResult {
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false，渲染层可据此静默） */
  changed?: boolean;
  /** 配置已写入但网关由外部进程托管，需用户自行重启网关才生效 */
  needsRestart?: boolean;
}

/** nanobot MCP 同步结果（主进程返回） */
export interface MCPSyncResult {
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false） */
  changed?: boolean;
  /** 已写入但 serve 由外部进程托管，需用户自行重启才生效 */
  needsRestart?: boolean;
}

/** nanobot config.json 的 mcpServers 段原始快照（只读回读用） */
export type NanobotMcpSnapshot = Record<string, unknown>;

/** MCP 传输类型（与 `@/types` 的 MCPTransport 对齐的最小形态） */
export type McpProbeTransport = 'url' | 'command';

/**
 * MCP 连接探针请求（渲染层 → 主进程）。
 *
 * **刻意不含凭据**：密钥只存在主进程的保险库里，探针按 `name` 去取。
 * 渲染层多传一份明文，就等于把「凭据加密」这条设计从中间拆断。
 */
export interface McpProbeRequest {
  /** server 名：既是回显标识，也是主进程查凭据的键 */
  name: string;
  transport: McpProbeTransport;
  /** url 模式的地址 */
  endpoint?: string;
  /** command 模式的启动命令（含空格分隔的 args） */
  command?: string;
  /** url 模式的传输类型（`sse` 才允许降级走老式 GET 握手） */
  urlType?: 'sse' | 'streamableHttp';
  /** 超时（毫秒），缺省由主进程用 8000 */
  timeoutMs?: number;
}

/**
 * `tools/list` 返回的一条工具。
 * 直接复用渲染层领域类型：探针结果是**同一个事实**，两处各声明一份必然漂移
 * （症状是"界面能渲染、类型对不上"）。
 */
export type McpProbeTool = McpToolInfo;

/** MCP 连接探针结果 */
export interface McpProbeResult {
  ok: boolean;
  status: 'connected' | 'error';
  /** 服务端暴露的工具清单（`ok=false` 时为空） */
  tools: McpProbeTool[];
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  /** `ok=false` 时的可读原因（超时 / HTTP 码 / 子进程 stderr 摘要） */
  error?: string;
  /** 从发起握手到得出结论的耗时 */
  latencyMs: number;
}

/** 凭据保险库状态（可用性用来提示用户「本机没有系统凭据库」） */
export interface CredentialVaultStatus {
  available: boolean;
  /** 保险库文件路径（仅供界面展示，便于用户定位/备份） */
  path: string;
}

/** 凭据写入结果 */
export interface SecretWriteResult {
  ok: boolean;
  error?: string;
}

/**
 * 技能三态覆盖同步结果（FR-3.1）。
 *
 * 与 `MCPSyncResult` 同形但独立命名：语义不同（技能覆盖不需要重启也能被
 * 下一轮请求读到，因为网关每轮都重读 config），未来若把「无需重启」这条
 * 落到返回里，不至于因为共用类型而牵动 MCP 的行为。
 */
export interface SkillOverrideSyncResult {
  ok: boolean;
  message: string;
  /** 覆盖表是否实际发生变更（幂等校准时为 false） */
  changed?: boolean;
  /** 已写入但网关由外部进程托管，需用户自行重启才生效 */
  needsRestart?: boolean;
}

/** nanobot 定时任务同步结果（主进程返回） */
export interface TaskSyncResult {
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false，渲染层可据此静默） */
  changed?: boolean;
}

/**
 * nanobot cron 执行审计记录（主进程扫描 {workspace}/cron/runs/ 返回）。
 * 对应引擎 bound_runner 每次执行写入的一个 JSON 文件。
 */
export interface NanobotCronRunRecord {
  /** 引擎生成的运行 id（{jobId}:{timestamp}:{rand}） */
  runId: string;
  /** 关联的定时任务 id */
  jobId: string;
  /** 任务名称 */
  jobName: string;
  /** 绑定的会话键 */
  sessionKey: string;
  /** 执行状态：queued=排队中；ok=成功；error=失败 */
  status: 'queued' | 'ok' | 'error';
  /** 失败原因（status=error 时） */
  error?: string;
  /** 引擎回复正文（status=ok 时） */
  response?: string;
  /** 记录更新时间戳（毫秒） */
  updatedAtMs: number;
}

/**
 * nanobot IM 频道会话摘要（主进程扫描 sessions 目录返回）。
 * 对应磁盘上一个 `{base64url(channel:chat_id)}.jsonl` 文件。
 */
export interface NanobotChannelSessionSummary {
  /** nanobot session key，形如 `feishu.feishu:ou_xxx` / `dingtalk:cidxxx` */
  key: string;
  /** 渠道名（key 冒号前段，如 feishu.feishu / dingtalk / websocket） */
  channel: string;
  /** 会话标题（metadata.title 或首条用户消息摘要） */
  title: string;
  /** 列表预览文本（首条用户消息） */
  preview: string;
  /** 消息条数（不含 metadata / provider_state 记录） */
  messageCount: number;
  /** 创建时间 ISO */
  createdAt: string;
  /** 最近更新时间 ISO */
  updatedAt: string;
}

/** nanobot IM 频道会话详情（含完整历史消息行） */
export interface NanobotChannelSessionDetail
  extends NanobotChannelSessionSummary {
  /** JSONL 消息行原始记录（role/content/timestamp/tool_calls 等） */
  messages: Record<string, unknown>[];
}

/**
 * nanobot 定时任务（cron）执行会话详情。
 * 引擎以 `api:cron-{taskId}` 会话键执行定时任务并落盘 JSONL，
 * 运行记录展开时经主进程只读拉取，用于展示完整执行过程。
 */
export interface NanobotCronSessionDetail {
  /** nanobot session key（`api:cron-{taskId}`） */
  key: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 最近更新时间 ISO */
  updatedAt: string;
  /** 消息条数（不含 metadata / provider_state 记录） */
  messageCount: number;
  /** JSONL 消息行原始记录（role/content/tool_calls 等） */
  messages: Record<string, unknown>[];
}

/**
 * 删除定时任务执行留痕的结果。
 *
 * 「从列表中移除」自动任务分组时要真正清掉该任务的执行记录，而记录的
 * **唯一数据源在引擎磁盘上**（`cron/runs/*.json` 审计文件 + `api:cron-{taskId}`
 * 会话 JSONL）——渲染层每 15s 以审计目录为准重建执行记录，只删本地会话
 * 会在下一次轮询或重启后原样复现。因此该操作由主进程完成。
 *
 * 只清「执行痕迹」，不动任务本身：任务仍在 jobs.json 里按计划执行，
 * 下次触发会产生全新的审计文件与会话文件。
 */
export interface NanobotCronHistoryDeleteResult {
  /** 是否全部删除成功（部分失败时为 false，失败项写入 error） */
  ok: boolean;
  /** 实际删除的文件数（审计文件 + 会话文件） */
  removed: number;
  /** 失败描述（ok=true 时缺省） */
  error?: string;
}

/**
 * nanobot config.json 的 channels 段原始快照（只读回读用）。
 * 键为渠道名（dingtalk / feishu / weixin / wecom 等），
 * 值为该渠道的配置对象（feishu 含 instances 多实例数组）。
 */
export type NanobotChannelsSnapshot = Record<string, unknown>;

/** 智能体侧主动发送到 IM 频道用户的参数 */
export interface ChannelSendParams {
  /** nanobot 渠道名（session key 冒号前段，如 feishu.feishu） */
  channel: string;
  /** IM 会话 id（session key 冒号后段，如飞书 open_id） */
  chatId: string;
  /** 消息正文 */
  content: string;
}

/** 智能体侧主动发送结果 */
export interface ChannelSendResult {
  ok: boolean;
  /** 失败原因（ok=false 时） */
  error?: string;
}

/** 扫码接入动作（网关 settings.channel.connect.{action}） */
export type ChannelConnectAction = 'start' | 'poll' | 'cancel';

/** 网关重启 / 拉起结果（needsRestart：外部托管需用户手动重启） */
export interface GatewayRestartResult {
  ok: boolean;
  message: string;
  needsRestart?: boolean;
}

/**
 * Platform 适配层接口定义。
 * 渲染层只依赖这里的抽象（StorageAdapter / PlatformAdapter），
 * 永不直接 import 'electron'。所有环境差异在 platform/ 内部消化。
 */

/**
 * 统一异步存储适配器（Zustand persist 与业务层共用）。
 *
 * 契约是「写进去什么、读出来什么」，**不约定后端的具体表示**：
 * - electron：桥接层按文本传递，落盘为 ① `~/.nanowork/` 或 ② userData 下的文件；
 * - web：localStorage，值会带一层 JSON 转义（实现细节，调用方不得依赖）。
 * 实际调用方一律按字符串取用（`get<string>`）。
 */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** 平台适配实现（web / electron） */
export interface PlatformAdapter {
  env: 'web' | 'electron';
  storage: StorageAdapter;
  notify(title: string, body: string): void;
  /**
   * 写入文本文件（用于导出记忆、nanobot 配置片段等）。
   * - electron：**相对路径**解析到产品自有目录 `~/.nanowork/`（如 `MEMORY.md`
   *   → `~/.nanowork/MEMORY.md`）；绝对路径须落在用户主目录 / userData /
   *   `~/.nanowork/` 内，越界一律拒绝；
   * - web：降级为浏览器下载（path 仅作为下载文件名）。
   */
  writeTextFile(path: string, content: string): Promise<void>;
  /**
   * 读取本地技能目录并解析 SKILL.md。
   * - electron：扫描磁盘（用户级 `~/.nanowork/skills`，以及给了 workspace 时的
   *   项目级 `<workspace>/skills`）并解析，返回结果带 `scope` 区分层级；
   * - web：降级为空数组（Web 端通过文件选择或内置技能使用）。
   * @param workspace 当前工作区绝对路径；省略则只扫用户级目录
   */
  loadUserSkills(workspace?: string): Promise<Skill[]>;
  /**
   * 订阅技能目录变更（主进程 fs.watch 推送，已防抖），用于热加载。
   * - electron：主进程推送 `skills:changed`；
   * - web：无文件系统可监听，返回一个空的取消订阅函数。
   */
  onSkillsChanged(cb: () => void): () => void;
  /**
   * 弹出系统目录选择器，返回所选目录绝对路径。
   * - electron：原生 dialog.showOpenDialog；
   * - web：File System Access API（不支持的浏览器返回 null）。
   * 用户取消或环境不支持时返回 null。
   */
  pickDirectory(): Promise<string | null>;
  /**
   * 将 MCP Server 片段同步进 nanobot 运行时（合并写入 config.json 的
   * `tools.mcpServers`，并按需重启 serve 子进程）。
   * - electron：主进程完成合并与按需重启，返回结果；
   * - web：无文件系统权限，降级为下载片段文件并返回 needsRestart。
   */
  syncNanobotMcp(mcpJson: string): Promise<MCPSyncResult>;
  /**
   * 将技能三态覆盖同步进 nanobot 运行时（合并写入 config.json 的
   * `agents.defaults.skillOverrides`，并按需重启网关）。
   *
   * 这是三态真正生效的通道：不推的话，界面上「停用」只是本地不显示，
   * 引擎照旧把该技能列进模型的可用技能清单。
   * - electron：主进程完成合并与按需重启，返回结果；
   * - web：无文件系统权限，降级为下载片段文件并返回 needsRestart。
   */
  syncNanobotSkills(overridesJson: string): Promise<SkillOverrideSyncResult>;
  /**
   * 只读回读 nanobot config.json 的 `tools.mcpServers` 段（用于本地配置缺失时回显）。
   * - electron：主进程读取磁盘；
   * - web：无文件系统权限，返回 null。
   */
  getNanobotMcp(): Promise<NanobotMcpSnapshot | null>;
  /**
   * MCP 连接探针：真实握手（`initialize` + `tools/list`），返回连接结果与工具清单。
   * - electron：主进程按传输类型跑探针（stdio spawn / http POST），凭据取自主进程保险库；
   * - web：无本地进程与系统凭据库，返回 `ok=false` 并说明不支持。
   */
  probeMcpServer(request: McpProbeRequest): Promise<McpProbeResult>;
  /**
   * 凭据保险库可用性（加密是否可用，以及保险库落点）。
   * - electron：`safeStorage.isEncryptionAvailable()`；
   * - web：恒为 `available=false`（浏览器无 OS 凭据库）。
   */
  secretsStatus(): Promise<CredentialVaultStatus>;
  /**
   * 已配置凭据的 **key 名清单**（`{ serverName: ['token'] }`）。
   * 只回传名字、**不回传值**——值一旦回传渲染层，加密就白做了。
   * - web：恒为空对象。
   */
  secretsKeys(): Promise<Record<string, string[]>>;
  /**
   * 整条替换某个 server 的凭据；传空对象等于删除该条。
   * 加密不可用时**拒绝写入**（fail-closed），返回 `ok=false` 与原因。
   * - web：`ok=false`（不支持）。
   */
  secretsSet(name: string, secrets: Record<string, string>): Promise<SecretWriteResult>;
  /**
   * 删除某个 server 的凭据（幂等）。
   * - web：视为已删（`ok=true`）。
   */
  secretsDelete(name: string): Promise<SecretWriteResult>;
  /**
   * 将 channels 配置片段同步进 nanobot 运行时（合并写入 config.json 并重启网关）。
   * - electron：主进程完成合并与重启，返回结果；
   * - web：无文件系统权限，降级为下载片段文件并返回 needsRestart。
   */
  syncNanobotChannels(channelsJson: string): Promise<ChannelSyncResult>;
  /**
   * 只读回读 nanobot config.json 的 channels 段（用于本地配置缺失时回显）。
   * - electron：主进程读取磁盘；
   * - web：无文件系统权限，返回 null。
   */
  getNanobotChannels(): Promise<NanobotChannelsSnapshot | null>;
  /**
   * 将定时任务片段同步进 nanobot 运行时（幂等合并写入
   * `{workspace}/cron/jobs.json` 并通知 gateway 热加载）。
   * - electron：主进程完成合并与热加载，返回结果；
   * - web：无文件系统权限，降级为下载片段文件。
   */
  syncNanobotTasks(tasksJson: string): Promise<TaskSyncResult>;
  /**
   * 列出 nanobot cron 执行审计记录（只读扫描 {workspace}/cron/runs/）。
   * - electron：主进程读取磁盘；
   * - web：无文件系统权限，返回空数组。
   */
  listNanobotCronRuns(): Promise<NanobotCronRunRecord[]>;
  /**
   * 读取定时任务执行会话的完整历史（只读，`api:cron-{taskId}` 会话键）。
   * - electron：主进程读取对应 JSONL；
   * - web：无文件系统权限，返回 null。
   */
  getCronSession(taskId: string): Promise<NanobotCronSessionDetail | null>;
  /**
   * 删除某个定时任务的全部执行留痕（不可撤销）。
   * - electron：主进程删除会话 JSONL 与 `cron/runs/` 下的审计文件；
   * - web：无文件系统权限，视为已删除（返回 ok=true, removed=0）。
   */
  deleteNanobotCronHistory(taskId: string): Promise<NanobotCronHistoryDeleteResult>;
  /**
   * 列出 nanobot 磁盘上的 IM 频道会话摘要（只读扫描 sessions 目录）。
   * - electron：主进程读取磁盘；
   * - web：无文件系统权限，返回空数组。
   */
  listNanobotChannelSessions(): Promise<NanobotChannelSessionSummary[]>;
  /**
   * 读取单个 IM 频道会话的完整历史（只读）。
   * @param key nanobot session key（`channel:chat_id`）
   * - electron：主进程读取对应 JSONL；
   * - web：返回 null。
   */
  getNanobotChannelSession(
    key: string,
  ): Promise<NanobotChannelSessionDetail | null>;
  /**
   * 智能体侧主动发送消息到 IM 频道用户（经 gateway /v1/send 出站）。
   * - electron：主进程 HTTP 调用 gateway；
   * - web：无 gateway 访问能力，返回失败。
   */
  sendChannelMessage(params: ChannelSendParams): Promise<ChannelSendResult>;
  /**
   * IM 渠道扫码接入（经主进程认证 WS 桥调网关 settings.channel.connect.*）。
   * - electron：主进程签发 token 并经 webui WebSocket 发 mutation 帧；
   * - web：无法访问本地网关，返回失败。
   */
  channelConnect(
    action: ChannelConnectAction,
    channel: string,
    params?: Record<string, string>,
  ): Promise<ChannelConnectResponse>;
  /**
   * 强制重启本地网关（绕过 channels 同步幂等短路，加载后端写入的新通道）。
   * - electron：主进程重启 / 拉起网关子进程；外部托管时返回 needsRestart；
   *   可选 engineChannel 非空时，重启前先确保该渠道在 config.json 中启用（双保险）；
   * - web：无网关控制权，返回失败（忽略 engineChannel）。
   * @param engineChannel 引擎渠道名（如 weixin / feishu）
   */
  restartNanobotGateway(engineChannel?: string): Promise<GatewayRestartResult>;
  /**
   * 断开已连接扫码渠道（清除凭证 + 停用渠道 + 重启网关，卡片回到可重新扫码状态）。
   * - electron：主进程清 config.json 凭证（微信另删 weixin/account.json 状态文件）并重启网关；
   *   外部托管网关时返回 needsRestart；
   * - web：无文件系统权限，返回失败。
   * @param kind 渠道 kind（weixin / feishu / lark；手动配置渠道无断开路径）
   */
  disconnectChannel(kind: string): Promise<GatewayRestartResult>;
  /**
   * 在系统文件管理器中打开路径（Windows 资源管理器 / macOS Finder / Linux 文件管理器）。
   * - electron：主进程调 shell.openPath；
   * - web：无原生能力，返回失败。
   * @param path 绝对路径；不存在或打开失败时返回 ok=false 与原因
   */
  openPath(path: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * 读取本地文件为 base64（复制消息后粘贴恢复附件内容用）。
   * - electron：主进程 fs.readFile；
   * - web：无文件系统权限，返回 ok=false。
   */
  readFileAsBase64(path: string): Promise<ReadFileBase64Result>;
}

/** 本地文件 base64 读取结果 */
export interface ReadFileBase64Result {
  ok: boolean;
  base64?: string;
  size?: number;
  error?: string;
}

/**
 * Electron 主进程经 preload 暴露到 window 的桥接口。
 * 渲染层仅通过 platform 调用，不直接接触。
 */
/** 运行平台标识（与主进程 process.platform 对齐） */
export type PlatformName = 'win32' | 'darwin' | 'linux';

/** 应用元信息（主进程 app:getInfo 返回） */
export interface AppInfo {
  appName: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: PlatformName;
  osVersion: string;
  arch: string;
  deviceId: string;
}

/**
 * 桌面端（Electron）专有行为配置。
 * 持久化在渲染层 settings store，主进程启动时从同一份 store 文件回读，
 * 因此冷启动即可按用户偏好注册快捷键 / 应用开机自启。
 */
export interface DesktopConfig {
  /** 点击窗口关闭按钮时最小化到系统托盘；false 则直接退出应用 */
  closeToTray: boolean;
  /**
   * 全局唤起快捷键（Electron accelerator 语法，如 'Ctrl+Alt+S'）。
   * 空串表示禁用全局快捷键。
   */
  hotkey: string;
  /** 开机/登录时自动启动（openAtLogin） */
  openAtLogin: boolean;
  /** macOS：Dock 中是否显示图标；关闭后仅托盘图标可唤起（其它平台忽略） */
  showInDock: boolean;
}

/** 桌面端配置应用结果：携带主进程实际生效值，便于渲染层纠正 UI 状态 */
export interface DesktopConfigResult {
  /** 是否全部应用成功；快捷键被占用或语法非法时为 false */
  ok: boolean;
  /** 失败原因（仅快捷键相关，其余字段不会失败） */
  error?: string;
  /** 主进程实际生效的完整配置 */
  config: DesktopConfig;
}

// ——— D2 事件流桥的入参/出参（渲染层 ↔ 主进程）———

/**
 * 事件流追加参数。
 *
 * 传**领域对象**而非序列化文本：主进程拥有磁盘/线格式（JSONL 逐行编码），
 * 渲染层只表达「发生了什么事件」。这样格式演进只改 eventStore 一处。
 */
export interface EventAppendParams {
  /** 会话 id（单层安全片段，越界由主进程拒绝） */
  sessionId: string;
  /** 所属工作空间：决定 `projects/<slug>/`；缺省归入默认槽 */
  workdir?: string | null;
  /** 本次要追加的事件（按 `seq` 升序） */
  events: SessionEvent[];
}

/** 事件流追加结果：返回该会话最新计数，供渲染层推进续写游标 */
export interface EventAppendResult {
  /** 该会话当前最大 `seq` */
  lastSeq: number;
  /** 该会话累计事件数（来自索引投影） */
  eventCount: number;
}

export interface ElectronAPI {
  storageGet(key: string): Promise<string | null>;
  storageSet(key: string, value: string): Promise<void>;
  storageRemove(key: string): Promise<void>;
  storageClear(): Promise<void>;
  // —— 事件流存储（D2：以 append-only 事件流为事实源）——
  // 主进程拥有磁盘格式：IPC 两侧只传领域对象（事件 / 元数据 / 索引），
  // JSONL 编码、索引投影、容错解析全部封在 electron/eventStore.ts 内。
  /** 追加事件并维护索引；返回最新计数 */
  eventsAppend(params: EventAppendParams): Promise<EventAppendResult>;
  /** 读取会话事件流（主进程解析 JSONL；不存在返回空数组） */
  eventsRead(sessionId: string, workdir?: string | null): Promise<SessionEvent[]>;
  /** 删除会话的事件流与元数据，并移除索引条目（幂等） */
  eventsRemove(sessionId: string, workdir?: string | null): Promise<void>;
  /** 读取会话元数据；不存在返回 null */
  readSessionMeta(sessionId: string, workdir?: string | null): Promise<SessionMeta | null>;
  /** 覆盖写入会话元数据 */
  writeSessionMeta(meta: SessionMeta): Promise<void>;
  /** 扫描全部工作空间目录下的会话元数据（索引重建 / 磁盘发现） */
  listSessionMetas(): Promise<SessionMeta[]>;
  /** 读取会话索引；不存在返回空索引 */
  readSessionIndex(): Promise<SessionIndexFile>;
  /** 全量重建会话索引并落盘；返回重建后的索引 */
  rebuildSessionIndex(): Promise<SessionIndexFile>;
  /** 内容寻址备份：写入 `<hash>.bak`（已存在则跳过） */
  putFileBackup(hash: string, content: string): Promise<void>;
  /** 内容寻址备份：读取 `<hash>.bak`；不存在返回 null */
  getFileBackup(hash: string): Promise<string | null>;
  notify(title: string, body: string): void;
  /** 写入文本文件；相对路径解析到 `~/.nanowork/`，绝对路径须在允许的根内 */
  writeTextFile(path: string, content: string): Promise<void>;
  /** 启动 nanobot 网关子进程（桌面端自动拉起） */
  nanobotStart(): Promise<boolean>;
  /** 停止 nanobot 网关子进程 */
  nanobotStop(): Promise<void>;
  /** 查询 nanobot 网关子进程是否在运行 */
  nanobotStatus(): Promise<boolean>;
  /** 同步 channels 配置片段到 nanobot（主进程合并写入 config.json 并重启网关） */
  nanobotSyncChannels(channelsJson: string): Promise<ChannelSyncResult>;
  /** 只读回读 nanobot config.json 的 channels 段；不存在返回 null */
  nanobotGetChannels(): Promise<NanobotChannelsSnapshot | null>;
  /** 同步 MCP Server 片段到 nanobot（主进程合并写入 tools.mcpServers 并按需重启 serve） */
  nanobotSyncMcp(mcpJson: string): Promise<MCPSyncResult>;
  /** 只读回读 nanobot config.json 的 tools.mcpServers 段；不存在返回 null */
  nanobotGetMcp(): Promise<NanobotMcpSnapshot | null>;
  /** MCP 连接探针（真实握手；凭据由主进程从保险库补齐） */
  mcpProbe(request: McpProbeRequest): Promise<McpProbeResult>;
  /** 凭据保险库可用性与落点 */
  secretsStatus(): Promise<CredentialVaultStatus>;
  /** 凭据 key 名清单（不含值） */
  secretsKeys(): Promise<Record<string, string[]>>;
  /** 写入某 server 的凭据（空对象即删除） */
  secretsSet(name: string, secrets: Record<string, string>): Promise<SecretWriteResult>;
  /** 删除某 server 的凭据 */
  secretsDelete(name: string): Promise<SecretWriteResult>;
  /** 同步技能三态覆盖到 nanobot（主进程合并写入 agents.defaults.skillOverrides 并按需重启） */
  nanobotSyncSkills(overridesJson: string): Promise<SkillOverrideSyncResult>;
  /** 同步定时任务片段到 nanobot（主进程合并写入 jobs.json 并通知热加载） */
  nanobotSyncTasks(tasksJson: string): Promise<TaskSyncResult>;
  /** 列出 nanobot cron 执行审计记录（只读） */
  nanobotListCronRuns(): Promise<NanobotCronRunRecord[]>;
  /** 读取定时任务执行会话完整历史（只读）；不存在返回 null */
  nanobotGetCronSession(taskId: string): Promise<NanobotCronSessionDetail | null>;
  /** 删除定时任务执行留痕（审计文件 + 会话 JSONL，不可撤销） */
  nanobotDeleteCronHistory(taskId: string): Promise<NanobotCronHistoryDeleteResult>;
  /** 列出 nanobot 磁盘上的 IM 频道会话摘要（只读） */
  nanobotListChannelSessions(): Promise<NanobotChannelSessionSummary[]>;
  /** 读取单个 IM 频道会话完整历史（只读）；不存在返回 null */
  nanobotGetChannelSession(
    key: string,
  ): Promise<NanobotChannelSessionDetail | null>;
  /** 主动发送消息到 IM 频道用户（gateway /v1/send 出站） */
  nanobotSendChannelMessage(
    params: ChannelSendParams,
  ): Promise<ChannelSendResult>;
  /** 扫码接入（网关认证 WS 桥：settings.channel.connect.{start|poll|cancel}） */
  nanobotChannelConnect(
    action: ChannelConnectAction,
    channel: string,
    params: Record<string, string>,
  ): Promise<ChannelConnectResponse>;
  /** 强制重启 / 拉起网关（绕过同步幂等短路，加载新通道配置）；
   * 可选 engineChannel 非空时，重启前确保该渠道已启用 */
  nanobotRestartGateway(engineChannel?: string): Promise<GatewayRestartResult>;
  /** 断开扫码渠道连接（清凭证 + 停用 + 重启网关；外部托管时 needsRestart） */
  nanobotDisconnectChannel(kind: string): Promise<GatewayRestartResult>;
  /** 在系统文件管理器中打开路径（资源管理器/Finder）；失败返回错误描述 */
  openPath(path: string): Promise<{ ok: boolean; error?: string }>;
  /** 读取本地文件为 base64；失败返回 ok=false 与错误描述 */
  readFileAsBase64(path: string): Promise<ReadFileBase64Result>;
  /** 扫描本地技能目录并解析 SKILL.md（用户级 + 指定工作区的项目级） */
  loadUserSkills(workspace?: string): Promise<Skill[]>;
  /**
   * 订阅技能目录变更（主进程 fs.watch 推送，已防抖）。
   * 用于热加载：用户往目录里丢一个 SKILL.md 后不重进页面也能看到。
   * 返回取消订阅函数。
   */
  onSkillsChanged(cb: () => void): () => void;
  /** 原生目录选择对话框，返回所选目录绝对路径；取消返回 null */
  pickDirectory(): Promise<string | null>;
  /** 窗口最小化 */
  windowMinimize(): void;
  /** 窗口最大化/还原切换 */
  windowToggleMaximize(): void;
  /** 窗口关闭 */
  windowClose(): void;
  /** 查询窗口是否最大化 */
  windowIsMaximized(): Promise<boolean>;
  /** 重新加载窗口 */
  windowReload(): void;
  /** 切换开发者工具 */
  windowToggleDevTools(): void;
  /** 切换全屏 */
  windowToggleFullScreen(): void;
  /** 当前运行平台：'win32' | 'darwin' | 'linux' */
  getPlatform(): PlatformName;
  /** 订阅窗口最大化状态变化（回调收到布尔） */
  onWindowMaximizeChange(cb: (maximized: boolean) => void): void;
  /** 获取应用元信息（名称、版本、各运行时版本、操作系统、持久化设备 ID） */
  appGetInfo(): Promise<AppInfo>;
  // —— 桌面端集成：系统托盘 & 全局快捷键（仅 Electron）——
  /** 读取主进程当前生效的桌面端配置（开机自启取系统真实状态） */
  appGetDesktopConfig(): Promise<DesktopConfig>;
  /** 应用桌面端配置补丁并立即生效，返回主进程实际生效值 */
  appSetDesktopConfig(patch: Partial<DesktopConfig>): Promise<DesktopConfigResult>;
  /** 显示并聚焦主窗口（托盘菜单与全局快捷键共用入口） */
  appShowWindow(): void;
  /** 真正退出应用（绕过「最小化到托盘」） */
  appQuit(): void;
  /** 订阅主进程下发的路由跳转（托盘菜单「打开设置」）；返回取消订阅函数 */
  onAppNavigate(cb: (path: string) => void): () => void;
  /** 订阅主进程下发的「打开关于弹窗」指令（托盘菜单「关于」）；返回取消订阅函数 */
  onAppOpenAbout(cb: () => void): () => void;
  /**
   * 订阅托盘菜单勾选变更推送（用户在托盘里改了开机自启等开关）。
   * 回调仅用于同步 UI，不应再回写主进程，否则会与主进程形成回环。
   * 返回取消订阅函数。
   */
  onDesktopConfigChange(cb: (config: DesktopConfig) => void): () => void;
}

declare global {
  interface Window {
    /** preload 注入；非 Electron 环境不存在 */
    electronAPI?: ElectronAPI;
  }
}
