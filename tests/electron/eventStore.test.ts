import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventStore, parseEventJsonl, type EventStore } from '../../electron/eventStore';
import { sessionIndexPath, sessionJsonlPath } from '../../electron/eventRoutes';
import type { StorageRoots } from '../../electron/storageRoutes';
import type { SessionEvent, SessionMeta } from '../../src/types/event';

/**
 * 事件流存储 IO 层单测（D2）。
 *
 * 这是「运行时数据目录化」的核心链路：追加 JSONL → 投影索引 → 重建。
 * 之所以把 IO 独立成 `electron/eventStore.ts`（只依赖 node:fs），正是为了
 * 能在这里用临时目录把整条链路跑通，而不必启动 Electron。
 *
 * 注意：对外是**领域对象**（事件 / 元数据 / 索引），磁盘格式是内部细节——
 * 只有「落盘行数」这类断言才直接读文件，用来证明 append-only 是真的。
 */

let root: string;
let roots: StorageRoots;
let store: EventStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nanowork-events-'));
  roots = { home: root, electronUserData: root };
  store = createEventStore(roots);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 直接读 JSONL 行数（验证 append-only：只增不改） */
function jsonlLineCount(sessionId: string, workdir?: string | null): number {
  const raw = readFileSync(sessionJsonlPath(roots, sessionId, workdir), 'utf-8');
  return raw.split('\n').filter((line) => line.trim()).length;
}

function startEvent(sessionId = 's1', seq = 1): SessionEvent {
  return {
    id: 'e1',
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

function msgEvent(
  seq: number,
  content: string,
  role: 'user' | 'assistant' = 'user',
  sessionId = 's1',
): SessionEvent {
  return {
    id: `e${seq}`,
    sessionId,
    parentId: seq > 1 ? `e${seq - 1}` : null,
    seq,
    type: 'message',
    timestamp: 1000 + seq,
    messageId: `m${seq}`,
    role,
    content,
  };
}

function titleEvent(seq: number, title: string, sessionId = 's1'): SessionEvent {
  return {
    id: `t${seq}`,
    sessionId,
    parentId: null,
    seq,
    type: 'ai-title',
    timestamp: 1000 + seq,
    title,
  };
}

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
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

describe('eventStore: 追加与索引投影', () => {
  it('追加事件落盘 JSONL，并把计数投影进索引', async () => {
    const r = await store.append({
      sessionId: 's1',
      workdir: null,
      events: [startEvent(), msgEvent(2, '你好')],
    });

    expect(r).toEqual({ lastSeq: 2, eventCount: 2 });
    expect(jsonlLineCount('s1', null)).toBe(2);

    const events = await store.readEvents('s1', null);
    expect(events.map((e) => e.type)).toEqual(['session-start', 'message']);

    const idx = await store.readIndex();
    expect(idx.entries.s1.eventCount).toBe(2);
    expect(idx.entries.s1.lastSeq).toBe(2);
  });

  it('多次追加只增不减（append-only）且计数累加', async () => {
    await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'a')] });
    const r = await store.append({
      sessionId: 's1',
      workdir: null,
      events: [msgEvent(2, 'b'), msgEvent(3, 'c')],
    });

    expect(r).toEqual({ lastSeq: 3, eventCount: 3 });
    // 3 行原文，前一次追加没有被重写
    expect(jsonlLineCount('s1', null)).toBe(3);
  });

  it('空追加不写盘也不建索引（幂等 no-op）', async () => {
    const r = await store.append({ sessionId: 's1', workdir: null, events: [] });
    expect(r).toEqual({ lastSeq: 0, eventCount: 0 });
    expect(existsSync(sessionIndexPath(roots))).toBe(false);
    expect(await store.readEvents('s1', null)).toEqual([]);
  });

  it('meta 缺失时从事件流就地推导索引条目（会话不会从列表消失）', async () => {
    await store.append({
      sessionId: 's2',
      workdir: null,
      events: [startEvent('s2'), msgEvent(2, '第一条消息', 'user', 's2')],
    });

    const idx = await store.readIndex();
    expect(idx.entries.s2).toBeDefined();
    expect(idx.entries.s2.lastSeq).toBe(2);
    expect(idx.entries.s2.title).toBe('第一条消息');
  });

  it('索引损坏时被容错丢弃并随下次追加重建', async () => {
    const indexPath = sessionIndexPath(roots);
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, '{ 这不是合法 JSON', 'utf-8');

    const r = await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'x')] });
    expect(r).toEqual({ lastSeq: 1, eventCount: 1 });

    const idx = await store.readIndex();
    expect(idx.entries.s1.eventCount).toBe(1);
  });

  it('workdir 决定事件流落点目录', async () => {
    await store.append({
      sessionId: 's1',
      workdir: '/Users/me/proj',
      events: [msgEvent(1, 'x')],
    });
    expect(existsSync(sessionJsonlPath(roots, 's1', '/Users/me/proj'))).toBe(true);
    expect(await store.readEvents('s1', '/Users/me/proj')).toHaveLength(1);
    // 默认槽里不该出现同一会话
    expect(await store.readEvents('s1', null)).toEqual([]);
  });
});

describe('eventStore: 元数据', () => {
  it('writeMeta 后 readMeta 返回规范化后的领域对象', async () => {
    await store.writeMeta(meta());
    const read = await store.readMeta('s1', null);
    expect(read).toMatchObject({ id: 's1', title: '会话一', mode: 'craft' });
    expect(await store.readMeta('s1', 'D:/other')).toBeNull();
  });

  it('追加时用 meta 覆盖索引字段（meta 是权威）', async () => {
    await store.writeMeta(meta({ title: '来自 meta' }));
    await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'x')] });

    const idx = await store.readIndex();
    expect(idx.entries.s1.title).toBe('来自 meta');
  });

  it('ai-title 事件更新索引标题（自动命名晚于首条消息）', async () => {
    await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'x')] });
    await store.append({ sessionId: 's1', workdir: null, events: [titleEvent(2, '自动标题')] });

    const idx = await store.readIndex();
    expect(idx.entries.s1.title).toBe('自动标题');
  });

  it('listMetas 跨工作空间目录扫描全部元数据', async () => {
    await store.writeMeta(meta());
    await store.writeMeta(meta({ id: 's2', workdir: 'D:/work/a', title: 'W' }));

    const metas = await store.listMetas();
    expect(metas.map((m) => m.id).sort()).toEqual(['s1', 's2']);
  });
});

describe('eventStore: 删除与重建', () => {
  it('删除会话清掉事件流 + 元数据 + 索引条目，且可重复调用', async () => {
    await store.writeMeta(meta());
    await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'x')] });

    await store.remove('s1', null);

    expect(await store.readEvents('s1', null)).toEqual([]);
    expect(await store.readMeta('s1', null)).toBeNull();
    expect((await store.readIndex()).entries.s1).toBeUndefined();

    await expect(store.remove('s1', null)).resolves.toBeUndefined();
  });

  it('tombstone：JSONL 从磁盘上消失，meta 与索引条目留下墓碑（重建也不复活）', async () => {
    await store.writeMeta(meta());
    await store.append({
      sessionId: 's1',
      workdir: null,
      events: [msgEvent(1, 'x'), msgEvent(2, 'y')],
    });
    // 先证明它本来在盘上，否则下面那条「不在了」是空断言
    expect(existsSync(sessionJsonlPath(roots, 's1', null))).toBe(true);

    const deletedAt = '2026-09-27T00:00:00.000Z';
    await store.tombstone({ ...meta(), deletedAt, rev: 2 });

    // ① 正文真的**从盘上消失**（而不是「读不出来」）
    expect(existsSync(sessionJsonlPath(roots, 's1', null))).toBe(false);
    // ② meta 还在，且是墓碑版本——它是删除能跨设备传播的载体
    expect((await store.readMeta('s1', null))?.deletedAt).toBe(deletedAt);
    // ③ 索引条目**当场**带墓碑：列表的数据源是索引，晚一步写就等于「删了又回来」
    expect((await store.readIndex()).entries.s1?.deletedAt).toBe(deletedAt);
    // ④ 全量重建（重启后索引损坏 / schema 升级会走这条）也不能把墓碑洗掉
    const rebuilt = await store.rebuildIndex();
    expect(rebuilt.entries.s1?.deletedAt).toBe(deletedAt);
    expect((await store.readIndex()).entries.s1?.deletedAt).toBe(deletedAt);
  });

  it('rebuildIndex 以 meta 为骨架并按 JSONL 统计计数', async () => {
    await store.writeMeta(meta());
    await store.append({
      sessionId: 's1',
      workdir: null,
      events: [msgEvent(1, 'a'), msgEvent(2, 'b')],
    });

    // 破坏索引，验证完全由磁盘重建
    await writeFile(sessionIndexPath(roots), '{', 'utf-8');
    const idx = await store.rebuildIndex();

    expect(idx.entries.s1.eventCount).toBe(2);
    expect(idx.entries.s1.lastSeq).toBe(2);
    // 也已落盘
    expect((await store.readIndex()).entries.s1.lastSeq).toBe(2);
  });
});

describe('eventStore: 内容寻址备份', () => {
  it('put/get 往返，且同 hash 重复写入被跳过（幂等）', async () => {
    await store.putBackup('abc123', 'v1');
    expect(await store.getBackup('abc123')).toBe('v1');

    // 同 hash（即同内容）再写不同内容：跳过，保留首次写入
    await store.putBackup('abc123', 'v2');
    expect(await store.getBackup('abc123')).toBe('v1');

    expect(await store.getBackup('missing-hash')).toBeNull();
  });
});

describe('eventStore: 边界与容错', () => {
  it('越界 sessionId / hash 一律拒绝', async () => {
    await expect(
      store.append({ sessionId: '../evil', workdir: null, events: [] }),
    ).rejects.toThrow();
    await expect(store.readEvents('..', null)).rejects.toThrow();
    await expect(store.putBackup('../x', 'v')).rejects.toThrow();
  });

  it('parseEventJsonl 逐行容错：坏行跳过，原文不丢', () => {
    expect(parseEventJsonl(null)).toEqual([]);
    expect(parseEventJsonl('')).toEqual([]);
    const parsed = parseEventJsonl('{"a":1}\n\n  \n{bad}\n{"b":2}');
    expect(parsed).toHaveLength(2);
  });
});
