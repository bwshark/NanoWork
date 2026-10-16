# nanowork V1.6 升级需求与开发计划

> **版本代号**：V1.6「运行期工程加固」（Runtime Hardening）  
> **文档性质**：增量文档（需求 + 计划合一）。收口目标 —— 需求并入 `nanowork-prd-design-v2.md` 第 3 章对应域（R3 / R8 / R11 / 新增 R13），计划并入第 6 章里程碑。  
> **需求来源**：`docs/analysis-workbuddy-builtin-plugins.md`、`docs/analysis-workbuddy-platform-capabilities.md`、`docs/analysis-workbuddy-rea-deep-dive.md`（三轮 WorkBuddy 逆向分析）。  
> **口径**：本文所有「现状」均为**代码实测**（带 `file:line`），不采信文档描述；与代码冲突时以代码为准（对齐文档治理约定第 4 条）。  
> **版本日期**：2026-10-16



---

## 〇、TL;DR

WorkBuddy 三轮逆向共给出 **51 条候选**（插件机制 12 条 / 平台能力 15 条 / 运行期工程 24 条）。本文把它们**去重、收敛、按域编号**，形成 **24 条正式需求**，并分为 **8 个批次 + 1 个 ADR 立项**。

**核心判断**：本项目在「功能面」上并不落后（Skill / Plugin / Expert / Hook / 产物 / 记忆 / 同步都有），落后的是 **运行期工程**——具体是三件事：

| # | 类别           | 一句话                                                                   | 典型证据                                                                                                |
| - | ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1 | **事故止血**     | 双开互杀、崩溃留孤儿占端口、端口释放超时后盲启动                                              | `main.ts` 内 `process.on(` 零命中；`waitForPortFree` 返回值被丢弃后仍 `startNanobot()`（`main.ts:2008/2306/4457`） |
| 2 | **安全纵深**     | 危险开关是「全局默认开」而非「按角色领取」；主进程删除是裸 `fs.rm`                                 | `main.ts:557-560` `webSecurity:false` 全局生效；全仓 `shell.trashItem` 零命中                                 |
| 3 | **可观测与存储卫生** | 启动/首字延迟无埋点；`llm_usage.sqlite3-wal` 4.13 MB vs 主库 143 KB 从未 checkpoint | 全仓 `performance.mark` 零命中；TTFT 采集率 0/1148                                                           |

外加一条**结构性**缺口（唯一需要 ADR 的）：**插件清单的读者只有 2 个（`skills` / `mcpServers`），而 WorkBuddy 有 6 个**；插件无法提供 prompt 片段、无法声明子代理/命令/工具策略。

**放行门槛**：8 个批次中，批次 1–2 为 **P0（必须）**，批次 3–6 为 **P1（本期）**，批次 7 为 **P1（可并行）**，批次 8 为 **ADR 立项（不承诺本期交付）**。

### 落地进度（滚动更新）

| 批次 | 状态 | 日期 | 证据 |
|---|---|---|---|
| **B1 事故止血** | ✅ **已落地** | 2026-10-16 | 19 条新单测 + 4 项变异验证全红后转绿；三套 tsc 0 错误；`vitest` 213 文件 3218 用例全绿；`vite build` 绿；`main.cjs`/`preload.cjs` 已重建；真机一轮 12 项全绿 + **旧行为前后对比**（还原旧写法后「退出后端口 18900 已释放」FAIL） |
| **B2 卫生与诊断** | 🟡 **4/5 项落地，B2-02 前提被实测推翻而不做** | 2026-10-16 | 新增 57 条单测 + 4 项变异验证；三套 tsc 0 错误；`vitest` **215 文件 3258 用例全绿**；`vite build` 绿；cjs 已重建。真机：`run/` 三份僵尸全部判为 `stale-dead-pid` 并清除；端口→占用者 pid 链路实测通过。**B2-02 见下方专列** |
| **B3 安全纵深** | ✅ **已落地** | 2026-10-16 | 新增 `windowPreferences.ts`(12 单测+变异红后转绿) / `safeDelete.ts`(5 单测+fail-closed 变异) / `artifactCsp.ts`(4 单测+connect-src 变异) / `iframe-csp.d.ts`；`main.ts` 走 `createWindowPreferences`(主窗口 `sandbox:true` + 显式认领 `webSecurity:false`，notes 落 warn)；`eventStore`/`pluginPackage` 删除改 `safeDelete`(FR-8.11)；`ArtifactRenderer`/`WebTabView` 仅 docMode 套 CSP(FR-8.12)。三套 tsc 0 错误；`vitest` **218 文件 3279 用例全绿 exit=0**；`vite build` 绿；cjs 已重建。V-1(sandbox+preload 兼容)通过、V-2(引擎无 CORS→主窗口显式认领 webSecurity:false 保留)落定 |
| B4–B8 | ⬜ 未开工 | — | — |

> **⚠️ B2-02（SQLite WAL checkpoint worker）本期不做——原前提被实测推翻。**
> 分析时的证据是「`llm_usage.sqlite3-wal` 4.13 MB vs 主库 143 KB（≈29:1），从未 checkpoint」。
> 复核发现这是**误读**：
> ① 4.13 MB ≈ 恰好 1000 页 × 4096 B = SQLite 默认 `wal_autocheckpoint` 阈值，而引擎
> （`llm_usage/store.py:189-192`）只设了 `journal_mode=WAL`，**没有关** autocheckpoint；
> ② autocheckpoint 走的是 PASSIVE——会把 WAL 内容写回主库但**不截断文件**，所以文件
>   大小停在历史高水位是**正常行为**，不是「从不 checkpoint」；
> ③ 现在实测 WAL 只有 **52 KB**（主库 180 KB）：干净关闭最后一个连接时 SQLite 会
>   checkpoint 并删掉 WAL，之后重新长；
> ④ 引擎的 `_read_connection()` 有正确的 `finally: connection.close()`，**没有泄漏的读快照**
>   去阻塞 checkpoint。
> **结论**：WAL 行为正常，做一个跨进程 checkpoint worker 是给不存在的问题加复杂度，
> 还会与写入者（Python 引擎）争锁。且 `better-sqlite3` 本机未安装、Electron 37 的
> `node:sqlite` 不可用——原「选项 A」需要新增原生依赖。**建议改为**：若仍想在诊断包里
> 看见库体积，就在 `processes.json` 里加一项 sqlite 文件尺寸（只读，无争锁），
> 需要时再立项；要真做 checkpoint 应改引擎侧（写入者），但那需要引擎契约变更。
>
> B1 的完整落地记录（文件清单、真机判据、踩到的环境坑）见 §四 批次明细与 `tasks/verify-b1-process-lifecycle.mjs` 头注释。

---

## 一、版本定位与范围

### 1.1 为什么是 V1.6，而不是 V2

| 阶段           | 内容                           | 状态                         |
| ------------ | ---------------------------- | -------------------------- |
| V1           | 工作台成型（M1–M5）                 | 未整体收口（M3 4/6、M4 已闭合、M5 部分） |
| V1.5         | 多端同步（M6）                     | ✅ 已闭合（2026-10-04 核实）       |
| **V1.6（本文）** | **运行期工程加固 + 扩展面补强**          | 本期                         |
| V2           | 团队（M7：项目空间 / 知识库 RAG / 人机双写） | 未开工                        |
| V3           | 企业（M8）                       | 未开工                        |

**定在 V1.6 的理由**：本文 24 条需求**没有一条是新业务能力**，全是对既有能力的**加固与补齐**；它们不改变数据模型、不改变引擎契约（仅 1 条需引擎 `[LOCAL PATCH]`），因此不构成一个新的大版本。但**它们不做的代价随用户量线性放大**（双开 → 数据/连接损坏；无埋点 → 性能问题不可诊断），所以必须在 V2 开工前结清。

### 1.2 三条泳道

```
泳道 A｜运行期止血      —— 不做就会真的坏（双开 / 孤儿 / EADDRINUSE）
泳道 B｜安全纵深        —— 现在只有一个单点（应用层审批），缺纵深
泳道 C｜可观测与存储卫生 —— 现在的问题是「不知道慢在哪、库在涨」
泳道 D｜扩展面          —— 唯一的结构性缺口（与 A/B/C 完全解耦，可并行）
```

### 1.3 需求编号规则与落位

遵循文档治理约定第 3 条（`FR-<域>.<序>`），**不新造编号体系**，只做两件事：

1. **向既有域追加**：R3 扩展生态 → `FR-3.10~3.14`；R8 安全 → `FR-8.10~8.13`；R11 可观测 → `FR-11.6~11.9`。
2. **新增一个域**：**R13 运行期健壮性与交付** → `FR-13.1~13.6`（理由：单实例锁、进程树治理、首屏体积、运行时自检这类关注点在 R1–R12 里没有归属——R8 是安全、R11 是可观测，都不是「进程与交付的生命周期」）。

| 域                     | 现有编号上限  | 本期新增             | 主题                                           |
| --------------------- | ------- | ---------------- | -------------------------------------------- |
| R3 扩展生态               | FR-3.9  | **FR-3.10~3.14** | 插件 prompt 片段 / 清单读取器 / 工具策略 / 市场索引 / 扩展运行时   |
| R8 安全、权限与沙箱           | FR-8.9  | **FR-8.10~8.13** | 窗口安全档位 / 应用数据删除回收站化 / 预览隔离与 CSP / 路径级规则      |
| R11 可观测性与成本           | FR-11.5 | **FR-11.6~11.9** | 启动剖析 / 埋点与报告 / 存储卫生 / 诊断包增强                  |
| **R13 运行期健壮性与交付（新增）** | —       | **FR-13.1~13.6** | 单实例 / 进程生命周期 / 网关重启入口 / 运行态残留 / 首屏体积 / 运行时自检 |

### 1.4 与既有 FR 的关系（不重复造轮子）

| 本期新增              | 与既有条目的关系                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-8.10 窗口安全档位    | **细化 FR-8.5（沙箱执行，P1 🟡）的 electron 侧**：FR-8.5 讲「执行类任务进受限上下文」，本条约的是「Electron 窗口自身的 webPreferences 档位」——前者是引擎沙箱，后者是外壳安全，二者正交，本条约完成后 FR-8.5 仍只完成一半（引擎侧 Windows 沙箱仍缺） |
| FR-11.6 / FR-11.7 | **补齐 FR-11.2（全链路 trace）缺的前半段**：FR-11.2 是「单次请求 trace」（回合级），本期是「进程级启动与延迟分段」——trace 回答「这一步调了什么」，剖析回答「这 9.4 秒花在哪」                                                    |
| FR-11.8 存储卫生      | 无既有条目，全新                                                                                                                                                         |
| FR-13.5 首屏体积      | 对应第 5 章非功能需求「性能」行的**可测化**（原文只写「会话列表 1000 条内渲染 ≤ 200ms」，无首屏指标）                                                                                                    |
| FR-3.10~3.14      | **FR-3.4（Plugin 形态）已声明** `prompt/` `commands/` `agents/` 目录，但**引擎侧从未读取**（见 §2.1 实测）——本期是把「声明了但没读」变成「真读」                                                          |

### 1.5 明确不做（本期冻结）

| 项                                                                                             | 原因                                                             | 来源              |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------- |
| 插件带 UI 资产（iframe / MCP App）                                                                   | 渲染层无 iframe 沙箱体系，引入 = 开 XSS 面                                  | 分析① P5          |
| 跨进程 shell hook + `${PLUGIN_ROOT}` 拼命令                                                         | 本项目引擎是 Python **进程内** hook，已优于 WorkBuddy 的跨进程方案                | 分析① P4          |
| `welcomemode/*/prompt.tpl` 整棵 Jinja 模板树                                                       | 本项目已有「引擎模板 + 渲染层槽位」双轨，再加一棵变三轨混乱                                | 分析① §四          |
| OS 级沙箱（tsbx 规则系统整体移植）                                                                         | tsbx 为腾讯会话体系设计，体量与定位不匹配；引擎侧 Linux bwrap 已存在                    | 分析② §2.2、分析③ §五 |
| Windows Job Object **native binding 本身**                                                      | 引擎是 Python 不是 Node；先用 `taskkill /T` + await 兜底（见 FR-13.2 的降级档） | 分析③ §五          |
| 设备指纹 / 风控 / 内核驱动 / UAC 提权 / 微信 `WM_COPYDATA` / 企微原生 SDK / 分享目标 msix / Module Federation UI 联邦 | 为腾讯生态与企业分发服务，与「本地优先的个人 agent 客户端」无关                            | 分析② §三          |
| 14 个 IM 渠道集成模块 / `tencent-docs-*` / `office-*`                                                | 同上                                                             | 分析③ §五          |
| 1.94 MB `log-acl-guard.js` 整体移植                                                               | 体量过大、用途未验证；只借「日志出口必经凭据过滤」这个**位置**                              | 分析③ J3          |
| `.codebuddy-plugin` / `.workbuddy-plugin` 双前缀兼容                                               | 那是改名期技术债，不是设计                                                  | 分析① §四          |

---

## 二、需求清单

> 每条格式：**ID / 名称 / 优先级 / 来源 / 现状（实测） / 需求 / 验收标准（DoD） / 落点 / 前置与风险**  
> 优先级：**P0** 事故/数据风险，必须最先做；**P1** 本期承诺；**P2** 按需。

### 2.1 R13 运行期健壮性与交付（新增域）

#### FR-13.1 单实例与二次唤起

| 项     | 内容                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | **P0**                                                                                                                                             |
| 来源    | 分析② B2、分析③ C3-b                                                                                                                                    |
| 现状    | 全仓 `requestSingleInstanceLock` **零命中**。双开 → 第二实例走「复用端口」分支（`main.ts:837-851`）→ 两窗口共用同一引擎 → **第二实例退出时 `taskkill` 掉它以为是自己拉起的进程 → 第一个实例瞬间失连**          |
| 需求    | ① `app.whenReady()` 之前获取单实例锁，抢锁失败即退出；② `second-instance` 事件中还原并聚焦既有窗口（若最小化/隐藏到托盘则先 show）；③ 锁的释放与 `before-quit` 的 `isQuitting` 置位保持同序               |
| 验收标准  | ① 连续启动两次：第二个进程退出码为 0 且不产生新窗口、不 spawn 新引擎；② 第二个实例启动时，第一个窗口被 focus（可用 `BrowserWindow.isFocused()` 断言）；③ 单测覆盖「抢锁失败 → 不进入 startNanobot」这条路径（可用可注入的锁替身） |
| 落点    | `electron/main.ts`（`app.whenReady()` 之前，约 4550 行前）；新增分支不放进既有 `if` 链                                                                                |
| 前置/风险 | 低。唯一注意：`window-all-closed` 在非 darwin 会 `app.quit()`，托盘隐藏场景要确认锁不会被误释放                                                                               |

#### FR-13.2 进程生命周期与孤儿清理

| 项     | 内容                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | **P0**                                                                                                                                                                                                                                                                                                                                                                |
| 来源    | 分析③ C3-a / C3-f                                                                                                                                                                                                                                                                                                                                                       |
| 现状    | ① `main.ts` 内 `process.on('uncaughtException' / 'SIGINT' / 'SIGTERM')` **零命中**，`will-quit` 不存在；② `before-quit`（`main.ts:4567`）里同步调 `stopNanobot()`，而 `stopNanobot` 内部 `spawn('taskkill', …, {stdio:'ignore'})`（`main.ts:917`）**不 await**（该函数签名也不是 async）→ 进程可能在 taskkill 生效前就退出；③ `shell:true` 使 nanobot 成为 `cmd` 的**孙进程**（`main.ts:866-879` / `961-975`），只杀直接子进程杀不干净 |
| 需求    | ① 补 `uncaughtException` / `SIGINT` / `SIGTERM` 三个钩子，统一走一个 `cleanupChildProcesses()`；② `before-quit` 改为**同步等待**清理完成（`event.preventDefault()` + 异步清理 + 完成后再 `app.exit()`，或改 `will-quit` 并 await 一个 Promise 链）；③ 子进程 spawn 时加 `detached:false` + `windowsHide:true`，并把「进程树清理」抽成可测函数；④ **降级档**：确认上述措施不足时，再评估 Job Object（需 native binding）；**不默认引入**                       |
| 验收标准  | ① 真机：任务管理器中强制结束主进程 → 5 秒内 `nanobot serve` 进程树消失、端口 18900/18790 可立即重绑；② 单测覆盖「cleanup 被调用且 kill 参数含 `/T`」；③ 变异验证：把 `await` 去掉 → 用例必须变红                                                                                                                                                                                                                                  |
| 落点    | `electron/main.ts`（进程清理函数 910-980 区间 + `before-quit` 4567）；建议抽出 `electron/childProcesses.ts` 以便单测                                                                                                                                                                                                                                                                     |
| 前置/风险 | 中。`before-quit` 的时序改动会影响托盘退出 / Cmd+Q / 安装器重启三条路径，需回归；`will-quit` 与 `before-quit` 二选一，不要两处都防                                                                                                                                                                                                                                                                           |

#### FR-13.3 网关重启统一入口与端口释放超时短路

| 项     | 内容                                                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | **P0**（含**真 bug**）                                                                                                                                                                                                                       |
| 来源    | 分析③ C3-c                                                                                                                                                                                                                                 |
| 现状    | 「`stop` → `waitForPortFree` → `start`」三处复制粘贴：`main.ts:2008`（MCP 配置）、`2306`（模型配置）、`4457`（技能覆盖）。**三处都丢弃了 `waitForPortFree` 的返回值**，超时后仍然 `startNanobot()` → 必然 `EADDRINUSE`。`waitForPortFree` 定义在 `main.ts:994`，本身返回 `boolean`（写法正确，是调用点没用） |
| 需求    | ① 抽 `restartServe(): Promise<{ok:boolean; message:string}>`，三处调用点替换；② 端口未释放时**短路报错并给出人话原因**（沿用现有 `{ok:false,message}` 返回约定，触发点是设置页 toast），**绝不盲启动**；③ 是否顺带把 `waitForPortFree` 的 5s 超时改成可配（建议保持 5s，但把超时事件写入日志）                            |
| 验收标准  | ① 单测：模拟端口恒占用 → `restartServe()` 返回 `ok:false` 且**未调用** `startNanobot`；② 变异验证：把「超时短路」改回「无视返回值」→ 用例必须变红；③ 三处调用点行为一致（同一函数）；④ 真机：占用 18900 后改 MCP 配置 → 得到明确错误提示而非静默失败                                                                         |
| 落点    | `electron/main.ts:994`（保留）、`2008` / `2306` / `4457`（替换为调用）                                                                                                                                                                               |
| 前置/风险 | 低。注意三处的错误文案不同（MCP / 模型 / 技能），抽取后要保留各自可区分的 message                                                                                                                                                                                        |

#### FR-13.4 运行态残留清理（僵尸状态文件）

| 项     | 内容                                                                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | **P0**                                                                                                                                                                                                                                                                                          |
| 来源    | 分析③ C3-d                                                                                                                                                                                                                                                                                        |
| 现状    | ✅ **已落地（2026-10-16）**。原状：`run/gateway.{2643f60c,c2eaae52,4e20da55}.json` 三份堆积，其中一份的 `config_path` 指向**另一个项目**，无人回收。引擎侧有完整 lease/supervisor（`nanobot/nanobot/gateway/runtime.py:509-518` + `_live_state()` 的 PID 裁剪），但 **Electron 侧从不 acquire**——`spawn('gateway --foreground')` 绕过整套引用计数 |
| 需求（已实现） | ① 启动时扫 `run/gateway.*.json`，五档判据：解析失败 → pid 缺失 → pid 已死 → config 指纹不属当前项目 → live；② 文件名精确匹配 `^gateway(\.[0-9a-f]{6,64})?\.json$`，**排除 `.clients.json` 与两把 `.lock`**（那是引擎 lease 的现场，删了会破坏引用计数）；③ 清理动作写运行日志；④ **fail-open**：清理失败不阻塞启动（这是卫生问题不是安全问题）；⑤ **只删文件，从不杀进程**——看到活 pid 就 taskkill 是替用户做决定，那可能是用户自己手动拉起的网关 |
| 验收标准  | ① 单测：死 pid 被清、活 pid 且 config 匹配保留、指向他项目 config 的状态文件被清、删失败如实记 `failed` 且不抛、目录不存在不抛；② 真机：`run/` 三份僵尸全部判为 `stale-dead-pid` 并清除、目录已空；③ `EPERM` 保守判活（误判活的代价只是多留一个文件，误判死会删掉别人正在用的状态） |
| 落点    | 新增 `electron/gatewayRuntimeState.ts`；`main.ts` 的 `sweepGatewayRuntimeState()` 在 `app.whenReady()` 中、**拉起引擎之前** await（成本只是几次 readdir+readFile，不值得为它异步） |
| 前置/风险 | 低。`run/` 是 `<config 所在目录>/run`（非用户资产），走普通 `fs.unlink`；**不**走 FR-8.11 的 `safeDelete`——那个是给用户资产用的回收站通道 |

#### FR-13.5 首屏体积治理

| 项     | 内容                                                                                                                                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | **P1**                                                                                                                                                                                                                                         |
| 来源    | 分析③ C4                                                                                                                                                                                                                                         |
| 现状    | ① `src/router/index.tsx:1-14` 约 10 个页面**全部静态 import**；② 全仓 `React.lazy` 零命中（唯一真动态 import 是 `ArtifactRenderer.tsx:120-129` 的 mermaid）；③ `manualChunks` 只赚 HTTP 缓存粒度，`dist/index.html` 里 `markdown`（790 KB）仍被 `modulepreload` → **首屏 2.27 MB**   |
| 需求    | ① 路由级 `React.lazy` + `Suspense` 边界（带可见 fallback，避免白屏）；② 把 `markdown` 分包从 `modulepreload` 挪到按需（照 mermaid 现成写法）；③ 保留 `App` / `AppLayout` 为静态（它们是所有路由的壳，懒加载无收益）                                                                                   |
| 验收标准  | ① `dist/index.html` 中 `modulepreload` 的目标总量 **≤ 1.2 MB**（当前 2.27 MB，最大一块是 `matrix:markdown` 790 KB）；② 每个路由首次进入仍可正常渲染（真机脚本逐页访问）；③ 无白屏：`Suspense` fallback 已在慢网络下可见（可用 devtools throttling 目视）；④ **不做**「假懒加载」——若某 chunk 仍被 `modulepreload`，视为未完成 |
| 落点    | `src/router/index.tsx`、`vite.config.ts`（`build.rollupOptions.output.manualChunks`）                                                                                                                                                             |
| 前置/风险 | 中。⚠️ 真机验证铁律第 3 条：**dev server 与 `vite build` 不要并发**；改 `@mui/icons-material` 类依赖重优化前先 `mv node_modules/.vite/deps_temp_* /tmp`                                                                                                                  |

#### FR-13.6 引擎运行时自检与引导

| 项     | 内容                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | **P1**                                                                                                                                                                                                                                        |
| 来源    | 分析② B8、分析③ J5（`self-check.js` / `memory-check.js` 登记项）                                                                                                                                                                                        |
| 现状    | 无随包运行时（引擎要用户自建 venv）。`main.ts` 的 `fallbackLaunchConfig()` 在全部候选路径失败后**没有「全失败」分支**——「装不上 / 找不到引擎」是黑盒                                                                                                                                           |
| 需求    | ① 启动期对引擎做三项自检：**解释器可达**（venv python 存在且可执行）、**引擎包可导入**（`python -c "import nanobot"`）、**配置可加载**（`nanowork.config.json` 通过引擎 schema 校验）；② 任一项失败 → 渲染层给出**分步可操作引导**（含真实命令、真实报错原文、文档链接），而不是笼统 toast；③ **不打包 CPython**（明确不做，见 §1.5），只把「装不上」从黑盒变可操作 |
| 验收标准  | ① 把 venv 改名 → 启动后出现「解释器不可达」引导且**文案含实际查找过的路径**；② 单测：三项自检各自有独立的失败用例（禁止合并成「自检失败」一个布尔）；③ 自检本身不得阻塞窗口显示（与窗口可见性解耦）                                                                                                                                   |
| 落点    | `electron/main.ts` 的 `fallbackLaunchConfig()` / 启动链路；新增 `electron/engineSelfCheck.ts`；渲染层新增引导视图（可复用设置页「关于」分区）                                                                                                                                 |
| 前置/风险 | 中。自检要跑 Python 子进程，注意**不要在渲染期同步等待**（会拖长首屏）；建议在窗口显示后异步跑                                                                                                                                                                                         |

### 2.2 R3 扩展生态（追加）

> 本组 5 条的**共同前提**：`nanobot/agent/plugins.py` 的清单解析面目前只认 `$schema` / `name` / `description` / `repository` / `extensions['dev.nanobot']` / `mcpServers`，技能走**目录约定**（扫包内 `skills/`）而非 manifest 声明。扩展的本质是「把声明了但没读的字段真读起来」。

#### FR-3.10 插件可提供 prompt 片段（★结构性）

| 项     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | **P1（本组最高）**                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 来源    | 分析① P0 / G1                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 现状    | 插件**不能提供 prompt 片段**。`promptCatalog` 的槽位是渲染层硬编码常量；引擎侧 `nanobot/utils/prompt_templates.py` 是**单个 `FileSystemLoader` + `OVERRIDABLE_TEMPLATES` 白名单覆盖**。后果：第三方无法在不改引擎代码的前提下注入领域规程                                                                                                                                                                                                                                                                                                    |
| 需求    | ① `plugins.py` 的 `AgentPlugin` 加 `prompts` 字段（与 `skills` 同形：string | string[]，指向包内目录）；② 把 `SkillsLoader` 已有的「已启用插件 → 包根」映射（`enabled_agent_plugin_skill_dirs`）**提升为按插件 `name` 索引的挂载表**，服务全部文本资产而不只 skills；③ `prompt_templates.py` 的单 loader → **ChainLoader**：`① 插件虚拟命名空间 > ② 工作区覆盖 > ③ 引擎内置`；④ **信任分级（必做，否则是安全洞）**：`builtin` / `trusted` 直注，`user` 档片段包 `<untrusted_content>`（引擎已有 `_snippets/untrusted_content.md` 可复用）；⑤ 变量上下文复用现有 `render_template(name, context)`，**不另建变量体系** |
| 验收标准  | ① demo 插件的 `fragments/domain.md` 经 `{% include "demo-plugin/fragments/domain.md" %}` 出现在系统提示词中（一条用例证明整链路）；② **变异验证**：去掉 ChainLoader 第一级 → 用例必须变红；③ `user` 档插件的片段在最终提示词中**确实被 `<untrusted_content>` 包裹**；④ `_package_fingerprint` 的覆盖范围已包含 `prompts` 目录（见风险 R-6，缺它是「改了不生效」）                                                                                                                                                                                                        |
| 落点    | `nanobot/agent/plugins.py`、`nanobot/utils/prompt_templates.py`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 前置/风险 | 高。⚠️ 引擎仓库只读（`nanobot/` 独立 git、对象库受损）→ 落地需人工同步，见风险 R-4。⚠️ **不要**照搬 WorkBuddy 的模板树（见 §1.5）                                                                                                                                                                                                                                                                                                                                                                                          |


#### FR-3.11 插件清单读取器统一

| 项 | 内容 |
|---|---|
| 优先级 | **P1** |
| 来源 | 分析① P1 / G2·G3·G5 |
| 现状 | manifest 不认 `agents` / `commands` / `hooks`，子代理只能由核心代码或专家团运行时构造，无斜杠命令扩展点 |
| 需求 | `AgentPlugin` dataclass 扩为：`skill_dirs` / `agent_files` / `command_files` / `prompt_dirs` / `hook_manifest` / `tool_policy`（形状见分析① §P1）。**关键纪律：所有新字段的路径必须走同一套 `_contained()` 包含性检查**（`plugins.py` 现成注释已点明「这一层是遍历防护」）；绕过它 = 给已有的防路径逃逸开后门 |
| 验收标准 | ① 每条新路径都有「越界路径被拒」的用例（含 `../` 与绝对路径两种形态）；② 字段未声明时行为与现状完全一致（向后兼容）；③ fingerprint 覆盖新目录 |
| 落点 | `nanobot/agent/plugins.py` |
| 前置/风险 | 中。与 FR-3.10 同批落地成本最低（共用挂载表） |

#### FR-3.12 声明式工具策略（只收紧）

| 项 | 内容 |
|---|---|
| 优先级 | **P1** |
| 来源 | 分析① P2 / G5 |
| 现状 | 无插件级声明式工具白名单；工具策略散在 `toolsPolicyStore.ts` + 引擎 hook |
| 需求 | 在**技能 frontmatter** 与**插件 manifest** 两处支持 `tools:` 字段（与 WorkBuddy `interaction.md` frontmatter 同形），装配时叠加为 ToolPolicy。落点照 `nanobot/agent/hooks/agent_tools.py`（FR-2.2 的成熟实现）的形状加 `plugin_tools.py`，挂进 `turn_hooks.py` 的 `build_agent_turn_hook` 基线链 |
| 验收标准 | ① 插件/技能声明 `tools:` 后，未列出的工具被拦；② **白名单只能收紧不能放宽**——基线链里的审批门必须是「交集」语义，即插件无法用 `tools:` 把审批门顶掉（**用例：声明 `tools: [shell]` 不得使 `shell` 绕过审批**）；③ 变异验证：把交集改成并集 → 用例变红 |
| 落点 | `nanobot/agent/hooks/plugin_tools.py`（新增）、`turn_hooks.py` |
| 前置/风险 | 中。这是**安全语义**，必须与 FR-8.2 的工具网关语义对齐后再动 |

#### FR-3.13 市场索引文件与依赖解析

| 项 | 内容 |
|---|---|
| 优先级 | **P2** |
| 来源 | 分析① P3 / G6 |
| 现状 | `electron/pluginMarketplace.ts` 靠**目录扫描**；拿不到 `dependencies` / `category` 这类市场级语义 |
| 需求 | 加**可选**的 `marketplace.json`（`{name, plugins:[{name, source, category, dependencies[]}]}`）。带来 `dependencies` 解析（WorkBuddy 的 `welcomemode-design → [mcp-miora, ardot]` 就是这么表达的）。**没有索引文件时回退目录扫描**，保持向后兼容 |
| 验收标准 | ① 有索引 → 依赖被解析且拓扑排序后安装；② 无索引 → 行为与现状一致（回归用例）；③ 循环依赖被明确拒绝并给出人话原因 |
| 落点 | `electron/pluginMarketplace.ts`、`electron/pluginPackage.ts` |
| 前置/风险 | 低。**不建议**抄 WorkBuddy「所有插件共用一个版本串」（那是整包发版的产物）——本项目走版本化缓存 + `current` 指针，应保留**每插件独立版本** |

#### FR-3.14 应用级扩展运行时（需 ADR）

| 项 | 内容 |
|---|---|
| 优先级 | **P1（ADR）→ 实施另排** |
| 来源 | 分析② B9 / 层② |
| 现状 | PRD「四级扩展生态」只列了名字，**零实现**。WorkBuddy 的 `extensions/` 是 8 个 **fork 独立 Node 进程** + `distribution.json`，入口经 `main/preload/fork-preload.cjs` → `runExtension({extensionId, env, activate})` |
| 需求 | **先出 ADR**（`docs/adr/`），明确四件事：① 扩展的进程模型（fork 子进程，**不抄 Module Federation**）；② 权限面（扩展能拿到什么 API，如何声明）；③ 生命周期（activate / deactivate / 崩溃重启）；④ 与插件的分工（插件给 agent 加能力，扩展给应用加功能——**两套机制不要混**）。ADR 通过后再实施 |
| 验收标准 | **ADR 通过即视为本批次完成**（本期不承诺实现）。ADR 必须含「为什么抄进程隔离、不抄 UI 联邦」与「不做 Guest 桥接 SDK 的理由」（后者只在做第三方 UI 扩展时才需要） |
| 落点 | `docs/adr/ADR-00xx.md`（新增） |
| 前置/风险 | 高。这是**唯一需要先设计的**条目——不要跳过 ADR 直接写代码 |

### 2.3 R8 安全、权限与沙箱（追加）

#### FR-8.10 窗口安全档位表与 webSecurity 分流

| 项 | 内容 |
|---|---|
| 优先级 | **P1（本组最高）** |
| 来源 | 分析③ C1 |
| 现状 | `main.ts:557-560`：`contextIsolation:true` / `nodeIntegration:false` **对了**，但 **`webSecurity:false` 全局生效且未设 `sandbox`**；全仓 webPreferences 只此一处，注释理由是「`file://` 访问本地网关」。对照 WorkBuddy：`webPreferences` 按**窗口角色查表**，全表仅 `image-decoder` / `splash` 关 sandbox，且 `image-decoder` 是唯一的 `webSecurity:false` **且缺 `partition` 直接 throw**——同样的危险开关，人家做成**默认拿不到** |
| 需求 | ① 新增 `electron/windowPreferences.ts`，`createWindowPreferences(kind, opts)` 按角色返回档位（`main` / `first-party` / `guest-popup` / `image-decoder` / `artifact-preview`），**危险档位缺前置条件即 throw**（照 WorkBuddy 的 `throw` 写法）；② 恢复主窗口 `webSecurity:true`——正解二选一：**方案 A（推荐）** 网关响应加 `Access-Control-Allow-Origin`（资产只在 `127.0.0.1` 监听 + `Origin` 校验）；**方案 B** 把需要跨源的窗口单独拆出用独立 `kind`；③ 主窗口补 `sandbox:true` |
| 验收标准 | ① **前置验证用例（必做）**：`sandbox:true` 下 `preload.cjs` 仍可用（**先跑一次 dev，别指望 typecheck 能发现**）；② 「`image-decoder` 缺 `partition` 必须 throw」有独立用例；③ 变异验证：把 `throw` 换成静默返回 → 用例变红；④ 真机：本地网关对话链路无回归（CORS 方案落地后） |
| 落点 | 新增 `electron/windowPreferences.ts`；改 `electron/main.ts:557-560` 与全部 `new BrowserWindow` 调用点；`electron/builder.config.json`（如需 `protocols`） |
| 前置/风险 | **最大的一条风险**：`sandbox:true` 会让 preload 只能访问受限 API 集，若 `preload.cjs` 用了 Node 内置模块会**直接崩**。**前置验证不通过则本批次只做「webSecurity 分流 + 档位表骨架」，不动 sandbox** |

#### FR-8.11 应用数据删除统一走回收站（fail-closed 不降级）

| 项 | 内容 |
|---|---|
| 优先级 | **P1** |
| 来源 | 分析② B4 |
| 现状 | 引擎侧删除做得**比 WorkBuddy 还细**（`security/trash.py` 走 `SHFileOperationW`，fail-closed 抛 `TrashUnavailableError` 绝不降级），但 **Electron 主进程自身删除是裸 `fs.rm`**（`eventStore.ts` / `pluginPackage.ts` / `main.ts`），全仓 **`shell.trashItem` 零命中**；`logStore.ts` 注释明说刻意规避批量守卫 → 客户端这半边完全没设防 |
| 需求 | 新增 `electron/safeDelete.ts` 封装 `shell.trashItem`：① **失败不降级**（抛错而非 `fs.rm` 兜底）；② 提供 `safeDelete(path)` / `safeDeleteMany(paths)`，后者按阈值走批量语义；③ 替换全部裸 `fs.rm` 调用点；④ 明确区分**用户资产**（必须回收站）与**运行时缓存**（可直删，但必须显式标注 `runtime: true` 并写日志）——**这个区分要在 API 层强制**，不靠调用方自觉 |
| 验收标准 | ① 单测：`shell.trashItem` 抛错 → 调用点**不**发生真删且错误向上抛；② 变异验证：加一行「失败则 `fs.rm`」→ 用例变红；③ 全仓 `fs.rm` 剩余调用点每一处都有显式 `runtime: true` 或已迁移；④ 真机：删除一个会话 → 文件出现在系统回收站 |
| 落点 | 新增 `electron/safeDelete.ts`；改 `electron/eventStore.ts` / `pluginPackage.ts` / `main.ts` / `logStore.ts` |
| 前置/风险 | 中。⚠️ 项目既有纪律「跑全量门禁要带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`」（4 个预存文件的 `afterEach` `fs.rm(recursive)` 被安全删除守卫拦截）——本条约会让这个守卫**更重要**，落地时要同步核对测试夹具是否受影响 |

#### FR-8.12 产物/外部内容预览隔离与 CSP

| 项 | 内容 |
|---|---|
| 优先级 | **P1** |
| 来源 | 分析② B3、§2.5 |
| 现状 | 产物 HTML 在 iframe 中 `allow-scripts` 且**无 CSP**（`ArtifactRenderer.tsx` / `WebTabView.tsx` 用 `srcDoc`）。WorkBuddy 的 `markdown-shared-guest.html` 有严格 CSP |
| 需求 | ① iframe 加 `csp` 属性，**至少含 `connect-src 'none'`**（堵住产物 HTML 外传数据的通道）；② 审查是否真的需要 `allow-scripts`——若产物只需静态渲染则去掉；③ 与 FR-8.10 的 `artifact-preview` 档位打通（同一处定义窗口/iframe 的安全档） |
| 验收标准 | ① 产物含 `fetch('https://evil')` 时被 CSP 拦截（真机 devtools 断言 `Refused to connect`）；② 现有产物渲染形态（html/svg/mermaid/图片/视频）全部无回归（真机脚本逐类访问）；③ 变异验证：去掉 `connect-src 'none'` → 用例变红 |
| 落点 | `src/components/artifacts/ArtifactRenderer.tsx`、Web 视图组件 |
| 前置/风险 | 中。过严的 CSP 会打断本来就依赖外链 CSS/字体的产物 → 采用「默认严 + 允许按产物声明白名单」而非一刀切 |

#### FR-8.13 路径级权限规则（glob，复合动作）

| 项 | 内容 |
|---|---|
| 优先级 | **P1（需引擎改动）** |
| 来源 | 分析② B6、§2.2 |
| 现状 | 无用户可配置路径规则；凭据名单**硬编码且不可改**，`SecuritySection.tsx` 明写「不做白名单编辑器」 |
| 需求 | 抄 WorkBuddy `tsbx_rules.json` 的**复合动作**设计：`{path, action: "read=deny|write=deny|delete=deny"}`——**读写删分别授权**，而不是一个笼统的 allow/deny。引擎 `security/` 新增规则加载器；`SecuritySection.tsx` 加编辑器（草稿 + 保存，因改配置会重启网关） |
| 验收标准 | ① 单测覆盖三种动作的**正交性**（`write=deny` 不得顺带禁读）；② 规则文件路径必须走引擎既有的包含性检查；③ 无规则文件时行为与现状完全一致（向后兼容）；④ `no_access` 凭据为**无条件**守卫，规则无法覆盖它（回归） |
| 落点 | `nanobot/nanobot/security/`（新增加载器）、`src/components/settings/sections/SecuritySection.tsx` |
| 前置/风险 | 中。**引擎仓库只读**（见风险 R-4）；且本条约与 FR-8.4（默认拒绝写入）语义相邻，落地前要先确认二者优先级顺序 |

### 2.4 R11 可观测性与成本（追加）

#### FR-11.6 启动性能剖析器

| 项 | 内容 |
|---|---|
| 优先级 | **P1** |
| 来源 | 分析③ C6、分析② B1 |
| 现状 | 全仓 `performance.mark` / `process.uptime` / `perf_hooks` **零命中**；`main.ts:799-829` 注释写着 spawn→listen 实测 **9.4 秒**，但**从不落日志** → 「9.4 秒花在哪」只能靠猜 |
| 需求 | 照 `startup-profile.cjs` 的**两个原则**：① **默认零 I/O**——只有显式开关（`NANOWORK_STARTUP_PROFILE=1`）才加载采集器；② **独立于业务模块图**——不 import store / config / logger。至少打三个点：`whenReady → 窗口可见`、`spawn → first listen`（那 9.4 秒）、`首 token` |
| 验收标准 | ① 不设开关时**零额外 IO、零额外模块加载**（可用构建产物对比 or 单测断言采集器未被 require）；② 设开关后产出分段数据（JSONL 或结构化日志）；③ 分段区间去重（若统计的是区间并集，照 `startup-profile.cjs` 的 `unionDuration()` 语义） |
| 落点 | 新增 `electron/startupProfile.ts`；`main.ts` 启动链路打点 |
| 前置/风险 | 低。**必须在 FR-13.5（首屏治理）与预热池之前做**——否则是「没数据就优化」 |

#### FR-11.7 会话性能埋点与自包含报告（含 TTFT 采集修复 ★真缺陷）

| 项 | 内容 |
|---|---|
| 优先级 | **P1**（含**真缺陷**） |
| 来源 | 分析② B1、分析③ §2.3 附 |
| 现状 | ① `llm_usage.sqlite3` **1148 条记录中 `stream=1` 与 `ttft_ms>0` 均为 0**；② `src/ai/runtime/nanobotHttp/usage.ts` 与 `src/types/usage.ts` **根本没有 `ttftMs` 字段** → TTFT 采集率 **0**，即「首字延迟 ≤ 3s」这条非功能需求**当前无法测量** |
| 需求 | ① 补 `ttftMs` / `stream` 字段（wire → 领域类型 → 落库三处同改，避免「声明了但没写」）；② 在 SSE 首字节处打点；③ 产出**自包含 HTML 报告**（抄 WorkBuddy「JSONL 落盘 + 拖拽即渲染」的形态：单文件、无外部依赖、拖进浏览器就能看） |
| 验收标准 | ① 新产生的记录中 `ttft_ms>0` 占比 > 0（真机一轮对话即可验证）；② 报告 HTML 在**断网**下可完整渲染（无 CDN 依赖）；③ 单测：SSE 首字节到首 token 的耗时计算正确（含「首字节即首 token」的边界）；④ 与 FR-11.2 的回合 trace **不重复采集**（trace 是回合级，本条是延迟级） |
| 落点 | `src/ai/runtime/nanobotHttp/usage.ts`、`src/types/usage.ts`、`nanobot/nanobot/llm_usage/store.py:295-301`（写入者）、新增 `resources/perf-report.html` |
| 前置/风险 | 中。⚠️ 写入者是 **Python 引擎**不是 Electron（`store.py:295-301`），补字段需引擎侧配合（见风险 R-4） |

#### FR-11.8 存储卫生：SQLite WAL 周期 checkpoint

| 项 | 内容 |
|---|---|
| 优先级 | **本期不做（前提被推翻）** |
| 来源 | 分析③ C2 |
| 原判据 | ~~`llm_usage.sqlite3-wal` 4.13 MB vs 主库 143 KB（≈29:1），从未 checkpoint~~ |
| **复核结论（2026-10-16）** | **原判据是误读，WAL 行为正常**：① 4.13 MB ≈ 恰好 1000 页 × 4096 B = SQLite 默认 `wal_autocheckpoint` 阈值，而引擎（`nanobot/nanobot/llm_usage/store.py:189-192`）只设 `journal_mode=WAL`，**没有关** autocheckpoint；② autocheckpoint 走 PASSIVE，会写回主库但**不截断文件**，大小停在历史高水位是正常行为；③ 现实测 WAL **52 KB** / 主库 180 KB——干净关闭最后一个连接时 SQLite 会 checkpoint 并删 WAL；④ 引擎 `_read_connection()` 有正确 `finally: connection.close()`，无泄漏读快照阻塞 checkpoint |
| 结论 | 做一个**跨进程** checkpoint worker 是给不存在的问题加复杂度，还会与写入者（Python 引擎）争锁。且 `better-sqlite3` 本机未安装、Electron 37 的 `node:sqlite` 不可用——原「选项 A」需新增原生依赖 |
| 替代口径 | ① 想在诊断包里看见库体积 → 在 `processes.json` 加一项 sqlite 文件尺寸（只读、无争锁），需要时立项；② 要真做 checkpoint 应改**引擎侧**（写入者），但需引擎契约变更（`nanobot/` 只读，另立） |
| 落点 | 本期无 |

| **FR-11.9 诊断包增强：进程维度 + 日志出口凭据过滤** | **P1** | ✅ **已落地（2026-10-16）** | ① 诊断包加**进程/端口维度**：`processes.json`（本进程 pid/uptime、三个引擎端口的监听者 pid、`run/` 状态文件逐份 verdict）；分类手法抄 `core-process-roles.js` 的四桶模型。② 日志/诊断**出口**加一遍**内容级凭据过滤**（四类模式，保留首 4 尾 4）——只借「过滤位置」的设计，不抄 1.94 MB 的 `log-acl-guard.js` 实现。⚠️ 边界已如实写进 README 与模块注释：**模式匹配覆盖不了长得不像凭据的凭据**，真正的保证仍是「含凭据的文件根本不进包」 |

---

## 三、依赖与前置验证

**必须先做的三项验证**（任一不过，对应批次要改方案，不要硬上）：

| # | 验证 | 为什么必须先验 | 不通过时的替代方案 |
|---|---|---|---|
| V-1 | **`sandbox:true` 与 `preload.cjs` 的兼容性** | `sandbox:true` 会让 preload 失去 Node API 集，**会直接崩**；`typecheck` 发现不了 | 只做 webPreferences 档位表骨架 + `webSecurity` 分流，不动 `sandbox`（FR-8.10 验收标准 ②③④ 仍可满足） |
| V-2 | **`webSecurity:true` 下本地网关是否可用** | 现状 `webSecurity:false` 的理由是「`file://` 访问本地网关」，恢复真需要 CORS 头；网关是 Python 引擎 | 方案 B：把需要跨源的窗口单独拆出用独立 `kind` |
| V-3 | **`waitForPortFree` 超时的真实发生率** | 决定 FR-13.3 是「修 bug」还是「修 bug + 调超时值」 | 保持 5s，仅把超时事件写入日志观察一个迭代 |


**批次间依赖**：

```
FR-13.1 ──► FR-13.2         （单实例先定「谁是主实例」，清理才有明确责任方）
FR-13.3 ──► FR-13.4         （重启入口统一后，残留清理才有单一调用点可挂）
FR-13.5 ──► FR-11.6         （先治理再剖析？否 —— 反了，见下）
```

⚠️ **修正上一条**：正确顺序是 **FR-11.6（剖析）先于 FR-13.5（首屏治理）**——没有分段数据不要做体积优化，否则无法判断收益来自哪一处。同理 **FR-11.6 先于预热（C5，本期不做）**。

```
FR-11.6 ──► FR-13.5         （有数据再优化）
FR-11.6 ──► FR-11.7         （同一采集器扩展，共用落点）
FR-8.4  ──► FR-8.13         （默认拒绝写入的优先级必须先确定，再叠路径规则）
FR-8.2  ──► FR-3.12         （工具白名单语义必须先对齐工具网关，否则交集/并集说不清）
FR-3.10 ──► FR-3.11         （prompt 片段依赖统一挂载表；反过来做会返工）
FR-3.14 ──► （ADR 通过后）→ 实施
```

---

## 四、开发计划

### 4.1 批次总览

| 批次 | 主题 | 需求 | 泳道 | 优先级 | 可并行 |
|---|---|---|---|---|---|
| **B1** | 事故止血 | FR-13.1 / 13.2 / 13.3 | A | **P0** | 否（主线） |
| **B2** | 卫生与诊断 | FR-13.4 / 11.8 / 11.9 | A+C | **P0** | 与 B3 可部分并行 |
| **B3** | 安全纵深 | FR-8.10 / 8.11 / 8.12 | B | P1 | 与 B2 可并行 |
| **B4** | 可观测 | FR-11.6 / 11.7 | C | P1 | 与 B5 可并行 |
| **B5** | 首屏与交付 | FR-13.5 / 13.6 | A | P1 | 与 B4 可并行 |
| **B6** | 引擎侧路径规则 | FR-8.13 | B | P1 | 与 B7 可并行 |
| **B7** | 扩展面 | FR-3.10 / 3.11 / 3.12 / 3.13 | D | P1 | **完全独立，随时可开工** |
| **B8** | 扩展运行时 | FR-3.14（**仅 ADR**） | D | P1 | 完全独立 |
| — | （不排期）预热池 | 分析③ C5 | C | P2 | 等 B4 数据说话 |
| — | （不排期）Job Object 内核兜底 | FR-13.2 强化档 | A | P2 | 等 B1 效果评估 |

**推荐总序**（每批独立可合、可回滚）：

```
B1 事故止血 ──► B2 卫生与诊断 ──┬──► B3 安全纵深 ──► B6 引擎路径规则
                                └──► B4 可观测 ──► B5 首屏与交付
B7 扩展面（并行，不阻塞以上任何一批）
B8 ADR（并行）
```

### 4.2 批次明细

#### 批次 B1 —— 事故止血（P0）

| 任务号 | 任务 | 需求 | 产出 | DoD（验收命令 / 判据） |
|---|---|---|---|---|
| B1-01 | 加单实例锁 + `second-instance` 唤醒，位置在 `app.whenReady()` 前 | FR-13.1 | `electron/main.ts` | 连开两次 → 第二个退出且不 spawn 新引擎；`npm run typecheck:electron` 0 错误 |
| B1-02 | 抽 `cleanupChildProcesses()`；补 `uncaughtException` / `SIGINT` / `SIGTERM`；`before-quit` 改同步等待 | FR-13.2 | `electron/childProcesses.ts`（新增）+ `main.ts` | 真机强杀主进程 → 5s 内进程树消失、端口可重绑；单测含 `/T` 参数断言 |
| B1-03 | 抽 `restartServe()`；三处调用点替换；端口超时**短路报错**（修 bug） | FR-13.3 | `electron/main.ts:994/2008/2306/4457` | 单测：端口恒占用 → `ok:false` 且未调 `startNanobot`；变异验证变红 |
| B1-04 | 子进程 spawn 补 `detached:false` + `windowsHide:true` | FR-13.2 | `main.ts:866-879 / 961-975` | 真机：无 cmd 黑框闪出；行为无回归 |

**批次门禁**：三套 tsc（`typecheck` / `typecheck:electron` / `typecheck:tests`）+ `vitest run --maxWorkers=3` + `vite build` 全绿，**判据永远看退出码**；改 `electron/**.ts` 后**必须重建 `main.cjs` + `preload.cjs`**（`npm run build:electron` / `electron:serve`），**不要手改 `.cjs`**。

> **✅ 已落地（2026-10-16）**
>
> **新增模块**（均可单测，不碰 Electron 全局态）：
> `electron/singleInstance.ts`（锁语义，`app` 收成按事件命名的最小面）·
> `electron/childProcesses.ts`（`buildTreeKillArgs` / `killProcessTree` / `waitForProcessExit` / `cleanupChildProcesses`）·
> `electron/serveRestart.ts`（`restartServe(doneMessage, deps)`，纯编排 + 依赖注入）。
>
> **新增测试**：`tests/electron/{singleInstance,childProcesses,serveRestart}.test.ts` 共 **19 例**。
>
> **`main.ts` 改动**：① 单实例锁上移到**所有带副作用模块级代码之前**（第二个实例连 eventStore 都不建）；② `before-quit` 只留同步收尾，异步进程树清理移到 `will-quit`（`preventDefault` → 等 → `app.exit(0)`，清理失败也必定退出）；③ 补 `uncaughtException` / `SIGINT` / `SIGTERM` 三个进程级兜底；④ 两处 spawn 补 `windowsHide:true` + `detached:false`；⑤ 三处复制粘贴替换为 `restartServeForConfig()`。
>
> **踩到并已规避的坑**：`Electron.App` 的 `on` 是重载集合，赋给单一签名时 TS 只拿第一个重载比 → 必须不兼容 → 解法是**按事件命名**（`onSecondInstance`）而不是收 `App` 类型。详见 `singleInstance.ts` 模块注释。
>
> **真机验证**：`tasks/verify-b1-process-lifecycle.mjs`（CDP + 全机进程扫描 + 端口探测）。**必须清掉 `ELECTRON_RUN_AS_NODE`**——WorkBuddy 的 Bash 环境注入了它，会让 `electron.exe` 退化成纯 Node（`require('electron')` 返回路径字符串 → `app` undefined → 主进程第一行就崩）。
> 前后对比：把 `will-quit` 还原成旧行为（同步发起即返回）后重跑，**「退出后端口 18900 已释放」FAIL**（主进程走了、serve 还占着端口）；换回新行为后同一条转绿——这条判据是真 discriminator。
>
> ⚠️ **本机 GPU 进程不可用**（Chromium `FATAL: gpu process isn't usable`，应用约 1 秒内早夭，退出码 0x80000003）导致真机脚本**无法稳定复跑**；本轮早先已取得一轮 12 项全绿。脚本已加整体重试与「不依赖渲染层」的 browser 级关闭路径，环境恢复后可直接复跑。

#### 批次 B2 —— 卫生与诊断（P0）

| 任务号 | 任务 | 需求 | 产出 | DoD |
|---|---|---|---|---|
| B2-01 | `run/gateway.*.json` 启动期 stale 清理（pid 存活 + config 指纹双判） | FR-13.4 | `electron/gatewayRuntimeState.ts`（新增） | 真机：清理后 `run/` 只剩当前实例状态文件 |
| B2-02 | WAL checkpoint worker（选项 A：Electron 侧 `better-sqlite3`） | FR-11.8 | `electron/walCheckpointWorker.ts`（新增） | **`ls -l llm_usage.sqlite3-wal`：4.13 MB → 接近 0** |
| B2-03 | TRUNCATE→PASSIVE 降级 + `:fallback-passive` 标注 | FR-11.8 | 同上 | 单测：模拟 locked → 降级断言 |
| B2-04 | 诊断包加进程/端口维度 | FR-11.9 | `electron/diagnostics.ts` | 导出 zip 含进程快照可判 pid 存活 |
| B2-05 | 日志出口内容级凭据过滤 | FR-11.9 | `electron/logStore.ts` | 写入形似密钥的串 → 导出被脱敏；变异验证变红 |

> **✅ 已落地（2026-10-16，B2-01 / B2-04 / B2-05；B2-02 + B2-03 见顶部专列，不做）**
>
> **新增模块**：
> - `electron/gatewayRuntimeState.ts` —— 状态文件解析/五档判定/清理 + `netstat` 端口内省。
>   五档判据：`stale-unparseable` → `stale-no-pid` → `stale-dead-pid` → `stale-foreign-config` → `live`。
>   **只删文件，从不杀进程**（看到活 pid 就 taskkill 是替用户做决定）。
>   文件名用 `^gateway(\.[0-9a-f]{6,64})?\.json$` 精确匹配，**排除 `.clients.json` 与两把 `.lock`**
>   ——那是引擎 lease 的现场，删了会破坏引用计数。
> - `electron/secretRedaction.ts` —— 四类模式（键值对 / Bearer / `sk-` / JWT），
>   保留首 4 尾 4；**刻意不脱敏长十六进制串**（`args_digest` 的 sha256 是定位调用的线索）。
>
> **`main.ts` 接线**：① `sweepGatewayRuntimeState()` 在**拉起引擎之前** await（目录干净时引擎
> 写自己的状态文件，不与上轮残留互相干扰），失败 fail-open 只记日志；② `diagnostics:export`
> 传入 `buildProcessSnapshot()`；③ `DIAGNOSTIC_PORTS` 必须声明在 `GATEWAY_HEALTH_PORT` **之后**
> （模块级 const 踩 TDZ，已写进注释）。
>
> **`diagnostics.ts` 改动**：新增 `processes.json` 条目；日志/trace 进包前过一遍脱敏，
> `meta.json` 记 `redaction.{applied,hits}`、README 说明「这是模式匹配、覆盖不了不像凭据的凭据」。
> 快照本体只落 `processes.json`，meta 里只留 `processSnapshotIncluded` 指针（一个事实一个落点）。
> 计数改为按**实际进包的内容**统计——脱敏后体积会变小，按原始体积报数字会对不上。
>
> **真机验证**（不需要 GUI，直接对真实目录跑）：`run/` 三份僵尸全部判为 `stale-dead-pid`
> 并清除、`run/` 已空；另起一个真监听端口，`collectPortListeners` 正确归属到占用者 pid。
>
> **新测试**：`tests/electron/{gatewayRuntimeState,secretRedaction}.test.ts` 共 36 例，
> `diagnosticsStore.test.ts` 补 5 例。**4 项变异验证**：去掉 foreign-config 判据 /
> 放开文件名匹配 / 把 `tokens` 加进凭据键名 / 跳过出口脱敏——各自精确红一条。
> ⚠️ 其中「`input_tokens` 不误伤」原本用 `input_tokens=1234`（4 字符）做负向用例，
> **因为长度门槛就通不了，等于因错误的原因通过**；已改成 10 字符值后才具备证伪能力。

#### 批次 B3 —— 安全纵深（P1）

| 任务号 | 任务 | 需求 | 产出 | DoD |
|---|---|---|---|---|
| B3-00 | **前置验证 V-1 / V-2**（sandbox + preload 兼容性 / webSecurity 恢复可行性） | — | 验证记录（写入本批次报告） | 明确结论 + 选定替代方案 |
| B3-01 | 新增窗口档位表 `createWindowPreferences(kind, opts)` | FR-8.10 | `electron/windowPreferences.ts`（新增） | 「缺 partition 必须 throw」有独立用例 + 变异验证 |
| B3-02 | 主窗口 `webSecurity` 分流（方案 A 或 B，按 V-2 结论） | FR-8.10 | `main.ts:557-560` | 真机对话链路无回归 |
| B3-03 | 主窗口 `sandbox:true`（**仅当 V-1 通过**） | FR-8.10 | 同上 | preload 功能无缺失（dev 实跑） |
| B3-04 | `electron/safeDelete.ts` + 替换全部裸 `fs.rm` | FR-8.11 | `safeDelete.ts`（新增）+ 4 个调用点 | 单测：trashItem 抛错不降级；真机会话删除进回收站 |
| B3-05 | 产物 iframe CSP 收紧（`connect-src 'none'`） | FR-8.12 | `ArtifactRenderer.tsx`、Web 视图 | 真机 devtools 见 `Refused to connect`；四类产物无回归 |

#### 批次 B4 —— 可观测（P1）

| 任务号 | 任务 | 需求 | 产出 | DoD |
|---|---|---|---|---|
| B4-01 | 启动剖析器（默认零 I/O + 独立模块图 + 三点打点） | FR-11.6 | `electron/startupProfile.ts`（新增） | 不设开关时零额外加载（单测断言）；设开关后产出分段 |
| B4-02 | 补 `ttftMs` / `stream` 三处同改（wire → 类型 → 落库） | FR-11.7 | `usage.ts`、`src/types/usage.ts`、引擎 `store.py` | 新记录 `ttft_ms>0` 占比 > 0（真机一轮对话） |
| B4-03 | SSE 首字节打点 + 耗时计算 | FR-11.7 | `src/ai/runtime/nanobotHttp/chat.ts` | 单测含「首字节即首 token」边界 |
| B4-04 | 自包含 HTML 性能报告 | FR-11.7 | `resources/perf-report.html`（新增） | 断网可完整渲染（无 CDN 依赖） |

**批次特殊约束**：B4-01 完成后**先出数据再决定后续**——若 9.4 秒集中在 Python import，则预热池（C5）收益有限，本期不做。

#### 批次 B5 —— 首屏与交付（P1）

| 任务号 | 任务 | 需求 | 产出 | DoD |
|---|---|---|---|---|
| B5-01 | 路由级 `React.lazy` + `Suspense`（带可见 fallback） | FR-13.5 | `src/router/index.tsx` | 逐页真机访问无白屏 |
| B5-02 | `markdown` 分包移出 `modulepreload`，改按需 | FR-13.5 | `vite.config.ts`、`ArtifactRenderer.tsx` | `dist/index.html` 的 `modulepreload` 总量 ≤ 1.2 MB |
| B5-03 | 引擎三项自检（解释器 / 包导入 / 配置校验） | FR-13.6 | `electron/engineSelfCheck.ts`（新增） | 三项各有独立失败用例；venv 改名 → 引导含真实路径 |
| B5-04 | 渲染层引导视图 | FR-13.6 | 设置页「关于」分区或独立视图 | 自检不阻塞窗口显示 |

**批次特殊约束**：真机验证铁律 —— dev server 与 `vite build` 不要并发；改图标类依赖前先 `mv node_modules/.vite/deps_temp_* /tmp`。

#### 批次 B6 —— 引擎侧路径规则（P1）

| 任务号 | 任务 | 需求 | 产出 | DoD |
|---|---|---|---|---|
| B6-01 | 引擎 `security/` 规则加载器（`{path, action}` 复合动作） | FR-8.13 | `nanobot/nanobot/security/`（新增） | 三种动作正交性单测；无规则文件行为不变 |
| B6-02 | `SecuritySection.tsx` 规则编辑器（草稿 + 保存） | FR-8.13 | `SecuritySection.tsx` | 改配置 → 重启网关生效；`no_access` 无条件守卫回归 |
| B6-03 | 引擎侧改动登记 `[LOCAL PATCH]` | — | `docs/upstream-merge-conflicts.md` | 逐文件逐行登记，含再打补丁顺序 |

#### 批次 B7 —— 扩展面（P1，独立并行）

| 任务号 | 任务 | 需求 | 产出 | DoD |
|---|---|---|---|---|
| B7-01 | `AgentPlugin` 加 `prompts` 字段 + 走 `_contained()` | FR-3.10 | `nanobot/agent/plugins.py` | 越界路径被拒用例 |
| B7-02 | `_package_fingerprint` 覆盖范围扩到新目录 | FR-3.10/3.11 | 同上 | 用例：改插件 prompt → 缓存失效 |
| B7-03 | 单 loader → ChainLoader（插件命名空间 > 工作区 > 内置） | FR-3.10 | `nanobot/utils/prompt_templates.py` | demo 插件片段进系统提示词；**变异验证（去第一级 → 变红）** |
| B7-04 | 信任分级：`user` 档包 `<untrusted_content>` | FR-3.10 | 同上 | 断言最终提示词确有包裹 |
| B7-05 | 统一挂载表 + `agents` / `commands` / `prompt_dirs` / `hook_manifest` / `tool_policy` | FR-3.11 | `plugins.py` | 字段未声明时行为不变 |
| B7-06 | `plugin_tools.py` 声明式工具策略（**交集语义**） | FR-3.12 | `nanobot/agent/hooks/plugin_tools.py`（新增） | `tools:[shell]` 不得绕过审批；变异验证变红 |
| B7-07 | 可选 `marketplace.json` + 依赖解析（无索引回退扫描） | FR-3.13 | `pluginMarketplace.ts` | 循环依赖被拒；无索引回归 |

#### 批次 B8 —— 扩展运行时 ADR（P1，不承诺实现）

| 任务号 | 任务 | 需求 | 产出 | DoD |
|---|---|---|---|---|
| B8-01 | 写 ADR：进程模型 / 权限面 / 生命周期 / 与插件分工 | FR-3.14 | `docs/adr/ADR-00xx.md` | ADR 含「抄进程隔离、不抄 MF」与「不做 Guest SDK」的理由 |

### 4.3 验证纪律（每条需求都要有变异验证）

| 需求 | 变异操作（改回旧写法） | 期望结果 |
|---|---|---|
| FR-13.1 | 去掉单实例锁 | 「第二个实例不进 startNanobot」用例变红 |
| FR-13.2 | 去掉 `await` | 清理完成度用例变红 |
| FR-13.3 | 恢复「无视 `waitForPortFree` 返回值」 | 「超时短路」用例变红 |
| FR-13.4 | 去掉 config 指纹判据 | 「指向他项目 config 的状态文件被误留」用例变红 |
| FR-8.10 | `throw` 改静默返回 | 「缺 partition 必须抛」用例变红 |
| FR-8.11 | 加一行「失败则 `fs.rm`」 | 「trashItem 失败不降级」用例变红 |
| FR-8.12 | 去掉 `connect-src 'none'` | 「产物 fetch 被拦」用例变红 |
| FR-8.13 | 把复合动作降级为单一 allow/deny | 「`write=deny` 不禁读」用例变红 |
| FR-11.8 | ~~去掉 PASSIVE 降级分支~~ | **本期不做**（前提被推翻，见 §〇 专列） |
| FR-11.9 | 去掉内容级凭据过滤 | 「密钥被脱敏」用例变红 ✅ 已验证 |
| FR-13.4 | 去掉 `stale-foreign-config` 分支 | 「活着的他项目状态文件被清」用例变红 ✅ 已验证 |
| FR-13.4 | 放开文件名匹配（`startsWith('gateway')`） | 「`.clients.json` / `.lock` 不碰」用例变红 ✅ 已验证 |
| FR-13.4 | 把 `tokens` 加进凭据键名（脱敏侧） | 「`input_tokens` 不误伤」用例变红 ✅ 已验证 |
| FR-13.5 | 恢复静态 import | 「首屏 preload 总量」断言变红 |
| FR-3.10 | 去掉 ChainLoader 第一级 | 「demo 插件片段进提示词」用例变红 |
| FR-3.12 | 交集改并集 | 「`tools:[shell]` 不得绕过审批」用例变红 |

**通用纪律**（项目既有，逐条重申）：
1. 每个整改项**先写用例再看红**，不接受「代码写完顺手补测试」。
2. 门禁**三套 tsc 一起跑**；`npm run test` 带 `--maxWorkers=3`（并行拉满时 `tests/electron/` 互相干扰）。
3. 跑全量门禁带 **`CODEBUDDY_SAFE_DELETE_ENABLED=0`**，否则 4 个预存文件的 `afterEach` `fs.rm(recursive)` 被安全删除守卫拦截超时 → **假报 12 个失败**。**判据永远看退出码**。
4. 绿灯 ≠ 门禁过：全绿但 `exit=1` = Unhandled Error（多为 MUI 过渡 `setTimeout`），该文件 `afterEach` 卸组件 + 等 400ms。
5. 改 `electron/**.ts` → **重建 `main.cjs` + `preload.cjs`**。
6. 引擎侧改动 → 登记 `[LOCAL PATCH]`（`nanobot/` 是独立只读仓库）。

### 4.4 风险登记册

| # | 风险 | 影响 | 概率 | 应对 |
|---|---|---|---|---|
| R-1 | **`sandbox:true` 与 `preload.cjs` 不兼容** | B3-03 崩 | 高 | 前置验证 V-1；不过则只做档位表 + webSecurity 分流 |
| R-2 | **恢复 `webSecurity:true` 后本地网关不可用** | 主链路断 | 中 | 前置验证 V-2；方案 B（拆窗口）兜底 |
| R-3 | WAL checkpoint 与引擎写入竞争 | 偶发 `SQLITE_BUSY` | 中 | `busy_timeout` + 接受 PASSIVE 降级 + 真机长对话验证 |
| R-4 | **引擎仓库只读**（`nanobot/` 独立 git、对象库受损） | B6 / B7 / B4-02 无法直接提交 | 高 | 改动走人工同步；逐条登记 `docs/upstream-merge-conflicts.md`；**模型不得执行任何 git 写操作** |
| R-5 | 插件 prompt 片段 = **提示词注入面** | 安全 | 中 | 信任分级 + `user` 档 `<untrusted_content>`（FR-3.10 ④） |
| R-6 | **fingerprint 未同步扩大** | 「改插件不生效」以缓存击穿形态出现，极难查 | 高 | B7-02 单列一个任务 + 用例（改 prompt → 缓存失效） |
| R-7 | `React.lazy` 引入白屏 | 体验 | 中 | `Suspense` 必须带可见 fallback；真机逐页验证 |
| R-8 | Job Object 需 native binding | 排期 | 中 | 本期不做 native；先 `taskkill /T` + await，效果不足再评估 |
| R-9 | `before-quit` 时序改动影响托盘退出 / Cmd+Q / 安装器重启 | 退出不干净 | 中 | 三条路径逐一回归；`will-quit` 与 `before-quit` 二选一 |
| R-10 | 扩展运行时误引入 UI 联邦 | 复杂度爆炸 | 中 | B8 只出 ADR，明确「不抄 MF」 |
| R-11 | 老测试夹具依赖裸 `fs.rm` | 门禁假红 | 中 | B3-04 落地时核对 `tests/electron/` 夹具 |

### 4.5 放行标准

一个批次视为完成，必须同时满足：

- [ ] 该批次全部任务的 DoD 逐条勾选（含真机判据）
- [ ] 三套 tsc + `vitest`（`--maxWorkers=3`）+ `vite build` 全绿，**退出码为 0**
- [ ] 该批次变异的项已做变异验证（改回旧写法 → 用例变红）
- [ ] 涉及 `electron/**.ts` 的已重建 `main.cjs` / `preload.cjs`
- [ ] 涉及引擎的已登记 `[LOCAL PATCH]`
- [ ] 本文件对应条目的「现状」列已更新为「已落地 + 日期 + 判据数字」
- [ ] 有可观测数字的（FR-11.8 / FR-13.5）已写入前后对比

---

## 五、交付物与变更清单

### 5.1 新增文件

| 文件 | 批次 | 作用 |
|---|---|---|
| `electron/childProcesses.ts` | B1 | 子进程创建与进程树清理（可单测） |
| `electron/gatewayRuntimeState.ts` | B2 | `run/gateway.*.json` 五档判定 + stale 清理 + `netstat` 端口内省 |
| `electron/secretRedaction.ts` | B2 | 日志出口的内容级凭据脱敏（四类模式） |
| ~~`electron/walCheckpointWorker.ts`~~ | ~~B2~~ | **本期不做**（WAL 前提被推翻，见 §〇） |
| `electron/windowPreferences.ts` | B3 | 窗口安全档位表（危险档位缺前置即 throw） |
| `electron/safeDelete.ts` | B3 | 删除统一走回收站、失败不降级 |
| `electron/startupProfile.ts` | B4 | 启动剖析（默认零 I/O、独立模块图） |
| `resources/perf-report.html` | B4 | 自包含性能报告（断网可用） |
| `electron/engineSelfCheck.ts` | B5 | 引擎三项自检 |
| `nanobot/agent/hooks/plugin_tools.py` | B7 | 声明式工具策略（交集语义） |
| `nanobot/nanobot/security/<rules>.py` | B6 | 路径级复合动作规则加载器 |
| `docs/adr/ADR-00xx.md` | B8 | 扩展运行时 ADR |

### 5.2 主要修改文件

| 文件 | 批次 | 改什么 |
|---|---|---|
| `electron/main.ts` | B1/B2/B3/B4/B5 | 单实例锁、清理与时序、`restartServe()`、webPreferences、埋点打点、自检接线 |
| `electron/diagnostics.ts` | B2 | 进程/端口维度 |
| `electron/logStore.ts` | B2 | 内容级凭据过滤 |
| `electron/eventStore.ts` / `pluginPackage.ts` | B3 | 删除改走 `safeDelete` |
| `src/router/index.tsx` | B5 | 路由级懒加载 |
| `vite.config.ts` | B5 | `markdown` 分包移出 `modulePreload` |
| `src/components/artifacts/ArtifactRenderer.tsx` | B3/B5 | 预览 CSP + mermaid 沿用现成动态 import 写法 |
| `src/ai/runtime/nanobotHttp/usage.ts`、`src/types/usage.ts` | B4 | 补 `ttftMs` / `stream` |
| `src/components/settings/sections/SecuritySection.tsx` | B6 | 路径规则编辑器 |
| `nanobot/agent/plugins.py` | B7 | `prompts` 字段 + 统一挂载表 + 新路径 `_contained()` |
| `nanobot/utils/prompt_templates.py` | B7 | ChainLoader + 信任分级 |
| `electron/pluginMarketplace.ts` | B7 | 可选 `marketplace.json` + 依赖解析 |
| `docs/upstream-merge-conflicts.md` | B6/B7 | `[LOCAL PATCH]` 登记 |


### 5.3 代码删除/替换

| 项 | 说明 |
|---|---|
| `main.ts:2008 / 2306 / 4457` 的复制粘贴三连 | 替换为 `restartServe()` |
| 全部裸 `fs.rm`（非运行时缓存处） | 替换为 `safeDelete()` |
| 全局 `webSecurity:false` | 收敛进档位表，主窗口恢复 `true` |

---

## 附录 A：追溯矩阵（分析产物 → 需求 ID）

| 分析来源 | 候选 | 收敛为 |
|---|---|---|
| 分析① P0 / G1 | 插件 prompt 片段 | **FR-3.10** |
| 分析① P1 / G2·G3 | 清单读取器（agents / commands） | **FR-3.11** |
| 分析① P2 / G5 | 声明式工具白名单 | **FR-3.12** |
| 分析① P3 / G6 | marketplace 索引 | **FR-3.13** |
| 分析① P4 | 插件级 hooks | ❌ 降维 / 不做（见 §1.5） |
| 分析① P5 / G7 | 插件带 UI 资产 | ❌ 不做（见 §1.5） |
| 分析① §三 缓存隐患 | fingerprint 覆盖 | **R-6 风险 + B7-02 任务** |
| 分析② B1 | 性能埋点 + HTML 报告 | **FR-11.6 / FR-11.7** |
| 分析② B2 | 单实例锁 + 深链 | **FR-13.1**（深链部分未纳入本期） |
| 分析② B3 | 产物预览 CSP | **FR-8.12** |
| 分析② B4 | 主进程删除走回收站 | **FR-8.11** |
| 分析② B5 | Windows Job Object | **FR-13.2 降级档**（本期不做 native） |
| 分析② B6 | 路径级 glob 规则 | **FR-8.13** |
| 分析② B7 | 语气档落成 md | 未纳入本期（低优先，见 §1.5 之外的口袋清单） |
| 分析② B8 | 引擎运行时自检 | **FR-13.6** |
| 分析② B9 | 扩展 = fork + activate | **FR-3.14（ADR）** |
| 分析② B10~B15 | PTY / ripgrep / 多形态 / 骨架屏 / Guest SDK / IM 幂等 | 按需，未纳入本期 |
| 分析③ C1 | 窗口安全档位表 | **FR-8.10** |
| 分析③ C2 | WAL checkpoint worker | ~~FR-11.8~~ → **本期不做（原判据误读，见 §〇 专列）** |
| 分析③ C3-a | 生命周期钩子 + will-quit | **FR-13.2** ✅ |
| 分析③ C3-b | 单实例锁 | **FR-13.1** ✅ |
| 分析③ C3-c | restartServe + 超时短路 | **FR-13.3** ✅ |
| 分析③ C3-d | run/ 僵尸清理 | **FR-13.4** ✅ |
| 分析③ C3-e | 诊断包进程维度 | **FR-11.9** ✅ |
| 分析③ C3-f | Job Object（重） | 不排期（等 B1 效果） |
| 分析③ C4 | lazy chunk + manifest 契约 | **FR-13.5**（manifest 契约部分留待扩展目录加载） |
| 分析③ C5 | CLI 预热池 | 不排期（等 B4 数据） |
| 分析③ C6 | 启动剖析器 | **FR-11.6** |
| 分析③ J1 | 三层进程拓扑 | 决策项：**保持 foreground + 补兜底**（不走 detached daemon） |
| 分析③ J3 | 日志出口凭据过滤（借位置不借实现） | **FR-11.9** ✅ |
| 分析③ J5 | `self-check` / `memory-check` | 合并进 **FR-13.6** |
| 分析③ J2 / J4 / J6 | AsyncLocalStorage / 凭据保护 / 稳定 ID | 登记，本期不做 |
| 分析②/③ 三工程习惯 | fail-closed 纵深 / 注释即设计文档 / 运行期无法自证交构建期 | **横向纪律**，落在每条需求的「落点」注释里（不单独立需求） |

## 附录 B：口袋清单（本期不做，登记备查）

| 项 | 来源 | 触发条件 |
|---|---|---|
| CLI 预热池 / 常驻预热进程 | 分析③ C5 | FR-11.6 数据显示 spawn 是主要耗时项之后 |
| Windows Job Object native binding | 分析③ C3-f | FR-13.2 的 `taskkill` 档实测不足之后 |
| 托盘语气档落成用户可编辑 md | 分析② B7 | 有明确的语气定制诉求时 |
| 深链协议（`protocols` + 单实例联动） | 分析② B2 后半 | 需要「从浏览器/终端唤起」时（FR-13.1 已为其铺路） |
| PTY 终端（`node-pty` + xterm） | 分析② B10 | 要做「可交互终端」时 |
| 内嵌 ripgrep（NAPI 形态） | 分析② B11 | 搜索频繁、进程启动开销成瓶颈时 |
| 多发行形态（基线 + override 补丁） | 分析② B12 | 要做私有化 / 云托管时 |
| Guest 桥接 SDK（postMessage + MessagePort） | 分析② B14 | 要做第三方 UI 扩展 / MCP App 时（当前已明确不做） |
| 自动更新（NSIS 静默链） | 分析② §2.8 | 分发给外部用户时 |
| 随包运行时（PortableGit / CPython / node） | 分析② §2.7 | 安装体验成为阻塞项时（FR-13.6 先做「可操作的失败」） |
| `AsyncLocalStorage` 归因耗时 | 分析③ J2 | 主进程 IPC 往返需要归因时 |
| 凭据保护 bootstrap / 稳定 ID 生成器 | 分析③ J4 / J6 | 凭据面加固 / 跨重启稳定 ID 需求出现时 |

---

## 附录 C：一句话总结每批

| 批次 | 一句话 |
|---|---|
| B1 | 先让「双开互杀、崩溃留孤儿、端口占用盲启动」这三件事不再发生 |
| B2 | 让残留状态自己清掉、让 WAL 不再涨、让诊断包能看见进程 |
| B3 | 把安全从「应用层单点」补成「外壳 + 内容 + 删除」三道 |
| B4 | 先把 9.4 秒拆开、把 TTFT 采起来，再谈优化 |
| B5 | 首屏瘦一半，引擎装不上时能给出人话引导 |
| B6 | 路径权限从硬编码变成用户可配的复合动作规则 |
| B7 | 让插件清单的读者从 2 个变成 5 个（含最关键的 prompt 片段） |
| B8 | 扩展运行时先出 ADR，抄进程隔离、不抄 UI 联邦 |
