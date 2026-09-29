# FR-7.2 产物索引 —— 落地规格

> **一句话范围**：给产物建**独立索引**（`contentHash` 内容寻址 + 跨会话检索 + 去重），
> 落点是 store 索引切片（两端权威）+ Electron 镜像 `<userData>/artifact-index/<id>.json`。
> **内容本体不动**——不牵动 `ArtifactRenderer` 与事件流里 artifact 事件的形态。
>
> **与 M6 的关系**：M6（多端一致）已全线闭合，但**产物内容寻址同步**被 6a 裁决划出，
> 理由正是「落点会随 FR-7.2 重做」。本批把落点建起来，产物同步才有了着落处。
> **本批不做产物同步**（仍等 FR-7.2 落地后的另立批次）。

---

## 0. 现状差距（开工前实测，2026-09-29）

| PRD FR-7.2 要求 | 现状 | 差距 |
|---|---|---|
| `contentHash: "sha256:..."` | ❌ 无。只有 `hashContent`（djb2，`src/lib/workspaceKey.ts`） | 缺内容寻址 |
| `artifact-index/<id>.json` | ❌ 目录不存在 | 缺独立索引落点 |
| 跨会话检索 | ❌ `ArtifactsPage` 仅 42 行纯列表，标题还挂「（P2）」 | 缺检索 |
| 同内容不重复入库 | ❌ 只按 `id` 去重、且仅同会话内（`artifactsStore.ts:23`） | 缺去重 |
| 索引字段 `sessionId`/`messageId` | ❌ `Artifact` 类型里一个都没有 | 缺索引元数据 |

另有三处**照 PRD 写就会写错**的地方，见 §1 的 D1 / D5 / D8。

---

## 1. 决策表

| # | 决策点 | 裁决 | 理由 |
|---|---|---|---|
| D1 | 索引落点 | **store 索引切片为权威（两端可用）+ Electron 额外镜像 `artifact-index/<id>.json`**；**内容本体不动** | 内容本体已内联在**消息**里（`sessionsStore.handleArtifact` → `updateMessage` 加 `artifacts`）并进事件流。做「内容池按 hash 去重 + 索引存引用」要同时改 `ArtifactRenderer` 的取内容方式与 `ArtifactEvent` 形态，风险与工作量都不成比例。镜像则把 PRD 要的同构落点先建起来 |
| D2 | `contentHash` 算法 | **新建 `src/lib/contentHash.ts`，`contentHash(text) → 'sha256:<hex>'**，输入按 UTF-8 编码 | 6b 规格 §5 已把这条定为**跨批契约**：FR-7.3 的 `file-history/<hash>.bak` 与未来产物同步复用同一函数，避免出现两套寻址 |
| D3 | 为什么必须**同步** | 渲染层拿不到 `node:crypto`；`crypto.subtle.digest` 是**异步**的，而入库点 `recordArtifact` 是同步 reducer。故用**纯 TS 同步实现**（标准 SHA-256，约 70 行），两端逐字节一致 | 「异步 hash」会把同步 store 拖成异步，牵动所有调用方 |
| D4 | 与 djb2 的分工 | **`hashContent`（djb2）不得用于内容寻址**。djb2 只用于段键与变更检测（6b 用的 `<!-- SUMMARY:<hash> -->` 去重标记与它逐字节对齐） | 6b 规格 §5 明令两者分工，混用会出现「短 hash 冒充内容地址」 |
| D5 | `ArtifactEvent.path` | **本期不启用**。该字段注释已写「artifact-index 落地后启用；V1 不使用」，启用它 = 内容外置到文件 = D1 排除项 | 启用后事件流里的产物只剩引用，重放投影需要能读回文件，Web 端还得降级——不是本批能收住的 |
| D6 | `recordArtifact` 签名 | 加 `messageId`：`recordArtifact(sessionId, messageId, artifact)` | 索引要 `messageId`（PRD 样例有），且「跳回该会话并定位到该消息」需要它。调用点只有 `sessionsStore.ts:2208` 一处，`handleArtifact` 手上就有 `messageId` |
| D7 | 镜像方向 | **单向**（store → 文件），本批**不提供回读入口**；Web 端 `put`/`remove` 是 **no-op** | 回读会让文件成为第二权威，双源一致性成本高于收益。镜像的价值是「诊断/迁移/未来产物同步的落点」，与 6a 归档同性质（记为已知偏差 #1） |
| D8 | 删会话要清产物 | **`clearSession` / `clearAll` 目前零调用点** → 删掉会话后产物库仍留着它的产物。本期把 `deleteSession` / `deleteSessions` 接上 `clearSession` | 不接则索引只增不减，孤儿条目永久堆积；且「会话已删、产物还在」本身就是错的行为 |
| D9 | `version` / `previousVersion` | **本期不落字段** | PRD 明确 `previousVersion` 是 FR-7.4（P1）版本链的基础，本批不做半条链 |

---

## 2. 数据模型

### 2.1 `src/lib/contentHash.ts`

```ts
/** 内容寻址哈希：`sha256:<hex>`，输入按 UTF-8 编码。同步、纯函数、不 import platform。 */
export function contentHash(text: string): string;
```

标准 SHA-256（FIPS 180-4），纯 TS 同步实现，`TextEncoder` 做 UTF-8 编码
（浏览器与 Node 都有全局 `TextEncoder`，jsdom 亦提供）。

### 2.2 `ArtifactIndexEntry`（`src/types/artifact.ts`）

```ts
export interface ArtifactIndexEntry {
  /** 产物 id（与 `Artifact.id` 一致，也是索引文件名 `<id>.json`） */
  id: string;
  sessionId: string;
  messageId?: string;
  type: ArtifactType;
  title?: string;
  /** 内容寻址：`sha256:<hex>` */
  contentHash: string;
  createdAt: string;
}
```

**刻意不含** `content`（本体不进索引，见 D1）与 `version`/`previousVersion`（见 D9）。

### 2.3 `artifactsStore` 索引切片

```ts
interface ArtifactsState {
  bySession: Record<string, Artifact[]>;          // 既有，内容本体
  index: Record<string, ArtifactIndexEntry>;      // 新增：跨会话检索与去重的权威入口
  recordArtifact: (sessionId: string, messageId: string, artifact: Artifact) => void;
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
}
```

`index` **必须进 `partialize`**（否则重启即丢，而 `bySession` 还在 → 两端立刻不一致）。

---

## 3. 落点

| 数据 | 落点 | 备注 |
|---|---|---|
| `bySession`（内容本体） | `<userData>/artifacts.json` | 既有（`STORAGE_KEYS.artifacts`） |
| `index`（索引切片） | 同上（随 `artifacts.json`） | **新增**，进 `partialize` |
| 索引镜像 | `<userData>/artifact-index/<id>.json` | **新增**，Electron 专属，单向（D7） |

### 3.1 平台能力（新增）

```ts
export interface ArtifactIndexFiles {
  /** 写入/覆盖单条索引；Web 端无文件系统 → no-op */
  put(entry: ArtifactIndexEntry): Promise<void>;
  /** 删除单条索引（幂等）；Web 端 → no-op */
  remove(id: string): Promise<void>;
}
```

挂在 `PlatformAdapter.artifactIndex`（与 `memoryFiles` 同层：一个 key 一个文件的
storage 契约表达不了「一个目录、若干文件」）。Electron 端新增 IPC
`artifactIndex:put` / `artifactIndex:remove`，主进程写 `<userData>/artifact-index/`。

---

## 4. 去重语义（D3 裁决展开）

1. **入库去重**：`recordArtifact` 计算 `contentHash`，**同会话内**已存在相同
   `contentHash` 的产物 → 跳过（既不新增 `bySession` 项，也不新增索引条目）。
2. **跨会话不去重入库**：同一内容在两个会话出现 → 两条索引条目（`id` / `sessionId`
   不同，`contentHash` 相同）。理由：跨会话检索要能回答「哪些会话产出过它」。
3. **检索折叠**：产物库默认按 `contentHash` 折叠，重复项标「N 处出现」，可展开。

> 内容本体因此**仍跨会话重复存储**（已知偏差 #4）。彻底去重 = D1 排除项。

---

## 5. 判据（可证伪）

| # | 判据 |
|---|---|
| J-A1 | `contentHash('')` / `contentHash('abc')` / 中文串与 SHA-256 标准向量逐字符相等，且带 `sha256:` 前缀 |
| J-A2 | 同一输入在 jsdom 与 node 两种环境下结果相同（纯 TS，无平台分支） |
| J-A3 | `contentHash` 与 `hashContent`（djb2）输出形态可区分（前缀 / 长度），用例锁死「不得互换」 |
| J-B1 | `recordArtifact` 后 `index` 有对应条目，含 `sessionId` / `messageId` / `contentHash` |
| J-B2 | 同会话内重复写入相同内容 → `bySession[sessionId]` 长度不变、`index` 不新增条目 |
| J-B3 | 不同会话写入相同内容 → `index` 两条，`contentHash` 相同、`sessionId` 不同 |
| J-B4 | `index` 进 `partialize`：重载后索引仍在（与 `bySession` 一致，无孤儿条目） |
| J-C1 | Electron 端 `recordArtifact` 会调 `platform.artifactIndex.put`（mock 断言被调用）；Web 端 no-op 且不抛 |
| J-C2 | `clearSession` 删掉该会话全部索引条目，并逐个调 `remove` |
| J-D1 | 搜索框命中标题 / 内容 / 语言三者之一即显示，不命中不显示 |
| J-D2 | 类型筛选切换后列表只剩该类型 |
| J-D3 | 时间排序正反切换，顺序真的颠倒 |
| J-D4 | 同 `contentHash` 的多条默认折叠为一条并显示「N 处出现」，展开后可见全部 |
| J-D5 | 点「回到会话」→ `selectSession` + `navigate('/chat')` + `focusMessage(messageId)` 被调用 |

---

## 6. 已知偏差

1. **索引镜像是单向的**（D7）：写入后本机无人回读，供诊断 / 迁移 / 未来产物同步使用。
2. **`ArtifactEvent.path` 仍未启用**（D5）：事件流里的产物继续自包含内容。
3. **`version` / `previousVersion` 不落**（D9）：归 FR-7.4。
4. **内容本体跨会话重复存储**：去重只做到「不重复入库 + 检索折叠」（§4）。
5. **索引无 GC**：只随 `clearSession` / `clearAll` / 删会话清理；`artifact-index/`
   目录下的孤儿文件依赖同一条路径，不另设扫描器。
