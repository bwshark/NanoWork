# 项目长期记忆 — nanowork

React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。
FR 权威：`docs/nanowork-prd-design-v2.md` 第 3 章；逐日细节 `YYYY-MM-DD.md`；长尾 `MEMORY-archive.md`。本文件只记**看代码推不出来**的事。

## 硬规则（违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git，只读。
- 渲染层只 `src/platform/**` 碰 `window.electronAPI`；引擎 wire 键名只在 `src/ai/runtime/nanobotHttp/**`（两条 CI grep 带注释过滤，复核要逐字跑原命令）。
- 核心逻辑/测试单引号，UI 双引号；注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`；升 vitest4 必须同升 vite≥6（否则全仓 `failed to find the runner`）。
- 判超时只看 `err.name==='AbortError'`（跨 realm `instanceof` 恒 false）。
- 门禁：三套 tsc（`typecheck` / `:electron` / `:tests`，tests 不在 build 内）+ `vitest --maxWorkers=3 --silent` + `CODEBUDDY_SAFE_DELETE_ENABLED=0 vite build --emptyOutDir false`。**永远看退出码**。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`。
- `tests/`、`tasks/` 被 .gitignore 整目录忽略 → 新文件 `git add -f`。
- 新 storage key 必须登记 `STORAGE_KEYS` + `electron/storageRoutes.ts::RUNTIME_FILES`（裸字符串落 json 路由会让主进程 `JSON.parse` 崩）。
- 引擎 `Base` `extra="ignore"` → 新声明式字段先改 `schema.py` 并加往返用例。
- 换行：多数 `.ts`/`.py` 是 CRLF（个别新文件 LF）→ 批量 Edit/replace 前先探。
- 依赖方向：`src/` 不 import `electron/`；`src/lib/` 按功能域分子目录、`tests/lib/` 同构镜像；Electron 直接 import 的 8 个 lib 文件，依赖链里**不能出现 `@/` 别名**（esbuild 打主进程会失败）。

## 引擎事实
- `spawn(wait=false)` 丢结果（serve 无 inbound 消费者）→ `/v1` 链路必须 `run_inline`。
- 两套 logger 占位符不同：`loop.py` loguru `{}` / `expert_group.py` 标准 `%s`，写反不报错。
- `agent/context.py` 只能在函数内 import `agent.plugins`，否则环闭（`WebToolsConfig not fully defined`）。
- 端口职责：`serve` 才有 `/v1/*` REST；`gateway` 只有 channel + `/health` + `/v1/turn(/progress)` + `/v1/send` + `/v1/cron/reload` + `/v1/approvals(/resolve)`。两进程两套进程级注册表。
- 思考在 assistant 记录的 `reasoning_content`（客户端不读就只有「工具行、无思考」）。
- `list_webui_sessions` 会扫全局 transcript 目录 → 依赖行数的断言在本机必红。
- `hook_manifest` 唯一执行方 `agent/hooks/plugin_lifecycle.py`（挂 turn_hooks 基线链 + subagent 一次），**刻意不跑外部命令**。
- 改引擎代码不用同步副本（venv 的 `nanobot.__file__` 就是仓库内那份）。
- 引擎测试三条**预存**红（Windows symlink）：`test_plugin_state_symlink_cannot_escape_config_root` / `test_package_skill_rejects_symlink` / `test_workspace_policy::test_resolve_allowed_path_blocks_symlink_escape`。
- 审计两通道：`tool-gateway.ndjson`（工具网关）+ `app-operations.ndjson`（`record_app_operation`，键名 camelCase，与客户端 `src/lib/audit/appAudit.ts` 同格式）。

## 客户端/渲染
- ⛔ 消息渲染不分会话类型（任务/助理/定时用同一套组件）。
- ⛔ 副作用别挂可选 UI 组件（网关地址对齐下沉 `connectionManager.probeOnce()`）；`nextGatewayEndpoint` **只看 port**（`running=false` 但有 port 正是最需对齐的场景）。
- ⛔ 云端 access token TTL 只有 30 分钟 → 一律「`getToken` 实时取票 + 401 换票重放一次」，**绝不把 token 拷进配置快照**。装配处唯一 `src/sync/kbGateway.ts`。
- ⛔ refresh 必须单飞，实现只在 `syncAccount.refresh()`（服务端轮换 + 重用检测，旧票二次即整链吊销）。
- `nanowork.config.json` 是 camelCase。
- vitest 全量固定 `--maxWorkers=3 --silent`：不加 silent 时 MUI act 告警能刷 13 万行 → `ERR_IPC_CHANNEL_CLOSED`、**拿不到汇总行**（别误判用例失败）；`EPERM node-brokered-fs-shim` 重跑即绿。
- `npm run build` 偶发 vite panic → 单跑 `npx vite build` 重定向日志更稳。

## 知识库（M7）+ 云端
- 绑定形态：渲染层每轮预取（不是引擎工具）。⛔ `kbIds: []` = 组织可见**全部**库，与 `toolAllow: []`（一个都不许）方向相反，不能共用归一。检索不到**不注入任何段**。provider 靠 `setKnowledgeSearchProvider` 注入（否则 lib↔sync/runtime 成环）。
- ⛔ Agent 上新字段必须改三处：`types/agent.ts` + `agentsStore.buildAgent` + `mergeAgents`（漏第三处的症状：给内置专家设的值重启后消失）。
- 文档解析：`.docx`（zip + document.xml）/ `.xlsx`（sharedStrings + 各 sheet `<row>`，路径靠 rels 解析，不能猜 sheet1）/ `.pptx`（`slideN.xml` 的 `<a:t>`，**按页号数字排序**）/ `.txt|md|csv`（UTF-8-sig → GB18030）/ `.pdf` 用 **pypdf 可选依赖**（`-i https://pypi.org/simple`）。上传走 **base64 JSON**、先解析后落库、8MB / 20 万字；扫描件 422（**OCR 明确不做**）；降级走 `warnings` 由客户端逐条弹。

- ⛔ **正文以 Markdown 为唯一存储格式**（检索吃纯文本，存 HTML 等于让检索啃标签）；
  `docx`/`xlsx` 解析产 **GFM 管道表格**（`w:p` 全量 iter 会把表格拍平 → 改成按
  `body` 顺序遍历 `w:p`/`w:tbl`；xlsx 空单元格在 XML 里缺失 → 按 `r="C5"` 定位列号）。
- ⛔ **检索投影不落库**：`KbChunk.text` 存 GFM 原文（详情页拼回正文要用），
  投影在 `chunking.retrieval_text()` 那一刻算；**词法排序与 embedding 必须走同一个
  投影函数**。投影要**按 `\n\n` 逐段**做（短文档的标题+段落+表格装同一块，
  「整块是表格」不成立 → 否则最常见的情况一次都不生效）。投影的价值是「列名与数据
  同一行」，不是「从零命中变命中」。
- ⛔ **转换层（`src/lib/kb/richText.ts`）必须有 `table`/`img` 分支**，否则保存时
  **静默吞掉**（不报错，每存一次丢一次）；单元格要包 `<div>`（裸文本 td 在
  contentEditable 里点不进去）；对齐用 `data-align` 不用 `style`（浏览器会改写 style）。
- 表格样式抽 `components/knowledge/docTableSx.ts` 两处共用；⛔ 别给 `th` 设默认
  `text-align`（会抹掉 remark-gfm 的 `align` 属性）。
- **图片**（已做）：独立表 `kb_assets`（`create_all` 不 ALTER）；正文存内部 scheme
  `![图注](asset:<id>)`（解析阶段是 `asset-index:<n>`，入库时换真 id）；
  ⛔ **判重按「剥离图片引用后的文本」算**（图片 id 每次入库都变，带 id 算摘要
  就永远判不出重复）；图片去重**只在同一文档内**（跨文档共享会让删 A 带走 B 的图）；
  SVG/EMF/WMF 不收（SVG 是 XSS 载体）。
- ⛔ **`<img src>` 不带 `Authorization` 头** → 只能 JS 带票取字节再换 `blob:` 地址；
  **不选签名 URL**（那给权限开旁路）。渲染前文本层替换、保存前换回 `asset:<id>`；
  图片解析必须放**页面层**（编辑器只在换文档时写 DOM，异步结果到不了编辑器）；
  ⛔ react-markdown 默认 `urlTransform` 会清空 `blob:` → 放行逻辑留在
  `markdown/MarkdownRenderer` 内部（`MarkdownView` 只透传布尔，import 它的任何
  导出都会把 772KB 拽回首屏）。
- ⚠️ **`sx` 里 `borderRadius: 4` 实测变成 40px**（被当 spacing 换算）→ 写像素用字符串。
- **插图通道**（粘贴 / 选文件）：`POST /kbs/{kb}/assets`（base64 JSON）→ 图片
  **先入库、正文后引用**（粘贴要立刻看到图）→ 代价是孤儿图，按「`doc_id` 为空且
  超 1 小时」惰性清理；⛔ **类型按内容魔数判**（改扩展名骗不过）；⛔ **保存文档时要把
  正文引用的 asset 绑定到该文档**（否则不会跟着 purge 清掉）；上传要写权限。
- ⛔ **插图的选区取用顺序是「当前选区 → 上次记下的」**：只用上次记的会插错位置
  （先粘贴的图跑到后选的文件后面，顺序反）—— 真机才发现，单测测不出。
  点「插入图片」按钮前要 `captureSelection`（文件对话框让编辑器失焦）。
- 图表：只做静态图（跟图片同路）与数值抽取，**交互式图表编辑器不做**。
- 加列迁移：`cloud/app/migrations.py` 的 `ADDED_COLUMNS`（DDL 必须带 DEFAULT）。⛔ 只加不改不删。判据必须在**自建 engine** 上跑（conftest 每例重建库，迁移分支走不到）。
- 文档生命周期：写要 admin（`allowed_roles` 只管读）；判重按切好的块算 sha256（重复 409 点名已有标题）；删除要三张表都清（vectors→chunks→documents）且校验 `doc.kb_id`。
- 可见性唯一实现 `kb/visibility.py::allows()`：**admin|owner 无条件放行**（管理豁免，否则「建完看不见也改不了」）→ member 需 `角色 ∈ allowedRoles` ∧（不按部门收窄 ∨ 我直属部门 ∈ 允许集合的子树）。⛔ 所以界面上「管理员/所有者」必须画成不可关：点得动却不改变结果 = 让人以为权限变了。
- 回收站：`deleted_at` ISO 字符串、**空串 = 活**。默认软删（块与向量留着 → 恢复即可检索），`?purge=true` 才动三张表。⛔ `deleted_at == ''` 的过滤要写在**四处**（检索候选 / 重建索引 / 列表 / 覆盖率），少一处就是「删了还能搜到」。30 天 + 惰性清理（不靠 cron）。
- `kb_documents.updated_at`（2026-10-25 加）：ISO 字符串，空串 = 老行 → `_document_view` 读时退回 `created_at`；改名/恢复打戳。列表「更新时间」读它，别拿 createdAt 冒充。
- 部门：`parent_id` 用**空串**表根（NULL 在唯一索引里互不相等）；移动校验环 / 整棵子树高度 / 同级重名；部门角色 `member/manager` 与组织角色是两个维度；**有部门范围**的库其允许部门负责人可维护，没部门范围的库仍只归组织管理员。
- pgvector：⛔ 本机无 Postgres → 未验证的路径不写。接入点只有 `vectors.load_vectors` + `retrieval.rank_by_vectors`；换实现必须用同一批用例跑。
- 知识库页布局（2026-10-25 重排版）：侧栏团队→库两级树 + 右侧「团队视图（库卡片）/ 库视图（文件列表）」，**默认不进第一个库**（否则「这个团队有什么」永远要翻好几层）。建库/新建文档/成员与权限都在弹窗或「+」菜单里 → 取值要走 `dialogRoot()`/`document`（Portal 不在挂载容器内）。

## 本机环境坑
- ⚠️ `HTTP_PROXY` 会让 urllib 把 127.0.0.1 交给代理 → 502（uvicorn 明明好好的）。验证脚本用 `build_opener(ProxyHandler({}))`。
- ⚠️ 重启 8910 前确认端口 PID 已换新：旧进程占着时新进程打完成迁移日志就 `WinError 10048` 退出，而 `/health` 仍 200（老进程在答）。
- ⚠️ 云端全量 pytest **别加 `-q`**（Windows 上不打汇总行，会被误判失败）。
- 变异验证：绝对路径 + 无条件 `cp` 备份还原 + `cmp` 校验；绿了先查「同一规则是否写了两遍」；收尾必须 `git diff` 复查。
- 默认拒绝写入（FR-8.4）：引擎 `FileToolsConfig.default_deny_write=True` 与客户端 `DEFAULT_DENY_WRITE=true` 必须逐字一致；`_FsTool` / `resolve_allowed_path` 默认 **False**（upstream 兼容）→ 有用例钉住「两层必须相反」。只在 full 模式生效。
- 产物登记：任务会话 `handleProcessTool`→`deriveFileArtifacts`；导入会话只有 `sessionsStore.openExternal`。nanobot JSONL 把一轮拆成 `assistant(tool_calls)`→`tool`→`assistant(正文)`，映射要**按轮聚合**；重放不幂等 → `hasContentHashInHistory` 跳过。
- ⛔ IM 发言不能走 `/v1/chat`（会落 `api:<id>` 新会话、零报错），必须 gateway `POST /v1/turn`。
- 专家包是单文件 JSON（`nanowork.expert/v1`）；三条反直觉：缺技能不阻塞 / 缺预设丢弃 / `toolAllow: []` 原样保留。
- 默认模型 `agnes-3.0-flash`，免费档会限流 → 验收脚本先 `wait_for_quota()`，别把「额度不够」判成「功能不对」。
- ⛔ 从 WorkBuddy 宿主起引擎必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（filelock 的 unlink 被垫片拦 → serve 退出）。
- `tool_deny` 按工具名不按能力（deny `write_file` 后子代理会用 `apply_patch`/`exec`）。
- Dream 输入只有 `memory/history.jsonl`；`/dream` 是后台任务，候选轮询 `GET /v1/dream/review`。
- venv：只有 `nanobot/nanobot/.venv` 在用；引擎测试 `cd nanobot && ./nanobot/.venv/Scripts/python.exe -m pytest tests/`。
