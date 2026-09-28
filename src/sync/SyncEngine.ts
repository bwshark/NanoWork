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
import type { SyncTombstones } from '@/types';
import { setSyncStatus } from './useSyncStatus';
import { TOMBSTONE_MAX_AGE_MS } from './types';
import type { SyncClient } from './SyncClient';
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

  private timer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineHandler: (() => void) | null = null;
  private started = false;
  private running = false;
  private readonly conflicts: PushConflict[] = [];

  constructor(options: SyncEngineOptions) {
    this.client = options.client;
    this.account = options.account;
    this.registry = options.registry;
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onlineTarget = options.onlineTarget ?? defaultOnlineTarget();
    this.cursorStore = options.cursorStore ?? createMemoryCursorStore();
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

  /** 已记录的内存冲突快照（副本）。持久化归批次 4。 */
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
      return { pulled: 0, pushed: 0, conflicts: 0, skipped: true };
    }

    if (this.running) {
      // 已有同步在跑：不叠加，避免同一批变更被推两次
      return { pulled: 0, pushed: 0, conflicts: 0, skipped: true };
    }

    this.running = true;
    setSyncStatus({ status: 'syncing' });
    let pulled = 0;

    try {
      // 1. 先 pull：把对端 / 上次同步后的变更落下来（§六 #12）
      const firstPull = await this.client.pull(this.cursorStore.get());
      pulled += this.applyPull(firstPull);
      this.cursorStore.set(firstPull.cursor);

      // 2. 组装并 push
      const changes = this.collectChanges();
      let pushed = 0;
      let conflictCount = 0;

      if (changes.length > 0) {
        const response = await this.client.push(changes);
        pushed = response.accepted.length;
        conflictCount = response.conflicts.length;

        for (const conflict of response.conflicts) {
          this.rememberConflict(conflict);
          // 冲突：服务端版本更新 → 按落地语义应用服务端这份（§六 #9 / #13）
          this.applyChange({ collection: conflict.collection, entity: conflict.server });
        }

        // 3. accepted 非空 → 再 pull 一次，取回服务端归一后的 updatedAt（§5.3）
        if (response.accepted.length > 0) {
          const secondPull = await this.client.pull(this.cursorStore.get());
          pulled += this.applyPull(secondPull);
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

      return { pulled, pushed, conflicts: conflictCount, skipped: false };
    } catch (error) {
      setSyncStatus({
        status: 'offline',
        lastError: error instanceof Error ? error.message : String(error),
      });
      return { pulled, pushed: 0, conflicts: 0, skipped: false };
    } finally {
      this.running = false;
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

  private rememberConflict(conflict: PushConflict): void {
    this.conflicts.push(conflict);
    if (this.conflicts.length > MAX_CONFLICT_SNAPSHOTS) {
      this.conflicts.splice(0, this.conflicts.length - MAX_CONFLICT_SNAPSHOTS);
    }
  }
}
