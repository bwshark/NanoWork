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
>
> ⚠️ **本文自身亦有三处勘误（2026-09-28 批次 5 追加，登记为 §九 看板 #22）**——落点复核时发现
> 以下三处「照现在这样写就会写错」。按「加勘误、不改原文」口径处理：**原文保留**，在原处加注：
> ① **§5.5** 的「撞号时按**设备号** tie-break」**不可实现**（`BaseEvent` 上根本没有设备号字段）→ 末级键改用**事件 `id`**；
> ② **§5.5 / §七 批次 5** 的「并集不丢」是**事件层**语义，**投影层只显示一条链**（`project.ts::activePath` 只沿单一 max-`seq` 尖端回溯）；
> ③ **§四** `sessionEvents` 行的「append（按 seq）」其**实施含义**是「push 游标 = 每会话**推送确认水位**」，**不是**「服务端已知最大 `seq`」——后者在并发下会**丢推**。

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

### 2.2 必须先补（6 个洞：Phase 0 留下的 4 个 + CI 基线登记的 2 个；**#1 / #2 / #5 / #6 已闭合**）

> 前四条都**不是 M6 的新需求**，是 Phase 0 明确「归 V1.5」的欠账；后两条是 CI **已登记为基线例外**
> 的既有越界（`.github/workflows/ci.yml` 的两条检查）。
>
> **2026-09-28 复核结论：开工前已无拦路石，且 #2 也已提前闭合。** 剩下两条的收益都要等同步层存在才兑现，
> 因此各自归位到批次内而不是卡在开工前：
>
> - **#2（凭据）** —— ✅ **已于 2026-09-28 落地（提前落在批次 3）**：「不上行」那一半早随排除表生效，
>   写入侧保险库化同期完成（密钥入 `safeStorage` 保险库，`channels.json` 只留非密钥字段）；
> - **#3（C 类资产）** / **#4（产物寻址）** —— 一个是段落级 LWW 另案、一个依赖尚未开工的
>   FR-7.2（产物落点会随它重做，现在写会白写），两者都归**批次 6**。
>
> 换句话说：本节从「开工前置清单」变成了**批次内的排期表**——批次 1（服务端）/ 批次 2（客户端引擎）/
> 批次 3（前置欠账）/ 批次 4（实体接线）/ 批次 5（事件流追加同步）**均已落**；余 C 类文件型资产与
> 产物内容寻址归**批次 6**。

| # | 欠账 | 为什么必须在 M6 补 | 详见 |
|---|---|---|---|
| 1 | **会话删除的墓碑** | ✅ **已于 2026-09-27 闭合**：`deleteSession` / `deleteSessions` 改走 `tombstoneSession(meta)`——写墓碑（`deletedAt` + `rev` + `updatedBy`）+ **覆盖索引条目** + 丢弃 JSONL 正文，保留 meta 与索引条目，删除自此可传播。硬删 `removeSession` 保留给「空会话搬迁分片」。落地面：新契约方法 ×3 个存储实现（内存参照 / Web 分片 / Electron 主进程）+ `events:tombstone` IPC + `platform` 能力 + `sessionDeletePatch`。 | syncmeta §7.3（已改为「已补做」） |
| 2 | **渠道凭据保险库化 + 同步排除表** | ✅ **已于 2026-09-28 闭合（批次 3）**：①「不上行」半程在 2026-09-25 随 `toChannelSyncPayload` 的 `CHANNEL_SYNC_OMIT_KEYS` 生效（剔除 4 个密钥 + 3 个配套 id + 2 个运行时事实，有反向护栏用例）；② **写入侧保险库化于本批落地**——新增共享纯模块 `src/lib/channelSecrets.ts`（渲染层与主进程**同源**的密钥字段表 / 保险库命名 `channel:<kind>` / 取密钥 / 去密钥）+ 主进程 `electron/channelSecretInjection.ts`（合并 `config.json` 时按 `kind`、feishu 按实例 `domain` **回补**密钥；另有 `carryOverChannelSecrets` 兜底：**保险库不可用时保留磁盘旧密钥**，保证渠道可用）+ `channelsStore` 的 `refreshSecrets` / `saveSecrets` / `vaultExistingSecrets`（`partialize` **仅在 `electron` 且保险库可用时**剔密钥）+ ChannelConfigDialog / ImChannelsPage 与启动期改按保险库判据。定案仍是「与同步接线同期」（§六 待确认 #5）。 | syncmeta §5.3 + 本文 §七 批次 3 |
| 3 | **C 类文件型资产的同步设计** | 记忆（`MEMORY.md` / `<workdir>/.nanowork/memory/`）、身份文件（`SOUL.md`/`USER.md`）、提示词覆盖、插件包——它们的「版本」是文件 `mtime` / 段落时间，**塞不进实体元数据**，需要段落级 LWW 另案。 | PRD §19.3、syncmeta §二 C 类 |
| 4 | **产物（`artifacts`）内容寻址同步** | Phase 0 刻意不给它加实体元数据：产物按**内容寻址**（只传新增 hash），且它的落点（②`artifacts.json`）会随 FR-7.2 产物索引（M4）重做。 | syncmeta §八 |
| 5 | **平台边界收口**（渲染层直连 `window.electronAPI`） | ✅ **已于 2026-09-27 闭合**（V1.5 开工前完成，比排期提前）：原先 4 项 CI 基线例外 + 复核时查出的 **5 处未登记**越界（设置页拆分后新增的 3 个 section 与 2 个 hooks，共 **9 个文件**）全部改走适配层——新增「桌面端集成」能力组（窗口控制 / 托盘配置 / 主进程指令）、`platformOs()`、事件存储适配器的 `electronBridge()`；CI 检查一补 `src/platform/` 允许区 + **基线清空** + 「基线项必须真实存在」自检。**仍留在本节是因为它是 `src/sync/` 的前提条件**（§3.2 不变量 4「不得 `import 'electron'`」）。 | `docs/README.md` §九 看板 #13 |
| 6 | **引擎 wire 字段泄漏收口** | ✅ **已于 2026-09-28 闭合**：`src/lib/channelScan.ts` / `src/types/channel.ts` 里的 `session_id` 等 wire 键名已收进 `src/ai/runtime/nanobotHttp/channelConnect.ts`（承载 wire 类型 + 起始参数 + 编码/解码 + camelCase 领域类型），`platform.channelConnect` 退化成只搬运不解释的通道；CI 检查二**基线清空**。`channels` 正是本批要接线同步的 collection 之一，所以它也是接线前的顺路收口。 | `docs/README.md` §九 看板 #14 |

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

**落地备注（2026-09-28，批次 1 实施时暴露的四条）**——都不是设计变更，是「照文档写会踩」的细节：

| # | 事 | 为什么值得记 |
|---|---|---|
| 1 | **`server_seq` 不能省，不能拿自增 `id` 顶替** | push 走 UPDATE，行 `id` 不变。用 `id` 当游标的后果是：对端游标一旦越过该行，此后该实体的**任何更新都拉不到**——症状是「第一次同步成功、之后再也不动」，出现得很晚但成因在这一行。`tests/test_sync.py::test_update_after_first_pull_is_visible` 专门守它 |
| 2 | **sqlmodel 0.0.47 的 `datetime` 字段强制带时区** | 写 naive 值直接抛 `ValueError: Datetime values must have timezone information`，而它没有导出 `NaiveDatetime`。已实测 **SQLite 对 aware datetime 往返保真**（读回仍带 `tzinfo=UTC`），故全场统一 aware UTC 并抽 `app/timeutil.py`；顺带避开 `datetime.utcnow()`（3.12 起弃用且返回 naive） |
| 3 | **第三级 tie-break 必须拆成独立函数才测得出来** | `resolve(current, incoming)` 的两端 `entity_id` 必然相同 → 字典序那条**永远平局**，在 `resolve()` 里根本击不中。故裁决拆成 `compare_versions()`（可单测）+ `resolve()`（用前者） |
| 4 | **refresh 重放会吊销整条轮换链，包括刚签发的新票** | 这是刻意的（只吊销旧票则攻击者手里的票能一路换下去），但第一次写测试时按「新票应当仍可用」断言会红。语义见 `app/auth/routes.py` 模块 docstring |

**落地备注（2026-09-28 批次 4 追加第 5 条）**——批次 4 实施时暴露的**阻断级**缺口：

> **5 · `updatedAt` 归一必须「写回 payload」，否则 §5.3 只实现了一半（批次 4 修复）**
>
> 批次 1 只把归一后的时间写进了 `row.updated_at`（**列**），payload 仍是 `json.dumps(entity)` 原样 →
> 「行的服务端时间」与「payload 的客户端时间」**两个时钟混比**。后果：客户端 `collectChanges()` 是
> **全量 push**（§5.1），每轮空闲同步都把同一个客户端时间再送一次 → 服务端 `resolve()` 判 `stale` →
> 回 `conflicts` → **徽章恒亮 `conflict`**（默认每 30s 一次），门禁①/②必然失败。
>
> 这不是新需求：批次 2 的引擎与类型注释**本就假设服务端会归一并回传**
> （`SyncEngine.ts`「accepted 非空 → 再 pull 一次，取回服务端归一后的 `updatedAt`」、`types.ts` 同款说明），
> 即 §5.3 当时**只落地了一半**。
>
> **修复（两处，均在 `cloud/app/sync/routes.py::push`）**：
> ① 落库前 `entity['updatedAt'] = iso_z(now)` 再序列化（`row.client_updated_at` 仍保留客户端上报值供审计）；
> ② `resolve()` 的 `cmp == 0` 分支，若「**除 `updatedAt` 外**负载与已存 `row.payload` 完全相同」，则
> **幂等跳过**——不写库、不推进 `server_seq`、也不进 `accepted`。
> **②为什么必须加**：归一之后，每轮空闲同步都会「`cmp==0` → 接受 → 写库 → `seq+1` → 客户端回拉全量
> → 本地 `updatedAt` 前移」，形成 30s 一次的**无限写入 + 无限回拉**；跳过之后空闲态才是真·空转。
> 另：`iso_z()` 从测试局部 helper 抽进了 `cloud/app/timeutil.py` 共享。
>
> 用例：`cloud/tests/test_sync.py` 的 `test_push_normalizes_updated_at_to_server_receive_time`、
> `test_identical_push_is_idempotent_and_does_not_advance_seq`。

**落地备注（2026-09-28 批次 5 追加第 6 条）**——对上面第 1 条「每次写入都推进 `server_seq`」的**第二个例外**：

> **6 · 事件（`sync_events`）按唯一键幂等跳过时同样不推进 `server_seq`（批次 5）**
>
> 批次 5 新增事件流通道（§四 `sessionEvents`）。事件**不可改写**，故其「重复」判据不是 `updatedAt` / `rev`
> 而是**唯一键 `(user_id, session_id, event_id)`**：已存在 → **不写库、不推进 `server_seq`、不计入
> `accepted_events`**。与第 5 条同源（都属「重收同一事实时不得制造新变更」），只是判据从「除 `updatedAt`
> 外负载相同」换成了「事件 id 相同」。
> 用例：`cloud/tests/test_sync_events.py::test_repush_same_events_is_idempotent`。

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

> **`sessionEvents` 行的实施含义（2026-09-28 批次 5 勘误）**——该行「append（按 `seq`）」有三个不显然的落点：
> 1. **它不进 `syncRegistry`**：`SyncCollectionSpec.read()` 是**同步**的，而事件存储（`EventStore`）**全异步**；
>    硬套会得到一个撒谎的 `read()`。故事件通道是**第二个适配器**（`src/sync/eventStream.ts`），**可选注入**引擎；
>    未注入时是纯 LWW 引擎，既有行为一字不变。
> 2. **push 游标是「每会话推送确认水位」，且只在 push 成功后推进**——**不是**「服务端已知最大 `seq`」。
>    后者在并发下会**丢推**：A 离线攒 `seq 1..5`、B 先推 `1..3`，A 联网 pull 到 `1..3` 若据此推进水位，
>    A 本机那几条**永不上行**。代价是「每条远端事件回显一次」（服务端按 id 去重，**有界**，非无限回环）。
>    该水位**按账户隔离**（换号不得互相影响，见 `docs/README.md` §九 看板 #23）。
> 3. 「无元数据」⇒ 事件**不参与 LWW**、服务端**不归一** `updatedAt`、**不**入 `sync_items`——另立 `sync_events`
>    表，但**共享同一条每用户 `server_seq` 游标**（`_next_seq` 取两表最大值 + 1），故 pull 仍是单游标一次取全。

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

> ✅ **2026-09-28 批次 4 补全**：此前「回写」只落在 `row.updated_at` **列**上，**payload 仍是客户端原值**
> —— 于是「pull 下发的也是归一后的值」这句**当时并不成立**，且直接导致每轮空闲同步被误判 `stale`
> （徽章恒 `conflict`）、门禁①/②失败。现已在 `push` 落库前把 `entity['updatedAt']` 归一为接收时刻，
> 并给「完全同版且内容未变」加了幂等跳过（详见 §3.1 落地备注第 5 条）。

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

> ⚠️ **勘误（2026-09-28 批次 5）——上面「按设备号 tie-break」不可实现；「并集不丢」的粒度也需澄清**：
> 1. **「设备号 tie-break」作废**：`BaseEvent`（`src/types/event.ts`）**没有**设备号字段；`updatedBy` 只存在于
>    `SessionMeta` / 实体元数据上。真要按设备号裁决，就必须给事件**加字段 + 迁移既有 JSONL**，超出本批。
>    → 末级键改用 **事件 `id` 字典序**，即 `dedupe(by id)` → `sort(by (seq asc, id asc))`。
>    `id` 是 uuid、跨端一致，用它做末级键**确定且两端一致**，已满足「并集不丢 + 顺序确定」的全部诉求。
>    （真要设备号，应作为**后续批次的事件 schema 变更**另立。）
> 2. **「并集不丢」是事件层语义**：`src/events/project.ts::activePath` 只沿**单一** max-`seq` 尖端回溯
>    → 两端并发追加时，并集**在事件层完整保留**，但**投影层只显示一条链**（另一分支的事件在文件里、
>    不在当前会话视图里）。故门禁判据必须断言在**原始事件列表**（id 集合 / 条数 / 顺序），**不能**断言在
>    `messages` 投影上——否则会把「另一分支不出现在消息气泡里」误判成失败。
> 3. 补充（本批落地的两条纪律）：**落地分片只认接收方本机**（`sessionsStore` 的 `streamWorkdir ?? workdir`）；
>    会话在本机未知 / 已墓碑 → **跳过该批事件**（不落孤儿文件），绝不照抄发送方路径（与 §六 #11 同一条纪律）。

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
| 5 | 渠道凭据保险库化何时做？ | ✅ **已落（2026-09-28，批次 3）**：「与同步排除表同期」已兑现——密钥入 `electron/credentialVault.ts`（`safeStorage`），`channels.json` 仅存非密钥字段；保险库不可用时退化为明文且**不剔除**（界面标注「未加密」） | 同步一开就必须切；V1 阶段维持明文是对的，但那是「因为不同步」 |
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
>
> **2026-09-28 批次 4 现状**：#9（pull 必须浅合并）、#10（墓碑 30 天窗由**发送方**过滤）、
> #11（`workdir` 保留原值 + `streamWorkdir` 重定向到本机默认分片）、#12（先 pull 再 push，且**不加**
> `rev===0` 过滤——老数据内容来自内置定义、自建条目 id 是随机数，天然不会互相覆盖）、
> #14（token 走 `platform.storage` 字符串 JSON 而**非**保险库；CORS 补 `5176`）、
> #15（双实例夹具已落地）**均已按各自裁决实现**，逐条理由与可证伪判据见
> `docs/batch-4-entity-wiring-spec.md`。
> ⚠️ **#13 是唯一打折的**：`conflict` 时被覆盖方的 `client` 快照**仍在引擎内存**（上限 50，重启即失），
> 持久化未做——「不做手工合并 UI」≠ 丢弃，语义满足；但「跨重启可追查」尚未兑现，**留待后续批次**。

---

## 七、分批实施与门禁

> 顺序原则：**批次 1（服务端）/ 批次 2（客户端引擎）/ 批次 3（前置欠账）/ 批次 4（实体接线 + 认证 UI + 状态徽章）/
> 批次 5（事件流追加同步）已全部落地**——批次 1/2 是纯新增（`cloud/` 与 `src/sync/` 都不改既有代码、
> 可最先开工并彼此并行），批次 3/4/5 依次补齐；**余下只剩批次 6（C 类文件型资产 + 产物内容寻址 +
> 数据主权 + 墓碑 GC 30 天）**。

| 批次 | 内容 | 完成判据（可证伪） |
|---|---|---|
| **1 服务端骨架** | ✅ **已落（2026-09-28）**：`cloud/` FastAPI + auth 五端点 + `sync_items` 表 + LWW merger + push/pull；`pytest` 26 例 + CI `cloud-gate` 作业 | `pytest` 全绿；**auth 全生命周期往返**（register→login→refresh→me→logout）；**LWW 三级 tie-break 逐条**（时间大者胜 / 时间等则 rev 大者胜 / 都等则 id 字典序）；push 后 pull 能取回 |
| **2 客户端引擎** | ✅ **已落（2026-09-28）**：`src/sync/` 七件（`types` / `SyncClient` / `syncAccount` / `syncRegistry` / `SyncEngine` / `useSyncStatus` / `index`）+ `tests/sync/` 5 文件 59 用例（mock fetch）；本批 registry **只注册 `agents` 样板**，其余 8 个 collection 留批次 4；**未动 `electron/`** | **未登录时 fetch 调用次数 = 0**（local-first 守卫）；push 组装**含墓碑**且**过裁剪函数**；pull 落地后墓碑条目不出现在列表（三条均有用例，经 QA 变异测试逐个击穿） |
| **3 前置欠账** | ✅ **已落（2026-09-28）**：渠道凭据保险库化（`src/lib/channelSecrets.ts` + `electron/channelSecretInjection.ts` + `channelsStore` 接线 + 启动期/UI 判据）+ 排除表落地（早于本批，2026-09-25）+ wire 泄漏收口（§2.2 #6，同日）。（**会话删除墓碑与平台边界均已提前闭合**，见 §2.2 #1 / #5；C 类资产与产物寻址随批次 6） | ✅ `channels.json` 与同步负载里**都没有** secret（保险库不可用时退化为明文，此时 `partialize` **不**剔除、界面标注「未加密」——fail-open 以保渠道可用）；**CI wire 检查的基线清零**（新增越界会被拦）；**动了 `electron/` → 已重建 `main.cjs` + `preload.cjs`**（门禁：三套 tsc + vitest **106 文件 1717 用例** + `vite build` 全绿） |
| **4 实体接线 + 认证 UI** | ✅ **已落（2026-09-28）**：`syncRegistry` 由「只注册 `agents`」补齐到 **8 个 collection**（`agents` + `expertGroups` / `tasks` / `mcp` / `channels` / `skillOverrides` / `settings` / `sessionMeta`；**`sessionEvents` 刻意不注册**，归批次 5）；新增 `src/sync/runtime.ts`（装配 + store 订阅 + suppress/missed + 账户生命周期，单例 `getSyncRuntime` / `initSyncRuntime` / `disposeSyncRuntime`）；`settingsStore` 加 `syncMeta` 兄弟切片（v11→v12）、`sessionsStore` 加 `sessionTombstones` + 远端落地入口；`src/pages/auth/`（登录/注册，**不引入全局守卫**——local-first）+ `SyncStatusBadge`（落**侧栏底部**而非 TitleBar：后者只在 Electron 渲染）+ 设置页「账户」分区（导出/删账户为禁用占位，归批次 6）；**另修掉 §3.1 落地备注第 5 条的阻断缺口**（服务端 payload 归一 + 同版幂等跳过）。落地规格：`docs/batch-4-entity-wiring-spec.md` | ✅ 门禁①（**已自动化**，非只有真机）：`tests/sync/integration.twoDevice.test.ts` 双实例夹具（真 spawn `uvicorn` + 两套 store 快照/换装）→ A↔B **双向一致**（Agent 与会话元数据），空闲同步 `status === 'synced'` 且 `conflict === 0`；✅ 门禁②：离线改 → 联网 → **并集不丢**（`aX` 与 `aY` 同时在两端），同实体并发改按 LWW 收敛且条目不消失；**17 项变异全部「改坏 → 变红 → 还原」**——其中**新增的服务端变异**（去掉归一）会让门禁①②的 `synced` 断言**双双变红**，证明该修复是必需的而非装饰 |
| **5 事件流追加同步** | ✅ **已落（2026-09-28）**：新增事件通道 `src/sync/eventStream.ts`（`SessionEventStreamAdapter`，**可选注入**引擎，未注入即纯 LWW 引擎；**刻意不进 `syncRegistry`**——`SyncCollectionSpec.read()` 是同步的而 `EventStore` 全异步）；服务端新增 `sync_events` 表（唯一键 `(user_id, session_id, event_id)`）**与 `sync_items` 共享同一条每用户 `server_seq` 游标**（`_next_seq` 取两表 max + 1），**扩展**既有 push/pull 各加 `events` 字段（**不新增端点**，避免第二条游标）；事件**不归一** `updatedAt`（不可改写的事实）；跨设备**只落接收方本机分片**（`streamWorkdir ?? workdir`，未知/已墓碑会话**跳过**）；去重/排序 `dedupe(by id) → sort(by (seq asc, id asc))`；**push 游标 = 每会话「推送确认水位」且只在 push 成功后推进**（pull 落地**不**推进，否则并发下丢推）。**另修两条账户态缺陷**（README §九 #23：pull 游标与事件推送水位此前**换号既不重置也不隔离** → B 登录后拉不到自己账户里的数据）。落地规格 `docs/batch-5-session-events-spec.md`；m6 文档自身三处勘误见文首横幅与 README §九 #22 | ✅ 门禁②（**事件层**验收）：`tests/sync/sessionEventsSync.test.ts` 双实例夹具**每设备一份 `EventStore`**（原夹具只有一套共享 → 不隔离就「A 追加即 B 可见」，用例失去鉴别力）→ 断网追加 N 条 → 联网后对端拿到全部 N 条且 `(seq,id)` 顺序正确；两端并发追加**并集不丢**（断言**原始数组长度 + 每 id 出现次数恰为 1**，**不用** `Set.size`——`Set` 会把重复折叠成假绿）。**QA 独立变异 15 项，13 项击穿**；另 2 项「打了不红」由 QA 自己揪出并补强：① 门禁② 原判据用 `new Set(ids).size === 6`（去重删掉后 `rawLength` 6→9 而 `unique` 仍 6，**断言照样绿**）→ 改为原始长度 + 出现次数；② 服务端「跨两表共享游标」**零覆盖**（`_next_seq` 退化成 items-only 仍全绿）→ 补 `test_pure_event_batches_advance_shared_cursor`。门禁实测：三套 tsc 0 错 + `vitest --maxWorkers=3` **118 文件 / 1787 用例** + `vite build` + 服务端 `ruff`/`pytest` **35 例**全绿；**未动 `electron/`**（水位走 `platform.storage` 未登记 key 的 `misc` 兜底）→ 无需重建产物。**已知限制**：并发分支在**投影层只显示一条链**（见 §5.5 勘误 ②）；远端事件落地后**不**重对齐本机记录器（同源限制） |
| **6 其余欠账 + 数据主权** | C 类文件型资产（记忆段落级 LWW / 身份文件 / 提示词覆盖）；产物内容寻址；导出全部数据 / 删账户；墓碑 GC 30 天 | 段落级 LWW 有单测；导出产物可重新导入；GC 后 pull 不复活已删条目 |

**门禁（沿用并扩展 `nanowork-dev-gate`）**：

- 客户端：三套 `tsc` 0 错误 → `vitest run --maxWorkers=3` 全绿 → `vite build --emptyOutDir false` 绿。
  （批次 4 实测：**115 文件 / 1771 用例**。⚠️ `tests/electron/pluginPackage.test.ts` 在并发跑时曾出现
  `afterEach` 钩子超时，**单跑 51/51 通过** → 判定为环境 flake，与本批无关。）
- 服务端：`ruff check` + `ruff format --check` + **`pytest`**（批次 4 实测 **28 passed**）——与 `nanobot/`
  的测试方式分开（那里是只读参考，**不得**为它加测试依赖）。
- 动了 `electron/`（**批次 3**）→ ✅ 已重建 `main.cjs` + `preload.cjs`（`main.cjs` 309,618 → 314,114 字节，
  `carryOverChannelSecrets` / `injectChannelSecrets` 均在产物中）。**批次 4 未动 `electron/`**（cursor 维持内存、
  `settings.syncMeta` 随 `nanowork.settings` 落盘、会话索引走既有 `rebuildIndex`）→ 无需重建。
  判据：`electron/` 下**没有任何 `.ts` 比 `main.cjs` 新**——用 `-nt` **逐个**比对，别只看 `main.ts`
  （esbuild 是 `--bundle`，所有被 import 的模块都打进了产物）。
- 跨阶段门禁 (c)：token 存储在 Web 端必须有降级路径并**写明**（批次 4 落地：token 走 `platform.storage`
  的**字符串 JSON**，Web 落 localStorage；**刻意不用**凭据保险库——保险库纪律是「值永不回传渲染层」，
  而同步引擎恰恰在渲染层需要 access token）。
- **新增（批次 4）**：门禁①/② **不再依赖「真机跑」**——由 `tests/sync/integration.twoDevice.test.ts`
  的真 spawn `uvicorn` + 双 store 快照夹具承担；真机两实例手测降为补充（§六 #15 的裁决）。

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
