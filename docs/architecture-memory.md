# 增量架构设计：工作区文件记忆（MEMORY.md 机制）

> 本文档为 `docs/prd-memory.md` 的配套架构设计，**仅描述变更部分**，不重写既有架构。
> 所有跨端读写一律经由 `platform`（`platform.storage` / `platform.writeTextFile`），禁止直接依赖 `electron`。

---

## 1. 实现方案概述

在 `src/lib/memory.ts` 新增一个与平台无关的**记忆服务层**（MemoryService），统一封装读取/写入/追加/摘要逻辑；MemoryState 类型扩充进 `src/types/memory.ts`；`settingsStore` 增加 `memoryEnabled`/`autoSummarize` 开关并持久化；`sessionsStore.createSession` 与 `send` 在拼装 system 消息阶段同步调用 MemoryService 读取并以标签块注入 system prompt 末尾；UI 侧新增独立「记忆」页（路由 `/memory`）与侧边导航项，设置页追加「记忆」分区，「保存为记忆」作为聊天消息 hover 菜单项，新会话 `ChatHeader` 顶部显示「已加载 N 条记忆」提示条。Electron 经 `platform.writeTextFile` 写真实 `MEMORY.md`，Web 经 `platform.storage` 以 `nanowork.memory.<workspaceKey>` 存文本；读取时 Electron 优先真实文件回退 storage，Web 直接读 storage。

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
  /** 会话结束时是否自动沉淀摘要（默认 false，推荐关闭） */
  autoSummarize: boolean;
}
```

`DEFAULT_SETTINGS` 同步增加 `memoryEnabled: true`、`autoSummarize: false`。

---

## 4. 调用流程

### 4.1 创建会话 → 读取 → 注入

```
[用户新建会话]
  → sessionsStore.createSession(agentId?)
      → MemoryService.load(workspaceKey)        // 异步读取 MEMORY.md
          ├─ electron: platform.writeTextFile 真实文件优先，缺省回退 storage
          └─ web:      platform.storage.get(nanowork.memory.<key>)
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
      → electron: platform.writeTextFile('MEMORY.md', 全量)
      → web:      platform.storage.set(key, 全量)
  → toast 成功
```

### 4.4 记忆页编辑 → 写

```
MemoryPage 加载 → MemoryService.load() 填入文本框
  → 用户编辑 → [保存]
      → MemoryService.save(fullText)  // 覆盖写
  → [导出] → platform.writeTextFile('MEMORY.md', text)（web 触发下载）
  → [清空] → MemoryService.clear()
```

### 4.5 自动沉淀触发点（P1）

```
[会话结束事件：deleteSession / 新建会话 / 切换会话]
  → 若 autoSummarize 开启且网关可达（probe === 'connected'）
      → 调用 Agent 生成 ≤150 字结构化摘要（决策/偏好/待办）
      → MemoryService.append(summary, { source:'auto' })
      → 幂等去重：摘要哈希比对末尾块，相同则跳过
  → 网关离线/异常时静默跳过（summarize 返回空串）
```

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
  - Web：`nanowork.memory.<workspaceKey>`（`<workspaceKey>` 取当前工作区路径哈希或 `agent.workdir`，默认 `default`）。
  - Electron：真实文件路径 `<safeRoot>/MEMORY.md`，`safeRoot` 由主进程提供（经 `platform.writeTextFile` 解析）。
- **注入标签格式**（system prompt 末尾包裹，便于解析与去重）：
  ```
  <!-- MEMORY -->
  <MEMORY.md 全文>
  <!-- /MEMORY -->
  ```
- **幂等去重策略**：
  - 自动摘要追加前计算 `hash(摘要文本)`，读取末尾块首行是否含相同 hash 标记（`<!-- SUMMARY:<hash> -->`），命中则跳过。
  - 手动「保存为记忆」不强制去重（用户主动行为），但相同连续片段可通过 UI 二次确认避免。
- **workspaceKey 解析**：统一由 `MemoryService.resolveWorkspaceKey()` 返回，多工作区以路径为 key（PRD 推荐默认）。
- **离线跳过**：`autoSummarize` 在网关不可达（probe !== 'connected'）时一律不触发，`summarize` 静默返回空串。
- **不污染 agent.systemPrompt**：记忆仅运行时注入 `send`/`createSession` 的临时 history，永不写入 `agentsStore.agent.systemPrompt`。
- **文本编码**：统一 UTF-8，`\n` 换行；引用块用 Markdown `>` 语法。

---

## 8. 待明确事项

1. **workspaceKey 来源**：当前 `agent.workdir` 默认 `/workspace`，Web 端无真实路径。需确认 Web 端 workspaceKey 取「当前激活 agent 的 workdir 哈希」还是「全局单一 default」。本设计默认：**Web 单一 `default`，Electron 用真实 workdir 路径**。
2. **自动摘要的 Agent 调用方式**：PRD 要求「调用 Agent 生成摘要」，但未指定是否复用 `send` 通道或独立轻量接口。本设计预留 `MemoryService.summarize(history)`，内部走 `connectionManager.getClient()`，具体 prompt 模板在 T28 细化。
3. **Electron 真实文件路径权限**：`safeRoot` 由主进程约束，渲染层仅传相对 `MEMORY.md` 文件名，具体落盘目录策略需主进程侧配合（不在本渲染层设计范围）。
4. **记忆页与设置页「打开记忆文件」**：Web 端「打开」等价于跳转记忆页；Electron 端可经 `platform.writeTextFile` 触发系统打开（或仅展示路径），交互细节 T27/T28 确认。

---

## 附：关键决策摘要

- **零新依赖**：全部复用 zustand / MUI / platform，不引入 electron 直接引用。
- **服务层隔离**：`MemoryService` 统一封装跨端差异，UI/Store 不直接判断 `platform.env`。
- **注入位置**：system prompt 末尾，标签包裹，保证可解析、可去重、不污染 agent 模板。
- **默认安全**：`memoryEnabled=true`（注入开），`autoSummarize=false`（自动沉淀关），网关离线时跳过自动摘要。
- **任务上限**：7 个任务（T22~T28），按依赖顺序排列，T22 为基础设施，T27/T28 并行度低但均仅依赖前置单一任务。
