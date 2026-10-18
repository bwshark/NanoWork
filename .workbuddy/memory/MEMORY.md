# 项目长期记忆 — nanowork

WorkBuddy 式智能体客户端：React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。完整 FR 状态索引见 `docs/README.md` §九 看板。

## 硬规则
- ⛔ 模型不得执行任何 git 写操作(提交/推送由用户定)；`nanobot/` 独立 .git 且对象库受损 → 只读。
- 渲染层只 `src/platform/**` 认识 `window.electronAPI`(CI检查一)；引擎 wire 键名只 `src/ai/runtime/nanobotHttp/**`(CI检查二)。
- 核心逻辑/测试单引号；UI 混用双引号 → 先看现有风格别整体格式化。注释写「为什么」。
- ⛔ `vitest` 与根 `vite` 同代：锁 `vitest@3.2.7`+根 `vite@5.4.21`，升 vitest4 必须同升 vite≥6。
- 判超时只看 `err.name==='AbortError'`(abort 抛 DOMException，跨 realm `instanceof Error` 恒 false)。
- 门禁三套 tsc 一起跑(`typecheck`/`typecheck:electron`/`typecheck:tests`；tests 不在 build 内)。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`。
- 门禁带 `--maxWorkers=3`；全量带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`(否则 `fs.rm` 被安全删除守卫拦→假报12失败)。永远看退出码。
- `tests/` 被 `.gitignore` 整目录忽略 → 新测试 `git add -f`；`tasks/` 已补前导斜杠。
- 写 `platform.storage.set` 新 key 要登记 `STORAGE_KEYS`；裸字符串别落 json 路由(主进程 `JSON.parse` 必崩)。
- 引擎 `Base` `extra="ignore"`：未声明键静默丢弃 → 新增声明式字段先改 `schema.py`+加往返用例。

## 引擎编排/日志
- ⚠️ `spawn(wait=false)` 丢结果：serve 进程无 inbound 消费者(唯一 `consume_inbound` 在 `AgentLoop.run()`)。FR-2.4/编排用 `run_inline` 直接 await，不走总线。
- 两套 logger 占位符不同：`loop.py` 用 loguru(`{}`)、`expert_group.py` 用标准 logging(`%s`)。写反不报错。改日志前看文件 import。
- ⚠️ `**kwargs` 透传撞形参=无声改语义：透传整体进具名容器(如 `member_extra`)。
- 成员/专家模型未校验别透传 provider：配了预设目录没命中→退本轮 runtime+告警；目录为空允许透传。
- 回退链两态(`preset`|`inline`)不许拍平；失效引用让网关起不来(加载校验链每项必须存在)。
- 「查不到≠不支持」：元数据缺失一律宽松。

## 引擎 import 环 / 路径
- ⚠️ `agent/context.py` 里 `from nanobot.agent.plugins import ...` 只能函数内局部导入：`agent/__init__` 重导出 context，plugins 模块级 import `config.loader`→环闭→`schema.py` 末尾 `_resolve_tool_config_refs` 静默失败 → 任何 `Config.model_validate` 报 `WebToolsConfig not fully defined`。
- 路径规则优先级：凭据 `no_access` > 允许根包含性 > 路径规则 > `default_deny_write`。匹配=对该 kind 有表态的规则里最具体。
- 删除复用写解析路径须传 `kind='delete'`，否则 `delete=deny` 不生效。

## 客户端/渲染
- ⛔ **副作用别挂在可选 UI 组件上**：`AppLayout.tsx` 里 `{/* <ConnectionBanner /> */}` 是注释掉的，而网关地址自动对齐曾整条只活在该组件的轮询里 → 组件不渲染 ⇒ 地址永远停出厂默认 18900 ⇒ 全部 REST `ERR_CONNECTION_REFUSED`（模型列表空、Dream 面板 Failed to fetch）。已下沉到 `connectionManager.probeOnce()`（先 `alignGatewayEndpoint()` 再探），判据只有 `applyGatewayEndpointInfo` 一处。改地址/能力同步类逻辑先确认它挂在哪。
- 端口职责（2026-10-18 实测）：`serve` 才提供 `/api` REST（`/v1/models`、`/v1/dream/*`）；`gateway` 只有 channel + `/health`，`/v1/*` 一律 404。同一应用两个进程两个端口，别把 health 端口当 API 端口。
- ⚠️ 网关地址同步判据：`nextGatewayEndpoint`（src/lib/gatewayEndpoint.ts）只看 `port`（主进程仅在端口验证过监听后才写 port）。**复用外部网关时 `running=false` 但 `port` 有值——这是最需要对齐的场景**，别再加回 `running` 判据（2026-10-18 修过：加了就永远不同步 → 全部 REST `Failed to fetch`）。
- StrictMode：换请求清状态用 `key={id}` 卸载重挂，别渲染期 ref+setState。
- store 两条写路径不对称(`createAgent`/`updateAgent`/`mergeAgents`)→加新字段三处一起改，否则「保存瞬间消失/重启变回」。
- ⚠️ `.tsx` `return (<JSX>,)` 逗号运算符=tsc TS1109 但 vite/vitest 正常，报错落 `);` 行与病灶隔几十行。`return (<JSX>)` 不带逗号。
- ⚠️ Bash heredoc 给 Python 传 `"\n"` 落字面 `/n`，esbuild 报语法错且指错行 → 改文件换行用 Edit 或 `chr(10)`，改完 `grep -c '/n '` 自查。
- 可选 prop 不能当功能开关；改输入区「有没有内容」判据要两处同改(`onSend` 前置 + 按钮 `disabled` 同源)。
- ⚠️ **`nanowork.config.json` 是 camelCase**（`modelPresets` / `modelPreset` / `fallbackModels` / `providerRetryMode`）。用 snake_case 探测会读到 `None` → 误判成「没写进去」并改错地方（2026-10-18 踩过）。
- ⚠️ 模型「默认」有**两条解析路径**：`resolve_preset()`（认 `modelPreset`，运行时用）vs `resolve_default_preset()`（只读 `agents.defaults.model`，隐式 default 用）。任何「读默认模型」的新代码都要确认读的是哪条——两者不一致时界面显示与实际行为分叉且零报错。不变量：**指针有效 ⇒ defaults 6 字段与之一致**（`electron/modelDefaultsConfig.ts` 的 `syncDefaultsToPointer`）。
- ⚠️ vitest 全量偶发 `EPERM ... node-brokered-fs-shim` → worker 崩 → `ERR_IPC_CHANNEL_CLOSED` + 大量 errors。**是沙箱拦截读文件，不是用例红**；同命令重跑即绿。

## 引擎统一(2026-10-17 收尾)
- 用户决策：统一到本仓 study 副本，桌面也跑本仓。study 引擎自洽(`gitstore.py` 含 FileLock、启动器指向本仓 venv、`nanobot_ai 0.3.0` 已装)。
- 覆盖配置 `$APPDATA/nanowork/nanowork.nanobot.json`：现**不写 bin**(回落代码兜底两层 venv `nanobot/nanobot/.venv`)，显式 `config=D:/Workspace/study/nanowork/nanowork.config.json`(无内联密钥，凭据走 `DASHSCOPE_API_KEY` 环境变量)。
- ⚠️ 两个 venv 并存：网关实测用一层 `nanobot/.venv`；代码兜底 `engineInterpreterCandidates` 解析两层 `nanobot/nanobot/.venv`。override 不写 bin 时走两层(自带 lark_oapi、websockets 15.0.1)。
- ⚠️ 渠道依赖自动安装会搞坏 venv：`channels.feishu` 有真实实例→启动自动 `uv pip install`→lark-oapi 要求降级 websockets(16.1.1→15.0.1)，卸载时 `.pyd` 被占→拒绝访问→包删一半没装回→`ModuleNotFoundError`。防复发：渠道依赖预先装进活动 venv；`websockets` dist-info 仍在时普通安装判定 satisfied 静默跳过，必须 `--reinstall`。
- ⚠️ `readLaunchConfigFromDisk`：override 写 bin 会丢掉 `-m nanobot`(`args: cfg.bin?[]:fallback.args`)。真实命令 `gateway --foreground --config <path> -v`。不带 `--foreground` 的 gateway 会 daemon 化，`timeout` 杀不干净。

## 真机验证铁律
1. 布局量几何(`getBoundingClientRect`+`getComputedStyle`)别只看截图 2. Playwright `args:['--no-proxy-server']`(本机 `http_proxy` 劫持 127.0.0.1) 3. dev server 与 `vite build` 不并发 4. 启动 dev 前 `mv node_modules/.vite/deps_temp_* /tmp` 5. 真机切场景每场景 `ctx.newPage()`，桩落 localStorage 且 `Object.assign` 内存对象 6. 判上游真伪 `curl --noproxy '*' -i` + `/openapi.json`。

## B3 引擎侧三件(🟡 进行中)
- **B3-01 FR-2.5 子代理委派**：②✅ `agent/tools/spawn.py` 在 `channel=="api"` 强制 `wait=True` 走 `run_inline`(结果回注)，回归用例锁死；③✅ 权限单调递减已在 study 用 `bind_workspace_scope(parent)`+`AgentToolPolicyHook` 实现，3 组回归用例。①待真机一轮；④⬜ 客户端 `subagent-group` 行类型 + 引擎经 `on_progress` 推子代理进度（`ToolContext` 无进度槽，需独立接线）。
- **B3-02 FR-4.6 Dream 闸门**：①✅ 实测 Dream 经 `build_dream_tools()` 直落 `MEMORY.md`(无 candidate/闸门) ②✅ 闸门已落：`MemoryStore` 加 candidate 生命周期(`prepare/has/compute/accept`/`reject`)，`build_dream_tools(require_review=True)` 把写工具指向 candidate 副本；手动 `/dream` + cron `on_cron_job` 双路径接闸门。③✅ 客户端审查页已落：引擎加 REST `GET /v1/dream/review` + `POST /v1/dream/accept`/`reject`(`_plugin_workspace` 取工作区→`MemoryStore`)；`NanobotHttpRuntime` 透传 `getDreamReview/acceptDream/rejectDream`(`AgentRuntime` 接口按能力声明加可选方法，老网关无此方法时面板静默降级)；`src/pages/memory/DreamReviewPanel.tsx`(MUI，new/modified/deleted 三类 diff + 采纳/丢弃) 接入 `MemoryPage`。④✅ `DreamConfig.require_review=True` 默认开(`AgentLoop.from_config` 透传，三处 `if require_review` 分支；关掉回退「直落」旧行为)。
- **B3-03 FR-6.5 IM 审批**：①审批请求转渠道卡片(批准/拒绝+TTL) ②回调 `POST /v1/tool-approvals/{id}`(复用既有端点) ③fail-closed(渠道不可用/超时/重放一律不执行)；桌面权限弹窗不受影响(两路并存)。

## 引擎 local patch 清单(本仓 study 副本)
- `config/schema.py` `DreamConfig.require_review: bool=True` — FR-4.6 闸门开关(默认开)。
- `agent/memory.py` `MemoryStore` 增 `dream_candidate_dir` + `prepare/has/compute/accept/reject_dream_candidate` + `build_dream_tools(require_review=)` — FR-4.6 闸门核心。
- `agent/tools/spawn.py` `channel=="api"` 强制 `wait=True` — FR-2.5。
- `command/builtin.py` `cmd_dream` 接闸门；新增 `cmd_dream_review`/`accept`/`reject` — FR-4.6 命令面。
- `cli/gateway_runtime.py` `on_cron_job` Dream 分支接闸门(修过一次缩进 bug：`Dream` 块曾被误嵌进 `_silent` 进度回调，等于 cron Dream 永不执行)。
- `agent/loop.py` `AgentLoop` 增 `dream_require_review` 构造参 + `from_config` 透传 `defaults.dream.require_review`。
- `api/server.py` 新增 `GET /v1/dream/review` + `POST /v1/dream/accept`/`reject`(`_plugin_workspace` 取工作区→`MemoryStore`)，供客户端审查页用。
- 客户端：`src/ai/runtime/types.ts` `AgentRuntime` 接口按能力声明加 `getDreamReview?`/`acceptDream?`/`rejectDream?`；`chat.ts`(`NanobotClient`) 实现三方法；`runtime.ts`(`NanobotHttpRuntime`) 透传；新增 `src/pages/memory/DreamReviewPanel.tsx` 并接入 `MemoryPage`。

## 记忆功能现状
- 三层落点真实可用；测试全绿(详情见每日日志)。
- ⚠️ 未修缺陷：`looksLikeSystemError`(`src/lib/memory.ts`)漏判三类报错文案 → 报错被写进长期记忆(详见 `2026-10-01.md`)。
