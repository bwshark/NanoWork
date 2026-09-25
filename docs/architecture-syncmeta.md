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
| **2 实体接线** | Agent / ExpertGroup / Task / MCP / Channel 五个 store 接线 + Skill 覆盖表抽离 + 各自的 `version` 升版 | 每个 store 一条「改 → rev+1」「删 → 墓碑且不出现在列表」的用例；**Channel 额外一条：「同步负载不含 `clientSecret` / `appSecret` / `botSecret` / `token`」**（§5.3 定案的可证伪判据） |
| **3 会话与设置** | `indexFile` 写入 `rev` / `updatedBy`；`lib/settingsSync.ts` 的 `toSyncPayload` + 排除表 | 一条「会话重命名后 `rev` 递增」用例；一条「同步负载不含 `gatewayEndpoint` / `apiToken`」用例 |

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

**尚未做（属批次 2/3 —— 别把「地基完成」当成「同步前置换完了」）**：五个 store 的接线与
`version` 升版、Skill 覆盖表抽离、`indexFile` 写入 `rev` / `updatedBy`、`lib/settingsSync.ts`
的 `toSyncPayload` + 排除表；§三 表里 #7 会话元数据只缺 `updatedBy` 的补写也在批次 3。
另：§二 C 类（文件型资产）的段落级 LWW **不在本文范围**，V1.5 另案。

---

## 八、明确不做（写下来是为了防止下一轮又讨论一遍）

- ❌ 不给**事件流**加 `SyncMeta`（A 类，§19.3）。
- ❌ 不在 V1 实现 `SyncEngine` / 网络请求 / 冲突解决 UI——那是 M6（V1.5）。
- ❌ 不在 V1 清理墓碑（GC 依赖跨设备同步状态，V1 无法回答）。
- ❌ 不给 `artifactsStore` 加实体元数据：产物按**内容寻址**同步（§19.3，只传新增 hash），
  它的落点（② `artifacts.json`）与 FR-7.2 的独立产物索引（M4）会一起重做，现在加元数据是白写。
- ❌ 不碰 `pluginsStore`：它没有 storage key（§12.2.1 刻意如此），已安装清单与激活状态都是
  每次从权威重读的**事实**，没有可同步的实体。
