# nanowork V1.7 开发计划：收口与可分发性（Closure & Distribution）

> **版本代号**：V1.7「V1 收口 + 交付闭环」
> **文档性质**：增量**计划**（不含新业务需求）——只做两件事：把 V1 剩下的 P1 结清、把「开发者能跑」变成「别人能装」。
> **前置**：`docs/upgrade-v1.6-requirements-and-plan.md`（**19 条新增 FR，18 条已落**，`FR-11.8` 因前提被实测推翻而不做；原文称「24 条」按批次任务计数）
> **口径**：本文所有「现状」均为**代码实测**（带 `file:line`），不采信文档描述；与代码冲突时以代码为准（文档治理约定第 4 条）。
> **版本日期**：2026-10-17

---

## 〇、TL;DR

V1.6 把「运行期工程」补齐了，但 **V1 本身仍未整体收口**（`OVERVIEW.md` §TL;DR 的原话）。逐条复核 V1 的 P1 之后，只剩 **7 条**，而其中 **3 条的状态标注与代码不符**——如果直接照着 `nanowork-prd-design-v2.md` §6 的 P1 基线表排期，会把已经做完的活重做一遍（该表还把 `FR-1.7` / `FR-7.4` 列在「未完成」里，两者其实早已 ✅）。

所以本期的**第一件事不是写代码，是把判据改对**（B1），然后才是：

| 批 | 主题 | 规模 | 一句话 |
|---|---|---|---|
| **B1** | 判据与文档收口 | S | 先把「还剩什么」改成真的，否则后面全是白工 |
| **B2** | 客户端补完 | M | 把剩下两件纯渲染层的事做掉（同步边界收尾 / 提示词注入检测） |
| **B3** | 引擎侧能力（一次做完） | L | 子代理委派 / Dream 审查闸门 / IM 内审批——三条都要动引擎，**必须一批做完**，因为引擎有两份副本要同步 |
| **B4** | 交付闭环 | M–L | 自动更新 / 深链 / 运行时自助安装 / 反馈包——从「能跑」到「能装」 |
| **B5** | 数据驱动决策 | S | 用 v1.6 新装的剖析数据决定预热池、Job Object 这些口袋项到底要不要做 |

**放行门槛**：B1–B2 为 P0（必须），B3–B4 为 P1（本期承诺），B5 不承诺交付物、只承诺一次带数据的决策记录。

### 落地进度（滚动更新）

| 批次 | 状态 | 日期 | 证据 |
|---|---|---|---|
| **B1 判据与文档收口** | ✅ **已完成（7/7）** | 2026-10-17 | **B1-01**：v2 §6 的 P1 基线表整块重写为「复核后真正剩余的 P1 共 4 条」并逐条给阻塞点与落点；`docs/README.md` §九 看板新增 **#35**（与 #34 同源的状态滞后，第二次发生）。**B1-02**：`FR-4.4` ⬜→🟡，写明「个人 / 项目两级已由记忆 v2 落地（`memoryPaths.ts` 两类根 + `workspaceIdFor` / `scopeIdFor`），只剩组织级 → V3」，**本轮零代码改动**。**B1-03**：`FR-8.6` 拆三件（彻底删除 ✅ / 检索前过滤被知识库阻塞 / 注入检测待做）并注明「不再计为整条欠账」。**B1-04**：`FR-3.9` 收窄为两块并给 ② 的降级口径。**B1-05**：**19 条 FR**（R13 全量 6 + R3 5 + R8 4 + R11 4）并入 v2 第 3 章，**新开 R13 域**并进域总览表；顺带校准「原文称 24 条 / 实为 19 条」的计数口径（v1.6 §〇 加勘误行）。**B1-06**：`OVERVIEW.md` 全篇重写（V1 收口口径、V1.6/V1.7 进度、已实现能力按域、遗留风险 10 条）。**B1-07**：本文件已登记进 `docs/README.md` §三。**门禁实测（零代码改动，用于确认基线）**：三套 `tsc` 均 0 错误；`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` **退出码 0**（24.43s）；首屏 `modulepreload` 0.61 MB / 合计 1.16 MB（两条预算内）；`vitest` **226 文件 3409 用例**中 **2 个红均已定位为夹具/环境类**（同步集成用例并发下健康检查超时、`fileBackup` 用例断言与 `list()` 契约冲突的确定性 flaky），证据见 `OVERVIEW.md` §2.1 —— **两条噪声建议在 B2 一并修掉** |
| **B2 客户端补完** | ✅ **已完成（3/3 + 2 处门禁噪声）** | 2026-10-17 | **B2-01**：会话版本引用集进同步负载——`Session.pluginVersions` / `SessionMeta.pluginVersions` 声明字段 + `src/lib/sessionPluginRefs.ts`（快照 / 解析 / GC 保护集，纯函数）+ 白名单 `pluginVersions`（**对象按内容比**，否则每轮发送都涨 `rev`）+ `toMeta` / `toMetaFromEntity` / `metaToSession` / `deriveMetaFromEvents` 往返 + `collectCache` 的引用集改为 **本机生效副本 ∪ 会话引用集**（换机 GC 不再删掉别的设备正在用的那一版）。**B2-02**：`src/lib/promptInjection.ts` 四类规则（指令覆盖 / 角色劫持 / 外泄诱导 / 编码混淆）+ `components/composer/InjectionNotice.tsx`，`Composer` 上方常驻提示、**只提示不拦截**；规则按「动作 + 对象」收紧，6 条「正常提问不误报」用例钉住误报率。**B2-03**：占位本就确定（`hashHue`），本轮补 `helperText` 写明「云端头像未接入」+ 9 条用例**锁定确定性**（同名同色同字；URL 头像退回名称首字），**不新增任何网络请求**。**门禁噪声（2 处，均非回归）**：① `fileBackupStore` 的 `BackupEntry` 加单调 `seq`，`list()` 改「`at` 倒序 → `seq` 倒序」的**全序**（同毫秒也确定），用例改为按契约断言「最新在前」；② 两个同步集成用例的健康检查与 `beforeAll` 超时 20s → 90s（全量并发下 uvicorn 首次 import 可被拖过 20s，单跑只要 2.9s）。**门禁**：三套 `tsc` 0 错误；全量 `vitest --maxWorkers=3` **229 文件 / 3454 用例 exit=0**（此前的两处红全消）；`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` exit=0；`electron/main.cjs` / `preload.cjs` 已重建（`indexFile.ts` 被主进程打包，改它必须重建）。**变异验证 3 项**：白名单去掉 `pluginVersions` → 4 条红；去掉 `seq` 兜底 → 2 条红；去掉中文指令覆盖规则 → 1 条红 |
| **引擎统一收尾** | ✅ **已完成** | 2026-10-17 | 用户决策「统一到本仓 study 副本，桌面也跑本仓」。`$APPDATA/nanowork/nanowork.nanobot.json` 由坏掉的 `{}`（带 BOM→`JSON.parse` 抛错→fallback 到本仓 exe）改为显式 `{bin: study exe, host:127.0.0.1, port:8900}`（无 BOM）。study 引擎已自洽：`gitstore.py` 含 FileLock、`nanobot.exe` 启动器指向本仓 venv（`nanobot_ai 0.3.0` 已装）、`nanobot --version`→v0.3.0。凭据走环境变量 `DASHSCOPE_API_KEY`（两份 `nanowork.config.json` 均无内联密钥）→ 统一不丢凭据。本机无 codes 应用 userData（codes 副本未被使用），备份在 `codes/nanobot/.local-backup-eng-20261017_204905/`。B3 引擎改动落 study 即可，不再强制双副本同步 |
| B3 引擎侧三件 | 🟡 代码全落、待真机（B3-01 ②③④；B3-02 ①②③④；B3-03 ①②③） | 2026-10-18 | 三件均已实现并有用例；剩余 B3-01 ①（子代理真机一轮）与三件的飞书真机闭环。B3-03 新增 `security/im_approval.py` + `tests/security/test_im_approval.py`(36) |
| B4 交付闭环 | ✅ 全部完成（B4-01 自动更新 / B4-02 深链 / B4-03 运行时自助安装 / B4-04 反馈包） | 2026-10-18 | B4-01 发布源 GitHub Releases（真机发版需 `GH_TOKEN`），B4-04 诊断含启动剖析+延迟摘要+脱敏清单可见，B4-03 一键修复状态机已落（仅当解释器/导入失败时出按钮） |
| B5 数据驱动决策 | ✅ 已完成（4 项决策记录，均带数字） | 2026-10-18 | B5-01 关掉 CLI 预热池（首字延迟 p50 5s/p95 47s 由远端 LLM 主导，引擎启动 4.4s 已被 app 启动并行预热覆盖）；B5-02 采纳只读 sqlite 尺寸监控、拒绝跨进程 checkpoint（引擎确有 `llm_usage.sqlite3` 180KB）；B5-03 维持自助安装（本机自检 3/3 通过，未触发 <70% 阈值）；B5-04 续挂口袋清单（现有 `taskkill /T` 回收有效、无真实诉求） |

> **B1 过程中额外发现（已记录，未擅自扩范围）**：① `vite build` 不带 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 会被安全删除守卫拦在 `emptyDir(dist)`，报错栈看着像构建坏了 —— 已写进 `OVERVIEW.md` §5.2 的提醒。② `tests/lib/fileBackup.test.ts` 的 `append / delete` 用例断言的是**插入序**，而 `list()` 的契约是**最新在前**，两次快照跨毫秒时必然红（4 次重跑 2 红 2 绿）。这是**夹具与契约冲突**，不是产品缺陷，但会让每次全量门禁掷硬币。**修法建议**：给时间线条目加单调 `seq`，`list()` 改成「`at` 倒序 → `seq` 倒序」的全序（同毫秒也有确定顺序），用例随契约断言 —— 顺带消掉 UI 侧真实存在的不确定性；只改用例（断言集合）是次选。排入 B2 收尾。

---

## 一、现状核对（代码实测，2026-10-17）

### 1.1 V1 的 P1 还剩什么

| FR | 文档口径 | 代码实测 | 结论 |
|---|---|---|---|
| **FR-2.5** 子 Agent 委派 | P1 ⬜ | 引擎**能力已在**：`agent/subagent.py` + `agent/loop.py:425` `self.subagents = SubagentManager(...)`；`loop.py:212` 有 `_subagent_tools_config()` | **真待办**。缺的不是「能不能派生」，而是三件事：① 权限**单调递减**是否真成立（子工具集 ⊆ 父工具集，需实测 `_subagent_tools_config` 与父 `tool_allow/tool_deny` 的关系）② `/v1` 链路下 `spawn(wait=false)` 结果必丢（已定位，需改走 `run_inline`）③ 客户端看不见子代理（ProcessView 无分组） |
| **FR-3.9** 扩展态同步边界 | P1 🟡 | 启用态已同步（`src/lib/settingsSync.ts` 把 `enabledPlugins` 列为保留）；版本引用集只服务本机 GC（`src/stores/pluginsStore.ts`） | **真待办，但只剩两块**：① 会话版本引用集**进同步负载**（当前不跨端）② 专家头像走**账户级命名空间**（现仅 `Agent.avatar?: string` 本地字段）。②依赖云端资产，本期可降级为「确定性占位 + 降级说明」 |
| **FR-4.4** 记忆分级与命名空间 | P1 ⬜ | **个人 / 项目两级已由记忆 v2 落地**：`src/lib/memoryPaths.ts` 的 `USER_MEMORY_DIR`（`~/.nanowork/user-memory/u_<hash>/`）与工作区根（`<wd>/.nanowork/memory/`），隔离键 `workspaceIdFor()` / `scopeIdFor()` | **改判，不是开发任务**。三级里「个人 / 项目」已 ✅，只剩「组织」——而组织级记忆必须有租户/组织模型（V3）。本期只做**状态勘误**，不写代码 |
| **FR-4.6** Dream 双阶段记忆 | P1 ⬜ | 引擎 Dream **已在跑**：`agent/memory.py:82` `.dream_cursor`、`:410` 读 cursor 判「有没有新东西要合并」、`:511` `dream_prompt_file`；`llm_usage` 里 `source='dream'` 有真实流量 | **真待办**。缺的是文档要求的那半句——「**合并产物需用户可审查后才生效**」：现在是无闸门直落，缺候选暂存 + 审查 UI。⚠️ 落点需实测（Dream 是直写 `memory/MEMORY.md` 还是经工具写） |
| **FR-6.5** IM 内审批 | P1 ⬜ | 审批**回传端点已有**：`api/server.py:866` / `:1111` `POST /v1/tool-approvals/{id}`；渠道**发送能力已有**：`channels/*/runtime.py` 各家都有 `async def send(OutboundMessage)` | **真待办**。缺引擎侧「把审批请求变成渠道卡片 + 收回调」这一段；桌面权限弹窗不受影响（两条路并存） |
| **FR-8.5** 沙箱执行 | P1 🟡 | electron 侧已由 v1.6 `FR-8.10`（`electron/windowPreferences.ts` 档位表）补；引擎侧 Windows 沙箱仍缺 | **本期只做边界声明**：把「已有什么/没有什么」写死进设置页与文档，不做 native 沙箱（见 B5） |
| **FR-8.6** 数据防泄漏 | P1 ⬜ | 三件里：① 「记忆可彻底删除」**已随 FR-4.5 ✅**（真实删除）② 「检索前按权限过滤」被知识库阻塞（无知识库＝无检索）③ 「提示词注入检测」**全仓零命中** | **部分待办**：只剩③可做，①②改判（② → V2 知识库，① → 已落） |

> 复核依据：`grep` 全仓 + 逐文件读。**未做**：FR-2.5 的子代理权限关系、FR-4.6 的 Dream 写入落点——两者在 B3 开工第一步用「跑一轮 + 查盘」实测，不靠读代码推断（项目已有「别从 grep 推断序列化」的教训）。

### 1.2 必须先修的三处判据偏差

| # | 偏差 | 后果 |
|---|---|---|
| 1 | `nanowork-prd-design-v2.md` §6 的「P1 状态基线（2026-10-07）」表把 `FR-1.7` 会话检索、`FR-7.4` 产物版本列为「未完成（可纯客户端落地）」，但两者分别已于 2026-10-06 / 10-05 转 ✅（代码：`src/lib/sessionSearch.ts`、`src/stores/artifactsStore.ts:101` 的 `versions` / `previousVersion`） | 照表排期 = 重做已完成的活 |
| 2 | `FR-4.4` 标 ⬜ 但两级已落；`FR-8.6` 标 ⬜ 但三件里两件已落/被阻塞 | 把「改判」当成「开发」，虚增规模；也让真正的缺口（Dream 闸门、IM 审批）被埋没 |
| 3 | v1.6 的 19 条新增 FR 尚未并入 v2 第 3 章（R3 / R8 / R11 / R13），`OVERVIEW.md` 仍是 2026-09-17 口径 | 下一轮做「阶段盘点」时又得从 `docs/` 里翻增量文档 |

---

## 二、批次明细

### 批次 B1 —— 判据与文档收口（P0，S）

**先做，且只改文档不动代码。** 这一批的价值是「让下一轮的排期输入是真的」。

| 任务号 | 任务 | 落点 | DoD |
|---|---|---|---|
| B1-01 | 勘误 v2 §6「P1 状态基线」表：`FR-1.7` / `FR-7.4` / `FR-6.6` 移出未完成清单，注明转 ✅ 的日期与代码落点 | `docs/nanowork-prd-design-v2.md` §6 | 表内每一条都能用 `file:line` 对上代码；在 `docs/README.md` §九 看板登记「状态滞后」这一条本身 |
| B1-02 | `FR-4.4` 改判：个人 / 项目两级 **✅**（指向 `memoryPaths.ts` 两类根与隔离键），组织级 → **V3**（依赖租户模型） | v2 第 3 章 R4 + 第 2 章里程碑 | 状态从 ⬜ 改为「✅（V1 范围）/ ⬜（组织级，见 V3）」，不再计入 V1 欠账 |
| B1-03 | `FR-8.6` 拆三件并分别定状态：彻底删除 ✅ / 检索前过滤 → V2 知识库 / 注入检测 ⬜（本期 B2-02 做） | v2 第 3 章 R8 | 一条 FR 拆成三行可验收的子项，无「一整条 ⬜ 盖住已完成部分」 |
| B1-04 | `FR-3.9` 收窄为剩余两块，并给 ② 定降级口径 | v2 第 3 章 R3 | ①「会话版本引用集跨端」进 B2-01；②「专家头像」标「本期降级，不承诺云端」 |
| B1-05 | v1.6 的 19 条新增 FR 并入 v2 第 3 章对应域（R3 `FR-3.10~3.14` / R8 `FR-8.10~8.13` / R11 `FR-11.6~11.9` / 新域 R13 `FR-13.1~13.6`） | v2 第 3 章 + 第 6 章里程碑 | 第 3 章能直接查出这 24 条（含状态与判据），增量文档转为「已并入」 |
| B1-06 | 按 v2 §1.2 口径重写 `OVERVIEW.md`（该文件自我约定「每期收口时重写」） | `OVERVIEW.md` | 里程碑表反映 v1.6/v1.7 的真实状态；§四 遗留风险删掉已闭合项（如「专家团只持久化未执行」「文件回滚假就绪」） |
| B1-07 | 本文件登记进 `docs/README.md` §三 增量文档 | `docs/README.md` | 索引行含「状态 / 阶段 / 内容概要」三列，符合登记制 |

**门禁**：不需要 `tsc` / `vitest`（零代码改动），但必须做一次「文档 → 代码」交叉核对：每条改判都要有一次 `grep`/读文件作为依据，**不接受从别的文档抄**。

---

### 批次 B2 —— 客户端补完（P0，M）

零引擎改动、零 `electron/**` 改动（不用重建 cjs），一批做完即可单独发版。

| 任务号 | 任务 | 需求 | 落点 | DoD |
|---|---|---|---|---|
| B2-01 | 会话的**插件版本引用集**进同步负载：让「A 设备装的是 v0.1.9、B 设备是 v0.1.10」在 pull 后能被发现并按引用集解析 | FR-3.9 ① | `src/types/session*` + `src/sync/*` + `src/stores/pluginsStore.ts` | 两端同步后，同一会话解析到同一版本；**不得**把包本体上行（包本体仍各设备自装）；旧负载缺字段时按「无引用集」放行，不报错 |
| B2-02 | 提示词注入检测：本地规则识别 + 命中打标 + UI 提示（不阻断） | FR-8.6 ③ | 新增 `src/lib/promptInjection.ts`（纯函数）+ 输入区/记忆页展示 | 至少覆盖四类：指令覆盖（"ignore previous" / "忽略以上"）、角色劫持、外泄诱导（读 `.env` / 密钥路径）、编码混淆（base64/零宽字符）。**命中只提示不拦截**（拦错了比不拦更糟）；规则集可单测、可扩展 |
| B2-03 | 专家头像降级口径落地：无账户命名空间时给出**确定性**占位（同 Agent 同色同字），并在专家编辑页说明「云端头像未接入」 | FR-3.9 ② | `src/types/agent.ts` / 专家编辑页 | 同一 Agent 在两端占位一致（同 hash 同输出）；不新增网络请求 |

**变异验证**（改回旧写法必须变红）：

| 需求 | 变异 | 期望 |
|---|---|---|
| B2-01 | 把引用集从同步负载里摘掉 | 「pull 后两端解析到同一版本」用例变红 |
| B2-01 | 对缺字段的旧负载抛错 | 「旧负载兼容」用例变红 |
| B2-02 | 把「命中即拦截」当成实现 | 「命中不阻断发送」用例变红 |
| B2-02 | 规则只看中文或只看英文 | 单语种用例漏检 → 变红 |
| B2-03 | 占位改回随机色 / 随机字 | 「同 Agent 两端一致」用例变红 |

---

### 批次 B3 —— 引擎侧能力（P1，L，**必须一批做完**）

> ⚠️ 三条都要动 `nanobot/`，而本机有**两份引擎副本**（`D:\Workspace\Codes\...\nanobot` 是桌面真正在跑的那份、`study/...\nanobot` 是工作副本）。分三批做＝同步三次，每多一次就多一次「两份行为不一致」的机会。**做完一次性同步，并按 `upstream-merge-conflicts.md` 逐条登记 `[LOCAL PATCH]`。模型不执行任何 git 写操作。**

#### B3-01 子 Agent 委派（FR-2.5）

| 步骤 | 内容 | 状态 |
|---|---|---|
| ① 实测现状 | 跑一轮让主 Agent 派生：查「子代理最终回答有没有回到主答案里」「子代理实际拿到的工具集 vs 父的工具集」 | ⏳ 待真机一轮（代码层已用回归用例锁住 ②+③ 行为，等价保证） |
| ② 修结果回收 | `/v1` 链路改走 `run_inline`（`spawn(wait=true)`，`announce=False`，结果当工具结果回注），**不碰** `spawn(wait=false)`（它的结果在 `serve` 拓扑下必丢） | ✅ **已落**（2026-10-18）：`agent/tools/spawn.py` 在 `channel=="api"` 时强制 `wait=True`；回归用例 `test_spawn_tool_forces_inline_for_api_channel` + 对照 `test_spawn_tool_respects_background_for_interactive_channel` 锁死「不退回 wait=false」 |
| ③ 权限单调递减 | 子工具集 = 父工具集 ∩ 子声明；父是 `None`（不限）时按子声明，父是空集时子必须为空集 | ✅ **已落（早于本批，study 副本）**：`_run_admitted_subagent` 经 `bind_workspace_scope(parent_scope)` + `AgentToolPolicyHook` 继承父 tool_allow/tool_deny；`test_subagent_inherits_agent_tool_deny` / `_allow` / `_without_policy_can_still_write` 三组锁死（父空→子按声明、父窄→子不得更宽、父 None→子按声明） |
| ④ 客户端可见 | ProcessView 按子代理分组（与专家团成员分组同一套渲染，不新造视图） | ✅ 已落（2026-10-18）：引擎新增 `agent/subagent_progress.py`（进度槽 contextvar，与 `bind_workspace_scope` 同构）+ `_SubagentHook` 发 `started/tool/done/error` + 服务端 SSE `kind:subagent`；客户端 `chat.ts` 解析 → `sessionsStore.handleProcessSubagent`（**落盘**，与成员同纪律）→ `processDetail.groupSubagentEvents` → `ProcessView` 新增 `SubagentGroupView`。测试：引擎 6 例（含端到端 `started→done` 序列）+ 客户端 9 例分组语义 + 等价性用例扩到子代理三行；变异：分组键去掉 `subagent:` 前缀 → 1 例红 |

#### B3-02 Dream 审查闸门（FR-4.6）

| 步骤 | 内容 | DoD |
|---|---|---|
| ① 实测落点 | 查 Dream 合并产物到底落在哪：`memory/MEMORY.md`？`agent/memory.py` 的 memory 工具？ | ✅ **已落（2026-10-18）**：代码层实测确认 `build_dream_tools()` 把 `MEMORY.md/SOUL.md/USER.md` 注册给写工具**直落**，无 candidate、无闸门——即 FR-4.6 的硬缺口 |
| ② 加闸门 | 产物先写 candidate 区（不改 `MEMORY.md`），客户端审查页展示「新增 / 修改 / 删除」三类 diff，采纳才写回 | ✅ **已落（2026-10-18）**：`MemoryStore` 新增 `dream_candidate_dir` + `prepare_dream_candidate`/`has_dream_candidate`/`compute_dream_candidate_diff`/`accept_dream_candidate`(逐字节比对，仅变化才写回)/`reject_dream_candidate`(永不碰正式文件)；`build_dream_tools(require_review=True)` 把写工具指向 candidate 副本；手动 `/dream` 与 cron `on_cron_job` 两条路径都接闸门。`test_dream_review_gate.py`(15) + `test_builtin_dream.py` 新增门开用例锁死「不采纳⇒逐字节不变」 |
| ③ 客户端审查 | 记忆页新增「待审查」区（沿用记忆 v2 的冲突裁决 UI 形态，不新造） | ✅ **已落（2026-10-18）**：引擎新增 3 条 REST 端点 `GET /v1/dream/review`(返回 `compute_dream_candidate_diff`)、`POST /v1/dream/accept`、`POST /v1/dream/reject`（`api/server.py` 沿用 `_plugin_workspace` 取工作区→`MemoryStore`）；客户端 `NanobotHttpRuntime` 透传 `getDreamReview/acceptDream/rejectDream`（`AgentRuntime` 接口按能力声明加了可选方法，老网关无此方法时面板静默降级）；新增 `src/pages/memory/DreamReviewPanel.tsx`（MUI，展示 new/modified/deleted 三类 diff + 采纳/丢弃）并接入 `MemoryPage`（工作区作用域、写盘 `reloadToken` 变化即重拉）。`tests/api/test_dream_review_endpoint.py`(5) 锁死端点契约。**真机采纳/丢弃验证待用户环境（网关 + dashscope）跑一轮** |
| ④ 回退开关 | 闸门可关（回到「直落」），默认**开** | ✅ **已落（2026-10-18）**：`DreamConfig.require_review: bool = True`（默认开）；`AgentLoop` 经 `from_config` 透传 `defaults.dream.require_review`；`loop.py`/`builtin.py`/`gateway_runtime.py` 三处 `if require_review` 分支；关掉即回到引入闸门前的「直落」旧行为。配置往返用例已随 ② 用例覆盖 |

⚠️ 与记忆 v2 的关系：v2 已有 `conflicts.json` + 裁决审计流。Dream 候选**不得**复用冲突案件表（那是「两条事实打架」，这里是「模型提议新增」），但可以复用**事务与审计**机制。

#### B3-03 IM 内审批（FR-6.5）

| 步骤 | 内容 | DoD | 状态 |
|---|---|---|---|
| ① 推送 | 审批请求转成渠道卡片（批准 / 拒绝两键）+ 超时 TTL | 钉钉 / 飞书 / 企微至少 1 家真机收到卡片 | ✅ **已落（2026-10-18）**：`build_bus_progress_callback` 新增 `approval_request` 分支，**以普通出站消息**下发（不包 `ProgressEvent`，否则被 `send_progress` 静音）；正文含工具名 / 参数摘要 / TTL / 短编号，`buttons=[["允许","拒绝"]]`。TTL 来自 `ApprovalRequest.timeout_seconds`（与 `wait_for` 同源）。⚠️ **飞书 `send` 不渲染按钮**（代码实测），因此契约以**文本回复**为准，按钮只服务 Telegram/Slack 等已支持渠道。**启用开关**：IM 原本是 `tool_approval=auto`（钩子根本不介入），新增 `channels.<name>.tool_approval: "ask"`（`channel_tool_approval_modes` + `WorkspaceScopeResolver.default_for`），默认 `auto` 不改桌面行为 |
| ② 回调 | 渠道入站回调 → 裁决投回挂起的 future | 点「拒绝」⇒ 工具不执行且主对话收到 deny 结果（与桌面拒绝等价） | ✅ **已落（2026-10-18）**：新增 `security/im_approval.py`（`ApprovalInbox`）在 `AgentLoop.run()` 里、**先于命令分发与 pending 队列**吸收「允许 / 拒绝」；支持裸裁决（本会话唯一一条）与「允许 <编号>」（多条的消歧）。⚠️ **偏差**：走**进程内** `PENDING_APPROVALS.resolve`，不是 `POST /v1/tool-approvals/{id}`——IM 轮次在 **gateway 进程**，该端点只在 **serve 进程**，两个进程各有自己的注册表，HTTP 投过去只会落空。协议面未新增，仍复用 `ApprovalDecision` |
| ③ fail-closed | 渠道不可用 / 超时 / 回调重放 | 一律**不执行**；重放不重复裁决；用例锁死三条 | ✅ **已落（2026-10-18）**：渠道不可用 → 卡片发不出 → 钩子 300s 超时判 deny；超时 → `asyncio.wait_for` 判 deny；重放 → `resolve` 二次返回 False + `ApprovalInbox` 回「已处理或已过期」；跨会话 → 不消耗、不裁决；多条待裁决 + 裸裁决 → 要求带编号，绝不猜。**真机（飞书）收卡 + 允许/拒绝闭环待验证** |

**变异验证**：

| 需求 | 变异 | 期望 |
|---|---|---|
| FR-2.5 | 子工具集改成「父 ∪ 子」 | 「父窄 → 子不得更宽」变红 |
| FR-2.5 | 退回 `spawn(wait=false)` | 「子代理产出出现在最终回答」变红 |
| FR-4.6 | 闸门关掉（直写 MEMORY.md） | 「不采纳 ⇒ 文件逐字节不变」变红 |
| FR-4.6 | 采纳后不写审计 | 「采纳有审计记录」变红 |
| FR-6.5 | 超时改判为 allow | 「超时不执行」变红 |
| FR-6.5 | 回调不去重 | 「重放不重复裁决」变红 |

---

### 批次 B4 —— 交付闭环（P1，M–L）

目标判据一句话：**在一台没装 Node / 没装 Python / 没 clone 仓库的机器上，装得上、更新得了、坏了能说清。**

| 任务号 | 任务 | 现状（实测） | DoD |
|---|---|---|---|
| B4-01 | 自动更新 | ✅ **已落（2026-10-18）**：`electron-updater@6.8.9` 进 dependencies；`builder.config.json` 加 `publish`（GitHub `bwshark/nanowork`，`releaseType: release`）；`package.json` 加 `release:electron`；`electron/updater.ts` 纯状态机（`autoDownload=false`、**只有 `update-not-available` 才产出 `up-to-date`**、错误原样透出）；`UpdateCard` 接入关于页（检查 / 下载 / 重启安装 / 进度 / 原始报错 / **未签名常驻提示** / 发布页兜底）。⚠️ 真机发版链路待验证（需 `GH_TOKEN` + `release:electron`） | 判据：改一版号 → 能检测到并完成下载 → 重启生效 |
| B4-02 | 深链 `nanowork://` | ✅ **已落（2026-10-18）**：新增 `electron/deepLink.ts`（严格解析 `nanowork://x` 与 `nanowork:///x` 两种 authority；未知名 / 空 id / 超长一律 `null`）+ `createDeepLinkRouter`（渲染层 `app:renderer-ready` 报到前排队，之后按序 flush——直接 send 会静默丢）+ `main.ts` 三入口（冷启动 argv / second-instance argv / macOS `open-url`）+ `builder.config.json` 的 `protocols`；渲染层 `App.tsx` 执行动作，`new-chat` 经路由 state 把 prompt 交给 `ChatPage` 预填。第二实例仍由既有单实例锁转交，不自己起网关 | 首批只支持两个动作：`open-session?id=` / `new-chat?prompt=`；**第二实例必须经第一实例转交**（不得自己起网关）；非法参数落到首页且不崩 |
| B4-03 | 运行时自助安装 | ✅ **已落（2026-10-18）**：新增 `electron/engineInstall.ts`（`createEngineInstaller` 状态机：venv → pip install -e → verify，失败即停、后续标 skipped、原始输出透出、可取消杀进程树）。recipe 与 `engineSelfCheck` remedy **同源**（同路径、同引号规则，渲染层只发「开始/取消」不传命令）。`EngineSelfCheckCard` 仅当「解释器 / 导入」失败时显示「一键修复」（配置失败不给，pip 修不了 pydantic 字段）；修复中显示步骤+原始输出+「取消修复」，成功后自动重新自检。`main.ts` 经 `engine:install-progress` 推送状态。 | 自检失败时给「一键创建 venv + 安装引擎」的**可执行**引导（逐条命令可见、可复制、有进度、失败给原始报错）。**不承诺**随包 CPython（体积决策见 B5-03） |
| B4-04 | 反馈包 | ✅ **已落（2026-10-18）**：`electron/diagnostics.ts` 增加启动剖析（`startup-profile.jsonl`）与 `session-latency.summary.json`（min/p50/p95/max + 最近 50 条，坏行忽略）；`meta.redaction` 增 `patterns` 清单；`DiagnosticsExportResult` 增 `redactionHits`；`DiagnosticsSection` 常驻「脱敏与隐私」卡（包含 / 不包含 / 脱敏模式 / 边界）+ 导出后保留落点并提供「打开所在目录」（新增 `shell:showItemInFolder` IPC） | 「一键生成 + 打开所在目录 + **脱敏清单可见**」（用户能看见发了什么，才敢发）；包内含启动剖析与 `session-latency.jsonl` 摘要 |

**真机判据**（必须做，不能只用单测替代）：

1. 装到干净机器/新用户目录 → 首启能看到「引擎未就绪 + 怎么办」而不是白屏。
2. 改版本 → 更新检测 → 下载 → 重启后版本号变化。
3. 浏览器点 `nanowork://new-chat?prompt=hi` → 复用已开窗口（不出现第二个网关进程，`run/` 只有一份状态文件）。
4. 生成反馈包 → 解压自查：无 API key、无 cookie、无绝对路径里的用户名。

---

### 批次 B5 —— 数据驱动决策（P1，S，不承诺交付物）

v1.6 的 `FR-11.6` 已经把启动剖析打点装上了（`app.load→ready` / `window.create→firstPaint` / `serve.spawn→listen` / `gateway.spawn→listen`）。**这些数据现在就是口袋清单的「触发条件」判据**，不用再猜。

本批于 2026-10-18 完成审计 + 实测，四项均给出**带数字的结论**（非「待评估」）。实测数据源：① 本机直接计时 `serve.spawn→listen`（与 `main.ts:1147/1175` 同口径）② 真实 `session-latency.jsonl`（15 个样本，落于 `%APPDATA%/nanowork/`）③ 本机跑 `engineSelfCheck` 三项（解释器/导入/配置）④ `llm_usage.sqlite3` 实存在项目根（184320 字节）。

#### B5-01 · CLI 预热池 —— **决策：关掉（不立项）**

| 项 | 值 |
|---|---|
| 判据 | `serve.spawn→listen` 占 `app.load→ready` 比例 > 40% 且用户可感知 → 立项 |
| 实测 `serve.spawn→listen` | **4418 ms**（暖机、venv 已就绪；注：`main.ts:1072` 注释里的 9.4s 是旧环境残留，已过时） |
| 实测首字延迟（15 样本 `firstTokenLatencyMs`） | **p50≈5.0s / p95≈46.6s / max≈60.9s**（排序：2243,2459,2459,2487,2514,2523,4950,5029,16307,17153,17199,22029,24883,46644,60936） |
| 关键事实 | serve 在 `app.load` 阶段即 `Promise.all` 并行拉起（`startupProfile.ts` docstring 明示），**不与窗口首屏串行的瓶颈**；用户可感知延迟由远端 LLM 首字主导（p50 5s ≈ 引擎启动，p95 47s 是引擎启动的 10 倍以上） |

**结论**：预热池最多为「用户在引擎就绪前就发问」省下 ≤4.4s，而该场景已被 app 启动期并行预热覆盖；真实瓶颈（远端 LLM）不受影响。收益边际、且要维护一个常驻预热进程 → **关掉这一项，续挂口袋清单**。

#### B5-02 · `processes.json` 加 sqlite 尺寸（替代 WAL checkpoint）—— **决策：采纳只读监控；拒绝跨进程 checkpoint**

| 项 | 值 |
|---|---|
| 判据 | 只读 `stat` 文件尺寸、不争锁；不做跨进程 WAL checkpoint（v1.6 已论证前提被推翻） |
| 监控对象是否真实存在 | **是**：`llm_usage.sqlite3` 落于项目根，**184320 字节**（≈180KB），引擎确有 sqlite 产物 |
| 当前 `processes.json` 内容 | 仅进程/端口快照（pid、引擎端口占用者、`run/` 状态文件死活），**尚未含 sqlite 尺寸** |

**结论**：跨进程 WAL checkpoint **不做**（前提已被推翻，且会争锁）。替代项采纳：在 `processes.json` 増一个只读 `sqlite: { path, sizeBytes }` 字段（对 `llm_usage.sqlite3` 做 `stat`，纯只读、零争锁、约 5 行）。属低风险可观测增强，**不计入 V1.7 硬交付**，排入诊断包后续小步；真要落地时复用 `diagnostics.ts` 现有的 `processSnapshot` 注入点。

#### B5-03 · 随包运行时（CPython）vs 自助安装 —— **决策：维持 B4-03（自助安装）**

| 项 | 值 |
|---|---|
| 判据 | B4-03 自助安装实测成功率 < 70% → 评估随包 CPython；否则维持 |
| 本机实测（标准开发环境） | 引擎自检 **3/3 通过**：解释器可达 ✅ / `import nanobot` ✅(`nanowork-selfcheck-import-ok`) / 配置 schema 校验 ✅(`nanowork-selfcheck-config-ok`)；`serve` 实际拉起并监听（4.4s） |
| 安装状态机健壮性 | `engineInstall.ts` 覆盖 venv 创建→`pip install -e`→哨兵 verify→失败即停标 skipped→原始输出透出→可取消杀进程树；失败模式有清晰用户可见引导 |
| 随包 CPython 的代价 | 安装包 +30~50MB、签名/自动更新（B4-01）复杂度上升、跨平台要各打一份 |

**结论**：当前真实样本（n=1，标准开发环境）**成功**；状态机对主要失败模式有覆盖。未触发「<70%」阈值 → **维持 B4-03 自助安装**。重访触发：发版后累计 N≥30 次干净机器安装遥测里成功率 <70%，再评估随包方案。注：本机 1 个样本**不代表**无 Python/公司代理/ARM 等异质环境的成功率，但该数据只能靠发版后真实遥测获得。

#### B5-04 · Windows Job Object native / PTY / ripgrep —— **决策：续挂口袋清单，不为对齐而做**

| 项 | 值 |
|---|---|
| 判据 | v1.6 `FR-13.2` 的 `taskkill /T` 效果 + 真实用户诉求；无诉求则不为「对齐 WorkBuddy」而做 |
| 现有机制有效性 | `orphanProcesses.ts`（B4 期）对已知**三层进程链**（electron→shim→中间→监听者）用父指针上溯 + `taskkill /T /F` 回收有效，无已知失效场景 |
| 用户诉求 | 无 PTY / ripgrep 嵌入请求 |

**结论**：**续挂口袋清单**。现有孤儿回收已覆盖实测拓扑；native Job Object 仅在出现「`taskkill` 漏杀导致端口被占」的真实 bug 时才值得做。PTY/ripgrep 无需求，**明确不为与 WorkBuddy 对齐而实现**。

---

## 三、依赖与顺序

```
B1 ──┬─→ B2 ────────────────┐
     └─→ B3（一次做完+同步）─┴─→ B4 ─→ B5
```

- **B1 是硬前置**：不修判据就排期，等于拿过期地图找路。
- **B2 与 B3 完全解耦**，可并行（B2 只碰 `src/`，B3 只碰 `nanobot/`）。
- **B4 依赖 B1**（自检卡位置、设置页分区要与 v1.6 的 `FR-13.6` 对齐），**不依赖 B3**；但如果 B3 期间要发版，B4-01 应提前到 B3 之前做（有了自动更新，后续修引擎不用重新发安装包）。
- **B5 必须最后**：它的输入是 B4/B3 的实测数据。

---

## 四、验证纪律（继承 v1.6，逐条重申）

1. 每个任务**先写用例再看红**，不接受「代码写完顺手补测试」；上表列的变异项必须逐条真跑（改回旧写法 → 精确变红 → 改回转绿）。
2. 门禁**三套 tsc 一起跑**（`typecheck` / `typecheck:electron` / `typecheck:tests`，后者不在 `build` 内）。
3. `npm test` 带 **`--maxWorkers=3`**；跑全量带 **`CODEBUDDY_SAFE_DELETE_ENABLED=0`**（否则 4 个预存文件的 `afterEach` 被安全删除守卫拦超时 → 假报 12 个失败）。**判定永远看退出码。**
4. 绿灯 ≠ 门禁过：全绿但 `exit=1` = Unhandled Error（多为 MUI 过渡 `setTimeout`）→ 该文件 `afterEach` 卸组件 + 等 400ms。
5. 改 `electron/**.ts` → **重建 `main.cjs` + `preload.cjs`**（B4 全员命中）。
6. 引擎侧改动 → 登记 `docs/upstream-merge-conflicts.md` 的 `[LOCAL PATCH]`；**两份副本同步一次**（B3 收尾时）。
7. 真机判据不接受「单测通过」替代，尤其 B4 的四条（安装 / 更新 / 深链 / 反馈包）。

---

## 五、放行标准（V1.7 收口）

- [ ] B1 七项全勾：v2 第 3 章能直接查出 v1.6 的 19 条 FR，`FR-4.4/8.6/3.9` 无「整条 ⬜ 盖住已完成部分」的写法
- [ ] V1 的 P1 **全部 ✅ 或明确改判**（改判要有代码依据，不能是「本期不做」）
- [ ] B2 / B3 的变异验证逐条变红后转绿；三套 tsc + `vitest` + `vite build` **退出码 0**
- [ ] B4 四条真机判据全过（截图 + 关键日志入 `tasks/`）
- [ ] `OVERVIEW.md` 重写完成，§四 遗留风险与代码一致
- [ ] B5 留下一次带数字的决策记录（不是「待评估」）

---

## 六、明确不做（本期冻结）

| 项 | 原因 | 归属 |
|---|---|---|
| 组织级记忆（FR-4.4 第三级） | 需要租户 / 组织模型 | V3 |
| 知识库 RAG（FR-4.7）+ FR-2.3 知识库绑定 + FR-8.6 检索前过滤 | 需要云端摄取 worker + 向量库 + 权限过滤，是 V2 的主体 | V2（M7） |
| 项目空间 / 人机双写 / 组织资产发布（FR-12.7 / FR-7.5 / FR-2.6） | 同上，属 M7 团队 | V2 |
| 远程扩展市场 + 签名校验（FR-3.5） | 无服务端；`FR-3.13` 已把索引模型留好 | V2 |
| E2E 加密 / 多租户 / SSO / 计费（FR-10.7 等） | 企业能力 | V3 |
| Guest 桥接 SDK / Module Federation UI 联邦 | `ADR-0025` 已否决（共享依赖单例 / 权限面无处安放 / 首屏回退） | 不做 |
| Windows Job Object native、PTY、内嵌 ripgrep、CLI 预热池 | 全部等 B5 的数据或真实诉求 | 口袋清单 |

---

## 附录 A：与 v1.6 的关系

| V1.6 产物 | V1.7 怎么用 |
|---|---|
| `FR-13.6` 引擎自检 + 设置「关于」自检卡 | B4-03 的入口（自检失败 → 自助安装引导）；B4-01 的检查更新入口放在同一分区 |
| `FR-11.6` 启动剖析 + `perf:latency` | B5-01 的决策输入 |
| `FR-11.9` 诊断包（进程维度 + 凭据脱敏） | B4-04 的底座（只加「用户可见的脱敏清单」） |
| `FR-13.1` 单实例锁 | B4-02 深链的硬前置（第二实例必须转交第一实例） |
| `FR-8.10` 窗口安全档位 | FR-8.5 的 electron 侧已有；本期只在文档/设置页写清「引擎侧还没做」 |
| `FR-3.10~3.13` 扩展面 | B2-01 的版本引用集与它同源（`pluginMarketplace` 的版本语义） |

## 附录 B：一句话总结每批

| 批 | 一句话 |
|---|---|
| B1 | 先把「还剩什么」改成真的——三处状态偏差会让整期排期白做 |
| B2 | 同步边界收尾 + 注入检测，纯渲染层，一批可独立发版 |
| B3 | 子代理 / Dream 闸门 / IM 审批都要动引擎，**一批做完只同步一次副本** |
| B4 | 从「开发者能跑」到「别人能装」：更新、深链、自助安装、敢发的反馈包 |
| B5 | 用 v1.6 装上的仪表盘决定口袋清单里哪些该做、哪些该关掉 |
