# FR-7.3 文件级回滚 —— 落地规格

> **一句话范围**：补全 `PlatformAdapter.fileBackup` 抽象（Electron 调既有 `putFileBackup`/
> `getFileBackup` 桥，落 `<userData>/file-history/<hash>.bak`；Web 端 no-op），给
> `MemoryService` 全部写路径接 **prebackup**（覆盖/删除前快照旧内容）+ 回滚时间线，
> 并在记忆页提供「历史快照 / 回滚到此处」UI。**引擎侧 workspace 文件写前快照单列
> follow-up**（nanobot 当前只读，本批不可改）。
>
> **与 6b 的关系**：6b §0 已裁定 FR-7.3 的 `file-history/<hash>.bak`（本机回滚备份，单设备）
> 与 C 类资产的内容寻址（跨端去重）是「同名不同物」——本批只做前者。

---

## 0. 现状差距（开工前实测，2026-09-29）

| 要求 | 现状 | 差距 |
|---|---|---|
| `PlatformAdapter.fileBackup` 抽象 | ❌ `ElectronAPI` 有 `putFileBackup`/`getFileBackup`，但 `PlatformAdapter` 没暴露（只有 `memoryFiles`/`artifactIndex`） | 缺统一抽象 |
| 写前快照 | ❌ `MemoryService.save/writeFile/append/removeFile/clear` 直接覆盖/删除，无 prebackup | 缺 prebackup |
| 回滚 UI | ❌ 记忆页无历史快照面板 | 缺 UI |
| 回滚时间线 | ❌ 仅内容寻址备份，无「哪个文件 / 何时 / 什么操作」元数据 | 缺 timeline |

---

## 1. 决策表

| # | 决策点 | 裁决 | 理由 |
|---|---|---|---|
| D1 | 落地范围 | **仅客户端记忆写点**（MemoryService 全路径：L2 用户级 + L3 工作区级）；引擎侧 workspace 文件写前快照**单列 follow-up**（nanobot 只读） | 客户端写路径 40+ 调用点 funnel 进 5 个方法，可控；引擎侧需改 nanobot（违反只读约束） |
| D2 | 平台抽象 | 新增 `FileBackup` 接口挂 `PlatformAdapter.fileBackup`：electron 调 `window.electronAPI.putFileBackup`/`getFileBackup`；web no-op | 与 `artifactIndex` 同层模式；**不新建 IPC**（桥已存在于 `electron/preload.ts` + `main.ts:2523`）→ 无需重建 `main.cjs`/`preload.cjs` |
| D3 | prebackup 时机 | 覆盖/删除**之前**对**旧内容**做 `putFileBackup(hash, old)`；最佳努力（`try/catch`），失败不影响真实写入 | 快照若抛错不能阻断用户保存 |
| D4 | 回滚时间线 | 新 `fileBackupStore`（持久化 `timeline: Record<fileKey, {hash, at, op}[]>`），单 key 上限 50 条 | 内容寻址备份本身无「哪个文件/何时」元数据，回滚 UI 需要时间线 |
| D5 | `fileKey` 口径 | `memory:${scope}:${workdir ?? ''}:${name}` | 跨工作区/作用域隔离；用户级 `workdir` 空 |
| D6 | 回滚动作 | `getFileBackup(hash)` → `MemoryService.writeFile(workdir, name, content)`；写回**自身触发 prebackup** → 回滚可再撤销 | 回滚不是破坏性行为，留痕才安全 |
| D7 | Web 端 | `fileBackup` no-op、`getFileBackup` 返回 `null` → 记忆页「历史快照」禁用并提示「仅桌面端支持」 | 与 FR-7.2 镜像同款降级 |

---

## 2. 数据模型

### 2.1 `FileBackup`（platform/types.ts）

```ts
export interface FileBackup {
  /** 内容寻址备份：写入 `<hash>.bak`（同 hash 幂等）；Web 端 no-op */
  put(hash: string, content: string): Promise<void>;
  /** 读取备份；不支持时返回 null */
  get(hash: string): Promise<string | null>;
}
```

### 2.2 `fileBackupStore`

```ts
interface FileBackupState {
  timeline: Record<string, Array<{ hash: string; at: string; op: 'overwrite' | 'append' | 'delete' }>>;
  record(fileKey: string, hash: string, op: Op): void;
  list(fileKey: string): Array<{ hash: string; at: string; op: Op }>;
}
```

持久化 key：`nanowork.fileBackups`（`STORAGE_KEYS.fileBackups`）。

### 2.3 `src/lib/artifact/fileBackup.ts`（封装）

```ts
/** 写前快照：读旧内容 → 内容寻址备份 → 记时间线（最佳努力） */
export async function snapshotBeforeWrite(fileKey: string, oldContent: string | null, op: Op): Promise<void>;
/** 回滚到指定快照：读备份 → 写回（自身触发 prebackup） */
export async function restoreSnapshot(fileKey: string, hash: string): Promise<void>;
/** 列出某文件的快照时间线 */
export function listSnapshots(fileKey: string): Array<{ hash: string; at: string; op: Op }>;
```

---

## 3. MemoryService 接 prebackup

| 方法 | fileKey | op | 旧内容来源 |
|---|---|---|---|
| `save('user')` | `memory:user::MEMORY.md` | overwrite | `platform.storage.get(USER_MEMORY_KEY)` |
| `save('workspace')` → `writeFile(MEMORY.md)` | `memory:workspace:<wd>::MEMORY.md` | overwrite | `platform.memoryFiles.read(wd, MEMORY.md)` |
| `writeFile(name)` | `memory:workspace:<wd>::<name>` | overwrite | `platform.memoryFiles.read(wd, name)` |
| `append` 工作区级 | `memory:workspace:<wd>::<daily>` | append | `platform.memoryFiles.read(wd, daily)` |
| `append` 用户级 | `memory:user::MEMORY.md` | append | `platform.storage.get(USER_MEMORY_KEY)` |
| `removeFile` | `memory:workspace:<wd>::<name>` | delete | `platform.memoryFiles.read(wd, name)` |
| `clear('user')` | `memory:user::MEMORY.md` | delete | `platform.storage.get(USER_MEMORY_KEY)` |
| `clear('workspace')` | 每个文件一条 | delete | `platform.memoryFiles.list` + 逐个 `read` |

`oldContent === null`（文件原本不存在）→ 不快照（无物可回滚）。

---

## 4. 判据（可证伪）

| # | 判据 |
|---|---|
| J-A1 | `PlatformAdapter.fileBackup` 在 electron 调到 `window.electronAPI.putFileBackup`；web 调 no-op 不抛 |
| J-A2 | `MemoryService.writeFile` 覆盖前：旧内容被 `putFileBackup(contentHash(old), old)` 且 `timeline[fileKey]` 多一条 overwrite |
| J-A3 | `MemoryService.append` 前：当日文件旧内容被快照，op=append |
| J-A4 | `MemoryService.clear` 前：每个被删文件旧内容被快照，op=delete |
| J-A5 | prebackup 抛错不影响真实写入（最佳努力） |
| J-A6 | 回滚：`restoreSnapshot` 调 `getFileBackup(hash)` → 写回；写回本身在时间线再留一条 |
| J-A7 | 记忆页「历史快照」面板列出 `timeline[fileKey]`（按 at 倒序），点「回滚到此处」触发 J-A6 |
| J-A8 | Web 端 `timeline` 恒空，UI 禁用并提示「仅桌面端支持文件级回滚」 |
| J-A9 | 单 key 时间线上限 50 条（超出丢弃最旧） |

---

## 5. 已知偏差

1. **引擎侧 workspace 文件无写前快照**：nanobot 只读，本批只覆盖客户端记忆写点；引擎侧任意文件回滚为 follow-up。
2. **`bodies` 与记忆备份是两套存储**：产物正文去重在 `artifactsStore.bodies`，记忆回滚在 `file-history/`；两者互不相关（前者跨会话去重、后者单设备时间线）。
3. **Web 端无回滚**：`fileBackup` no-op，记忆页仅展示不可用提示。
4. **时间线不 GC**：单 key 上限 50 条，更早的快照只保留备份文件（内容寻址）但不在时间线列出。
