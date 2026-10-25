import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fileBackup.ts` 是 FR-7.3 的封装层：把「内容寻址备份」（`platform.fileBackup`）
 * 与「时间线元数据」（`useFileBackupStore`）两件事合成一处。这里用 spy 替换
 * `platform.fileBackup`，证明两条链路都被正确驱动；`useFileBackupStore` 是纯
 * 渲染层状态、不碰文件系统，直接用即可。
 */
const { putSpy, getSpy } = vi.hoisted(() => ({
  putSpy: vi.fn(async () => undefined),
  getSpy: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock('@/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      fileBackup: { put: putSpy, get: getSpy },
    },
  };
});

import { contentHash } from '@/lib/core/contentHash';
import {
  fileKeyOf,
  getBackupContent,
  listSnapshots,
  snapshotBeforeWrite,
} from '@/lib/artifact/fileBackup';
import { useFileBackupStore } from '@/stores/fileBackupStore';

const USER_KEY = fileKeyOf('user', null, 'MEMORY.md');

beforeEach(() => {
  putSpy.mockClear();
  getSpy.mockClear();
  useFileBackupStore.setState({ timeline: {} });
});

describe('fileKeyOf（D5）', () => {
  it('口径 memory:scope:workdir:name（workdir 缺省落到空串）', () => {
    expect(fileKeyOf('user', null, 'MEMORY.md')).toBe('memory:user::MEMORY.md');
    expect(fileKeyOf('workspace', 'D:\\ws', 'MEMORY.md')).toBe(
      'memory:workspace:D:\\ws:MEMORY.md',
    );
    // 缺省 workdir 落到空串，跨作用域隔离
    expect(fileKeyOf('workspace', null, '2026-09-29.md')).toBe(
      'memory:workspace::2026-09-29.md',
    );
  });
});

describe('snapshotBeforeWrite（J-A1~A3）', () => {
  it('oldContent 为 null / 空串 → 无物可回滚，跳过（不调 put、不记时间线）', async () => {
    await snapshotBeforeWrite(USER_KEY, null, 'overwrite');
    await snapshotBeforeWrite(USER_KEY, '', 'overwrite');
    expect(putSpy).not.toHaveBeenCalled();
    expect(useFileBackupStore.getState().list(USER_KEY)).toEqual([]);
  });

  it('有旧内容 → 按 contentHash 存盘 + 记一条时间线（op 透传）', async () => {
    await snapshotBeforeWrite(USER_KEY, '旧正文', 'overwrite');
    expect(putSpy).toHaveBeenCalledWith(contentHash('旧正文'), '旧正文');
    const tl = useFileBackupStore.getState().list(USER_KEY);
    expect(tl).toHaveLength(1);
    expect(tl[0].hash).toBe(contentHash('旧正文'));
    expect(tl[0].op).toBe('overwrite');
  });

  it('append / delete 同为有效 op（J-A2），时间线恒为「最新在前」', async () => {
    await snapshotBeforeWrite(USER_KEY, 'a', 'append');
    await snapshotBeforeWrite(USER_KEY, 'b', 'delete');
    const ops = useFileBackupStore.getState().list(USER_KEY).map((e) => e.op);
    // 契约是**倒序（最新在前）**，不是插入序。原先这条断言写的是 `['append','delete']`，
    // 只在两次快照落在同一毫秒时（`at` 相同 → sort 稳定 → 保持插入序）才成立，
    // 跨毫秒就必然红——那是用例与 `list()` 的契约冲突，不是实现坏了。
    expect(ops).toEqual(['delete', 'append']);
  });

  it('两次快照落在同一毫秒时，顺序仍由 seq 决定（不靠 sort 的稳定性）', async () => {
    // 冻结时钟：两次 `record` 拿到**逐字相同**的 `at`，把「同毫秒」这个前提做出来。
    // 没有 `seq` 兜底时这条必然返回插入序（`['append','delete']`）→ 契约失效。
    vi.useFakeTimers();
    try {
      await snapshotBeforeWrite(USER_KEY, 'a', 'append');
      await snapshotBeforeWrite(USER_KEY, 'b', 'delete');
      const timeline = useFileBackupStore.getState().list(USER_KEY);
      expect(timeline.map((e) => e.at)).toEqual([timeline[1].at, timeline[1].at]);
      expect(timeline.map((e) => e.op)).toEqual(['delete', 'append']);
      expect(timeline.map((e) => e.seq)).toEqual([2, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('put 抛错不阻断真实写入（最佳努力，吞掉，且不记时间线）', async () => {
    putSpy.mockRejectedValueOnce(new Error('disk full'));
    await expect(snapshotBeforeWrite(USER_KEY, 'x', 'overwrite')).resolves.toBeUndefined();
    expect(useFileBackupStore.getState().list(USER_KEY)).toEqual([]);
  });
});

describe('getBackupContent / listSnapshots（J-A5~A6）', () => {
  it('getBackupContent 转调 platform.fileBackup.get', async () => {
    getSpy.mockResolvedValueOnce('正文');
    expect(await getBackupContent('h1')).toBe('正文');
    expect(getSpy).toHaveBeenCalledWith('h1');
  });

  it('listSnapshots 倒序：最新写入的快照排在最前', async () => {
    useFileBackupStore.getState().record(USER_KEY, contentHash('a'), 'overwrite');
    await new Promise((r) => setTimeout(r, 2));
    useFileBackupStore.getState().record(USER_KEY, contentHash('b'), 'append');
    await new Promise((r) => setTimeout(r, 2));
    useFileBackupStore.getState().record(USER_KEY, contentHash('c'), 'delete');
    const list = listSnapshots(USER_KEY);
    expect(list.map((e) => e.hash)).toEqual([contentHash('c'), contentHash('b'), contentHash('a')]);
  });
});
