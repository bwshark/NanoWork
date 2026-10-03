# 增量架构设计：记忆体系 v2（结构化事实 · 蒸馏 · 冲突裁决 · 用户画像 · 召回）

> **配套**：需求依据 `docs/prd-memory-v2.md`；开发计划 `docs/plan-memory-v2.md`。
> **前置**：`docs/prd-memory.md` / `docs/architecture-memory.md`（v1，**不废止**，其已落地机制全部保留，见 §11）。
> **唯一事实源**：`docs/nanowork-prd-design-v2.md`。本文与其第 14 章冲突时以它为准，与**代码**冲突时以代码为准。
> **状态**：增量（待实施）。
>
> **对标**：WorkBuddy 记忆机制（博客园 `xiaobaiysf/p/21866387`）+ `learn-workbuddy` 的
> `s10_workspace_memory` / `s11_user_memory` / `s12_cloud_memory` 教学实现。§2 给出一一映射。

---

## 1. 现状与设计边界

### 1.1 现状代码基线（实测，非文档转述）

| 关注点 | 现状所在 | 现状形态 |
|---|---|---|
| 记忆服务 | `src/lib/memory.ts`（1049 行） | `MemoryServiceImpl` 单例；`load` / `save` / `clear` / `append` / `listFiles` / `readFile` / `writeFile` / `removeFile` / `loadForInjection` / `composeMemoryForInjection` / `wrapForInjection` / `summarize` / `countEntries` / `writeVersion` |
| 目录约定 | `src/lib/workspaceMemory.ts` | `MEMORY.md` + `YYYY-MM-DD.md`；`sortMemoryFileNames` / `mergeMemoryFiles` / `isMemoryFile(Name)` / `isWritableMemoryFileName` / `dailyMemoryFileName` |
| 段落 LWW | `src/lib/memoryMerge.ts` | `splitBlocks` / `blockKey` / `parseMemory` / `renderMemory` / `mergeMemory` / `diffRemovedKeys`（同步用，段级 2P-Set + 墓碑） |
| Agent 写入协议 | `src/lib/memoryDirective.ts` | `<memory-save scope="user\|workspace">` 解析 / 剥离 / `MEMORY_WRITE_INSTRUCTION` |
| 类型 | `src/types/memory.ts` | `MemoryMeta` / `MemoryState` / `MemoryScope` / `MemoryDirective` / `MemoryScopeSummary` / `MemoryAppendOptions` |
| 平台契约 | `src/platform/types.ts:462` `WorkspaceMemoryFiles` | `list` / `read` / `write` / `remove` / `removeAll` / `migrateLegacy`——**按 `workdir` 定位一个目录** |
| 主进程 | `electron/memoryRoutes.ts`、`electron/workspaceMemoryStore.ts` | 路径解析（`resolveWorkspaceMemoryDir` / `resolveMemoryFile` / `resolveLegacyMemoryFile`）+ fs（`listMemoryFiles` / `readMemoryFile` / `writeMemoryFile` / `removeMemoryFile` / `clearMemoryFiles` / `migrateLegacyMemory`） |
| 注入接线 | `src/stores/sessionsStore.ts:1329` `loadMemoryInto`、`:1375` `isMemorySnapshotStale`、`:691-716` `streamAssistantReply` 0.1 | 会话级快照 + 版本失效 |
| 自动沉淀 | `src/stores/sessionsStore.ts:1147` `sedimentSession` | 触发点 `deleteSession(s)` / `createSession` 补触发 |
| UI | `src/pages/memory/MemoryPage.tsx`、`src/components/settings/sections/MemorySection.tsx`、`src/components/MemoryBar.tsx` | 文件编辑器形态（作用域切换 + 文件切换 + 编辑/导出/清空/回滚） |
| 开关 | `src/types/settings.ts:51,53`、`src/stores/settingsStore.ts:127,135`（persist `version: 13`） | `memoryEnabled` / `autoSummarize`，默认 `true` |
| 段落常量 | `src/lib/constants.ts:176,179,182,212` | `MEMORY_KEY_PREFIX` / `MEMORY_TAG_OPEN` / `MEMORY_TAG_CLOSE` / `USER_MEMORY_KEY` |
| 事件存储 | `src/events/store.ts`（`EventStore`）、`src/events/project.ts`（`activePath` / `projectMessages`）、`src/events/index.ts`（`getEventStore()`） | 召回语料的唯一来源 |
| 测试 | `tests/memoryService.test.ts`(721) 等 **9 个文件约 1900 行** | 回归底线，**不得删改语义** |

### 1.2 设计边界（本文**不**动的东西）

1. **落点不变**：工作区级仍是 `<工作目录>/.nanowork/memory/`（与 WorkBuddy `.workbuddy/memory/` 同构）。不往用户项目里塞产品文件的取舍（`prd-memory.md` §6.1）继续成立。
2. **注入标签与协议不变**：`<!-- MEMORY -->` / `<!-- /MEMORY -->` / `<!-- SUMMARY:<hash> -->` / `<memory-save>` / 两个开关，全部继续有效（`nanowork-prd-design-v2.md` §14.2「现有机制设计良好，予以保留」）。
3. **渲染层零 `electron`**（ADR-019）：所有 IO 经 `platform.*`。
4. **引擎侧零改动**：不给 nanobot 增 `[LOCAL PATCH]`（`docs/upstream-merge-conflicts.md` 的清单不再变长）。
5. **同步不阻塞本次**：与 `src/sync/` 的接线放 Phase 5，见 §10。

---

## 2. WorkBuddy 机制 → 本项目落点映射

| WorkBuddy 机制 | 本文档落点 | 需求 |
|---|---|---|
| `MemoryFact`（kind / importance / memory_key / evidence） | §4.1 `MemoryFact` + `<workdir>/.nanowork/memory/daily/YYYY-MM-DD.jsonl` | FR-M1, FR-M2 |
| 显式 `DistillPolicy` 门槛 | §4.3 `distillFacts(facts, policy, now)` 纯函数 | FR-M5 |
| `curated.json` 策展状态 + 修订链 | §4.3 `CuratedEntry` / `CuratedState` | FR-M6 – FR-M9 |
| 同分 fail-closed + `MemoryConflictCase` | §4.4 `ConflictCase` / `conflicts.json` | FR-M11, FR-M12 |
| `resolve_conflict` + 陈旧保护 + 审计流 | §4.4 `resolveConflict` + `conflict-adjudications.jsonl` | FR-M13 – FR-M15 |
| 五阶段 transaction journal + 重启前滚 | §4.5 `transaction.ts` + `conflict-resolution-transactions.jsonl` | FR-M16 – FR-M19 |
| `MEMORY.md` 作为可重建投影 | §4.6 `renderCuratedProjection` | FR-M10 |
| s11 Profile（字段级 patch） | §4.7 `profile.json` + `updateProfile` | FR-M20 |
| s11 Preference（key + expiry + provenance） | §4.7 `preferences.json` + `setPreference` | FR-M21 – FR-M24 |
| s12 `RecallQuery/Candidate/Score/Hit/Result` | §4.8 `src/lib/recall.ts`（**实施时合成单文件**，见 §13.1 的落地偏差） | FR-M25 – FR-M30 |
| 有界注入（精简 MEMORY.md + 最近 ≤6 条） | §4.6 `buildInjectionBlock` + 预算裁剪 | FR-M10, FR-M29 |
| 治理（查看/编辑/删除/关闭、冲突待审、30 天清理） | §4.9 `/memory` 页事实视图 + 保留策略 | FR-M31 – FR-M36 |

---

## 3. 总体架构

```
                       ┌──────────────────────── 注入路径（有界） ────────────────────────┐
                       │                                                                  │
 会话事件流(EventStore) │  user 侧:  profile.json ──┐                                       │
        │              │            preferences.json ──┤                                   │
        │              │            curated(user).json ─┤  renderActive / 预算裁剪          │
        │              │                              └──► MemoryContextBlock ──► system 段末尾
        │              │  workspace 侧: daily/*.jsonl ──► curated.json ──► MEMORY.md(投影) ─┘
        │              │                     ▲                 │
        │              │        distill()    │                 │ resolveConflict()
        │              │   （显式策略，无模型） │                 │ （人，带 revision + eventId）
        │              │                     │                 ▼
        │              └──────────────► conflicts.json + 审计流 + 事务 journal
        │
        └──► 召回路径（只读）：normalize → candidate → score → stableRank → render ──► 本轮 system 段的 <recalled_context> 块
```

**三条互不混淆的链路**：

| 链路 | 输入 | 输出 | 是否写盘 | 是否调模型 |
|---|---|---|---|---|
| **写入**（证据） | 模型 `<memory-save>` / 自动沉淀 / 用户「记住这条」/ 显式 API | 追加 `daily/*.jsonl` 一行 | 是（纯追加） | 仅自动沉淀路径 |
| **蒸馏**（证据 → 结论） | `daily/*.jsonl` + 既有 `curated.json` | 新 `curated.json` + 可能新建 `conflicts.json` case + 重建 `MEMORY.md` | 是（多文件，走事务） | **否**（显式策略） |
| **注入 / 召回**（结论 → prompt） | `curated.json` + `preferences.json` + `profile.json` | `<!-- MEMORY -->` 块 / `RecallResult` | **否** | 否 |

---

## 4. 详细设计

### 4.1 数据模型：事实（证据层）

`src/types/memory/` 新增（按关注点拆文件，避免再造一个千行 `memory.ts`）：

```ts
// src/types/memory/fact.ts
export type FactKind = 'decision' | 'convention' | 'pitfall' | 'outcome';
export type FactSource = 'agent' | 'user' | 'auto' | 'remote';
export type FactOrigin =
  | 'manual'        // 用户「保存为记忆」/ 记忆页手工新增
  | 'memory-save'   // 模型 <memory-save> 协议
  | 'sediment'      // 会话结束自动沉淀
  | 'legacy'        // v1 Markdown 段落投影（不参与自动晋升）
  | 'import'        // FR-M35 bundle 导入
  | 'dream';        // 引擎 Dream 产物采样（FR-M37，只作候选证据）

/** 记忆的**原子单位**：一条结构化事实（对应 s10 的 MemoryFact） */
export interface MemoryFact {
  factId: string;              // 稳定 id：`f_` + hash(workspace_id + kind + key + content + observed_at)
  workspaceId: string;         // 归属（由 workdir 归一化 + hash 得出，见 §5.3）
  kind: FactKind;
  content: string;             // 归一化后非空，≤ 2000 字符
  importance: 1 | 2 | 3 | 4 | 5;
  memoryKey?: string;          // 冲突域，形态 ^[a-z0-9]+([._-][a-z0-9]+)*$，≤ 64
  source: FactSource;          // 谁提供
  origin: FactOrigin;          // 从哪条链路来的（诊断用）
  evidence?: string;           // 自由文本证据，≤ 500（文件/会话/工具名）
  sourceEventId?: string;      // Harness provenance：事件流 event id，模型不可伪造
  observedAt: string;          // ISO（含时区，统一存 UTC）
  schema: 2;                   // 记录级 schema 版本
}

/**
 * 事实 → 冲突域键（**唯一的键推导入口**，§4.3 用它分组）。
 *
 * `EntryKey` 是**内部键**，形态含 `:`，因此**不受 FR-M2 的 `memory_key` 正则约束**——
 * 那条正则管的是「人/模型提供的 `memoryKey`」（`^[a-z0-9]+([._-][a-z0-9]+)*$`）。
 * 三个命名空间刻意分开，任何一个都不会与另一个互相替代：
 * - `k:` 显式 key（人会持续用同一个 key 表达同一个问题）
 * - `d:` 派生键（无 key 时按 kind + 归一化内容，只合并 evidence，不跨内容替代）
 * - `l:` v1 Markdown 段落（只读 legacy）
 */
export function entryKeyForFact(fact: MemoryFact): EntryKey {
  if (fact.memoryKey) return `k:${fact.memoryKey}`;
  return `d:${fact.kind}:${hashContent(normalizeForDedup(fact.content))}`;
}

/** 冲突域稳定键（**内部键，不受 FR-M2 的 memory_key 正则约束**） */
export type EntryKey =
  | `k:${string}`        // 显式 memory_key
  | `d:${string}`        // 派生键（无显式 key：kind + 归一化内容）
  | `l:${string}`        // v1 Markdown 段落（legacy）
  | `x:${string}`;       // 域级墓碑（该域被用户删除，见 §4.3 步骤 6）
```

**校验（fail-closed，任一条不合格则整条拒绝、不部分写入）**：

| 字段 | 规则 |
|---|---|
| `kind` | 必须命中四个枚举之一 |
| `content` | trim 后非空、≤ 2000 字符；`looksLikeSystemError()` 命中即拒绝（复用 v1 判据，三道防线下沉到事实入口） |
| `importance` | 整数 1–5；缺省按 `kind` 推定（decision 4 / convention 4 / pitfall 4 / outcome 2） |
| `memoryKey` | 可选；命中正则且 ≤ 64；**不要求语义正确**（key 是「回答哪个问题」，由写入方负责） |
| `observedAt` | 可解析 ISO；缺省 `now`；**不得晚于**调用方容差内的未来（> 5 分钟即拒绝，防时钟漂移污染 `last_seen` 比较） |

### 4.2 存储布局与所有权

```
<workdir>/.nanowork/memory/                        ← 工作区级（**落点不变**）
├── MEMORY.md                                      [投影] 人读 + 兼容 v1
├── YYYY-MM-DD.md                                  [证据·v1 兼容] 继续可读，不再新写
├── daily/
│   └── YYYY-MM-DD.jsonl                           [证据] 结构化事实，append-only
├── curated.json                                   [canonical] 策展状态（修订链）
├── conflicts.json                                 [canonical] 冲突案件快照
├── conflict-adjudications.jsonl                   [证据] 人工裁决审计流
├── conflict-resolution-transactions.jsonl          [证据] 事务阶段事件
└── archive/                                       [归档] 超期事实（Phase 4）

~/.nanowork/user-memory/                           ← 用户级（**新目录**，取代单文件）
└── <scope-id>/
    ├── daily/
    │   └── YYYY-MM-DD.jsonl                       [证据] 身份类事实的原始证据（同构工作区级，见 §12 Q4）
    ├── profile.json                               [canonical] 结构化画像
    ├── preferences.json                           [canonical] keyed 偏好全集（含过期）
    ├── curated.json                               [canonical] 用户级策展修订（身份类事实的蒸馏产物）
    ├── conflicts.json                             [canonical] 用户级冲突案件
    ├── conflict-adjudications.jsonl               [证据]
    ├── conflict-resolution-transactions.jsonl     [证据]
    ├── MEMORY.md                                  [投影] 偏好 + 活跃修订（人读 + 注入）
    ├── user.md                                    [投影] 画像（人读）
    └── MEMORY.md.migrated                         [留档] v1 单文件搬迁后的原件（只读，不是记忆）
```

> **两级的结构刻意同构**（都有 `daily/` / `curated.json` / `conflicts.json` / 两个 journal / 投影），
> 差别只在 owner 与投影内容：用户级多 `profile.json` 与 `preferences.json`，且**没有** `MEMORY.md` 的
> Markdown 证据兼容需求（v1 的用户级本来就是单文件，见 §9 迁移）。同构的好处是 `distillFacts` /
> 事务 / 恢复这三套机制**只有一份实现**，作用域只是换一个 `ref`。

| 文件 | 身份 | 写入方式 | 能否作为证据 | 失败语义 |
|---|---|---|---|---|
| `daily/*.jsonl` | 原始事实日志 | 单行 JSON + 追加 | 是 | 追加失败 → 该条事实不存在，调用方知悉（`appendFact` 抛错） || `curated.json` | 策展状态机器真相 | 临时文件 + 落盘 + 原子替换 | 可追溯到 `evidence_ids` | 替换失败 → 旧版本保持不变 |
| `conflicts.json` | 待审与历史冲突快照 | 临时文件 + 原子替换 | 是（含候选、revision、fingerprint） | 同上 |
| `conflict-adjudications.jsonl` | 人工裁决审计流 | 单事件追加 | 是（actor / rationale / 选中证据） | 追加失败 → 由事务 journal 前滚重试 |
| `conflict-resolution-transactions.jsonl` | 多文件裁决恢复日志 | 阶段事件追加 | 是（intent hash + 前后快照） | 同上 |
| `MEMORY.md` / `user.md` | 面向人与 prompt 的派生视图 | 从 canonical 原子重建 | **否**，随时可重建 | 修复失败 → 上抛，不把旧投影当成功 |
| `profile.json` / `preferences.json` | 用户级 canonical | 临时文件 + 原子替换 | 是 | 替换失败 → 旧版本保持不变 |

**v1 数据的处置**（FR-M3）：

- `MEMORY.md` 与 `YYYY-MM-DD.md` **原样保留**，继续被读取与注入（`mergeMemoryFiles` 的既有排序不变）；
- 首次遇到旧格式时，把每个 Markdown 段落**投影成一条 legacy fact 内存对象**（`kind: 'convention'`、`importance: 3`、`origin: 'legacy'`、`memoryKey` 派生、`observedAt` 取块首时间戳或文件 mtime），**只用于展示与冲突检测，不写回文件**（避免改写用户原文）；
- legacy fact **不参与自动晋升**（避免把「过程记录」误当「稳定结论」再次入库），但**参与去重与冲突提示**；
- 记忆页对 legacy 条目显示「历史格式」角标。

### 4.3 蒸馏（证据 → 结论）

`src/lib/memory/distill.ts`——**纯函数，无 IO、无 platform、无模型**：

```ts
export interface DistillPolicy {
  retentionDays: number;              // 默认 30
  minImportance: number;              // 默认 4
  repeatThreshold: number;            // 默认 2（同一归一化内容出现次数）
  supersessionRepeatThreshold: number;// 默认 2（独立事实确认数）
  promotableKinds: FactKind[];        // 默认 ['decision','convention','pitfall']
}

export interface CuratedEntry {
  entryKey: EntryKey;      // 冲突域稳定键（形态见 §4.1 的 EntryKey；不是 memory_key 本身）
  memoryKey: string;       // 显式 key（`k:` 域）或派生键字符串（`d:`/`l:` 域，仅用于展示与诊断）
  kind: FactKind;
  revision: number;        // 从 1 起，连续
  status: 'active' | 'superseded' | 'disabled';
  content: string;
  importance: number;
  evidenceIds: string[];   // 不可变来源集合
  evidenceCount: number;   // 独立事实数（= evidenceIds 去重后长度；排序用，冗余存）
  firstSeen: string;       // ISO
  lastSeen: string;        // ISO，替代比较的基准
  supersedes?: number;     // 指向旧 revision
  supersededBy?: number;   // 指向新 revision
  disabledReason?: string;  // FR-M34
}

export interface CuratedState {
  schema: 2;
  workspaceId: string;
  revisions: CuratedEntry[];   // 全部修订（含历史），active 由 status 判定
  renderedAt: string;
}

export interface DistillReport {
  promoted: number;
  merged: number;          // 只合并 evidence，未产生新修订
  superseded: number;
  conflicts: number;       // 本次新发现的同分冲突
  queuedConflicts: number; // 实际新建/推进的 case 数
  conflictCaseIds: string[];
  stale: number;           // 因时间不新被拒绝的候选
  skipped: number;         // 未过门槛
  truncated?: number;
}

export function distillFacts(
  facts: readonly MemoryFact[],
  prev: CuratedState,
  policy: DistillPolicy,
  now: Date,
): { next: CuratedState; cases: ConflictCase[]; report: DistillReport };
```

> **纯函数契约（硬约束，NFR-M12）**：本模块**不读时钟、不读随机数、不读 `locale`、不依赖 Map 迭代顺序**。
> 所有时间来自 `now` 与 `evidence.observedAt`；所有集合在返回前排序。实施后必须有一条
> 「打乱 facts 输入顺序 → canonical JSON 逐字节相同」的测试（见 §4.3.1 的确定性契约）。

**算法（逐条对应 s10）**：

```
1. 过滤：observedAt ≤ now - retentionDays；kind ∈ promotableKinds
2. 分组：
   有 memoryKey → 按 `k:<memoryKey>` 建冲突域
   无 memoryKey → 按 `<kind> + normalizeForDedup(content)` 建独立键
3. 门槛：importance ≥ minImportance  OR  组内归一化内容出现次数 ≥ repeatThreshold
4. 对每个冲突域：
   active = prev 中 status==='active' 的修订（无则本域首次策展）
   candidates = 通过门槛的事实，按（importance DESC, evidenceCount DESC, observedAt DESC）排序
   ┌─ 无 active：最高分候选 → 新建 revision 1（active）
   ├─ 唯一最高分，且其 content 与 active.content 归一化后相同 → 只合并 evidenceIds（merged++）
   ├─ 唯一最高分，内容不同：
   │     门槛① 该候选自身通过步骤 3
   │     门槛② 独立事实数 ≥ supersessionRepeatThreshold
   │     门槛③ 候选最新 observedAt **严格晚于** active.lastSeen
   │     全满足 → 新 revision = active.revision + 1，active → superseded，
   │              双方 supersedes / supersededBy 互指（superseded++）
   │     任一不满足 → 拒绝，记 stale++（时间不新）或 skipped++（证据不足）
   └─ 最高分**并列**（importance 与 evidenceCount 与 observedAt 全相同）：
         fail-closed：active 不动，创建/推进 ConflictCase（conflicts++, queuedConflicts++）
5. 幂等：同 (facts, prev, policy, now) 必得同一结果；重复跑不新增修订、不重复合 evidence
6. 返回前校验：每个冲突域**至多一个** `status='active'`、`revision` 连续、前后链接互配 → 否则抛
   `CorruptCuratedStateError`。**「至多」而不是「恰好」**（2026-10-02 修正）：FR-M31 的真删与
   FR-M34 的停用都必须能让一个域合法地**没有 active**，否则用户点一次「停用」就会让整个 store
   被判损坏、记忆页与注入一起不可用——治理动作把系统打死。两种终态显式定义：
   - **停用（disabled）**：该修订转 `status='disabled'` + `disabledReason`，域内**没有** active。
     不注入、可恢复（改回 active 即重新生效）。
   - **删除**：从 `revisions` 里移除该修订，并**追加一条域级墓碑记录**（`status='disabled'`、
     `content=''`、`deletedAt`、`reason`）留在 canonical 里，使「这个域被用户删掉了」这一事实
     在域内可表达（空域 ≠ 损坏），也便于 FR-M35 导出与审计。
   两种终态都对 `distillFacts` 可见：**域被停用/删除后，新事实不得自动把它复活**，只能进
   `ConflictCase` 等人工裁决（否则用户删掉的东西会被下一次蒸馏写回来——这正是
   `memoryMerge.ts:186-189` 用段级墓碑解决的同一类问题）。
```

**legacy 域的特殊规则**：`l:` 键的域**不与其他域互相替代**（避免把「补充新信息」误当「更新」——这正是 v1 用软约束绕开的坑，现在由命名空间硬隔离解决）。

#### 4.3.1 确定性契约（2026-10-02 补齐，§10 的跨设备收敛依赖它）

`distillFacts` 被称为「纯函数」，但原设计有六处未钉死，任一处不确定都会让「同一份证据 → 同一份 `curated.json`」不成立：

| # | 未钉死点 | 现在钉死为 |
|---|---|---|
| 1 | `CuratedState.renderedAt`（谁产生、是否读时钟） | **取 `now` 参数，不读系统时钟**。它进 canonical 会被逐字节比较，所以必须由调用方给定的 `now` 决定。（阅读器不依赖它做任何判定。） |
| 2 | `evidenceIds` 顺序 | **排序后存储**（按 `factId` 字典序，用 `<` 而非 `localeCompare`）。否则 JSONL 到位顺序不同 → 数组不同 → 文件不同 |
| 3 | `lastSeen` / `firstSeen` 推导 | `firstSeen = min(evidence.observedAt)`、`lastSeen = max(evidence.observedAt)`。**不是 `now`**：用 `now` 会让 FR-M6 幂等破产，且 FR-M8 门槛③（候选严格晚于 active.lastSeen）会**随时间自己变严**，同一条事实今天不能替代、明天就能，行为不可复现。另：`factId` 的哈希**必须含 `evidence`**（实施时踩到的真实 bug）——否则「同一分钟里从两个不同来源确认同一件事」会得到同一个 id，被当成一条事实，于是替代门槛的「独立事实数 ≥ 2」**永远凑不够**，报告里只看到 `skipped` 而看不出原因 |
| 4 | `createMemoryFact` 的「缺省 `now`」与「纯函数」矛盾 | 函数签名显式带 `now: Date`；**校验本身不读时钟**。「缺省当前时间」的便利只存在于**调用侧 wrapper**（`appendFact`），不在纯函数里 |
| 5 | `setPreference` 的 `updatedAt?: string` 缺省 | 同上：`setPreference(state, key, value, opts, now)` 显式传 `now`；`opts.updatedAt` 缺省时取 `now`，但**由参数传入** |
| 6 | 跨时区落哪个日文件 | `dailyMemoryFileName` 用**本地时间**（`src/lib/workspaceMemory.ts:104-111`，v1 的刻意选择：文件名要对得上用户心里的「今天」），而 `observedAt` 存 UTC。两者并存是**有意的**，代价是「同一 UTC 时刻在不同时区落到不同日文件」。因此**读取侧不得假设 `daily/<某一天>.jsonl` 就是全部**——`loadFacts(since)` 一律枚举日期文件（按名升序）后过滤 `observedAt`，写入侧才用本地日名 |
| 7 | **写入按哪个日名分片**（2026-10-02 实施时定稿） | 事实落进**它自己 `observedAt` 那一天**的日文件（`dailyFactLogFileName(fact.observedAt)`），**不是**写入时刻那一天。理由有二：① 一条三年前的决策仍应落在它发生那天的日志里，而不是「今天」——否则「回溯补录一条旧事实」会把历史搅乱；② 去重因此只需查那**一个**文件（同一 `factId` 必然同 `observedAt`、必然同日），而按「最近 N 天」扫窗口会把老事实整个漏出扫描范围，让「同一事实重复写入」永远判不出来——这是实施时踩到并修掉的一个真实 bug |

**排序比较一律用 `<`**（沿用 `src/lib/workspaceMemory.ts:134-138` 的理由）：`importance DESC → lastSeen DESC → entryKey ASC`（§4.6 裁剪）与 `memoryId ASC`（§4.8 排序）中所有字符串比较都用 `<`，**禁用 `localeCompare`**——中文环境下按读音排序会把一致的结果变成随 locale 变化的结果。

**复用判据的模块归属**（NFR-M1）：`looksLikeSystemError` 现在住在 `src/lib/memory.ts:175-181`，而该文件 `import` 了 `@/platform` 与 `@/ai/connectionManager`（`:1-2`）——把事实校验放进那个模块就违反「纯函数、无 platform、无 IO」。故实施时把它（连同 `normalizeForDedup` / `parseEntryBodies` / `cjkRatio` 等判据）**搬到纯模块**（`src/lib/memory/detect.ts`），`src/lib/memory.ts` 转出保持既有引用可用。

**`hashContent` 的位宽**（修正）：它是 32 位 djb2、最多 **8** 个 hex（`src/lib/workspaceKey.ts:30-36`），不是原设计写的「前 16 位」。故 `workspaceId` / `scope-id` / `factId` / `conflictId` 的实际形态是 `w_<8hex>`、`u_<8hex>`、`f_<8hex>` 等——**不要写成 16 位**（会以为存在一个不存在的长度）。8 hex 的碰撞面在「单工作区数千条事实」规模下可接受；若将来要更宽，做法是**换一个哈希函数**（`hashContent` 加宽）而不是拼接两个 8 位（那会破坏「同内容同值」）。

### 4.4 冲突与人工裁决

```ts
// src/types/memory/conflict.ts
export interface ConflictCandidate {
  candidateId: string;      // `c_` + hash(entryKey + revision + content)
  entryKey: string;
  content: string;
  revision: number;         // 候选若胜出将写入的 revision
  evidenceIds: string[];
  importance: number;
  lastSeen: string;
}

export interface ConflictCase {
  conflictId: string;       // 确定性：hash(workspaceId|userScope + memoryKey + evidenceFingerprint)
  revision: number;         // 同一 memoryKey 的案件版本
  status: 'open' | 'resolved' | 'superseded';
  memoryKey: string;
  candidates: ConflictCandidate[];   // incumbent 与 challenger
  evidenceIds: string[];
  observedFactIds: string[];         // 检测时该域的全部事实
  activeEntryKey: string | null;     // 检测时的 active 修订
  evidenceFingerprint: string;       // hash(排序后的 observedFactIds)
  detectedAt: string;
  resolvedAt?: string;
  resolution?: { candidateId: string; actor: string; eventId: string; resultEntryKey: string | null };
}
```

`src/lib/memory/adjudicate.ts`：

```ts
export interface ResolveConflictInput {
  conflictId: string;
  candidateId: string;
  expectedRevision: number;   // 调用方刚看到的 case revision
  actor: string;              // 人（界面账号 / "local-user"）
  rationale: string;          // 非空
  eventId: string;            // 幂等键，必须由 harness/UI 生成
}
export class StaleConflictResolutionError extends Error {}
export class ConflictEventReuseError extends Error {}
```

**执行前重新校验五条**：

| # | 校验 | 不满足时抛 |
|---|---|---|
| 1 | case 仍 `open`，且 `case.revision === expectedRevision` | `StaleConflictResolutionError` |
| 2 | 当前 active entry 仍是检测时的版本（`activeEntryKey` 一致） | `StaleConflictResolutionError` |
| 3 | 当前 workspace 的 `observedFactIds` 与 `evidenceFingerprint` 快照一致 | `StaleConflictResolutionError` |
| 4 | `candidateId` 确实属于该 case | `StaleConflictResolutionError` |
| 5a | `eventId` **同参**重试（value 与 rationale 与候选全同） | 不抛错：**返回原事件**（幂等） |
| 5b | `eventId` 已被用于**另一种**裁决（同 id、不同参数） | `ConflictEventReuseError` |

> 两类错误刻意分开（2026-10-02 对齐）：1–4 是「你看的东西旧了」（要求重看），5b 是「这个幂等键已被占用」
> （要求换一个 key）——两者的处置动作完全不同，合成一个异常会让调用方不知道该刷新还是该换 key。

**分支语义**（FR-M14）：

| 选择 | canonical 动作 | 审计 | 修订 |
|---|---|---|---|
| challenger | 创建 `revision + 1` active；旧版 `superseded` | 追加（含 `resultEntryKey` = 新 entryKey） | **+1** |
| incumbent | 仅把 case 置 `resolved` | 追加（`resultEntryKey` = 原 entryKey） | **0**（保持现状不制造虚假修订） |

**权限边界（硬约束）**：`resolveConflict` / `listConflicts(open)` **不出现在模型的工具列表**。候选内容不能给自己授予裁决权。**同时，本项目没有任何「客户端工具注册」通道**——模型可见的工具由引擎（nanobot）下发，客户端加一个工具就要给引擎打 `[LOCAL PATCH]`（本次明确为 0 个）。因此 v2 的**记忆读写一律走正文协议，不新增模型工具**：

| 能力 | 通道 | 与 v1 的关系 |
|---|---|---|
| 写入一条记忆 | `<memory-save scope="…" key="…" kind="…">` 正文块 | v1 已有，只加可选属性 |
| **召回历史** | **客户端按轮触发**：发送前用本轮用户消息（+ 最近一轮上下文）作为 `query`，把召回到的有界 hits 渲染成 `<recalled_context>` 块附在 system 段（与 `<!-- MEMORY -->` 块并列，同开同关） | **新增**，但不需要模型做任何事，也不需要工具 |
| 裁决冲突 | 只有记忆页 UI | 新增，人为入口 |

> **为什么召回不做成「模型调用的工具」**（改动前后都能满足 FR-M25–FR-M30，但代价差一个量级）：
> ① 客户端无工具注册通道，做成工具必然要动引擎（违反 §1.2 边界 4）；
> ② 即便能加工具，它要求**模型自己想起来去检索**——而 v1 的实测教训恰恰是「模型看不到就答不出来」
> （`prd-memory.md` §6.7 的快照失效事故）。按轮自动召回把「想不想得起」从模型身上移回 harness，
> 与 §2 原则 1（harness 掌握，模型不掌握）同向。
> **代价（必须接受）**：每轮都付一次召回成本。故 `recall` 有**触发门槛**——query 词项数 < 2、
> 或与上一轮 query 归一化后相同（连续追问）时不召回；命中为 0 时不注入（不产空 wrapper，FR-M29）。
> 语义上这与「模型显式调用 `recall_history`」等价，只是由客户端决定何时调。

### 4.5 事务与重启恢复

`src/lib/memory/transaction.ts`：

```ts
export type TxnPhase = 'prepared' | 'curated_applied' | 'conflict_closed' | 'audit_appended' | 'committed';

export interface ResolutionIntent {
  transactionId: string;
  intentSha256: string;        // 对规范化后的 intent 体算哈希，防篡改
  workspaceId: string;
  conflictId: string;
  candidateId: string;
  eventId: string;
  actor: string;
  rationale: string;
  before: { curated: CuratedState; conflict: ConflictCase };  // 完整快照
  after: { curated: CuratedState; conflict: ConflictCase };
  preparedAt: string;
}

export interface TxnPhaseEvent {
  transactionId: string;
  intentSha256: string;
  phase: TxnPhase;
  at: string;
}
```

**推进顺序**（每阶段**先完成目标写入、再追加阶段事件**）：

```
prepared                  → 追加 intent（含 before/after 全量快照）到 transactions.jsonl
  → curated_applied       → 原子替换 curated.json，再追加阶段事件
  → conflict_closed       → 原子替换 conflicts.json，再追加阶段事件
  → audit_appended        → 追加 conflict-adjudications.jsonl，再追加阶段事件
  → committed             → 追加阶段事件（终态）
```

**崩溃窗口对齐**（NFR-M5 的八个边界 = 5 个阶段事件追加点 + 3 次目标替换的前后）：

| 崩溃点 | 磁盘状态 | 恢复动作 |
|---|---|---|
| `prepared` 之后、`curated_applied` 之前 | curated = before | 重做整条事务 |
| `curated` 替换后、阶段事件前 | curated = after，无阶段事件 | 从 `prepared` 重放：比较 curated —— 等于 after → 视为已应用，继续 |
| `conflict_closed` 阶段 | curated = after，conflict ∈ {before, after} | 逐文件比较：before → 重做该文件；after → 继续 |
| `audit_appended` 阶段 | 审计可能已追加 | **按 `eventId` 去重**，重放不产生重复审计行 |
| 任意状态**既不等于 before 也不等于 after** | 可能已有更新或损坏 | **fail-closed 抛错**（不回滚、不覆盖），交给人工 |

**恢复入口与启动期竞态（2026-10-02 补齐）**：类名统一为 **`MemoryStore`**（原 §4.5 写的 `WorkspaceMemoryStore` 与 §6/§7.1 的 `MemoryStore` 不一致，以前者为准是不对的——`MemoryStore` 是唯一名字）。恢复是**显式的异步步骤**，不是构造函数里的副作用：

```ts
const store = new MemoryStore(ref);        // 纯构造，不碰磁盘、不产生快照
await store.recover();                     // 幂等前滚 + 加载 + 校验（未完成前 store 处于 'recovering' 态）
```

- `recover()` 未完成时，`writeVersion()` 返回 `0` 且 `getContextForInjection()` 抛 `StoreNotReadyError`；
- 调用方（`loadMemoryInto` / 记忆页）必须先 `await recover()` 再读；
- **`isMemorySnapshotStale()` 保持同步**（NFR-M2 / §7.4）：它只比较已经落在 `Session` 上的版本号与 `MemoryService.writeVersion()`，**不触发恢复、不读盘**。这条是「快照判据同步」与「恢复异步」能共存的关键——恢复由**会话创建/首次水合**这条本就异步的路径负责，不在判据里做。

**journal intent 校验**：`intentSha256` 不匹配、阶段跳跃（如缺 `conflict_closed` 直接 `audit_appended`）、`workspaceId` 与当前 store 不一致 → 显式拒绝。

### 4.6 投影与有界注入

`src/lib/memory/project.ts`（纯函数）：

```ts
export function renderCuratedProjection(state: CuratedState, opts?: { includeMeta?: boolean }): string;
export function renderUserMemoryProjection(
  profile: UserProfile,
  prefs: PreferenceState,
  curated: CuratedState,
  asOf: Date,
): string;
```

`renderCuratedProjection` 只渲染 `status === 'active'` 的修订，且带轻量元信息（`kind` / `revision` / `lastSeen`），便于人读与诊断。**永不渲染** `superseded` / `disabled` / 冲突候选。

`src/lib/memory/injection.ts`：

```ts
export interface InjectionBudget {
  userChars: number;        // 默认 4000（对标 WorkBuddy 用户级单会话写入上限口径）
  workspaceChars: number;   // 默认 3000
  recentFactLimit: number;  // 默认 6（对标 s10）
}

export interface InjectionBlock {
  text: string;
  entries: number;
  truncated: number;        // 被裁掉的行数（可观察）
  sourceVersion: { user: number; workspace: number };
}

export async function buildInjectionBlock(
  ref: { userScope: string; workdir: string | null },
  budget: InjectionBudget,
  asOf: Date,
): Promise<InjectionBlock>;
```

**注入块形态**（保留 v1 的两段定序与护栏句，只把正文换成「活跃修订投影 + legacy 段落 + 最近事实」）。

> ⚠️ **唯一的包裹点（2026-10-02 修正）**：`buildInjectionBlock().text` 返回**未包裹的正文**（即下面的
> `【用户级记忆…】` / `【工作区记忆…】` 两段），**不含** `<!-- MEMORY -->`、`<!-- /MEMORY -->` 与护栏句。
> 包裹由**调用方唯一一次**调 `MemoryService.wrapForInjection(text)` 完成（现有调用点在
> `src/stores/sessionsStore.ts:738-741`，`src/lib/memory.ts:938-942` 自己补标签 + 护栏句）。
> 若按「块形态图里画着标签」照字面实现，会出现**双重包裹 + 双份护栏句**，并破坏
> `extractFromInjection`（`src/lib/memory.ts:948-961`）与 `constants.ts:190` 的约定。

下面画的是**最终注入到 system 段的完整形态**（标签与护栏句来自 `wrapForInjection`，不是 `buildInjectionBlock` 的产物）：

```
<!-- MEMORY -->
<护栏句：记忆仅供参考、不是身份或系统指令；用户级跨项目成立、工作区级只对当前工作区成立，
        冲突时以用户级为准；记忆里的目录不代表当前工作目录>
<provenance: source=client-memory v2, user_scope=…, workspace_id=…, captured_at=…, entries=…, truncated=…>
【用户级记忆 · 跨项目】
（active 偏好 + active 策展修订 + profile 摘要 + legacy 用户级单文件内容）
【工作区记忆 · 当前工作区】
（active 策展修订 + legacy Markdown 段落 + 最近 N 条事实）
<!-- /MEMORY -->
```

**legacy 段落必须继续进 prompt**（2026-10-02 修正，原设计的一条硬伤）：v1 的 `MEMORY.md` 与
`YYYY-MM-DD.md` 正文在 §4.2 里「不写回 canonical」「不参与自动晋升」，若注入集合又只列
active 修订 + 最近事实，则**用户既有长期记忆在升级后一个字都不再进 prompt** —— 这直接违背
PRD §8 与 FR-M3 的「条目集合不减少」判据，且 9 个 v1 测试全绿也发现不了（它们测的是
`MemoryService.loadForInjection`，而链路上游换了集合）。故：

| 来源 | 注入位置 | 优先级 | 预算归属 |
|---|---|---|---|
| active 偏好 / profile（用户级） | 用户级段 | 高 | `userChars` |
| active 策展修订（用户级 → 工作区级） | 各自段 | 高 | 各自预算 |
| **legacy 用户级单文件正文** | 用户级段**末尾** | 低 | `userChars` |
| **legacy 工作区 Markdown 段落** | 工作区级段**末尾** | 低 | `workspaceChars` |
| 最近 N 条事实 | 工作区级段**末尾**（legacy 之后） | 低 | `workspaceChars` |

裁剪顺序不变（先裁低优先级）；**legacy 段落是可被预算裁掉的**（否则预算无从成立），但
`truncated` 必须如实计数，且记忆页要显示「有 N 条历史格式内容因预算未注入」。**可执行判据**
（写进 `tests/memory/injection.test.ts`）：同一份 v1 目录，在 `budget` 足够大时
`loadForInjection().entries` 在升级前后**不减少**。

**裁剪优先级**：`importance DESC → lastSeen DESC → entryKey ASC`（确定性，同输入同结果）。`truncated > 0` 时在记忆页显示「因预算截断 N 条」。

**预算硬约束（NFR-M6）**：注入总量**不随 daily 日志天数增长**——日志永远只通过「最近 N 条事实」这一个有界窗口进入。

**快照失效兼容**：`MemoryService.writeVersion()` 语义升级为「本轮已读过的所有 store 版本的组合值」。§7.4 给出精确实现，`isMemorySnapshotStale()` 保持**同步**（NFR-M2）。

### 4.7 用户级：Profile 与 Preference

#### 4.7.0 `userScope` 从哪来（2026-10-02 补齐，原设计缺失）

原设计把 `userScope` 当既有事实用，但**全仓不存在这个标识**（`grep userScope src/` 零命中）。经核验，唯一存在的用户身份是**云端登录态** `SyncAccount.getSession()?.userId`（`src/sync/syncAccount.ts:205`、`src/sync/SyncEngine.ts:679`），未登录归一到 `''`（`src/sync/fileAssets.ts:121,198`）。把记忆目录挂在登录态上会得到两个不可接受的后果：**未登录没有记忆**；**登录后 scope 变化 → I11 拒绝读取既有记忆 → 用户观感「登录后记忆全没了」**。

因此 `userScope` **必须与账户解耦**：

```ts
// src/lib/memory/scope.ts
/** 本地用户作用域：首次使用时生成并持久化，之后永不因登录态变化 */
export function ensureLocalUserScope(): Promise<string>;   // `u_` + 16 hex
```

| 规则 | 内容 |
|---|---|
| 生成 | 首次需要用户级记忆时生成 `u_<16hex>`，写入 `settingsStore`（新增 `localMemoryScope` 字段，随 persist 迁移补默认；**不参与云同步**——见 §7.2 的 `SETTINGS_SYNC_OMIT_KEYS`） |
| 归属 | `scope-id = hashContent(userScope)` 作目录名；canonical JSON 内保存同一个 `userScope`，读取不匹配即拒绝（FR-M24 保持不变） |
| 账户绑定 | 登录**只做绑定映射**（记录「本机 `userScope` ↔ 云端 `userId`」），**不换目录、不迁数据**。云端记忆（Phase 5）落地为一个**额外的只读作用域**，不与本地作用域混写；这样「登录/登出」永远不会让本地记忆变成不可读 |
| 登录前已有数据 | 登录后仍读本地作用域；云端作用域只作附加来源。因此**不存在**「scope 不匹配 → 空记忆」这条路径 |
| 恢复语义（§4.9 的「改作用域」与 I11） | 跨作用域**搬**一条记忆（工作区级 ↔ 用户级）**不是移动文件**：它要在目标作用域**新建一条事实**（`origin: 'manual'`）+ 在源作用域**停用**该修订（FR-M34），并记一条审计。理由：`factId` 含 `workspaceId`、`entryKey` 含作用域前缀，直接搬运会破坏归属校验（I11 不是能靠改文件绕过的校验） |
| 多用户（FR-M24） | 同一根目录下 `u_a` / `u_b` 互不可见；错误复制的 canonical 文件被 `userScope` 不匹配拒绝 |

#### 4.7.1 Profile

```ts
// src/types/memory/profile.ts
export const PROFILE_FIELDS = [
  'name', 'callThem', 'timezone', 'language', 'occupation',
  'organization', 'role', 'city', 'responseStyle',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type UserProfile = Partial<Record<ProfileField, string>>;

export interface ProfileUpdateResult { changed: ProfileField[]; unchanged: ProfileField[]; }

export function applyProfilePatch(
  prev: UserProfile,
  patch: Record<string, string | null>,
): { next: UserProfile; result: ProfileUpdateResult };   // 纯函数，抛出 ProfileValidationError
```

规则（FR-M20，逐条对齐 s11）：只改出现的字段；`null` = 显式删除；schema 外字段报错；值须为归一化后非空、≤1000 字符的**字符串**（数字/布尔/对象不隐式转文本）；**任一字段非法则整体拒绝**；等值 patch 记 `unchanged` 且不重写 JSON（但投影过期仍修复投影）。

```ts
// src/types/memory/preference.ts
export interface PreferenceRecord {
  key: string;                 // ^[a-z0-9]+([._-][a-z0-9]+)*$，≤ 64
  value: string;               // 非空，≤ 1000
  revision: number;            // 从 1 起
  source: 'user' | 'agent' | 'transcript' | 'remote';
  sourceEventId?: string;      // Harness provenance，模型不可提交（FR-M23）
  updatedAt: string;           // ISO UTC
  expiresAt?: string;          // ISO UTC；到达即 expired（FR-M22）
}
export interface PreferenceState { schema: 2; userScope: string; records: PreferenceRecord[]; }

export type PreferenceChange = 'CREATED' | 'UNCHANGED' | 'UPDATED';

export function setPreference(
  state: PreferenceState,
  key: string,
  value: string,
  opts: { source: PreferenceRecord['source']; sourceEventId?: string; updatedAt?: string; expiresAt?: string },
): { next: PreferenceState; change: PreferenceChange };
```

幂等身份 = `value + source + expiresAt + sourceEventId` 全等才是 `UNCHANGED`（不写盘、不加 revision；重试传入更晚时间也**不推进证据时间**）。相同 value 但延长期限或补充新来源 → `UPDATED`（revision + 1）。**时间防回滚规则**：`updatedAt` 严格早于 canonical `updatedAt` 的写入只有在**状态完全相同**（即命中 `UNCHANGED`）时才允许；一旦状态不同，写入时间必须**严格晚于** canonical `updatedAt`，否则拒绝（否则重放旧 transcript 会回滚新偏好）。**无 `sourceEventId` 时的确认语义**（对齐 s11）：显式传入比 canonical `updatedAt` 更晚的时间 = 用户再次确认，即使 value 不变也推进 `updatedAt` 并 `revision + 1`；**不传时间也不传事件 id** 的调用沿用状态去重（程序自动取的当前时间不能证明用户再次确认）。`deletePreference` 按 key 精确删除，不做自然语言模糊匹配。

**多用户/多作用域隔离**（FR-M24）：`scope-id = hash(userScope)` 作为目录名（避免 `/`、空格、邮箱进路径）；canonical JSON 内保存同一 `userScope`，读取时不匹配即拒绝。

**注入投影**：`listActivePreferences(state, asOf)` 是唯一可注入集合；过期记录留在 canonical 以便解释「它曾经为何生效」；历史 `asOf` 查询是纯读取，**不写回当前投影**。

### 4.8 召回（跨会话历史检索）

```
src/lib/recall/
├── types.ts       RecallQuery / RecallCandidate / RecallScoreBreakdown / RecallHit / RecallResult / StoredMemory / MemorySource
├── normalize.ts   normalizeRecallQuery()
├── candidate.ts   buildRecallCandidates()
├── score.ts       scoreRecallCandidate()
├── rank.ts        stableRankRecallCandidates()
├── engine.ts      RecallEngine（只读，编排五阶段）
├── render.ts      renderRecalledContext()（XML，带 provenance 与 score）
└── source.ts      会话事件流 → StoredMemory[] 的适配器
```

契约（FR-M26 – FR-M29）：

```ts
export interface StoredMemory {
  memoryId: string; userScope: string;
  kind: 'conversation' | 'profile_snapshot';
  content: string; summary: string;
  source: MemorySource;   // { sourceId, sourceType, title, capturedAt }
  storedAt: string;       // 进入存储时间（≠ capturedAt）
}
export interface RecallScoreBreakdown {
  matchedTerms: string[]; queryTermCount: number;
  lexicalCoverage: number; recency: number;
  weights: { lexical: 0.85; recency: 0.15 };
  contributions: { lexical: number; recency: number };
  total: number;
}
export interface RecallResult {
  query: RecallQuery;
  hits: RecallHit[];
  searchedRecords: number;
  candidateRecords: number;
  emptyReason: 'no_matching_terms' | null;
}
```

| 阶段 | 规则 |
|---|---|
| `normalize` | 折叠空白 → NFKC → casefold → 空白归一化；英文按词切分；**连续中文补二元字符**（「分层记忆」→ 分层/层记/记忆）。空 query 拒绝；无 searchable term（纯标点）**明确拒绝**（不退化成全量召回） |
| `candidate` | 只读 `kind === 'conversation'` 的记录，且逐条校验 `userScope` 与 query 一致；只保留**存在词项重合**的候选；此阶段无 score / rank，**不写回存储** |
| `score` | `total = 0.85 × lexicalCoverage + 0.15 × recency`，返回**完整 breakdown**（不是孤立数字） |
| `stableRank` | 排序键固定：`total DESC → lexicalCoverage DESC → capturedAt DESC → memoryId ASC`（最后一项消除插入顺序影响） |
| `render` | XML，每个 hit 保留 `query_id` / `scope` / `provenance` / `score_breakdown`；**无匹配返回空串**（不为空 wrapper 消耗预算） |

**语料适配器（`source.ts`）——本项目特有的一步**：

```
getEventStore().listMetas()                          // 全部会话（含未加载的）
  → 对每个 meta：meta.workdir 即事件流**分片**（toMeta 写的，见 sessionsStore.ts:444）
  → getEventStore().readEvents(meta.id, meta.workdir)
  → activePath(events) → projectMessages(path)       // 复用 @/events/project，不发明第二套推导
  → 逐条 user/assistant 消息 → StoredMemory{
       memoryId: `ev:${meta.id}:${messageId}`,
       kind: 'conversation',
       source: { sourceId: meta.id, sourceType: 'session_transcript',
                 title: meta.title, capturedAt: message.createdAt }
     }
  → 语料缓存（进程内 LRU，按会话 id + rev 失效）+ 上限（默认 10000 条）按 capturedAt DESC 裁剪
```

> **为什么用事件流而不是新建一份 history 副本**：`docs/nanowork-prd-design-v2.md` 第 9 章与 ADR-023 把「会话视图的产地必须同源」定为硬约束。召回再建一套语料 = 第三个产地，必然漂移。适配器是**只读投影**，不落盘。

**触发与注入边界**（对照 §4.4 的通道表）：召回**不是模型工具**，而是客户端在装配 system 段时按轮触发的一段只读派生视图。三件事必须成立：

1. **query 自包含**。query 取自**本轮用户消息**（拼接上一轮用户消息作为最短上下文），不依赖「模型当前在想什么」。因此「继续上次」这类表述**在客户端侧就无法构造有效 query**——它会命中 0 条并按 FR-M29 返回空（`empty_reason='no_matching_terms'`），这正是需求要的行为，且不需要靠提示词约束模型。
2. **有界**。注入的 hits 受 `recallBudget`（默认 1200 字符 / 最多 3 条）约束，超限按 `rank` 截断；命中 0 条时**不注入**（不产空 wrapper）。
3. **只读**。召回不写任何 durable store（不变量 I7）；渲染出的块带 `query_id` / `normalized_query` / 每个 hit 的 `scope` / `provenance` / `score_breakdown`，便于审计与「这条从哪来」的追问。

渲染形态（与 s12 的 `render` 阶段同构，落在 system 段、紧邻 `<!-- MEMORY -->` 块）：

```xml
<recalled_context query_id="q_…" normalized_query="定时任务 结论" user_scope="…">
  <hit rank="1" memory_id="ev:<sessionId>:<messageId>" memory_kind="conversation"
       source_id="<sessionId>" source_type="session_transcript" title="…" captured_at="…">
    <score total="0.9952" lexical_coverage="1.000" recency="0.968"
           lexical_contribution="0.850" recency_contribution="0.145"/>
    <snippet>…</snippet>
  </hit>
</recalled_context>
```

### 4.9 治理 UI

`/memory` 页从「文件编辑器」升级为**三视图**（`MemoryPage.tsx` 拆分）：

| 视图 | 内容 | 需求 |
|---|---|---|
| **事实视图**（默认） | 按作用域列出 active 修订：内容 / `kind` / importance / revision / firstSeen / lastSeen / 证据来源（可展开到 `factId`）。逐条操作：**停用**（带理由）/ **删除**（真删 + 审计）/ **改作用域** | FR-M31, FR-M34 |
| **待裁决（N）** | 每个 open case 展示候选与各自证据、检测时间、`revision`；提交时带 `expectedRevision` + 理由。陈旧 → 提示「证据已变化，请重看」并刷新 | FR-M32 |
| **文件**（高级，默认折叠） | v1 的编辑器原样保留（作用域 + 文件切换 + 编辑/导出/清空/回滚） | 兼容 v1 |

`MemoryBar`（「已加载 N 条记忆」）改为显示 `entries` + `truncated`（截断时提示）。

### 4.10 保留与遗忘

| 需求 | 设计 |
|---|---|
| FR-M33 保留 | **三个概念必须分开，别混**（2026-10-02 修正，原文把三个数写在一起造成 30/180 混淆）：<br>① `retentionDays`（默认 **30**）= **蒸馏年龄门槛**——事实必须至少这么老才有资格晋升（`distillFacts` 的第一步，见 §4.3）；<br>② `archiveAfterDays`（默认 **180**）= **日志归档年龄**——某个日期的 `daily/*.jsonl` 整体移入 `memory/archive/`，不再被 `distillFacts` 扫描，但**保留可审计**（这是**文件级**归档，不是「事实级」）；<br>③ `disable` / `delete`（FR-M34 / FR-M31）= **单条事实级**的动作，与上面两个时间参数无关。<br>另外「工作区日志数量上限（默认 180 个日期文件）」是**数量口径的 UI 提示**（超过时提醒用户归档），不是归档判据——判据只有 ②。**丢弃证据 ≠ 蒸馏**：两者代码路径分开，这条对齐 s10「真正的存储清理由单独的 retention/backup 策略负责」 |
| FR-M34 停用 | `CuratedEntry.status = 'disabled'` + `disabledReason`；不注入但保留、可恢复 |
| FR-M35 导出 | 导出 bundle JSON：`{ schema, exportedAt, userScope, workspaceId, facts, curated, conflicts, adjudications, profile, preferences }`；导入时校验 scope 并记 `origin: 'import'` |
| FR-M36 边界 | 记忆页「诊断」入口只读展示引擎侧记忆元信息（路径 + 大小 + mtime），**不解析内容、不注入、不可编辑**；`docs/nanowork-prd-design-v2.md` §14 与 `docs/prd-memory.md` §6.8 补一段收敛说明。**本期只做「边界声明 + 文档收敛」这一半**：渲染层拿不到引擎 workspace 的绝对路径（它由 `nanowork.config.json` 的 `agents.defaults.workspace` 决定，只在主进程可解析），要做只读元信息面板就得再开一条平台读回通道。**该面板推迟到 Phase 5**，届时与 FR-M37 一起做（两者都依赖同一条通道）。本期以记忆页顶部的一段静态说明 + `docs/` 收敛文字兑现 FR-M36 的**认知目标** |
| FR-M37 Dream 候选 | 兑现 v2 §14.3「自动合并的产物必须用户可审查后才生效」：引擎 Dream 产物（`.nanowork-workspace/memory/MEMORY.md` + `history.jsonl` + `.dream_cursor`）只作为**只读证据**采样（`source: 'remote'`、`origin: 'dream'`），其候选**不得**直接成为 active 修订，一律进 open `ConflictCase` 的 challenger 或 `status='pending-review'`，经 §4.4 的裁决流程生效。引擎侧**零写入** |

---

## 5. 存储层改造（平台边界）

### 5.1 为什么不能继续用「按 workdir 定位一个目录」的契约

现契约 `WorkspaceMemoryFiles` 的每个方法都是 `(workdir, ...)`：它把**存储根**与**定位方式**焊死在一起。用户级记忆需要第二个根（`~/.nanowork/user-memory/`），结构化记忆需要 `list` 之外的**原子替换**与**子目录**（`daily/`、`archive/`）。继续沿用只能靠 `workdir` 里塞伪路径，那是把「根」这个语义散进调用方。

### 5.2 新平台契约

```ts
// src/platform/types.ts
export type MemoryStoreRef =
  | { kind: 'workspace'; workdir: string | null }   // <workdir>/.nanowork/memory/ 或兜底目录
  | { kind: 'user'; userScope: string };            // ~/.nanowork/user-memory/<scope-id>/

export interface MemoryFiles {
  list(ref: MemoryStoreRef, subdir?: string): Promise<string[]>;
  read(ref: MemoryStoreRef, name: string, subdir?: string): Promise<string | null>;
  write(ref: MemoryStoreRef, name: string, content: string, subdir?: string): Promise<void>;
  remove(ref: MemoryStoreRef, name: string, subdir?: string): Promise<void>;
  /** 原子替换：写临时文件 → 落盘 → 改名覆盖。与 write 的区别是**绝不暴露半写状态** */
  replace(ref: MemoryStoreRef, name: string, content: string, subdir?: string): Promise<void>;
  /** 单行追加（JSONL 用）：实现侧保证单次 write，不读全文 */
  appendLine(ref: MemoryStoreRef, name: string, line: string, subdir?: string): Promise<void>;
  /** 读取整份 JSONL（按行） */
  readLines(ref: MemoryStoreRef, name: string, subdir?: string): Promise<string[]>;
  removeAll(ref: MemoryStoreRef, subdir?: string): Promise<void>;
}
```

**共享文件名策略**（放 `src/lib/memory/paths.ts`，两端各校验一次——渲染侧是一致性，主进程侧是安全边界，与 v1 同一口径）：

| 位置 | 名称规则 |
|---|---|
| 根 | `MEMORY.md` / `curated.json` / `conflicts.json` / `conflict-adjudications.jsonl` / `conflict-resolution-transactions.jsonl` / `YYYY-MM-DD.md`（v1 兼容、只读） / `user.md` / `profile.json` / `preferences.json` |
| `daily/` | `YYYY-MM-DD.jsonl` |
| `archive/` | `YYYY-MM-DD.jsonl`（只读） |
| 读取宽 | 任意合法单段 `.md` / `.json` / `.jsonl`（用户手放的文件不该被静默忽略——v1 的既有取舍） |
| 写入严 | 上述白名单；其余名字抛错（不是静默降级）。**另需两条迁移专用名**：旧单文件留档 `<name>.md.migrated`（v1 已有的模式，`electron/workspaceMemoryStore.ts:49` 的 `LEGACY_ARCHIVE_SUFFIX`）与 `daily/`、`archive/` 两个子目录；但它们**永远不是写入目标**——留档是 `rename` 的结果，子目录由路径策略固定 |

**`replace` 的实现**：Electron 侧 `writeFile(tmp)` → `flush` → `rename(tmp, target)`（同目录）。⚠️ **两点如实**（2026-10-02 核验修正）：① `fs.rename` 覆盖已存在目标在 **Windows 上可能因句柄占用失败**（`EPERM` / `EBUSY`）——故实现必须**带重试**并在最终失败时清理临时文件、保留旧版本（这不改变契约，只是让「失败时旧版本不变」在 Windows 上真的成立）；② 目录项 `fsync` 在 Windows 不可移植，故**不承诺断电级持久性**，只承诺「不暴露半写状态」。Web 侧没有临时文件与 `rename`：**现有实现是「一个目录一个 `localStorage` key」**（`src/platform/storage.web.ts:64-88`，注释 `:90-101` 解释了为什么需要第二份索引来枚举），故 `replace` / `appendLine` 都是「读整份目录映射 → 改 → 写回」，**多标签页会丢更新**、且**无 `fsync` 级崩溃安全**（NFR-M9 已如实降级，`NFR-M5` 的八个边界在 Web 端不可验证）。**这条能力是 FR-M16 在 Electron 端成立的前提**。

**安全边界不变**：`electron/workspaceMemoryStore.ts` 的三条继续成立——① `lstat` 拒绝符号链接与特殊文件（`MEMORY.md` 被换成指向 `~/.ssh/id_rsa` 的链接会把私钥塞进 prompt）；② 目标必须落在解析后的记忆目录内（`resolve + 前缀比对`）；③ 写入名字白名单是**能力边界**不是提示。

**`platform.memoryFiles` 的兼容**：`WorkspaceMemoryFiles` 保留为**已废弃的薄封装**（内部转调 `MemoryFiles` + `ref`），避免一次性改动 v1 的调用点与测试；标注 `@deprecated` 并在 Phase 2 末清理。

### 5.3 标识符

| 标识 | 生成 | 用途 |
|---|---|---|
| `workspaceId` | `'w_' + hashContent(normalizeWorkspacePath(workdir))`（8 hex，见 §4.3.1 的位宽修正），无 workdir → `'default'` | 事实归属校验：JSONL 记录里带它，读取时不匹配即拒绝（对齐 s10 的 `workspace_id` 校验） |
| `scope-id` | `'u_' + hashContent(userScope)`（8 hex） | 用户记忆目录名（`userScope` 的来源见 §4.7.0） |
| `factId` | `'f_' + hashContent(workspaceId + kind + (memoryKey ?? '') + normalizeForDedup(content) + observedAt)` | 稳定、跨设备同值、可去重 |
| `conflictId` | `hash(scope + memoryKey + evidenceFingerprint)` | **确定性**：同证据必得同 case，重启不重复建案 |
| `query_id` / `hit.memory_id` | `q_<8hex>` / `ev:<sessionId>:<messageId>` | 召回审计与「这条从哪来」的追问 |

> 与 `workspaceKeyFor()`（`<basename>-<hash8>`，v1 的旧落点 key）**刻意不同**：那个名字是给人看的（`nanowork-1a2b3c4d.md`），`workspaceId` 是给程序做归属校验的，可读性无用而长度有害。

---

## 6. 主要代码流程

```
write（证据）
  <memory-save> / 自动沉淀 / 用户操作 / 导入（API 显式传 now，纯函数部分不读时钟）
    → 构造 MemoryFact（补 kind/importance/source/origin；scope → user|workspace；observedAt = 调用方给的 now）
    → 校验（kind / importance / content / memoryKey / observedAt；**报错文案命中即拒**——判据由纯模块
      `src/lib/memory/detect.ts` 提供，见 §4.3.1 的模块归属）
    → dailyMemoryFileName(observedAt) → appendLine(daily/YYYY-MM-DD.jsonl, JSON)
    → 去重按 **factId**（稳定哈希，不是行号）：当日文件或近 N 日窗口内已出现同 factId → 跳过
    → 返回 'written' | 'skipped-empty' | 'skipped-duplicate'

distill（证据 → 结论，**无模型**）
  loadFacts(now - retentionDays .. now)
    → distillFacts(facts, prevCurated, policy, now)          // 纯函数
    → 有 case 变化 → 事务：prepared intent → replace(curated.json) → replace(conflicts.json) → committed
    → 无 case 变化 → replace(curated.json)（单文件原子）
    → renderCuratedProjection → replace(MEMORY.md)           // 投影可重建
    → DistillReport 落日志（不落盘到记忆目录）

inject（结论 → prompt，每次发送）
  isMemorySnapshotStale(sessionId)?          // 同步判定，见 §7.4
    → 是：await loadMemoryInto（读盘）        // 已排在流式槽位之后
  buildInjectionBlock(ref, budget, now)          // 返回**未包裹**正文（标签与护栏句由唯一包裹点补）
    → 并行读 profile / preferences / curated(user) / curated(workspace)
      + legacy 用户级单文件（只读，NFR-M11 保证它还在）
      + legacy 工作区 Markdown 合并视图（mergeMemoryFiles）
      + 最近 N 条事实
    → 渲染 + 预算裁剪（确定性优先级；legacy 与最近事实排在最低优先级）
    → composeMemoryForInjection（v1 的两段定序不变）
    → 调用方唯一一次 wrapForInjection → system 段 memory 槽位

recall（只读；**客户端按轮触发，不是模型工具**）
  本轮用户消息 + 上一轮用户消息 → query（词项数 < 2 或与上轮 query 归一化后相同 → 跳过）
    → normalizeRecallQuery(query)                     // 空 / 纯标点 → 明确拒绝
    → corpus = adaptEventStreamToStoredMemories()     // 只读投影 + 缓存
    → buildRecallCandidates(corpus, q)                // 只构造有词项重合的
    → scoreRecallCandidate(each) → stableRankRecallCandidates
    → RecallResult（含 scope / provenance / scoreBreakdown）
    → renderRecalledContext(result, recallBudget)     // 空 → ''（不产空 wrapper）
    → system 段 <recalled_context> 槽位（紧邻 <!-- MEMORY --> 块）
    → **不写任何 durable store**（I7）

resolve（人工裁决）
  listConflicts(open) → 人看到 case(revision)
    → resolveConflict(input)
        校验五条（case open + revision + active entry + fingerprint + eventId 未复用）
        → 追加 prepared intent（before/after 全量快照 + intentSha256）
        → replace(curated.json)        → 阶段 curated_applied
        → replace(conflicts.json)      → 阶段 conflict_closed
        → append(adjudications.jsonl)  → 阶段 audit_appended
        → 阶段 committed
        任一步抛错 → 由下次 `await store.recover()`（§4.5）幂等前滚
        challenger → 新 revision；incumbent → 不产生新修订

restart（恢复）
  new MemoryStore(ref)
    → recoverPendingTransactions()   // 逐条：磁盘 == before → 重做；== after → 继续；否则 fail-closed
    → loadFacts / loadCurated / loadConflicts / loadAdjudications（校验 workspaceId / userScope / schema）
    → 校验每个域恰一个 active、revision 连续、链接互配（损坏 → CorruptCuratedStateError）
    → getContextForInjection() 供注入
```

---

## 7. 与既有代码的接线点（文件级）

### 7.1 新增文件

| 路径 | 内容 |
|---|---|
| `src/types/memory/fact.ts` | `MemoryFact` / `FactKind` / `FactSource` / `FactOrigin` / `deriveMemoryKey` |
| `src/types/memory/curated.ts` | `CuratedEntry` / `CuratedState` / `DistillPolicy` / `DistillReport` |
| `src/types/memory/conflict.ts` | `ConflictCase` / `ConflictCandidate` / 裁决输入与错误类型 |
| `src/types/memory/profile.ts` | `UserProfile` / `PROFILE_FIELDS` / patch 结果 |
| `src/types/memory/preference.ts` | `PreferenceRecord` / `PreferenceState` / `PreferenceChange` |
| `src/types/memory/recall.ts` | `StoredMemory` / `RecallQuery` / `RecallCandidate` / `RecallScoreBreakdown` / `RecallHit` / `RecallResult` |
| `src/types/memory/index.ts` | 汇总再导出（并进 `src/types/index.ts`） |
| `src/lib/memory/paths.ts` | 记忆文件名策略、子目录名、白名单（**纯逻辑，两端共用**） |
| `src/lib/memory/fact.ts` | `createMemoryFact`（校验 + id 生成，纯函数） |
| `src/lib/memory/distill.ts` | `distillFacts` / `validateCuratedState`（**纯函数**） |
| `src/lib/memory/preference.ts` | `setPreference` / `deletePreference` / `listActivePreferences`（纯函数） |
| `src/lib/memory/profile.ts` | `applyProfilePatch` / `validateProfile`（纯函数） |
| `src/lib/memory/project.ts` | `renderCuratedProjection` / `renderUserMemoryProjection`（纯函数） |
| `src/lib/memory/injection.ts` | `buildInjectionBlock` / 预算裁剪（纯逻辑 + 注入端口） |
| `src/lib/memory/transaction.ts` | intent / 阶段事件 / `recoverTransactions`（纯逻辑，IO 经端口注入） |
| `src/lib/memory/adjudicate.ts` | `resolveConflict` 的**校验与状态推演**（纯函数）+ 协调层 |
| `src/lib/memory/store.ts` | `MemoryStore`：持久化边界（唯一碰 `platform.memoryFiles` 的地方）、懒迁移、缓存 |
| `src/lib/memory/legacy.ts` | v1 Markdown / 单文件用户记忆 → legacy fact / profile 的**只读**投影 |
| `src/lib/memory/index.ts` | 对外门面（`MemoryService` 从 `src/lib/memory.ts` 迁移到此，`src/lib/memory.ts` 变转出壳） |
| `src/lib/recall/{types,normalize,candidate,score,rank,engine,render,source}.ts` | 召回五阶段 |
| `src/components/memory/{FactListView,ConflictQueue,MemoryFileEditor,BudgetBar}.tsx` | 记忆页三视图 |

### 7.2 改动文件

| 路径 | 改动 | 注意 |
|---|---|---|
| `src/lib/memory.ts` | 变为**转出壳**（re-export `src/lib/memory/*`），保持既有 import 路径可用 | 40+ 调用点零改动；`MemoryService` 单例语义不变 |
| `src/lib/workspaceMemory.ts` | 保留既有函数；新增 `isCuratedJsonFileName` / `isFactJsonlFileName` / 子目录常量 | 不改既有导出语义 |
| `src/platform/types.ts` | 新增 `MemoryFiles` + `MemoryStoreRef`；`WorkspaceMemoryFiles` 标 `@deprecated`；**同一处还有 bridge 接口**（`memoryListFiles` / `memoryReadFile` / `memoryWriteFile` / `memoryRemoveFile` / `memoryRemoveAll` / `memoryMigrateLegacy`，见 :1047-1062）需按新契约扩签名 | 漏掉 bridge 接口这层，渲染层编译不过而设计上看不出来 |
| `src/platform/index.ts`、`src/platform/storage.web.ts`、`src/platform/storage.electron.ts`、`src/platform/nanobotBridge.ts` | 提供 `memoryFiles` 新实现（Web 用 `localStorage` 前缀模拟目录；Electron 走 bridge） | `nanobotBridge.ts` 是**被忽略的一层**：它把 `window.nanobot` 桥成平台方法。只改 `main.ts` / `preload.ts` 会漏它 |
| `electron/memoryRoutes.ts` | 新增 `resolveUserMemoryDir(ref)` / `resolveMemorySubdir`；`resolveMemoryFile` 支持 ref + subdir | 越界校验与 `lstat` 口径不变 |
| `electron/workspaceMemoryStore.ts` | 新增 `replaceMemoryFile`（temp + rename）/ `appendMemoryLine` / `readMemoryLines`；`listMemoryFiles` 支持 subdir | 名字白名单加 `replace`/`appendLine` 两个入口；`rename` 只用于 `replace` 的最终一步（跨目录归档用「写新 + 删旧」，不新增 `rename` IPC） |
| `electron/main.ts` | `memory:*` 六个 handler（:2474-2495）扩参；新增 `memory:replace` / `memory:appendLine` / `memory:readLines` | handler 是**唯一**真正碰 fs 的入口 |
| `electron/preload.ts` | 六个 `memory*` 方法（:41-54）扩参；新增三个方法 | |
| `electron/storageRoutes.ts` | 用户级记忆的**旧单文件路由**（`[USER_MEMORY_KEY]: { rel: 'MEMORY.md' }`，:111）**保持不动**（它是唯一同步资产 `memoryUser` 的落点，见 §9 与 NFR-M11）；新增 `userMemoryDir(roots)`；`sanitizeSegment` 复用到 `<scope-id>`；**`knownRouteFiles` 要覆盖新目录**以便 `storage:clear` 真的清得掉 | 该文件的既有约定是「一个 key 一个文件」（:225-264），**表达不了目录**——这正是要新开 `MemoryFiles` 的原因 |
| `src/components/settings/sections/AccountSection.tsx` | 账户导出/导入（`ArchiveWorkspaceMemory`，:65-79 / :243-249）目前**平铺收集工作区记忆**；新 canonical 文件（`curated.json` / `conflicts.json` / `daily/*.jsonl` / `archive/*`）与用户级新目录都会被**静默漏掉**，必须纳入「哪些文件属于记忆」的清单 | 漏掉不会报错，只会让导出的 bundle 缺内容——典型的静默数据缺口 |
| `electron/eventRoutes.ts` | 召回语料适配器复用既有按分片解析目录的逻辑（`cwdSlug`，:90-109 / :134-141），**只读**，无需改动；此处登记是为了说明 `source.ts` 依赖它而不是自己拼路径 | — |
| `src/types/settings.ts`、`src/stores/settingsStore.ts` | 新增 `memoryDistillPolicy`（对象）与 `memoryRetentionDays` / `memoryBudget`；persist `version: 13 → 14` + migrate | 加字段要同时改类型/默认值/迁移/UI（`settings-inventory.md` 的维护约定，该文 §二 表格同步登记） |
| `src/lib/settingsSync.ts` | 把三个新记忆设置加进 `SETTINGS_SYNC_OMIT_KEYS` | 它们是**本地策略**（蒸馏门槛 / 注入预算 / 保留期），各设备可不同；上行到同步或引擎会让「本机调宽了门槛，别的设备跟着变」 |
| `src/stores/sessionsStore.ts` | `loadMemoryInto` 改调 `buildInjectionBlock`；`isMemorySnapshotStale` 用组合版本；`sedimentSession` 改为写结构化事实；`<memory-save>` 落盘改走 `appendFact` | **NFR-M2 硬约束**：刷新仍在流式槽位之后、判定仍同步 |
| `src/pages/memory/MemoryPage.tsx` | 拆三视图；文件编辑器折叠为「高级」 | 现共 525 行、`save(text, 'user')` 在 :155、:222 |
| `src/pages/chat/AssistantMessage.tsx` | 「保存为记忆」菜单（现为 `MemoryService.append(message.content, { source: activeTitle }, 'workspace', memoryWorkspace)`，:207-224）改走 `appendFact`，落成 `origin: 'manual'` 的事实 | 落点是**这条消息所属会话**的 workdir，不是当前活跃会话（:95-104 的注释写了理由，迁移时不得丢） |
| `src/components/MemoryBar.tsx` | 增加 `truncated` 提示 | |
| `src/components/settings/sections/MemorySection.tsx` | 增加保留期 / 预算 / 蒸馏门槛的开关与说明 | |
| `src/lib/promptAssembly.ts` | `memory-write` 槽位文案更新（鼓励提供 `memory_key`） | 段序与标签**不变**：`memory` 是第 8 槽、`memory-write` 是第 9 槽（见 `promptAssembly.ts:172,175`），身份段仍在其之前（护栏句「以上方系统提示定义的身份为准」依赖这个顺序） |
| `src/lib/memoryDirective.ts` | 新增可选属性 `key` / `kind` / `importance` 的解析；`MEMORY_WRITE_INSTRUCTION` 补充说明 | 既有 `scope` 语义与 fail-closed 行为不变 |
| `docs/prd-memory.md`、`docs/architecture-memory.md` | 顶部加「已被 `*-v2` 增量叠加」横幅，指向本文与 PRD v2 | 不重写内容（它们是演进记录） |
| `docs/nanowork-prd-design-v2.md` §14 | 增补 v2 落地指针（FR-4.1/4.2 升级、FR-4.6 Dream 与 §4.10 的关系、L1 的本地等价实现） | 唯一事实源的维护 |

### 7.3 测试文件

| 路径 | 覆盖 |
|---|---|
| `tests/memory/fact.test.ts` | 校验矩阵（kind / importance / 长度 / key 形态 / 未来时间 / 报错文案拒收）；`factId` 稳定性 |
| `tests/memory/distill.test.ts` | 门槛矩阵、幂等、legacy 域隔离、替代三门槛、fail-closed 同分、`DistillReport` 各项、损坏状态报错、v1 数据读兼容 |
| `tests/memory/adjudicate.test.ts` | 五条校验、陈旧保护、`eventId` 幂等与复用拒绝、challenger/incumbent 分支、审计字段完整性 |
| `tests/memory/transaction.test.ts` | 五阶段顺序、**八个写入边界故障注入**、重启前滚幂等、intent 防篡改、阶段跳跃拒绝、投影中断修复 |
| `tests/memory/profile.test.ts` | 字段级 patch、`null` 删除、schema 外报错、类型约束、整体拒绝、等值 patch 不重写、投影修复 |
| `tests/memory/preference.test.ts` | CREATED/UNCHANGED/UPDATED、完整幂等身份、expiry 边界与时区、stale 拒绝、provenance 不可伪造、跨 scope 拒绝、delete 精确性 |
| `tests/memory/injection.test.ts` | 只注入 active、不注入候选/过期/superseded、预算裁剪确定性、`truncated` 计数、空记忆不产块、护栏句与两段定序不变 |
| `tests/memory/store.test.ts` | `replace` 原子性、`appendLine` 单写、懒迁移不丢内容、`workspaceId` / `userScope` 不匹配拒绝 |
| `tests/recall/*.test.ts` | 五阶段契约、中英文归一化、纯标点/空 query 拒绝、稳定排序 tie-break、空结果契约、只读性、provenance 与 breakdown、`limit` 边界 |
| `tests/memoryPage*.test.tsx` | 三视图切换、待裁决提交与陈旧提示、停用/删除、截断提示 |
| `tests/sessionsPromptAssembly.test.ts`（**改**） | 新增：结构化块真的进了请求的 system 段；预算裁剪在真实链路上生效；刷新仍在槽位之后（既有守门用例不动） |
| `tests/electron/workspaceMemoryStore.test.ts`（**改**，注意不是 `tests/electron/memory*`） | 新增 IPC 契约、User 根路径解析、越界拒绝、符号链接拒绝；**并修正 :87-93**（`index.json` 不被列成记忆）以适配新白名单 |
| `tests/memoryService.test.ts`（**改**） | **修正 :410**（`memoryDiskPath('user')` 期望值）；复核 :697-721（`writeVersion` 单调性）按 §7.4 组合版本语义更新 |
| `tests/sessionsStore.test.ts`（**改**） | 复核 :704-737：用户级写入仍必须使快照过期，且 `send` 仍同步进入流式态（**这两条不得同时失效**） |
| `tests/sync/fileAssets`（**改/增**） | `memoryUser` 资产在 v2 迁移后**内容不变**（NFR-M11）：防止「迁移导致跨端删除用户记忆」的回归 |

### 7.4 注入快照版本的精确语义（NFR-M2）

现状：`MemoryService.writeVersion()` 是**单个**进程内计数器，唯一递增点在 `save` / `append` / `writeFile` / `removeFile` / `clear` / 懒迁移。

升级后候选状态有**三个**（user、workspace、profile/preferences 同属 user）：

```ts
// src/lib/memory/store.ts
writeVersion(): number;   // 组合值：`${userVersion}:${workspaceVersion}` 的单射数字编码
```

- 两个分计数器分别由「用户级任一次落盘」与「工作区级任一次落盘」递增，**递增点仍在写入完成之后**（v1 的既有理由：先递增会让并发读取拿到「新版本 + 旧内容」的快照，那个快照会被判为有效，于是永久停在旧内容上）；
- 组合值必须是**单射**（不同组合 → 不同值），否则「用户级变了、工作区级没变」可能撞上与上一状态相同的值；
- `Session.memoryVersion` 存组合值，`isMemorySnapshotStale()` 的比较逻辑不变，**仍是同步函数**；
- 蒸馏与裁决也是写入，同样递增对应分计数器；
- 跨会话看到了别的会话的蒸馏结果：版本变了 → 刷新 → 重读。这是正确行为，不是抖动。

---

## 8. 不变量（可测，写完即用测试钉住）

| # | 不变量 | 违反后果 |
|---|---|---|
| I1 | 证据只追加：`daily/*.jsonl` 的行**永不**被 `distill` 修改或删除 | 长期结论失去来源，错误蒸馏无法重算 |
| I2 | 每个冲突域（`entryKey`）**至多一个** `status='active'` 的修订；零 active 只允许在「域已 `disabled` / 已删（域级墓碑）」两种显式终态下成立，且域终态**不会被后续蒸馏自动复活** | 注入出现两个互相矛盾的值；或用户停用/删除后 store 被判损坏 |
| I3 | 修订链完整：每个域 `revision` 连续、`supersedes` / `supersededBy` 互配 | 历史不可读，替代关系断裂 |
| I4 | 只有 `resolveConflict` 能改变 active 值（且必须通过五条校验） | 模型/竞态可静默改写长期记忆 |
| I5 | 裁决 **incumbent 不产生新修订** | 伪造一次事实变化，历史被污染 |
| I6 | `MEMORY.md` 与 `user.md` 任何时候都能由 canonical 状态**逐字节重建** | Markdown 事实上变成第二权威，漂移不可检测 |
| I7 | 召回**零写入**：任意次召回后 durable store 逐字节不变（不论由客户端按轮触发还是由 harness 显式调用 `recall`） | 检索污染记忆 |
| I8 | 注入块**只**含 active 修订 + profile/preferences + 最近 N 条事实；预算未被突破；`truncated` 与实际裁剪一致 | 上下文失控；用户看到静默丢失 |
| I9 | 「已水合会话 `send` 同步进入流式态」继续成立（NFR-M2） | 同会话并发 `send` 互斥失效 |
| I10 | 崩溃后重启：每个未完成裁决**要么前滚到 committed、要么不动**，且不产生重复审计行 | 记忆与待审队列互相矛盾 |
| I11 | `workspaceId` / `userScope` 不匹配的 canonical 文件被**拒绝读取** | 跨工作区/跨用户污染 |
| I12 | 渲染层无 `import 'electron'` | 平台边界检查红 |

---

## 9. 迁移与兼容

| 场景 | 处置 |
|---|---|
| v1 `MEMORY.md` + `YYYY-MM-DD.md` | 继续读（§4.2）；投影为 legacy fact 参与展示与冲突检测，**并且继续参与注入**（作为工作区侧最低优先级段落，与最近事实共享 `workspaceChars` 预算——见 §4.6 的「legacy 段落必须继续进 prompt」）；**不改写原文** |
| v1 单文件用户记忆 `~/.nanowork/MEMORY.md`（storage key `nanowork.userMemory`） | ⚠️ **不得改名、不得清空**（2026-10-02 对抗性核验修正）。该 key **已经在同步边界内**：`src/sync/fileAssets.ts:76-80` 把 `USER_MEMORY_KEY` 注册为**段落级** C 类资产 `memoryUser`（`paragraphLevel: true`）。一旦把它改名成 `.migrated`，`platform.storage.get(USER_MEMORY_KEY)` 变空 → `hydrate()` 走「内容变了」分支（`fileAssets.ts:272-287`）→ `diffRemovedKeys` 为**上次已知的全部段落**生成墓碑（`mergeTombstones`，配 `src/lib/memoryMerge.ts:253`）→ `collect()` 上行 → 其他设备 `apply()` 按墓碑**删掉这些段落**。这不是「本机迁移」，是**跨设备的用户记忆清空**。<br>**正确处置**：① 原文件**原地保留**为 legacy 只读源（内容不动、key 不动，继续参与注入，理由同工作区级）；② 新目录另起（`~/.nanowork/user-memory/<scope-id>/`）；③ 若要退役 `memoryUser` 资产，必须作为**独立的、需要跨端协商的一次性动作**（先升 `schema` 版本、两端都识别后再停采），**不在本迁移里做** |
| §10 的「未接线」表述 | 修正：用户级记忆**已经在同步边界内**（`memoryUser`）。v2 的 canonical 文件（`daily/*.jsonl`、`curated.json`、`conflicts.json`、两个 journal）**不在**任何 collection 里，即**不上行、不从云端落地**。Phase 5 要做的不是「接线」，而是「用证据流替换段落并集」——见 §10（已改写） |
| v1 段落级 LWW（`memoryMerge.ts`，同步用） | **保留**。它服务的是 `memoryUser` 的段落并集（今天就在跑），与本文的「事实冲突域」是两件事：前者解决「两台设备各改了一个段落」，后者解决「同一问题有两个答案」 |
| v1 的 9 个记忆测试文件 | **门禁要求是「全绿」，但**「不删不改语义」这个措辞**站不住**（2026-10-02 修正）。至少两处断言必须按新语义更新，实施时必须点名处理：<br>① `tests/electron/workspaceMemoryStore.test.ts:87-93` 断言根目录的 `index.json` **不被列成记忆**——与 §5.2「读取宽：任意合法单段 `.md`/`.json`/`.jsonl`」冲突，需按白名单细化（`index.json` 保持被排除）；<br>② `tests/memoryService.test.ts:410` 断言 `memoryDiskPath('user', null) === '~/.nanowork/MEMORY.md'`——用户级落点变更为目录后必须改期望值。<br>另有 `tests/memoryService.test.ts:697-721`（`writeVersion` 单调/不递增）与 `tests/sessionsStore.test.ts:704-737`（用户级写入必须使快照过期 + `send` 仍同步进槽位）受 §7.4 组合版本影响，需按新语义复核。**其余用例保持原断言语义** |
| persist `version: 13` | 升到 `14`：新增字段补默认值；`memoryEnabled` / `autoSummarize` 保持 `true`（v1 的 `false → true` 提升逻辑一句不动） |
| 新开关默认值 | `memoryDistillPolicy` 默认即 §4.3 的三个门槛（与 WorkBuddy 口径一致）；用户可在设置页放宽 |
| 新目录首次创建 | **惰性**：只在真的要写时创建，避免「每个打开过的项目都多出一个空文件夹」（v1 的既有取舍） |
| 主进程 `storage:clear` | 必须同步扩展：现 `clearStorageFiles` 只删静态路由文件 + `memoryDir` 下的 `.md/.json`（`electron/main.ts:2435-2444`），`knownRouteFiles` 不含新目录（`electron/storageRoutes.ts:336-346`）。v2 的 `~/.nanowork/user-memory/**`、`<workdir>/.nanowork/memory/daily|archive/**` 都要纳入「清空应用数据」；`.migrated` 留档按「用户数据」一并清理（它是原件副本，留着会让用户以为数据还在，而清理不应留残渣） |

---

## 10. 与同步（`src/sync/`）的接线（Phase 5，本次不阻塞）

**问题**：`curated.json` / `conflicts.json` 是 canonical 状态，若直接进 `syncRegistry` 做 LWW，两台设备各自独立裁决会产生**不可合并的分叉**（这与 `memoryMerge.ts` 的段落 LWW 不同——段落的键是内容哈希，天然去重）。

**设计（记录决策，实施归 Phase 5）**：同步 **append-only 证据流**（`daily/*.jsonl`、`conflict-adjudications.jsonl`、`conflict-resolution-transactions.jsonl`），把 `curated.json` / `conflicts.json` / 投影**当作每台设备各自从证据重算的派生物**。

- 好处：与 s10 的「证据留存、结论可重建」一致；与 s10 的「多文件裁决需要进程内事务」不冲突（事务是本地的，跨设备的最终一致由「同一份证据 → 同一个 `distillFacts`（纯函数、确定性）」保证）；
- 前提：`distillFacts` 必须**确定性**（无时钟读取、无随机、无 Map 迭代顺序依赖）——这是 §4.3 把它设计成纯函数并显式传 `now` 的原因；
- 代价：两台设备可能因为看到的证据到达顺序不同而短暂不一致，下一次 `distill` 收敛。可接受。

---

## 11. 明确保留的 v1 机制（原样，附理由）

| v1 机制 | 为什么不能丢 |
|---|---|
| 落点 `<workdir>/.nanowork/memory/`、不写产品文件进用户项目 | 用户对自己项目目录的控制权（`prd-memory.md` §6.1） |
| 两层合并注入的定序（用户级在前）+ 护栏句 | 顺序与护栏句是**同一套假设**，改一边就失效（`prd-memory.md` §6.4） |
| `looksLikeSystemError` 三道防线 | 一条系统报错进长期记忆会被永久注入（`prd-memory.md` §6.5 的真实事故） |
| 注入快照失效机制、补刷点在流式槽位之后 | 并发互斥的可测性质（`prd-memory.md` §6.7；本文 NFR-M2/I9） |
| **不做字节相似度阈值去重** | 三条真实数据的实测表（覆盖率 0.25~0.45 vs 更新 0.90）。v2 用**显式 `memory_key` + 替代门槛**从根上解决，而不是把阈值调松 |
| `<memory-save>` 不走工具审批 | 纯本地无副作用写入弹审批框只会教用户关掉审批（`memoryDirective.ts` 文件头） |
| `snapshotBeforeWrite` 写前快照 / 记忆页版本回滚 | FR-7.3 的既有能力，与本文的 canonical/投影分层不冲突（它备份的是文件版本，本文管的是语义） |
| 段落级 LWW `mergeMemory.ts` | 服务同步场景，与事实冲突域是两件事（§9） |
| 身份文件 L4（`SOUL.md` / `IDENTITY.md` / `USER.md` / `BOOTSTRAP.md`） | 与 WorkBuddy 的 L4 同构，v2 不改其落点与注入方式 |

---

## 12. 待确认事项（含推荐答案）

| # | 问题 | 推荐答案与理由 |
|---|---|---|
| 1 | `MEMORY.md` 是否允许用户手编？编了算不算权威？ | **允许，但明确定位为投影**。手编内容在下次 `distill` 重建时会被覆盖——除非用户在「文件视图」里显式选择「保留手工段落」。更好的默认是：手工新增内容通过「文件视图保存」时，客户端把它转成 `origin='manual'` 的**事实**写入 `daily/`（这样手编也进正式链路，不被重建吃掉）。**需在 Phase 2 定稿** |
| 2 | legacy fact（v1 段落）是否参与冲突检测？ | **参与检测、不参与晋升**。它们是用户既有资产的真实内容，忽略会漏掉真冲突；但让它们自动替代新事实风险更高 |
| 3 | `memory_key` 由谁提供？ | **三层兜底**：① `<memory-save key="…">` 显式提供（最优）；② 客户端对常见形态（`response.language` / `runtime.*` / `editor.*`）做规则化推断；③ 派生 key（§4.1）。**不让模型自由发明 key**（会漂移成无数个域） |
| 4 | 用户级是否也需要 `daily/*.jsonl`？ | **需要**，同构工作区级。身份类事实的**原始证据**必须留存（否则「为什么记着我叫明明」无法解释）。落 `~/.nanowork/user-memory/<scope-id>/daily/` |
| 5 | 召回语料是否需要落盘缓存？ | **不落盘**。事件流已是权威且只读；落盘会造出第三个产地（违反 ADR-023 的口径）。进程内 LRU + 按 `rev` 失效足够 |
| 6 | 蒸馏谁来触发？ | **三个点**：① 会话结束（既有 `sedimentSession` 之后）；② 记忆页「立即整理」按钮；③ 应用启动后延迟一次（兜底）。**不做后台定时**——V1 没有可靠的常驻调度，且暴露在 UI 上用户能看见 |
| 7 | 冲突 case 无人处理会怎样？ | 候选**不进注入**（I8），当前值继续生效，`MemoryBar` 与记忆页显示「待裁决 N」。不做自动超时裁决（拿不准就不动，原则 3） |
| 8 | 是否需要把 `files` 之外的用户态（如 `preferences`）也纳入「清空」？ | **是**，但分粒度：清空工作区级 = 删该工作区记忆目录下全部记忆文件（v1 语义）；清空用户级 = 删 `profile.json` / `preferences.json` / `curated.json` / 投影 / 日志，**保留身份文件**（`FR-4.3` 的既有豁免） |

---

## 13. 对抗性核验记录与补充规格（2026-10-02）

本节是两份文档**定稿前的代码级对抗核验**结论。核验覆盖 §5 平台契约的可行性、注入路径的
`await` 边界、召回语料的分片口径、蒸馏确定性、Web 端降级、CI 门禁覆盖面。**通过的结论**：
① 平台契约（`MemoryRef` + 子目录 + `replace`/`appendLine`/`readLines`）**可实现**——`ipcRenderer.invoke`
能结构化克隆 ref 对象，`StorageRoots.home` 已可用于 `~/.nanowork/user-memory/`；
② 注入路径**不新增 `await`**——`streamAssistantReply` 的流式槽位在 `sessionsStore.ts:704-707`，
唯一 `await` 在 `:714-716`，装配段 `:724-800` 全程同步，只要 `buildInjectionBlock` 落在
`loadMemoryInto`（`:1349`）内部即可（NFR-M2 与 I9 继续成立）；
③ 召回语料口径**正确**——`streamShardOf`（`sessionsStore.ts:430-432`）→ `toMeta` 把**分片**写进
`meta.workdir`（`:442-444`）→ `readEvents(sessionId, workdir)` 按 `cwdSlug` 推目录
（`electron/eventRoutes.ts:90-141`），含同步落地会话（`toMetaFromEntity` 重定向，`:578-593`）。

**已修正的阻塞级缺陷**（正文已改，此处只列导航）：

| # | 缺陷 | 修正位置 |
|---|---|---|
| B-1 | 召回被设计成「模型可见工具」，而客户端**没有工具注册通道**（请求只有 `tool_allow`/`tool_deny`，`src/ai/runtime/types.ts:95-96`） | §4.4 通道表 + §4.8「触发与注入边界」+ FR-M25a + NFR-M10 |
| B-2 | `userScope` 全仓不存在，挂在登录态上会导致「未登录无记忆 / 登录后记忆不可读」 | §4.7.0（与账户解耦的本地 `userScope` + 绑定映射） |
| B-3 | v1 用户级单文件**已在同步边界内**（段落级资产 `memoryUser`，`src/sync/fileAssets.ts:76-80`），按原 §9 改名会在 `hydrate()` 生成段级墓碑（`:272-287`）并**跨设备清空用户记忆** | §9 迁移表 + NFR-M11 + `tests/sync` 回归 |
| B-4 | v1 `MEMORY.md` / `YYYY-MM-DD.md` 在 v2 注入集合里消失（FR-M3 与 FR-M10 互斥） | §4.6「legacy 段落必须继续进 prompt」+ 可执行判据 |
| B-5 | I2「**恰**一个 active」与 FR-M31 真删 / FR-M34 停用冲突（停用即判 store 损坏） | §4.3 步骤 6 + I2 改「**至多**一个 active」+ 域级终态与墓碑 |

**其余已修正项**：双重包裹（§4.6 的唯一包裹点）、`FactOrigin` 缺 `'import'`、`entryKey`/`memoryKey` 命名空间混淆（§4.1 的 `EntryKey`）、`hashContent` 位宽（§4.3.1）、`renderedAt`/`lastSeen`/`evidenceIds` 顺序等六处确定性（§4.3.1）、`looksLikeSystemError` 的模块归属（§4.3.1）、30/180 两个数混用（§4.10 的 FR-M33）、异常分工（§4.4 五条校验表）、Web 端三条不成立的契约（§5.2 + NFR-M9）、`electron/main.ts` / `ElectronAPI` / `storage.electron.ts` / `AccountSection.tsx` 四处接线漏项（§7.2）、既有测试的断言变更点（§7.3 + NFR-M4）、`storage:clear` 覆盖新目录（§9）、类名统一与恢复期竞态（§4.5）。

### 13.1 本节新增的规格（正文未展开，实施时按此做）

**（1）记忆读写的调用方边界（FR-M20 / FR-M21 / FR-M23 / FR-M31 的入口）**

原设计只给了纯函数签名，没写「谁调用」。明确如下——**依据 FR-M13a：不新增模型工具**：

| 能力 | 调用方 | 传 `source` / provenance | 是否有 UI |
|---|---|---|---|
| `applyProfilePatch`（FR-M20） | ① `/persona` 页的 Profile 表单（新增小节）；② `<memory-save scope="user" kind="profile">` 的受控解析（模型只能提议，harness 落盘）；③ 导入（FR-M35） | `source: 'user'` / `'agent'` / `'import'`；`sourceEventId` 由 harness 从事件流取 | 是 |
| `setPreference`（FR-M21 / FR-M23） | ① 记忆页「偏好」列表的新增/编辑/删除；② `<memory-save scope="user" key="…">` 解析；③ 导入 | `source: 'user'` / `'agent'`；`sourceEventId` **仅**由 ② 的 harness 侧附加（模型提交的 event id 一律丢弃） | 是 |
| 召回（FR-M25a） | `buildInjectionBlock` 内部按轮触发；`recall()` 另供 harness 测试/诊断显式调用 | `query_id` 由 harness 生成 | 否（结果只进 prompt） |
| `moveEntry`（FR-M31 的「改作用域」） | 记忆页单条操作 | 按 §4.7.0 的「跨作用域搬 = 目标域新建事实 + 源域停用 + 审计」实现；**不移动文件** | 是 |
| `resolveConflict`（FR-M13） | 记忆页「待裁决」区 | `actor` 取界面账号或 `'local-user'`；`eventId` 由 UI 生成 | 是 |

> 原设计引用的 `save_user_preference` / `write_memory` **不是工具**（不可能有——见 FR-M13a）。这段
> 措辞已在 §4.4 的通道表里纠正；实施时**不要**去找这两个工具的挂载点。

**（2）canonical 文件的写前快照（补 M8 缺口，兑现 PRD §8.6）**

`curated.json` / `conflicts.json` / `profile.json` / `preferences.json` 是**用户资产**，与 v1 的
`MEMORY.md` 同类，因此**必须同样享受 FR-7.3 的写前快照与版本回滚**：每次 `replace` 前调
`snapshotBeforeWrite(fileKeyOf(scope, workdir, name), oldContent, op)`。注意两处扩展：

- **`fileKeyOf` 需要 scope-id 维度**：现实现 `src/stores/fileBackupStore.ts:86-88` 对 `scope==='user'`
  把 `workdir` 恒取 `null`，多用户/多作用域会共用同一条 `memory:user::…` 时间线 → 备份互相覆盖。
  新增维度：user 侧 key 用 `<scope-id>`（§4.7.0）。
- **`.jsonl` 只追加文件不做整份快照**（每次都备份会爆炸）；它的回滚锚点是**归档**（FR-M33），
  语义不同要分开。

**（3）I12 目前**没有**被 CI 钉住（如实说明）**

`.github/workflows/ci.yml` 的两条平台边界检查是「grep `window.electronAPI`」（`:126-129`）与
「wire 字段泄漏」（`:184-188`），**不检查** `from 'electron'` / `node:fs`。因此 I12 目前只有
**代码评审**在守。若要让 I12 可测，需在 CI 增加一条针对 `src/**` 的 grep——**这是本设计的
新增前置条件**，已记入开发计划的 Phase 0 门禁任务；在它落地前，请勿把 I12 当作已自动化。

**（4）electron 侧对共享纯模块的导入方式**

`electron/**` 目前对 `src/**` **一律用相对导入**（如 `electron/memoryRoutes.ts:2-9`、
`electron/eventStore.ts:23-29`），无一处用 `@/`。共用 `src/lib/memory/paths.ts` 时必须沿用相对路径，
否则 `npm run build:electron` 的 esbuild 解析会失败。

**（5）`src/lib/memory.ts` 与 `src/lib/memory/` 并存时的解析优先级**

`moduleResolution: "bundler"` 下 `@/lib/memory` **优先解析到文件** `src/lib/memory.ts`，目录
`src/lib/memory/index.ts` 只在该文件不存在时生效。因此：

- 门面单例留在 `src/lib/memory/index.ts`，`src/lib/memory.ts` 改为**显式子路径再导出**
  （`export * from './memory/store'` 等，不用裸 `./memory`）；
- `src/lib/memory/**` 内部模块**禁止反向 import 门面**（会成环）；
- M0-08 必须加一条 import 解析断言（`tests/memory/facade.test.ts`），否则「改了半天没生效」。

**（6）`stored_at` 与 `captured_at` 在事件语料里同值（如实说明）**
事件只有 `BaseEvent.timestamp`（`src/types/event.ts:122`），投影已把它用作 `createdAt` 的兜底
（`src/events/project.ts:154-158`）。因此对 `kind: 'conversation'` 的记录，
`storedAt` 与 `source.capturedAt` **会取到同一个值**——契约保留两个字段是为了将来接真远端存储，
**不要**为了「看起来不同」而伪造一个 `storedAt`。

### 13.2 实施期的落地偏差（2026-10-02，供后续维护者对照）

计划与实际不可能完全一致；以下偏差是**刻意的**，记在这里以免下一个人以为设计写错了：

| 设计里写的 | 实际落成 | 为什么 |
|---|---|---|
| `src/lib/memory/*` 目录 + `memory.ts` 转出壳 | 全部落在 `src/lib/` 顶层（`memoryFact.ts` / `memoryDistill.ts` / `memoryAdjudicate.ts` / `memoryStore.ts` / …），**未建目录** | `moduleResolution: "bundler"` 下 `@/lib/memory` 会优先解析到**文件** `memory.ts`，与目录 `memory/` 同名（设计 §13.1(5) 记的正是这个坑）。与其做一次 40+ 调用点的搬迁，不如换个文件名——零风险且同样清晰 |
| `src/lib/recall/{types,normalize,candidate,score,rank,engine,render,source}.ts` 八个文件 | 合成两个：`src/lib/recall.ts`（五阶段）+ `src/lib/recallCorpus.ts`（语料适配器） | 八个小文件在一个 400 行的模块里制造的是导航成本而不是边界；阶段边界已经由**导出的函数**与结构化类型表达清楚 |
| `memoryProject.ts` 在 §7.1 只做投影渲染 | 同时被 `memoryEdit.ts` 与 `memoryStore` 的调用方复用 | 见下面的「投影渲染器不能省」 |
| `MemoryStore` 构造即 `recover()` | 显式 `await store.recover(now)`，且在 `resolve()` 前也会跑一次 | 异步构造会引入启动期竞态（设计 §4.5 已记）；`resolve` 前跑一次是为了不让未完成的事务干扰用户正在做的裁决 |

**投影渲染器不能省（一次真实事故）**：`createMemoryStore` 的 `renderProjection` 是**可选**
参数，而 `memoryEdit.ts` 的工作区仓储最初忘了传它。症状极具迷惑性——手编保存看起来正常
（因为文件里还留着用户刚写的原文），但 `distill` 与 `rebuildProjection` 都因为「没有渲染器」
而**静默早退**，投影其实再也不会被重建；等用户删掉文件、或下次蒸馏想刷新投影时，内容就
凭空消失。现在 `workspaceStoreFor()` 固定传入它，`memoryProject.ts` 是唯一渲染实现。

**M2-10 的 `WorkspaceMemoryFiles` 清理被撤销（刻意保留）**：该任务原写「Phase 2 末清理
`WorkspaceMemoryFiles` 弃用薄封装」，判据是 `grep WorkspaceMemoryFiles src/` 仅剩历史注释。
实施时判定**不做**，理由是本项目的迁移策略（NFR-M11）是**双轨并存**：

- v1 的 `MEMORY.md` / 日期 `.md` 是用户既有资产与 `nanowork.userMemory` 这个**已同步**的
  段落级资产，v2 只**读**它们作为最低优先级的 legacy 段落，**不写**、不改；
- 因此 v1 的读写面（`platform.memoryFiles` / `WorkspaceMemoryFiles`）仍然是活代码，
  去掉它等于让 v1 记忆只读不可写——那不是「清理」，是功能回退；
- 退役 `nanowork.userMemory` 是一件**跨设备的协商动作**（清空它会在其它设备上生成段落墓碑
  并删掉那边的用户记忆），不该以一次内部重构的形式顺手做掉。

结论：判据本身要改，而不是代码。这条偏差与上面几条一样是**有意的**。
