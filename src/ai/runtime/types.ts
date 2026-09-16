/**
 * 引擎契约层（D1）：`AgentRuntime` 防腐层的类型声明。
 *
 * 设计意图（见 docs/nanowork-prd-design-v2.md 第 8 章）：
 * 引擎的 HTTP/SSE 契约、配置片段形态、键名风格都是 nanobot 的实现细节。
 * 收敛到本文件后，**渲染层任何模块都不再直接依赖 nanobot 的 wire 格式**——
 * 升级引擎大版本或改走 ACP 式双向协议时，改动被限制在
 * `runtime/nanobotHttp/` 内，UI 与 store 零改动。
 *
 * 边界约定：
 * - 本文件只放「契约」；任何 nanobot 特有字段（`session_id`、`access_mode`、
 *   `mcpServers`、`jobs.json` 结构等）**不得**出现在这里，只能出现在
 *   `nanobotHttp/` 内部。
 * - `ChatHandle` 是 transport 级原语（可中断的一次流式请求），仅由
 *   `nanobotHttp` 内部使用；对外只暴露 `chat()` + `abort()` 两个动作，
 *   以免把「句柄管理」这种传输细节泄漏给调用方。
 */
import type {
  ArtifactType,
  ChannelConfig,
  ChannelKind,
  ChatMessageParam,
  ConnectionStatus,
  MCPConfig,
  ModelInfo,
  TaskConfig,
  TaskRunRecord,
  ToolCallStatus,
} from '@/types';
import type { ExecutionMode, PlanStep } from '@/types/event';

// 领域类型（模型目录 / 连接状态 / 运行记录）由 `@/types` 定义，
// 这里仅做转出，使调用方「只 import 一处」即可拿到完整契约面。
export type { ConnectionStatus, ModelInfo, TaskRunRecord };

/** 单个待上传文件（对齐引擎的文件上传能力） */
export interface UploadFile {
  /** 文件名（含扩展名），用于服务端判别类型 */
  name: string;
  /** 文件内容（base64 编码字符串） */
  content: string;
  /** MIME 类型（可选，缺省按扩展名推断） */
  mimeType?: string;
}

/**
 * 发送给 `AgentRuntime.chat` 的会话请求。
 *
 * 注意：这里**不含** endpoint / token 等连接参数——连接信息由实现自行解析
 * （nanobot-http 从 settings 读取）。契约层只描述「一次对话需要什么」，
 * 不描述「怎么连上去」。
 */
export interface ChatRequest {
  agentId: string;
  messages: ChatMessageParam[];
  model?: string;
  stream: true;
  /** 会话隔离标识；同时也是 `abort()` 的寻址键 */
  sessionId?: string;
  /** 会话级工作空间绝对路径（引擎按 turn 生效） */
  workspace?: string;
  /** 会话级权限策略：restricted=默认沙箱 / full=完全访问 */
  accessMode?: 'restricted' | 'full';
  /**
   * 会话级逐条批准策略：
   * - `auto`（缺省）：工具直接执行，不打断对话；
   * - `ask`：副作用工具（写文件 / 执行命令 / MCP 调用等）执行**前**必须由用户
   *   逐条裁决，引擎侧挂起等待（超时按拒绝处理，fail-closed）。
   *
   * 与 `accessMode` 是正交的两轴：前者管「能碰哪里」，后者管「要不要先问」。
   */
  approvalMode?: 'auto' | 'ask';
  /**
   * 会话级执行模式（FR-1.4）：缺省 `craft`。
   *
   * `ask` / `plan` 下引擎在工具网关层**拒绝**写类工具调用，而不是「先做再问」；
   * 因此这是**能写到哪**的第三根轴，与前两根互不替代。
   *
   * `plan` 额外开启 `submit_plan` 工具：模型用它把结构化计划交给用户裁决，
   * 事件经 `StreamHandlers.onPlan` 下发（计划只允许提交，不允诺执行）。
   */
  sessionMode?: ExecutionMode;
  /**
   * Agent 工具白名单（FR-2.2）：本会话所用 Agent 声明的工具授权。
   *
   * 这是第四根轴——前三根管「能碰哪里 / 要不要问 / 能不能写」，这一根管
   * **「这个 Agent 有没有这个能力」**。约束在引擎的工具网关强制，不依赖提示词。
   *
   * - `toolAllow` 省略（undefined）= 该 Agent 未声明限制；传**空数组** =
   *   一个工具都不许（两者语义不同，不能混）；
   * - `toolDeny` **永远优先于** `toolAllow`。
   */
  toolAllow?: string[];
  /** Agent 工具黑名单（FR-2.2）；优先级高于 `toolAllow` */
  toolDeny?: string[];
  /** 随请求上传的文件 */
  files?: UploadFile[];
}

/**
 * 语音转录请求。
 * 配置（endpoint / model / token / language）由实现自行从 settings 读取，
 * 调用方只需给音频与可选项，避免 UI 层关心服务地址。
 */
export interface TranscribeRequest {
  /** 音频二进制（MediaRecorder 录制结果） */
  audio: Blob;
  /** 音频文件名（含扩展名），服务端据此判别格式；缺省 voice.webm */
  filename?: string;
  /** 语言提示（ISO-639-1），留空由服务自动检测 */
  language?: string;
  /** 上下文提示词，可提升专有名词识别率 */
  prompt?: string;
}

/**
 * 工具执行进度事件（过程时间线展示用）。
 * 与 `ToolCallEvent`（权限门控用）相互独立：前者是「引擎报告它在干什么」，
 * 后者是「需要用户批准的调用」。
 */
export interface ProcessToolEvent {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** start=开始执行 / end=完成 / error=出错 */
  phase: 'start' | 'end' | 'error';
  /** 执行结果（end 时携，已截断） */
  result?: string;
  /** 错误信息（error 时携） */
  error?: string;
}

/** 工具调用事件载荷（权限门控用） */
export interface ToolCallEvent {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  sensitive: boolean;
  status: ToolCallStatus;
  /** 执行结果（done 时携带） */
  result?: string;
}

/**
 * 逐条批准请求（FR-1.5，真实引擎回环）。
 *
 * **与 `ToolCallEvent` 的区别**：那是「引擎报告它想干什么」，本类型是
 * 「引擎**真的停下了**，在等一个裁决」——收到它就必须回话，否则该工具
 * 调用会在超时后被引擎按拒绝处理。工具尚未执行，因此没有 status / result。
 */
export interface ApprovalRequestEvent {
  /** 审批请求 id；回传裁决时用它寻址 */
  id: string;
  /** 待执行工具名 */
  tool: string;
  /** 工具入参（已由引擎侧截断，仅够展示） */
  args: Record<string, unknown>;
  /** 引擎侧对应的工具调用 id（用于与过程时间线对齐，可能缺省） */
  callId?: string;
}

/** 逐条批准的裁决结果 */
export type ApprovalDecision = 'allow' | 'deny';

/** 富产物事件载荷 */
export interface ArtifactEvent {
  id: string;
  type: ArtifactType;
  title?: string;
  content: string;
  language?: string;
  url?: string;
}

/**
 * Plan 模式下发的待裁决计划（FR-1.5）。
 *
 * 步骤形状**复用** `@/types/event` 的 `PlanStep` 而非另立一套：同一份计划要
 * 在运行时（本类型）与落盘（事件）之间往返，两处各自定义必然漂移。
 */
export interface PlanProposal {
  planId: string;
  steps: PlanStep[];
}

/** 流式事件回调集合（页面/store 仅通过此契约与 runtime 交互） */
export interface StreamHandlers {
  /** 流式文本片段 */
  onToken(chunk: string): void;
  /** 工具调用事件（含 sensitive 标记） */
  onToolCall(ev: ToolCallEvent): void;
  /** 富产物事件 */
  onArtifact(ev: ArtifactEvent): void;
  /** 深度思考文本片段 */
  onReasoning?(chunk: string): void;
  /** 当前深度思考段结束（后续 reasoning 将开启新段） */
  onReasoningEnd?(): void;
  /** 工具执行进度行 */
  onProcessTool?(ev: ProcessToolEvent): void;
  /**
   * 逐条批准请求：引擎已挂起该工具调用，等待 `respondApproval()` 回话。
   *
   * 仅在会话开启 `approvalMode: 'ask'` 时才会触发。**实现方必须保证终局**——
   * 要么回裁决，要么让流中断；悬空不回会让工具调用卡到超时（判为拒绝）。
   */
  onApprovalRequest?(req: ApprovalRequestEvent): void;
  /**
   * Plan 模式产出的计划（FR-1.5）。
   *
   * 与审批请求的关键区别：**它不等回话**。引擎放行 `submit_plan` 后本轮就继续
   * 走完，用户的裁决由下一轮请求带回（模式切到 craft 后再发一条消息）。
   * 实现方不应在本回调里阻塞等待——那是 `onApprovalRequest` 的语义。
   */
  onPlan?(plan: PlanProposal): void;
  /** 状态变化：思考 / 流式 / 工具中 / 完成 */
  onStatus(status: 'thinking' | 'streaming' | 'tooling' | 'done'): void;
  /** 正常结束 */
  onDone(): void;
  /** 出错 */
  onError(err: Error): void;
}

/**
 * 一次流式发送的句柄（transport 级，`nanobotHttp` 内部使用）。
 *
 * - `done` 解析：流结束（正常 / 出错 / abort 导致的取消）。
 *   中断调用方不抛错；真正的协议级错误通过 `StreamHandlers.onError` 上报。
 * - `abort()` 立即中断底层 fetch；幂等。
 */
export interface ChatHandle {
  /** 等待流结束（成功 / 出错 / 用户中断） */
  done: Promise<void>;
  /** 中断本次请求；幂等 */
  abort(): void;
}

/**
 * 引擎能力声明（FR-9.3 能力协商）。
 *
 * **为什么要显式声明**：今天「`sseToolCalls` 已实现但网关不下发标准
 * tool_calls」是一个散落在注释里的隐式假设；声明成数据后，UI 可据此主动
 * 降级，而不是靠人去读实现猜。
 *
 * 取值必须**可追溯到证据**，不许乐观填 true。
 */
export interface RuntimeCapabilities {
  /** 下发 reasoning 事件（deepseek 类模型的思考过程） */
  reasoning: boolean;
  /** 下发标准 OpenAI `delta.tool_calls` 增量 */
  toolCalls: boolean;
  /** 下发 / 可提取富产物事件 */
  artifacts: boolean;
  /** 配置热加载（无需重启引擎） */
  hotReload: boolean;
  /**
   * 支持逐条工具批准（FR-1.5）：引擎能在工具执行前挂起并接受裁决回传。
   * 报 false 时 UI 必须隐藏「逐条批准」开关，不得提供无效的授权入口。
   */
  toolApproval: boolean;
  /**
   * 支持会话级执行模式（FR-1.4）与计划投递（FR-1.5）：引擎按 turn 接受
   * 执行模式并在 `plan` 模式下把 `submit_plan` 的结果下发为流事件。
   *
   * 报 false 时 UI 必须隐藏执行模式选择器——留着一个点了不生效的开关，
   * 比没有开关更糟（用户会以为自己在 Plan 模式，实际每一句都能改文件）。
   */
  executionModes: boolean;
  /** 支持的 IM 渠道标识（取值域与产品侧 `ChannelKind` 一致） */
  channels: ChannelKind[];
  /** 支持会话级隔离 */
  sessions: boolean;
}

/**
 * 可同步/可回读的配置域。
 *
 * - `connectors`：MCP 连接器（写入引擎的 `tools.mcpServers`）
 * - `channels`：IM 渠道（写入引擎的 `channels` 段）
 * - `tasks`：定时任务（写入引擎工作区的 `cron/jobs.json`）
 * - `models`：模型目录（只读）
 * - `memory`：会话记忆（V1 由产品自有目录承载，不在引擎配置内）
 */
export type RuntimeSection = 'connectors' | 'channels' | 'tasks' | 'models' | 'memory';

/**
 * 各配置域的**写入载荷**。
 *
 * 载荷是产品领域对象（`MCPConfig[]` 等），**不是**引擎片段字符串——
 * 片段格式（`{ tools: { mcpServers } }` / `jobs.json` 结构）是引擎实现细节，
 * 只能存在于 `nanobotHttp/` 内部。调用方给出领域对象即可，序列化由实现负责。
 *
 * 取值为 `never` 表示该域不支持此方向（编译期即拦截）。
 */
export interface RuntimeSyncPayload {
  connectors: MCPConfig[];
  channels: ChannelConfig[];
  tasks: TaskConfig[];
  models: never;
  memory: never;
}

/**
 * 各配置域的**回读结果**。
 *
 * `tasks` / `memory` 取 `never`：定时任务的运行记录请用 `listRuns()`，
 * 记忆由产品自有目录承载（见 18.2），二者都不从引擎配置域回读。
 */
export interface RuntimeReadResult {
  connectors: MCPConfig[];
  channels: ChannelConfig[];
  models: ModelInfo[];
  tasks: never;
  memory: never;
}

/**
 * 配置同步结果。
 *
 * `message` **必填**：每一次同步都必须能向用户解释「写到了哪、要不要重启、
 * 有没有降级」。强制填字段比事后在 UI 里拼兜底文案更可靠，也让本类型与
 * platform 侧的 `MCPSyncResult` / `ChannelSyncResult` / `TaskSyncResult`
 * 结构兼容，实现可直接透传主进程返回值。
 */
export interface SyncResult {
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false，UI 可据此静默） */
  changed?: boolean;
  /** 是否需要重启引擎才生效 */
  needsRestart?: boolean;
}

/** 会话运行态查询条件（定时任务留痕、IM 会话归档） */
export interface RunQuery {
  /** 只取某个任务（引擎 job id）的运行记录 */
  taskId?: string;
  /** 只取某个引擎会话键（如 `api:cron-<id>`）的运行记录 */
  sessionKey?: string;
  /** 起始时间（毫秒时间戳，含） */
  sinceMs?: number;
  /** 最多返回条数（缺省不截断） */
  limit?: number;
}

/**
 * 引擎唯一出口。
 *
 * 页面与 store **禁止** new 具体实现，一律经
 * `connectionManager.getClient()` / `getRuntime()` 获取。
 */
export interface AgentRuntime {
  /** 实现标识，如 `'nanobot-http'`（用于日志与诊断，不参与分支判断） */
  readonly kind: string;
  /** 能力声明（FR-9.3） */
  readonly capabilities: RuntimeCapabilities;

  /**
   * 流式对话（唯一对话入口）。
   * 返回的 Promise 在流结束（正常 / 出错 / 被 abort）后解析——注意它**不**
   * 以 reject 表达错误，协议级错误经 `handlers.onError` 上报。
   */
  chat(req: ChatRequest, handlers: StreamHandlers): Promise<void>;
  /**
   * 中断指定会话进行中的流式响应。无活跃请求时静默 no-op。
   * 以 `sessionId` 而非句柄寻址：这是传输无关的取消语义（ACP 等协议同构）。
   */
  abort(sessionId: string): Promise<void>;

  /**
   * 回传一条逐条批准的裁决（FR-1.5）。
   *
   * 这是**流式请求之外的反向通道**：SSE 只出不进，而引擎此时正阻塞在工具
   * 执行前等待裁决，所以必须另开一次请求送回去。
   *
   * - `requestId` 取自 `ApprovalRequestEvent.id`；
   * - `reason` 仅在拒绝时有意义，会被回灌给模型让它改道（可省略）；
   * - 请求已超时或被取消时抛错——调用方应据此提示「已失效」，而不是
   *   假装授权成功。
   *
   * 能力判定：`capabilities.toolApproval === false` 的实现不定义此方法。
   */
  respondApproval?(
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void>;

  /** 模型目录 */
  listModels(): Promise<ModelInfo[]>;
  /** 可达性探测 */
  probe(): Promise<ConnectionStatus>;

  /**
   * 配置类镜像（写侧）：把本地**领域对象**推给引擎。
   * 序列化与落盘路径由实现决定；调用方不构造片段。
   */
  sync<S extends RuntimeSection>(
    section: S,
    payload: RuntimeSyncPayload[S],
  ): Promise<SyncResult>;
  /**
   * 配置类回读（读侧）：从引擎回读真实状态，返回**领域对象**。
   * 不支持的域抛 `RuntimeSectionUnsupportedError`（调用方据此降级，不静默）。
   */
  read<S extends RuntimeSection>(section: S): Promise<RuntimeReadResult[S]>;

  /** 会话运行态查询（定时任务留痕、IM 会话归档） */
  listRuns(query: RunQuery): Promise<TaskRunRecord[]>;

  /**
   * 语音转录。**方法存在性即能力声明**：不具备该能力的实现不定义此方法，
   * 调用方须判空后降级（不额外增设 `capabilities.transcription` 字段，
   * 避免「同一个事实有两个真值来源」）。
   */
  transcribe?(req: TranscribeRequest): Promise<string>;
}

/** 该引擎实现不支持某个配置域时抛出（调用方据此走降级分支，而非静默） */
export class RuntimeSectionUnsupportedError extends Error {
  constructor(
    readonly section: RuntimeSection,
    readonly kind: string,
  ) {
    super(`引擎实现 ${kind} 不支持配置域 ${section}`);
    this.name = 'RuntimeSectionUnsupportedError';
  }
}
