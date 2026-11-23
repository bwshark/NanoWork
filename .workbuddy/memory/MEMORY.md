# 项目长期记忆 — nanowork

React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。FR 权威：`docs/nanowork-prd-design-v2.md` 第 3 章；逐日细节 `YYYY-MM-DD.md`；**长尾细节全在 `MEMORY-archive.md`**（本文只留「不看代码就会踩坑」的硬事实，写新条目前先问：删了这条会不会有人重犯？不会就别写）。

## 硬规则（违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git，只读。`git -c safe.directory='*'` 才能读 log（否则 dubious ownership）。
- 渲染层只 `src/platform/**` 碰 `window.electronAPI`；引擎 wire 键名只在 `src/ai/runtime/nanobotHttp/**`。
- 核心/测试单引号，UI 双引号；注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`（升 vitest4 必须同升 vite≥6，否则全仓 `failed to find the runner`）。
- 判超时只看 `err.name==='AbortError'`（跨 realm `instanceof` 恒 false）。
- 门禁：三套 tsc（`typecheck`/`:electron`/`:tests`）+ `vitest --maxWorkers=3 --silent` + `CODEBUDDY_SAFE_DELETE_ENABLED=0 vite build --emptyOutDir false`。**永远看退出码**——⛔ 不能经管道拿（`pytest … | tail` 的 `$?` 是 tail 的），要 `> /tmp/x.log 2>&1; echo "EXIT=$?"`。
- ⛔ 引擎 pytest 也必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`：否则清理 `%TEMP%\pytest-of-*` 被拦，症状是 `INTERNALERROR … ValueError: 'D:\…\nanobot' is not in the subpath of 'D:\…\nanobot'`——两个**完全相同**的路径比较失败，极易误判成代码问题。
- 引擎全量有 **9 条环境红**（沙箱无外网 → mcp_probe/mcp_tool/web_fetch 的 ConnectError、pdf 提取缺依赖、`session_handles` 的 Windows 文件锁 `WinError 5`），改代码前先看是不是这些。
- ⛔ `lambda msg: coro(...)` 会被 `tests/gateway/test_health_route_contract.py` 判红（「协程调用点既没 await 也没被调度」，它只扫裸名字调用）→ 用 `functools.partial(coro, kw=…)`。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`；`tests/`、`tasks/` 被整目录忽略 → `git add -f`。
- 新 storage key 登记 `STORAGE_KEYS` + `electron/storageRoutes.ts::RUNTIME_FILES`。
- `src/` 不 import `electron/`；Electron 直接 import 的 8 个 lib 文件，依赖链里**不能有 `@/` 别名**。
- 变异验证：绝对路径 + 无条件备份还原 + `cmp`；绿了先查「同一规则是否写了两遍」；收尾 `git diff`。
- ⚠️ 日志/文档里的「未做」清单会过期：梳理进度**先读代码/文档核实**（11-03 就照抄过一份全过期的清单）。

## 引擎事实
- `spawn(wait=false)` 丢结果 → `/v1` 链路必须 `run_inline`。
- logger 占位符：`loop.py` loguru `{}` / `expert_group.py` `%s`，写反不报错。
- `agent/context.py` 只能在函数内 import `agent.plugins`（否则环闭）。
- `serve` 才有 `/v1/*`；`gateway` 只有 channel + `/health` + `/v1/turn(/progress)` + `/v1/send` + `/v1/cron/reload` + `/v1/approvals(/resolve)`。
- 思考在 assistant 记录的 `reasoning_content`。`hook_manifest` 唯一执行方 `agent/hooks/plugin_lifecycle.py`（**刻意不跑外部命令**）。
- 改引擎代码不用同步副本（venv 的 `nanobot.__file__` 就是仓库内那份）。
- 三条**预存**红（Windows symlink）：`test_plugin_state_symlink_cannot_escape_config_root` / `test_package_skill_rejects_symlink` / `test_workspace_policy::...symlink_escape`。
- 审计三通道：`tool-gateway.ndjson`（引擎）/ `app-operations.ndjson`（本机，camelCase）/ `app-operations.gateway.ndjson`（网关外发，serve 与 gateway 是两个进程，别混写同一文件）。

## 客户端/渲染
- ⛔ 消息渲染不分会话类型；⛔ 副作用别挂可选 UI 组件；`nextGatewayEndpoint` **只看 port**。
- ⛔ 云端 access token TTL 30 分钟 → 「`getToken` 实时取票 + 401 换票重放一次」（唯一实现 `src/lib/net/authedRequest.ts`，kbClient 是薄委托）；**绝不把 token 拷进配置快照**；装配处唯一 `src/sync/*Gateway.ts`；refresh 单飞只在 `syncAccount.refresh()`。
- ⛔ 登录态结论**只有一份**：`account.isSessionExpired()`（换票被 401/403 拒绝才置真，网络错不算）+ `useAuthIssue()`。页面别各自记 `sessionExpired` 布尔、侧栏别只看 `getSession()`——两侧各算一遍必然出现「侧栏显示登录邮箱、页面说登录已过期」。
- ⛔ Agent 新字段改三处：`types/agent.ts` + `agentsStore.buildAgent` + `mergeAgents`。
- vitest 全量必带 `--maxWorkers=3 --silent`（不加会刷 13 万行 act 告警 → `ERR_IPC_CHANNEL_CLOSED`）；`EPERM node-brokered-fs-shim` 重跑即绿。`npm run build` 偶发 vite panic → 单跑 `npx vite build` 重定向日志更稳。
- ⛔ MUI `Popper` **不传** `TransitionProps` → `<Fade {...TransitionProps}>` 的 `in` 恒 false，浮层 `opacity:0`+`visibility:hidden`（DOM/尺寸/文案全正常，只看像素才发现）。必须显式 `in appear`；jsdom 不跑 CSS transition，只能断言内联 style 没隐藏态。
- 侧边栏菜单顺序存 **id** 不存下标/文案；归一化必须补缺失项；存储侧 `normalizeStoredMenuOrder` 空表保持空表，渲染侧才补成完整顺序。
  - ⛔ **`CustomMenuPanel` 的工作副本也要过 `normalizeMenuOrder`**：它曾直接拿 store 里那串 `moreMenuOrder`（上次保存的快照，不含后来新增的行）→ 新入口只在浮层出现、面板里排不到（症状像「这行不支持排序」）。新增菜单项必须同时看这一处。
- ⛔ 拖拽落库只提交被拖那一段（两段都传会把没动过的那段从「默认」变成「已调过」）。几何判据用「列表顶 + 槽位 × **行距**」的 `pointerdown` 快照（用行高会逐行累积偏差）；会话放 `ref` 不放 state。浮层与触发器之间的缝隙要延时关闭（180ms）。
- jsdom 无布局（`getBoundingClientRect()` 恒 0）→ 测拖拽必须伪造矩形；`setPointerCapture` 是 `undefined` → 用 `?.()`。
- ⚠️ 测 MUI `Select`：**`mousedown` 才展开菜单**，选项 `[role="option"]` 渲染在 `body`。`TextField` 的 `aria-label` 在外层 div，要 `querySelector('input, textarea')`。
- ⚠️ `sx` 里 `borderRadius: 4` 实测变 40px → 写像素用字符串。

## 语音（STT / 语音讨论）
- ⛔ 引擎 `serve` **没有** `/audio/transcriptions` → 客户端**直连服务商**；百炼走 `POST /chat/completions`（base64 进 `input_audio.data`，只有 `qwen3-asr-flash` 吃内联）。上传前转 **16kHz 单声道 WAV**。
- ⛔ 实时流式鉴权**只能** `?api_key=`；中间结果事件是 **`transcription.delta`**；commit 后**不发** `session.finished`（静默 600ms 收尾）。
- ⛔ Electron 默认**拒绝所有 media 权限**（`setPermissionRequestHandler` + `setPermissionCheckHandler` 两个都要设）；Windows 最常见是 `NotReadableError`（设备被占用）→ 用 `err.name` 判。
- ⛔ 语音讨论自激回声：播报前就开 ASR → 音频闸门（`gateOpenRef`）+ 文本兜底 `isEchoTranscript()`（Dice≥0.82）。点麦克风会让输入区失焦 → 开录时记 `voiceAnchorRef`。
- 全文（模型额度、波形、WS 细节、配色）见 archive「语音输入（STT）」小节。

## 产物（FR-7.2/7.4/7.5）
- ⛔ 圈选改写用 **textarea 取选区**，不在渲染后的 DOM 上圈选（`selectionStart/End` 本身就是原文偏移）。
- ⛔ 改写结果**不能用 `trim()`**（缩进是语义）→ 用只去首尾空行的 `trimBlankEdges`；剥代码围栏判据是「整段**恰好**一层」。
- ⛔ 改写用独立 `sessionId`（`rewrite:<artifactId>`）：`abort` 按会话键寻址，借真实 id 会打断正常对话。改写不回写磁盘（只改索引正文）。
- ⛔ jsdom **没有** `setSelectionRange` → `defineProperty` 设 `selectionStart/End`；合成 **`select` 事件不触发 React `onSelect`**，必须派发 `mouseup`（否则用例 5s 超时）。
- 产物归属是**派生**的（产物 → 会话 → 项目），⛔ 不在产物上冗余存 `projectId`；按轮聚合、重放不幂等 → `hasContentHashInHistory`。

## 组织资产 / 知识库 / 内置模型（细节见 archive 与 `docs/fr-2-6-org-assets.md`）
- ⛔ 组织资产**发布的是快照不是引用**；载荷白名单构造（黑名单式会随新字段静默泄露）；服务端递归拒 `path`/`imBinding`（客户端剥是为体验，服务端拒是兜底）；编辑**只开名称/说明，不开载荷**，换内容必须撤回重发。
- ⛔ 知识库 `kbIds: []` = 组织可见**全部**库（与 `toolAllow: []` 方向相反，两处不共用归一函数）；可见性唯一实现 `kb/visibility.py::allows()`；个人库 = `Organization.kind=personal` + 其下一本普通库（⛔ 不加 `owner_user_id` 分叉）；⛔ 个人库不在 `kbsByOrg` → 「选中库不在列表就清空」会踢掉它（用 `personalKbRef` 排）。
- ⛔ 知识库正文以 Markdown 为唯一存储格式；`src/lib/kb/richText.ts` 必须有 `table`/`img` 分支（否则**静默吞掉**）；`<img src>` 不带 Authorization → 带票取字节换 `blob:`（`urlTransform` 会清 blob，放行留在 `MarkdownRenderer` 内部）。
- ⛔ 加列迁移走 `migrations.py::ADDED_COLUMNS`（DDL 带 DEFAULT，只加不改不删）；判据必须在**自建 engine** 上跑。
- 内置模型：种子只插缺失 id；⛔ 写接口没配 admin token 回 **404 而非 403**；模型菜单 `anchorOrigin` 显式向上（632px 高窗口 flip 不生效）。

## 本机环境坑（高频，全文见 archive）
- ⛔ **工作区是 VMware 共享目录，派生进程（bash/node/powershell）对它只有读权限**（2026-11-17 实测）：`touch` 即 Permission denied，而 Write/Edit 工具能写（进程令牌不同）。后果：**门禁里的 `vitest` 与 `vite build` 跑不了**（都要在配置旁写临时文件 / 写 dist），`tsc --noEmit` 与云端 `pytest` 可以。四种绕法全失败（`.mjs` 配置 / UNC 根 / junction / symlink / file:// alias）——根因是共享名 `Shared Folders` **带空格**，vite 归一化把 `/Shared` 吃掉变成 `Z: Folders/...`。→ 全量测试与 UI 用例交给用户本机终端跑。
- ⛔ 云端 venv 也是坏的（base 指向不存在的 `D:\Tools\miniconda3`）→ 用系统 `python` 直接 `pip install` 云端依赖后 `cd cloud && python -m pytest tests/`（网络可用）。
- ⛔ 云端跑在容器 `nanowork-cloud`(8910)：改 `cloud/app/**` **必须重建镜像**（`docker restart` 是旧代码）。症状「某页全 Not Found 但 `/health` 200」→ `cd cloud && python docker/verify.py --routes-only`。
- ⛔ **沙箱内 docker 引擎不可达**（2026-11-03 实测）：`version`/`ps`/`images` 全部**无输出且退出码 0**；`wsl.exe` 被硬拦。→ 重建镜像由用户在本机终端跑；我这边用「原生 uvicorn + 备用端口 + `verify.py --routes-only`」验证。
- ⛔ 从 WorkBuddy 宿主起引擎必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`；默认拒绝写入（FR-8.4）引擎 `default_deny_write=True` 与客户端 `DEFAULT_DENY_WRITE=true` 逐字一致（`_FsTool` 参数默认 **False**，用例钉住两层必须相反）。
- ⛔ IM 发言不能走 `/v1/chat`（落 `api:<id>` 新会话、零报错），必须 gateway `POST /v1/turn`。`tool_deny` 按工具名不按能力。
- ⛔ 验 FR-8.3 回收站**别用 `%TEMP%` 下路径**（临时目录内是直删）；`HTTP_PROXY` 会让 urllib 把 127.0.0.1 交给代理 → 502。
- 默认模型免费档限流 → 验收脚本先 `wait_for_quota()`。

## 打包交付
- 入口唯一 `node scripts/build-installer.mjs [--platform win|mac|linux] [--arch x64|arm64]`；⛔ 架构与 `build/rt` 必须成对。
- ⛔ `build-engine.mjs::relativizeSymlinks()` **不能删**（`uv python install` 的绝对路径符号链接会让用户机 `bin/python3` 悬空，而构建机自检仍绿 = 假绿）。判据与 mac/linux 细节见 archive。
