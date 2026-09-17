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
