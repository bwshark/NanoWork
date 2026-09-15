import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { PLACEHOLDER_TITLES, STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { toast } from '@/components/Toast';
import { connectionManager } from '@/ai/connectionManager';
import { getRuntime } from '@/ai/runtime';
import {
  attachmentsToUploadFiles,
  toPersistableAttachment,
} from '@/lib/attachments';
import { MemoryService } from '@/lib/memory';
import { useAgentsStore } from './agentsStore';
import { useArtifactsStore } from './artifactsStore';
import { useExpertGroupsStore } from './expertGroupsStore';
import { useSettingsStore } from './settingsStore';
import { useSkillsStore } from './skillsStore';
import type {
  Artifact,
  Attachment,
  ChatMessageParam,
  MemoryState,
  Message,
  PermissionLog,
  ProcessToolRow,
  Session,
  ToolCall,
} from '@/types';
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ArtifactEvent,
  ChatRequest,
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

export type StreamStatus = 'idle' | 'thinking' | 'streaming' | 'tooling' | 'done';

/** 单个会话的流式上下文（仅运行时状态，不持久化） */
export interface SessionStream {
  /** 当前流式阶段：思考 / 流式 / 工具中 / 完成 */
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
    opts?: { workdir?: string; fullAccess?: boolean; toolApproval?: boolean },
  ) => Session;
  /**
   * 注入外部来源会话（IM 频道会话）并激活。
   * 同 id 已存在时整体替换（刷新消息 / 标题 / 时间）；
   * 频道会话不进入持久化白名单，每次打开从 nanobot 实时拉取。
   */
  openExternal: (session: Session) => void;
  selectSession: (id: string) => void;
  deleteSession: (id: string) => void;
  /**
   * 批量删除会话（分组级「从列表中移除」用）。
   *
   * 刻意**不做**自动沉淀：一个自动任务分组动辄几十条执行记录，
   * 逐条调模型总结既慢又无检索价值，且删除是用户明确的「清掉」意图。
   */
  deleteSessions: (ids: string[]) => void;
  renameSession: (id: string, title: string) => void;
  /** 切换置顶状态：分组内始终排在最前 */
  togglePinSession: (id: string) => void;
  /** 设置会话工作空间（undefined 表示清除，归入默认分组） */
  setSessionWorkdir: (id: string, workdir?: string) => void;
  /** 设置会话权限策略：true = 允许完全访问 */
  setSessionFullAccess: (id: string, fullAccess: boolean) => void;
  /** 设置会话级逐条批准：true = 副作用工具执行前逐一授权（FR-1.5） */
  setSessionToolApproval: (id: string, toolApproval: boolean) => void;
  /** 设置会话级模型覆盖 */
  setSessionModel: (id: string, model: string) => void;

  // —— 记忆 ——
  /** 关闭「已加载 N 条记忆」提示条 */
  dismissMemoryBar: () => void;
  /** 异步读取记忆并缓存到指定会话（createSession 内部调用，也可手动刷新） */
  loadMemoryInto: (sessionId: string) => Promise<void>;

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
   * @param decision 允许 / 拒绝
   * @param reason 拒绝原因（可选）；引擎会回灌给模型让它改道
   *
   * 回传失败（请求已超时/已取消）时提示用户并仍出队——该请求已死，
   * 留在队列里只会反复失败。
   */
  resolveApproval: (decision: ApprovalDecision, reason?: string) => Promise<void>;
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

  // 1) 构造 history：system (agent / 记忆 / 技能 / 本地时间) + 历史消息
  const history: ChatMessageParam[] = [];
  const agent = agents.find((a) => a.id === session.agentId);
  if (agent?.systemPrompt) {
    history.push({ role: 'system', content: agent.systemPrompt });
  }
  // 记忆注入：读取本会话创建时缓存的快照，以标签块追加在 system 段末尾。
  // 永不写入 agent.systemPrompt，仅存在于本次请求的临时 history。
  // 用户在提示条上「关闭」后（memoryLoaded.dismissed），临时停止注入，
  // 避免旧记忆干扰当前 Agent 人设；新建会话时 dismissed 会重置。
  const memorySnapshot =
    useSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.memory ?? '';
  const memoryDismissed = useSessionsStore.getState().memoryLoaded.dismissed;
  if (
    !memoryDismissed &&
    useSettingsStore.getState().settings.memoryEnabled &&
    memorySnapshot.trim() !== ''
  ) {
    const wrapped = MemoryService.wrapForInjection(memorySnapshot);
    if (wrapped !== '') history.push({ role: 'system', content: wrapped });
  }
  // 技能注入：把本会话挂载且已启用的技能 prompt 追加在 system 段末尾。
  const skills = useSkillsStore
    .getState()
    .skills.filter(
      (sk) => session.skillIds?.includes(sk.id) && sk.enabled && sk.prompt.trim() !== '',
    );
  skills.forEach((sk) => history.push({ role: 'system', content: sk.prompt }));
  // 本地时间提示：追加在 system 段末尾（仅存在于本次请求的临时 history，
  // 不落库不污染人设）。智能体处理「30分钟后」「后天2点半」等相对时间时，
  // 需据此换算为绝对时间后再调用 cron 工具，避免时区/基准歧义导致调度偏差。
  const now = new Date();
  const localTime = now.toLocaleString('zh-CN', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, hour12: false });
  history.push({
    role: 'system',
    content: `当前本地时间：${localTime}（时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}，ISO ${now.toISOString()}）。当用户提出相对时间（如"30分钟后""后天2点半""8月底"）的提醒/定时任务时，请据此换算为绝对时间后再调用 cron 工具。`,
  });
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

  const req: ChatRequest = {
    agentId: session.agentId,
    messages: history,
    stream: true,
    // 会话级模型优先；未设置（Auto）时省略 model，由网关使用其配置默认模型
    model: session.model ?? '',
    sessionId,
    // 附件上传：仅在本次确实带文件时下发，nanobotClient 据此切 multipart
    ...(files && files.length > 0 ? { files } : {}),
    // 会话级工作空间：引擎按 turn 解析 workspace_scope 生效；
    // 权限仅「完全访问」时显式下发 full，默认权限跟随引擎配置默认
    workspace: session.workdir,
    accessMode: session.fullAccess ? 'full' : undefined,
    // 逐条批准（tool_approval 轴）：两种权限开关是正交的，但「完全访问」更粗——
    // 它已经表达了「别问我」，因此开启时不再叠加逐条审批，避免两个开关互相打架。
    approvalMode: session.toolApproval && !session.fullAccess ? 'ask' : undefined,
  };

  // 2) 为该会话建立独立流式上下文（其他会话不受影响）
  useSessionsStore.setState((s) => ({
    streams: { ...s.streams, [sessionId]: { status: 'thinking', active: true } },
    error: null,
  }));

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
      onApprovalRequest: (r) =>
        useSessionsStore.getState().handleApprovalRequest(sessionId, assistantId, r),
      onDone: () => patchStream({ status: 'done' }),
      onError: (err) => {
        sendError = err.message;
        useSessionsStore.setState({ error: err.message });
        toast.error(`发送失败：${err.message}`);
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendError = msg;
    useSessionsStore.setState({ error: msg });
    toast.error(`发送失败：${msg}`);
  } finally {
    // 结束（成功 / 报错 / abort）后移除该会话的流式上下文，恢复可发送状态。
    // 顺带把本次耗时落到助手消息上（消息头「已处理 33s」的数据源）：
    // 这里是所有出口（done / error / abort）的唯一交汇点，放这里才不会漏。
    // 已有 durationMs 时不覆盖（重放 / 持久化恢复过的消息保持原值）。
    useSessionsStore.getState().updateMessage(sessionId, assistantId, (m) => {
      if (m.durationMs !== undefined) return m;
      const startedAt = Date.parse(m.createdAt);
      if (Number.isNaN(startedAt)) return m;
      const elapsed = Date.now() - startedAt;
      return elapsed > 0 ? { ...m, durationMs: elapsed } : m;
    });
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
 */
function closeOpenReasoning(m: Message): Message {
  const process = m.process;
  if (!process || process.length === 0) return m;
  const last = process[process.length - 1];
  if (last.kind !== 'reasoning' || last.closed) return m;
  return {
    ...m,
    process: [...process.slice(0, -1), { ...last, closed: true }],
  };
}

/** 记忆提示状态初始值（不持久化） */
const INITIAL_MEMORY_STATE: MemoryState = { injected: false, count: 0, dismissed: false };

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

export const useSessionsStore = create<SessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],
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
        const agentsState = useAgentsStore.getState();
        /**
         * 兜底优先级与召唤逻辑对齐：显式 agentId > 全局活跃专家团 > 全局活跃专家。
         * 专家团绑定仅在其启用且存在启用成员时生效；
         * agentId 取团内首位启用成员作为执行代表（完整多 Agent 编排依赖 nanobot 运行时，P2）。
         */
        const groupsState = useExpertGroupsStore.getState();
        const candidateGroup =
          agentId === undefined && groupsState.activeGroupId
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
          groupLeader?.id ??
          agentsState.activeAgentId ??
          agentsState.agents[0]?.id ??
          '';
        const agent = agentsState.agents.find((a) => a.id === aid);
        const session: Session = {
          id: genId(),
          agentId: aid,
          ...(boundGroup ? { groupId: boundGroup.id } : {}),
          skillIds: agent?.skillIds?.length ? [...agent.skillIds] : undefined,
          workdir: opts?.workdir,
          fullAccess: opts?.fullAccess,
          toolApproval: opts?.toolApproval,
          title,
          messages: [],
          permissionLog: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        set((s) => ({
          sessions: [session, ...s.sessions],
          activeId: session.id,
          // 新会话重置提示条，等异步读取结果回填
          memoryLoaded: INITIAL_MEMORY_STATE,
        }));

        // 异步加载记忆，不阻塞返回
        void get().loadMemoryInto(session.id);
        return session;
      },

      loadMemoryInto: async (sessionId) => {
        if (!useSettingsStore.getState().settings.memoryEnabled) return;
        let text = '';
        try {
          text = await MemoryService.load();
        } catch {
          return;
        }
        if (text.trim() === '') return;
        // 会话可能已在读取期间被删除
        if (!get().sessions.some((s) => s.id === sessionId)) return;

        get().updateSession(sessionId, (s) => ({ ...s, memory: text }));
        set({
          memoryLoaded: {
            injected: true,
            count: MemoryService.countEntries(text),
            dismissed: false,
          },
        });
      },

      dismissMemoryBar: () =>
        set((s) => ({ memoryLoaded: { ...s.memoryLoaded, dismissed: true } })),

      setSessionWorkdir: (id, workdir) =>
        get().updateSession(id, (s) => ({
          ...s,
          workdir,
          updatedAt: nowIso(),
        })),

      setSessionFullAccess: (id, fullAccess) =>
        get().updateSession(id, (s) => ({
          ...s,
          fullAccess,
          updatedAt: nowIso(),
        })),

      setSessionToolApproval: (id, toolApproval) =>
        get().updateSession(id, (s) => ({
          ...s,
          toolApproval,
          updatedAt: nowIso(),
        })),

      setSessionModel: (id, model) =>
        get().updateSession(id, (s) => ({
          ...s,
          model,
          updatedAt: nowIso(),
        })),

      openExternal: (session) =>
        set((s) => ({
          sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
          activeId: session.id,
        })),

      selectSession: (id) => set({ activeId: id }),

      deleteSession: (id) => {
        // 自动沉淀触发点（P1）：删除会话前尝试把历史归纳进记忆。
        // 开关关闭时跳过；fire-and-forget，不阻塞删除。
        const { autoSummarize } = useSettingsStore.getState().settings;
        const target = get().sessions.find((x) => x.id === id);
        if (autoSummarize && target && target.messages.length > 0) {
          const history: ChatMessageParam[] = target.messages
            .filter(
              (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() !== '',
            )
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
          const sourceTitle = target.title;
          void (async () => {
            try {
              const summary = await MemoryService.summarize(history);
              if (summary.trim() !== '') {
                await MemoryService.append(summary, { source: `auto:${sourceTitle}` });
              }
            } catch {
              /* 自动沉淀为附加能力，失败静默 */
            }
          })();
        }

        set((s) => {
          const sessions = s.sessions.filter((x) => x.id !== id);
          const activeId = s.activeId === id ? sessions[0]?.id ?? null : s.activeId;
          return { sessions, activeId };
        });
      },

      deleteSessions: (ids) => {
        const doomed = new Set(ids);
        if (doomed.size === 0) return;
        set((s) => {
          const sessions = s.sessions.filter((x) => !doomed.has(x.id));
          // 活跃会话被删时退回列表首位；没删到任何会话则原样返回，避免无谓重渲染
          if (sessions.length === s.sessions.length) return s;
          const activeId =
            s.activeId && doomed.has(s.activeId) ? sessions[0]?.id ?? null : s.activeId;
          return { sessions, activeId };
        });
      },

renameSession: (id, title) =>
  get().updateSession(id, (s) => ({ ...s, title, updatedAt: nowIso() })),

  togglePinSession: (id) =>
    get().updateSession(id, (s) => ({
      ...s,
      pinned: !s.pinned,
      updatedAt: nowIso(),
    })),

      updateSession: (id, updater) =>
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === id ? updater(x) : x)),
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
        get().updateSession(sid, (s) => ({
          ...s,
          // 占位标题（新会话/新任务）在首条消息时自动替换为消息摘要
          title: (PLACEHOLDER_TITLES as readonly string[]).includes(s.title)
            ? trimmed.slice(0, 24) || list[0]?.name.slice(0, 24) || '新会话'
            : s.title,
          messages: [...s.messages, userMsg, assistantMsg],
        }));

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
        const session = get().sessions.find((s) => s.id === sessionId);
        if (!session || session.readonly) return;
        if (get().streams[sessionId]) return;
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx === -1 || session.messages[idx].role !== 'user') return;

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

      appendToken: (sessionId, messageId, chunk) =>
        get().updateMessage(sessionId, messageId, (m) => {
          const base = closeOpenReasoning(m);
          return { ...base, content: base.content + chunk };
        }),

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
        // 在消息上落一条 pending 行，使授权请求与过程时间线同源可见
        get().updateMessage(sessionId, messageId, (m) => ({
          ...m,
          toolCalls: [
            ...(m.toolCalls ?? []),
            {
              id: req.id,
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
              id: req.id,
              sessionId,
              messageId,
              toolCallId: req.id,
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
        get().updateMessage(head.sessionId, head.messageId, (m) => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map((t) =>
            t.id === head.toolCallId
              ? { ...t, status: (decision === 'allow' ? 'approved' : 'rejected') as ToolCall['status'] }
              : t,
          ),
        }));
        get().updateSession(head.sessionId, (s) => ({
          ...s,
          permissionLog: [
            ...s.permissionLog,
            {
              id: genId(),
              tool: head.tool,
              args: head.args,
              decision: decision === 'allow' ? 'approved' : 'rejected',
              at: nowIso(),
            },
          ] as PermissionLog[],
        }));
      },

      handleArtifact: (sessionId, messageId, ev) => {
        const artifact: Artifact = {
          id: ev.id,
          type: ev.type,
          title: ev.title,
          content: ev.content,
          language: ev.language,
          url: ev.url,
          createdAt: nowIso(),
        };
        get().updateMessage(sessionId, messageId, (m) => ({
          ...m,
          artifacts: [...(m.artifacts ?? []), artifact],
        }));
        useArtifactsStore.getState().recordArtifact(sessionId, artifact);
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

      closeReasoning: (sessionId, messageId) =>
        get().updateMessage(sessionId, messageId, (m) => closeOpenReasoning(m)),

      handleProcessTool: (sessionId, messageId, ev) =>
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
        }),

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
    {
      name: STORAGE_KEYS.sessions,
      storage: zustandStorage,
      // 持久化仅本地会话数据，不持久化运行时状态；
      // 频道会话（channel 有值）每次从 nanobot 实时拉取，不落本地存储，
      // 同时避免重载后 activeId 指向未恢复的频道会话
      partialize: (s) => {
        // 频道会话与只读会话均为外部来源快照，不持久化（每次打开实时拉取）
        const sessions = s.sessions.filter((x) => !x.channel && !x.readonly);
        const activeId = sessions.some((x) => x.id === s.activeId)
          ? s.activeId
          : null;
        return { sessions, activeId };
      },
    },
  ),
);
