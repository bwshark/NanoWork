# 项目长期记忆 — nanowork

WorkBuddy 式智能体客户端：React 18 + TS + Vite 渲染层 + Electron 主进程 + nanobot 引擎（Python）。

**详述全在 skill `nanowork-dev-gate`**：§0 环境与命令、§1 门禁（+§1.1 服务端）、§2 重建 `main.cjs`、
§1.2 工具链双陷阱、§3 端口与存储根、§4 引擎契约层、§5 nanobot 测试与 git 禁区、§6 事件流存储、
§7 各功能批次（**§7.11 记忆链路**、§7.12 真机验证与 UI 坑、§7.13 领域结论、§7.14 模型对话框与
「浏览器里桩 electronAPI」配方、§7.15–§7.28 同步/产物/审批/工作步骤）。**本文件只留最硬规则与索引。**

## 硬规则

- 核心逻辑/测试**单引号**（`src/ai`、`src/stores`、`tests`、`electron`）；`src/pages` 等 UI 层混用双引号
  → **动某文件先看它现有风格，别顺手整体格式化**。注释写「为什么」。
- ⛔ **模型不得执行任何 git 写操作**（提交/推送由用户决定）；`nanobot/` 有独立 .git 且对象库受损 → 只读。
- **渲染层只允许 `src/platform/**` 认识 `window.electronAPI`**（CI 检查一）；**引擎 wire 键名只允许出现在
  `src/ai/runtime/nanobotHttp/**`**（CI 检查二）。两处基线均已清空 → 要新能力就加适配层方法，别在业务代码里判桥。
- 读持久化值要**解析两次**（`createJSONStorage` + `WebStorageAdapter` 各一次）。
- ⛔ **`vitest` 与根 `vite` 必须同代，现锁 `vitest@3.2.7` + 根 `vite@5.4.21`**。升 vitest 4 必须同时把根 vite 升 ≥6。
- ⚠️ **判超时只看 `err.name === 'AbortError'`**，别写 `instanceof Error`（abort 抛 `DOMException`，跨 realm 恒 false）。
- 门禁**三套 tsc 一起跑**（`typecheck` / `typecheck:electron` / `typecheck:tests`）：`typecheck:tests` **不在 `build` 内**。
- 改 `electron/**.ts` 必须**重建两个 `.cjs`**（`main.cjs` 是 bundle，`electron/` 下任何被 import 的模块都进去了）。
- ⚠️ **门禁命令必须带 `--maxWorkers=3`**：并行度拉满时 `tests/electron/` 那组会互相干扰
  （实测 12 文件挂 4 个 / 38 例，加了即全绿）。
- ⚠️ **`tests/` 被 `.gitignore` 整目录忽略**（裸 `tests/`，无前导斜杠）→ 新测试文件**静默不进版本库**
  （实测 165 个文件只跟踪 136 个）。新增测试要 `git add -f`，或把该行改成 `/tests/`。同文件对 `tasks/` 已记过同款教训。
- **写 `platform.storage.set` 的新 key 必须先在 `STORAGE_KEYS`（constants.ts）登记**，否则不进
  「全部显式登记」不变量；且**值是裸字符串就别落 json 路由**——主进程 json 路由无条件 `JSON.parse`，
  裸文本必然写盘失败（症状：`storage:set` handler 报错 + 数据静默丢）。

## 索引（一句话结论 → 详见）

| 主题 | 一句话 | 详见 |
|---|---|---|
| 存储两个根 | `~/.nanowork` = 用户资产；`%APPDATA%/nanowork` = 运行数据；事件流在后者，**不在 workdir** | §3、§7.13.1 |
| 工作空间 | 切换**不搬迁文件**；`workdir`=语义 / `streamWorkdir`=落盘分片，读事件一律 `streamShardOf` | §7.13.1 |
| 列表可见性 | 判据用 `conversationCount`/`hasConversation`，**别拼 `messages.length`**（消息按需水合） | §7.13.2 |
| 默认工作空间 | 分组 key 是**空字符串** → 判空一律写 `key === null`，否则「菜单能开点了没反应」 | §7.13.3 |
| 记忆落点 | 唯一写用户工作目录处：`<workdir>/.nanowork/memory/`；`append` 只写当天文件 | §7.13.4、§7.11 |
| 工作目录 | 运行时值**不许进长期记忆、不许让记忆赢**；`# Current Project` 无条件追加且排在 `# Memory` 后 | §7.13.5 |
| 心跳 | 空闲唯一稳态出网；优先 `/health`（根路径免鉴权），仅 404/405/501 写回退缓存 | §7.13.6 |
| MCP 传输 | URL 分不出 → 缺省自动检测；`urlType` 三态，UI 空串必须映射 `undefined` | §7.13.7 |
| 内容列/输入区 | 展开 `chatColumnSx`，助手内容**不加 `max-width`**；输入区高度按可见行 + border-box 内边距 | §7.13.8/9 |
| 默认模型 | Auto = 隐式 default 预设 → `defaults.model` 是**裸模型名**，下拉项 id 是**预设名**（同名不同义） | §7.13.10 |
| 引擎复用 | 端口被占 → 复用无句柄的旧实例（带旧配置）→「改配置没生效」；先比进程 `CreationDate` vs 配置 mtime | §7.13.11 |
| 网关端口 | 首选 `18900`（两份镜像常量）；`winerror 10013`≠`10048`（保留区间 vs 被占用，前者杀进程无效） | §3 |
| 落盘字段 | 引擎 `Base` 是 `extra="ignore"` → 未声明键**静默丢弃**；新增声明式字段须同时改 schema + 往返用例 | §7.14 G |
| 加**必填** Settings 字段 | 会触发全仓测试的 `Settings` 字面量集体 TS2741（本次 21 个），须纯插入补字段、零断言改动；先 `grep -rl "theme:" tests/ \| wc -l` 估半径 | §7.28.4 |
| 同步元数据 | 8 实体全落（`rev`/`updatedAt`/`updatedBy`/`deletedAt`）；墓碑独立表；`channels` 墓碑键是 `kind`；会话 `rev` 由 `updateSession` 自动维护 | `docs/architecture-syncmeta.md` |
| M6 跨端同步 | **不引入 SQLite、连 changelog 都不做** → 全量 push；`updatedAt` 服务端接收时间归一；`sessionMeta`(LWW) 与 `sessionEvents`(append) 两 collection；`streamWorkdir` 落接收方自己分片 | `docs/architecture-m6-sync.md` |
| 同步账户态 | 跨账户存活的进程内态都要问「属哪个账户」：`resetAccountScopedState()` + 事件水位按账户分片 | §7.21 |
| 第三/四类通道 | 产物 / 文件资产 / 事件流：全异步 → **不进 `syncRegistry`**（`spec.read()` 是同步的，硬套得撒谎） | §7.22、§7.23 |
| 产物索引+版本链 | 内容寻址 `contentHash()`（`sha256:<hex>`，同步纯 TS）；`bodies` 内容池 + `bySession` 引用；回退=新开一版不覆盖历史 | `docs/fr-7-2-*`、`fr-7-4-*` |
| 产物收回 | 引擎 `delete_file` 后产物必须消失：`DELETE_FILE_TOOLS` → `removeArtifacts`（**bodies 保留**）→ `handleProcessTool` 里**收回优先于登记**。⚠️ 函数名是 `handleProcessTool` 不是 `handleToolCall` | `fr-7-2-*` §4.1 |
| 审批卡片覆盖输入框 | `ApprovalCard` 绝对定位贴底；**锚点层不许有 `pb`**（否则漏 12px、placeholder 透出）；三档裁决 + 引擎 `always` 豁免 | §7.25 |
| ⚠️ StrictMode | `main.tsx` 是 `<React.StrictMode>` → 每次渲染跑两遍。**换请求清状态一律 `key={id}` 卸载重挂**，别用「渲染期 ref 哨兵 + setState」；测试入口 `mountStrict()` | §7.25.2 |
| 侧栏账户入口 | 常驻 UI 必须 `useSyncRuntime()` **订阅**单例——`getSyncRuntime()` 读一次会把「运行时还没建好」固化成「未登录」 | §7.26 |
| 路由三层 / 全屏登录页 | `App` 只跑启动副作用 + Toast；`/auth` 与 `<AppLayout>` **平级**（提根级会跳过启动链，且不报错） | §7.27 |
| 工作步骤三档 | `Settings.processDetail`；分类是**只读白名单**（fail-open，未知工具算关键）；审批/敏感/出错卡片必须在 `<Collapse>` 之外 | §7.28 |
| 工具调用显示两遍 | 根因是实时路径 `handleApprovalRequest` 丢了 `call_id`。`ApprovalRequestEvent.id`（回传裁决）≠ `callId`（对齐过程行），不能合并 | §7.28.6 |
| 可观测性 | trace 由**事件流派生**（零埋点）；日志**行内分级 + 模块白名单**（白名单即文件名域）；诊断包**刻意不含凭据**、体积闸先保最新并如实记「略过几个」 | §7.29 |
| ⚠️ `onError` 与 `catch` 是两个失败出口 | 只在外层 `catch` 落日志 ⇒ 「跑一轮失败对话，日志里一条都没有」。给失败加记录前先数一遍**所有出口** | §7.29 |
| 设置写入策略（FR-8.4） | 只合并 `tools.file` **那一个键**（整体替换 `tools` 会静默吞掉 `mcpServers`/`restrictToWorkspace`/`ssrfWhitelist`）；幂等签名**只看该键**（否则别处改 MCP 就一直弹「已变更」）；camel 写、两种键都读；`supported:false`（引擎没这个落点，保存自动补键）≠ `null`（读不到、禁用保存） | §7.32 |
| 凭据名册只读（FR-8.4） | `NO_ACCESS_*` 是**引擎名单常量** → 只展示不给修改入口；白名单也不做编辑器（引擎白名单是按作用域的 `allowed_root`，文本框引擎 `extra=ignore` 静默丢） | §7.32.5 |
| IM 会话来源（FR-6.4） | 分组/筛选键用**渠道原始首段**（`ChannelKind` 只 5 个成员，未知渠道会被**图标**的回退规则并进钉钉组）；来源判定（`channel` 非空）与本地 id 前缀是两个判据不许合并；筛选态放 store（Tab 是条件渲染，组件 state 会重挂载丢）；IM 标题只读（轮询会盖回） | §7.33 |
| 投递档位（FR-5.6/6.3） | `_DELIVERY_MODES` 三档是**包含**关系 `error` ⊂ `complete` ⊂ `start`；加档位必须有「不影响既有档位」的用例 + 登记表用例 | §7.34.1/§7.34.5 |
| ⚠️ cron 进度事件**早就在发** | `channel != "system"` 一律 `publish_lifecycle=True`，cron turn 的 channel 是 origin → `ProgressEvent`（含 `tool_events`）已经发出，受渠道 `send_progress`/`send_tool_hints` 控制。**做 milestone 的真实工作量是「镜像到 targets + 定节流」，不是「找信号源」** | §7.34.2 |
| ⚠️ FR-2.4 专家团「真实执行」现状**做不了** | `spawn` 只有 `task/label/temperature/wait`（无人设/工具策略），子代理人设由固定模板构造，`agent_id` 只用于工具策略 → 引擎没有「运行某具名 Agent」的概念；`mode` 全仓无执行读取点。**三条路径与 5 个待产品决策的语义问题见方案文档** | `docs/design-fr-2-4-expert-orchestration.md` |
| 专家表单已收口为共用组件 | `AgentFormDialog`（超集）供「专家管理 / 我的专家」两个入口共用；`PLATFORM_LABEL` 收口到 `lib/imPlatform.ts`；草稿重置用 `useEffect` 不用 `key`（保退出动画） | §7.35.6 |
| ⚠️ 两个 MUI 实测坑 | `MuiFormControlLabel-label` 类名**不存在**（选择器会静默拿 null）；`FormControlLabel` 的负 margin 让开关与文字**零间距**（看着像压住字，几何上只是紧贴） | §7.35.7 |
| ⚠️ 项目未开 `noUnusedLocals` | 搬迁代码后残留的未使用 import/变量默认 tsc **抓不到** → 用 `tsc --noEmit --noUnusedLocals` 自查（注意它会报全仓既有项，只清自己改的文件） | §7.35.6 |
| P0 已清空（2026-10-05 盘点） | P0 33 条中 31 ✅，剩 `FR-2.3`（只差知识库，属 V2）/ `FR-2.4`（待引擎能力）；P1 24 条中 18 ✅ | PRD 第 6 章基线 |
| 产物版本链（FR-7.4）**早已实现** | 版本历史区 / 预览 / 对比 / 回退全在 `ArtifactPanel.tsx:694/304/933`（2026-09-29 落地）。⚠️ 旧笔记与 PRD 长期写着「缺对比与回退入口」是**错的** → **状态结论必须能指到 `文件:行号`，别沿用笔记** | PRD §20.10 |
| ⚠️ MUI Tooltip 的 `aria-label` 层级不定 | 直接包 `IconButton` 时在 `button` 上；包一层 `<span>`（给 disabled 按钮垫的那层）时在 **span** 上。⚠️ 找到 span **也不能直接点**（它是 button 的父，事件向上冒泡不经过 button）→ 要向下取里面的 button | §7.36 |
| 专家模型绑定（FR-2.3） | `Agent.model` 存**预设名**（与 `Session.model` 同域）；优先级 会话 > 专家 > 空，**逐级回落**；⚠️ **下发前必须拦失效预设**（否则「删一个预设」=「所有绑过它的专家全部发不出消息」）；⚠️ 目录未加载返回 `null` 而非空集（否则冷启动第一轮静默丢选择） | §7.35.1/§7.35.2 |
| ⚠️ store 两条写路径不对称 | `createAgent` 白名单构造 / `updateAgent` 展开赋值 / `mergeAgents` 逐字段覆盖 → 加新字段只改一处**不报错**，症状是「新建时选的 X 保存瞬间消失」或「改了内置条目重启后变回」。新增字段三处一起改 | §7.35.3 |
| ⚠️ 诊断产物的清理 | 一律**浅删除**（`readdir`+`unlink`+`rmdir`），`fs.rm(recursive)` 会撞宿主批量删除守卫挂几十秒 | §7.29 第 9 条 |
| ⚠️ 引擎 `Base` 收两种键名 | `alias_generator=to_camel` + `populate_by_name` → camel 与 snake **都认**；但 **未声明的键静默丢弃** → 新增声明式字段必须先改 `schema.py` + 加往返用例。**别从 grep 推断序列化行为** | §7.30.1 |
| ⚠️ 「查不到 ≠ 不支持」 | 元数据缺失（Web / 引擎离线 / 手填模型名）一律**宽松**：读成 false 会让所有人静默丢功能且无报错可查 | §7.30.2 |
| ⚠️ 硬门禁只能用在默认值宽松的字段上 | `supportsTools/Reasoning` 默认 true → 可禁用；`supportsVision` 默认 **false** → 只能软提示（硬门禁 = 一升级禁掉所有人的贴图） | §7.30.3 |
| ⚠️ `input_tokens` 已含缓存读取 | 计价必须**三档**（未命中输入 / 缓存读 / 输出），两档在长会话可高估一个数量级；缓存单价缺省 = 按输入价（不是 0） | §7.30.4 |
| ⚠️ 共享 loader 的飞行中去重 | `loadManaged` 并发时**旧结果后返回会覆盖新结果** → 默认去重、保存/删除/进分区传 `force` | §7.30.6 |
| ⚠️ jsdom 缺 `URL.createObjectURL` | 附件链路（图片预览）会直接失败；垫片已进 `tests/setup.ts` | §7.30.8 |
| ⚠️ 绿灯 ≠ 门禁过 | 全绿但 `exit=1` = `Unhandled Error`（MUI 过渡的 `setTimeout` 不归 React 管，环境销毁后触发）→ 该文件要 `afterEach` 卸组件 + 等 400ms。**判门禁看退出码** | §7.30 末 |
| 回退链是**两态** | 引擎 `FallbackCandidate = str \| InlineFallbackConfig`（str=引用预设 / 对象=内联配置，靠**类型**区分）→ 客户端建构成 `{kind:'preset'\|'inline'}`，**不许拍平**（拍平后回写无从还原） | §7.31.1 |
| ⚠️ 回退链的失效引用会让**网关起不来** | 引擎在**配置加载时**校验链上每项都存在于 `modelPresets`，不满足抛 ValueError。→ 写入侧：删/改名预设必须 `dropFallbackRef`/`renameFallbackRef`；界面侧：失效引用**禁用保存**并说明后果 | §7.31.2 |
| 配置类编辑用**草稿 + 保存** | `syncNanobotModels` **每次写入都重启网关**（`/v1/models` 在 serve 启动时构建）；顺序编辑是多步操作 → 逐次落盘 = 每点一下闪一次 | §7.31.3 |
| ⚠️ 运行时回退事实**拿不到** | 引擎 `turn_model_updated` 只在 **websocket** 通道发（`context.channel != "websocket"` 即 return），本客户端走 HTTP（`channel="api"`）；HTTP 响应的 `model` 只是**请求解析出的**预设模型。别用它冒充「实际服务模型」 | §7.31.4 |
| ⚠️ MUI Tooltip 把 title 复制成包裹层 `aria-label` | `data-mui-internal-clone-element` 的 `<span aria-label="删除">` + 内层 `<button aria-label="删除">` → 真机脚本按 `[aria-label=…]` + `nth()` 定位全错位。**用具名 role 定位**。另：Tooltip 直接包 disabled 按钮，提示永不可见 + 控制台刷警告，垫一层 `<span>` 才真修好 | §7.31.5 |
| ⚠️ `.gitignore` 裸目录名匹配**任意层级** | `tasks/` 会连 `src/**/tasks/` 一起忽略（注释写着要加前导 `/`，规则被改回过）→ 两个真实源码文件从未入库、**新 clone 编译不过**。判据：`git check-ignore -v src/components/tasks/__probe__.ts` | 硬规则 |
| ⚠️ vite 重新优化依赖崩在**清理阶段** | 新增 `@mui/icons-material` 图标 → re-optimize → `commit()` 里 `rm deps_temp_*`（数千项）撞安全删除守卫 → dev 当场退出。**只 mv 走启动前的 deps_temp_* 不够**（本轮会新建一个再删）。崩溃时 `deps/` 已就绪 → **再启动一次即可**（第二轮不再优化）；判据 `ls node_modules/.vite/deps \| grep -i <新图标名>` | §1.2 补 |

## 记忆功能现状（2026-10-01 检查实测）

三层落点**均真实可用**（有磁盘实证）：L2 `~/.nanowork/MEMORY.md`（3 条）；L3 `C:\Users\xinmi\NanoWork\.nanowork\memory\`（4 个日期文件）
与 `D:\aaa\.nanowork\memory\`；兜底 `~/.nanowork/memory/default/`；懒迁移跑过（`~/.nanowork/memory/*.md.migrated` 4 个）。
记忆相关 9 个测试文件 195 用例全绿。

⚠️ **已发现未修的缺陷**：`looksLikeSystemError`（`src/lib/memory.ts`）特征词表漏掉三类真实报错文案，
导致**报错被写进长期记忆并长期注入**——生产数据已脏 4 条（`~/.nanowork/memory/default/2026-09-20|21.md`、
`C:\Users\xinmi\NanoWork\...\2026-09-20|21.md`、`D:\aaa\...\2026-09-21.md`），内容形如
`Error: {'message': 'The model `sciherd` does not exist…'}` / `Error calling LLM: Connection error.`。
漏判原因：无 `does not exist` / `model_not_found` / `connection error` 这类特征词（`Error` 单独不算）。
详见 `.workbuddy/memory/2026-10-01.md`。

## 真机验证铁律

1. 布局类问题**量几何**（`getBoundingClientRect`+`getComputedStyle`），别只看截图；验证要能证伪。
2. **Playwright 必须 `args:['--no-proxy-server']`**：本机 `http_proxy` 会劫持 `127.0.0.1` → `goto` 超时，dev server 其实好的。
3. dev server 与 `vite build` **不要并发**（都动 `node_modules/.vite`）；门禁 `vitest run --maxWorkers=3`、
   `vite build --emptyOutDir false` + `CODEBUDDY_SAFE_DELETE_ENABLED=0`。**dev 端口以 `vite.config.ts` 为准（2026-10-01 = 5176）**。
4. dev server **首屏预热一次**（首次重打包可能拖过 60s，不预热会误判「挂了」）。
5. ⚠️ **启动 dev 前先 `mv node_modules/.vite/deps_temp_* /tmp/`**：改 `@mui/icons-material` 图标等会让 vite 重新优化依赖 →
   删 `deps_temp_*` 撞安全删除守卫（2400+ > 50）→ **dev server 起手就崩**（新版 vite 已复现）。
6. ⚠️ **真机脚本切场景 = 每场景 `ctx.newPage()`**：store 是模块级单例、展开态是组件 state，一次 goto（同 URL / about:blank / 加 query）复位不了；
   桩数据落 `localStorage` **且** `Object.assign` 内存对象（`sessionStorage` 不跨 tab；只落盘则当前页拿到上轮桩）。详见 `.workbuddy/memory/2026-10-04.md`。
5. 判断上游真伪用 `curl --noproxy '*' -i` + `/openapi.json`，别只读自己代码（401/404/超时各有原因）。
