import type { ArtifactIndexEntry, McpToolInfo, Skill } from '@/types';
import type { PluginInstallResult, PluginScanResult } from '@/types/plugin';
import type {
  SessionEvent,
  SessionIndexFile,
  SessionMeta,
} from '@/types/event';

// 插件领域类型声明在 `@/types/plugin.ts`（**唯一声明处**，主进程也引它）。
// 这里只做转出，让 platform 消费方「只 import 一处」即可拿到完整契约面。
export type {
  InstalledPlugin,
  PluginActivation,
  PluginDrift,
  PluginEngineEntry,
  PluginEngineIndex,
  PluginInstallResult,
  PluginManifest,
  PluginPermissions,
  PluginResourceGroup,
  PluginResourceId,
  PluginScanResult,
  PluginView,
} from '@/types/plugin';

/**
 * 插件启停结果（IPC / 适配层返回）。
 *
 * 与技能三态覆盖的 `SkillOverrideSyncResult` 刻意分开：插件启停**由引擎执行**
 * （指纹绑定的激活标记只能引擎签），客户端只是转达，所以没有「本地已改、
 * 引擎未变」这种中间态，也就没有 `changed` / `needsRestart`。
 */
export interface PluginActionResult {
  ok: boolean;
  /** 失败原因（面向用户，已本地化） */
  error?: string;
}

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
  /**
   * url 模式的传输方式。
   * - 省略 = **自动检测**：POST 被「该地址不接受 POST」类状态码（405/404/406/415/501）
   *   拒掉时，补一次老式 GET 握手；实测结果经 `McpProbeResult.transport` 回传。
   * - `streamableHttp` = 显式声明，**不做降级**（避免对普通 HTTP 端点发起无谓长连接）。
   * - `sse` = 显式声明老式 HTTP+SSE。
   *
   * 之所以缺省是自动而不是「等用户写 sse」：两类端点的 URL 长得一模一样
   * （都可能就是 `/mcp`），光看地址分不出来；而早期实现要求显式声明，
   * 那个字段又没有 UI 入口 ⇒ 粘贴一个老式 SSE 地址 100% 失败。
   */
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
  /**
   * 本次握手**实测**用上的传输方式（`ok=true` 时才有）。
   *
   * 调用方据此把探测结果落进 `MCPConfig.urlType` —— 引擎写出的 `type` 必须
   * 与实际传输一致，否则会得到「测试通过、聊天时引擎连不上」这种最难查的状态。
   */
  transport?: 'sse' | 'streamableHttp';
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

// ——————————————————————————————————————————————
// 模型设置（config.json 的 modelPresets + providers）
//
// 引擎的 HTTP 接口没有「模型设置写入」端点（`webui/settings_models.py` 那套
// 走 WebSocket），所以模型增删只能由主进程直接改 config.json —— 与 channels /
// mcpServers / skillOverrides 同一条链路。
// ——————————————————————————————————————————————

/**
 * 一个 modelPreset 的字段集（camelCase，与磁盘上的 config.json 同形）。
 *
 * ⚠️ **预设没有 `label` 字段**：引擎的 `ModelPresetConfig` 继承的 `Base`
 * 没有开 `extra="allow"`，多写的键会被静默丢弃。所以 `/v1/models` 里
 * `label` 恒等于预设名——**预设名就是模型选择器里显示的那行字**，
 * 改名只能换 key，不能只换展示名。
 */
export interface NanobotModelPreset {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindowTokens: number;
  temperature: number;
  reasoningEffort: string | null;
  /**
   * 能力声明（客户端「高级配置」的三项）。
   *
   * **刻意是可选的**：`agents.defaults` 组的隐式 default 预设、以及本产品上手
   * 之前建下的预设都没有这三个键。缺省语义由 `buildManaged` 按引擎字段默认值
   * 补齐，别在这里写 `false` —— 那会把「没声明过」变成「声明了不支持工具调用」。
   */
  supportsTools?: boolean;
  supportsVision?: boolean;
  customProtocol?: boolean;
}

/** 预设引用到的 providers 条目（回显用，含 key 明文——见 NanobotModelsSnapshot） */
export interface NanobotModelProvider {
  apiKey: string | null;
  apiBase: string | null;
  displayName: string | null;
}

/**
 * 模型设置页需要的引擎侧快照。
 *
 * `providers` **只回传被某个预设引用到的条目**，不是全量 45 个供应商：
 * 全量回传会把一堆从未配置过的供应商连同 null 一起灌进渲染层，
 * 界面要么画出几十行空壳，要么得自己再筛一遍。
 */
export interface NanobotModelsSnapshot {
  /** modelPresets 全量；key = 预设名 = 模型选择器里的 id */
  presets: Record<string, NanobotModelPreset>;
  providers: Record<string, NanobotModelProvider>;
  /** agents.defaults.modelPreset；null = 走隐式 default 预设 */
  defaultPreset: string | null;
}

/**
 * 模型配置的一次变更。
 *
 * 刻意做成**变更指令**而不是「整份预设表回传」：与 `tools.mcpServers`
 * 「nanowork 全权托管、整体替换」不同，`modelPresets` 用户也可能在引擎自己的
 * WebUI 里维护，整体替换会把那些预设静默删掉。逐条变更只动它点名的那一个 key。
 */
export type NanobotModelsMutation =
  | {
      op: 'upsert';
      /** 目标预设名（= 模型名） */
      preset: string;
      /** 改名时的旧预设名；缺省表示新增或原地更新 */
      previousPreset?: string;
      config: NanobotModelPreset;
      /** 供应商凭据；内置供应商只写 apiKey（apiBase 留给引擎注册表默认值） */
      provider?: {
        /** providers 里的 config key（内置为 camelCase，自定义为 slug） */
        key: string;
        apiKey?: string | null;
        apiBase?: string | null;
        displayName?: string | null;
      };
      /** 是否同时把该预设设为默认 */
      setDefault?: boolean;
    }
  | {
      op: 'delete';
      preset: string;
      /** 随之清理的供应商 key；仅当它是自定义供应商且已无人引用时才真的删 */
      providerKey?: string;
    }
  | { op: 'setDefault'; preset: string };

/** 模型配置同步结果（与 MCP / 技能覆盖同形） */
export interface ModelsSyncResult {
  ok: boolean;
  message: string;
  changed?: boolean;
  /** 已写入但 serve 由外部进程托管，需用户自行重启才生效 */
  needsRestart?: boolean;
}

/** 供应商连接测试请求（主进程发起，携带 key，不经过渲染层的网络栈） */
export interface ModelProbeRequest {
  /** 内置供应商的注册表名，或自定义供应商的 config key */
  provider: string;
  /** 自定义供应商必填；内置供应商省略时由主进程查目录取默认地址 */
  apiBase?: string;
  apiKey?: string;
}

export interface ModelProbeResult {
  ok: boolean;
  error?: string;
  /** 探测到的模型 id（按名字排序，最多 200 条，供「模型名称」自动补全） */
  models?: string[];
  latencyMs: number;
  /**
   * 本次探测实际用的是哪来的凭据（**只报来源，绝不回传密钥内容**）：
   * - `request`：表单里填的；
   * - `config`：引擎 config.json 里该供应商已配置的（表单留空时的兜底）；
   * - `null`：一个都没有，发的是裸请求。
   * 界面上用它解释「没填 key 也连上了」以及「401 是谁的 key 被拒」。
   */
  keySource?: 'request' | 'config' | null;
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

/**
 * 扫码接入的**原始**返回（引擎载荷，未解码）。
 *
 * `result` 刻意是 `Record<string, unknown>` 而**不是**具体 wire 形状：这条协议与
 * `/v1/chat/completions` 并列，其字段名只允许出现在 `src/ai/runtime/nanobotHttp/`
 * （ADR-020，CI 检查二）。平台层只搬运不解释——编码与解码都在
 * `nanobotHttp/channelConnect.ts` 的 `channelConnect()` / `decodeChannelConnect()`。
 */
export type ChannelConnectResponse =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

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

/**
 * 工作区记忆的**目录后端**（`<workdir>/.nanowork/memory/`）。
 *
 * ## 为什么不复用 `storage`
 *
 * `storage` 的契约是「一个 key 一个文件，值原样存取」，而工作区记忆是
 * **一个目录、若干按天分片的文件**：需要枚举（记忆页的文件切换器、读取时合并）、
 * 需要按名字粒度的删除（清空整个工作区）。硬塞进 `storage` 只能靠约定
 * `nanowork.memory.<key>.<file>` 这类复合 key 来表达目录结构，而主进程的
 * 路由表是按前缀做字符串拼接的——那会把「目录」这个语义散到三处。
 *
 * ## 契约
 *
 * - `workdir` 为 `null` 表示「会话没有绑定工作目录」，落产品目录下的兜底目录；
 * - 所有名字都是**单段文件名**，不得含分隔符；非法名字一律拒绝（抛错 / 返回空）；
 * - 读取比写入宽松：`list` / `read` 收下目录里所有 `.md`（用户手写的不该被忽略），
 *   写入只接受 `MEMORY.md` 与 `YYYY-MM-DD.md`；
 * - 不存在的目录 / 文件在 `list` / `read` 上是**正常状态**（空数组 / null），
 *   不是错误；能力边界被越过时（非法文件名）才抛错。
 */
export interface WorkspaceMemoryFiles {
  /** 列出该工作区全部记忆文件名（已按注入顺序排序） */
  list(workdir: string | null): Promise<string[]>;
  /** 读取单个记忆文件；不存在返回 null */
  read(workdir: string | null, name: string): Promise<string | null>;
  /** 覆盖写入单个记忆文件（自动创建目录） */
  write(workdir: string | null, name: string, content: string): Promise<void>;
  /** 删除单个记忆文件（幂等） */
  remove(workdir: string | null, name: string): Promise<void>;
  /** 删除该工作区全部记忆文件（不可撤销）；返回删除个数 */
  removeAll(workdir: string | null): Promise<number>;
  /**
   * 旧单文件落点的懒迁移（幂等）。
   * 目录里已有记忆时直接返回空数组，不会覆盖用户在新目录里的编辑。
   * @returns 本次新写入的文件名
   */
  migrateLegacy(workdir: string | null): Promise<string[]>;
}

/**
 * 记忆存储的**根标识**（记忆 v2）。
 *
 * 存在的理由：v1 的每个方法都是 `(workdir, …)`，把「存储根」与「怎么定位」焊死在一起。
 * v2 有**两类根**（跟着工作目录走的、跟着用户走的），继续用 `workdir` 表达只能靠往里
 * 塞伪路径——那是把「根」这个语义散进调用方。故显式建一个判别联合。
 *
 * - `workspace`：`<workdir>/.nanowork/memory/`；`workdir` 为 `null` 表示会话没绑工作目录，
 *   落产品目录下的兜底位置（`~/.nanowork/memory/default/`）——**与 v1 一致**；
 * - `user`：`~/.nanowork/user-memory/<scope-id>/`；`userScope` 由 `ensureLocalUserScope()`
 *   生成并持久化，**与登录态解耦**（详见 `docs/architecture-memory-v2.md` §4.7.0）。
 */
export type MemoryDirRef =
  | { kind: 'workspace'; workdir: string | null }
  | { kind: 'user'; userScope: string };

/**
 * 记忆目录后端的**v2 能力**（子目录 / 原子替换 / JSONL 追行）。
 *
 * 与 `WorkspaceMemoryFiles` 的关系：后者是 v1 的根级读写面，继续保留以兼容既有调用点与
 * 测试；本接口补齐 v2 需要的三类能力。两者共用 `src/lib/memoryPaths.ts` 的文件名策略，
 * 差异只在能力面，不在语义。
 */
export interface MemoryDirFiles {
  /** 列出某个记忆目录（可带子目录）里的文件名；目录不存在返回空数组（正常状态，不是错误） */
  listDir(dirRef: MemoryDirRef, subdir?: string): Promise<string[]>;
  /** 读取单个文件（可带子目录）；不存在 / 非普通文件返回 null */
  readDirFile(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<string | null>;
  /** 覆盖写入单个文件（可带子目录）；名字必须过写入白名单，否则抛错 */
  writeDirFile(
    dirRef: MemoryDirRef,
    name: string,
    content: string,
    subdir?: string,
  ): Promise<void>;
  /** 删除单个文件（幂等） */
  removeDirFile(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<void>;
  /** 原子替换（见 `PlatformAdapter.memoryReplaceDirFile` 的说明） */
  replaceDirFile(
    dirRef: MemoryDirRef,
    name: string,
    content: string,
    subdir?: string,
  ): Promise<void>;
  /** 追加一行（JSONL） */
  appendDirLine(dirRef: MemoryDirRef, name: string, line: string, subdir?: string): Promise<void>;
  /** 读取整份 JSONL */
  readDirLines(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<string[]>;
}

/**
 * 产物索引的**目录后端**（`<userData>/artifact-index/<id>.json`，FR-7.2）。
 *
 * ## 为什么不复用 `storage`
 *
 * 与 `WorkspaceMemoryFiles` 同因：这是「一个目录、若干按 id 命名的文件」，
 * `storage` 的「一个 key 一个文件」契约表达不了；更关键的是它**不是权威**——
 * 产物索引的权威是 store 索引切片（Web 端没有文件系统也要能检索），这里只是
 * Electron 的**单向镜像**（写下去供诊断 / 迁移 / 未来的产物同步取用）。
 *
 * ## 契约
 *
 * - **单向**：只有 `put` / `remove`，**没有读**——本批没有任何回读入口，
 *   不提供就不会有人误把它当第二权威；
 * - **失败可容忍**：镜像写失败不影响入库（调用方 `.catch()` 静默），
 *   索引切片才是权威；
 * - **web 端是 no-op**：无文件系统，两个方法都直接 resolve。
 */
export interface ArtifactIndexFiles {
  /** 写入/覆盖单条索引（按 `entry.id` 命名）；Web 端 no-op */
  put(entry: ArtifactIndexEntry): Promise<void>;
  /** 删除单条索引（幂等）；Web 端 no-op */
  remove(id: string): Promise<void>;
}

/**
 * 内容寻址文件备份（FR-7.3 文件级回滚）。
 *
 * ## 与 `ArtifactIndexFiles` 同层
 *
 * 也是「一个 key（这里是 `hash`）一个文件」的目录后端，落点 `<userData>/file-history/
 * <hash>.bak`（Electron）；但它是**回滚锚点**，不是索引。Web 端同样是 no-op。
 *
 * ## 契约
 *
 * - **内容寻址**：`put(hash, content)` 按 `hash` 命名文件；同 hash 即同内容，天然幂等
 *   （主进程 `file-backup:put` 对已存在文件直接跳过）；
 * - **失败可容忍**：调用方（MemoryService prebackup）应 `try/catch` 包住，备份失败
 *   绝不影响真实写入；
 * - **web 端是 no-op**：`get` 返回 `null`，记忆页据此禁用回滚 UI。
 */
export interface FileBackup {
  /** 写入/覆盖一份内容寻址备份；Web 端 no-op */
  put(hash: string, content: string): Promise<void>;
  /** 读取备份；不支持时返回 null */
  get(hash: string): Promise<string | null>;
}

/** 平台适配实现（web / electron） */
export interface PlatformAdapter {
  env: 'web' | 'electron';
  storage: StorageAdapter;
  /** 工作区记忆的目录后端（v1 面：`MEMORY.md` + 日期 `.md`，落点见 `WorkspaceMemoryFiles`） */
  memoryFiles: WorkspaceMemoryFiles;
  /**
   * 记忆目录后端（**v2 面**：子目录 / 原子替换 / JSONL 追行，见 `MemoryDirFiles`）。
   *
   * 与 `memoryFiles` **刻意分开两个属性**：v1 面同时被 Electron 的 `memory:*` IPC 与
   * Web 的 `nanowork.wsmem.*` key 承载，v2 面另走一组 IPC 与 `nanowork.mem2.*` key
   * （理由见 `src/lib/memoryPaths.ts` 的 `webMemoryDirKey`）。合成一个对象会让
   * 「v1 面写、v2 面读」这类不一致有机会发生，且要动 v1 的既有测试。
   */
  memoryDirs: MemoryDirFiles;
  /** 产物索引的目录后端（Electron 单向镜像，落点见 `ArtifactIndexFiles`） */
  artifactIndex: ArtifactIndexFiles;
  /** 内容寻址文件备份（FR-7.3 文件级回滚，落点见 `FileBackup`） */
  fileBackup: FileBackup;
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
   * 弹出系统文件选择器并读取所选文本文件内容。
   * - electron：原生 dialog.showOpenDialog（openFile）+ 主进程 fs.readFileSync 读 UTF-8；
   * - web：动态 `<input type=file accept=".json">` + `file.text()`。
   * 返回 `{ name, content }`（Web 端无路径，只有文件名）；用户取消或环境不支持返回 null。
   * 注意：Electron 端返回的是**文件内容**而非路径——与 `pickDirectory` 只返路径不同，
   * 因为 Web 端拿不到本地路径，调用方统一消费内容即可。
   */
  pickFile(): Promise<{ name: string; content: string } | null>;
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
   * 只读回读 nanobot config.json 的 `modelPresets` / `providers` / 默认预设。
   * - electron：主进程读取磁盘；
   * - web：无文件系统权限，返回 null。
   */
  getNanobotModels(): Promise<NanobotModelsSnapshot | null>;
  /**
   * 把一次模型变更同步进 nanobot 配置并按需重启 serve。
   * - electron：主进程合并写入 config.json（modelPresets + providers +
   *   agents.defaults.modelPreset），serve 由本应用托管时立即重启；
   * - web：无文件系统权限，降级为下载配置片段。
   */
  syncNanobotModels(mutationJson: string): Promise<ModelsSyncResult>;
  /**
   * 供应商连接测试：真实请求 `GET {apiBase}/models` 验证 key 是否可用。
   *
   * 由主进程发起而不是渲染层 `fetch`：浏览器端会被 CORS 挡掉，而失败原因
   * （跨域）与「key 无效」在界面上长得一模一样，会把人引到错误的排查方向。
   * - electron：主进程发请求，内置供应商的默认地址查 `modelProviders` 目录；
   * - web：返回 `ok=false` 并说明不支持。
   */
  probeModel(request: ModelProbeRequest): Promise<ModelProbeResult>;
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
   * 用系统默认浏览器打开一个 http(s) 链接（设置页「查看文档」这类外链入口）。
   *
   * 与 `openPath` 分开而不是复用它：`openPath` 是**文件路径**语义（主进程直接交给
   * shell 打开），拿它去开 URL 会得到「找不到该文件」；而这里的实现要额外做
   * 协议白名单校验——渲染层能把任意字符串送进来，放行 `file:` / 自定义协议
   * 等于把主进程的 shell 打开能力交出去。
   * - electron：主进程 `shell.openExternal`（仅 http/https）；
   * - web：`window.open`（浏览器自己的行为边界）。
   * @param url http/https 链接；协议不合法或打开失败返回 ok=false 与原因
   */
  openUrl(url: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * 读取本地文件为 base64（复制消息后粘贴恢复附件内容用）。
   * - electron：主进程 fs.readFile；
   * - web：无文件系统权限，返回 ok=false。
   */
  readFileAsBase64(path: string): Promise<ReadFileBase64Result>;
  /**
   * 扫描已安装插件包（FR-3.4，只读）。
   *
   * 扫的是产品自有目录 `~/.nanowork/plugins` 下的包，**不做安装/启用判断**：
   * 磁盘事实归扫描，激活状态归引擎（`readEnginePlugins`）。
   * - electron：主进程读盘并解析 `plugin.json`；
   * - web：无文件系统权限，返回空结果（`pluginsRoot` 为空串）。
   */
  scanPlugins(): Promise<PluginScanResult>;
  /**
   * 安装（复制）一个插件包到 `~/.nanowork/plugins/<name>`。
   *
   * 目录名取**清单里的 `name`**，不是来源目录名（来源可能是
   * `my-plugin-1.2.0/`）。清单非法或目录已存在时**不落盘**。
   * - electron：主进程完成校验与复制；
   * - web：无文件系统权限，返回 `ok=false`。
   * @param overwrite 已安装时是否覆盖（升级场景）
   */
  installPlugin(sourceDir: string, overwrite?: boolean): Promise<PluginInstallResult>;
  /**
   * 卸载插件（删除包目录，不可撤销）。名字非法或目录越界时拒绝。
   * - electron：主进程删除；
   * - web：返回 `ok=false`。
   */
  uninstallPlugin(name: string): Promise<PluginActionResult>;
  // —— 桌面端集成（窗口控制 / 托盘配置 / 主进程指令）——
  // 这一组在 Web 端一律降级为 no-op / null / 空取消函数，**渲染层据此分支而不是
  // 自己判断 preload 桥在不在**。原先 `TitleBar` / `useDesktopConfig` /
  // `useGlobalShortcuts` / `AppLayout` 各自 `if (window.electronAPI)`，于是
  // 「有没有桥」这个判据在四处各写了一遍（2026-09-27 收口）。
  /**
   * 当前操作系统。
   * - electron：主进程 `process.platform`；
   * - web：按 UA 粗推断（只服务 macOS 判定这类展示逻辑）。
   */
  platformOs(): PlatformName;
  /**
   * 读取主进程**实际生效**的桌面端配置（开机自启取系统真实状态，可能与渲染层
   * 保存的期望值不同——例如用户在系统设置里改过）。
   * - electron：主进程回读；
   * - web：`null`（浏览器里没有托盘 / 全局快捷键这回事）。
   */
  getDesktopConfig(): Promise<DesktopConfig | null>;
  /**
   * 应用桌面端配置补丁并回读主进程实际生效值。
   * - electron：`ok=false` + `error` 表示某项没生效（如快捷键被占用），`config`
   *   是回退后的实际值；
   * - web：`null`，调用方据此跳过「已生效」反馈。
   */
  setDesktopConfig(patch: Partial<DesktopConfig>): Promise<DesktopConfigResult | null>;
  /**
   * 订阅托盘菜单勾选变更（用户在托盘里改了开机自启等开关）。
   * 回调**只用于同步 UI，不得回写主进程**，否则形成「主进程→渲染层→主进程」回环。
   * 返回取消订阅函数；web 端为空实现。
   */
  onDesktopConfigChange(cb: (config: DesktopConfig) => void): () => void;
  /** 真正退出应用（绕过「最小化到托盘」）；web 端 no-op */
  appQuit(): void;
  /** 订阅主进程下发的路由跳转（托盘菜单「打开设置」）；返回取消订阅函数，web 端为空实现 */
  onAppNavigate(cb: (path: string) => void): () => void;
  /** 订阅主进程下发的「打开关于弹窗」指令（托盘菜单「关于」）；返回取消订阅函数，web 端为空实现 */
  onAppOpenAbout(cb: () => void): () => void;
  /** 窗口最小化；web 端 no-op */
  windowMinimize(): void;
  /** 窗口最大化 / 还原切换；web 端 no-op */
  windowToggleMaximize(): void;
  /** 关闭窗口（开启「关闭到托盘」时由主进程改为隐藏）；web 端 no-op */
  windowClose(): void;
  /** 全屏切换（快捷键走这里）；web 端 no-op——那边由调用方回退到 Fullscreen API */
  windowToggleFullScreen(): void;
  /** 查询窗口是否最大化；web 端恒 `false` */
  windowIsMaximized(): Promise<boolean>;
  /** 订阅窗口最大化状态变化；web 端空实现（与桥同形：**不返回**取消订阅函数） */
  onWindowMaximizeChange(cb: (maximized: boolean) => void): void;
  /**
   * 应用元信息（名称 / 版本 / 运行时版本 / 平台）。
   *
   * 存在的理由之一：插件清单的 `engines.nanowork` 区间要拿**当前版本**去判，
   * 而这个版本只有主进程知道。放进适配层同时收掉了渲染层直接读
   * `window.electronAPI` 的越界写法（`TitleBar` 早先就是这么取版本的）。
   * - electron：`app.getVersion()` 等；
   * - web：返回 `null`（浏览器里没有「应用版本」这个概念）。
   */
  appInfo(): Promise<AppInfo | null>;
  /**
   * 本地存储信息：缓存目录、缓存占用、所在卷容量、内置默认工作空间目录。
   *
   * `ensureDefaultWorkspace=true` 时主进程会顺带把**内置默认工作空间目录**
   * 建出来（`<home>/NanoWork`）。渲染层只在「用户没有自定义工作空间路径」
   * 时传 true——那种情况下新建任务确实会落到这个目录，先建出来才不会出现
   * 「设置里写着这个路径、磁盘上却没有」的错位。用户自定义的路径不建：
   * 目录选择器返回的目录必然已存在，不需要我们代劳。
   * - electron：主进程现算；
   * - web：无文件系统权限，返回 `null`（卡片据此显示不可用）。
   */
  storageInfo(ensureDefaultWorkspace?: boolean): Promise<StorageInfo | null>;
}

/** 本地文件 base64 读取结果 */
export interface ReadFileBase64Result {
  ok: boolean;
  base64?: string;
  size?: number;
  error?: string;
}

/**
 * 卷（磁盘分区）容量。
 *
 * 三个值**互不推导**，所以必须一起给：`totalBytes ≠ usedBytes + freeBytes`。
 * Windows 有保留给系统还原 / 回收站的隐藏空间，Linux 有 root 保留块
 * （`statfs` 的 `bfree` 与 `bavail` 之差）。用两个值相减去凑第三个，
 * 「磁盘已用 + 磁盘可用」就会对不上总量，占用条永远差一截。
 */
export interface DiskUsage {
  /** 卷总容量（字节） */
  totalBytes: number;
  /** 卷已用（字节） */
  usedBytes: number;
  /** 卷可用（字节，以**当前用户**可写为准） */
  freeBytes: number;
}

/**
 * 本地存储信息（设置「存储」卡片用）。
 *
 * 全部由主进程现算，渲染层不做路径拼接：`<home>/NanoWork` 的分隔符在
 * Windows 是 `\`、macOS/Linux 是 `/`，浏览器里既拿不到 home 也没有 path 模块，
 * 在渲染层用字符串拼路径早晚会在某个平台上错一格。
 */
export interface StorageInfo {
  /**
   * 系统缓存目录 = 产品自有目录 `~/.nanowork/`（Windows 为 `C:\Users\<user>\.nanowork`）。
   *
   * 与 WorkBuddy 的 `~/.workbuddy/` 同构：都是「这个应用自己的目录」，路径可预期，
   * 用户在资源管理器里能直接找到。
   *
   * 注意本项目的应用数据**分成两个根**（见设置「数据管理 → 数据落点」）：
   * 这里只是用户资产（设置、记忆、身份文件、技能、插件）那一个；对话事件流
   * （`projects/*.jsonl`）、索引与文件备份在应用数据目录。因此 `cacheBytes`
   * 统计的是本目录体积，不等于「本机全部产品数据」。
   */
  cacheDir: string;
  /** 缓存目录当前占用字节数（递归统计；目录不存在或读取失败按 0） */
  cacheBytes: number;
  /** 缓存目录所在卷的容量 */
  disk: DiskUsage;
  /**
   * 内置默认工作空间目录（`<home>/NanoWork`）。
   * 用户未在设置里指定 `defaultWorkspacePath` 时，新建任务落在它下面。
   */
  defaultWorkspaceDir: string;
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

/**
 * 网关子进程的实际监听信息（主进程 `nanobot:gatewayInfo` 返回）。
 *
 * 端口是**运行时值而非约定值**：首选端口被占用、或落在 Windows 保留端口区间时，
 * 主进程会自动顺延。渲染层只有拿到这里返回的实际端口，才能对齐
 * `settings.gatewayEndpoint`——否则界面会一直探测一个没人监听的端口。
 */
export interface NanobotGatewayInfo {
  /** serve 子进程是否由本应用托管且正在运行（端口复用时为 false） */
  running: boolean;
  /** 实际监听主机；端口未知时为 null */
  host: string | null;
  /** 实际监听端口；尚未解析出时为 null */
  port: number | null;
  /** 配置里的首选端口（界面提示「已自动改用其他端口」用） */
  preferredPort: number;
  /** 实际端口是否已偏离首选端口 */
  fallback: boolean;
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
  /**
   * 软删除：写墓碑元数据 + 覆盖索引条目 + **丢弃事件流正文**（保留 meta 与索引条目）。
   *
   * 与 `eventsRemove` 的差别只有「留不留痕迹」，而它决定了删除能否跨设备传播——
   * 详见 `src/events/store.ts` 的 `tombstoneSession`。
   */
  eventsTombstone(meta: SessionMeta): Promise<void>;
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
  // —— 工作区记忆目录（`<workdir>/.nanowork/memory/`）——
  // **刻意独立于 writeTextFile**：后者只放行 home / userData / ~/.nanowork 三个根，
  // 而记忆落在用户的工作目录里。放宽它的白名单等于让「导出文件」获得往任意位置
  // 写文件的能力，所以另开一条能力面更窄的通道：只能写 MEMORY.md 与日期文件。
  /** 列出工作区记忆目录下的记忆文件名（已排序） */
  memoryListFiles(workdir: string | null): Promise<string[]>;
  /** 读取单个记忆文件；不存在返回 null */
  memoryReadFile(workdir: string | null, name: string): Promise<string | null>;
  /** 覆盖写入单个记忆文件（只接受 MEMORY.md / YYYY-MM-DD.md） */
  memoryWriteFile(workdir: string | null, name: string, content: string): Promise<void>;
  /** 删除单个记忆文件（幂等） */
  memoryRemoveFile(workdir: string | null, name: string): Promise<void>;
  /** 删除该工作区全部记忆文件；返回删除个数 */
  memoryRemoveAll(workdir: string | null): Promise<number>;
  /**
   * 旧单文件落点的懒迁移（幂等）；返回本次新写入的文件名。
   * @deprecated 记忆 v1 的能力，仅用于读旧数据；v2 新代码不要调用。
   */
  memoryMigrateLegacy(workdir: string | null): Promise<string[]>;
  // —— 记忆 v2 的目录后端（子目录 + 原子替换 + JSONL 追行）——
  // 与上面那批的关系：上面是 v1 的「工作区根目录 + 单段文件名」形态，继续保留以兼容
  // 既有调用点与测试；这一批是 v2 需要的额外能力：`MemoryDirRef` 化（工作区级 /
  // 用户级两类存储根）、子目录（`daily/`、`archive/`）、原子替换、单行追加。
  // 名字与子目录一律走 `src/lib/memoryPaths.ts` 的白名单（两端同一份）。
  /** 列出某个记忆目录（可带子目录）里的文件名 */
  memoryListDir(dirRef: MemoryDirRef, subdir?: string): Promise<string[]>;
  /** 读取单个文件（可带子目录）；不存在返回 null */
  memoryReadDirFile(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<string | null>;
  /** 覆盖写入单个文件（可带子目录，只走白名单） */
  memoryWriteDirFile(
    dirRef: MemoryDirRef,
    name: string,
    content: string,
    subdir?: string,
  ): Promise<void>;
  /** 删除单个文件（可带子目录，幂等） */
  memoryRemoveDirFile(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<void>;
  /**
   * **原子替换**：写临时文件 → 落盘 → 改名覆盖目标。
   *
   * 与 `memoryWriteDirFile` 的唯一区别是**绝不暴露半写状态**——`curated.json` /
   * `conflicts.json` / `profile.json` / `preferences.json` 这类 canonical 状态一旦
   * 被读到半截 JSON，整份记忆就不可用。Web 端无临时文件，退化为一次 set（best-effort）。
   */
  memoryReplaceDirFile(
    dirRef: MemoryDirRef,
    name: string,
    content: string,
    subdir?: string,
  ): Promise<void>;
  /** 单行追加（JSONL 用）；实现侧保证单次 write，不读全文 */
  memoryAppendDirLine(
    dirRef: MemoryDirRef,
    name: string,
    line: string,
    subdir?: string,
  ): Promise<void>;
  /** 读取整份 JSONL（按行返回，已去空行） */
  memoryReadDirLines(dirRef: MemoryDirRef, name: string, subdir?: string): Promise<string[]>;
  // —— 产物索引（`<userData>/artifact-index/<id>.json`，FR-7.2）——
  // 单向镜像：只有写与删，**没有读**（权威在 store 索引切片，见 ArtifactIndexFiles）。
  /** 写入/覆盖单条产物索引 */
  artifactIndexPut(entry: ArtifactIndexEntry): Promise<void>;
  /** 删除单条产物索引（幂等） */
  artifactIndexRemove(id: string): Promise<void>;
  /** 启动 nanobot 网关子进程（桌面端自动拉起） */
  nanobotStart(): Promise<boolean>;
  /** 停止 nanobot 网关子进程 */
  nanobotStop(): Promise<void>;
  /** 查询 nanobot 网关子进程是否在运行 */
  nanobotStatus(): Promise<boolean>;
  /** 查询网关**实际**监听的地址与端口（端口自动顺延后据此对齐渲染层地址） */
  nanobotGatewayInfo(): Promise<NanobotGatewayInfo>;
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
  /** 只读回读 config.json 的 modelPresets / providers / 默认预设 */
  nanobotGetModels(): Promise<NanobotModelsSnapshot | null>;
  /** 提交一次模型变更（upsert / delete / setDefault），主进程落盘并按需重启 serve */
  nanobotSyncModels(mutationJson: string): Promise<ModelsSyncResult>;
  /** 供应商连接测试（主进程发起 GET {apiBase}/models） */
  probeModel(request: ModelProbeRequest): Promise<ModelProbeResult>;
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
  /** 用系统默认浏览器打开 http(s) 链接；协议不合法或打开失败返回 ok=false */
  openUrl(url: string): Promise<{ ok: boolean; error?: string }>;
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
  /**
   * 原生文件选择对话框：弹窗选 .json 归档并读回内容。
   * 返回 `{ name, content }`（content 为 UTF-8 文本）；用户取消返回 null。
   */
  pickFile(): Promise<{ name: string; content: string } | null>;
  // —— 插件包生命周期（FR-3.4）——
  // 只做文件系统那一半（扫 / 装 / 卸）：激活状态由引擎的 /v1/plugins 给出，
  // 不走 IPC——引擎才是权威，客户端不复刻指纹哈希。
  /** 扫描 `~/.nanowork/plugins` 下已安装的插件包（只读） */
  pluginsScan(): Promise<PluginScanResult>;
  /** 安装（复制）插件包到 `~/.nanowork/plugins/<清单 name>` */
  pluginsInstall(sourceDir: string, overwrite?: boolean): Promise<PluginInstallResult>;
  /** 卸载插件（删除包目录，不可撤销） */
  pluginsUninstall(name: string): Promise<PluginActionResult>;
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
  /** 获取本地存储信息（缓存目录 / 缓存占用 / 卷容量 / 内置默认工作空间目录） */
  appGetStorageInfo(ensureDefaultWorkspace?: boolean): Promise<StorageInfo>;
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
