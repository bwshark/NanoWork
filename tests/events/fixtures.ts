import type {
  SessionEvent,
  SessionIndexEntry,
  SessionIndexFile,
  SessionMeta,
} from '@/types/event';
import { SESSION_INDEX_VERSION } from '@/events/indexFile';

/** 事件 / 元数据 / 索引的测试构造器（被 tests/events 下的多个用例复用） */

export function startEvent(sessionId = 's1', seq = 1): SessionEvent {
  return {
    id: `${sessionId}-start`,
    sessionId,
    parentId: null,
    seq,
    type: 'session-start',
    timestamp: 1000,
    agentId: 'default',
    mode: 'craft',
    permissionMode: 'restricted',
  };
}

export function msgEvent(
  seq: number,
  content: string,
  role: 'user' | 'assistant' = 'user',
  sessionId = 's1',
): SessionEvent {
  return {
    id: `${sessionId}-m${seq}`,
    sessionId,
    parentId: seq > 1 ? `${sessionId}-m${seq - 1}` : null,
    seq,
    type: 'message',
    timestamp: 1000 + seq,
    messageId: `${sessionId}-msg${seq}`,
    role,
    content,
  };
}

export function titleEvent(seq: number, title: string, sessionId = 's1'): SessionEvent {
  return {
    id: `${sessionId}-t${seq}`,
    sessionId,
    parentId: null,
    seq,
    type: 'ai-title',
    timestamp: 1000 + seq,
    title,
  };
}

export function sessionMeta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    title: '会话一',
    agentId: 'default',
    mode: 'craft',
    permissionMode: 'restricted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function indexEntry(over: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 's1',
    title: '会话一',
    agentId: 'default',
    mode: 'craft',
    permissionMode: 'restricted',
    eventCount: 1,
    lastSeq: 1,
    messageCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function sessionIndex(entries: SessionIndexEntry[]): SessionIndexFile {
  return {
    version: SESSION_INDEX_VERSION,
    entries: Object.fromEntries(entries.map((e) => [e.id, e])),
  };
}
