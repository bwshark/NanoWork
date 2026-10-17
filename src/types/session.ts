import type { ExecutionMode } from './event';
import type { Message } from './message';
import type { PermissionLog } from './permission';

/** 一个会话（绑定某个 Agent，含消息流与权限决策记录） */
export interface Session {
  id: string;
  /** 绑定的 Agent id（专家团模式下为**团长**：其工具策略界定整团上限，成员由引擎按 mode 派发） */
  agentId: string;
  /** 绑定的专家团 id；召唤专家团时设置（与 agentId 绑定对称），null 表示显式解除团绑定 */
  groupId?: string | null;
  /** 本会话临时挂载的技能 id 列表 */
  skillIds?: string[];
  /** 会话级工作空间（工作目录）；未设置时归入「默认工作空间」分组 */
  workdir?: string;
  /**
   * **事件流落盘分片**：该会话的 `.jsonl` / `.meta.json` 所在目录对应的路径
   * （`projects/<cwdSlug(streamWorkdir)>/`）。
   *
   * 它与 `workdir` 在绝大多数情况下相同，只在一种情况下分叉：会话**已经有消息**
   * 又被切换了工作空间。此时工作空间（语义、注入给引擎的 cwd、侧边栏归属、记忆
   * 目录）跟着变，但**磁盘上的记录不搬家**——`workdir` 改成新路径、
   * `streamWorkdir` 冻在它当时所在的目录。
   *
   * 为什么不搬：
   * - 搬迁是「读旧 → 删旧 → 写新」，中间进程挂掉就是整段对话消失；而这个动作
   *   的触发非常轻量（点一下输入框里的工作空间），代价与触发完全不成比例；
   * - 记录属于「这个会话从哪来」，切换工作空间是「以后去哪儿」，后者不该改写前者。
   *
   * 只在「确知一条消息都没有」时才允许随工作空间归位（见 `setSessionWorkdir`），
   * 所以分片一旦非空就等价于「冻结」，此后不再变化。
   *
   * `undefined` 表示「仍跟随 `workdir`」——新建会话、以及从未发过消息的会话都是
   * 这个状态；水合时由 `SessionMeta.workdir` 补上。
   */
  streamWorkdir?: string;
  /**
   * 会话级权限策略：true = 允许完全访问（工具可在工作空间外执行）。
   * 默认 false（默认权限：操作在安全沙箱约束内进行）。
   */
  fullAccess?: boolean;
  /**
   * 会话级逐条批准（FR-1.5）：true = 副作用工具（写文件 / 执行命令 /
   * MCP 调用等）执行**前**必须由用户逐条授权，引擎会挂起等待裁决。
   *
   * 与 `fullAccess` 是正交两轴——前者管「能碰哪里」，本字段管「要不要先问」。
   * 但 `fullAccess` 是更粗的开关：开启后不再逐条询问（见 sessionsStore
   * 中 approvalMode 的推导）。
   */
  toolApproval?: boolean;
  /**
   * 会话级执行模式（FR-1.4）：`ask` / `plan` 只读，`craft` 可直接改动文件。
   *
   * **缺省即 `craft`**——这是刻意的向后兼容：事件化之前的会话按 craft 记账，
   * 读取时用 `?? 'craft'` 而不是把缺失当成某种「未知模式」。
   *
   * 注意它**决定的是能不能写**，不是「回答得详不详细」：ask / plan 下写类工具
   * 被引擎的工具网关 deny（客户端拦不住，也不能靠提示词约束）。
   */
  mode?: ExecutionMode;
  /** 会话级模型覆盖；未设置时回退全局默认模型 */
  model?: string;
  /** 会话来源 IM 频道（如 dingtalk / feishu）；缺省为本地会话 */
  channel?: string;
  /** 只读会话（如定时任务执行留痕）：聊天页隐藏输入框，不参与持久化 */
  readonly?: boolean;
  /** 是否置顶：分组内始终排在最前，便于快速访问高频任务（持久化） */
  pinned?: boolean;
  /**
   * **会话版本引用集**（FR-3.9 ①）：`{ 插件名: 版本 }`，建会话时生效的那一份。
   *
   * 它是**声明**不是缓存——跨设备同步（在 `SESSION_SYNC_FIELDS` 白名单里），
   * 用来回答两件本机磁盘答不了的事：① 换台机器 GC 时，别把「别的设备上的会话
   * 正在用的那一版」当旧副本删掉；② 本机装的版本与这个会话当初用的不同时，
   * 界面能如实说出来（见 `lib/sessionPluginRefs.ts`）。
   *
   * 只在建会话时快照一次，之后不随本机装了什么而漂移：它记的是历史事实。
   */
  pluginVersions?: Record<string, string>;
  /** 会话标题（首条消息摘要） */
  title: string;
  messages: Message[];
  /**
   * 该会话的**对话记录条数**（用户 / 助手消息事件数），来自索引投影
   * （`SessionIndexEntry.messageCount`）。
   *
   * 它存在的唯一理由是：**「有没有对话记录」必须能在水合之前回答**。启动时列表
   * 只读索引，会话消息要等点进去才从 JSONL 重建（见 `sessionsStore.loadSessions`），
   * 所以未点开的会话 `messages` 是留白的——只看 `messages.length` 会把它们全判成
   * 空会话，于是侧边栏「只剩下当前打开的那一条」、其余工作空间看起来一个任务都没有。
   *
   * `undefined` = **未知**（不是从索引来的会话：`openExternal` 注入的外部会话、
   * 新建但没落过盘的会话），此时退回 `messages.length`。判定一律走
   * `@/lib/conversation` 的 `hasConversation` / `conversationCount`，别在各处自己拼。
   */
  messageCount?: number;
  /** 敏感操作权限决策记录（FR-009） */
  permissionLog: PermissionLog[];
  /**
   * 本会话创建时读取到的记忆原文快照（未包裹标签）。
   * send 时复用该快照注入 system 段，避免每次请求重复 IO。
   * 永不写回 agent.systemPrompt。
   *
   * 它是**纯缓存**：内容随时可从 `MEMORY.md` 重读，所以必须记录下面两个
   * 「产出依据」，否则会话存活期间的任何写入都进不来（见 `memoryVersion`）。
   */
  memory?: string;
  /**
   * 生成上面那份快照时的记忆写入版本（`MemoryService.writeVersion()`）。
   * 与当前版本不等 = 期间有写入（模型 `<memory-save>` / 自动沉淀 / 记忆页编辑），
   * 下一轮发送前会重读。undefined = 从未产出过快照，由 createSession /
   * loadSession 的异步预热负责；预热在途时一律**不判过期**（避免误刷）。
   * 补刷发生在 `streamAssistantReply` 步骤 0.1——流式槽位同步占位之后，
   * 这样「send 同步进入流式态」与「注入最新记忆」两个目标同时成立。
   */
  memoryVersion?: number;
  /**
   * 生成快照时使用的**工作目录**（原样保存当时的 `workdir`）。
   * 用户改了会话的工作目录后，同一份快照指向的就是另一个记忆目录了，必须一并失效。
   *
   * 存的是路径本身而不是它的哈希：工作区记忆的落点已经由目录表达隔离
   * （`<workdir>/.nanowork/memory/`），判据里再算一次哈希只会多一层可能不同步的推导。
   */
  memoryWorkspace?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 同步元数据的版本号与修改者（第 19 章）。
   *
   * 会话是**内联形态**：不像那五个 store 的实体那样把墓碑拆成独立表，而是直接
   * 挂在对象上。原因是会话的删除至今是「三件套全删」（JSONL + meta + 索引条目），
   * 没有可留墓碑的载体；`deletedAt` 因此只在读取侧容错（见 `normalizeSessionMeta`），
   * 写入侧不做（`docs/architecture-syncmeta.md` §7.3 记了原因）。
   *
   * 递增由 `updateSession` 自动完成（见 `lib/sessionSyncMeta.ts`），
   * **不要在调用点手写 `rev`**。
   */
  rev?: number;
  updatedBy?: string;
}
