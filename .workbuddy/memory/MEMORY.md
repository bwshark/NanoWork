# 项目长期记忆 — nanowork

React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。FR 权威：`docs/nanowork-prd-design-v2.md` 第 3 章；逐日细节 `YYYY-MM-DD.md`；长尾 `MEMORY-archive.md`。只记**看代码推不出来**的事。

## 硬规则（违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git，只读。
- 渲染层只 `src/platform/**` 碰 `window.electronAPI`；引擎 wire 键名只在 `src/ai/runtime/nanobotHttp/**`。
- 核心/测试单引号，UI 双引号；注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`（升 vitest4 必须同升 vite≥6，否则全仓 `failed to find the runner`）。
- 判超时只看 `err.name==='AbortError'`（跨 realm `instanceof` 恒 false）。
- 门禁：三套 tsc（`typecheck`/`:electron`/`:tests`）+ `vitest --maxWorkers=3 --silent` + `CODEBUDDY_SAFE_DELETE_ENABLED=0 vite build --emptyOutDir false`。**永远看退出码**——⛔ 不能经管道拿（`pytest … | tail` 的 `$?` 是 tail 的），要 `> /tmp/x.log 2>&1; echo "EXIT=$?"`。
- ⛔ 引擎 pytest 也必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`：否则清理 `%TEMP%\pytest-of-*` 被拦（尾部 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`），症状是 `INTERNALERROR … ValueError: 'D:\…\nanobot' is not in the subpath of 'D:\…\nanobot'`——两个**完全相同**的路径比较失败，极易误判成代码问题。
- 引擎全量有 **9 条环境红**（沙箱无外网 → mcp_probe/mcp_tool/web_fetch 的 ConnectError、pdf 提取缺依赖、`session_handles` 的 Windows 文件锁 `WinError 5`），改代码前先看是不是这些。
- ⛔ `lambda msg: coro(...)` 会被 `tests/gateway/test_health_route_contract.py` 判红（「协程调用点既没 await 也没被调度」，它只扫裸名字调用）→ 用 `functools.partial(coro, kw=…)`。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`；`tests/`、`tasks/` 被整目录忽略 → `git add -f`。
- 新 storage key 登记 `STORAGE_KEYS` + `electron/storageRoutes.ts::RUNTIME_FILES`。
- 换行多为 CRLF（个别新文件 LF）→ 批量 Edit 前先探。
- `src/` 不 import `electron/`；Electron 直接 import 的 8 个 lib 文件，依赖链里**不能有 `@/` 别名**。
- 变异验证：绝对路径 + 无条件备份还原 + `cmp`；绿了先查「同一规则是否写了两遍」；收尾 `git diff`。

## 引擎事实
- `spawn(wait=false)` 丢结果 → `/v1` 链路必须 `run_inline`。
- logger 占位符：`loop.py` loguru `{}` / `expert_group.py` `%s`，写反不报错。
- `agent/context.py` 只能在函数内 import `agent.plugins`（否则环闭）。
- `serve` 才有 `/v1/*`；`gateway` 只有 channel + `/health` + `/v1/turn(/progress)` + `/v1/send` + `/v1/cron/reload` + `/v1/approvals(/resolve)`。
- 思考在 assistant 记录的 `reasoning_content`。`hook_manifest` 唯一执行方 `agent/hooks/plugin_lifecycle.py`（**刻意不跑外部命令**）。
- 改引擎代码不用同步副本（venv 的 `nanobot.__file__` 就是仓库内那份）。
- 三条**预存**红（Windows symlink）：`test_plugin_state_symlink_cannot_escape_config_root` / `test_package_skill_rejects_symlink` / `test_workspace_policy::...symlink_escape`。
- 审计两通道：`tool-gateway.ndjson` + `app-operations.ndjson`（camelCase）。

## 客户端/渲染
- ⛔ 消息渲染不分会话类型；⛔ 副作用别挂可选 UI 组件；`nextGatewayEndpoint` **只看 port**。
- ⛔ 云端 access token TTL 30 分钟 → 「`getToken` 实时取票 + 401 换票重放一次」，**绝不把 token 拷进配置快照**；装配处唯一 `src/sync/*Gateway.ts`；refresh 单飞只在 `syncAccount.refresh()`。
- ⛔ Agent 新字段改三处：`types/agent.ts` + `agentsStore.buildAgent` + `mergeAgents`。
- vitest 全量必带 `--maxWorkers=3 --silent`（不加会刷 13 万行 act 告警 → `ERR_IPC_CHANNEL_CLOSED`）；`EPERM node-brokered-fs-shim` 重跑即绿。`npm run build` 偶发 vite panic → 单跑 `npx vite build` 重定向日志更稳。
- ⛔ MUI `Popper` **不传** `TransitionProps` → `<Fade {...TransitionProps}>` 的 `in` 恒 false，浮层 `opacity:0`+`visibility:hidden`（DOM/尺寸/文案全正常，只看像素才发现）。必须显式 `in appear`；jsdom 不跑 CSS transition，只能断言内联 style 没隐藏态。
- 侧边栏菜单顺序存 **id** 不存下标/文案；归一化必须补缺失项（否则新增入口静默消失）；存储侧 `normalizeStoredMenuOrder` 空表保持空表，渲染侧才补成完整顺序。
  - ⛔ **`CustomMenuPanel` 的工作副本也要过 `normalizeMenuOrder`**：它曾直接拿 store 里那串 `moreMenuOrder`（上次保存的快照，不含后来新增的行）→ 新入口只在浮层里出现、面板里排不到（症状像「这行不支持排序」）。新增菜单项必须同时看这一处。
- ⛔ 拖拽落库只提交被拖那一段（两段都传会把没动过的那段从「默认」变成「已调过」）。几何判据用「列表顶 + 槽位 × **行距**」的 `pointerdown` 快照（用行高会逐行累积偏差）；会话放 `ref` 不放 state（`pointermove` 每帧读，setState 异步会重复算位移）。
- jsdom 无布局（`getBoundingClientRect()` 恒 0）→ 测拖拽必须伪造矩形；`setPointerCapture` 是 `undefined` → 用 `?.()`。浮层与触发器之间的缝隙要延时关闭（180ms），否则「一闪就没」。
- ⚠️ 测 MUI `Select`：**`mousedown` 才展开菜单**，选项 `[role="option"]` 渲染在 `body`（不在挂载容器）。`TextField` 的 `aria-label` 在外层 div，要 `querySelector('input, textarea')`。

## 语音输入（STT）— 细节见 archive 同名小节
- ⛔ 引擎 `serve` **没有** `/audio/transcriptions` → 客户端**直连服务商**；百炼走 `POST /chat/completions`（base64 进 `input_audio.data`，`qwen3-asr-flash` 才吃内联，`qwen-audio-*` 只吃公网 URL）。
- ⛔ 上传前转 **16kHz 单声道 WAV**（小端头、量化 32767）。实时流式鉴权**只能** `?api_key=`，中间结果事件是 **`transcription.delta`**，commit 后**不发** `session.finished`（静默收尾）。
- ⛔ Electron 默认**拒绝所有 media 权限**（`setPermissionRequestHandler` + `setPermissionCheckHandler` 两个都要设）；Windows 最常见是 `NotReadableError`（设备被占用）。
- ⛔ 语音讨论自激回声：播报前就开 ASR → 音频闸门（`gateOpenRef`）+ 文本兜底 `isEchoTranscript()`（Dice≥0.82）。

## 产物（FR-7.2/7.4/7.5）
- ⛔ 圈选改写用 **textarea 取选区**，不在渲染后的 DOM 上圈选：`Range`→原文字符偏移要处理 `<br>`/表格/被吞标记，算漏就改错段落；`selectionStart/End` 本身就是原文偏移。
- ⛔ 改写结果**不能用 `trim()`**：缩进是语义（会误判「无变化」并抹平缩进）→ 用只去首尾空行的 `trimBlankEdges`。
- ⛔ 剥代码围栏判据是「整段**恰好**一层」；按「第一个到最后一个」取会吃掉正文自带代码块的前后内容。
- ⛔ 改写用独立 `sessionId`（`rewrite:<artifactId>`）：`abort` 按会话键寻址，借真实 id 会打断正常对话。改写不回写磁盘（只改索引正文），已登记。
- ⛔ jsdom **没有** `textarea.setSelectionRange` → `defineProperty` 设 `selectionStart/End`；合成 **`select` 事件不触发 React `onSelect`**，必须派发 `mouseup`（否则用例 5s 超时）。

## 组织资产（FR-2.6，2026-11-03）
- **发布的是快照不是引用**：改本机那个专家，组织里那份不变。载荷在 `lib/orgAsset/orgAssetPayload.ts` 里**白名单构造**（黑名单式 `{...agent, path: undefined}` 会随新字段静默泄露）。
- ⛔ 服务端**拒绝**（400，递归查）`path` / `imBinding`；客户端剥是为体验，服务端拒是为兜底——漏剥的客户端必须报错而不是静默泄露本机路径。`knowledge` 也不上传（组织专属库 id）。
- ⛔ `toolAllow`/`toolDeny` 的**存在性**有语义（`[]`=一个都不许）；模型预设失效要丢弃，但**空集=目录未加载→不校验**（与 `planExpertImport` 同口径）。
- 落地三种方式（刻意不统一）：专家 `importAgent`（新 uuid，再来一份）+ 重名走导出的 `dedupeExpertName`；技能 `installSkill`，id **`org:<assetId>`**（重复导入=覆盖）；提示词 `PromptLibrary.save(kind,key,text)`（覆盖前确认）。
- ⛔ 导入不重复记账：`importAgent`/`installSkill` 已记 `agent.import`/`skill.install`，只有提示词补 `orgAsset.import`。
- 页面权限只认 `KbOrg.role`（服务端算好的），前端不重算；`POST/PATCH/DELETE` 仅 admin/owner。跨组织资产 id → 404（多组织管理员必须挡住）。
- 云端：`cloud/app/orgassets/`（`org_assets` 表，payload 存 TEXT）+ `cloud/tests/test_org_assets.py`（13 例）；新路由已进 `docker/verify.py::REQUIRED_ROUTE_PREFIXES`。客户端页 `src/pages/orgAssets/`，入口在侧栏「更多」。
- ⛔ 编辑**只开名称/说明，不开载荷**：载荷是发布时的快照、组织侧无版本链，改它等于悄悄替换别人已导入的那份（导入方本机不会变，两边对不上）。换内容必须撤回后重发。`PATCH` 只送**真正改过**的字段（整表单回传会写一次 `updated_at` 并留空审计账）。
- 端到端验证通道（沙箱里 docker 不可用时）：`NANOWORK_CLOUD_DB_URL="sqlite:///C:/…/verify.db" ./.venv/Scripts/python.exe -m uvicorn app.main:app --port 8911` + `docker/verify.py --routes-only --base-url`。2026-11-03 用真 HTTP + 真 SQLite 跑 26 项全绿（此前只有 TestClient）。

## 知识库（M7）
- 绑定：渲染层每轮预取。⛔ `kbIds: []` = 组织可见**全部**库（与 `toolAllow: []` 方向相反）；provider 靠 `setKnowledgeSearchProvider` 注入（否则成环）；检索不到不注入任何段。
- ⛔ 正文以 Markdown 为唯一存储格式，解析产 GFM 管道表格；检索投影不落库、按 `\n\n` 逐段算，词法与 embedding 共用同一函数。
- ⛔ `src/lib/kb/richText.ts` 必须有 `table`/`img` 分支（否则**静默吞掉**）；单元格包 `<div>`；对齐用 `data-align`；别给 `th` 设默认 `text-align`。
- ⛔ `<img src>` 不带 Authorization → 带票取字节换 `blob:`；react-markdown `urlTransform` 会清 `blob:` → 放行留在 `MarkdownRenderer` 内部。
- ⚠️ `sx` 里 `borderRadius: 4` 实测变 40px → 写像素用字符串。
- 可见性唯一实现 `kb/visibility.py::allows()`；个人库 = `Organization.kind=personal` + 其下一本普通库（⛔ 不加 `owner_user_id` 分叉）；⛔ 个人库不在 `kbsByOrg` → 「选中库不在列表就清空」会踢掉它（用 `personalKbRef` 排）。
- 加列迁移走 `migrations.py::ADDED_COLUMNS`（DDL 带 DEFAULT，只加不改不删）；判据必须在**自建 engine** 上跑。图表只做静态图 + 数值抽取。

## 内置模型（云端下发）
- `builtin_models` 全局表 + `GET /api/models/builtin`（登录可读）；⛔ 种子只插缺失 id；⛔ 写接口没配 admin token 时回 **404 而非 403**。
- 客户端 `App.tsx` 注入 fetcher（modelsStore 不能 import `sync/runtime`）；播种判据「预设名不在 managed 里」。

## 本机环境坑
- ⚠️ 云端跑在容器 `nanowork-cloud`(8910)：改 `cloud/app/**` **必须重建镜像**（`docker restart`/无 `--build` 的 up 都是旧代码）。症状「某页全 Not Found 但 `/health` 200」→ `cd cloud && python docker/verify.py --routes-only`。
- ⛔ Dockerfile 默认 `BASE_IMAGE=python:3.12-slim`。⛔ `failed size validation: 1691 != 1324` 是 Docker Desktop 的 Registry Mirrors 回坏 manifest → `docker pull python:3.12-slim` 换 digest。⛔ **apt 与 pip 源独立**：`APT_MIRROR=mirrors.aliyun.com PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/` 三条一起给。⚠️ 2026-11 起 slim 已是 trixie，首构建 7~8 分钟。⚠️ 构建日志全 NUL，判断僵死看**字节增长**；⛔ 日志**别经管道**（块缓冲 → 0 字节），`> /tmp/x.log 2>&1` 再 tail。
- Docker CLI 不在 PATH：`%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`。
- ⛔ **沙箱内 docker 引擎不可达**（2026-11-03 实测）：`context ls` 能读（纯本地配置），但凡要连引擎的 `version`/`info`/`ps`/`images` 全部**无输出且退出码 0**（看着像「没有容器」其实是没连上）；`wsl.exe` 被安全策略**硬拦**（黑名单，不能绕过）。→ 重建镜像只能由用户在本机终端跑 `docker compose up -d --build`；我这边改用「原生 uvicorn + 备用端口 + `verify.py --routes-only`」验证。
- ⚠️ PowerShell 里 `-Filter "Name like '%python%'"` 会被安全策略误判成 cmd 的 `%VAR%` 语法而**整条命令被拒**；改用 `Get-Process | Where-Object`。
- ⚠️ FastAPI/pydantic 邮箱校验**拒绝保留域名**：`@v.test` / `@x.local` 直接 422，验证脚本要用 `@example.com`。
- ⚠️ `HTTP_PROXY` 会让 urllib 把 127.0.0.1 交给代理 → 502（脚本用 `ProxyHandler({})`）。重启 8910 前确认 PID 已换新（旧进程占着时 `WinError 10048`，`/health` 仍 200）。云端 pytest **别加 `-q`**（Windows 不打汇总行）。
- 默认拒绝写入（FR-8.4）：引擎 `default_deny_write=True` 与客户端 `DEFAULT_DENY_WRITE=true` 逐字一致；`_FsTool` 参数默认 **False**（用例钉住两层必须相反）。
- ⛔ IM 发言不能走 `/v1/chat`（落 `api:<id>` 新会话、零报错），必须 gateway `POST /v1/turn`。
- 产物登记：任务会话 `handleProcessTool`→`deriveFileArtifacts`；导入会话只有 `sessionsStore.openExternal`；按轮聚合，重放不幂等 → `hasContentHashInHistory`。
- 默认模型 `agnes-3.0-flash` 免费档限流 → 验收脚本先 `wait_for_quota()`。
- ⛔ 从 WorkBuddy 宿主起引擎必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。`tool_deny` 按工具名不按能力（deny `write_file` 后子代理会用 `apply_patch`/`exec`）。
- ⚠️ 验 FR-8.3 回收站**别用 `%TEMP%` 下路径**（临时目录内删除是**直删**）。Dream 输入只有 `memory/history.jsonl`；`/dream` 后台任务，候选轮询 `GET /v1/dream/review`。
- ⚠️ 写入工具把形似凭据的字面串换成 `***` → 测试口令拆写并 `repr` 复核。
- ⚠️ 内置浏览器（IAB）截图超 10MiB / `dom_cua_get_visible_dom` 返回空 → 走 Playwright（`npx --no-install playwright`；包在 `~/AppData/Local/npm-cache/_npx/<hash>/node_modules/playwright`，**必须传 `executablePath`**）。`vite --strictHost` 是错 flag（`--strictPort`）。
- ⚠️ 新增 worktree 需建 node_modules 目录联接（PowerShell `New-Item -ItemType Junction`）。venv 只有 `nanobot/nanobot/.venv`；引擎测试 `cd nanobot && ./nanobot/.venv/Scripts/python.exe -m pytest tests/`。

## 打包交付
- 入口唯一 `node scripts/build-installer.mjs [--platform win|mac|linux] [--arch x64|arm64]`；⛔ 架构与 `build/rt` 必须成对，不一致直接 fail。
- ⛔ `uv python install` 的符号链接是绝对路径 → `build-engine.mjs::relativizeSymlinks()` **不能删**（否则 `bin/python3` 悬空且 electron-builder `EEXIST symlink`，构建机自检仍绿 = 假绿）。
- mac / linux 打包、安装包判据、Electron 验证命令见 archive 同名小节；改依赖后跑 `npm ci --dry-run`。
