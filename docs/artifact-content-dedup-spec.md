# 产物内容寻址彻底去重 —— 落地规格

> **一句话范围**：推翻 FR-7.2 的 D1 排除项（「内容本体不动」），引入 `bodies` 内容池，
> 产物正文按 `contentHash` 只存一份；`bySession` 改为**引用**（去 `content`），渲染时回填。
> 配套一次性迁移旧 `bySession` 内联正文。落点（`contentHash` / 索引切片 / Electron 镜像）已备。
>
> **与 FR-7.2 的关系**：FR-7.2 已知偏差 #4「内容本体跨会话重复存储」在本批消除。
> 检索折叠（按 `contentHash`）继续沿用，且现在折叠的正是「正文只存一份」后的真实重复。

---

## 0. 现状差距（开工前实测，2026-09-29）

| FR | 现状 | 差距 |
|---|---|---|
| 正文跨会话只存一份 | ❌ `artifactsStore.bySession` 每条 `Artifact` 都内联 `content`，同内容在 N 个会话 = N 份 | 缺内容池 |
| `ArtifactItem` 渲染有正文 | `ArtifactsPage` / `ArtifactPanel` 直接把 `bySession` 的 `artifact.content` 交给 `ArtifactRenderer` | 改引用后必须回填 |
| 旧数据兼容 | 已入库的 `bySession` 仍带 `content` | 需一次性迁移进 `bodies` |

---

## 1. 决策表

| # | 决策点 | 裁决 | 理由 |
|---|---|---|---|
| D1 | 去重形态 | **`bodies: Record<contentHash, string>` 内容池 + `bySession` 改为引用（去 `content`）**，渲染时按 `entry.contentHash` 从池回填 | 彻底去重唯一干净的做法：正文只随 hash 存一份，跨会话天然不重复。检索折叠（D4）因此建立在真实去重之上 |
| D2 | 迁移 | `onRehydrateStorage` 一次性把旧 `bySession` 内联 `content` 搬进 `bodies`、原位置 `content=''` | 升级后首启即完成；不迁移则旧产物正文消失 |
| D3 | image / video | `content` 本就为空串 → **不写 `bodies`**，`bySession` 里本就是空，渲染回落 `url` | 空正文进池无意义；`artifactContentHash` 已回落 `url` 作身份 |
| D4 | 检索折叠 | `groupByHash` 不变（基于 `entry.contentHash`）；正文重复现在才是「真重复」 | 折叠语义不变，但底层已去重 |
| D5 | 渲染回填 | `ArtifactsPage` + `ArtifactPanel` 构造 `ArtifactItem` 时 `content = bodies[entry.contentHash] ?? artifact.content` 再交给 `ArtifactRenderer` | 渲染面只两处，集中回填；`bodies` 缺失（未迁移 / 图片）时回落内联，零回归 |
| D6 | 清库 | `clearAll` 同时清 `bodies`；`clearSession` **不清** `bodies`（同 hash 可能被其它会话引用） | 避免误删他人正文；孤儿 `bodies` 代价见已知偏差 #1 |
| D7 | Electron 镜像 | `artifact-index/<id>.json` 镜像**不变**（只索引，不含正文） | 镜像定位仍是诊断/迁移落点，不承载正文 |

---

## 2. 数据模型

### 2.1 `artifactsStore` 状态

```ts
interface ArtifactsState {
  /** 按 sessionId 归档的**引用**（已去 content），渲染前从 bodies 回填 */
  bySession: Record<string, Artifact[]>;
  /** 内容池：contentHash → 正文（彻底去重；image/video 不入池） */
  bodies: Record<string, string>;
  /** 独立索引：id → 条目（FR-7.2，跨会话检索与去重权威入口） */
  index: Record<string, ArtifactIndexEntry>;
  recordArtifact: (sessionId: string, messageId: string, artifact: Artifact) => void;
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
}
```

`bodies` **必须进 `partialize`**（否则重启后索引在、正文丢）。

### 2.2 `recordArtifact` 新流程

```
hash = artifactContentHash(artifact)              // 复用 FR-7.2 契约
if (artifact.content) bodies[hash] = artifact.content   // D3：空正文不入池
reference = { ...artifact, content: '' }          // D1：去 content 入库
if (同会话同 hash 已存在) return                    // 入库去重（同 FR-7.2）
bySession[sessionId].push(reference)
index[id] = buildIndexEntry(...)
mirrorPut(index[id])
```

### 2.3 回填辅助

```ts
/** 渲染前把引用还原成带正文的 Artifact；bodies 缺失时回落内联（兼容/图片） */
export function resolveArtifactContent(
  contentHash: string,
  bodies: Record<string, string>,
  fallback: string,
): string {
  return bodies[contentHash] ?? fallback;
}
```

---

## 3. 去重语义

1. **入库去重**（同 FR-7.2）：同会话同 `contentHash` 跳过。
2. **跨会话不去重入库**：同内容两会话 → 两条索引（`sessionId` 不同），但**正文只存一份**（同一 `bodies[hash]`）。
3. **检索折叠**：按 `contentHash` 折叠，标「N 处出现」。
4. **彻底去重**：正文在 `bodies` 中按 hash 唯一；`bySession` 不再持有正文。

---

## 4. 判据（可证伪）

| # | 判据 |
|---|---|
| J-A1 | 同内容两会话各 `recordArtifact` 一次：`index` 两条、`bodies` 仅 1 个 key、`bySession` 两处引用的 `content` 均为 `''` |
| J-A2 | `bodies[hash]` 与 `artifact.content` 逐字符相等（非图片） |
| J-A3 | 渲染面 `ArtifactRenderer` 收到的 `artifact.content` 来自 `bodies`（非空），正文不丢失 |
| J-A4 | 迁移：旧持久化数据（带 `content`）重载后 `bodies` 被填充、`bySession` 引用 `content=''` |
| J-A5 | `clearAll` 后 `bodies` 为空；`clearSession` 后 `bodies` 仍保留（可能跨会话共享） |
| J-A6 | 图片类（`content=''`）：`recordArtifact` 不入 `bodies`，渲染仍正常（用 `url`） |
| J-A7 | `index` 进 `partialize`（与 `bodies` 一起），重启后索引与正文一致无孤儿 |

---

## 5. 已知偏差

1. **`bodies` 不 GC**：`clearSession` 不清池（防误删共享 hash 的正文），残留 KB 级孤儿，可接受。
2. **事件流里 artifact 仍内联**：`ArtifactEvent` 不含 `path`（FR-7.2 D5），事件流是会话事实源、无法跨会话去重；本批只去重 `artifactsStore` 库。
