# SyncMeta 落地清单（V1 前置增量架构）

> **文档性质**：增量架构文档（Increment）。范围 = v2 第 19.2 节「V1 必须先落 `SyncMeta`」的
> **实施落点清单**，不新增需求编号、不改需求语义。
>
> **唯一事实源**：`nanowork-prd-design-v2.md`。本文与它冲突以它为准；与**代码**冲突以代码为准。
>
> **收口目标**：并入 v2 第 19.2 节（同步元数据）与第 18.2.3 节（三条收敛原则）。
>
> **依据**：ADR-006「V1 实体即带 `SyncMeta`」、§19.2、§19.3、FR-10.1（P1）、FR-10.5。

---

## 一、为什么这份清单必须现在产出

§19.2 已经把「什么时候做」讲死了：**V1 不实现同步，但 V1 的实体必须带同步元数据**。
晚做的代价不是「多写一遍代码」，而是二选一：全量数据迁移（有丢数据的风险），
或在同步层做字段补齐（逻辑分支**永久**污染同步代码）。

现状是**半分落地**，这是最坏的状态——看起来有：

| 位置 | 现状 |
|---|---|
| `src/types/event.ts:416 / 460` | `SessionMeta` 与 `SessionIndexEntry` 声明了 `rev?: number` / `deletedAt?: string \| null` |
| `src/events/indexFile.ts:176-177` | `normalizeSessionMeta` 会**读**这两个字段 |
| `src/events/indexFile.ts:292 / 377` | 索引与元数据写出时会**透传** `meta.rev` |
| 全仓 | **没有任何写入点**。`updatedBy` 字段根本不存在 |

也就是说：读取路径已经按「有同步元数据」的形状写好了，而写入路径一个都没接。
这比完全没做更危险——`rev` 恒为 `undefined` 时读取方不会报错，只会静默按「无版本」处理，
等 V1.5 接同步时才暴露「所有实体的 rev 都是空的」。

**一个已经就位的地基**：`electron/storageRoutes.ts:78` 已有 `DEVICE_ID_STORAGE_KEY`
（② `<userData>/device-id.txt`），并通过 `platform.getAppInfo().deviceId` 暴露
（`TitleBar.tsx` / `AboutSection.tsx` 已在展示）。`updatedBy` 的来源不需要新造。

---

## 二、三类数据 × 三种同步策略（§19.3 的落地口径）

给实体加 `SyncMeta` **不是**对所有数据都适用的。按 §19.3 先分类，再决定加什么：

| 类别 | 数据 | 策略 | 是否加 `SyncMeta` |
|---|---|---|---|
| **A 追加型** | 会话事件流（`projects/<slug>/<id>.jsonl`） | 按 `seq` 游标追加同步，天然无冲突 | ❌ **不加**。给它加 `rev` 是错误抽象——追加型数据没有「被改写」这件事 |
| **B 可变实体** | Agent / 专家团 / Task / Connector / Channel / Skill 覆盖态 / 会话元数据 / Settings | LWW + tombstone | ✅ **加** |
| **C 文件型资产** | 记忆（`MEMORY.md` / `<workdir>/.nanowork/memory/`）、身份文件、提示词覆盖、插件包 | 段落级或文件级 LWW（比时间戳），按内容寻址传 hash | ⚠️ **不加实体字段**。它们的「版本」是文件的 `mtime` / 段落时间，塞进实体元数据没有承载者 |

> **推论**：本文只处理 B 类。C 类要在 V1.5 单独设计（段落级 LWW 见 §19.3 的
> 「按 `##` 分块比较 `modified_at`」），不属本文范围，但**要在 §19.2 收口时显式记为待办**，
> 否则容易误以为「SyncMeta 落完，同步就没前置了」。

---

## 三、落点清单

`markDirty` 语义统一为：`rev += 1`、`updatedAt = now()`、`updatedBy = deviceId`。
新建时 `rev = 1`、`deletedAt = null`；删除时只写 `deletedAt`，**不移除数组项**（见第五节）。

### 3.1 需加 `SyncMeta` 的实体

| # | 实体 | 类型文件 | Store | 持久化 key | 磁盘落点 | 现有时间字段 | 需补字段 | `markDirty` 调用点 |
|---|---|---|---|---|---|---|---|---|
| 1 | `Agent` | `types/agent.ts` | `agentsStore` | `nanowork.agents` | ① `experts/agents.json` | `createdAt` | `updatedAt` `rev` `deletedAt` `updatedBy` | `createAgent` / `updateAgent` / `removeAgent` / `toggleAgent` |
| 2 | `ExpertGroup` | `types/expertGroup.ts` | `expertGroupsStore` | `nanowork.expertGroups` | ① `experts/groups.json` | `createdAt` | 同上 | `createGroup` / `updateGroup` / `removeGroup` / `toggleGroup` |
| 3 | `TaskConfig` | `types/task.ts` | `tasksStore` | `nanowork.tasks` | ② `tasks.json`（过渡） | `createdAt` | 同上 | `addTask` / `updateTask` / `removeTask` / `toggleTask` |
| 4 | `MCPConfig` | `types/mcp.ts` | `mcpStore` | `nanowork.mcp` | ① `mcp.json` | **无** | `createdAt` + 上述四项 | `addConfig` / `updateConfig` / `removeConfig` / `toggleMcp` / `setMcpEnabled` / `setToolDisabled` |
| 5 | `ChannelConfig` | `types/channel.ts` | `channelsStore` | `nanowork.channels` | ① `channels.json` | `lastSyncAt`（**本地事实**） | `createdAt` `updatedAt` + 四项 | `saveConfig` / `removeConfig` / `setEnabled` / `disconnectChannel` / `refreshFromNanobot` |
| 6 | Skill **覆盖态** | `types/skill.ts` | `skillsStore` | `nanowork.skills` | ① `skills/index.json` | — | 见 §3.2 特别说明 | `setSkillOverride` / `toggleSkill` / `setSkillEnabled` / `toggleSkillPin` / `installSkill` / `removeSkill` |
| 7 | 会话元数据 | `types/event.ts`<br>`SessionMeta` + `SessionIndexEntry` | `src/events/indexFile.ts` | —（`projects/<slug>/<id>.meta.json` + `index/sessions.json`） | ① / ② | `createdAt` `updatedAt` **已有** | **只缺 `updatedBy`**；`rev` / `deletedAt` 已声明，补写入即可 | `writeSessionMeta` / 索引更新处（`indexFile.ts:292` / `:377` 的上下文）——`renameSession` / `togglePinSession` / `setSessionMode` / `setSessionModel` / `setSessionWorkdir` / `deleteSession` / `deleteSessions` 全部经此 |
| 8 | `Settings` | `types/settings.ts` | `settingsStore` | `nanowork.settings` | ① `settings.json` | — | **字段级处理，见 §3.3** | `setSettings` / `setShortcut` / 各 `set*` 偏好动作 |

### 3.2 特别说明：Skill 只同步「覆盖态」，不同步扫描结果

`skillsStore` 的 `partialize` 是 `{ skills, pinnedIds }`，而 `skills` 数组里混了两种东西：

- **事实**：从 `~/.nanowork/skills` 与 `<workspace>/skills` 扫出来的技能清单
  （`name` / `description` / `allowedTools` / `path`…）——它由磁盘决定，**多端自然一致**，
  同步它等于把「扫描结果」当成可变实体，是错的；
- **用户意图**：`override`（三态覆盖）与 `pinnedIds`——**这个才是要同步的**。

**建议**：不要给整个 `Skill` 加 `SyncMeta`，而是把覆盖态抽成一张独立的可同步表：

```ts
/** 可同步的技能覆盖表（`skillId` → 用户意图 + 同步元数据） */
type SkillOverrideEntry = SyncMeta & {
  skillId: string;
  override: SkillOverride;
  pinned: boolean;
};
```

这样 V1 只加一个 `nanowork.skillOverrides` 键（落 ① `skills/overrides.json`），
既不动现有的扫描/热加载链路（`scanSkillsDir` / `fs.watch` / `skills:changed`），
也不会在同步时把本机路径（`Skill.path`）这个**机器专属字段**带上云端——
后者正是 FR-10.5 明确禁止的。

### 3.3 `Settings` 的字段级排除清单（FR-10.5）

`Settings` 是**唯一一个不能整体加 `SyncMeta` 的实体**：它一个对象里同时装着
「用户偏好」与「本机环境」。要求实现一个纯函数裁剪同步负载：

```ts
// src/lib/settingsSync.ts
export function toSyncPayload(settings: Settings): Settings;
```

**必须排除（机器专属）**：

| 字段 | 为什么 |
|---|---|
| `gatewayEndpoint` / `apiToken` | 指向本机网关；同步过去会把对方的客户端指向你的机器（FR-10.5 明文点名） |
| `transcription.endpoint` / `transcription.apiToken` | 同上，且 `apiToken` 是凭据 |
| `desktop.*` | 托盘 / 全局热键 / 开机自启是**本机能力**，Web 端只有占位 |
| `defaultWorkspacePath` | 本地路径，跨设备无意义（各机目录结构不同） |
| `knownWorkspaces` / `workspaceAliases` | 键是**绝对路径**，跨设备不成立 |
| `hiddenSessions` | 见 §六 待确认问题 2 |

**保留（用户偏好）**：`theme` / `memoryEnabled` / `autoSummarize` / `promptDomain` /
`promptStyle` / `userCustomPrompt` / `sidebarCollapsed` / `shortcuts` / `enabledPlugins`。

> `enabledPlugins` 值得单独一句：它同步的是**意图**（§12.2.1 已确立「事实在引擎侧」），
> 插件包本体由各设备自行安装，这条与 FR-3.9「只同步启用态、不同步包本体」天然一致。

---

## 四、新增共享件

| 文件 | 内容 | 为什么单独抽 |
|---|---|---|
| `src/types/sync.ts` | `SyncMeta` 接口 + `SyncableEntity` 约束类型 | §19.2 给定的四字段目前只以**内联可选字段**的形式散在 `event.ts` 里；抽成单一来源，避免第三个实体再抄一遍 |
| `src/lib/syncMeta.ts` | 纯函数：`stampCreate(updatedBy)` / `markDirty(meta, updatedBy)` / `markDeleted(meta, updatedBy)` / `isTombstone(meta)` | 与 `storageRoutes.ts` / `skillOverrides.ts` 同一条纪律：**纯逻辑不碰 IO，可真单测**；四个字段一旦各处手写，一定会漂移 |
| `src/lib/syncSelect.ts` | `liveEntities<T>(list)`（过滤墓碑）、`pickSyncable<T>(entity, omitKeys)`（剔除运行时事实） | 见第五节：墓碑过滤是**必须集中**的一件事 |
| `src/lib/deviceId.ts` | `getDeviceId()`：Electron 取 `platform.getAppInfo().deviceId`；Web 端见 §六 待确认问题 1 | `updatedBy` 的来源，两侧行为要显式而不是各自 `?? 'unknown'` |

---

## 五、三个非显然的实现约束（改之前必读）

### 5.1 删除语义要从「移除」改成「留墓碑」

现状 `removeAgent` / `removeGroup` / `removeTask` / `removeConfig` 都是**过滤掉数组项**。
LWW 同步要求删除能被传播，因此必须改为「置 `deletedAt` 并保留记录」。

**代价是真实的**：一旦保留墓碑，**每一个读取处都要过滤**，否则删掉的 Agent 会
重新出现在列表里。这就是为什么上表把 `liveEntities()` 抽成共享件而不是让各页面自己写
`filter((a) => !a.deletedAt)`——13 个消费方各写一遍，漏一处就是「删不掉的幽灵条目」。

**V1 阶段只打标记、不清理**：GC 策略（保留 N 天后删墓碑）依赖「所有设备都已同步到该墓碑」
这个 V1 无法回答的问题，归 V1.5。V1 只保证墓碑写进去了。

> ⚠️ **落地时改了一处（2026-09-25，详见 §7.2）**：store 数组那五个实体**没有**采用
> 「条目留在数组里 + 每个读取处过滤」，而是**把墓碑拆成独立的 `SyncTombstones` 表**
> （`types/sync.ts`），存活数组天生只含存活条目。上面这段「每一个读取处都要过滤」的
> 代价因此只剩**内联形态**——会话。改动理由：数组里的墓碑会被合并函数
> 冲掉，且 UI 读取点有二十余处。
>
> ⚠️ **会话那一路的结局（2026-09-25 记，2026-09-27 已补做）**：会话当时只落到了「元数据写入」
> （`rev` / `updatedBy`），**删除墓碑没有做**——`deleteSession` 当时是三件套全删，没有可留墓碑的载体。
> **该缺口已于 2026-09-27 补齐**：新增契约方法 `tombstoneSession(meta)`（写墓碑 + 覆盖索引条目 +
> 丢弃 JSONL 正文，保留 meta 与索引条目），硬删 `removeSession` 只留给「空会话搬迁分片」这类
> 物理移动。三个存储实现（内存参照 / Web 分片 / Electron 主进程）与 `events:tombstone` IPC
> 全部落地，详见 §7.4。

### 5.2 运行时事实字段必须从同步负载剔除

同一个实体里混着**声明**与**事实**，只有声明该同步：

| 实体 | 声明（同步） | 事实（**不同步**，本机重算） |
|---|---|---|
| `MCPConfig` | `name` / `transport` / `endpoint` / `command` / `urlType` / `disabledTools` / `enabled` | `tools` / `lastProbedAt` / `status` / `authKeyNames` |
| `ChannelConfig` | `kind` / `enabled` / `allowFrom` / `groupPolicy` / `topicIsolation` | `lastSyncAt` / `syncStatus` / **全部凭据字段**（见 §5.3） |
| `TaskConfig` | `name` / `schedule` / `prompt` / `agentId` / `status` / `runOptions` | （无，`runs` 不在持久化负载内） |
| `SessionIndexEntry` | 元数据字段 | `eventCount` / `lastSeq` / `messageCount`（**索引是派生物**，§9.4 已定性为可再生） |

`status` / `syncStatus` 这类字段跨设备同步会得到一个「本机从未探测过、却显示 connected」
的假状态——与 §12.4.2 里「假连接测试」是同一个错误。用 `pickSyncable()` 显式列 omit 键，
而不是靠记得。

### 5.3 凭据不同步，且这条已经在实现里了

`MCPConfig.auth` 是**编辑草稿**，真值在主进程加密保险库
（`~/.nanowork/connectors/.credentials.v3.json`），`partialize` 已剔除。
`ChannelConfig` 的 `clientSecret` / `appSecret` / `botSecret` / `token` **目前是明文落
`channels.json`**——同步前必须先解决「凭据是否随同步上行」，否则 V1.5 一开同步就等于把
渠道密钥发到云端。

**已定案（2026-09-25）：不上行。** V1.5 开同步时，这批字段整体进入 `ChannelConfig` 的
同步排除表，与 `MCPConfig.auth` 同一口径。

**V1.5 未实现之前，渠道凭据维持现状**：不做「迁移进主进程保险库」的改造，
`channels.json` 明文存储**不动**。理由有二：迁移要触及渠道的读写链路（`saveConfig` /
`refreshFromNanobot` / `toNanobotChannels` / 引擎 `config.json` 合并），改错的代价是
**渠道直接不可用**，而渠道可用性在 V1 阶段是硬需求；再者，**只要同步不发生，明文存储
不产生新的暴露面**（它与今天的行为完全一致）。

凭据保险库化与同步排除表**同期**在 V1.5 一次性落地，届时一并切换。

---

## 六、待确认问题（含推荐答案）

| # | 问题 | 推荐答案 | 理由 |
|---|---|---|---|
| 1 | Web 端没有设备标识（`deviceId` 只有 Electron 有），`updatedBy` 填什么？ | Web 在 `localStorage` 生成并持久化一个 uuid（键名与 Electron 复用 `nanowork.deviceId`，两侧存储介质不同不冲突） | 与 Electron 语义对齐；不能填 `'web'` 常量——多台浏览器会共用同一个 `updatedBy`，LWW 的「谁改的」就失去意义 |
| 2 | `settings.hiddenSessions`（从侧边栏移除的会话 id 列表）同步吗？ | **不同步**（列入 §3.3 排除表） | 它描述的是「本机上我看见什么」。会话在各设备的可见性本就不同（比如某台只用了 3 天），同步它会让对方凭空少一批条目 |
| 3 | `ChannelConfig` 的渠道密钥是否随同步上行？ | **✅ 已定案（2026-09-25）· 不上行**：V1.5 开同步时把渠道凭据迁进主进程保险库并加入同步排除表；**V1.5 之前维持明文现状、不做迁移**，保证渠道可用（详见 §5.3） | 与 `MCPConfig.auth` 的处理保持一致；现在它是明文落 `channels.json` 的。保险库化会触及渠道读写链路，V1 阶段为此冒险的收益为负 |
| 4 | `rev` 从 1 还是 0 起？ | **从 1 起**（`rev = 0` 保留表示「迁移前的老数据、从未被改写过」） | 老数据迁移时给 `rev: 0` 即可区分「历史遗留」与「新建」，便于 V1.5 首次全量推送时识别需要补齐的对象 |
| 5 | 老数据迁移放在 `migrate` 里还是读取时补？ | 放在各 store 的 `migrate`（`settingsStore` 已到 v11、`skillsStore` v2、`channelsStore` v2，继续升版） | 与既有 11 次迁移同一套机制；读取时补会永久留下一批「看起来没迁移过」的分支 |

---

## 七、分批实施与门禁

| 批次 | 内容 | 完成判据 |
|---|---|---|
| **1 地基** | `types/sync.ts` + `lib/syncMeta.ts` + `lib/syncSelect.ts` + `lib/deviceId.ts` + 单测 | ✅ **已完成（2026-09-25，见 §7.1）**：纯函数单测覆盖 `markDirty` 递增、`markDeleted` 幂等、`isTombstone`、`liveEntities` 过滤 |
| **2 实体接线** | Agent / ExpertGroup / Task / MCP / Channel 五个 store 接线 + Skill 覆盖表抽离 + 各自的 `version` 升版 | ✅ **已完成（2026-09-25，见 §7.2）**：五个 store 各一条「改 → rev+1」「删 → 墓碑且不出现在列表」；Channel 另有「同步负载不含 `clientSecret` / `appSecret` / `botSecret` / `token`」「引擎回读不复活已删渠道」 |
| **3 会话与设置** | `indexFile` 写入 `rev` / `updatedBy`；`lib/settingsSync.ts` 的 `toSyncPayload(settings)` + 排除表 | ✅ **已完成（2026-09-25，见 §7.3）**：一条「会话重命名后 `rev` 递增」用例（含「没改元数据就不涨版本」三条反向护栏）；一条「同步负载不含 `gatewayEndpoint` / `apiToken`」用例 |

**门禁（沿用 `nanowork-dev-gate`）**：三套 `tsc` 0 错误 → `vitest run --maxWorkers=3` 全绿
→ `vite build --emptyOutDir false` 绿。**动了 `electron/storageRoutes.ts`（新增
`skills/overrides.json` 路由）必须重建 `main.cjs`**，否则 Electron 下新路由静默缺失。

### 7.1 实施进度

**批次 1（地基）已完成 · 2026-09-25**

落地文件：`src/types/sync.ts`（`SyncMeta` / `SyncMetaInput` / `SyncableEntity`，已在
`src/types/index.ts` 登记）、`src/lib/syncMeta.ts`、`src/lib/syncSelect.ts`、`src/lib/deviceId.ts`；
用例 `tests/lib/{syncMeta,syncSelect,deviceId}.test.ts`（36 例）。

门禁：三套 `tsc` 0 错误 / `vitest run --maxWorkers=3` **94 文件 1531 用例全绿** /
`vite build --emptyOutDir false` 24.45s exit=0。**未动 `electron/`，故无需重建 `main.cjs`。**

实现时**细化**了本文三处——原表述照做会真的写错，一并记下：

| 处 | 本文原表述 | 实际落地 | 为什么 |
|---|---|---|---|
| 墓碑判据 | 「`deletedAt !== null` 即墓碑」 | **非空字符串才算墓碑**（`tombstoneOf`，`normalize` 与 `isTombstone` **共用**它） | `''` 这类脏值会让两处判据分叉成一个**永远删不掉**的条目（读侧说「不是墓碑」、写侧说「已经是了」）。方向也刻意选「读成存活」：条目照常显示、数据还在可恢复，好过凭空消失而用户看不出原因 |
| `markDirty` 与墓碑 | （未提） | **不清 `deletedAt`** | 编辑一条已删条目不得让它复活；复活须是显式动作（V1 没有），否则对端会收到「删了又出现」的抖动，而它在 LWW 下与「新增一条同名条目」无法区分 |
| `deviceId` 形状 | 「Web 端在 `localStorage` 生成 uuid」 | 另加 **`currentDeviceId()` 同步读数** + `src/App.tsx` 启动预热 `void getDeviceId()` | store 的写动作是**同步**的，标记 `markDirty` 时拿不到 Promise。与 `PromptLibrary` / `IdentityService` 同构（读盘异步、取用同步，见 skill §7.6 不变量 2）。未预热时返回 `null` 而**不是**空串——调用方据此延后写入 |

**批次 1 已钉住的可证伪判据**（都在用例里，不是「应该没问题」）：

- `markDirty` 对老数据得 `rev = 1`（不是 2、不是 `NaN`）；脏 `rev`（`NaN` / 字符串 / `null` / `Infinity`）同样按老数据读。
- `markDeleted` 幂等：对已墓碑条目再删一次，`rev` 与 `deletedAt` 都不动。
- `liveEntities` 与 `isTombstone` 同源：`deletedAt` 缺字段 / `null` / `''` 均算**存活**。
- `pickSyncable` 剔除凭据（`clientSecret` / `appSecret` / `botSecret` / `token`）与运行时事实（`tools` / `lastProbedAt` / `status` / `authKeyNames`）——§5.3 与 §5.2 的单元级对应物。
- `getDeviceId` 并发只生成一个 id 且只写一次存储；Electron 分支**不生成、不写存储**。

**尚未做（本文范围之外，V1.5 前必须补）**：
**会话删除的墓碑**（`deleteSession` / `deleteSessions` 至今是「JSONL + meta + 索引条目」三件套全删，
没有可留墓碑的载体）。详见 §7.3 的「明确未做」一节——它与 §二 C 类（文件型资产）的段落级
LWW 一起归 V1.5 另案。

**至此本文 §三 表格的 8 个实体全部落位**（1–6 见 §7.2，7–8 见 §7.3）。

### 7.2 批次 2（实体接线）已完成 · 2026-09-25

落地的 store 与版本号：

| Store | 持久化 key | `version` | 删除形态 | 墓碑键 |
|---|---|---|---|---|
| `agentsStore` | `nanowork.agents` | 1（新增） | 摘除 + 墓碑 | `id` |
| `expertGroupsStore` | `nanowork.expertGroups` | 1（新增） | 摘除 + 墓碑 | `id` |
| `tasksStore` | `nanowork.tasks` | 不变（无旧数据形态变化） | 摘除 + 墓碑 | `id` |
| `mcpStore` | `nanowork.mcp` | 1（新增） | 摘除 + 墓碑 | `id` |
| `channelsStore` | `nanowork.channels` | 2 → **3** | 摘除 + 墓碑 | **`kind`** |
| `skillsStore` | `nanowork.skills` v2 → **3**；新增 `nanowork.skillOverrides` | 3 | 覆盖表无墓碑（值变化） | — |

新增共享件：`src/lib/syncStamp.ts`（store 专用的三个带设备标识的标记入口）、
`src/lib/skillOverrideTable.ts`（覆盖表的纯函数）、`src/lib/syncPayloads.ts`（云端负载裁剪）。

用例：`tests/stores/syncMetaWiring.test.ts`（16 例）、`tests/lib/syncPayloads.test.ts`（6 例）。

门禁：三套 `tsc` 0 错误 / `vitest run --maxWorkers=3` **96 文件 1554 用例全绿** /
`vite build --emptyOutDir false` 23.39s exit=0。**动了 `electron/storageRoutes.ts`
（新增 `skills/overrides.json` 路由），已重建 `main.cjs` + `preload.cjs`**，
并核对新路由字符串确实进了产物（不重建则 Electron 下新路由静默缺失、界面上看不出异常）。

> 全量首次运行时 `tests/electron/{pluginPackage,workspaceMemoryStore}.test.ts` 各有 1 例
> `afterEach` 清理钩子超时（Windows 并发下的文件删除争用）；单独复跑 68 例全绿，
> 复跑全量亦全绿——与本次改动无关，属环境抖动（已核：两文件不触及本次改动的任何模块）。

实现时**细化**了本文五处——原表述照做会真的写错：

| 处 | 本文原表述 | 实际落地 | 为什么 |
|---|---|---|---|
| §5.1 删除语义 | 「置 `deletedAt` 并保留数组项」，代价是「每一个读取处都要过滤」 | **墓碑拆成独立 `SyncTombstones` 表**，存活数组只含存活条目 | 两个硬约束：① 数组里的墓碑会被**合并函数冲掉**——`agentsStore.refresh()` 走 `mergeAgents(get().agents)`，合并产出只含「内置 + 存活用户条目」，于是每次启动都把墓碑洗净再写回，删除标记活不过一次重启；② UI 读取点实测二十余处，在 selector 里内联过滤每次 store 变动都产出新数组引用，要么给每处补 `useShallow`、要么放任多余重渲染，两条路都要改二十多个文件且漏一处是静默的 |
| §5.2 墓碑键 | （未提） | `channelsStore` 的墓碑键是 **`kind`** 而不是 `id` | 渠道的实体身份是 `kind`（一卡一配置），而 `id` 是本地随机数且**回读会重新生成**（`fromNanobotChannels` 每次 `genId()`）。按 `id` 键控时回读侧永远匹配不上墓碑——症状是「删掉的渠道下次启动自己回来了」。已用一条「引擎回读不复活已删渠道」用例钉住 |
| §5.3 凭据排除 | 「`clientSecret` / `appSecret` / `botSecret` / `token` 四个字段进排除表」 | **凭据对成组剔除**：连 `clientId` / `appId` / `botId` 一起剔 | 只剔 secret 会同步出一条「有 id、没密钥」的渠道——看着配好了、实际永远连不上，而界面上看不出差在哪，比什么都不留更难查 |
| §5.3 适用范围 | （未提） | **引擎负载 ≠ 云端负载**：`channelsStore.syncAll` 提交给引擎的片段**必须带凭据**，§5.3 约束的只是云端同步负载 | 引擎靠凭据连 IM，少一个 `appSecret` 渠道直接不可用。两者字段清单重叠但不相同，故各一处显式声明（`nanobotHttp/channels.ts` / `lib/syncPayloads.ts`），并在两处都写了「别把裁剪套到对面」的注释 |
| §3.3 落点 | `src/lib/settingsSync.ts` 的 `toSyncPayload` | 先落成 `src/lib/syncPayloads.ts`（渠道），批次 3 的 settings 并入**同一文件** | 两个同构文件（都是「实体 → 可上云负载」）会各自演化，排除表也就有了两个家。放一处，改的人一次只看一张表 |

另有三处 store 内的具体决定（都写进了用例）：

- **运行时事实不推进 `rev`**：`mcpStore.setStatus` / `testConfig` 的探测结果（`status` /
  `tools` / `lastProbedAt`）不算「用户改过这条配置」——否则每点一次「测试」就涨一次版本号，
  LWW 的「谁改的更新」会被探测噪声淹没。但实测到的 `urlType` 是**声明**，那一次要标记。
- **墓碑 id 不被引擎镜像重放复活**：`tasksStore.addTask` 遇到「该 id 有墓碑」时返回 `null`
  并**不写入**（返回值类型从 `TaskConfig` 变成 `TaskConfig | null`）。放在 store 层而不是
  让调用方各自判断——`cronTaskMirror` 与历史消息重放都会走它。
- **技能覆盖表是用户意图的唯一来源**：`skills` 降为**派生视图**（事实 + 覆盖表合成），
  `pinnedIds` 由覆盖表派生且**不落盘**（落盘就是第二份真相，症状是「点过置顶、重启后顺序变了」）。
  「回到默认档」写 `override: 'on'` 而**不是删条目**——删除与「从来没有过」在数据上无法区分，
  而 LWW 需要能比较新旧；只有「技能本身已卸载」才真删条目（否则是一条指向不存在技能的僵尸）。

**批次 2 已钉住的可证伪判据**（都在用例里）：

- 五个 store 各一条「建 1 → 改 2 → 删 3」，且删除后**列表里查不到**、墓碑表里查得到。
- `channelsStore`：墓碑键等于 `kind`（`Object.keys(tombstones)` 断言，不是「看着像」）；
  引擎回读已删渠道返回 `false` 且列表仍为空；重新配置同 kind 会清掉旧墓碑。
- `mcpStore`：写入 `status` 后 `rev` **不变**。
- `skillsStore`：改档 `rev+1`；置顶 `rev+1` 且**不改覆盖档、不推引擎**；卸载清条目；
  重新安装把档位拉回 `on`（保留置顶）；v2 老数据迁移**只抽有意图的条目**且 `rev = 0`。
- `syncPayloads`：排除表里的键在负载里一个都不能有，且负载不能被剔到只剩几个键
  （反向护栏，防「把排除表写成全集」也算通过）；同时守一条边界——提交给引擎的片段**带凭据**。

### 7.3 批次 3（会话与设置）已完成 · 2026-09-25

落地文件：

| 文件 | 内容 |
|---|---|
| `src/lib/sessionSyncMeta.ts`（新增） | 可同步字段白名单 `SESSION_SYNC_FIELDS`（12 个）、`sessionMetaChanged`、`sessionSyncPatch` / `sessionCreatePatch` / `withSessionSync` |
| `src/lib/settingsSync.ts`（新增） | `toSyncPayload(settings)`、`SETTINGS_SYNC_OMIT_KEYS`、`TRANSCRIPTION_SYNC_OMIT_KEYS`、`SettingsSyncPayload` |
| `src/types/event.ts` | `SessionMeta` / `SessionIndexEntry` 各补 `updatedBy`（**两个都补**，理由见下） |
| `src/types/session.ts` | `Session` 补 `rev` / `updatedBy`（内联形态） |
| `src/events/indexFile.ts` | `normalizeSessionMeta` 读 `updatedBy`；`entryFromMeta` / `applyAppend` 透传 |
| `src/events/project.ts` | `metaToSession` 透传 `rev` / `updatedBy`（回读路径） |
| `src/stores/sessionsStore.ts` | `toMeta` 透传两个字段；`createSession` 落 `rev = 1`；**`updateSession` 自动维护** |

用例：`tests/lib/sessionSyncMeta.test.ts`（22 例）、`tests/lib/settingsSync.test.ts`（10 例）、
`tests/sessionsSyncMeta.test.ts`（8 例，走真实 store + 内存事件存储的集成链路）。

门禁：三套 `tsc` 0 错误 / `vitest run --maxWorkers=3` **99 文件 1594 用例全绿** /
`vite build --emptyOutDir false` 17.13s exit=0。**未动 `electron/`，故无需重建 `main.cjs`。**

实现时**细化**了本文四处——原表述照做会真的写错：

| 处 | 本文原表述 | 实际落地 | 为什么 |
|---|---|---|---|
| §七 批次 3 落点 | `indexFile` 写入 `rev` / `updatedBy`（把「写」放在索引层） | 递增点落在 **`sessionsStore.updateSession`**，`indexFile` 只负责**透传** | 索引是**可再生派生物**，它没有「改过几次」的记忆——重建一次（版本不符 / 文件损坏时会发生）就无从知道该写几。递增必须挂在有状态的地方：渲染层的会话对象。索引只照抄 |
| §3.1 第 7 行 `markDirty` 调用点 | 列了七个动作名（`renameSession` / `togglePinSession` / `setSessionMode` / …） | **不逐个标记**，而是**比较改动前后的可同步字段**，真的变了才打脏 | 这七个动作＋未来新增的都从 `updateSession` 走。逐个手写必然漏，而漏掉的后果是**静默**的（本地一切正常，换台设备才发现少了一次改动）。自动判定另有一个收益：改**记忆快照**（`loadMemoryInto` 也走 `updateSession`）不会涨版本——否则每开一次会话就涨一版，`rev` 退化成「打开过几次」的计数器 |
| §3.3 落点 | 同节既写 `src/lib/settingsSync.ts`，§7.2 的表格又写「并入 `syncPayloads.ts` 同一文件」 | **独立成 `src/lib/settingsSync.ts`** | 文档自相矛盾，取 §3.3 的路径。更实际的理由：Settings 的裁剪有一块**嵌套**处理（`transcription` 要保住 `enabled` / `model` / `language`，只剔 `endpoint` / `apiToken`），与 `pickSyncable` 的**顶层**语义不同构；放同一文件会让「两个实体共用一套规则」的错觉更强 |
| §3.3 排除表 | 把 `transcription.endpoint` / `transcription.apiToken` 列为「必须排除」 | 顶层排除表里**没有** `transcription`，它单独走 `TRANSCRIPTION_SYNC_OMIT_KEYS` | `pickSyncable` 只做顶层浅拷贝：在顶层 omit 掉 `transcription` 会连同三个正当偏好一起扔掉（语音开关是跨设备成立的偏好）。而内层字段又不能顶层表达，所以拆两张表 |
| §5.2 运行时事实 | 只点名 `eventCount` / `lastSeq` / `messageCount` 三个索引计数 | 白名单**额外排除** `streamWorkdir` | 它是「这条会话的记录落在**哪台机器的哪个目录**」——本机事实，且各机路径不同。它与 `workdir` 必须分开看：后者是用户选的语义工作空间（是声明，保留同步），前者是落盘分片（是事实，不上云） |

另有两处具体决定（都写进了用例）：

- **凭据是「省略」而不是「置空」**：`transcription.endpoint` / `apiToken` 从负载里**消失**，
  而不是写成 `''`。省略 = 不参与同步、对端保留自己的本机值；置空会把对端配好的地址清掉。
- **`SessionIndexEntry` 也补 `updatedBy`**（而不只是 `SessionMeta`）：索引是「meta + 计数」的投影，
  重建时 `entryFromMeta` 直接照抄。只给 meta 加字段的话，一次重建就会把同步元数据整批洗掉，
  而界面上看不出异常——直到下次同步发现所有会话的 `rev` 都回到缺省值。

**批次 3 已钉住的可证伪判据**（都在用例里）：

- 「新建 → `rev = 1`」「重命名 → 落盘 meta 的 `rev = 2` 且 `updatedBy` 是当前设备号」。
- 连续三次改动（重命名 / 置顶 / 换模式）得到 `rev = 4`——**逐次累加**，不是每次从 1 重数。
- 三条反向护栏：改标题为**同一个值**不涨版本；刷记忆快照（`memory*`）不涨版本；
  改 `streamWorkdir` 不涨版本。
- 白名单逐条核对：`streamWorkdir` / `messageCount` / `memory*` / `messages` / `permissionLog`
  一个都不在 `SESSION_SYNC_FIELDS` 里；11 个可同步字段逐条断言「改了就算改过」。
- 技能挂载按**顺序**比较（`['x','y']` ≠ `['y','x']`）；`undefined` 与 `[]` 不同义。
- `settings`：`gatewayEndpoint` / `apiToken` / `desktop` / 三个路径字段 / `hiddenSessions`
  都不在负载里；`transcription` 里三个偏好字段**在**、两个机器字段**不在**；
  排除表逐条反向核对 + 「负载不能被剔到只剩几个键」的反向护栏。

### 7.4 会话删除墓碑（2026-09-27 补做 · 原「明确未做」项的收口）

本文 §3.1 把 `deleteSession` / `deleteSessions` 列在 `markDirty` 调用点上，2026-09-25 的三批
**没有做**。当时记下的现状与原因（保留以便追溯）：

- 会话删除当时是「JSONL + meta + 索引条目」**三件套全删**，没有可留墓碑的载体。改成墓碑要
  保留 meta 与索引条目、只删 JSONL，于是多出一种**「有 meta、无 JSONL」**的新形态，需要逐一
  审计 `listMetas` / `rebuildIndex` / `loadSessions` / `isEventStreamSession` 四条读取路径；
  `removeSession` 是主进程实现的整体删除，还要新增一个渲染层可调的入口
  （动 `electron/eventStore.ts` + 三个存储实现 + preload + `platform/types.ts`）。
- 收益**只在 V1.5 兑现**：V1 没有同步层，墓碑不产生任何用户可感知的变化；当时就写 `deletedAt`
  等于给一条暂时无人读的字段承担上面全部风险。
- 读取侧当时已就绪：`SessionIndexEntry.deletedAt` 已在 `listSessionEntries` 里过滤、
  `normalizeSessionMeta` 也容错读到它——**只差写入侧**。

**2026-09-27 补齐**。落地形状与上面的预估有三处不同，都是照预估做会写错的地方：

| 处 | 原预估 | 实际落地 | 为什么 |
|---|---|---|---|
| 新能力 | 「渲染层可调的**写墓碑**入口」 | **一个方法做完三件事**：`tombstoneSession(meta)` = 写墓碑 meta + 覆盖索引条目 + **丢弃 JSONL 正文** | 拆成「写 meta + 删正文」两次调用会留下中间态：只写了 meta（正文还在 → 下次同步把正文当新内容推上去），或只删了正文（索引条目没墓碑 → **重启后会话复活**）。顺序也不能反 |
| 索引更新 | 未提 | **必须显式投影进索引**（新增纯函数 `tombstoneEntry`） | `listSessions()` 读的是**索引条目**上的 `deletedAt`，而 meta 文件只在 `rebuildIndex` 时才影响索引。不写索引 = 「删了 → 重启 → 又回来」，且界面上看不出任何异常 |
| 旧 `removeSession` | 改造成软删 | **保留为硬删**，只给「空会话搬迁分片」（`setSessionWorkdir`）用 | 搬迁要删的是**旧分片**的整套文件（含旧索引条目）；改成软删会让会话搬完后从列表里消失 |

落地清单（12 个文件）：契约 `EventStore.tombstoneSession(meta)` × 3 个实现（内存参照 / Web 分片 /
Electron 主进程）+ `events:tombstone` IPC 三件套（`electron/main.ts` / `preload.ts` /
`platform/types.ts`）+ 会话侧 `sessionDeletePatch()`（`lib/sessionSyncMeta.ts`，包 `metaForDelete`
以保证**墓碑幂等**）+ `sessionsStore` 的 `dropSessionStream` → `tombstoneSessionStream`。
**动了 `electron/` → 已重建 `main.cjs` + `preload.cjs`**。

**可证伪判据**（都在用例里，不是「应该没问题」）：

- 契约测试对**两个实现**各跑一遍：墓碑**当场**进索引、正文丢弃、meta 保留、
  「重建索引后 `listSessions()` 仍为空」；并断言**计数照抄既有条目**而非重算成 0
  （正文已丢，重算等于抹掉「这条曾有很多消息」）。
- `tests/electron/eventStore.test.ts` 在**真实临时目录**上断言 JSONL **从盘上消失**
  （`existsSync` 由 true → false，前一条断言先证明它本来在盘上，否则「不在了」是空断言），
  且重建索引后条目仍带 `deletedAt`。
- `tests/sessionsStore.test.ts` 断言 `deleteSession` 后墓碑落盘（`deletedAt` + `rev > 0`）
  且索引当场生效、重建不复活。
- `tests/events/electronStore.test.ts` 断言软删走**独立通道**，`eventsRemove` 一次都没被调到
  （复用硬删通道会把墓碑当场抹掉，删除又变回不可传播）。

---

## 八、明确不做（写下来是为了防止下一轮又讨论一遍）

- ❌ 不给**事件流**加 `SyncMeta`（A 类，§19.3）。
- ❌ 不在 V1 实现 `SyncEngine` / 网络请求 / 冲突解决 UI——那是 M6（V1.5）。
- ❌ 不在 V1 清理墓碑（GC 依赖跨设备同步状态，V1 无法回答）。
- ❌ 不给 `artifactsStore` 加实体元数据：产物按**内容寻址**同步（§19.3，只传新增 hash），
  它的落点（② `artifacts.json`）与 FR-7.2 的独立产物索引（M4）会一起重做，现在加元数据是白写。
- ❌ 不碰 `pluginsStore`：它没有 storage key（§12.2.1 刻意如此），已安装清单与激活状态都是
  每次从权威重读的**事实**，没有可同步的实体。
