# 项目长期记忆 — nanowork

React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。
FR 权威：`docs/nanowork-prd-design-v2.md` 第 3 章；逐日细节 `YYYY-MM-DD.md`；长尾 `MEMORY-archive.md`。只记**看代码推不出来**的事。

## 硬规则（违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git，只读。
- 渲染层只 `src/platform/**` 碰 `window.electronAPI`；引擎 wire 键名只在 `src/ai/runtime/nanobotHttp/**`。
- 核心/测试单引号，UI 双引号；注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`（升 vitest4 必须同升 vite≥6，否则全仓 `failed to find the runner`）。
- 判超时只看 `err.name==='AbortError'`（跨 realm `instanceof` 恒 false）。
- 门禁：三套 tsc（`typecheck` / `:electron` / `:tests`）+ `vitest --maxWorkers=3 --silent` + `CODEBUDDY_SAFE_DELETE_ENABLED=0 vite build --emptyOutDir false`。**永远看退出码**。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`；`tests/`、`tasks/` 被整目录忽略 → `git add -f`。
- 新 storage key 登记 `STORAGE_KEYS` + `electron/storageRoutes.ts::RUNTIME_FILES`。
- 换行多为 CRLF（个别新文件 LF）→ 批量 Edit 前先探。
- `src/` 不 import `electron/`；Electron 直接 import 的 8 个 lib 文件，依赖链里**不能有 `@/` 别名**。

## 引擎事实
- `spawn(wait=false)` 丢结果 → `/v1` 链路必须 `run_inline`。
- logger 占位符：`loop.py` loguru `{}` / `expert_group.py` `%s`，写反不报错。
- `agent/context.py` 只能在函数内 import `agent.plugins`（否则环闭）。
- `serve` 才有 `/v1/*`；`gateway` 只有 channel + `/health` + `/v1/turn(/progress)` + `/v1/send` + `/v1/cron/reload` + `/v1/approvals(/resolve)`。
- 思考在 assistant 记录的 `reasoning_content`。
- `hook_manifest` 唯一执行方 `agent/hooks/plugin_lifecycle.py`，**刻意不跑外部命令**。
- 改引擎代码不用同步副本（venv 的 `nanobot.__file__` 就是仓库内那份）。
- 三条**预存**红（Windows symlink）：`test_plugin_state_symlink_cannot_escape_config_root` / `test_package_skill_rejects_symlink` / `test_workspace_policy::...symlink_escape`。
- 审计两通道：`tool-gateway.ndjson` + `app-operations.ndjson`（camelCase）。

## 客户端/渲染
- ⛔ 消息渲染不分会话类型；⛔ 副作用别挂可选 UI 组件；`nextGatewayEndpoint` **只看 port**。
- ⛔ 云端 access token TTL 30 分钟 → 「`getToken` 实时取票 + 401 换票重放一次」，**绝不把 token 拷进配置快照**；装配处唯一 `src/sync/kbGateway.ts`；refresh 单飞只在 `syncAccount.refresh()`。
- ⛔ Agent 新字段改三处：`types/agent.ts` + `agentsStore.buildAgent` + `mergeAgents`。
- vitest 全量必带 `--maxWorkers=3 --silent`（不加会刷 13 万行 act 告警 → `ERR_IPC_CHANNEL_CLOSED`、拿不到汇总行）；`EPERM node-brokered-fs-shim` 重跑即绿。
- `npm run build` 偶发 vite panic → 单跑 `npx vite build` 重定向日志更稳。

## 知识库（M7）
- 绑定：渲染层每轮预取。⛔ `kbIds: []` = 组织可见**全部**库（与 `toolAllow: []` 方向相反）；provider 靠 `setKnowledgeSearchProvider` 注入（否则成环）；检索不到不注入任何段。
- ⛔ 正文以 Markdown 为唯一存储格式，解析产 GFM 管道表格；检索投影不落库、按 `\n\n` 逐段算，词法与 embedding 共用同一函数。
- ⛔ `src/lib/kb/richText.ts` 必须有 `table`/`img` 分支（否则**静默吞掉**）；单元格包 `<div>`；对齐用 `data-align`；别给 `th` 设默认 `text-align`。
- ⛔ `<img src>` 不带 Authorization → 带票取字节换 `blob:`；react-markdown `urlTransform` 会清 `blob:` → 放行留在 `MarkdownRenderer` 内部（不外提，772KB）。
- ⚠️ `sx` 里 `borderRadius: 4` 实测变 40px → 写像素用字符串。
- 可见性唯一实现 `kb/visibility.py::allows()`；个人库 = `Organization.kind=personal` + 其下一本普通库（⛔ 不给 `knowledge_bases` 加 `owner_user_id` 分叉）；⛔ 个人库不在 `kbsByOrg` → 「选中库不在列表就清空」会把它踢掉（用 `personalKbRef` 排）。
- 加列迁移走 `migrations.py::ADDED_COLUMNS`（DDL 带 DEFAULT，只加不改不删）；判据必须在**自建 engine** 上跑。图表只做静态图 + 数值抽取。

## 内置模型（云端下发）
- `builtin_models` 全局表 + `GET /api/models/builtin`（登录可读）；⛔ 种子只插缺失 id；⛔ 写接口没配 admin token 时回 **404 而非 403**。
- 客户端 `App.tsx` 注入 fetcher（modelsStore 不能 import `sync/runtime`）；播种判据「预设名不在 managed 里」，不比对值。

## 本机环境坑
- ⚠️ 云端跑在容器 `nanowork-cloud`(8910)：改 `cloud/app/**` **必须重建镜像**（`docker restart` 与无 `--build` 的 up 都是旧代码）。
- Docker CLI 不在 PATH：`%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`。
- ⚠️ `HTTP_PROXY` 会让 urllib 把 127.0.0.1 交给代理 → 502（脚本用 `ProxyHandler({})`）。
- ⚠️ 重启 8910 前确认 PID 已换新（旧进程占着时新进程 `WinError 10048` 退出，`/health` 仍 200）。
- ⚠️ 云端 pytest **别加 `-q`**（Windows 不打汇总行）。
- 变异验证：绝对路径 + 无条件备份还原 + `cmp`；绿了先查「同一规则是否写了两遍」；收尾 `git diff`。
- 默认拒绝写入（FR-8.4）：引擎 `default_deny_write=True` 与客户端 `DEFAULT_DENY_WRITE=true` 逐字一致；`_FsTool` 参数默认 **False**（用例钉住两层必须相反）。
- ⛔ IM 发言不能走 `/v1/chat`（会落 `api:<id>` 新会话、零报错），必须 gateway `POST /v1/turn`。
- 产物登记：任务会话 `handleProcessTool`→`deriveFileArtifacts`；导入会话只有 `sessionsStore.openExternal`；按轮聚合，重放不幂等 → `hasContentHashInHistory`。
- 专家包 `nanowork.expert/v1`：缺技能不阻塞 / 缺预设丢弃 / `toolAllow: []` 原样保留。
- 默认模型 `agnes-3.0-flash` 免费档限流 → 验收脚本先 `wait_for_quota()`。
- ⛔ 从 WorkBuddy 宿主起引擎必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- `tool_deny` 按工具名不按能力（deny `write_file` 后子代理会用 `apply_patch`/`exec`）。
- ⚠️ 验 FR-8.3 回收站**别用 `%TEMP%` 下的路径**：临时目录内的删除是**直删**（返回 `Deleted (temp directory, not recycled)`），`defaultDenyWrite` 仍会拦，但「是否进回收站」验不出来。
- Dream 输入只有 `memory/history.jsonl`；`/dream` 是后台任务，候选轮询 `GET /v1/dream/review`。
- ⚠️ 写入工具会把形似凭据的字面串换成 `***` → 测试口令拆写并 `repr` 复核。
- venv 只有 `nanobot/nanobot/.venv`；引擎测试 `cd nanobot && ./nanobot/.venv/Scripts/python.exe -m pytest tests/`。

## 打包交付
- 入口唯一 `node scripts/build-installer.mjs [--platform win|mac|linux] [--arch x64|arm64]`；⛔ 架构与 `build/rt` 必须成对，不一致直接 fail。
- ⛔ `uv python install` 的符号链接是绝对路径 → `build-engine.mjs::relativizeSymlinks()` **不能删**（否则 `bin/python3` 悬空且 electron-builder `EEXIST symlink`，构建机自检仍绿 = 假绿）。
- mac / linux 打包、安装包判据、Electron 验证命令见 archive 同名小节；改依赖后跑 `npm ci --dry-run`。
