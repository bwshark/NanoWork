import { platform } from '@/platform';
import type { SessionEvent, SessionIndexFile, SessionMeta } from '@/types/event';
import {
  applyAppend,
  countEvents,
  deriveMetaFromEvents,
  listSessionEntries,
  normalizeSessionIndex,
  normalizeSessionMeta,
  rebuildSessionIndex,
  removeSessionEntry,
  tombstoneEntry,
} from './indexFile';
import type { SessionCounters } from './indexFile';
import type { EventStore, EventStoreCapabilities } from './store';

/**
 * Web 事件存储：浏览器端降级实现。
 *
 * Web 没有文件系统，落点退化为 `platform.storage`（localStorage）**按会话分片**：
 *
 * ```
 * nanowork.events.ids          → string[]            会话 id 注册表（替代「扫描目录」）
 * nanowork.events.index        → SessionIndexFile    会话索引
 * nanowork.events.events.<id>  → SessionEvent[]      会话事件流
 * nanowork.events.meta.<id>    → SessionMeta         会话元数据
 * ```
 *
 * ## 与 Electron 实现的三点差异（已如实反映在 capabilities）
 *
 * 1. **非真实文件**（`fileBacked: false`）——用户在资源管理器里看不到；
 * 2. **无内容寻址备份**（`fileHistory: false`）——回滚锚点不可用，故
 *    `putBackup` 为 no-op、`getBackup` 恒为 null；
 * 3. **追加有写放大**——localStorage 无法原地追加，只能「读数组 → 拼接 → 回写」。
 *    这是浏览器存储模型的硬限制，故必须按会话分片，避免「改一条会话重写全部」。
 *
 * ## 索引语义与主进程一致
 *
 * 索引投影复用 `src/events/indexFile.ts` 的纯函数——它与 Electron 主进程用的
 * 是同一份实现（见该文件注释），因此两端列表行为不会漂移。
 * 工作空间在 Web 端不作为落点维度（无目录概念），只保留在 meta 里。
 */

const CAPABILITIES: EventStoreCapabilities = {
  fileBacked: false,
  fileHistory: false,
};

const KEYS = {
  /** 会话 id 注册表（替代磁盘扫描） */
  ids: 'nanowork.events.ids',
  index: 'nanowork.events.index',
  events: (sessionId: string) => `nanowork.events.events.${sessionId}`,
  meta: (sessionId: string) => `nanowork.events.meta.${sessionId}`,
} as const;

export function createWebEventStore(): EventStore {
  const { storage } = platform;

  async function readIds(): Promise<string[]> {
    return (await storage.get<string[]>(KEYS.ids)) ?? [];
  }

  async function registerId(sessionId: string): Promise<void> {
    const ids = await readIds();
    if (!ids.includes(sessionId)) await storage.set(KEYS.ids, [...ids, sessionId]);
  }

  async function readIndex(): Promise<SessionIndexFile> {
    return normalizeSessionIndex(await storage.get<SessionIndexFile>(KEYS.index));
  }

  async function readMeta(sessionId: string): Promise<SessionMeta | null> {
    return normalizeSessionMeta(await storage.get<SessionMeta>(KEYS.meta(sessionId)));
  }

  async function readEvents(sessionId: string): Promise<SessionEvent[]> {
    return (await storage.get<SessionEvent[]>(KEYS.events(sessionId))) ?? [];
  }

  return {
    capabilities: CAPABILITIES,

    async append({ sessionId, events }) {
      // 空追加：不落盘也不建条目（与 Electron 主进程语义一致）
      if (events.length === 0) {
        const entry = (await readIndex()).entries[sessionId];
        return { lastSeq: entry?.lastSeq ?? 0, eventCount: entry?.eventCount ?? 0 };
      }
      await registerId(sessionId);
      // localStorage 不能原地追加：读数组 → 拼接 → 回写（见文件头第 3 点）
      const all = [...(await readEvents(sessionId)), ...events];
      await storage.set(KEYS.events(sessionId), all);

      // meta 缺失（如历史数据）时从事件流就地推导，会话才不会从列表消失
      const meta = (await readMeta(sessionId)) ?? deriveMetaFromEvents(sessionId, all);
      const next = applyAppend(await readIndex(), meta, events, sessionId);
      await storage.set(KEYS.index, next);

      const entry = next.entries[sessionId];
      return { lastSeq: entry?.lastSeq ?? 0, eventCount: entry?.eventCount ?? 0 };
    },

    readEvents,

    async removeSession(sessionId) {
      await storage.remove(KEYS.events(sessionId));
      await storage.remove(KEYS.meta(sessionId));
      await storage.set(
        KEYS.ids,
        (await readIds()).filter((id) => id !== sessionId),
      );
      const index = removeSessionEntry(await readIndex(), sessionId);
      await storage.set(KEYS.index, index);
    },

    async tombstoneSession(meta) {
      // 正文丢掉、meta 留着；id 也必须继续留在注册表里——`listMetas()` 靠它枚举，
      // 掉了的话下一次 `rebuildIndex()` 会把墓碑一起重建掉，删除就此失效。
      await storage.remove(KEYS.events(meta.id));
      await registerId(meta.id);
      await storage.set(KEYS.meta(meta.id), meta);
      await storage.set(KEYS.index, tombstoneEntry(await readIndex(), meta));
    },

    readMeta,

    async writeMeta(meta) {
      await registerId(meta.id);
      await storage.set(KEYS.meta(meta.id), meta);
    },

    async listMetas() {
      const metas = await Promise.all((await readIds()).map((id) => readMeta(id)));
      return metas.filter((m): m is SessionMeta => m !== null);
    },

    readIndex,

    async listSessions() {
      return listSessionEntries(await readIndex());
    },

    async rebuildIndex() {
      const ids = await readIds();
      const metas: SessionMeta[] = [];
      const counters: Record<string, SessionCounters> = {};
      for (const id of ids) {
        const meta = await readMeta(id);
        if (meta) metas.push(meta);
        counters[id] = countEvents(await readEvents(id));
      }
      const index = rebuildSessionIndex(metas, counters);
      await storage.set(KEYS.index, index);
      return index;
    },

    //  Web 端无文件系统：内容寻址备份不可用（capabilities.fileHistory=false）
    async putBackup() {
      // no-op
    },

    async getBackup() {
      return null;
    },
  };
}
