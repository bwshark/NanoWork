# 批次 6a 落地规格：数据主权 + 墓碑 GC + `conflict` 快照持久化

> **范围勘误横幅（2026-09-28，开工前裁决）**
>
> m6 §七 把「批次 6」写成 4 项，实际体量约等于前三批之和，且**其中一项文档自己建议划出**。
> 本批按下列拆分执行（用户 2026-09-28 裁决）：
>
> | 文档里的项 | 本批处置 |
> |---|---|
> | A 数据主权（导出全部数据 / 彻底删除账户，FR-10.6） | **本批做** |
> | B 墓碑 GC 30 天（服务端清理） | **本批做**（并顺带完成批次 5 遗留的「已删会话事件级联清理」） |
> | C `conflict` 被覆盖方快照持久化（§六 #13，批次 4 唯一打折项） | **本批做** |
> | D 删账户 → 清服务端全部同步数据（含 `sync_events`） | **本批做** |
> | E **C 类文件型资产**（记忆段落级 LWW / 身份文件 / 提示词覆盖） | ⏭ **移出，另开批次 6b**——它的形状取决于尚未开工的 FR-7.3（M4/P0），现在做会白做 |
> | F **产物（`artifacts`）内容寻址同步** | ⛔ **划出本期**——依赖尚未开工的 FR-7.2（M4/P0），落点 ②`artifacts.json` 会随它重做（m6 §2.3 二选一，本批取「划出」） |
>
> 因此本批称 **批次 6a**。m6 §七 的批次 6 行在回填时拆成 6a（✅）与 6b（待开工）+ 一句划出声明。

---

## 〇、本批要解决的三个问题（用一句话说清）

1. **用户拿不走自己的数据，也删不掉自己的账户** —— `AccountSection` 里那两项是 `disabled` 占位
   （`src/components/settings/sections/AccountSection.tsx:156-189`），服务端也没有对应端点。
2. **服务端只增不减** —— 墓碑行永远留在 `sync_items`，已删会话的 `sync_events` 永不清理。
   §5.4 定了「30 天后由服务端 GC」，但代码里**没有 GC**（客户端的 30 天上行窗已落，见 §2.4）。
3. **`conflict` 的被覆盖方数据只活在内存里** —— `SyncEngine` 的 `conflicts` 数组上限 50，进程一退就没了
   （§六 #13 明记为「唯一打折项」）。

---

## 一、决策摘要表

| # | 问题 | 裁决 | 一句话理由 |
|---|---|---|---|
| D1 | 导出由谁组装？ | **客户端组装**：本地持久化快照 + 会话（meta + 事件流）+ **云端副本**（`GET /api/account/export`） | 「你在 nanoWork 中的全部数据」主要在本机；云端只是交集。只导云端会漏掉从未同步过的本地数据 |
| D2 | 云端导出用**新端点**还是复用 `pull?since=0`？ | **新端点** `GET /api/account/export` | `pull(0)` 形状会随同步协议演进；导出是**用户可见契约**（要 `formatVersion`），且需要带账户元信息（`email` / `createdAt`），`pull` 两者都没有 |
| D3 | 导出**包含哪些**本地数据？ | 结构化 store 持久化（`STORAGE_KEYS` 全表）+ 身份文件 ×4 + 用户级 `MEMORY.md` + 会话（meta + 事件流） | 这些是**可枚举**的（静态 key 表 + 索引）。`StorageAdapter` **没有 `keys()`**，动态 key 无法枚举 |
| D4 | 导出**不含**什么？ | ① 工作区记忆（`<workdir>/.nanowork/memory/`）② 提示词模板（`nanowork.prompt.<kind>.<key>`）③ 渠道密钥（保险库）④ 同步运行时态 | ①② 都是**动态 key / 目录**，需要枚举能力与文件级寻址——与 C 类资产同线，**随 6b 一并纳入**；③ 保险库纪律是「值不回传渲染层」，导出是渲染层动作，拿不到；④ 是本机运行态，不是用户数据 |
| D5 | 导出是否包含凭据（`settings.providers.*.apiKey` 等）？ | **包含**，并在 UI 上明示「归档含 API 密钥，请妥善保管」 | 数据主权的语义是「把我的数据还给我」；文件写在本机/用户自己选的位置，不是上行。**排除**会制造「导出不完整且无提示」的静默缺口 |
| D6 | 导出落到哪？ | `platform.writeTextFile(<文件名>, content)` | Electron 解析相对路径到 `~/.nanowork/`、Web 降级为浏览器下载。**已有平台能力，无需新增、无需动 `electron/`** |
| D7 | 「可重新导入」怎么做？ | 归档是**自描述且无损**的：`buildArchive()` → `parseArchive()` → `applyArchive(archive, writer)` 往返一致，**有用例**。**导入 UI 已补齐**（新增 `platform.pickFile` + 「导入归档」按钮） | ~~原判据：不提供导入 UI~~ **已闭合**：新增平台能力 `platform.pickFile(): Promise<{ name, content } \| null>`（Web 走 `<input type=file>` + `file.text()`、Electron 走 `dialog.showOpenDialog` openFile + `readFileSync` 读 UTF-8）。`AccountSection` 的「导入归档」调 `pickFile` → `parseArchive` → `applyArchive(arch, (k,v) => platform.storage.set(k,v))`，**只写回 `local` 段**，未登录亦可导入。用例见 `tests/components/accountImport.test.tsx`（J-D7-1~4） |
| D8 | 「彻底删除账户」删什么？ | **服务端**：`sync_items` + `sync_events` + `refresh_tokens` + `users` 行全删（不可恢复）。**客户端**：登出 + 清全部同步运行时态（token / pull 游标 / 事件水位 / conflict 快照）。**本机业务数据保留** | 删云端账户 ≠ 删本机文件（local-first）。本机数据的清除已有独立动作（`storage:clear`），UI 提示里写明。把两件事混成一个按钮，等于给「误删本机全部会话」开了一条一次性入口 |
| D9 | 墓碑 GC 判据用哪个时间？ | **`row.deleted_at`**（= 删除方写入的 `deletedAt`），**不是** `updated_at` | §六 #10 已论证：`updated_at` 是**服务端接收时间**且每次重收都重置 → 按它 GC 则永远 GC 不掉。用 `deleted_at` 才与**客户端的 30 天上行窗同源同钟**（两边在同一个时刻边界切换） |
| D10 | 服务端怎么触发 GC？ | **`push` 入口顺路 GC**（本账户、幂等），**不新增端点** | 无调度器可用；新增 `POST /api/sync/gc` 等于多一条写路径 + 多一次往返。push 已在写库路径上，顺路清理零额外协议 |
| D11 | 已删会话的 `sync_events` 怎么办？（批次 5 遗留 #7） | **GC 时级联**：超期的 `sessionMeta` 墓碑行 → 一并删 `sync_events where session_id = <该墓碑 id>` | 会话删除在协议里就是「推一个 `sessionMeta` 墓碑」，服务端不知道别的信号。级联挂在 GC 上零协议改动。**未超期的已删会话，其服务端事件最多残留 30 天**——对端拉到也会被「未知/已墓碑会话跳过」挡掉（批次 5 已落），无害 |
| D12 | `conflict` 快照落在哪？ | **登记** `electron/storageRoutes.ts` 的 `RUNTIME_FILES`：`nanowork.sync.conflict` → `<userData>/sync-conflicts.json`（json、紧凑） | §六 #13 明确要求登记。落 ② 的另一个好处：它会进 `knownRouteFiles()` → `storage:clear`（「清空数据」）能带走它，而 `misc/` 兜底的文件带不走——过期的冲突快照正是「清空数据」该清的东西。**代价：本批动 `electron/` → 必须重建 `main.cjs`/`preload.cjs`** |
| D13 | 快照的值形状？ | `Record<userId, PushConflict[]>`，**按账户分片**，每账户上限沿用 `MAX_CONFLICT_SNAPSHOTS`（50） | 直接套用批次 5 的教训：runtime 全应用**复用同一个 `SyncEngine` 实例**，值不带账户维度就会「A 登出、B 登录后看到 A 的冲突」。**不要**再犯一次 |
| D14 | 快照什么时候读写？ | 写：`rememberConflict()` 后**读-改-写**（只替换本账户分片）。读：`ensureAccountState()` 里按需载入当前账户分片。清：`resetAccountScopedState()` **只清内存、不删盘上分片** | 与事件水位（批次 5）同一套生命周期，切回原账户可恢复。`ensureAccountState()` 已经存在（批次 5 的账户态收口点），直接挂上去 |

---

## 二、逐条裁决详述 + 可证伪判据

> 判据一律写「**哪个文件、哪个用例**会红」。**不许写「哪个场景会红」**——批次 4 的规格正是这么写错了两处，
> 被 QA 抓出来（`docs/batch-4-entity-wiring-spec.md` 的两处口径修正、skill §7.20）。

### 2.1 服务端：账户导出 `GET /api/account/export`

**形状**（`cloud/app/account/routes.py`）：

```jsonc
{
  "format": "nanowork-cloud-export",
  "formatVersion": 1,
  "exportedAt": "2026-09-28T12:00:00Z",
  "user": { "id": "...", "email": "...", "createdAt": "..." },
  "items":  [ { "collection": "agents", "entity": { ... } } ],   // 全部 sync_items
  "events": [ { "id": "...", "sessionId": "...", "seq": 1, ... } ] // 全部 sync_events
}
```

- 走 `current_user` 依赖（Bearer）。**只返回本账户**（`user_id` 过滤）。
- 排序：`items` 按 `(collection, entity_id)`、`events` 按 `(session_id, seq, id)` —— **确定性输出**，
  否则「同一份数据导两次得到不同文件」会让往来比对变得不可用。
- **不带凭据**是天然的：服务端本来就只存客户端推上来的负载，而 `pickSyncable` / `toChannelSyncPayload`
  已在**上行侧**剔掉了凭据（§5.2，云端负载那条路）。

**判据 J-A1**：`cloud/tests/test_account.py::test_export_returns_all_items_and_events`
—— 推 2 个实体 + 2 条事件 → `export` 的 `items`/`events` 条数与内容齐全，且含 `user.email`。

**判据 J-A2**：`cloud/tests/test_account.py::test_export_is_scoped_to_current_user`
—— A 推数据、B 推数据 → A 的 `export` **只有 A 的**（B 的一条都不在）。

**判据 J-A3**：`cloud/tests/test_account.py::test_export_is_deterministic`
—— 连导两次（中间无写入）→ 两次响应体**逐字节相同**（`items`/`events` 排序确定）。
> ⚠️ 这条**专门**用来防「排序不确定」：不加 `ORDER BY` 时 SQLite 往往凑巧返回插入序，
> 于是「先删一条再补一条」的数据会出现两种导出顺序，而**平时看起来一切正常**。

### 2.2 服务端：彻底删除账户 `DELETE /api/account`

- 在一个事务里删：`sync_items`(本账户全部) → `sync_events`(本账户全部) → `refresh_tokens`(本账户全部) → `users`(本行)。
- 返回 `204`。**幂等**：重复调用第二次返回 `401`（用户已不存在）——这是可接受的，见判据。
- **不**触碰其他用户的任何行。

**判据 J-A4**：`cloud/tests/test_account.py::test_delete_account_wipes_everything`
—— 建账户 → 推实体 + 事件 → `DELETE /api/account` 204 → ① 原 access token 再调 `/api/auth/me` 得 **401**；
② 重新注册同邮箱**成功**（`users` 行确实没了，不是仅置灰）；③ 新账户 `export` 为空。
> 判据 ② 是关键：它把「只删数据行、`users` 行还在」这种半吊子实现**逼红**（那样重注册会 409）。

### 2.3 服务端：墓碑 GC（`push` 入口顺路）

新增 `cloud/app/sync/retention.py`（**纯函数**，不碰 IO，便于单测）：

```python
TOMBSTONE_TTL_DAYS = 30

def expired_tombstone_ids(rows, *, now, ttl_days=TOMBSTONE_TTL_DAYS) -> list[str]: ...
```

`routes.py::push` 在**实体循环之前**调用 `_gc_tombstones(session, user.id, utc_now())`：

1. 取本账户 `deleted_at is not null` 的 `SyncItem` 行；
2. `deleted_at <= now - 30d` 的 → 删行；
3. 其中 `collection == 'sessionMeta'` 的 `entity_id`（= `sessionId`）→ 删对应 `sync_events`。

**为什么可以删（而不是留着压 payload）**：墓碑的作用是「让别的设备学到删除」。30 天窗口的作用是
「近似所有设备都学到了」。删除之后，一个**已经应用过该墓碑**的设备再 push 自己的墓碑会被当成新建行写回
（无害，`deleted_at` 不变，下轮再 GC）；一个**从未见过该墓碑**的设备不会因此复活条目（它本地也没有存活副本）。

**已知限制（写进文档，不掩盖）**：设备离线**超过 30 天**、且持有该条目的**存活**副本时，它上线 push 会
因为「服务端已无该行可比对」而**复活**该条目。彻底解决需要 per-device 水位或永久墓碑，**留后续批次**
（m6 §5.4 的原话就是「服务端只能按时间近似」）。

**判据 J-B1**：`cloud/tests/test_sync_gc.py::test_expired_tombstone_is_collected`
—— 直接写一行 `deleted_at = now - 31d` 的墓碑 → push（任意）→ 该行从 `sync_items` 消失。

**判据 J-B2**：`cloud/tests/test_sync_gc.py::test_fresh_tombstone_survives`
—— `deleted_at = now - 29d` → push → 行**仍在**，且 `pull` 仍能取回它。
> J-B1/J-B2 成对：只有 B1 会把「TTL 写成 0 天」判成通过。

**判据 J-B3**：`cloud/tests/test_sync_gc.py::test_gc_cascades_session_events`
—— 写超期的 `collection='sessionMeta'` 墓碑 + 该 `sessionId` 的 2 条事件 + 另一个会话的 1 条事件 → push →
**该会话的 2 条事件没了、另一个会话的 1 条还在**。

**判据 J-B4**：`cloud/tests/test_sync_gc.py::test_gc_does_not_touch_other_users`
—— A 有超期墓碑、B 有超期墓碑 → A push → **只有 A 的行被删**。

**判据 J-B5**：`cloud/tests/test_sync_gc.py::test_pull_after_gc_does_not_resurrect`
—— 客户端视角的正面判据：A 删条目（推墓碑）→ B `pull` → B 落地 → 时间推进 > 30 天 → A push 触发 GC →
B 再 `pull` → **B 侧该条目仍是删除态**（`deletedAt` 非空），且 B 再 push 自己的墓碑不会让它变回存活。
> 这条直接对应 m6 §七 的完成判据「GC 后 pull 不复活已删条目」。

### 2.4 客户端：归档（`src/lib/sync/accountArchive.ts`）

**纯函数 + IO 注入**（与 `syncMeta.ts` / `channelSecrets.ts` 同一条纪律：纯逻辑不碰 IO，因而可真单测）。

```ts
export const ARCHIVE_FORMAT = 'nanowork-archive';
export const ARCHIVE_FORMAT_VERSION = 1;

export interface ArchiveSources { /* 由调用方注入的只读快照 */ }

export function buildArchive(src: ArchiveSources, meta: ArchiveMeta): NanoworkArchive;
export function parseArchive(text: string): NanoworkArchive;   // 非法输入抛 ArchiveParseError
export function applyArchive(arch: NanoworkArchive, write: ArchiveWriter): Promise<ApplyReport>;
export function archiveFileName(now: Date): string;            // nanowork-export-YYYYMMDD-HHmmss.json
```

- `applyArchive` 的 `write` 是注入的 `(key, value) => Promise<void>`，所以往返用例**不需要真存储**。
- 归档里的 `local` 段逐 key 存**原始字符串**（`platform.storage.get<string>(key)` 拿到的就是它），
  **不再解析**——解析再序列化会改变字节，往返就不再无损。

**判据 J-C1**：`tests/lib/sync/accountArchive.test.ts`「往返无损」
—— 给一组假 key/value（含一段带换行与 CJK 的文本、一段 JSON 文本）→ `buildArchive` → `JSON.stringify` →
`parseArchive` → `applyArchive` 到内存 writer → **每个 key 的字符串与原始逐字节相同**。

**判据 J-C2**：`tests/lib/sync/accountArchive.test.ts`「非法输入被拒」
—— `parseArchive('{}')` / `parseArchive('not json')` / `parseArchive` 一个 `format` 不对的对象
→ 抛 `ArchiveParseError`（**不返回半个归档**，否则导入会写坏一半存储）。

**判据 J-C3**：`tests/lib/sync/accountArchive.test.ts`「formatVersion 高于本端时拒绝」
—— 若 6b 之后加了字段，老客户端导入新归档必须**明确报错**而不是静默丢字段。

**判据 J-C4**：`tests/lib/sync/accountArchive.test.ts`「云端段可缺省」
—— 未登录导出的归档 `cloud: null`，`parseArchive` 仍然通过（离线也必须能导出）。

### 2.5 客户端：删账户

`SyncAccount` 接口新增 `deleteAccount(): Promise<void>`（`src/sync/syncAccount.ts`）：

1. 调 `DELETE /api/account`（带 Bearer；401/403 视为失败并抛出 `SyncAuthError`）；
2. 成功后走**与 `logout()` 相同**的收口：清本地会话（`clearSession` + 通知订阅者）。
3. `SyncEngine.resetAccountScopedState()` 由 `runtime.onSession` 的 `null` 分支触发（**已有路径**，不新增）。

**判据 J-D1**：`tests/sync/syncAccount.test.ts` 新增用例「删除账户后本地会话被清空且订阅者收到 null」
—— 假 fetch 返回 204 → `account.getSession() === null`、订阅回调收到 `null`，且请求方法与路径是
`DELETE /api/account` 且带 `Authorization`。
> 判据必须断言**方法与路径**：只断言「发了一次请求」的话，把方法写成 `POST` 也照样绿。

**判据 J-D2**：`tests/sync/syncAccount.test.ts`「服务端失败时不清本地会话」
—— 假 fetch 返回 500 → 抛错、`getSession()` **仍有值**。否则会出现「云端还在、本机以为删了」的最坏状态。

### 2.6 客户端：`conflict` 快照持久化

- `src/sync/types.ts`：新增 `CONFLICT_SNAPSHOT_STORAGE_KEY = 'nanowork.sync.conflict'`（值 = 字符串 JSON）。
- `src/sync/SyncEngine.ts`：
  - `rememberConflict()` 之后 → 更新本账户分片并**读-改-写**落盘；
  - `ensureAccountState()` → 首次进入某账户时载入该账户分片（内存上限沿用 `MAX_CONFLICT_SNAPSHOTS`）；
  - `resetAccountScopedState()` → **清内存、不删盘**（切回可恢复）；
  - 全仓**不得** `remove` 该 key（除测试）。
- `electron/storageRoutes.ts`：`RUNTIME_FILES[CONFLICT_SNAPSHOT_STORAGE_KEY] = { rel: 'sync-conflicts.json', format: 'json' }`

**判据 J-E1**：`tests/sync/conflictSnapshot.test.ts`「重启后仍有冲突快照」
—— 造一次冲突（服务端返回 `conflicts`）→ `engine.getConflicts().length === 1` →
**新建一个 `SyncEngine` 实例、同一个 storage 后端** → `getConflicts().length === 1`。

**判据 J-E2**：`tests/sync/conflictSnapshot.test.ts`「快照按账户隔离」
—— 账户 A 造冲突 → 切到 B（B 也有自己的冲突）→ B 的 `getConflicts()` **只有 B 的**；
切回 A → **A 的快照仍在**。
> 这条是批次 5 的教训复现：值形状一旦不带 `userId`，本用例必红。

**判据 J-E3**：`tests/sync/conflictSnapshot.test.ts`「上限仍然生效」
—— 造 60 次冲突 → `getConflicts().length === MAX_CONFLICT_SNAPSHOTS`（50），且落盘的那份也是 50。

### 2.7 客户端：UI（`AccountSection.tsx`）

- 「导出全部数据」：点击 → 组装归档 → `platform.writeTextFile(文件名, JSON.stringify(arch, null, 2))` →
  toast 成功（带落点提示：Electron 提示 `~/.nanowork/`，Web 提示「已下载」）+ **一句凭据提醒**。
  未登录时仍可点（只导本地段），UI 上写明「未登录：仅导出本机数据」。
- 「彻底删除账户」：点击 → **二次确认对话框**（要求输入邮箱或点「确认删除」）→ 调 `deleteAccount()` → toast。
  未登录时该行**禁用**并说明「未登录无需删除云端账户」。

**判据 J-F1**：`tests/pages/auth.test.tsx` 更新「登录后两项均可点」
—— 登录态下两个按钮 `disabled === false`（**取代**批次 4 的「占位且 disabled」断言）。

**判据 J-F2**：`tests/pages/auth.test.tsx`「未登录：导出可点、删账户禁用」
—— 未登录下「导出全部数据」可点、「彻底删除账户」`disabled === true`。
> J-F1/J-F2 成对：只留一条的话，「两个按钮恒定可点」或「恒定禁用」都能蒙混过关。

**判据 J-F3**：`tests/pages/auth.test.tsx`「删账户必须经过二次确认」
—— 点「彻底删除账户」→ **断言 `deleteAccount` 尚未被调用**、确认对话框出现；点确认后才被调用一次。
> 这条防的是「确认框只是装饰」：把 `onClick` 直接接上 `deleteAccount` 会让它红。

---

## 三、文件清单

**服务端（新增 4）**
- `cloud/app/account/__init__.py`
- `cloud/app/account/routes.py`
- `cloud/app/sync/retention.py`
- `cloud/tests/test_account.py`、`cloud/tests/test_sync_gc.py`

**服务端（修改 2）**
- `cloud/app/main.py`（挂 `account` router）
- `cloud/app/sync/routes.py`（`push` 入口顺路 GC）

**客户端（新增 1）**
- `src/lib/sync/accountArchive.ts`

**客户端（修改 6）**
- `src/sync/types.ts`（`CONFLICT_SNAPSHOT_STORAGE_KEY`、云端导出/删除的类型）
- `src/sync/SyncClient.ts`（`exportAccount()` / `deleteAccount()`）
- `src/sync/syncAccount.ts`（`deleteAccount()`）
- `src/sync/SyncEngine.ts`（快照持久化 + 账户分片）
- `src/components/settings/sections/AccountSection.tsx`（接线 + 二次确认）
- `electron/storageRoutes.ts`（登记 `nanowork.sync.conflict`）

**测试（新增 3、修改 1）**
- `tests/lib/sync/accountArchive.test.ts`（新）
- `tests/sync/conflictSnapshot.test.ts`（新）
- `tests/sync/syncAccount.test.ts`（改：J-D1/J-D2）
- `tests/pages/auth.test.tsx`（改：J-F1~F3，替换批次 4 的 disabled 占位断言）

**文档（新增 1、修改 2）**
- `docs/batch-6-data-sovereignty-spec.md`（本文件）
- `docs/architecture-m6-sync.md`、`docs/README.md`

---

## 四、依赖图 / 实现顺序

```
T01 服务端（account/routes + retention + push GC + main 挂载 + 两个测试）   ← 无依赖
T02 客户端契约与归档（types + SyncClient + accountArchive + 归档测试）      ← 无依赖（与 T01 并行）
T03 引擎快照持久化（SyncEngine + storageRoutes + conflictSnapshot 测试）    ← 无依赖（与 T01/T02 并行）
T04 账户流程与 UI（syncAccount.deleteAccount + AccountSection + auth 测试） ← 依赖 T02
T05 门禁与产物重建（三套 tsc + 全量 vitest + vite build + ruff/pytest + 重建 main.cjs/preload.cjs） ← 依赖 T01–T04
T06 文档回填（m6 / README / 记忆 / skill）                                  ← 依赖 T05
```

**并行约束**：`T01` 只碰 `cloud/**`、`T03` 只碰 `src/sync/SyncEngine.ts` + `electron/storageRoutes.ts`，
`T02`/`T04` 碰 `src/lib`、`src/sync/{types,SyncClient,syncAccount}.ts`、`src/components`、`tests/**`。
**`T02` 与 `T04` 共用 `src/sync/types.ts`，必须先 T02 后 T04（串行）。**

---

## 五、共享知识（跨文件约定）

1. **字符串 JSON**：所有落 `platform.storage` 的同步运行时值（account / eventCursor / conflict）一律
   `JSON.stringify` 后 `set`、`get<string>` 后 `JSON.parse`。直接存对象会在 Electron 桥变成 `[object Object]`。
2. **账户分片**：任何跨账户共享的运行时键，值形状一律 `Record<userId, T>`，写盘用**读-改-写**（只替换本分片）。
   单账户（未登录）归一到 `''`。
3. **单引号**：`src/lib`、`src/sync`、`src/stores`、`tests`、`electron` 一律单引号；`cloud/` 走 `ruff format`。
4. **禁 import**：`src/sync/**` 不得 import `electron`、不得 import React（`useSyncStatus.ts` 是既有的唯一例外）；
   `SyncEngine.ts` 不得 import 任何 store。
5. **`cloud/` 时间**：一律 `app/timeutil.py` 的 `utc_now()` / `iso_z()` / `coerce_utc()`（aware UTC）。
   **不用** `datetime.utcnow()`（sqlmodel 0.0.47 强制带时区）。
6. **不改** `src/sync/syncRegistry.ts`、`src/events/**`、`nanobot/`；**无新增第三方依赖**；
   **模型禁止任何 git 写操作**。

---

## 六、待明确事项 / 已知偏差（写给用户与下一批）

| # | 事项 | 本批处置 |
|---|---|---|
| 1 | ~~**导入 UI 不做**（D7）~~ **✅ 已闭合（2026-09-29）** | 已新增 `platform.pickFile` 并接线 `AccountSection`「导入归档」按钮（Web `<input type=file>` / Electron `dialog.showOpenDialog`），用例 `tests/components/accountImport.test.tsx` 4 例全绿。导入只写 `local` 段，未登录亦可点 |
| 2 | ~~**工作区记忆 / 提示词模板不进导出、不进同步**（D4）~~ **✅ 已闭合（2026-09-29 批次 6b）** | 提示词模板并入 `ARCHIVE_LOCAL_KEYS`（按 `PROMPT_SLOTS` 静态表展开）；工作区记忆进新的 `workspaceMemory` 段（`formatVersion` 升 **2**），导入写**本机当前工作区**（忽略归档里的 `workdir`）。**同步侧**：提示词覆盖已同步（`promptOverrides`），工作区记忆**只进归档不进同步**（D0-2：无跨端身份 + 属用户项目目录）。落地规格 `docs/batch-6b-file-assets-spec.md` |
| 3 | **渠道密钥不进导出** | 保险库纪律（值不回传渲染层）。「导出保险库」是独立议题，归 6b 或更后 |
| 4 | **离线 > 30 天的存活副本可能复活已删条目**（§2.3 已知限制） | 接受（m6 §5.4 原设计即「30 天近似」）。彻底解决需 per-device 水位，留后续 |
| 5 | **未超期已删会话的云端事件残留 ≤ 30 天** | 接受：对端拉到会被「未知/已墓碑会话跳过」挡掉（批次 5 已落） |
| 6 | **删账户不删本机业务数据**（D8） | UI 明示；本机清除走既有的「清空数据」 |
| 7 | **`conflict` 快照只落盘、无 UI 展示** | §六 #13 只要求「不丢弃、可追查」；展示界面不在本期（「MVP 只做徽章 + toast」的既有裁决） |

---

## 七、门禁（沿用 `nanowork-dev-gate`）

- 客户端：`npm run typecheck` / `typecheck:electron` / `typecheck:tests`（**第三套不在 `build` 内**）
  → `vitest run --maxWorkers=3`（**不与 dev server 并发**）→ `vite build --emptyOutDir false`。
- 服务端：`cd cloud && .venv/Scripts/python.exe -m ruff check . && ... -m ruff format --check . && ... -m pytest -q`。
- **本批动了 `electron/`（D12）→ 必须重建**：
  ```bash
  "$NODE" node_modules/esbuild/bin/esbuild electron/main.ts --bundle --platform=node --format=cjs --external:electron --outfile=electron/main.cjs --log-level=warning
  "$NODE" node_modules/esbuild/bin/esbuild electron/preload.ts --bundle --platform=node --format=cjs --external:electron --outfile=electron/preload.cjs --log-level=warning
  ```
  新鲜度判据：`electron/` 下**没有任何 `.ts` 比 `main.cjs` 新**——用 `-nt` **逐个**比对（esbuild 是 `--bundle`，
  被 import 的模块全打进产物，只看 `main.ts` 会漏）。
