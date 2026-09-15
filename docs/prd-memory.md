# 增量 PRD：工作区文件记忆（MEMORY.md 机制）

> 本文件为 `docs/prd.md` 的增量补充，仅描述 P1「工作区文件记忆」变更部分，不重写既有 P0 需求。

## 1. 需求目标与价值
让客户端在每个工作区根目录沉淀一份可读、可编辑的 `MEMORY.md`，把多轮及跨会话的任务上下文、用户偏好、关键结论持久化为 Markdown。新会话可将其作为上下文注入 Agent，实现"越用越懂你"的长期记忆，弥补当前会话隔离导致的信息丢失，且复用已有 `platform.writeTextFile`/`platform.storage` 能力，跨端零侵入。

## 2. 用户故事
- **查看记忆**：As a 用户, I want 在"记忆"入口查看当前工作区的 MEMORY.md 原文, so that 我能知道 Agent 记住了什么。
- **Agent 自动沉淀记忆**：As a 用户, I want 会话结束后 Agent 自动把关键结论摘要写入 MEMORY.md, so that 下次会话无需重复交代背景。
- **手动编辑记忆**：As a 用户, I want 在聊天页选中内容"保存为记忆"并手动编辑 MEMORY.md, so that 我能主动控制长期记忆的准确性。

## 3. 需求池
- **P0** 记忆存储：工作区根目录 `MEMORY.md`（Markdown）。Electron 经 `platform.writeTextFile` 落真实文件（safe root）；Web 经 `platform.storage` 落 localStorage（或降级下载）。读取优先真实文件，缺省回退 localStorage。
- **P0** 记忆读取：新会话创建时自动读取 MEMORY.md；以可开关的"记忆上下文"注入 system prompt 末尾（开关存 `settingsStore`）。
- **P0** 手动写入：聊天页消息操作菜单提供"保存为记忆"（追加带时间戳的引用块）；"记忆"页支持在线编辑并保存。
- **P1** 自动沉淀：会话结束（关闭/新建会话）触发摘要；策略 = 调用 Agent 生成 ≤150 字结构化摘要（决策/偏好/待办），追加至 MEMORY.md，幂等去重。
- **P1** UI 落点：设置页新增"记忆"分区 + 独立"记忆"入口页；聊天页消息 hover 菜单含"保存为记忆"。
- **P2** 多工作区记忆隔离与导入/导出。

### 与现有 store 关系
- `agentsStore.agent.systemPrompt`：记忆**不**写入 systemPrompt 字段，仅运行时注入，保持 agent 模板纯净。
- `sessionsStore`：在 `createSession` 阶段读取记忆并拼装上下文，不持久化记忆内容本身。

## 4. UI / 交互设计要点
```
设置页 ── 记忆 [开关: 注入记忆上下文] [打开记忆文件]
聊天页 ── 消息 hover → "💾 保存为记忆"
记忆页 ── ┌──────────────────────┐
          │ MEMORY.md (可编辑)   │
          │ [保存] [重置] [导出] │
          └──────────────────────┘
```
新建会话时若记忆非空，聊天顶部显示"已加载 N 条记忆"提示条，可临时关闭。

## 5. 待确认问题
1. 自动摘要默认开还是关？**推荐：默认关，首次手动开启并提示。**
2. Web 端记忆存 localStorage 还是强制下载文件？**推荐：localStorage 为主，提供导出。**
3. 记忆注入位置（system prompt 末尾 vs 独立 context 块）？**推荐：system prompt 末尾，标签包裹。**
4. 自动摘要调用哪个模型？**推荐：随当前连接直连 nanobot 网关；网关离线时静默跳过。**
5. 多工作区如何判定根目录？**推荐：以当前打开的工作区路径为 key。**
