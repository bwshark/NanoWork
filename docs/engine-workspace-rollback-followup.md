# 引擎侧 workspace 文件回滚 —— 单列 follow-up

> **状态**：⏸ 延后（单列，不并入本批）。
> **原因**：nanobot 引擎仓库为**只读**（独立 `.git` 且对象库受损，模型不得改其代码），
> 引擎侧 workspace 文件写点（记忆以外的用户工作区文件）的「写前快照 + 回滚」无法在当前
> 客户端批次内实现。FR-7.3 客户端记忆回滚**已落**（见 `docs/fr-7-3-file-rollback-spec.md`），
> 但只覆盖客户端记忆写点（`MEMORY.md` + 工作区记忆目录），不含引擎 workspace 文件。

---

## 1. 范围与边界

| 写点 | 归属 | 回滚现状 |
|---|---|---|
| 客户端记忆（`MEMORY.md` / 工作区记忆目录） | 客户端 `MemoryService` | ✅ FR-7.3 已落（`src/lib/artifact/fileBackup.ts` + 平台 `FileBackup`） |
| 引擎 workspace 文件（用户工作区里的任意文件，经 `shell.py` / `apply_patch` 写入） | **nanobot 引擎进程内** | ⬜ 本 follow-up，待引擎可写 |

记忆回滚与文件回滚**是两套独立链路**：记忆走客户端 `MemoryService` 的五个写入口挂
`snapshotBeforeWrite`；workspace 文件走引擎的写工具（`write_file` / `apply_patch` /
`delete_file`），不在客户端可控范围。

## 2. 设计要点（待实现，供开工参考）

1. **落点**：复用 FR-7.3 的 `file-history/<hash>.bak` blob 形态（已是跨批契约，
   `sha256:<hex>` 由 `src/lib/core/contentHash.ts` 产出），**不要**另起一套哈希方案。
2. **写前快照**：在引擎写工具执行**前**对目标文件做快照（内容哈希命中则跳过，避免重复
   存储），时间线元数据与记忆回滚同构（`fileBackups` 风格）。
3. **回滚动作**：引擎暴露「回滚到某快照」工具 / 事件，由客户端 UI 触发（类比 FR-7.3 的
   「历史快照 / 回滚到此处」）。回退自身须再触发一次快照（可再撤销，与记忆回滚同源）。
4. **回收站兜底**：删除类操作已收口 `security/trash.py`（FR-8.3），回滚不应绕过它——
   回滚 = 用快照内容覆盖当前文件，不是「从回收站找回」。
5. **Web 端**：引擎 workspace 文件本就只在 Electron + 引擎进程内存在，Web 端无此概念
   （与 FR-7.3 的 `fileBackup` no-op 同款降级）。

## 3. 阻塞项

- **nanobot 只读**：本仓库对象库受损且模型不得执行 git 写操作。要落引擎侧回滚，需：
  1. 引擎仓库恢复可写（或切到可读写分支）；或
  2. 由用户在引擎侧独立 PR 实现，客户端本批只预留调用契约。
- **客户端调用契约已就绪**：`platform` 的 `FileBackup`（`put` / `get`）与 `file-backup:put/get`
   IPC 已存在，引擎侧回滚可直接复用，无需新增平台能力。

## 4. 验收（开工后）

- 引擎写工具执行前，目标文件快照落入 `file-history/<hash>.bak`；
- 客户端 UI 能列出 workspace 文件的历史快照并回滚到任意一处；
- 回滚自身产生新快照（可再撤销）；
- 内容相同（哈希命中）不重复落快照。

## 5. 本轮回访结论（2026-09-29）

**客户端侧无代码可写，本 follow-up 维持 ⏸ 延期。**

- **客户端调用契约已就绪**（§3 第 4 点已判定）：`platform` 的 `FileBackup`（`put`/`get`）与
  `file-backup:put`/`file-backup:get` IPC 由 FR-7.3 落地，引擎侧 workspace 回滚可直接复用，
  **无需新增任何平台能力**。
- **引擎侧是真正的阻塞点**：nanobot 仓库只读（独立 `.git` 且对象库受损，模型不得 git 写），
  引擎写工具（`shell.py` / `apply_patch` / `delete_file`）的「写前快照 + 回滚动作」无法在当前
  客户端批次内实现。
- **结论**：本批次的「引擎侧 workspace 文件回滚客户端脚手架」任务收口为「无动作」——
  仅补充本档与 `docs/c-class-cross-device-spec.md` 的状态记录，不新建/不改任何源码。
  待引擎仓库恢复可写（或由用户在引擎侧独立 PR 实现）后，按 §2 设计要点 + §4 验收落地，
  客户端无需再改。
