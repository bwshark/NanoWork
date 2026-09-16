# 增量架构设计：工作区文件记忆（MEMORY.md 机制）

> 本文档为 `docs/prd-memory.md` 的配套架构设计，**仅描述变更部分**，不重写既有架构。
> 所有跨端读写一律经由 `platform`（`platform.storage` / `platform.writeTextFile`），禁止直接依赖 `electron`。

---

## 1. 实现方案概述

在 `src/lib/memory.ts` 新增一个与平台无关的**记忆服务层**（MemoryService），统一封装读取/写入/追加/摘要逻辑；MemoryState 类型扩充进 `src/types/memory.ts`；`settingsStore` 增加 `memoryEnabled`/`autoSummarize` 开关并持久化；`sessionsStore.createSession` 与 `send` 在拼装 system 消息阶段同步调用 MemoryService 读取并以标签块注入 system prompt 末尾；UI 侧新增独立「记忆」页（路由 `/memory`）与侧边导航项，设置页追加「记忆」分区，「保存为记忆」作为聊天消息 hover 菜单项，新会话 `ChatHeader` 顶部显示「已加载 N 条记忆」提示条。

**落盘（与初版的差异）**：不再由渲染层调 `platform.writeTextFile` 写 `MEMORY.md`——
那条路径传的是纯文件名，被主进程安全校验拒绝后又吞掉异常，于是「写真实 MEMORY.md」
从未生效且无人察觉。现在**统一走 `platform.storage`**，Electron 由主进程把
`nanowork.memory.<key>` / `nanowork.userMemory` 路由成真实文件
（`~/.nanowork/memory/<key>.md` / `~/.nanowork/MEMORY.md`），Web 落 localStorage。
渲染层**没有** electron 分支，也**没有**「优先真实文件回退 storage」的双读路径。

---

## 2. 文件列表及相对路径

| 路径 | 状态 | 说明 |
|------|------|------|
| `src/lib/memory.ts` | **[新]** | MemoryService：读取/写入/追加/摘要/去重，跨端封装 |
| `src/types/memory.ts` | **[新]** | MemoryState、MemoryMeta 等类型契约 |
| `src/types/index.ts` | **[改]** | 再导出 memory 类型 |
| `src/lib/constants.ts` | **[改]** | 增加 `ROUTES.memory` 与 `MEMORY_KEY_PREFIX`/`MEMORY_FILENAME` 常量 |
| `src/stores/settingsStore.ts` | **[改]** | `Settings` 增加 `memoryEnabled`、`autoSummarize` 字段及默认值 |
| `src/stores/sessionsStore.ts` | **[改]** | `createSession`/`send` 注入记忆；新增 `memoryLoaded` 提示状态 |
| `src/router/index.tsx` | **[改]** | 注册 `/memory` 路由 |
| `src/layout/SidebarNav.tsx` | **[改]** | 导航项增加「记忆」入口 |
| `src/pages/memory/MemoryPage.tsx` | **[新]** | 独立记忆编辑页（在线编辑 + 保存 + 导出 + 清空） |
| `src/pages/settings/SettingsPage.tsx` | **[改]** | 新增「记忆」分区（开关 + 打开记忆文件） |
| `src/pages/chat/UserMessage.tsx` | **[改]** | 增加 hover 菜单「💾 保存为记忆」 |
| `src/pages/chat/ChatHeader.tsx` | **[改]** | 顶部「已加载 N 条记忆」提示条 |
| `src/components/MemoryBar.tsx` | **[新]** | 「已加载记忆」提示条可复用组件 |

---

## 3. 类型契约

### 3.1 新增 `src/types/memory.ts`

```ts
/** 单条记忆块的轻量元信息（仅用于计数/展示，不强制持久化） */
export interface MemoryMeta {
  /** 估算条数（按二级标题或空行切分） */
  entries: number;
  /** 字符长度 */
  chars: number;
  /** 最后写入 ISO 时间（从文件内容最后时间戳推断，无则 null） */
  lastWrittenAt: string | null;
}

/** 记忆注入运行时状态（存于 sessionsStore，不持久化） */
export interface MemoryState {
  /** 当前会话是否注入了记忆 */
  injected: boolean;
  /** 注入的记忆条数 */
  count: number;
  /** 用户是否临时关闭了提示条 */
  dismissed: boolean;
}

/** 记忆写入选项 */
export interface MemoryAppendOptions {
  /** 引用源（如会话标题/消息片段），用于生成引用块 */
  source?: string;
  /** 显式时间戳，默认 now */
  at?: string;
}
```

### 3.2 `Settings` 新增字段（`src/types/settings.ts`）

```ts
export interface Settings {
  gatewayEndpoint: string;
  apiToken: string;
  theme: 'light' | 'dark';
  // —— 新增：记忆相关 ——
  /** 是否将 MEMORY.md 注入 system prompt 末尾（默认 true） */
  memoryEnabled: boolean;
  /** 会话结束时是否自动沉淀摘要（默认 true） */
  autoSummarize: boolean;
}
```

`DEFAULT_SETTINGS` 同步增加 `memoryEnabled: true`、`autoSummarize: **true**`
（persist `version: 9` 迁移把历史 `false` 提升为 `true`；理由见 §4.5 与
`docs/prd-memory.md` §6.2——自动沉淀是记忆的**唯一自动写入源**，默认关等于没有记忆）。

---

## 4. 调用流程

### 4.1 创建会话 → 读取 → 注入

```
[用户新建会话]
  → sessionsStore.createSession(agentId?)
      → MemoryService.load(workspaceKey)        // 异步读取记忆
          └─ 统一走 platform.storage.get('nanowork.memory.<key>')
               Electron：主进程把该 key 路由为真实文件 ~/.nanowork/memory/<key>.md
               Web：      localStorage（内存降级）
      → 若 memoryEnabled 且内容非空
          → 拼装 system 段：agent.systemPrompt + 标签包裹记忆块
          → 置 memoryLoaded = { injected:true, count, dismissed:false }
  → ChatHeader 渲染「已加载 N 条记忆」提示条
```

### 4.2 发送消息时注入（send 路径）

```
sessionsStore.send(text)
  → 构造 history
  → 若 agent.systemPrompt 存在 → push system
  → 若 memoryEnabled 且本会话已 loaded → push system（标签包裹记忆块）
  → 发起请求
```
> 注：记忆仅在 `createSession` 阶段读取一次并缓存于 session 级 `memoryLoaded` 状态；`send` 时复用该快照，避免每次请求重复 IO。

### 4.3 「保存为记忆」→ 写

```
[聊天消息 hover → 保存为记忆]
  → MemoryService.append(content, { source: 会话标题 })
      → 生成带时间戳引用块：
        > [2025-xx-xx HH:mm] 来自「会话标题」
        > 原文片段...
      → 统一走 platform.storage.set(key, 全量)
           Electron：主进程路由为 ~/.nanowork/memory/<key>.md（原样 Markdown，可手工编辑）
           Web：      localStorage
  → toast 成功
```

### 4.4 记忆页编辑 → 写

```
MemoryPage 加载 → MemoryService.load() 填入文本框
  → 用户编辑 → [保存]
      → MemoryService.save(fullText)  // 覆盖写
  → [导出] → platform.writeTextFile('MEMORY.md', text)
              Electron：相对路径解析到 ~/.nanowork/MEMORY.md
              Web：     触发下载
  → [清空] → MemoryService.clear()
```

### 4.5 自动沉淀触发点（P1）

```
[会话结束事件：deleteSession / deleteSessions / createSession（对上一个会话补触发）]
  → 守卫（sedimentSession 内部）：
       autoSummarize=false        → 跳过
       readonly 或 cron: 前缀会话 → 跳过（自动任务分组几十条 run，无检索价值）
       无消息 / 已沉淀过该会话    → 跳过
  → 调用模型生成 ≤150 字**分节**摘要：[身份] … / [任务] …
  → 分流落盘：
       identity → MemoryService.append(text, opt, 'user')                     → ~/.nanowork/MEMORY.md
       task     → MemoryService.append(text, opt, 'workspace', workspaceKey)  → ~/.nanowork/memory/<key>.md
  → 幂等去重：内容哈希比对已有块，相同则跳过
  → 网关离线/异常时静默跳过（summarize 返回两节皆空）
```

三条实现要点（2026-09-17 修复，详见 `docs/prd-memory.md` §6.2）：

1. **触发点必须有两个**。初版只挂 `deleteSession`，而 PRD 要求「关闭 / **新建会话**」
   都算会话结束——「说一句 → 直接新建会话 → 问我是谁」整段落在空档里。
2. **workdir key 现算，不读全局 `currentKey`**。归纳是异步的，期间用户可能已切工作区；
   依赖全局状态会把 A 的摘要写进 B（这类串味比「没记忆」更难排查）。
   故 `load/save/clear/append` 都增加了末位可选 `workspaceKey` 参数。
3. **分节而非一段**。「落到哪一层」由内容性质决定：称呼/职业跨项目成立（L2），
   本次决策/待办只对当前工作区有意义（L3）。一段摘要无法同时满足两层。

---

## 5. 任务列表（有序，依赖关系）

| 编号 | 任务名 | 源文件 | 依赖 | 优先级 |
|------|--------|--------|------|--------|
| **T22** | 记忆类型与常量基础 | `src/types/memory.ts`[新]、`src/types/index.ts`[改]、`src/lib/constants.ts`[改] | — | P0 |
| **T23** | 记忆服务层 MemoryService | `src/lib/memory.ts`[新] | T22 | P0 |
| **T24** | Settings 开关与持久化 | `src/stores/settingsStore.ts`[改]、`src/types/settings.ts`[改] | T22 | P0 |
| **T25** | 会话注入与提示状态 | `src/stores/sessionsStore.ts`[改]、`src/components/MemoryBar.tsx`[新]、`src/pages/chat/ChatHeader.tsx`[改] | T23, T24 | P0 |
| **T26** | 聊天保存为记忆菜单 | `src/pages/chat/UserMessage.tsx`[改] | T23, T25 | P0 |
| **T27** | 记忆页 + 路由 + 导航 | `src/pages/memory/MemoryPage.tsx`[新]、`src/router/index.tsx`[改]、`src/layout/SidebarNav.tsx`[改] | T23 | P1 |
| **T28** | 设置页记忆分区 + 自动沉淀 | `src/pages/settings/SettingsPage.tsx`[改] | T24, T27 | P1 |

> 实现顺序：T22 → T23 → T24 → T25 → T26 → T27 → T28。
> T25/T26 依赖 T23（MemoryService 已可用）；T27 仅依赖 T23；T28 依赖 T24 与 T27（设置页需在记忆页概念稳定后补充分区）。

---

## 6. 依赖包

无需新增第三方包，复用现有依赖：
- `zustand` / `zustand/middleware`：状态与 persist（已用）
- `react-router-dom`：路由注册（已用）
- `@mui/material`：UI 组件（已用）
- 内置 `platform.storage` / `platform.writeTextFile`：跨端读写（已用）
- 摘要生成复用现有 `connectionManager` + `AIClient`，无需新包。

---

## 7. 共享知识 / 跨文件约定

- **记忆 key 命名**：
  - 工作区级 key：`nanowork.memory.<workspaceKey>`，`<workspaceKey>` 由
    `workspaceKeyFor(workdir)` 现算，形态 `<basename>-<hash8>`（如 `nanowork-1a2b3c4d`），
    无 workdir 回落 `default`。
  - **用户级 key**：`nanowork.userMemory`（刻意不复用动态前缀，否则会得到
    `memory/user.md` 这个谁都不认的孤儿文件）。
  - Web：`localStorage` 内该 key。
  - Electron：主进程把 key 路由为**真实文件**（`~/.nanowork/memory/<key>.md` /
    `~/.nanowork/MEMORY.md`，原样 Markdown，用户可直接打开编辑）；
    `workspaceKey` 经 `sanitizeSegment` 收敛为安全文件名。**渲染层不再有单独的
    electron 落盘分支**（见 `nanowork-prd-design-v2.md` 18.2.5 / ADR-019）。
  - 命名说明：`MEMORY.md` 仅作**用户级**的存储文件名与工作区级的「导出」目标名。
- **注入标签格式**（system prompt 末尾包裹，便于解析与去重）：
  ```
  <!-- MEMORY -->
  <MEMORY.md 全文>
  <!-- /MEMORY -->
  ```
- **幂等去重策略**：
  - 自动摘要追加前计算 `hash(摘要文本)`，读取末尾块首行是否含相同 hash 标记（`<!-- SUMMARY:<hash> -->`），命中则跳过。
  - 手动「保存为记忆」同样走去重（同一段内容连点两次不会写两遍）——「用户主动行为」不等于可以写重复内容。
- **workspaceKey 解析**：由 `workspaceKeyFor(workdir)` 现算（纯函数，可单测），
  `MemoryService.useWorkspace(key)` 只负责把它登记为「当前工作区」（供记忆页与手动保存使用），
  落盘一律由调用方显式传 key，避免异步写串到别的分区。
- **离线跳过**：`autoSummarize` 在网关不可达（probe !== 'connected'）时一律不触发，`summarize` 静默返回两节皆空。
- **不污染 agent.systemPrompt**：记忆仅运行时注入 `send`/`createSession` 的临时 history，永不写入 `agentsStore.agent.systemPrompt`。
- **文本编码**：统一 UTF-8，`\n` 换行；引用块用 Markdown `>` 语法。

---

## 8. 待明确事项

1. **workspaceKey 来源** ✅ **已定**：`workspaceKeyFor(workdir)` —— 会话的
   `workdir` 归一化后取 `<basename>-<hash8>`；无 workdir（IM 会话 / Web 旧数据）
   回落 `default`。Web 端同样按 `workdir` 计算（会话自带），不再退化成全局单键。
2. **自动摘要的 Agent 调用方式**：PRD 要求「调用 Agent 生成摘要」，但未指定是否复用 `send` 通道或独立轻量接口。本设计预留 `MemoryService.summarize(history)`，内部走 `connectionManager.getClient()`，具体 prompt 模板在 T28 细化。
3. **Electron 真实文件路径权限** ✅ **已定**：不再由渲染层传 `MEMORY.md` 文件名。记忆正文经 `platform.storage` 的 `nanowork.memory.<key>` 直接由主进程路由到 `~/.nanowork/memory/<key>.md`；`MEMORY.md` 仅作导出名，`fs:writeTextFile` 把相对路径解析到 ① `~/.nanowork/`，绝对路径限制在 home / userData / ① 之内（`resolveWriteTarget`，见 `nanowork-prd-design-v2.md` 18.2.5）。
4. **记忆页与设置页「打开记忆文件」**：Web 端「打开」等价于跳转记忆页；Electron 端可经 `platform.writeTextFile` 触发系统打开（或仅展示路径），交互细节 T27/T28 确认。

---

## 附：关键决策摘要

- **零新依赖**：全部复用 zustand / MUI / platform，不引入 electron 直接引用。
- **服务层隔离**：`MemoryService` 统一封装跨端差异，UI/Store 不直接判断 `platform.env`。
- **注入位置**：system prompt 末尾，标签包裹，保证可解析、可去重、不污染 agent 模板。
- **默认开启**：`memoryEnabled=true`（注入开），`autoSummarize=true`（自动沉淀开）。
  **这是 2026-09-17 的修正**：旧默认 `autoSummarize=false` 导致整条链路从未被触发，
  用户「告诉过它我叫什么，新会话依然一问三不知」。自动沉淀是记忆的唯一自动写入源，
  默认关 = 默认没有记忆。用户仍可在设置页一键关闭，迁移只跑一次不会覆盖该选择。
  网关离线时仍照常跳过自动摘要（不因此报错）。
- **任务上限**：7 个任务（T22~T28），按依赖顺序排列，T22 为基础设施，T27/T28 并行度低但均仅依赖前置单一任务。
