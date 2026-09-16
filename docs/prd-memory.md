# 增量 PRD：工作区文件记忆（MEMORY.md 机制）

> 本文件为 `docs/prd.md` 的增量补充，仅描述 P1「工作区文件记忆」变更部分，不重写既有 P0 需求。
>
> **2026-09-17 实现对齐**：§3 与 §5 中若干条与实现不一致（落点写成「工作区根目录」、
> 自动摘要「默认关」）。本轮按实现修正，并在 §6 记录两处**刻意偏离**及理由。
> 排查过程与磁盘证据见 `.workbuddy/reports/memory-diagnosis-2026-09-17.md`。

## 1. 需求目标与价值
让客户端沉淀一份可读、可编辑的长期记忆文件，把多轮及跨会话的任务上下文、用户偏好、关键结论持久化为 Markdown。新会话可将其作为上下文注入 Agent，实现"越用越懂你"的长期记忆，弥补当前会话隔离导致的信息丢失，且复用已有 `platform.writeTextFile`/`platform.storage` 能力，跨端零侵入。

**落点（与初版描述的差异）**：不写在「工作区根目录」，而是收在用户的资产目录下，分两层
（详见 §6.1）——①用户级 `~/.nanowork/MEMORY.md`；②工作区级
`~/.nanowork/memory/<workspaceKey>.md`。用户的工作目录不被产品写入任何文件。

## 2. 用户故事
- **查看记忆**：As a 用户, I want 在"记忆"入口查看长期记忆原文与**它在磁盘上的位置**, so that 我能知道 Agent 记住了什么、存在哪。
- **Agent 自动沉淀记忆**：As a 用户, I want 会话结束后自动把关键结论摘要写入记忆, so that 下次会话无需重复交代背景。
- **记住我是谁**：As a 用户, I want 我告诉过 Agent 的称呼/职业在新会话里依然有效, so that 跨项目都不用重复自我介绍。
- **手动编辑记忆**：As a 用户, I want 在聊天页把某条回复"保存为记忆"并手动编辑记忆页, so that 我能主动控制长期记忆的准确性。

## 3. 需求池
- **P0** 记忆存储：分两层落 Markdown。用户级 → `~/.nanowork/MEMORY.md`；工作区级 →
  `~/.nanowork/memory/<workspaceKey>.md`（key = 工作目录的 `<basename>-<hash8>`，
  见 §6.1）。Electron 由主进程 `storageRoutes` 把 storage key 路由成真实文件；
  Web 经 `platform.storage` 落 localStorage（另有导出下载）。
- **P0** 记忆读取：新会话创建时自动读取 MEMORY.md；以可开关的"记忆上下文"注入 system prompt 末尾（开关存 `settingsStore`）。
- **P0** 手动写入：聊天页消息操作菜单提供"保存为记忆"（追加带时间戳的引用块）；"记忆"页支持在线编辑并保存。
- **P1** 自动沉淀：会话结束触发摘要。触发点为**两个**——关闭/删除会话、**新建会话**（切走时对上一个会话补触发）；策略 = 调用模型生成 ≤150 字**分节**摘要，分节落盘、幂等去重（详见 §6.2）。
- **P1** UI 落点：设置页新增"记忆"分区 + 独立"记忆"入口页；聊天页消息 hover 菜单含"保存为记忆"。
- **P2** 多工作区记忆隔离与导入/导出。
- **P2** Agent 受控写入：Agent 可在回答里用 `<memory-save scope="…">` 声明「这条请记住」，由客户端完成落盘（见 §6.3）。

### 与现有 store 关系
- `agentsStore.agent.systemPrompt`：记忆**不**写入 systemPrompt 字段，仅运行时注入，保持 agent 模板纯净。
- `sessionsStore`：在 `createSession` 阶段读取记忆并拼装上下文，不持久化记忆内容本身。

## 4. UI / 交互设计要点
```
设置页 ── 记忆 [开关: 注入记忆上下文] [开关: 会话结束自动沉淀摘要] [打开记忆页]
聊天页 ── 消息 hover → "💾 保存为记忆"
记忆页 ── ┌────────────────────────────────────┐
          │ [用户级 | 工作区级]  落点: ~/.nanowork/memory/<key>.md │
          │ (可编辑正文)                        │
          │ [保存] [导出] [清空]                │
          └────────────────────────────────────┘
```
新建会话时若记忆非空，聊天顶部显示"已加载 N 条记忆"提示条，可临时关闭。

## 5. 待确认问题（已定论）
1. 自动摘要默认开还是关？**已定论：默认开**（`settingsStore.DEFAULT_SETTINGS.autoSummarize = true`，persist v9 迁移把历史 `false` 提升为 `true`）。理由见 §6.2。
2. Web 端记忆存 localStorage 还是强制下载文件？**已定论：localStorage 为主，提供导出。**
3. 记忆注入位置（system prompt 末尾 vs 独立 context 块）？**已定论：system 段末尾，标签包裹**，且 identity 段必须排在 memory 之前（护栏句指向「上方」）。
4. 自动摘要调用哪个模型？**已定论：随当前连接直连 nanobot 网关；网关离线时静默跳过。**
5. 多工作区如何判定根目录？**已定论：以会话的 workdir 为 key（归一化 + 哈希），见 §6.1。**

## 6. 实现对齐（2026-09-17）

### 6.1 两层落点与工作区 key

| 作用域 | 落点 | workspace key | 写入方 |
|---|---|---|---|
| 用户级（L2） | `~/.nanowork/MEMORY.md` | 不适用 | 记忆页手动编辑；自动沉淀的**身份类**分节；Agent `<memory-save scope="user">` |
| 工作区级（L3） | `~/.nanowork/memory/<key>.md` | `workspaceKeyFor(workdir)` | 自动沉淀的**任务类**分节；「保存为记忆」；Agent 默认档 |

`workspaceKeyFor` 形态 `<basename>-<hash8>`（如 `nanowork-1a2b3c4d`）：
带 basename 是为了让文件名可读（纯哈希会让「去哪个文件找记忆」变成猜谜）；
只做三件归一化（反斜杠→斜杠、去尾斜杠、转小写），因为 Windows 路径大小写不敏感，
`D:\Work` 与 `d:/work/` 必须落同一个 key，否则同一工作区的记忆被劈成两半。
无 workdir（IM 会话 / 历史数据）回落 `default`，与升级前的数据保持连续。

> **初版为何写成「工作区根目录」**：那是 follow 了 WorkBuddy 的形态
> （`<workspace>/.workbuddy/memory/`）。实际实现选择收在用户资产目录，
> 理由是①不往用户的项目目录里塞产品文件；②同一个工作目录可以被多个 Agent 使用，
> 记忆属于用户而非项目。**这是刻意偏离，不是未实现。**

### 6.2 自动沉淀：两个触发点 + 分节分流

触发点（对齐「会话结束（关闭 / 新建会话）」）：
- `deleteSession` / `deleteSessions`；
- `createSession` —— 对**上一个会话**补触发。这一处曾完全缺失，导致
  「说一句 → 直接新建会话 → 问我是谁」整段落在空档里。

守卫（`sedimentSession` 内部，单条与批量同一条规则）：
`autoSummarize` 关 → 跳过；`readonly` 或 `cron:` 前缀 → 跳过（自动任务分组动辄
几十条 run，逐条调模型既慢又无检索价值，且这些 run 的真值在引擎侧）；无消息 → 跳过；
同一会话只沉淀一次（模块级去重集）。

**为何默认开而不是默认关**：初版推荐「默认关，首次手动开启并提示」。实测后果不是
「少写一点记忆」，而是整条链路从未被触发——用户告诉 Agent 自己的名字，新会话依然
一问三不知。自动沉淀是记忆的**唯一自动写入源**，默认关等于默认没有记忆。

**为何分节**：「落到哪一层」由内容性质决定，不能由调用方一刀切：
称呼/年龄段/职业/稳定偏好是**跨项目**事实（换个工作区依然成立 → L2）；
本次会话的决策/待办/项目专有事实只对当前工作区有意义（→ L3）。
初版提示词只保留「决策/偏好/待办」三类，身份类事实不在三类里，**整段被丢弃**——
这正是「我告诉过它我叫什么，新会话却不知道」的直接原因。

### 6.3 Agent 侧受控写入协议

Agent 在回答末尾写 `<memory-save scope="user|workspace">…</memory-save>` 声明意图，
由客户端解析 → **剥离标记**（不进入用户可见正文，也不进入事件流）→ 交
`MemoryService.append` 落盘（时间戳/来源/幂等标记由它统一负责）。

不走工具调用的理由：「记一条偏好」是纯本地无副作用写入，弹审批框只会教会用户
把审批全关掉。协议与记忆能力同开同关（`memoryEnabled && autoSummarize`）。

### 6.4 与引擎侧记忆的边界（易混）

本项目有**两套互不相干**的记忆，别当成同一件事：

| | 客户端记忆 | 引擎（nanobot）记忆 |
|---|---|---|
| 落点 | `~/.nanowork/MEMORY.md`、`~/.nanowork/memory/<key>.md` | `agents.defaults.workspace/memory/MEMORY.md` |
| 写入方 | 本 PRD 描述的全部路径 | 引擎的 Dream 归纳（定时批处理） |
| 是否随会话 workdir 变化 | **是**（L3 按 key 隔离） | **否**（绑定引擎配好的那个 workspace） |

引擎记忆的 workspace 由 `nanobot.config.json` 决定（本项目为
`<repo>/.nanowork-Workspace`），`build_system_prompt(workspace=…)` 只影响
prompts/skills 覆盖，**不改记忆落点**。因此不要期望「换个工作区，引擎记忆跟着换」。
