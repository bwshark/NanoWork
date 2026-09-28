/**
 * 事件流同步适配器——引擎与「事件流」的**唯一耦合点**（批次 5，规格 §2.1）。
 *
 * ## 为什么是第二类通道，而不是 `SyncCollectionSpec`
 *
 * 1. `SyncCollectionSpec.read()` 是**同步**的；事件存储（`EventStore`）**全异步**。
 *    塞进 LWW spec 要么让 `read()` 变成假同步（返回空 / 缓存），要么改全体 spec 的
 *    契约（回归面过大）。
 * 2. 事件流**没有墓碑、没有 `rev` / `updatedAt`**：spec 的 `keyOf` / `tombstones`
 *    / `payload` 三个钩子对它**全是空转**，硬套 = 用错抽象。
 * 3. 引擎与 store 的唯一耦合点是 registry；事件通道的耦合点是**另一个**适配器，
 *    两者都被 `runtime` 装配——`SyncEngine.ts` **依旧不 import 任何 store**。
 *
 * 因此本文件是 `src/sync/**` 里**唯一** import `@/events` + `sessionsStore` 的地方。
 * 事件通道的契约见 `SessionEventStreamAdapter`：全异步，与 LWW 分道。
 *
 * ## 落地分片只认接收方本机（规格 §2.3）
 *
 * 分片一律取自**本机** `sessionsStore` 的 `streamWorkdir ?? workdir`：拉来的会话由
 * 批次 4 的 `toMetaFromEntity` 落地，其 `streamWorkdir` 已重定向为本机默认分片，
 * 故这里取到的是本机路径，**绝不照抄发送方路径**。会话在本机未知 / 已墓碑 / 外部
 * 来源（IM / 只读 / cron）→ **跳过该批事件**，不落孤儿文件。
 *
 * ## 去重与排序（规格 Q4）
 *
 * 一律 `dedupe(by id) → sort(by (seq asc, id asc))`：事件 `id` 是 uuid、跨端一致，
 * 用它做末级 tie-break **确定且两端一致**（事件体上没有「设备号」字段，见勘误 §3.1）。
 */

import { getEventStore } from '@/events';
import { enqueueSessionTask } from '@/events/recorder';
import { isEventStreamSession, useSessionsStore } from '@/stores/sessionsStore';
import type { SessionEvent } from '@/types/event';

/**
 * 事件流同步适配器：管 append-only 事件流（**全异步**）。
 *
 * 与 `syncRegistry`（管 LWW 实体、同步 `read()`）分工，两者都被 `runtime` 装配、
 * 注入引擎。
 */
export interface SessionEventStreamAdapter {
  /** 本机存在事件流的会话（已过滤 IM / 只读 / cron）与其**本机分片** */
  localSessions(): Array<{ id: string; shard: string | undefined }>;
  /** 读该会话本机 `seq > sinceSeq` 的事件（按 seq 升序）；会话未知返回 [] */
  readEventsSince(sessionId: string, sinceSeq: number): Promise<SessionEvent[]>;
  /** 落地远端事件：按 `id` 去重 + 追加到**本机分片**；返回实际新增条数 */
  appendRemoteEvents(sessionId: string, events: SessionEvent[]): Promise<number>;
}

/**
 * 事件排序键 `(seq asc, id asc)`（规格 Q4 的确定性规则，两端同源）。
 *
 * 末级用 `id` 字典序而非「设备号」：`BaseEvent` 没有设备号字段，且 `id` 跨端一致，
 * 用它保证「同一并集两端排序一致」这条不变量。
 */
function compareEvents(a: SessionEvent, b: SessionEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 取某会话的**本机分片**；本机未知 / 非事件流会话返回 `null`（调用方据此跳过）。 */
function shardOf(sessionId: string): string | undefined | null {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session || !isEventStreamSession(session)) return null;
  return session.streamWorkdir ?? session.workdir;
}

export function createSessionEventStreamAdapter(): SessionEventStreamAdapter {
  return {
    localSessions() {
      return useSessionsStore
        .getState()
        .sessions.filter((s) => isEventStreamSession(s))
        .map((s) => ({ id: s.id, shard: s.streamWorkdir ?? s.workdir }));
    },

    async readEventsSince(sessionId, sinceSeq) {
      const shard = shardOf(sessionId);
      if (shard === null) return [];
      const all = await getEventStore().readEvents(sessionId, shard);
      return all.filter((ev) => ev.seq > sinceSeq).sort(compareEvents);
    },

    async appendRemoteEvents(sessionId, events) {
      const shard = shardOf(sessionId);
      // 未知 / 墓碑 / 外部来源会话 → 跳过（不落孤儿文件，规格 §2.3）
      if (shard === null) return 0;

      // 按 id 去重：既对本机已存在的事件去重，也对本批内重复的 id 去重（幂等）
      const existing = await getEventStore().readEvents(sessionId, shard);
      const seen = new Set(existing.map((ev) => ev.id));
      const fresh: SessionEvent[] = [];
      for (const ev of events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        fresh.push(ev);
      }
      if (fresh.length === 0) return 0;

      fresh.sort(compareEvents);
      // 排进该会话的写队列：与记录器的实时追加串行，避免「读数组 → 拼接 → 回写」竞态
      await enqueueSessionTask(sessionId, async () => {
        await getEventStore().append({ sessionId, workdir: shard, events: fresh });
      });
      return fresh.length;
    },
  };
}
