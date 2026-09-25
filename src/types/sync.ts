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
 * `deletedAt` 有非空时间即**墓碑**：删除不摘除数组项，而是打标记（LWW 要求删除可
 * 传播）。代价是每个读取处都要过滤——一律走 `liveEntities()`，别自己写
 * `filter((item) => !item.deletedAt)`。
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

/** 可同步实体的约束形状：`id` + 同步元数据。只用于类型约束，不参与运行时。 */
export interface SyncableEntity extends SyncMeta {
  id: string;
}
