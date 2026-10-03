# 开发计划：记忆体系 v2（结构化事实 · 蒸馏 · 冲突裁决 · 用户画像 · 召回）

> **配套**：需求依据 `docs/prd-memory-v2.md`（`FR-M1`–`FR-M36` / `NFR-M1`–`NFR-M9`）、
> 设计 `docs/architecture-memory-v2.md`（§4.1–§4.10、§5、§7.1–§7.4、§8 不变量 `I1`–`I12`、§9 迁移、§12 待确认）。
> **唯一事实源**：`docs/nanowork-prd-design-v2.md`（第 14 章，已于 2026-10-02 加 v2 增量指针）。
> **前置**：`docs/prd-memory.md` / `docs/architecture-memory.md`（v1，**不废止**，其已落地机制原样保留，见 §6.2）。
> **状态**：增量（待实施）。
>
> **本计划的定位**：这是记忆 v2 的**工程实现与验收唯一依据**。任务表可直接派工；§4 的测试映射、
> §5 的崩溃矩阵、§6 的迁移步骤、§9 的对标清单是 QA 的验收脚本来源。任何实现与本文冲突，
> 以 `docs/architecture-memory-v2.md` 为准；与**代码**冲突，以代码为准（并回来改本文）。
>
> **硬约束（全阶段有效）**
> 1. 渲染层**零 `electron`**：所有 IO 经 `platform.*`（ADR-019 口径不变，CI 平台边界检查继续通过）。
> 2. 引擎侧（`nanobot/`）**零改动、零新增 `[LOCAL PATCH]`**：`docs/upstream-merge-conflicts.md` 的
>    104 处 / 28 文件清单**不再变长**。凡需求实现必须在引擎侧落点的，一律**改道到客户端**（见 §10.2 B-1）。
> 3. v1 的 9 个记忆测试文件（**实测 1907 行**，见 §4.3）是**回归底线**：允许新增用例，**不允许删改既有断言语义**。
> 4. `NFR-M2` / `I9` 是硬约束：「已水合会话 `send` **同步**进入流式态」必须继续成立；记忆快照过期判定
>    保持**同步函数**；刷新只能排在流式槽位**之后**（`src/stores/sessionsStore.ts:701-716`）。
> 5. 不改 `docs/README.md`（登记制由文档负责人在收口时执行）。

---

## 0. 代码基线速查（2026-10-02 实测，行号可核）

本计划的每条文件级判断都来自下表，不是文档转述。

| 关注点 | 实测事实 | 与设计文档的一致性 |
|---|---|---|
| 记忆服务 | `src/lib/memory.ts` **1049 行**，`MemoryServiceImpl` 单例 + `load/save/clear/append/listFiles/readFile/writeFile/removeFile/loadForInjection/composeMemoryForInjection/wrapForInjection/summarize/countEntries/writeVersion` | ✅ 设计 §1.1「1049 行」逐项相符 |
| 目录约定 | `src/lib/workspaceMemory.ts` **205 行**：`CURATED_MEMORY_FILE` / `dailyMemoryFileName` / `sortMemoryFileNames` / `mergeMemoryFiles` / `isMemoryFileName` / `isWritableMemoryFileName` / `isSameMemoryWorkspace` | ✅ |
| 段落 LWW | `src/lib/memoryMerge.ts` **270 行**（同步用，段级 2P-Set + 墓碑） | ✅ 设计 §9 保留 |
| 写入协议 | `src/lib/memoryDirective.ts` **121 行**：`parseMemoryDirectives` / `stripMemoryDirectives` / `MEMORY_WRITE_INSTRUCTION`；消费点在 `src/stores/sessionsStore.ts:974` | ✅ |
| 类型 | `src/types/memory.ts` **70 行**（`MemoryMeta`/`MemoryState`/`MemoryScope`/`MemoryDirective`/`MemoryScopeSummary`/`MemoryAppendOptions`） | ✅ |
| 平台契约 | `src/platform/types.ts:462` `WorkspaceMemoryFiles`（`list/read/write/remove/removeAll/migrateLegacy`），`PlatformAdapter` 在 `:530`（`memoryFiles` 字段 `:534`） | ✅ 设计 §1.1 行号精确 |
| 平台实现 | Web `src/platform/storage.web.ts:103` `WebWorkspaceMemoryFiles`；Electron `src/platform/storage.electron.ts:75` `ElectronWorkspaceMemoryFiles`；装配 `src/platform/index.ts:56-58` | ✅ |
| 主进程路径 | `electron/memoryRoutes.ts` **116 行**：`resolveWorkspaceMemoryDir` / `resolveMemoryFile` / `resolveLegacyMemoryFile` / `resolveCuratedMemoryFile` + 越界与白名单双保险 | ✅ |
| 主进程 fs | `electron/workspaceMemoryStore.ts` **208 行**：`listMemoryFiles` / `readMemoryFile` / `writeMemoryFile`（`lstat` 拒非普通文件）/ `removeMemoryFile` / `clearMemoryFiles` / `migrateLegacyMemory` | ✅ |
| IPC | handler 在 `electron/main.ts:2474-2492`（`memory:list/read/write/remove/removeAll/migrate`）；`electron/preload.ts:45-54` 六个方法 | ⚠️ 设计 §7.2 只列了 `preload.ts`，未列 `main.ts`（见 §2 前置说明） |
| 注入接线 | `src/stores/sessionsStore.ts` **2443 行**：`streamAssistantReply` `:691`（槽位 `:701-707`、刷新 `:709-716`、记忆块 `:735-741`、`memory-write` `:746-747`）；`sedimentSession` `:1147`；`createSession` `:1205`；`loadMemoryInto` `:1329`；`isMemorySnapshotStale` `:1375` | ✅ 设计 §1.1 行号精确 |
| 开关与持久化 | `src/stores/settingsStore.ts` persist **`version: 13`**（`:247`）；v9 迁移把 `autoSummarize` 强制提升 `true`（`:295`） | ✅ 设计 §7.2「13 → 14」前提成立 |
| 常量 | `src/lib/constants.ts`：`MEMORY_KEY_PREFIX` `:176`、`MEMORY_TAG_OPEN` `:179`、`MEMORY_TAG_CLOSE` `:182`、`USER_MEMORY_KEY` `:212`（旧单文件用户记忆的 storage key） | ✅ 设计 §1.1 行号精确 |
| 事件存储 | `src/events/store.ts`（`EventStore` / `createMemoryEventStore`）、`src/events/project.ts`（`activePath:108` / `projectMessages:190` / `metaToSession:419`） | ✅ 召回语料唯一来源 |
| 召回现状 | `grep -i recall src/` **零命中** → G7 成立（全仓无跨会话检索） | ✅ PRD §1.2 |
| 工具面 | 模型可见工具由**引擎**提供；客户端只有正文协议（`<memory-save>`）与 `platform.syncNanobotMcp` 写 `tools.mcpServers` 两条通道 | ✅ 已据实调整设计：召回改为**客户端按轮触发**（FR-M25a），不新增模型工具（详见 §10.2 B-1） |
| 引擎记忆 | 客户端**读不到**引擎 workspace 路径（`grep nanowork-Workspace src/ electron/` 零命中），`platform` 有 channels/mcpServers/modelPresets 三类只读回读，**无** `agents.defaults.workspace` 回读 | ✅ 已据实收敛范围：只读面板推迟 Phase 5（详见 §10.2 B-2） |
| 测试 | `vitest.config.ts`：`environment: 'jsdom'`、`include: ['tests/**/*.test.ts','tests/**/*.test.tsx']` → `tests/memory/` 与 `tests/recall/` 新增即被收集，**不需要改配置** | ✅ |
| 模块解析 | `tsconfig.json`：`moduleResolution: "bundler"` + `paths: @/* → ./src/*` | ⚠️ `src/lib/memory.ts` 与 `src/lib/memory/index.ts` 并存时裸路径 `@/lib/memory` 只会解析到前者（见 §2 前置说明） |
| 引擎补丁面 | `docs/upstream-merge-conflicts.md`：28 文件 / **104 处** `[LOCAL PATCH]`，行号为 2026-09-17 快照 | ✅ 本计划要求 **+0** |

---

## 1. 计划总览

### 1.1 里程碑（沿用 PRD §7 的 `Phase 0`–`Phase 5`）

| 阶段 | 主题 | 任务数 | 需求覆盖 | 「done」一句话 |
|---|---|---|---|---|
| **Phase 0** | 平台与存储地基 | 10 | FR-M4, FR-M16；NFR-M3/M5/M9 | 两端 `platform.memoryFiles`（`MemoryFiles` + `MemoryStoreRef`）可用且 `replace` 真原子、`appendLine` 真追加；新旧数据共存不丢；v1 的 40+ 调用点**零改动** |
| **Phase 1** | 事实 → 蒸馏 → 冲突 → 事务 → 裁决（核心增量） | 12 | FR-M1–FR-M19 | `distillFacts` 纯函数与 `resolveConflict` 被测试钉死；八个写入边界故障注入后可**幂等恢复或 fail-closed**；注入块已有界（不随日志天数增长） |
| **Phase 2** | 用户画像与偏好 + 有界注入收口 + 治理页 | 10 | FR-M20–FR-M24, FR-M31, FR-M32, FR-M34（+ FR-M10 / NFR-M6 收口） | 记忆页能看到「系统记住了哪些事实」、能逐条停用/删除、能提交裁决与陈旧保护；注入总量有硬上限且 `truncated` 可观察；`WorkspaceMemoryFiles` 弃用封装清零 |
| **Phase 3** | 跨会话召回 | 9 | FR-M25–FR-M30 | 五阶段契约齐备、每个 hit 带 `scope`/`provenance`/`score_breakdown`；召回**零写入**；同输入同 `as_of` 必得同排名 |
| **Phase 4** | 保留 / 归档 / 导出 / 边界收口 | 6 | FR-M33, FR-M35, FR-M36 | 归档不删证据（`archive/` 不被 `distill` 扫描）；bundle 可导出可导入且校验 scope；双记忆体系边界写进唯一事实源 |
| **Phase 5**（不在本次） | 云端画像 + 跨设备同步 + 向量 / reranker | 0 | — | **不留实现**，只留接口：`RecallResult` 契约不因换 ranker 而变；同步只同步 append-only 证据（设计 §10） |

**合计 47 个任务**（Phase 0 = 10、Phase 1 = 12、Phase 2 = 10、Phase 3 = 9、Phase 4 = 6）。

### 1.2 全局完成判据（五个阶段全部满足才算「最低要求与 WorkBuddy 一样」）

1. **门禁**：`npm run typecheck` + `typecheck:electron` + `typecheck:tests` + `npm test` + `npm run build` 全绿；
   v1 的 9 个记忆测试文件（1907 行）语义未改（`git diff` 只允许新增用例）。
2. **不变量**：`I1`–`I12` 每条都有测试钉住（映射见 §4.4）。
3. **崩溃安全**：§5 的十个写入边界全部按预期「redo / continue / fail-closed」，重复恢复结果相同。
4. **对标**：§9 的 M1–M6 逐条可勾选（含「明确不在本次」的边界）。

> ⚠️ **文档不一致（阶段归属）**：PRD §7 的 Phase 1 行按需求区间覆盖 `FR-M1 – FR-M19`，其中含
> `FR-M10`（有界注入）；但 Phase 2 行的**文案**也写了「有界注入」与「注入不再随日志线性增长」，
> 而它的需求列从 `FR-M20` 起。**处置（取设计为准）**：`FR-M10` 的**机制**落在 Phase 1（M1-11 纯函数
> `buildInjectionBlock` + M1-12 接线），Phase 2 只做**预算参数化、`truncated` 可观察与 UI 呈现**
> （M2-05/M2-06）——即 Phase 2 的文案描述的是**收口**，不是首次实现。

### 1.3 与既有文档的收口关系

| 本文档 | 收口目标 |
|---|---|
| `docs/plan-memory-v2.md`（本文） | 增量（待实施）；收口目标：并入 `docs/nanowork-prd-design-v2.md` 第 14 章的落地记录，或按 `docs/README.md` §八 登记后再定 |
| 登记动作 | **由文档负责人执行**，本计划不编辑 `docs/README.md` |

---

## 2. 任务分解表

> **通用约定**
> - 任务编号 `M<阶段>-<序号>`；依赖写任务 id；需求写 `FR-M*` / `NFR-M*`；不变量写 `I*`（设计 §8）。
> - 「产出文件」只使用设计 §7.1（新增）/ §7.2（改动）/ §7.3（测试）的路径；**不发明新路径**。
> - 验收命令全部取自 `package.json`：`npm test -- <path>` 展开为 `vitest run <path>`。
> - **定义完成（DoD）**：**每个任务的定义完成 = 该行「验收命令 / 判据」全部成立 + 下面四条通用要求**：
>   ① 验收命令全绿；② 新增/改动的公开导出有注释说明「为什么」，与仓库既有注释风格一致；
>   ③ 未新增渲染层 `electron` 引用（`I12`）；④ 未新增 `[LOCAL PATCH]`（`nanobot/` 零改动）。
>   任务表只额外写与该任务相关的差异判据。
>
> ⚠️ **两处必须先澄清的接缝（实施前拍板，落在对应任务里）**
> 1. **`src/lib/memory.ts` 与 `src/lib/memory/index.ts` 并存**：设计 §7.1 把门面放在新目录的 `index.ts`，
>    §7.2 把 `src/lib/memory.ts` 降为「转出壳」。实测 `tsconfig.json` 是 `moduleResolution: "bundler"`，
>    裸路径 `@/lib/memory` 会解析到**文件**而非目录索引。**处置**：M0-08 的转出壳按**显式子路径**再导出
>    （`export * from '@/lib/memory/fact'` 等），并把 `MemoryService` 单例本身留在 `src/lib/memory/index.ts`；
>    禁止任何代码依赖「目录索引」解析，`tests/memory/store.test.ts` 加一条 `import` 解析断言。
> 2. **`electron/main.ts` 不在设计 §7.2 清单里**，但 `memory:*` 六个 IPC handler 实测在
>    `electron/main.ts:2474-2492`。**处置**：M0-05 明确改动 `electron/main.ts`（新增 `memory:replace` /
>    `memory:appendLine` / `memory:readLines`），并按 §4.1 规则**重建 `main.cjs` / `preload.cjs`**。

### 2.1 Phase 0 · 平台与存储地基（10 个任务）

| id | 任务名 | 产出文件 | 依赖 | 需求 | 验收命令 / 判据（=DoD） |
|---|---|---|---|---|---|
| **M0-01** | 平台契约：新增 `MemoryFiles` + `MemoryStoreRef`，`WorkspaceMemoryFiles` 标 `@deprecated` | `src/platform/types.ts`(改) | — | FR-M4, FR-M16, NFR-M3 | `npm run typecheck` + `npm run typecheck:electron`；判据：`memoryFiles` 字段类型切换后**既有调用点零改动**（v1 六方法仍经弃用薄封装可用），`grep -rn "WorkspaceMemoryFiles" src/` 的命中点数量与改动前一致（实测基线：`types.ts` 声明 + `index.ts` 4 处引用/注释 + 两个实现类） |
| **M0-02** | 文件名策略与子目录白名单（纯逻辑，两端共用） | `src/lib/memory/paths.ts`(新)、`src/lib/workspaceMemory.ts`(改) | — | FR-M1, FR-M16, I11 | `npm test -- tests/workspaceMemory.test.ts`（新增用例：`daily/*.jsonl` / `archive/*.jsonl` 白名单、写入严/读取宽、`workspaceIdOf`/`scopeIdOf` 稳定性） |
| **M0-03** | Electron fs 三能力：`replaceMemoryFile`（temp → write → fsync → rename）/ `appendMemoryLine`（单次 write，不读全文）/ `readMemoryLines` | `electron/workspaceMemoryStore.ts`(改) | M0-01, M0-02 | FR-M16, NFR-M5 | `npm test -- tests/electron/workspaceMemoryStore.test.ts`（新增：替换原子性、失败时旧版本不变且 `*.tmp` 被清理、append 不读全文、`lstat` 拒符号链接与特殊文件仍成立） |
| **M0-04** | 主进程路径解析支持 `ref` + `subdir`（用户级根 `~/.nanowork/user-memory/<scope-id>/`） | `electron/memoryRoutes.ts`(改) | M0-02 | FR-M4, NFR-M3 | `npm test -- tests/electron/memoryRoutes.test.ts`（新增：`resolveUserMemoryDir`、`resolveMemorySubdir`、越界拒绝、`\0`/相对路径回落兜底目录） |
| **M0-05** | `memory:*` IPC（`replace` / `appendLine` / `readLines`）+ preload + **重建构建产物** | `electron/main.ts`(改)、`electron/preload.ts`(改)、`electron/main.cjs`+`electron/preload.cjs`(重建) | M0-03, M0-04 | NFR-M9, NFR-M5 | `npm run electron:serve`（内部用 esbuild 重建 `main.cjs`/`preload.cjs`）+ `npm run typecheck:electron`；判据：真机可用新通道，`git status` 显示两个 `.cjs` 已更新 |
| **M0-06** | 两端 `MemoryFiles` 实现 + 平台装配（Web 用 `localStorage` 前缀模拟目录） | `src/platform/storage.web.ts`、`src/platform/storage.electron.ts`、`src/platform/index.ts`(改) | M0-01, M0-05 | NFR-M3, NFR-M9 | `npm test -- tests/memory/store.test.ts`；判据：Web 端 `replace` 等价单键原子、无 tmp 阶段；「无文件落点」在 UI 文案上明示（NFR-M9 不允许「Electron 能存、Web 静默丢」） |
| **M0-07** | `MemoryStore` 骨架：**唯一**持久化边界（只此一处碰 `platform.memoryFiles`）、进程内缓存、版本分计数器 | `src/lib/memory/store.ts`(新) | M0-06 | FR-M16, NFR-M2, I11 | `npm test -- tests/memory/store.test.ts`；判据：`writeVersion()` 组合值**单射**（同 (user,workspace) 版本对 → 不同数字）、构造时不写种子数据、不构造 provider client（NFR-M1） |
| **M0-08** | 门面与转出壳：`MemoryService` 单例语义不变，既有 import 路径可用 | `src/lib/memory/index.ts`(新)、`src/lib/memory.ts`(改) | M0-07 | NFR-M4 | 9 个 v1 记忆测试文件全绿（命令见 §4.3）；判据：`grep -rn "from '@/lib/memory'" src tests` 全部仍可解析 |
| **M0-09** | settings `version: 13 → 14`：新增 `memoryDistillPolicy`(对象) / `memoryRetentionDays` / `memoryBudget` + 迁移 | `src/types/settings.ts`、`src/stores/settingsStore.ts`(改) | — | FR-M5, FR-M10, NFR-M1 | `npm test -- tests/settingsMemoryMigration.test.ts`；判据：`autoSummarize = true` 的 v9 提升逻辑**一句不动**；类型/默认值/迁移/UI 四处同改（`docs/settings-inventory.md` 维护约定） |
| **M0-10** | 故障注入夹具与不变量断言桩（单一 `crashAt(boundary)` 开关，夹具内联在本文件） | `tests/memory/transaction.test.ts`(新) | M0-06, M0-07 | NFR-M5 | `npm test -- tests/memory/transaction.test.ts`；判据：§5 的十个边界**每一个都能被单独注入**，且注入后 `new MemoryStore(ref)` 可跑完恢复流程（断言先按骨架写死期望值） |

### 2.2 Phase 1 · 事实 → 蒸馏 → 冲突 → 事务 → 裁决（12 个任务）

| id | 任务名 | 产出文件 | 依赖 | 需求 | 验收命令 / 判据（=DoD） |
|---|---|---|---|---|---|
| **M1-01** | 事实模型、校验与 `factId` 生成（fail-closed：任一字段非法整条拒绝） | `src/types/memory/fact.ts`(新)、`src/types/memory/index.ts`(新)、`src/lib/memory/fact.ts`(新) | M0-02 | FR-M1, FR-M2 | `npm test -- tests/memory/fact.test.ts`（kind / importance 1–5 / content ≤2000 / `memoryKey` 正则≤64 / `observedAt` 未来 >5min 拒绝 / `looksLikeSystemError` 命中即拒；`factId` 跨进程稳定） |
| **M1-02** | 事实日志 append-only 写入 + `loadFacts` 窗口读 + 近 N 日 `factId` 去重 | `src/lib/memory/store.ts`(改) | M0-07, M1-01 | FR-M1, I1 | `npm test -- tests/memory/store.test.ts`；判据：写入只走 `appendLine` 单次追加；`distill` 前后 `daily/*.jsonl` **逐字节不变**（I1） |
| **M1-03** | legacy 只读投影：v1 `MEMORY.md`/`YYYY-MM-DD.md` 段落 → `origin='legacy'` 事实（**不写回文件、不参与自动晋升**） | `src/lib/memory/legacy.ts`(新) | M0-07, M1-01 | FR-M3, FR-M4 | `npm test -- tests/memory/distill.test.ts`（读兼容用例）；判据：迁移前后 `loadForInjection()` 的**条目集合不减少**，`git status` 显示记忆文件零改动 |
| **M1-04** | `distillFacts` / `validateCuratedState`（**纯函数**：无 IO、无 platform、无模型、无时钟读取） | `src/types/memory/curated.ts`(新)、`src/lib/memory/distill.ts`(新) | M1-01 | FR-M5–FR-M9, NFR-M1, NFR-M8 | `npm test -- tests/memory/distill.test.ts`（门槛矩阵、幂等、`legacy:` 域互不替代、替代三门槛、同分 fail-closed、`DistillReport` 每项可观察、损坏状态抛 `CorruptCuratedStateError`；**10k 事实 < 2s**） |
| **M1-05** | 投影渲染：`renderCuratedProjection`（只渲染 `active`，带轻量元信息） | `src/lib/memory/project.ts`(新) | M1-04 | FR-M10(投影), I6 | `npm test -- tests/memory/injection.test.ts`；判据：**永不**渲染 `superseded`/`disabled`/冲突候选；同 `CuratedState` 两次渲染逐字节相同 |
| **M1-06** | 冲突类型与确定性 `conflictId`（`hash(scope + memoryKey + evidenceFingerprint)`） | `src/types/memory/conflict.ts`(新) | M1-04 | FR-M11, FR-M12 | `npm run typecheck` + `npm test -- tests/memory/distill.test.ts`（同证据 → 同 `conflictId`，重启不重复建案） |
| **M1-07** | 建案 / 推进 case + `conflicts.json` 原子替换；证据变化时旧 case 标 `superseded` | `src/lib/memory/store.ts`、`src/lib/memory/distill.ts`(改) | M1-06, M0-07 | FR-M11, FR-M12, I2 | `npm test -- tests/memory/distill.test.ts`；判据：重复 `distill()` 不重复建案、无 case 变化时只做单文件原子替换 |
| **M1-08** | 事务 journal：intent（before/after 全量快照 + `intentSha256`）+ `prepared → curated_applied → conflict_closed → audit_appended → committed` | `src/lib/memory/transaction.ts`(新) | M0-10 | FR-M16, FR-M17, I10 | `npm test -- tests/memory/transaction.test.ts`（五阶段顺序、每阶段**先完成目标写入再追加阶段事件**、intent 篡改/阶段跳跃/`workspaceId` 不匹配显式拒绝） |
| **M1-09** | 重启幂等前滚 + 投影中断修复（`recoverPendingTransactions()` 在 store 构造时调用） | `src/lib/memory/store.ts`(改) | M1-08 | FR-M18, FR-M19, I6, I10 | `npm test -- tests/memory/transaction.test.ts`（磁盘 == before → 重做；== after → 继续；否则 **fail-closed**；多次恢复结果相同；陈旧投影由 canonical 重渲染修复） |
| **M1-10** | `resolveConflict` 协调层：五条重校验 + challenger/incumbent 两分支 + 审计追加 + `eventId` 幂等 | `src/lib/memory/adjudicate.ts`(新) | M1-07, M1-08 | FR-M13–FR-M15, I4, I5 | `npm test -- tests/memory/adjudicate.test.ts`（`StaleConflictResolutionError` / `ConflictEventReuseError`；选 incumbent **修订数 +0**；审计字段完整：actor / rationale / case revision / 选中证据 / 原 active key / 结果 active key / eventId） |
| **M1-11** | 有界注入块：`buildInjectionBlock` + 预算裁剪（`importance DESC → lastSeen DESC → entryKey ASC`）+ provenance 行 | `src/lib/memory/injection.ts`(新) | M1-05 | FR-M10, NFR-M6, I8 | `npm test -- tests/memory/injection.test.ts`（只注入 active + 最近 `recentFactLimit`(6)；不注入 superseded/候选/open case/日志全文/transcript；`truncated` 与实际裁剪一致；空记忆返回空串不产 wrapper） |
| **M1-12** | 注入接线：`loadMemoryInto` 改调 `buildInjectionBlock`、`isMemorySnapshotStale` 用组合版本、`sedimentSession` 落结构化事实、`<memory-save>` 走 `appendFact`；指令协议加可选 `key`/`kind`/`importance` | `src/stores/sessionsStore.ts`、`src/lib/memoryDirective.ts`、`src/lib/promptAssembly.ts`(改) | M1-02, M1-11, M0-09 | FR-M1, NFR-M2, I8, I9 | `npm test -- tests/sessionsStore.test.ts tests/sessionsPromptAssembly.test.ts`；**守门用例「快照过期时 `send` 仍同步进入流式态」必须原样绿**；结构化块真的进了请求 system 段（`tests/sessionsPromptAssembly.test.ts` 新增）；段序与 `<!-- MEMORY -->` 标签不变 |

### 2.3 Phase 2 · 用户画像与偏好 + 有界注入收口 + 治理页（10 个任务）

| id | 任务名 | 产出文件 | 依赖 | 需求 | 验收命令 / 判据（=DoD） |
|---|---|---|---|---|---|
| **M2-01** | Profile 字段级 patch（9 字段白名单；`null` = 显式删除；schema 外报错；整体拒绝） | `src/types/memory/profile.ts`(新)、`src/lib/memory/profile.ts`(新) | M0-06 | FR-M20, FR-M24 | `npm test -- tests/memory/profile.test.ts`（等值 patch 记 `unchanged` 且**不重写 canonical**；投影过期仍修复投影；`{"name": null}` 报错而不是注入 `Name: None`） |
| **M2-02** | Preference 键级生命周期（`CREATED`/`UNCHANGED`/`UPDATED`、完整幂等身份、expiry UTC、stale 拒绝、`deletePreference` 精确删除） | `src/types/memory/preference.ts`(新)、`src/lib/memory/preference.ts`(新) | M0-02 | FR-M21–FR-M23 | `npm test -- tests/memory/preference.test.ts`（同 value + 同 source/expiresAt/sourceEventId、更晚重试 = no-op 且**不推进证据时间**；同 value 延长 expiry = `UPDATED`(rev+1)；`listActivePreferences(asOf)` 是唯一可注入集合） |
| **M2-03** | 用户级 store 落盘：`profile.json` / `preferences.json` / `curated.json` 原子替换 + `userScope` 校验 + v1 单文件用户记忆懒迁移 | `src/lib/memory/store.ts`(改) | M2-01, M2-02, M0-06 | FR-M4, FR-M21, FR-M24 | `npm test -- tests/memory/store.test.ts tests/memory/preference.test.ts`；判据：`userScope` 不匹配**拒绝读取**（I11）；旧 `nanowork.userMemory` 内容不丢、原文件改名 `.migrated`、storage key 保留只读 |
| **M2-04** | 用户级投影：`renderUserMemoryProjection`（profile + active 偏好 + active 修订 + `user.md`） | `src/lib/memory/project.ts`(改) | M2-03 | FR-M20, I6 | `npm test -- tests/memory/injection.test.ts`；判据：历史 `asOf` 查询是**纯读取**，不写回当前投影 |
| **M2-05** | 注入预算收口：`InjectionBudget`（用户级 4000 / 工作区级 3000 / 最近 6 条）+ `truncated` 上报 + `MemoryBar` 提示 | `src/lib/memory/injection.ts`(改)、`src/components/MemoryBar.tsx`(改) | M1-11 | FR-M10, NFR-M6 | `npm test -- tests/memory/injection.test.ts`；判据：注入总量**不随 daily 日志天数增长**（加 30 天日志后字符数不变），截断时 `MemoryBar` 显示「因预算截断 N 条」 |
| **M2-06** | 事实视图：按作用域列 active 修订（内容 / kind / importance / revision / firstSeen / lastSeen / 证据来源） | `src/components/memory/FactListView.tsx`(新)、`src/components/memory/BudgetBar.tsx`(新) | M2-04, M2-05 | FR-M31, FR-M34 | `npm test -- tests/memoryPage*.test.tsx`；判据：legacy 条目带「历史格式」角标；证据可展开到 `factId` |
| **M2-07** | 待裁决队列：候选内容 + 各自证据 + 检测时间 + case `revision`；提交带 `expectedRevision` 与理由；陈旧提示 | `src/components/memory/ConflictQueue.tsx`(新) | M1-10 | FR-M32 | `npm test -- tests/memoryPage*.test.tsx`；判据：陈旧时提示「证据已变化，请重看」并刷新；`listConflicts()` 是取到 open case 的**唯一**入口 |
| **M2-08** | 记忆页拆三视图（事实 / 待裁决(N) / 文件-高级）；v1 编辑器原样保留并折叠 | `src/components/memory/MemoryFileEditor.tsx`(新)、`src/pages/memory/MemoryPage.tsx`(改) | M2-06, M2-07 | FR-M31, FR-M32（+ v1 兼容） | `npm test -- tests/memoryPageScope.test.tsx tests/memoryPage*.test.tsx`；判据：**v1 文件编辑器的既有用例语义不变**（作用域切换 + 文件切换 + 导出/清空/回滚） |
| **M2-09** | 单条停用 / 删除 / 改作用域（canonical + 审计；`disabled` ≠ `delete` ≠ `superseded`） | `src/lib/memory/store.ts`(改)、`src/pages/memory/MemoryPage.tsx`(改) | M2-03, M2-06 | FR-M31, FR-M34 | `npm test -- tests/memory/store.test.ts tests/memoryPage*.test.tsx`；判据：`disabled` 立即停止注入但保留可恢复；`delete` 真删且留审计 |
| **M2-10** | 设置页新增保留期 / 预算 / 蒸馏门槛；**Phase 2 末清理** `WorkspaceMemoryFiles` 弃用薄封装 | `src/components/settings/sections/MemorySection.tsx`(改)、`src/platform/types.ts`、`src/platform/index.ts`(改) | M2-05, M0-09 | FR-M5, FR-M10, NFR-M4 | `npm test -- tests/settingsDialogSections.test.tsx tests/settingsMemoryMigration.test.ts` + 全量 `npm test`；判据：加字段同时改「类型 / 默认值 / 迁移 / UI」四处；`grep WorkspaceMemoryFiles src/` 仅剩历史注释 |

### 2.4 Phase 3 · 跨会话召回（9 个任务）

> **并行机会**：本阶段除 M3-09 外**只依赖 `M0-01` 与召回自身类型**（只读、不写 store），
> 因此 `M3-01`–`M3-08` 可与 Phase 1/2 **并行推进**（见 §3.1 泳道 C）。
> **前置阻塞**：M3-09 依赖 §10.2 **B-1**（`recall_history` 的暴露通道）拍板。

| id | 任务名 | 产出文件 | 依赖 | 需求 | 验收命令 / 判据（=DoD） |
|---|---|---|---|---|---|
| **M3-01** | 召回类型契约：`StoredMemory` / `RecallQuery` / `RecallCandidate` / `RecallScoreBreakdown` / `RecallHit` / `RecallResult` | `src/types/memory/recall.ts`(新)、`src/lib/recall/types.ts`(新) | M0-01 | FR-M25, FR-M27 | `npm run typecheck`；判据：`storedAt`（进入存储）与 `capturedAt`（来源事件发生）是**两个字段** |
| **M3-02** | `normalize`：折叠空白 → NFKC → casefold → 空白归一；英文按词；**连续中文补二元字符**；空/纯标点明确拒绝 | `src/lib/recall/normalize.ts`(新) | M3-01 | FR-M26 | `npm test -- tests/recall/normalize.test.ts`（「分层记忆」→ 分层/层记/记忆；`limit ∉ [1,10]` 拒绝；「继续上次」这类依赖上下文的 query 在契约层不特殊处理、由工具描述约束） |
| **M3-03** | `candidate`：只读 `kind==='conversation'`、逐条校验 `userScope`、只留有词项重合者 | `src/lib/recall/candidate.ts`(新) | M3-02 | FR-M27, FR-M29 | `npm test -- tests/recall/candidate.test.ts`；判据：本阶段**无 score / rank**、不写回存储 |
| **M3-04** | `score`：`total = 0.85 × lexicalCoverage + 0.15 × recency`，返回完整 breakdown | `src/lib/recall/score.ts`(新) | M3-03 | FR-M27, FR-M28 | `npm test -- tests/recall/score.test.ts`（`matchedTerms` / `queryTermCount` / `weights` / `contributions` 齐备；10k 消息语料 < 300ms） |
| **M3-05** | `stableRank`：`total DESC → lexicalCoverage DESC → capturedAt DESC → memoryId ASC` | `src/lib/recall/rank.ts`(新) | M3-04 | FR-M28 | `npm test -- tests/recall/rank.test.ts`；判据：打乱输入数组顺序（模拟 JSONL 插入顺序）后排名**完全相同** |
| **M3-06** | `render`：XML，每 hit 带 `query_id`/`scope`/`provenance`/`score_breakdown`；**无匹配返回空串** | `src/lib/recall/render.ts`(新) | M3-05 | FR-M29 | `npm test -- tests/recall/render.test.ts`（空 hits → `''`，不为空 wrapper 消耗预算） |
| **M3-07** | 语料适配器：`EventStore.listMetas() → readEvents(id, workdir) → activePath → projectMessages`，进程内 LRU + 上限 10000 条按 `capturedAt DESC` 裁剪 | `src/lib/recall/source.ts`(新) | M3-01 | FR-M30（+ ADR-023 同源） | `npm test -- tests/recall/source.test.ts`；判据：**不落盘**（无新 durable 文件）、只读、`memoryId = ev:<sessionId>:<messageId>` 稳定 |
| **M3-08** | `RecallEngine`：编排五阶段 + 缓存按 `rev` 失效 + `emptyReason='no_matching_terms'` | `src/lib/recall/engine.ts`(新) | M3-02…M3-07 | FR-M25, FR-M29 | `npm test -- tests/recall/engine.test.ts`（任意次召回后 durable store **逐字节不变** = I7；无匹配返回空 hits + `searchedRecords`/`candidateRecords`） |
| **M3-09** | 召回通道：**客户端按轮触发**（触发门槛 + 预算 + `<recalled_context>` 渲染），`recall()` 可被 harness 显式调用但不进模型工具清单 | `src/lib/memory/injection.ts`(改)、`src/stores/sessionsStore.ts`(改)、`src/lib/recall/render.ts` | M3-08 | FR-M25a, FR-M26, FR-M29, NFR-M10 | `npm test -- tests/recall/engine.test.ts tests/recall/render.test.ts`；判据：`recall` **不出现在**模型可见的能力面；引擎侧零改动；命中 0 条不产 `<recalled_context>` 块；连续追问同一话题不重复召回（I7） |

### 2.5 Phase 4 · 保留 / 归档 / 导出 / 边界收口（6 个任务）

| id | 任务名 | 产出文件 | 依赖 | 需求 | 验收命令 / 判据（=DoD） |
|---|---|---|---|---|---|
| **M4-01** | 归档与保留策略：`archiveAfterDays`(默认 180) 之外的 `daily/*.jsonl` → `archive/`；`distill` 不扫 `archive/`；**不删除证据** | `src/lib/memory/store.ts`、`src/lib/memory/distill.ts`(改) | M1-04, M0-06 | FR-M33, I1 | `npm test -- tests/memory/store.test.ts tests/memory/distill.test.ts`；判据：归档前后 `evidence_ids` 仍可解析到原事实（NFR-M7）；归档**不改变**任何 active 值 |
| **M4-02** | 导出 bundle：`{schema, exportedAt, userScope, workspaceId, facts, curated, conflicts, adjudications, profile, preferences}`；既有 Markdown 导出保留 | `src/lib/memory/index.ts`(改)、`src/pages/memory/MemoryPage.tsx`(改) | M2-03, M1-10 | FR-M35 | `npm test -- tests/memoryPage*.test.tsx`；判据：bundle 字段齐全、`JSON.parse` 后自包含（不引用外部文件） |
| **M4-03** | 导入校验与来源标记：校验 `workspace_id` / `user_scope`，记 `origin='import'` | `src/lib/memory/index.ts`、`src/types/memory/fact.ts`(改) | M4-02 + **B-3** | FR-M35, I11 | `npm test -- tests/memory/fact.test.ts tests/memory/store.test.ts`；判据：scope 不匹配**拒绝导入**并给出原因；导入不覆盖既有 active（改为候选） |
| **M4-04** | 边界收口：记忆页顶部**静态说明**「客户端记忆 v2 是唯一长期记忆源」+ `docs/` 文案收敛（**只读元信息面板推迟 Phase 5**，见 §10.2 B-2） | `src/pages/memory/MemoryPage.tsx`(改)、`docs/nanowork-prd-design-v2.md` §14(改)、`docs/prd-memory.md` §6.8(改) | M2-08 | FR-M36 | `npm test -- tests/memoryPage*.test.tsx`；判据：记忆页明示边界；**本期不新增任何 IPC**；面板相关代码不在本任务范围 |
| **M4-05** | 文档收口：v1 文档顶部横幅指向三件套；唯一事实源 §14 增补 v2 落地指针；`prd-memory.md` §6.8 补双记忆体系收敛说明 | `docs/prd-memory.md`、`docs/architecture-memory.md`、`docs/nanowork-prd-design-v2.md` §14(改) | M4-01…M4-04 | FR-M36 | 判据：三处横幅/指针存在且指向三件套；`docs/README.md` **未被本任务修改**（登记由负责人执行） |
| **M4-06** | 全量回归与验收：门禁 + 不变量 + 崩溃矩阵 + 对标清单复跑 | 无新增文件 | M4-01…M4-05 | NFR-M4, NFR-M7 | `npm run typecheck && npm run typecheck:electron && npm run typecheck:tests && npm test && npm run build`；`git diff --stat` 确认 9 个 v1 记忆测试文件未删改语义；`git status nanobot/` 为空（零 `[LOCAL PATCH]`） |

### 2.6 Phase 5（不在本次，**零任务**）

云端画像、跨设备记忆同步、向量 / embedding / LLM reranker。**只留两条接口约束**（设计 §10）：
① `distillFacts` 必须确定性（无时钟读取、无随机、无 Map 迭代顺序依赖）——M1-04 的验收项；
② 同步只同步 append-only 证据流（`daily/*.jsonl` / `conflict-adjudications.jsonl` /
`conflict-resolution-transactions.jsonl`），`curated.json` / `conflicts.json` / 投影是**每台设备各自重算的派生物**。

---

## 3. 关键路径与并行度

### 3.1 四条泳道

| 泳道 | 内容 | 任务 | 前置 |
|---|---|---|---|
| **A · 平台与存储**（串行，关键路径） | 契约 → fs 能力 → IPC → 两端实现 → store 骨架 → 门面 | M0-01 → M0-02 → M0-03/M0-04 → M0-05 → M0-06 → M0-07 → M0-08 | 无（**第一批开工**） |
| **B · 纯函数与状态机** | 事实模型 → 蒸馏 → 投影 → 冲突 → 事务 → 裁决 → 注入 | M1-01…M1-11 | M0-02（M1-01）、M0-07（M1-02/03/07）、M0-10（M1-08） |
| **C · 召回**（只读，可与 Phase 1/2 并行） | 类型 → normalize → candidate → score → rank → render → source → engine | M3-01…M3-08 | **仅 M0-01**（不需要 store、不写盘） |
| **D · 接线与 UI** | 注入接线 → 预算/`MemoryBar` → 三视图 → 停用/删除 → 设置页 → 导出/诊断 | M1-12、M2-05…M2-10、M4-02、M4-04 | 各自的功能依赖（见 §2） |

`M0-09`（settings v14）与 `M3-*` 一样是**无依赖可随时开工**的任务。

### 3.2 关键路径（单开发者视角不可压缩的那条）

```
M0-01 → M0-02 → M0-03 → M0-05 → M0-06 → M0-07 → M0-08
      → M1-01 → M1-02 → M1-04 → M1-06 → M1-07 → M1-08 → M1-09 → M1-10
      → M1-11 → M1-12 → M2-05 → M2-06 → M2-08 → M2-09 → M4-01 → M4-06
```

约 **26 个任务**在关键路径上（其余 21 个可并行或可后置）。三个最容易低估的接缝：

| 接缝 | 为什么是接缝 | 必须先于 |
|---|---|---|
| `M0-01` 平台 `MemoryFiles` 契约 | 任何持久化都经它；契约错了后面每个任务的产出文件都要重写 | 所有涉及落盘的任务（M0-03…M2-10、M4-01…M4-03） |
| `M0-10` 故障注入夹具 | 故障注入不是「最后补测试」——没有 `crashAt` 开关，M1-08/M1-09 的恢复逻辑无法被验证 | M1-08、M1-09（以及 M4-06） |
| `M1-04` `distillFacts` 纯函数 | 冲突（M1-06/07）、投影（M1-05）、裁决（M1-10）、注入（M1-11）、归档（M4-01）全部读它的输出 | M1-05/M1-06/M1-07、M4-01 |
| `M1-11` 注入纯函数 | `sessionsStore`（2443 行）的接线必须一次做对，否则并发用例与记忆用例互相牵连 | M1-12、M2-05 |

### 3.3 推荐执行顺序（按「最早可交付价值」排序）

1. **第 1 批**：`M0-01`、`M0-02`、`M0-09`、`M3-01`（类型与契约先行，四人日以内）。
2. **第 2 批**：`M0-03`、`M0-04`、`M0-10`、`M3-02`、`M3-07`。
3. **第 3 批**：`M0-05`、`M0-06`、`M0-07`、`M1-01`、`M3-03`、`M3-04`。
4. **第 4 批**：`M0-08`、`M1-02`、`M1-03`、`M1-04`、`M3-05`、`M3-06`。
5. **第 5 批**：`M1-05`、`M1-06`、`M1-07`、`M1-08`、`M3-08`（召回主路径可在此闭合）。
6. **第 6 批**：`M1-09`、`M1-10`、`M1-11`（Phase 1 收口，此时 §5 矩阵必须全绿）。
7. **第 7 批**：`M1-12`、`M2-01`、`M2-02`、`M2-03`、`M2-04`。
8. **第 8 批**：`M2-05` → `M2-06`/`M2-07` → `M2-08`/`M2-09` → `M2-10`。
9. **第 9 批**：`M3-09`（等 B-1）、`M4-01`…`M4-06`。

### 3.4 不建议的并行

- **`M0-08`（门面转出壳）不得早于 M0-07**：门面一落地，40+ 调用点就在新链路上，store 骨架没就位会让整个仓库处于「可编译但语义未定」的状态。
- **`M1-12` 不得与 `M1-02`/`M1-11` 并行**：`sessionsStore.ts` 是 2443 行的热点文件，且它的并发用例（`tests/sessionsStore.test.ts`，815 行）是 `NFR-M2`/`I9` 的唯一守门人；同文件多线并行必然在合并时把刷新顺序改坏。
- **`M3-09` 不得早于 B-1 决策**：通道形态未定时写实现，等于把「引擎侧新增工具」这个违反硬约束的方案固化进代码。

---

## 4. 门禁与验证策略

### 4.1 可用命令（全部来自 `package.json`，无自造脚本）

| 命令 | 实际执行 | 证明什么 | 何时必跑 |
|---|---|---|---|
| `npm run typecheck` | `tsc --noEmit`（`src/`） | 渲染层类型完整 | **每个任务** |
| `npm run typecheck:electron` | `tsc --noEmit -p tsconfig.node.json` | 主进程（`electron/`）类型完整 | 凡动 `electron/` |
| `npm run typecheck:tests` | `tsc --noEmit -p tsconfig.test.json`（`src` + `tests`） | 测试代码类型完整 | 凡新增/改测试 |
| `npm test` | `vitest run`（jsdom，`tests/**/*.test.ts(x)`） | 全量回归 | 每阶段出口 + 每批合并 |
| `npm test -- <path…>` | `vitest run <path…>` | 单套件/多套件 | 每个任务的验收 |
| `npm run build` | `typecheck` + `typecheck:electron` + `vite build` | 生产构建可用（渲染层无 electron 引用会在打包时暴露） | 阶段出口 |
| `npm run build:electron` | `vite build` + esbuild 重建 `electron/main.cjs`、`electron/preload.cjs` + `electron-builder` 打包 | **构建产物与源码一致** | 动了 `electron/` 且要出包时 |
| `npm run electron:serve` | 同上（esbuild 重建）后 `electron .` | 真机链路可用（**日常用这条，不跑 electron-builder**） | M0-05 及任何 IPC 改动 |
| `npm run verify:gateway` | `vitest run tests/gateway.integration.test.ts` | 与真实 nanobot 网关的协议链未坏（自动沉淀 / 召回回注的真实请求） | M1-12、M3-09、M4-06（需本机网关） |
| CI 平台边界检查 | `.github/workflows/ci.yml` 的 `run: \|` 内联脚本（检查一：渲染层不得直连 `window.electronAPI`；检查二：引擎 wire 字段不得泄漏） | `I12`（渲染层零 electron）与 ADR-020 | M0-06、M3-07、M4-06；**本地无 npm script**，按 CI 脚本内容复现，并确认两条基线仍为空（`docs/README.md` 看板 #13/#14 已清空 + 有「基线项不存在即失败」自检） |

**`electron/main.cjs` / `preload.cjs` 是构建产物**：改了 `electron/*.ts` 而不重建，会出现「测试绿、真机行为是旧的」——
这是本计划里最容易被误判为「功能没生效」的坑（见 §7 R2）。

### 4.2 任务 → 测试文件映射（测试文件名严格取自设计 §7.3）

| 测试文件 | 覆盖 | 归属任务 |
|---|---|---|
| `tests/memory/fact.test.ts` | 校验矩阵、`factId` 稳定性、`origin` 联合（含导入）、`looksLikeSystemError` 出口拒收 | M1-01, M4-03 |
| `tests/memory/distill.test.ts` | 门槛矩阵、幂等、legacy 域隔离、替代三门槛、fail-closed 同分、`DistillReport` 各项、损坏状态报错、v1 读兼容 | M1-03, M1-04, M1-06, M1-07, M4-01 |
| `tests/memory/adjudicate.test.ts` | 五条校验、陈旧保护、`eventId` 幂等与复用拒绝、challenger/incumbent 分支、审计字段完整性、裁决 API 不对模型暴露 | M1-10, M3-09 |
| `tests/memory/transaction.test.ts` | 五阶段顺序、**§5 的故障注入矩阵**、重启前滚幂等、intent 防篡改、阶段跳跃拒绝、投影中断修复 | M0-10, M1-08, M1-09, M4-06 |
| `tests/memory/profile.test.ts` | 字段级 patch、`null` 删除、schema 外报错、类型约束、整体拒绝、等值 patch 不重写、投影修复 | M2-01 |
| `tests/memory/preference.test.ts` | `CREATED`/`UNCHANGED`/`UPDATED`、完整幂等身份、expiry 边界与时区、stale 拒绝、provenance 不可伪造、跨 scope 拒绝、`delete` 精确性 | M2-02, M2-03 |
| `tests/memory/injection.test.ts` | 只注入 active、不注入候选/过期/superseded、预算裁剪确定性、`truncated` 计数、空记忆不产块、护栏句与两段定序不变 | M1-05, M1-11, M2-04, M2-05 |
| `tests/memory/store.test.ts` | `replace` 原子性、`appendLine` 单写、懒迁移不丢内容、`workspaceId`/`userScope` 不匹配拒绝、`writeVersion()` 单射、导入 scope 校验 | M0-06, M0-07, M1-02, M2-03, M2-09, M4-01, M4-03 |
| `tests/recall/normalize.test.ts` | 中英文归一化、二元字符、空/纯标点拒绝、`limit` 边界 | M3-02 |
| `tests/recall/candidate.test.ts` | 词项重合过滤、`userScope` 校验、无 score/rank、只读 | M3-03 |
| `tests/recall/score.test.ts` | breakdown 完整性、权重常量、10k 语料 < 300ms | M3-04 |
| `tests/recall/rank.test.ts` | 四级 tie-break、打乱输入顺序结果相同 | M3-05 |
| `tests/recall/render.test.ts` | XML 形态、provenance 与 breakdown 保留、空结果空串 | M3-06 |
| `tests/recall/source.test.ts` | 事件流 → `StoredMemory` 适配、`activePath`/`projectMessages` 复用、上限裁剪、不落盘 | M3-07 |
| `tests/recall/engine.test.ts` | 五阶段编排、缓存失效、零写入（I7）、`emptyReason` | M3-08, M3-09 |
| `tests/memoryPageScope.test.tsx`（**改**） | v1 文件编辑器语义不变（作用域/文件切换/导出/清空/回滚） | M2-08 |
| `tests/memoryPage*.test.tsx`（**新增，遵循 §7.3 模式**） | 三视图切换、待裁决提交与陈旧提示、停用/删除、截断提示、诊断区只读 | M2-06, M2-07, M2-08, M2-09, M4-02, M4-04 |
| `tests/sessionsPromptAssembly.test.ts`（**改**） | 结构化块真的进了请求 system 段、预算裁剪在真实链路上生效、刷新仍在槽位之后 | M1-12, M2-05 |
| `tests/electron/memoryRoutes.test.ts`、`tests/electron/workspaceMemoryStore.test.ts`（**改**） | 新 IPC 契约、用户根路径解析、越界拒绝、符号链接拒绝 | M0-03, M0-04, M0-05 |

新增测试文件落在 `tests/memory/` 与 `tests/recall/`——**实测不需要改 `vitest.config.ts`**
（`include` 已是 `tests/**/*.test.ts(x)`），也**不需要改 `tsconfig.test.json`**（`include` 已含 `tests`）。

### 4.3 v1 回归底线（9 个文件，实测 1907 行）

| 文件 | 行数 | 它锁住的性质 |
|---|---|---|
| `tests/memoryService.test.ts` | 721 | 去重两层、`looksLikeSystemError` 判据、`parseSummary` 容错、`summarize` 三道防线 |
| `tests/electron/workspaceMemoryStore.test.ts` | 209 | 目录列读写、白名单、懒迁移、符号链接拒绝 |
| `tests/memoryScope.test.ts` | 205 | 两层合并定序、只写用户级也能读到、条目计数 |
| `tests/workspaceMemory.test.ts` | 187 | 文件名合法性与排序、合并规则 |
| `tests/memoryPageScope.test.tsx` | 166 | 记忆页作用域/文件切换与写盘目标 |
| `tests/lib/memoryMerge.test.ts` | 150 | 段落 LWW（2P-Set + 墓碑）、`normalizeForDedup` |
| `tests/electron/memoryRoutes.test.ts` | 123 | 路径解析与越界拒绝 |
| `tests/lib/memoryPrebackup.test.ts` | 90 | `snapshotBeforeWrite` 写前快照（FR-7.3） |
| `tests/settingsMemoryMigration.test.ts` | 56 | persist 迁移与开关默认值 |
| **合计** | **1907** | 与 PRD/设计所述「约 1900 行」一致 ✅ |

**规则**：这 9 个文件**允许新增用例**（新增的用例属于新任务的产出），**不允许删改既有断言语义**。
`M4-06` 用 `git diff` 复核这条规则；`tests/sessionsStore.test.ts`（815 行）与
`tests/sessionsPromptAssembly.test.ts`（459 行）同属守门人，`I9`/`NFR-M2` 的用例**特指不得改动**。

### 4.4 十二条不变量的钉法

| # | 不变量 | 钉在哪个测试 |
|---|---|---|
| I1 | `daily/*.jsonl` 行永不被 `distill` 修改或删除 | `tests/memory/distill.test.ts` + `tests/memory/store.test.ts`（归档不删证据） |
| I2 | 每个 `entryKey` 恰有一个 `active` | `tests/memory/distill.test.ts`（含损坏状态抛错） |
| I3 | 修订链连续、`supersedes`/`supersededBy` 互配 | `tests/memory/distill.test.ts` |
| I4 | 只有 `resolveConflict` 能改 active（且过五条校验） | `tests/memory/adjudicate.test.ts` |
| I5 | 裁决 `incumbent` **不产生新修订** | `tests/memory/adjudicate.test.ts`（断言 `revision` 计数 +0） |
| I6 | `MEMORY.md` / `user.md` 可由 canonical 逐字节重建 | `tests/memory/injection.test.ts` + `tests/memory/transaction.test.ts`（投影中断修复） |
| I7 | 召回**零写入** | `tests/recall/engine.test.ts`（召回前后 store 快照深比较） |
| I8 | 注入只含 active + profile/偏好 + 最近 N 条；预算未破；`truncated` 与实际一致 | `tests/memory/injection.test.ts` |
| I9 | 已水合会话 `send` 同步进入流式态（`NFR-M2`） | `tests/sessionsStore.test.ts`（**既有守门用例，不得改语义**）+ `tests/sessionsPromptAssembly.test.ts` |
| I10 | 崩溃后每个未完成裁决要么前滚到 `committed`、要么不动，且无重复审计行 | `tests/memory/transaction.test.ts`（§5 全矩阵 + 重复恢复幂等） |
| I11 | `workspaceId` / `userScope` 不匹配的 canonical 被拒绝读取 | `tests/memory/store.test.ts` + `tests/memory/preference.test.ts` + `tests/memory/fact.test.ts`（导入） |
| I12 | 渲染层无 `import 'electron'` | CI 平台边界检查（本地按 CI 脚本复现）+ `npm run build` |

### 4.5 阶段出口门禁

| 阶段出口 | 命令 | 必须同时成立的判据 |
|---|---|---|
| Phase 0 | `npm run typecheck && npm run typecheck:electron && npm test` | 9 个 v1 文件全绿；`tests/memory/store.test.ts` 与 `tests/memory/transaction.test.ts` 骨架绿；`WorkspaceMemoryFiles` 弃用标注存在；`main.cjs`/`preload.cjs` 已重建 |
| Phase 1 | `npm run typecheck && npm run typecheck:electron && npm run typecheck:tests && npm test && npm run build` | `I1`–`I6`、`I8`、`I9`、`I10` 全部有对应测试且绿；§5 矩阵十条全绿；`tests/sessionsStore.test.ts` 并发用例未被削弱 |
| Phase 2 | 同上 + `npm test -- tests/settingsDialogSections.test.tsx` | `I6`、`I8`、`NFR-M6`（注入总量不随日志天数增长）、`NFR-M9`（Web 降级明示）；`WorkspaceMemoryFiles` 弃用封装清零；persist v14 迁移绿 |
| Phase 3 | 同上 + `npm run verify:gateway` | `I7` 绿；五阶段契约齐备；`FR-M26` 的空/纯标点拒绝与自包含要求有测试；裁决 API 不在模型能力面 |
| Phase 4 | 同上 | `NFR-M7`（active 修订可回溯到 `evidence_ids` 与裁决事件）绿；bundle 往返可用；`git status nanobot/` 为空；`[LOCAL PATCH]` 计数仍为 104 |

### 4.6 NFR-M1（无 API key 可验证）与 NFR-M8（性能）的具体断言

- **NFR-M1**：`tests/memory/store.test.ts` 断言「import `@/lib/memory` 与 `@/lib/memory/store` 不构造 provider client、
  不创建默认 store 实例、不写种子数据」。实现侧的对应约束：`src/lib/memory/*` 的**纯函数模块**
  （`fact` / `distill` / `project` / `preference` / `profile` / `transaction` / `injection`）
  **不得** import `@/ai/connectionManager`；只有 `summarize` 一类的模型调用留在门面层（v1 现状即如此，
  `src/lib/memory.ts:2` 是唯一 import 点）。
- **NFR-M8**：三条断言分别落在 `tests/memory/distill.test.ts`（10k 事实 `< 2s`）、
  `tests/memory/injection.test.ts`（读盘 + 渲染 `< 50ms`）、`tests/recall/engine.test.ts`（10k 消息 `< 300ms`）。
  jsdom 下抖动较大，判据用**宽松阈值 + 相对比较**（例如「10k 事实的耗时 < 1k 事实的 20 倍」）以避免 CI 假红——
  但必须保留一条绝对上限断言，否则 `I8`/`NFR-M6` 的「不随日志线性增长」会退化成不可证。

---

## 5. 故障注入与崩溃安全测试矩阵

全部落在 `tests/memory/transaction.test.ts`（M0-10 建夹具、M1-08/M1-09 填实现）。

### 5.1 十个写入边界

| # | 注入点（NFR-M5 命名） | 注入方式（`crashAt`） | 崩溃后磁盘状态 | 期望恢复动作 | 判定 | 不变量 |
|---|---|---|---|---|---|---|
| 1 | **临时文件 write** | 在写 `*.tmp` 的过程中中断（写一半） | 目标文件 = `before`；`*.tmp` 内容为半截 | 清理全部 `*.tmp`，从 `prepared` **重做**该文件的替换 | **redo** | I10 |
| 2 | **flush**（未 fsync） | `flush` 之后、`fsync` 之前杀进程 | 目标 = `before`；`*.tmp` 逻辑上完整（仅页缓存） | 以「未 fsync 的 tmp 不可信」为前提：清理 + 重做替换 | **redo** | I6, I10 |
| 3 | **fsync** | `fsync` 之后、`rename` 之前杀进程 | 目标 = `before`；`*.tmp` 已持久 | 重放 `rename`（等价重做），或清理后重做替换 | **redo** | I6, I10 |
| 4 | **替换**（rename 完成、阶段事件未追加） | `rename` 之后、追加 `curated_applied` 之前杀进程 | `curated.json` = `after`；journal 最新为 `prepared` | 逐文件比较：== `after` → 视为已应用，**继续**追加阶段事件 | **continue** | I10 |
| 5 | **curated 前后** | 在 `curated.json` 替换的 before/after 两侧各注入一次 | `curated` ∈ {`before`, `after`} | `before` → **重做**整条事务；`after` → **继续** | **redo / continue** | I2, I3, I10 |
| 6 | **case 关闭（conflicts）前后** | 在 `conflicts.json` 替换两侧注入 | `curated` = `after`；`conflicts` ∈ {`before`, `after`} | 逐文件判定：`before` → 重做该文件；`after` → 继续 | **redo / continue** | I5, I10 |
| 7 | **审计追加前后** | 在 `append(conflict-adjudications.jsonl)` 两侧注入（含「写了一半的行」） | 审计可能已追加完整行、或留下**残行** | **按 `eventId` 去重**：已存在 → 不重复追加；残行 → 丢弃后续写 | **continue** | I10, NFR-M7 |
| 8 | **投影替换前后** | 在 `replace(MEMORY.md)`（含用户级 `user.md`）两侧注入 | canonical 完整；投影 ∈ {`before`, `after`, 半写} | **以 canonical 重渲染修复投影**，再继续关案与追加审计（**无 journal 阶段**，属派生物修复） | **redo（派生）** | I6 |
| 9 | **既非 before 也非 after** | 人为把 `curated.json` 改成第三种内容（模拟已存在更新或损坏） | 磁盘与 intent 快照都不匹配 | **fail-closed 抛错**：不回滚、不覆盖，交人工处置 | **fail-closed** | I10 |
| 10 | **journal 自身不可信** | 改 `intentSha256` / 删 `conflict_closed` 阶段事件 / 改 `workspaceId` | journal 不能作为恢复依据 | **显式拒绝**（不尝试前滚），并报出具体不一致项 | **fail-closed** | I10, I11 |

**四条通用断言**（每个边界都要过）：
① 恢复完成后每个冲突域仍**恰有一个 `active`**（I2）且链接互配（I3）；
② 同一注入点**重复恢复 N 次**结果逐字节相同（幂等，I10）；
③ `daily/*.jsonl` 与 `conflict-adjudications.jsonl` 的**既有有效行**不因恢复被改写或删除（I1）；
④ 恢复路径**不依赖**任何旧进程内对象（`new MemoryStore(ref)` 构造时完成，见设计 §4.5）。

### 5.2 注入实现约定（避免夹具本身成为假绿来源）

1. **单一开关**：`crashAt(boundary: Boundary, phase: 'before' | 'after')` 抛出 `InjectedCrash`，
   `Boundary` 是上表第 1–8 行的枚举字面量；第 9/10 行不由开关产生（是**填盘**，不是注入）。
2. **以 `before`/`after` 快照为唯一判据**：恢复逻辑只比较「磁盘 == intent.before」与「磁盘 == intent.after」，
   断言也只看这三态，不做「像不像 after」的模糊判断——这正是 `M1-09` 的 `fail-closed` 分支能被测到的前提。
3. **`fsync` 必须真的存在**：M0-03 的 `replaceMemoryFile` 若只写 `fs.writeFile` + `rename`（无 `fsync`），
   第 2/3 行就退化成同一件事，矩阵失去区分度。验收时用 `grep -n "fsync" electron/workspaceMemoryStore.ts` 佐证。
4. **Web 端等价性**：`localStorage.setItem` 是单键原子操作，第 1–4 行的 tmp 阶段退化为 no-op——
   `tests/memory/store.test.ts` 用 Web 实现跑一遍同一批用例，断言「Web 不会出现 Electron 独有的半写状态」
   （`NFR-M9`：能力对齐，差异必须显式而非静默）。

> ⚠️ **文档不一致（八边界的分解方式）**
> - PRD **NFR-M5** 把八个边界枚举为：临时文件 write / flush / fsync / 替换 / curated 前后 /
>   case 关闭前后 / 审计追加前后 / 投影替换前后。
> - 设计 **§4.5** 写的是「八个边界 = 5 个阶段事件追加点 + 3 次目标替换的前后」，而它的崩溃窗口表
>   只列了 **5 行**（`prepared` 后 / `curated` 替换后 / `conflict_closed` / `audit_appended` / 任意不符）。
>   两种分解不能一一对应（阶段事件是 5 个追加点、目标写入是 curated/conflicts/审计/投影 **4 处**，
>   「3 次替换」与「八个」都对不上），且**投影替换在阶段列表里没有对应阶段**，而 FR-M19 又要求它可恢复。
> - **处置（取设计为语义权威、PRD 为覆盖清单）**：上表按 **PRD 的八个命名 + 投影边界 + 两条 fail-closed 收尾**
>   建立覆盖（不合并、不省略），每行的恢复语义取设计 §4.5 的「重做 / 继续 / fail-closed」三分类；
>   投影边界按 **FR-M19 的原文**处理为「从 canonical 重渲染修复」，不新增 journal 阶段
>   （新增阶段等于修改设计 §4.5 的状态机，超出本计划权限）。

---

## 6. 迁移与回归清单

### 6.1 v1 → v2 迁移步骤（有序，每步自带验证）

| 步 | 动作（设计 §9） | 验证 |
|---|---|---|
| 1 | 平台能力就位（`replace` / `appendLine` / `readLines` / 用户级根）——**不动任何既有数据** | `npm test -- tests/memory/store.test.ts tests/electron/workspaceMemoryStore.test.ts`；`git status` 无记忆文件变更 |
| 2 | v1 工作区 `MEMORY.md` + `YYYY-MM-DD.md` **继续读**（`mergeMemoryFiles` 排序不变），段落投影为 `legacy` 事实**只读、不写回** | `npm test -- tests/workspaceMemory.test.ts tests/memory/distill.test.ts`；判据：迁移前后 `loadForInjection()` 的**条目集合不减少**（FR-M3） |
| 3 | v1 单文件用户记忆 `nanowork.userMemory` → `~/.nanowork/user-memory/<scope-id>/MEMORY.md`；原文件改名 `.migrated` 留档；storage key **保留只读**；内容作为 `origin='legacy'` 参与注入、**不自动晋升** | `npm test -- tests/memory/store.test.ts tests/memory/preference.test.ts`；判据：用户级条目数不减少、原文逐字节可读回 |
| 4 | 旧工作区单文件 `~/.nanowork/memory/<workspaceKey>.md` 仍走**既有** `migrateLegacy`（语义不改，按 mtime 归档成日期文件） | `npm test -- tests/electron/workspaceMemoryStore.test.ts`（既有用例原样绿） |
| 5 | persist `version: 13 → 14`：新字段补默认值；`memoryEnabled` / `autoSummarize` 保持 `true`；**v9 的 `false → true` 提升逻辑一句不动**（`src/stores/settingsStore.ts:295`） | `npm test -- tests/settingsMemoryMigration.test.ts`；判据：老用户直接升级后 `memoryDistillPolicy` 即 §4.3 的三个门槛 |
| 6 | 新目录 / 新文件**惰性创建**：只在真要写时才建（避免「每个打开过的项目都多出一个空文件夹」） | 判据：只读打开一个项目后 `<workdir>/.nanowork/` 不出现空目录；`clear` **不删目录本身**（v1 语义） |
| 7 | 段落级 LWW（`src/lib/memoryMerge.ts`）**保留不动**——它服务文件同步，与事实冲突域是两件事 | `npm test -- tests/lib/memoryMerge.test.ts`（既有用例原样绿） |
| 8 | 门禁与回归底线复核 | 9 个 v1 文件全绿 + `npm run typecheck && npm run typecheck:electron && npm run typecheck:tests && npm run build` |

**回滚锚点**：迁移全程不覆盖原文（第 2/3/4 步都留档或只读），且 v1 的写前快照
（`snapshotBeforeWrite`，`src/lib/memory.ts:689/716/727/771/785/843/857`）继续生效——
「迁移出错」的处置是**删除新建目录/键**，不是反向改写旧文件。

### 6.2 必须继续可用的 v1 行为（回归底线）

PRD §8 的 7 条（= 设计 §11 的前 7 行），外加设计 §11 补的两行——**九条全部受测试保护**：

| # | 保留项 | 由谁守着 |
|---|---|---|
| 1 | 落点在用户工作目录下（`<workdir>/.nanowork/memory/`），不往用户项目塞产品文件 | `tests/workspaceMemory.test.ts` + `tests/electron/memoryRoutes.test.ts` |
| 2 | 两层合并注入的定序（用户级在前、工作区级在后）+ 护栏句裁决规则 | `tests/memoryScope.test.ts` + `tests/memory/injection.test.ts` |
| 3 | 系统报错不落盘（`looksLikeSystemError` 三道防线） | `tests/memoryService.test.ts` + `tests/memory/fact.test.ts`（判据下沉到事实入口） |
| 4 | 注入快照失效机制（`memoryVersion` + `memoryWorkspace` + **同步**判定 + 补刷点在流式槽位之后） | `tests/sessionsStore.test.ts`（并发守门用例）+ `tests/sessionsPromptAssembly.test.ts` |
| 5 | **不做**字节相似度阈值去重（v2 用显式 `memory_key` + 替代门槛解决同一问题） | `tests/memoryService.test.ts`（三条真实重复/更新/补充的实测表用例） |
| 6 | 写前快照 / 版本回滚锚点（FR-7.3 `snapshotBeforeWrite`） | `tests/lib/memoryPrebackup.test.ts` + `tests/memoryPageScope.test.tsx`（版本历史） |
| 7 | `<memory-save>` 受控写入协议**不走工具审批** | `tests/memoryService.test.ts` + `src/lib/memoryDirective.ts` 的既有解析用例 |
| 8 | 段落级 LWW `memoryMerge.ts`（服务同步场景） | `tests/lib/memoryMerge.test.ts` |
| 9 | 身份文件 L4（`SOUL.md` / `IDENTITY.md` / `USER.md` / `BOOTSTRAP.md`）落点与注入方式不变 | `tests/identityService.test.ts`、`tests/promptAssembly.test.ts` |

> ⚠️ **文档不一致（清单条数）**：PRD §8 列 **7 条**，设计 §11 是 **9 行**（多出「段落级 LWW」「身份文件 L4」）。
> **处置**：不删任何一条——上表取**并集（9 条）**作为回归底线，PRD 的 7 条是它的子集。

### 6.3 迁移期需要特别盯的两个数据面

1. **用户级 storage key 双读期**：`nanowork.userMemory` 在迁移后**保留只读**，但 v1 的 `save('user')` /
> `append(..., 'user')` 仍会写它（`src/lib/memory.ts:686-693/840-848`）。若 M2-03 不同时把写入也切到新落点，
> 会出现「写进旧 key、读新目录」的分叉。**验收判据**：M2-03 之后 `grep -n "USER_MEMORY_KEY" src/`
> 仅出现在迁移读取路径上（写入路径必须改用 `MemoryStore` 用户级根）。
2. **legacy 域不参与晋升**：`legacy:` 前缀的域与显式 `memory_key` 域**永不互相替代**（设计 §4.3）。
> 判据：M1-03/M1-04 的用例必须包含「同一工作区既有 v1 段落又有新事实、且内容相同时，
> 不产生 supersede、只产生 merged/skipped」。

---

## 7. 风险登记册

概率/影响为 高/中/低；「早期信号」是**在出问题时最先能观察到的东西**。

| # | 风险 | 概率 | 影响 | 早期信号 | 缓解 | 责任任务 |
|---|---|---|---|---|---|---|
| R1 | **刷新被挪到流式槽位之前**（`NFR-M2`/`I9`）——读盘 `await` 前移会让同会话并发 `send` 互斥失效 | 中 | 高 | `tests/sessionsStore.test.ts` 并发用例报 `expected undefined to be defined` | M1-12 明确只改 `loadMemoryInto` 的**内部**（`buildInjectionBlock`），不改 `streamAssistantReply:701-716` 的顺序；守门用例**不得**改动 | M1-12 |
| R2 | **`electron/main.cjs` / `preload.cjs` 是构建产物**：改了源不重建 → 「测试绿、真机是旧行为」 | 高 | 中 | 真机点「保存记忆」没反应，但 `npm test` 全绿；`git status` 里 `.cjs` 无变更 | M0-05 的 DoD 强制 `npm run electron:serve`；任何动 `electron/` 的任务出口都要求两个 `.cjs` 已更新 | M0-05, M0-03, M0-04 |
| R3 | **Web 端 localStorage 降级**：无文件落点、单键容量约 5MB、`replace` 无 tmp 阶段 | 中 | 中 | Electron 上能存、Web 上「保存成功但重启丢」或写入超限抛 `QuotaExceededError` | M0-06 让两端走同一份契约测试；UI 明示「浏览器本地存储（Web 端无文件落点）」；超限走显式报错而非静默丢（NFR-M9） | M0-06, M2-05 |
| R4 | **`src/stores/sessionsStore.ts` 2443 行**、并发与记忆用例交织：一处顺序改动引发连锁回归 | 高 | 高 | `tests/sessionsStore.test.ts`（815 行）出现与本次改动无关的红 | M1-12 独占该文件（不与其他任务并行）；先加断言再改实现；改动面限制在 `loadMemoryInto` / `isMemorySnapshotStale` / `sedimentSession` / `<memory-save>` 四处 | M1-12 |
| R5 | 模型写不出合法 `memory_key`（PRD §9） | 高 | 低 | 事实大量落在 `legacy:` 派生域、显式域稀少 | `memory_key` **可选**；缺省走派生 key（FR-M7）；`<memory-save>` 协议不变，客户端补 `kind`/`importance` 默认值；三层兜底（显式 / 规则推断 / 派生） | M1-01, M1-12 |
| R6 | 30 岁门槛让**新项目短期没有策展记忆**，用户感觉「没记住」 | 高 | 中 | 记忆页显示「N 条已记，M 条待满 30 天晋升」而 active 修订为 0 | 近期事实仍进注入（`recentFactLimit`=6）；门槛可配置（`memoryDistillPolicy`）；UI 明示计数 | M0-09, M2-05, M2-06 |
| R7 | **人工裁决增加操作负担**，用户放着不处理 | 中 | 中 | 「待裁决 N」长期只增不减 | 只有平局才建案；未决候选**不进注入**（I8），不污染回答；`MemoryBar` 与记忆页给角标 | M1-10, M1-11, M2-07 |
| R8 | **事务 journal 写放大**：每次裁决多几次小写入 | 中 | 低 | 裁决路径写盘次数与耗时明显高于普通 `append` | journal 只出现在**裁决与策展写入**路径；`append` 仍是单次追加（`appendLine`） | M1-08, M1-02 |
| R9 | 结构化与 v1 Markdown **语义并存**导致认知负担（「该看哪个」） | 高 | 中 | 用户仍去编辑 `MEMORY.md` 而事实视图没人看 | 记忆页以**事实视图为默认**、文件编辑器折叠为「高级」；legacy 条目带「历史格式」角标（FR-M3） | M2-06, M2-08 |
| R10 | **召回吃掉上下文**，反而伤害回答质量 | 中 | 中 | 召回结果把 system 段明显挤长、回答变差 | 召回**只读**且**不自动注入**（FR-M29 结构化返回）；无匹配渲染空串；预算由 `NFR-M6` 兜底 | M3-06, M3-08 |
| R11 | **`src/lib/memory.ts` 与 `src/lib/memory/` 同名**：`moduleResolution: "bundler"` 下裸路径只解析到文件 | 高 | 中 | 新门面 `src/lib/memory/index.ts` 的改动「不生效」 | M0-08 用**显式子路径**再导出，`grep` 断言无裸路径依赖目录索引；加一条 import 解析断言 | M0-08 |
| R12 | **召回的暴露通道与「引擎零改动」冲突**（§10.2 B-1） | 高 | 高 | M3-09 一开工就发现需要动 `nanobot/` 或写一个本地 MCP server | ✅ **已处置**：改为**客户端按轮触发**（FR-M25a / 设计 §4.4 通道表 / §4.8 触发与注入边界），模型不产出任何协议标签，引擎侧零改动；预算与触发门槛入 NFR-M10，避免每轮召回把上下文吃满 | M3-09（已解除） |
| R13 | **引擎侧记忆诊断入口缺平台能力**（§10.2 B-2） | 中 | 低 | M4-04 需要新增只读回读，而设计 §7.2 没有这一行 | ✅ **已处置**：本期降级为**静态说明 + 文案收敛**（兑现 FR-M36 的认知目标），只读元信息面板推迟 Phase 5，与 FR-M37 共用同一条「引擎 workspace 路径读回」通道 | M4-04（已解除） |
| R14 | **`origin: 'import'` 不在 `FactOrigin` 联合里**（§10.2 B-3） | 中 | 低 | M4-03 编译报「`'import'` 不在联合类型中」 | M4-03 显式扩展 `src/types/memory/fact.ts` 的联合，并在计划/设计层补记（不改设计正文以外的语义） | M4-03 |
| R15 | **用户级 storage key 双读期数据分叉**（§6.3-1） | 中 | 高 | 用户级记忆在页面上「有时在、有时不在」 | M2-03 同时切**写入**路径；`grep USER_MEMORY_KEY` 只应出现在迁移读取处 | M2-03 |
| R16 | **`NFR-M8` 性能断言在 jsdom 下抖动**导致 CI 假红 | 中 | 低 | 同一个 commit 在不同机器上一红一绿 | 用宽松阈值 + 相对比较（10k vs 1k），保留一条绝对上限断言 | M1-04, M3-04 |
| R17 | **蒸馏不确定性**（时钟 / 随机 / Map 迭代顺序），破坏 Phase 5 的跨设备收敛前提 | 低 | 高 | 同输入两次 `distillFacts` 结果不同 | `now` 显式传参；纯函数模块禁止 `new Date()` / `Math.random()` / 依赖 `Map` 迭代顺序；`tests/memory/distill.test.ts` 加「同输入同结果逐字节」用例 | M1-04 |
| R18 | **双记忆体系边界收口不彻底**（G11）：引擎记忆仍被用户误认为客户端记忆 | 中 | 中 | 用户在诊断区看到引擎记忆，以为可以编辑/删除 | FR-M36 的措辞落到 UI 与 v2 §14：客户端记忆 v2 是**唯一**长期记忆源；诊断区只读且不可编辑 | M4-04, M4-05 |
| R19 | **`[LOCAL PATCH]` 膨胀**（任何需求改道到引擎都会让合并面变长） | 中 | 高 | `git -C nanobot diff` 出现新标记；合并上游时冲突面扩大 | 硬约束 2：引擎侧零改动；M4-06 复核 `nanobot/` 工作区为空、计数仍为 104 | 全阶段, M4-06 |
| R20 | **平台边界 CI 检查红**（新增模块误引 `electron` 或 wire 字段） | 低 | 中 | CI「平台边界检查」作业失败 | `src/lib/recall/*` 只经 `platform.*` 与 `@/events/*`；M3-07 出口跑一次边界复现 | M3-07, M4-06 |
| R21 | **归档误删证据**（把 retention 与 distill 混在一起实现） | 中 | 高 | 归档后某条 active 修订的 `evidence_ids` 解析不到 | M4-01 把「移动文件」与「蒸馏扫描范围」分开实现与分开测试；断言 `I1` | M4-01 |
| R22 | 记忆页三视图拆分**动到 v1 编辑器**导致既有行为回归 | 中 | 中 | `tests/memoryPageScope.test.tsx` 变红 | M2-08 把 v1 编辑器整体搬进 `MemoryFileEditor.tsx`，**不改逻辑只改宿主**；`memoryPageScope` 用例语义不得改 | M2-08 |

---

## 8. 估算

**假设**：1 名熟悉本仓库的资深开发者（读过 `CONTEXT`/v2 主文档/本文档，能独立跑三套 tsc 与 vitest）；
1 人日 = 6 小时有效编码；**含**写测试、跑门禁、写注释；**不含**产品评审、设计变更等待、真机长测、Phase 5。

| 阶段 | 任务数 | 人日 | 说明 |
|---|---|---|---|
| Phase 0 | 10 | **4 – 6** | 平台契约与 fs 能力是机械工作但**必须一次做对**；故障注入夹具（M0-10）是隐性成本大头 |
| Phase 1 | 12 | **14 – 20** | 蒸馏/冲突/事务/裁决四件事各需「纯函数 + 测试矩阵」；§5 的十条边界注入与幂等断言占 3–5 人日 |
| Phase 2 | 10 | **9 – 13** | 两个纯函数模块（profile/preference）规则密集但可测；三视图拆分与 v1 兼容是 UI 侧主要成本 |
| Phase 3 | 9 | **7 – 10** | 五阶段本身简单（透明基线 ranker），成本在**语料适配器**（复用 `activePath`/`projectMessages`）与零写入断言；不含 B-1 决策等待 |
| Phase 4 | 6 | **4 – 6** | 归档/导出/导入/文档/全量回归复跑 |
| **合计** | **47** | **38 – 55** | 单开发者串行；测试与故障注入约占 40% |

**关键路径下限**：若只做 §3.2 关键路径上的 26 个任务，约 **30 – 40 人日**。
**并行收益**：泳道 C（召回 M3-01…M3-08）与泳道 A/B 无数据依赖，双人并行可把总工期压到 **约 26 – 34 人日**
（瓶颈回到泳道 A 与 M1-12 的独占串行段）。

---

## 9. 验收清单（对标 WorkBuddy）

### 9.1 机制 → 需求 → 任务 → 判据

| WorkBuddy 机制（PRD §1.1） | 本次范围 | 需求 | 任务 | 可观察判据 | 命令 |
|---|---|---|---|---|---|
| **M1 三层作用域隔离** | ✅ 要求（云端层用本地结构化画像 + 召回等价实现） | FR-M1, FR-M4, FR-M24, FR-M10 | M1-01, M1-11, M2-01, M2-03 | 工作区事实不污染别的项目；`userScope` 不匹配被拒绝；注入块两段定序与护栏句不变 | `npm test -- tests/memory/store.test.ts tests/memory/preference.test.ts tests/memoryScope.test.ts` |
| **M2 每日日志 append-only** | ✅ 要求，**并升级**为结构化 JSONL | FR-M1, FR-M2, FR-M3 | M1-01, M1-02, M1-03 | `daily/YYYY-MM-DD.jsonl` 单行追加；`distill` 前后文件逐字节不变；v1 `YYYY-MM-DD.md` 仍可读 | `npm test -- tests/memory/fact.test.ts tests/memory/store.test.ts tests/memory/distill.test.ts` |
| **M3 精炼记忆（curated）** | ✅ **全部要求**：蒸馏 / 冲突域 / 替代门槛 / fail-closed / 人工裁决 / 事务 / 证据留存 | FR-M5–FR-M19, FR-M33 | M1-04…M1-10, M4-01 | 30 天门槛由显式策略决定（**不调模型**）；同分建案不动现状；challenger 才 +1 修订；崩溃可前滚；`evidence_ids` 可回溯 | `npm test -- tests/memory/distill.test.ts tests/memory/adjudicate.test.ts tests/memory/transaction.test.ts` |
| **M4 用户画像与偏好** | ✅ 要求（只读语义用 `source='remote'` 的只读投影等价表达） | FR-M20–FR-M23 | M2-01, M2-02, M2-03, M2-04 | 字段级 patch（`null` = 删除、schema 外报错、整体拒绝）；偏好键级生命周期 + expiry + provenance；`sourceEventId` 模型不可伪造 | `npm test -- tests/memory/profile.test.ts tests/memory/preference.test.ts` |
| **M5 历史对话检索** | ✅ 功能等价（检索范围 = 本机全部会话事件；**不要求**服务端语义排序） | FR-M25–FR-M30 | M3-01…M3-09 | 五阶段各有结构化产出；hit 带 `scope`/`provenance`/`score_breakdown`；稳定排序可复现；召回零写入；空/纯标点 query 明确拒绝 | `npm test -- tests/recall/` + `npm run verify:gateway` |
| **M6 治理闭环** | ✅ 要求（含冲突队列、单条删除/停用、过期与保留策略） | FR-M31, FR-M32, FR-M34, FR-M33 | M2-06…M2-09, M4-01 | 事实视图可查可停用可删除；「待裁决 N」可提交并带陈旧保护；`retentionDays`/`archiveAfterDays` 有独立策略且不删证据 | `npm test -- tests/memoryPage*.test.tsx tests/memory/store.test.ts` |

### 9.2 逐条勾选（评审用）

- [ ] **M1**：项目 A 的 `memory_key` 事实在项目 B 不可见；「我叫什么」跨项目可见（`workspace_id`/`user_scope` 双向校验）。
- [ ] **M2**：日志只追加；删日志的场景**不存在**于代码路径（`I1` 有测试）。
- [ ] **M2 升级**：新事实落 `daily/*.jsonl`；v1 `YYYY-MM-DD.md` 迁移前后条目集合不减少。
- [ ] **M3 蒸馏**：`distillFacts` 在**无 API key**下可跑通并有单测（`NFR-M1`）。
- [ ] **M3 冲突域**：同一 `memory_key` 的新旧值不并存；`legacy:` 域与显式域互不替代。
- [ ] **M3 替代门槛**：三条门槛（晋升 + ≥2 独立事实 + 严格更晚）缺一即拒绝，且拒绝原因在 `DistillReport` 里可观察。
- [ ] **M3 fail-closed**：同分时 active 不动、建持久化 case、候选不进注入。
- [ ] **M3 人工裁决**：五条校验任一不满足抛 `StaleConflictResolutionError`；incumbent 分支修订数不变；审计含 actor/rationale/eventId。
- [ ] **M3 事务**：§5 十条边界全部符合预期；重复恢复幂等；journal 被篡改/跳阶段显式拒绝。
- [ ] **M3 证据留存**：`evidence_ids` 指回原始事实；归档不删证据。
- [ ] **M4 画像**：`null` 删除、schema 外报错、类型约束（不隐式转文本）、整体拒绝、等值 patch 不重写。
- [ ] **M4 偏好**：完整幂等身份（value+source+expiresAt+sourceEventId）；过期 = 不注入而非删除；历史 `asOf` 查询不写回。
- [ ] **M5 召回**：五阶段可分别定位失败；`limit` 边界、纯标点拒绝、空结果空串；召回前后 durable store 逐字节不变。
- [ ] **M6 治理**：记忆页能看 active 事实、能停用/删除/改作用域、能裁决；`MEMORY.md` 只是投影（可重建）。
- [ ] **边界**：引擎侧 `git status` 为空；`[LOCAL PATCH]` 仍为 104；渲染层无 `import 'electron'`。

### 9.3 明确不在本次（防止验收范围膨胀，PRD §10）

1. 云端画像的**服务端学习**、跨设备记忆同步（Phase 5）。
2. 向量检索 / embedding / LLM reranker（只留接口，`RecallResult` 契约不变）。
3. 组织级 / 项目级记忆命名空间（`FR-4.4`，依赖 V2/V3）。
4. 引擎侧（nanobot）任何记忆改造（**零 `[LOCAL PATCH]` 新增**）。
5. 记忆的端到端加密（V3 合规范围）。
6. 技能 / 自动化作为「行动型记忆」的重做。

---

## 10. 未决问题与阻塞项

### 10.1 设计 §12 的八条（实质照录，补「必须在哪个阶段前定稿」与影响面）

| # | 问题（设计 §12） | 推荐的实质答案（设计原文口径） | 定稿期限 | 阻塞/影响 |
|---|---|---|---|---|
| Q1 | `MEMORY.md` 是否允许用户手编？编了算不算权威？ | **允许，但明确定位为投影**；手编内容在下次 `distill` 重建时会被覆盖——除非在「文件视图」显式选择「保留手工段落」。更好的默认：手工保存时由客户端转成 `origin='manual'` 的**事实**写入 `daily/`，让手编也进正式链路 | **Phase 2 开工会**（设计原文即「需在 Phase 2 定稿」） | 影响 M1-12（`<memory-save>` 落盘路径）、M2-08（文件视图保存语义） |
| Q2 | legacy fact（v1 段落）是否参与冲突检测？ | **参与检测、不参与晋升** | Phase 1 开工前（M1-03 即刻需要） | 阻塞 **M1-03**、影响 M1-04 |
| Q3 | `memory_key` 由谁提供？ | **三层兜底**：① `<memory-save key="…">` 显式；② 客户端对常见形态（`response.language` / `runtime.*` / `editor.*`）规则化推断；③ 派生 key。**不让模型自由发明 key** | Phase 1 开工前 | 影响 M1-01（校验）、M1-12（协议解析） |
| Q4 | 用户级是否也需要 `daily/*.jsonl`？ | **需要**，同构工作区级；身份类事实的原始证据必须留存（否则「为什么记着我叫明明」无法解释），落 `~/.nanowork/user-memory/<scope-id>/daily/` | **Phase 2 开工会** | 阻塞 **M2-03**（目录布局）；⚠️ 设计 §4.2 的目录树里**没有**用户级 `daily/`，与本节推荐答案不一致（见 §10.2 B-4） |
| Q5 | 召回语料是否需要落盘缓存？ | **不落盘**。事件流已是权威且只读；落盘会造出第三个产地（违反 ADR-023）。进程内 LRU + 按 `rev` 失效足够 | Phase 3 开工前 | 阻塞 **M3-07**（缓存实现） |
| Q6 | 蒸馏谁来触发？ | **三个点**：① 会话结束（既有 `sedimentSession` 之后）；② 记忆页「立即整理」按钮；③ 应用启动后延迟一次（兜底）。**不做后台定时** | Phase 1 收口前 | 影响 M1-12、M2-06（按钮与状态） |
| Q7 | 冲突 case 无人处理会怎样？ | 候选**不进注入**（I8），当前值继续生效，`MemoryBar` 与记忆页显示「待裁决 N」；**不做自动超时裁决** | Phase 2 开工前 | 影响 M1-11、M2-07 |
| Q8 | 是否把 `files` 之外的用户态（如 `preferences`）也纳入「清空」？ | **是，但分粒度**：清空工作区级 = 删该工作区记忆目录下全部记忆文件（v1 语义）；清空用户级 = 删 `profile.json` / `preferences.json` / `curated.json` / 投影 / 日志，**保留身份文件**（FR-4.3 既有豁免） | Phase 2 收口前 | 影响 M2-09、M2-10；需同步改 `MemoryService.clear` 的既有语义说明 |

### 10.2 本计划新发现的阻塞项（读代码/读两文档得出）

> **2026-10-02 状态更新**：下列五项**全部已拍板**，其中 B-1 / B-2 的处置**已回写进需求与设计文档**
> （不再只是本计划的建议）。各任务可按「已定处置」直接开工，无需再等外部决策。
>
> **同期还有一轮独立的代码级对抗核验**（对照 11 个源文件 + CI 配置），结论已全部回写
> `docs/architecture-memory-v2.md` §13（并改了正文）。**本计划的以下计数需按此对齐**：
>
> | 变更 | 影响本计划的地方 |
> |---|---|
> | 需求从 `FR-M1–M37` / `NFR-M1–M9` 扩为**含 `FR-M13a` / `FR-M25a` / `FR-M31a` + `NFR-M10–M12`** | §2 任务分解表里凡引用「NFR-M9」的验收行，改为 NFR-M9（Web 降级）/ NFR-M10（召回预算）/ NFR-M11（迁移不得跨端丢数据）/ NFR-M12（确定性）中的对应项；M1-01 的「报错文案拒收」需引用新模块 `src/lib/memory/detect.ts`（§4.3.1 的模块归属） |
> | **新增 B-3′（数据安全，最高优先）**：v1 用户级单文件已在同步边界内（`src/sync/fileAssets.ts:76-80` 的段落级资产 `memoryUser`），改名/清空会在 `hydrate()`（`:272-287`）生成段级墓碑并**跨设备删除用户记忆** | **M0-03 / M2-03 / M2-11 的迁移步骤必须按设计 §9 改写**：原文件与原 key 原地不动、只作 legacy 只读源；退役 `memoryUser` 不许放在本次迁移。新增任务：**同步侧回归用例**（迁移前后 `platform.storage.get(USER_MEMORY_KEY)` 逐字节相同）。这是本计划里**唯一一条数据安全级**验收 |
> | **新增 B-2′（I12 未被 CI 钉住）**：`ci.yml:126-129,184-188` 只查 `window.electronAPI` 与 wire 字段，**不查** `from 'electron'` / `node:fs` | **Phase 0 增一条 CI 任务**：在 `.github/workflows/ci.yml` 加一条针对 `src/**` 的 grep，使 I12 可自动化。在它落地前，I12 只能靠评审 |
> | **新增 M0-12（平台契约可实现性已确认，但接线清单补 4 处）** | `electron/main.ts`（handler 注册，:2474-2494）、`src/platform/types.ts` 的 `ElectronAPI`（:1047-1062）、`src/platform/storage.electron.ts`（实现所在，:75-107）、`src/components/settings/sections/AccountSection.tsx`（:65-79 / :243-249 的导出会静默漏新 canonical 文件） |
> | **NFR-M4 措辞修正** | 「9 个 v1 记忆测试不删不改语义」改为「**必须全绿，但两处断言必须按新语义更新**」：`tests/electron/workspaceMemoryStore.test.ts:87-93` 与 `tests/memoryService.test.ts:410`；另需复核 `tests/memoryService.test.ts:697-721`、`tests/sessionsStore.test.ts:704-737`。§4 门禁表按此改 |
> | **门禁新增 `npm run build:electron`** | `electron/main.cjs` / `preload.cjs` 是 `.gitignore:25-26` 的构建产物，`npm run build`（`package.json:10`）**不重建**它们。凡动 `electron/**` 的任务（M0-05 等）验收命令必须含它 |
> | **FR-M31a（清空应用数据覆盖新落点）** | M2-10（清空语义）需把 `~/.nanowork/user-memory/**`、`daily|archive/**` 与 `.migrated` 纳入 `clearStorageFiles`（`electron/main.ts:2435-2444`、`electron/storageRoutes.ts:336-346`） |
> | **FR-M31 的「改作用域」+ FR-M35 的账户导出** | M2-09 需实现 `moveEntry`（语义见设计 §4.7.0：目标域新建事实 + 源域停用 + 审计，**不是移动文件**）；M4-03 需同步扩展 `AccountSection` 的导出清单 |
> | **canonical 写前快照（M8）** | M1-11 / M2-09 需给 `curated.json` / `conflicts.json` / `profile.json` / `preferences.json` 挂 `snapshotBeforeWrite`，并给 `fileKeyOf` 加 `<scope-id>` 维度（`src/stores/fileBackupStore.ts:86-88`） |

| # | 阻塞项 | 为什么是阻塞 | 最终处置（已回写文档） | 阻塞任务 |
|---|---|---|---|---|
| **B-1** | **召回的暴露通道**：设计旧稿要求把 `recall_history(query, limit)` 放进**模型可见的工具列表**，但本仓库的模型工具由**引擎**提供，客户端只有正文协议（`<memory-save>`）与 `platform.syncNanobotMcp`（写 `tools.mcpServers`）两条通道。走引擎工具 = 新增 `[LOCAL PATCH]`（违反硬约束 2）；走 MCP = 要在本机跑一个 MCP server（Phase 3 体量不允许） | 通道形态决定 M3-09 的全部实现与测试形态；未定就实现等于把违规方案固化 | ✅ **改为「客户端按轮触发」**（设计 §4.4 的通道表 + §4.8「触发与注入边界」、需求新增 **FR-M25a**、预算入 **NFR-M10**）：发送前用本轮用户消息（拼上一轮作最短上下文）作 query，命中渲染成 `<recalled_context>` 附在 system 段。**模型不做任何动作、不产出任何协议标签、引擎零改动**。比「模型调工具」更稳：不依赖模型自己想起来检索（v1 的快照失效事故正是「模型看不到就答不出来」）。`recall()` 仍可被 harness 显式调用以支持测试与诊断，但**不进模型工具清单** | **M3-09**（M3-01…M3-08 不受阻） |
| **B-2** | **引擎侧记忆「诊断」入口缺平台能力**：`FR-M36` 要求记忆页诊断区只读展示引擎侧记忆的「路径 + 大小 + mtime」，但客户端读不到引擎 workspace 路径（实测 `grep nanowork-Workspace src/ electron/` 零命中；`platform` 只有 channels/mcpServers/modelPresets 三类只读回读），且设计 §7.2 未列所需文件 | 没有能力就只能显示死文案，达不到「可查看诊断信息」的验收 | ✅ **范围收敛 + 推迟**（需求 FR-M36 的「范围收敛（2026-10-02）」括注、设计 §4.10 的 FR-M36 行）：本期只做**边界声明 + 文档收敛 + 记忆页顶部静态说明**（这正是 FR-M36 的认知目标）；只读元信息面板**整体推迟到 Phase 5**，与 FR-M37（Dream 候选通道）同批，两者共用同一条「引擎 workspace 路径读回」通道。**本期不新增 IPC** | **M4-04**（降级为「静态说明 + 文案收敛」，不再阻塞） |
| **B-3** | **`origin: 'import'` 不在类型联合里**：设计 §4.10（FR-M35）要求导入时记 `origin: 'import'`，而 §4.1 的 `FactOrigin` 联合没有这一项 | M4-03 直接编译不过 | ✅ 已把 `FactOrigin` 扩为 `'manual' \| 'memory-save' \| 'sediment' \| 'legacy' \| 'import' \| 'dream'`（设计 §4.1；`'dream'` 供 FR-M37 用），并注明按 §4.10 / FR-M37 扩展 | **M4-03**（解除） |
| **B-4** | **用户级 `daily/` 的目录归属**：设计 §4.2 的 `~/.nanowork/user-memory/<scope-id>/` 树里没有 `daily/`，而 §12 Q4 的推荐答案是「需要」 | 目录布局一旦落地，事后补会牵动 store 路径策略与迁移路径 | ✅ 按 §12 Q4 采纳：**用户级也建 `daily/YYYY-MM-DD.jsonl`**，设计 §4.2 的目录树已补齐，并加了一段「两级刻意同构」的理由（三套机制只有一份实现，作用域只换一个 `ref`） | **M2-03**（已定，可直接开工） |
| **B-5** | **`lib/memory.ts` 与 `lib/memory/` 同名**（§2 前置说明 1） | 未定则门面改动可能「不生效」，且 40+ 调用点会解析到错误模块 | ✅ 维持本计划处置：M0-08 用显式子路径再导出 + 加 import 解析断言；门面单例留在 `src/lib/memory/index.ts` | **M0-08** |

### 10.3 阻塞矩阵（一览）

> 五项阻塞已全部拍板（§10.2）。本表用于开工前核对「哪些任务可以直接起」。

| 任务 | 在等什么 | 可否先做别的 |
|---|---|---|
| M0-08 | B-5（已定处置） | 可（直接开工） |
| M1-03 | Q2 | 否（M1-03 本身就在等它） |
| M2-03 | Q4 / B-4（已定为「需要」） | 可（M2-01/M2-02 纯函数可先做） |
| M3-09 | ~~B-1~~ 已定：客户端按轮触发（设计 §4.4 通道表 / FR-M25a / NFR-M10） | 可（M3-01…M3-08 不受阻） |
| M4-03 | ~~B-3~~ 已定：`FactOrigin` 扩 `'import'` / `'dream'` | 可（M4-02 可先做） |
| M4-04 | ~~B-2~~ 已定：本期降级为静态说明 + 文案收敛，只读面板推迟 Phase 5 | 可（M4-01/M4-02/M4-05 可先做） |
| 全阶段 | 硬约束 2（引擎零改动） | 任何需求若判定必须动引擎，**立即回到 §10.2 B-1 的处置**（改道客户端），不得先打补丁 |

---

> **本计划不改动的文件**：`docs/README.md`（登记由文档负责人执行）、`nanobot/`（引擎侧零改动）、
> 以及 v1 的 9 个记忆测试文件（只允许新增用例）。
