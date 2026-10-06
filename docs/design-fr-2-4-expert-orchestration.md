# FR-2.4 专家团编排：引擎侧设计方案（2026-10-05）

> **决策（2026-10-05）**：走 **路径 2「引擎编排」**——语义最正（成员在同一 turn 内执行、
> 事件流天然可归属），代价是引擎改动最大且有一个前置修复项。落地顺序排在 `FR-7.4` 之后，
> 实施步骤见 §7。
>
> 目标：让 `sequential` / `parallel` / `coordinator` 三模式**真实执行**，且编排过程在
> ProcessView 里可见。本文先给**事实**（现状为什么做不了），再给**三条可选路径**，
> 最后给**需要产品先拍板的语义问题**——这些问题不定，任何实现都会返工。

## 1. 现状：为什么现在做不了（代码依据）

| 事实 | 位置 |
| --- | --- |
| `mode` 全仓**没有任何执行读取点**（只在类型 / 标签 / 表单 / 卡片 / tooltip） | `src/types/expertGroup.ts`、两个 agents 页面 |
| 团成员唯一被逻辑读取处是「取首位启用成员当 leader」，所以**只有那一个成员生效** | `sessionsStore.createSession` |
| 引擎只有**匿名子代理**：`spawn` 工具的入参是 `task / label / temperature / wait`，**没有人设、没有工具策略** | `nanobot/nanobot/agent/tools/spawn.py` |
| 子代理人设由**固定模板**构造，函数签名里没有 agent 概念 | `agent/subagent.py:570` 的 `_build_subagent_prompt(workspace)` → `templates/agent/subagent_system.md` |
| 引擎的 `agent_id`（请求参数）**只用于工具策略**，不是人设路由 | `api/server.py`、`security/workspace_access.py` |
| 「带人设的专家」完全由**客户端**拼提示词实现（`assemblePromptSections` 的 agent-persona 段）+ 下发 `tool_allow`/`tool_deny` | `src/lib/promptAssembly.ts`、`sessionsStore.send` |
| 已知缺陷：`/v1` 链路下 `spawn(wait=false)` 的**结果必然丢失**——根因是 **serve 进程没有 inbound 消费者**（见 §7.0 更正），不是跨进程 | `OVERVIEW.md` |
| `ProcessEvent` 无成员字段 → 「谁在跑」连数据源都没有 | `src/types/process.ts` |

**结论**：引擎里没有「运行某个具名 Agent」这个概念。三模式要真跑，只有两条路——
**在客户端编排**，或**给引擎新增派发能力**。第三条「伪编排」可以做但要如实命名。

## 2. 设计前必须拍板的 5 个语义问题

这些是**产品决策**，不是技术选择。不定它们，实现必然返工：

1. **谁产出最终答案？**
   - `sequential`：最后一个成员？还是 leader 汇总？
   - `parallel`：谁整合多视角结论（leader 再跑一轮？还是机械拼接）？
   - `coordinator`：leader 直接输出，还是结束后再收口一次？
2. **上下文怎么传？** 前一个成员的**完整输出**给下一个（token 爆炸），还是只给摘要？
   并行时各成员是否都能看到用户原始输入 + 会话历史？
3. **失败怎么办？** 一个成员失败 → 整个团失败？跳过它继续？让 leader 决定重试？
4. **成本预算**：3 个成员 = 3 倍 token。要不要给团设「最多 N 个成员参与」或让用户看到预估？
5. **过程可见性**：ProcessView 里怎么表达「现在是成员 B 在跑」？
   ——需要新的消息/事件类型，还是给现有事件加 `memberId` 字段？

## 3. 三条路径

### 路径 1：客户端编排（零引擎改动，推荐作为第一步）

**做法**：客户端按模式依次 / 并发发起 N 次请求，每次用**该成员的人设 + 工具策略 + 模型**
（这三样现有能力都支持），最后一次由 leader 收口：

```
用户输入
  → [客户端] for 成员 in 团.members: 发一次请求（agentId=成员, 注入该成员 systemPrompt）
      每次的输入 = 用户原始输入（+ 可选：前序成员的结论摘要）
  → [客户端] 最后一次请求：以 leader 人设汇总 N 份结论 → 作为唯一一条 assistant 消息落库
```

- `sequential` = 串行，后者能看到前者的输出（按 §2 第 2 条决定给全文还是摘要）
- `parallel` = 并发发起（`Promise.allSettled`），再让 leader 汇总
- `coordinator` = 先让 leader 产计划，再按计划派发，最后 leader 收口

**改动面**：全在客户端（发送链路 + 消息模型 + ProcessView 的成员归属 + 失败处理）。

**优点**：零引擎改动；专家人设/工具/模型三件套现成；进度完全可控（客户端自己知道谁在跑）。

**代价 / 风险**：
- 每个成员是**独立的会话 turn** → 会产生多条 assistant 消息，需要决定「落库形态」
  （全部保留？折叠成一条？只留汇总？）——直接影响会话历史与后续上下文
- **token 成本 N 倍**，且要自己控制上下文长度
- 中断语义：用户点「停止」时要能取消所有在飞的成员请求
- 会话的 `activeId` 只有一个 → 并发请求下的事件流要靠 `memberId` 分流（否则进度会串）

### 路径 2：引擎编排（语义最正，改动最大）

**做法**：给引擎加「按具名成员派发」的能力，三模式在引擎内调度。

引擎侧接口草案（示意）：

```python
# 请求侧：客户端在 turn 请求里带上成员清单（人设 / 工具 / 模型）
{
  "messages": [...],
  "expert_group": {
    "mode": "sequential" | "parallel" | "coordinator",
    "members": [
      { "id": "builtin:legal", "name": "法务专家",
        "system_prompt": "...", "tool_allow": [...], "model": "qwen" }
    ],
    "lead": "builtin:general",
    "aggregate": "lead" | "concat"
  }
}
```

引擎侧需要新增/修改：

1. `SubagentManager.spawn() / run_inline()` 增加 `system_prompt`、`tool_allow`、`tool_deny`、`model`
   四个可选入参，并在 `_build_subagent_prompt` 里按 §2 决定「覆盖 vs 追加」；
2. 一个新的调度器（或在 `run_turn` 里）读 `expert_group`，按 mode 依次 / 并发调用上面两条路径之一；
3. 客户端需自行等待并发成员（不受 §7.0 缺陷影响——客户端编排用同步调用，不走总线）；
4. 事件流补成员归属（`member_id` 进 `ProgressEvent`），否则 ProcessView 仍无法表达「谁在跑」。

**优点**：一次请求搞定；成员在**同一 turn** 内跑 → 事件流天然可归属；客户端不必自己管并发/中断/上下文。

**代价**：引擎是能力把关点，这四步都不是小改动；且第 3 步是**前置阻塞项**。

### 路径 3：明确降级的「单模型扮演」（立刻可交付，但必须如实命名）

**做法**：不真的派发多个成员，而是把「团 + 模式 + 成员清单（含各自人设）」合成为**一段系统提示词**
注入给 leader，让它自己多视角产出。

- 改动极小（客户端拼提示词，零引擎改动）
- **产出形态上**能体现「多视角 / 主从」，但**本质是一个模型跑一遍**
- ⚠️ 命名必须诚实：界面上叫「多视角分析（单模型扮演）」，**不能叫「并行会诊」**——
  否则就是「声明一个不生效的档位」的同一类坑（参见投递档位 `milestone` 与 §20.9.6）

## 4. 对比与建议顺序

| | 真实性 | 引擎改动 | 客户端改动 | 主要风险 |
| --- | --- | --- | --- | --- |
| 路径 1 客户端编排 | **真**（N 次真实调用） | 无 | 中 | 落库形态 / 上下文长度 / 并发与中断 |
| 路径 2 引擎编排 | **真**（引擎内调度） | 大（4 步，含一个前置修复） | 中 | 引擎改动面 + 背景结果丢失的历史缺陷 |
| 路径 3 单模型扮演 | **假**（1 次调用） | 无 | 小 | 命名不诚实时会误导用户 |

**建议**：

- **第一期（立刻可用）**：把 UI 的诚实说明保留（已落，见 §20.9.6），**不急着上路径 3**
  ——它带来的收益（多视角文案）小于「用户以为真在并行」的误导风险。
- **第二期（真编排第一步）**：走**路径 1**，但**只做 `sequential`**。
  理由：串行最容易讲清语义（一条接一条，天然有序）、最容易做进度归属、也不涉及并发与中断的复杂度。
  同时把 §2 的 5 个问题在实现里定下来并写进 PRD。
- **第三期**：在路径 1 的三个模式都跑通、且用户对「N 倍 token」有感知之后，
  再评估是否值得下沉到路径 2（引擎编排），其起点是第 1 步「按成员派发」，不是 §7.0。

## 5. 验收（路径 1 · sequential 为例）

1. **真的调了 N 次**：引擎侧 `/v1` 请求日志里能看到 N 次带不同 `agent_id` / systemPrompt 的调用
   （不是一次调用里的多段文案）；
2. **顺序是真的**：成员 B 的输入里能看到成员 A 的输出（按 §2 第 2 条的形式）；
3. **归属可见**：ProcessView 能标出「成员 A / 成员 B」，且事件不串到同一个气泡里；
4. **失败被定义**：让某个成员失败，行为符合 §2 第 3 条的约定，且用户能看到是哪一步失败；
5. **成本可见**：这次执行消耗的 token / 金额能在用量页对上（N 倍是预期的）。

## 6. 附：为什么「让模型自己 spawn 成员」不是一条独立路径

有人会想：给 leader 一个 `spawn_member(member_id, task)` 工具，让它自己决定派谁。
这**不是**独立路径，而是**路径 2 的一种触发方式**——它同样需要：

- 引擎知道「本会话有哪些成员」（上方 `expert_group.members` 的输入通道）；
- `spawn` 支持注入成员人设与工具策略（路径 2 第 1 步）；
- 结果回得来（路径 2 第 3 步的前置修复）。

而且它把「编排正确性」寄托在模型的自觉上——`parallel` / `coordinator` 的模式语义
（并发度、汇总方式）无法靠提示词保证。所以要么由客户端调度（路径 1），
要么由引擎调度（路径 2），不要让模型临时决定。

## 7. 路径 2 的实施步骤（已选定）

> **2026-10-06 更正**：本节初稿把第 0 步写成「前置阻塞项」，且把根因写成「两进程各持
> MemoryBus」——**两条都错了**，见 §7.0。第 0 步与编排**无依赖**（编排器用 `run_inline`
> 直接 await，不走消息总线），已降级为独立缺陷修复；第 1 步才是真正的起点。

### 7.0 （独立缺陷，非前置）`/v1` 链路下 `spawn(wait=false)` 丢结果

**根因更正（2026-10-06 实测）**。初稿写的「serve / gateway 两进程各持 MemoryBus」不成立：

- 子代理跑在**发起它的那个进程**里。`/v1` 请求由 `serve` 进程处理
  （`nanobot/cli/commands.py:349` 起），所以 spawn 出的子代理也在 serve 进程，
  `_announce_result` 把结果 `publish_inbound` 到**同一个** `MessageBus`
  （`nanobot/agent/subagent.py:559`）→ 不涉及跨进程。
- 真因是 **serve 进程里没有 inbound 消费者**：全仓唯一的 `consume_inbound()` 在
  `AgentLoop.run()`（`nanobot/agent/loop.py:1315`），而 `serve` 只做
  `web.run_app(...)`（`commands.py:448`），**从不调用 `run()`** → 注入消息永远躺在
  `asyncio.Queue` 里，无人唤醒主 agent。
  （两进程的说法对 **cron** 成立——调度由 gateway 独占——但与本缺陷无关。）

**与 FR-2.4 的关系：无依赖**。编排器应当用 `SubagentManager.run_inline()`
（`subagent.py:308`，`await inline_task` 直接返回结果、`announce=False`）并发 gather，
**完全不经过消息总线**。所以丢结果不会阻塞编排；它只影响「用户手动让 agent 后台跑个任务」
这个普通聊天场景——模型承诺了 "I'll notify you when it completes"，而这句话在本链路下
**永远兑现不了**。

修法候选（待定，语义差异大，需先选）：

| 方案 | 语义 | 代价 |
| --- | --- | --- |
| A 请求内等待 | HTTP 响应前等本会话后台任务完成，结果随响应返回 | 后台变前台等待，长任务会撞 `timeout_s` |
| B serve 起消费者 | 保留真后台，续跑主 agent 汇总 | 客户端拿不到（HTTP 已关），需新通道 + 客户端配合 |
| C 不撒谎 | 该链路下明确告知「后台结果不会自动回来」，或强制 `wait=true` | 不提供能力 |

**验收**（任一方案）：起一个背景子代理，断言它的结果不再静默消失——要么回到调用方，
要么被明确告知。

### 第 1 步：让派发支持「按成员」—— **已落地（2026-10-06）**

实测后比原计划**小得多**，因为三块里有两块早已具备，缺的是「接上」而不是「新建」：

| 能力 | 原计划 | 实测 | 落点 |
| --- | --- | --- | --- |
| 人设 | 新增 `system_prompt` 入参 | 新增 `persona` 入参，**追加**而非覆盖 | `subagent.py:_build_subagent_prompt` |
| 工具策略 | 新增 `tool_allow` / `tool_deny` | **已存在于 `WorkspaceScope`**，缺的是子代理侧没装授权门 | `subagent.py` 的 `CompositeHook` |
| 模型 | 新增 `model` 入参 | **`LLMRuntime` 本就带 model**，加 `with_model()` 即可派生 | `utils/llm_runtime.py` |

**顺带修了一个真实的安全旁路**：`_run_admitted_subagent` 的 hook 链里**没有**
`AgentToolPolicyHook`（只有 `ToolApprovalHook` / `SessionModeHook`）→ 父 Agent 被
`tool_deny` 挡住的工具，只要 `spawn` 还在白名单里，就能让子代理代劳（`_build_tools`
是全量加载的，不受父策略约束）。最小权限退化成「只对直接调用生效的礼貌」。

修法是**补上那一个 hook**，而不是新传一份策略：`SpawnTool` 已经把
`current_workspace_scope()`（父作用域，含 tool_allow / tool_deny）原样带进来，本函数
又 bind 了它——所以「权限单调递减」是**继承**出来的，不需要调用方记得再声明一遍
（后者必然会被漏掉）。FR-2.5 依赖的同一条约束也随之成立。

**人设为什么是追加**：`_build_subagent_prompt` 渲染的模板里装着**工作区边界与技能清单**，
那是安全边界不是风格。允许覆盖等于让「派发给成员」顺手开出一条越界通道。

**验收**：派出的子代理用的是**指定成员的人设与工具集**，而不是固定那份 `subagent_system.md`。
已配 6 例 + 2 条变异验证（移除授权门 / 改追加为覆盖，均确认转红）。

### 第 2 步：编排调度 —— **已落地（2026-10-06，引擎侧 + 客户端接线）**

**引擎侧**：新增 `agent/expert_group.py`（纯调度；「跑一个成员」由调用方以 `run_member` 注入，
生产实现是 `SubagentManager.run_inline`），加两处接线：

| 落点 | 改动 |
| --- | --- |
| `nanobot/agent/expert_group.py`（新） | `parse_expert_group()` 严格校验（非法形状抛 `ExpertGroupError`，**不静默降级**）；`ExpertGroupOrchestrator` 按 mode 调度、按 `aggregate` 收口；`run_member` 依赖注入 → 调度语义**不依赖模型即可单测** |
| `nanobot/agent/loop.py` | `_run_turn` 顶部命中 `expert_group` 即接管（`_maybe_run_expert_group`）——正常 agent loop **完全不跑** |
| `nanobot/api/server.py` | JSON 请求体读 `expert_group` → `parse_expert_group` 校验 → 放进 turn metadata；非法形状 **400**。**multipart 也支持**（以 JSON 串承载，`_parse_multipart` → `_json.loads`），避免「带附件的一轮」成为编排旁路 |

**客户端接线**（同一批落地，功能因此可从界面触达）：

| 落点 | 改动 |
| --- | --- |
| `src/ai/runtime/types.ts` | 契约类型 `ExpertGroupMember` / `ExpertGroupRequest`（camelCase）+ `ChatRequest.expertGroup?` |
| `src/lib/expertGroupRequest.ts`（新） | `buildExpertGroupRequest(group, agents, availablePresetIds)`：过滤已删/停用成员、逐字段映射、按预设有效性决定成员模型下发、**成员数 < 2 返回 `undefined`** |
| `src/ai/runtime/nanobotHttp/chat.ts` | `expertGroupWire()`：camelCase → `expert_group`（`system_prompt` / `tool_allow` …）；JSON body 与 multipart（JSON 串）两路都带 |
| `src/stores/sessionsStore.ts` | `streamAssistantReply` 由 `session.groupId` 解析团并塞进 `ChatRequest` |

**客户端两个判据（都不会报错、只会静默改行为，故单测覆盖）**：

- **单成员团不触发编排**：只有一名启用成员时不下发——与「单专家一轮」结果无差别，而引擎默认
  `aggregate="lead"` 会让同一名成员再跑一轮收口，白花一倍 token；
- **成员模型只在预设仍存在时下发**：目录未加载（`null`）时不筛，判据与 `resolveTurnModel` 一致。

**权限上限**：本轮作用域的顶层 `tool_allow`（= 会话 Agent / 团长的策略）仍是**上限**，
成员只能在其内进一步收窄（引擎侧 `_member_workspace_scope` 单调递减）。即「团长的工具策略界定
整团的能力边界」——这是有意的最小权限选择，不是遗漏。

**已定死的语义**（对应 §2 的 5 问）：

1. **谁产出最终答案**：`aggregate="lead"`（默认）→ lead 再跑一轮收口；`"concat"` → 机械拼接。
2. **上下文怎么传**：`sequential` 只把**成功成员**的产出喂给下一个；`parallel` 成员彼此不可见
   （这是并行的定义，不是丢上下文）；`coordinator` 先让 lead 出计划，计划进每个执行成员的输入。
   **不做摘要压缩**（token 优化留待后续）。
3. **失败怎么办**：单成员失败被**隔离**（记进 `MemberOutcome.error` 并继续）；**全部**失败才抛错。
4. **成本刹车**：`members ≤ 8`（`MAX_MEMBERS`）、`max_concurrent ≤ 8`，超限 400。
5. **落库形态（定死）**：**只有最终汇总落成一条 assistant 消息**；成员输出不是消息，只随进度事件
   出站（`member_started` / `member_finished` / `member_failed` / `group_planned` / `group_aggregating`）。
   实现上靠 `ctx.all_messages` 的前缀让 `prepare_save_boundary` 算出正确追加边界（`_finish_expert_group_turn`）。

**工具与模型**：成员作用域由父作用域派生——**白名单取交集、黑名单取并集**（权限只能单调递减，
`_member_workspace_scope`），成员没声明工具策略时**原样继承**（而不是清空）；成员模型经
`runtime_resolver` 解析（preset 名走 `resolve_preset`），解析不了退回本轮 runtime 并留痕。

**测试**：`tests/agent/test_expert_group.py` **26 例全绿**（脚本化 `run_member`，无模型）——
三种 mode 的顺序/并发上限、`concat`/`lead` 聚合、空汇总回退拼接、单成员失败隔离、全失败抛错、
事件归属、事件监听器抛错不拖垮调度，以及 11 条非法形状的参数化校验。

**验收**：一次请求内真的调了 N 个成员（引擎日志可见），顺序符合 mode 语义。

**未做（第 2 步的剩余）**：

- 成员的 token 用量没有汇总进 `_last_usage`（用量页暂时看不到这 N 倍成本）。
- 过程事件的**前端按成员分组渲染**属第 3 步；当前服务端 `_on_progress` 会忽略这些未知 kwarg
  （字段已就位，等第 3 步消费）。
- 客户端 UI 还未暴露 `lead` / `aggregate` / `maxConcurrent` 三个旋钮（现用引擎默认值）。
- 端到端真机验证（起真实网关跑一次两成员团）尚未做——沙箱拉不起 nanobot 网关，
  客户端接线由单测 + 引擎源码静态闭环。

### 第 3 步：事件流补成员归属 —— **已落地（2026-10-06）**

引擎侧此前**已经**在 `_on_member_event` 里把 `member` / `member_event` 送进 `on_progress`
（第 2 步就位），缺的是「接上」——而且接到一半会静默丢事件：

| 落点 | 改动 |
| --- | --- |
| `nanobot/agent/loop.py` | `extra` 改**整体**塞进 `member_extra`（原先平铺）。`group_planned` 的载荷带一个 `plan` 键，而 `/v1` 的 `_on_progress` 恰好有同名形参（语义是 Plan 模式的结构化计划、期望 dict）→ 平铺会绑成它并走 `{**plan}` 对 str 解包 → TypeError。异常被 orchestrator 的 `_emit` 吞掉，现象是「计划事件凭空消失、什么都不报」 |
| `nanobot/api/server.py` | `_on_progress` 显式收 `member` / `member_event` / `member_extra`，下发 `kind: "member"`（透传载荷先展开、固定键后覆盖，归属字段不允许被载荷同名键改写） |
| `src/types/process.ts` | 新增过程行 `MemberEvent`（`kind: 'member'`，五相位）。**独立一类**而不是给工具行加 `memberId`：成员产出既不是工具调用也不是思考，塞进工具行会让「工具」这个词再也说不清自己指什么 |
| `src/types/event.ts` + `events/{factory,project}.ts` | 新增事件 `expert-group-member`。**必须落盘**：打开会话时消息由事件流重建，只改内存会「刷新后成员归属凭空消失」，而实时那一轮看起来完全正常 |
| `src/ai/runtime/types.ts` + `nanobotHttp/chat.ts` | 契约 `ProcessMemberEvent` + `onProcessMember`；相位走**白名单映射**，未知相位**忽略**而不是猜（猜错会把「团长在汇总」显示成「成员开始执行」） |
| `src/stores/sessionsStore.ts` | `handleProcessMember`：闭合思考段 → 记事件 → 更新 `Message.process`；行 id 取**落盘事件 id**，让实时与重放两条路径的 key 一致 |
| `src/lib/processDetail.ts` | `MemberGroupRow` + **跨事件分组**；`result` 档只留失败成员 |
| `src/pages/chat/ProcessView.tsx` | 成员组行：成员名 + 状态 + 按需展开的产出/计划；**失败原因不折叠** |
| `src/lib/processDigest.ts` | 署名头步数**按成员计，不按相位计**（相位相加会让「3 个成员的团」显示成「8 步」） |

**几条定死的展示口径**（都不会报错、只会显示错话，故每条都有用例）：

- **按成员 id 归组，不按相邻段**：`parallel` 的事件是交错的（A 开始 → B 开始 → A 完成 → B 完成），
  按相邻分组会把同一成员劈成两块、界面上出现两次——验收里「事件不串」说的正是它。
- **失败优先、不洗白**：成员只要失败过一次就判失败，之后的产出不改写这个结论。
- **回合结束后停在中途 → 「结果未返回」**（不说「失败」：可能已经跑完、只是相位没送到）；
  **最后动作是汇总 → 「已结束」**（汇总的产出就是下面那条最终回答，写「结果未返回」
  会与用户正读到的正文自相矛盾）。
- **`result` 档只留失败成员**：与工具行的档位豁免同一条原则——异常永不隐身。

**未做**：成员**内部**的工具调用不上报（成员跑在子代理里，`run_inline` 没有回传通道），
所以成员块只显示相位与产出，不显示它内部每一步做了什么。**这是引擎侧的现状，不是渲染层的省略**——
界面如实只画拿得到的东西。

**验收**：ProcessView 能标出「成员 A / 成员 B」，且事件不串。覆盖：
`nanobot/tests/test_api_stream.py`（引擎真的发出来了）、`tests/gateway.integration.test.ts`（相位映射）、
`tests/lib/processDetail.test.ts` + `tests/chatProcessTimeline.test.tsx`（分组与渲染）、
`tests/events/equivalence.test.ts`（刷新前后逐字段一致）。
