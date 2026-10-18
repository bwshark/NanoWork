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

## 客户端/渲染事实（不可从代码直接推断）
- ⛔ 副作用别挂可选 UI 组件：`ConnectionBanner` 注释掉过，网关地址自动对齐已下沉到 `connectionManager.probeOnce()`，判据只有 `applyGatewayEndpointInfo` 一处。
- ⚠️ 网关地址同步判据 `nextGatewayEndpoint` 只看 `port`(主进程仅端口验证监听后才写)。**复用外部网关 `running=false` 但 `port` 有值——最需对齐场景，别加回 `running` 判据**(加了就永远不同步→全部 REST `Failed to fetch`)。
- ⚠️ `.tsx` `return (<JSX>,)` 逗号运算符=tsc TS1109 但 vite/vitest 正常，报错行与病灶隔几十行。`return (<JSX>)` 不带逗号。
- ⚠️ Bash heredoc 给 Python 传 `"\n"` 落字面 `/n` → esbuild 报语法错且指错行。改文件换行用 Edit 或 `chr(10)`，改完 `grep -c '/n '` 自查。
- ⚠️ `nanowork.config.json` 是 camelCase(`modelPresets`/`modelPreset`/`fallbackModels`/`providerRetryMode`)。snake_case 探测读到 None→误判「没写进去」。
- ⚠️ 模型「默认」两条解析路径：`resolve_preset()`(认 `modelPreset`，运行时用) vs `resolve_default_preset()`(只读 `agents.defaults.model`，隐式 default)。不一致时界面显示与实际行为分叉且零报错。不变量：指针有效⇒defaults 6 字段与之一致(`electron/modelDefaultsConfig.ts` `syncDefaultsToPointer`)。
- ⚠️ vitest 全量偶发 `EPERM ... node-brokered-fs-shim` → worker 崩 → `ERR_IPC_CHANNEL_CLOSED`。**是沙箱拦读文件，非用例红**；同命令重跑即绿。

## 引擎统一配置（2026-10-17 收尾）
- 用户决策：统一到本仓 study 副本，桌面也跑本仓。覆盖配置 `$APPDATA/nanowork/nanowork.nanobot.json`：现**不写 bin**(回落两层 venv `nanobot/nanobot/.venv`)，显式 `config=D:/Workspace/study/nanowork/nanowork.config.json`(无内联密钥，凭据走 `DASHSCOPE_API_KEY` 环境变量)。
- ⚠️ 两 venv 并存：网关实测用一层 `nanobot/.venv`；代码兜底 `engineInterpreterCandidates` 解析两层。override 不写 bin 时走两层(自带 lark_oapi、websockets 15.0.1)。
- ⚠️ 渠道依赖自动安装会搞坏 venv(`channels.feishu`→启动 `uv pip install`→lark-oapi 要求降级 websockets 16.1.1→15.0.1，卸载 `.pyd` 被占→删一半没装回→`ModuleNotFoundError`)。防复发：依赖预先装进活动 venv；必 `--reinstall`。
- ⚠️ `readLaunchConfigFromDisk`：override 写 bin 会丢 `-m nanobot`(`args: cfg.bin?[]:fallback.args`)。真实命令 `gateway --foreground --config <path> -v`。不带 `--foreground` 会 daemon 化，`timeout` 杀不干净。

## 真机验证铁律
1. 布局量几何(`getBoundingClientRect`+`getComputedStyle`)别只看截图 2. Playwright `args:['--no-proxy-server']`(本机 `http_proxy` 劫持 127.0.0.1) 3. dev server 与 `vite build` 不并发 4. 启动 dev 前 `mv node_modules/.vite/deps_temp_* /tmp` 5. 真机切场景每场景 `ctx.newPage()`，桩落 localStorage 且 `Object.assign` 内存对象 6. 判上游真伪 `curl --noproxy '*' -i` + `/openapi.json`。

## B3/B4 关键 gotcha（看板只记「完成」，这里记「坑」）
- **B3-03 IM 审批**：裁决走**进程内直投**，`POST /v1/tool-approvals/{id}` 只在 serve 进程，gateway 进程各自 `PENDING_APPROVALS`→HTTP 投过去必落空。飞书 `send` 不渲染 `buttons`→契约以**文本回复**为准(允许/同意/approve/allow；拒绝/不同意/deny/reject)。必须先开 `channels.<name>.tool_approval:"ask"`(默认 auto，IM 走 `default()` 钩子不介入)。群聊同会话任一已配对成员都能拍板(未绑 sender)。测试 41 例；变异：包回 ProgressEvent→1红、去会话校验→1红、`for_turn` 退回 `default()`→2红。
- **B4-02 深链**：必须 `app:renderer-ready` 握手(渲染层挂监听前 `send`=静默丢)；`App.tsx` 先订阅再 `appRendererReady()`。自定义 scheme `nanowork://x`→`hostname=x`、`nanowork:///x`→`hostname=""`/`pathname="/x"`，两种都要认。`acquireSingleInstance` 回调现带 `(argv, workingDirectory)`。测试 20 例。
- **B4-01 自动更新**：`electron-updater` 必须打进 main.cjs(`builder.config` `files` 不含 node_modules)。只有 `update-not-available` 才 `up-to-date`；`error` 原样透出不许显示「已是最新」；开发态 `!app.isPackaged` 直接 `unsupported`。未签名不做运行时探测→常驻提示+发布页兜底。测试 10 例；变异：catch 改 `up-to-date`→1红。
- **B4-04 反馈包**：`SESSION_LATENCY_FILE`/`STARTUP_PROFILE_FILE` 由 `diagnostics.ts` 导出、`main.ts` 复用(各写文件名会静默「包里永远没摘要」)。延迟摘要不整份进包(坏行忽略，否则整份消失)。测试 18 例。
- **B4-03 运行时自助安装**：recipe 与 `engineSelfCheck` remedy 同源，渲染层只发「开始/取消」不传命令(否则任意代码执行)；`quote()` 复用。仅「解释器/导入」失败显「一键修复」(配置失败不给)。进度经 `engine:install-progress`；装成功主进程清 `engineSelfCheckInflight`。测试 20 例；变异：去 ANSI 清洗→1红。
- **B4 全量构建/测试因宿主内存(OOM≈1.3-2.1GB)未跑通**；复核命令：`CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run build` + `npx vitest run --maxWorkers=3`。

## 测试技巧（本轮审计沉淀，非显然）
- ⚠️ **`AgentLoop` 可用 mock 真实构造**：`AgentLoop(bus=MagicMock(), provider=MagicMock(), workspace=Path)`（已验证）。想测 `run()` 的顺序类判据时，给 bus 一个「吐一条消息后 `sleep(3600)`」的假 `consume_inbound`，`create_task(run())` 后轮询目标 future 再 `task.cancel()`，即可真实驱动一次迭代——不必重构 loop 抽出接缝。
- ⚠️ **测子代理/渠道审批必须选非 scoped 渠道**：`scoped_channels={websocket,api}` 会忽略逐渠道 `tool_approval` 映射，要用 feishu/dingtalk 之类才能得到 `ask`（用 api 会静默保持 auto，测试假绿）。
- 发送控件等无 aria-label 的 MUI 按钮，加 `data-testid` 换可测性是划算的（本轮给 Composer 发送按钮加了 `composer-send`，换来「命中注入仍能发送」这条 DoD 的真门锁）。

## B5 数据驱动决策（2026-10-18，决策记录，无代码交付）
- **B5-01 关掉 CLI 预热池**：实测 `serve.spawn→listen`=4.4s(暖机)却被 app 启动并行预热覆盖；首字延迟(p50 5s/p95 47s/max 61s，15 真实样本)由远端 LLM 主导，是引擎启动 10 倍以上→预热池收益边际。
- **B5-02 采纳只读 sqlite 尺寸监控、拒绝跨进程 WAL checkpoint**：引擎确有 `llm_usage.sqlite3`(180KB)；`processes.json` 增只读 `stat` 字段约 5 行，非 V1.7 硬交付，排诊断后续小步。
- **B5-03 维持 B4-03 自助安装**：本机引擎自检 3/3 通过(解释器/导入/配置)，未触发「成功率<70%」阈值→不随包 CPython(代价 +30~50MB/签名更新复杂)。重访触发=发版后 N≥30 干净机器遥测成功率<70%。
- **B5-04 续挂口袋清单**：现有 `taskkill /T` 孤儿回收对三层进程拓扑有效、无真实诉求→不随 WorkBuddy 对齐做 Job Object/PTY/ripgrep。

## 记忆功能现状
- 三层落点真实可用；测试全绿(详情见每日日志)。
- ⚠️ 未修缺陷：`looksLikeSystemError`(`src/lib/memory.ts`)漏判三类报错文案 → 报错被写进长期记忆(详见 `2026-10-01.md`)。
