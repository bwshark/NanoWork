import type {
  ArtifactType,
  ChatMessageParam,
  ConnectionStatus,
  ModelInfo,
  ToolCallStatus,
} from '@/types';

/** 单个待上传文件（对齐 nanobot 文件上传能力） */
export interface UploadFile {
  /** 文件名（含扩展名），用于服务端判别类型 */
  name: string;
  /** 文件内容（base64 编码字符串） */
  content: string;
  /** MIME 类型（可选，缺省按扩展名推断） */
  mimeType?: string;
}

/**
 * 发送给 AIClient 的会话请求。
 * stream 固定为 true（首版仅流式）。
 */
export interface ChatRequest {
  agentId: string;
  messages: ChatMessageParam[];
  model?: string;
  stream: true;
  /** nanobot 会话隔离标识（透传 session_id），缺省由网关维护默认会话 */
  sessionId?: string;
  /** 会话级工作空间绝对路径（nanobot /v1 workspace 字段，引擎按 turn 生效） */
  workspace?: string;
  /** 会话级权限策略：restricted=默认沙箱 / full=完全访问 */
  accessMode?: 'restricted' | 'full';
  /** 随请求上传的文件（nanobot 支持图片/文档/文本，max 10MB/文件） */
  files?: UploadFile[];
}

/**
 * 语音转录请求（对齐 OpenAI 兼容 /audio/transcriptions）。
 * 配置（endpoint / model / token / language）由 client 自行从 settings 读取，
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

/** 流式事件回调集合（页面/store 仅通过此契约与 client 交互） */
export interface StreamHandlers {
  /** 流式文本片段 */
  onToken(chunk: string): void;
  /** 工具调用事件（含 sensitive 标记） */
  onToolCall(ev: ToolCallEvent): void;
  /** 富产物事件 */
  onArtifact(ev: ArtifactEvent): void;
  /** 深度思考文本片段（网关 delta.nanobot_event kind=reasoning） */
  onReasoning?(chunk: string): void;
  /** 当前深度思考段结束（后续 reasoning 将开启新段） */
  onReasoningEnd?(): void;
  /** 工具执行进度行（网关 delta.nanobot_event kind=tool） */
  onProcessTool?(ev: ProcessToolEvent): void;
  /** 状态变化：思考 / 流式 / 工具中 / 完成 */
  onStatus(status: 'thinking' | 'streaming' | 'tooling' | 'done'): void;
  /** 正常结束 */
  onDone(): void;
  /** 出错 */
  onError(err: Error): void;
}

/**
 * 工具执行进度事件（网关 [LOCAL PATCH] 注入的 delta.nanobot_event kind=tool）。
 * 与 ToolCallEvent（OpenAI 增量 tool_calls + 权限门控）相互独立，仅用于过程时间线展示。
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

/** 工具调用事件载荷 */
export interface ToolCallEvent {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  sensitive: boolean;
  status: ToolCallStatus;
  /** 执行结果（done 时携带） */
  result?: string;
}

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
 * 一次流式发送的句柄（FR-中断）：渲染层持有以便取消。
 *
 * - `done` 解析：流结束（正常 / 出错 / abort 导致的取消）。
 *   中断调用方不抛错；真正的协议级错误通过 `StreamHandlers.onError` 上报。
 * - `abort()` 立即中断底层 fetch；流结束后 `done` 解析为 undefined。
 */
export interface ChatHandle {
  /** 等待流结束（成功 / 出错 / 用户中断） */
  done: Promise<void>;
  /** 中断本次请求；幂等 */
  abort(): void;
}

/**
 * 统一 AI 客户端抽象（FR-001 引擎即插即用）。
 * 当前唯一实现：nanobotClient（直连 nanobot 网关）。
 * 页面与 store 禁止 new 具体实现，一律经 ConnectionManager.getClient() 获取。
 */
export interface AIClient {
  readonly kind: 'nanobot';
  sendMessage(req: ChatRequest, handlers: StreamHandlers): ChatHandle;
  listModels(): Promise<ModelInfo[]>;
  probe(): Promise<ConnectionStatus>;
  /**
   * 语音转文字：走 OpenAI 兼容 /audio/transcriptions。
   * 未配置转录服务 / 服务不可用时抛可读错误，由 UI 转 toast。
   */
  transcribe(req: TranscribeRequest): Promise<string>;
}
