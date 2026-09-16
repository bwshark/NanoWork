# docs/ 文档索引

本目录是 nanowork 的需求与设计文档库。由于项目经历过多轮增量迭代，文档之间存在**重复、冲突与版本叠加**。本索引是唯一的入口：**新增文档必须在此登记**，读者先看本表再决定读哪份。

> **唯一事实源**：`nanowork-prd-design-v2.md`。任何文档与它冲突，以它为准；任何文档与**代码**冲突，以代码为准。

---

## 一、状态图例

| 状态 | 含义 | 处理动作 |
|---|---|---|
| **现行** | 内容有效，可直接作为实现依据 | 正常维护 |
| **增量** | 针对某一特性的补充设计（PRD/架构成对），已实现但尚未并入主文档 | 需写入「收口目标」，择机并入 v2 |
| **已取代** | 内容已被其它文档覆盖，**仅作历史存档** | 冻结，除顶部横幅外不得再编辑 |

**适用阶段**沿用 v2 第 2.3 节的四期演进：

| 期 | 代号 | 主题 |
|---|---|---|
| **V1** | 工作台成型 | 引擎契约层、事件化会话、三级权限、提示词外置、四层记忆、自动化增强、产物回滚、可观测 |
| **V1.5** | 多端一致 | 云端账户 + 双向同步（FastAPI 认证 + Sync API，LWW） |
| **V2** | 团队协作 | 项目空间、共享知识库/记忆、人机双写、评论 @AI |
| **V3** | 企业私有化 | 多租户、SSO/RBAC、审计、审批、gVisor 级沙箱、计费 |

---

## 二、现行文档（Canonical）

| 文档 | 状态 | 阶段 | 内容概要 |
|---|---|---|---|
| **`nanowork-prd-design-v2.md`** ⭐ | 现行（主文档） | V1 → V3 全程 | 需求 + 设计合一的唯一总纲。第 0 章三点纠偏（D1 引擎契约层 / D2 事件化会话 / D3 三级权限）；第 1–6 章需求（R1–R12 域、`FR-<域>.<序>` 编号、用户故事、非功能、里程碑；**2.5 交付边界**：客户端之外需新增 7 个系统 + 三条硬判据）；第 7–22 章设计（五层架构、事件模型（**9.4 索引层：JSON 索引（V1）／SQLite（目标态）**、**9.6 D2 落地记录（A–E 全部完成）**：事件模型 + 存储抽象三层（路由/索引/IO）+ 双实现 + 四个不变量 + Phase C 双写（`recordFor` 事件总表）/ Phase D 切读（水合）/ Phase E 清理（移除旧 persist）+ 两条推导路径同源（`project`/`activePath`）+ 三处已知范围差异）、权限（**10.3.1 收口落点纠偏**：L2 收口在**引擎**而非客户端，`access_mode` 与 `tool_approval` 为**正交两轴**）、执行模式（**10.1.1 模式强制落地（M2）**：`session_mode` 是第四根会话轴、未知取值报错不降级、deny 回注工具结果；**10.2.1 计划走 `submit_plan` 工具通道提交**而非解析回答）、工具网关（**11.1.1 逐条批准落地（D3）**：引擎否决通道 + 审批回传端点 + 客户端契约与 UI、三个 fail-closed 不变量、已知边界；**11.2.1 默认拒绝写入落地（FR-8.4）**）、**M2 安全收尾（2026-09-16 闭合）**：三档决策 `decide_tier`（`allow`/`sandbox`/`deny`，未知工具默认 deny）+ **回收站改道**（FR-8.3，回收站不可用即 fail-closed，`delete_file` 为唯一删除入口）+ **审计留痕**（FR-8.9，`audit/tool-gateway.ndjson`，append-only 且写失败绝不影响执行）+ **Agent 工具白名单**（FR-2.2，`WorkspaceScope` 第五根轴，`None` ≠ 空集）、四级扩展（**12.5–12.8 含 WorkBuddy 分发源实测**：市场四档来源 / 版本隔离缓存 / 云端边界 / 落地约束汇总；**12.4.1 技能三态落地说明（FR-3.1）**：三态生效点对照表、项目级目录落在 `<workspace>/skills`、覆盖表两跳推送；**12.4.2 连接器落地说明（FR-3.2）**：真实探针替代 `delay(700)` 假连接测试、工具黑名单 vs 上游白名单的分叉语义、凭据三份副本的加密边界与三条 fail-closed）、提示词工程（**13.5 落地进度（M3 首轮）**：模式 × 领域 × 风格内置矩阵 + `~/.nanowork/prompts/` 外置覆盖（引擎白名单模板同样可覆盖，坏覆盖 fail-open）+ `assemblePromptSections` 固定装配顺序 + `<identity_context>` 单块）、记忆（**14.2 落地差异（M3 首轮）**：L2 用户级 / L4 身份文件已落，`scope` 为**末位可选参数**；落点在 ① 而非 `<workspace>`）、自动化、IM、产物回滚、数据模型（**18.2 四个根：目录约定与落地现状**：目标态与实现的逐项对照、三条收敛原则、两个实测缺陷，**18.2.5 目标态落地：key→文件路由**（一 key 一文件 + 归属路由 + 旧 blob 迁移））、同步、可观测、接口清单、目录规划）；第 23–24 章 ADR（**ADR-021：工具权限唯一收口在引擎**、**ADR-022：事件流磁盘格式归主进程独占 + 纯索引逻辑两侧共用 + JSON 索引**、**ADR-023：会话视图两个产地必须同源**（等价性测试 `tests/events/equivalence.test.ts` 守卫）、**ADR-024：执行模式与计划提交落在引擎会话作用域**（第四根轴 `session_mode` + `submit_plan` 工具通道））与风险；附录 A 机制映射总表 / B 一致性修复清单 / C 术语表。**第 8 章含 8.2.1 契约落地修订与 8.4.1 D1 迁移记录**（引擎模块收敛到 `src/ai/runtime/`、codec 归一收口、清理 5 处死代码、`platform.env` vs `isElectron()` 陷阱） |
| `cross-platform-sync-design.md` | 现行 | V1.5 / V2 / V3 | 跨端同步**整合版**：云端身份（邮箱 + JWT）+ 双向同步引擎。local-first、account-scoped、LWW + tombstone、append-only 同步日志、`SyncEngine` 包裹现有 store、认证/存储/运行时三层解耦 |
| `gateway-e2e.md` | 现行 | V1 | 网关端到端验证手册：协议层用 monkeypatch `global.fetch` 跑通 `NanobotClient` 全链路（SSE 文本流 / `tool_calls` 增量 / artifact 提取）+ 真实 `nanobot serve` 启动步骤与验证清单 |
| `prd.md` | 现行（**范围已收窄**） | V1 | 初版 PRD：定位、10 条用户故事、P0–P2 需求池（`FR-001`–`FR-012`）与 RFC 2119 验收标准。**新需求不再写入本文件**，仅保留其验收标准作为 MVP 验收对照 |
| `nanowork-prd.md` | 现行（**阶段受限**） | V3 | 企业平台需求方案（代号 WorkPilot）：多租户、组织/RBAC、SSO/OIDC/LDAP、审批流、审计、计费、技能市场、项目空间、自建沙箱执行器。是 **V3 的需求来源**，其「企业」定位与 V1 本地优先客户端不冲突（分期见 v2 第 2.3 节） |

---

## 三、增量文档（Increment，待并入主文档）

四份文档是**两对 PRD ↔ 架构**，均已实现但内容尚未收敛进 v2。

| 文档 | 状态 | 阶段 | 内容概要 | 收口目标 |
|---|---|---|---|---|
| `prd-memory.md` | 增量 | V1 | 工作区文件记忆（`MEMORY.md`）：目标、3 条用户故事、P0–P2 需求池、5 个待确认问题（含推荐答案） | 并入 v2 第 14 章（记忆体系） |
| `architecture-memory.md` | 增量 | V1 | 记忆机制增量架构：`MemoryService`、`src/types/memory.ts`、跨端读写路径、注入点、13 项文件清单、UI 落点 | 并入 v2 第 14.2 节（注入机制） |
| `prd-tasks.md` | 增量 | V1 | 对话一键创建定时任务：`FT-01`–`FT-08`、预填规则（提示词/Agent/名称）、hover 交互与对话框草图 | 并入 v2 第 15 章（自动化） |
| `architecture-tasks.md` | 增量 | V1 | 上述的增量架构：抽取共享 `TaskFormDialog`、新增 `CreateTaskDialog`、`TaskDraft` 与组件接口契约 | 并入 v2 第 15.2 节（数据模型） |

---

## 四、已取代文档（Superseded，仅存档）

| 文档 | 阶段 | 取代者 | 保留原因 / 注意事项 |
|---|---|---|---|
| `architecture.md` | V1（历史初版） | v2 第 7、22 章 | 分层图与 AIClient / platform 约定仍有参考价值。**⚠️ 其默认网关写作 `127.0.0.1:8765`，正确值是 `8900`**（见 `src/lib/constants.ts:15`）；文件清单已过期 |
| `chat.md` | V1（历史） | v2 第 13 章 | 内容已收编为 `FR-1.x` 与「入口预设 × 执行模式」矩阵 / 第 13 章提示词工程。原文为口语化描述、无编号与验收标准 |
| `cloud-sync-design.md` | V1.5 | `cross-platform-sync-design.md` | 早期同步设计，约束与整合版不同（未限定 FastAPI、未排除 Node），保留作设计演进痕迹 |
| `user-sync-login.md` | V1.5 | `cross-platform-sync-design.md` | 同上，内容已被整合版吸收 |

---

## 五、工程流程文档（Process）

与产品分期解耦，全阶段有效，由 `AGENTS.md` 指引。

| 文档 | 状态 | 内容 |
|---|---|---|
| `agents/issue-tracker.md` | 现行 | Issue / Spec 以 GitHub Issue 为载体，`gh` CLI 操作约定；「PR 是否作为需求入口」开关 |
| `agents/triage-labels.md` | 现行 | 5 个 triage 角色 → 本仓库实际标签串的映射表 |
| `agents/domain.md` | 现行 | 领域文档消费约定：优先读 `CONTEXT.md` / `CONTEXT-MAP.md` / `docs/adr/`（单上下文仓库） |

---

## 六、仓库根文档与工程配置（不在 docs/ 内，一并索引）

| 文件 | 状态 | 说明 |
|---|---|---|
| `README.md`（根） | 现行 | 使用入门：安装、启动命令、npm scripts、已知限制 |
| `OVERVIEW.md`（根） | **增量（待重写）** | 交付状态章节停留在「T01–T36 完成」，未反映 IM 渠道 / 扫码接入 / 专家团 / 语音输入 / 思考过程时间线等后续实现。需按 v2 第 1.2 节（现状代码基线）重写 |
| `AGENTS.md`（根） | 现行 | Agent 技能入口：issue tracker / triage labels / domain docs 三份指引 |
| `openspec/config.yaml` | 现行 | 平台归口约定（`web` / `electron`），v2 需求表的「环境」列沿用此口径 |
| `docs/adr/` | **待建** | 架构决策记录目录，由 `/domain-modeling` 惰性创建。v2 第 23 章已给出 ADR 摘要，落地后逐条迁入 |

---

## 七、推荐阅读路径

| 读者 | 路径 |
|---|---|
| 新加入的开发者 | 根 `README.md` → `nanowork-prd-design-v2.md`（**务必先读第 0 章 + 第 1.2 节基线**）→ 第 7 章架构 / 第 22 章目录规划 → 按需读增量文档 |
| 产品 / 需求评审 | v2 第 1–6 章 → `prd-memory.md` + `prd-tasks.md` → `prd.md` 的验收标准 |
| 只做跨端同步 | `cross-platform-sync-design.md` → v2 第 19 章（本文提出的增量要求：V1 必须先落 `SyncMeta`） |
| 只做安全 / 权限 | v2 第 10.3 节（三层权限，含 **10.3.1 收口落点纠偏**）+ 第 11 章（工具网关、**11.1.1 逐条批准落地**、**11.2.1 默认拒绝写入**、硬兜底、沙箱）+ **M2 安全收尾（FR-8.2/8.3/8.4/8.9 + FR-2.2 工具白名单，第 6 章进度注）** + ADR-021 |
| 只做会话存储 / 事件化 | v2 第 9 章（事件模型、落盘布局、**9.6 D2 落地记录（A–E 全部）**）+ 第 9.4 节（JSON 索引 vs SQLite 的取舍）+ ADR-022 + ADR-023 |
| 只做执行模式 / 计划审批（FR-1.4 / FR-1.5） | v2 第 10.1–10.2 节（三种模式、计划事件流、**10.1.1 模式强制落地**、**10.2.1 计划走 `submit_plan` 工具提交**）+ 第 11.1.1 节（模式门与审批门挂在同一条 hook 链上的叠加语义）+ ADR-024 |
| 只做提示词 / 人格 / 记忆分层（FR-4.2 / FR-4.3 / P-提示词外置） | v2 第 13 章（**13.2 变量清单落地状态**、**13.3 五个标签块**、**13.5 落地进度（M3 首轮）**）+ 第 14.1–14.2 节（**四层已落三层**、`scope` 为末位可选参数、注入顺序里身份必须在记忆之前）+ 第 18.1 / 18.2 节（① 下的身份文件与 `prompts/`）；代码落点 `src/lib/{promptCatalog,promptLibrary,identity,promptAssembly,memory}.ts`、`src/pages/persona/`、引擎 `utils/prompt_templates.py` + `agent/context.py` |
| 只做技能目录 / 三态覆盖（FR-3.1） | v2 第 12.1 / 12.4 节（**12.4.1 落地说明**：项目级目录是 `<workspace>/skills`、扫描顺序与优先级链反向、三态生效点对照表）+ 第 3 章 FR-3.1 行 + 第 6 章进度注（**M3 第二批**）；代码落点 `src/lib/skillOverrides.ts`、`src/stores/skillsStore.ts`、`src/lib/skillParser.ts`、`src/pages/skills/SkillsPage.tsx`、`electron/main.ts`（`scanSkillsDir` / `fs.watch` / `mergeSkillOverridesIntoConfig`）、引擎 `agent/skills.py` |
| 只做连接器：连接测试 / 工具级授权 / 凭据加密（FR-3.2） | v2 第 12.4.2 节（**落地说明**：探针为什么必须真实、黑名单为何不复用上游白名单、凭据三份副本的加密边界与 fail-closed；**12.7 云/端边界**）+ 第 3 章 FR-3.2 行 + 第 6 章进度注（**M3 第三批**）；代码落点 `electron/mcpProbe.ts`、`electron/credentialVault.ts`、`electron/main.ts`（`injectConnectorSecrets` / `mcp:probe` / `secrets:*`）、`src/stores/mcpStore.ts`、`src/ai/runtime/nanobotHttp/config.ts`、`src/pages/mcp/McpPage.tsx`、引擎 `agent/tools/mcp.py`（`disabled_tools` 过滤）+ `config/schema.py` |
| V3 规划 | v2 第 2.3 节 → `nanowork-prd.md` |

---

## 八、文档治理约定

1. **登记制**：新增文档必须在上表登记（状态 + 适用阶段 + 一句话概要）。
2. **三态收敛**：状态只有「现行 / 增量 / 已取代」三种。
   - 增量文档必须写**收口目标**（并入 v2 哪一节）；
   - 已取代文档必须写**取代者**，并在文首加横幅。
3. **编号统一**：需求编号一律 `FR-<域>.<序>`（v2 第 3 章）。不再新增 `FR-0xx` 形式编号。
4. **事实以代码为准**：端口、文件清单、已实现能力等，先核对代码再改文档（参考 v2 第 1.2 节）。
5. **已取代文档冻结**：保留但不再编辑，仅在文首追加取代横幅。
6. **ADR 沉淀**：v2 第 23 章的关键决策，在 `docs/adr/` 建立后逐条迁入（`ADR-0001` 起）。

---

## 九、文档一致性问题看板

对齐 v2 附录 B，并补充本文新发现的一条。✅ = 已修复，⬜ = 待办。

| # | 文件 | 问题 | 状态 |
|---|---|---|---|
| 1 | `README.md`（根） | WorkBuddy 归属误标为「网易有道」 | ✅ |
| 2 | `OVERVIEW.md`（根） | 同上 | ✅ |
| 3 | `OVERVIEW.md`（根） | 交付状态未反映 IM 渠道 / 扫码接入 / 专家团 / 语音输入等已实现能力 | ⬜ |
| 4 | `docs/prd.md` | WorkBuddy 归属误标为「网易有道」 | ✅ |
| 5 | `docs/prd.md` | `FR-010` 标注「首版仅预留」，实际 5 渠道 + 扫码接入已实现 | ⬜ |
| 6 | `docs/architecture.md` | 默认网关写成 `127.0.0.1:8765`，应为 `8900` | ⬜ |
| 7 | `docs/architecture.md` | 文件清单过期（缺 `platform` / `nanobotBridge` / `im` / `composer` / `memory` 等），或在文首标注「历史版本，以 v2 为准」。另：3.2 节与 T04 引用的 `src/ai/types.ts` / `nanobotClient.ts` 已在 D1 迁至 `src/ai/runtime/types.ts` / `runtime/nanobotHttp/chat.ts`（见 v2 第 8.4.1 节） | ⬜ |
| 8 | `docs/chat.md` | 无编号、无验收标准；需收编进 v2 后在文首标注已被取代 | ⬜ |
| 9 | `docs/nanowork-prd.md` | 定位为企业平台，与代码基线不符；需在文首加注「V3 阶段需求，见 v2 第 2.3 节」 | ⬜ |
| 10 | `docs/user-sync-login.md` | 已被 `cross-platform-sync-design.md` 整合；需加 superseded 横幅 | ⬜ |
| 11 | `docs/cloud-sync-design.md` | 同上，需加 superseded 横幅 | ⬜ |
| 12 | `docs/gateway-e2e.md` | 第 2 节写 `nanobot serve --port 8765`，与项目默认网关 `8900` 不一致，照做会连不上 | ⬜ |

> 第 12 条为本次编写索引时新发现：`gateway-e2e.md` 的「真实网关」步骤会让读者把网关起在 `8765`，而客户端默认指向 `8900`，导致连接失败。建议在 v2 中统一为「nanobot 自身默认端口以 `nanobot serve --help` 为准；本项目客户端默认 `8900`」。

---

## 十、检查清单（提交前自检）

- [ ] 新文档已在第一~六节登记
- [ ] 状态取值合法，增量文档写了收口目标，已取代文档写了取代者
- [ ] 需求编号符合 `FR-<域>.<序>`
- [ ] 引用的端口 / 文件路径 / 已实现能力已与代码核对
- [ ] 若本索引的「一致性问题看板」有对应条目，已同步更新状态
