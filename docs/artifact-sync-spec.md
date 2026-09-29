# 产物内容寻址同步（批次 6，M6）

> **一句话范围**：把 FR-7.2 的**产物索引**（`artifactsStore.index`）与**内容池**
> （`artifactsStore.bodies`）经同步层跨端传播——索引条目作 LWW 实体、内容池作内容寻址
> blob，两者共享「内容寻址」这个核心：同 `contentHash` 的正文在云端只存一份，跨端天然去重。
>
> 与「产物同步本身仍未开工」（FR-7.2 已知偏差 #5）的关系：本批把它接上。

---

## 0. 设计定位

产物有两个维度，都塞不进 `SyncCollectionSpec` 的同步 `read()`（LWW 实体要求同步读）：

1. **索引条目**（`index`）—— LWW 实体，键 = `id`，自带 `rev` / `updatedAt` /
   `updatedBy` / `deletedAt`，`title` 演进走三级 tie-break 裁决（与 8 个实体同款）。
2. **内容池**（`bodies`）—— 内容寻址 blob，键 = `contentHash`，正文**不可变**
   （SHA-256 相同则内容必相同）。`rev` 恒 1、`updatedAt` 恒 `''`、`deletedAt` 恒 `null`
   → LWW 永远「完全同版 → 平局 → 服务端保留先到者」，不会因时间戳漂移而覆盖（内容相同，
   覆盖无害）。

因此产物**不进 `syncRegistry`**，而是走独立的 `ArtifactsAdapter`（与 `eventStream` /
`fileAssets` 并列的「第四类通道」）：全异步、可选注入、引擎**不 import 任何 store**
（不变量 2）。

## 1. 两个 collection（字符串，collection 无关的服务端原样存取）

| collection | 语义 | 键 | 特殊 |
|---|---|---|---|
| `artifactIndex` | 索引条目（LWW 实体 + 墓碑） | `id` | `version` / `previousVersion` / `versions`（FR-7.4）随条目走 |
| `artifactBodies` | 内容池（内容寻址 blob） | `contentHash` | 不可变，云端只存一份 |

服务端 `cloud/app/sync/routes.py` 的 `push` / `pull` 对 collection **完全无关**——整条
`entity` payload 原样存取，`payload` 列是 `Text` 无大小限制，**无需改云端**。

## 2. 客户端接线

| 落点 | 改动 |
|---|---|
| `src/sync/artifacts.ts` | `ArtifactsAdapter`：`hydrate()` 补 `updatedBy` 设备 id；`collect()` 组装两类变更；`apply()` 落地（内容池 upsert / 索引 LWW 存活合并 + 墓碑摘除） |
| `src/sync/SyncEngine.ts` | 新增 `artifacts?` 选项：`syncNow` 里 **pull 前 hydrate**、pull 后 `applyPulledArtifacts`、push 并入 `collect()`（与 `fileAssets` 同款接线） |
| `src/sync/runtime.ts` | 注入 `createArtifactsAdapter()`；`useArtifactsStore` 加入本地变更订阅（`SUBSCRIBED_STORES`），使本地入库 / 编辑触发防抖同步 |
| `src/sync/types.ts` | `SyncCollection` 联合类型补 `'artifactIndex' \| 'artifactBodies'`（仅约束拼写，运行时不依赖它分发） |

`updatedBy` 由适配器补（与 `fileAssets` 同款）：store 的同步写入动作（`recordArtifact` /
`clearSession` / `clearAll` / 版本动作）拿不到异步的 `deviceId`，条目里写空串 `''`，
`collect()` 阶段补成真实值。

## 3. 账户态

单账户设备假设（与 8 个可同步实体同源）：store 是单例全局，索引条目自带 LWW 四元数据，
无需像 `fileAssets` 那样另存按账户分片的 `PersistedState`。跨账户隔离归 M6 后续批次。

## 4. 判据（可证伪）

| # | 判据 |
|---|---|
| J-1 | 未 `hydrate()` → `collect()` 返回 `[]`（绝不推未水合的空覆盖） |
| J-2 | `recordArtifact` 后 `collect()` 含 `artifactIndex:<id>`（rev=1）+ `artifactBodies:<contentHash>`（content 命中，rev=1/updatedAt=''） |
| J-3 | 同内容跨会话只占 `artifactBodies` 一个 key（`bodies` 去重），但 `artifactIndex` 两条 |
| J-4 | `apply` 内容池：相同正文 → 0 改动；新正文 → 写入 `bodies` |
| J-5 | `apply` 索引：远端更旧 → 0；远端更新 → 落地；`deletedAt` → 摘除 + 写墓碑 |
| J-6 | `apply` 携带 `version` / `previousVersion` / `versions`（FR-7.4）保留 |
| J-7 | 引擎接线：hydrate 在 pull 前、collect 并入 push、pull 产物走适配器落地并计入 `pulled`；未注入 → 既有行为不变 |
| J-8 | `useArtifactsStore` 本地写入触发 `notifyLocalChange`（防抖同步） |

## 5. 已知偏差

1. **`versions` 数组 LWW 整条替换**：冲突时赢家那份 `versions` 覆盖输家，罕见冲突下版本
   历史可能丢失输家分支（P1 可接受；精确多分支合并非 MVP 目标）。
2. **无独立 `bodies` GC**：`clearSession` 不清池（防误删共享 hash 正文），孤儿 KB 级，可接受。
