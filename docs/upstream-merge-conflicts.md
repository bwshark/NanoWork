# 上游合并冲突面清单（`[LOCAL PATCH]` 全量）

> **本文用途**：V1 的引擎侧改动是直接打在 vendored 的 nanobot 源码上的（v2 第 2.2 节的「不 fork 主干」在这里存在张力）。
> 本文把**所有会被上游合并冲掉的改动**登记成可核对的清单，供将来合并上游时逐条重放。
>
> **数据来源**：2026-09-17 对本地引擎仓库 `nanobot/` 的实测（`git diff` / `Select-String`）。
> **唯一事实源**：`docs/nanowork-prd-design-v2.md`。本文只登记冲突面，不定义需求。

---

## 一、一句话结论

本地引擎 = **上游 `e93b92c2` + 1 个 V1 提交**（55 文件 / +8205 / −189）；
而上游 `origin/main` 已领先 **145 个提交**。也就是说：

> **合并上游时，冲突面 = 上游的 145 个提交 × 本地被打补丁的 28 个文件（104 处标记 + 8 个未标记文件）。**

这不是「将来某天」的问题——`origin/main` 已经在动，越晚合并冲突越大。

---

## 二、分叉现状（实测）

| 项 | 值 |
|---|---|
| 本地分支 | `sciherd-agent` |
| HEAD | `fda6c492 feat: 添加审计功能`（V1 成果，单提交） |
| HEAD 的父提交 | `e93b92c2 refactor(webui): extract outbound wire encoding (NAN-102)` |
| 上游远端 | `origin`（`HKUDS/nanobot`），`origin/main` = `2fb16593` |
| merge-base | `e93b92c2`（= 本地父提交，说明**没有分叉**，只是落后） |
| 上游领先 | **145 个提交** |
| 本地领先 | 1 个提交 |
| V1 提交规模 | 55 files changed, **8205 insertions(+), 189 deletions(-)** |

> 落后 145 个提交意味着：本地补丁的**上下文行**有很大概率已被上游改写，`git merge` 的自动合并成功率会很低，实务上应按「重放补丁」而非「合并分支」来规划。

---

## 三、补丁面 A：带 `[LOCAL PATCH]` 标记的改动（28 文件 / 104 处）

标记格式：源码注释里的 `# [LOCAL PATCH] ...` 或 docstring 内的 `[LOCAL PATCH]`。
**命中文件数 28，命中次数 104。** 行号为 2026-09-17 的快照，合并前需按标记文本重新定位（行号必然漂移）。

| 文件（相对 `nanobot/`） | 处 | 行号 | 主题 |
|---|---:|---|---|
| `api/server.py` | 16 | 188,307,394,427,434,438,442,460,504,571,591,721,768,827,958,960 | FR-2.2 工具策略 · 会话四轴透传 · 审批回传端点 · `/v1/plugins` · 进度/计划事件注入 SSE · 请求级模型解析 |
| `security/workspace_access.py` | 15 | 13,17,87,90,93,102,119,158,261,273,290,317,363,441,448 | 会话四轴（`access_mode` / `tool_approval` / `session_mode` / `tool_allow`）承载与归一 |
| `agent/tools/filesystem.py` | 10 | 41,46,51,89,92,94,132,159,229,1278 | FR-8.3 删除留痕 / 批量守卫 / `delete_file` 改道回收站 · FR-3.4 用户级插件目录 |
| `security/tool_approval.py` | 7 | 11,26,49,59,71,106,158 | `decide_tier` 三档 · `sandbox` 档 · `submit_plan` 非副作用 · 模式禁止判定 |
| `agent/subagent.py` | 5 | 146,151,238,455,594 | 子代理技能/插件清单与主代理同源 · 子代理提示词可覆盖 |
| `agent/tools/execution.py` | 5 | 46,50,85,159,222 | FR-8.2/8.9 审计留痕 · 审批否决消费点 · 凭据目录硬边界 |
| `utils/prompt_templates.py` | 5 | 7,41,65,98,125 | §13.4/ADR-007 提示词外置（可覆盖白名单 / 覆盖路径 / 默认副本落盘） |
| `agent/tools/mcp.py` | 4 | 1143,1166,1201,1366 | 工具级授权黑名单（`disabled_tools`）· 插件来源覆盖用户级目录 |
| `utils/progress_events.py` | 4 | 21,31,77,91 | 把审批请求 / 计划事件推给客户端 |
| `agent/context.py` | 3 | 36,147,239 | §13.3 `<identity_context>` 标签 · 主提示词可被 `<workspace>/prompts/` 覆盖 |
| `agent/hooks/tool_approval.py` | 3 | 3,96,102 | 逐条批准的引擎侧实现（模式/白名单拒绝的归属说明） |
| `agent/loop.py` | 3 | 389,688,2448 | FR-3.4 用户级插件目录存到实例 · 消息级 metadata 注入 |
| `agent/skills.py` | 3 | 25,132,137 | FR-3.1 技能三态覆盖 · 用户级技能/插件目录 |
| `agent/turn_hooks.py` | 3 | 68,76,83 | 审批门 / 模式门 / 工具白名单声明为**基线能力**（非可选扩展） |
| `config/schema.py` | 3 | 148,382,724 | FR-3.1 `skillOverrides` · `disabled_tools` · 排查提示 |
| `agent/plugins.py` | 2 | 28,243 | FR-3.4 组件位置候选与回退（`.nanowork-plugin/`） |
| `security/workspace_policy.py` | 2 | 19,264 | FR-8.4 `default_deny_write` |
| `agent/hook.py` | 1 | 69 | **`before_execute_tool` 否决通道**（ADR-021 的收口点） |
| `agent/hooks/agent_tools.py` | 1 | 3 | FR-2.2 工具白名单引擎侧强制点（整文件新增） |
| `agent/hooks/session_mode.py` | 1 | 3 | FR-1.4 执行模式引擎侧强制点（整文件新增） |
| `agent/tools/context.py` | 1 | 95 | FR-3.4 用户级插件目录 |
| `agent/tools/path_utils.py` | 1 | 22 | FR-8.4 写操作默认策略 |
| `agent/tools/plan.py` | 1 | 3 | FR-1.5 `submit_plan` 工具（整文件新增） |
| `agent/tools/shell.py` | 1 | 831 | FR-8.3 运行时硬兜底 |
| `cli/commands.py` | 1 | 372 | 为 `serve` 进程注入 `CronService` |
| `security/audit.py` | 1 | 1 | FR-8.2/8.9 append-only 审计（整文件新增） |
| `security/trash.py` | 1 | 1 | FR-8.3 回收站改道（整文件新增） |
| `utils/helpers.py` | 1 | 926 | §13.4 可覆盖主提示词默认副本落盘 |

> **整文件新增的 8 个模块**（无上游对应物，合并时不会冲突，但**会被上游的同名新文件顶掉**，需确认上游是否已自行实现同类能力）：
> `agent/hooks/{agent_tools,session_mode,tool_approval}.py`、`agent/tools/plan.py`、
> `security/{audit,trash,tool_approval}.py`、`templates/IDENTITY.md`。

---

## 四、补丁面 B：**未打标记**的改动（8 文件）

V1 提交还改了 8 个上游文件却**没有留 `[LOCAL PATCH]` 标记**。这些是合并时最容易漏掉的部分——
按标记搜索会直接跳过它们。

| 文件 | 规模 | 说明 / 待办 |
|---|---|---|
| `nanobot/cli/gateway_runtime.py` | **+130 / −28** | **最大的未标记改动面。** 疑为网关路由注册（审批回传 / 插件清单 / cron 注入等）与运行时装配。**建议补标记并补注释** |
| `nanobot/templates/prompts/README.md` | +31 / −1 | 提示词外置的使用说明（文档类，冲突影响低） |
| `nanobot/cron/service.py` | +20 | cron 服务接线（与 `cli/commands.py` 的 `CronService` 注入配对） |
| `nanobot/providers/openai_compat_provider.py` | +12 | provider 侧适配（与 `session_locks` 改名同批） |
| `nanobot/apps/cli/service.py` | +7 / −2 | CLI 服务装配 |
| `nanobot/webui/mcp_presets_api.py` | +4 / −2 | MCP 预设接口 |
| `.gitignore` | +1 | 忽略 `.ptmp/`（测试临时目录，2026-09-17 补） |
| `webui/package-lock.json` | −43 | 依赖锁变动（**建议确认是否应保留**，锁文件冲突会阻断合并） |

> **待办（本次未做）**：为上述前 6 个源文件补齐 `[LOCAL PATCH]` 标记与动机注释。
> 现状是「标记覆盖率 = 104 处 / 预计 110+ 处」，漏标会让上游合并变成考古。

---

## 五、语义**刻意反转**的上游契约（3 处断言）

这三处不是普通的补丁，而是**与上游既有测试契约相反**的决策。合并上游时如果直接接受上游版本，
安全行为会被静默撤销。全部集中在 FR-8.3（删除改道回收站）：

| 文件 / 用例 | 上游契约 | nanowork 契约 | 理由 |
|---|---|---|---|
| `tests/tools/test_exec_security.py::test_exec_3599_regression_rm_with_dev_null_redirect` | `` rm <ws>/f 2>/dev/null `` 应成功，文件被删 | 该命令**必须被拦下**（`delete_file`），且文件**原封不动** | `rm` 无法进系统回收站；删除只能走 `delete_file` |
| `tests/tools/test_exec_security.py`（参数化允许列表） | 把 #3599 报障者的原句列为**放行**样例 | 该句从放行列表**移除**，覆盖迁到新用例 `test_shell_delete_is_intercepted_even_with_dev_null_redirect` | 同上；且拦截原因必须指向 `delete_file` 而非「路径越界」（否则模型会改路径重试而不是改道） |
| `tests/tools/test_tool_validation.py::test_exec_guard_allows_dev_null_redirect` | `rm "..." 2>/dev/null` → `error is None`（放行） | 同一命令被拦下并指向 `delete_file`；重定向合法性改由**非删除命令**（`cat ... 2>/dev/null`）覆盖 | 同上 |

另有 1 处**签名改名**（同样会与上游冲突）：`nanobot/api/server.py` 的 `handle_chat_completions`
入参由上游的 `session_lock`（单锁）改为本地 `session_locks`（注册表），
`tests/test_openai_api.py` 三处构造随之调整，并新增对 `model_presets` / `runtime_resolver` 的显式置空。

---

## 六、合并上游的操作步骤

**不要 `git merge origin/main`。** 落后 145 个提交时，正确做法是按补丁面**重放**：

1. **先冻结**：记录当前 HEAD（`fda6c492`）与本文快照，确认本地工作区干净。
2. **建分支试合并**：`git switch -c try-merge-upstream origin/main`，只做**试**合并，不解决冲突，
   目的是拿到 `git merge --no-commit` 后的冲突清单与「上游已改动同一区域」的文件集合。
3. **按主题重放补丁**（推荐顺序，依赖在前）：
   1. 提示词外置（`prompt_templates.py` / `context.py` / `helpers.py`）——依赖最少
   2. 技能三态与用户级目录（`skills.py` / `plugins.py` / `subagent.py` / `tools/context.py` / `tools/mcp.py` / `config/schema.py`）
   3. 会话四轴与执行模式（`security/workspace_access.py` / `agent/hooks/session_mode.py` / `agent/tools/plan.py` / `utils/progress_events.py`）
   4. 工具网关与审批（`agent/hook.py` / `agent/hooks/tool_approval.py` / `security/tool_approval.py` / `agent/turn_hooks.py`）
   5. 删除改道与审计（`security/trash.py` / `security/audit.py` / `agent/tools/filesystem.py` / `agent/tools/shell.py` / `agent/tools/execution.py` / `agent/tools/path_utils.py`）
   6. API/CLI 接线（`api/server.py` / `cli/commands.py` / `cli/gateway_runtime.py` / `providers/openai_compat_provider.py`）
   7. 测试（含第五节 3 处**反转**断言——必须在重放后重新确认它们仍是反转的）
4. **每重放一批就跑一次引擎测试**（命令见 `docs/engine-dev-setup.md`），不要攒到最后。
5. **核对第五节**：合并后 grep 三个反转用例，确认本地契约仍在，未被上游版本覆盖。
6. **回填本文**：更新「分叉现状」表的 HEAD 与领先/落后数，重新生成第三节表。

---

## 七、维护约定

1. **新增引擎侧改动必须打 `[LOCAL PATCH]` 标记**，并写明：对应 `FR-x.y` / `§` 编号 + **为什么不改上游就做不到**。
   例外仅限纯新增文件（已自明）与文档。
2. **每季度（或上游发版时）重跑本文第三节的统计**，更新分叉现状表。落后的提交数是最直观的债务指标。
3. **禁止扩大标记面**：能在客户端（`src/`）解决的问题不要下沉到引擎。
   目前 104 处已是显著债务，v2 第 2.2 节「不 fork 主干」的张力在本文如实登记，不做粉饰。
4. 补齐第四节 6 个未标记文件的标记，属当前待办。

---

## 八、相关文档

| 文档 | 关系 |
|---|---|
| `docs/nanowork-prd-design-v2.md` §2.2 / §10.3.1 / §11.1.1 / §13.4 / ADR-021 / ADR-024 | 定义「为什么必须下沉到引擎」 |
| `docs/engine-dev-setup.md` | 引擎仓库边界、venv、测试命令、对象库修复记录 |
| `docs/adr/ADR-0021.md` / `ADR-0024.md` | 两处最大补丁面的决策依据（工具收口、执行模式） |

---

## 九、V1.6 追加的引擎侧补丁（2026-10-16，B7 扩展面）

> 本节是**增量登记**，不重排前几节的快照编号。§三 的表是 2026-09-17 的快照
> （28 文件 / 104 处）；本次追加后实测 **34 文件 / 146 处**（差额含 V1.5 / M6 各批，
> 不全是本节这批）。

| 文件（相对 `nanobot/`） | 本次改动 | FR | 为什么不改上游做不到 |
|---|---|---|---|
| `agent/plugins.py` | `AgentPlugin` 加 `prompt_dirs` / `agent_files` / `command_files` / `hook_manifest` / `tool_policy`（均在**解析期**过 `_contained()`）；新增 `PluginMount` + `enabled_agent_plugin_mounts()`（统一挂载表）+ `plugin_trust()` + `plugin_prompt_mounts()`；`_invalidate_skill_cache` 连挂载表一起清 | FR-3.10 / 3.11 / 3.12 | 上游的清单解析面只认 `$schema` / `name` / `description` / `repository` / `extensions` / `mcpServers`，技能走目录约定。**「声明了但没读的字段」只能由我们自己读起来** |
| `utils/prompt_templates.py` | 单 `FileSystemLoader` → **ChainLoader**（① 插件命名空间 ② 工作区覆盖 ③ 内置）；新增 `PluginPromptLoader` / `WorkspaceOverrideLoader` / `wrap_untrusted()` / `PluginPromptMount`；`render_template` 加 `plugin_mounts=` | FR-3.10 ①③④ | 上游是单 loader + 覆盖白名单，第三方无法在不改引擎代码的前提下注入领域规程。且上游式覆盖用 `from_string`，**产出的模板没有 loader** → 覆盖文件里的 `{% include %}` 一律解析不到（这是本次才发现的既有缺陷，不是新增行为） |
| `agent/context.py` | `self.user_plugins_dir` 落实例；新增 `_plugin_prompt_mounts()`；把挂载点透传进 `build_system_prompt` / `_get_identity` 的 4 处 `render_template` | FR-3.10 | 不接线 = 片段永远进不了系统提示词（本仓库在 `session_mode` 上踩过同款「函数对了但没接线」的静默缺陷） |
| `agent/hooks/plugin_tools.py`（**新增**） | 声明式工具白名单的策略代数（`parse_declared_tools` / `combine_declarations` / `policy_gaps`）+ `DeclaredToolPolicyHook` + 工厂 | FR-3.12 | 技能与插件的作者此前只能靠提示词表达「我只用这些工具」，而提示词是软约束。工具执行唯一入口 `before_execute_tool` 在引擎侧，客户端拦不住 |
| `agent/turn_hooks.py` | `AgentTurnHookSpec.declared_tools` 字段；把声明门挂进基线链（排在 Agent 授权门之后） | FR-3.12 | 与审批门 / 模式门 / 授权门同级：ephemeral turn 同样绕不过 |
| `agent/loop.py` | 装配点传 `declared_tools=self.context.declared_tool_policy(...)`（**装配期算一次**，不让热路径上的每次工具调用去扫盘） | FR-3.12 | 声明来自磁盘（技能 frontmatter / 插件清单），而工具调用是热路径 |
| `agent/skills.py` | `SkillsLoader.declared_tools()`：读 always 技能 frontmatter 里**原始**的 `tools:` 值（刻意不在这里收敛，收敛归 `plugin_tools.parse_declared_tools`，避免两份规则漂移） | FR-3.12 | 技能元数据只在引擎侧解析，客户端拿不到 |
| `agent/context.py`（追加） | `declared_tool_policy()`：把「always 技能」与「已启用插件」两处声明合成一份策略 | FR-3.12 | 两个来源合起来的规则（**交集**）需要一个落点，放在客户端等于两份真相 |

**三条给合并上游时的提醒**：

1. **`WorkspaceOverrideLoader` 是行为变更**（不只是新增）：覆盖模板里的 `{% include %}`
   从「解析不到」变成「能解析」。若上游也重建了覆盖机制，要保住这一点。
2. **自定义 loader 的 `get_source` 找不到时必须 `raise TemplateNotFound`，不能 `return None`**：
   Jinja 的 `BaseLoader.load` 会解包返回值，返回 `None` 抛的是
   `TypeError: cannot unpack non-iterable NoneType object`，而 `ChoiceLoader`
   **只捕 `TemplateNotFound`** → 这个 TypeError 会带着一个与模板名毫无关系的栈冒到业务代码。
   本次实测踩到（见 `tests/agent/test_plugin_prompt_fragments.py` 的用例注释）。
3. **ChainLoader 的内置 loader 必须始终在链尾**：漏掉它时链上唯一那个 loader 抛错后无人接手，
   `agent/platform_policy.md` 这类内置模板会直接解析失败 —— 而报错看起来像「模板文件不见了」，
   真因却是「忘了把兜底那一级接上」。
4. **`create_declared_tool_policy_hook` 必须用 `isinstance` 认形状，不能只判 `is not None`**：
   `declared_tools` 由装配方喂进来，任何「长得像但不是」的值都会造成最坏的一种故障 ——
   门挂上了、白名单是空的、**所有工具全被拒**，而拒绝原因里连一个来源名都没有。
   实测来源：单测把 `ContextBuilder` mock 掉后返回 `MagicMock`，它 `is not None` 但
   `__contains__` 恒为 False。认不出形状一律当「没声明」（不约束）+ warn。
5. **`tools:` 是既有 frontmatter 里的新键**：合并上游时若上游引入了同名字段（不同语义），
   必须显式决定取谁。本次实现按**硬白名单**语义解释（见 `plugin_tools.py` 模块 docstring），
   并已确认当时的内置技能没有任何 `tools:` 键（`grep -rn '^tools:' nanobot/skills/` 为空）—— 合并后要重跑这个检查。

### 6. FR-8.13 路径级权限规则（2026-10-16 追加）

| 文件（相对 `nanobot/`） | 本次改动 | FR | 为什么不改上游就做不到 |
|---|---|---|---|
| `security/path_rules.py`（**新增**） | 复合动作（读 / 写 / 删各自授权）的规则形状、归一化、最具体匹配、裁决与拒绝原因 | FR-8.13 | 上游只有「一个 allowed_root + 一个 deny_write 开关」，没有按路径分动作的概念 |
| `security/workspace_policy.py` | `resolve_allowed_path()` 加 `rules` / `kind` 两个参数，并把规则插进优先级链 | FR-8.13 | 这是路径访问的**唯一收口**（ADR-021），规则必须挂在这里才拦得住所有工具 |
| `agent/tools/path_utils.py` | `resolve_workspace_path()` 透传 `rules` / `kind` | FR-8.13 | filesystem 工具的公共解析入口 |
| `agent/tools/filesystem.py` | `FileToolsConfig.path_rules` 字段；`create()` 里归一化一次；`_resolve_read` / `_resolve_write` / 删除入口各自传 `kind` | FR-8.13 | 配置字段要在工具侧落地；删除复用写解析路径但**必须按 delete 裁决**，否则 `delete=deny` 永不生效 |

**优先级顺序（合并上游时的断言点）**：① 凭据 `no_access`（无条件，规则不可覆盖）→ ② 工作区 /
允许根包含性（规则不能放宽边界）→ ③ 路径规则 → ④ `default_deny_write`。
四条各有一条用例钉住（`tests/security/test_path_rules.py`）。

**⚠️ 一个必须一起带走的修复（`agent/context.py`）**：本会话早些时候给 `context.py` 加了
**模块级**的 `from nanobot.agent.plugins import ...`，把 `agent/__init__ → context →
plugins → config.loader → config.schema` 闭成了环。症状是 `config/schema.py` 末尾的
`_resolve_tool_config_refs()` 静默失败，于是**任何** `Config.model_validate` 都抛
`` `Config` is not fully defined; you should define `WebToolsConfig` ``（`tests/config/test_model_presets.py`
因此红了一整轮）。已改为**函数内局部导入**（schema.py 末尾本就写着这条排查提示）。
合并上游时若看到 `context.py` 里出现模块级的 plugins 导入，按同一条理由驳回。

---

## 十、桌面端助理视图的实时进度旁路（2026-10-19 追加）

> 这一批解决的是「助理（IM）视图在等回复期间界面全空」：任务视图走 `/v1/chat` 的 SSE
> 能逐帧拿到思考与工具行，而 `/v1/turn` 那条链路只回「已受理」，进度经
> `bus.publish_outbound` 全部发给了渠道自己（飞书卡片等），桌面端看不到。
> 做法是在 `TurnDelivery` 的进度回调上**并联一个旁听者**，把同一份事件攒成内存快照，
> 再经 gateway health 端口的 `GET /v1/turn/progress` 增量取走。

| 文件（相对 `nanobot/`） | 本次改动 | 为什么不改上游做不到 |
|---|---|---|
| `gateway/turn_progress.py`（**新增**） | `TurnProgressStore`：`begin` / `observe` / `finish` / `snapshot(since)`；事件形状与 SSE 的 `nanobot_event` 对齐；只记登记过的会话；溢出丢最旧一段 | 引擎没有任何「进度快照」概念，进度是**一次性**投递给渠道的流，不落任何可读状态 |
| `agent/turn_delivery.py` | `TurnDeliveryFactory(progress_observer=...)` + `TurnDelivery.progress_observer`；`progress_callback()` 返回「旁听 + 原样投递」的包装；包装形参**逐字对齐**底层回调 | 这是全轮进度事件的唯一汇合点。挂在渠道侧只服务那一个渠道；挂在 `on_progress` 外层拿不到 `session_key` |
| `cli/gateway_runtime.py` | 装配 `TurnProgressStore` + 订阅 `TurnCompleted` / `TurnRunStatusChanged`；`/v1/turn` 受理前 `begin`；新增 `GET /v1/turn/progress` | 端点必须与 `/v1/turn` **同进程**：会话 key 的形态受 `unified_session` 影响，客户端自己算必错 |

**三条给合并上游时的提醒**：

1. **包装回调不能写 `**kwargs`**：引擎用 `inspect.signature` 判断通道能力
   （`on_progress_accepts_plan_events` 等）。多一个 `**kwargs` 会把「不支持」变成「支持」，
   调用方随即把 `plan` 事件发进来，再原样转发给底层回调 → `TypeError`。
2. **旁听者的异常必须被吞掉**：进度只是「看得见」，渠道投递才是「发得出去」。
   旁路写失败绝不能连带这一轮回复一起失败（`tests/gateway/test_turn_progress.py` 有用例钉住）。
3. **`begin` 要在 `publish_inbound` 之前**：`publish_inbound` 会让出事件循环，
   引擎的 `run()` 可能立刻开始回吐进度；先投递后登记会静默丢掉头几条（往往是整段思考）。
