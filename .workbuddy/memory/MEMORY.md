# 项目长期记忆 — nanowork

WorkBuddy 式智能体客户端：React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。FR 状态索引见 `docs/README.md` §九 看板；本文件只记**看板/代码推导不出的架构事实**。逐日细节见同目录 `YYYY-MM-DD.md`；长尾细节（验证铁律详版 / B3-B4 坑 / 测试技巧详版 / B5 决策 / 审批卡详版 / 产物登记详版 / FR-8.4 详版 / 客户端事实详版）见 `MEMORY-archive.md`。

## 硬规则（CI 门禁，违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git 且对象库受损 → 只读。
- 渲染层只 `src/platform/**` 认识 `window.electronAPI`(CI检查一)；引擎 wire 键名只 `src/ai/runtime/nanobotHttp/**`(CI检查二)。
- 核心逻辑/测试单引号；UI 双引号。注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`；升 vitest4 必须同升 vite≥6。
- 判超时只看 `err.name==='AbortError'`(跨 realm `instanceof Error` 恒 false)。
- 门禁三套 tsc 一起跑(`typecheck`/`typecheck:electron`/`typecheck:tests`；tests 不在 build 内)。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`(esbuild, external:electron)。
- 门禁 `--maxWorkers=3`；全量带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`(否则 `fs.rm` 被安全删除守卫拦→假报12失败)。永远看退出码。
- `tests/` 被 `.gitignore` 整目录忽略 → 新测试 `git add -f`。
- 写 `platform.storage.set` 新 key 要登记 `STORAGE_KEYS`；裸字符串别落 json 路由(主进程 `JSON.parse` 必崩)。
- 引擎 `Base` `extra="ignore"`：未声明键静默丢弃 → 新增声明式字段先改 `schema.py`+加往返用例。
- ⚠️ **CI 平台边界检查有注释过滤**：`grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)'` → 纯注释里提到 `window.electronAPI` 不算越界；复核必须逐字跑 CI 原命令（裸 grep 粗查会误报一堆注释文字）。

## 引擎架构事实（不可从代码直接推断）
- ⚠️ `spawn(wait=false)` 丢结果：serve 进程无 inbound 消费者(唯一 `consume_inbound` 在 `AgentLoop.run()`)。FR-2.4/编排用 `run_inline` 直接 await。
- ⚠️ 两套 logger 占位符不同：`loop.py` loguru(`{}`)、`expert_group.py` 标准 logging(`%s`)。写反不报错。
- ⚠️ `agent/context.py` 里 `from nanobot.agent.plugins import ...` 只能函数内局部导入(否则 `agent/__init__`→plugins→config.loader 环闭→`schema.py` `_resolve_tool_config_refs` 静默失败→`Config.model_validate` 报 `WebToolsConfig not fully defined`)。`agent/__init__` 半初始化→测试首行加 `import nanobot.agent` 绕开。
- 端口职责：`serve` 才提供 `/v1/*` REST(`/v1/models`、`/v1/dream/*`)；`gateway` 只有 channel + `/health` + `/v1/turn` + `/v1/send` + `/v1/turn/progress` + `/v1/cron/reload` + `/v1/approvals` + `/v1/approvals/resolve`；其余 `/v1/*` 一律 404。两进程两端口。
- ⚠️ 引擎把思考写进 assistant 记录的 **`reasoning_content`**（纯文本；兼容 blocks 数组 / `{text}` 对象），客户端映射层必须读它，否则助理/定时任务视图**有工具行但无「深度思考」**。见 `recordReasoning`；思考段与工具行**按到达顺序交错**，连续 reasoning 累积成一段，空思考不建段。
- ⚠️ `list_webui_sessions` 除 `sessions_dir` 外还扫**全局** webui transcript 目录 → 依赖行数的断言在开发机上必红。`RecoveryCoordinator._recovery_candidates` 包 `except Exception` → 桩缺 `locked_session_files`/`sessions_dir` **不报错**，只留 traceback + 恢复发现静默降级。

## 产物登记的两条路径（2026-10-19）
- 任务会话：`handleProcessTool`(phase=end)→`deriveFileArtifacts`→`handleArtifact`；富产物是流结束后 `extractArtifacts(全文)` 跑一次。
- 导入会话（IM 频道 / 定时任务）：**推理在引擎侧**，本地只有磁盘 JSONL 重放 → 登记时机只有 `sessionsStore.openExternal`（6 个调用点的唯一入口），由 `sessionImport.attachImportedFileArtifacts` / `attachImportedTextArtifacts` 补齐。判据刻意与上面同套。
- ⚠️ nanobot JSONL 把一轮拆成 `assistant(tool_calls)`→`tool`→`assistant(正文)`；`mapRecordsToMessages` 必须**按轮聚合**（user 是轮边界），否则一轮裂成两个「助手」气泡。
- ⚠️ **`recordArtifact` 对「整段历史重放」不幂等**：4 秒轮询重建 Session 会把版本链叠长(v2→v4)。登记前用 `hasContentHashInHistory` 跳过已在版本链里的 hash。
- ⚠️ 断言产物正文别读 `bySession[i].content`（恒空串），要 `resolveArtifactContent(entry.contentHash, bodies, '')`。
- ⛔ **IM 会话发言绝不能走 `/v1/chat`**：引擎 `api/server.py` 执行 `session_key = f"api:{session_id}"` → 落进与 IM 无关的新会话，**全程零报错**。IM 内发言必须用 gateway `POST /v1/turn`。

## 客户端/渲染事实（不可从代码直接推断）
- ⛔ 消息渲染**不分会话类型**：`MessageStream` 对任务/助理/定时任务同一套组件；两类视图差异在**数据侧**不在渲染层。
- ⛔ 副作用别挂可选 UI 组件：网关地址自动对齐已下沉到 `connectionManager.probeOnce()`，判据只有 `applyGatewayEndpointInfo` 一处。
- ⚠️ 网关地址同步判据 `nextGatewayEndpoint` **只看 `port`**（主进程仅端口验证监听后才写）。复用外部网关 `running=false` 但 `port` 有值是最需对齐场景，**别加回 `running` 判据**。
- ⚠️ `nanowork.config.json` 是 camelCase(`modelPresets`/`modelPreset`/`fallbackModels`/`providerRetryMode`)。
- ⚠️ vitest 全量偶发 `EPERM ... node-brokered-fs-shim` → worker 崩 → `ERR_IPC_CHANNEL_CLOSED`。是沙箱拦读文件，同命令重跑即绿。
- ⚠️ **依赖方向**：`src/` **不从 `electron/` import**；`electron/` → `src/` 方向既有（`electron/storageRoutes.ts:9` 运行时 import `../src/lib/constants`）。跨侧共享的常量下沉到 `src/` 侧（例：`DEFAULT_DENY_WRITE` 在 `src/lib/constants.ts`）。
  `src/lib/constants.ts` 的 `@/types` 是 **type-only** import → esbuild 擦除 → 主进程 import 该文件**不会**牵进 `@/` 别名（**已实测**，`src/lib/constants.ts:46-47` 那条相反的旧注释是错的）。

## 桌面端 IM 审批卡（2026-10-20 收口，真机 C.8 全链路通过）
- **三条通道不能混**：任务视图=SSE `approval_request`/serve 进程/`POST /v1/tool-approvals/{id}`；**助理视图=轮询 gateway `GET /v1/approvals`（会话级快照，无游标）/gateway 进程/`POST /v1/approvals/resolve`**。
- ⛔ **IM 轮次是渠道入站触发，桌面端是旁观者** → `turn_progress.begin()` 没登记这一轮 → 桌面端只能自己轮询。
- ⛔ **裁决必须打 gateway 18790，不能打 serve 18900**：两进程各有一张模块级 `PENDING_APPROVALS` → 打错进程 409 → **点了「允许」什么都没发生，全程零报错**。
- ⚠️ **session_key 三段必须对齐**：渠道 `f"{self.name}:{chat_id}"` → 引擎磁盘 `feishu.feishu:ou_...` → 网关 `f"{channel}:{chat_id}"` → 桌面端 channel=`key.split(':')[0]`，chatId 用 `channelChatId()`（**不能用 `split(':')[1]`**，chatId 可含冒号）。
- ⚠️ **「漏 await」是网关路由层的静默杀手**：`async def _handle_approvals` 但路由处不 await → 协程对象解包 → 端点恒 500 → 客户端静默吞 → **审批卡永远不出现，全程零报错**。已修为同步 `def`。判据 `nanobot/tests/gateway/test_health_route_contract.py`（AST，12 例）。
- ⚠️ **外部进程改不了进程级 `PENDING_APPROVALS`** → 真机触发挂起只能走渠道入站（`POST /v1/turn` 投 inbound）。工具 `tools/inject_pending_approval.py`。
- 客户端落点：`src/stores/channelApprovalsStore.ts`（1 秒轮询 + 乐观出队 + `MAX_FAILURES=8` + `unsupported` 立即停）+ `src/components/ChannelApprovalCard.tsx` + `src/pages/chat/ChatPage.tsx`（`session?.channel` 决定渲染 Channel/Task 审批卡，**互斥**）。
- ⚠️ **平台层依赖方向铁律**：`electron/main.ts` 也 import `src/platform/types.ts` → 平台层是渲染层与主进程**共同底座** → `ApprovalDecision` 下沉到 `src/types/permission.ts`，`src/ai/runtime/types.ts` 改为 `export type {X} from` + **同时** `import type`（否则 TS2304）。
- 真机证据：allow 路径文件真创建 + deny 路径真没创建；卡片贴底（top:726/bottom:900）。截图 `docs/evidence/approval-card-ui.png`。

## FR-8.4「默认拒绝写入」默认值收口为 true（2026-10-21，用户决策）
- **决策**：PRD §11.2「白名单制=不配即从严」→ `defaultDenyWrite` 默认改 **true**（原先 false = 没配这个键的机器哪里都能写，与 PRD 相反）。
- ⚠️ **三层默认刻意不同，不可套用**：配置层 `FileToolsConfig.default_deny_write`=**True**（产品策略）；客户端 `src/lib/constants.ts::DEFAULT_DENY_WRITE`=**true**（**必须与引擎逐字一致**，不一致 → 界面说开着引擎在放行，零报错）；`_FsTool.__init__` 参数默认=**False**（upstream 兼容边界，`memory.py` 依赖）；`resolve_allowed_path(deny_write_by_default=)` 函数参数默认=**False**。
  ⛔ **`sed` 批量替换会把配置层与参数层一起改**（本轮真踩到）→ 判据 `test_fs_tool_parameter_default_stays_false` 钉住「两层必须相反」。
- **影响面精确边界**：**只在 full 模式生效**（判据 `allowed_root is None and not files`）——restricted 模式**零影响**；**删除同样被拦**（走写解析路径）；**读不受影响**；`pathRules` 是 full 模式**唯一放行出口**（具体胜笼统），但规则**不能放宽边界** → restricted 下无效。
- ⚠️ **本机所有会话都落 full 模式**（`restrictToWorkspace: false` ⇒ 普通会话不下发 `access_mode` → `default_access_mode(False)`=`"full"`，**含未勾「完全访问」的普通会话**）→ 改默认后无 `pathRules` 时**写与删全被拒**。已加 `C:/Users/xinmi/NanoWork` 放行规则。引擎读的是**仓库内** `nanowork.config.json`（被 `.gitignore:36` 忽略）。

## 引擎统一配置（2026-10-17 收尾）
- 覆盖配置 `$APPDATA/nanowork/nanowork.nanobot.json`：现**不写 bin**（回落两层 venv），显式 `config=D:/Workspace/study/nanowork/nanowork.config.json`（无内联密钥，凭据走 `DASHSCOPE_API_KEY` 环境变量）。
- ⚠️ venv 真相：**代码与网关实际只用一个 —— 两层 `nanobot/nanobot/.venv`**（Python 3.13.12，editable install 指向 `D:\Workspace\study\nanowork\nanobot` → **只有一份代码**）。一层 `nanobot/.venv` 是 uv 建的遗留，**无任何代码引用**，可删。
  ⚠️ **跑引擎测试的路径**：venv 在**两层**（`nanobot/nanobot/.venv`），测试在**一层**（`nanobot/tests/`）→ `cd nanobot && ./nanobot/.venv/Scripts/python.exe -m pytest tests/`。
- ⚠️ 渠道依赖自动安装会搞坏 venv（lark-oapi 降级 websockets → 删 `.pyd` 被占 → 半装）。防复发：依赖预装进活动 venv；必 `--reinstall`。
- ⚠️ `readLaunchConfigFromDisk`：override 写 bin 会丢 `-m nanobot`。真实命令 `gateway --foreground --config <path> -v`。不带 `--foreground` 会 daemon 化，`timeout` 杀不干净。
