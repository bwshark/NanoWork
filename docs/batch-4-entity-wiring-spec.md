# 批次 4 落地规格 · 实体接线 + 认证 UI + 状态徽章

> **性质**：这是工程实现与 QA 验收的**唯一依据**。每条「裁决」都带理由；每个取舍都给出**可证伪判据**（QA 变异测试按它做）。
>
> **前置事实（不必重证）**：批次 1（`cloud/` FastAPI + auth + `sync_items` + LWW）、批次 2（`src/sync/` 七件）、批次 3（渠道凭据保险库化 + 排除表 + wire 收口）均已落。批次 2 引擎**只注册了 `agents`**，其余全部留到本批。
>
> **本批硬约束**：`src/ai`、`src/stores`、`src/sync`、`tests`、`electron` 用**单引号**；`src/pages` 等 UI 层随该文件现有风格。渲染层**不得 import 'electron'**（走 `src/platform`）。引擎（`src/sync/SyncEngine.ts`）**不得 import 任何 store**，只能经 `syncRegistry`。不得执行 git 写操作。不动 `nanobot/`。**尽量不动 `electron/`**（动了必须重建 `main.cjs`）。

---

> ## ⚠️ 决策勘误（2026-09-28，落地前）：G1 采用 **C2（服务端根因修复）**，**不是** §0.1 推荐的 C1
>
> **已拍板**：G1 走 **C2**。理由：C2 是 `architecture-m6-sync.md` §5.3 的**原文意图**，也是批次 2
> 引擎与类型注释**本来就假设**的行为（`SyncEngine.ts:20/342`、`types.ts:63` 都写「accepted 非空 →
> 再 pull 一次，取回服务端归一后的 `updatedAt`」）——即 §5.3 此前**只实现了一半**。C1 只压症状，
> 且保留「行的服务端时间 vs payload 的客户端时间」两个时钟混比的隐患。
>
> **本批因此新增 `cloud/` 改动（两处，均非新增端点）**：
> 1. `cloud/app/sync/routes.py::push` —— 落库前把 `entity['updatedAt']` **归一为服务端接收时刻**
>    （`iso_z(now)`）再 `json.dumps`，使「pull 下发的也是归一后的值」真正成立；`row.client_updated_at`
>    仍保留客户端上报值供审计。
> 2. 同处 `resolve()` 的 `cmp == 0`（完全同版）分支 —— 若「**除 `updatedAt` 外**负载与已存内容完全相同」，
>    则**幂等跳过**（既不写库、也不推进 `server_seq`、也不进 `accepted`）。
>    **为什么必须加**：客户端 `collectChanges()` 是**全量 push**；归一之后，每一轮空闲同步都会
>    「`cmp==0` → 接受 → 写库 → `seq+1` → 客户端回拉全量 → 本地 `updatedAt` 前移」，形成 **30s 一次的
>    无限写入 + 无限回拉**。跳过之后空闲态才是**真·空转**（不写、不拉、本地不变）。
>
> **对下游的改动**：
> - §0.1 的 **C1 自冲突过滤本批不做**（C2 生效后客户端不再产生自冲突）；
> - §I.3 的变异项 **`C1-1` 作废**，替换为服务端用例（见 `cloud/tests/test_sync.py` 新增两条）；
> - §J 的 **T01 增补 `cloud/app/sync/routes.py` + `cloud/tests/test_sync.py`**，且**必须跑服务端门禁**
>   （`ruff check` / `ruff format --check` / `pytest`，见 skill §1.1）；
> - §J 的 T05 中「`tests/sync/*` 断言 `status==='synced'`（验证 §0.1-C1 生效）」改为「验证归一落库」；
> - §L.1 的两难已解，按 C2 执行；§0.2 的 CORS 一行照做（补 `5176`）。
>
> **已核验的风险面**：`cloud/tests/test_sync.py` 的 8 条用例**无一条**依赖「payload 保留客户端
> `updatedAt`」（`updatedAt` 只在测试夹具 `entity()` 里出现）。已逐条推演 C2 后仍绿：
> `push_then_pull` / `cursor_is_monotonic` / `update_after_first_pull` / `stale_push_reports_conflict` /
> `clock_skew_cannot_hijack` / `payload_isolated_per_user` / `requires_auth` / `entity_without_id_skipped`。

---

## 0. 先决产物：两处必须与本批同期修正的「遗留缺口」（否则门禁①②必然失败）

### 0.1 G1（阻断级）· 空转 push 会被服务端判 stale → 徽章恒 `conflict`

**事实链**（读代码确认，非推测）：
- 服务端 `cloud/app/sync/routes.py::push` 落库时：`row.updated_at = utc_now()`（服务器接收时间），`row.payload = json.dumps(entity)`（**客户端 payload 原样存，不改写 `updatedAt`**）。
- 客户端引擎 `collectChanges()` 是**全量 push**：每轮都把**所有存活实体**重新组装上行（`SyncEngine.ts:279-302`）。
- 于是：改动发生 → 实体的 `updatedAt = T`；push 被接受后服务端行 `updated_at = S`（S 是接收时刻，通常 > T）；**下一轮全量 push 又把同一个 T 送上去**；服务端 `resolve(current, incoming)` 比较 `incoming.updated_at(T)` vs `current.updated_at(S)` → `T < S` → **拒绝（stale）**，回 `conflicts`。
- 引擎 `syncNow()`：`conflictCount = response.conflicts.length` → `status = 'conflict'`。

**后果**：任一次真实改动之后，**每一个空闲同步周期**（默认 30s）都会把每条已推实体判成冲突 → 徽章恒亮 `conflict`，且会连带触发 `conflict` toast。门禁①/②的「登录后一致 / 空闲态稳定」都过不了。

**设计文档的原始意图**：`architecture-m6-sync.md` §5.3 明写「服务端落库时按接收时刻重算并回写……**pull 下发的也是归一后的值**」。但 `push` 只归一了 `row` 的**列**，**没有**把归一后的值写回 payload。也就是说 §5.3 只实现了一半。

**裁决（二选一，推荐 C1）**：

- **C1（本批采用，客户端侧，零 cloud 改动）**：在 `SyncEngine.syncNow()` 的冲突循环里**过滤自冲突**——服务端回传的 `conflict.server` 与「我们这一轮刚推上去的同 `(collection,id)` 实体」在 `(rev, updatedAt)` 上**完全相同**时，这不是真冲突（内容一模一样，只是服务端把接收时间记在了行上），不计数、不 toast、不 `apply`。
  - **理由**：服务端在 stale 分支返回的正是**之前那次被接受的 `row.payload`**，而我们的 payload 自那次以来没变 → 二者逐字段相同。判据落在「版本四要素里的 rev+updatedAt 相同」上，稳定且不需要深比较。
  - **可证伪判据**：`tests/sync/SyncEngine.test.ts` 新增「空转同步（源集合未变 → 服务端返回同版本 stale）→ `result.conflicts === 0` 且 `getSyncStatus().status === 'synced'`」；把这条过滤删掉，用例必须变红。
- **C2（根因修复，作为**建议**记下，本批不作为交付物）**：服务端 `push` 落库前把 payload 的 `updatedAt` 归一为接收时刻（`entity['updatedAt'] = iso_z(now)`）再 `json.dumps`，使 §5.3 成立、自冲突自然消失。**这是根因，但动 `cloud/`**；若产品决定允许动服务端，C2 优先于 C1。

> ⚠️ **C1 不可省**。若 QA 认为「自冲突」是真冲突，请先看本节事实链——它是 `updatedAt` 语义错配的产物，不是两端数据分歧。

### 0.2 G2（阻断级）· Web 端 CORS 未放行 vite 实际端口

`vite.config.ts` 的 dev server 端口是 **5176**（不是 5173）。`cloud/app/main.py::_default_origins` 只放行 `5173 / 5199`。Web 端从 `http://localhost:5176` 打 cloud 会因 preflight（带 `Authorization` + `application/json`）被 CORS 拦。

**裁决**：本批不新增 cloud 端点；但需把 `NANOWORK_CLOUD_ORIGINS` 环境变量（或 `_default_origins` 默认值）**补上 5176**（一行）。这是启动配置而非端点，属「确实需要」的最小 cloud 侧调整。
**判据**：Web 端登录链路 e2e 用例（`tests/pages/auth.test.tsx` 的联调部分）能拿到 200。

---

## A. 其余 collection 的逐条契约

> **通用写法**（引擎冻结契约，本批不重设计）：
> - `read()` 直接 `useXxxStore.getState()` 取 `entities` 与 `tombstones`（**同步**，zustand 特性）；
> - `apply()` 用 `syncRegistry.applyEntity()` 做**键控落地**（墓碑入表 + 从存活数组摘除；存活 upsert + 清同名墓碑），随后 `useXxxStore.setState(...)`。**apply 绝不调用 store 的业务动作**（`updateAgent` 之类会 `rev+1`，污染 incoming 元数据）；
> - `keyOf` 对「墓碑记录」必须容错：`tombstoneEntries()` 产出的是 `{ id: <落点键>, ...meta }`，**不含实体自己的键字段**。故凡「落点键 ≠ `id`」的 collection，`keyOf` 一律写成 `(e) => String(e.<field> ?? e.id)`。
> - `payload()` 一律走显式裁剪函数（白名单/排除表），不裸传实体。

### A.1 `expertGroups` → `src/stores/expertGroupsStore.ts`
| 项 | 值 |
|---|---|
| `collection` | `'expertGroups'` |
| `keyOf` | `(e) => String(e.id)` |
| `read()` | `state.groups`（存活）+ `state.tombstones`（键=id） |
| `apply()` | `applyEntity(state.groups, state.tombstones, entity, keyOf)` → `setState({ groups, tombstones })` |
| `payload()` | `pickSyncable(entity, [])`（`ExpertGroup` 无运行时事实字段） |

**真实 API**：`useExpertGroupsStore.getState().groups` / `.tombstones`；`useExpertGroupsStore.setState({ groups, tombstones })`。`ExpertGroup extends SyncMetaFields`（`src/types/expertGroup.ts:35`），自带 `rev/updatedAt/updatedBy/deletedAt`，无需合成。
**理由**：与 `agents` 样板逐字同构（同 `mergeGroups`+独立墓碑表形态），零特例。

### A.2 `tasks` → `src/stores/tasksStore.ts`
| 项 | 值 |
|---|---|
| `collection` | `'tasks'` |
| `keyOf` | `(e) => String(e.id)` |
| `read()` | `state.tasks` + `state.tombstones` |
| `apply()` | `applyEntity(...)` → `setState({ tasks, tombstones })` |
| `payload()` | `pickSyncable(entity, [])` |

**`runs` 的处理（源码确认）**：`TaskRunRecord[]` 是 `TasksState.runs`（**store 级字段**，不是 `TaskConfig` 的字段，见 `tasksStore.ts:56` 与 `types/task.ts:52-64`）。`read()` 只取 `state.tasks`，`TaskConfig` 里本就**没有** `runs`；`partialize` 里的 `runs`（`tasksStore.ts:441`）只影响本地落盘，**永不进入同步负载**。所以 payload 无需为 `runs` 特判——但**必须在规格里点明**，避免后人把 `runs` 塞进 `TaskConfig`。
**判据**：payload 里断言 `'runs' in payload === false`；往 `TaskConfig` 加 `runs` 字段后该用例变红。

### A.3 `mcp` → `src/stores/mcpStore.ts`
新增到 `src/lib/syncPayloads.ts`（与渠道排除表同处，理由同 syncmeta §7.2）：

```ts
// src/lib/syncPayloads.ts（新增）
export const MCP_SYNC_OMIT_KEYS: readonly string[] = [
  // —— 运行时事实（本机重算，§5.2）——
  'connectionStatus', // 真实握手结果，唯一写入者 testConfig
  'syncStatus',       // 「配置有没有写进**本机**引擎」，本机事实
  'tools',            // 探针缓存（tools/list 产物）
  'lastProbedAt',     // 本机探测时刻
  'lastSyncedAt',     // 本机同步进引擎的时刻
  // —— 本机事实字段 ——
  'authKeyNames',     // 「**本机保险库**里配了哪些凭据名」，跨设备不成立（§5.2 表已列）
  // —— 凭据（成组：id + secret，§5.3）——
  'auth',             // 编辑草稿，值只应存在于本机保险库
];
export function toMcpSyncPayload(config: MCPConfig): Partial<MCPConfig> {
  return pickSyncable(config, MCP_SYNC_OMIT_KEYS);
}
```

| 项 | 值 |
|---|---|
| `collection` | `'mcp'` |
| `keyOf` | `(e) => String(e.id)` |
| `read()` | `state.configs` + `state.tombstones` |
| `apply()` | `applyEntity(...)` → `setState({ configs, tombstones })` |
| `payload()` | `toMcpSyncPayload(entity)` |

**omit 清单的准确性与理由**（读 `types/mcp.ts` + `mcpStore.ts` 确认）：
- `connectionStatus` / `syncStatus` / `tools` / `lastProbedAt` / `lastSyncedAt`：`types/mcp.ts:9`、`:104-118` 明标「运行时事实」；`mcpStore.partialize` 落盘时也把 `connectionStatus` 归零、`syncing→idle`（`mcpStore.ts:507-513`）。
- `authKeyNames`：**§5.2 的表格把它列在「事实（不同步）」**；同 `tools` 一类——它是「本机保险库的 key 名清单」，同步过去会让对端显示「已配置凭据」而其保险库为空（假状态）。
- `auth`：编辑草稿，明文密钥，**严禁上行**（与 `CHANNEL_SYNC_OMIT_KEYS` 剔 `clientSecret` 同口径）。
- **保留**：`id/name/transport/endpoint/urlType/command/disabledTools/enabled/source/description/category/icon/version/createdAt` + 元数据四字段。「声明」类，跨端成立。
**已确认不一致**：任务描述里的 omit 清单是「…/syncStatus/tools/lastProbedAt/lastSyncedAt + auth」，**漏了 `authKeyNames`**。以本节为准（源码 + §5.2 双证）。
**判据**：payload 里断言不含上述 7 个键；把 `MCP_SYNC_OMIT_KEYS` 里的 `auth` 删掉 → 「密钥不上行」用例变红（QA 变异 D-③）。

### A.4 `channels` → `src/stores/channelsStore.ts`（身份裁决见 **B**）
| 项 | 值 |
|---|---|
| `collection` | `'channels'` |
| `keyOf` | `(e) => String(e.kind ?? e.id)`（**墓碑记录无 `kind`，只有 `id=kind`**，见下） |
| `read()` | `state.configs` + `state.tombstones`（**键 = `kind`**） |
| `apply()` | 见下（需保住本机 `id`） |
| `payload()` | `toChannelSyncPayload(entity)`（`src/lib/syncPayloads.ts`） |

**apply 写法（保住本机 `id`）**——引擎已做 `{...local, ...incoming}` 浅合并，`incoming.id` 是对端随机数，会覆盖本机 `id`：
```ts
apply: (entity) => {
  const s = useChannelsStore.getState();
  const key = String((entity as { kind?: unknown }).kind ?? (entity as { id?: unknown }).id);
  const existing = s.configs.find((c) => c.kind === key);
  // 墓碑：原样落地（走 applyEntity 的墓碑分支）；存活：强制本机 id，缺失才 genId
  const merged = isTombstone(entity)
    ? entity
    : { ...entity, id: existing?.id ?? genId() };
  const next = applyEntity(
    s.configs as unknown as SyncEntityRecord[],
    s.tombstones,
    merged,
    (e) => String(e.kind ?? e.id),
  );
  useChannelsStore.setState({
    configs: next.list as unknown as ChannelConfig[],
    tombstones: next.tombstones,
  });
},
```

**理由**：渠道实体身份是 `kind`（`channelsStore.ts:62-69` 明写「墓碑键是 `kind` 而不是 `id`；`id` 只是本地随机数且会被回读重新生成」）。落地若让对端 `id` 覆盖本机 `id`，`setSyncStatus(id,…)`、React key 的稳定性都会被打破；本机 `id` 必须留。

### A.5 `skillOverrides` → `src/stores/skillsStore.ts`
**源码确认**：`SkillOverrideEntry extends SyncMeta`（**非 Partial**，`types/skill.ts:54`），落点是 **`Record` 还是数组**？→ **`SkillOverrideEntry[]`（数组）**，存放于 `SkillsState.overrides`（`skillsStore.ts:36,292`），独立持久化键 `STORAGE_KEYS.skillOverrides`（`constants.ts:130`，落 ① `skills/overrides.json`）。`pinnedIds` 是它的**派生值**（不落盘）。

**tombstone 概念**：**没有**。`types/skill.ts:50-52` 与 `skillOverrideTable.ts:15-19` 明写「把一条覆盖『删掉』的语义是回到默认档 `on`（值的变化，不是删除），直接移除条目即可；`deletedAt` 恒为 `null`」。故本 collection **无墓碑**。

| 项 | 值 |
|---|---|
| `collection` | `'skillOverrides'` |
| `keyOf` | `(e) => String(e.skillId ?? e.id)` |
| `read()` | `state.overrides` + `tombstones: {}`（**返回空表**） |
| `apply()` | `applyEntity(state.overrides, {}, entity, keyOf)` 得到新 `overrides`，再**重算派生视图**（见下）后 `setState` |
| `payload()` | `pickSyncable(entity, [])` |

**apply 必须重算派生视图**（否则 UI 不随落地变化）：
```ts
apply: (entity) => {
  const s = useSkillsStore.getState();
  const { list } = applyEntity(
    s.overrides as unknown as SyncEntityRecord[], {}, entity,
    (e) => String(e.skillId ?? e.id),
  );
  const overrides = list as unknown as SkillOverrideEntry[];
  useSkillsStore.setState({
    overrides,
    skills: applyOverrides(s.skills, overrides),   // @/lib/skillOverrideTable
    pinnedIds: pinnedSkillIds(overrides),          // @/lib/skillOverrideTable
  });
},
```
**理由**：`overrides` 是权威、`skills`/`pinnedIds` 是派生（`skillsStore.ts:146-150` 的 `commitOverrides` 不变量）。落地只改 `overrides` 会让表与视图分叉。
**判据**：pull 一条把 `override` 从 `off` 改回 `on` 的条目后，`skills.find(s=>s.id===x).enabled === true`；漏重算 → 用例变红。

### A.6 `settings` → `src/stores/settingsStore.ts`（单例，**见 C 的完整裁决**）
| 项 | 值 |
|---|---|
| `collection` | `'settings'` |
| `keyOf` | `(e) => String(e.id ?? 'local')` |
| `read()`/`apply()`/`payload()` | 见 **C** |

### A.7 `sessionMeta` → `src/stores/sessionsStore.ts` + 会话索引（**见 D 的完整裁决**）
| 项 | 值 |
|---|---|
| `collection` | `'sessionMeta'` |
| `keyOf` | `(e) => String(e.id)` |
| `read()`/`apply()`/`payload()` | 见 **D** |

### A.8 `sessionEvents` **不在本批**（写明理由）
`sessionEvents`（事件流 `<id>.jsonl`）**不注册**，理由三条（`architecture-m6-sync.md` §四、§5.5）：
1. **策略不同**：它是 **append-only（按 `seq` 游标）**，没有「被改写」这件事。给它走 LWW 是**错误抽象**（§四 末注）。
2. **同步源不同**：它的事实源是 JSONL（经 `@/events` 的 `EventStore`，**异步**），而引擎 `spec.read()` 是**同步**契约——本批接不了（见 D 的同一约束）。
3. **跨设备落点未定**：拉了事件必须落到**本机 `streamWorkdir` 分片**、`seq` 撞号要按事件 `id` 去重 + 按 `seq` 排序保留并集（§5.5），属批次 5 的专门设计。
**判据**：`createDefaultRegistry().entries().map(s=>s.collection)` 断言**不含** `'sessionEvents'`。

---

## B. channels 的统一身份裁决

### B.1 `keyOf` 一律取 `kind` —— 是
**理由**：`channelsStore` 的墓碑键就是 `kind`（`withTombstone(s.tombstones, kind, …)`，`channelsStore.ts:275`、`:245`），而 `configs` 是「一个 `kind` 至多一条配置」（`saveConfig` 用 `configs.find(c => c.kind === partial.kind)` 定位，`channelsStore.ts:232`）。若 `keyOf` 取 `id`，墓碑（键=`kind`）与实体（键=`id`）永远对不上 → 「删掉的渠道下次启动自己回来」（`channelsStore.ts:62-69` 已经把这个坑写死过）。

### B.2 同一 `kind` 会不会有多条？—— 客户端**不会**
**读源码确认**：
- `src/types/channel.ts:28-64` 的 `ChannelConfig` **没有 `instances` 字段**；渠道身份 = `kind`。
- `src/types/channel.ts:6-9` 说「feishu / lark 二者共用 nanobot `feishu` channel，经 `domain` 区分，**多实例经 `instances` 数组并存**」——但那是 **nanobot 引擎侧**的形状，落到客户端被**拍平成两个独立 `kind`**：`ChannelKind = 'dingtalk' | 'feishu' | 'lark' | 'weixin' | 'wecom'`（`channel.ts:19`）。
- `src/ai/runtime/nanobotHttp/channels.ts:70` 写出去时 `domain: cfg.kind`；`:191` 读回来时 `domain==='lark' ? 'lark' : 'feishu'`。即**客户端的 one-config-per-kind ↔ 引擎的 instance-per-domain 是一一映射**：`feishu` 卡片 ≡ `domain='feishu'` 的实例，`lark` 卡片 ≡ `domain='lark'` 的实例。
- `src/lib/channelMeta.ts` 的 `CHANNEL_METAS` 把 `feishu` / `lark` 列为**两个独立 kind**，各自一份表单。

**结论**：客户端**不存在**「一个 `kind` 对应多个实例」的情形（`feishu` 与 `lark` 是两个不同 `kind`，各自一条 store 条目，**不共用**同一个 `channels.feishu.instances[]` 条目）。故 `keyOf = kind` 无互相覆盖风险，**不需要** `kind + domain` 的复合键。

### B.3 `id` 在同步负载里怎么处理
- **上行带 `id` 吗**：**带**（`toChannelSyncPayload` 不剔 `id`；剔的是凭据与运行时事实）。上行带 `id` 无害且必要——服务端要用 `entity.id` 填 `entity_id` 列。
- **落地怎么保住本机 `id`**：`apply()` 里强制 `id = 本机既有 id`（A.4 的写法）。**理由**：对端 `id` 是随机数，覆盖本机 `id` 会打断 `setSyncStatus(id,…)` 寻址与 React key 稳定。
- **为什么不干脆把 `id` 从 payload 剔掉**：剔了则服务端 `entity_id` 落成空串 → 服务端 `push` 的 `if not entity_id … continue` 会**静默跳过该实体**（`routes.py:106`）。所以 `id` 必须在。

### B.4 可证伪判据（QA 变异测试）
- **M-B1**：把 `channels` 的 `keyOf` 改成 `(e) => String(e.id)` → 用例「本机删除渠道 → pull 回同 kind → 该 kind 不出现在 `configs`」**必须变红**。
- **M-B2**：把 `apply()` 里的 `id: existing?.id ?? genId()` 删掉（让对端 `id` 覆盖）→ 用例「pull 覆盖后本机 `configs[i].id` 不变」**必须变红**。
- **M-B3**：断言 `feishu` 与 `lark` 是**两条独立** `configs` 条目（同一次 pull 各自落地）；若误用 `kind+domain` 复合键或把它们合并，用例变红。

---

## C. settings 单例

### C.1 `keyOf`
```ts
export const SETTINGS_SINGLETON_ID = 'local';
keyOf: (e) => String(e.id ?? SETTINGS_SINGLETON_ID),
```
`Settings` 是单例（`settingsStore.setState` 恒改同一个 `settings` 对象），故实体的 `id` 恒为 `'local'`。

### C.2 单例必须有**合成元数据**（引擎要求）
`Settings` **不带** `SyncMeta`（`types/settings.ts:31` 是纯 `Settings`，无 `rev/updatedAt`），而引擎 `stampOf` 用实体上的 `rev/updatedAt/deletedAt` 做 LWW。若不带元数据，则每条 settings 版本的 `updatedAt` 恒为 `''` → 服务端按 EPOCH 处理 → **每条 settings push 都被判 stale**（同 §0.1 的机理，更彻底）。

**裁决**：在 `settingsStore` 增一个**兄弟切片** `syncMeta: SyncMeta`（与其它 store 的 `tombstones` 同类——把「同步元数据」放在实体旁边，而不是塞进 `Settings` 类型污染全局）。

- **为什么不做「重启后给 `updatedAt=now`」的懒补偿**：会在**设备 A 离线期间 B 改过设置**时，A 重启即用「当前时间」压过 B 改动 → **丢失 B 的改动**（门禁②红）。故 `syncMeta` 必须持久化。
- **为什么不新增独立存储 key / 不动 electron**：`settingsStore` 的 `persist.partialize` 已承担落盘，把 `syncMeta` 加进 `partialize` 即可**零 electron 改动、零新 key**（`storageRoutes` 不用改，`main.cjs` 不用重建）。这正是「兄弟切片」相对「独立 key」的优势。
- **为什么 `storageRoutes` 里 `syncMeta` 不需要单独登记**：它随 `nanowork.settings` 一起落 ① `settings.json`。

**`settingsStore` 的改动（v11 → v12）**：
```ts
// state 初值
syncMeta: { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null } as SyncMeta,

// setSettings / setShortcut / resetShortcuts：改动可同步字段 → metaForEdit（@/lib/syncStamp）
setSettings: (patch) =>
  set((s) => ({ settings: { ...s.settings, ...patch }, syncMeta: metaForEdit(s.syncMeta) })),
setShortcut: (id, binding) =>
  set((s) => ({ settings: { ...s.settings, shortcuts: next }, syncMeta: metaForEdit(s.syncMeta) })),
resetShortcuts: () =>
  set((s) => ({ settings: { ...s.settings, shortcuts: {} }, syncMeta: metaForEdit(s.syncMeta) })),

// partialize 增加 syncMeta
partialize: (s) => ({ settings: s.settings, status: s.status, syncMeta: s.syncMeta }),
// migrate：补默认值（老用户没有它）
syncMeta: state?.syncMeta ?? { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null },
```
**哪些动作 bump、哪些不**：只有会改**可同步字段**的 `setSettings` / `setShortcut` / `resetShortcuts` bump。`setStatus`（连接态）、`setWorkspaceAlias` / `rememberWorkspace` / `forgetWorkspace` / `hideSessions`（其字段全在排除表里）**不 bump**。
**判据**：`setStatus('connected')` 后 `syncMeta.rev` **不变**；`setSettings({theme:'dark'})` 后 `rev` **+1**。

### C.3 `read()` / `payload()`
```ts
function settingsEntity(): SyncEntityRecord {
  const { settings, syncMeta } = useSettingsStore.getState();
  return { id: SETTINGS_SINGLETON_ID, ...toSyncPayload(settings), ...syncMeta };
}
read: () => ({ entities: [settingsEntity()], tombstones: {} }),
payload: (e) => e, // 实体已是裁剪后的形态（含 id + 四元数据）
```

### C.4 `apply()` —— 浅合并 + **`transcription` 内层合并**，本机字段绝不可被清空
```ts
apply: (entity) => {
  const inc = entity as Record<string, unknown>;
  const {
    id: _id, rev, updatedAt, updatedBy, deletedAt,
    transcription, ...rest
  } = inc;
  const s = useSettingsStore.getState();
  const nextSettings: Settings = {
    ...s.settings,                                  // 本机字段全部保留
    ...(rest as Partial<Settings>),                 // 只覆盖对端带来的「偏好」字段
    transcription: {                                // ⚠️ 嵌套对象必须内层合并
      ...s.settings.transcription,
      ...((transcription as Partial<TranscriptionConfig>) ?? {}),
    },
  };
  useSettingsStore.setState({
    settings: nextSettings,
    syncMeta: {
      rev: typeof rev === 'number' ? rev : 0,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
      updatedBy: typeof updatedBy === 'string' ? updatedBy : '',
      deletedAt: typeof deletedAt === 'string' ? deletedAt : null,
    },
  });
},
```

**「绝不能被动」清单**（这些字段在 `SETTINGS_SYNC_OMIT_KEYS` / `TRANSCRIPTION_SYNC_OMIT_KEYS` 里被剔，故 payload 不含它们，浅合并天然保留）：
`gatewayEndpoint`、`apiToken`、`desktop`（整块）、`defaultWorkspacePath`、`knownWorkspaces`、`workspaceAliases`、`hiddenSessions`、`transcription.endpoint`、`transcription.apiToken`。

### C.5 `transcription` 特别检查 —— 会清掉吗？
**若不内层合并，会。** `toSyncPayload` 对 `transcription` 做的是**内层裁剪**（返回 `Partial<TranscriptionConfig>`，只含 `enabled`/`model`/`language`，剔 `endpoint`/`apiToken`——`settingsSync.ts:72,86-92`）。落地时若写成顶层浅合并 `{ ...s.settings, ...inc }`，`inc.transcription`（缺 `endpoint`）会**整个替换** `s.settings.transcription` → **对端已配好的 `transcription.endpoint` 被清空**。
**裁决**：`apply()` 里对 `transcription` 必须逐字段内层合并（C.4 已给写法）——照 C.4 写则 `endpoint`/`apiToken` **保留**。
**判据**：本机 `transcription.endpoint='http://local'`，pull 一条 `transcription:{enabled:true,model:'whisper-1'}` → 落地后 `endpoint` **仍为** `'http://local'`；把内层合并删成顶层浅合并 → 用例变红（QA 变异 D-④）。
**同理**：`gatewayEndpoint` 在本机设过值，pull 一条不含它的 settings → 落地后 `gatewayEndpoint` **不变**（判据，QA 变异 D-⑤：把 `apply` 改成整对象替换 → 变红）。

---

## D. sessionMeta

### D.1 读/写的**真实落点**
- **列表**来自**索引** `index/sessions.json`（`SessionIndexFile`，`types/event.ts:482`）；**每条元数据**落在 `<id>.meta.json`（`SessionMeta`，`types/event.ts:374`）。两者**都要读写**，不是二选一：
  - `sessionsStore.loadSessions` 是「**先读索引**（`store.listSessions()`）→ 对每条 `readMeta(id)` → 组装成内存 `sessions`」（`sessionsStore.ts:1347-1371`）；
  - `SessionIndexEntry` 是「`SessionMeta`（可同步字段）+ 三个计数（`eventCount`/`lastSeq`/`messageCount`，**派生物**）」的投影（`indexFile.ts:277-299` 的 `entryFromMeta`）。
- **形状对齐**：`Session`（领域层）↔ `SessionMeta`（落盘权威）↔ `SessionIndexEntry`（列表投影）。`metaToSession`（`project.ts:412`）把 `meta` 还原成 `Session`（`agentId` 的 `'default'` 哨兵还原为空串、`workdir` 取 `meta.workspace ?? meta.workdir`、`streamWorkdir` 取 `meta.workdir`、`permissionMode='full'→fullAccess`）；`sessionSyncMeta.ts` 的 `SESSION_SYNC_FIELDS` 是**可同步白名单**。

### D.2 ⚠️ 引擎约束：`read()` 是**同步**的，而事件存储是**异步**的
引擎 `collectChanges()` / `findLocal()` 都**同步**调用 `spec.read()`。而会话数据在 `EventStore`（`getEventStore()`，全异步）。**因此 sessionMeta 的同步源不能是 EventStore，必须是 `sessionsStore` 的内存快照。**

**裁决**：`sessionsStore` 增一个**兄弟墓碑表** `sessionTombstones: Record<string, SyncMeta>`（与其它 store 的 `tombstones` 同构）：
- `read()`：`entities = useSessionsStore.getState().sessions`（内存快照，已含 `rev/updatedBy/updatedAt`）；`tombstones = state.sessionTombstones`；
- 墓碑来源（填充点）：
  1. `loadSessions` 末尾：`const idx = await store.readIndex();` 取所有 `entries[id].deletedAt` 非空者 → 填 `sessionTombstones`（`readIndex()` 返回**含墓碑**的原始索引；`listSessions()` 才是过滤后的）；
  2. `deleteSession` / `deleteSessions`：`tombstoneSessionStream(s)` 时一并写入 `sessionTombstones[id] = sessionDeletePatch(s)`（并置 `deletedAt`）；
  3. 落地远端墓碑时写入。

### D.3 `keyOf` / `payload()`
```ts
keyOf: (e) => String(e.id),
payload: (e) => {
  const s = e as Partial<Session> & SyncEntityRecord;
  const out: Record<string, unknown> = {
    id: s.id,
    ...pickSyncFields(s as Session),           // SESSION_SYNC_FIELDS 白名单
    rev: s.rev, updatedAt: s.updatedAt, updatedBy: s.updatedBy,
    deletedAt: s.deletedAt ?? null,
  };
  // 显式排除：streamWorkdir 不在 SESSION_SYNC_FIELDS 里，这里再断言一次（防回归）
  return out;
},
```
- `SESSION_SYNC_FIELDS`（`sessionSyncMeta.ts:46-59`）= `title/agentId/groupId/skillIds/workdir/fullAccess/toolApproval/mode/model/channel/readonly/pinned`；
- **`streamWorkdir` 不得上行**：它是**本机事实**（「记录在哪台机器的哪个目录」），白名单已排除；**仍要在 payload 里显式断言**（`expect('streamWorkdir' in payload).toBe(false)`），因为白名单是「用的人知道才不漏」，断言是「改坏了会红」。
**判据**：payload 断言含 `SESSION_SYNC_FIELDS` 全字段 + 四元数据；断言**不含** `streamWorkdir` / `messages` / `permissionLog` / `messageCount` / `memory` / `memoryVersion` / `memoryWorkspace`（QA 变异 D-⑥：把 `streamWorkdir` 加进 payload → 变红）。

### D.4 `read()` 如何把墓碑与存活分开 / `apply()` 如何写回
- **存活**：在 `sessions` 数组里（`deleteSession` 已把它从数组摘掉）。
- **墓碑**：在 `sessionTombstones` 表里（`sessions` 数组**永不含**墓碑）。
- **`apply(entity)` 写回**（同步更新内存 + 异步落盘；`apply` 返回 `void`，落盘 fire-and-forget，与 `tombstoneSessionStream` 同款）：
```ts
// 1) 墓碑分支（isTombstone(entity) === true）
apply: (entity) => {
  const meta = toMetaFromEntity(entity);          // 由 entity 组装 SessionMeta
  if (isTombstone(entity)) {
    void getEventStore().tombstoneSession(meta);  // 写墓碑 + 覆盖索引条目 + 丢弃正文
    useSessionsStore.setState((s) => ({
      sessions: s.sessions.filter((x) => x.id !== meta.id),
      sessionTombstones: { ...s.sessionTombstones, [meta.id]: normalizeMeta(meta) },
    }));
    return;
  }
  // 2) 存活分支：写 meta + 让索引出现该条 + 更新内存
  const next = buildSessionFromMeta(meta);        // streamWorkdir 重定向见 D.5
  void getEventStore().writeMeta(toMeta(next)).then(() => requestIndexRebuild());
  useSessionsStore.setState((s) => ({
    sessions: s.sessions.some((x) => x.id === next.id)
      ? s.sessions.map((x) => (x.id === next.id ? { ...x, ...next } : x))
      : [next, ...s.sessions],
    sessionTombstones: withoutTombstone(s.sessionTombstones, next.id),
  }));
},
```
- **为什么存活分支要 `writeMeta` 后再 `requestIndexRebuild()`**：`EventStore.writeMeta` **只写 `<id>.meta.json`，不动索引**（`electronStore.ts:61`、`webStore.ts:128`）；而 `loadSessions` 的**列表来源是索引**——不重建索引，重启后这条会话**不会出现在列表里**。`writeMeta` + `rebuildIndex`（内部 `entryFromMeta(meta, counters)`）把条目补进索引，**无需新增 IPC、无需动 `electron/`**。
  - `requestIndexRebuild()` = 模块级**防抖**（如 300ms）包一次 `getEventStore().rebuildIndex()`，避免每条落地各重建一次。
  - **已知代价**：重建时该会话无本机 JSONL → `messageCount=0`，本批（事件流未接）该会话在侧边栏「无对话记录的工作空间不显示」规则下可能不显示分组——**可接受**；批次 5 事件流落盘后 `append` 会把它算正。
- **为什么墓碑分支用 `tombstoneSession`**：它一条动作完成「写墓碑 + **覆盖索引条目**（`tombstoneEntry`）+ 丢弃正文」（`store.ts:72`、`webStore.ts:117-124`），正好是删除传播所需的全部。等价的 `writeMeta` 做不到（不动索引）。

### D.5 `workdir` 跨设备裁决（§六 #11）
**裁决**：
1. **`workdir`（语义工作空间，声明）原样保留**——落地时不覆写成默认、不丢弃（§六 #11「保留原值」）。
2. **`streamWorkdir`（落盘分片，事实）在落地时重定向为**「本机默认工作空间」`resolveDefaultWorkspacePath()`（`@/stores/storageInfoStore`）——**绝不用对端的 `workdir`**。
   - 理由：拉来的会话 `streamWorkdir` 为空，`streamShardOf = streamWorkdir ?? workdir`（`sessionsStore.ts:376-378`）会**回退到对端路径**（§5.5 已点名这个后果）。显式写本机 default 分片，批次 5 的事件才会落在本机。
3. **不做**「目标机目录不存在 → 归入默认分组」的异步探测：它需要在 `apply`（同步）里做异步 IO + 改侧边栏分组逻辑，且**门禁①不要求**。作为**已知限制**记下（`workdir` 保留原值，侧边栏按该路径分组；目录不存在时该分组指向一个空目录）。
**判据（可证伪）**：
- pull 一条 `workdir='/remote/path'` 的会话 → 落地后 `session.workdir === '/remote/path'`（原值保留）；`session.streamWorkdir === resolveDefaultWorkspacePath()`（本机）；
- `toMeta(session)` 的 `workdir`（分片）=== 本机 default，`workspace` === `/remote/path`（`project.ts:388-393` 的落盘约定）；
- 把 `streamWorkdir` 改成不重定向（用对端路径）→ 用例「streamWorkdir 不等于对端 workdir」变红（QA 变异 D-⑦）。

---

## E. 首次登录全量 push（§六 #12）

**顺序**：引擎已是**先 pull 再 push**（`SyncEngine.syncNow` 步骤 1 → 2）。确认无需改动。

**唯一裁决**：**不新增 `rev===0` 过滤，也不加引擎开关；依赖「先 pull 再 push」本身。**

**理由（为什么不加过滤）**：
- `rev===LEGACY_REV(0)` 只表示「迁移前、从未被改写过」。老数据的**内容**来自内置定义（`BUILTIN_AGENTS` 等），**多端天然一致**；用户自建条目即便 `rev=0`，其 `id` 是随机数，**跨设备不会键冲突** → 两端 push 后都被接受、都在（并集，无覆盖）。
- 先 pull 再 push 已消除 §六 #12 点名的「后登录的机器覆盖先登录的」：设备 B 登录时**先拉到 A 已推的数据并落地**，再 push——此时 B 的本地内容已与 A 合并（浅合并/键控），不存在「两端各自把 `rev=0` 补齐成 `rev=1/updatedAt=now` 后随机裁决」。
- 若加 `rev===0` 过滤，反而会**长期漏推**：一台设备若始终是唯一登录者，其老数据永远 `rev=0`，就永远不上云。
- 实现落点：**无**（既不在引擎加开关，也不在 payload 过滤）。

**可证伪判据**：
- **E-①**：预置设备 A / B 各含 `rev=0` 的内置 Agent（同 id、同内容）→ A 先登录同步；B 再登录同步 → 两端 `agents` 键控一致，且**无一条被对方覆盖丢内容**。
- **E-②**：把引擎顺序改成「先 push 再 pull」→ E-① 用例必须变红（暴露 #12 的症状）。
- **E-③**：断言 `SyncEngine.syncNow` 中 `client.pull` 的**首次调用**在 `client.push` 之前（spy 调用顺序）。

---

## F. 修正 `SyncRunResult.pulled` 语义（批次 2 遗留）

**问题**：`applyChange` 无论「远端胜、落地了」还是「本地胜、丢弃了远端」都 `return true`（`SyncEngine.ts:388-411`），于是 `applyPull` 的 `pulled` 把**被丢弃的**也算进去了，与注释「本轮 pull 落地的变更条数」（`SyncEngine.ts:69`）不符。

**裁决**：**改返回值语义，不改注释**——`applyChange` 返回「**是否真的改动了本地**」：
```ts
private applyChange(change: SyncChange): boolean {
  const spec = this.registry.get(change.collection);
  if (!spec) return false;
  const incoming = change.entity;
  const key = spec.keyOf(incoming);
  const { entities, tombstones } = spec.read();
  const local = findLocal(entities, tombstones, key, spec.keyOf);

  if (local === null) { spec.apply(incoming); return true; }        // 新条：落地
  const winner = pickWinner(stampOf(local, key), stampOf(incoming, key));
  if (winner === 'remote') {                                        // 远端胜：落地
    spec.apply(isTombstone(incoming) ? incoming : { ...local, ...incoming });
    return true;
  }
  return false;                                                     // 本地胜：丢弃远端，未改动本地
}
```
**理由**：
- 与字段注释（「落地的变更条数」）一致；**注释是对的，实现是错的**。
- 冲突循环里 `this.applyChange({collection, server})` 的返回值**被忽略**（`SyncEngine.ts:339`），改语义不影响冲突落地。
**哪一版更利于门禁②断言**：「真实落地」版。门禁②要断「离线 N 条改动联网后**全部落地**」——`pulled === N` 是**可判别**的正向信号；而「尝试数」版永远 `pulled === response.changes.length`，无论落没落地都为真，**断言无鉴别力**。
**判据**：pull 一批含「1 条新 + 1 条本地更新（远端更旧）」→ `result.pulled === 1`（不是 2）；改回无条件 `return true` → 用例变红。

---

## G. 装配与生命周期接线

### G.1 落点与签名
新增 `src/sync/runtime.ts`（**不**放进 `SyncEngine.ts`，保持引擎零 store 依赖；`index.ts` 只加一行 `export * from './runtime'`）：

```ts
// src/sync/runtime.ts
export interface SyncRuntime {
  account: SyncAccount;
  client: SyncClient;
  registry: SyncRegistry;
  engine: SyncEngine;
  /** 载入已持久化账户并（若已登录）启动调度；App 启动时 await 一次 */
  init(): Promise<void>;
  /** 登录后的启动入口（内部由 account.subscribe 触发，一般不用手调） */
  start(): void;
  /** 登出：停调度 + 复位状态 */
  stop(): void;
  /** 释放：取消所有 store 订阅 */
  dispose(): void;
}

export function createSyncRuntime(opts?: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): SyncRuntime {
  const account = createStorageSyncAccount({ baseUrl: opts?.baseUrl, fetchImpl: opts?.fetchImpl });
  const client = new SyncClient({
    baseUrl: opts?.baseUrl,
    fetchImpl: opts?.fetchImpl,
    getAccessToken: () => account.getAccessToken(),
    refreshAccessToken: () => account.refresh(),
  });
  const registry = createDefaultRegistry();
  const engine = new SyncEngine({ client, account, registry, now: opts?.now, cursorStore: createMemoryCursorStore() });

  // ── 本地变更 → 防抖同步（见 G.3）──
  let suppress = false;      // 同步落地期间抑制，避免「落地 → 订阅 → 再同步」自激
  let missed = false;
  const onChange = (): void => { if (suppress) missed = true; else engine.notifyLocalChange(); };
  const unsubscribers = SUBSCRIBED_STORES.map((store) => store.subscribe(onChange));

  // ── 登录 / 登出 生命周期 ──
  const onSession = (session: AccountSession | null): void => {
    if (session) engine.start();
    else { engine.stop(); resetSyncStatus(); }
  };
  const unsubAccount = account.subscribe(onSession);

  return {
    account, client, registry, engine,
    async init() {
      await account.load();
      if (account.isAuthenticated()) engine.start();
    },
    start: () => engine.start(),
    stop: () => { engine.stop(); resetSyncStatus(); },
    dispose() {
      unsubAccount();
      unsubscribers.forEach((u) => u());
      engine.stop();
    },
  };
}
```

`SUBSCRIBED_STORES` 是包裹 `suppress` 的 `syncNow`：
```ts
async function syncNowGuarded() {
  suppress = true;
  try { return await engine.syncNow(); }
  finally {
    suppress = false;
    if (missed) { missed = false; engine.notifyLocalChange(); } // 同步窗口内的本地改动补一次
  }
}
```
> **注**：`engine.notifyLocalChange` 已内建防抖（默认 1s）且未登录即 no-op，故「订阅过灵」（如 `syncing`/`lastSync` 等运行时字段也触发）只会产生一次合并后的额外同步，无副作用。**必须**的只有 `suppress`（防自激）。

### G.2 登录 `start()` / 登出 `stop()` + `resetSyncStatus()` 的调用点
- **登录成功**：`account.login()` / `register()` → `apply(session)` → `emit()` → `account.subscribe(onSession)` 收到非 null → `engine.start()`。**无需在登录 UI 里手调 `start()`**（订阅是唯一入口，避免「登录 UI 记一次、别处忘了」）。
- **登出**：`account.logout()` → `apply(null)` → `onSession(null)` → `engine.stop()` + `resetSyncStatus()`。
- **App 冷启动已登录**：`runtime.init()` 内 `await account.load()` 触发 `emit()` → `onSession(session)` → `engine.start()`。
- **登出按钮（设置页「账户」分区）**：只调 `runtime.account.logout()`，不手调 stop（同上）。

### G.3 「本地变更 → `notifyLocalChange()`」防抖接入点
**接法：在装配处 `useXxxStore.subscribe(onChange)`**（G.1），订阅 7 个可同步 store：`agentsStore` / `expertGroupsStore` / `tasksStore` / `mcpStore` / `channelsStore` / `skillsStore` / `settingsStore`。（`sessionsStore` 的会话元数据改动也订阅——见下注。）

**为什么这样不会漏**（对比「每个动作调用点手动 notify」）：
- zustand 的 `subscribe` 在**任何 `set`** 后触发——不依赖调用方记得 notify。新增一个 store 动作（如将来加 `duplicateAgent`）**自动纳入**，无需改同步代码。
- 手动 notify 的失败形态是**静默**的：本机一切正常，只是「某次改动换台电脑看不到」；而这类漏点有几十个（各 store 的 CRUD + settings 家族动作），必然漏。
- `suppress` 机制解决「pull 落地 = `set` = 触发订阅 = 再同步」的自激环；`missed` 补一次保证同步窗口内的用户改动不丢。
**注**：`sessionsStore` 的 `updateSession` 会 `set` → 也订阅；会话删除（`deleteSession`）走 `tombstoneSessionStream`（`set` + 异步落盘）→ 订阅同样捕获。
**判据**：`agentsStore.createAgent(...)` 后（登录态、假时钟推进 1s）断言 `fetch` 被调用一次；未登录时断言**零次**。

### G.4 `src/App.tsx` 启动块的接入位置与顺序
现有步骤：`loadSessions` → `storageInfo.refresh` → `getDeviceId()` →（electron）channels 保险库/回读/syncAll + MCP 回读 → channelSessions 轮询。

**接入**：在 **`getDeviceId()` 之后、且 `loadSessions()` 之后**，新增（同一 `useEffect`）：
```ts
void (async () => {
  await getDeviceId();                 // ← 由「void」改为「await」：syncMeta.updatedBy 依赖它
  await useSessionsStore.getState().loadSessions();   // 已在上面调用，这里确保顺序（或将 runtime.init 放其后）
  const runtime = createSyncRuntime();
  syncRuntimeRef.current = runtime;    // 供卸载时 dispose（useEffect 清理函数）
  await runtime.init();
})();
```
并在清理函数里 `syncRuntimeRef.current?.dispose()`。

**相对顺序与理由**：
1. **必须在 `getDeviceId()` 之后**：`settingsStore.syncMeta` 的 `updatedBy`（`metaForEdit` → `currentDeviceId()`）与 payload 的 `updatedBy` 都取设备号；预热未完成则落空串（`syncStamp.ts:20-23` 已说明空串=来源未知）。
2. **必须在 `loadSessions()` 之后**：`runtime.init()` 可能立即 `engine.start()` → pull → 落地 `sessionMeta`；若 `loadSessions` 未完成，内存 `sessions` 为空，落地会与即将水合的列表产生竞态。
3. **与 channels 保险库 / MCP 回读的相对顺序无硬约束**：那两步是「本机事实回读」，与云同步互不写同一字段（渠道 `syncStatus`、MCP 回读都被排除表剔）。放它们之后即可（避免启动首屏抢 IO）。
4. **Web 端同样创建 runtime**（`createStorageSyncAccount` 的 storage 变体在 Web 落 localStorage），只是 channels 回读分支不执行。

### G.5 cursor 是否持久化（§5.1 的 `nanowork.sync.cursor`）
**裁决：本批维持内存（`createMemoryCursorStore()`），不持久化。**
**理由**：
- MVP 是**全量 push**（§5.1）+ `applyChange` **幂等**（`applyEntity` 键控，重复应用结果一致）。重启后 `since=0` **全量 pull** → 逐条按 LWW 落地 → 与「带旧游标」等价（不会漏、不会重）。
- 持久化需登记 `electron/storageRoutes.ts` 的 `RUNTIME_FILES`（新 key `nanowork.sync.cursor`）+ **重建 `main.cjs`**——与「本批尽量不动 electron」冲突，而收益（省一次全量 pull）对几十条实体可忽略。
**若将来持久化**：把 `createMemoryCursorStore()` 换成 `platform.storage` 变体，并在 `RUNTIME_FILES` 登记 `nanowork.sync.cursor`（值形如序号 + JSON），重建 `main.cjs`。**引擎代码不改**（`CursorStore` 接口已就位，`SyncEngine.ts:51-65`）。
**判据**：重启后（模拟）首次 `pull` 的 `since === 0`；落地幂等用例（同一批 pull 应用两次，store 不变）。

---

## H. UI 落点

### H.1 `src/pages/auth/`（登录 + 注册）
**新建**：
- `src/pages/auth/AuthPage.tsx`：邮箱 + 密码，`Tabs`（登录 / 注册）或单页 + 模式切换；提交调 `runtime.account.login(email, pwd)` / `.register(...)`；失败按 `SyncAuthError.status` 提示（401 邮箱或密码错误 / 409 邮箱已注册）。成功后 `useNavigate()(ROUTES.chat)`。
- 复用 `SettingsPrimitives` 的**视觉件**（`SettingsCard` / `SettingsRow`）保持风格一致（本项目设置区已用这套）；页面外层用 `Box` 居中卡片。

**路由结构改法（先看现状）**：
- 路由集中在 `src/router/index.tsx`（`createBrowserRouter`，无独立 route 配置文件；`ROUTES` 常量在 `src/lib/constants.ts:79`）。
- **「未登录不拦截本地使用，只收在同步设置入口」的落法**：
  1. **不引入全局路由守卫**——`/chat`、`/agents`… 全部保持免登录；（否则违反 local-first）
  2. `constants.ts` 加 `ROUTES.auth = '/auth'`；
  3. `router/index.tsx` 的 children 加 `{ path: ROUTES.auth, element: <AuthPage /> }`；
  4. **唯一入口**：设置弹窗「账户」分区里，未登录时一个「登录 / 注册」按钮 → `useNavigate()(ROUTES.auth)` + `useSettingsUiStore.getState().closeSettings()`（关闭弹窗再跳）。可选：徽章 `local` 态点击也跳 `/auth`。
- **为什么用路由页而非弹窗**：设计 §3.3 指名 `src/pages/auth/`；且登录成功后要跳回主界面，路由页天然衔接。**不**把 `/auth` 做成受保护页（它就是登录页本身）。

### H.2 同步状态徽章
**落点：侧栏底部（`src/layout/SidebarNav.tsx`），紧邻「设置」行**——**不是 `TitleBar`**。
**理由（读现有布局确认）**：`TitleBar` 只在 Electron 渲染（`TitleBar.tsx:118` `if (platform.env !== 'electron') return null`），而 Web 端也要看徽章；`SidebarNav` 底部已有一行「设置」（`SidebarNav.tsx:322-337`），徽章放其上/其侧，天然成为「同步状态 + 同步入口」的落点，且两平台一致。

**新建** `src/components/SyncStatusBadge.tsx`：
```tsx
export function SyncStatusBadge() {
  const status = useSyncStatus();                 // @/sync
  const prev = useRef(status.status);
  useEffect(() => {
    if (status.status === 'conflict' && prev.current !== 'conflict') {
      toast.warning('检测到同步冲突：已保留服务端版本，本地改动未丢失');
    }
    prev.current = status.status;
  }, [status.status]);
  // 图标 + 文案按 status.state 渲染；点击 → navigate(ROUTES.auth) 或 openSettings('account')
  return (/* ... */);
}
```
- 消费 `useSyncStatus()`（`SyncStatusState`：`status` / `lastSyncedAt` / `conflictCount` / `lastError`）。
- `conflict` 态：**过渡沿**（非 conflict → conflict）给**一次** `toast`（用 `@/components/Toast` 的 `toast.warning`；`Toast.tsx` API = `toast.info|success|error|warning`），避免每轮重复弹。
- 五态映射：`local`（灰·「未同步」）、`syncing`（旋转）、`synced`（勾·`lastSyncedAt`）、`conflict`（黄·告警）、`offline`（红·`lastError`）。
- 在 `SidebarNav` 底部 `<Box>`（设置行上方）挂 `<SyncStatusBadge />`。

**判据**：`tests/components/SyncStatusBadge.test.tsx`：`setSyncStatus({status:'conflict'})` 触发一次 toast；连续两次相同 state 只弹一次（过渡沿去重）。

### H.3 设置页「账户」分区
**沿用既有组件与风格**（`src/components/settings/sections/*` + `SettingsPrimitives` 的 `SettingsCard/SettingsRow`）。
**新建** `src/components/settings/sections/AccountSection.tsx`；同步登记到三处：
1. `src/stores/settingsUiStore.ts` 的 `SETTINGS_SECTION_IDS` 加 `'account'`；
2. `src/components/settings/settingsNav.tsx` 的 `SETTINGS_NAV` 加一项（建议放「数据与安全」组，图标用 `CloudOutlined`/`SyncOutlined`）；
3. `src/components/settings/SettingsDialog.tsx` 的 `SectionBody` switch 加 `case 'account'`。

**本批只做**：
- 登录态展示：邮箱（`account.getSession()?.email`）、设备 ID（`platform.appInfo()?.deviceId` 或「仅桌面端可见」）、上次同步时间（`useSyncStatus().lastSyncedAt`）、状态徽章；
- 未登录：显示「登录 / 注册」按钮（→ H.1）；
- 登出按钮（`runtime.account.logout()`）。

**批次 6 留位（代码注释写明）**：在分区底部放两张**禁用/占位**卡片或行，并注明：
```ts
// ⚠️ 批次 6：以下两项属数据主权（FR-10.6），本批不实现。
//  - 「导出全部数据」→ 见 batch-6 规格
//  - 「彻底删除账户」→ 见 batch-6 规格
// 位置在此占位，避免批次 6 重新设计版面。
```
**判据**：`tests/pages/auth.test.tsx`：未登录 → 显示入口按钮；登录（假 account）→ 显示邮箱 + 登出；文本含「导出全部数据」「彻底删除账户」占位（断言存在但 disabled）。

---

## I. 测试与验收策略（QA 按此执行）

### I.1 门禁①「两端登录同账户后 Agent / 会话双向一致」自动化
**夹具（§六 #15）**：同一个 uvicorn + 两个隔离的 store / storage 实例。本机有 `cloud/.venv`。

**服务启动**（`tests/sync/integration.twoDevice.test.ts` 的 `beforeAll`）：
```ts
import { spawn, type ChildProcess } from 'node:child_process';
const PY = process.platform === 'win32'
  ? 'cloud/.venv/Scripts/python.exe' : 'cloud/.venv/bin/python';
let server: ChildProcess;
beforeAll(async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanowork-it-'));
  server = spawn(PY, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8910'], {
    cwd: 'cloud',
    env: { ...process.env, NANOWORK_CLOUD_DB_URL: `sqlite:///${path.join(dbDir, 'it.db')}` },
    stdio: 'ignore',
  });
  await waitHealth('http://127.0.0.1:8910/health', 15000);   // 轮询 /health
}, 30000);
afterAll(() => { server.kill(); });
```
（若 `cloud/.venv` 不存在 → `describe.skipIf(!hasVenv)` 跳过，避免 CI 无 Python 时红。）

**两个实例如何隔离**：本项目 store 是**模块级单例**，同进程无法真起「两套并存的 store」。采用**快照 / 换装**法模拟两台设备：
```ts
// tests/helpers/deviceSnapshot.ts
export function snapshotStores(): StoreSnapshot { /* deep-clone 7 store 的同步相关切片 */ }
export function restoreStores(snap: StoreSnapshot): void { /* setState 覆盖回去 */ }
export function resetStoresEmpty(): void { /* 全部置空（新设备） */ }
```
两台「设备」= 两份 `SyncEngine`（各自独立内存 cursor）+ 两套 store 快照，交替换装后调用 `engine.syncNow()`。

**断言（双向一致）**：
1. **设备 A**：置入 `agents=[a1,a2]`、建两个会话（含 title/pinned）→ A 的 engine `syncNow()`（pull→push）。
2. **设备 B**：`resetStoresEmpty()`；用 B 的 engine `syncNow()` → 断言 B 的 `agentsStore.getState().agents`（键控后）与 A **一致**（id/name/enabled）；B 的 `sessionsStore` 含 A 的两个会话（title/pinned 一致，**`streamWorkdir` 已重定向为本机**）。
3. **设备 B 改**：B 建 `a3`、重命名会话 → B `syncNow()`。
4. **设备 A**：`restoreStores(A 快照)`；A `syncNow()` → 断言 A 拿到 `a3` 与会话新标题（**B→A 方向也一致**）。
5. 全程断言 `getSyncStatus().status === 'synced'`（验证 §0.1-C1 生效，无自冲突）。

**真机手测补充（门禁要求「真机跑」）**：两台真机 / 两个 `userData` 目录，同一账户，登录后改 Agent / 会话，看对端出现——**作为 e2e 补充，非替代单测**（§六 #15）。

### I.2 门禁②「离线改 → 联网 → 合并无丢失」自动化
同一夹具，用**注入的 fake fetch** 控制「断网」：
1. A、B 已同步（基线一致）。
2. **A 离线**（`fetchImpl` 抛 `TypeError`）→ A 新增 `aX`；**B 在线**→ B 新增 `aY` 并 `syncNow()`（推上 `aY`）。
3. **A 联网** → A `syncNow()`（先 pull 到 `aY` 并落地，再 push `aX`）→ 断言 A 同时有 `aX`、`aY`（**无丢失**）。
4. **B 同步** → 断言 B 同时有 `aX`、`aY`。
5. **同一实体的并发改**（LWW 边界，显式断言而非回避）：A、B 都改 `a1.name`（B 的 `updatedAt` 更大）→ 合并后两端 `a1.name === B 的版本`（LWW 一致），且 `a1` 未消失。
**判据**：步骤 3/4 断言两个 id 都在（键控并集）；把「先 pull 再 push」打乱 → A 步骤 3 会丢掉 `aY` → 变红。

### I.3 逐 collection 的变异测试清单（改坏实现 → 用例必须变红）
| # | 目标 | 变异（改坏） | 必须变红的用例 |
|---|---|---|---|
| D-① | agents/expertGroups/tasks/mcp | `keyOf` 改成常量（如 `() => 'x'`） | 「两条独立实体各自落地、不互相覆盖」 |
| D-② | 通用 | `apply` 里改用 store 业务动作（如 `updateAgent`）而非 `applyEntity` | 「pull 落地后 `rev` 等于 incoming（未被 +1）」 |
| D-③ | mcp | 从 `MCP_SYNC_OMIT_KEYS` 删 `auth` | 「payload 不含 `auth`（密钥不上行）」 |
| D-④ | settings | `apply` 的 `transcription` 改顶层浅合并 | 「pull 后 `transcription.endpoint` 保留」 |
| D-⑤ | settings | `apply` 改整对象替换（`setState({settings: inc})`） | 「pull 后 `gatewayEndpoint`/`knownWorkspaces` 保留」 |
| D-⑥ | sessionMeta | `payload` 加 `streamWorkdir` | 「payload 不含 `streamWorkdir`」 |
| D-⑦ | sessionMeta | `apply` 存活分支不重定向 `streamWorkdir` | 「落地后 `streamWorkdir === 本机默认工作空间`」 |
| D-⑧ | sessionMeta | 墓碑分支改用 `writeMeta`（不 `tombstoneSession`） | 「pull 墓碑后该会话从列表/索引消失」 |
| B-1 | channels | `keyOf` 改成 `id` | 「删除渠道不复活」 |
| B-2 | channels | `apply` 不保本机 id | 「pull 后本机 `id` 不变」 |
| F-1 | 引擎 | `applyChange` 恒 `return true` | 「本地更新时 `pulled` 不 +1」 |
| C1-1 | 引擎 | 去掉自冲突过滤 | 「空转同步 `conflicts === 0`」 |
| E-② | 引擎 | 先 push 再 pull | 门禁②步骤 3 变红 |
| G-1 | runtime | 去掉 `suppress` | 「pull 落地不再触发额外同步」的自激环用例 |
| G-3 | runtime | 去掉 store 订阅 | 「createAgent 后 1s 内 fetch 被调用」 |

### I.4 单元用例落点（新增）
- `tests/sync/syncRegistry.batch4.test.ts`：7 个 collection 的 `read/apply/payload` + 墓碑 + 键控（含 A.1–A.7 判据）。
- `tests/sync/settingsSingleton.test.ts`：C.4/C.5（合并、transcription 内层、本机字段保留）+ C.2（rev bump 规则）。
- `tests/sync/sessionMetaSync.test.ts`：D.3–D.5（payload 白名单/排除、墓碑读写、workdir 裁决）。
- `tests/sync/SyncEngine.batch4.test.ts`：F（pulled 语义）+ §0.1-C1（自冲突过滤）+ E（pull 先于 push）。
- `tests/sync/integration.twoDevice.test.ts`：I.1 / I.2（`skipIf(!hasVenv)`）。
- `tests/components/SyncStatusBadge.test.tsx`、`tests/pages/auth.test.tsx`。

---

## J. 任务分解（依赖有序，≤5 个任务）

| 任务 | 内容 | 依赖 | 优先级 |
|---|---|---|---|
| **T01 基础设施/契约修正** | `src/lib/syncPayloads.ts`（+`MCP_SYNC_OMIT_KEYS`/`toMcpSyncPayload`）；`src/sync/SyncEngine.ts`（F 的 `pulled` 语义 + §0.1-C1 自冲突过滤）；`src/lib/constants.ts`（+`ROUTES.auth`）；`src/stores/settingsStore.ts`（+`syncMeta` 切片，v12）；`src/stores/sessionsStore.ts`（+`sessionTombstones` + `applyRemoteSessionMeta`/`applyRemoteSessionTombstone` + `loadSessions` 填充 + 导出 `sessionMetaOf`） | — | P0 |
| **T02 注册表接线** | `src/sync/syncRegistry.ts`（注册 A.1–A.7 共 7 个 spec，含 channels 身份与 settings 单例） | T01 | P0 |
| **T03 装配与生命周期** | `src/sync/runtime.ts`（`createSyncRuntime` + store 订阅 + suppress/missed + 账户生命周期）；`src/sync/index.ts`（+导出）；`src/App.tsx`（接入 + 顺序 + dispose） | T02 | P0 |
| **T04 认证 UI** | `src/pages/auth/AuthPage.tsx`；`src/router/index.tsx`（+`/auth`）；`src/components/settings/sections/AccountSection.tsx`；`settingsNav.tsx` / `settingsUiStore.ts` / `SettingsDialog.tsx` 登记 account 分区 | T03 | P0 |
| **T05 状态徽章 + 测试** | `src/components/SyncStatusBadge.tsx` + `SidebarNav.tsx` 挂载；`tests/sync/*`（I.3/I.4 用例）+ `tests/components/SyncStatusBadge.test.tsx` + `tests/pages/auth.test.tsx` | T03,T04 | P1 |

## K. Shared Knowledge（跨任务约定）
- 所有可同步实体的**元数据四字段**语义统一：`rev`（新建=1，迁移前=0）、`updatedAt`（ISO UTC）、`updatedBy`（`currentDeviceId() ?? ''`）、`deletedAt`（非空=墓碑）。
- 引擎 `spec.read()` **同步**；`spec.apply()` **同步写内存 + 异步 fire-and-forget 落盘**（会话）。
- **`apply` 只走 `applyEntity` + `setState`，绝不调 store 业务动作**（避免 `rev` 被 +1）。
- `keyOf` 对墓碑记录必须容错（`e.<field> ?? e.id`）。
- 单引号：`src/sync`、`src/stores`、`src/lib`、`tests`、`electron`。UI 层（`src/pages`、`src/components`）**随该文件现有风格**（`SettingsDialog`/`GeneralSection` 用单引号，`TitleBar` 用双引号——**新建文件与该目录邻近文件一致**）。
- 渲染层不得 import 'electron'；引擎不得 import store；不动 `nanobot/`；`cloud/` 仅 §0.2 一行 origins。

## L. Anything UNCLEAR（假设与风险）
1. **§0.1 自冲突是真实缺陷**（已给事实链）。若产品坚持「不碰 `SyncEngine`」，则改为 **C2**（服务端补全 §5.3）——二者**必居其一**，否则门禁①/②恒红。
2. **`workdir` 不存在时的「归入默认分组」**（§六 #11 后半）**本批不实现**（需异步探测 + 改侧边栏分组）；只实现「`streamWorkdir` 重定向到本机 default」。标记为已知限制。
3. **会话 `messageCount` 本批不同步**：拉来的会话在事件流（批次 5）落地前 `messageCount=0`，可能在侧边栏「无对话不显示分组」规则下暂不可见；门禁①断言的是**store/索引级一致**，不含侧边栏可见性。
4. **settings 的 `syncMeta` 需升 `settingsStore` 版本到 v12**：会影响既有 `settingsStorage.test.tsx`（若它锁了 version？已核：不锁）；迁移函数必须补 `syncMeta` 默认值。
5. 本批**不动 `electron/`**（cursor 内存、settingsMeta 随 settings 落盘、会话索引走 `rebuildIndex`）→ **无需重建 `main.cjs`**。若后续为 cursor/settingsMeta 新增独立 storage key，则必须重建。
