/**
 * 事件模型：会话的事实源（D2，见 `docs/nanowork-prd-design-v2.md` 第 9 章）。
 *
 * ## 为什么事件化
 *
 * 现状 `Session.messages: Message[]` 是**整块持久化**的快照，天然不支持：
 * 回滚到第 N 步、分支/重放、增量同步、大历史性能（每次加载全量反序列化）。
 * WorkBuddy 的做法是「每会话一个 JSONL 逐行追加事件，事件用 `parentId` 串成
 * DAG」——本文件即该 DAG 的节点契约。
 *
 * ## 与旧模型的关系
 *
 * **不推翻** `Session`/`Message`，而是改变它们的角色：
 *
 * | 之前 | 之后 |
 * |---|---|
 * | `sessionsStore` 是事实源（persist 整块） | 事件流是事实源（落盘 JSONL）；`sessionsStore` 是**内存视图** |
 * | `send()` 直接改 `messages` | `send()` 派发事件 → 落盘 → 更新视图 |
 * | 列表来自全量反序列化 | 列表来自索引（`SessionIndexEntry`） |
 *
 * ## 只增不改
 *
 * 事件一旦落盘**不可改写**（append-only）：用「追加一条修正事件」而非「改旧事件」
 * 来表达变化。这是可回滚与可同步的前提，也让 `seq` 能安全地作为游标。
 *
 * ## 命名提示（勿与视图模型混淆）
 *
 * 本模块的类型是**持久化的事件节点**。它们与本文件同目录的几个**渲染视图模型**
 * 同名但不同层，注意区分：
 *
 * - `./process` 的 `ReasoningEvent` 是「思考段时间线」的渲染聚合体（带 `closed`），
 *   由 SSE 进度事件在 store 内聚合而成，**不落盘**；
 * - 本模块的 `ReasoningEvent`（`type: 'reasoning'`）是事件流里的一个节点。
 *
 * 正因为存在这类同名不同层的类型，本模块**不**从 `types/index.ts` 再导出，
 * 一律以 `@/types/event` 直达，避免 barrel 歧义与误用。
 */

import type { ArtifactChange, ArtifactType } from './artifact';
import type { Role } from './message';
import type { PlanVerdict } from './message';
import type { MemberEventPhase } from './process';

/** 事件类型全集（对齐设计文档 9.2；17 种） */
export type EventType =
  | 'session-start' // 会话开始（记录 agent / workdir / mode / model）
  | 'message' // 用户或助手消息
  | 'reasoning' // 模型思考过程
  | 'function-call' // 工具调用请求
  | 'function-call-result' // 工具执行结果
  | 'permission-decision' // 权限决策（允许 / 拒绝 + 策略来源）
  | 'plan' // Plan 模式产出的计划
  | 'plan-decision' // 计划审批结果
  | 'expert-group-member' // 专家团成员生命周期（FR-2.4）
  | 'artifact' // 产物
  | 'file-history-snapshot' // 文件快照（回滚锚点）
  | 'commit' // commitSeq 推进（回滚边界）
  | 'ai-title' // 自动标题
  | 'usage' // token / 成本
  | 'error' // 错误
  | 'mode-change' // 模式切换
  | 'session-end'; // 会话结束

/** 执行模式（FR-1.4 / FR-1.5）：提问 / 计划 / 执行 */
export type ExecutionMode = 'ask' | 'plan' | 'craft';

/** 权限策略（会话级）：restricted = 默认权限；full = 允许完全访问 */
export type PermissionMode = 'restricted' | 'full';

/** 工具裁决（第 11 章工具网关）：放行 / 沙箱内放行 / 拒绝 */
export type ToolDecision = 'allow' | 'sandbox' | 'deny';

/**
 * 引擎侧链路信息，**逐事件落盘**。
 *
 * 这正是 WorkBuddy 的做法：可观测性不需要额外埋点，因为 trace 信息本来就随
 * 事件走。排查「这一步是谁跑的、用了哪个模型、请求 id 是什么」时无需旁路日志。
 */
export interface EventProvider {
  /** 实际使用的模型名 */
  model?: string;
  /** 请求侧模型 id（多模型路由时与 model 可能不同） */
  requestModelId?: string;
  /** 引擎 trace id，用于与网关日志对齐 */
  traceId?: string;
  /** 执行该事件的 Agent id（子代理场景与 session.agentId 不同） */
  agent?: string;
}

/**
 * 归属字段：把「回合内事件」挂到承载它的渲染层消息上。
 *
 * ## 为什么需要它
 *
 * 助手消息的正文是**流式累积**的，因此 `message` 事件只能在**回合结束时**落盘
 * （内容是终值）。于是同回合的工具 / 思考 / 产物事件的 `seq` 都**小于**那条
 * `message` 事件——若靠「就近归属」，它们会被算到上一条消息头上。
 *
 * 用显式的 `messageId` 关联则与顺序无关：投影时先按 id 归组、再按各消息
 * `message` 事件的 `seq` 排序，天然容忍乱序、丢事件与分叉。
 *
 * ## 取值
 *
 * 与 `Message.id` 一致（渲染层消息 id），非事件 id（`BaseEvent.id`）。
 * 缺省表示该事件不挂在任何消息上（例如 `commit` / `usage` / `session-end`）。
 */
export interface MessageScoped {
  /** 承载本事件的渲染层消息 id（`Message.id`） */
  messageId?: string;
}

/** 所有事件的公共字段 */
export interface BaseEvent {
  /** 事件唯一 id */
  id: string;
  /** 所属会话 id */
  sessionId: string;
  /** DAG 父节点；根事件（session-start）为 null */
  parentId: string | null;
  /** 会话内单调递增序号，从 1 开始（作为读取游标） */
  seq: number;
  type: EventType;
  /** 毫秒时间戳 */
  timestamp: number;
  /** 引擎侧链路信息（可选） */
  provider?: EventProvider;
}

/** 会话开始：记录本会话的执行上下文 */
export interface SessionStartEvent extends BaseEvent {
  type: 'session-start';
  agentId: string;
  /** 会话级工作空间；缺省表示「默认工作空间」 */
  workdir?: string;
  mode: ExecutionMode;
  permissionMode: PermissionMode;
  model?: string;
}

/**
 * 消息（用户 / 助手 / 工具回执）。
 *
 * **一条 `Message` 对应一条本事件**：用户消息在发送时落盘；助手消息因正文是
 * 流式累积的，在**回合结束时**以终值落盘（同回合的工具 / 思考事件通过
 * `MessageScoped.messageId` 关联到它，而不是靠顺序）。
 */
export interface MessageEvent extends BaseEvent {
  type: 'message';
  /** 渲染层消息 id（`Message.id`）；同会话内唯一，也是回合内其它事件的归属键 */
  messageId: string;
  role: Role;
  content: string;
  /**
   * 消息创建时间（ISO 8601）。
   *
   * 与 `BaseEvent.timestamp`（事件**落盘**时刻）不等价：助手消息在回合开始时就
   * 有了占位（`createdAt` 定在那一刻），而事件要等回合结束才写。缺省时投影回退
   * 到 `timestamp`，故老事件仍可读。
   */
  createdAt?: string;
  /** 附件仅存引用元信息；内容本身不入事件流（另存附件库） */
  attachments?: Array<{
    id: string;
    name: string;
    kind?: string;
    mime?: string;
    size?: number;
    path?: string;
  }>;
  /**
   * 富文本副本（仅 user 消息）：附件徽章以 `\uE000<attId>\uE001` 占位，
   * 气泡据此把徽章渲染回输入时的原始位置。
   */
  richContent?: string;
  /** 本次流式处理耗时（毫秒，仅 assistant；回合结束时写入） */
  durationMs?: number;
  /** 助手回合被用户中断（仅 assistant） */
  aborted?: boolean;
  /** 助手回合因引擎侧异常（断流 / 报错 / 迭代上限）未正常收尾（仅 assistant） */
  interrupted?: boolean;
}
/** 模型思考片段；同一段思考会追加多条，末条 `done=true` 收尾 */
export interface ReasoningEvent extends BaseEvent, MessageScoped {
  type: 'reasoning';
  content: string;
  /** 本段思考是否结束 */
  done?: boolean;
}
/** 工具调用请求 */
export interface FunctionCallEvent extends BaseEvent, MessageScoped {
  type: 'function-call';
  /** 引擎侧调用 id（与 function-call-result 配对） */
  callId: string;
  /** 工具名（对齐 nanobot 工具名） */
  name: string;
  args: Record<string, unknown>;
  /** 网关决策结果（第 11 章）；决策前缺省 */
  policy?: { decision: ToolDecision; reason?: string };
}

/** 工具执行结果 */
export interface FunctionCallResultEvent extends BaseEvent, MessageScoped {
  type: 'function-call-result';
  callId: string;
  name: string;
  status: 'ok' | 'error';
  /** 成功时的展示文本（已按需截断） */
  result?: string;
  /** 失败原因 */
  error?: string;
}

/**
 * 权限决策。
 *
 * `source` 记录裁决来自哪一层：`engine` = 引擎侧审批回环（D3 逐条批准）；
 * `local` = 遗留的本地假门控（已废弃，仅为迁移历史事件保留）。
 */
export interface PermissionDecisionEvent extends BaseEvent, MessageScoped {
  type: 'permission-decision';
  /** 被裁决的工具调用记录 id（与 `ToolCall.id` 对齐；审批门控下即审批请求 id） */
  callId: string;
  tool: string;
  /** 工具入参：投影时用于重建该行（气泡上的工具卡片要显示「批准了什么」） */
  args?: Record<string, unknown>;
  decision: 'approved' | 'rejected';
  reason?: string;
  source: 'engine' | 'local';
}

/** 计划步骤 */
export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'done' | 'skipped';
}

/**
 * Plan 模式产出的计划。
 *
 * 挂在**承载它的助手消息**上（`MessageScoped`）：与产物同源，计划是
 * 「这一轮说了什么」的一部分——孤立的时间线顺序会因助手 `message` 事件在回合
 * 结束才落盘而把计划算到上一条消息头上（见 `MessageScoped` 的说明）。
 */
export interface PlanEvent extends BaseEvent, MessageScoped {
  type: 'plan';
  planId: string;
  steps: PlanStep[];
}

/** 计划审批结果（用户裁决留痕，append-only） */
export interface PlanDecisionEvent extends BaseEvent, MessageScoped {
  type: 'plan-decision';
  planId: string;
  decision: PlanVerdict;
  reason?: string;
  /** 用户勾选保留的步骤 id；缺省表示全选 */
  approvedStepIds?: string[];
}

/**
 * 产物。
 *
 * **V1 自包含内容**：设计文档原设想「事件只存引用、内容进 `artifact-index/`」，
 * 但该索引属 R7 / M4 范围尚未落地。在它可用之前，事件内联 `content`——
 * 否则刷新后消息气泡里的内联产物会整块消失（旧实现是随会话快照持久化的，
 * 不能倒退）。
 *
 * `path` / `size` / `change` 原先作为「索引落地后的引用式写法」留位，现由
 * **文件产物**（工具写出的文件）启用：它们的身份就是路径，正文对改写类工具
 * 不可得，因此必须把路径与变更性质随事件落盘，刷新后卡片才能原样恢复。
 */
export interface ArtifactEvent extends BaseEvent, MessageScoped {
  type: 'artifact';
  /** 产物 id（与 `Artifact.id` 一致） */
  artifactId: string;
  /** 渲染类别（与 `Artifact.type` 一致） */
  kind: ArtifactType;
  /** 标题（与 `Artifact.title` 一致；无标题写空串） */
  name: string;
  /** 文本类内容（html / svg / code / mermaid / markdown）；外链类为空串 */
  content: string;
  /** code 高亮语言 */
  language?: string;
  /** image / video 外链 url */
  url?: string;
  /** 文件产物的绝对路径 */
  path?: string;
  /** 文件产物的字节数（正文快照不可得时缺省） */
  size?: number;
  /** 文件产物的变更性质（created / modified） */
  change?: ArtifactChange;
  /** 文件产物的事件级内容指纹（正文不可得的改写类工具，见 `Artifact.fingerprint`） */
  fingerprint?: string;
  mime?: string;
}

/** 文件快照（回滚锚点）：同一内容只备份一次（内容寻址） */
export interface FileSnapshotEvent extends BaseEvent {
  type: 'file-history-snapshot';
  commitSeq: number;
  files: Array<{ path: string; hash: string; backupRef: string }>;
}

/** commitSeq 推进（回滚边界） */
export interface CommitEvent extends BaseEvent {
  type: 'commit';
  commitSeq: number;
  /** 触发本次推进的调用 id（可选） */
  callId?: string;
}

/** 自动生成的会话标题 */
export interface AiTitleEvent extends BaseEvent {
  type: 'ai-title';
  title: string;
}

/** 用量（token / 成本） */
export interface UsageEvent extends BaseEvent {
  type: 'usage';
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}

/** 错误 */
export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  code?: string;
  /** 原始错误描述（仅本地调试，不入同步） */
  detail?: string;
}

/** 执行模式切换 */
export interface ModeChangeEvent extends BaseEvent {
  type: 'mode-change';
  from: ExecutionMode;
  to: ExecutionMode;
}

/**
 * 回合结束。
 *
 * **V1 语义**：一次「用户提问 → 助手回答」的**单轮**结束（`reason` 即本轮结果：
 * 正常 / 出错 / 被中断）。之所以不叫 turn-end 而沿用 `session-end`，是因为
 * 事件类型全集（16 种）已由设计文档固定；会话**生命周期**级的结束
 * （删除 / 归档 / 同步吊销）留待 V2 的独立事件。本轮边界对同步与回滚有用，
 * 故保留而非闲置。
 */
export interface SessionEndEvent extends BaseEvent {
  type: 'session-end';
  /**
   * 本轮结果。`interrupted` 与 `aborted` 必须分开：前者是引擎侧异常结束
   * （断流 / 报错 / 迭代上限），后者是用户主动停止——重放与统计要把它们分开算。
   */
  reason?: 'done' | 'error' | 'aborted' | 'interrupted';
}

/**
 * 专家团成员的生命周期（FR-2.4 第 3 步）。
 *
 * 与 `reasoning` / `function-call` 同类：它是**回合内**的过程事件，靠 `messageId`
 * 归到承载它的助手消息上（成员产出不是消息，只随过程事件出站）。
 *
 * ⚠️ **必须落盘、不能只改内存里的 `Message.process`**：打开会话时消息是由事件流
 * 重建的（`projectMessages`），不落盘就会「退出重进后成员归属凭空消失」——
 * 而实时那一轮看起来完全正常，属于最难自查的一类。
 */
export interface ExpertGroupMemberEvent extends BaseEvent, MessageScoped {
  type: 'expert-group-member';
  /** 成员 id（同一成员会连续发多个相位，分组键） */
  memberId: string;
  memberName: string;
  phase: MemberEventPhase;
  /** 产出文本（finished）/ 团队计划（planned） */
  text?: string;
  /** 失败原因（failed） */
  error?: string;
}

/** 事件联合（判别字段为 `type`） */
export type SessionEvent =
  | SessionStartEvent
  | MessageEvent
  | ReasoningEvent
  | FunctionCallEvent
  | FunctionCallResultEvent
  | PermissionDecisionEvent
  | PlanEvent
  | PlanDecisionEvent
  | ExpertGroupMemberEvent
  | ArtifactEvent
  | FileSnapshotEvent
  | CommitEvent
  | AiTitleEvent
  | UsageEvent
  | ErrorEvent
  | ModeChangeEvent
  | SessionEndEvent;

/** 从联合中按 `type` 取出具体事件类型 */
export type EventOfType<T extends EventType> = Extract<SessionEvent, { type: T }>;

/**
 * 会话元数据（落盘 `<sessionId>.meta.json`）。
 *
 * 与 `SessionIndexEntry` 的区别：meta 是**每会话一份**的权威元数据（可含同步
 * 元数据与用户偏好），索引条目是**为列表查询做的投影**（可随时从 meta 重建）。
 * 分离的原因是索引需要按会话数线性增长地扫描，而 meta 只在打开单个会话时读。
 */
export interface SessionMeta {
  id: string;
  title: string;
  agentId: string;
  groupId?: string | null;
  /**
   * **事件流落盘分片**：本 meta 与同目录的 `.jsonl` 所对应的路径
   * （`projects/<cwdSlug(workdir)>/`）。
   *
   * 不变式：meta 文件永远位于 `cwdSlug(this.workdir)` 那个目录里——路径解析
   * （`electron/eventStore.ts` 的 `writeMeta` / `rebuildIndex`）直接由它推出目录，
   * 所以它取的是「文件当前所在分片」，而不是「会话现在绑定的工作空间」。
   *
   * 两者只在一种情况下不同：会话已有消息又被切换了工作空间——此时记录留在原处
   * （`workdir` 不变），新的工作空间写进 `workspace`。见 `Session.streamWorkdir`。
   */
  workdir?: string;
  /**
   * 会话**当前绑定**的工作空间（语义值）：侧边栏分组、注入引擎的 cwd、记忆目录
   * 都看它。缺省表示与 `workdir` 相同（从未切换过工作空间的会话都是这个形态，
   * 于是老数据不需要迁移）。
   */
  workspace?: string;
  mode: ExecutionMode;
  model?: string;
  permissionMode: PermissionMode;
  /** 会话级逐条批准（与 permissionMode 正交，见 Session.toolApproval） */
  toolApproval?: boolean;
  /**
   * 本会话临时挂载的技能 id 列表。
   *
   * 技能内容会随每次请求注入 system 段，因此这是**影响行为**的会话状态，
   * 必须随元数据落盘（与 `Session.skillIds` 对齐）。
   */
  skillIds?: string[];
  /** 来源 IM 渠道；缺省为本地会话 */
  channel?: string;
  readonly?: boolean;
  pinned?: boolean;
  /**
   * 会话版本引用集（FR-3.9 ①，与 `Session.pluginVersions` 对齐）。
   *
   * 必须随 meta 落盘：它是**声明**而非缓存，重启后丢失就等于「这个会话当初用哪一版」
   * 凭空消失，GC 保护与「版本不一致」提示会一起失效。
   */
  pluginVersions?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** 同步元数据（第 19 章） */
  rev?: number;
  /**
   * 最后改动这份元数据的**设备标识**（`lib/deviceId.ts` 的 `currentDeviceId()`）。
   *
   * 老数据（事件化之前写的 meta）没有这个字段，读作空串——空串明确表示「来源未知」，
   * 不要兜底成 `'unknown'`：那会伪装成一台真实设备，多台机器共用同一个值，
   * LWW 里「谁改的」就彻底失去意义。
   */
  updatedBy?: string;
  deletedAt?: string | null;
}

/**
 * 索引条目（落盘 `index/sessions.json`）。
 *
 * 设计文档 9.4 原定 SQLite（`sessions` 表），本项目 V1 改用 **JSON 索引文件**：
 * 索引是**可再生派生物**（可从各会话的 JSONL + meta 重建），零原生依赖对
 * 跨端一致与打包链路的价值高于 SQLite 的查询能力。接口留位，后续可无痛替换。
 */
export interface SessionIndexEntry {
  id: string;
  title: string;
  agentId: string;
  groupId?: string | null;
  workdir?: string;
  mode: ExecutionMode;
  model?: string;
  permissionMode: PermissionMode;
  channel?: string;
  readonly?: boolean;
  pinned?: boolean;
  /** 事件总数（含全部类型） */
  eventCount: number;
  /** 最大 seq（读取游标） */
  lastSeq: number;
  /**
   * **有对话记录**的判据：用户 / 助手 `message` 事件的数量。
   *
   * 它必须落在索引里，不能靠「读一遍 JSONL 看有没有 message 事件」现算：
   * 列表（侧边栏任务列表）在启动时**只读索引**，会话消息要等用户点进去才水合
   * （见 `sessionsStore.loadSessions`）。此前列表用 `session.messages.length > 0`
   * 判断「这条任务有没有内容」，于是重启之后未点开的会话消息是留白的，全被判成
   * 「空会话」而消失——侧边栏于是只剩下当前打开的那一条，其余工作空间看起来
   * 「一个任务都没有」。
   *
   * 与 `messages.length` 的细微差别：索引计数含**全部** message 事件，投影只算
   * 活跃时间线（编辑后重发会废弃旧分支）。列表只关心「有没有内容」，这点差异
   * 无意义；界面上以水合后的条数为准，见 `conversationCount`。
   */
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * 同步元数据（第 19 章）。
   *
   * 与 `SessionMeta` **保持同一份形状**：索引是「meta + 计数」的投影，重建时
   * `entryFromMeta` 直接照抄。若只给 meta 加字段而不给条目加，重建一次
   * （索引版本不符 / 文件损坏时会发生）就会把同步元数据整批洗掉，而界面上看不出异常
   * ——直到下次同步发现所有会话的 `rev` 都回到了缺省值。
   */
  rev?: number;
  updatedBy?: string;
  deletedAt?: string | null;
}

/** 索引文件结构（带 schema 版本，便于后续迁移） */
export interface SessionIndexFile {
  /** schema 版本；当前为 1 */
  version: number;
  /** 条目按会话 id 索引 */
  entries: Record<string, SessionIndexEntry>;
}
