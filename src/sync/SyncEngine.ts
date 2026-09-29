/**
 * 单集合同步引擎：push 组装、pull 落地、调度。
 *
 * ## 四条客户端不变量（architecture-m6-sync.md §3.2）
 *
 * 1. **未登录 = 纯本地**：`start()` 不注册任何定时器 / 监听器，`syncNow()` 直接返回
 *    `{ skipped: true }`，**零网络请求**。这是 local-first 的兜底，有单测守卫。
 * 2. **`syncRegistry` 是唯一耦合点**：本文件不 `import` 任何 store。
 * 3. **平台能力有 Web 降级**（由 `syncAccount` 的 storage 变体承担）。
 * 4. **不 import `electron`**；也不 import React（只用 `setSyncStatus`）。
 *
 * ## 时序（§六 #12：先 pull 后 push）
 *
 * ```
 * 未登录 → status=local, return skipped
 * status=syncing
 * pull(cursor) → 落地 → 推进 cursor
 * collectChanges() → 非空则 push
 *   → 冲突：存内存快照 + 应用 server 版本
 *   → accepted 非空：再 pull 一次（拿服务端归一后的 updatedAt）
 * status = 有冲突 ? conflict : synced
 * 失败 → status=offline（本地功能不受影响）
 * ```
 *
 * 先 pull 后 push 的理由：若先 push，两端会把各自的 `rev = 0` 老数据都补齐成
 * `rev = 1 / updatedAt = now`，LWW 只能按时序随机裁决 → 症状是「后登录的机器覆盖
 * 先登录的」，且验收门禁②看不出来。
 *
 * ## LWW 三级 tie-break（与服务端 `merger.py` 同构）
 *
 * 1. `updatedAt` 大者胜；2. 相等则 `rev` 大者胜；3. 再相等则 `id` 字典序大者胜。
 * 第三级存在的理由不是「分出高下」，而是**确定性**：前两级都相等时，两端各自执行
 * 必须得出同一个胜者。`compareVersions` 拆成独立函数，第三级才测得到。
 */

import { isTombstone, tombstoneEntries } from '@/lib/syncMeta';
import { platform } from '@/platform';
import type { SyncTombstones } from '@/types';
import type { SessionEvent } from '@/types/event';
import { setSyncStatus } from './useSyncStatus';
import { EVENT_CURSOR_STORAGE_KEY, CONFLICT_SNAPSHOT_STORAGE_KEY, TOMBSTONE_MAX_AGE_MS } from './types';
import type { SyncClient } from './SyncClient';
import type { SessionEventStreamAdapter } from './eventStream';
// 仅类型：避免 `SyncEngine` ↔ `fileAssets` 形成运行时循环（后者 import 了前者的
// `compareVersions`，那是运行时依赖；这边只要类型，编译后即被擦除）
import type { FileAssetsAdapter } from './fileAssets';
import type { SyncAccount } from './syncAccount';
import type { SyncEntityRecord, SyncRegistry } from './syncRegistry';
import type { PullResponse, PushConflict, SyncChange, VersionStamp } from './types';

/**
 * 游标存储接口（关键裁决 B：cursor 仅内存，重启 `since=0` 全量拉，幂等）。
 *
 * 本批只接内存实现——**不动 `electron/`**（因此无需重建 `main.cjs`）。批次 4 若要
 * 持久化，接一份 storage 实现即可，引擎代码不改。
 */
export interface CursorStore {
  get(): number;
  set(cursor: number): void;
}

/** 内存游标（缺省实现）。 */
export function createMemoryCursorStore(initial = 0): CursorStore {
  let value = initial;
  return {
    get: () => value,
    set: (cursor: number) => {
      value = cursor;
    },
  };
}

/** 一次同步的结果。 */
export interface SyncRunResult {
  /** 本轮 pull 落地的变更条数 */
  pulled: number;
  /** 本轮 push 被服务端接受的实体 id 数 */
  pushed: number;
  /** 本轮服务端判定的冲突数 */
  conflicts: number;
  /** 是否跳过（未登录 / 并发的重复调用） */
  skipped: boolean;
  /** 本轮 pull **真正落地**的事件条数（批次 5；未注入事件通道时为 0） */
  pulledEvents: number;
  /** 本轮 push 被服务端**新增**接受的事件条数（批次 5；未注入时为 0） */
  pushedEvents: number;
}

export interface SyncEngineOptions {
  client: SyncClient;
  account: SyncAccount;
  registry: SyncRegistry;
  /** 取当前时刻（毫秒）；缺省 `Date.now`。用于墓碑时间窗与 `lastSyncedAt`。 */
  now?: () => number;
  /** 本地变更防抖窗口（毫秒）；缺省 1000 */
  debounceMs?: number;
  /** 定时同步间隔（毫秒）；缺省 30000 */
  intervalMs?: number;
  /** `online` 事件目标；缺省 `window`（Web / Electron 渲染层均有） */
  onlineTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** 游标存储；缺省内存实现 */
  cursorStore?: CursorStore;
  /**
   * 事件流通道（批次 5）；缺省 `undefined` = **纯 LWW 引擎**（既有行为不变）。
   *
   * 事件通道**全异步**、与 LWW 的同步 `read()` 分道；引擎只经此适配器访问事件流，
   * **不 import 任何 store**（不变量 2）。
   */
  eventStream?: SessionEventStreamAdapter;
  /**
   * C 类文件型资产通道（批次 6b）；缺省 `undefined` = 不同步记忆 / 身份文件 /
   * 提示词覆盖（既有行为不变）。
   *
   * 与 `eventStream` **同款裁决**：资产的读取是异步的，塞不进 `SyncCollectionSpec`
   * 的同步 `read()`（详见 `fileAssets.ts` 文件头）。引擎只经此适配器访问，
   * **不 import 任何 store**（不变量 2）。
   */
  fileAssets?: FileAssetsAdapter;
}

const DEFAULT_DEBOUNCE_MS = 1000;
const DEFAULT_INTERVAL_MS = 30_000;
/** 内存冲突快照上限（§六 #13；持久化归批次 4）。 */
const MAX_CONFLICT_SNAPSHOTS = 50;

/** ISO → 毫秒；缺省 / 非法按「零值时间」（`-Infinity`），与服务端的 EPOCH 同义。 */
function timeOf(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * 三级 tie-break：`>0` 表示 a 胜，`<0` 表示 b 胜，`0` 表示完全同版。
 *
 * 与服务端 `cloud/app/sync/merger.py::compare_versions` **逐条同构**。缺 `updatedAt`
 * 的老数据按零值时间读（`-Infinity`），避免 `Date.parse('') === NaN` 让比较全部为
 * false → 老数据永远判「无版本」。
 */
export function compareVersions(a: VersionStamp, b: VersionStamp): -1 | 0 | 1 {
  const at = timeOf(a.updatedAt);
  const bt = timeOf(b.updatedAt);
  if (at !== bt) return at > bt ? 1 : -1;
  if (a.rev !== b.rev) return a.rev > b.rev ? 1 : -1;
  if (a.id !== b.id) return a.id > b.id ? 1 : -1;
  return 0;
}

/**
 * 裁决胜者：远端严格更新 → `remote`；否则（含完全同版）→ `local`。
 *
 * 平局归本地是刻意的：本地版本并非「输」，只是「不比远端旧」——丢掉远端、等下次
 * push 由服务端再裁一次，比在这里做一次可能两端不一致的合并更安全。
 */
export function pickWinner(local: VersionStamp, remote: VersionStamp): 'local' | 'remote' {
  return compareVersions(remote, local) > 0 ? 'remote' : 'local';
}

/** 实体 → 裁决用的版本四要素（`id` 缺失时用落点键兜底）。 */
function stampOf(entity: SyncEntityRecord, fallbackId: string): VersionStamp {
  const rev = typeof entity.rev === 'number' && Number.isFinite(entity.rev) ? entity.rev : 0;
  const updatedAt = typeof entity.updatedAt === 'string' ? entity.updatedAt : '';
  const deletedAt =
    typeof entity.deletedAt === 'string' && entity.deletedAt !== '' ? entity.deletedAt : null;
  const id = typeof entity.id === 'string' && entity.id !== '' ? entity.id : fallbackId;
  return { id, rev, updatedAt, deletedAt };
}

/** 墓碑是否仍在 30 天时间窗内（超期不上行，§六 #10）。 */
function withinTombstoneWindow(deletedAt: string, nowMs: number): boolean {
  const deletedMs = Date.parse(deletedAt);
  // 时间不合法时宁可上行：漏掉删除会留下删不掉的幽灵条目，比多发一次严重得多
  if (!Number.isFinite(deletedMs)) return true;
  return nowMs - deletedMs <= TOMBSTONE_MAX_AGE_MS;
}

/**
 * 运行时收窄：把从存储读回的任意值校验成 `PushConflict`。
 *
 * 落盘分片是**脏值可达**的（手改文件 / 版本回退 / 半截写入），若不校验就把
 * `forScope` 原样灌进内存，下游 `getConflicts()` 的消费方（UI/徽章）会拿到形状
 * 不对的条目。宁可少一条快照，也不要把坏数据当冲突展示。
 */
function isPushConflict(value: unknown): value is PushConflict {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.collection === 'string' &&
    typeof c.id === 'string' &&
    typeof c.server === 'object' &&
    c.server !== null &&
    typeof c.resolution === 'string'
  );
}

/** 在存活数组 + 墓碑表里按键找本地版本；墓碑表也不命中则返回 `null`。 */
function findLocal(
  entities: SyncEntityRecord[],
  tombstones: SyncTombstones,
  key: string,
  keyOf: (e: SyncEntityRecord) => string,
): SyncEntityRecord | null {
  const live = entities.find((entity) => keyOf(entity) === key);
  if (live) return live;
  if (Object.prototype.hasOwnProperty.call(tombstones, key)) {
    // 墓碑表里只有元数据 + 键，补回 `id` 才能参与裁决
    return { id: key, ...tombstones[key] } as SyncEntityRecord;
  }
  return null;
}

/** 缺省 `online` 目标：浏览器 / Electron 渲染层的 `window`。 */
function defaultOnlineTarget():
  | Pick<Window, 'addEventListener' | 'removeEventListener'>
  | undefined {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    return window;
  }
  return undefined;
}

export class SyncEngine {
  private readonly client: SyncClient;
  private readonly account: SyncAccount;
  private readonly registry: SyncRegistry;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly onlineTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  private readonly cursorStore: CursorStore;
  private readonly eventStream?: SessionEventStreamAdapter;
  /**
   * C 类文件型资产通道（批次 6b，可选注入）。
   *
   * 与 `eventStream` 并列：两者都不进 `registry`，故 `applyChange` 对它们的 collection
   * 因「未登记」而返回 `false`——`pulled` 计数不会与各自的异步落地重复。
   */
  private readonly fileAssets?: FileAssetsAdapter;

  /**
   * **当前账户**每会话「已确保上行到服务端」的事件水位（批次 5 的 push 游标，规格 §2.1）。
   *
   * 语义：`eventSeqs[sid]` = 「`seq ≤ 该值的本机事件都已上行到服务端」的最大值。
   * **只在 push 成功后推进**——拉取落地时绝不推进（否则并发下会丢推，反例见规格）。
   *
   * **按账户隔离**：本 Map 只承载 `activeAccountScope` 对应账户的水位；账户变化时会被清空
   * 并按新账户重载（见 `resetAccountScopedState` / `ensureAccountState`）。
   */
  private readonly eventSeqs = new Map<string, number>();
  /** 内存 `eventSeqs` 是否已从 `platform.storage` 载入（惰性；账户变化时强制重载） */
  private eventCursorsLoaded = false;
  /**
   * 引擎「账户态」当前归属的账户 scope（`userId`；无 `getSession` 时为 `''`）。`null` = 尚未归属。
   *
   * 账户态 = **pull 游标**（`cursorStore`）+ **内存事件水位**（`eventSeqs`）：服务端为每个账户
   * 维护独立的 `server_seq` 空间，二者都必须按账户隔离。每次同步前比对它与此账户的 scope，
   * **不同即换号** → 复位账户态——这是「引擎实例被 runtime 复用」场景防跨账户泄漏的关键。
   */
  private activeAccountScope: string | null = null;
  /** 构造时的初始 pull 游标（账户态复位时回到它；缺省 0 = 「`since=0` 全量拉」）。 */
  private readonly initialCursor: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineHandler: (() => void) | null = null;
  private started = false;
  private running = false;
  /**
   * **当前账户**的冲突快照（被服务端版本覆盖的条目），上限 `MAX_CONFLICT_SNAPSHOTS`（50）。
   *
   * 与 `eventSeqs` 同属「账户态」：只承载 `activeAccountScope` 对应账户的分片，账户变化时
   * 被清空并按新账户从 `platform.storage` 重载（见 `resetAccountScopedState` /
   * `loadConflictsIfNeeded`）。持久化形状 `Record<userId, PushConflict[]>` 见 `types.ts`。
   */
  private readonly conflicts: PushConflict[] = [];
  /** 内存 `conflicts` 是否已从 `platform.storage` 载入（惰性；账户变化时强制重载） */
  private conflictsLoaded = false;

  constructor(options: SyncEngineOptions) {
    this.client = options.client;
    this.account = options.account;
    this.registry = options.registry;
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onlineTarget = options.onlineTarget ?? defaultOnlineTarget();
    this.cursorStore = options.cursorStore ?? createMemoryCursorStore();
    // 记下初始游标：账户态复位（换号 / 登出）时回到它——缺省 0 = 「`since=0` 全量拉」
    this.initialCursor = this.cursorStore.get();
    this.eventStream = options.eventStream;
    this.fileAssets = options.fileAssets;
  }

  /**
   * 启动调度：注册定时同步 + `online` 监听，并立即同步一次。
   *
   * **未登录直接返回，不注册任何定时器 / 监听器**（不变量 1）。此时不把 `started`
   * 置真，以便「登录后再 start()」仍能生效。
   */
  start(): void {
    if (this.started) return;

    if (!this.account.isAuthenticated()) {
      setSyncStatus({ status: 'local' });
      return;
    }

    this.started = true;
    this.timer = setInterval(() => {
      void this.syncNow();
    }, this.intervalMs);

    if (this.onlineTarget) {
      const handler = (): void => {
        void this.syncNow();
      };
      this.onlineHandler = handler;
      this.onlineTarget.addEventListener('online', handler);
    }

    void this.syncNow();
  }

  /** 停止调度（幂等）：清定时器 / 监听 / 防抖，并把 `started` 复位以便重启。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const handler = this.onlineHandler;
    if (this.onlineTarget && handler) {
      this.onlineTarget.removeEventListener('online', handler);
      this.onlineHandler = null;
    }
    this.started = false;
  }

  /**
   * 复位「账户态」：把 pull 游标归零 + 清空内存事件水位，并记下当前归属账户。
   *
   * 账户态 = **pull 游标**（`cursorStore`）+ **内存事件水位**（`eventSeqs`）。二者都只属于
   * 当前账户：服务端为每个账户维护独立的 `server_seq` 空间，换号后若沿用上一账户的游标，
   * `pull(since=<上一账户的值>)` 会**什么都拉不到** → 看不到本账户里已有的任何数据，且不报错
   * （比事件水位的静默丢推更早、更普遍地可达：任何换号都会踩）。
   *
   * 归零是安全的：批次 2 的既有裁决即「游标仅内存、重启 `since=0` 全量拉、幂等」——换号归零
   * 与之同源，代价只是一次全量重拉，**不会丢数据**。只动内存，**不删**持久化事件水位分片
   * （其它账户的水位要靠分片恢复，切回时仍可恢复其进度）。
   *
   * **账户生命周期入口调用**（`runtime.onSession` 在登录 / 登出 / 换号时）；引擎自身在每次
   * 同步前也会经 `ensureAccountState` 检测换号（双保险，见其说明）。
   *
   * 冲突快照（`conflicts`）走同一套生命周期：这里**只清内存、不删盘上分片**——其它账户的
   * 快照要靠分片恢复，切回原账户时仍可看到自己的冲突记录（与事件水位同一条裁决）。
   */
  resetAccountScopedState(): void {
    this.activeAccountScope = this.eventCursorScope();
    this.eventSeqs.clear();
    this.eventCursorsLoaded = false;
    this.conflicts.length = 0;
    this.conflictsLoaded = false;
    this.cursorStore.set(this.initialCursor);
  }

  /**
   * 同步前确保「账户态」属于当前账户：账户变化（首次 / 换号 / 登出后重登）即复位。
   *
   * 仅可能在**已登录**路径被调用（`syncNow` 的 auth 守卫之后，守卫未过直接返回）——本方法
   * 只动内存（`cursorStore.set`），**不发任何网络请求**，不变量 1「未登录 = 零 fetch」不受影响。
   */
  private ensureAccountState(): void {
    if (this.activeAccountScope === this.eventCursorScope()) return;
    this.resetAccountScopedState();
  }

  /**
   * 通知「本地发生了变更」：防抖后同步。
   *
   * 未登录直接返回，不排任何定时器——这是「未登录时推进时间仍 0 次 fetch」的实现基础。
   */
  notifyLocalChange(): void {
    if (!this.account.isAuthenticated()) return;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow();
    }, this.debounceMs);
  }

  /**
   * 已记录的内存冲突快照（副本）。
   *
   * 内容由两部分合成：本次进程内新记的冲突 + 启动时从 `platform.storage` 按当前账户
   * 分片载入的历史冲突（载入在 `syncNow` 走 `ensureAccountState` 时惰性发生）。
   */
  getConflicts(): PushConflict[] {
    return [...this.conflicts];
  }

  /**
   * 组装上行负载：每个 collection 的**存活实体** ∪ **时间窗内的墓碑**，各自过裁剪。
   *
   * 墓碑也走 `spec.payload`：`tombstoneEntries()` 产出的是 `SyncMeta & { id }`，与其
   * 「补一条删除负载」不如复用同一裁剪入口，避免出现「存活裁剪了、墓碑没裁」的缺口。
   */
  collectChanges(): SyncChange[] {
    const out: SyncChange[] = [];
    const nowMs = this.now();

    for (const spec of this.registry.entries()) {
      const { entities, tombstones } = spec.read();

      for (const entity of entities) {
        out.push({ collection: spec.collection, entity: spec.payload(entity) });
      }

      for (const entry of tombstoneEntries(tombstones)) {
        // 墓碑必带非空 `deletedAt`（`tombstoneEntries` 的契约）；防御性地跳过脏值
        if (entry.deletedAt === null) continue;
        if (!withinTombstoneWindow(entry.deletedAt, nowMs)) continue;
        out.push({
          collection: spec.collection,
          entity: spec.payload(entry as unknown as SyncEntityRecord),
        });
      }
    }

    return out;
  }

  /** 运行一次同步（先 pull 后 push）。未登录或并发重复调用时返回 `skipped: true`。 */
  async syncNow(): Promise<SyncRunResult> {
    if (!this.account.isAuthenticated()) {
      setSyncStatus({ status: 'local' });
      return {
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        skipped: true,
        pulledEvents: 0,
        pushedEvents: 0,
      };
    }

    if (this.running) {
      // 已有同步在跑：不叠加，避免同一批变更被推两次
      return {
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        skipped: true,
        pulledEvents: 0,
        pushedEvents: 0,
      };
    }

    this.running = true;
    setSyncStatus({ status: 'syncing' });
    let pulled = 0;
    let pulledEvents = 0;

    try {
      // 账户态（pull 游标 + 事件水位）按账户隔离：换号即复位，避免沿用上一账户的游标 / 水位
      this.ensureAccountState();
      // 冲突快照按账户隔离：首次（或换号后）进入本账户时从 `platform.storage` 载入其分片
      await this.loadConflictsIfNeeded();
      // 事件通道：首次（或换号后）同步时从 `platform.storage` 载入本账户水位（纯 LWW 跳过）
      if (this.eventStream) await this.ensureEventCursorsLoaded();
      // C 类资产（批次 6b）：**必须在 pull 之前**水合——「内容即版本」要先于组装上行
      // 负载生效，否则本轮 push 用的是上一轮的版本号。
      if (this.fileAssets) await this.fileAssets.hydrate();

      // 1. 先 pull：把对端 / 上次同步后的变更落下来（§六 #12）
      const firstPull = await this.client.pull(this.cursorStore.get());
      pulled += this.applyPull(firstPull);
      pulled += await this.applyPulledFileAssets(firstPull.changes);
      // 事件落地：异步，按 sessionId 分组逐会话落地；**绝不推进水位**（规格 §2.1 J1-b）
      pulledEvents += await this.applyPulledEvents(firstPull.events);
      this.cursorStore.set(firstPull.cursor);

      // 2. 组装并 push（C 类资产走适配器，与 LWW 实体同批上行）
      const changes = [...this.collectChanges(), ...(this.fileAssets?.collect() ?? [])];
      const eventBatch = await this.collectEventChanges();
      let pushed = 0;
      let pushedEvents = 0;
      let conflictCount = 0;

      if (changes.length > 0 || eventBatch.events.length > 0) {
        const response = await this.client.push(changes, eventBatch.events);
        pushed = response.accepted.length;
        pushedEvents = response.accepted_events;
        conflictCount = response.conflicts.length;

        // 事件水位**只在 push 成功后**推进（J1-c：不得挪到 push 之前）。
        // 推进到「本批实际推送的该会话最大 seq」：即便服务端按 id 幂等跳过
        // （`accepted_events` 为 0）这些事件也确已被服务端持有，推进安全，且避免了
        // 「每轮把远端事件回推」的无界开销（规格 §2.1：稳态是每条远端事件回显一次）。
        if (eventBatch.events.length > 0) {
          for (const [sessionId, maxSeq] of eventBatch.maxSeqBySession) {
            this.eventSeqs.set(sessionId, maxSeq);
          }
          await this.persistEventCursors();
        }

        for (const conflict of response.conflicts) {
          await this.rememberConflict(conflict);
          // 冲突：服务端版本更新 → 按落地语义应用服务端这份（§六 #9 / #13）
          this.applyChange({ collection: conflict.collection, entity: conflict.server });
        }

        // 3. accepted 非空 → 再 pull 一次，取回服务端归一后的 updatedAt（§5.3）
        if (response.accepted.length > 0) {
          const secondPull = await this.client.pull(this.cursorStore.get());
          pulled += this.applyPull(secondPull);
          pulled += await this.applyPulledFileAssets(secondPull.changes);
          pulledEvents += await this.applyPulledEvents(secondPull.events);
          this.cursorStore.set(secondPull.cursor);
        }
      }

      setSyncStatus({
        status: conflictCount > 0 ? 'conflict' : 'synced',
        lastSyncedAt: new Date(this.now()).toISOString(),
        pendingCount: 0,
        conflictCount: this.conflicts.length,
        lastError: null,
      });

      return {
        pulled,
        pushed,
        conflicts: conflictCount,
        skipped: false,
        pulledEvents,
        pushedEvents,
      };
    } catch (error) {
      setSyncStatus({
        status: 'offline',
        lastError: error instanceof Error ? error.message : String(error),
      });
      return {
        pulled,
        pushed: 0,
        conflicts: 0,
        skipped: false,
        pulledEvents,
        pushedEvents: 0,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * 组装上行的**事件流批次**：每会话 `readEventsSince(eventSeqs.get(id) ?? 0)`。
   *
   * 返回事件数组 + 「本会话本批最大 seq」映射（供 push 成功后推进水位）。未注入
   * `eventStream` → 返回空批次（纯 LWW 引擎，既有行为不变）。
   */
  private async collectEventChanges(): Promise<{
    events: SessionEvent[];
    maxSeqBySession: Map<string, number>;
  }> {
    const events: SessionEvent[] = [];
    const maxSeqBySession = new Map<string, number>();
    if (!this.eventStream) return { events, maxSeqBySession };

    for (const { id } of this.eventStream.localSessions()) {
      const since = this.eventSeqs.get(id) ?? 0;
      const sessionEvents = await this.eventStream.readEventsSince(id, since);
      if (sessionEvents.length === 0) continue;
      let maxSeq = since;
      for (const ev of sessionEvents) {
        events.push(ev);
        if (ev.seq > maxSeq) maxSeq = ev.seq;
      }
      maxSeqBySession.set(id, maxSeq);
    }
    return { events, maxSeqBySession };
  }

  /**
   * 落地一批 pull 来的事件：按 `sessionId` 分组 → `adapter.appendRemoteEvents`。
   *
   * **绝不推进水位**（规格 §2.1 的关键裁决）：拉取落地时若推进水位会丢推——设备 A
   * 离线攒了 `seq 1..5`、B 攒了 `1..3` 并先推；A 联网先 pull 到 B 的 `1..3`，若此时
   * 把水位推到 3，则 A 本机 `seq 1..3` 的事件**永远不会上行**。返回实际**新增落地**
   * 的事件数（供 `SyncRunResult.pulledEvents`）。
   */
  private async applyPulledEvents(events: SessionEvent[]): Promise<number> {
    if (!this.eventStream || events.length === 0) return 0;
    const bySession = new Map<string, SessionEvent[]>();
    for (const ev of events) {
      const list = bySession.get(ev.sessionId);
      if (list) list.push(ev);
      else bySession.set(ev.sessionId, [ev]);
    }
    let applied = 0;
    for (const [sessionId, sessionEvents] of bySession) {
      applied += await this.eventStream.appendRemoteEvents(sessionId, sessionEvents);
    }
    return applied;
  }

  /**
   * 落地 C 类资产变更（批次 6b）。
   *
   * 与 `applyPulledEvents` 同款：单独一步、异步。这三个 collection **未登记**进
   * registry，故 `applyPull` 对它们返回 `false`（不计数），不会与这里重复。
   */
  private async applyPulledFileAssets(changes: SyncChange[]): Promise<number> {
    if (!this.fileAssets || changes.length === 0) return 0;
    let applied = 0;
    for (const change of changes) {
      applied += await this.fileAssets.apply(change);
    }
    return applied;
  }

  /**
   * 当前账户的 cursor scope：取 `account.getSession()?.userId`。
   *
   * 未登录 / 无 `getSession`（如纯 LWW 单测桩）时退化为 `''`——同一引擎实例下所有匿名
   * 场景共用一个空 scope，语义等价于「无账户维度」，但换到具名账户时仍能正确切分。
   * 引擎**不 import 任何 store**（不变量 2），只经 `SyncAccount` 现有 API 取 `userId`。
   */
  private eventCursorScope(): string {
    return this.account.getSession()?.userId ?? '';
  }

  /**
   * 载入**当前账户**的事件水位（惰性；每次同步前由 `ensureAccountState` 保证账户已切分）。
   *
   * 存储形状：`Record<userId, Record<sessionId, number>>`（见 `types.ts`）——只读**当前账户**
   * 那一份分片到内存 `eventSeqs`。账户变化时 `ensureAccountState` 已把 `eventCursorsLoaded`
   * 复位为 `false`，故这里天然是「按账户各载入一次」。
   */
  private async ensureEventCursorsLoaded(): Promise<void> {
    if (this.eventCursorsLoaded) return;
    this.eventCursorsLoaded = true;
    const scope = this.eventCursorScope();
    try {
      const raw = await platform.storage.get<string>(EVENT_CURSOR_STORAGE_KEY);
      if (typeof raw !== 'string' || raw.trim() === '') return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const forScope = (parsed as Record<string, unknown>)[scope];
      if (typeof forScope !== 'object' || forScope === null) return;
      for (const [sessionId, seq] of Object.entries(forScope as Record<string, unknown>)) {
        if (typeof seq === 'number' && Number.isFinite(seq)) this.eventSeqs.set(sessionId, seq);
      }
    } catch {
      // 坏值 / 存储不可用：当作空水位——水位归 0 → 全量重推 → 服务端按事件 id 去重
    }
  }

  /**
   * 把**当前账户**的水位写回 `platform.storage`（`Record<userId, Record<sessionId, number>>`
   * 的字符串 JSON）。
   *
   * **读-改-写**：先读回整个分片表，**只替换本账户那一份**再写回——其它账户的分片原样
   * 保留。若直接整体覆盖，账户来回切换就会互相清掉对方的水位，退化成「每次换号都全量
   * 重推」（无害但多余）；更糟的是若只写单账户形状，B 的写入会让 A 的进度彻底丢失。
   */
  private async persistEventCursors(): Promise<void> {
    const scope = this.eventCursorScope();
    const current: Record<string, number> = {};
    for (const [sessionId, seq] of this.eventSeqs) current[sessionId] = seq;
    try {
      const raw = await platform.storage.get<string>(EVENT_CURSOR_STORAGE_KEY);
      let all: Record<string, unknown> = {};
      if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) all = parsed as Record<string, unknown>;
      }
      all[scope] = current;
      await platform.storage.set(EVENT_CURSOR_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // 丢了不影响正确性（见 types.ts `EVENT_CURSOR_STORAGE_KEY` 的说明）
    }
  }

  /** 落地一批 pull 变更，返回实际应用的条数。 */
  private applyPull(response: PullResponse): number {
    let applied = 0;
    for (const change of response.changes) {
      if (this.applyChange(change)) applied += 1;
    }
    return applied;
  }

  /**
   * 落地单条变更（§六 #9 浅合并），返回「**是否真的改动了本地**」。
   *
   * - 未知 collection：静默跳过（前向兼容，不抛错）；
   * - 本地不存在：直接采用 → 改动本地，返回 `true`；
   * - 远端严格更新：墓碑走 `apply(entity)`，存活走 `apply({ ...local, ...payload })`
   *   ——**浅合并**，元数据以 payload 为准，本机事实字段因此得以保留 → 改动本地，返回 `true`；
   * - 否则（本地更新 / 同版）：丢弃远端、等下次 push → **未改动本地**，返回 `false`。
   *
   * 返回值语义与 `SyncRunResult.pulled` 的注释（「本轮 pull **落地**的变更条数」）对齐：
   * 把「尝试数」当落地数会让门禁②的 `pulled === N` 断言失去鉴别力（被丢弃的也算进去）。
   * 冲突循环里 `this.applyChange({ collection, entity: server })` 的返回值**被忽略**，
   * 故改语义不影响冲突落地。
   */
  private applyChange(change: SyncChange): boolean {
    const spec = this.registry.get(change.collection);
    if (!spec) return false;

    const incoming = change.entity;
    const key = spec.keyOf(incoming);
    const { entities, tombstones } = spec.read();
    const local = findLocal(entities, tombstones, key, spec.keyOf);

    if (local === null) {
      spec.apply(incoming);
      return true;
    }

    const winner = pickWinner(stampOf(local, key), stampOf(incoming, key));
    if (winner === 'remote') {
      if (isTombstone(incoming)) {
        spec.apply(incoming);
      } else {
        spec.apply({ ...local, ...incoming });
      }
      return true;
    }
    // 本地胜（含完全同版）：丢弃远端，未改动本地
    return false;
  }

  /**
   * 记一条冲突快照：更新内存（上限 50）后**读-改-写**落盘（只替换当前账户分片）。
   *
   * 落盘失败不影响同步正确性（快照是「可追查」的附加物，不是协议事实），故吞掉异常。
   * 上限在内存与盘上同源：`persistConflicts` 写的就是裁剪后的 `this.conflicts`。
   */
  private async rememberConflict(conflict: PushConflict): Promise<void> {
    this.conflicts.push(conflict);
    if (this.conflicts.length > MAX_CONFLICT_SNAPSHOTS) {
      this.conflicts.splice(0, this.conflicts.length - MAX_CONFLICT_SNAPSHOTS);
    }
    await this.persistConflicts();
  }

  /**
   * 载入**当前账户**的冲突快照（惰性；账户变化时 `resetAccountScopedState` 已把
   * `conflictsLoaded` 复位，故这里天然是「按账户各载入一次」）。
   *
   * 存储形状：`Record<userId, PushConflict[]>`（见 `types.ts`）——只读**当前账户**那一份
   * 分片到内存 `conflicts`。坏值 / 存储不可用 → 当作空（与事件水位同一条容错）。
   */
  private async loadConflictsIfNeeded(): Promise<void> {
    if (this.conflictsLoaded) return;
    this.conflictsLoaded = true;
    const scope = this.eventCursorScope();
    try {
      const raw = await platform.storage.get<string>(CONFLICT_SNAPSHOT_STORAGE_KEY);
      if (typeof raw !== 'string' || raw.trim() === '') return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const forScope = (parsed as Record<string, unknown>)[scope];
      if (!Array.isArray(forScope)) return;
      this.conflicts.length = 0;
      for (const item of forScope) {
        if (this.conflicts.length >= MAX_CONFLICT_SNAPSHOTS) break;
        if (isPushConflict(item)) this.conflicts.push(item);
      }
    } catch {
      // 坏值 / 存储不可用：当作空快照——丢了不影响同步正确性
    }
  }

  /**
   * 把**当前账户**的冲突快照写回 `platform.storage`
   * （`Record<userId, PushConflict[]>` 的字符串 JSON）。
   *
   * **读-改-写**：先读回整个分片表，**只替换本账户那一份**再写回——其它账户的分片
   * 原样保留。与事件水位同一条理由：整体覆盖会让账户来回切换时互相清掉对方的快照。
   */
  private async persistConflicts(): Promise<void> {
    const scope = this.eventCursorScope();
    const current = this.conflicts.slice();
    try {
      const raw = await platform.storage.get<string>(CONFLICT_SNAPSHOT_STORAGE_KEY);
      let all: Record<string, unknown> = {};
      if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) all = parsed as Record<string, unknown>;
      }
      all[scope] = current;
      await platform.storage.set(CONFLICT_SNAPSHOT_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // 丢了不影响同步正确性（见 types.ts `CONFLICT_SNAPSHOT_STORAGE_KEY` 的说明）
    }
  }
}
