/**
 * 工作区文件记忆（MEMORY.md）类型契约。
 * 对应设计文档 docs/architecture-memory.md §3.1。
 * 注意：这里只描述数据形状，跨端读写一律由 src/lib/memory.ts 的 MemoryService 封装。
 */

/** 单条记忆块的轻量元信息（仅用于计数/展示，不强制持久化） */
export interface MemoryMeta {
  /** 估算条数（按二级标题或空行切分） */
  entries: number;
  /** 字符长度 */
  chars: number;
  /** 最后写入 ISO 时间（从文件内容最后时间戳推断，无则 null） */
  lastWrittenAt: string | null;
}

/** 记忆注入运行时状态（存于 sessionsStore，不持久化） */
export interface MemoryState {
  /** 当前会话是否注入了记忆 */
  injected: boolean;
  /** 注入的记忆条数 */
  count: number;
  /**
   * 因**上下文预算**被裁掉的条数（0 表示全装下）。
   *
   * 记忆 v2 给注入加了硬预算（设计 §4.6）：超出按确定优先级裁剪。裁剪本身是对的，
   * 但静默裁剪会让用户以为「它记住了」而模型其实没看到那一条——所以这个数字
   * 要出现在 `MemoryBar` 上，并指向记忆页让用户自己取舍。
   */
  truncated?: number;
  /** 用户是否临时关闭了提示条 */
  dismissed: boolean;
}

/**
 * 记忆作用域（design §14.1 四层里的 L2 / L3）。
 *
 * - `user`：用户级长期记忆，落 `~/.nanowork/MEMORY.md`（跨项目生效，L2）。
 *   写入方有三处：用户在记忆页亲手编辑、自动沉淀识别出的**身份类**事实
 *   （称呼/职业/稳定偏好），以及 Agent 在用户明确要求下写的
 *   `<memory-save scope="user">`。
 * - `workspace`：工作区长期记忆，落 `<工作目录>/.nanowork/memory/`（L3）——
 *   一个目录，里面是 `MEMORY.md`（精炼记忆）+ 若干 `YYYY-MM-DD.md`（每日日志），
 *   读取时合并注入。没有绑定工作目录的会话落 `~/.nanowork/memory/default/`。
 *   按会话的工作目录隔离。
 */
export type MemoryScope = 'user' | 'workspace';

/**
 * Agent 在回答里声明的「这一条请记住」（`<memory-save>` 块，P2-A）。
 *
 * 它只是**意图**：真正的落盘（时间戳、来源、幂等去重标记）由
 * `MemoryService.append` 统一负责。见 `src/lib/memoryDirective.ts`。
 */
export interface MemoryDirective {
  /** 落到哪一层；省略时按 `workspace` */
  scope: MemoryScope;
  /** 待写入的正文（已 trim，非空） */
  content: string;
}

/** 某个作用域的记忆概览（记忆页的作用域切换用） */
export interface MemoryScopeSummary {
  scope: MemoryScope;
  label: string;
  description: string;
  chars: number;
  entries: number;
  lastWrittenAt: string | null;
}

/** 记忆写入选项 */
export interface MemoryAppendOptions {
  /** 引用源（如会话标题/消息片段），用于生成引用块 */
  source?: string;
  /** 显式时间戳，默认 now */
  at?: string;
}

/* ==========================================================================
 * 记忆 v2（结构化事实 · 蒸馏 · 冲突裁决）
 *
 * 需求：docs/prd-memory-v2.md（FR-M1 … FR-M17）；设计：docs/architecture-memory-v2.md §4.1–§4.5。
 *
 * 与上面 v1 类型的关系：v1 的记忆原子单位是 **Markdown 段落**（`MemoryMeta` /
 * `MemoryAppendOptions`），v2 的是**结构化事实**（`MemoryFact`）。两者并存：v1 的
 * `MEMORY.md` 与日期 `.md` 继续可读、继续进 prompt（设计 §4.6），只是不再自动晋升。
 * ========================================================================== */

/**
 * 事实的类型（对齐 s10 的四类）。
 *
 * `outcome`（「本次测试通过」这类当轮结果）**永不自动晋升**——它只在近期日志里有意义，
 * 把它写进长期记忆等于给每个会话埋一条噪声。这条是显式策略的一部分，不是提示。
 */
export type FactKind = 'decision' | 'convention' | 'pitfall' | 'outcome';

/** 谁提供了这条事实 */
export type FactSource = 'agent' | 'user' | 'auto' | 'remote';

/**
 * 这条事实从哪条链路进来（诊断用，不参与策略）。
 *
 * - `manual`：用户点「保存为记忆」或在记忆页手工新增；
 * - `memory-save`：模型用 `<memory-save>` 协议声明；
 * - `sediment`：会话结束的自动沉淀；
 * - `legacy`：v1 的 Markdown 段落投影而来（**不参与自动晋升**）；
 * - `import`：bundle 导入（FR-M35）；
 * - `dream`：引擎 Dream 产物采样（FR-M37，只作候选证据）。
 */
export type FactOrigin =
  | 'manual'
  | 'memory-save'
  | 'sediment'
  | 'legacy'
  | 'import'
  | 'dream';

/**
 * 记忆的**原子单位**：一条结构化事实（对应 s10 的 `MemoryFact`）。
 *
 * 为什么不是「一段自由文本」：自由文本无法判定「值不值得长期记」（没有 kind /
 * importance），也无法判定「这两条说的是不是同一件事」（没有 `memoryKey`）。
 * 记忆 v1 的重复与冲突问题全部源于此（见 `docs/prd-memory-v2.md` §1.3）。
 */
export interface MemoryFact {
  /** 稳定 id：`f_<hash8>`，由 workspaceId + kind + memoryKey + 归一化正文 + observedAt 推出 */
  factId: string;
  /** 归属（工作区标识）；读取时不匹配即拒绝——避免跨工作区污染 */
  workspaceId: string;
  kind: FactKind;
  /** 归一化后非空，≤ `FACT_CONTENT_MAX_CHARS` */
  content: string;
  /** 1–5；缺省按 kind 推定（decision/convention/pitfall → 4，outcome → 2） */
  importance: number;
  /**
   * 冲突域：描述「这条记忆回答哪个问题」，**不是答案本身**。
   * 例：`runtime.python-version`（值可以是 3.11 或 3.12）。
   */
  memoryKey?: string;
  source: FactSource;
  origin: FactOrigin;
  /** 自由文本证据（文件 / 会话 / 工具名），≤ `FACT_EVIDENCE_MAX_CHARS` */
  evidence?: string;
  /** Harness provenance：事件流 event id。**不接受模型提交**（FR-M23） */
  sourceEventId?: string;
  /** ISO（含时区，统一存 UTC）；**不得晚于** `now` 超过容差 */
  observedAt: string;
  /** 记录级 schema 版本 */
  schema: 2;
}

/** 冲突域的**内部键**（含 `:`，因此不受 `memory_key` 正则约束，只用于分组） */
export type EntryKey =
  | `k:${string}` // 显式 memory_key
  | `d:${string}` // 派生键（无显式 key：kind + 归一化内容）
  | `l:${string}` // v1 Markdown 段落（legacy）
  | `x:${string}`; // **域级墓碑**：该域被用户删除（见 CuratedEntry 的域终态说明）

/** 修订的状态 */
export type CuratedStatus = 'active' | 'superseded' | 'disabled';

/**
 * 一条**策展修订**：通过蒸馏门槛、进入 `curated.json` 的结论。
 *
 * ## 域终态（为什么「零 active」是合法状态）
 *
 * 用户停用（FR-M34）或删除（FR-M31）某个域的唯一 active 修订后，该域**没有** active。
 * 若把这种状态判成「损坏」（`CorruptCuratedStateError`），用户点一次「停用」就会让
 * 记忆页与注入整体不可用——治理动作把系统打死。故不变量是「**至多**一个 active」，
 * 且域终态**不会被后续蒸馏自动复活**（否则用户删掉的东西会被下一次蒸馏写回来）。
 */
export interface CuratedEntry {
  /** 冲突域稳定键（形态见 `EntryKey`） */
  entryKey: EntryKey;
  /** 显式 key（`k:` 域）或派生键字符串（仅用于展示与诊断） */
  memoryKey: string;
  kind: FactKind;
  /** 从 1 起、连续递增 */
  revision: number;
  status: CuratedStatus;
  content: string;
  importance: number;
  /** 不可变来源集合（**排序后存储**，保证跨设备逐字节可比） */
  evidenceIds: string[];
  /** 独立事实数（= `evidenceIds` 去重后长度；排序用，冗余存） */
  evidenceCount: number;
  /** 最早证据时间（`min(observedAt)`，不是 now） */
  firstSeen: string;
  /** 最近证据时间（`max(observedAt)`，不是 now）——替代比较的基准 */
  lastSeen: string;
  /** 指向被本版替代的旧 revision */
  supersedes?: number;
  /** 指向替代本版的新 revision */
  supersededBy?: number;
  /** 停用理由（FR-M34） */
  disabledReason?: string;
  /** 域级墓碑的删除时刻（仅 `x:` 域记录） */
  deletedAt?: string;
}

/** 策展状态（canonical，落 `curated.json`） */
export interface CuratedState {
  schema: 2;
  workspaceId: string;
  /** 全部修订（含历史与被替代的），active 由 `status` 判定 */
  revisions: CuratedEntry[];
  /** 由 `distillFacts` 的 `now` 推出，**不读系统时钟** */
  renderedAt: string;
}

/**
 * 记忆 v2 的**可配置策略**（`Settings.memoryPolicy`）。
 *
 * 与 `DistillPolicy` / `InjectionBudget` / `ArchivePolicy` 的关系：本类型是**持久化的用户
 * 偏好**，那三个是**函数参数**。运行时由 `resolveMemoryPolicy(settings)` 把偏好翻成参数，
 * 于是纯函数保持「显式传参、无全局状态」——它们仍然可离线测（NFR-M1）。
 *
 * 为什么不直接把 `Settings` 塞进纯函数：那会让每个用例都要构造一份完整 settings，
 * 而纯函数关心的是三五个数字。
 */
export interface MemoryPolicySettings {
  /** 蒸馏晋升的年龄门槛（天） */
  retentionDays: number;
  /** 不必重复出现即可晋升的最低重要度 */
  minImportance: number;
  /** 重复出现多少次可晋升 */
  repeatThreshold: number;
  /** 挑战者要替代 incumbent 需要多少条独立证据 */
  supersessionRepeatThreshold: number;
  /** 日志文件归档阈值（天）——与 `retentionDays` **不是**同一件事（见 `memoryArchive.ts`） */
  archiveAfterDays: number;
  /** 用户级注入预算（字符） */
  userChars: number;
  /** 工作区级注入预算（字符） */
  workspaceChars: number;
  /** 注入里「最近事实」的条数上限 */
  recentFactLimit: number;
}

/** 这些字段必须在合法区间内（设置页的滑块会被手工改成任何值） */
export const MEMORY_POLICY_LIMITS = {
  retentionDays: { min: 1, max: 3650 },
  minImportance: { min: 1, max: 9 },
  repeatThreshold: { min: 1, max: 20 },
  supersessionRepeatThreshold: { min: 1, max: 20 },
  archiveAfterDays: { min: 7, max: 3650 },
  userChars: { min: 200, max: 100_000 },
  workspaceChars: { min: 200, max: 100_000 },
  recentFactLimit: { min: 0, max: 100 },
} as const satisfies Record<keyof MemoryPolicySettings, { min: number; max: number }>;

/** 记忆 v2 策略的出厂默认值（与 `docs/settings-inventory.md` 逐项一致） */
export const DEFAULT_MEMORY_POLICY: MemoryPolicySettings = {
  retentionDays: 30,
  minImportance: 4,
  repeatThreshold: 2,
  supersessionRepeatThreshold: 2,
  archiveAfterDays: 180,
  userChars: 4000,
  workspaceChars: 3000,
  recentFactLimit: 6,
};

/**
 * 把任意来源的取值收敛到合法策略。
 *
 * 逐字段做「类型 + 区间」双检查：持久化文件可能被手工编辑过、云端同步可能推来
 * 字符串，而 `retentionDays: "30"` 参与日期运算会算成 NaN 并让**门槛静默失效**
 * （不报错、不告警，只是「怎么都不晋升」）——那是最难查的一类故障。
 */
export function normalizeMemoryPolicy(value: unknown): MemoryPolicySettings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof MemoryPolicySettings, unknown>
  >;
  const out = { ...DEFAULT_MEMORY_POLICY };
  for (const key of Object.keys(DEFAULT_MEMORY_POLICY) as Array<keyof MemoryPolicySettings>) {
    const candidate = raw[key];
    const limits = MEMORY_POLICY_LIMITS[key];
    const num = typeof candidate === 'number' ? candidate : Number(candidate);
    if (!Number.isFinite(num)) continue;
    const rounded = Math.round(num);
    if (rounded < limits.min || rounded > limits.max) continue;
    out[key] = rounded;
  }
  return out;
}

/**
 * 蒸馏策略（对应 s10 的 `DistillPolicy`；默认值见 `DEFAULT_DISTILL_POLICY`）
 */
export interface DistillPolicy {
  /** 事实必须至少这么老才有资格晋升（天） */
  retentionDays: number;
  /** 或：重要度达到这个值即可晋升（不必重复出现） */
  minImportance: number;
  /** 或：同一归一化内容出现这么多次即可晋升 */
  repeatThreshold: number;
  /** 替代既有 active 值时，需要的**独立事实**确认数 */
  supersessionRepeatThreshold: number;
  /** 可自动晋升的 kind（`outcome` 刻意不在内） */
  promotableKinds: FactKind[];
}

/** 蒸馏结果报告：让「拒绝晋升的原因」可观察，而不是只看到一个数字 */
export interface DistillReport {
  /** 新晋为修订的条数 */
  promoted: number;
  /** 只合并了 evidence、未产生新修订的条数 */
  merged: number;
  /** 产生替代（旧版变 superseded）的次数 */
  superseded: number;
  /** 本次发现的同分冲突数 */
  conflicts: number;
  /** 实际新建 / 推进的冲突案件数 */
  queuedConflicts: number;
  /** 新建的案件 id */
  conflictCaseIds: string[];
  /** 因「时间不够新」被拒绝替代的候选数 */
  stale: number;
  /** 未过门槛、被跳过的组数 */
  skipped: number;
}

/** 冲突候选（incumbent 或 challenger） */
export interface ConflictCandidate {
  /** `c_<hash8>`：由 entryKey + revision + 归一化内容推出 */
  candidateId: string;
  entryKey: EntryKey;
  content: string;
  /** 若胜出将写入的 revision */
  revision: number;
  evidenceIds: string[];
  importance: number;
  lastSeen: string;
}

/** 冲突案件的生命周期 */
export type ConflictStatus = 'open' | 'resolved' | 'superseded';

/**
 * 一个**可恢复的观察快照**：不是一句「发生冲突」的提示，而是当时看到了什么。
 *
 * 有了 `revision` / `observedFactIds` / `evidenceFingerprint`，「陈旧页面点提交」
 * 才拦得住——三条都是裁决前必须重新核对的。
 */
export interface ConflictCase {
  /** 确定性：`hash(scope + memoryKey + evidenceFingerprint)`，同证据必得同 id */
  conflictId: string;
  /** 同一 memoryKey 的案件版本 */
  revision: number;
  status: ConflictStatus;
  /** 归属（工作区标识或用户作用域） */
  scopeId: string;
  memoryKey: string;
  entryKey: EntryKey;
  candidates: ConflictCandidate[];
  /** 检测时该域的全部事实 id */
  observedFactIds: string[];
  /** 检测时的 active 修订键；域内没有 active 时为 null */
  activeEntryKey: EntryKey | null;
  /**
   * 检测时 active 的 `revision`。
   *
   * 为什么需要它（只比 `activeEntryKey` 不够）：键是「哪个问题」，而同一个问题的
   * 答案**可以自己演进**（该域在用户裁决之前又发生了一次正常替代）。此时键没变、
   * revision 变了，旧案件里的候选已经对不上现状——只比键会漏掉这种陈旧。
   */
  activeRevision: number | null;
  /** `hash(排序后的 observedFactIds)` */
  evidenceFingerprint: string;
  detectedAt: string;
  resolvedAt?: string;
  resolution?: {
    candidateId: string;
    actor: string;
    eventId: string;
    rationale: string;
    /** 结果：challenger 胜出时是新 entryKey，incumbent 保持时是原 entryKey，null 表示域被清空 */
    resultEntryKey: EntryKey | null;
  };
}

/** 冲突案件快照（落 `conflicts.json`） */
export interface ConflictState {
  schema: 2;
  workspaceId: string;
  cases: ConflictCase[];
  renderedAt: string;
}

/** 裁决输入 */
export interface ResolveConflictInput {
  conflictId: string;
  candidateId: string;
  /** 调用方**刚看到**的案件版本；与服务端不一致时抛 `StaleConflictResolutionError` */
  expectedRevision: number;
  /** 人（界面账号 / `local-user`） */
  actor: string;
  /** 非空 */
  rationale: string;
  /** 幂等键：由 harness/UI 生成；同参重试返回原事件，换参抛 `ConflictEventReuseError` */
  eventId: string;
}

/** `resolveConflict` 的结果 */
export interface ResolveConflictResult {
  /** 本次是否真的产生了变更（同参重试时为 false） */
  applied: boolean;
  /** 结果 active 修订键 */
  resultEntryKey: EntryKey | null;
  /** 新的案件状态 */
  nextConflicts: ConflictState;
  /** 新的策展状态 */
  nextCurated: CuratedState;
  /** 审计事件（调用方负责持久化） */
  adjudication: AdjudicationEvent;
}

/** 一次人工裁决的审计事件（append 到 `conflict-adjudications.jsonl`） */
export interface AdjudicationEvent {
  eventId: string;
  conflictId: string;
  /** 裁决时案件处于的 revision（陈旧保护的一部分） */
  caseRevision: number;
  candidateId: string;
  actor: string;
  rationale: string;
  /** 选中候选的证据 id */
  evidenceIds: string[];
  /** 检测时的 active 修订键 */
  previousEntryKey: EntryKey | null;
  /** 结果 active 修订键；incumbent 保持时为原键（**不产生新修订**） */
  resultEntryKey: EntryKey | null;
  /** 是否选择了 challenger（= 是否产生了新修订） */
  choseChallenger: boolean;
  at: string;
}

/**
 * 事务阶段（设计 §4.5）。
 *
 * 顺序是硬约束，**每阶段先完成目标写入、再追加阶段事件**——反过来就是「事件说做了、
 * 实际没做」，恢复时无法判定。
 */
export type TxnPhase =
  | 'prepared'
  | 'curated_applied'
  | 'conflict_closed'
  | 'audit_appended'
  | 'committed';

/** 一次裁决的完整意图（含 before/after 全量快照，故可重放） */
export interface ResolutionIntent {
  transactionId: string;
  /** 对规范化后的 intent 体算哈希，防篡改 */
  intentSha256: string;
  workspaceId: string;
  conflictId: string;
  candidateId: string;
  eventId: string;
  actor: string;
  rationale: string;
  before: { curated: CuratedState; conflicts: ConflictState };
  after: { curated: CuratedState; conflicts: ConflictState };
  preparedAt: string;
}

/** 事务阶段事件（append 到 `conflict-resolution-transactions.jsonl`） */
export interface TxnPhaseEvent {
  kind: 'intent' | 'phase';
  transactionId: string;
  intentSha256: string;
  /** `kind: 'intent'` 时承载完整 intent；`kind: 'phase'` 时为 undefined */
  intent?: ResolutionIntent;
  phase?: TxnPhase;
  at: string;
}

/* ==========================================================================
 * 记忆 v2：用户级两契约（Profile 与 Preference）
 *
 * 需求：`docs/prd-memory-v2.md` FR-M20 – FR-M24；设计：`docs/architecture-memory-v2.md` §4.7。
 *
 * 为什么分成两个契约而不是一份任意 Markdown：
 * - Profile 回答「这个用户是谁」，需要**字段级 patch**（改时区不该动职业）；
 * - Preference 回答「跨项目默认怎样」，需要**按键替换 + 有效期 + 来源**。
 * 把两者混成一段自由文本，就同时失去字段级更新与键级去重。
 * ========================================================================== */

/**
 * Profile 的字段白名单。
 *
 * **schema 外字段直接报错**，不是静默丢弃：模型的每一轮都可能发明新字段
 * （`nickname` / `preferred_name` / `gender`…），静默收下会让 profile 变成垃圾桶，
 * 而报错能让「模型在编字段」这件事在开发期就暴露。
 */
export const PROFILE_FIELDS = [
  'name', // 姓名
  'callThem', // 希望被怎么称呼
  'timezone', // 时区
  'language', // 默认回复语言
  'occupation', // 职业
  'organization', // 所在组织
  'role', // 角色 / 岗位
  'city', // 常驻城市
  'responseStyle', // 表达偏好（简洁 / 详细…）
] as const;

/** Profile 字段名 */
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** 用户画像：**只含白名单字段**，值为归一化后的字符串 */
export type UserProfile = Partial<Record<ProfileField, string>>;

/** Profile 的 canonical 状态（落 `profile.json`） */
export interface ProfileState {
  schema: 2;
  /** 用户作用域；读取时不匹配即拒绝（防止错误复制） */
  userScope: string;
  profile: UserProfile;
  updatedAt: string;
}

/** 字段值长度上限（对标设计 §4.7 的 1000 字符约束） */
export const PROFILE_VALUE_MAX_CHARS = 1000;

/** Profile patch 的结果 */
export interface ProfileUpdateResult {
  /** 真正发生变化的字段（含被删除的） */
  changed: ProfileField[];
  /** 值相同、未改动的字段 */
  unchanged: ProfileField[];
}

/** 偏好的来源（Harness 可信信息，不是模型自由文本） */
export type PreferenceSource = 'user' | 'agent' | 'transcript' | 'remote';

/** 一条偏好记录 */
export interface PreferenceRecord {
  /** 语义键：描述「这条偏好回答哪个问题」，不是答案本身 */
  key: string;
  value: string;
  /** 从 1 起，可观察更新才递增 */
  revision: number;
  source: PreferenceSource;
  /** Harness provenance（事件流 event id）。**模型不能提交或伪造**（FR-M23） */
  sourceEventId?: string;
  updatedAt: string;
  /** 到期即「不再注入」，但记录保留在 canonical（可解释它曾经为何生效） */
  expiresAt?: string;
}

/** 偏好集合（落 `preferences.json`） */
export interface PreferenceState {
  schema: 2;
  userScope: string;
  /** 全部记录（含已过期） */
  records: PreferenceRecord[];
  updatedAt: string;
}

/** 一次 `setPreference` 的可观察结果 */
export type PreferenceChange = 'CREATED' | 'UNCHANGED' | 'UPDATED';

/** 偏好键 / 值的长度上限 */
export const PREFERENCE_KEY_MAX_CHARS = 64;
export const PREFERENCE_VALUE_MAX_CHARS = 1000;

/** 偏好键的形态（与 `memory_key` 同一套规则） */
export const PREFERENCE_KEY_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;


