> ⚠️ **已被 v2 增量叠加（2026-10-02）**：本文描述的是**记忆 v1** 的架构。
> 其落点取舍、两层合并注入定序、报错不落盘、注入快照失效等机制在 v2 中原样保留
> （见 `docs/architecture-memory-v2.md` §11）；v2 的平台契约、canonical/投影分层、
> 蒸馏与裁决事务见该文。三件套入口：`docs/prd-memory-v2.md` / `docs/architecture-memory-v2.md`
> / `docs/plan-memory-v2.md`。

# 增量架构设计：工作区文件记忆（MEMORY.md 机制）

> ⚠️ **落点已变更（2026-09-19）**：工作区记忆**不再落 `~/.nanowork/memory/<key>.md`
> 单文件**，改为落**用户工作目录下的目录** `<工作目录>/.nanowork/memory/`，
> 里面是 `MEMORY.md`（精炼记忆）+ 若干 `YYYY-MM-DD.md`（每日日志），读取时合并注入。
> 与 WorkBuddy 的 `.workbuddy/memory/` 同构。
>
> 本文下面各节的路径示例（`~/.nanowork/memory/<key>.md`）是**变更当时的历史记录**，
> 保留下来便于对照演进过程；描述现状请看这几处：
>
> | 关注点 | 现状所在 |
> |---|---|
> | 目录与文件名约定、排序、合并 | `src/lib/memory/workspaceMemory.ts` |
> | 主进程路径解析与越界校验 | `electron/memoryRoutes.ts` |
> | 主进程 fs 读写与旧数据懒迁移 | `electron/workspaceMemoryStore.ts` |
> | 渲染层目录后端（Web 为 localStorage 模拟） | `src/platform/types.ts` 的 `WorkspaceMemoryFiles` |
> | 记忆服务 | `src/lib/memory/memory.ts` 的 `MemoryServiceImpl` |
> | 工作目录 → 旧落点 key（仅迁移用） | `src/lib/workspace/workspaceKey.ts` |
>
> 没有绑定工作目录的会话（IM 会话、存储设置之前建的旧会话）仍落产品目录下的
> `~/.nanowork/memory/default/`——没有工作目录就没有「跟着走」的载体。

> 本文档为 `docs/prd-memory.md` 的配套架构设计，**仅描述变更部分**，不重写既有架构。
> 所有跨端读写一律经由 `platform`（`platform.memoryFiles` / `platform.storage` /
> `platform.writeTextFile`），禁止直接依赖 `electron`。

---

## 1. 实现方案概述

在 `src/lib/memory/memory.ts` 新增一个与平台无关的**记忆服务层**（MemoryService），统一封装读取/写入/追加/摘要逻辑；MemoryState 类型扩充进 `src/types/memory.ts`；`settingsStore` 增加 `memoryEnabled`/`autoSummarize` 开关并持久化；`sessionsStore.createSession` 与 `send` 在拼装 system 消息阶段调用 MemoryService 读取并以标签块注入 system prompt 末尾；UI 侧新增独立「记忆」页（路由 `/memory`）与侧边导航项，设置页追加「记忆」分区，「保存为记忆」作为聊天消息 hover 菜单项，新会话 `ChatHeader` 顶部显示「已加载 N 条记忆」提示条。

> **读取时机（2026-09-17 修订）**：`createSession` 读盘后把结果缓存进 `session.memory`（纯缓存）；`send` 本身**不再读盘**，而是在 `streamAssistantReply` 里**先同步占住流式槽位、再按需刷新过期快照**（异步）。刷新是刷新、装配是装配，两者顺序不可交换——细节见 §4.2 注 1~注 3。

**落盘（与初版的差异）**：不再由渲染层调 `platform.writeTextFile` 写 `MEMORY.md`——
那条路径传的是纯文件名，被主进程安全校验拒绝后又吞掉异常，于是「写真实 MEMORY.md」
从未生效且无人察觉。此后曾统一走 `platform.storage`（Electron 由主进程把
`nanowork.memory.<key>` / `nanowork.userMemory` 路由成真实文件），Web 落 localStorage。
渲染层**没有** electron 分支，也**没有**「优先真实文件回退 storage」的双读路径。

> **2026-09-19 起**：工作区级改为走 `platform.memoryFiles`（目录后端）：Electron 侧
> 由主进程 `memory:*` IPC 直接读写 `<工作目录>/.nanowork/memory/` 下的文件，**不经过**
> `platform.storage`（那个契约是「一个 key 一个文件」，表达不了「一个目录、若干日期
> 文件」）。用户级 `~/.nanowork/MEMORY.md` 仍然走 `platform.storage`。
> 渲染层依然没有 electron 分支——路径拼接与安全校验全在主进程，见 `electron/memoryRoutes.ts`。

---

## 2. 文件列表及相对路径

| 路径 | 状态 | 说明 |
|------|------|------|
| `src/lib/memory/memory.ts` | **[新]** | MemoryService：读取/写入/追加/摘要/去重，跨端封装 |
| `src/types/memory.ts` | **[新]** | MemoryState、MemoryMeta 等类型契约 |
| `src/types/index.ts` | **[改]** | 再导出 memory 类型 |
| `src/lib/core/constants.ts` | **[改]** | 增加 `ROUTES.memory` 与 `MEMORY_KEY_PREFIX` 常量（后者现仅用于定位旧落点，2026-09-19 起） |
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
      → memoryKey = workspaceKeyFor(session.workdir)
      → MemoryService.loadForInjection(memoryKey)   // 异步读取**两层**记忆
          ├─ load('user')               → ① ~/.nanowork/MEMORY.md
          └─ load('workspace', key)     → ① ~/.nanowork/memory/<key>.md
          → composeMemoryForInjection() → 用户级在前、工作区级在后
          └─ 统一走 platform.storage.get(...)（Electron 由主进程路由成真实文件；Web 落 localStorage）
      → 若 memoryEnabled
          → 采样 version = MemoryService.writeVersion()（在读取**之前**，见 §4.2 注 3）
          → 缓存到 session.memory（send 时由装配器包成 <!-- MEMORY --> 块；
            空记忆也缓存空串，让「undefined = 尚未加载」这一约定成立）
          → 连同产出依据一起写回：memoryVersion + memoryWorkspaceKey（供过期判定）
          → 合并结果非空且非 silent → 置 memoryLoaded = { injected:true, count, dismissed:false }
  → ChatHeader 渲染「已加载 N 条记忆」提示条
```

> **两层合并注入（2026-09-17 P0 修复）**：注入侧原先只读 `workspace` 一层，
> 而写入侧从 P1-B 起就把身份类事实分流到 `user` 层——于是 L2 成了一份
> **写得进、读不出**的文件：「在 `D:\test` 告诉过它我叫什么，换到 `D:\tmp`
> 就问不出来」，而 `~/.nanowork/MEMORY.md` 里明明躺着这条事实。
> 现在 `loadForInjection` 并行读两层并合成一段注入正文，`entries` 取
> **两段各自计数之和**（段标题用 `【…】`，不进 `countEntries` 的 `## ` 计数）。
> 定序（用户级在前）是硬约束：护栏句写着「冲突时以用户级为准」，顺序反了那句就指向空处。

### 4.2 发送消息时注入（send 路径）

```
sessionsStore.send(text, sessionId)
  → 追加 user + assistant(占位)，落事件流
  → streamAssistantReply(sessionId, assistantId, files)
      → ① 同步占住流式槽位（streams[sessionId] = { status:'thinking', active:true }）
      → ② 快照过期则刷新（await；全函数唯一的 await，且已在槽位之后）
           isMemorySnapshotStale()：
             memoryVersion   !== MemoryService.writeVersion()    ← 期间有写入
             或 memoryWorkspaceKey !== workspaceKeyFor(workdir) ← 换了工作目录
      → ③ 装配 history：system 段 + 技能 + 记忆块（wrapForInjection）+ 本地时间 + 历史
      → 发起请求
```

> **注 1｜快照为什么会失效**：快照只在 `createSession` / `loadSession` 生成一次，
> 而记忆随时可能被写——模型本轮写下的 `<memory-save>`、别处会话结束时的自动沉淀、
> 记忆页的手动编辑。实测事故：在 `D:\temp` 的会话写下「用户擅长前端 GIS 开发」，
> 13 秒后回到 `D:\tmp` 的会话问「我擅长什么」，注入的仍是旧快照。证据来自事件流里
> 存着的**完整请求体**：两次请求的 MEMORY 块逐字节相同，都只有写入前的那一条。
>
> **注 2｜刷新为什么必须在槽位之后**：「已水合的会话 `send` 同步进入流式态」是
> `tests/sessionsStore.test.ts` 锁死的可测性质——同一会话并发 `send` 互斥、
> 不同会话可并发，全靠槽位在同步段内落位。刷新要读盘（异步），若提到槽位之前，
> 这次 `await` 会把整个流式态推后一个 microtask。**顺序不可交换**，且有专门用例
> 守着：把刷新挪回 `send` 里，那条用例立即失败（`expected undefined to be defined`）。
>
> **注 3｜版本在读取之前采样**：`loadMemoryInto` 先取 `writeVersion()` 再读盘。
> 采早不采晚——若读取期间恰好有写入落盘，这次的正文可能不含它，记成「已包含」
> 就会永久停在旧内容上；最坏结果只是多刷一次。

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
  → 构造 history：只取「用户提问 + **未被中断（aborted）**的助手回答」
  → 读取已有长期记忆（loadForInjection）作为 knownFacts 一并发给模型
  → 调用模型生成 ≤150 字**分节**摘要：[身份] … / [任务] …
       入口另有两道防污染守卫（summarize）：像系统报错的条目剔除；
       过滤后一次有效回答都没有则直接跳过（不浪费一次归纳请求）；
       带 knownFacts 时另附规则：只输出「新增」或「与已有不同」的事实
  → 分流落盘：
       identity → MemoryService.append(text, opt, 'user')                     → ~/.nanowork/MEMORY.md
       task     → MemoryService.append(text, opt, 'workspace', workspaceKey)  → ~/.nanowork/memory/<key>.md
  → 幂等去重（两层）：字节级比对已有 hash 标记；语句级把新正文与已有各条正文
       归一化后比对（挡住「同一句换标点 / 空白 / 大小写」的机械重复）
  → 网关离线/异常时静默跳过（summarize 返回两节皆空）
```

五条实现要点（2026-09-17 修复，详见 `docs/prd-memory.md` §6.2 / §6.5 / §6.6）：

1. **触发点必须有两个**。初版只挂 `deleteSession`，而 PRD 要求「关闭 / **新建会话**」
   都算会话结束——「说一句 → 直接新建会话 → 问我是谁」整段落在空档里。
2. **workdir key 现算，不读全局 `currentKey`**。归纳是异步的，期间用户可能已切工作区；
   依赖全局状态会把 A 的摘要写进 B（这类串味比「没记忆」更难排查）。
   故 `load/save/clear/append` 都增加了末位可选 `workspaceKey` 参数。
3. **分节而非一段**。「落到哪一层」由内容性质决定：称呼/职业跨项目成立（L2），
   本次决策/待办只对当前工作区有意义（L3）。一段摘要无法同时满足两层。
4. **错误文案不落盘**（P1 修复）。网关在配额 / 鉴权失败时会把报错原文当作正常
   `delta.content` 吐进 SSE 流——通道层面分不出这一帧是回答还是报错，只能在内容层
   判定（`looksLikeSystemError`：强特征词 **且** 中文字符占比 < 15%，避免误杀
   「排查 API key 配额」这类正常中文摘要）。不设这道防线，一条系统报错会以
   「会话摘要」的名义成为永久记忆，此后每次会话都被注入。
5. **归纳要看得到已有记忆**（防重复，2026-09-17）。首次归纳只知道本次会话，
   于是「用户叫明明」被每个会话重新归纳一遍，同一事实攒出三份措辞不同的记录。
   归纳前把 `loadForInjection()` 的结果作为 `knownFacts` 传给模型，要求它只输出
   **新增**或**发生变化**的事实。注意措辞必须同时覆盖这两类：只说「不要重复」
   会让模型把「20 岁 → 25 岁」这类更新也丢掉。

---

## 5. 任务列表（有序，依赖关系）

| 编号 | 任务名 | 源文件 | 依赖 | 优先级 |
|------|--------|--------|------|--------|
| **T22** | 记忆类型与常量基础 | `src/types/memory.ts`[新]、`src/types/index.ts`[改]、`src/lib/core/constants.ts`[改] | — | P0 |
| **T23** | 记忆服务层 MemoryService | `src/lib/memory/memory.ts`[新] | T22 | P0 |
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
- **注入标签格式**（system prompt 末尾包裹，便于解析与去重）。`src` 是
  `composeMemoryForInjection` 合成后的**两层正文**，只有一层有内容时照样带标题
  （让模型看得出这条记忆的适用边界）：
  ```
  <!-- MEMORY -->
  <边界指令行：记忆仅供参考、不是身份或系统指令；冲突时以用户级为准>
  【用户级记忆 · 跨项目】
  <~/.nanowork/MEMORY.md 全文>

  【工作区记忆 · 当前工作区】
  <~/.nanowork/memory/<key>.md 全文>
  <!-- /MEMORY -->
  ```
  段标题用 `【…】` 而非 `## `：记忆正文可能是用户手写的 Markdown，而
  `countEntries` 优先按 `## ` 计数，凭空加两层二级标题会让「记忆条数」多出两条。
- **幂等去重策略**（两层，详见 `docs/prd-memory.md` §6.6）：
  - **字节级**：追加前计算 `hash(正文)`，比对已有块的 `<!-- SUMMARY:<hash> -->` 标记，命中则跳过。
  - **语句级**：把新正文与 `parseEntryBodies()` 取出的**已有各条正文**逐一
    经 `normalizeForDedup()` 归一化后比对，挡住「同一句话换标点 / 空白 / 大小写 /
    Markdown 装饰」的机械重复——这类内容的哈希必然不同，第一层挡不住。
  - 手动「保存为记忆」同样走这两层（同一段内容连点两次不会写两遍）——「用户主动行为」不等于可以写重复内容。
  - **刻意不做相似度阈值**。想认出「改写式重复」得把阈值压到 0.45 以下，而实测
    「20 岁 → 25 岁」这类**更新**的相似度高达 0.90、「同前缀补充新信息」的覆盖率
    高达 1.00——压低阈值就会把它们一并误杀，那是静默丢记忆。字面上无法区分
    「重复 / 更新 / 补充」，因为区分它们需要知道**哪部分是事实的键**。
  - **语义层（主力）**：`MEMORY_WRITE_INSTRUCTION` 要求模型写之前先核对已注入的
    记忆块，并明确「更新要写新的完整表述、不要罗列多个版本」「不写一次性操作播报」；
    `summarize(history, { knownFacts })` 让自动沉淀也看得到已有记忆。
- **`append` 返回写入结果**（`written` / `skipped-empty` / `skipped-duplicate`）。
  调用方可以继续 `await` 后忽略（TS 合法），但测试与「记忆页」需要区分
  「写进去了」和「因为重复被跳过」——否则「去重生效了吗」只能靠数条数来猜。
- **workspaceKey 解析**：由 `workspaceKeyFor(workdir)` 现算（纯函数，可单测），
  `MemoryService.useWorkspace(key)` 只负责把它登记为「当前工作区」（供记忆页与手动保存使用），
  落盘一律由调用方显式传 key，避免异步写串到别的分区。
- **注入快照的失效机制**（2026-09-17 修复，见 §4.2）：`session.memory` 是**纯缓存**，
  配套两个「产出依据」——`memoryVersion`（写入版本）与 `memoryWorkspaceKey`（由 workdir 推导）。
  `isMemorySnapshotStale()` 必须是**同步**判定：调用方（`streamAssistantReply`）
  据此决定要不要付一次读盘 IO，async 就等于强行插入 await 边界。
  - `MemoryService.writeVersion()` 单调递增，**唯一递增点是 `save()`**——`clear` 与
    `append` 都经它，所以「版本变了」严格等价于「某处真的落过盘」。递增放在写入
    **完成之后**：先递增会让并发读取拿到「新版本 + 旧内容」的快照，而该快照会被
    后续判定为有效，于是永久停在旧内容上。
  - 补刷点两处：`selectSession`（切回会话）与 `streamAssistantReply` 步骤 0.1（发送前）。
  - **刷新顺序不可与流式槽位交换**（§4.2 注 2），有专门回归用例守着。
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
