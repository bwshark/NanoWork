import { describe, expect, it } from 'vitest';
import { selectOverflowDirs, selectPrunableDirs, type RetainedDirEntry } from '@/observability/retention';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 4);
const isDate = (n: string) => /^\d{4}-\d{2}-\d{2}$/.test(n);

const dirs: RetainedDirEntry[] = [
  { name: '2026-09-01', newestMs: NOW - 33 * DAY }, // 很旧
  { name: '2026-10-01', newestMs: NOW - 3 * DAY },
  { name: '2026-10-04', newestMs: NOW - 1000 }, // 今天
  { name: 'not-a-date', newestMs: NOW - 99 * DAY }, // 用户自己放的
  { name: '2026-09-30', newestMs: 0 }, // 空目录（上次清理崩了的壳子）
];

describe('selectPrunableDirs', () => {
  it('按截止时刻选旧目录，格式不符的一律跳过', () => {
    const cutoff = NOW - 14 * DAY;
    expect(selectPrunableDirs(dirs, cutoff, isDate)).toEqual(['2026-09-01', '2026-09-30']);
  });

  it('恰好落在截止时刻的目录不清（`<` 而非 `<=`）', () => {
    const cutoff = NOW - 3 * DAY;
    // 2026-10-01 的 newestMs 正好等于 cutoff
    expect(selectPrunableDirs(dirs, cutoff, isDate)).not.toContain('2026-10-01');
    expect(selectPrunableDirs(dirs, cutoff + 1, isDate)).toContain('2026-10-01');
  });

  it('空目录（newestMs=0）可清——留着只会让日志目录看起来一堆空文件夹', () => {
    expect(selectPrunableDirs([{ name: '2026-10-04', newestMs: 0 }], NOW, isDate)).toEqual([
      '2026-10-04',
    ]);
  });

  it('cutoff <= 0 表示不清理（与 logRetentionCutoff 的语义对齐）', () => {
    for (const c of [0, -1, Number.NaN])
      expect(selectPrunableDirs(dirs, c, isDate)).toEqual([]);
  });

  it('名字非法的不动——那是用户的东西，不是我们的垃圾', () => {
    const only = [{ name: 'my-notes', newestMs: 0 }];
    expect(selectPrunableDirs(only, NOW, isDate)).toEqual([]);
  });
});

describe('selectOverflowDirs', () => {
  const pids: RetainedDirEntry[] = [
    { name: '1000', newestMs: NOW - 5 * DAY },
    { name: '1001', newestMs: NOW - 4 * DAY },
    { name: '1002', newestMs: NOW - 3 * DAY },
    { name: '1003', newestMs: NOW - 2 * DAY },
    { name: '1004', newestMs: NOW - 1 * DAY },
  ];
  const isPid = (n: string) => /^\d+$/.test(n);

  it('超出上限时从最旧的开始裁', () => {
    expect(selectOverflowDirs(pids, 3, isPid)).toEqual(['1000', '1001']);
    expect(selectOverflowDirs(pids, 5, isPid)).toEqual([]);
    expect(selectOverflowDirs(pids, 9, isPid)).toEqual([]);
  });

  it('max <= 0 / 非有限数不裁（避免「配错一个 0 就把 trace 清空」）', () => {
    for (const m of [0, -3, Number.NaN])
      expect(selectOverflowDirs(pids, m, isPid)).toEqual([]);
  });

  it('时间相同时按名字定序，结果稳定（否则每次跑裁的目录都不一样）', () => {
    const same: RetainedDirEntry[] = [
      { name: '20', newestMs: NOW },
      { name: '10', newestMs: NOW },
      { name: '30', newestMs: NOW },
    ];
    expect(selectOverflowDirs(same, 1, isPid)).toEqual(['10', '20']);
  });
});
