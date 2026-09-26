# M6 跨端同步 · 落点清单（V1.5 开工前置）

> 这份清单与 `architecture-syncmeta.md` 是**上下半场**的关系：
> - `architecture-syncmeta.md` = **Phase 0**：V1 必须先落的 `SyncMeta`（**已全部完成，2026-09-25**）；
> - **本文** = **Phase 1+**：M6 本体（云端认证 + 双向同步引擎）的落地拆解。
>
> 设计权威仍是 **`cross-platform-sync-design.md`**（6 条开放问题已全部定案，PRD v2 §19.1 直接采纳）。
> 本文**不重复论证设计**，只回答四个落地问题：**哪些已经就绪 / 哪些必须先补 / 代码落在哪 / 分几批做**。
>
> ⚠️ **但不要把那份设计文档整篇照抄进代码**：其 §4.3 / §12 / §13 / §14 的「本地 SQLite + `sync_changelog`」
> 与 `nanowork-cloud/` 目录名，已被 **ADR-022** 与本文 **§5.1** 推翻。该文档**已在文首加「⚠️ 勘误」横幅**
> （2026-09-26，登记在 `docs/README.md` §九 看板 #17），**先看 §5.1 再看那两节**。

---

## 一、M6 的验收门禁与交付物

来自 PRD v2 第 6 章里程碑表：

| 项 | 内容 |
|---|---|
| **交付物** | FastAPI 认证 + Sync API + `SyncMeta` **全量接入** |
| **验收门禁** | ① 两端登录同账户后 Agent / 会话**双向一致**；② 离线编辑联网合并**无丢失** |
| **覆盖需求** | FR-10.1 同步元数据 / FR-10.2 云端账户 / FR-10.3 双向同步 / FR-10.4 离线优先 / FR-10.5 同步范围控制 / FR-10.6 数据主权 / FR-10.7 端到端加密（P2，可后置） |
| **跨阶段门禁**（PRD §6） | (a) `npm run build` 绿；(b) 新增能力有单测；(c) **新增平台能力必须有 Web 降级路径**；(d) 文档与 openspec 同步更新 |

> **M6 是「交付系统 ①（云核）」的唯一里程碑**（PRD v2 §6 对照表）。M1–M5 零新系统，M6 起新增一个
> 服务端——所以本文的「落点」**跨越两个仓库根**（客户端 `src/` + 服务端 `cloud/`）。

---

## 二、Phase 0 盘点：M6 可以直接吃什么，必须先补什么

### 2.1 已就绪（V1 已落，M6 零改动可用）

| 能力 | 落点 | M6 怎么用 |
|---|---|---|
| 8 个实体的同步元数据 | `Agent` / `ExpertGroup` / `TaskConfig` / `MCPConfig` / `ChannelConfig` / `SkillOverrideEntry` / `SessionMeta`(+索引条目) / `Settings` | 直接作为 LWW 的 `(id, rev, updatedAt)` 三要素来源 |
| 墓碑独立表 | `SyncTombstones`（`types/sync.ts`）+ `withTombstone` / `withoutTombstone` / `tombstoneEntries`（`lib/syncMeta.ts`） | push 负载 = **存活实体 + 墓碑表**，`tombstoneEntries()` 就是拼装器 |
| 存活过滤 | `liveEntities()`（`lib/syncSelect.ts`） | pull 落地后列表天然正确，UI 无需改动 |
| 云端负载裁剪 | `toChannelSyncPayload`（`lib/syncPayloads.ts`）、`toSyncPayload(settings)`（`lib/settingsSync.ts`）、`pickSyncable()` | ——这两个函数**当前无人调用**，M6 的 push 组装处就是它们的第一个调用方 |
| 设备标识 | `getDeviceId()` / `currentDeviceId()`（`lib/deviceId.ts`） | push 时补 `updatedBy`；服务端据此区分设备 |
| 老数据语义 | `INITIAL_REV = 1` / `LEGACY_REV = 0`（`lib/syncMeta.ts`） | 首次全量推送时识别「需补齐」的对象（`rev === 0`） |

### 2.2 必须先补（6 个洞：Phase 0 留下的 4 个 + CI 基线登记的 2 个）

> 前四条都**不是 M6 的新需求**，是 Phase 0 明确「归 V1.5」的欠账；后两条是 CI **已登记为基线例外**
> 的既有越界（`.github/workflows/ci.yml` 的两条检查）。六条都应在**接线之前**补完，否则会出现
> 「同步做完了，但某类数据同步过去是错的」——或者新代码原地重蹈旧越界。

| # | 欠账 | 为什么必须在 M6 补 | 详见 |
|---|---|---|---|
| 1 | **会话删除的墓碑** | `deleteSession` 至今是「JSONL + meta + 索引」**三件套全删**，删除**无法传播** → 另一台设备上会话**复活**。要动主进程 `removeSession` + 三个存储实现 + preload。 | syncmeta §7.3「明确未做」 |
| 2 | **渠道凭据保险库化 + 同步排除表** | 已定案「凭据不上行」，但 `channels.json` **目前是明文**。同步一开就必须切；且**排除表与保险库化同期落**（`toChannelSyncPayload` 已写好排除表，缺的是写入侧改道）。 | syncmeta §5.3 |
| 3 | **C 类文件型资产的同步设计** | 记忆（`MEMORY.md` / `<workdir>/.nanowork/memory/`）、身份文件（`SOUL.md`/`USER.md`）、提示词覆盖、插件包——它们的「版本」是文件 `mtime` / 段落时间，**塞不进实体元数据**，需要段落级 LWW 另案。 | PRD §19.3、syncmeta §二 C 类 |
| 4 | **产物（`artifacts`）内容寻址同步** | Phase 0 刻意不给它加实体元数据：产物按**内容寻址**（只传新增 hash），且它的落点（②`artifacts.json`）会随 FR-7.2 产物索引（M4）重做。 | syncmeta §八 |
| 5 | **平台边界收口**（渲染层 4 个文件直连 `window.electronAPI`） | `src/sync/` 的硬约束就是「**不得 `import 'electron'`**」（§3.2 不变量 4），而新增的 `src/pages/auth/` 还要存 token；不收口等于让新代码原地重蹈。CI 检查一已把这 4 个文件（`src/layout/AppLayout.tsx`、`src/components/TitleBar.tsx`、`src/pages/settings/SettingsPage.tsx`、`src/events/electronStore.ts`）登记为基线例外，**新增越界会被 CI 直接拦下**。 | `docs/README.md` §九 看板 #13 |
| 6 | **引擎 wire 字段泄漏收口** | `src/lib/channelScan.ts` / `src/types/channel.ts` 含 `session_id`，未收进 `src/ai/runtime/nanobotHttp/`（ADR-020）。而 `channels` 正是本批要接线同步的 collection 之一，顺手收口。 | `docs/README.md` §九 看板 #14 |

### 2.3 与 V1 余项的耦合（决定 M6 的交付边界）

> **M6 可以不等 V1 整体闭合**（M3 余 2 项、M4 全未开工、M5 部分，见 `OVERVIEW.md` §一），
> 但下面三条是**交叉耦合**——V1 那边动了，M6 这边就得跟着重做。开工前必须二选一：
> **先补它**，或**把对应能力从 M6 交付物里显式划出**（划出不是不管，是写明「不在本期验收范围」）。

| V1 未落项 | 耦合点 | 处置 |
|---|---|---|
| **FR-7.2 产物独立索引**（M4，P0） | 见 §2.2 欠账 #4：产物按内容寻址同步，而落点（②`artifacts.json`）会随 FR-7.2 重做 | 先做 FR-7.2，或把**产物同步**从 M6 划出 |
| **FR-3.8 版本隔离缓存**（M3，P1） | FR-3.9 要同步「会话版本引用集」，而引用集的前提是 `cache/<market>/<plugin>/<version>/` 已存在 | 先做 FR-3.8，或把**扩展态 / 版本引用同步**从 M6 划出（会话可同步字段白名单后补一项不痛） |
| **FR-7.3 文件回滚**（M4，P0） | 与 §2.2 欠账 #3 的 C 类文件型资产（快照 / 内容寻址 / 段落级 LWW）是同一条技术线 | 不阻塞开工，但 C 类资产的**设计**要先对齐 FR-7.3 的落点，否则两套寻址方案并存 |

其余 M3/M4/M5 余项（市场注册表、RRULE、结果回推 IM、IM 会话归档、用量报表等）与同步无交集，可并行。

---

## 三、三个子系统与文件落点

### 3.1 服务端：`cloud/`（新建，Python FastAPI）

**单一进程**承载认证与同步，**不引入 Node、不依赖 nanowork 既有后端**（设计 §16 已定案）。

```
cloud/                          # 与 nanobot/ 并列的仓库根子目录
├── app/
│   ├── main.py                 # FastAPI 入口（含 CORS：Web 端需 credentials）
│   ├── auth/
│   │   ├── routes.py           # /api/auth/{register,login,refresh,logout,me}
│   │   ├── security.py         # 密码哈希（bcrypt/argon2）+ JWT 签发/校验 + refresh 轮换
│   │   └── deps.py             # current_user 依赖（Bearer → userId）
│   ├── sync/
│   │   ├── routes.py           # POST /api/sync/push、GET /api/sync/pull
│   │   ├── merger.py           # LWW 裁决（§7.1 三级 tie-break）：纯函数，可单测
│   │   └── models.py           # sync_items 表（collection, entity_id, user_id, rev, updated_at, deleted_at, payload, server_seq）
│   └── db.py                   # SQLModel engine：开发 SQLite / 生产 PostgreSQL
├── tests/                      # pytest：auth 生命周期 + LWW 裁决 + push/pull 往返
└── pyproject.toml
```

**关键契约（与客户端约定，必须一次对齐）**：

| 端点 | 请求 | 响应 |
|---|---|---|
| `POST /api/sync/push` | `{ changes: [{ collection, entity }] }` | `{ accepted: string[], conflicts: [{ id, server, resolution }] }` |
| `GET /api/sync/pull?since=<cursor>` | —— | `{ cursor, changes: [{ collection, entity }] }` |

**两条服务端不变量**：
- **`updatedAt` 由服务端接收时间归一**（设计 §6.3 / §15）：多端时钟漂移下，客户端时间只作**入参**，
  服务端落库时按「接收时刻」重算并回写，否则一台系统时间快的机器会永远赢 LWW。
- **`cursor` 由服务端基于 `server_seq` 单调生成**，与客户端的 `rev`/`updatedAt` **解耦**——
  cursor 是「服务端变更流的序号」，不是实体版本。混用会导致 pull 漏数据。

### 3.2 客户端：`src/sync/`（新建，渲染层，**不得 `import 'electron'`**）

```
src/sync/
├── SyncClient.ts       # HTTP 封装：鉴权头、push、pull、refresh 重试；仅依赖 fetch
├── SyncEngine.ts       # 单集合引擎：push 组装（tombstones + 存活 + 裁剪函数）、pull 落地、调度
├── syncRegistry.ts     # 各 store 的 getter/setter 注册表（引擎与 store 的唯一耦合点）
├── syncAccount.ts      # 账户态：token 获取/刷新/登出；Electron 走 keychain，Web 走 cookie
└── useSyncStatus.ts    # 状态（local/syncing/synced/conflict/offline）供 Banner 订阅
```

**四条客户端不变量**：
1. **未登录 = 纯本地**：`SyncEngine` 完全不启动，**零网络请求、零副作用**（local-first 兜底，设计 §5.4）。
   这条要有单测守卫——「未登录时调用任何 store 动作，fetch 调用次数为 0」。
2. **`syncRegistry` 是唯一耦合点**：引擎不 `import` 任何 store，只读注册表。反过来的话，
   每个 store 都要知道同步的存在，而它们的职责是本地 CRUD。
3. **平台能力必须有 Web 降级**（跨阶段门禁 c）：token 存储在 Electron 用 `safeStorage`/keychain、
   Web 用 `httpOnly cookie`；`deviceId` 两侧都用 `lib/deviceId.ts`（已就绪）。
4. **`src/sync/` 属渲染层** → 走 vite，**不需要重建 `main.cjs`**；但若为 token 存储动了
   `electron/`（preload / 主进程），**必须重建**（见 skill §8 的新鲜度判据）。

### 3.3 认证与同步状态 UI

| 界面 | 落点 | 说明 |
|---|---|---|
| 登录 / 注册 | `src/pages/auth/`（新建）+ 路由守卫 | 两端同一份；未登录时**不拦截**本地使用，只收在「同步设置」入口 |
| 同步状态徽章 | 复用标题栏 / 侧边栏底部 | 消费 `useSyncStatus()`；`conflict` 态给 toast |
| 账户与数据主权 | 设置页「账户」分区 | 登出 / **导出全部数据** / **彻底删除账户**（FR-10.6） |

---

## 四、实体 → collection 契约（`syncRegistry` 的落点表）

引擎按 `(collection, entityId)` 索引。下表是**唯一权威**，改实体时先改它：

| collection | 实体 / 类型 | 本地 store / 落点 | 读 | 写（落地 pull） | 策略 | 负载函数 |
|---|---|---|---|---|---|---|
| `agents` | `Agent` | `agentsStore`（① `experts/agents.json`） | store + `tombstones` | store | LWW | `pickSyncable`（无 omit） |
| `expertGroups` | `ExpertGroup` | `expertGroupsStore`（① `experts/groups.json`） | 同上 | 同上 | LWW | `pickSyncable` |
| `tasks` | `TaskConfig` | `tasksStore`（② `tasks.json`） | 同上 | 同上 | LWW | `pickSyncable`（`runs` 不在持久化负载） |
| `mcp` | `MCPConfig` | `mcpStore`（① `mcp.json`） | 同上 | 同上 | LWW | `pickSyncable(omit 运行时事实 + auth)` |
| `channels` | `ChannelConfig` | `channelsStore`（① `channels.json`） | 同上（**墓碑键是 `kind`**） | 同上 | LWW | **`toChannelSyncPayload`** |
| `skillOverrides` | `SkillOverrideEntry` | `skillsStore`（① `skills/overrides.json`） | store | store | LWW | `pickSyncable` |
| `settings` | `Settings`（单例 `id='local'`） | `settingsStore`（① `settings.json`） | store | store | LWW（字段级） | **`toSyncPayload`** |
| `sessionMeta` | `SessionMeta` / 索引条目 | `projects/<slug>/<id>.meta.json` + `index/sessions.json` | `indexFile` | `indexFile` | LWW | `withSessionSync` / 白名单 |
| `sessionEvents` | 事件流 `<id>.jsonl` | `streamWorkdir` 分片 | JSONL 读取 | 追加写 | **append（按 `seq`）** | 无（不需要元数据） |
| `artifacts` | 产物 | ② `artifacts.json` | —— | —— | **内容寻址（只传新 hash）** | 欠账 #4 |

> ⚠️ **`sessionMeta` 与 `sessionEvents` 是两个 collection、两种策略**——这是会话同步最容易做错的地方：
> 标题/置顶/模式走 LWW（可冲突），消息正文走追加（天然无冲突）。混成一个 collection 会让 LWW 去裁决
> 一条只会增长的事件流。

---

## 五、五个非显然约束（改这块之前必读）

### 5.1 本地**没有、也不引入** SQLite → 不照抄设计文档 §4.3

`cross-platform-sync-design.md` §4.3 写「引入本地 `sync_metadata` + `sync_changelog` 两张 SQLite 表」，
但 **ADR-022 已定案 V1 舍弃 SQLite**（Electron 31 = Node 20 无内置 `node:sqlite`，仓库零原生依赖），
索引层已改 JSON（PRD §9.4）。**照抄 §4.3 等于推翻 M1 的决策。**

**首选方案（本文推荐）：连 changelog 表都不做。** 理由：`SyncMeta` 落地后，**变更日志成了派生物**——
「哪些实体改过」直接由实体自身的 `updatedAt` / `rev` 回答，不需要第二份记录：

- **push 组装** = `存活实体（updatedAt > 本地已推水位）` ∪ `tombstoneEntries()`，再各自过裁剪函数；
- 实体量级是**几十条**（Agent/渠道/任务），MVP 可**直接全量 push**，服务端 LWW 裁决——
  彻底省掉 outbox 与水位，也就省掉「outbox 与实体不一致」这一整类 bug。

**同步状态落点**（若确实需要水位）：走现有 `platform.storage` 的**一 key 一文件**，
新增 key 登记进 `electron/storageRoutes.ts`：`nanowork.sync.cursor`（② 运行时）、
`nanowork.sync.account`（② 运行时）。**不进 ①、不上云**。

### 5.2 引擎负载 ≠ 云端负载（两条路，字段清单重叠但不相同）

`channelsStore.syncAll` 提交给**引擎**的必须**带凭据**（引擎靠它连 IM）；「凭据不上行」**只约束云端**。
本文与 `lib/syncPayloads.ts` / `lib/settingsSync.ts` 说的都是**云端**那条。加字段时两处都要看。

### 5.3 `updatedAt` 以服务端接收时间为准（时钟漂移）

LWW 直接比较客户端 `updatedAt` 会被「系统时间快的设备」永久劫持。所以：**客户端 `updatedAt` 只作入参**，
服务端落库时按**接收时刻**重算并回写；pull 下发的也是归一后的值。这条不实现，验收门禁②
（「离线编辑联网合并无丢失」）会以随机方式失败。

### 5.4 墓碑 GC 30 天 与「删除传播」有先后

墓碑保留 30 天后由**服务端**定时清理（设计 §7.3 已定）。顺序是「**先所有设备都拿到该墓碑，再 GC**」——
而服务端只能按时间近似（30 天足够覆盖）。**V1 的墓碑永不清**（已就绪），M6 起才引入 GC。
清理前必须确认 pull 的 `since` 水位机制不会让「刚 GC 的墓碑」被重新拉取为空。

### 5.5 会话事件流：`streamWorkdir` 是**本机事实**，跨设备必须重定向

会话元数据里 `workdir`（语义工作空间，是**声明**）同步；`streamWorkdir`（落盘分片，是**事实**）**不同步**
（`lib/sessionSyncMeta.ts` 白名单已排除它）。后果：**从设备 A 拉来的会话，事件流要落到设备 B 自己的分片**，
不能照抄发送方的路径——否则 B 上会出现一个指向 A 的目录、B 自己读不到。

另一个并发点：`seq` 是**会话内单调、单写者假设**的序号。若两台设备**同时**在同一会话里追加，`seq` 会撞。
MVP 的裁决：**按事件 `id`（uuid）去重 + 按 `seq` 排序**，撞号时按设备号 tie-break，**保留双方事件**
（并集不丢，符合门禁②）；文档明确「同一会话不建议两端同时继续」为已知限制。

> **另有四条同类约束尚未定案**，见 §六 第 9–12 条：pull 落地的合并语义、墓碑 GC 的过滤责任、
> `Session.workdir` 跨设备落地、首次 push/pull 顺序。它们与上面五条一样「照现在的文档写就会写错」，
> 差别只是还缺一个裁决——所以放在 §六 而不是这里。

---

## 六、待确认问题（含推荐答案）

| # | 问题 | 推荐答案 | 理由 |
|---|---|---|---|
| 1 | 服务端代码落在哪？ | **同仓 `cloud/` 子目录**，与 `nanobot/` 并列；**不新增第二个嵌套 git** | V1.5 本地 `uvicorn` 单机跑通，同仓便于一次性门禁与版本对齐；生产独立部署形态**设计已定「留待后续」**（§16）。`nanobot/` 那个独立 .git 是上游 fork 的历史包袱，不该复制 |
| 2 | 本地同步状态用 SQLite 还是现有存储？ | **不引入 SQLite**（ADR-022），用 `platform.storage` 一 key 一文件；**MVP 连 changelog 都不做**（§5.1） | 照抄设计 §4.3 会推翻 M1。`SyncMeta` 已让变更日志变成派生物 |
| 3 | push 是全量还是增量？ | **MVP 全量 push**（实体量几十条），pull 增量 | 省掉 outbox 与水位，消除一整类一致性 bug；量大后再加 `updatedAt` 水位 |
| 4 | 服务端 DB？ | 开发 **SQLite**（`sqlmodel`）/ 生产 **PostgreSQL**，同一份 schema | 设计 §3 已定；本地跑通不需要起 Postgres |
| 5 | 渠道凭据保险库化何时做？ | **M6 批次内**，与同步排除表**同期**（§2.2 欠账 #2） | 同步一开就必须切；V1 阶段维持明文是对的，但那是「因为不同步」 |
| 6 | 冲突 UI 做到什么程度？ | **MVP 只做状态徽章 + toast**，不做逐条合并界面 | 设计 §7.4 把字段级合并列为「未来升级」；验收门禁只要求「无丢失」，不要求「可手工合并」 |
| 7 | 事件流是否走对象存储（S3）？ | **MVP 直传服务端行存**（事件小、量可控），S3 留到 §4.1 的「大文件」场景 | 设计 §4.1 提了 S3，但 MVP 引入对象存储会把部署复杂度翻倍，收益为零 |
| 8 | Web 端 `deviceId` 与 Electron 冲突吗？ | **不冲突**：同一 key 名、不同介质（localStorage vs `<userData>/device-id.txt`） | syncmeta §六 待确认 1 已定 |
| 9 | **pull 落地是整条替换还是合并？** | **必须浅合并（merge），不能整条替换**。`push` 侧经 `pickSyncable()` 剔掉了运行时事实（`MCPConfig.tools` / `status` / `lastProbedAt`、`ChannelConfig.syncStatus`），落地若整条替换会把**本机事实字段一并抹掉** → 恰好制造出 §5.2 要避免的「本机没探测过却显示 connected」假状态，只是发生在**写侧**。落地形状：`{ ...本地条目, ...payload }`，元数据（`rev` / `updatedAt` / `deletedAt` / `updatedBy`）以 payload 为准；该规则写进 `syncRegistry` 的 setter 契约 | 裁剪逻辑已落地（`lib/syncSelect.ts`）但只写了 push 半程；写侧若无合并语义，「剔除事实」就变成「删掉本机事实」 |
| 10 | **客户端墓碑永不清理 × 服务端 30 天 GC，怎么共存？** | **过滤动作必须发生在客户端 push 组装处**：`tombstoneEntries()` 之外再套一层时间窗，超期墓碑不再上行（客户端本地同期清理）。理由：`SyncTombstones` 目前全仓**零清理逻辑**，而 MVP 是**全量 push** → 每轮都把 40 天前的老墓碑再送一次；服务端又按「接收时间归一」`updatedAt`（§5.3），重收即重置时钟 → **按归一后的时间 GC 则永远 GC 不掉**；若改按客户端 `deletedAt` GC 则回到时钟漂移。两头都不成立，只能由发送方负责 | §5.4 只写了「先传播、后 GC」的先后，没写「谁把超期墓碑挡在门外」 |
| 11 | **`Session.workdir` 跨设备怎么落地？** | **保留同步，但落地时做路径可用性判定**：目标机不存在该目录时归入「默认工作空间」分组、保留原值待用户确认，**不**拿它去当事件流分片名。注意 `streamShardOf = streamWorkdir ?? workdir`（`stores/sessionsStore.ts`），拉来的会话 `streamWorkdir` 为空，会 fallback 到**对端路径**——这正是 §5.5 要防的那个后果，而 §5.5 只处理了 `streamWorkdir` | 它在白名单里（`lib/sessionSyncMeta.ts` 第 51 行），而 `settings` 的绝对路径字段（`defaultWorkspacePath` / `knownWorkspaces` / `workspaceAliases`）反被排除——**同一类东西两条规则**，需显式裁决而不是各写各的 |
| 12 | **首次登录先 push 还是先 pull？** | **先 pull 再 push**（等价做法：首次不推 `rev === LEGACY_REV` 的老数据）。若先 push，两端把各自的 `rev = 0` 老数据都补齐成 `rev = 1`、`updatedAt = now`，LWW 只能按时序随机裁决 → 症状是「**后登录的机器覆盖先登录的**」，且门禁②看不出来（不是离线合并场景） | §2.1 只说首次全量推送要识别 `rev === 0`，没说补齐后两端的版本号会撞 |
| 13 | **`conflict` 时被覆盖方的数据去哪？** | 在 `SyncEngine` 的 pull 落地处**保留一份 `client` 快照**（走 ② 运行时存储、一 key 一文件，登记 `electron/storageRoutes.ts`），并写明「MVP 只做徽章 + toast」的含义是**不做手工合并 UI**，不等于丢弃被覆盖内容 | 设计 §15 与 §7.4 都提到保留快照，但 §3.2 的 `src/sync/` 四件套里**没有它的位置**；门禁②「无丢失」的边界要靠它定义 |
| 14 | **认证的两个落地细节？** | ① Token 存储**复用 `electron/credentialVault.ts`**（`safeStorage`，已有「不可用时拒绝写入」的 fail-closed），不另造 keychain 通道；② Web 本地开发 `vite:5173` ↔ `uvicorn:8910` 属**跨站** → 明确 `SameSite=None; Secure`（本地备注 http 例外）与 CORS `credentials: true`，写进 §3.1 `main.py` 的注释 | 跨阶段门禁 (c) 要求「新增平台能力必须有 Web 降级路径并**写明**」——这一条就是它 |
| 15 | **门禁①/② 怎么自动化？** | 建一套**双实例夹具**：同一个 uvicorn + 两个隔离的 store / storage 实例（Electron 侧两个 `userData` 目录、Web 侧两个 `browser context`），跑「登录 → 改 → 断网 → 改 → 联网 → 比对」。门禁①可补一条真机手测，但**不能只有手测** | 门禁原文写「真机跑，非单测」，与项目「新增能力必须有单测」的纪律冲突；门禁②的「离线合并无丢失」本质上完全可自动化 |

> **第 9–15 条为 2026-09-26 追加。** 前 8 条来自设计文档自身的开放问题；这 7 条是**落点复核时暴露的、
> 两份同步文档都没有回答**的问题，共同点是「不定就会把实现形状做错，而症状在门禁里看不出来」。

---

## 七、分批实施与门禁

> 顺序原则：**批次 1（服务端）与批次 2（客户端引擎）是纯新增**——`cloud/` 与 `src/sync/` 都不改既有代码、
> 也不依赖下面的欠账，**可以最先开工并彼此并行**；**批次 4（实体接线）之前**必须先完成批次 3，
> 否则会出现「同步通了但数据是错的」。

| 批次 | 内容 | 完成判据（可证伪） |
|---|---|---|
| **1 服务端骨架** | `cloud/`：FastAPI + auth 五端点 + `sync_items` 表 + LWW merger + push/pull；pytest | `pytest` 全绿；**auth 全生命周期往返**（register→login→refresh→me→logout）；**LWW 三级 tie-break 逐条**（时间大者胜 / 时间等则 rev 大者胜 / 都等则 id 字典序）；push 后 pull 能取回 |
| **2 客户端引擎** | `src/sync/` 四件套 + `syncRegistry` + 单测（mock fetch） | **未登录时 fetch 调用次数 = 0**（local-first 守卫）；push 组装**含墓碑**且**过裁剪函数**；pull 落地后墓碑条目不出现在列表 |
| **3 前置欠账** | 会话删除墓碑（动 `electron/`）+ 渠道凭据保险库化 + 排除表落地 + 平台边界收口 + wire 泄漏收口（C 类资产与产物寻址随批次 6） | 删掉的会话**不复活**（跨「设备」模拟）；`channels.json` 与同步负载里**都没有** secret；**CI 平台边界 / wire 两条检查的基线例外清零**（新增越界会被拦）；**动了 `electron/` → 重建 `main.cjs`** |
| **4 实体接线 + 认证 UI** | 8 实体 + 会话元数据接 registry；首次登录**全量 push**（`rev === 0` 补默认值）；`src/pages/auth/` + 状态徽章 | 门禁①：**两端登录同账户后 Agent / 会话双向一致**（真机跑，非单测）；离线改 → 联网 → 合并无丢失 |
| **5 事件流追加同步** | `sessionEvents` 按 `seq` 游标 push/pull；跨设备**落本机 `streamWorkdir`** | 门禁②：断网追加 N 条 → 联网后对端拿到全部 N 条且顺序正确；两端并发追加**并集不丢** |
| **6 其余欠账 + 数据主权** | C 类文件型资产（记忆段落级 LWW / 身份文件 / 提示词覆盖）；产物内容寻址；导出全部数据 / 删账户；墓碑 GC 30 天 | 段落级 LWW 有单测；导出产物可重新导入；GC 后 pull 不复活已删条目 |

**门禁（沿用并扩展 `nanowork-dev-gate`）**：

- 客户端：三套 `tsc` 0 错误 → `vitest run --maxWorkers=3` 全绿 → `vite build --emptyOutDir false` 绿。
- 服务端：**新增 `pytest`**（`cloud/tests/`）——这是本项目第一次出现 Python 侧门禁，
  与 `nanobot/` 的测试方式分开（那里是只读参考，**不得**为它加测试依赖）。
- 动了 `electron/`（批次 3 必动）→ **重建 `main.cjs` + `preload.cjs`**。
- 跨阶段门禁 (c)：token 存储在 Web 端必须有降级路径并**写明**。

---

## 八、明确不做（写下防下一轮再议）

- ❌ **不做团队 / 共享 Agent**：本期仅个人账户，「多租户」只指按 `user_id` 隔离（设计 §16.3）。
- ❌ **不做 OAuth2 第三方登录**：MVP 只做邮箱 + 密码 + JWT（设计 §16.5）。
- ❌ **不做实时协同 / CRDT**：MVP 用 LWW；字段级合并、WebSocket 实时推送为后续演进（设计 §7.4 / §9）。
- ❌ **不做端到端加密**（FR-10.7 是 P2）：设计 §10 已列为可选，本期不落。
- ❌ **不引入 Node 服务**、**不依赖 nanowork 既有后端**（当前不存在）。
- ❌ **不推翻 local-first**：云端不可用时本地必须全功能可用（设计 §15）。
- ❌ **模型不得执行任何 git 写操作**（本项目一贯纪律）；服务端仓库的提交同样由用户决定。

---

## 九、与既有文档的关系

| 文档 | 关系 |
|---|---|
| `cross-platform-sync-design.md` | **设计权威**（本文是它的落地拆解）；§4.3 的 SQLite 方案已被 §5.1 修正——该文档**已在文首加「⚠️ 勘误」横幅**（2026-09-26，八行表 + 七处行内勘误），登记在 `docs/README.md` §九 看板 #17 |
| `architecture-syncmeta.md` | **Phase 0 落点清单**（已完成）；其 §八「明确不做」的 4 条 = 本文 §2.2 的欠账 |
| PRD v2 §19 跨端与同步 | §19.1 采纳设计；§19.2 要求 `SyncMeta`（已落）；§19.3 三类数据策略（本文 §四 按它分 collection） |
| PRD v2 第 6 章 | M6 验收门禁的出处 |
| `nanowork-prd-design-v2.md` FR-10.1–10.7 | M6 覆盖的需求编号 |
