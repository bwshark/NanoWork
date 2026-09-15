/**
 * nanobot HTTP 实现（D1 的当前唯一 Adapter）。
 *
 * 职责边界：
 * - 对**上**：实现 `AgentRuntime` 契约，是渲染层与引擎之间的唯一出口。
 * - 对**下**：把工作分派给同目录的三个域模块（`chat` / `config` /
 *   `channels` / `tasks`）——它们才知道 nanobot 的 wire 格式。
 *
 * 本文件**只做编排**：登记/取消进行中的流、把 section 分派到域模块、
 * 声明能力。它不解析 SSE、不拼配置片段、不关心 jobs.json 结构。
 */
import { NanobotClient } from './chat';
import { readMcpFromRuntime, syncMcpToRuntime } from './config';
import { readChannelsFromRuntime, syncChannelsToRuntime } from './channels';
import { listRunsFromRuntime, syncTasksToRuntime } from './tasks';
import {
  RuntimeSectionUnsupportedError,
  type AgentRuntime,
  type ApprovalDecision,
  type ChatHandle,
  type ChatRequest,
  type ConnectionStatus,
  type ModelInfo,
  type RunQuery,
  type RuntimeCapabilities,
  type RuntimeReadResult,
  type RuntimeSection,
  type RuntimeSyncPayload,
  type StreamHandlers,
  type SyncResult,
  type TaskRunRecord,
  type TranscribeRequest,
} from '../types';
import type { ChannelConfig, ChannelKind, MCPConfig, TaskConfig } from '@/types';

/** 引擎当前支持的 IM 渠道（对齐 nanobot 各 channel manifest） */
const SUPPORTED_CHANNELS: ChannelKind[] = [
  'dingtalk',
  'feishu',
  'lark',
  'weixin',
  'wecom',
];

/**
 * 能力声明。**每一项都必须可追溯到证据**，不许乐观填 true——
 * 声明错了比不声明更糟，因为 UI 会据此隐藏降级提示。
 *
 * - `reasoning: true`：网关 `[LOCAL PATCH]` 在 `delta.nanobot_event.kind='reasoning'`
 *   注入思考片段（见 chat.ts 的 `NanobotStreamEvent`）。
 * - `toolCalls: false`：`/v1/chat/completions` 只下发 `delta.content`，
 *   **不下发**标准 `delta.tool_calls`。客户端的增量解析器仍在（为未来网关
 *   预留），但按契约层「能力声明」的语义，当前必须报 false，让 UI 走
 *   `nanobot_event.kind='tool'` 的过程时间线通道，而不是等待权限弹窗。
 * - `artifacts: true`：由客户端对完整文本做围栏块启发式提取（不依赖引擎下发）。
 * - `hotReload: false`：渠道配置变更需重启网关（tasks 走 reload 端点可热加载，
 *   但能力按最保守口径声明，避免 UI 在渠道场景下误以为无需重启）。
 * - `sessions: true`：支持 `session_id` 会话级隔离。
 * - `toolApproval: true`：`[LOCAL PATCH]` 给 `before_execute_tool` 加了否决通道，
 *   引擎能在工具执行前挂起并经 `nanobot_event.kind='approval_request'` 下发请求、
 *   由 `POST /v1/tool-approvals/{id}` 接收裁决（见 docs 第 11 章）。
 */
const CAPABILITIES: RuntimeCapabilities = {
  reasoning: true,
  toolCalls: false,
  artifacts: true,
  hotReload: false,
  toolApproval: true,
  channels: SUPPORTED_CHANNELS,
  sessions: true,
};

export class NanobotHttpRuntime implements AgentRuntime {
  readonly kind = 'nanobot-http';
  readonly capabilities = CAPABILITIES;

  /** 传输层（SSE / multipart / 转录），不对外暴露 */
  private readonly client = new NanobotClient();

  /**
   * 进行中的流：会话 id → 句柄。
   * 之所以按 sessionId 登记而不是把句柄交给调用方：`abort(sessionId)` 是
   * 传输无关的取消语义（未来 ACP 实现同样是「向会话发 cancel」），
   * 而上层的 store 也不需要理解句柄的生命周期。
   */
  private readonly inflight = new Map<string, ChatHandle>();

  async chat(req: ChatRequest, handlers: StreamHandlers): Promise<void> {
    // 同步登记：`sendMessage` 与 `inflight.set` 之间没有 await，
    // 因此调用方在 `chat()` 返回前发起 abort 也能命中（无竞态窗口）。
    const handle = this.client.sendMessage(req, handlers);
    const sid = req.sessionId;
    if (sid) this.inflight.set(sid, handle);
    try {
      await handle.done;
    } finally {
      // 仅清理自己登记的那一条：同会话重入时不能误删新请求的登记
      if (sid && this.inflight.get(sid) === handle) this.inflight.delete(sid);
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.inflight.get(sessionId)?.abort();
  }

  /** 逐条批准裁决回传：SSE 之外的反向通道，直接委托 transport。 */
  respondApproval(
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    return this.client.respondApproval(requestId, decision, reason);
  }

  probe(): Promise<ConnectionStatus> {
    return this.client.probe();
  }

  listModels(): Promise<ModelInfo[]> {
    return this.client.listModels();
  }

  transcribe(req: TranscribeRequest): Promise<string> {
    return this.client.transcribe(req);
  }

  /**
   * 配置写侧分派。
   *
   * 注意载荷是**领域对象**（`MCPConfig[]` 等），片段序列化在域模块内完成。
   * 泛型签名让调用点在编译期就知道每个 section 该传什么；实现内部因
   * 「一个泛型值对应多个具体类型」必须做一次断言，这是把类型安全
   * 推给调用点、把断言收敛到一个 switch 的取舍。
   */
  async sync<S extends RuntimeSection>(
    section: S,
    payload: RuntimeSyncPayload[S],
  ): Promise<SyncResult> {
    switch (section) {
      case 'connectors':
        return syncMcpToRuntime(payload as unknown as MCPConfig[]);
      case 'channels':
        return syncChannelsToRuntime(payload as unknown as ChannelConfig[]);
      case 'tasks':
        return syncTasksToRuntime(payload as unknown as TaskConfig[]);
      default:
        throw new RuntimeSectionUnsupportedError(section, this.kind);
    }
  }

  /** 配置读侧分派。`tasks` / `memory` 不支持——前者用 `listRuns()`，后者在产品自有目录（见 18.2） */
  async read<S extends RuntimeSection>(section: S): Promise<RuntimeReadResult[S]> {
    switch (section) {
      case 'connectors':
        return (await readMcpFromRuntime()) as unknown as RuntimeReadResult[S];
      case 'channels':
        return (await readChannelsFromRuntime()) as unknown as RuntimeReadResult[S];
      case 'models':
        return (await this.client.listModels()) as unknown as RuntimeReadResult[S];
      default:
        throw new RuntimeSectionUnsupportedError(section, this.kind);
    }
  }

  listRuns(query: RunQuery): Promise<TaskRunRecord[]> {
    return listRunsFromRuntime(query);
  }
}
