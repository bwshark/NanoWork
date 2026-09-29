# 批次 6b：C 类文件型资产（同步 + 归档补录）

> **上游**：`docs/architecture-m6-sync.md` §2.2 欠账 #3、§2.3（FR-7.3 耦合行）、§七 批次表 6b 行；
> `docs/batch-6-data-sovereignty-spec.md`（批次 6a）§0「E 移出」与 §6 已知偏差 #2。
> **本批定位**：把 6a 划出的「C 类文件型资产」落地，并把 6a 欠下的「归档不含工作区记忆 /
> 提示词模板」补上。**产物内容寻址同步不在本批**（6a 裁决 F：等 FR-7.2）。

---

## 0. 依赖裁决：6b 不再等 FR-7.3

m6 §2.3 把 FR-7.3 与 C 类资产记为同一条技术线，理由是两者都写「内容寻址」。
本批开工前复核后判定：**这是同名不同物，不构成阻塞**。

| | FR-7.3 的 `file-history/<hash>.bak` | C 类资产的「按内容寻址传 hash」 |
|---|---|---|
| 目的 | **本机回滚备份**（写类工具执行前快照，供 `rollbackTo` 反查） | **跨端传输去重**（同内容不重复传） |
| 作用域 | 单设备，落 ② `<userData>/file-history/` | 跨设备，走 `sync_items` |
| 生命周期 | 随会话，可被 GC | 随账户，需与墓碑 GC 对齐 |

**D0-1（依赖解耦）**：6b **不引入 blob 存储、不传 hash 引用**，同步负载直接带正文。
真正的耦合点只剩「hash 契约」，本批把它定死（§5），FR-7.3 与产物同步将来**复用同一个函数**，
从而不会出现两套寻址。

**为什么可以直接传正文**：C 类资产是 KB 级文本（记忆 / 身份文件 / 提示词模板）。
为它建 blob 存储 + 引用计数 + GC，换来的去重收益近零，却要新增一张表和一个回收周期。

**D0-2（工作区记忆只进归档，不进同步）**：`<workdir>/.nanowork/memory/` **不参与跨端同步**。

1. **没有跨端身份**：工作区由**路径**标识，而路径每台机器不同（`D:\proj` vs `/home/u/proj`）。
   批次 5 已裁「`streamWorkdir` 是本机事实、拉来的事件流落接收方自己的分片」——同一条结论。
2. **它是用户项目目录里的文件**（可能已纳入版本控制）。跨端同步等于跨设备改写用户仓库，
   而这件事用户没有授权意图。

它**进归档**（§4）：归档是**本机备份**语义，导出/恢复到同一台机器的同一工作区，没有身份问题。

---

## 1. C 类资产清单与同步粒度

| 资产 | 落点 | 跨端身份 | 粒度 | collection |
|---|---|---|---|---|
| 用户级记忆 | ① `~/.nanowork/MEMORY.md`（`nanowork.userMemory`） | 账户单例 | **段落级 LWW**（§2） | `memoryUser` |
| 身份文件 | ① `~/.nanowork/{SOUL,IDENTITY,USER}.md` | `kind` | 文件级 LWW | `identityFiles` |
| 提示词覆盖 | ① `~/.nanowork/prompts/<kind>/<key>.md` | `PROMPT_SLOTS` 静态表 | 文件级 LWW | `promptOverrides` |
| 工作区记忆 | `<workdir>/.nanowork/memory/*` | ❌ 无 | — | ⛔ 不进同步，只进归档（D0-2） |
| 插件包 | — | — | — | ⛔ 不碰（`architecture-syncmeta.md` §八：无 storage key，是每次从权威重读的事实） |
| 产物 | — | — | — | ⛔ 划出（6a 裁决 F，等 FR-7.2 重做落点） |

**D1-1（枚举口径）**：提示词覆盖按 `PROMPT_SLOTS` **静态表**枚举，不扫目录。
`StorageAdapter` 没有 `keys()`（6a D3 的同一条限制），动态 key 无法枚举；而 `PROMPT_SLOTS`
覆盖了全部合法槽位——`storageRoutes` 虽能写任意 `kind.key`，但 UI 只认表内的槽位。

**D1-2（BOOTSTRAP 不进同步）**：`BOOTSTRAP.md` 是**出厂预置的一次性引导种子**，引导完成即删除。
同步它会让「A 机已完成引导、B 机新装」变成「B 被 A 的已删除状态影响 / 或反过来让 A 重新引导」——
两种方向都错。它由安装生成、由本机消费，不属跨端资产。

**D1-3（空串 = 回到默认，不删）**：提示词覆盖的「清空」语义是「用内置模板」（`promptLibrary`
的既有约定），故 C 类**一律无墓碑**——`tombstones` 恒为 `{}`，删除态用空串表达。

---

## 2. 段落级 LWW（用户级记忆）

PRD §19.3 写的是「按 `##` 分块比较 `modified_at`」。落到本仓的真实格式要做两处修正。

**D2-1（段落边界 = 空行分隔的块）**：记忆正文由 `MemoryService.append` 产出为 Markdown 引用块
（`> [ISO] 来自「…」` + 去重标记 + 正文），块间空行分隔；手写的则是 `## ` 标题段。
二者的共同边界是**空行**，且与既有 `parseEntryBodies` / `countEntries` 的口径一致。
按 `## ` 切会漏掉占绝大多数的引用块。

**D2-2（段键）**：优先取块内 `<!-- SUMMARY:<hash> -->` 的 hash（`append` 产出，同一正文跨设备同 hash）；
没有标记（手写块）时取 `hashContent(normalizeForDedup(body))`。

**D2-3（段时间戳）**：块首 `> [ISO]` 即 `modified_at`；无时间戳的块视为最旧（`''`）。

**D2-4（合并 = 段级 2P-Set + LWW）**：

```
allKeys = K(local块) ∪ K(remote块) ∪ K(local墓碑) ∪ K(remote墓碑)
for each key:
  取四者中 at 最大者；墓碑则丢弃该段，块则保留该块
  （平局：块优先于墓碑——「又写回来」胜过「删掉了」）
按 at 升序拼接，块间空行分隔
墓碑集合取并集，同键取 at 较大者
```

**为什么必须有段级墓碑**：记忆页的编辑是**整份覆盖**，`clear()` 是整份清空。若只做段并集，
「删掉一条」与「清空」在下次同步时会被对端的旧段**填回来**——那是**功能回归**（用户按了清空
却还能看到旧记忆）。段级墓碑让删除可传播。

**D2-5（墓碑从 diff 来）**：本机不记录历史，墓碑由 `diff(上次已知段全集, 当前段)` 得出。
镜像持久化「已知段全集」（段键集合，KB 级），每次 `hydrate()` 时重算——被移除的段进墓碑。

---

## 3. 落地形态：第三个适配器，不进 `syncRegistry`

**D3-1（走 `FileAssetsAdapter`，不注册进 `SyncRegistry`）**——与批次 5 对事件流的裁决同款：
`SyncCollectionSpec.read()` 是**同步**的，而 C 类资产的读取是**异步**的
（`platform.storage.get` / `platform.memoryFiles.read`）。硬套 registry 会得到一个撒谎的 `read()`。

```
interface FileAssetsAdapter {
  hydrate(): Promise<void>;                    // 读当前文本 → 推进 rev/updatedAt/段墓碑
  collect(): SyncChange[];                     // 上行负载
  apply(change: SyncChange): Promise<number>;  // 落地（段落级 / 文件级 LWW）
}
```

引擎**可选注入**（`SyncEngineOptions.fileAssets?`），与 `eventStream` 同例。三者互不注册，
故引擎 `applyChange` 对这些 collection 因「未登记」而自然跳过——`pulled` 计数不会重复。

**D3-2（内容即版本）**：C 类资产没有实体 CRUD 可供挂钩（`MemoryService` / `IdentityService` /
`PromptLibrary` 各自的写入路径有十余处）。因此不在写入处打点，而是在 `hydrate()` 时按
`hashContent(content)` 与持久化的 hash 比对：变了才 `rev += 1`、`updatedAt = now()`。
好处是**改哪条路径都不会漏**（新增写入入口不需要记得调 `markDirty`）。

**D3-3（元数据落点）**：`<userData>/file-assets-sync.json`（登记进 `RUNTIME_FILES`），
与 6a 的 `sync-conflicts.json` 同例——必须能被「清空数据」带走，否则清空后 `rev`/`updatedAt`
归零会让本机被远端静默覆盖。→ **本批会动 `electron/storageRoutes.ts` 与 `electron/main.ts`
的登记，必须重建 `main.cjs` / `preload.cjs`**。

**D3-4（引擎改动三处）**：`syncNow` 中 ① pull 之前 `await fileAssets.hydrate()`；
② push 时 `changes.push(...fileAssets.collect())`；③ pull 之后 `await applyPulledFileAssets(changes)`
（单独异步一步，`applyPull` 保持同步且对未登记 collection 返回 `false` 不计数）。

**D3-5（服务端零改动）**：`sync_items.collection` 是 `str`，push 只校验非空，无白名单。
新增三个 collection 名不需要动 `cloud/`。

---

## 4. 归档补录（6a §6 已知偏差 #2）

**D4-1（提示词模板进 `local` 段）**：把 `PROMPT_SLOTS` 展开成 `nanowork.prompt.<kind>.<key>`
各条并入 `ARCHIVE_LOCAL_KEYS`。静态表可枚举，成本极低。

**D4-2（工作区记忆进新顶层段）**：

```ts
workspaceMemory: { workdir: string | null; files: Record<string, string> } | null
```

导出**当前工作区**（`MemoryService.resolveWorkspaceDir()`；`null` 即产品目录兜底那份）。

**D4-3（导入落本机当前工作区）**：导入**忽略归档里的 `workdir`**，写进接收方自己的
`.nanowork/memory/`——与批次 5「拉来的事件流落接收方自己的分片」同一条结论。

**D4-4（`formatVersion` 1 → 2）**：新增顶层段是格式变更。按 J-C3（6a 判据）：
老客户端读到 `2` 必须**明确报错**而不是静默丢掉工作区记忆。

---

## 5. hash 契约（供 FR-7.3 / 产物同步复用）

本批**不预建 sha256 模块**——没有调用点的工具函数是死代码，而真正的契约是一句约定：

> **内容寻址（`file-history/<hash>.bak`、产物 blob）一律用 `sha256:<hex>`（UTF-8 输入）**。
> FR-7.3 落地时在 `src/lib/contentHash.ts` 新建它，产物同步将来同理 → 不会出现两套寻址。
> 它与本批用到的 `hashContent`（djb2）**分工明确、不要混用**：djb2 只用于**段键与变更检测**
> （短、快、且与既有 `<!-- SUMMARY:<hash> -->` 去重标记逐字节对齐）；sha256 用于**跨端寻址**
> （抗碰撞、需要在两台机器上独立算出同一个值）。

---

## 6. 判据（可证伪）

| # | 判据 | 用例 |
|---|---|---|
| J-1 | 段落级 LWW：两端各自 append，合并后**两段都在**（并集，不丢） | `tests/lib/memoryMerge.test.ts` |
| J-2 | 同段键冲突：`at` 大者胜；`at` 相同则保留块（块优先于墓碑） | 同上 |
| J-3 | 删除可传播：A 删某段 → B 合并后该段**不回来**；A 清空 → B 变空 | 同上 |
| J-4 | 段键稳定性：同内容跨端同键（引用块走 `SUMMARY:` hash，手写块走归一化 hash） | 同上 |
| J-5 | 内容即版本：`hydrate()` 后内容变 → `rev+1` / `updatedAt` 更新；内容不变 → **不动** | `tests/sync/fileAssets.test.ts` |
| J-6 | 身份文件文件级 LWW，`BOOTSTRAP` **不进** `collect()` | 同上 |
| J-7 | 提示词覆盖按 `PROMPT_SLOTS` 枚举，空串（回到默认）能同步 | 同上 |
| J-8 | 引擎接线：注入适配器后 push 负载含 C 类三条；pull 落地后本机文本 = 合并结果 | `tests/sync/SyncEngine.batch6b.test.ts` |
| J-9 | 归档含提示词模板 + 工作区记忆；`formatVersion === 2` | `tests/lib/accountArchive.test.ts` |
| J-10 | 导入：归档的工作区记忆落**本机当前工作区**，不建归档里那个目录 | 同上 |
| J-11 | J-C3 回归：老客户端（`formatVersion` 上限 1）拒读 v2 归档 | 同上 |

---

## 7. 已知偏差（写下来防止下一轮又讨论）

| # | 偏差 | 为什么接受 |
|---|---|---|
| 1 | **段级墓碑不 GC**：墓碑集合随删除次数增长 | 段键是短 hash，几百条也是 KB 级。真要 GC 得等跨设备水位（与 6a 的墓碑 GC 同源），本期不做 |
| 2 | **工作区记忆不跨端**（D0-2） | 无跨端身份 + 属用户项目目录。它进归档，本机备份语义完整 |
| 3 | **同步负载带全文**，不做内容寻址去重 | D0-1：KB 级文本，blob 存储 + GC 的成本远大于收益 |
| 4 | **`PROMPT_SLOTS` 表外的提示词 key 不同步** | `StorageAdapter` 无 `keys()`，动态 key 不可枚举；UI 只认表内槽位 |
| 5 | **并发删除同一段**：两端同 `at` 时块优先（可能「删了又回来」） | 与既有 LWW 三级 tie-break 同款取舍；块优先比墓碑优先更安全（多一条好过丢一条） |
