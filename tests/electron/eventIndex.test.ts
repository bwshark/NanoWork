import { describe, expect, it } from 'vitest';
import {
  SESSION_INDEX_VERSION,
  applyAppend,
  deriveMetaFromEvents,
  emptySessionIndex,
  entryFromMeta,
  listSessionEntries,
  parseSessionIndex,
  parseSessionMeta,
  rebuildSessionIndex,
  removeSessionEntry,
  serializeSessionIndex,
  summarizeTitle,
  upsertEntry,
} from '../../electron/eventIndex';
import type {
  AiTitleEvent,
  MessageEvent,
  SessionIndexEntry,
  SessionMeta,
  SessionStartEvent,
} from '@/types/event';

const T0 = Date.parse('2026-09-16T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function startEvent(over: Partial<SessionStartEvent> = {}): SessionStartEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    parentId: null,
    seq: 1,
    type: 'session-start',
    timestamp: T0,
    agentId: 'a1',
    mode: 'craft',
    permissionMode: 'restricted',
    ...over,
  };
}

function messageEvent(over: Partial<MessageEvent> = {}): MessageEvent {
  return {
    id: 'e2',
    sessionId: 's1',
    parentId: 'e1',
    seq: 2,
    type: 'message',
    timestamp: T0 + 10,
    messageId: 'm2',
    role: 'user',
    content: '帮我整理一下这个目录',
    ...over,
  };
}

function aiTitleEvent(title: string, over: Partial<AiTitleEvent> = {}): AiTitleEvent {
  return {
    id: 'e3',
    sessionId: 's1',
    parentId: 'e2',
    seq: 3,
    type: 'ai-title',
    timestamp: T0 + 20,
    title,
    ...over,
  };
}

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    title: '标题',
    agentId: 'a1',
    mode: 'craft',
    permissionMode: 'restricted',
    createdAt: iso(0),
    updatedAt: iso(0),
    ...over,
  };
}

/**
 * 会话索引纯逻辑单测。
 *
 * 索引是**可再生派生物**，所以这里的重点不是「永不损坏」，而是：
 * 1. 损坏/版本不符时必须**安全降级为空**（丢索引不算事故，误读才算）；
 * 2. 追加投影必须**只增不减**且标题/时间语义正确（列表排序与显示全靠它）；
 * 3. 所有更新**不可变**（否则并发写入会互相覆盖，D2 的双写阶段会踩到）。
 */
describe('eventIndex: 解析与容错', () => {
  it('空值 / 非法 JSON / 结构不符一律降级为空索引', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '"x"', '{"entries":1}']) {
      expect(parseSessionIndex(raw)).toEqual(emptySessionIndex());
    }
  });

  it('schema 版本不符时丢弃（索引可再生，重建即可）', () => {
    const raw = JSON.stringify({ version: 999, entries: { s1: meta() } });
    expect(parseSessionIndex(raw)).toEqual(emptySessionIndex());
  });

  it('合法索引可往返序列化', () => {
    const index = rebuildSessionIndex([meta()], { s1: { eventCount: 3, lastSeq: 3 } });
    const round = parseSessionIndex(serializeSessionIndex(index));
    expect(round).toEqual(index);
    expect(round.version).toBe(SESSION_INDEX_VERSION);
  });
});

describe('eventIndex: deriveMetaFromEvents', () => {
  it('从 session-start 事件取执行上下文，标题取首条用户消息摘要', () => {
    const m = deriveMetaFromEvents('s1', [
      startEvent({ agentId: 'a9', mode: 'ask', permissionMode: 'full', workdir: '/w' }),
      messageEvent({ content: '请把周报整理成表格' }),
    ]);
    expect(m).toMatchObject({
      id: 's1',
      agentId: 'a9',
      mode: 'ask',
      permissionMode: 'full',
      workdir: '/w',
      title: '请把周报整理成表格',
    });
    expect(m.createdAt).toBe(iso(0));
    expect(m.updatedAt).toBe(iso(10));
  });

  it('ai-title 优先于首条消息（自动命名晚于消息）', () => {
    const m = deriveMetaFromEvents('s1', [
      startEvent(),
      messageEvent({ content: '一段很长的用户输入' }),
      aiTitleEvent('自动生成的标题'),
    ]);
    expect(m.title).toBe('自动生成的标题');
  });

  it('标题被折叠为单行并截断', () => {
    const m = deriveMetaFromEvents('s1', [messageEvent({ content: `${'x'.repeat(80)}\n\n第二行` })]);
    expect(m.title.length).toBeLessThanOrEqual(61);
    expect(m.title).toContain('…');
  });

  it('无事件时使用兜底值而非抛错', () => {
    const m = deriveMetaFromEvents('s1', [], { fallback: { agentId: 'af', title: '兜底标题' } });
    expect(m.agentId).toBe('af');
    expect(m.title).toBe('兜底标题');
    expect(m.mode).toBe('craft');
    expect(m.permissionMode).toBe('restricted');
  });
});

describe('eventIndex: applyAppend 投影', () => {
  it('事件数与 lastSeq 只增不减，updatedAt 取最大活动时间', () => {
    let index = applyAppend(emptySessionIndex(), meta(), [startEvent(), messageEvent()], 's1');
    expect(index.entries.s1.eventCount).toBe(2);
    expect(index.entries.s1.lastSeq).toBe(2);
    expect(index.entries.s1.updatedAt).toBe(iso(10));

    const later = messageEvent({ id: 'e9', seq: 9, timestamp: T0 + 5000, content: '后续' });
    index = applyAppend(index, meta({ updatedAt: iso(1000) }), [later], 's1');
    expect(index.entries.s1.eventCount).toBe(3);
    expect(index.entries.s1.lastSeq).toBe(9);
    expect(index.entries.s1.updatedAt).toBe(iso(5000));
  });

  it('本次追加含 ai-title 时覆盖标题', () => {
    let index = applyAppend(emptySessionIndex(), meta({ title: '旧标题' }), [messageEvent()], 's1');
    expect(index.entries.s1.title).toBe('旧标题');
    index = applyAppend(index, meta({ title: '旧标题' }), [aiTitleEvent('新标题')], 's1');
    expect(index.entries.s1.title).toBe('新标题');
  });

  it('appended 为空时用 meta 建档（幂等），无 meta 无既有条目则不动', () => {
    const built = applyAppend(emptySessionIndex(), meta({ pinned: true }), [], 's1');
    expect(built.entries.s1.eventCount).toBe(0);
    expect(built.entries.s1.pinned).toBe(true);

    const untouched = applyAppend(emptySessionIndex(), null, [], 's1');
    expect(untouched.entries.s1).toBeUndefined();
  });

  it('meta 的可同步字段每次追加都覆盖（元数据是权威）', () => {
    let index = applyAppend(emptySessionIndex(), meta(), [messageEvent()], 's1');
    index = applyAppend(index, meta({ pinned: true, channel: 'feishu', title: '改名' }), [], 's1');
    expect(index.entries.s1).toMatchObject({ pinned: true, channel: 'feishu', title: '改名' });
    expect(index.entries.s1.eventCount).toBe(1);
  });

  it('结构不可变：原索引对象不被改写', () => {
    const index = applyAppend(emptySessionIndex(), meta(), [], 's1');
    const snapshot = JSON.parse(JSON.stringify(index)) as typeof index;
    const next = applyAppend(index, meta({ title: 'x' }), [messageEvent()], 's1');
    expect(index).toEqual(snapshot);
    expect(next).not.toBe(index);
    expect(next.entries).not.toBe(index.entries);
  });
});

describe('eventIndex: parseSessionMeta 容错', () => {
  it('非法 JSON / 非对象 / 缺 id 一律返回 null', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '{"title":"x"}']) {
      expect(parseSessionMeta(raw)).toBeNull();
    }
  });

  it('缺字段按安全默认补齐（旧版本 meta 不应丢掉整个会话）', () => {
    const parsed = parseSessionMeta('{"id":"s1"}');
    expect(parsed).toMatchObject({
      id: 's1',
      title: '新任务',
      agentId: 'default',
      mode: 'craft',
      permissionMode: 'restricted',
    });
    expect(typeof parsed!.createdAt).toBe('string');
  });

  it('非法 mode / permissionMode 回落到默认值', () => {
    const parsed = parseSessionMeta(
      '{"id":"s1","mode":"bogus","permissionMode":"yolo"}',
    );
    expect(parsed!.mode).toBe('craft');
    expect(parsed!.permissionMode).toBe('restricted');
  });

  it('合法字段原样保留（含 pinned / channel / rev）', () => {
    const source = meta({ pinned: true, channel: 'feishu', rev: 3, mode: 'plan' });
    const parsed = parseSessionMeta(JSON.stringify(source));
    expect(parsed).toMatchObject({
      id: 's1',
      mode: 'plan',
      pinned: true,
      channel: 'feishu',
      rev: 3,
    });
  });
});

describe('eventIndex: 条目维护与列表', () => {
  it('upsert / remove 均返回新对象', () => {
    const index = emptySessionIndex();
    const entry = entryFromMeta(meta(), { eventCount: 1, lastSeq: 1 });
    const added = upsertEntry(index, entry);
    expect(added.entries.s1).toEqual(entry);
    expect(index.entries.s1).toBeUndefined();

    const removed = removeSessionEntry(added, 's1');
    expect(removed.entries.s1).toBeUndefined();
    expect(added.entries.s1).toBeDefined();
    // 移除不存在的条目时原样返回（避免无谓的重渲染/写盘）
    expect(removeSessionEntry(removed, 'nope')).toBe(removed);
  });

  it('列表：置顶优先 → 最近更新优先 → id 稳定，且过滤软删除', () => {
    const mk = (id: string, updatedAt: string, pinned?: boolean, deletedAt?: string) =>
      ({ ...entryFromMeta(meta({ id }), { eventCount: 0, lastSeq: 0 }), id, updatedAt, pinned, deletedAt }) as SessionIndexEntry;

    const index = {
      version: SESSION_INDEX_VERSION,
      entries: {
        a: mk('a', iso(100)),
        b: mk('b', iso(300)),
        c: mk('c', iso(200), true),
        d: mk('d', iso(999), false, iso(500)),
      },
    };

    expect(listSessionEntries(index).map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('rebuildSessionIndex 用计数补齐 eventCount / lastSeq', () => {
    const rebuilt = rebuildSessionIndex(
      [meta({ id: 's1' }), meta({ id: 's2' })],
      { s1: { eventCount: 7, lastSeq: 7 } },
    );
    expect(rebuilt.entries.s1).toMatchObject({ eventCount: 7, lastSeq: 7 });
    // 未提供计数的会话仍可用，计数待下次追加补齐
    expect(rebuilt.entries.s2).toMatchObject({ eventCount: 0, lastSeq: 0 });
  });

  it('summarizeTitle 折叠空白并在超长时截断', () => {
    expect(summarizeTitle('  a   b\n c ')).toBe('a b c');
    expect(summarizeTitle('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});
