import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_SLUG,
  cwdSlug,
  eventIndexDir,
  eventsRoot,
  fileBackupPath,
  fileHistoryDir,
  isSafeSegment,
  legacySessionsBlobPath,
  projectDir,
  projectsDir,
  resolveEventReadTarget,
  sessionIndexPath,
  sessionJsonlPath,
  sessionMetaPath,
} from '../../electron/eventRoutes';
import type { StorageRoots } from '../../electron/storageRoutes';

const ROOTS: StorageRoots = { home: '/home/u', electronUserData: '/ud' };

/**
 * 事件落点路由单测。
 *
 * 重点覆盖两类「出错代价高、且不易在手工点击中发现」的问题：
 * 1. **布局**——路径写错会让 D2 的迁移找不到旧数据，或让备份与事件分居两处；
 * 2. **越界**——`sessionId` / 备份 hash 都来自上层，带分隔符就能写出目录树之外。
 */
describe('eventRoutes: cwdSlug 编码', () => {
  it('未指定工作空间时归入 default', () => {
    expect(cwdSlug(null)).toBe(DEFAULT_PROJECT_SLUG);
    expect(cwdSlug(undefined)).toBe(DEFAULT_PROJECT_SLUG);
    expect(cwdSlug('')).toBe(DEFAULT_PROJECT_SLUG);
    expect(cwdSlug('   ')).toBe(DEFAULT_PROJECT_SLUG);
  });

  it('编码为可读的 -seg-seg 形态，且跨平台同路径同 slug', () => {
    expect(cwdSlug('/Users/foo/bar')).toBe('-Users-foo-bar');
    // Windows 反斜杠 + 盘符：与 POSIX 同路径应得到同一 slug
    expect(cwdSlug('C:\\Users\\foo\\bar')).toBe('-Users-foo-bar');
    expect(cwdSlug('C:/Users/foo/bar')).toBe('-Users-foo-bar');
    expect(cwdSlug('/Users/foo/bar/')).toBe('-Users-foo-bar');
  });

  it('非法字符与保留名被收敛，不产生可逃逸的片段', () => {
    expect(cwdSlug('/a/../../etc')).not.toContain('..');
    const slug = cwdSlug('/x/con/a b');
    expect(slug).toBe('-x-_con-a_b');
    expect(slug.startsWith('.')).toBe(false);
  });

  it('超长路径被截断到单层名上限', () => {
    const slug = cwdSlug(`/${'a'.repeat(300)}`);
    expect(slug.length).toBeLessThanOrEqual(120);
    expect(slug).not.toContain(sep);
  });
});

describe('eventRoutes: 路径布局', () => {
  it('事件数据根落在 ② electronUserData', () => {
    expect(eventsRoot(ROOTS)).toBe('/ud');
    expect(projectsDir(ROOTS)).toBe(join('/ud', 'projects'));
    expect(eventIndexDir(ROOTS)).toBe(join('/ud', 'index'));
    expect(fileHistoryDir(ROOTS)).toBe(join('/ud', 'file-history'));
  });

  it('会话正文与元数据同目录、按 sessionId 命名', () => {
    const jsonl = sessionJsonlPath(ROOTS, 's1', '/Users/foo');
    const meta = sessionMetaPath(ROOTS, 's1', '/Users/foo');
    expect(jsonl).toBe(join('/ud', 'projects', '-Users-foo', 's1.jsonl'));
    expect(meta).toBe(join('/ud', 'projects', '-Users-foo', 's1.meta.json'));
    expect(projectDir(ROOTS, '/Users/foo')).toBe(join('/ud', 'projects', '-Users-foo'));
  });

  it('未指定工作空间时落到 projects/default', () => {
    expect(sessionJsonlPath(ROOTS, 's2')).toBe(join('/ud', 'projects', 'default', 's2.jsonl'));
  });

  it('索引与备份路径独立于会话目录', () => {
    expect(sessionIndexPath(ROOTS)).toBe(join('/ud', 'index', 'sessions.json'));
    expect(fileBackupPath(ROOTS, 'abc123')).toBe(join('/ud', 'file-history', 'abc123.bak'));
  });

  it('旧 blob 路径与索引路径不同目录（避免迁移时误读）', () => {
    expect(legacySessionsBlobPath(ROOTS)).toBe(join('/ud', 'sessions.json'));
    expect(legacySessionsBlobPath(ROOTS)).not.toBe(sessionIndexPath(ROOTS));
  });
});

describe('eventRoutes: 片段安全校验', () => {
  it('isSafeSegment 拒绝分隔符、上跳与空值', () => {
    expect(isSafeSegment('s1')).toBe(true);
    expect(isSafeSegment('a-b_c.d')).toBe(true);
    expect(isSafeSegment('../etc')).toBe(false);
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('a\\b')).toBe(false);
    expect(isSafeSegment('.hidden')).toBe(false);
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('')).toBe(false);
    expect(isSafeSegment('a'.repeat(121))).toBe(false);
  });

  it('非法 sessionId / 备份 hash 抛错（拒绝而非静默清洗）', () => {
    expect(() => sessionJsonlPath(ROOTS, '../../evil')).toThrow(/非法的会话 id/);
    expect(() => sessionMetaPath(ROOTS, 'a/b')).toThrow(/非法的会话 id/);
    expect(() => fileBackupPath(ROOTS, '../x')).toThrow(/非法的备份 hash/);
    expect(() => fileBackupPath(ROOTS, 'bad hash')).toThrow(/非法的备份 hash/);
  });
});

describe('eventRoutes: 读取目标越界校验', () => {
  it('三个允许根内的路径放行', () => {
    for (const target of [
      sessionJsonlPath(ROOTS, 's1', '/Users/foo'),
      sessionMetaPath(ROOTS, 's1', '/Users/foo'),
      sessionIndexPath(ROOTS),
      fileBackupPath(ROOTS, 'abc123'),
    ]) {
      expect(resolveEventReadTarget(target, ROOTS)).toBe(resolve(target));
    }
  });

  it('根之外一律拒绝（含前缀伪装与上跳）', () => {
    expect(resolveEventReadTarget('/etc/passwd', ROOTS)).toBeNull();
    expect(resolveEventReadTarget(join('/ud', 'index-evil', 'x.json'), ROOTS)).toBeNull();
    expect(resolveEventReadTarget(join('/ud', 'projects', '..', '..', 'etc'), ROOTS)).toBeNull();
    expect(resolveEventReadTarget('', ROOTS)).toBeNull();
    expect(resolveEventReadTarget('a\0b', ROOTS)).toBeNull();
  });
});
