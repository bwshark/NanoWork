import type { EventAppendParams, EventAppendResult } from '@/platform/types';
import type {
  SessionEvent,
  SessionIndexEntry,
  SessionIndexFile,
  SessionMeta,
} from '@/types/event';
import {
  applyAppend,
  countEvents,
  deriveMetaFromEvents,
  emptySessionIndex,
  listSessionEntries,
  rebuildSessionIndex,
  removeSessionEntry,
} from './indexFile';
import type { SessionCounters } from './indexFile';

/**
 * 事件存储契约（D2）。
 *
 * 设计文档第 9 章的落地：**append-only 事件流是会话的事实源**，会话列表来自
 * 可再生的索引，而 `sessionsStore` 降级为内存视图。本模块只定义「存什么、
 * 取什么」，不含任何落盘方式——那是实现的事。
 *
 * ## 两个实现 + 一个参照实现
 *
 * | 实现 | 落点 | 能力 |
 * |---|---|---|
 * | `electronStore.ts` | `<userData>/projects/…`（真实文件） | 文件 + 备份 |
 * | `webStore.ts` | 浏览器分片存储（`platform.storage`） | 仅数据，无文件 |
 * | `store.ts` 的 `createMemoryEventStore` | 内存（**测试参照实现**） | 全量语义 |
 *
 * 内存实现存在的意义是可测：契约测试对它跑一遍，等于把「追加 → 索引 → 重建」
 * 的语义精确固定下来，两个真实实现只需证明自己与它行为一致。
 *
 * ## 与 D1 契约层的同构
 *
 * 与 `src/ai/runtime` 一样，`src/events/index.ts` 是**唯一入口**（惰性单例）；
 * 渲染层不得直接 import `electronStore` / `webStore`，否则降级分支就会被绕过。
 */
export interface EventStoreCapabilities {
  /** 事件流落为真实文件（Electron）；false = 浏览器分片存储（Web 降级） */
  fileBacked: boolean;
  /** 支持内容寻址文件备份（编辑前快照 / 回滚锚点） */
  fileHistory: boolean;
}

export interface EventStore {
  readonly capabilities: EventStoreCapabilities;

  /** 追加事件并维护索引；返回最新计数（`lastSeq` 作为续写游标） */
  append(params: EventAppendParams): Promise<EventAppendResult>;
  /** 读取会话的全部事件（按落盘顺序，即 `seq` 升序） */
  readEvents(sessionId: string, workdir?: string | null): Promise<SessionEvent[]>;
  /** 删除会话的事件流与元数据，并移除索引条目（幂等） */
  removeSession(sessionId: string, workdir?: string | null): Promise<void>;

  /** 读取会话元数据；不存在返回 null */
  readMeta(sessionId: string, workdir?: string | null): Promise<SessionMeta | null>;
  /** 覆盖写入会话元数据（会话 id / 工作空间取自 meta 自身） */
  writeMeta(meta: SessionMeta): Promise<void>;
  /** 枚举全部会话元数据（磁盘扫描 / 注册表） */
  listMetas(): Promise<SessionMeta[]>;

  /** 读取会话索引（列表查询的数据源；不存在或损坏返回空索引） */
  readIndex(): Promise<SessionIndexFile>;
  /** 索引 → 会话列表（过滤软删除 + 置顶/最近排序） */
  listSessions(): Promise<SessionIndexEntry[]>;
  /** 全量重建索引（索引损坏或 schema 升级时） */
  rebuildIndex(): Promise<SessionIndexFile>;

  /** 内容寻址备份：写入（同 hash 幂等）；`fileHistory=false` 时为 no-op */
  putBackup(hash: string, content: string): Promise<void>;
  /** 内容寻址备份：读取；不支持时返回 null */
  getBackup(hash: string): Promise<string | null>;
}

/** 内存键：工作空间 + 会话 id（Web 无目录，但内存实现要能区分同 id 不同空间） */
function scopeKey(sessionId: string, workdir?: string | null): string {
  return `${workdir ?? ''}\u0000${sessionId}`;
}

/**
 * 内存参照实现：语义与真实实现一致，仅不落盘。
 * 供契约测试与组件测试使用（不参与打包路径）。
 */
export function createMemoryEventStore(): EventStore {
  const eventsById = new Map<string, SessionEvent[]>();
  const metasById = new Map<string, SessionMeta>();
  const backups = new Map<string, string>();
  let index: SessionIndexFile = emptySessionIndex();

  return {
    capabilities: { fileBacked: false, fileHistory: true },

    async append({ sessionId, workdir, events }) {
      const k = scopeKey(sessionId, workdir);
      const all = [...(eventsById.get(k) ?? []), ...events];
      eventsById.set(k, all);

      const meta = metasById.get(k) ?? (all.length > 0 ? deriveMetaFromEvents(sessionId, all) : null);
      index = applyAppend(index, meta, events, sessionId);
      const entry = index.entries[sessionId];
      return { lastSeq: entry?.lastSeq ?? 0, eventCount: entry?.eventCount ?? 0 };
    },

    async readEvents(sessionId, workdir) {
      return [...(eventsById.get(scopeKey(sessionId, workdir)) ?? [])];
    },

    async removeSession(sessionId, workdir) {
      const k = scopeKey(sessionId, workdir);
      eventsById.delete(k);
      metasById.delete(k);
      index = removeSessionEntry(index, sessionId);
    },

    async readMeta(sessionId, workdir) {
      return metasById.get(scopeKey(sessionId, workdir)) ?? null;
    },

    async writeMeta(meta) {
      metasById.set(scopeKey(meta.id, meta.workdir), meta);
    },

    async listMetas() {
      return [...metasById.values()];
    },

    async readIndex() {
      return index;
    },

    async listSessions() {
      return listSessionEntries(index);
    },

    async rebuildIndex() {
      const counters: Record<string, SessionCounters> = {};
      for (const [k, events] of eventsById) {
        const sessionId = k.slice(k.indexOf('\u0000') + 1);
        counters[sessionId] = countEvents(events);
      }
      index = rebuildSessionIndex([...metasById.values()], counters);
      return index;
    },

    async putBackup(hash, content) {
      if (!backups.has(hash)) backups.set(hash, content);
    },

    async getBackup(hash) {
      return backups.get(hash) ?? null;
    },
  };
}
