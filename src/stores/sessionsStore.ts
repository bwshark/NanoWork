import { create } from 'zustand';
import { platform } from '@/platform';
import { PLACEHOLDER_TITLES, STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { toast } from '@/components/Toast';
import { connectionManager } from '@/ai/connectionManager';
import { getRuntime } from '@/ai/runtime';
import { CRON_SESSION_ID_PREFIX } from '@/lib/sessionImport';
import {
  createRecorder,
  dropRecorder,
  enqueueSessionTask,
  getEventStore,
  hasRecorder,
  hasSessionMessages,
  isExecutionMode,
  listSessionEntries,
  messageEventIdOf,
  metaToSession,
  primeRecorder,
  project,
  recordEvents,
  recorderWorkdir,
  setRecordErrorSink,
  setRecorderWorkdir,
  takeTurnEvents,
  toEventAttachment,
  UNBOUND_AGENT_SENTINEL,
} from '@/events';
import { buildTurnTrace } from '@/observability/trace';
import { log } from '@/observability/logger';
import type { EventFactory } from '@/events/factory';
import type { ExecutionMode, SessionEvent, SessionMeta } from '@/types/event';
import { normalizeMeta, withoutTombstone } from '@/lib/syncMeta';
import {
  attachmentsToUploadFiles,
  toPersistableAttachment,
} from '@/lib/attachments';
import { MemoryService, isEmptySummary } from '@/lib/memory';
import { isSameMemoryWorkspace } from '@/lib/workspaceMemory';
import { sessionCreatePatch, sessionDeletePatch, withSessionSync } from '@/lib/sessionSyncMeta';
import {
  MEMORY_WRITE_INSTRUCTION,
  parseMemoryDirectives,
  stripMemoryDirectives,
} from '@/lib/memoryDirective';
import { IdentityService } from '@/lib/identity';
import { PromptLibrary } from '@/lib/promptLibrary';
import {
  DEFAULT_PROMPT_DOMAIN,
  DEFAULT_PROMPT_STYLE,
} from '@/lib/promptCatalog';
import { assemblePromptSections } from '@/lib/promptAssembly';
import { availablePresetIds, resolveTurnModel } from '@/lib/agentBinding';
import { buildExpertGroupRequest } from '@/lib/expertGroupRequest';
import { useAgentsStore } from './agentsStore';
import { useArtifactsStore } from './artifactsStore';
import { useExpertGroupsStore } from './expertGroupsStore';
import { useSettingsStore } from './settingsStore';
import { resolveDefaultWorkspacePath } from './storageInfoStore';
import { useSkillsStore } from './skillsStore';
import { usePluginsStore } from './pluginsStore';
import { snapshotSessionPluginVersions } from '@/lib/sessionPluginRefs';
import { useModelsStore } from './modelsStore';
import {
  deletedFilePathFrom,
  deriveFileArtifacts,
  fileArtifactId,
  findFileArtifact,
} from '@/lib/fileArtifact';
import type {
  Artifact,
  ArtifactChange,
  Attachment,
  ChatMessageParam,
  MemoryState,
  Message,
  MessagePlan,
  PermissionLog,
  PlanVerdict,
  ProcessEvent,
  ProcessToolRow,
  Session,
  SyncMeta,
  SyncMetaInput,
  ToolCall,
} from '@/types';
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ArtifactEvent,
  ChatRequest,
  PlanProposal,
  ProcessMemberEvent,
  ProcessToolEvent,
  ToolCallEvent,
  UploadFile,
} from '@/ai/runtime/types';

/**
 * 待用户裁决的逐条批准请求（触发 PermissionDialog）。
 *
 * 与旧版「本地假门控」的关键区别：**引擎此时真的停下了**——工具尚未执行，
 * 会话的流式响应被阻塞在引擎的 `before_execute_tool` 里。所以这条记录
 * 必须被终局处理（裁决或让流中断），悬空会拖到引擎超时（判为拒绝）。
 */
export interface PendingApproval {
  /** 引擎侧审批请求 id；回传裁决时用它寻址 */
  id: string;
  sessionId: string;
  /** 承载该工具调用的助手消息 id（用于回写状态） */
  messageId: string;
  /** 该工具调用在消息上的记录 id（与 id 不同：记录 id 是 UI 侧行标识） */
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
}

export type StreamStatus =
  | 'idle'
  | 'thinking'
  | 'reasoning'
  | 'streaming'
  | 'tooling'
  | 'done';

/** 单个会话的流式上下文（仅运行时状态，不持久化） */
export interface SessionStream {
  /**
   * 当前流式阶段：等待响应 / 深度思考 / 流式 / 工具中 / 完成。
   *
   * `thinking` 与 `reasoning` 刻意分开：前者是「请求已发出、首帧尚未到达」的
   * 真空等待，后者是「模型正在回吐思考正文」。两者此前共用 `thinking`，
   * 导致深度思考正文已在滚动、状态行却仍写着「等待模型响应」。
   */
  status: StreamStatus;
  /**
   * 是否有可中断的进行中请求（供「停止」按钮判定）。
   * 不持有请求句柄：中断以 `runtime.abort(sessionId)` 表达，
   * store 不需要理解句柄生命周期（见 ai/runtime/types.ts 边界约定）。
   */
  active: boolean;
}

interface SessionsState {
  sessions: Session[];
  /**
   * **会话墓碑的兄弟表**（批次 4）：`会话 id → 删除元数据`。
   *
   * 与 `sessions` 分开存，理由同 `agentsStore.tombstones`（存活数组天生只含存活项）。
   * 会话的删除在磁盘上由索引条目的 `deletedAt` 承载（`tombstoneSession` → `tombstoneEntry`），
   * 而同步层需要一份**同步可读**的内存镜像——`loadSessions` 末尾从 `readIndex()` 的
   * 原始索引（含墓碑）填充，`deleteSession` / `deleteSessions` 与远端落地时写入。
   *
   * 为什么不能用 `sessions` 数组内的 `deletedAt` 承载：`loadSessions` 的列表来源是
   * `listSessions()`（**已过滤墓碑**），墓碑根本进不了 `sessions`；且数组里放墓碑会与
   * 合成逻辑打架（同 `SyncTombstones` 的说明）。
   */
  sessionTombstones: Record<string, SyncMeta>;
  activeId: string | null;
  /**
   * 按会话隔离的流式状态映射：sessionId → 流式上下文。
   * 各会话彼此独立、可同时并发流式（对齐主流 AI 办公工具的多任务并行体验）；
   * 流结束后对应条目被移除。仅运行时状态，不持久化。
   */
  streams: Record<string, SessionStream>;
  /**
   * 逐条批准的待裁决队列（FIFO）。仅运行时状态，不持久化——请求 id 由引擎
   * 单次生成，重启后不存在可回传的对象，持久化只会留下「点了没反应」的死条目。
   *
   * 用队列而非单槽：多个会话可并发流式，各自都可能挂起等裁决；同一轮里的
   * 并行工具调用也会产生多条。UI 只呈现队首，逐条处理。
   */
  pendingApprovals: PendingApproval[];
  error: string | null;
  /** 记忆注入运行时提示状态（不持久化） */
  memoryLoaded: MemoryState;

  // —— 会话 CRUD ——
  /**
   * 创建会话。opts 携带会话级上下文（工作空间 / 权限策略），
   * 供侧边栏「在某工作空间下新建会话」等入口使用。
   * agentId 缺省时按「全局活跃专家团 > 全局活跃专家」兜底（与召唤逻辑对齐）；
   * 绑定专家团时 agentId 取团内首位启用成员作为执行代表。
   */
  createSession: (
    agentId?: string,
    title?: string,
    opts?: {
      workdir?: string;
      fullAccess?: boolean;
      toolApproval?: boolean;
      /** 执行模式（FR-1.4）；缺省 craft */
      mode?: ExecutionMode;
      /**
       * 是否把「当前专家 / 专家团」及其技能继承到新会话。
       *
       * 缺省 `true`（保持既有语义：agentId 缺省时按全局活跃专家兜底，与召唤逻辑对齐）。
       * 「新建任务」入口显式传 `false`：新任务默认是一张白纸——输入框里不该预先冒出
       * 专家 chip 与技能 chips，挂谁由用户当场用 `+` 菜单 / `/` 指令决定。
       * 显式传入的 agentId 不受此开关影响（那是调用方的明确指派）。
       */
      inheritCapabilities?: boolean;
    },
  ) => Session;
  /**
   * 注入外部来源会话（IM 频道会话）并激活。
   * 同 id 已存在时整体替换（刷新消息 / 标题 / 时间）；
   * 频道会话不进入持久化白名单，每次打开从 nanobot 实时拉取。
   */
  openExternal: (session: Session) => void;
  /**
   * 启动水合：**会话列表来自索引**（不扫 JSONL），消息留待选中时按需加载。
   * 索引缺失或损坏时自动重建一次（索引是可再生派生物）。
   */
  loadSessions: () => Promise<void>;
  /**
   * 按需水合单个会话：读事件流 → 重建消息 → 建立记录器。幂等，可并发调用。
   * 外部来源会话（IM 频道 / 定时任务留痕）不落本地事件流，直接视为已就绪。
   */
  loadSession: (id: string) => Promise<void>;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /**
   * 批量删除会话（分组级「从列表中移除」用）。
   *
   * 刻意**不做**自动沉淀：一个自动任务分组动辄几十条执行记录，
   * 逐条调模型总结既慢又无检索价值，且删除是用户明确的「清掉」意图。
   */
  deleteSessions: (ids: string[]) => void;
  /**
   * pull 落地一条**存活**的会话元数据（`sessionMeta` collection，§D.4）。
   *
   * 与其余 collection 不同：会话的同步负载是「元数据投影」，落地要**双写**——
   * 内存 `sessions` + 磁盘 `<id>.meta.json` +（防抖）重建索引。写 meta 之后再
   * `rebuildIndex()` 是必需的：`EventStore.writeMeta` 只写 meta、**不动索引**，
   * 而列表来源是索引——不重建，重启后这条会话不会出现在列表里。
   *
   * `streamWorkdir` 在落地时**重定向为本机默认工作空间**（§D.5）：拉来的会话在本机
   * 还没有 JSONL，用对端路径做分片会让批次 5 的事件落在错误目录。
   */
  applyRemoteSessionMeta: (entity: Record<string, unknown>) => void;
  /** pull 落地一条会话**墓碑**（§D.4）：写墓碑 + 覆盖索引条目 + 丢弃正文。 */
  applyRemoteSessionTombstone: (entity: Record<string, unknown>) => void;
  renameSession: (id: string, title: string) => void;
  /** 切换置顶状态：分组内始终排在最前 */
  togglePinSession: (id: string) => void;
  /** 设置会话工作空间（undefined 表示清除，归入默认分组） */
  setSessionWorkdir: (id: string, workdir?: string) => void;
  /** 设置会话权限策略：true = 允许完全访问 */
  setSessionFullAccess: (id: string, fullAccess: boolean) => void;
  /**
   * 切换会话执行模式（FR-1.4）。
   *
   * 落到**事件**（`mode-change`）而非只落到 meta：模式切换决定了那一轮之后
   * 引擎「能做什么」，是会话历史的一部分——重放时可以回答「这句改动是在
   * Craft 下发生的吗」。meta 同步性则由 `persistMeta` 负责。
   */
  setSessionMode: (id: string, mode: ExecutionMode) => void;
  /** 设置会话级逐条批准：true = 副作用工具执行前逐一授权（FR-1.5） */
  setSessionToolApproval: (id: string, toolApproval: boolean) => void;
  /** 设置会话级模型覆盖 */
  setSessionModel: (id: string, model: string) => void;

  // —— 记忆 ——
  /** 关闭「已加载 N 条记忆」提示条 */
  dismissMemoryBar: () => void;
  /**
   * 异步读取记忆并缓存到指定会话。
   *
   * @param silent 只预热缓存、不更新「已加载 N 条记忆」提示条。打开既有会话时用
   *   ——提示条是「本次新建会话已注入记忆」的反馈，重开旧会话时再弹一次是噪音。
   */
  loadMemoryInto: (sessionId: string, opts?: { silent?: boolean }) => Promise<void>;

  /**
   * 会话里缓存的记忆快照是否已过期（**同步**判定：调用方据此决定要不要付一次
   * IO，所以它本身绝不能是 async）。
   *
   * 为何需要：快照只在 createSession / loadSession 生成一次，而记忆随时可能被写
   * ——模型本轮写下的 `<memory-save>`、另一个会话结束时的自动沉淀、记忆页的手动
   * 编辑。实测事故：A 会话写下「用户擅长前端 GIS 开发」，13 秒后 B 会话问
   * 「我擅长什么」，注入的仍是旧快照（证据是事件流里存着的完整请求体）。
   *
   * 两个判据：写入版本变了、或会话的 workdir 换了（同一份快照指向另一个文件）。
   *
   * 补刷点有两处：`selectSession`（切回会话时）与 `streamAssistantReply` 步骤 0.1
   * （发送前）。后者刻意排在流式槽位同步占位**之后**——判定与刷新都是异步 IO，
   * 提到占位之前会把「send 同步进入流式态」推后一个 microtask。
   */
  isMemorySnapshotStale: (sessionId: string) => boolean;

  // —— 发送 / 流式 ——
  /**
   * 在指定会话内发送消息并流式接收回复。
   * @param text 用户输入文本（可与 attachments 同时为空吗？不可；二者皆空直接返回 null）
   * @param sessionId 目标会话 id；缺省为当前活跃会话，均无时自动新建会话
   * @param attachments 随消息上传的附件；**可选**，既有调用方（tasksStore / retry）
   * 不传时行为完全不变
   * @returns 本次执行结果（会话 id + 本次请求的错误信息，错误不会被并发会话覆盖）；
   * 前置校验不通过（空文本且无附件 / 会话已在流式中 / 只读等）返回 null
   */
  send: (
    text: string,
    sessionId?: string,
    attachments?: Attachment[],
    richContent?: string,
  ) => Promise<{ sessionId: string; error: string | null } | null>;
  /**
   * 在已有用户消息上重新发送：用 newContent 替换该消息，清空其后的所有消息
   * （已有产物落盘不受影响），并发起一次新的助手流式响应。
   * 找不到消息 / 内容未变 / 只读 / 已在流式时静默 no-op。
   */
  resendFromMessage: (
    sessionId: string,
    messageId: string,
    newContent: string,
  ) => Promise<void>;
  /**
   * 中断指定会话正在流的请求（无活跃流时静默 no-op）。
   * @param sessionId 目标会话 id；缺省为当前活跃会话
   * 被打断的助手消息会被标记 aborted=true。
   */
  abort: (sessionId?: string) => void;
  /** 重试当前活跃会话最后一条 user 消息 */
  retry: () => Promise<void>;
  appendToken: (sessionId: string, messageId: string, chunk: string) => void;
  handleToolCall: (sessionId: string, messageId: string, ev: ToolCallEvent) => void;
  handleArtifact: (sessionId: string, messageId: string, ev: ArtifactEvent) => void;
  /** 深度思考文本片段：聚合进末尾未闭合思考段，无则开新段 */
  appendReasoning: (sessionId: string, messageId: string, chunk: string) => void;
  /** 闭合末尾未闭合的深度思考段 */
  closeReasoning: (sessionId: string, messageId: string) => void;
  /** 工具执行进度行（start=新增 running 行 / end=done / error=error） */
  handleProcessTool: (sessionId: string, messageId: string, ev: ProcessToolEvent) => void;
  /**
   * 专家团成员进度行（FR-2.4）：一次多成员编排里「谁在做什么」。
   *
   * 与工具行不同，**同一成员会有多行**（开始 / 完成 / 失败…），归属靠
   * `MemberEvent.memberId`；渲染时才按它分组（见 `lib/processDetail.ts`）。
   * 这里不做聚合：聚合是展示档位的事，落库保持「一个相位一行」的原始事实。
   */
  handleProcessMember: (sessionId: string, messageId: string, ev: ProcessMemberEvent) => void;
  /**
   * 引擎发来逐条批准请求（引擎已挂起该工具调用）：入队 + 在消息上记一条
   * pending 行，并把会话状态置为 tooling。
   */
  handleApprovalRequest: (
    sessionId: string,
    messageId: string,
    req: ApprovalRequestEvent,
  ) => void;
  /**
   * 裁决队首的逐条批准请求并回传引擎。
   *
   * @param decision 允许 / 拒绝 / 本会话始终允许
   * @param reason 拒绝原因（可选）；引擎会回灌给模型让它改道
   *
   * 回传失败（请求已超时/已取消）时提示用户并仍出队——该请求已死，
   * 留在队列里只会反复失败。
   */
  resolveApproval: (decision: ApprovalDecision, reason?: string) => Promise<void>;
  /**
   * Plan 模式产出的计划到达（FR-1.5）：落到 `plan` 事件并挂在助手消息上。
   *
   * 与 `handleApprovalRequest` **不构成**同一类 things：计划不需要本轮回话，
   * 引擎放行 `submit_plan` 后继续把这一轮说完，用户何时裁决由 UI 决定。
   */
  handlePlan: (sessionId: string, messageId: string, plan: PlanProposal) => void;
  /**
   * 裁决一条计划（FR-1.5）。
   *
   * @param planId `MessagePlan.planId`；同一会话内唯一，用它寻址而非消息 id，
   *   是为了让未来「一条消息多份计划」不必改签名
   * @param decision approved / rejected
   * @param opts.approvedStepIds 批准范围（缺省 = 全批准，`[]` = 一项不批）
   * @param opts.reason 打回意见：会被原样带给下一轮，让模型据此重规划
   *
   * 批准会**顺带把会话切到 Craft**——否则批准的语义是空的：引擎在 Plan 模式下
   * 依旧拒绝一切写类工具，所谓「批准后进入执行」就成了一句谎话。
   * 是否立刻发起下一轮由 `execute: true` 决定（缺省不自动发）。
   *
   * @returns 是否成功裁决（计划不存在 / 已裁决过返回 false）
   */
  resolvePlan: (
    planId: string,
    decision: PlanVerdict,
    opts?: {
      approvedStepIds?: string[];
      reason?: string;
      /** 批准后是否立即以该范围为内容发起一轮执行请求；缺省 false */
      execute?: boolean;
    },
  ) => Promise<boolean>;
  clearError: () => void;

  // —— 内部更新工具 ——
  updateSession: (id: string, updater: (s: Session) => Session) => void;
  updateMessage: (
    sessionId: string,
    messageId: string,
    updater: (m: Message) => Message,
  ) => void;
}

const nowIso = () => new Date().toISOString();

// ————————————————————————————————————————————————————————————————
// 事件流接线（D2 Phase C）：事件流是事实源，本 store 是内存视图
// ————————————————————————————————————————————————————————————————

/**
 * 会话是否写入本地事件流。
 *
 * 三类会话**不写**——它们的真值在引擎侧，本地落盘只会制造两份互相打架的数据：
 * - IM 频道会话（`channel`）：每次打开从 nanobot 实时拉取；
 * - 只读留痕会话（`readonly`）：引擎已完成的历史快照；
 * - 定时任务执行会话（`cron:` 前缀）：引擎按 run 持有，本地存副本会与下次同步重复。
 *
 * 前两条与旧 `persist` 的 `partialize` 白名单一致；第三条是**新增的明确排除**：
 * 旧实现把它们持久化过（注释写着「非 readonly 以便持久化」），那其实是在本地
 * 复制引擎的权威数据，Phase E 起不再这么做。
 *
 * **导出**（批次 5）：事件流同步适配器（`src/sync/eventStream.ts`）据此过滤本机
 * 存在事件流的会话，避免在适配器里复制一份判据而漂移。
 */
export function isEventStreamSession(s: Pick<Session, 'id' | 'channel' | 'readonly'>): boolean {
  return !s.channel && !s.readonly && !s.id.startsWith(CRON_SESSION_ID_PREFIX);
}

/** 事件流操作的错误出口：提示用户 + 记控制台（内存视图不清空——它此时仍是权威） */
function reportStreamError(sessionId: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[sessionsStore] 事件流操作失败（${sessionId}）：`, error);
  // 同时落一行日志（FR-11.3）：控制台随窗口关闭就消失，而「记录写入失败」
  // 恰恰是用户事后想回溯的问题——它已经不可复现了（内存视图仍是好的）。
  log.error('events', '事件流操作失败', { sessionId, error: msg });
  toast.error(`会话记录写入失败：${msg}`);
}

/**
 * 对话失败的日志落点（FR-11.3）。
 *
 * ## 为什么必须是**两**条路径共用一个出口
 *
 * 2026-10-04 的真机验证抓到的第一个缺陷就是这个：最初只在最外层的 `catch` 里落了
 * 日志，而**绝大多数失败根本走不到那里**——引擎报错 / 断流超时是由
 * `handlers.onError` 上报的（见下方 `onError` 分支），它把 `sendError` 一写就结束了。
 * 结果是「跑一轮失败对话，日志里一条都没有」，而那恰恰是用户最会来问的场景。
 *
 * 两条路径的**下一步不同**，所以文案也分开（`phase`）：
 * - `stream`：请求发出去了、引擎答了话但它说失败（先看引擎 / 模型）；
 * - `request`：请求压根没能建立（先看网关起没起、地址对不对）。
 */
function logChatFailure(sessionId: string, phase: 'stream' | 'request', message: string): void {
  log.error('chat', phase === 'stream' ? '对话流失败' : '发送请求失败', {
    sessionId,
    phase,
    error: message,
  });
}

/**
 * 把刚结束的这一回合折成一份 trace 落盘（FR-11.2）。
 *
 * ## 为什么在这里取值、而不是重新读一遍事件流
 *
 * 事件流的写入是**异步入队**的（`recordEvents` 只把构造好的事件排进队列），此刻
 * 读盘既可能读到半截、也要多付一次 IO。记录器的**回合缓冲**（`takeTurnEvents`）
 * 给的正是这一轮事件的原始对象——构造与消费同一批，不存在两种推导。
 *
 * ## 为什么整段吞错
 *
 * 调用点在回合收尾路径上（所有出口 done / error / abort 的唯一交汇点）。可观测性
 * 是旁路：它失败只该少一份 trace，绝不能把这一轮的收尾打挂——那会换来一个
 * 「发消息报错」的假象，而真正的原因在 trace 里（如果它还能写出来的话）。
 */
function persistTurnTrace(sessionId: string): void {
  try {
    const events = takeTurnEvents(sessionId);
    if (events.length === 0) return;
    const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
    // channel / readonly / cron 三类会话的事实源在引擎侧，本地没有事件流
    // （`recordFor` 对它们根本不写盘），也就没有「本机这一轮」可言。
    if (session && !isEventStreamSession(session)) return;

    const file = buildTurnTrace(events, {
      sessionId,
      agentId: session?.agentId || undefined,
    });
    // fire-and-forget：写盘在主进程，渲染层不等（见 PlatformAdapter.writeTrace）
    platform.writeTrace(file);
  } catch (e) {
    log.warn('trace', '构建回合 trace 失败', { sessionId, error: String(e) });
  }
}

// 记录器的写盘失败走同一出口（模块初始化时注册一次）
setRecordErrorSink(reportStreamError);

/**
 * 会话的**事件流落盘分片**（`.`jsonl` / `.meta.json` 所在目录对应的路径）。
 *
 * 未冻结（`streamWorkdir` 为空）时即等于工作空间——新建会话与从未发过消息的会话
 * 都是这个形态，此时记录随工作空间走；一旦冻结就不再变化。所有按目录取文件的
 * 读写（读事件、写 meta、删会话）都必须走它，而不是 `session.workdir`。
 */
function streamShardOf(s: Pick<Session, 'workdir' | 'streamWorkdir'>): string | undefined {
  return s.streamWorkdir ?? s.workdir;
}

/** 会话视图 → 元数据（`SessionMeta` 是事件流的权威元数据，见 `@/types/event`） */
function toMeta(s: Session): SessionMeta {
  const shard = streamShardOf(s);
  return {
    id: s.id,
    title: s.title,
    agentId: s.agentId,
    groupId: s.groupId ?? null,
    // `workdir` 写**分片**（meta 与 jsonl 必须同目录，主进程按它推目录），
    // 语义工作空间写进 `workspace`——两者相同则省略，省得每份 meta 都多一个字段
    workdir: shard,
    ...(s.workdir !== undefined && s.workdir !== shard
      ? { workspace: s.workdir }
      : {}),
    // 执行模式（ask / plan / craft，FR-1.4）：缺省 craft——事件化之前的会话
    // 一律按「可直接执行」记账，缺失值不是「未知模式」
    mode: s.mode ?? 'craft',
    model: s.model,
    permissionMode: s.fullAccess ? 'full' : 'restricted',
    toolApproval: s.toolApproval,
    skillIds: s.skillIds,
    channel: s.channel,
    readonly: s.readonly,
    pinned: s.pinned,
    // 会话版本引用集（FR-3.9 ①）：声明性质，必须随 meta 落盘，否则重启即丢失
    pluginVersions: s.pluginVersions,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    // 同步元数据（第 19 章）：`rev` / `updatedBy` 由 `updateSession` 自动维护
    // （见 `lib/sessionSyncMeta.ts`）；这里是**唯一的落盘出口**，漏掉就等于没记过
    rev: s.rev,
    updatedBy: s.updatedBy,
  };
}

/** 取会话；不存在或非本地事件流会话时返回 null */
function eventStreamTarget(sessionId: string): Session | null {
  const s = useSessionsStore.getState().sessions.find((x) => x.id === sessionId);
  return s && isEventStreamSession(s) ? s : null;
}

/**
 * 记录一批事件（**构造同步、写盘异步**，见 `@/events/recorder` 的说明）。
 *
 * 外部来源会话直接跳过（正常路径）。本地会话却缺记录器说明漏了水合——此时
 * **上报而非抛出**：本函数会在 SSE 回调栈上被调用，抛错会打断整条流，而漏记
 * 一条事件是可恢复的（内存视图仍是当前权威，下次加载以磁盘为准）。
 */
function recordFor(
  sessionId: string,
  build: (factory: EventFactory) => SessionEvent | SessionEvent[],
): SessionEvent[] {
  if (!eventStreamTarget(sessionId)) return [];
  if (!hasRecorder(sessionId)) {
    reportStreamError(sessionId, new Error('事件记录器未就绪，本次事件未落盘'));
    return [];
  }
  return recordEvents(sessionId, build);
}

/** 落盘会话元数据（标题 / 置顶 / 权限 / 模型等**非事件型**变更） */
function persistMeta(s: Session): void {
  if (!isEventStreamSession(s)) return;
  void getEventStore()
    .writeMeta(toMeta(s))
    .catch((e: unknown) => reportStreamError(s.id, e));
}

/** `updateSession` 之后按 id 取回并落盘元数据 */
function persistMetaOf(sessionId: string): void {
  const target = eventStreamTarget(sessionId);
  if (target) persistMeta(target);
}

/**
 * 删除会话：**打墓碑**并丢弃事件流正文与记录器。
 *
 * ## 为什么不再是 `removeSession`（硬删）
 *
 * 硬删把 `meta` 与索引条目**一并抹掉**，删除因此没有载体可以传播——另一台设备
 * 下次同步时又会把自己那份推回来，用户看到的是「删掉的会话自己回来了」。
 * 墓碑（`deletedAt` + `rev` + `updatedBy`）是唯一能让删除进入 LWW 裁决的载体
 * （FR-10.1，见 `architecture-syncmeta.md` §7.3）。**正文仍然丢弃**：删了就不该
 * 再留在盘上，而墓碑只留 `id` 与元数据这些小对象。
 *
 * 必须排进该会话的写队列：否则「刚排队的追加」会在删除之后又把正文写回来。
 * 删除完成后才丢记录器（队列条目随之释放）。
 */
function tombstoneSessionStream(s: Session): void {
  hydratedSessions.delete(s.id);
  if (!isEventStreamSession(s)) return;
  const id = s.id;
  // 墓碑按**分片**落盘（`toMeta` 内部走 `streamShardOf`）：切过工作空间的会话，
  // 元数据仍在原分片里。按 `s.workdir` 去写会留下原分片那份「没打墓碑的元数据」，
  // 它在下一次重建索引时会让这个会话复活。
  const tombstone: SessionMeta = { ...toMeta(s), ...sessionDeletePatch(s) };
  void enqueueSessionTask(id, async () => {
    await getEventStore().tombstoneSession(tombstone);
  }).then(
    () => dropRecorder(id),
    (e: unknown) => reportStreamError(id, e),
  );
}

// ————————————————————————————————————————————————————————————————
// 同步落地（批次 4）：sessionMeta collection 的读写转换
// ————————————————————————————————————————————————————————————————

/** 索引重建的防抖窗口（毫秒）：合并短时间内多条落地为一次重建 */
const INDEX_REBUILD_DEBOUNCE_MS = 300;
/** 索引重建的防抖定时器（模块级，跨落地共享） */
let indexRebuildTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 请求一次**防抖的索引重建**。
 *
 * `EventStore.writeMeta` / `tombstoneSession` 的写入路径都维护索引，但落地远端会话时
 * 我们要把「本机此前没有的会话」补进列表——`writeMeta` 只写 meta 不动索引，只有在
 * `rebuildIndex()`（内部 `entryFromMeta(meta, counters)`）之后它才会出现在列表里。
 * 每条落地各重建一次会重复扫盘，故用防抖合并。
 */
function requestIndexRebuild(): void {
  if (indexRebuildTimer !== null) clearTimeout(indexRebuildTimer);
  indexRebuildTimer = setTimeout(() => {
    indexRebuildTimer = null;
    void getEventStore().rebuildIndex().catch(() => undefined);
  }, INDEX_REBUILD_DEBOUNCE_MS);
}

/** 由 `SessionMeta` 组装会话视图（仅元数据派生字段；runtime 字段留空由调用方补） */
function buildSessionFromMeta(meta: SessionMeta): Session {
  return { ...metaToSession(meta), messages: [], permissionLog: [] };
}

/**
 * 从实体上摘出**版本引用集**并逐项校验（FR-3.9 ①）。
 *
 * 逐项过滤而不是整体信任：引用集是**加强信息**（GC 保护 + 版本提示），
 * 一条格式不对不该让整次 pull 落地失败。空集归一为 `undefined`——
 * 「没有引用集」与「引用集为空」语义相同，不必多存一种形态。
 */
function pluginVersionsOf(entity: Record<string, unknown>): Record<string, string> | undefined {
  const raw = entity.pluginVersions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(raw as Record<string, unknown>)) {
    if (name === '') continue;
    if (typeof version !== 'string' || version === '') continue;
    out[name] = version;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}


/**
 * 由同步负载（`sessionMeta` collection 的 entity）组装 `SessionMeta`（**落盘形态**）。
 *
 * ⚠️ 负载里的 `workdir` 是**语义工作空间**（`SESSION_SYNC_FIELDS` 的白名单字段），
 * **不是落盘分片**。落盘分片必须**重定向为本机默认工作空间**（§D.5）：拉来的会话在
 * 本机还没有 JSONL，若用对端路径做分片，`streamShardOf = streamWorkdir ?? workdir`
 * 会回退到对端路径，批次 5 的事件就落在错误目录。故这里把 `workdir`（分片）写成
 * 本机默认、把对端语义工作空间写进 `workspace`（`toMeta` 的落盘约定）。
 *
 * 墓碑负载**不带**业务字段（`tombstoneEntries()` 只产出 `id` + 元数据），此时
 * `workdir` 落到本机默认、`workspace` 缺省——正好是「本机无此会话」的正确形态。
 */
export function toMetaFromEntity(entity: Record<string, unknown>): SessionMeta {
  const streamShard = resolveDefaultWorkspacePath();
  const semanticWorkdir = typeof entity.workdir === 'string' ? entity.workdir : undefined;
  const now = new Date().toISOString();
  return {
    id: String(entity.id),
    title: typeof entity.title === 'string' && entity.title ? entity.title : '新任务',
    agentId:
      typeof entity.agentId === 'string' && entity.agentId
        ? entity.agentId
        : UNBOUND_AGENT_SENTINEL,
    groupId: typeof entity.groupId === 'string' ? entity.groupId : null,
    workdir: streamShard,
    ...(semanticWorkdir !== undefined && semanticWorkdir !== streamShard
      ? { workspace: semanticWorkdir }
      : {}),
    mode: isExecutionMode(entity.mode) ? entity.mode : 'craft',
    ...(typeof entity.model === 'string' ? { model: entity.model } : {}),
    permissionMode: entity.fullAccess === true ? 'full' : 'restricted',
    ...(typeof entity.toolApproval === 'boolean' ? { toolApproval: entity.toolApproval } : {}),
    ...(Array.isArray(entity.skillIds)
      ? {
          skillIds: (entity.skillIds as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          ),
        }
      : {}),
    ...(typeof entity.channel === 'string' ? { channel: entity.channel } : {}),
    ...(typeof entity.readonly === 'boolean' ? { readonly: entity.readonly } : {}),
    ...(typeof entity.pinned === 'boolean' ? { pinned: entity.pinned } : {}),
    // 会话版本引用集（FR-3.9 ①）：同步负载里带的是 `{插件名: 版本}` 的**声明**，
    // 逐项过滤非法值而不是整体信任——一条格式不对的引用集不该让整次落地失败
    ...(pluginVersionsOf(entity) ? { pluginVersions: pluginVersionsOf(entity) } : {}),
    createdAt: typeof entity.createdAt === 'string' ? entity.createdAt : now,
    updatedAt: typeof entity.updatedAt === 'string' ? entity.updatedAt : now,
    rev: typeof entity.rev === 'number' ? entity.rev : undefined,
    updatedBy: typeof entity.updatedBy === 'string' ? entity.updatedBy : undefined,
    deletedAt: typeof entity.deletedAt === 'string' ? entity.deletedAt : null,
  };
}

/** 从同步负载 / 会话实体身上摘出**四个同步元数据字段**（归一后返回） */
export function sessionMetaOf(entity: Record<string, unknown>): SyncMeta {
  return normalizeMeta(entity as SyncMetaInput);
}


// ————————————————————————————————————————————————————————————————
// 读路径接线（D2 Phase D）：列表来自索引，消息按需从事件流重建
// ————————————————————————————————————————————————————————————————

/**
 * 已完成「事件 → 消息」重建的会话 id。
 *
 * 放模块作用域而非 store state：它是纯粹的去重标记，进 state 只会制造
 * 无意义的订阅与重渲染（视图拿不到也不需要它）。
 */
const hydratedSessions = new Set<string>();
/** 进行中的水合（并发去重：列表点击与 `send` 可能同时触发） */
const hydrating = new Map<string, Promise<void>>();

/** 记住「上次打开的会话」，供下次启动恢复；与业务数据无关，故独立于事件流 */
function rememberActiveSession(id: string | null): void {
  void platform.storage.set(STORAGE_KEYS.activeSession, id ?? '');
}

/**
 * 清掉旧版整块持久化留下的数据。
 *
 * 该键已无任何读取方（旧的解析路径随 Phase E 一并移除），留着只会成为永远读不到
 * 的孤儿；历史会话已由用户清空，故无需迁移，直接清理。
 */
function purgeLegacySessionSnapshot(): void {
  void platform.storage.remove(STORAGE_KEYS.legacySessions).catch(() => undefined);
}

/**
 * 闭合消息末尾未闭合的**思考段**：落一条终值 `reasoning` 事件，并同步闭合视图。
 *
 * 思考段是流式聚合的（逐 chunk 累积），不能逐 chunk 写盘，故采用「闭合时才落
 * 一条终值事件」。视图侧有三个闭合时机（工具开始 / 正文开始 / 回合结束），
 * 本函数挂在同一批时机上，保证两条推导路径不会各闭各的。
 *
 * 无未闭合段时是 no-op，因此可以安全地挂在每 token 的路径上。
 */
function flushReasoning(sessionId: string, messageId: string): void {
  const msg = useSessionsStore
    .getState()
    .sessions.find((s) => s.id === sessionId)
    ?.messages.find((m) => m.id === messageId);
  const process = msg?.process ?? [];
  const last = process[process.length - 1];
  if (!last || last.kind !== 'reasoning' || last.closed) return;

  // 事件与视图都基于同一份 content，先后无关；先写事件便于按 seq 阅读。
  // 落盘后把事件 id 回写到行上，保证「实时视图」与「重放投影」的行 id 一致。
  const [ev] = recordFor(sessionId, (f) =>
    f.reasoning({ messageId, content: last.content, done: true }),
  );
  useSessionsStore
    .getState()
    .updateMessage(sessionId, messageId, (m) => closeOpenReasoning(m, ev?.id));
}

/**
 * 在指定会话内为「已就位的助手占位消息」发起流式响应。
 * 通用流式逻辑：拼装 system+skills+memory+本地时间+历史 → 建立流式上下文 →
 * 启动 client → 收敛流式状态。
 * 共享给 send() 与 resendFromMessage() 使用，避免两处流式路径漂移。
 * 调用方负责前置校验（会话存在 / 非只读 / 未在流式），函数内不重复检查。
 *
 * @param files 随本次请求上传的文件（base64 载荷）；缺省为纯文本请求。
 * 有文件时 nanobotClient 自动切换 multipart/form-data。
 *
 * 返回 `error`: null = 成功完成；非空字符串 = 流中或连接阶段的错误消息。
 */
async function streamAssistantReply(
  sessionId: string,
  assistantId: string,
  files?: UploadFile[],
): Promise<{ error: string | null }> {
  const { sessions } = useSessionsStore.getState();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return { error: '会话不存在' };
  const agents = useAgentsStore.getState().agents;

  // 0) 同步占住流式槽位——**必须在任何 await 之前**。
  // 「同一会话并发 send 被拒绝、不同会话可并发」依赖这一性质：
  // tests/sessionsStore.test.ts 的并发用例在不 await 的情况下就断言 streams[sid] 已就绪。
  useSessionsStore.setState((s) => ({
    streams: { ...s.streams, [sessionId]: { status: 'thinking', active: true } },
    error: null,
  }));

  // 0.1) 记忆快照过期则刷新。**位置在槽位之后，不是之前**：读盘是异步的，若提到
  // 槽位前面，这次 await 会把「同步进入流式态」整体推后一个 microtask，并发互斥
  // 随之失效。快照过期 = 会话存活期间记忆被写过（本会话上一轮的 `<memory-save>`、
  // 别处会话的自动沉淀、记忆页编辑），不刷就会拿旧快照回答——「刚告诉它我会 GIS，
  // 下一句它却不知道」正是这么来的。loadMemoryInto 自带 try/catch，失败静默保留旧快照。
  if (useSessionsStore.getState().isMemorySnapshotStale(sessionId)) {
    await useSessionsStore.getState().loadMemoryInto(sessionId, { silent: true });
  }

  // 1) 构造 history：system 段（统一经装配器）+ 历史消息
  //
  // 装配走 `assemblePromptSections`（§13.3）：段序与标签统一收口在那里，本函数
  // 只负责把各来源解析成字符串。**装配段全程同步**（上面 0.1 是唯一的 await，
  // 且已在槽位之后）——这正是三个服务都提供同步取值的原因
  // （PromptLibrary.resolveSync / IdentityService.contentSync / 会话缓存的 memory 快照）。
  const agent = agents.find((a) => a.id === session.agentId);
  const settings = useSettingsStore.getState().settings;

  // 记忆注入：读取本会话缓存的快照，以标签块追加在 system 段末尾。
  // 永不写入 agent.systemPrompt，仅存在于本次请求的临时 history。
  // 用户在提示条上「关闭」后（memoryLoaded.dismissed），临时停止注入，
  // 避免旧记忆干扰当前 Agent 人设；新建会话时 dismissed 会重置。
  //
  // 快照是**纯缓存**、不进事件流（内容随时可从 MEMORY.md 重读）：由
  // `createSession`（带提示条）与 `loadSession`（静默预热）写入，`selectSession`
  // 在切回会话时补刷一次；本函数开头（步骤 0.1）还会在流式槽位占位后补刷一次。
  const memorySnapshot =
    useSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.memory ?? '';
  const memoryDismissed = useSessionsStore.getState().memoryLoaded.dismissed;
  const memoryBlock =
    !memoryDismissed && settings.memoryEnabled && memorySnapshot.trim() !== ''
      ? MemoryService.wrapForInjection(memorySnapshot)
      : '';

  // 记忆写入协议：与记忆能力同开同关。
  // 关掉 autoSummarize 就等于「不要长期记忆」，此时再告诉模型怎么记一条，
  // 它只会反复追问「要我记住吗」而写不进去——能力与说明必须成对出现。
  const memoryWrite =
    settings.memoryEnabled && settings.autoSummarize ? MEMORY_WRITE_INSTRUCTION : '';

  // 技能注入：把本会话挂载且已启用的技能 prompt 追加在 system 段末尾。
  const skills = useSkillsStore
    .getState()
    .skills.filter(
      (sk) => session.skillIds?.includes(sk.id) && sk.enabled && sk.prompt.trim() !== '',
    );

  // 本地时间提示（仅存在于本次请求的临时 history，不落库不污染人设）。
  // 智能体处理「30分钟后」「后天2点半」等相对时间时，需据此换算为绝对时间后
  // 再调用 cron 工具，避免时区/基准歧义导致调度偏差。
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localTime = now.toLocaleString('zh-CN', { timeZone, hour12: false });
  const localTimeNote = `当前本地时间：${localTime}（时区 ${timeZone}，ISO ${now.toISOString()}）。当用户提出相对时间（如"30分钟后""后天2点半""8月底"）的提醒/定时任务时，请据此换算为绝对时间后再调用 cron 工具。`;

  // Agent 级覆盖优先于全局设置：字段省略 = 跟随全局（不要用 ?? 填成确定值，
  // 那会抹掉「跟随全局」这个状态，见 types/agent.ts 的注释）。
  const domain = agent?.promptDomain ?? settings.promptDomain ?? DEFAULT_PROMPT_DOMAIN;
  const style = agent?.promptStyle ?? settings.promptStyle ?? DEFAULT_PROMPT_STYLE;

  const history: ChatMessageParam[] = assemblePromptSections({
    agentPersona: agent?.systemPrompt,
    identity: {
      soul: IdentityService.contentSync('soul'),
      identity: IdentityService.contentSync('identity'),
      user: IdentityService.contentSync('user'),
      // 引导文件未被 IdentityService.loadAll() 读过时 isOnboarding() 为 false，
      // 因此「没加载」不会把每个会话都推进引导态。
      bootstrap: IdentityService.isOnboarding() ? IdentityService.contentSync('bootstrap') : '',
    },
    style: PromptLibrary.resolveSync('style', style),
    mode: PromptLibrary.resolveSync('mode', session.mode ?? 'craft'),
    domain: PromptLibrary.resolveSync('domain', domain),
    userInstructions: settings.userCustomPrompt,
    memory: memoryBlock,
    memoryWrite,
    skills: skills.map((sk) => sk.prompt),
    localTime: localTimeNote,
  }).map((section) => ({ role: 'system' as const, content: section.content }));

  useSessionsStore
    .getState()
    .sessions.find((s) => s.id === sessionId)
    ?.messages.forEach((m) => {
      if (m.id === assistantId) return; // 排除占位
      // 纯附件消息（用户未敲字）content 为空，但必须进 history，
      // 否则「只发文件」的场景下该文件轮次会在上下文里凭空消失
      const hasPayload = m.content.trim() !== '' || (m.attachments?.length ?? 0) > 0;
      if ((m.role === 'user' || m.role === 'assistant') && hasPayload) {
        history.push({ role: m.role, content: m.content });
      }
    });

  /**
   * 专家团编排（FR-2.4 路径②）：会话绑定的团在「≥2 名启用成员」时由引擎接管本轮。
   *
   * 解析不到团 / 团已停用 / 启用成员不足 → `undefined`，退回「以团内首位启用成员为
   * `agentId` 的单专家一轮」（既有行为），不产生任何额外调用。构造与判据收在
   * `buildExpertGroupRequest` 里，便于单测。
   *
   * 用 `getState()` 读一次而不订阅：这是发送动作里的取值，不是渲染依赖。
   */
  const group = session.groupId
    ? useExpertGroupsStore.getState().groups.find((g) => g.id === session.groupId)
    : undefined;
  const expertGroup = buildExpertGroupRequest(
    group,
    agents,
    availablePresetIds(useModelsStore.getState().models),
  );

  const req: ChatRequest = {
    agentId: session.agentId,
    messages: history,
    stream: true,
    // 模型：**会话显式选择 > 专家绑定（FR-2.3）> 空**（空 = 省略 model 字段，
    // 由网关用它配置里的默认模型）。
    //
    // 两个候选都要过一遍「预设是否还在目录里」的校验：预设被删/改名后，绑定就成了
    // 一个指向不存在东西的字符串，而引擎收到未知预设**直接报错**——不拦的话，
    // 「设置里删掉一个预设」会表现为「所有绑过它的专家每一轮都发不出去」。
    // 校验规则与「目录未加载时不校验」的理由见 `lib/agentBinding.ts`。
    //
    // 用 `getState()` 读一次而不订阅：这是发送动作里的取值，不是渲染依赖。
    model: resolveTurnModel(
      session.model,
      agent?.model,
      availablePresetIds(useModelsStore.getState().models),
    ),
    sessionId,
    // 附件上传：仅在本次确实带文件时下发，nanobotClient 据此切 multipart
    ...(files && files.length > 0 ? { files } : {}),
    // 会话级工作空间：引擎按 turn 解析 workspace_scope 生效；
    // 权限仅「完全访问」时显式下发 full，默认权限跟随引擎配置默认
    //
    // `?? resolveDefaultWorkspacePath()` 是**兜底而不是等价改写**：`createSession`
    // 已经把默认路径写进 `workdir`，正常会话走不到这里。会走到的只有两种——
    // ① 会话建立在「主进程还没回过存储信息」的那一瞬；② 早于该功能存在的旧会话。
    // 不给兜底的话，请求里 `workspace` 就是 undefined，引擎退回它**自己**配置里的
    // 默认工作空间（开发机上是个仓库内路径），模型在提示词里看到的就是那个目录——
    // 于是「设置里写着 NanoWork、文件却写去了别处」。
    workspace: session.workdir ?? resolveDefaultWorkspacePath(),
    accessMode: session.fullAccess ? 'full' : undefined,
    // 逐条批准（tool_approval 轴）：两种权限开关是正交的，但「完全访问」更粗——
    // 它已经表达了「别问我」，因此开启时不再叠加逐条审批，避免两个开关互相打架。
    approvalMode: session.toolApproval && !session.fullAccess ? 'ask' : undefined,
    // 执行模式（session_mode 轴，FR-1.4）：与上面三轴同处会话级 scope。
    // 显式传缺省值 craft 而不省略——模式决定的是「能不能写」，缺失时宁按
    // 「可写」记账也不能让引擎猜；写清楚还能让 SSE 里的拒绝原因对得上。
    sessionMode: session.mode ?? 'craft',
    // Agent 工具白名单（FR-2.2）：随会话所用 Agent 的定义下发，由引擎的工具
    // 网关强制。每轮都发而不是持久化——策略必须始终镜像**当前**的 Agent 配置，
    // 而不是某个陈旧的快照。`?? undefined` 保持「未设置」而非「空数组」。
    toolAllow: agent?.toolAllow ?? undefined,
    toolDeny: agent?.toolDeny ?? undefined,
    // 专家团编排：命中时引擎按成员派发。注意顶层 `toolAllow`（团长的策略）仍是
    // 本轮作用域的**上限**——成员只能在其内进一步收窄（引擎侧权限单调递减）。
    ...(expertGroup ? { expertGroup } : {}),
  };

  /**
   * 更新该会话的流式上下文。
   * 条目已被清理、或已收敛为 idle（用户已 abort）时静默 no-op，
   * 避免 abort 后迟到的状态回调复活「流式中」UI。
   */
  const patchStream = (patch: Partial<SessionStream>) =>
    useSessionsStore.setState((s) => {
      const cur = s.streams[sessionId];
      if (!cur || cur.status === 'idle') return s;
      return { ...s, streams: { ...s.streams, [sessionId]: { ...cur, ...patch } } };
    });

  // 本次请求的错误信息（局部捕获，避免被并发会话的全局 error 覆盖）
  let sendError: string | null = null;
  /**
   * 本轮是否被引擎侧异常打断（断流 / 引擎报错 / 撞上迭代上限）。
   *
   * 与 `sendError` 一样是**局部**捕获：并发会话的中断不该污染另一条会话的结算。
   * 它决定结算时的 `reason`（`interrupted` 而不是 `done`）与事件落盘字段。
   */
  let interrupted = false;
  try {
    // 大附件先给预期：网关要解码、解析文档再交给模型，可能耗时数分钟。
    // 不给提示的话，用户面对几分钟的空白会以为「点了发送没反应」或已经卡死。
    const attachBytes = (files ?? []).reduce(
      (sum, f) => sum + Math.floor(((f.content?.length ?? 0) * 3) / 4),
      0,
    );
    if (attachBytes > 2 * 1024 * 1024) {
      toast.info(
        `已上传 ${(attachBytes / (1024 * 1024)).toFixed(1)} MB 附件，网关解析处理可能需要几分钟，请耐心等待`,
      );
    }
    const client = await connectionManager.getClient();
    // 经契约层发起流式对话：`chat()` 在流结束（正常 / 报错 / 被中断）后解析，
    // 协议级错误经 onError 上报；中断由 useSessionsStore.abort() 走
    // runtime.abort(sessionId)，此处不需要持有任何句柄。
    await client.chat(req, {
      onStatus: (status) => {
        if (status !== 'done') patchStream({ status });
      },
      onToken: (chunk) =>
        useSessionsStore.getState().appendToken(sessionId, assistantId, chunk),
      onToolCall: (ev) =>
        useSessionsStore.getState().handleToolCall(sessionId, assistantId, ev),
      onArtifact: (ev) =>
        useSessionsStore.getState().handleArtifact(sessionId, assistantId, ev),
      onReasoning: (chunk) =>
        useSessionsStore.getState().appendReasoning(sessionId, assistantId, chunk),
      onReasoningEnd: () =>
        useSessionsStore.getState().closeReasoning(sessionId, assistantId),
      onProcessTool: (ev) =>
        useSessionsStore.getState().handleProcessTool(sessionId, assistantId, ev),
      onProcessMember: (ev) =>
        useSessionsStore.getState().handleProcessMember(sessionId, assistantId, ev),
      onApprovalRequest: (r) =>
        useSessionsStore.getState().handleApprovalRequest(sessionId, assistantId, r),
      onPlan: (plan) =>
        useSessionsStore.getState().handlePlan(sessionId, assistantId, plan),
      // 首字延迟采样（FR-11.7）：只落一条数据，不碰界面状态。
      // 「只有真的等到首字才触发」由 runtime 侧保证（没等到首字它不会回调），
      // 所以这里不必再判空——报了 null 样本只会污染报告的平均值。
      onLatency: (sample) => platform.recordSessionLatency(sample),
      onDone: () => patchStream({ status: 'done' }),
      onError: (err) => {
        sendError = err.message;
        useSessionsStore.setState({ error: err.message });
        // 协议级失败是**绝大多数**失败形态（引擎报错 / 断流超时都会走这里），
        // 而它不会抛到 `streamAssistantReply` 的外层 catch —— 两个出口都要记，
        // 否则「跑一轮失败的对话，日志里一条都没有」。
        logChatFailure(sessionId, 'stream', err.message);
        toast.error(`发送失败：${err.message}`);
      },
      onInterrupted: () => {
        // 不弹 toast：这不是「发送失败」，而是「发出去了、只回来一半」。提示走消息内
        // 常驻的警示行（见 AssistantMessage），长任务里 toast 一闪而过反而看不见。
        interrupted = true;
        useSessionsStore.getState().updateMessage(sessionId, assistantId, (m) => ({
          ...m,
          interrupted: true,
        }));
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendError = msg;
    useSessionsStore.setState({ error: msg });
    // 落一行日志（FR-11.3）：对话失败是「用户会来问」的头号问题，而 toast 一关就没。
    // 这条覆盖的是「请求压根没发出去」（拿不到 runtime / 同步抛错），
    // 协议级失败走上面 onError 那一条——两条都要，理由见 `logChatFailure`。
    logChatFailure(sessionId, 'request', msg);
    toast.error(`发送失败：${msg}`);
  } finally {
    // 回合边界：先把未闭合的思考段落盘（此后不会再追加），再结算助手消息。
    flushReasoning(sessionId, assistantId);

    // 结算本次耗时（消息头「已处理 33s」的数据源）：
    // 这里是所有出口（done / error / abort）的唯一交汇点，放这里才不会漏。
    // 已有 durationMs 时不覆盖（重放 / 水合恢复过的消息保持原值）。
    const settle = () => {
      const m = useSessionsStore
        .getState()
        .sessions.find((s) => s.id === sessionId)
        ?.messages.find((x) => x.id === assistantId);
      if (!m) return undefined;
      if (m.durationMs !== undefined) return m.durationMs;
      const startedAt = Date.parse(m.createdAt);
      if (Number.isNaN(startedAt)) return undefined;
      const elapsed = Date.now() - startedAt;
      return elapsed > 0 ? elapsed : undefined;
    };
    // 事件与视图必须拿到同一个值：先算一次，两处共用
    const durationMs = settle();
    const finalMsg = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === sessionId)
      ?.messages.find((x) => x.id === assistantId);
    const aborted = finalMsg?.aborted === true;
    /**
     * **跑了一半才断**的轮次必须自报家门。
     *
     * 静默超时（网关在超时窗口内一个字节都没吐）走的是 `onError`，**不是**
     * `onInterrupted`——于是这一轮既有正文、又在消息头显示成「已完成」，
     * 而事实是最后那一步工具的结果根本没回来。2026-10-01 报障正是这个形态：
     * 消息写着「已完成 11m52s」，最后一行却永远在转圈（客户端 120s 静默超时
     * 掐断了一轮仍在跑 `exec` 的回合）。
     *
     * 判据带上「是否已经产出过东西」：把「一开口就连不上」摘出去——那种情况
     * 没有半截结果可言，标成「被中断」反而误导（它是彻底的连接失败，走 toast）。
     */
    const partialError =
      !!sendError &&
      ((finalMsg?.content.trim().length ?? 0) > 0 || (finalMsg?.process?.length ?? 0) > 0);
    // 局部标记与消息上的标记取或：`onInterrupted` 已经写进消息，但并发/重放路径下
    // 局部变量才是这一轮的权威事实。
    const wasInterrupted = interrupted || finalMsg?.interrupted === true || partialError;
    const reason = sendError
      ? 'error'
      : aborted
        ? 'aborted'
        : wasInterrupted
          ? 'interrupted'
          : 'done';

    /**
     * 受控记忆写入（P2-A）：模型可能在本轮回答里夹带 `<memory-save>` 块。
     *
     * 剥离必须发生在**落盘之前**，且视图与事件用同一份结果——否则刷新一次
     * 协议标记就会从事件流里冒出来（实时视图 ≡ 重放投影，见 tests/events/equivalence）。
     * abort 的轮次不处理：半截回答里的指令块不可信。
     */
    const rawContent = finalMsg?.content ?? '';
    const directives = aborted ? [] : parseMemoryDirectives(rawContent);
    const visibleContent =
      directives.length > 0 ? stripMemoryDirectives(rawContent) : rawContent;

    if (visibleContent !== rawContent) {
      useSessionsStore.getState().updateMessage(sessionId, assistantId, (m) => ({
        ...m,
        content: visibleContent,
      }));
    }

    // 助手终值 + 回合边界落盘。助手正文是流式累积的，只能在回合结束以终值落盘
    // （同回合的工具 / 思考事件通过 messageId 关联到它，见 @/types/event）。
    recordFor(sessionId, (f) => [
      ...(sendError ? [f.error({ message: sendError })] : []),
      f.message({
        messageId: assistantId,
        role: 'assistant',
        content: visibleContent,
        // 创建时刻必须随事件落盘：助手消息的占位在回合**开始**就有了，
        // 而事件要等回合**结束**才写。不带 createdAt 的话，重放投影只能退回
        // 事件时间戳，于是「已处理 33s」的基准与刷新前不一致（见 project.ts）。
        ...(finalMsg?.createdAt ? { createdAt: finalMsg.createdAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(wasInterrupted ? { interrupted: true } : {}),
      }),
      f.sessionEnd({ reason }),
    ]);

    // 全链路 trace（FR-11.2）：这一轮的事件刚刚全部构造完，趁热折成一份 trace。
    // 位置刻意放在 recordFor **之后**：缓冲里必须已经含 `session-end`，否则
    // trace 的 status 无从判断（那正是「这一轮到底算成功还是失败」的唯一权威）。
    persistTurnTrace(sessionId);

    /**
     * 落盘：协议块只是**意图**，真正的写入统一交给 MemoryService.append
     * ——时间戳、来源、幂等去重标记都由它负责，模型碰不到文件格式。
     * 失败静默：记不住一条不该让用户看到一次发送失败。
     */
    if (directives.length > 0) {
      const s = useSettingsStore.getState().settings;
      if (s.memoryEnabled && s.autoSummarize) {
        // 记忆按**会话的工作目录**隔离（工作区记忆落在 `<workdir>/.nanowork/memory/`）。
        // `?? null` 不能省：`Session.workdir` 是 `string | undefined`，而 `undefined`
        // 在 MemoryService 里表示「按当前工作区」——一个本来没有工作目录的会话会去读
        // **上一个会话**的记忆。
        const workdir =
          useSessionsStore.getState().sessions.find((x) => x.id === sessionId)?.workdir ?? null;
        void (async () => {
          for (const d of directives) {
            try {
              await MemoryService.append(d.content, { source: 'agent' }, d.scope, workdir);
            } catch {
              /* 记忆写入失败不影响本轮回答 */
            }
          }
        })();
      }
    }

    if (durationMs !== undefined || wasInterrupted) {
      useSessionsStore.getState().updateMessage(sessionId, assistantId, (m) => ({
        ...m,
        ...(durationMs !== undefined ? { durationMs } : {}),
        // `interrupted` 必须**同时**写回内存消息，不能只写进事件负载：
        // 事件要等下次水合才投影回视图，而用户此刻就在看这一屏。早先只有
        // `onInterrupted` 那条路径写内存态，于是「静默超时」掐断的轮次在实时视图里
        // 依然显示成「已完成」，刷新一下才变成「已中断」——同一个事实两种说法。
        ...(wasInterrupted ? { interrupted: true } : {}),
      }));
    }
    // 结束（成功 / 报错 / abort）后移除该会话的流式上下文，恢复可发送状态
    useSessionsStore.setState((s) => {
      if (!s.streams[sessionId]) return s;
      const streams = { ...s.streams };
      delete streams[sessionId];
      return { ...s, streams };
    });
  }
  return { error: sendError };
}

/**
 * 闭合消息末尾未闭合的深度思考段。
 * 工具执行 / 正文 token / reasoning_end 到达时调用，
 * 使后续 reasoning chunk 开启新段（对应 UI 上多个「深度思考」块）。
 *
 * @param rowId 用事件 id 覆盖该段的行 id。行 id 只是 UI 侧标识，用事件 id 的
 *   好处是**重载后不变**——否则同一个思考段在「实时视图」与「重放投影」里
 *   会是两个不同的 id，两条推导路径的结果就无法逐字段比对。
 */
function closeOpenReasoning(m: Message, rowId?: string): Message {
  const process = m.process;
  if (!process || process.length === 0) return m;
  const last = process[process.length - 1];
  if (last.kind !== 'reasoning' || last.closed) return m;
  return {
    ...m,
    process: [...process.slice(0, -1), { ...last, ...(rowId ? { id: rowId } : {}), closed: true }],
  };
}

/**
 * 取一个会话里**最后一条用户消息**的正文（跨会话召回的 query）。
 *
 * 为什么是「最后一条」而不是「全部历史」：召回的 query 要**自包含**——它描述「现在
 * 想找什么」。最后一条用户消息正是这件事的最接近表达；把整个会话喂进去会让词项覆盖
 * 整个话题域，命中率反而下降（任何一条沾边的旧会话都能匹配上）。
 *
 * 空会话 / 只有附件没有文字时返回 `undefined`：调用方据此跳过召回。
 */
function lastUserMessageOf(session: { messages?: Message[] } | undefined): string | undefined {
  const messages = session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = (m.content ?? '').trim();
    if (text !== '') return text;
  }
  return undefined;
}

/** 记忆提示状态初始值（不持久化） */
const INITIAL_MEMORY_STATE: MemoryState = {
  injected: false,
  count: 0,
  truncated: 0,
  dismissed: false,
};

/**
 * 会话流式状态选择器：供组件按会话订阅，实现「每个任务独立状态」。
 * 返回原始 status 字符串（未流式时为 'idle'），由调用方派生布尔值，
 * 避免在 selector 内返回新对象导致无限重渲染。
 */
export function selectSessionStreamStatus(
  s: Pick<SessionsState, 'streams'>,
  sessionId: string | null | undefined,
): StreamStatus {
  if (!sessionId) return 'idle';
  return s.streams[sessionId]?.status ?? 'idle';
}

/**
 * 队首待裁决的逐条批准请求（PermissionDialog 用）。
 * 返回 `undefined` 表示队列为空；逐条处理，不在 selector 内构造新对象。
 */
export function selectPendingApproval(
  s: Pick<SessionsState, 'pendingApprovals'>,
): PendingApproval | undefined {
  return s.pendingApprovals[0];
}

/**
 * 仅供测试：清空水合标记与在途水合。
 *
 * 水合状态放模块作用域（见 `hydratedSessions` 的说明），因此**不会**随
 * `setState` 归零；用例之间若复用同一会话 id，会因「上一用例已标记就绪」
 * 而跳过水合、记录器缺失。测试在重置事件存储时一并调用本函数。
 */
export function __resetHydrationForTest(): void {
  hydratedSessions.clear();
  hydrating.clear();
}

/** 本轮进程内已完成自动沉淀的会话 id（同一会话不重复归纳） */
const sedimentedSessions = new Set<string>();

/** 供测试复位沉淀去重状态（与 __resetHydrationForTest 配套） */
export function __resetSedimentForTest(): void {
  sedimentedSessions.clear();
}

/**
 * 自动沉淀：把一次「会话结束」的历史归纳成长期记忆。
 *
 * **触发点**（对齐 PRD-memory「会话结束（关闭 / 新建会话）」）：
 * - `deleteSession` / `deleteSessions`：会话被关闭/删除时；
 * - `createSession`：切走时对**上一个会话**补触发——这一步以前完全缺失，
 *   而「说一句 → 新建会话 → 问我是谁」恰好整段落在那个空档里。
 *
 * **分流**（本次修复的核心）：摘要按内容性质分两节落不同层。
 * - `identity`（称呼/年龄段/职业/稳定偏好）→ **L2 用户级**，跨项目生效；
 * - `task`（本次决策/待办/项目专有事实）→ **L3 工作区级**，按会话 workdir 隔离。
 *
 * 工作区 key 由**会话的 workdir** 现算，而不是读落盘那一刻的全局 `currentKey`——
 * 归纳是异步的，期间用户完全可能切到别的工作区，用 `currentKey` 会把 A 的摘要
 * 写进 B，这类串味比「没记忆」更难排查。
 *
 * 同一会话只沉淀一次（`sedimentedSessions`）：`createSession` 的补触发在每次
 * 新建会话时都会重新挑选「上一个会话」，没有这层去重会反复归纳同一段历史。
 *
 * **防污染**（P1）：输入侧只收「用户提问 + 未被中断的助手回答」，输出侧由
 * `MemoryService.summarize` 与 `parseSummary` 拦下系统报错文案——网关在配额 /
 * 鉴权失败时会把错误原文当作正常 content 吐进 SSE 流，通道层面分辨不出，
 * 不设这道防线它就会以「会话摘要」的名义写进长期记忆。详见 src/lib/memory.ts。
 *
 * **防重复**：归纳前把已有的长期记忆作为 `knownFacts` 交给模型，要求它只输出
 * 「新增的或发生变化的事实」。靠内容比对去重行不通——同一事实的多种措辞在字符
 * 层面并不相似（实测覆盖率仅 0.25~0.45），而把阈值压低到能识别它们时，又会把
 * 「年龄 20 → 25」这类**更新**一并误杀。判断「重复还是更新」需要理解语义。
 */
function sedimentSession(target: Session): void {
  if (!useSettingsStore.getState().settings.autoSummarize) return;
  // 定时任务执行记录与引擎只读留痕**不归纳**：一个自动任务分组动辄几十条 run，
  // 逐条调模型既慢又无检索价值，而这些 run 的真值本就在引擎侧（不是用户对话）。
  // 这条守卫让「批量关闭自动任务分组」依然是零模型调用。
  if (target.readonly) return;
  if (target.id.startsWith(CRON_SESSION_ID_PREFIX)) return;
  if (target.messages.length === 0) return;
  if (sedimentedSessions.has(target.id)) return;
  sedimentedSessions.add(target.id);

  const history: ChatMessageParam[] = target.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '')
    // 被用户中断的助手消息是**半截回答**，不作为归纳依据（与正文里
    // `<memory-save>` 指令块按 aborted 跳过是同一条理由：残缺输出不可信）。
    // 用户提问本身保留——话已经说出口，被中断不代表没说过。
    .filter((m) => !(m.role === 'assistant' && m.aborted === true))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  if (history.length === 0) return;

  const source = `auto:${target.title}`;
  const workdir = target.workdir ?? null;

  // fire-and-forget：归纳要调一次模型，绝不能阻塞删除/新建这些交互动作
  void (async () => {
    try {
      // 把**已有的长期记忆**一并交给归纳模型。这是对抗「同一事实换种措辞反复写入」
      // 的主要手段：模型看不到已记内容时，「用户叫明明」会被每个会话重新归纳一遍，
      // 而字符级的近似判定救不了改写式重复（见 memory.ts 的 isSameStatement 实测表）。
      const { text: knownFacts } = await MemoryService.loadForInjection(workdir);
      const summary = await MemoryService.summarize(history, { knownFacts });
      if (isEmptySummary(summary)) return;
      if (summary.identity !== '') {
        await MemoryService.append(summary.identity, { source }, 'user');
      }
      if (summary.task !== '') {
        await MemoryService.append(summary.task, { source }, 'workspace', workdir);
      }
    } catch {
      /* 自动沉淀为附加能力，失败静默 */
    }
  })();
}

export const useSessionsStore = create<SessionsState>()(
  (set, get) => ({
    sessions: [],
    sessionTombstones: {},
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
    memoryLoaded: INITIAL_MEMORY_STATE,

    /**
     * 创建会话。保持**同步返回** Session（兼容既有调用方与测试）；
     * 记忆读取为异步 IO，以 fire-and-forget 方式在后台完成并回填 session.memory。
     */
    createSession: (agentId, title = '新会话', opts) => {
      // 切走前的会话 id —— 「新建会话」是 PRD 定义的会话结束信号之一
      const prevSessionId = get().activeId;
      const agentsState = useAgentsStore.getState();
      /**
       * 是否继承当前专家 / 专家团（及其技能）。
       *
       * 关掉这条继承链时既不解析专家团、也不取全局活跃专家，`agentId` 落成空串：
       * 请求里省略 `agent_id`（见 nanobotHttp/chat.ts 的 `buildRequest`），
       * 由网关按自身配置的默认 Agent 应答，同时不注入任何 Agent 人设与技能 prompt。
       * 这正是「新任务 = 白纸」在协议面的形态，而不是只在 UI 上把 chip 藏起来。
       */
      const inheritCapabilities = opts?.inheritCapabilities !== false;
      /**
       * 兜底优先级与召唤逻辑对齐：显式 agentId > 全局活跃专家团 > 全局活跃专家。
       * 专家团绑定仅在其启用且存在启用成员时生效；
       * agentId 取团内首位启用成员作为**团长**——引擎按 mode 派发其余成员
       *（见 `lib/expertGroupRequest.ts`；团长策略是整团的权限上限）。
       */
      const groupsState = useExpertGroupsStore.getState();
      const candidateGroup =
        inheritCapabilities && agentId === undefined && groupsState.activeGroupId
          ? groupsState.groups.find(
              (g) => g.id === groupsState.activeGroupId && g.enabled,
            )
          : undefined;
      const groupLeader = candidateGroup
        ? candidateGroup.memberIds
            .map((id) => agentsState.agents.find((a) => a.id === id))
            .find((a) => a && a.enabled)
        : undefined;
      const boundGroup = candidateGroup && groupLeader ? candidateGroup : undefined;
      const aid =
        agentId ??
        (inheritCapabilities
          ? groupLeader?.id ??
            agentsState.activeAgentId ??
            agentsState.agents[0]?.id ??
            ''
          : '');
      const agent = agentsState.agents.find((a) => a.id === aid);
      // 插件版本快照取自 store 的**已扫描视图**（插件页未进过时为空 → 不写引用集）。
      // 刻意不在建会话时 `refresh()`：那要读磁盘 + 发 HTTP，而建会话是同步动作。
      const pluginVersions = snapshotSessionPluginVersions(
        usePluginsStore.getState().installed,
      );
      const session: Session = {
        id: genId(),
        agentId: aid,
        ...(boundGroup ? { groupId: boundGroup.id } : {}),
        // aid 为空串时 agent 必然 undefined → 不挂任何技能（新任务的默认态）
        skillIds: agent?.skillIds?.length ? [...agent.skillIds] : undefined,
        /**
         * 会话版本引用集（FR-3.9 ①）：把**此刻**生效的插件版本记成声明。
         *
         * 只在建会话时快照一次——它记的是历史事实（「这个会话用的哪一版」），
         * 之后本机再装新版也不该改写它，否则①换机 GC 会按最新版保护、
         * ②「两端版本不一致」永远看不出来。取不到插件（插件页从未进过、引擎离线）
         * 时得到 `undefined`，语义是「这份会话没声明过」，不是「声明为空」。
         */
        ...(pluginVersions ? { pluginVersions } : {}),
        /**
         * 调用方没当场指定工作空间时，落到「默认工作空间存储路径」
         * （设置 → 通用 → 存储；用户值 > 内置 `<home>/NanoWork`）。
         *
         * 兜底放在**这里**而不是各个「新建任务」入口：入口有六七个
         * （侧边栏、标题栏、快捷键、各页面的 ensureSession…），逐个传一遍
         * 必然漏掉一两个，而漏掉的那个只表现为「新任务偶尔不落到默认路径」，
         * 既不容易发现，也很难定位是哪一次点击出的问题。
         */
        workdir: opts?.workdir ?? resolveDefaultWorkspacePath(),
        fullAccess: opts?.fullAccess,
        toolApproval: opts?.toolApproval,
        ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
        title,
        messages: [],
        permissionLog: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        // 新建会话的同步元数据（第 19 章）：`rev = 1`、`updatedBy` 取当前设备。
        // 走 `sessionCreatePatch` 而不是让 `updateSession` 顺手打脏——新建不该经过
        // 「改动」那条路径，否则首条会话的 `rev` 会依赖「谁先调了 updateSession」
        ...sessionCreatePatch(),
      };
      set((s) => ({
        sessions: [session, ...s.sessions],
        activeId: session.id,
        // 新会话重置提示条，等异步读取结果回填
        memoryLoaded: INITIAL_MEMORY_STATE,
      }));
      rememberActiveSession(session.id);
      // 登记为「用过的目录」留痕（该表当前没有读取方，见 settings.knownWorkspaces）
      if (session.workdir) {
        useSettingsStore.getState().rememberWorkspace(session.workdir);
      }

      // 自动沉淀触发点之二（新建会话）：对上一个会话补触发一次归纳。
      // 用户「告诉它我是谁 → 直接新建会话」时不会经过删除路径，若只挂 deleteSession，
      // 这一段对话永远不会进入记忆——这正是「新会话就忘了」的直接成因。
      if (prevSessionId && prevSessionId !== session.id) {
        void (async () => {
          try {
            const prev = get().sessions.find((s) => s.id === prevSessionId);
            if (!prev) return;
            // 重启后重开的会话，消息可能还没水合；先补读盘再判定是否值得归纳
            // （已水合的会话在 loadSession 里会立刻返回，不产生额外 IO）
            if (prev.messages.length === 0) await get().loadSession(prev.id);
            const fresh = get().sessions.find((s) => s.id === prevSessionId);
            if (fresh) sedimentSession(fresh);
          } catch {
            /* 沉淀为附加能力，失败静默 */
          }
        })();
      }

      // 事件流：新会话立即可写（seq 从 1 开始），故先建记录器再落 session-start。
      // 记录器先于任何写入建立，`loadSession` 才不会把它当成「待水合」而重置 seq。
      if (isEventStreamSession(session)) {
        createRecorder(session.id, session.workdir);
        recordEvents(session.id, (f) =>
          f.sessionStart({
            agentId: session.agentId,
            ...(session.workdir !== undefined ? { workdir: session.workdir } : {}),
            mode: session.mode ?? 'craft',
            permissionMode: session.fullAccess ? 'full' : 'restricted',
            ...(session.model !== undefined ? { model: session.model } : {}),
          }),
        );
        persistMeta(session);
      }
      // 标记为已水合：消息就在内存里、记录器也已就绪，无需再去读盘
      // （读了反而会把记录器的 seq 重置回 0）。`send` 据此走同步快路径。
      hydratedSessions.add(session.id);

      // 异步加载记忆，不阻塞返回
      void get().loadMemoryInto(session.id);
      return session;
    },

    loadMemoryInto: async (sessionId, opts) => {
      // 工作区由**会话的 workdir** 决定（P1-A），它同时是落点（`<workdir>/.nanowork/memory/`）
      // 与隔离单位。先切当前工作区再判开关：当前工作区影响的是「记忆页与手动保存
      // 落到哪个目录」，属于落点归属，不该被「是否注入记忆」这个开关影响。
      //
      // `?? null` 不能省：`Session.workdir` 是 `string | undefined`，而 `undefined`
      // 表示「按当前工作区」——漏掉它会让没有工作目录的会话读到上一个会话的记忆。
      const workdir =
        get().sessions.find((s) => s.id === sessionId)?.workdir ?? null;
      MemoryService.useWorkspace(workdir);

      if (!useSettingsStore.getState().settings.memoryEnabled) return;
      // 版本在**读取之前**采样：若读取期间恰好有写入落盘，这次的正文可能不含它，
      // 记成「已包含」就会永久停在旧内容上。采早不采晚，最坏结果只是多刷一次。
      const version = MemoryService.writeVersion();
      let loaded: { text: string; entries: number; truncated: number };
      try {
        // 注入**两层**（L2 用户级 + L3 工作区级）：写入侧从 P1-B 起就按内容性质分流，
        // 这里只读工作区级等于把身份类事实写进一份没人读的文件——「在 A 工作区
        // 告诉过它我叫什么，换到 B 工作区就问不出来」正是这么来的。
        //
        // 2026-10-02 起本函数同时装配**记忆 v2** 的结构化部分（active 策展修订、
        // 画像、可注入偏好、最近 N 条事实），并按预算裁剪；v1 的 legacy 正文作为
        // 最低优先级段落继续进 prompt（`buildInjectionBlock` 的 `*LegacyText`）。
        //
        // 召回 query 取**本会话最后一条用户消息**：这是「按轮触发」在快照模型下的
        // 自然落点——记忆快照本来就是每会话一次，不是每轮一次（每轮重算会让
        // 装配路径多一个 await，破坏「send 同步进入流式态」，见 NFR-M2）。
        // 需要更「当轮」的检索时，那条路径要单独设计（Phase 3 的后续工作）。
        const recallQuery = useSettingsStore.getState().settings.memoryRecall
          ? lastUserMessageOf(get().sessions.find((s) => s.id === sessionId))
          : undefined;
        loaded = await MemoryService.loadForInjection(
          workdir,
          recallQuery,
          // 门槛与预算出自设置页（`memoryPolicy`）；解析成函数参数由 `resolveMemoryPolicy` 统一做
          useSettingsStore.getState().settings.memoryPolicy,
        );
      } catch {
        return;
      }
      // 会话可能已在读取期间被删除
      if (!get().sessions.some((s) => s.id === sessionId)) return;
      // 空记忆也落一个空串：让「`memory === undefined` = 尚未加载」这一约定成立。
      // 同时记下产出依据（版本 + 工作目录），供 isMemorySnapshotStale 判断过期。
      get().updateSession(sessionId, (s) => ({
        ...s,
        memory: loaded.text,
        memoryVersion: version,
        memoryWorkspace: workdir ?? undefined,
      }));
      // 空记忆不弹提示条
      if (loaded.text === '') return;
      if (opts?.silent) return;
      set({
        memoryLoaded: {
          injected: true,
          count: loaded.entries,
          // 截断数要露出来：静默裁剪会让用户以为「它记住了」而模型没看到
          truncated: loaded.truncated,
          dismissed: false,
        },
      });
    },

    isMemorySnapshotStale: (sessionId) => {
      // 记忆关掉时不注入，刷新没有意义
      if (!useSettingsStore.getState().settings.memoryEnabled) return false;
      const session = get().sessions.find((s) => s.id === sessionId);
      // 从未产出过快照：预热在途，或本该由 createSession / loadSession 负责。
      // 这里**刻意不补读**——补读会插入一个 await 边界，而「已水合的会话 send
      // 同步进入流式态」是可测性质（tests/sessionsStore.test.ts 的并发用例）。
      if (!session || session.memoryVersion === undefined) return false;
      if (session.memoryVersion !== MemoryService.writeVersion()) return true;
      // workdir 变了 → 同一份快照已经指向另一个工作区的记忆目录。
      // 用 `isSameMemoryWorkspace` 而不是 `!==`：同一个目录会有多种字面量
      // （大小写、尾分隔符、正反斜杠），字符串比较会把「还是同一个目录」判成过期，
      // 于是每一轮发送都白白重读一次盘。两侧都为空视为相同（`isSameWorkspacePath`
      // 的契约是「任一侧为空一律 false」，那是给侧边栏分组用的，口径不同）。
      return !isSameMemoryWorkspace(session.memoryWorkspace, session.workdir);
    },

    dismissMemoryBar: () =>
      set((s) => ({ memoryLoaded: { ...s.memoryLoaded, dismissed: true } })),

    setSessionWorkdir: (id, workdir) => {
      /**
       * 「清除」（传 `undefined`）= 回到默认工作空间。配了默认路径时落回它，
       * 否则才真的置空。不这么做就会出现自相矛盾的形态：设置里明明写着
       * 默认工作空间是 `~/NanoWork`，用户点一下「清除」反而掉进另一个分组。
       */
      const next = workdir ?? resolveDefaultWorkspacePath();
      const before = get().sessions.find((x) => x.id === id);
      get().updateSession(id, (s) => ({
        ...s,
        workdir: next,
        updatedAt: nowIso(),
      }));
      // 登记为「用过的目录」留痕（该表当前没有读取方，见 settings.knownWorkspaces）。
      // `next` 可能为空——默认工作空间路径在设置就绪前算不出来，那种情况不登记
      if (next) useSettingsStore.getState().rememberWorkspace(next);
      const after = get().sessions.find((x) => x.id === id);
      if (!after || !isEventStreamSession(after)) return;
      const from = before?.workdir;
      if (from === next) {
        persistMeta(after);
        return;
      }

      /**
       * 记录搬不搬。
       *
       * 只在「确知一条消息都没有」或「此前根本没绑过工作空间」时才搬：
       *
       * - **搬是危险动作**：读旧 → 删旧 → 写新，中间挂掉就是整段对话没了；
       *   而它的触发只是「点一下输入框里的工作空间」，代价与触发极不成比例。
       * - **搬也不符合语义**：记录是「这个会话从哪来」，切换工作空间是「以后
       *   去哪儿」——后者不该改写前者。更直观的后果是：把一个任务从 bbb 切到
       *   aaa，本该只是它换了个工作空间，却让 bbb 工作空间连人带记录一锅端走。
       *
       * 空会话（只有 `session-start`，或压根没写过消息）搬迁代价为零，仍照旧
       * 归位——这样「新建任务 → 选工作空间 → 开始干活」这一常见路径下，记录
       * 落在用户真正干活的那个工作空间分片里，`projects/` 的目录名不会说谎。
       *
       * 判据用 `hasSessionMessages`（记录器侧，与水合无关），`null`（无从判断）
       * 归入「有内容」——搬错方向的代价不可逆，宁可少搬。
       */
      const knownEmpty = hasSessionMessages(id) === false;
      const neverBound = from === undefined;
      if (!knownEmpty && !neverBound) {
        // 冻结分片：记录留在原目录，此后所有读写都按它走。记录器也**不**改作用域
        // ——它是后续追加的落点，与 `streamWorkdir` 必须一致，否则新事件会被写到
        // 另一个目录，会话的正文被拆成两个文件（读回时只剩后半段）。
        const shard = recorderWorkdir(id) ?? before?.streamWorkdir ?? from;
        get().updateSession(id, (s) => ({ ...s, streamWorkdir: shard }));
        persistMetaOf(id);
        return;
      }

      // 空会话：记录器的作用域先切（后续写入落新目录），搬迁任务排进同一队列——
      // 队列保证「先把旧目录里已排队的追加写完，再读旧目录搬迁」，不会丢事件。
      setRecorderWorkdir(id, next);
      const scope = next;
      void enqueueSessionTask(id, async () => {
        const store = getEventStore();
        if (!store.capabilities.fileBacked) {
          // Web 无目录维度（分片存储不区分工作空间）：只需更新 meta
          await store.writeMeta(toMeta(after));
          return;
        }
        const events = await store.readEvents(id, from);
        // 顺序：删旧（含旧索引条目）→ 写新（重建条目并算准计数）→ 写 meta。
        // 若反过来先写新再删旧，`removeSession` 会把新条目一并删掉
        // （索引按会话 id 计，不分作用域）。
        await store.removeSession(id, from);
        if (events.length > 0) {
          await store.append({ sessionId: id, workdir: scope, events });
        }
        await store.writeMeta(toMeta(after));
      }).then(undefined, (e: unknown) => reportStreamError(id, e));
    },

    setSessionFullAccess: (id, fullAccess) => {
      get().updateSession(id, (s) => ({
        ...s,
        fullAccess,
        updatedAt: nowIso(),
      }));
      persistMetaOf(id);
    },

    /**
     * 切换执行模式。
     *
     * 两件事必须一起做：改内存视图 + 落 `mode-change` 事件。只改视图则刷新后
     * 回到旧模式（用户会以为自己在 Plan 里，实际已经能写）；只写事件则 UI 不更新。
     *
     * 同模式重复切换是 no-op，避免用户连点把事件流灌满无意义的切换记录。
     */
    setSessionMode: (id, mode) => {
      const before = get().sessions.find((x) => x.id === id);
      if (!before) return;
      if ((before.mode ?? 'craft') === mode) return;
      get().updateSession(id, (s) => ({ ...s, mode, updatedAt: nowIso() }));
      recordFor(id, (f) =>
        f.modeChange({ from: before.mode ?? 'craft', to: mode }),
      );
      persistMetaOf(id);
    },

    setSessionToolApproval: (id, toolApproval) => {
      get().updateSession(id, (s) => ({
        ...s,
        toolApproval,
        updatedAt: nowIso(),
      }));
      persistMetaOf(id);
    },

    setSessionModel: (id, model) => {
      get().updateSession(id, (s) => ({
        ...s,
        model,
        updatedAt: nowIso(),
      }));
      persistMetaOf(id);
    },

    openExternal: (session) => {
      set((s) => ({
        sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
        activeId: session.id,
      }));
      rememberActiveSession(session.id);
    },

    /**
     * 启动水合：**只读索引**（每会话一条投影，加载成本与会话数而非事件数相关），
     * 消息留白，等用户点进去再由 `loadSession` 读 JSONL 重建。
     *
     * 这就是 PRD 9.5 说的「列表来自索引、消息来自事件流」——旧实现的
     * `persist` 会在启动时反序列化整个会话数组（含全部消息与 base64 附件），
     * 会话一多就不是线性成本而是一次性卡顿。
     */
    loadSessions: async () => {
      // 清掉旧版整块持久化留下的快照文件（历史会话已删除，无需迁移）
      purgeLegacySessionSnapshot();

      const store = getEventStore();
      let entries = await store.listSessions();
      if (entries.length === 0) {
        // 索引是可再生派生物：缺失（首次运行 / 被清理）或损坏时重建一次
        entries = listSessionEntries(await store.rebuildIndex());
      }
      const sessions: Session[] = [];
      for (const entry of entries) {
        const meta = await store.readMeta(entry.id, entry.workdir);
        if (!meta) continue;
        if (!isEventStreamSession(meta)) continue;
        // `messageCount` 来自索引：它是**水合之前**唯一能回答「这条任务有没有
        // 对话记录」的数据（消息要等点进去才读盘，见 `@/lib/conversation`）。
        // 漏掉它，重启后侧边栏会把所有没点开过的任务当成空会话。
        sessions.push({
          ...metaToSession(meta),
          messages: [],
          permissionLog: [],
          messageCount: entry.messageCount,
        });
      }

      /**
       * 补登记工作空间：老用户（本字段之前）没有这张表，而它记录了「用户用过哪些
       * 目录」。现有的会话就是最可靠的补登记来源。
       *
       * 放在这里而不是每条会话各自的创建路径：老数据不会重走创建路径。
       *
       * 注意这张表**当前没有读取方**——侧边栏从「没有对话记录的工作空间不显示」
       * 之后不再据此补空分组（见 `settings.knownWorkspaces`）。保留写入是为了让
       * 「用过的目录」这条留痕不至于断档，供后续的工作空间选择器使用。
       */
      const settingsState = useSettingsStore.getState();
      const known = settingsState.settings.knownWorkspaces ?? [];
      const used = new Set<string>();
      for (const s of sessions) {
        if (s.workdir) used.add(s.workdir);
        // 分片目录也是用户真实用过的工作空间（会话切走之后它就成了「用过的目录」）
        if (s.streamWorkdir) used.add(s.streamWorkdir);
      }
      // 只补表里没有的：登记动作会触发一次持久化写入，启动路径上不该反复写
      for (const path of used) {
        if (!known.includes(path)) settingsState.rememberWorkspace(path);
      }

      let activeId: string | null = null;
      try {
        const remembered = await platform.storage.get<string>(STORAGE_KEYS.activeSession);
        if (remembered && sessions.some((s) => s.id === remembered)) activeId = remembered;
      } catch {
        /* 恢复「上次打开」失败不影响启动，退化为「未选中」 */
      }

      // 同步层的内存墓碑镜像：`listSessions()` 会**过滤掉**墓碑条目（见
      // `listSessionEntries`），所以上面 `entries` 里看不到它们；墓碑只能从**原始
      // 索引**（`readIndex()` 返回未过滤的 `entries`）恢复。重启后若不回填，本机
      // 已删除的会话在同步层「看起来从未存在」——下一次 pull 若正好拉到对端尚未
      // 见到该墓碑的存活副本，就会被当新会话重新落地，删除就此复活。
      const rawIndex = await store.readIndex();
      const sessionTombstones: Record<string, SyncMeta> = {};
      for (const [id, entry] of Object.entries(rawIndex.entries)) {
        // 只有带 `deletedAt` 的条目才是墓碑；存活条目由上面的 `sessions` 承载
        if (!entry.deletedAt) continue;
        sessionTombstones[id] = sessionMetaOf(entry as unknown as Record<string, unknown>);
      }

      set({ sessions, activeId, sessionTombstones });
      // 首屏就把当前会话的消息准备好，避免用户看到空列表后内容才刷出来
      if (activeId) void get().loadSession(activeId);
    },

    loadSession: async (id) => {
      if (hydratedSessions.has(id)) return;
      const inflight = hydrating.get(id);
      if (inflight) return inflight;

      const task = (async () => {
        const target = get().sessions.find((x) => x.id === id);
        // 会话不存在（已被删除）或为外部来源：后者消息由引擎快照直接提供，
        // 本地没有事件流可读，直接标记就绪以免每次选中都重走一遍判断
        if (!target || !isEventStreamSession(target)) {
          hydratedSessions.add(id);
          return;
        }
        // 本进程内新建的会话：`createSession` 已建好记录器（seq 已对齐），
        // 事件也都在内存视图里，无需读盘——若此时读盘会把记录器重置回 seq 0
        if (hasRecorder(id)) {
          hydratedSessions.add(id);
          return;
        }

        // 按**分片**读，而不是会话当前的工作空间：切过工作空间的会话，记录仍在
        // 原分片目录里（见 `Session.streamWorkdir`），按新工作空间去读会什么都读不到
        const events = await getEventStore().readEvents(id, streamShardOf(target));
        // 读盘期间会话可能已被删除
        const current = get().sessions.find((x) => x.id === id);
        if (!current) return;
        // 记录器的作用域同样是分片：它决定后续写入落哪个目录，必须与读的是同一个
        primeRecorder(id, streamShardOf(current), events);
        const { messages, permissionLog } = project(events);
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, messages, permissionLog } : x,
          ),
        }));
        // 静默预热记忆快照：它是纯缓存、不进事件流，若不在这里补上，
        // 重开的会话将永远不注入记忆（旧版靠整块持久化顺带存了它）
        await get().loadMemoryInto(id, { silent: true });
        hydratedSessions.add(id);
      })();

      hydrating.set(id, task);
      try {
        await task;
      } finally {
        hydrating.delete(id);
      }
    },

    selectSession: (id) => {
      set({ activeId: id });
      rememberActiveSession(id);
      // 已水合的会话会走 loadSession 的早退分支（不再预热），所以过期检查单独补一次：
      // 切回会话时就刷新，下一轮发送才能继续走同步快路径。
      if (get().isMemorySnapshotStale(id)) {
        void get().loadMemoryInto(id, { silent: true });
      }
      void get().loadSession(id);
    },

    deleteSession: (id) => {
      // 自动沉淀触发点之一（关闭会话）：删除前把历史归纳进记忆。
      const target = get().sessions.find((x) => x.id === id);
      if (target) sedimentSession(target);

      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== id);
        const activeId = s.activeId === id ? sessions[0]?.id ?? null : s.activeId;
        return {
          sessions,
          activeId,
          // 同步层的内存镜像墓碑：磁盘载体是索引条目的 `deletedAt`（`tombstoneSession`
          // 写入），同步层读的是这张表（见 `sessionTombstones` 的说明）。
          ...(target
            ? { sessionTombstones: { ...s.sessionTombstones, [id]: sessionDeletePatch(target) } }
            : {}),
        };
      });

      // 落盘走**墓碑**：内存视图已移除，但磁盘上要留下「它被删了」这条记录
      if (target) tombstoneSessionStream(target);

      // 产物随会话一起清（FR-7.2 规格 D8）：`clearSession` 此前零调用点，
      // 于是「会话已删、产物库里还留着它的产物」，且索引只增不减。
      useArtifactsStore.getState().clearSession(id);
    },

    deleteSessions: (ids) => {
      const doomed = new Set(ids);
      if (doomed.size === 0) return;
      const targets = get().sessions.filter((x) => doomed.has(x.id));
      // 批量关闭同样是「会话结束」，逐个体沉淀（已沉淀过的会被去重跳过）
      targets.forEach(sedimentSession);
      set((s) => {
        const sessions = s.sessions.filter((x) => !doomed.has(x.id));
        // 活跃会话被删时退回列表首位；没删到任何会话则原样返回，避免无谓重渲染
        if (sessions.length === s.sessions.length) return s;
        const activeId =
          s.activeId && doomed.has(s.activeId) ? sessions[0]?.id ?? null : s.activeId;
        // 同步层的内存镜像墓碑（同 deleteSession）
        const sessionTombstones = { ...s.sessionTombstones };
        for (const t of targets) sessionTombstones[t.id] = sessionDeletePatch(t);
        return { sessions, activeId, sessionTombstones };
      });
      targets.forEach(tombstoneSessionStream);
      // 同 deleteSession：批量删除也要带走产物（规格 D8）
      targets.forEach((t) => useArtifactsStore.getState().clearSession(t.id));
    },

    /**
     * pull 落地一条**存活**的会话元数据（`sessionMeta` collection，§D.4）。
     *
     * 与其余 collection 不同：会话的同步负载是「元数据投影」，落地要**双写**——
     * 内存 `sessions` + 磁盘 `<id>.meta.json` +（防抖）重建索引。写 meta 之后再
     * `rebuildIndex()` 是必需的：`EventStore.writeMeta` 只写 meta、**不动索引**，
     * 而列表来源是索引——不重建，重启后这条会话不会出现在列表里。
     */
    applyRemoteSessionMeta: (entity) => {
      const meta = toMetaFromEntity(entity);
      const next = buildSessionFromMeta(meta);
      void getEventStore()
        .writeMeta(toMeta(next))
        .then(() => requestIndexRebuild())
        .catch((e: unknown) => reportStreamError(next.id, e));
      set((s) => ({
        sessions: s.sessions.some((x) => x.id === next.id)
          ? s.sessions.map((x) =>
              x.id === next.id
                ? {
                    ...x,
                    ...next,
                    // 只覆盖元数据派生字段，**保留本机运行时状态**（messages /
                    // permissionLog / messageCount）。若写成 `{ ...x, ...next }`，
                    // 本机已水合的会话会被清空消息——而 `hydratedSessions` 已标记就绪，
                    // `loadSession` 不再重读，聊天记录会永久消失（本机回拉自己刚推的
                    // 变更时必现：引擎在 accepted 非空后会再 pull 一次）。
                    messages: x.messages,
                    permissionLog: x.permissionLog,
                    messageCount: x.messageCount,
                  }
                : x,
            )
          : [next, ...s.sessions],
        // 存活落地清同名墓碑（「删除后又建回来」不留幽灵墓碑）
        sessionTombstones: withoutTombstone(s.sessionTombstones, next.id),
      }));
    },

    /** pull 落地一条会话**墓碑**（§D.4）：写墓碑 + 覆盖索引条目 + 丢弃正文。 */
    applyRemoteSessionTombstone: (entity) => {
      const meta = toMetaFromEntity(entity);
      // `tombstoneSession` 一条动作完成「写墓碑 + 覆盖索引条目 + 丢弃正文」（见 §D.4）。
      // 等价地改用 `writeMeta` 做不到：它不动索引 → 重启后该会话仍留在列表里（删不掉）。
      void getEventStore()
        .tombstoneSession(meta)
        .catch((e: unknown) => reportStreamError(meta.id, e));
      set((s) => ({
        sessions: s.sessions.filter((x) => x.id !== meta.id),
        sessionTombstones: { ...s.sessionTombstones, [meta.id]: normalizeMeta(meta) },
      }));
    },

    renameSession: (id, title) => {
      get().updateSession(id, (s) => ({ ...s, title, updatedAt: nowIso() }));
      persistMetaOf(id);
    },

    togglePinSession: (id) => {
      get().updateSession(id, (s) => ({
        ...s,
        pinned: !s.pinned,
        updatedAt: nowIso(),
      }));
      persistMetaOf(id);
    },

    /**
     * 唯一的会话改动入口。
     *
     * 同步元数据（第 19 章）在这里**自动**维护：比较改动前后的「可同步字段」
     * （白名单见 `lib/sessionSyncMeta.ts`），真的变了才 `rev + 1` 并刷新 `updatedBy`。
     *
     * 为什么放在这里而不是各调用点：本入口有十来个调用方（重命名 / 置顶 / 换模式 /
     * 换模型 / 换工作空间 / 换权限 / 改记忆快照…），逐个手写 `rev` 必然漏，
     * 而漏掉的后果是**静默**的——本地一切正常，换台设备才发现少了一次改动。
     * 自动判定的另一个好处是改记忆快照（`memory*`，纯缓存）不会涨版本：
     * 它们不在白名单里。
     */
    updateSession: (id, updater) =>
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? withSessionSync(x, updater(x)) : x)),
      })),

    updateMessage: (sessionId, messageId, updater) =>
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === sessionId
            ? {
                ...x,
                messages: x.messages.map((m) => (m.id === messageId ? updater(m) : m)),
                updatedAt: nowIso(),
              }
            : x,
        ),
      })),

    send: async (text: string, targetSessionId?: string, attachments?: Attachment[], richContent?: string) => {
      const trimmed = text.trim();
      const list = attachments ?? [];
      // 纯文本与附件至少要有其一，否则无从发起请求
      if (!trimmed && list.length === 0) return null;

      // 1) 选定/创建会话（显式指定 > 当前活跃 > 自动新建）
      let state = get();
      let sessionId = targetSessionId ?? state.activeId;
      let session = sessionId ? state.sessions.find((s) => s.id === sessionId) : undefined;
      if (!session) {
        // agentId 传 undefined，由 createSession 按「全局活跃专家团 > 全局活跃专家」兜底
        //（与召唤专家/召唤专家团的绑定逻辑一致）
        const created = get().createSession(undefined, trimmed.slice(0, 24) || '新会话');
        sessionId = created.id;
        session = get().sessions.find((s) => s.id === sessionId);
      }
      if (!session || !sessionId) return null;
      // 只读会话（定时任务执行留痕等外部来源）不允许继续对话
      if (session.readonly) return null;
      // 会话级并发控制：仅阻止「同一会话」重复发起流式，其他会话互不影响
      if (get().streams[sessionId]) return null;
      const sid = sessionId;

      // 事件流：先把该会话的历史事件读进内存并建立记录器（幂等，已就绪则直接返回）。
      // 必须在追加消息之前完成——记录器未就绪时 recordFor 会拒绝落盘。
      // 已水合的会话走同步快路径：不产生 await 边界，`send` 因此能同步进入流式态
      // （多会话并发流式的可测性质依赖这一点）。
      //
      // 记忆快照的过期检查**不在这里**：这里补一次 await 就把同步快路径推后了一个
      // microtask。它已内聚到 `streamAssistantReply` 的步骤 0.1——先同步占住流式
      // 槽位，再刷新快照，两个目标同时成立。
      if (!hydratedSessions.has(sid)) await get().loadSession(sid);

      // 2) 追加 user + assistant(占位) 消息
      //    纯附件发送时文本为空，网关要求 message 非空，
      //    因此补一句「附件：a.pdf、b.xlsx」作为可读占位（同时让用户气泡有内容可看）
      const content =
        trimmed !== '' ? trimmed : `附件：${list.map((a) => a.name).join('、')}`;
      const userMsg: Message = {
        id: genId(),
        role: 'user',
        content,
        // 落库前裁剪掉 object URL 与大文件内容，避免撑爆本地存储
        ...(list.length > 0
          ? { attachments: list.map(toPersistableAttachment) }
          : {}),
        // 富文本副本（徽章 token 占位）：仅本地气泡内联渲染用
        ...(richContent ? { richContent } : {}),
        createdAt: nowIso(),
      };
      const assistantId = genId();
      const assistantMsg: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
      };

      // 占位标题（新会话 / 新任务）在首条消息时自动替换为消息摘要
      const currentTitle = get().sessions.find((x) => x.id === sid)?.title ?? '';
      const nextTitle = (PLACEHOLDER_TITLES as readonly string[]).includes(currentTitle)
        ? trimmed.slice(0, 24) || list[0]?.name.slice(0, 24) || '新会话'
        : undefined;

      // 用户消息进事件流（助手占位**不落盘**：它的正文是流式累积的，
      // 回合结束才有一条带终值的 `message` 事件）。
      // 标题变更一并作为 `ai-title` 落盘：索引的标题取自「本次追加里的末条
      // ai-title > meta.title」，只写 meta 会与索引读取竞争，落事件才确定。
      recordFor(sid, (f) => [
        f.message({
          messageId: userMsg.id,
          role: 'user',
          content: userMsg.content,
          createdAt: userMsg.createdAt,
          ...(userMsg.attachments && userMsg.attachments.length > 0
            ? { attachments: userMsg.attachments.map(toEventAttachment) }
            : {}),
          ...(userMsg.richContent ? { richContent: userMsg.richContent } : {}),
        }),
        ...(nextTitle !== undefined ? [f.aiTitle({ title: nextTitle })] : []),
      ]);

      get().updateSession(sid, (s) => ({
        ...s,
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        messages: [...s.messages, userMsg, assistantMsg],
      }));
      if (nextTitle !== undefined) persistMetaOf(sid);

      // 3) 触发助手流式响应（共用 streamAssistantReply，附件转 base64 载荷随行）
      const { error } = await streamAssistantReply(
        sid,
        assistantId,
        attachmentsToUploadFiles(list),
      );
      return { sessionId: sid, error };
    },

    /**
     * 在已有用户消息上重新发送：
     * 1) 校验（会话存在 / 非只读 / 当前未在流式 / 目标是 user 消息）；
     * 2) 若内容有变化则覆盖该消息文本并刷新 createdAt，否则保持原状；
     * 3) 删除该消息之后的所有消息（会话级 artifact / 文件产物落盘不受影响）；
     * 4) 新增一条空的 assistant 占位并复用 streamAssistantReply 开启新一轮流式。
     *
     * 与 send() 的差异：send() 在末尾追加新 user，本方法在原位覆盖；其余流式路径一致。
     */
    resendFromMessage: async (sessionId, messageId, newContent) => {
      const trimmed = newContent.trim();
      if (!trimmed) return;
      const snapshot = get().sessions.find((s) => s.id === sessionId);
      if (!snapshot || snapshot.readonly) return;
      if (get().streams[sessionId]) return;

      // 事件流就绪后再定位目标消息：既要能落盘，也要能查到分支点。
      // 已水合时是同步快路径（不产生额外的 await 边界）。
      // 记忆快照的过期刷新与 send 同源，都在 `streamAssistantReply` 步骤 0.1
      // （流式槽位占位之后），此处不再补 —— 理由同上。
      if (!hydratedSessions.has(sessionId)) await get().loadSession(sessionId);

      const session = get().sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const idx = session.messages.findIndex((m) => m.id === messageId);
      if (idx === -1 || session.messages[idx].role !== 'user') return;
      /**
       * 分支点 = 被替换消息当初落盘的那条 `message` 事件。
       *
       * 「编辑后重发」作废该消息之后的全部内容，但事件流**只增不改**，那些事件
       * 仍留在文件里。新事件从被替换处**分叉**（parentId 指向它），于是
       * 「从最新事件沿 parentId 回溯」这条活跃时间线天然跳过废弃分支
       * （见 `@/events/project` 的 `activePath`）。必须在下一条消息落盘前取，
       * 否则索引已被刷新成新事件 id。
       */
      const branchFrom = messageEventIdOf(sessionId, messageId);

      const original = session.messages[idx];
      const contentChanged = original.content !== trimmed;

      // 1) 内容有变化才覆盖（更新文本 + 刷新时间，作为「最近一次发送时间」回显给用户）
      //    编辑后的纯文本不再携带徽章位置信息，richContent 一并作废
      const updatedUser: Message = contentChanged
        ? { ...original, content: trimmed, richContent: undefined, createdAt: nowIso() }
        : original;

      // 2) 截断「原消息之后」的所有内容（包括其助手回复 / 工具调用 / 产物记录），
      //    3) 追加新的 assistant 占位
      const assistantId = genId();
      const assistantMsg: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
      };

      // 重发同样要落一条用户消息事件（即使内容未变）：它是新分支的起点，
      // 也是「该消息的时间戳/内容以最新一次为准」的依据
      recordFor(sessionId, (f) =>
        f.message(
          {
            messageId: updatedUser.id,
            role: 'user',
            content: updatedUser.content,
            createdAt: updatedUser.createdAt,
            ...(updatedUser.attachments && updatedUser.attachments.length > 0
              ? { attachments: updatedUser.attachments.map(toEventAttachment) }
              : {}),
            ...(updatedUser.richContent ? { richContent: updatedUser.richContent } : {}),
          },
          branchFrom !== undefined ? { parentId: branchFrom } : undefined,
        ),
      );

      get().updateSession(sessionId, (s) => ({
        ...s,
        messages: [...s.messages.slice(0, idx), updatedUser, assistantMsg],
      }));

      // 4) 共用流式逻辑；原消息携带的附件一并重发（大文件已裁剪内容时自动跳过）
      await streamAssistantReply(
        sessionId,
        assistantId,
        attachmentsToUploadFiles(original.attachments),
      );
    },

    /**
     * 中断指定会话正在流式传输的请求。无活跃请求时静默 no-op。
     *
     * 1) 立刻调 runtime.abort(sessionId) → 终止底层 fetch；
     * 2) 把该会话最后一条 assistant 消息标记 aborted=true（仅当它存在，
     *    避免误标历史消息）；
     * 3) 立即把该会话流式状态收敛为 idle 且 active=false，让 UI 不再显示
     *    「正在思考 / 流式中」，响应更跟手；流真正结束由 send 的 finally
     *    块移除条目。active=false 同时保证重复点击「停止」是幂等的。
     */
    abort: (sessionId) => {
      const sid = sessionId ?? get().activeId;
      if (!sid) return;
      const stream = get().streams[sid];
      if (!stream?.active) return;
      const target = get().sessions.find((s) => s.id === sid);
      const last = target?.messages[target.messages.length - 1];
      if (last && last.role === 'assistant') {
        get().updateMessage(sid, last.id, (m) => ({ ...m, aborted: true }));
      }
      set((s) => {
        const cur = s.streams[sid];
        if (!cur) return s;
        return {
          ...s,
          streams: { ...s.streams, [sid]: { ...cur, status: 'idle', active: false } },
        };
      });
      void getRuntime().abort(sid);
    },

    appendToken: (sessionId, messageId, chunk) => {
      // 正文开始 = 思考段结束：先把未闭合的段落到事件流，再追加正文
      flushReasoning(sessionId, messageId);
      get().updateMessage(sessionId, messageId, (m) => {
        const base = closeOpenReasoning(m);
        return { ...base, content: base.content + chunk };
      });
    },

    /**
     * 标准 OpenAI `tool_calls` 事件（展示用）。
     *
     * 注意：**授权不在本方法内处理**。真实引擎的逐条批准走
     * `handleApprovalRequest`（引擎在工具执行前挂起，等待独立回传），
     * 而 `capabilities.toolCalls === false` 时本方法根本不会被触发。
     * 旧版在这里用 `status==='pending'` 造了一个纯本地的「假门控」——
     * 它拦不住引擎（工具照常执行），已被 D3 的真实回环取代。
     */
    handleToolCall: (sessionId, messageId, ev) => {
      get().updateMessage(sessionId, messageId, (m) => {
        const existing = m.toolCalls ?? [];
        const toolCalls = existing.some((t) => t.id === ev.id)
          ? existing.map((t) =>
              t.id === ev.id
                ? {
                    ...t,
                    status: ev.status,
                    ...(ev.result !== undefined ? { result: ev.result } : {}),
                  }
                : t,
            )
          : [
              ...existing,
              {
                id: ev.id,
                tool: ev.tool,
                args: ev.args,
                sensitive: ev.sensitive,
                status: ev.status,
                ...(ev.result !== undefined ? { result: ev.result } : {}),
              },
            ];
        return { ...m, toolCalls };
      });
    },

    handleApprovalRequest: (sessionId, messageId, req) => {
      // 工具调用行的 id 必须**与过程时间线对齐**：引擎在 approval_request 里带的
      // `call_id` 与 `tool` 进度事件里的 `call_id` 是同一次调用（见
      // `ApprovalRequestEvent.callId` 的注释），事件流投影（`events/project.ts`
      // 的 permission-decision 分支）也是直接拿 `callId` 当 ToolCall 的 id。
      // 早先这里用的是**审批请求 id**，于是实时路径下两份记录永远对不上，
      // 同一次 write_file 会既显示成过程行、又显示成一张卡片（2026-10-01 用户截图）。
      // 缺 `callId` 时退回审批请求 id：老引擎 / 退化路径下两侧仍可能对不上，
      // 宁可多渲染一张卡片，也不能把一次真实发生的调用藏起来。
      const callId = req.callId ?? req.id;
      // 在消息上落一条 pending 行，使授权请求与过程时间线同源可见
      get().updateMessage(sessionId, messageId, (m) => ({
        ...m,
        toolCalls: [
          ...(m.toolCalls ?? []),
          {
            id: callId,
            tool: req.tool,
            args: req.args,
            sensitive: true,
            status: 'pending' as ToolCall['status'],
          },
        ],
      }));
      set((s) => ({
        pendingApprovals: [
          ...s.pendingApprovals,
          {
            // `id` 是**回传裁决用的线上 id**（POST /v1/tool-approvals/{id}），
            // 与上面那条消息记录的身份不是一回事，不能合并。
            id: req.id,
            sessionId,
            messageId,
            toolCallId: callId,
            tool: req.tool,
            args: req.args,
          },
        ],
      }));
    },

    resolveApproval: async (decision, reason) => {
      const head = get().pendingApprovals[0];
      if (!head) return;
      // 先出队再回传：裁决只能生效一次，重复点击不应再发一次请求
      set((s) => ({ pendingApprovals: s.pendingApprovals.slice(1) }));
      try {
        await getRuntime().respondApproval?.(head.id, decision, reason);
      } catch (e) {
        // 请求已死（超时 / 被取消）：如实提示，不假装授权成功
        toast.error(e instanceof Error ? e.message : String(e));
      }
      // 视图侧只认「通过 / 未通过」两态：`always` 与 `allow` 对**这次调用**的
      // 结果完全一致（都执行），差别在引擎下一轮还问不问。把三态往视图与事件
      // 里扩散会让工具卡片、权限日志各多出一支与本次结果无关的分叉。
      const passed = decision !== 'deny';
      // 裁决落盘（`source: 'engine'` = 引擎侧审批回环，见 D3）。视图侧的
      // 工具卡片状态与 `permissionLog` 都由它重放出来，故一条事件足够。
      // 权限日志条目的 id / 时间取事件自身的值，使刷新前后是同一条记录
      // （而不是每次打开都新造一个 id，导致「同一次裁决」看起来有多个）。
      const [recorded] = recordFor(head.sessionId, (f) =>
        f.permissionDecision({
          messageId: head.messageId,
          callId: head.toolCallId,
          tool: head.tool,
          args: head.args,
          decision: passed ? 'approved' : 'rejected',
          ...(reason ? { reason } : {}),
          source: 'engine',
        }),
      );
      get().updateMessage(head.sessionId, head.messageId, (m) => ({
        ...m,
        toolCalls: (m.toolCalls ?? []).map((t) =>
          t.id === head.toolCallId
            ? { ...t, status: (passed ? 'approved' : 'rejected') as ToolCall['status'] }
            : t,
        ),
      }));
      get().updateSession(head.sessionId, (s) => ({
        ...s,
        permissionLog: [
          ...s.permissionLog,
          {
            id: recorded?.id ?? genId(),
            tool: head.tool,
            args: head.args,
            decision: passed ? 'approved' : 'rejected',
            at: recorded ? new Date(recorded.timestamp).toISOString() : nowIso(),
          },
        ] as PermissionLog[],
      }));
    },

    /**
     * 计划到达（FR-1.5）。
     *
     * 空步骤不下发：不是我们替模型决定「这不算计划」，而是 UI 上没有可勾选的
     * 内容时该卡片只会制造困惑——引擎侧已对空 `steps` 直接 deny，这里是双保险。
     */
    handlePlan: (sessionId, messageId, plan) => {
      if (plan.steps.length === 0) return;
      // 计划随消息落盘（运行时先构造使 视图/事件 同源，投影时按同一形状重建）
      recordFor(sessionId, (f) =>
        f.plan({ messageId, planId: plan.planId, steps: plan.steps }),
      );
      get().updateMessage(sessionId, messageId, (m) => ({
        ...m,
        plan: { planId: plan.planId, steps: plan.steps, status: 'pending' },
      }));
    },

    /**
     * 裁决计划（FR-1.5）。
     *
     * 寻址用 `planId` 而非「当前活跃会话的最后一条计划」：计划的裁决可以在
     * 用户切走会话、模型又产出新计划之后才发生，靠位置推断会批错对象。
     *
     * 批准 = 「这首轮不再只是讨论」：除了落 `plan-decision`，还要把会话切成
     * Craft。少做这一步，批准就只剩装饰意义——Plan 模式下引擎照样拒绝写工具。
     */
    resolvePlan: async (planId, decision, opts) => {
      let hit: { sessionId: string; messageId: string; plan: MessagePlan } | null = null;
      for (const s of get().sessions) {
        const m = s.messages.find((x) => x.plan?.planId === planId);
        if (m?.plan) {
          hit = { sessionId: s.id, messageId: m.id, plan: m.plan };
          break;
        }
      }
      if (!hit) return false;
      // 已裁决过：事件流只增不改，重复裁决只会append 出矛盾的审计记录
      if (hit.plan.status !== 'pending') return false;

      const approvedIds = opts?.approvedStepIds ?? hit.plan.steps.map((s) => s.id);
      recordFor(hit.sessionId, (f) =>
        f.planDecision({
          messageId: hit.messageId,
          planId,
          decision,
          ...(opts?.reason ? { reason: opts.reason } : {}),
          // 「全批准」用显式列表而非缺值表达：重放时无需猜测「当时是全选还是没勾」
          approvedStepIds: approvedIds,
        }),
      );
      get().updateMessage(hit.sessionId, hit.messageId, (m) => ({
        ...m,
        ...(m.plan
          ? {
              plan: {
                ...m.plan,
                status: decision,
                approvedStepIds: approvedIds,
                ...(opts?.reason ? { reason: opts.reason } : {}),
              },
            }
          : {}),
      }));

      if (decision === 'rejected') {
        // 打回不切模式：用户还要在 Plan 里继续讨论修订版计划，切成 Craft 会
        // 让模型立刻动手——那完全违背了他刚做的决定
        return true;
      }

      get().setSessionMode(hit.sessionId, 'craft');
      if (!opts?.execute) return true;

      // 立即执行：把批准范围**作为一轮用户消息**发出去。
      // 刻意不发隐式指令——模型需要看到被批准的具体范围，审计时也要能在会话里
      // 读到「当时批准了什么」，而不是只剩一句「用户批准了计划」。
      const session = get().sessions.find((s) => s.id === hit.sessionId);
      if (!session) return true;
      if (get().streams[hit.sessionId]) {
        toast.error('本轮回复尚未结束，请等它说完再执行计划');
        return true;
      }
      const stepText = hit.plan.steps
        .filter((s) => approvedIds.includes(s.id))
        .map((s, i) => `${i + 1}. ${s.text}`)
        .join('\n');
      await get().send(
        `按以下已批准的计划执行（不要超出该范围）：\n${stepText}`,
        hit.sessionId,
      );
      return true;
    },

    handleArtifact: (sessionId, messageId, ev) => {
      // 产物进事件流（V1 自包含内容，见 ArtifactEvent 的说明）：否则刷新后
      // 气泡里的内联产物会整块消失——旧实现是随会话快照持久化的，不能倒退。
      // 先落事件再据此构造视图对象：`createdAt` / 事件 id 都以事件为准，否则
      // 「实时视图」与「重放投影」会各自造时间，刷新前后不一致。
      const [recorded] = recordFor(sessionId, (f) =>
        f.artifact({
          messageId,
          artifactId: ev.id,
          kind: ev.type,
          name: ev.title ?? '',
          content: ev.content,
          ...(ev.language ? { language: ev.language } : {}),
          ...(ev.url ? { url: ev.url } : {}),
          ...(ev.path ? { path: ev.path } : {}),
          ...(ev.size !== undefined ? { size: ev.size } : {}),
          ...(ev.change ? { change: ev.change } : {}),
          ...(ev.fingerprint ? { fingerprint: ev.fingerprint } : {}),
        }),
      );
      const artifact: Artifact = {
        id: ev.id,
        type: ev.type,
        ...(ev.title !== undefined ? { title: ev.title } : {}),
        content: ev.content,
        ...(ev.language !== undefined ? { language: ev.language } : {}),
        ...(ev.url !== undefined ? { url: ev.url } : {}),
        ...(ev.path !== undefined ? { path: ev.path } : {}),
        ...(ev.size !== undefined ? { size: ev.size } : {}),
        ...(ev.change !== undefined ? { change: ev.change } : {}),
        ...(ev.fingerprint !== undefined ? { fingerprint: ev.fingerprint } : {}),
        createdAt: recorded ? new Date(recorded.timestamp).toISOString() : nowIso(),
      };
      get().updateMessage(sessionId, messageId, (m) => ({
        ...m,
        artifacts: [...(m.artifacts ?? []), artifact],
      }));
      useArtifactsStore.getState().recordArtifact(sessionId, messageId, artifact);
    },

    appendReasoning: (sessionId, messageId, chunk) =>
      get().updateMessage(sessionId, messageId, (m) => {
        const process = [...(m.process ?? [])];
        const last = process[process.length - 1];
        if (last && last.kind === 'reasoning' && !last.closed) {
          process[process.length - 1] = { ...last, content: last.content + chunk };
        } else {
          process.push({ id: genId(), kind: 'reasoning', content: chunk });
        }
        return { ...m, process };
      }),

    /** 闭合末尾未闭合的思考段（`reasoning_end` 到达时）：落盘 + 闭合视图 */
    closeReasoning: (sessionId, messageId) => flushReasoning(sessionId, messageId),

    /**
     * 工具执行进度行（start=新增 running 行 / end=done / error=error）。
     *
     * 副作用：开始执行会闭合当前思考段（与视图侧 `closeOpenReasoning` 同一时机），
     * 因此这里先 `flushReasoning` 把该段落盘，再落工具事件，最后更新视图——
     * 三者顺序与 `seq` 顺序一致，重放时过程时间线才是同样的排列。
     */
    handleProcessTool: (sessionId, messageId, ev) => {
      flushReasoning(sessionId, messageId);
      recordFor(sessionId, (f) =>
        ev.phase === 'start'
          ? f.functionCall({
              messageId,
              callId: ev.id,
              name: ev.tool,
              args: ev.args,
            })
          : f.functionCallResult({
              messageId,
              callId: ev.id,
              name: ev.tool,
              status: ev.phase === 'end' ? 'ok' : 'error',
              ...(ev.result !== undefined ? { result: ev.result } : {}),
              ...(ev.error !== undefined ? { error: ev.error } : {}),
            }),
      );
      get().updateMessage(sessionId, messageId, (m) => {
        const base = closeOpenReasoning(m);
        const process = [...(base.process ?? [])];
        const idx = process.findIndex((p) => p.kind === 'tool' && p.id === ev.id);
        if (ev.phase === 'start') {
          if (idx === -1) {
            process.push({
              id: ev.id,
              kind: 'tool',
              tool: ev.tool,
              args: ev.args,
              status: 'running',
            });
          } else {
            const prev = process[idx] as ProcessToolRow;
            process[idx] = { ...prev, tool: ev.tool, args: ev.args, status: 'running' };
          }
        } else {
          const row: ProcessToolRow = {
            ...(idx !== -1
              ? (process[idx] as ProcessToolRow)
              : {
                  id: ev.id,
                  kind: 'tool' as const,
                  tool: ev.tool,
                  args: ev.args,
                  status: 'running' as const,
                }),
            status: ev.phase === 'end' ? 'done' : 'error',
            ...(ev.result !== undefined ? { result: ev.result } : {}),
            ...(ev.error !== undefined ? { error: ev.error } : {}),
          };
          if (idx !== -1) process[idx] = row;
          else process.push(row);
        }
        return { ...base, process };
      });

      // 工具成功后把「真正落到磁盘的文件」登记为产物。
      // **只认 `end`（成功）**：失败 / 被拒的写入不能凭空造出一张产物卡片
      // （2026-09-29 事故的教训：失败被伪装成完成，界面不能跟着一起骗人）。
      // 一次调用可能涉及多个文件（`apply_patch` 的 `edits[]`），故按数组处理。
      if (ev.phase === 'end') {
        // 「收回」优先于「登记」：删除类工具成功后，那张产物卡片必须跟着消失。
        // 否则文件已不在磁盘、卡片还列着，点「在资源管理器打开」只会得到
        // 「路径不存在」——2026-09-30 用户报的就是这个（模型写完临时脚本、
        // 跑完自己 `delete_file` 清理，面板却留着两张点不开的卡片）。
        const deletedPath = deletedFilePathFrom(ev.tool, ev.args);
        if (deletedPath !== undefined) {
          const artifactId = fileArtifactId(sessionId, deletedPath);
          // 两处引用都要摘：消息气泡上的卡片，以及索引切片（面板列的就是后者）
          get().updateMessage(sessionId, messageId, (m) => {
            const list = m.artifacts ?? [];
            if (!list.some((a) => a.id === artifactId)) return m;
            return { ...m, artifacts: list.filter((a) => a.id !== artifactId) };
          });
          useArtifactsStore.getState().removeArtifacts([artifactId]);
          return;
        }

        const drafts = deriveFileArtifacts(ev.tool, ev.args, ev.id);
        for (const draft of drafts) {
          const existing = findFileArtifact(
            useArtifactsStore.getState().bySession[sessionId] ?? [],
            draft.path,
          );
          // 本会话已见过该路径 → 这是改写；改写类工具即便首次见到该路径，
          // 也只能是「改既有文件」（不是本会话新建的）
          const change: ArtifactChange =
            existing || draft.op === 'edit' ? 'modified' : 'created';
          get().handleArtifact(sessionId, messageId, {
            id: fileArtifactId(sessionId, draft.path),
            type: 'file',
            title: draft.name,
            content: draft.content,
            path: draft.path,
            change,
            ...(draft.size !== undefined ? { size: draft.size } : {}),
            ...(draft.language !== undefined ? { language: draft.language } : {}),
            ...(draft.fingerprint !== undefined ? { fingerprint: draft.fingerprint } : {}),
          });
        }
      }
    },

    /**
     * 专家团成员进度行（FR-2.4 第 3 步）。
     *
     * 与 `handleProcessTool` 同构：先闭合当前思考段（成员开始意味着上一段思考写完了，
     * 否则「思考 → 成员」在时间线上会呈现成思考还没结束成员就开始了），
     * 再落事件、最后更新视图——三者顺序与 `seq` 一致，重放才是同样的排列。
     */
    handleProcessMember: (sessionId, messageId, ev) => {
      flushReasoning(sessionId, messageId);
      const recorded = recordFor(sessionId, (f) =>
        f.expertGroupMember({
          messageId,
          memberId: ev.memberId,
          memberName: ev.memberName,
          phase: ev.phase,
          ...(ev.text !== undefined ? { text: ev.text } : {}),
          ...(ev.error !== undefined ? { error: ev.error } : {}),
        }),
      );
      // 行 id 取**落盘事件 id**：重放路径（`project.ts`）也用事件 id，
      // 两条路径的 key 因此一致——否则刷新一次整块成员区会重建（展开态丢失）。
      // 事件流会话（channel / readonly / cron）不落盘，退回现生成一个 id。
      const rowId = recorded[0]?.id ?? genId();
      get().updateMessage(sessionId, messageId, (m) => {
        const base = closeOpenReasoning(m);
        const row: ProcessEvent = {
          id: rowId,
          kind: 'member',
          memberId: ev.memberId,
          memberName: ev.memberName,
          phase: ev.phase,
          ...(ev.text !== undefined ? { text: ev.text } : {}),
          ...(ev.error !== undefined ? { error: ev.error } : {}),
        };
        return { ...base, process: [...(base.process ?? []), row] };
      });
    },

    retry: async () => {
      const state = get();
      const session = state.sessions.find((s) => s.id === state.activeId);
      if (!session) return;
      const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
      // 把原消息携带的附件与富文本副本一并重发（纯文本消息相应字段为 undefined，行为不变）
      if (lastUser)
        await get().send(lastUser.content, undefined, lastUser.attachments, lastUser.richContent);
    },

    clearError: () => set({ error: null }),
  }),
);
