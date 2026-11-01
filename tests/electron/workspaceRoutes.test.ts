import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitDiff,
  gitStatus,
  listDirectory,
  mapStatus,
  numstatPath,
  readTextFile,
} from '../../electron/workspaceRoutes';

/**
 * 右栏「文件 / 变更」两个标签页的数据层。
 *
 * 这些函数是纯读写 + git 子进程，**不依赖 Electron**，所以能直接跑：
 * 它们错了的症状都是「界面一片空白但没有任何报错」，那种问题只能靠测试兜住。
 */

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    execFile(cmd, args, { cwd }, (err, stdout) => resolve({ ok: err === null, stdout }));
  });

describe('listDirectory', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nanowork-ls-'));
    await mkdir(join(root, 'b-dir'));
    await mkdir(join(root, 'a-dir'));
    await writeFile(join(root, 'zz.txt'), 'hello');
    await writeFile(join(root, 'aa.txt'), '');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('目录优先、同类按名字排序，并带上文件体积', async () => {
    const result = await listDirectory(root);
    expect(result.ok).toBe(true);
    expect(result.entries.map((e) => e.name)).toEqual(['a-dir', 'b-dir', 'aa.txt', 'zz.txt']);
    expect(result.entries.filter((e) => e.dir).every((e) => e.size === undefined)).toBe(true);
    expect(result.entries.find((e) => e.name === 'zz.txt')?.size).toBe(5);
  });

  it('空路径与不存在的目录都返回失败并带原因（不抛）', async () => {
    expect((await listDirectory('')).ok).toBe(false);
    const missing = await listDirectory(join(root, 'nope'));
    expect(missing.ok).toBe(false);
    expect(missing.entries).toEqual([]);
    expect(missing.error).toBeTruthy();
  });
});

describe('readTextFile', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nanowork-read-'));
    await writeFile(join(root, 'text.txt'), '第一行\n第二行\n');
    await writeFile(join(root, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01]));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('读文本文件返回正文', async () => {
    const result = await readTextFile(join(root, 'text.txt'));
    expect(result.ok).toBe(true);
    expect(result.content).toContain('第二行');
    expect(result.binary).toBeUndefined();
  });

  it('前 8KB 有 NUL 就判为二进制（界面据此显示「无法预览」而不是一片方块）', async () => {
    const result = await readTextFile(join(root, 'bin.dat'));
    expect(result.ok).toBe(true);
    expect(result.binary).toBe(true);
    expect(result.content).toBeUndefined();
  });

  it('目录与不存在的文件都不当文本读', async () => {
    expect((await readTextFile(root)).ok).toBe(false);
    expect((await readTextFile(join(root, 'nope.txt'))).ok).toBe(false);
  });
});

describe('git 状态与 diff 的解析', () => {
  it('状态映射：未跟踪 / 冲突 / 重命名 / 增删改', () => {
    expect(mapStatus('?', '?')).toBe('untracked');
    expect(mapStatus('U', 'U')).toBe('conflicted');
    expect(mapStatus('A', 'A')).toBe('conflicted');
    expect(mapStatus('R', ' ')).toBe('renamed');
    expect(mapStatus('A', ' ')).toBe('added');
    expect(mapStatus(' ', 'D')).toBe('deleted');
    expect(mapStatus(' ', 'M')).toBe('modified');
  });

  it('--numstat 的重命名路径还原成**新**路径（否则行数统计会静默变成 0）', () => {
    expect(numstatPath('src/a.ts')).toBe('src/a.ts');
    expect(numstatPath('old/a.ts => new/a.ts')).toBe('new/a.ts');
    expect(numstatPath('src/{old => new}/a.ts')).toBe('src/new/a.ts');
  });
});

describe('gitStatus / gitDiff（真实仓库）', () => {
  let repo = '';
  let hasGit = false;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'nanowork-git-'));
    hasGit = (await run('git', ['--version'])).ok;
    if (!hasGit) return;
    await run('git', ['init'], repo);
    await run('git', ['config', 'user.email', 't@example.com'], repo);
    await run('git', ['config', 'user.name', 't'], repo);
    await writeFile(join(repo, 'app.ts'), 'line1\nline2\n');
    await run('git', ['add', '.'], repo);
    await run('git', ['commit', '-m', 'init'], repo);
    // 一个修改 + 一个未跟踪
    await writeFile(join(repo, 'app.ts'), 'line1\nline2\nline3\n');
    await writeFile(join(repo, 'fresh.ts'), 'a\nb\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('非 git 目录返回 isRepo=false 而不是抛错（界面要能说「这里不是仓库」）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'nanowork-nogit-'));
    try {
      const result = await gitStatus(empty);
      expect(result.ok).toBe(false);
      expect(result.isRepo).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('列出修改与未跟踪文件，并统计增删行数', async () => {
    if (!hasGit) return;
    const result = await gitStatus(repo);
    expect(result.ok).toBe(true);
    expect(result.isRepo).toBe(true);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(byPath.get('app.ts')?.status).toBe('modified');
    expect(byPath.get('app.ts')?.added).toBe(1);
    expect(byPath.get('fresh.ts')?.status).toBe('untracked');
    // 未跟踪文件 git 不给行数，由主进程自己数
    expect(byPath.get('fresh.ts')?.added).toBe(2);
    expect(result.added).toBe(3);
  });

  it('单个文件的 diff 带出改动行', async () => {
    if (!hasGit) return;
    const result = await gitDiff(repo, 'app.ts');
    expect(result.ok).toBe(true);
    expect(result.patch).toContain('+line3');
  });

  it('未跟踪文件合成「全新增」patch（否则点开是空白）', async () => {
    if (!hasGit) return;
    const result = await gitDiff(repo, 'fresh.ts');
    expect(result.ok).toBe(true);
    expect(result.patch).toContain('new file mode');
    expect(result.patch).toContain('+a');
  });

  it('工作目录之外的路径一律拒绝', async () => {
    if (!hasGit) return;
    const result = await gitDiff(repo, '../outside.ts');
    expect(result.ok).toBe(false);
  });
});
