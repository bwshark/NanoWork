/**
 * 事件流适配器单测（批次 5 §2.1 / §2.3 / §2.4）。
 *
 * 覆盖规格可证伪判据：
 * - **J1-a** 按 id 去重（删去重分支 → 红）；
 * - **J3-a** 落地只认**本机**分片（不照抄发送方路径）；
 * - **J3-b** 会话未知 / 墓碑 → 跳过且不建文件；
 * - **J4-b** 并集按 `(seq asc, id asc)` 排序确定且幂等。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getEventStore } from '@/events';
import { createSessionEventStreamAdapter } from '@/sync/eventStream';
import { useSessionsStore } from '@/stores/sessionsStore';
import { resetEventStream } from '../helpers/eventStream';
import { makeSession } from '../helpers/deviceSnapshot';
import type { SessionEvent } from '@/types/event';
import type { Session } from '@/types';

const DEV_B_WS = '/devB/ws';
const SENDER_WS = '/devA/ws';

function evt(id: string, seq: number, sessionId = 's1'): SessionEvent {
  return {
    id,
    sessionId,
    parentId: null,
    seq,
    type: 'ai-title',
    timestamp: 1000 + seq,
    title: id,
  };
}

function seedSessions(sessions: Session[]): void {
  useSessionsStore.setState({ sessions, activeId: null, sessionTombstones: {} });
}

beforeEach(() => {
  resetEventStream();
  seedSessions([]);
});

describe('J1-a / J3-a：去重与落地分片', () => {
  it('appendRemoteEvents 对已存在 id 的事件不重复落地', async () => {
    seedSessions([makeSession('s1', { workdir: '/remote', streamWorkdir: DEV_B_WS })]);
    const adapter = createSessionEventStreamAdapter();
    const batch = [evt('e1', 1), evt('e2', 2)];

    expect(await adapter.appendRemoteEvents('s1', batch)).toBe(2);
    // 删掉去重分支（改无条件追加）→ 这里会得到 2 → 红
    expect(await adapter.appendRemoteEvents('s1', batch)).toBe(0);

    const stored = await getEventStore().readEvents('s1', DEV_B_WS);
    expect(stored.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('appendRemoteEvents 落到【本机】分片（不照抄发送方路径）', async () => {
    // 会话语义工作空间 ∈ 发送方；落盘分片 ∈ 接收方（B）
    seedSessions([makeSession('s1', { workdir: SENDER_WS, streamWorkdir: DEV_B_WS })]);
    const adapter = createSessionEventStreamAdapter();

    await adapter.appendRemoteEvents('s1', [evt('e1', 1)]);

    // 把分片写成发送方路径 / 写死 DEV_B_WS 之外的值 → 断言红
    expect((await getEventStore().readEvents('s1', DEV_B_WS)).map((e) => e.id)).toEqual(['e1']);
    expect(await getEventStore().readEvents('s1', SENDER_WS)).toEqual([]);
  });

  it('未冻结分片（streamWorkdir 为空）时落到 workdir', async () => {
    seedSessions([makeSession('s1', { workdir: '/ws', streamWorkdir: undefined })]);
    const adapter = createSessionEventStreamAdapter();

    await adapter.appendRemoteEvents('s1', [evt('e1', 1)]);

    expect((await getEventStore().readEvents('s1', '/ws')).map((e) => e.id)).toEqual(['e1']);
  });
});

describe('J3-b：未知 / 非事件流会话跳过', () => {
  it('会话未知 / 墓碑 → 跳过且不建文件', async () => {
    seedSessions([]);
    const adapter = createSessionEventStreamAdapter();

    expect(await adapter.appendRemoteEvents('ghost', [evt('e1', 1, 'ghost')])).toBe(0);
    expect(await getEventStore().readEvents('ghost', DEV_B_WS)).toEqual([]);
  });

  it('IM / 只读 / cron 会话不算本机事件流会话', async () => {
    seedSessions([
      makeSession('local', { streamWorkdir: '/a' }),
      makeSession('im', { channel: 'feishu' }),
      makeSession('ro', { readonly: true }),
      makeSession('cron:x'),
    ]);

    const ids = createSessionEventStreamAdapter()
      .localSessions()
      .map((s) => s.id);
    expect(ids).toEqual(['local']);

    const adapter = createSessionEventStreamAdapter();
    expect(await adapter.appendRemoteEvents('im', [evt('e1', 1, 'im')])).toBe(0);
  });
});

describe('readEventsSince / 排序确定性', () => {
  it('readEventsSince 过滤 seq 且按 (seq asc, id asc) 升序', async () => {
    seedSessions([makeSession('s1', { streamWorkdir: DEV_B_WS })]);
    await getEventStore().append({
      sessionId: 's1',
      workdir: DEV_B_WS,
      events: [evt('e2', 2), evt('e1', 1), evt('e3', 3)],
    });
    const adapter = createSessionEventStreamAdapter();

    expect((await adapter.readEventsSince('s1', 1)).map((e) => e.id)).toEqual(['e2', 'e3']);
    expect((await adapter.readEventsSince('s1', 0)).map((e) => e.id)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
  });

  it('会话未知时 readEventsSince 返回 []', async () => {
    seedSessions([]);
    expect(await createSessionEventStreamAdapter().readEventsSince('ghost', 0)).toEqual([]);
  });

  it('J4-b：并集按 (seq,id) 排序确定且落地幂等', async () => {
    seedSessions([makeSession('s1', { streamWorkdir: DEV_B_WS })]);
    const adapter = createSessionEventStreamAdapter();
    // 同一 seq 时按 id 字典序：a < b
    const batch = [evt('b', 1), evt('a', 1), evt('c', 2)];

    // 乱序投入，落地后应是确定顺序
    await adapter.appendRemoteEvents('s1', [...batch].reverse());
    const once = (await getEventStore().readEvents('s1', DEV_B_WS)).map((e) => e.id);
    expect(once).toEqual(['a', 'b', 'c']);

    // 再落一次同批 → 幂等（不新增、顺序不变）
    expect(await adapter.appendRemoteEvents('s1', batch)).toBe(0);
    const twice = (await getEventStore().readEvents('s1', DEV_B_WS)).map((e) => e.id);
    expect(twice).toEqual(once);
  });
});
