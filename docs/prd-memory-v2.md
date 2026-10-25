# 增量 PRD：记忆体系 v2（对标 WorkBuddy 记忆机制）

> **文档版本**：v2 首版（2026-10-02）
> **状态**：增量（待实施）。本文与 `docs/architecture-memory-v2.md`（设计）、`docs/plan-memory-v2.md`（开发计划）
> 三件套配套；本文是**需求依据**，实现细节以设计文档为准，冲突时以代码为准。
> **替代关系**：本文**不废止** `docs/prd-memory.md` / `docs/architecture-memory.md`——它们描述
> 的是 v1（`MEMORY.md` 单层追加 + 分节自动沉淀），其中的**已落地机制全部保留**（见 §8）。
> 本文在其之上补齐「结构化事实 → 蒸馏 → 冲突裁决 → 用户画像 → 召回 → 治理」六件 WorkBuddy 有、
> 本项目缺的能力。
>
> **对标资料**：
> - WorkBuddy 记忆管理全景指南（博客园 `xiaobaiysf/p/21866387`）
> - `learn-workbuddy` 教学实现 `s10_workspace_memory` / `s11_user_memory` / `s12_cloud_memory`
> - 本地综合笔记 `docs/memory-workbuddy.md`

---

## 0. TL;DR（先读这一节）

**诊断**：本项目的记忆 v1 已经把 WorkBuddy 的**形态**做到了位——工作区记忆落在
`<工作目录>/.nanowork/memory/`（与 `.workbuddy/memory/` 同构）、每日日志 append-only、
两层合并注入、会话结束自动沉淀分节、受控写入协议、注入快照失效机制。
**缺的是 WorkBuddy 的工程内核**：记忆的原子单位不是「事实」而是「Markdown 段落」。

**三条根因**（§1.3）：

1. 没有「事实」这个一等公民 → 无法判定「值不值得长期记」、无法判定「哪两条说的是同一件事」、冲突时无从 fail-closed。
2. 没有区分「证据」与「结论」 → 日志与 `MEMORY.md` 被当成同等权威的正文拼起来注入，于是没有蒸馏、没有重算、没有原子重建。
3. 没有「召回」这个独立阶段 → 模型是「把记住的全部塞进 system 段」，上下文预算没有刹车。

**目标状态**：`结构化事实（daily/*.jsonl，append-only） → 显式策略蒸馏（curated.json，纯函数、不调模型）
→ 冲突域与替代门槛（同分 fail-closed、进人工队列） → 有界注入（只注入 active 修订 + 最近 N 条）
→ 跨会话召回（normalize → candidate → score → stableRank → render，只读） → 治理闭环（事实视图 / 待裁决 / 停用 / 保留）`。

**规模**：`FR-M1`–`FR-M37`（含 `FR-M13a` / `FR-M25a` / `FR-M31a`）+ `NFR-M1`–`NFR-M12`，五个 Phase（见 §7）。
**定稿前经过一轮代码级对抗核验**（对照 11 个源文件与 CI 配置）：发现并修正 **5 个阻塞级缺陷**、
十余处会返工的缺口，全部已回写本文与设计文档（记录见 `docs/architecture-memory-v2.md` §13）。
其中最严重的一条是**数据安全**问题：v1 用户级单文件已经在跨端同步边界内，原迁移方案会在
其他设备上**删除用户记忆**——现已改为「原文件原地保留为只读源」（见 FR-M4 与 NFR-M11）。
**不破坏**：v1 的落点、注入标签、去重标记、两个开关、`<memory-save>` 协议、9 个测试文件全部继续有效（见 §8）。

---

## 1. WorkBuddy 记忆机制拆解与差距分析

### 1.1 完整机制是什么

把官方文档口径、社区拆解与教学实现三层合起来看，WorkBuddy 的记忆**不是一个文件，而是六件互相咬合的机制**：

| # | 机制 | 载体 | 关键设计 |
|---|---|---|---|
| M1 | **三层作用域隔离** | 云端画像 / `~/.workbuddy/MEMORY.md` / `<workspace>/.workbuddy/memory/` | 按 owner（服务端 / 用户 / 工作区）分权，写入方与保留策略不同；A 项目规则不污染 B 项目 |
| M2 | **每日日志 append-only** | `memory/YYYY-MM-DD.md` | 只追加、不修改；记录当天完成的**实质性工作**，不记临时信息（搜索结果、临时路径、工具错误） |
| M3 | **精炼记忆（curated）** | `memory/MEMORY.md` | 从日志**蒸馏**出的稳定结论（项目约定、技术选型、架构决策、踩坑记录）；单会话写入上限 3000 字符；超 30 天日志需提炼后清理 |
| M4 | **用户画像与偏好** | 云端 profile + 用户级 `MEMORY.md` | 云端画像**只读**（本地仅缓存，不可手改）；用户级可读写，单会话上限 4000 字符；会话启动注入 |
| M5 | **历史对话检索** | Conversation Search | 跨**全部历史会话**语义检索；指令必须自包含（时间、任务、关键词），不能靠当前上下文推断检索目标 |
| M6 | **治理闭环** | 查看 / 编辑 / 删除 / 关闭 + 定期清理 | 记忆可查可删可关；过期记忆定期清；「云端画像不要手改，走设置页或自然语言指令维护」 |

教学实现（s10/s11/s12）把 M2/M3 的**工程内核**讲透了，这是官方文档没有的部分，也是「一样」这个词的真正所指：

| 机制 | 教学实现的做法 | 为什么必须这样 |
|---|---|---|
| 结构化事实 | `MemoryFact` 有 `kind`（decision/convention/pitfall/outcome）、`importance`、`memory_key`、`evidence`，**不是一段自由文本** | 自由文本无法判定「值不值得记」「和哪条冲突」 |
| 显式蒸馏策略 | `(年龄 ≥ 30 天 OR origin='manual') AND kind ∈ {decision,convention,pitfall} AND (importance ≥ 4 OR 归一化重复 ≥ 2)` | **不让 LLM 决定什么值得永远记住**；模型可以被注入、会被猜测污染，promotion 必须由 harness 掌握。**手编豁免年龄门槛**（2026-10-03 定稿，见 FR-M5）：用户显式写下的一句不该等 30 天，否则「保存 → 内容当场从投影里消失」 |
| 冲突域（`memory_key`） | key 描述「这条记忆回答哪个问题」（`runtime.python-version`），**不是答案本身** | 用答案当 key，值一变就成了另一个域，替代关系丢失，新旧版本并存 |
| 替代门槛 | 新值必须**同时**：通过晋升门槛 + 至少 2 条独立事实确认 + 时间晚于 active 的 `last_seen` | 单条高重要度事实不足以推翻既有决策；过期证据不能回滚当前值 |
| fail-closed 冲突 | 最优分数平局时**保留当前修订**并创建 `MemoryConflictCase` | 拿不准时不动现状，比猜错安全 |
| 人工裁决 | `resolve_conflict(case_id, candidate_id, expected_revision, actor, rationale, event_id)` | 只有人能选；模型工具列表**不含**该 API |
| 证据留存 | 蒸馏是建立**派生视图**，不删日志。`evidence_ids` 指回原始事实 | 删日志 = 长期结论失去来源、错误蒸馏无法重算 |
| 原子写 + 事务 | `curated.json` 用 temp + `os.replace`；跨文件裁决先写 append-only transaction journal（prepared → curated_applied → conflict_closed → audit_appended → committed），重启幂等前滚 | 三个文件各自原子 ≠ 三者一致；崩在中间会让「记忆」与「待审队列」互相矛盾 |
| canonical vs projection | JSON 是机器真相，`MEMORY.md` 是可重建投影 | Markdown 同时当数据库、当编辑协议、当 prompt 会必然漂移 |
| 有界注入 | 只注入精简 `MEMORY.md` + 最近 ≤6 条 facts；**不注入**全部日志、冲突候选、session transcript | 记忆的价值在召回时有预算和优先级，不在存得多 |
| 召回契约（s12） | `normalize → candidate → score → stable rank → render`；每个 hit 带 `scope` / `provenance` / `score_breakdown`；召回**只读** | 检索命中 ≠ 事实正确 ≠ 必须进 prompt；换一个 query 结果就该不同 |
| 用户级两契约（s11） | Profile 走**字段级 patch**；Preference 走 **key + value + expiry + source_event_id** | 「用户是谁」需要字段更新，「跨项目默认怎样」需要键级替换；两者不能混成任意 Markdown |

### 1.2 本项目现状

现状由代码实测得出，**不是文档转述**。涉及文件：`src/lib/memory/memory.ts`（1049 行）、
`src/lib/memory/workspaceMemory.ts`、`src/lib/memory/memoryMerge.ts`、`src/lib/memory/memoryDirective.ts`、
`src/types/memory.ts`、`electron/memoryRoutes.ts`、`electron/workspaceMemoryStore.ts`、
`src/pages/memory/MemoryPage.tsx`、`src/stores/sessionsStore.ts`。

**已经做对的（v1 的成果，必须保留）**：

| 能力 | 落点 |
|---|---|
| 工作区记忆目录化 | `<工作目录>/.nanowork/memory/` = `MEMORY.md` + `YYYY-MM-DD.md`（与 WorkBuddy `.workbuddy/memory/` **同构**，M2 的形态已经有了） |
| 两层合并注入 | `MemoryService.loadForInjection` 并行读 L2/L3 → `composeMemoryForInjection` → `wrapForInjection` 包 `<!-- MEMORY -->` 块 |
| 会话结束自动沉淀 | `sedimentSession`（`deleteSession` / `deleteSessions` / `createSession` 补触发），`summarize` 产出 `[身份]/[任务]` 分节 → L2/L3 分流 |
| 受控写入协议 | `<memory-save scope="user\|workspace">`，**不走工具审批**，落盘统一由 `append` 负责 |
| 去重 | 字节级（`hashContent` + `<!-- SUMMARY:<hash> -->`）+ 语句级（`normalizeForDedup` 后完全相等） |
| 系统报错不落盘 | `looksLikeSystemError`（强特征词 ∧ 中文占比 < 15%）三道防线 |
| 注入快照失效 | `Session.memoryVersion` + `memoryWorkspace` + 同步判定 `isMemorySnapshotStale()`；补刷点在槽位之后 |
| 段落级 LWW（同步用） | `memoryMerge.ts` 的 2P-Set + 段级墓碑 |
| 写前快照回滚锚点 | `snapshotBeforeWrite` + `fileBackup`（FR-7.3） |
| UI 治理雏形 | `/memory` 页：两作用域切换、文件级编辑、导出、清空、版本回滚 |
| 身份文件 | `SOUL.md` / `IDENTITY.md` / `USER.md` / `BOOTSTRAP.md` + `/persona` 页（与 WorkBuddy 的 L4 同构） |

**缺的（对照 §1.1 逐条）**：

| 缺口 | 现状证据 | 对标 | 严重度 |
|---|---|---|---|
| **G1 没有结构化事实** | `MemoryService.append(content, opts, scope, workdir)` 只收一段文本，落成 Markdown 引用块。没有 `kind` / `importance` / `memory_key` / `evidence` | M2 内核（`MemoryFact`） | 高（这是根因） |
| **G2 没有蒸馏** | 没有任何机制把 `YYYY-MM-DD.md` 里的过程记录提升为 `MEMORY.md` 的稳定结论。`MEMORY.md` 只能靠人手编辑 | M3 | **最高**（WorkBuddy 的核心增量） |
| **G3 没有冲突域与替代** | 同一事实的更新（20 岁 → 25 岁）靠模型「只写新的完整表述」的**软约束**；代码层只挡机械重复，旧版本留在文件里继续被注入 | M3 冲突域 + 替代门槛 | 高 |
| **G4 没有冲突队列与人工裁决** | 不存在 `conflict` 概念。PRD §6.6 明确把「记忆页人工合并」列为 P2 未实现 | M3 fail-closed + 裁决 | 高 |
| **G5 没有事务与重启恢复** | `append` 是「读全文 → 拼字符串 → 写回」，跨文件操作无 journal；崩溃可能留下半写状态。`save` 之外无一致性保障 | M3 事务日志 | 中高 |
| **G6 用户记忆不是结构化的** | L2 是 `~/.nanowork/MEMORY.md` **单个 Markdown 文件**，靠 `platform.storage` 的 `nanowork.userMemory` key 路由。没有 profile 字段、没有 keyed preference、没有 expiry、没有 revision、没有 `source_event_id` | M4 + s11 两契约 | 高 |
| **G7 没有跨会话召回** | 全仓无 `recall` / 跨会话检索实现（`grep` 证实：只有产物库的「跨会话检索」字样与**会话内**高亮搜索 `ChatSearchBar`）。`docs/nanowork-prd-design-v2.md` 也把 L1 云端画像标 ⬜ | M5 + s12 | 高 |
| **G8 注入无预算、无来源** | `loadForInjection` 把两层**全文**合并注入，没有字符/token 上限、没有裁剪优先级；注入块无内存快照 id、无 `captured_at` | M3 有界注入 / s12 provenance | 中高（长期必然爆上下文） |
| **G9 无过期与遗忘** | 没有 `expires_at`；日期日志无保留策略（工作区里能堆无限多个 `YYYY-MM-DD.md`）；PRD 的「超 30 天提炼后清理」无实现 | M3 30 天清理 / M6 遗忘 | 中 |
| **G10 治理页看不到「事实」** | `/memory` 页是**文件编辑器**（编辑 Markdown 原文）。用户看不到「系统记住了哪些事实、哪条被替代、哪条在等裁决」 | M6 | 中 |
| **G11 双记忆体系边界不清** | 客户端记忆（`<workdir>/.nanowork/memory/`）与引擎记忆（`.nanowork-workspace/memory/` + `history.jsonl` + `.dream_cursor`）**同时存在且互不知情**，实测两处都有内容。`prd-memory.md` §6.8 只用一张表说明「别当成同一件事」，没有收敛方案 | — | 中（认知负担 + 重复写入） |
| **G12 无「关闭某条记忆」** | 只有整层清空（`clear`）与整文件删除 | M6「删除或关闭」 | 低 |

### 1.3 差距的根因归纳

三条，其余都是它们的表现形式：

1. **没有「事实」这个一等公民（G1）**。记忆的原子单位是 **Markdown 段落**，而不是**带 kinds/importance/key/evidence 的事实**。于是：
   - 无法判断「值不值得长期记」（G2 没有晋升判据）；
   - 无法判断「这两条说的是同一件事」（G3 只能靠模型软约束，代码层只能挡机械重复）；
   - 无法在冲突平局时 fail-closed（G4 连冲突这个概念都没有）。
2. **没有区分「证据」与「结论」（G2/G5）**。`YYYY-MM-DD.md` 与 `MEMORY.md` 都被当成**同等权威的正文**，直接拼起来注入。WorkBuddy 的分工是：日志是**证据**（append-only、可留存、可重算），`MEMORY.md` 是**有损的派生视图**（可重建）。没有这个区分，就没有蒸馏、没有重算、没有原子重建。
3. **没有「召回」这个独立阶段（G7/G8）**。v1 的模型是「把记住的全部塞进 system 段」。WorkBuddy 的模型是「存下来的记录」与「本轮该进 prompt 的少量候选」两件事，中间隔着 `normalize → candidate → score → rank → render`。没有这个阶段，上下文预算就没有刹车。

### 1.4 「最低要求与 WorkBuddy 一样」的范围界定

按 §1.1 的 M1–M6 逐条口径对齐，**不含**需要云端服务端的能力：

| WorkBuddy 能力 | 本次是否要求 | 说明 |
|---|---|---|
| M1 三层作用域 | ✅ 要求 | 云端层用**本地结构化画像 + 召回**等价实现（见 FR-M11 / FR-M14），不引入服务端 |
| M2 每日日志 append-only | ✅ 要求，**并升级**为结构化 JSONL | 兼容读取既有 `YYYY-MM-DD.md`（不丢用户数据） |
| M3 蒸馏 / 冲突域 / 替代 / fail-closed / 人工裁决 / 事务 / 证据留存 | ✅ **全部要求** | 这是「最低要求」的主体 |
| M4 用户画像与偏好 | ✅ 要求 | 云端画像的「只读」语义用 `source='remote'` 的只读投影等价表达，本地不得手改 |
| M5 历史对话检索 | ✅ 要求（功能等价） | 检索范围 = 本机全部会话事件；契约（自包含 query + scope + provenance + score）与 s12 一致。**不要求**服务端语义排序 |
| M6 治理闭环 | ✅ 要求 | 含冲突队列、单条删除/停用、过期与保留策略 |
| 向量检索 / embedding / LLM reranker | ❌ 不要求 | s12 本身刻意先稳定接口、用透明基线 ranker；接口留好即可替换 |
| 服务端画像学习、跨设备记忆同步 | ❌ 不要求（Phase 2） | 与 V1.5 云端同步一并考虑，见 §7 |

---

## 2. 设计原则（约束所有后续决策）

1. **Harness 掌握 promotion，模型不掌握**。哪些事实值得长期保留、作用域是什么、证据关系如何，由代码的显式策略决定。模型可以在**候选提取**阶段参与，但不能决定「永远记住」。
2. **证据只追加，结论可重建**。原始事实永不因蒸馏删除；`MEMORY.md` 与注入块都是**派生投影**，任何时候可从 canonical 状态重建。
3. **拿不准就不动**。冲突平局 fail-closed，保留 incumbent 并进人工队列。
4. **canonical state 用 JSON，Markdown 只做人读视图**。人可编辑 Markdown，但编辑入口要能回写到 canonical（或明确标注「此编辑不参与晋升」）。
5. **注入有预算、带来源**。任何进入 prompt 的记忆都必须能回答「这条从哪来、什么时候记的、属于哪一层」，且总量有上限。
6. **不破坏 v1 既有行为与测试**。v1 的 9 个测试文件（约 1900 行）是回归底线；迁移是**读兼容 + 懒迁移**，不是重写。
7. **渲染层零 `electron` 依赖**。所有 IO 经 `platform.*`（`ADR-019` 口径不变）。

---

## 3. 用户故事

| # | 故事 | 价值 |
|---|---|---|
| US-1 | 作为用户，我在项目里连续工作了 40 天，希望那些「反复确认过的项目约定、技术选型、踩过的坑」自动沉淀成一份精炼记忆，而不是让我手抄进 `MEMORY.md` | 对标 M3，省掉手工蒸馏 |
| US-2 | 作为用户，我三个月前说过「我用 Python 3.11」，现在改口「换 3.12 了」，我希望记忆里**只留 3.12**，不要两个版本并存、也不要被旧值回滚 | 对标冲突域 + 替代门槛 |
| US-3 | 作为用户，当系统拿不准「该听新的还是旧的」时，我希望它**先不动**，把两个候选摆到我面前让我裁决，并告诉我各自的证据 | 对标 fail-closed + 人工裁决 |
| US-4 | 作为用户，我在项目 A 立的规矩不能污染项目 B；但「我叫什么、回复用中文」换任何项目都成立 | 对标 M1 作用域隔离 |
| US-5 | 作为用户，我想问「上个月我们讨论定时任务那次，结论是什么」，希望 Agent 能**跨会话**把那段找回来，并告诉我它出自哪个会话、什么时候 | 对标 M5 |
| US-6 | 作为用户，我想看看「系统到底记住了哪些事实」，逐条确认、改一条、删一条、或者让某条**暂时失效** | 对标 M6 |
| US-7 | 作为用户，我不想我的项目目录里多出产品文件，但我想知道记忆存在哪、能拷走 | 保留 v1 取舍 |
| US-8 | 作为用户，我不希望记忆把上下文挤爆——它应该只带该带的那部分 | 对标「召回有预算」 |

---

## 4. 需求池（`FR-M*`）

> 优先级：**P0** = 本次必达（「最低要求一样」的组成部分）；**P1** = 机制完整所必需，允许紧随其后；**P2** = 明确不在本次。
> 每条给出：验收标准（可判定）+ 对标 + 现状缺口编号。

### 4.1 存储与事实模型

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M1** | 结构化事实日志 | P0 | G1 | 新增 `MemoryFact` 作为记忆的原子单位，含 `fact_id` / `kind`(decision·convention·pitfall·outcome) / `content` / `importance`(1–5) / `memory_key?` / `source`(agent·user·auto·remote) / `evidence?` / `observed_at` / `workspace_id`。落 `<workdir>/.nanowork/memory/daily/YYYY-MM-DD.jsonl`，每行一条 JSON、单次 `O_APPEND` 语义追加。写入前校验 kind / importance / 内容长度 / `memory_key` 形态，**任一非法整体拒绝**（不部分写入） |
| **FR-M2** | `memory_key` 冲突域 | P0 | G3 | `memory_key` 描述「回答哪个问题」，形态限定 `^[a-z0-9]+([._-][a-z0-9]+)*$`，长度 ≤ 64。显式提供时按它建冲突域（内部键 `k:<memory_key>`）；缺省时按 `kind + 归一化内容` 派生稳定键（内部键 `d:<kind>:<hash>`）。**`memory_key` 与人/模型提供的值受上述正则约束；内部冲突域键（`k:` / `d:` / `l:` / `x:`）不受**——它们含 `:`，只用于分组，不对外暴露（见设计 §4.1 的 `EntryKey`） |
| **FR-M3** | v1 数据读兼容与懒迁移 | P0 | — | 既有 `MEMORY.md` 与 `YYYY-MM-DD.md` 全部继续可读、可注入；首次读到旧格式时**不丢内容、不改写原文**，以 `legacy` 语义纳入（`kind` 未知、不参与自动晋升），并在记忆页标注「历史格式」。回归：迁移前后 `loadForInjection()` 的**条目集合不减少** |
| **FR-M4** | 用户级结构化存储 | P0 | G6 | `~/.nanowork/user-memory/<scope-id>/` 目录：`daily/`（结构化事实日志）、`profile.json`（结构化画像）、`preferences.json`（keyed 偏好全集，含过期记录）、`curated.json` / `conflicts.json` / 两个 journal、`MEMORY.md`（投影）、`user.md`（画像投影）。**与工作区级刻意同构**（三套机制只有一份实现，作用域只换一个 `ref`）。canonical 是 JSON，Markdown 可重建。`userScope` **与账户解耦**、本机首次生成并持久化（见设计 §4.7.0）。**既有 `~/.nanowork/MEMORY.md` 原地保留、不改名、不清空**（理由与判据见 FR-M4a） |

| **FR-M4a** | 迁移不得造成跨端数据丢失 | P0 | G6 | v1 用户级单文件（storage key `nanowork.userMemory`）**已经在跨端同步边界内**：它是**段落级** C 类资产 `memoryUser`（`src/sync/fileAssets.ts:76-80`，`paragraphLevel: true`）。经代码核验：把该文件改名或清空 → `platform.storage.get` 变空 → `hydrate()` 走「内容变了」分支（`fileAssets.ts:272-287`）→ `diffRemovedKeys` 为**上次已知的全部段落**生成墓碑 → `collect()` 上行 → 其他设备 `apply()` 按墓碑**删掉这些段落**。这不是本机迁移，是**跨设备的用户记忆清空**。故：① 原文件与原 key **原地不动**，作为 legacy 只读源继续参与注入（同 FR-M3）；② 新目录另起；③ 若要退役 `memoryUser` 资产，必须作为**跨端协商的一次性动作**（先升 schema、两端都识别后再停采），**不在本次迁移里做**。验收：迁移前后 `platform.storage.get(USER_MEMORY_KEY)` 逐字节相同，且有一条同步侧回归用例守着 |

### 4.2 蒸馏（promotion）

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M5** | 显式蒸馏策略 `DistillPolicy` | P0 | G2 | 默认判据：`(年龄 ≥ retentionDays(默认 30) ∨ origin='manual') ∧ kind ∈ {decision, convention, pitfall} ∧ (importance ≥ 4 ∨ 归一化内容重复 ≥ 2)`。`outcome` **永不自动晋升**。策略参数可配置且**可单测**；不调用模型即可验证（无 API key 可跑）。<br>**手编豁免年龄门槛（2026-10-03 定稿）**：`origin === 'manual'`（用户在记忆页手写保存）不受 `retentionDays` 约束，立即成为 active 结论。若一视同仁，用户点保存后内容会被 `distill` 重建的投影**当场覆盖成空**（实测：`MEMORY.md` = `""`），而 toast 仍显示「已登记为长期记忆」——属静默丢失。连带约定：`createMemoryFact` 的缺省 `origin` 为 `'sediment'`（**不是** `'manual'`），特权值不当兜底 |
| **FR-M6** | 晋升为策展修订 | P0 | G2 | 通过判据的事实进入 `curated.json`，每条形成带 `revision` / `evidence_ids` / `first_seen` / `last_seen` / `status`(active·superseded) 的**修订**。重复执行 `distill()` 幂等：同输入不产生新修订、不重复合并 evidence。返回 `DistillReport`（`promoted` / `superseded` / `conflicts` / `queued_conflicts` / `stale` / `skipped`），让**拒绝晋升的原因可观察** |
| **FR-M7** | 无 memory_key 的归并 | P0 | G2 | 缺省 key 的同类事实按 `kind + 归一化内容` 合并 evidence；**不同内容不自动互相替代**（避免把「补充」误当「更新」），分别成为独立修订 |
| **FR-M8** | 替代门槛 | P0 | G3 | 同域新值与 active 不同内容时，**必须同时**满足：①（新值自身）通过 FR-M5 判据；② 至少 `supersessionRepeatThreshold`（默认 2）条**独立事实**确认；③ 候选最新 `observed_at` **严格晚于** active 的 `last_seen`。三条缺一即拒绝替代，记入 `stale` 或 `skipped` |
| **FR-M9** | 双向修订链 | P0 | G3 | 新版记 `supersedes = 旧 revision`，旧版记 `superseded_by = 新 revision`，旧版 `status = 'superseded'`。读取时校验「每个冲突域恰有一个 active、revision 连续、前后链接互相匹配」，损坏状态**显式报错**而不是静默选一个 |
| **FR-M10** | 有界注入 | P0 | G8 | `getContextForInjection()` 只注入：① active 修订渲染出的精简投影；② 最近 `recentFactLimit`（默认 6）条事实。**不注入**：`superseded` 修订、冲突候选、open case 候选、全部 daily 日志、session transcript。总量受 `budgetChars` 约束（默认：用户级 4000 / 工作区级 3000 字符，对标 WorkBuddy 的单会话写入上限口径），超限按「importance → last_seen」降序裁剪并记 `truncated` 计数 |

### 4.3 冲突与人工裁决

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M11** | 同分冲突 fail-closed | P0 | G4 | 多个候选按（importance, 独立证据数, 最新时间）排序；唯一胜出者成为下一版 active；**最优分数相同时不动现状**，保留 incumbent 并创建持久化 `MemoryConflictCase`。候选**不进**注入块 |
| **FR-M12** | 冲突案件完整快照 | P0 | G4 | case 含 `conflict_id`（由 workspace + memory_key + evidence fingerprint 确定性生成）/ `revision` / `candidates`（incumbent 与 challenger，各带 `evidence_ids`）/ `observed_fact_ids` / `active_entry_key` / `status`(open·resolved·superseded)。重复 `distill()` 不重复建案；证据变化且仍同分时旧 case 标 `superseded`、新 fingerprint 形成下一 revision。只有 `listConflicts()` 能取到 open case |
| **FR-M13** | 显式裁决 + 陈旧保护 | P0 | G4 | `resolveConflict(conflictId, candidateId, {expectedRevision, actor, rationale, eventId})` 执行前**重新校验**：case 仍 open 且 revision 未变、当前 active entry 仍是检测时版本、observed fact ids 与 fingerprint 快照一致、选中候选确实属于该 case —— 四者任一不满足抛 `StaleConflictResolutionError`（要求重看）；`eventId` **同参**重试返回原事件（幂等），**同 id 换参数**抛 `ConflictEventReuseError`（要求换 key）。两类错误的处置动作不同，刻意分开。**裁决 API 不出现在模型的工具列表里** |
| **FR-M13a** | 无客户端工具通道这一事实 | P0 | — | 本项目**没有任何「客户端向模型注册工具」的通道**：聊天请求只下发 `tool_allow` / `tool_deny`（`src/ai/runtime/types.ts:95-96`），工具定义全在引擎侧。因此 v2 的记忆能力**一律走正文协议或 UI**，不新增模型工具、不给引擎打 `[LOCAL PATCH]`：写入 = `<memory-save>`（v1 已有）、召回 = 客户端按轮触发（FR-M25a）、裁决 = 记忆页 UI。验收：全仓新增的模型可见工具数为 **0** |
| **FR-M14** | 裁决语义正确 | P0 | G4 | 选 challenger → 创建下一版 curated revision 并把 incumbent 标 superseded；选 incumbent → **只记审计事件，不制造新修订**（保持现状不是一次事实变化） |
| **FR-M15** | append-only 审计 | P0 | G4 | 每次成功裁决向 `conflict-adjudications.jsonl` 追加一条：`actor` / `rationale` / `case revision` / 选中 `evidence_ids` / 原 active key / 结果 active key / `event_id`。同 `event_id` 同参重试返回原事件（不重复写审计、不重复建修订）；同 `event_id` 换候选显式拒绝 |

### 4.4 事务与重启恢复

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M16** | 单文件原子替换 | P0 | G5 | `curated.json` / `conflicts.json` / `preferences.json` / `profile.json` 一律「写临时文件 → 落盘 → 原子替换」。失败时旧版本保持不变、临时文件被清理 |
| **FR-M17** | 跨文件事务 journal | P0 | G5 | 一次裁决在产生任何业务副作用**之前**，先把带完整 before/after 快照的 intent 追加到 `conflict-resolution-transactions.jsonl`；随后按 `prepared → curated_applied → conflict_closed → audit_appended → committed` 逐阶段推进，每阶段先完成目标写入再追加同 `transaction_id` + `intent_sha256` 的阶段事件 |
| **FR-M18** | 重启幂等前滚 | P0 | G5 | 新进程创建 store 实例时重放所有未 `committed` 的事务：磁盘状态等于 before → 重做；等于 after → 继续；**既非 before 也非 after → fail-closed 报错**（不回滚证据）。审计按原 `eventId` 去重，多次恢复不产生重复修订或重复审计行。journal intent 被篡改 / 阶段跳跃 / workspace 不匹配 → 显式拒绝 |
| **FR-M19** | 投影中断修复 | P0 | G5 | 若进程在 canonical 状态与 `MEMORY.md` 两次替换之间退出，恢复事务先以 canonical 状态修复陈旧投影，再继续关案与追加审计 |

### 4.5 用户画像与偏好

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M20** | Profile 字段级 patch | P0 | G6 | `updateProfile(patch)` 只改出现的字段，未出现字段不变；`null` 表示**显式删除**该字段；schema 外字段直接报错（避免模型每轮发明新字段）；值必须是归一化后非空、≤1000 字符的字符串（字典/列表/数字/布尔**不隐式转文本**）；局部 patch 中任一字段非法则**整个请求拒绝**，不写入已校验的前几个字段。等值 patch 记 `unchanged`，不重写 canonical JSON；投影过期仍修复投影。读取时同样校验，`{"name": null}` 报错而不是变成 `Name: None` 注入 |
| **FR-M21** | Preference 键级生命周期 | P0 | G6 | `setPreference(key, value, {source, sourceEventId, updatedAt, expiresAt})` 返回 `CREATED` / `UNCHANGED` / `UPDATED` 之一。**完整幂等身份** = value + source + expiresAt + sourceEventId：全部相同才是 no-op（不写盘、不加 revision，即使重试时间更晚也不推进证据时间）。相同 value 但延长期限或补充新来源 = 可观察更新（revision + 1）。**时间防回滚**：状态不同的写入时间必须**严格晚于** canonical `updatedAt`（否则重放旧 transcript 会回滚新偏好）；无 `sourceEventId` 时，显式传入更晚时间表示用户再次确认，即使 value 不变也推进 `updatedAt` 并 `revision + 1`。`deletePreference(key)` 按 key 精确删除，不做自然语言模糊匹配 |
| **FR-M22** | 过期偏好 | P0 | G9 | `expiresAt` 必须含时区、统一存 UTC。`as_of < expiresAt` 为 active，到达瞬间即 expired。`listPreferences()` 返回全部（含过期），`listActivePreferences(asOf)` 才返回可注入集合。过期是**不注入**而不是删除：记录留在 `preferences.json` 以便解释「它曾经为何生效」。历史 `as_of` 查询是纯读取，不写回当前投影 |
| **FR-M23** | 来源可溯且模型不可伪造 | P0 | G6 | `sourceEventId` 是 **Harness provenance**：程序化调用方可附 s09/事件流的稳定 event id；`save_user_preference` 这类面向模型的工具**只接受 value 与可选 expiry**，不能提交或伪造 event id |
| **FR-M24** | 多用户/多作用域隔离 | P1 | G6 | store 以 `user_scope` 摘要作为目录隔离单位；canonical JSON 内保存同一个 `user_scope`，读取时不匹配则**拒绝**（发现错误复制或调用方传错用户），而不是静默注入别人的记忆 |

### 4.6 召回（跨会话历史检索）

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M25** | 五阶段召回主路径 | P0 | G7 | 实现 `normalize → candidate → score → stableRank → render` 五阶段，各阶段产出**结构化数据**（`RecallQuery` / `RecallCandidate` / `RecallScoreBreakdown` / `RecallHit` / `RecallResult`），任一阶段失败可定位到输入 / 候选 / 评分 / 排序 / 渲染，而不是只看到一个不可解释的最终分数 |
| **FR-M25a** | 召回通道：按轮触发，不做模型工具 | P0 | G7 | 本项目**没有客户端工具注册通道**（模型可见工具由引擎下发），加一个工具就要给引擎打 `[LOCAL PATCH]`——本次明确 0 个。故召回由**客户端在装配 system 段时按轮触发**：query 取自本轮用户消息（拼上一轮用户消息作最短上下文），命中渲染成 `<recalled_context>` 块注入；**不需要模型做任何动作**。理由：v1 的实测教训是「模型看不到就答不出来」（`prd-memory.md` §6.7），把「想不想得起」移回 harness 与设计原则 1 同向。**代价**：每轮付一次召回成本，故设触发门槛（query 词项数 < 2、或与上一轮 query 归一化后相同 → 跳过）。验收：`recall` 可被 harness 显式调用（用于测试与诊断）并返回结构化 `RecallResult`，但它**不出现在任何模型工具清单里** |
| **FR-M26** | 自包含 Query | P0 | G7 | `RecallQuery` 含 `query_id` / `text` / `normalized_text` / `terms` / `user_scope` / `limit` / `issued_at`。原文先折叠空白，再 NFKC + casefold + 空白归一化；英文按词切分，连续中文补**二元字符**特征（「分层记忆」→ 分层/层记/记忆）。空白 query 拒绝；只有标点、无 searchable term 的 query **明确拒绝**（不退化成全量召回）；`limit ∉ [1,10]` 拒绝。工具描述必须要求模型**重述历史主题**，不能依赖当前对话上下文推断（「继续上次」必须失败） |
| **FR-M27** | 带来源与分数的 hit | P0 | G7/G8 | 每个 `RecallHit` 携带 `query_id` / `memory_id` / `rank` / `snippet` / `scope` / `provenance`(source_id·source_type·title·captured_at) / `score_breakdown`(matched_terms·query_term_count·lexical_coverage·recency·weights·contributions·total)。`stored_at`（进入存储的时间）与 `captured_at`（来源事件发生时间）是**两个字段** |
| **FR-M28** | 确定性稳定排序 | P0 | G7 | 基线分数 = `0.85 × query-term coverage + 0.15 × recency`；排序键显式固定为 `total DESC → lexical_coverage DESC → captured_at DESC → memory_id ASC`。同输入、同 `as_of`、同 records 必得**相同排名**（消除 JSONL 插入顺序影响） |
| **FR-M29** | 召回只读 + 结构化返回 | P0 | G7 | 召回**不修改**任何 durable store（不因读到就写回一条新记忆）；`recall(query, limit)` 返回**结构化 `RecallResult`**（可审计、可显示来源、可按预算截断、可后续插 reranker），而不是预排版的历史文本。渲染成 `<recalled_context>` 时，每个 hit 保留 `query_id` / `scope` / `provenance` / `score_breakdown`。无匹配时返回空 hits + `searched_records` / `candidate_records` / `empty_reason='no_matching_terms'`，渲染器返回**空串**（不为空 wrapper 消耗预算） |
| **FR-M30** | 检索范围 | P0 | G7 | 检索范围 = **本机事件流存储里的会话**（`EventStore.listMetas()` 磁盘扫描，`src/events/electronStore.ts:64-66`），即 user/assistant 消息的只读投影。**口径收窄（2026-10-02 修正）**：`readonly` / `channel` / `cron` 会话**不落本地事件流**（`isEventStreamSession`，`src/stores/sessionsStore.ts:409-411`），墓碑会话的正文已被丢弃（`electron/eventStore.ts:249-251`），因此这些会话检索不到——**必须在 UI 与文档里如实说明「可从历史对话检索中恢复的范围是本机事件流会话」**，不能宣称「全部历史」。语料规模超阈值时按 `limit` 与时间窗裁剪。**不要求**向量检索；接口须允许后续替换为 embedding / hybrid / reranker 而不改 `RecallResult` 契约 |

### 4.7 治理与遗忘

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M31** | 记忆页升级为「事实视图」 | P0 | G10 | 记忆页新增视图：按作用域列出 **active 修订**（内容 / kind / importance / revision / first_seen / last_seen / 证据来源），可逐条 **停用 / 删除 / 改作用域**。既有「文件编辑器」保留（面向高级用户与手工 Markdown）。**「改作用域」的语义是显式定义的**（见设计 §4.7.0）：跨作用域搬一条记忆 = 目标作用域**新建一条事实**（`origin: 'manual'`）+ 源作用域**停用**该修订 + 一条审计，**不是移动文件**（`factId` 含 `workspaceId`、`entryKey` 含作用域前缀，改文件会破坏归属校验 I11）。**「停用/删除」必须不会把 store 判定为损坏**（见 FR-M34 与设计 I2 的「至多一个 active」） |
| **FR-M31a** | 清空应用数据必须覆盖新落点 | P0 | — | 主进程 `clearStorageFiles` 现只删静态路由文件 + `memoryDir` 下的 `.md/.json`（`electron/main.ts:2435-2444`），`knownRouteFiles` 不含新目录（`electron/storageRoutes.ts:336-346`）。v2 必须把 `~/.nanowork/user-memory/**`、`<工作目录>/.nanowork/memory/daily|archive/**` 纳入「清空应用数据」，并一并清理 `.migrated` 留档。验收：清空后新目录不存在残留 |
| **FR-M32** | 冲突待审区 | P0 | G4/G10 | 记忆页新增「待裁决（N）」区：展示候选内容、各自证据、检测时间；选择其一提交（带 `expectedRevision` 与理由）。陈旧时界面提示「证据已变化，请重看」并刷新 |
| **FR-M33** | 保留与归档 | P1 | G9 | **三个概念分开**：`retentionDays`（默认 30）= 蒸馏**晋升年龄门槛**；`archiveAfterDays`（默认 180）= **日志文件级**归档（该日期的 `daily/*.jsonl` 整体移入 `memory/archive/`，不再被 `distill` 扫描但保留可审计）；`disable` / `delete` = 单条事实级动作（FR-M34 / FR-M31）。**不删除证据**——清理是独立策略，不与蒸馏混在一起。工作区日志**数量**上限（默认 180 个日期文件）只作 UI 提示，不是归档判据 |
| **FR-M34** | 单条停用（「关闭」） | P1 | G12 | 单条修订可标记 `disabled` + 理由，立即停止注入但保留在 canonical，可恢复。区别于 `delete`（真删，合规要求）与 `superseded`（被新值替代） |
| **FR-M35** | 导出与可迁移 | P1 | — | 导出为**一份自包含 JSON bundle**（facts + curated + profile + preferences + 审计流），可导入到另一台设备/工作区，导入时校验 `workspace_id` / `user_scope` 并把来源记为 `origin: 'import'`。既有 Markdown 导出保留。**必须同时扩展既有账户导出**：`src/components/settings/sections/AccountSection.tsx` 的 `ArchiveWorkspaceMemory`（:65-79 / :243-249）目前**平铺**收集工作区记忆，新 canonical 文件（`curated.json` / `conflicts.json` / `daily/*.jsonl` / `archive/*`）与用户级新目录都会被**静默漏掉**——漏掉不报错，只让 bundle 缺内容。验收：导出后**逐文件比对**，新 canonical 文件全部在 bundle 内 |

### 4.8 边界收口

| 编号 | 名称 | 优先级 | 缺口 | 验收标准 |
|---|---|---|---|---|
| **FR-M36** | 显式声明与引擎记忆的边界 | P1 | G11 | 在 `docs/nanowork-prd-design-v2.md` 第 14 章与记忆页 UI 中明确：客户端记忆 v2 为**唯一**长期记忆源；引擎 `agents.defaults.workspace/memory/`（Dream 产物）降级为**引擎内部工作记忆**，客户端不注入、不编辑、不在记忆页展示。目的：消除「两套记忆互相不知情」的认知负担。**本次不做引擎侧改动**（避免 `[LOCAL PATCH]` 继续膨胀）。**范围收敛（2026-10-02）**：只读「引擎记忆元信息」的面板需要一条渲染层拿不到的引擎 workspace 绝对路径读回通道，故该面板**推迟到 Phase 5**（与 FR-M37 同批）；本期以记忆页顶部静态说明 + 文档收敛兑现其**认知目标** |
| **FR-M37** | Dream 候选不静默生效 | P1 | G11 | 兑现 `nanowork-prd-design-v2.md` §14.3 的合规约束「自动合并的产物必须**用户可审查后才生效**」：引擎侧 Dream 归纳出的候选（`.nanowork-workspace/memory/` 的变化）**不得**直接成为 active 修订。实现形态：v2 的蒸馏产物中，凡**非**由 `kind ∈ {decision,convention,pitfall}` 事实直接晋升而来的条目（即来源标为引擎 Dream 的候选），一律先落成 **open `ConflictCase` 的 challenger 候选**或标记 `status='pending-review'`，经人工裁决（FR-M13）后才成为 active。引擎侧零改动（只读它的产物作为**证据**，不写它）。**依赖 §4.10 的边界确定后才能实施**，故不阻塞 Phase 1–3。**范围收敛（2026-10-02）**：采样引擎 Dream 产物同样需要「引擎 workspace 路径读回」通道，故整体**推迟到 Phase 5**，与 FR-M36 后半同批 |

---

## 5. 非功能需求

| 编号 | 要求 | 判据 |
|---|---|---|
| NFR-M1 | **无 API key 可验证** | 全部策略（蒸馏 / 替代 / 冲突 / 事务 / 召回）在无模型配置下可跑通并有单测；导入相关模块不构造 provider client、不创建默认 store、不写种子数据 |
| NFR-M2 | **同步不引入 await 边界** | 注入路径的「已水合会话 `send` 同步进入流式态」性质（`tests/sessionsStore.test.ts` 并发用例）必须继续成立。快照过期判定保持**同步** |
| NFR-M3 | **渲染层零 `electron`** | 所有文件 IO 经 `platform.*`。⚠️ **如实说明**：`.github/workflows/ci.yml` 现有的两条平台边界检查是「grep `window.electronAPI`」（:126-129）与「wire 字段泄漏」（:184-188），**并不检查** `from 'electron'` / `node:fs`——I12 今天只有代码评审在守。**本设计新增一条前置条件**：Phase 0 在 CI 增加一条针对 `src/**` 的 `from 'electron'` / `node:fs` grep，使 I12 可自动化 |
| NFR-M4 | **门禁不退化** | `npm run typecheck` / `typecheck:electron` / `typecheck:tests` / `npm test` / `npm run build` 全绿；**另加 `npm run build:electron`**（`electron/main.cjs` / `preload.cjs` 是 `.gitignore:25-26` 的构建产物，`npm run build` 不重建它们）。v1 的 9 个记忆测试文件**必须全绿**，但**不承诺「不删不改语义」**（2026-10-02 修正）：至少 `tests/electron/workspaceMemoryStore.test.ts:87-93`（`index.json` 不被列成记忆）与 `tests/memoryService.test.ts:410`（`memoryDiskPath('user')` 期望值）两处断言**必须**按新语义更新；`tests/memoryService.test.ts:697-721` 与 `tests/sessionsStore.test.ts:704-737` 需按组合版本语义复核。**其余用例保持原断言语义**，不得为了过测试而放宽断言 |
| NFR-M5 | **崩溃安全** | 八个持久化写入边界（临时文件 write / flush / fsync / 替换 / curated 前后 / case 关闭前后 / 审计追加前后 / 投影替换前后）故障注入后，重启可幂等恢复或显式 fail-closed |
| NFR-M6 | **上下文预算可控** | 注入总量有硬上限，超限必有 `truncated` 计数可观察；注入内容**永不**随日志天数增长而线性增长 |
| NFR-M7 | **可审计** | 任一条 active 修订可回溯到产生它的原始事实（`evidence_ids`）与（若经裁决）裁决事件（actor + rationale） |
| NFR-M8 | **性能** | 单次 `distill()` 在 10k 条事实下 < 2s（本机）；`getContextForInjection()` < 50ms（读盘 + 渲染）；召回在 10k 条消息语料下 < 300ms |
| NFR-M9 | **Web 端降级语义必须如实** | Web 无文件系统，且**现有实现是「一个目录一个 `localStorage` key」而不是「一 key 一文件」**（`src/platform/storage.web.ts:64-88`，其注释 `:90-101` 专门解释了为什么需要第二份索引来枚举）。因此 Web 端**不可能**满足三条契约，必须如实降级而不是声称等价：① `appendLine` 无追加语义，只能是「读整份目录映射 → 改 → 写回」；② `replace` 同样是读-改-写，**多标签页会丢更新**；③ 没有 `fsync` 级崩溃安全，`NFR-M5` 的八个写入边界**在 Web 端不可验证**。Web 端的能力表述统一为「结构化记忆可用，原子性与崩溃恢复为 best-effort」，UI 上标注「无文件落点」。**不得**出现「Electron 能存、Web 静默丢」的差异 |
| NFR-M11 | **迁移不得造成跨端数据损失** | 用户级单文件（`nanowork.userMemory`）**已经在同步边界内**：它是段落级 C 类资产 `memoryUser`（`src/sync/fileAssets.ts:76-80`）。把该文件清空或改名会让 `hydrate()` 为全部已知段落生成墓碑（`fileAssets.ts:272-287`）并**跨设备删除用户记忆**。判据：v2 迁移**不得**改动该 key 的内容与存在性（保留为 legacy 只读源）；编码层面的断言写进 `tests/memory/store.test.ts` 与同步侧回归用例 |
| NFR-M10 | **召回也有预算** | 因 FR-M25a 改为按轮触发，召回成本每轮都会发生。注入的 hits 受 `recallBudget`（默认 1200 字符 / 最多 3 条）约束，超限按 `rank` 截断；触发门槛（词项数 < 2、与上轮 query 相同）必须生效；命中 0 条不注入。判据：连续追问同一话题时**不重复**召回（可用测试断言 `recall` 调用次数）；长会话下注入总量不随轮数线性增长 |
| NFR-M12 | **确定性可复现** | `distillFacts` / `setPreference` / `applyProfilePatch` / `createMemoryFact` 的**纯函数形态显式接收 `now`**，不在函数内读时钟；`evidenceIds` 排序后存储；`firstSeen`/`lastSeen` 由 evidence 派生（不是 `now`）；一切字符串排序用 `<`，**禁用 `localeCompare`**。判据：同输入两次调用产出**逐字节相同**的 canonical JSON；打乱 facts 输入顺序结果不变 |

---

## 6. 用户故事 → 需求映射（覆盖检查）

| 故事 | 对应需求 |
|---|---|
| US-1 | FR-M1, FR-M2, FR-M5, FR-M6 |
| US-2 | FR-M2, FR-M8, FR-M9 |
| US-3 | FR-M11, FR-M12, FR-M13, FR-M32 |
| US-4 | FR-M1（`workspace_id`）, FR-M4（`user_scope`）, FR-M24, FR-M10 |
| US-5 | FR-M25 – FR-M30 |
| US-6 | FR-M20 – FR-M23, FR-M31, FR-M34 |
| US-7 | FR-M3, FR-M35；保留 v1 落点取舍（`docs/prd-memory.md` §6.1） |
| US-8 | FR-M10, NFR-M6 |

---

## 7. 分期与迁移

| 阶段 | 内容 | 需求 | 交付判据 |
|---|---|---|---|
| **Phase 0** | 平台与存储地基：多存储根（用户级目录）、原子替换、`rename` 能力、schema 版本与校验 | FR-M4, FR-M16 | 平台契约单测绿；新旧数据共存不丢 |
| **Phase 1** | 事实模型 + 日志 + 蒸馏 + 冲突 + 事务 + 裁决（**核心增量**） | FR-M1 – FR-M19 | 对标 M2/M3 全部要求达成；八个写入边界故障注入可恢复 |
| **Phase 2** | 用户画像与偏好 + 有界注入 + 治理页 | FR-M20 – FR-M24, FR-M31, FR-M32, FR-M34 | 对标 M4/M6；注入不再随日志线性增长 |
| **Phase 3** | 跨会话召回 | FR-M25 – FR-M30 | 对标 M5（本机范围） |
| **Phase 4** | 保留/归档/导出/边界收口 | FR-M33, FR-M35, FR-M36（文档收敛 + UI 静态说明） | 对标 M3 的 30 天清理与 M6 的遗忘 |
| **Phase 5（不在本次）** | 云端画像 + 跨设备记忆同步 + 向量/reranker + **引擎记忆只读诊断面板（FR-M36 后半）+ Dream 候选通道（FR-M37）** | — | 与 V1.5 `SyncMeta` / `docs/cross-platform-sync-design.md` 一并规划；两者共用同一条「引擎 workspace 路径读回」通道 |

**不破坏性承诺**：Phase 1–4 全程，v1 的落点（`<workdir>/.nanowork/memory/`）、注入标签（`<!-- MEMORY -->`）、
去重标记（`<!-- SUMMARY:<hash> -->`）、开关（`memoryEnabled` / `autoSummarize`）、
`<memory-save>` 协议**继续有效**。结构化能力是**叠加**，不是替换。

---

## 8. 明确保留的 v1 机制（不是「待重做」）

以下是 v1 已经做对、且 WorkBuddy 同类问题的教训已经体现在其中的部分，**v2 原样保留并继续受测试保护**：

1. **落点在用户工作目录下**（`<workdir>/.nanowork/memory/`）——不往用户项目里塞产品文件这条取舍（`docs/prd-memory.md` §6.1 的刻意偏离）继续成立，且与 WorkBuddy 同构。
2. **两层合并注入的定序**：用户级在前、工作区级在后；护栏句写明裁决规则。顺序与护栏句是同一套假设（`docs/prd-memory.md` §6.4）。
3. **系统报错不落盘**（`looksLikeSystemError` 三道防线）——`prd-memory.md` §6.5。
4. **注入快照失效机制**（`memoryVersion` + `memoryWorkspace` + 同步判定 + 补刷点在流式槽位之后）——`prd-memory.md` §6.7。NFR-M2 把它升级为硬约束。
5. **不做字节相似度阈值去重**——三条真实数据的实测表已证明中文短文本上不成立（`prd-memory.md` §6.6）。v2 用**显式 `memory_key` + 替代门槛**解决同一问题，这是「把语义判断交给有能力做它的层」的**正确形态**：不是让模型猜相似度，而是让 harness 拿到冲突域。
6. **写前快照 / 版本回滚锚点**（FR-7.3 `snapshotBeforeWrite`）——记忆页的「版本历史」继续可用。
7. **受控写入协议不走工具审批**——纯本地无副作用写入弹审批框只会教用户关掉审批。

---

## 9. 已知风险与取舍

| 风险 | 影响 | 处置 |
|---|---|---|
| 结构化迁移让「模型写记忆」变复杂 | 模型可能写不出合法 `memory_key` | `memory_key` **可选**；缺省走派生 key（FR-M7）。`<memory-save>` 协议**不变**，由客户端补 kind/importance 默认值 |
| 30 天年龄门槛让「新项目」短期没有策展记忆 | 用户感觉「没记住」 | ① 近期事实仍进注入（FR-M10 的 recent facts）；② 门槛可配置；③ 记忆页显示「N 条已记，M 条待满 30 天晋升」 |
| 人工裁决增加操作负担 | 用户可能放着不处理 | ① 平局才建案，正常更新不需要人；② 记忆页给「待裁决 N」角标；③ 未决候选**不进注入**，不会污染回答 |
| 事务 journal 增加写放大 | 每次裁决多几次小写入 | journal 只在**裁决**与**策展写入**路径出现（不是每次 `append`）；`append` 仍是单次追加 |
| 结构化与 v1 Markdown 语义并存，认知负担 | 使用者困惑「该看哪个」 | 记忆页以**事实视图为主**、文件编辑器折叠为「高级」；FR-M3 明确 legacy 标注 |
| 召回吃掉上下文 | 反而伤害回答质量 | FR-M29 只读、FR-M10 + NFR-M6 有界、无匹配渲染空串 |

---

## 10. 非目标（本次不做）

1. 云端画像的**服务端学习**与跨设备记忆同步（Phase 5，随 V1.5）。
2. 向量检索 / embedding / LLM reranker（接口预留，实现不换）。
3. 组织级 / 项目级记忆命名空间（`FR-4.4`，依赖 V2/V3）。
4. 引擎侧（nanobot）记忆改造：**零 `[LOCAL PATCH]` 新增**。
5. 记忆的端到端加密（V3 企业合规范围）。
6. 技能与自动化作为「行动型记忆」的重做（V1 已有 skills / cron，边界收敛归 FR-M36 之外的后续工作）。

---

## 11. 术语表（三件套统一口径）

| 术语 | 含义 | 不是什么 |
|---|---|---|
| **事实（fact）** | 记忆的**原子单位**，一条带 `kind` / `importance` / 可选 `memory_key` / 来源的结构化陈述。落 `daily/*.jsonl`，**只追加** | 不是「一段 Markdown」，不是「一次对话的摘要」 |
| **证据（evidence）** | 事实与裁决审计流的总称。永久保留，蒸馏不删它 | 不是「可以清理的临时数据」 |
| **冲突域（conflict domain）** | 由 `memory_key`（或派生 key）标识的「这一条记忆回答哪个问题」 | **不是答案本身**——`Use Python 3.11` 与 `Use Python 3.12` 共享同一个域 |
| **策展修订（curated revision）** | 通过蒸馏门槛、进入 `curated.json` 的一条带 `revision` 的结论 | 不是 daily 日志里的原始事实 |
| **active / superseded / disabled** | 修订的三种状态：当前生效 / 被新值替代 / 被人工停用 | `superseded` ≠ 删除；`disabled` ≠ 删除 |
| **蒸馏（distill）** | 由**显式策略**（非模型）从证据里选出稳定结论的动作 | 不是「让模型总结一下」 |
| **替代（supersession）** | 同域新值在通过三重门槛后成为下一版 active | 不是「内容相似就覆盖」 |
| **投影（projection）** | 由 canonical 状态渲染出的人读 / 注入视图（`MEMORY.md` / `user.md` / 注入块） | **不是权威**，随时可重建 |
| **canonical 状态** | `curated.json` / `conflicts.json` / `profile.json` / `preferences.json` | 不是 Markdown |
| **冲突案件（conflict case）** | 同分平局时 fail-closed 产生的、带完整证据快照的待审记录 | 不是「一条错误日志」 |
| **裁决（adjudication）** | **人**在带 `expectedRevision` 与理由的前提下选择候选的动作 | 模型**不能**调用 |
| **召回（recall）** | 针对当前 query 生成候选视图的**只读**派生过程 | 不是「把存过的记忆都读一遍」，不是「事实」 |
| **legacy（历史格式）** | v1 的 Markdown 段落被投影成的事实，参与展示与冲突检测、**不参与自动晋升** | 不是「待清理的脏数据」 |
| **作用域（scope）** | `user`（跨项目，`~/.nanowork/user-memory/`）/ `workspace`（`<工作目录>/.nanowork/memory/`） | 不是「文件放在哪」这么简单——owner、写入方、保留策略都不同 |

---

## 12. 对标验收总表（「与 WorkBuddy 一样」的逐项确认）

| WorkBuddy 机制 | 本项目需求 | 本项目设计 | 判据（可验证） |
|---|---|---|---|
| M1 三层作用域隔离 | FR-M1 / FR-M4 / FR-M24 | §4.1 / §4.2 / §4.7 | 两个工作区的事实互不可见（`workspaceId` 校验拒绝不匹配）；用户级换工作区仍可读 |
| M2 每日日志 append-only | FR-M1 / FR-M2 / FR-M3 | §4.1 / §4.2 | `daily/*.jsonl` 每行一事实；`distill` 前后文件行数不变（不变量 I1） |
| M3 精炼记忆（蒸馏 + 30 天 + 上限） | FR-M5 – FR-M9 / FR-M10 | §4.3 / §4.6 | 无 API key 可跑的蒸馏门槛单测；超 30 天日志核心内容进 `MEMORY.md`；注入有硬预算 |
| M3 冲突域与替代门槛 | FR-M2 / FR-M8 / FR-M9 | §4.3 | 「20 岁 → 25 岁」单条高重要度**不能**直接覆盖；两条独立事实 + 更新更晚才替代 |
| M3 fail-closed + 人工裁决 + 审计 | FR-M11 – FR-M15 | §4.4 | 同分不动现状并建案；五条校验失败抛陈旧错误；incumbent 不产生新修订（I5） |
| M3 事务与重启恢复 | FR-M16 – FR-M19 | §4.5 | 八个写入边界故障注入后重启：前滚或不动，无重复审计行（I10） |
| M4 用户画像（只读语义）+ 用户级偏好 | FR-M20 – FR-M23 | §4.7 | Profile 字段级 patch + 类型约束；Preference 键级幂等 + expiry + 来源不可伪造 |
| M5 历史对话检索 | FR-M25 – FR-M30 | §4.8 | 自包含 query 必填；hit 带 scope/provenance/score breakdown；并列排序确定；召回零写入（I7） |
| M6 治理（查看/编辑/删除/关闭/定期清理） | FR-M31 – FR-M35 | §4.9 / §4.10 | 记忆页三视图；单条停用生效；30 天归档可审计且不删证据 |
| 「存下来 ≠ 都送进 prompt」 | FR-M10 / NFR-M6 | §4.6 | 注入条目数不随日志天数增长；`superseded` 与冲突候选永不入 prompt（I8） |
| —— 非目标（不要求） | — | — | 向量检索、服务端画像学习、跨设备记忆同步（§10） |
