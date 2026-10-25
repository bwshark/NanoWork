# 增量架构设计：对话创建定时任务（FT-01 ~ FT-04）

> 架构师：高见远｜ 基于 `docs/prd-tasks.md`（产品经理：许清楚）。本文件仅描述增量变更，不重写既有任务 CRUD / 记忆架构。
> 复用原则：聊天入口与 TasksPage 共用同一份表单逻辑（抽 `TaskFormDialog`），纯前端 store 操作，渲染层不引入 `electron` 依赖。

## 1. 实现方案概述
将 `TasksPage.tsx` 当前内联的「新建/编辑任务」对话框抽取为受控共享组件 `src/components/tasks/TaskFormDialog.tsx`（`initial` + `onSubmit` + `onClose`，字段与校验与现有一致）；聊天侧 `UserMessage`/`AssistantMessage` 经 `MessageStream` 透传 `agentId`，hover 时显示「💾 保存为记忆 / ⏰ 创建定时任务」双按钮，点 ⏰ 经封装组件 `CreateTaskDialog`（复用 `TaskFormDialog`）以消息内容预填表单，确认后写 `tasksStore.addTask` 并 `toast.success`，全程不跳转 `/tasks`。

## 2. 文件列表及相对路径（标注 [新]/[改]）
- [新] `src/lib/task/taskDraft.ts` — 预填辅助：名称生成 + `buildTaskDraftFromMessage`。
- [新] `src/components/tasks/TaskFormDialog.tsx` — 受控共享任务表单（TasksPage 与聊天共用的唯一表单实现）。
- [新] `src/components/chat/CreateTaskDialog.tsx` — 聊天入口封装：预填 + `addTask` + `toast` 闭环，内部挂载 `TaskFormDialog`。
- [改] `src/pages/tasks/TasksPage.tsx` — 删除内联 Dialog，改为挂载 `TaskFormDialog`（新建/编辑共用）。
- [改] `src/pages/chat/UserMessage.tsx` — 加 ⏰ 按钮；接收 `agentId`；挂载 `CreateTaskDialog`。
- [改] `src/pages/chat/AssistantMessage.tsx` — 新增 hover 行（含 💾 + ⏰，按 PRD Q4 一并补 memory 按钮）；接收 `agentId`；挂载 `CreateTaskDialog`。
- [改] `src/pages/chat/MessageStream.tsx` — 向两个消息组件透传 `agentId={session.agentId}`。

## 3. 类型契约
既有类型**无需新增**；仅新增两个工具类型/函数签名。

```ts
// 来源：src/types/task.ts（已有，未改动）
// TaskConfig { id, name, schedule:{kind:'cron',expr}|{kind:'interval',minutes}, prompt, agentId, status, createdAt }

/** 表单提交数据：去掉 store 自管的 id / createdAt */
export type TaskDraft = Omit<TaskConfig, 'id' | 'createdAt'>;

// src/lib/task/taskDraft.ts [新]
/** 由消息首行生成任务名：trim 截断 20 字，超长加 '…'（PRD Q5） */
export function makeTaskName(content: string): string;

/** 由一条消息预填任务草稿；agentId 优先用 session.agentId */
export function buildTaskDraftFromMessage(
  message: Message,
  agentId: string,
): Partial<TaskConfig>;
// 返回 { name: makeTaskName(message.content), prompt: message.content, agentId }
```

`TaskFormDialog` 契约：
```ts
interface TaskFormDialogProps {
  open: boolean;
  /** 预填值；未给字段回退 EMPTY 默认（schedule 默认 interval 60、agentId 默认待上层给定） */
  initial?: Partial<TaskConfig>;
  /** 标题，默认 '新建任务'；聊天入口传 '创建定时任务（来自对话）' */
  title?: string;
  /** 提交按钮文案，默认 '保存'；聊天入口传 '创建任务' */
  submitLabel?: string;
  /** 校验通过（名称非空）后回调，data 已剔除 id/createdAt */
  onSubmit: (data: TaskDraft) => void;
  onClose: () => void;
}
```
`CreateTaskDialog` 契约：
```ts
interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  message: Message;
  agentId: string; // 来自 session.agentId
}
// 内部：initial = buildTaskDraftFromMessage(message, agentId)
//      onSubmit = (d) => { addTask(d); toast.success('已创建定时任务'); onClose(); }
```

## 4. 调用流程
```
用户 hover 消息（UserMessage / AssistantMessage）
  └─ hover 行显隐（opacity/pointerEvents，复用 UserMessage 既有模式）
       └─ 点 ⏰ IconButton（带 Tooltip）
            └─ 组件内 setCreateOpen(true)
                 └─ <CreateTaskDialog open message agentId>
                      ├─ initial = buildTaskDraftFromMessage(message, agentId)
                      │     · name = makeTaskName(content)（首行≤20字）
                      │     · prompt = message.content
                      │     · agentId = session.agentId（空则 TasksPage 同款回退 agents[0]?.id）
                      └─ 渲染 <TaskFormDialog initial title="创建定时任务（来自对话）" submitLabel="创建任务">
                           ├─ 内部 form state 初始化自 initial（字段同 TasksPage）
                           ├─ 校验：name 非空才可点「创建任务」（与 TasksPage 一致）
                           └─ 点「创建任务」→ onSubmit(data)
                                └─ tasksStore.addTask(data)
                                └─ toast.success('已创建定时任务')
                                └─ onClose → 对话框关闭，停留在聊天页（不跳 /tasks）
```
（Mermaid 等价文字时序如上。）

## 5. 任务列表（有序 · 依赖 · T29 起）
- **T29** [新] `src/lib/task/taskDraft.ts`：实现 `makeTaskName`（首行 trim 截断 20 字 + 超长 `…`）、`buildTaskDraftFromMessage(message, agentId)`。定义并导出 `TaskDraft = Omit<TaskConfig,'id'|'createdAt'>`。
  - 依赖：无（仅依赖既有 `Message`/`TaskConfig`）。
- **T30** [新] `src/components/tasks/TaskFormDialog.tsx`：受控 Dialog，复用 TasksPage 现有字段（name / schedule 类型 select / interval 分钟数 或 cron expr / 目标 Agent select / prompt 多行）+ 名称非空校验（提交按钮 `disabled={!form.name?.trim()}`）。内部 `form` state 由 `initial` 合并 `EMPTY` 初始化；`open` 或 `initial` 变化时 `useEffect` 重置 form。
  - 依赖：T29。
- **T31** [改] `src/pages/tasks/TasksPage.tsx`：删除内联 `<Dialog>` 及其表单 `form`/`save` 逻辑，改为挂载 `<TaskFormDialog>`；新建传 `initial={{agentId: agents[0]?.id}}`、编辑传 `initial={editing}`；`onSubmit` 内按 `editing` 分流 `updateTask`/`addTask`。标题/按钮用默认。删除后 `TasksPage` 内不再持有 `form`/`save`/`EMPTY`。
  - 依赖：T30。
- **T32** [新] `src/components/chat/CreateTaskDialog.tsx`：封装 `TaskFormDialog`，`open`+`onClose`+`message`+`agentId`；内部 `initial = buildTaskDraftFromMessage(message, agentId)`，agentId 为空时回退 `agents[0]?.id`（同 `TasksPage.openNew`）；`onSubmit = (d) => { addTask(d); toast.success('已创建定时任务'); onClose(); }`。
  - 依赖：T29、T30。
- **T33** [改] `src/pages/chat/UserMessage.tsx`：props 增 `agentId: string`；在既有 hover 行加 ⏰ `IconButton`（Tooltip「创建定时任务」），点击 `setCreateOpen(true)`；挂载 `<CreateTaskDialog open={createOpen} onClose message agentId />`。保留既有 💾 记忆按钮逻辑不变。
  - 依赖：T32、T35。
- **T34** [改] `src/pages/chat/AssistantMessage.tsx`：props 增 `agentId: string`；外层 `Box` 加 `onMouseEnter/Leave` + `hovered` state，新增 hover 行（左对齐，置于内容 Paper 上方），含 💾（PRD Q4 一并补，复用 `MemoryService.append` + `toast`，逻辑同 UserMessage `saveAsMemory`）与 ⏰ 双按钮；点 ⏰ 打开 `<CreateTaskDialog>`。复用 `opacity`/`pointerEvents` 显隐模式。
  - 依赖：T32、T35。
- **T35** [改] `src/pages/chat/MessageStream.tsx`：向 `<UserMessage>` / `<AssistantMessage>` 透传 `agentId={session?.agentId ?? ''}`（`session` 已在组件内取到）。
  - 依赖：无（先于 T33/T34 落地）。
- **T36** 联调冒烟：类型检查（`tsc`/构建）通过；手动验证 FT-01（双消息 hover 行）、FT-02（⏰ 预填 prompt/agentId/name）、FT-03（保存闭环 + toast 不跳转）、FT-04（TasksPage 与聊天共用表单、字段/校验一致）。
  - 依赖：T31、T33、T34、T35。

## 6. 共享知识 / 跨文件约定
- **名称自动生成**：`makeTaskName(content)` = 取首行 `content.split('\n')[0].trim()`，超 20 字截断并补 `…`；用户可在 Dialog 内编辑（PRD Q5）。
- **预填 agentId 优先级**：`session.agentId` 非空用之；为空回退 `agents[0]?.id`（与 `TasksPage.openNew` 一致）。聊天侧回退逻辑集中在 `CreateTaskDialog`，避免两条消息组件各写一遍。
- **校验**：名称非空（`form.name?.trim()`）才可提交；`TaskFormDialog` 用 `disabled` 控提交按钮，TasksPage 与聊天入口共用，禁止两份校验。
- **hover 显隐**：复用 `UserMessage` 既有 `{ opacity: hovered?1:0, transition:'opacity .15s', pointerEvents: hovered?'auto':'none' }` 模式；`AssistantMessage` 新增 hover 行与之视觉一致。
- **不跳转**：保存成功仅 `toast.success('已创建定时任务')`，停留聊天页（PRD Q2）；「去管理」按钮留 P1（FT-05）。
- **store 操作**：仅 `tasksStore.addTask`（聊天入口）/ `addTask`+`updateTask`（TasksPage）；不新建任务数据结构，`TaskConfig` 不变。
- **跨端约束**：渲染层不 `import 'electron'`；本增量纯前端 store + toast，无 IO 依赖。

## 7. 待明确事项
- 无阻塞项。以下为 P1/P2（已在 PRD 标注，不在本次范围）：FT-05 跳转按钮 / 连续创建、FT-06 空 agentId 高亮提示（本次已用 `agents[0]?.id` 回退兜底，足够）、FT-07 选中文本片段、FT-08 语义推荐调度。
- `AssistantMessage` 的 💾 记忆按钮按 PRD Q4 一并补入，与本次 hover 行同批，但记忆写入走既有 `MemoryService`，不新增任务逻辑。
