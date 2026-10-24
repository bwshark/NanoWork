# 项目长期记忆 — nanowork

WorkBuddy 式智能体客户端：React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。
**FR 状态权威在 `docs/nanowork-prd-design-v2.md` 第 3 章**（`docs/README.md` §九 是「文档之间互相矛盾」的看板，不是 FR 看板）。逐日细节看同目录 `YYYY-MM-DD.md`；长尾细节（验证铁律详版 / B3-B4 坑 / Playwright 桩 / FR-8.4 详版 / 审批卡详版 / 产物登记详版）看 `MEMORY-archive.md`。本文件只记**看代码推不出来的事**。

## 硬规则（CI 门禁，违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git 且对象库受损 → 只读。
- 渲染层只 `src/platform/**` 认识 `window.electronAPI`（CI 检查一）；引擎 wire 键名只 `src/ai/runtime/nanobotHttp/**`（CI 检查二）。⚠️ 两条 grep 都有注释过滤，复核必须逐字跑 CI 原命令。
- 核心逻辑/测试单引号；UI 双引号。注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`；升 vitest4 必须同升 vite≥6。
- 判超时只看 `err.name==='AbortError'`（跨 realm `instanceof Error` 恒 false）。
- 门禁三套 tsc 一起跑（`typecheck`/`typecheck:electron`/`typecheck:tests`，tests 不在 build 内）。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`（esbuild，external:electron）。
- 门禁 `--maxWorkers=3`；全量带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，**永远看退出码**。⚠️ `pytest -q` 在 Windows 上**不打汇总行**（`grep passed` 抓不到会被误判失败）→ 云端全量用不带 `-q`。
- `tests/` 被 `.gitignore` 整目录忽略 → 新测试要 `git add -f`；`tasks/` 同理。
- 写 `platform.storage.set` 新 key 要登记 `STORAGE_KEYS` 与 `electron/storageRoutes.ts` 的 `RUNTIME_FILES`；裸字符串别落 json 路由（主进程 `JSON.parse` 必崩）。
- 引擎 `Base` `extra="ignore"`：未声明键静默丢弃 → 新增声明式字段先改 `schema.py` + 加往返用例。
- ⚠️ 本仓 `.ts`/`.py` **多数 CRLF**（个别新文件是 LF）→ `python` 批量 replace 前先探换行，否则断言直接不过。
- 依赖方向：`src/` **不从 `electron/` import**；`electron/` → `src/` 方向既有。跨侧常量下沉 `src/lib/constants.ts`（其 `@/types` 是 type-only → esbuild 擦除，主进程可安全 import）。

## 引擎架构事实
- ⚠️ `spawn(wait=false)` 丢结果：serve 进程无 inbound 消费者（唯一 `consume_inbound` 在 `AgentLoop.run()`）。`/v1` 链路必须 `run_inline`。
- ⚠️ 两套 logger 占位符不同：`loop.py` loguru(`{}`)、`expert_group.py` 标准 logging(`%s`)。写反不报错。
- ⚠️ `agent/context.py` 里 import `agent.plugins` 只能函数内局部导入，否则环闭 → `Config.model_validate` 报 `WebToolsConfig not fully defined`（测试首行加 `import nanobot.agent` 可绕开）。
- 端口职责：`serve` 才有 `/v1/*` REST（`/v1/models`、`/v1/dream/*`）；`gateway` 只有 channel + `/health` + `/v1/turn` + `/v1/send` + `/v1/turn/progress` + `/v1/cron/reload` + `/v1/approvals(/resolve)`；其余 404。两进程两天线，**各有自己的进程级注册表**。
- ⚠️ 思考在 assistant 记录的 `reasoning_content`（纯文本，兼容 blocks/`{text}`）→ 客户端不读它就会出现「有工具行、无深度思考」。
- ⚠️ `list_webui_sessions` 还扫**全局** webui transcript 目录 → 依赖行数的断言在开发机上必红。
- ⚠️ `hook_manifest` 原本全仓无消费者（装了带钩子的插件=零发生零报错）。FR-3.6 后唯一执行方是 `agent/hooks/plugin_lifecycle.py`，挂 `turn_hooks` 基线链 + `subagent.py` 显式挂一次，**刻意不跑外部命令**。
- ⚠️ 改引擎代码**不用另同步副本**：两层 venv 的 `nanobot.__file__` 就是仓库内 `nanobot/`。
- ⚠️ 引擎测试三条**预存**红（本机 Windows symlink 语义）：`test_plugin_state_symlink_cannot_escape_config_root`、`test_package_skill_rejects_symlink`、`test_workspace_policy.py::test_resolve_allowed_path_blocks_symlink_escape`（后者单跑也红）。
- **审计有两条通道**（都在 `security/audit.py`）：① `tool-gateway.ndjson` = 工具网关（tool/tier 形状）；② `app-operations.ndjson` = 引擎自己做的非工具动作（`record_app_operation`，dream/config/cron 三处），键名 **camelCase** 与客户端 `src/lib/appAudit.ts` 共用一套行格式。两个文件都不合并写入；客户端另有本机那份落 `<userData>/audit/`，界面按 `origin` 合并成一条时间轴。

## 客户端/渲染事实
- ⛔ 消息渲染**不分会话类型**：任务/助理/定时任务同一套组件；差异在数据侧。
- ⛔ 副作用别挂可选 UI 组件（网关地址对齐已下沉 `connectionManager.probeOnce()`）。
- ⚠️ 网关地址同步判据 `nextGatewayEndpoint` **只看 `port`**（`running=false` 但有 port 正是最需对齐的场景），别加回 `running`。
- ⛔ 云端 **access token TTL 只有 30 分钟**（`cloud/app/auth/security.py::ACCESS_TTL`）→ 任何云端调用方都要「实时取票（`getToken`）+ 401 换票重放一次」，**不要把 token 拷进配置快照**（配置只建一次 ⇒ 半小时后必然 401）。知识库页曾因此把「票过期」报成「未登录」，与侧栏的登录邮箱自相矛盾。装配处唯一：`src/sync/kbGateway.ts::createRuntimeKbGateway`。
- ⛔ **refresh 必须单飞，且实现只在 `syncAccount.refresh()`**（不要在调用方各写一份）：服务端 `/api/auth/refresh` 是轮换 + 重用检测，旧票用第二次即判重放 → **整条链吊销 → 用户被登出**。知识库首屏 3~4 个并发请求会一起 401，这是正确性问题不是性能问题。
- ⚠️ `nanowork.config.json` 是 camelCase（`modelPresets`/`fallbackModels`/`providerRetryMode`）。
- ⚠️ vitest 全量偶发 `EPERM ... node-brokered-fs-shim` → worker 崩；同命令重跑即绿。另一种同症状的崩法是**输出量**：不加 `--silent` 时 MUI 的 act 告警能把日志刷到 13 万行，worker 以 `ERR_IPC_CHANNEL_CLOSED` 死掉、**拿不到汇总行**（别误判成用例失败）→ 全量用 `npx vitest run --maxWorkers=3 --silent`。
- ⚠️ `npm run build` 偶发 vite panic / `ENOENT \.\pipe\workbuddy-pac-*`；改单跑 `npx vite build` 并重定向日志更稳。

## 桌面端 IM 审批卡（真机已通过）
- **三条通道不能混**：任务视图=SSE `approval_request`+serve 进程+`POST /v1/tool-approvals/{id}`；**助理视图=轮询 gateway `GET /v1/approvals`+gateway 进程+`POST /v1/approvals/resolve`**。
- ⛔ 裁决打错进程 → 409 → 点了「允许」什么都没发生、零报错。IM 轮次在 gateway 进程，桌面端只是旁观者 → 只能轮询。
- ⚠️ session_key 三段要对齐；桌面端 chatId 用 `channelChatId()`（chatId 可含冒号）。
- ⚠️ 网关路由层「漏 await」是静默杀手：`async def` 不 await → 端点恒 500 → 卡片永不出现。判据 `nanobot/tests/gateway/test_health_route_contract.py`（AST）。
- ⚠️ 外部进程改不了 `PENDING_APPROVALS` → 真机触发只能走渠道入站（`POST /v1/turn`）。工具 `tools/inject_pending_approval.py`。
- 落点：`channelApprovalsStore`（1s 轮询 + 乐观出队 + `MAX_FAILURES=8`）、`ChannelApprovalCard`、`ChatPage` 按 `session?.channel` 二选一渲染。
- ⚠️ 平台层是渲染层与主进程**共同底座** → 共享类型下沉 `src/types/permission.ts`；`src/ai/runtime/types.ts` 用 `export type {} from` + 同时 `import type`（否则 TS2304）。

## 知识库绑定（FR-2.3 第四条 / M7，2026-10-24）
- 形态是**渲染层每轮预取**，不是引擎工具：token 不出渲染层、权限规则只在云端解释一次；代价=模型不能追问检索（已写进 FR-4.7 未做）。
- ⛔ `kbIds: []` = 该组织**可见的全部**库，与 `toolAllow: []`（一个都不许）**方向相反** → 两处不能共用归一函数。
- ⛔ 检索不到就**不注入任何段**（别写「未找到资料」占位）；失败降级为「本轮没资料」但必须 `console.warn`。
- provider 靠 `setKnowledgeSearchProvider` 注入（`sync/runtime` 装配处），否则 `lib ↔ sync/runtime` 成环。
- ⛔ **Agent 上新字段必须改三处**：`types/agent.ts` + `agentsStore.buildAgent`（白名单构造）+ `mergeAgents`（内置专家逐字段手抄覆盖）。漏第三处不报错，症状是「给内置专家设的值重启后消失」。
- `vite build` 清 `dist/` 会撞安全删除垫片批量阈值 → 必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。

## 知识库向量检索（FR-4.7，2026-10-24）
- 三档：`off`（**默认**，排序与纯词法逐条一致）/ `hash`（词袋随机投影，**非语义**）/ `openai`（任何 OpenAI 兼容 `/embeddings`）。换档只改 env，不改检索代码。
- ⛔ 向量表 `kb_vectors` **独立建表**，不给 `kb_chunks` 加列：`create_all` 不 ALTER 老表 → 老库静默少列，而测试库每次重建看不出来。
- ⛔ `load_vectors` 按 **kb_id** 取，不按 chunk_id 列表（后者会撞 SQLite 变量上限）。
- 排序是**混合**（词法 + 余弦走 RRF，k=60）；词法零命中而向量命中时返回纯向量结果。无向量的块**不参与**向量排序（不是 0 分参与）。
- `hash` 的碰撞噪声随桶数下降：dim=64 时无关文档余弦可到 0.16（会真进结果），dim=256 归零 → 默认 256，别往下调。

## 知识库文档解析（FR-4.7，2026-10-24）
- `.docx` 用标准库（zip + `word/document.xml`）；`.pdf` 用 **pypdf 可选依赖**（自己写抽取器会把中文抽成乱码，比不支持更糟）；`.txt/.md/.csv` 走 UTF-8-sig → GB18030。
- ⚠️ `pip install pypdf` 清华镜像没有该包 → 必须 `-i https://pypi.org/simple`（已装 6.21.2，`pyproject` 的 `[parse]` extra）。
- 上传走 **base64 JSON**（不引 `python-multipart`）；顺序必须「先解析后落库」，失败不留半篇。
- 上限 8MB / 单篇 20 万字 → **报错不截断**；扫描件 PDF 直接 422 + 提示 OCR（空文档会占块数却永不出现在结果里）；降级信息走响应 `warnings` 由客户端逐条弹。

## 加列迁移（2026-10-24，卸掉了「create_all 不能 ALTER」这个老约束）
- `cloud/app/migrations.py`：`APPEND` 到 `ADDED_COLUMNS`（表, 列, DDL **必须带 DEFAULT**）+ 可选 `ADDED_INDEXES`；`create_db_and_tables()` 在 `create_all` 之后调 `ensure_columns()`。
- ⛔ 只加不改不删（DROP COLUMN 老 SQLite 不支持，且静默删列不报错）。**加字段现在不需要再建旁表**。
- ⚠️ 判据必须在**自建 engine** 上跑（`tests/test_migrations.py`）：conftest 每例重建库，迁移分支永远走不到。

## 文档生命周期（FR-4.7，2026-10-24）
- 读写分权：`_writable_kb_or_404` 要 admin（`allowed_roles` 只管读）。成员写一律 403。
- 判重：`kb/digest.py::digest_of(chunks)` 按**切好的块**算 sha256，作用域**本库**；重复 409 点名已有标题；`_backfill_hashes` 给老文档从块补摘要。
- 删除：`kb_vectors → kb_chunks → kb_documents` 三张表都要删（只删文档行会留**孤儿块**，检索照样命中）；并校验 `doc.kb_id == kb.id`。
- `_document_view` 的 `kind` **从行上读**（原先由调用方传，列表接口没传 → 列表永远显示 text）。

## 部门与知识库可见性（FR-12.2 / FR-4.7，2026-10-24）
- 规则只有一条：`cloud/app/kb/visibility.py::allows()`。**列表 / 直连 `_kb_or_404` / 检索预过滤都走它**。
- 公式：admin|owner 豁免 → member 需 `角色 ∈ allowed_roles` ∧（不按部门收窄 ∨ 我直属部门 ∈ **允许集合的子树**）。方向反了会漏「人在子部门、库共享给父部门」。
- 部门表 `parent_id` 用**空串**表根（NULL 在唯一索引里互不相等 → 同名根去重失效）；成员关系独立表，不给 `org_members` 加列。

## 变异验证铁律（踩过：变异没还原就收尾）
- 变异脚本必须用**绝对路径**，还原用**无条件 `cp` 备份**（不要 `eval "cd x && ..."`，它会改 shell cwd 让 `cp` 静默失败），并用 `cmp` 校验还原成功。
- ⚠️ 变异**绿了不一定是用例弱**：先找「同一规则是否有第二份实现」（2026-10-24 可见性规则写了两遍，变异只杀掉一份 → 收敛成 `allows()` 后才红）。
- 跑完变异**必须 `git diff` 复查**，且同一轮内**再跑一次全量**——否则「测试红」与「工作区被污染」分不清（上一轮真把 `scope_ids = allowed` 留在仓库里过夜）。

## 默认拒绝写入（FR-8.4，用户决策：默认 true）
- ⚠️ **三层默认刻意不同**：引擎配置 `FileToolsConfig.default_deny_write=True`；客户端 `DEFAULT_DENY_WRITE=true`（必须与引擎逐字一致，否则界面说开着引擎在放行）；`_FsTool.__init__` 与 `resolve_allowed_path(deny_write_by_default=)` 参数默认 **False**（upstream 兼容，`memory.py` 依赖）。⛔ `sed` 批量替换会把两层一起改 → 有用例钉住「两层必须相反」。
- 只在 **full 模式**生效；删除同样被拦；读不受影响；`pathRules` 是 full 模式唯一放行出口但**不能放宽边界**（restricted 下无效）。
- 本机所有会话都落 full 模式（`restrictToWorkspace:false` ⇒ 普通会话也不下发 `access_mode`）→ 无 `pathRules` 时写与删全被拒；已放行 `C:/Users/xinmi/NanoWork`。

## 产物登记（两条路径）
- 任务会话：`handleProcessTool`(end) → `deriveFileArtifacts` → `handleArtifact`；富产物是流结束后 `extractArtifacts` 跑一次。
- 导入会话（IM/定时任务）：推理在引擎侧 → 登记时机只有 `sessionsStore.openExternal`，由 `sessionImport.attachImported*` 补齐。
- ⚠️ nanobot JSONL 把一轮拆成 `assistant(tool_calls)`→`tool`→`assistant(正文)`；映射必须**按轮聚合**（user 是轮边界）。
- ⚠️ 整段历史重放的 `recordArtifact` **不幂等**（4s 轮询会把版本链叠长）→ 用 `hasContentHashInHistory` 跳过。
- ⚠️ 断言产物正文别读 `bySession[i].content`（恒空串），用 `resolveArtifactContent(...)`。
- ⛔ IM 会话发言绝不能走 `/v1/chat`（引擎落 `api:<id>` 新会话，零报错），必须 gateway `POST /v1/turn`。

## 记忆 / 专家包类要点
- FR-3.3 专家包是**单文件 JSON**（`nanowork.expert/v1`，`expertType:'agent'`），`team` 明确拒导；技能只带 `{id,name}` 引用。三条归一语义反直觉：缺技能不阻塞 / 缺预设丢弃 / `toolAllow: []` 原样保留；`presetIds` 空集按「目录未加载」放行。`agentsStore.createAgent` 是白名单式构造（漏 `avatar`/`model` 会静默丢字段）。
- FR-3.9 专家头像云端未接入 → 确定性占位（`hashHue`）已锁定，`helperText` 有说明。

## 真机/环境
- 当前默认模型 `agnes-3.0-flash`（apihub.agnes-ai.com/v1，key 内联在仓库内 `nanowork.config.json`，该文件被 `.gitignore:36` 忽略）。**免费档会周期性限流** → 验收脚本先 `wait_for_quota()`，别把「额度不够」判成「功能不对」。
- ⛔ **从 WorkBuddy 宿主起引擎必须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`**：否则 `filelock` 解锁的 `unlink` 被安全删除垫片拦 → `SystemExit(1)` → serve 进程退出（症状：跑一阵突然 502 + `_try_trash` 栈）。
- ⚠️ `tool_deny` 按**工具名**不按能力：父 deny `write_file` 后子代理会改用 `apply_patch`/`exec` 写（不算越权）。想真禁写要一起 deny 或用 `access_mode`。
- ⚠️ Dream 输入只有 `memory/history.jsonl`（由会话归档写入），发几条消息再 `/dream` 通常 `nothing to process` → 用 `MemoryStore.append_history()` 造素材。`/dream` 是后台任务（回 `Dreaming...`），候选要轮询 `GET /v1/dream/review`；accept 的 `updated` 是 int。
- 真机验收脚本 `tasks/verify-b3-real.py`（c1/c2/c2-rollback），证据 `tasks/evidence/`。
- venv 真相：只有 `nanobot/nanobot/.venv` 在用（editable 指向本仓），`nanobot/.venv` 是 uv 遗留可删。跑引擎测试：`cd nanobot && ./nanobot/.venv/Scripts/python.exe -m pytest tests/`。
- 覆盖配置 `$APPDATA/nanowork/nanowork.nanobot.json`（无 bin，回落两层 venv；显式指 `config=<repo>/nanowork.config.json`）。渠道依赖自动安装会搞坏 venv → 预装进活动 venv 且必须 `--reinstall`。
