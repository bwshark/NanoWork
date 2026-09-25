/**
 * 同步元数据（design §19.2 / ADR-006）。
 *
 * ## 为什么 V1 就要有它
 *
 * V1 **不实现同步**，但 V1 创建的实体必须当场带上这四个字段。V1.5 的 SyncEngine
 * 按 `(collection, entityId)` + `rev` 做 LWW，实体里没有版本就只能二选一：全量数据
 * 迁移（有丢数据的风险），或在同步层补字段——后者那条分支会**永久**留在同步代码里。
 *
 * ## 四个字段要么一起有，要么一起没有
 *
 * 单加 `rev` 或单加 `deletedAt` 都是半成品，而且失败形态是**静默**的：读取方不会
 * 报错，只会按「无版本」处理，等接同步时才暴露「所有实体的 rev 都是空的」。
 * `SessionMeta` 正是这个形态（`rev` / `deletedAt` 早已声明，写入侧一个都没接）。
 *
 * ## 不属于本接口的东西
 *
 * - **追加型数据**（会话事件流 `<id>.jsonl`）：按 `seq` 游标追加，没有「被改写」
 *   这件事，给它 `rev` 是错误抽象（§19.3）。
 * - **文件型资产**（记忆 / 身份文件 / 提示词覆盖 / 插件包）：它们的「版本」是文件
 *   `mtime` 或段落时间，塞进实体元数据没有承载者，属 V1.5 另案。
 * - **运行时事实字段**（`MCPConfig.status` / `ChannelConfig.syncStatus` / 索引的
 *   `eventCount`）：本机重算，同步过去只会得到假状态，见 `lib/syncSelect.ts`。
 */

/**
 * 实体的同步元数据。
 *
 * `deletedAt` 有非空时间即**墓碑**。存储层有两种形态，取决于实体怎么存的：
 *
 * - **内联在实体上**（`SessionMeta` / `SessionIndexEntry` 这类逐条落文件的记录）：
 *   删除只置 `deletedAt` 并保留条目，读取处走 `liveEntities()` 过滤。
 * - **拆出独立的墓碑表**（`Agent` / `TaskConfig` / `MCPConfig` / `ChannelConfig`
 *   这类 store 数组）：条目被真正摘除，删除痕迹记在 `SyncTombstones` 里。见该类型的
 *   说明——这是落地时对 §19.2 原始方案的修正。
 */
export interface SyncMeta {
  /**
   * 版本号。新建为 1，每次改动 +1。
   *
   * `0` 是**保留值**，表示「迁移前的老数据、从未被改写过」：V1.5 首次全量推送据此
   * 识别需要补齐的对象。缺字段一律按 0 读，**不按 1**——按 1 会让老数据看起来
   * 「已经被改过一次」，与真新建的条目撞车，而 LWW 正是靠这个数判谁更新。
   */
  rev: number;
  /** 最后修改时间（ISO 8601） */
  updatedAt: string;
  /** 最后修改者的设备标识，见 `lib/deviceId.ts` */
  updatedBy: string;
  /** 删除时间；`null` = 存活 */
  deletedAt: string | null;
}

/**
 * 同步元数据的**输入**形态：允许缺字段。
 *
 * 迁移前的老实体（`SessionMeta` / 索引条目等）只有其中一部分、甚至一个都没有，
 * 而读侧与写侧都要吃得下——所以 `markDirty(meta, …)` 这类函数的入参是它。
 */
export type SyncMetaInput = Partial<SyncMeta>;

/**
 * 实体接口上的同步元数据字段（`Agent` / `TaskConfig` / `MCPConfig` … 用它 `extends`）。
 *
 * **刻意是可选形态**，与 `SessionMeta` 的既有声明一致，原因有二：
 * - 老数据的四字段一个都没有，必填会逼着每处 `migrate` 凭空造一份；
 * - 内置条目（`BUILTIN_AGENTS` / `MCP_SERVERS` 等）的真源是**代码**，它们的元数据
 *   只有在用户改动过该条目时才存在（见 `markDirty` 的「老数据按 `LEGACY_REV` 读」）。
 *
 * 与 `SyncMetaInput` 是同一个类型、两个名字：一个说「函数入参」，一个说
 * 「实体字段」，读代码时不必在两处语义间做翻译。
 */
export type SyncMetaFields = Partial<SyncMeta>;

/** 可同步实体的约束形状：`id` + 同步元数据。只用于类型约束，不参与运行时。 */
export interface SyncableEntity extends SyncMeta {
  id: string;
}

/**
 * 墓碑表：`实体 id → 该条目的删除元数据`（`deletedAt` 必为非空）。
 *
 * ## 为什么墓碑不与存活条目放在同一个数组里
 *
 * §19.2 的原始方案是「删除时置 `deletedAt` 并保留数组项」，文档自己也点出了代价
 * （「漏一处就是删不掉的幽灵条目」）。落地时撞上两个更硬的约束：
 *
 * 1. **数组里的墓碑会被合并函数冲掉**。`agentsStore.refresh()` 走
 *    `mergeAgents(get().agents)`，而合并产出只含「内置 + 存活用户条目」
 *    （`pickMeta` 只搬元数据，不搬条目）——于是每次启动都会把墓碑洗净、再写回
 *    持久化，删除标记活不过一次重启。要修就得让三个合并函数同时管「合并内置」
 *    与「保留墓碑」两件事，而这两件事没有任何关系。
 * 2. **读取处远不止「十几个」**。实测五个 store 的 UI 读取点有二十余处；在
 *    selector 里内联过滤（`useStore((s) => liveEntities(s.agents))`）每次 store
 *    变动都产出新数组引用，要么给每处补 `useShallow`、要么放任多余重渲染——
 *    两条路都要改二十多个文件，且漏一处是静默的。
 *
 * 拆表之后：存活数组**天生只含存活条目**（UI 与合并函数都不必知道墓碑的存在），
 * 删除只在这张表里留痕，同步层把两者拼起来即完整负载（`tombstoneEntries()`）。
 * `liveEntities()` 因此只服务**内联形态**（会话索引，批次 3）。
 *
 * 代价要写清楚：墓碑**不保留条目正文**，只留 `id` + 元数据。LWW 下删除只按
 * `(id, rev)` 传播，正文对判决无用；而「删除后引用的历史消息仍要能显示名称」这类
 * 需求，靠的是消息自己的快照，不是实体。
 */
export type SyncTombstones = Record<string, SyncMeta>;
