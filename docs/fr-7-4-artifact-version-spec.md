# FR-7.4 产物版本链 —— 落地规格

> **一句话范围**：同源产物多版本可**对比与回退**。索引条目加 `version` / `previousVersion`
> / `versions`；同 `id` 内容变化即升一版；历史正文因内容寻址（`bodies`）天然留存，回退只是
> 把旧正文重新设为当前版本（再开一版，不覆盖历史）。
>
> PRD（R7）：`FR-7.4 | 产物版本 | P1 | ⬜ | both | 同源产物多版本可对比与回退`。

---

## 0. 现状差距（2026-09-29，FR-7.2 已落）

| 要求 | 现状 | 差距 |
|---|---|---|
| `version` / `previousVersion` | ❌ 索引条目无此字段 | 缺版本元数据 |
| 同源产物多版本 | ❌ `recordArtifact` 同 id 重放直接跳过 | 缺升版机制 |
| 对比 / 回退 UI | ❌ 产物预览只有单版本 | 缺版本历史面板 |

## 1. 决策表

| # | 决策点 | 裁决 | 理由 |
|---|---|---|---|
| D1 | 版本身份 | **`id` 稳定跨版本**（同源 = 同 `id`）；`version` 是 1 起递增号 | 复用既有 `index` 主键，不需要引入「逻辑 artifact id」与「版本 id」双层 |
| D2 | 链指针 | `previousVersion` = 上一版 `contentHash`，沿 `bodies` 回溯旧正文 | 内容寻址：旧正文按 hash 在 `bodies` 仍唯一留存（不入池的 image/video 无法回溯，见 D6） |
| D3 | 历史存哪 | `versions: ArtifactVersionMeta[]` 挂在索引条目上，随 LWW 条目同步 | 单源真值（索引条目即同步实体）；UI 直接读，无需第二存储 |
| D4 | 升版触发 | ① 引擎重新下发**同 id 不同内容**（`recordArtifact` 改判为升版）；② 用户显式编辑（`recordArtifactVersion`）；③ 回退（`rollbackToVersion`） | 覆盖「助手重生成 / 人改 / 回退」三种同源演进 |
| D5 | 同内容重放 | 不升版；仅标题变化则同步更新标题 | 事件流重放同内容不应污染版本链 |
| D6 | 入池约束 | image / video 正文为空、不进 `bodies` → 回退对其无正文可恢复（直接跳过） | 图片靠 `url` 渲染，内容池本就不承载它 |
| D7 | LWW 与版本 | 版本元数据**不参与** LWW 胜负（只看 `rev` / `updatedAt`） | 冲突时赢家整条 `versions` 覆盖输家（见已知偏差 #1） |

## 2. 数据模型

`ArtifactIndexEntry`（见 `src/types/artifact.ts`）新增：

```ts
version: number;              // 当前版本号（1 起）
previousVersion?: string;     // 上一版 contentHash
versions?: ArtifactVersionMeta[]; // 完整历史（contentHash → bodies）
```

```ts
interface ArtifactVersionMeta {
  version: number;
  contentHash: string;        // 指向 bodies 里的正文正本
  createdAt: string;
  title?: string;
}
```

`buildIndexEntry`（FR-7.2）默认 `version: 1` 并种入 `versions[0]`。

## 3. 升版算法（`bumpVersion`，`src/stores/artifactsStore.ts`）

```
newHash = contentHash(artifact)
if newHash === existing.contentHash: return        // 无变化
bodies[newHash] = artifact.content                 // 写新正文（空正文不入池）
newVersion = existing.version + 1
versions.push({ version:newVersion, contentHash:newHash, createdAt:now, title })
entry = { ...existing, contentHash:newHash, version:newVersion,
          previousVersion:existing.contentHash, versions, rev+1, updatedAt:now }
更新 bySession[sessionId] 里该 id 的引用（content 清空）
```

幂等：内容没变 → 直接返回（重放安全）。

## 4. 回退（`rollbackToVersion`）

```
content = bodies[targetHash]; if undefined: return   // 图片等无正文可恢复
bumpVersion(existing, { id, type, title, content, createdAt:now })
```

新开一版，旧正文仍在 `bodies` → 历史不丢，可再前进 / 再回退。

## 5. 同步（`src/sync/artifacts.ts`）

`artifactIndex` 条目已含 `version` / `previousVersion` / `versions`：`collect()` 整条上行，
`apply()` 落地时**携带**这三个字段（`buildIndexEntry` 初值与 `apply` 重建都处理）。
`artifactBodies` 内容池按 hash 去重，历史正文跨端只存一份。

## 6. UI（`src/components/artifacts/ArtifactPanel.tsx`）

预览弹窗加「版本历史」折叠区：
- 每行 `vN · 时间 · 标题`，标「当前」；
- **预览此版本**（切换主渲染器，目视对比）；
- **对比**（打开左右分屏：当前 vs 所选历史版本）；
- **回退到此版本**（调 `rollbackToVersion`，toast 提示）。

## 7. 判据（可证伪）

| # | 判据 |
|---|---|
| J-A1 | 同 id 内容变化 → `version` +1、`previousVersion` = 旧 hash、`versions` 长度 +1、两版正文都在 `bodies` |
| J-A2 | 同 id 同内容重放 → `version` 不变、标题同步 |
| J-A3 | `recordArtifactVersion` 新内容 → 升一版 |
| J-A4 | `rollbackToVersion` → 新开一版、正文回到旧 hash、`previousVersion` = 回退前 hash |
| J-A5 | `rollbackToVersion` 对 image（正文不在 `bodies`）→ 不回退、不崩 |
| J-A6 | 同步：远端 `apply` 带 `version` / `previousVersion` / `versions` → 落地保留 |
| J-A7 | UI：版本历史列出各版；回退后当前版正文等于所选历史版 |

## 8. 已知偏差

1. **`versions` LWW 整条替换**：冲突时赢家覆盖输家版本历史（P1 可接受）。
2. **image / video 不参与版本正文**：靠 `url` 渲染，回退无正文可恢复（D6）。
