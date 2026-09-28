/**
 * 跨端同步（M6 / V1.5 批次 2）**客户端同步引擎**的契约类型与常量。
 *
 * ## 与谁对齐
 *
 * 这里的每个形状都以服务端代码为**唯一权威**（不是以文档）：
 * - `PushResponse` / `PullResponse` ← `cloud/app/sync/routes.py` 的 `PushResponse` /
 *   `PullResponse`（两者都带 `cursor: int`，`pull` 的 `since` 也是 `int`）。
 * - `AccountSession` ← `cloud/app/auth/routes.py` 的 `TokenPair`
 *   （`{ access, refresh, user: { id, email } }`）。
 *
 * 文档与代码不一致时以代码为准，并回到这里改类型——线上字段是运行时的真相。
 *
 * ## 为什么 `cursor` 是 number 而不是 ISO 时间
 *
 * `cursor` 是服务端**变更流序号**（`sync_items.server_seq`，单调递增），与实体的
 * `rev` / `updatedAt` **解耦**。混用会导致漏数据：实体版本可能不推进（比如只改了
 * 被 `pickSyncable` 裁掉的字段），而它依然需要被对端拉走。所以 `pull(since: number)`
 * 传的是序号，不是时间。
 */

/**
 * 已登记同步的 collection 名（§四 collection 契约表的客户端侧类型）。
 *
 * 引擎按 `(collection, entityId)` 索引，**不**依赖这张联合类型做运行时分发——
 * 未知字符串会被静默跳过（前向兼容：老客户端拉到一个新 collection 不应崩）。
 * 它只用于约束本批与后续批次登记的 collection 名拼写。
 */
export type SyncCollection =
  | 'agents'
  | 'expertGroups'
  | 'tasks'
  | 'mcp'
  | 'channels'
  | 'skillOverrides'
  | 'settings'
  | 'sessionMeta'
  | 'sessionEvents';

/** 一次变更：`collection` 名 + 该实体的完整负载（已过 `spec.payload` 裁剪）。 */
export interface SyncChange {
  collection: SyncCollection | string;
  entity: Record<string, unknown>;
}

/**
 * 服务端判定「客户端推送版本更旧」时回传的服务端版本。
 *
 * `server` 是服务端**当前落库的整条实体**（`json.loads(row.payload)`），客户端据此
 * 按 `syncRegistry` 的**浅合并**语义落地（§六 #9），而不是整条替换。
 */
export interface PushConflict {
  collection: string;
  id: string;
  server: Record<string, unknown>;
  resolution: string;
}

/**
 * `POST /api/sync/push` 的响应。
 *
 * `accepted` 是**实体 id 列表**（不是整条实体）；`cursor` 是本次 push 后服务端的
 * 变更流序号——push 之后要回拉一次（`pull(cursor)`），把服务端归一后的 `updatedAt`
 * 取回来（§5.3：`updatedAt` 以服务端接收时间为准）。
 */
export interface PushResponse {
  accepted: string[];
  conflicts: PushConflict[];
  cursor: number;
}

/** `GET /api/sync/pull?since=<cursor>` 的响应。 */
export interface PullResponse {
  cursor: number;
  changes: SyncChange[];
}

/**
 * 同步状态（供标题栏徽章 / 设置页「账户」分区订阅）。
 *
 * - `local`：未登录或纯本地，完全不参与同步（local-first 兜底，设计 §5.4）；
 * - `syncing`：正在 pull/push；
 * - `synced`：本轮同步完成且无冲突；
 * - `conflict`：有实体被服务端版本覆盖（徽章 + toast，MVP 不做手工合并 UI）；
 * - `offline`：网络 / 服务端异常，`lastError` 携带原因，本地功能不受影响。
 */
export type SyncStatus = 'local' | 'syncing' | 'synced' | 'conflict' | 'offline';

/**
 * 已登录账户的本地会话（批次 2 只存这些；批次 4 的登录 UI 负责填充）。
 *
 * `userId` / `email` 来自服务端 `user`，`access` / `refresh` 是 Bearer 对。
 */
export interface AccountSession {
  userId: string;
  email: string;
  access: string;
  refresh: string;
}

/**
 * LWW 裁决所需的四个字段（payload 不参与裁决）。
 *
 * 与服务端 `cloud/app/sync/merger.py` 的 `VersionStamp` **同构**——两端必须用同一套
 * 三级 tie-break，否则同一对版本会在两端得出不同结论。差别只在类型：服务端是
 * `datetime`，客户端是 ISO 字符串（比较时经 `Date.parse` 归一）。
 */
export interface VersionStamp {
  id: string;
  rev: number;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * 同步服务端地址（本地开发缺省值）。
 *
 * 与 skill §1.1 的真机启动命令一致：`uvicorn --host 127.0.0.1 --port 8910`。
 */
export const DEFAULT_SYNC_BASE_URL = 'http://127.0.0.1:8910';

/**
 * 客户端墓碑上行的时间窗（§六 #10）。
 *
 * `SyncTombstones` 目前全仓**零清理**，而 MVP 是**全量 push** → 每轮都会把老墓碑
 * 再送一次；服务端又按「接收时间归一」`updatedAt`（§5.3），重收即重置时钟，导致
 * 按归一后时间 GC 则永远 GC 不掉、按客户端 `deletedAt` GC 则回到时钟漂移。
 * 两头都不成立，**只能由发送方负责**：`collectChanges()` 对超过 30 天的墓碑不再上行。
 */
export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 账户会话的存储 key（② 运行时存储）。
 *
 * 与文档 §5.1 登记的名字一致：`nanowork.sync.account`（② 运行时，不进 ①、不上云）。
 * 值一律是**字符串 JSON**（见 `syncAccount.ts`：Electron 桥按文本传递，直接存对象
 * 在两侧反序列化行为不一致）。
 */
export const SYNC_ACCOUNT_STORAGE_KEY = 'nanowork.sync.account';
