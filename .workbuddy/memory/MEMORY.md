# 项目长期记忆 — nanowork

WorkBuddy 式智能体客户端：React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。完整 FR 状态索引见 `docs/README.md` §九 看板（B3/B4 落地细节以看板为准，本文件只记「看板/代码推导不出的架构事实」）。

## 硬规则（CI 门禁，违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git 且对象库受损 → 只读。
- 渲染层只 `src/platform/**` 认识 `window.electronAPI`(CI检查一)；引擎 wire 键名只 `src/ai/runtime/nanobotHttp/**`(CI检查二)。
- 核心逻辑/测试单引号；UI 双引号。注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`(同代)；升 vitest4 必须同升 vite≥6。
- 判超时只看 `err.name==='AbortError'`(abort 抛 DOMException，跨 realm `instanceof Error` 恒 false)。
- 门禁三套 tsc 一起跑(`typecheck`/`typecheck:electron`/`typecheck:tests`；tests 不在 build 内)。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`(esbuild, external:electron)。
- 门禁 `--maxWorkers=3`；全量带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`(否则 `fs.rm` 被安全删除守卫拦→假报12失败)。永远看退出码。
- `tests/` 被 `.gitignore` 整目录忽略 → 新测试 `git add -f`。
- 写 `platform.storage.set` 新 key 要登记 `STORAGE_KEYS`；裸字符串别落 json 路由(主进程 `JSON.parse` 必崩)。
- 引擎 `Base` `extra="ignore"`：未声明键静默丢弃 → 新增声明式字段先改 `schema.py`+加往返用例。

## 引擎架构事实（不可从代码直接推断）
- ⚠️ `spawn(wait=false)` 丢结果：serve 进程无 inbound 消费者(唯一 `consume_inbound` 在 `AgentLoop.run()`)。FR-2.4/编排用 `run_inline` 直接 await。
- ⚠️ 两套 logger 占位符不同：`loop.py` loguru(`{}`)、`expert_group.py` 标准 logging(`%s`)。写反不报错。
- ⚠️ `agent/context.py` 里 `from nanobot.agent.plugins import ...` 只能函数内局部导入(否则 `agent/__init__`→plugins→config.loader 环闭→`schema.py` `_resolve_tool_config_refs` 静默失败 → `Config.model_validate` 报 `WebToolsConfig not fully defined`)。
- ⚠️ `agent/__init__` 半初始化：测试首行加 `import nanobot.agent` 绕开 progress_events 触发环。
- 端口职责：`serve` 才提供 `/api` REST(`/v1/models`、`/v1/dream/*`)；`gateway` 只有 channel + `/health`，`/v1/*` 一律 404。两进程两端口，别把 health 端口当 API 端口。

## 产物登记的两条路径（2026-10-19）
- 任务会话：`handleProcessTool`(phase=end)→`deriveFileArtifacts`→`handleArtifact`(同时写 `message.artifacts` 与 `artifactsStore`)；富产物是流结束后 `extractArtifacts(全文)` 跑一次。
- 导入会话（IM 频道 / 定时任务执行）：**推理在引擎侧**，本地只有磁盘 JSONL 重放，没有流式回调 → 产物登记时机只有 `sessionsStore.openExternal`（6 个调用点的唯一入口），由 `sessionImport.attachImportedFileArtifacts` / `attachImportedTextArtifacts` 补齐。判据刻意与上面同套，别为导入会话单开一套。
- ⚠️ nanobot JSONL 把一轮拆成 `assistant(tool_calls)`→`tool`→`assistant(正文)` 多条记录；`mapRecordsToMessages` 必须**按轮聚合**成一条消息（user 是轮边界），否则一轮裂成两个「助手」气泡、产物卡片与正文分家——任务视图是流式聚合成一条的，两边形状必须一致。
- ⚠️ **`recordArtifact` 对「整段历史重放」不幂等**：轮询每 4 秒重建 Session 重放全部写入，会把版本链一路叠长(v2→v4…)。登记前必须用 `hasContentHashInHistory` 跳过已在版本链里的 hash（新写入 hash 未见过才入库）。
- ⚠️ 断言产物正文别读 `bySession[i].content`（恒空串，那是去 content 的引用），要 `resolveArtifactContent(entry.contentHash, bodies, '')`。
- ⛔ **IM 会话发言绝不能走 `/v1/chat`**：引擎 `api/server.py` 执行 `session_key = f"api:{session_id}"`，客户端传什么都被加 `api:` 前缀 → 落进与 IM 线程无关的新会话（历史不进 IM，且下次 4s 轮询 `openExternal` 重建即丢本地消息），**全程零报错**。已在 IM 会话内发言必须用 gateway `POST /v1/turn`（把文本当渠道 `InboundMessage` 投进 bus 交 `AgentLoop.run()`，会话 key 由 `f"{channel}:{chat_id}"` 解析、落盘+出站全白拿）。
- ⚠️ 引擎把思考写进 assistant 记录的 **`reasoning_content`**（纯文本；兼容 blocks 数组 / `{text}` 对象），客户端映射层必须读它，否则助理/定时任务视图**有工具行但无「深度思考」**（任务视图走 SSE 不受影响）。见 `recordReasoning`；思考段与工具行**按到达顺序交错**（先想后做），连续 reasoning 累积成一段（判据同 `flushReasoning`），空思考不建段。
- ⚠️ 测 `AgentLoop` 的 **session key 解析**必须真驱动 `run()`：直连 `_process_message` 绕过 `_effective_session_key`，把 key 改成 `api:` 前缀时用例仍全绿。且 `run()` 用 `asyncio.wait_for(bus.consume_inbound(), 1.0)`——替换假 consumer 会被超时取消（消息进队列却送不到 loop，症状：队列在涨、模型从没被调）；正确姿势是预置 `bus.inbound.put_nowait()` + 等 `bus.consume_outbound()`。`Session.messages` 是 TypedDict，按 `m["role"]` 取。

## 客户端/渲染事实（不可从代码直接推断）
- ⛔ IM 会话的进度**只投给渠道**（`bus.publish_outbound`→飞书卡片），桌面端拿不到 → 助理视图「等回复期间全空」不是渲染问题。
  现由引擎旁路 `gateway/turn_progress.py` + `GET /v1/turn/progress`（health 18790）供客户端 600ms 增量轮询，
  渲染层用**占位助手消息**（`startChannelTurnLive`，纯视图不写事件流）复用 `AssistantMessage` 的同一套过程视觉。
- ⚠️ 实时观察期间**必须抑制** `channelSessionsStore.refreshActiveIfChanged` 的整份替换：引擎开工即落一次盘
  （`_persist_user_message_early`）→ `updatedAt` 一变小，4 秒轮询就会把占位消息冲掉（症状：实时思考闪一下又空了）。
  登记表在 `src/lib/channelTurnLiveState.ts`，收尾时解除并立刻 refresh 让真实记录接管。
- ⛔ 消息渲染**不分会话类型**：`MessageStream` 对任务/助理/定时任务都用同一套 `UserMessage`/`AssistantMessage`；两类视图看着不一样，原因在数据侧不在渲染层，改前先查数据源（`message.artifacts` / `artifactsStore.bySession`）。
- ⛔ 副作用别挂可选 UI 组件：`ConnectionBanner` 注释掉过，网关地址自动对齐已下沉到 `connectionManager.probeOnce()`，判据只有 `applyGatewayEndpointInfo` 一处。
- ⚠️ 网关地址同步判据 `nextGatewayEndpoint` 只看 `port`(主进程仅端口验证监听后才写)。**复用外部网关 `running=false` 但 `port` 有值——最需对齐场景，别加回 `running` 判据**(加了就永远不同步→全部 REST `Failed to fetch`)。
- ⚠️ `.tsx` `return (<JSX>,)` 逗号运算符=tsc TS1109 但 vite/vitest 正常，报错行与病灶隔几十行。`return (<JSX>)` 不带逗号。
- ⚠️ Bash heredoc 给 Python 传 `"\n"` 落字面 `/n` → esbuild 报语法错且指错行。改文件换行用 Edit 或 `chr(10)`，改完 `grep -c '/n '` 自查。
- ⚠️ `nanowork.config.json` 是 camelCase(`modelPresets`/`modelPreset`/`fallbackModels`/`providerRetryMode`)。snake_case 探测读到 None→误判「没写进去」。
- ⚠️ 模型「默认」两条解析路径：`resolve_preset()`(认 `modelPreset`，运行时用) vs `resolve_default_preset()`(只读 `agents.defaults.model`，隐式 default)。不一致时界面显示与实际行为分叉且零报错。不变量：指针有效⇒defaults 6 字段与之一致(`electron/modelDefaultsConfig.ts` `syncDefaultsToPointer`)。
- ⚠️ vitest 全量偶发 `EPERM ... node-brokered-fs-shim` → worker 崩 → `ERR_IPC_CHANNEL_CLOSED`。**是沙箱拦读文件，非用例红**；同命令重跑即绿。

## 桌面端 IM 审批卡（2026-10-20 收口，真机 C.8 全链路通过）
- **三条通道不能混**：任务视图=SSE `approval_request` 事件/serve 进程/`POST /v1/tool-approvals/{id}`；**助理视图（IM 会话）=轮询 gateway `GET /v1/approvals`（会话级快照，无游标）/gateway 进程/`POST /v1/approvals/resolve`**。
- ⛔ **IM 轮次是渠道入站触发，桌面端是旁观者** → `turn_progress.begin()`（只由 `/v1/turn` 调用）没登记这一轮 → 进度通道里根本没它，4 秒会话刷新也看不到（审批挂起时不落盘）→ **桌面端只能自己轮询**。
- ⛔ **裁决必须打 gateway 18790，不能打 serve 18900**：两进程各有一张模块级 `PENDING_APPROVALS` → 打错进程 → 409 → **用户点了「允许」什么都没发生，全程零报错**。
- ⚠️ **session_key 三段必须对齐**（本轮全链路验证）：渠道侧注册 `f"{self.name}:{chat_id}"`（`channels/feishu/runtime.py`）→ 引擎磁盘 key `feishu.feishu:ou_144e...` → 网关查询 `session_key_for_channel()` → `f"{channel}:{chat_id}"` → 桌面端 channel 来自 `toChannelSessionSummary()`（`key.split(':')[0]` = 运行时渠道名 `feishu.feishu`），chatId 来自 `channelChatId()`（**不能用 `split(':')[1]`**，chatId 可含冒号）。
- ⚠️ **「漏 await」是网关路由层的静默杀手**：`async def _handle_approvals` 但路由处不 await → `status, payload = <coroutine>` → `cannot unpack non-iterable coroutine object` → 端点恒 500 → 客户端把它当「网关不支持」静默吞 → **审批卡永远不出现，全程零报错**。已修为**同步 `def`**（只读注册表快照，无 await 点）。判据见 `nanobot/tests/gateway/test_health_route_contract.py`（AST 静态判据，12 例）。
- ⚠️ **外部进程改不了进程级 `PENDING_APPROVALS`** → 想在真机触发审批挂起，只能走渠道入站（`POST /v1/turn` 投 inbound 消息，让引擎自己「调工具→需审批→注册→挂起」）。工具见 `tools/inject_pending_approval.py`。
- 客户端落点：`src/stores/channelApprovalsStore.ts`（1 秒轮询 + 乐观出队 + `MAX_FAILURES=8` + `unsupported` 立即停）+ `src/components/ChannelApprovalCard.tsx`（复用 `ApprovalCardBody`）+ `src/pages/chat/ChatPage.tsx`（`session?.channel` 决定渲染 Channel 还是 Task 审批卡，**互斥**）。
- ⚠️ **平台层依赖方向铁律**：`electron/main.ts` 也 import `src/platform/types.ts` → 平台层是渲染层与主进程**共同底座**，不能反向依赖上层契约 → `ApprovalDecision` 下沉到 `src/types/permission.ts`，`src/ai/runtime/types.ts` 改为**转出**（`export type {X} from` + **同时** `import type`，否则本文件内用到报 TS2304）。
- 真机证据：allow 路径文件真创建（`approval-probe.md` 内容 `hello`）+ deny 路径文件真没创建（`deny-probe.md`）；桌面端卡片贴底（`top:726/bottom:900`，= 输入框位置，与任务视图一致）。截图 `docs/evidence/approval-card-ui.png`。

## 引擎统一配置（2026-10-17 收尾）
- 用户决策：统一到本仓 study 副本，桌面也跑本仓。覆盖配置 `$APPDATA/nanowork/nanowork.nanobot.json`：现**不写 bin**(回落两层 venv `nanobot/nanobot/.venv`)，显式 `config=D:/Workspace/study/nanowork/nanowork.config.json`(无内联密钥，凭据走 `DASHSCOPE_API_KEY` 环境变量)。
- ⚠️ venv 真相（2026-10-19 复核）：**代码与网关实际只用一个 —— 两层 `nanobot/nanobot/.venv`**（Python 3.13.12，`python -m venv` 建；`engineInterpreterCandidates`/`fallbackLaunchConfig`/自检全解析它；当前运行中的 gateway `run/gateway.*.json` 也用它的 `Scripts/python.exe -m nanobot`）。一层 `nanobot/.venv` 是历史遗留（uv 建的 3.13.4，prompt=nanobot-ai），**无任何代码引用**，属废弃，可删。
- ⚠️ 渠道依赖自动安装会搞坏 venv(`channels.feishu`→启动 `uv pip install`→lark-oapi 要求降级 websockets 16.1.1→15.0.1，卸载 `.pyd` 被占→删一半没装回→`ModuleNotFoundError`)。防复发：依赖预先装进活动 venv；必 `--reinstall`。
- ⚠️ `readLaunchConfigFromDisk`：override 写 bin 会丢 `-m nanobot`(`args: cfg.bin?[]:fallback.args`)。真实命令 `gateway --foreground --config <path> -v`。不带 `--foreground` 会 daemon 化，`timeout` 杀不干净。

## 真机验证铁律
1. 布局量几何(`getBoundingClientRect`+`getComputedStyle`)别只看截图 2. Playwright `args:['--no-proxy-server']`(本机 `http_proxy` 劫持 127.0.0.1) 3. dev server 与 `vite build` 不并发 4. 启动 dev 前 `mv node_modules/.vite/deps_temp_* /tmp` 5. 真机切场景每场景 `ctx.newPage()`，桩落 localStorage 且 `Object.assign` 内存对象 6. 判上游真伪 `curl --noproxy '*' -i` + `/openapi.json`。
7. ⚠️ **Electron 启动两个环境坑（WorkBuddy 宿主下必踩）**：① `ELECTRON_RUN_AS_NODE=1` 被宿主注入 → Electron 以纯 Node 模式跑 → `import_electron3.ipcMain` undefined → 必须 `env -u ELECTRON_RUN_AS_NODE npx electron .`；② 本机 GPU 进程 0xC0000005 → `FATAL: GPU process isn't usable. Goodbye.` → 加 `--disable-gpu --disable-software-rasterizer --no-sandbox --disable-gpu-compositing --enable-unsafe-swiftshader`（`--no-sandbox` 是关键）。
8. ⚠️ **Playwright 桩五个坑**（验收 UI 时）：① `file://` 文档禁 `replaceState('/chat')` → `SecurityError: history state object with URL 'file:///D:/chat'` → **必须本地 HTTP 服务托管 dist**；② playwright 版本要 chromium-1248，本机只有 1243/1223 → 显式 `executablePath` 指 `chromium-1243/chrome-win64/chrome.exe`；③ 桩缺 preload 任何一个方法 → 渲染层 TypeError 白屏（先栽在 `getPlatform`）→ 补齐显式方法 + Proxy 兜底；④ Proxy 兜底一律返回 `{}` → `t.map is not a function`；且 **Proxy 的 `ownKeys` 陷阱**会让 `Object.keys(undefined)` 抛 "Cannot convert undefined or null to object" → 按方法名正则猜形状返回 `[]`/`{}`，**只写 `get`+`has`，不写 `ownKeys`**；⑤ MUI Tab 是 `button[role=tab]`，按文本找节点点不中 → 用 `querySelectorAll('[role="tab"]')`。
9. ⚠️ 项目 `package.json` 有 `"type": "module"` → 验收脚本必须 `.cjs` 后缀（否则 `require is not defined in ES module scope`）。
10. ⚠️ **CI 平台边界检查有注释过滤**：`grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)'` → **纯注释里提到 `window.electronAPI` / wire 字段不算越界**。用裸 grep 粗查会误报一堆注释文字；复核必须逐字跑 CI 原命令。
11. ⚠️ **workspace 隔离**：`session_manager.list_sessions()` 只扫**当前 workspace_id 目录**（`~/.nanobot/sessions/<workspace-id>/`），而 gateway 的会话根由 `get_data_dir()` = config 文件所在目录决定 → 本机落 `D:/Workspace/study/nanowork/sessions/<workspace-id>/`。找真实 IM 会话 key 要去这个目录翻，不能只看默认 `~/.nanobot`。

## B3/B4 关键 gotcha（看板只记「完成」，这里记「坑」）
- **B3-03 IM 审批**：裁决走**进程内直投**，`POST /v1/tool-approvals/{id}` 只在 serve 进程，gateway 进程各自 `PENDING_APPROVALS`→HTTP 投过去必落空。飞书 `send` 不渲染 `buttons`→契约以**文本回复**为准(允许/同意/approve/allow；拒绝/不同意/deny/reject)。必须先开 `channels.<name>.tool_approval:"ask"`(默认 auto，IM 走 `default()` 钩子不介入)。群聊同会话任一已配对成员都能拍板(未绑 sender)。测试 41 例；变异：包回 ProgressEvent→1红、去会话校验→1红、`for_turn` 退回 `default()`→2红。
- ⚠️ **B3-03 审批「挂起不出现」= 运行时渠道名 ≠ 配置段名（2026-10-20 真机根因）**：审批表键是**段名**(`feishu`)，但运行时 `InboundMessage.channel` 是**运行时渠道名** `feishu.<instanceId>`（`channels/feishu/instances.py::runtime_channel_name`；本机 `instanceId="feishu"`≠`default` → `feishu.feishu`）→ 精确查表必 miss → 退回 `auto` → 钩子直接放行。**全程零报错**，症状=IM 上写工具无审批直执行。修复在 `nanobot/security/workspace_access.py::resolve_channel_tool_approval`（精确优先→按 `channels/contracts.py::_validate_runtime_name` 契约回退段名→多段取最长；`source_channel` 保留运行时名）。⚠️ 修复留在 security 层：`channels/*` 不 import `security.*`（反向依赖成环），且 `ChannelManager` 在 `AgentLoop.from_config` **之后**构造→`_channel_owners` 映射无法在 resolver 构造期注入。判据 49→50 例（新增运行时名回退/最长优先/精确优先/未配置不误伤 + 完整闭环挂起→裁决→执行）；变异：删前缀回退→2红。**排查前先看 `module.__file__`**：本机曾有另一份已安装旧包导致误判「解析返回 {}」（差点误改 `FeishuConfig`）。
- ⚠️ **飞书 `cardkit:card:write` 只影响流式卡片**（`code=99991672`）：审批卡走**普通出站消息**（`bus/progress.py::_publish_approval`），`runtime.py:2483-2489` 仅对 `not msg.buttons` 做早退特判→**审批卡送达不需要该权限**。别把两者混为一谈。
- **B4-02 深链**：必须 `app:renderer-ready` 握手(渲染层挂监听前 `send`=静默丢)；`App.tsx` 先订阅再 `appRendererReady()`。自定义 scheme `nanowork://x`→`hostname=x`、`nanowork:///x`→`hostname=""`/`pathname="/x"`，两种都要认。`acquireSingleInstance` 回调现带 `(argv, workingDirectory)`。测试 20 例。
- **B4-01 自动更新**：`electron-updater` 必须打进 main.cjs(`builder.config` `files` 不含 node_modules)。只有 `update-not-available` 才 `up-to-date`；`error` 原样透出不许显示「已是最新」；开发态 `!app.isPackaged` 直接 `unsupported`。未签名不做运行时探测→常驻提示+发布页兜底。测试 10 例；变异：catch 改 `up-to-date`→1红。
- **B4-04 反馈包**：`SESSION_LATENCY_FILE`/`STARTUP_PROFILE_FILE` 由 `diagnostics.ts` 导出、`main.ts` 复用(各写文件名会静默「包里永远没摘要」)。延迟摘要不整份进包(坏行忽略，否则整份消失)。测试 18 例。
- **B4-03 运行时自助安装**：recipe 与 `engineSelfCheck` remedy 同源，渲染层只发「开始/取消」不传命令(否则任意代码执行)；`quote()` 复用。仅「解释器/导入」失败显「一键修复」(配置失败不给)。进度经 `engine:install-progress`；装成功主进程清 `engineSelfCheckInflight`。测试 20 例；变异：去 ANSI 清洗→1红。
- **B4 全量构建/测试因宿主内存(OOM≈1.3-2.1GB)未跑通**；复核命令：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` + `npx vitest run --maxWorkers=3`。

## 测试技巧（本轮审计沉淀，非显然）
- ⚠️ **`AgentLoop` 可用 mock 真实构造**：`AgentLoop(bus=MagicMock(), provider=MagicMock(), workspace=Path)`（已验证）。想测 `run()` 的顺序类判据时，给 bus 一个「吐一条消息后 `sleep(3600)`」的假 `consume_inbound`，`create_task(run())` 后轮询目标 future 再 `task.cancel()`，即可真实驱动一次迭代——不必重构 loop 抽出接缝。
- ⚠️ **测子代理/渠道审批必须选非 scoped 渠道**：`scoped_channels={websocket,api}` 会忽略逐渠道 `tool_approval` 映射，要用 feishu/dingtalk 之类才能得到 `ask`（用 api 会静默保持 auto，测试假绿）。
- 发送控件等无 aria-label 的 MUI 按钮，加 `data-testid` 换可测性是划算的（本轮给 Composer 发送按钮加了 `composer-send`，换来「命中注入仍能发送」这条 DoD 的真门锁）。
- ⚠️ **AST 判据解析 `if/elif` 路由链有两个陷阱（第一版同时踩了两个，路由表全空）**：① `if/elif` 在 AST 里是**嵌套**的 —— `elif` 落在前一个 `If` 的 `orelse` 里，不是平铺在 `body` 上；② 整条路由链嵌在 `async with connection_slots:` 里，**不是** `handle.body` 的直接子节点。正确解法：遍历用 `[n for n in ast.walk(handle) if isinstance(n, ast.If)]` + 单独函数只取本分支自己 `body` 里的调用（不含 `orelse` 中后续 elif 的）。
- ⚠️ **`PendingApprovals.register()` 默认用 `asyncio.get_running_loop()`** → 单元测试里必须**显式传 `loop=`**（一次性 `asyncio.new_event_loop()` + `finally: loop.close()`），否则 `RuntimeError: no running event loop`。
- ⚠️ **pytest on Windows 报 `INTERNALERROR: ValueError: 'D:\...\nanobot' is not in the subpath of 'D:\...\nanobot'`** → 路径大小写导致的 pytest `_bestrelpathcache` 内部错误，与代码无关 → 用 `--rootdir="D:/Workspace/study/nanowork/nanobot"`（forward-slash 绝对路径）。

## B5 数据驱动决策（2026-10-18，决策记录，无代码交付）
- **B5-01 关掉 CLI 预热池**：实测 `serve.spawn→listen`=4.4s(暖机)却被 app 启动并行预热覆盖；首字延迟(p50 5s/p95 47s/max 61s，15 真实样本)由远端 LLM 主导，是引擎启动 10 倍以上→预热池收益边际。
- **B5-02 采纳只读 sqlite 尺寸监控、拒绝跨进程 WAL checkpoint**：引擎确有 `llm_usage.sqlite3`(180KB)；`processes.json` 增只读 `stat` 字段约 5 行，非 V1.7 硬交付，排诊断后续小步。
- **B5-03 维持 B4-03 自助安装**：本机引擎自检 3/3 通过(解释器/导入/配置)，未触发「成功率<70%」阈值→不随包 CPython(代价 +30~50MB/签名更新复杂)。重访触发=发版后 N≥30 干净机器遥测成功率<70%。
- **B5-04 续挂口袋清单**：现有 `taskkill /T` 孤儿回收对三层进程拓扑有效、无真实诉求→不随 WorkBuddy 对齐做 Job Object/PTY/ripgrep。

## 记忆功能现状
- 三层落点真实可用；测试全绿(详情见每日日志)。
- ⚠️ 未修缺陷：`looksLikeSystemError`(`src/lib/memory.ts`)漏判三类报错文案 → 报错被写进长期记忆(详见 `2026-10-01.md`)。
