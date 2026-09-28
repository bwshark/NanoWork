import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElectronEventStore } from '@/events/electronStore';
import type { ElectronAPI } from '@/platform/types';
import { indexEntry, msgEvent, sessionIndex, sessionMeta } from './fixtures';

/**
 * Electron 事件存储：**转发正确性**测试。
 *
 * 该实现不含业务逻辑（落盘都在主进程），所以测试只关心两件事：
 * 1. 每个契约方法是否把参数原样送到正确的 IPC 通道；
 * 2. `listSessions` 是否用共享的索引排序（与主进程同一份纯函数）派生列表；
 * 3. 桥缺失时是否 fail-fast（而不是静默返回空数据）。
 */

type Win = Window & { electronAPI?: ElectronAPI };

function installBridge(over: Partial<Record<keyof ElectronAPI, unknown>> = {}): ElectronAPI {
  const api = {
    eventsAppend: vi.fn(async () => ({ lastSeq: 1, eventCount: 1 })),
    eventsRead: vi.fn(async () => [msgEvent(1, 'x')]),
    eventsRemove: vi.fn(async () => undefined),
    eventsTombstone: vi.fn(async () => undefined),
    readSessionMeta: vi.fn(async () => null),
    writeSessionMeta: vi.fn(async () => undefined),
    listSessionMetas: vi.fn(async () => []),
    readSessionIndex: vi.fn(async () => sessionIndex([])),
    rebuildSessionIndex: vi.fn(async () => sessionIndex([])),
    putFileBackup: vi.fn(async () => undefined),
    getFileBackup: vi.fn(async () => 'v'),
    ...over,
  } as unknown as ElectronAPI;
  (window as Win).electronAPI = api;
  return api;
}

let api: ElectronAPI;

beforeEach(() => {
  api = installBridge();
});

afterEach(() => {
  delete (window as Win).electronAPI;
});

describe('electronStore: 能力声明', () => {
  it('声明真实文件 + 内容寻址备份', () => {
    expect(createElectronEventStore().capabilities).toEqual({
      fileBacked: true,
      fileHistory: true,
    });
  });
});

describe('electronStore: IPC 转发', () => {
  it('append 原样转发参数并回传计数', async () => {
    const store = createElectronEventStore();
    const params = { sessionId: 's1', workdir: '/w', events: [msgEvent(1, 'x')] };

    await expect(store.append(params)).resolves.toEqual({ lastSeq: 1, eventCount: 1 });
    expect(api.eventsAppend).toHaveBeenCalledWith(params);
  });

  it('readEvents / readMeta / removeSession 透传 sessionId 与 workdir', async () => {
    const store = createElectronEventStore();

    await store.readEvents('s1', '/w');
    expect(api.eventsRead).toHaveBeenCalledWith('s1', '/w');

    await store.readMeta('s1', null);
    expect(api.readSessionMeta).toHaveBeenCalledWith('s1', null);

    await store.removeSession('s1', '/w');
    expect(api.eventsRemove).toHaveBeenCalledWith('s1', '/w');
  });

  it('tombstoneSession 走**独立**通道（复用硬删通道会把墓碑当场抹掉）', async () => {
    const store = createElectronEventStore();
    const dead = { ...sessionMeta(), deletedAt: '2026-09-27T00:00:00.000Z', rev: 3 };

    await store.tombstoneSession(dead);

    expect(api.eventsTombstone).toHaveBeenCalledWith(dead);
    // 硬删通道一次都不该被走到：它会把 meta 与索引条目一起删掉，删除又变回不可传播
    expect(api.eventsRemove).not.toHaveBeenCalled();
  });

  it('writeMeta 转发领域对象（序列化归主进程）', async () => {
    const store = createElectronEventStore();
    const meta = sessionMeta();
    await store.writeMeta(meta);
    expect(api.writeSessionMeta).toHaveBeenCalledWith(meta);
  });

  it('listMetas / rebuildIndex / 备份接口各自对应专用通道', async () => {
    const store = createElectronEventStore();

    await store.listMetas();
    expect(api.listSessionMetas).toHaveBeenCalled();

    await store.rebuildIndex();
    expect(api.rebuildSessionIndex).toHaveBeenCalled();

    await store.putBackup('h', 'content');
    expect(api.putFileBackup).toHaveBeenCalledWith('h', 'content');

    await expect(store.getBackup('h')).resolves.toBe('v');
    expect(api.getFileBackup).toHaveBeenCalledWith('h');
  });
});

describe('electronStore: listSessions 本地派生', () => {
  it('从索引派生列表并按置顶/更新时间排序', async () => {
    api = installBridge({
      readSessionIndex: vi.fn(async () =>
        sessionIndex([
          indexEntry({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
          indexEntry({ id: 'b', pinned: true, updatedAt: '2025-01-01T00:00:00.000Z' }),
        ]),
      ),
    });

    const list = await createElectronEventStore().listSessions();
    expect(list.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('electronStore: 桥缺失时 fail-fast', () => {
  it('window.electronAPI 缺席时调用即抛错（不静默返回空数据）', async () => {
    const store = createElectronEventStore();
    delete (window as Win).electronAPI;

    await expect(store.readEvents('s1', null)).rejects.toThrow(/Electron 桥不可用/);
    await expect(store.append({ sessionId: 's1', workdir: null, events: [] })).rejects.toThrow(
      /Electron 桥不可用/,
    );
  });
});
