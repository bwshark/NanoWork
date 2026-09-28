import { beforeEach, describe, expect, it } from 'vitest';
import { platform } from '@/platform';
import { createMemoryEventStore } from '@/events/store';
import type { EventStore } from '@/events/store';
import { createWebEventStore } from '@/events/webStore';
import { msgEvent, sessionMeta, startEvent, titleEvent } from './fixtures';

/**
 * 事件存储**契约测试**（D2）。
 *
 * 同一组断言跑在多个实现上——契约一旦被两个实现同时满足，Phase D 的 UI 就
 * 真的可以在任何平台上照同一套语义读写会话。内存实现是「参照实现」，
 * Web 分片实现是真实降级路径（jsdom + localStorage 垫片即可跑）。
 *
 * Electron 实现不在此列：它是纯 IPC 转发，用 mock 桥单独验证转发正确性
 * （见 electronStore.test.ts）。
 */

interface Impl {
  name: string;
  create: () => EventStore;
  reset: () => Promise<void>;
}

const IMPLS: Impl[] = [
  {
    name: 'memory（参照实现）',
    create: () => createMemoryEventStore(),
    reset: async () => {},
  },
  {
    name: 'web（分片降级）',
    create: () => createWebEventStore(),
    reset: () => platform.storage.clear(),
  },
];

for (const impl of IMPLS) {
  describe(`事件存储契约：${impl.name}`, () => {
    let store: EventStore;

    beforeEach(async () => {
      await impl.reset();
      store = impl.create();
    });

    it('追加后可读回事件，并返回计数', async () => {
      const r = await store.append({
        sessionId: 's1',
        workdir: null,
        events: [startEvent(), msgEvent(2, '你好')],
      });

      expect(r).toEqual({ lastSeq: 2, eventCount: 2 });
      const events = await store.readEvents('s1', null);
      expect(events.map((e) => e.type)).toEqual(['session-start', 'message']);
      expect(events[1]).toMatchObject({ content: '你好' });
    });

    it('多次追加累计（append-only，不丢历史）', async () => {
      await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'a')] });
      const r = await store.append({
        sessionId: 's1',
        workdir: null,
        events: [msgEvent(2, 'b'), msgEvent(3, 'c')],
      });

      expect(r).toEqual({ lastSeq: 3, eventCount: 3 });
      expect(await store.readEvents('s1', null)).toHaveLength(3);
    });

    it('空追加不建索引条目（幂等 no-op）', async () => {
      const r = await store.append({ sessionId: 's1', workdir: null, events: [] });
      expect(r).toEqual({ lastSeq: 0, eventCount: 0 });
      expect((await store.readIndex()).entries.s1).toBeUndefined();
      expect(await store.readEvents('s1', null)).toEqual([]);
    });

    it('meta 缺失时从事件流推导条目（会话不会消失）', async () => {
      await store.append({
        sessionId: 's2',
        workdir: null,
        events: [startEvent('s2'), msgEvent(2, '第一条消息', 'user', 's2')],
      });

      const idx = await store.readIndex();
      expect(idx.entries.s2).toMatchObject({ lastSeq: 2, title: '第一条消息' });
    });

    it('meta 是权威：写入后追加会把它投影进索引', async () => {
      await store.writeMeta(sessionMeta({ title: '来自 meta' }));
      await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'x')] });

      expect((await store.readIndex()).entries.s1.title).toBe('来自 meta');
      expect(await store.readMeta('s1', null)).toMatchObject({ id: 's1', title: '来自 meta' });
    });

    it('ai-title 事件覆盖索引标题', async () => {
      await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'x')] });
      await store.append({ sessionId: 's1', workdir: null, events: [titleEvent(2, '自动标题')] });

      expect((await store.readIndex()).entries.s1.title).toBe('自动标题');
    });

    it('listSessions：过滤软删除，置顶优先、其后按更新时间倒序', async () => {
      await store.writeMeta(sessionMeta({ id: 's1', updatedAt: '2026-01-01T00:00:00.000Z' }));
      await store.writeMeta(sessionMeta({ id: 's2', updatedAt: '2026-02-01T00:00:00.000Z' }));
      await store.writeMeta(
        sessionMeta({ id: 's3', pinned: true, updatedAt: '2025-01-01T00:00:00.000Z' }),
      );
      await store.writeMeta(sessionMeta({ id: 's4', deletedAt: '2026-03-01T00:00:00.000Z' }));
      for (const id of ['s1', 's2', 's3', 's4']) {
        await store.append({ sessionId: id, workdir: null, events: [msgEvent(1, 'x', 'user', id)] });
      }

      const list = await store.listSessions();
      expect(list.map((e) => e.id)).toEqual(['s3', 's2', 's1']);
    });

    it('removeSession 清掉事件流、元数据与索引条目，且可重复调用', async () => {
      await store.writeMeta(sessionMeta());
      await store.append({ sessionId: 's1', workdir: null, events: [msgEvent(1, 'x')] });

      await store.removeSession('s1', null);

      expect(await store.readEvents('s1', null)).toEqual([]);
      expect(await store.readMeta('s1', null)).toBeNull();
      expect((await store.readIndex()).entries.s1).toBeUndefined();
      await expect(store.removeSession('s1', null)).resolves.toBeUndefined();
    });

    it('tombstoneSession：墓碑当场进索引、正文丢弃、meta 保留，重建索引也不复活', async () => {
      await store.writeMeta(sessionMeta());
      await store.append({
        sessionId: 's1',
        workdir: null,
        events: [msgEvent(1, 'x'), msgEvent(2, 'y')],
      });
      const deletedAt = '2026-09-27T00:00:00.000Z';
      expect((await store.readIndex()).entries.s1.eventCount).toBe(2);

      await store.tombstoneSession({ ...sessionMeta(), deletedAt, rev: 2 });

      // 正文丢弃：删了就不该再留在盘上
      expect(await store.readEvents('s1', null)).toEqual([]);
      // meta 与索引条目**保留**：这是删除能跨设备传播的唯一载体（硬删在这里不留痕迹）
      expect(await store.readMeta('s1', null)).toMatchObject({ id: 's1', deletedAt });
      const entry = (await store.readIndex()).entries.s1;
      expect(entry?.deletedAt).toBe(deletedAt);
      // 计数照抄既有条目而不是重算成 0：正文已丢，重算等于抹掉「这条曾有很多消息」
      expect(entry?.eventCount).toBe(2);
      // 列表的数据源是索引 → 墓碑必须**当场**生效，否则重启后「删了的会话又回来」
      expect(await store.listSessions()).toEqual([]);
      // 重建索引走的是「meta → 条目」投影，同样不能把它放回来
      expect((await store.rebuildIndex()).entries.s1?.deletedAt).toBe(deletedAt);
      expect(await store.listSessions()).toEqual([]);
    });

    it('rebuildIndex 依元数据与事件计数重建', async () => {
      await store.writeMeta(sessionMeta());
      await store.append({
        sessionId: 's1',
        workdir: null,
        events: [msgEvent(1, 'a'), msgEvent(2, 'b')],
      });

      const idx = await store.rebuildIndex();
      expect(idx.entries.s1).toMatchObject({ eventCount: 2, lastSeq: 2 });
    });

    it('listMetas 枚举全部会话元数据', async () => {
      await store.writeMeta(sessionMeta({ id: 's1' }));
      await store.writeMeta(sessionMeta({ id: 's2', title: 'W' }));

      const metas = await store.listMetas();
      expect(metas.map((m) => m.id).sort()).toEqual(['s1', 's2']);
    });

    it('能力声明齐备（真实值由实现决定）', () => {
      expect(typeof store.capabilities.fileBacked).toBe('boolean');
      expect(typeof store.capabilities.fileHistory).toBe('boolean');
    });
  });
}

describe('事件存储能力差异', () => {
  it('Web 分片实现：非真实文件、无内容寻址备份', async () => {
    await platform.storage.clear();
    const store = createWebEventStore();
    expect(store.capabilities).toEqual({ fileBacked: false, fileHistory: false });

    // 备份接口在 Web 上安全降级（no-op / null），不是抛错
    await expect(store.putBackup('h', 'v')).resolves.toBeUndefined();
    expect(await store.getBackup('h')).toBeNull();
  });

  it('内存参照实现支持备份（用于验证回滚相关逻辑）', async () => {
    const store = createMemoryEventStore();
    expect(store.capabilities.fileHistory).toBe(true);
    await store.putBackup('h', 'v1');
    await store.putBackup('h', 'v2'); // 同 hash 幂等
    expect(await store.getBackup('h')).toBe('v1');
  });
});
