# 交付概览 — 类 WorkBuddy 智能体客户端（基于 nanobot 引擎）

> 引擎：nanobot（HKUDS，OpenAI 兼容 API）｜ 对标：WorkBuddy ｜ 平台归口：`web` / `electron`
>
> **本文是交付快照，不是需求依据。** 唯一事实源为 `docs/nanowork-prd-design-v2.md`；文档与代码冲突时**以代码为准**。
> 状态：**增量（每期收口时重写）**。本次重写：**2026-10-17**（V1.7 B1），改写口径遵循 v2 第 1.2 节「现状代码基线」。

---

## TL;DR

基于 **nanobot 引擎**、对标 **WorkBuddy** 的跨端智能体客户端。同一套 React 渲染层既可在浏览器运行，也可被 Electron 加载为桌面应用；直连 nanobot 网关（`/v1/chat/completions`，OpenAI 兼容 SSE），连接状态实时探测。

**版本进度**：**V1 已整体收口**（P0 只剩知识库绑定，而知识库属 V2，故 V1 范围视为完成；P1 剩 4 条已排进 V1.7）、**V1.5（多端同步）✅ 2026-10-04**、**V1.6（运行期工程加固）✅ 2026-10-17**（**19 个新增 FR 编号中 18 条 ✅**，`FR-11.8` 因前提被实测推翻而明确不做）、**V1.7（V1 收口 + 交付闭环）🟢 代码全完成（B1–B5，2026-10-18）** —— 自动更新 / 深链 / 运行时自助安装 / 反馈包均已实现，真机验证已过 3 条（深链 / 子代理 / Dream 闸门），余 3 条卡在外部凭据。

**当前最真实的一句差距**：功能与「可分发」都已就位，**卡在真机验收，而且剩下的三条不是「没时间验」而是「验不了」** —— `B3-01` 子代理委派与 `B3-02` Dream 闸门已于 **2026-10-23** 用 `agnes-3.0-flash` 真机跑通（脚本 `tasks/verify-b3-real.py`，证据 `tasks/evidence/b3-*.json`）；`B4-02` 深链早于 2026-10-21 通过；仍缺的三条各卡在一个外部前提：**`B3-03` IM 内审批**要飞书应用凭据、**`B4-01` 自动更新**要 GitHub 发版权限（`GH_TOKEN`）、**`B4-03` 自助安装**要一台没有 venv 的干净机器。

> **2026-10-22 追加**：V1.7 之外补做了 P1 最后一条 `FR-3.3` 专家包（单专家导出 / 导入，纯渲染层，未动引擎与 `electron/`）。至此 **V1 的 P1 全部有代码落地**，剩余全是真机验收。
> **2026-10-23 追加**：补做 `FR-3.6` 插件生命周期钩子（P2 里唯一没有 V2/V3 归属的一条）。在此之前插件的 `hooks/hooks.json` 只是被读进 `hook_manifest`，**没有任何执行方**——装了带钩子的插件、界面显示有 hooks、什么都没发生、零报错。现在按声明执行，且生效情况经 `GET /v1/plugins` 报到界面。

---

## 一、版本与里程碑状态（2026-10-17 核对）

| 阶段 | 状态 | 证据 / 说明 |
|---|---|---|
| **V1 · M1** 引擎与事件地基 | ✅ 闭合 | `src/ai/runtime/` 契约层（D1）；事件模型 + 存储三层（D2：路由 / 索引 / IO + 双实现 + 四个不变量 + Phase C/D/E）；实时视图与投影等价性有 `tests/events/equivalence.test.ts` |
| **V1 · M2** 安全与执行模式 | ✅ 闭合 | 三档决策 `decide_tier`、回收站改道（FR-8.3）、审计留痕（FR-8.9）、Agent 工具白名单（FR-2.2）、`session_mode`、逐条批准（D3，走 `POST /v1/tool-approvals/{id}` 真实回环） |
| **V1 · M3** 扩展与提示词 | ✅ 闭合 | 技能三态 / 连接器 / 插件市场四档注册表（FR-3.7）/ 版本隔离缓存（FR-3.8）/ 提示词工程；V1.6 又补了插件 prompt 片段、清单读取器、声明式工具策略、市场索引与依赖解析（`FR-3.10~3.13`）与扩展运行时 ADR（`FR-3.14` → ADR-0025） |
| **V1 · M4** 自动化与产物 | ✅ 闭合（2026-10-05） | `FR-5.4` / `5.6` / `6.3` / `6.4` / `7.2` / `7.3` 六条全落（含投递 `start` 档位、IM 会话归档、产物索引、文件级回滚） |
| **V1 · M5** 可观测与成本 | ✅ 闭合 | `FR-11.1`（`/v1/usage` + 三档计价）/ `11.2`（回合级 trace）/ `11.3`（日志分级）/ `8.9`（审计）；V1.6 又补 `FR-11.6`（启动剖析）/ `11.7`（TTFT 与自包含报告）/ `11.9`（诊断包进程维度 + 出口脱敏） |
| **V1.5 · M6** 多端同步 | ✅ 闭合（2026-10-04） | 七个批次全落（服务端 / 客户端引擎 / 前置欠账 / 实体接线 + 认证 UI / 事件流追加同步 / 6a 数据主权 + 墓碑 GC / 6b C 类文件型资产）；两条验收门禁由 `tests/sync/integration.twoDevice.test.ts` 与 `tests/sync/sessionEventsSync.test.ts` 自动化承担 |
| **V1.6** 运行期工程加固 | ✅ 收口（2026-10-17） | **19 个新增 FR 编号中 18 条 ✅**；`FR-11.8`（WAL checkpoint）**不做**（前提被实测推翻，替代口径见该条）。批次 B1–B8 的 DoD、真机判据与踩坑记录见 `docs/upgrade-v1.6-requirements-and-plan.md`；19 条 FR 已并入 v2 第 3 章 |
| **V1.7** V1 收口 + 交付闭环 | 🟢 代码全完成（B1–B5，2026-10-18）｜🟡 真机 3/6 通过（2026-10-23） | **B1** 判据勘误 + v1.6 并入 v2 + 本文件重写；**B2** 会话版本引用集进同步负载（`FR-3.9` ✅）、提示词注入检测（`FR-8.6` ③）、头像占位确定性锁定 + 两处门禁噪声（全量 229 文件 / 3454 用例 exit=0）；**B3** 子代理委派 `FR-2.5` / Dream 审查闸门 `FR-4.6` / IM 内审批 `FR-6.5` 三件代码全落；**B4** 自动更新 / 深链 / 运行时自助安装 / 反馈包四件全落；**B5** 四项带数字决策。10-19 追加 IM 助理视图完整体验（产物登记 / 轮聚合 / 深度思考 / 实时过程 / 助理发言走 `/v1/turn`，已提交）。**真机验证 3/6**：深链（10-21）、子代理（10-23，6/6）、Dream 闸门（10-23，11/11 + 回退 2/2）已过；余 IM 审批（缺飞书凭据）/ 自动更新（缺 `GH_TOKEN`）/ 自助安装（缺干净机器）。计划与判据见 `docs/plan-v1.7-closure-and-delivery.md` 附录 C |
| **V2 · M7** 团队 | 🟡 服务端已起步（2026-10-24） | `cloud/app/orgs`（组织 + 三级角色 + 成员管理，非成员 404、不得授予高于自己的角色、最后一个 owner 不可降级）与 `cloud/app/kb`（知识库 + 文档切块入库 + **检索前过滤**的词法检索）；**未做**：客户端 UI、向量检索、Office/PDF 解析、部门树、项目空间、人机双写 |
| **V3 · M8** 企业 | ⬜ 未开工 | 多租户 / SSO / RBAC / 审批 / 计费 / 沙箱强化 |

**V1 收口口径（2026-10-17）**：

- **P0 共 33 条，32 条 ✅**。唯一未完成的 `FR-2.3` 只剩「知识库绑定」，而知识库属 M7（V2）→ **V1 范围内已实质完成**。
- **P1 复核后只剩 4 条**（勘误见 §九 看板 #35）：`FR-2.5` 子代理委派、`FR-4.6` Dream 审查闸门、`FR-6.5` IM 内审批、`FR-8.6` ③ 提示词注入检测 —— **四者代码均已在 V1.7 落地**（2026-10-18），仅余真机验收（见 §四-11 + 计划书附录 C「真机验证清单」）。
- **两条已改判**：`FR-4.4` 个人 / 项目两级已由记忆 v2 落地（只剩组织级 → V3）；`FR-8.6` 三件里「彻底删除」已随 `FR-4.5` 落、「检索前过滤」被知识库阻塞（→ V2）。

---

## 二、质量门禁（2026-10-17 实测，非引用）

| 门禁 | 命令 | 实测结果 |
|---|---|---|
| 渲染层单测 | `CODEBUDDY_SAFE_DELETE_ENABLED=0 npx vitest run --maxWorkers=3` | ✅ **229 文件 / 3454 用例全绿、exit=0**（2026-10-17 B2 收尾实测；B1 时曾有两处红，原因与修法见 §2.1） |
| 类型检查（渲染层） | `npm run typecheck` | ✅ 退出码 0 |
| 类型检查（桌面外壳） | `npm run typecheck:electron` | ✅ 退出码 0 |
| 类型检查（测试代码） | `npm run typecheck:tests` | ✅ 退出码 0（**注意：不在 `build` 门禁内**） |
| 生产构建 | `CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` | ✅ 退出码 0，`vite build` 24.43s |
| 首屏体积 | `node tasks/verify-b5-first-paint.mjs` | ✅ 退出码 0：modulepreload **0.61 MB**（上限 1.2）、入口脚本 0.55 MB、首屏 JS 合计 **1.16 MB**（上限 1.5） |
| 引擎侧 pytest | `nanobot/nanobot/.venv/Scripts/python.exe -m pytest tests/...` | 🟡 上次实测 **2026-10-16**：除 3 条**预存** Windows symlink 权限红外全绿；**本次未复跑** |

### 2.1 曾有两处红：已定位并修掉（2026-10-17 B2）

1. **`tests/sync/sessionEventsSync.test.ts`** —— 全量并发下曾报「服务端 `http://127.0.0.1:8912/health` 在 20000ms 内未就绪」。
   **证据**：单独跑 **2 用例全过、7.8s 完成**（健康检查 2.9s）→ 是并发时的超时余量不足，不是功能坏了。
   **已修**：健康检查与 `beforeAll` 超时 20s → **90s**（两个同步集成文件都改），下一轮全量即绿。
2. **`tests/lib/fileBackup.test.ts` > `append / delete 同为有效 op`** —— 断言 `['append', 'delete']`，实际得到 `['delete', 'append']`。
   **根因**：`fileBackupStore.list()` 的契约是**倒序（最新在前）**（`src/stores/fileBackupStore.ts`：`sort((a, b) => b.at.localeCompare(a.at))`），而这条用例断言的是**插入序**。两次快照落在同一毫秒时按插入序返回（侥幸通过），落在不同毫秒时必然倒序返回。
   **证据**：同一文件连跑 4 次 → **2 红 2 绿**，是**确定性 flaky**（用例与契约冲突），与本期改动无关。
   **已修（选的是产品侧那条路）**：`BackupEntry` 加单调 `seq`，`list()` 改为「`at` 倒序 → `seq` 倒序」的**全序**，用例按契约断言「最新在前」——同毫秒两次快照的顺序也确定了（UI 时间线不再闪）。
   **修法二选一**（建议前者，顺手消掉真实的不确定性）：① 给时间线条目加单调 `seq`，`list()` 改为「`at` 倒序 → `seq` 倒序」的**全序**（同毫秒也有确定顺序），用例随契约断言；② 只改用例，按 `at` 排序后断言集合。

> 判定纪律（沿用）：**永远看退出码**；`CODEBUDDY_SAFE_DELETE_ENABLED=0` 必须带（不带时 `vite build` 的 `emptyDir(dist)` 会被安全删除守卫拦下 → 构建假红）。本次即踩中一次。

---

## 三、已实现能力（按域）

**引擎接入**
- `src/ai/runtime/` —— 唯一出口：`types.ts`（`AgentRuntime` + 能力声明 + wire 类型）、`nanobotHttp/runtime.ts`、`chat.ts`（SSE，透传 `session_id` / `model` / `workspace` / `access_mode`，支持 multipart 上传）、`nanobotHttp/{config,channels,tasks,usage,channelConnect}.ts`（把前端配置反向镜像进引擎）、`codec.ts`（camelCase ⇄ snake_case）。
- `connectionManager` + `ConnectionBanner` —— 网关可达性探测；主进程支持端口自动顺延与 `nanobot:gatewayInfo` 协商。

**会话与交互**
- `ChatPage` / `MessageStream` / `AssistantMessage`（流式 markdown）/ `ReasoningBlock` + `ProcessView`（思考过程时间线，`lib/processDigest.ts`）/ `ToolCallCard`。
- 输入区：斜杠命令、文件引用、附件栏、内联 chip、语音输入（`useVoiceInput`，走 OpenAI 兼容 `/audio/transcriptions`）。
- 空状态三级联动（模式 → Skill → 提示词）；**会话检索**（⌘K，`lib/sessionSearch.ts` 读事件流做全文匹配 + 投影缓存）。

**Agent 与专家**
- Agent CRUD / 启停 / 持久化；专家团三模式（`sequential` / `parallel` / `coordinator`）**真实执行**（引擎 `agent/expert_group.py` 调度，成员人设 / 工具 / 模型均已接线，`tests/agent/test_expert_group_wiring.py` 13 例 + 4 条变异验证）；成员归属经 SSE `kind:"member"` 出站 → ProcessView 按成员分组。
- **专家包导出 / 导入**（`FR-3.3`，2026-10-22）：单文件 JSON（schema `nanowork.expert/v1`），含头像、初始提示词、工具白/黑名单、领域风格覆盖、技能引用。导入侧做对账预览：缺技能**不阻塞**（如实报缺失）、缺模型预设丢弃并说明、重名自动加「（导入）」后缀、`toolAllow: []` 原样保留。落盘走既有 `platform.writeTextFile`（Electron `~/.nanowork/`、Web 下载），未新增平台能力。判据 `tests/lib/expertPackage.test.ts`(23) + `expertPackageIo.test.ts`(6) + `expertPackageImportDialog.test.tsx`(6)，4 条变异逐条变红。

**扩展生态（V1.6 大幅补强）**
- 技能三态、连接器、插件包、市场四档注册表 + 版本隔离缓存（`<version>/current` 指针）。
- **插件 prompt 片段**（`FR-3.10`）：`prompt_templates.py` 单 loader → **ChainLoader**（插件命名空间 → 工作区覆盖 → 内置），`user` 档片段包 `<untrusted_content>`。
- **声明式工具策略**（`FR-3.12`）：技能 frontmatter ∩ 插件 manifest，**只能收紧**；前端 `pluginToolGaps.ts` 复刻引擎语义并渲染「N 项工具被收窄」徽标。
- **市场索引与依赖解析**（`FR-3.13`）：可选 `marketplace.json` + 拓扑序安装（环打印出来）+ 语义化版本比较 + 无索引回退。
- **扩展运行时 ADR**（`FR-3.14` → `ADR-0025`）：fork 进程隔离、声明即权限、不抄 Module Federation、不做 Guest SDK。
- **生命周期钩子**（`FR-3.6`，2026-10-23）：插件 `hooks/hooks.json` 的**声明式**钩子——`session_start` 注入系统提示词（市场副本包 `<untrusted_content>`）、`before_tool` 按工具名**精确**拒绝、`after_tool` / `session_end` 观察。挂**基线链**（定时任务与子代理都绕不过，否则「插件禁止 exec」只是对用户手点那条路生效）；`deny` 只能收窄，永远盖不掉审批门 / 执行模式 / Agent 白名单；**刻意不跑外部命令**（钩子不进审批门与工具网关审计）。上限 单条 4000 字符 / 单轮 8000 / 每插件 32 条，超限截断并**报进 `GET /v1/plugins`**，插件卡片显示「N 个钩子生效 / M 条声明被忽略」。判据 23 例 + 5 项变异。
- **会话版本引用集**（`FR-3.9`）：建会话时快照 `{插件名: 版本}` 并随元数据**跨端同步**；`collectCache` 的引用集 = 本机生效副本 ∪ 会话声明，换机 GC 不会删掉别的设备仍在用的那一版；解析用本机副本回答「这个会话要的那一版在不在」（`missing` 如实报出）。包本体仍不上行。

**安全（V1.6 三道防线）**
- 应用层：`decide_tier` 三档 + 逐条批准 + 回收站改道 + 审计留痕。
- **审计两条来源**（`FR-8.9`，2026-10-23）：① **工具网关**（引擎 `security/audit.py`，模型每一步动了什么）；② **应用操作**（客户端 `src/lib/appAudit.ts`，人做的配置动作——专家 CRUD、技能装卸/改档、插件装卸/启停、连接器与渠道配置及凭据写入、定时任务增删启停、会话删除、安全策略）。第二来源**只记用户发起的动作**（同步落地走 `setState`，不经 store 动作）、detail **只记字段名并把疑似密钥脱敏成 `***`**、写盘失败一律吞（审计是旁路）。落点 `<userData>/audit/app-operations.ndjson`，审计页同页两档切换；判据 30 例 + 3 项变异。**2026-10-24 补引擎侧**：引擎自己做的非工具动作（Dream 采纳/丢弃、配置热加载、任务库重载）由 `nanobot/security/audit.py::record_app_operation` 写入 `<data_dir>/audit/app-operations.ndjson`（同一套行格式，`actor=engine`），客户端读回后与本机记录合并成一条时间轴、用「来源」列区分——「我点了采纳」与「引擎真的改了文件」是两件事。判据 14 例引擎 + 2 例界面 + 4 项变异。
- 外壳层：`electron/windowPreferences.ts` 档位表（危险档位缺前置即 throw）、主窗口 `sandbox:true`、`webSecurity:false` 收敛为显式认领。
- **沙箱边界声明**（`FR-8.5`，2026-10-23）：`src/lib/sandboxBoundary.ts` 是唯一事实来源——五层（渲染层外壳 / 工具网关 / 文件系统 / 网络 / 操作系统级隔离）逐层给「已生效 / 部分生效 / 没有」与**恰好缺的那一块**，设置「安全」分区只读渲染，**刻意不给开关**（引擎侧没有可开关的 native 沙箱，假开关等于宣称已有隔离）。同时纠正两处「文档写得像已隔离」的地方：`agent/tools/sandbox.py` 只有 bwrap 一个后端、仅 Linux、**默认关闭**（Windows 无后端 → 警告后裸跑），域名出口白名单则完全没有（只有 SSRF 防护）。判据 11 例 + 3 项变异，其中「OS 级隔离不得写成已生效」「bwrap 默认关闭 + Windows 无后端必须写着」「`exec` 绕过路径隔离必须写着」几条专门防止这张表被改成一片绿。
- 内容层：产物 iframe CSP（含 `connect-src 'none'`）；删除统一走 `safeDelete`（**失败不降级**）。
- 路径层（`FR-8.13`）：`security/path_rules.py` **读写删分别授权**；优先级定死为「凭据 `no_access`（无条件）> 允许根包含性 > 路径规则 > `default_deny_write`」。
- **提示词注入检测**（`FR-8.6` ③）：`src/lib/promptInjection.ts` 四类本地规则（指令覆盖 / 角色劫持 / 外泄诱导 / 编码混淆），输入框上方常驻一行提示、**只提示不拦截**；规则按「动作 + 对象」收紧，另有 6 条「正常提问不误报」用例守着误报率。

**可观测与成本**
- 用量（`/v1/usage`，三档计价 + 7/30/90 天窗口 + 平均首字延迟）、回合级 trace、日志分级、审计、诊断包（进程 / 端口 / 出口脱敏）。
- **启动剖析**（`FR-11.6`）：`app.load→ready` / `window.create→firstPaint` / `serve.spawn→listen` / `gateway.spawn→listen` 四点，区间按并集算，落 `session-latency.jsonl`。
- **TTFT 全链路已通**（`FR-11.7`）：`sseLatency` 量「首字节 → 首 token」；引擎侧把 observer 绑到 `make_provider` 构造出口后，交互流量真实落库（实测 `ttft_ms` 5778 / max 12197）。

**记忆（v2）**
- 两类存储根（用户级 `~/.nanowork/user-memory/u_<hash>/`、工作区级 `<wd>/.nanowork/memory/`）+ 隔离键；事实日志 `daily/*.jsonl` → 蒸馏 → 投影 `MEMORY.md`；冲突案件 + 人工裁决审计流；记忆页可查看 / 编辑 / 删除（**真实删除**）/ 导出。

**自动化**
- `TaskSchedule` = `cron`(5 段 + tz) | `interval` | `once`（含 `rrule` + 有效期窗口）；镜像进 `cron/jobs.json`（托管标记 + 会话绑定）；IM 结果回推、IM 会话归档。

**IM 通道**
- 钉钉 / 飞书 / Lark / 微信 / 企业微信 5 渠道 + 扫码接入（飞书 / Lark / 微信）；`allowFrom` 白名单、`groupPolicy`、`topicIsolation`；渠道健康轮询与告警。

**跨端与运行期（V1.6）**
- `src/platform/` 收口所有 `window.electronAPI`；渲染层零 `import 'electron'`。
- **单实例锁**（第二实例转交第一实例、不 spawn 引擎）、**进程树清理**（`uncaughtException` / 信号 / 退出钩子统一走 `cleanupChildProcesses`，`taskkill /T` + await）、**`restartServe()` 统一入口**（端口未释放即短路，绝不盲启动）、**`run/` 残留五档清理**（只删文件从不杀进程）、**首屏瘦身**（懒加载 + `__vitePreload` 助手单独成 chunk）、**引擎运行时自检**（解释器 / 包 / 配置三项各自独立，失败给可复制命令）。

**同步（V1.5）**
- FastAPI 认证 + Sync API + SyncMeta 全量接入（8 实体带 `rev` / `updatedAt` / `deletedAt` / `updatedBy`）、墓碑 30 天 GC、`conflict` 快照、数据主权归档。

---

## 四、已知限制 / 遗留风险

1. **`FR-8.4`「默认拒绝写入」仍是 opt-in**：引擎 `agent/tools/filesystem.py` 的 `default_deny_write: bool = False`，且仓库内 `nanowork.config.json` 的 `file.defaultDenyWrite` 也是 `false`、`pathRules: []`。语义与「默认拒绝」不符，需改名或改默认值（未排期）。
2. **上游耦合与双副本**：引擎侧 `[LOCAL PATCH]` 共 **163 处 / 37 文件**；桌面真正运行的是 `D:\Workspace\study\nanowork\nanobot`，本仓 `nanobot/` 是工作副本 → **任何引擎改动必须同步两份**（2026-10-17 已全量同步一次，唯一刻意差异是 `utils/gitstore.py` 的跨进程 `FileLock`）。模型不执行任何 git 写操作。
3. **引擎不下发 `tool_calls` / `artifacts` 事件**：`api/server.py` 的 `_sse_chunk(delta: str, ...)` 只带 `content`。客户端已按标准 OpenAI 协议写好解析层（网关下发即生效），并对完成文本做围栏块启发式产物提取。
4. **子代理 `spawn(wait=false)` 结果必丢**：`serve` 拓扑下没有 inbound 消费者。修复路径固定为 `run_inline`（`spawn(wait=true)`、`announce=False`、结果当工具结果回注）—— 排进 V1.7 B3-01。
5. **`FR-13.6` 真机项未做**：「改 venv 名 → 出引导」有破坏性，改用 `NANOBOT_BIN` 指向不存在路径的等价路径，**仅单测覆盖**。
6. **交付链四件已实现（B4 ✅ 代码完成）**：自动更新（`electron-updater` + `builder.config.json` 的 `publish` 段）、深链（`nanowork://`，`electron/deepLink.ts` + 协议注册）、运行时自助安装（`electron/engineInstall.ts`）、反馈包（`electron/diagnostics.ts`）均已在 2026-10-18 落地。深链真机已过（10-21）；更新要发版凭据、自助安装要干净机器，见 §四-11。
7. **`FR-11.8` 不做**：WAL 高水位是正常行为（PASSIVE checkpoint 不截断），跨进程 worker 会与写入者争锁；替代口径「诊断包加 sqlite 尺寸（只读）」待做（V1.7 B5-02）。
8. ~~门禁噪声两条~~ **已修（2026-10-17 B2）**：同步集成超时余量、`fileBackup` 用例与契约冲突全序化。全量门禁现在是 `229 文件 / 3454 用例 exit=0`。
9. **次要改进点**（不阻塞）：非敏感工具 `pending` 闪现、Artifact 下载统一 `.txt`、light 主题未联动切换。
10. **不在 V1.7 计划内的一条**：`FR-3.5` 远程扩展市场（P2 ⬜，无服务端，归 V2）。`FR-3.3` Expert 包已于 **2026-10-22** 落地（见 §三「Agent 与专家」），不再计为 V2 欠账——本期只做**单专家**分发；团队包（`expertType: team`）需成员互相引用，仍待设计。

11. **V1.7 真机验证 3/6 通过（非代码缺口）**：已过 —— 深链双入口（10-21）、子代理真实派生 + 权限单调递减（10-23）、Dream 候选/采纳/丢弃/回退开关（10-23）；未过 —— 飞书 IM 审批闭环（缺应用凭据）、更新下载安装（缺 `GH_TOKEN`，本机也未装 `gh`）、干净机器自助安装（本机已有 venv）。三条都不是代码问题，判据与逐条结论见 `docs/plan-v1.7-closure-and-delivery.md` 附录 C。

---

## 五、仓库构成与运行

### 5.1 两个仓库（其实是三份代码）

`nanobot/` 是**同级独立 git 仓库**（上游 `HKUDS/nanobot`），被父仓库 `.gitignore` 忽略，**不是 submodule**；父仓库 clone 后拿不到引擎源码（约定与初始化见 `docs/engine-dev-setup.md`）。另有**桌面实际运行的那份副本**（见 §四-2），改引擎必须两份一起改。

### 5.2 运行

```bash
npm install                       # 受限环境可加 ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm run dev                       # Web 开发服务器（http://localhost:5173）
npm run build                     # tsc ×2 + vite build → dist/
npm run electron:serve            # 构建并以 Electron 打开
npm run verify:gateway            # 网关链路集成测试（monkeypatch fetch 全链路）
```

真实网关（详见根 `README.md` 第 3 节与 `docs/engine-dev-setup.md`）：

```bash
.\nanobot\nanobot\.venv\Scripts\nanobot.exe serve --config nanowork.config.json --host 127.0.0.1 --port 18900 -v
```

> 客户端默认网关 `http://127.0.0.1:18900`（`src/lib/constants.ts`）。**端口不一致会连不上**。
> 首选端口被占用或落在 Windows 保留端口区间（`winerror 10013`，如 nanobot 自带 8900 就落在 8807–8906 内）时，桌面主进程会**自动顺延挑可用端口**并经 `nanobot:gatewayInfo` 同步给渲染层（横幅提示「端口已自动改为 N」）。
> ⚠️ 门禁与构建必须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，否则 `vite build` 清 `dist/` 会被安全删除守卫拦下（假红）。

---

## 六、相关文档

| 文档 | 用途 |
|---|---|
| `docs/nanowork-prd-design-v2.md` ⭐ | 唯一事实源：需求 + 设计 + ADR 总纲（V1.6 的 19 条已并入第 3 章） |
| `docs/plan-v1.7-closure-and-delivery.md` ⭐ | 当前执行计划：B1 判据收口 → B2 客户端 → B3 引擎侧 → B4 交付 → B5 数据决策 |
| `docs/upgrade-v1.6-requirements-and-plan.md` | V1.6 落地记录（需求原文、批次明细、变异验证、踩坑） |
| `docs/README.md` | 文档索引（登记制 + 一致性看板 + 阅读路径） |
| `docs/adr/` | 架构决策记录（ADR-0001 ~ ADR-0025） |
| `docs/engine-dev-setup.md` | 引擎仓库边界、venv 约定、本地开发与排错 |
| `docs/upstream-merge-conflicts.md` | `[LOCAL PATCH]` 全量清单（含 V1.6 的 B6 / B7 登记） |
| `docs/gateway-e2e.md` | 网关端到端验证手册 |
| `README.md`（根） | 使用入门 |
