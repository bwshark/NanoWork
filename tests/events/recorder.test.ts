import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRecordersForTest,
  __setEventStoreForTest,
  createMemoryEventStore,
  createRecorder,
  dropRecorder,
  hasRecorder,
  messageEventIdOf,
  primeRecorder,
  recorderWorkdir,
  recordEvents,
  setRecordErrorSink,
  setRecorderWorkdir,
  waitForSessionWrites,
  type EventStore,
} from '@/events';
import { EventFactory } from '@/events/factory';
import type { SessionEvent } from '@/types/event';

/**
 * 记录器单测：seq / 链尖的连续性、每会话写序、分支点索引。
 *
 * 用**内存实现**做端到端（追加真的进「磁盘」），另用**桩实现**专测队列语义
 * （保序、失败不阻断）——这两件事在内存实现上跑不出来。
 */

/** 只关心 append 调用的桩：记录顺序、可注入失败 */
function spyStore(opts: { failOn?: number } = {}) {
  const appended: Array<{ sessionId: string; workdir?: string | null; events: SessionEvent[] }> = [];
  let call = 0;
  const store: EventStore = {
    capabilities: { fileBacked: false, fileHistory: false },
    async append(params) {
      call += 1;
      if (opts.failOn === call) throw new Error(`append#${call} 失败`);
      appended.push({ sessionId: params.sessionId, workdir: params.workdir, events: params.events });
      return { lastSeq: params.events.at(-1)?.seq ?? 0, eventCount: params.events.length };
    },
    async readEvents() {
      return [];
    },
    async removeSession() {},
    async tombstoneSession() {},
    async readMeta() {
      return null;
    },
    async writeMeta() {},
    async listMetas() {
      return [];
    },
    async readIndex() {
      return { version: 1, entries: {} };
    },
    async listSessions() {
      return [];
    },
    async rebuildIndex() {
      return { version: 1, entries: {} };
    },
    async putBackup() {},
    async getBackup() {
      return null;
    },
  };
  return { store, appended };
}

/** 取一批次里首条事件的内容（断言用；这些批次装的都是 message 事件） */
function firstContent(batch: { events: SessionEvent[] }): string {
  const ev = batch.events[0];
  if (ev.type !== 'message') throw new Error(`预期 message 事件，实际是 ${ev.type}`);
  return ev.content;
}

function history(sessionId = 's1'): SessionEvent[] {  let n = 0;
  const factory = new EventFactory({
    sessionId,
    now: () => 1000,
    genId: () => `h${++n}`,
  });
  return [
    factory.sessionStart({ agentId: 'a1', mode: 'craft', permissionMode: 'restricted' }),
    factory.message({ messageId: 'u1', role: 'user', content: '你好' }),
    factory.message({ messageId: 'a1', role: 'assistant', content: '在的' }),
  ];
}

beforeEach(() => {
  __resetRecordersForTest();
  __setEventStoreForTest(null);
});

afterEach(() => {
  __resetRecordersForTest();
  __setEventStoreForTest(null);
});

describe('记录器的就绪与否', () => {
  it('未就绪时 recordEvents 抛错（静默丢事件才是真问题）', () => {
    expect(hasRecorder('s1')).toBe(false);
    expect(() => recordEvents('s1', (f) => f.sessionEnd({ reason: 'done' }))).toThrow(
      /记录器未就绪/,
    );
  });

  it('createRecorder 后就绪；重复调用不重置 seq', () => {
    createRecorder('s1');
    expect(hasRecorder('s1')).toBe(true);
    const first = recordEvents('s1', (f) => f.message({ messageId: 'u1', role: 'user', content: 'a' }));
    createRecorder('s1'); // 幂等
    const second = recordEvents('s1', (f) => f.message({ messageId: 'u2', role: 'user', content: 'b' }));

    expect(first[0].seq).toBe(1);
    expect(second[0].seq).toBe(2);
  });

  it('primeRecorder 对齐历史：seq 续写、parentId 接在链尖之后', () => {
    const events = history();
    primeRecorder('s1', undefined, events);

    const [next] = recordEvents('s1', (f) =>
      f.message({ messageId: 'u2', role: 'user', content: '继续' }),
    );
    expect(next.seq).toBe(4);
    expect(next.parentId).toBe('h3');
    expect(next.sessionId).toBe('s1');
  });

  it('primeRecorder 幂等：重复打开同一会话不漂移', () => {
    const events = history();
    primeRecorder('s1', undefined, events);
    primeRecorder('s1', undefined, events);
    const [next] = recordEvents('s1', (f) => f.sessionEnd({ reason: 'done' }));
    expect(next.seq).toBe(4);
  });
});

describe('分支点索引：messageId → message 事件 id', () => {
  it('prime 后可按 messageId 查到事件 id', () => {
    primeRecorder('s1', undefined, history());
    expect(messageEventIdOf('s1', 'u1')).toBe('h2');
    expect(messageEventIdOf('s1', 'a1')).toBe('h3');
    expect(messageEventIdOf('s1', '不存在')).toBeUndefined();
  });

  it('新落盘的消息事件会刷新索引（重发后指向新事件）', () => {
    primeRecorder('s1', undefined, history());
    const [branch] = recordEvents('s1', (f) =>
      f.message(
        { messageId: 'u1', role: 'user', content: '改过的' },
        { parentId: messageEventIdOf('s1', 'u1') },
      ),
    );
    expect(branch.parentId).toBe('h2');
    expect(messageEventIdOf('s1', 'u1')).toBe(branch.id);
  });

  it('废弃分支上的消息不作为分支点（只认活跃时间线）', () => {
    let n = 0;
    const f = new EventFactory({ sessionId: 's1', now: () => 1, genId: () => `e${++n}` });
    const s = f.sessionStart({ agentId: 'a', mode: 'craft', permissionMode: 'restricted' });
    const u1 = f.message({ messageId: 'u1', role: 'user', content: '原始' });
    // 废弃分支：u9 从 s 处分叉；随后 u1 被重发覆盖 → 尖端落在 u1b，u9 被绕开
    const u9 = f.message({ messageId: 'u9', role: 'user', content: '废弃' }, { parentId: s.id });
    const u1b = f.message({ messageId: 'u1', role: 'user', content: '最新' }, { parentId: u1.id });

    primeRecorder('s1', undefined, [s, u1, u9, u1b]);
    // u1 指向活跃链上最后一条；u9 在废弃分支上，不应出现
    expect(messageEventIdOf('s1', 'u1')).toBe(u1b.id);
    expect(messageEventIdOf('s1', 'u9')).toBeUndefined();
  });
});

describe('每会话写队列', () => {
  it('多次 record 按调用顺序落盘（Web 侧读改写不丢事件的前提）', async () => {
    const { store, appended } = spyStore();
    __setEventStoreForTest(store);
    createRecorder('s1');

    recordEvents('s1', (f) => f.message({ messageId: 'u1', role: 'user', content: '1' }));
    recordEvents('s1', (f) => f.message({ messageId: 'u2', role: 'user', content: '2' }));
    recordEvents('s1', (f) => f.message({ messageId: 'u3', role: 'user', content: '3' }));
    await waitForSessionWrites('s1');

    expect(appended.map(firstContent)).toEqual(['1', '2', '3']);
    expect(appended.map((a) => a.events[0].seq)).toEqual([1, 2, 3]);
  });

  it('一次 append 失败不阻断后续写入，且错误被上报', async () => {
    const { store, appended } = spyStore({ failOn: 1 });
    __setEventStoreForTest(store);
    const errors: Array<{ sessionId: string; error: unknown }> = [];
    setRecordErrorSink((sessionId, error) => errors.push({ sessionId, error }));

    createRecorder('s1');
    recordEvents('s1', (f) => f.message({ messageId: 'u1', role: 'user', content: 'first' }));
    recordEvents('s1', (f) => f.message({ messageId: 'u2', role: 'user', content: 'second' }));
    await waitForSessionWrites('s1');

    expect(errors).toHaveLength(1);
    expect(errors[0].sessionId).toBe('s1');
    expect(appended.map(firstContent)).toEqual(['second']);
  });

  it('不同会话互不阻塞（各自独立队列）', async () => {
    const { store, appended } = spyStore();
    __setEventStoreForTest(store);
    createRecorder('s1');
    createRecorder('s2');

    recordEvents('s1', (f) => f.message({ messageId: 'u1', role: 'user', content: 'a' }));
    recordEvents('s2', (f) => f.message({ messageId: 'u1', role: 'user', content: 'b' }));
    await Promise.all([waitForSessionWrites('s1'), waitForSessionWrites('s2')]);

    expect(appended.map((a) => a.sessionId)).toEqual(['s1', 's2']);
  });

  it('落盘写入事件正文（端到端：内存实现读回）', async () => {
    const memory = createMemoryEventStore();
    __setEventStoreForTest(memory);
    createRecorder('s1');

    recordEvents('s1', (f) =>
      f.message({ messageId: 'u1', role: 'user', content: '你好', attachments: [{ id: 'x', name: 'a.txt' }] }),
    );
    await waitForSessionWrites('s1');

    const stored = await memory.readEvents('s1');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: 'message', messageId: 'u1', content: '你好' });
  });
});

describe('作用域', () => {
  it('记录器持有作用域；append 携带该作用域', async () => {
    const { store, appended } = spyStore();
    __setEventStoreForTest(store);
    createRecorder('s1', '/w/a');
    expect(recorderWorkdir('s1')).toBe('/w/a');

    recordEvents('s1', (f) => f.sessionEnd({ reason: 'done' }));
    await waitForSessionWrites('s1');
    expect(appended[0].workdir).toBe('/w/a');

    setRecorderWorkdir('s1', '/w/b');
    recordEvents('s1', (f) => f.sessionEnd({ reason: 'done' }));
    await waitForSessionWrites('s1');
    expect(appended[1].workdir).toBe('/w/b');
  });

  it('setRecorderWorkdir 对未建立的记录器是 no-op', () => {
    expect(() => setRecorderWorkdir('nope', '/w')).not.toThrow();
    expect(recorderWorkdir('nope')).toBeUndefined();
  });
});

describe('dropRecorder', () => {
  it('丢弃后就绪状态与索引一并清除', () => {
    primeRecorder('s1', undefined, history());
    dropRecorder('s1');
    expect(hasRecorder('s1')).toBe(false);
    expect(messageEventIdOf('s1', 'u1')).toBeUndefined();
  });

  it('丢弃后重新 prime 可继续使用', () => {
    primeRecorder('s1', undefined, history());
    dropRecorder('s1');
    primeRecorder('s1', undefined, history());
    const [next] = recordEvents('s1', (f) => f.sessionEnd({ reason: 'done' }));
    expect(next.seq).toBe(4);
  });
});

describe('错误上报出口', () => {
  it('未注入 sink 时写盘失败不产生未处理的 rejection', async () => {
    const { store } = spyStore({ failOn: 1 });
    __setEventStoreForTest(store);
    setRecordErrorSink(null);

    createRecorder('s1');
    recordEvents('s1', (f) => f.sessionEnd({ reason: 'done' }));
    // 队列尾始终是「永不拒绝」的 Promise，故等待不会抛
    await expect(waitForSessionWrites('s1')).resolves.toBeUndefined();
  });
});
