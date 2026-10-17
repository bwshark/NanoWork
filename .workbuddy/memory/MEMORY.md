# 项目长期记忆 — nanowork

WorkBuddy 式智能体客户端：React 18 + TS + Vite 渲染层 + Electron 主进程 + nanobot 引擎（Python）。
详述全在 skill `nanowork-dev-gate`（环境/门禁/重建/引擎契约/同步/产物等）。
**完整 FR 状态索引见 `docs/README.md` §九 看板（以代码为准）**——本文件只留最硬规则与高频踩坑，避免重复。

## 硬规则

- 核心逻辑/测试**单引号**；UI 层混用双引号 → 动文件先看现有风格，别整体格式化。注释写「为什么」。
- ⛔ **模型不得执行任何 git 写操作**（提交/推送由用户决定）；`nanobot/` 独立 .git 且对象库受损 → 只读。
- 渲染层只允许 `src/platform/**` 认识 `window.electronAPI`（CI 检查一）；引擎 wire 键名只允许在 `src/ai/runtime/nanobotHttp/**`（CI 检查二）。两处基线已清空。
- 读持久化值要**解析两次**（`createJSONStorage` + `WebStorageAdapter` 各一次）。
- ⛔ **`vitest` 与根 `vite` 同代**：现锁 `vitest@3.2.7` + 根 `vite@5.4.21`。升 vitest 4 必须同时升根 vite ≥6。
- ⚠️ **判超时只看 `err.name === 'AbortError'`**（abort 抛 DOMException，跨 realm `instanceof Error` 恒 false）。
- 门禁**三套 tsc 一起跑**（`typecheck`/`typecheck:electron`/`typecheck:tests`）；`typecheck:tests` 不在 `build` 内。
- 改 `electron/**.ts` 必须**重建 `main.cjs` + `preload.cjs`**。
- ⚠️ 门禁命令带 **`--maxWorkers=3`**（并行拉满时 `tests/electron/` 互相干扰）。
- ⚠️ 跑全量门禁要带 **`CODEBUDDY_SAFE_DELETE_ENABLED=0`**，否则 4 个预存文件的 `afterEach` `fs.rm(recursive)` 被安全删除守卫拦截超时 → 假报 12 个失败。判定**永远看退出码**。
- ⚠️ **`tests/` 被 `.gitignore` 整目录忽略** → 新测试要 `git add -f`；同坑 `tasks/`（已补前导斜杠）。
- 写 `platform.storage.set` 新 key 必须先登记 `STORAGE_KEYS`；**裸字符串别落 json 路由**（主进程 `JSON.parse` 必崩，写入静默丢）。

## 高频踩坑（保命，细节见 docs/README.md §九 看板）

- ⚠️ **`spawn(wait=false)` 丢结果**：serve 进程无 inbound 消费者（唯一 `consume_inbound()` 在 `AgentLoop.run()`）。与 FR-2.4 **无依赖**——编排用 `run_inline` 直接 await，不走总线。
- ✅ **专家团 FR-2.4 三模式已真实执行（2026-10-06 落地、10-07 真机验证）**：引擎 `agent/expert_group.py` 调度、`loop.py` 命中即接管本轮；成员的人设/工具/模型**均已接线并配生产接线测试**（`tests/agent/test_expert_group_wiring.py` 13 例 + 4 条变异验证）。⚠️ 历史教训：`_run_member` 曾为闭包 → 这段逻辑**永远测不到**，才有了「人设只被解析从未使用」的静默缺陷。给不可测的接线段留闭包＝埋雷。
- ⚠️ **引擎两套 logger 并存，占位符不同**：`loop.py` 用 **loguru（`{}`）**、`expert_group.py` 用**标准 logging（`%s`）**。写反不报错——loguru 里 `%s` 只是不替换（告警无具体值），标准 logging 里 `{}` 要等真有 handler 才炸 `TypeError`。已有守卫 `tests/test_log_placeholder_contract.py`（AST 全仓扫描）。**改日志前先看该文件的 import**。
- ⚠️ **成员模型/专家模型不要在未校验时透传给 provider**：配了预设目录却没命中 → 必须退回本轮 runtime + 告警，否则 provider 回 `The model 'x' does not exist`，**一个成员写错会拖垮整团**。但「目录为空」时必须允许透传（没配预设 ≠ 全部失效）。
- ⚠️ **`**kwargs` 透传撞形参 = 无声改变语义**：`_on_progress` 的成员载荷若把 `extra` 平铺成 kwarg，coordinator 的 `plan` 键会命中同名形参（期望 dict）→ `**str` TypeError → 被 `_emit` 的 `except Exception` 吞掉 → 「事件凭空消失、不报错」。透传一律**整体进 `member_extra`** 这类具名容器。
- ⚠️ **专家模型绑定 FR-2.3**：`Agent.model` 存预设名（与 `Session.model` 同域）；下发前必须拦失效预设；目录未加载返回 `null` 非空集。
- ⚠️ **store 两条写路径不对称**（`createAgent`/`updateAgent`/`mergeAgents`）→ 加新字段三处一起改，否则「保存瞬间消失/重启变回」。
- ⚠️ **StrictMode**：换请求清状态用 `key={id}` 卸载重挂，别用渲染期 ref+setState；测试入口 `mountStrict()`。
- ⚠️ **回退链两态**（`preset`|`inline`）不许拍平；失效引用会让网关起不来（配置加载时校验链上每项必须存在）。
- ⚠️ **配置类编辑用草稿+保存**（`syncNanobotModels` 每次写入重启网关）。
- ⚠️ 引擎 `Base` `extra="ignore"`：未声明键静默丢弃 → 新增声明式字段先改 `schema.py` + 加往返用例。别从 grep 推断序列化。
- ⚠️ **「查不到 ≠ 不支持」**：元数据缺失（Web/引擎离线/手填模型）一律宽松。
- ⚠️ **`input_tokens` 已含缓存读取** → 计价三档（未命中/缓存读/输出），缓存单价缺省按输入价。
- ⚠️ **绿灯 ≠ 门禁过**：全绿但 `exit=1` = Unhandled Error（MUI 过渡 `setTimeout` 不归 React 管）→ 该文件 `afterEach` 卸组件 + 等 400ms。**判门禁看退出码**。
- ⚠️ **`.tsx` 里 `return (<JSX>,)` 的逗号运算符 = tsc 报 TS1109、vite/vitest 却正常**（TS 5.9 实测）：报错落在**收尾的 `);` 那一行**，与真正的病灶隔着几十行 → 极易误判成「文件写坏了」并开始怀疑人生。定位手段：esbuild 解析同一文件（能过就说明是 tsc 的问题，不是语法错）；`return (<JSX>)` **不要带逗号**（既有测试文件都不带）。
- ⚠️ **`printf '%s\n'` 写探针文件时 `\n` 是字面量**（bash 双引号不转义）→ 探针文件全带字面 `\n`，tsc/esbuild 报的是**探针自己的错**，结论全错。要用 heredoc（`cat > f <<'EOF'`）。
- ⚠️ **`.gitignore` 裸目录名匹配任意层级**：`tasks/` 曾误吞 `src/**/tasks/` 源码（已补前导斜杠）。
- ⚠️ **可选的 prop 不能当功能开关**：`Composer` 的编辑桥接 `registerComposerEdit(...)` 曾写在 `if (!apiRef) return` 之后，而 `ChatPage` 里**只有空态那个 hero 输入区**传 `apiRef` → 一进对话桥接整体为 `null`：「添加到对话」送不去焦点、标题栏「编辑」菜单三动作一起失灵，**且都不报错**。已改为无条件注册（变异验证：退回旧写法 → 单测 `expected null not to be null` 变红）。
- ⚠️ **改输入区「有没有内容」的判据要两处同改**：`onSend` 的前置判断与发送按钮的 `disabled` 必须同源，否则出现「按钮亮的、点了没反应」（引用胶囊曾踩）。

## 记忆功能现状

- 三层落点真实可用；9 测试文件 195 用例全绿。
- ⚠️ **未修缺陷**：`looksLikeSystemError`（`src/lib/memory.ts`）漏判三类报错文案 → 报错被写进长期记忆（生产已脏 4 条 `2026-09-20|21.md`）。详见 `.workbuddy/memory/2026-10-01.md`。

## 真机验证铁律

1. 布局量几何（`getBoundingClientRect`+`getComputedStyle`），别只看截图。
2. Playwright 必须 `args:['--no-proxy-server']`（本机 `http_proxy` 劫持 `127.0.0.1`）。
3. dev server 与 `vite build` 不要并发；dev 端口以 `vite.config.ts` 为准（2026-10-01 = 5176）。
4. 启动 dev 前先 `mv node_modules/.vite/deps_temp_* /tmp`（改 `@mui/icons-material` 图标重优化依赖会撞安全删除守卫崩 dev）。
5. 真机切场景 = 每场景 `ctx.newPage()`；桩数据落 `localStorage` **且** `Object.assign` 内存对象。
6. 判断上游真伪用 `curl --noproxy '*' -i` + `/openapi.json`。

## 引擎提示词层（FR-3.10 ChainLoader）· 2026-10-16

- ⚠️ **Jinja 自定义 loader 的 `get_source` 找不到时必须 `raise TemplateNotFound`，不能 `return None`**：`BaseLoader.load` 会解包返回值，返回 None 抛 `TypeError: cannot unpack non-iterable NoneType object`，而 `ChoiceLoader` 只捕 `TemplateNotFound` → 错误带着与模板名无关的栈冒到业务代码。
- ⚠️ **ChainLoader 的内置 `FileSystemLoader` 必须始终在链尾**：漏掉它时唯一那个 loader 抛错后无人接手，内置模板（如 `agent/platform_policy.md`）直接解析失败，报错像「模板文件不见了」。
- ⚠️ **覆盖模板必须走 loader，不能用 `Environment.from_string`**：`from_string` 产出的模板**没有 loader** → 覆盖文件里的 `{% include %}` 一律解析不到（上游式覆盖的既有缺陷）。
- 插件片段模板名基准是**包根**（`demo/fragments/domain.md`），不是被声明目录吃掉后的相对名。
- 清单里单值字段（`tools: "shell"`）必须走 `_string_list`；用 `_string_tuple` 会静默读成空 = 不约束 → **安全方向的静默失效**。
- 测试报告类 HTML 页面：jsdom 里 `body.textContent` **包含 inline `<script>` 源码** → 拿注释里的字样当 waitFor 判据会立刻通过（用例变恒真）。
- `jsdom` 无 `.d.ts` → 已在 `tests/jsdom.d.ts` 补最小声明（不引 `@types/jsdom`）。

## 插件市场（FR-3.7 / 3.8 / 3.13）· 2026-10-16

- ⚠️ **依赖是「市场级」语义，归 `marketplace.json`（索引文件），不是包清单的一维** → 落点只有 `electron/pluginMarketplace.ts`，`pluginPackage.ts` 不用动。
- ⚠️ **索引是可选元数据，不是白名单**：`resolveInstallOrder` 遇到「索引没提到这个包」必须按**单包**处理，否则一份没写全的索引会变成「市场里别的包装不上」的硬故障。
- ⚠️ **索引文件每次同步覆盖写**（与包副本的「只增不改」相反）；`listMarketPackages` 要**显式跳过**它，不能靠「拿文件 readdir 必然失败」来跳过。
- ⚠️ **版本比较永远用 `src/lib/semverRange` 的 `compareVersions`**，别字符串比：`'0.1.9' > '0.1.10'` 会装到旧版且无报错。
- 拓扑序/环检测 = DFS + `visiting`/`done` 三态；**循环要把环打印出来**（`a → b → a`），只说「存在循环」用户没法行动。

## 工具策略门（FR-3.12 plugin_tools）· 2026-10-16

- ⚠️ **「白名单只能收紧」是 `CompositeHook` 免费提供的**：`_decide_for_each_hook` 只收集 `allowed=False`，`allow()` 被直接丢弃 → 任何门都只能加 deny，**门的位置不改变语义**。
- ⚠️⚠️ **Hook 装配字段的工厂必须用 `isinstance` 认形状，不能只判 `is not None`**：喂进来一个「长得像但不是」的值（实测是单测里 mock 掉 `ContextBuilder` 后的 `MagicMock`）→ 门挂上、白名单空、**所有工具全被拒**，且拒绝原因里连来源名都没有（最坏的一种故障：整轮不可用 + 无法解释）。认不出形状＝当没声明 + warn。
- ⚠️ **变异验证必须先确认「用例真的覆盖了那一层」**：手工拼 `CompositeHook([...])` 的用例**证不了装配**（`build_agent_turn_hook`）——「有声明就跳过审批门」写进装配时它照绿。走真实装配的用例要放在那里。
- ⚠️ **多份声明（技能 frontmatter ∩ 插件清单）取交集**；并集会让任一份都能放宽另一份。
- `tools:` 是既有 frontmatter 的**新键** → 按硬白名单解释前先 `grep -rn '^tools:' <skills>/` 确认没撞名。
- 单值 `tools: shell` **必须收**（技能侧拿到的是原始值，这条规则是唯一防线）；`tools: []` = 显式全拒（不读成「没声明」）。

## 首屏治理（FR-13.5 / 13.6）· 2026-10-16

- ⚠️⚠️ **Vite 的 `__vitePreload` 助手必须单独成一个 chunk**：它被每个含动态 `import()` 的 chunk 副作用导入 → **它落在哪个 chunk，那个 chunk 就必然进入口的静态图**、被 `modulepreload`。手工 `manualChunks: { markdown: [...] }` 会把 772 KB 拽上首屏（本意相反），摘掉 markdown 后助手又落进 `mermaid`（665 KB 上首屏）。解法：`manualChunks(id) { if (id.includes('vite/preload-helper')) return 'preload-helper'; ... }`。
- ⚠️ **判据不能只卡 `modulepreload`**：把大依赖改回静态 `import` 时它会**并进入口 chunk**（553 KB → 1340 KB）而不是变成一条 preload → 只卡那一条的判据被绕过。判据见 `tasks/verify-b5-first-paint.mjs`（两条预算：modulepreload ≤ 1.2 MB、首屏合计 ≤ 1.5 MB）。
- ⚠️ **`const Page = lazy(() => import(...))` 必须写在 `createBrowserRouter([...])` 之前**：路由表在模块求值时就读它们，`const` 没有提升（tsc 报 TS2448/TS2454）。
- ⚠️ **`Suspense` 边界放 `AppLayout` 的 `<Outlet />` 外**（不是路由表）：放路由表会让带壳布局卸载重建。**全屏页（`/auth`）必须自己一个边界**，否则懒加载一路上抛到根级（无边界）→ 白屏。
- ⚠️ **测试等懒加载用轮询**（`tests/helpers/reactMount.ts` 的 `waitForSettled`）：`flush()` 是固定 10 轮 `setTimeout(0)`，等不完一个真实 `import()`。
- 引擎路径深度：**两层** `nanobot` —— `<appRoot>/nanobot` 是引擎仓库，venv 在 `<appRoot>/nanobot/nanobot/.venv`。候选路径只有一份真相（`engineInterpreterCandidates`），启动器与自检共用。
- ⚠️⚠️ **两份引擎副本，桌面真正跑的是另一份**：桌面前端连 `D:\Workspace\Codes\sciherd-cloud-smartagent\nanobot`（原始、**能出 token**）；`D:\Workspace\study\nanowork\nanobot` 是 patch 工作副本（`nanowork.config.json` 无内联凭证、shell 无 `DASHSCOPE_API_KEY` → 对话 **500、无法真机验证**）。`study/.../nanobot/nanobot/.venv/Scripts/nanobot.exe` 启动器**实际分发到 codes venv**（traceback 路径露馅）。→ **引擎改动必须同步两份**；**真机验证要让能出 token 的 codes 那份跑**（`study/.../nanobot.exe serve` 即走 codes）。**2026-10-17 已把 study 整套 `nanobot/nanobot` 源码同步进 codes**（codes 由仅 11 处 patch → 全量 163 处；`/v1/usage` 恢复 200；B4-02 经真实 /v1/usage 转绿），**唯一刻意保留的差异是 `utils/gitstore.py`**（codes 独有的跨进程 `FileLock`，与 study 版公共方法一致、API 兼容）。同步前备份在 `codes/nanobot/.local-backup-eng-20261017_204905/`（7.3M，可回滚）。⚠️ **今后若再改 study 引擎，需重新同步到 codes**（模型不做 git 写操作）。

## 引擎 import 环与路径规则（B6）· 2026-10-17

- ⚠️⚠️ **`agent/context.py` 里 `from nanobot.agent.plugins import ...` 只能是函数内局部导入**：`agent/__init__.py` 重导出 `context`，而 `plugins.py` 模块级 import `config.loader` → 环闭 → `config/schema.py` 末尾的 `_resolve_tool_config_refs()` 静默失败 → **任何** `Config.model_validate` 抛 `` `Config` is not fully defined; you should define `WebToolsConfig` ``。排查提示就写在 schema.py 末尾。
- ⚠️ **判定「是不是自己改坏的」必须跑 skill 登记的四目录基线**（`tests/utils tests/agent tests/command tests/config`）：我跑 `tests/agent`+`tests/utils` 子集时把上面那条误判成环境问题，`tests/config` 才照出来。
- 路径规则优先级：**凭据 `no_access`（无条件）> 允许根包含性 > 路径规则 > `default_deny_write`**。规则匹配是「对该 kind 有表态的规则里挑最具体」——写反了会让细规则意外放宽粗规则。
- 删除复用写解析路径但必须传 `kind='delete'`，否则 `delete=deny` 不生效。
- ⚠️ **变异要真能改变行为**：改到被前置过滤挡住的分支 / 只换执行顺序，都是空转变异（看到全绿会误导）。
