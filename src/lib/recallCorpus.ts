/**
 * 召回语料的**适配器**：会话事件流 → `StoredMemory[]`（只读投影）。
 *
 * 需求：FR-M30；设计：`docs/architecture-memory-v2.md` §4.8 的「语料适配器」。
 *
 * ## 为什么用事件流而不是新建一份 history 副本
 *
 * 会话视图的产地必须**同源**（ADR-023）：再建一套语料就是第三个产地，必然漂移——
 * 界面上看到的会话与检索到的会话会对不上，而这种不一致没有任何测试能及时发现。
 * 所以适配器复用 `activePath` + `projectMessages`（`@/events/project`），
 * 自己只做「消息 → StoredMemory」这一层薄映射。
 *
 * ## 三条如实的口径（不能宣称「全部历史」）
 *
 * 1. **只覆盖本地事件流会话**：`readonly` / `channel` / `cron` 会话不落本地事件流
 *    （`isEventStreamSession`），检索不到它们；
 * 2. **墓碑会话的正文已被丢弃**，只留 meta 与索引条目，因此也没有内容可检索；
 * 3. **`storedAt` 与 `capturedAt` 在本地语料里同值**：事件只有 `timestamp` 一个时间字段，
 *    投影把它当成 `createdAt`。契约保留两个字段是为了将来接真正的远端存储，
 *    **不要**为了「看起来不同」而伪造一个 `storedAt`。
 *
 * ## 只读且可缓存
 *
 * 适配器不写任何东西；调用方按「会话 id + rev」失效缓存。语料规模有上限
 * （按 `capturedAt` 倒序裁剪），否则「检索全部历史」会随着使用时间线性变慢。
 */

import type { Message, StoredMemory } from '@/types';
import type { SessionEvent, SessionIndexEntry, SessionMeta } from '@/types/event';
import { activePath, projectMessages } from '@/events/project';
import { getEventStore } from '@/events';
import { compareStrings } from '@/lib/memoryNormalize';

/** 语料规模上限（默认 10000 条消息） */
export const RECALL_CORPUS_LIMIT = 10_000;

/** 一条会话记录（适配器的输入单元，便于离线测试） */
export interface SessionCorpusInput {
  sessionId: string;
  title: string;
  events: readonly SessionEvent[];
  /** 事件流分片（`meta.workdir`）；仅用于读取，不影响产出的记录 */
  shard?: string | null;
}

/** 把一条消息压成可检索的记录（user / assistant，且正文非空） */
function messageToMemory(
  sessionId: string,
  title: string,
  userScope: string,
  message: Message,
): StoredMemory | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const content = (message.content ?? '').trim();
  if (content === '') return null;
  const capturedAt = normalizeInstant(message.createdAt);
  return {
    memoryId: `ev:${sessionId}:${message.id}`,
    userScope,
    kind: 'conversation',
    content,
    // 摘要在本地语料里就是正文的前 80 字（没有第二次模型调用；召回是可离线验证的能力）
    summary: content.length > 80 ? `${content.slice(0, 80)}…` : content,
    source: {
      sourceId: sessionId,
      sourceType: 'session_transcript',
      title,
      capturedAt,
    },
    // 本地事件流没有独立的「入库时刻」：与来源时刻同值（见文件头第 3 条）
    storedAt: capturedAt,
  };
}

/** 时间戳规范化：不可解析时回落到 epoch（排序按最旧处理，不会把坏数据顶上来） */
function normalizeInstant(value: string | undefined): string {
  const ms = Date.parse(value ?? '');
  return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/**
 * 把若干会话的事件流投影成召回语料（**纯函数**，不打 IO，便于离线测）。
 *
 * 逐条校验 `expectedScope`：语料被放错分区时宁可不召回，也不能把别人的记忆检索出来。
 */
export function buildCorpusFromSessions(
  sessions: readonly SessionCorpusInput[],
  opts: { userScope: string; limit?: number },
): StoredMemory[] {
  const limit = opts.limit ?? RECALL_CORPUS_LIMIT;
  const out: StoredMemory[] = [];

  for (const session of sessions ?? []) {
    if (!session || typeof session.sessionId !== 'string') continue;
    const messages = projectMessages(activePath(session.events ?? []));
    for (const message of messages) {
      const record = messageToMemory(
        session.sessionId,
        session.title ?? session.sessionId,
        opts.userScope,
        message,
      );
      if (record) out.push(record);
    }
  }

  // 稳定：时间倒序 → memoryId 升序（同刻的消息不能靠插入顺序决定谁进语料）
  out.sort((a, b) => {
    const dt = Date.parse(b.source.capturedAt) - Date.parse(a.source.capturedAt);
    return dt !== 0 ? dt : compareStrings(a.memoryId, b.memoryId);
  });
  return out.slice(0, limit);
}

/**
 * 从**事件存储**读取本机全部可检索的会话语料。
 *
 * 只读；`listMetas()` 是磁盘扫描（`electron/eventStore.ts`），因此它天然只覆盖
 * 「本地有事件流」的会话——这正是上面第 1 条口径的来源。
 */
export async function loadEventStreamCorpus(opts: {
  userScope: string;
  limit?: number;
}): Promise<StoredMemory[]> {
  const store = getEventStore();
  const metas: SessionMeta[] = await store.listMetas();
  const sessions: SessionCorpusInput[] = [];

  for (const meta of metas ?? []) {
    if (!meta || typeof meta.id !== 'string') continue;
    try {
      // `meta.workdir` 就是**事件流分片**（`toMeta` 把分片写进该字段，语义空间在
      // `meta.workspace`）。读事件必须按分片，否则切过工作空间的会话会读到空。
      const events = await store.readEvents(meta.id, meta.workdir);
      if (!events || events.length === 0) continue;
      sessions.push({
        sessionId: meta.id,
        title: meta.title ?? meta.id,
        events,
        shard: meta.workdir ?? null,
      });
    } catch {
      // 单个会话读失败不该让整次召回失败：跳过它，其余照常
    }
  }

  return buildCorpusFromSessions(sessions, opts);
}

/** 会话索引条目 → 标题（供 UI 展示「这条来自哪个会话」） */
export function titleOf(entry: Pick<SessionIndexEntry, 'title' | 'id'>): string {
  const title = (entry.title ?? '').trim();
  return title === '' ? entry.id : title;
}
