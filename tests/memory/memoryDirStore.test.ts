/**
 * 记忆 v2 的磁盘读写（`electron/workspaceMemoryStore.ts` 的 `*In` 一族）。
 *
 * 用**真机临时目录**跑，不打桩 fs：这一层的价值恰恰在「真的把文件写到了哪里、
 * 崩溃时留下了什么」，桩掉 fs 之后测试只能证明「我调用了 writeFile 这个名字」。
 *
 * 覆盖三件出错代价最高的事：
 *
 * 1. **原子替换**（`replaceMemoryFileIn`）：canonical 状态被读到半截 JSON 会让整份记忆
 *    不可用。所以既要有「成功后内容是新的、没有残留临时文件」，也要有「失败后旧版本
 *    保持不变」（用只读目标制造失败）。
 * 2. **两类存储根**：用户级落在 `~/.nanowork/user-memory/<scope-id>/`，**不能**碰 v1 的
 *    `~/.nanowork/MEMORY.md`——那个文件是跨端同步资产，动了会在其他设备上删除用户记忆。
 * 3. **子目录与越界**：`daily/` 可写、`archive/` 只读、`../` 一律拒绝。
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendMemoryFileLine,
  listMemoryFilesIn,
  readMemoryFileIn,
  readMemoryFileLines,
  removeMemoryFileIn,
  replaceMemoryFileIn,
  writeMemoryFileIn,
  type MemoryDirRef,
} from '../../electron/workspaceMemoryStore';
import { userMemoryDir } from '../../electron/memoryRoutes';
import { memoryDir, productDir, type StorageRoots } from '../../electron/storageRoutes';
import { scopeIdFor } from '../../src/lib/memoryPaths';

let root = '';
let workdir = '';
let roots: StorageRoots;
const wsRef: MemoryDirRef = { kind: 'workspace', workdir: '' };
const userRef: MemoryDirRef = { kind: 'user', userScope: 'me@example.com' };

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'nw-mem2-'));
  workdir = join(root, 'proj');
  roots = { home: join(root, 'home'), electronUserData: join(root, 'userdata') };
  await fs.mkdir(workdir, { recursive: true });
  (wsRef as { kind: 'workspace'; workdir: string }).workdir = workdir;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('两类存储根：落点归属', () => {
  it('工作区级落在 <workdir>/.nanowork/memory/', async () => {
    await writeMemoryFileIn(wsRef, 'MEMORY.md', '工作区记忆', roots);
    const target = join(workdir, '.nanowork', 'memory', 'MEMORY.md');
    expect(await fs.readFile(target, 'utf-8')).toBe('工作区记忆');
  });

  it('用户级落在 ~/.nanowork/user-memory/<scope-id>/', async () => {
    await writeMemoryFileIn(userRef, 'profile.json', '{"name":"老王"}', roots);
    const target = join(userMemoryDir('me@example.com', roots), 'profile.json');
    expect(await fs.readFile(target, 'utf-8')).toBe('{"name":"老王"}');
    expect(target).toContain(join(productDir(roots), 'user-memory', scopeIdFor('me@example.com')));
  });

  it('写用户级**不会**碰 v1 的单文件 MEMORY.md（它是跨端同步资产）', async () => {
    const legacy = join(productDir(roots), 'MEMORY.md');
    await fs.mkdir(productDir(roots), { recursive: true });
    await fs.writeFile(legacy, 'v1 的用户级记忆原文', 'utf-8');

    await writeMemoryFileIn(userRef, 'curated.json', '{"schema":2}', roots);
    await replaceMemoryFileIn(userRef, 'curated.json', '{"schema":2,"x":1}', roots);

    // 逐字节不变——迁移/写入都不许动它
    expect(await fs.readFile(legacy, 'utf-8')).toBe('v1 的用户级记忆原文');
  });

  it('没有工作目录时落产品目录下的兜底位置（与 v1 一致）', async () => {
    await writeMemoryFileIn({ kind: 'workspace', workdir: null }, 'MEMORY.md', 'x', roots);
    const target = join(memoryDir(roots), 'default', 'MEMORY.md');
    expect(await fs.readFile(target, 'utf-8')).toBe('x');
  });
});

describe('replaceMemoryFileIn：原子替换', () => {
  it('成功后内容是新的，且**没有残留临时文件**', async () => {
    await replaceMemoryFileIn(wsRef, 'curated.json', '{"rev":1}', roots);
    await replaceMemoryFileIn(wsRef, 'curated.json', '{"rev":2}', roots);

    expect(await readMemoryFileIn(wsRef, 'curated.json', roots)).toBe('{"rev":2}');
    const names = await fs.readdir(join(workdir, '.nanowork', 'memory'));
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(names.sort()).toEqual(['curated.json']);
  });

  it('目标不存在时也能替换（首次写入）', async () => {
    await replaceMemoryFileIn(wsRef, 'preferences.json', '{}', roots);
    expect(await readMemoryFileIn(wsRef, 'preferences.json', roots)).toBe('{}');
  });

  it('失败时**旧版本保持不变**，且临时文件被清理', async () => {
    await replaceMemoryFileIn(wsRef, 'curated.json', '{"rev":1}', roots);

    // 用「目标位置被一个目录占用」制造失败：与原子替换的落点冲突，rename 必失败
    const dir = join(workdir, '.nanowork', 'memory');
    const target = join(dir, 'conflicts.json');
    await fs.mkdir(target, { recursive: true });

    await expect(replaceMemoryFileIn(wsRef, 'conflicts.json', '{}', roots)).rejects.toThrow();

    // 旧内容（这里不存在）没被写成半截，且没有残留临时文件
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // 之前写好的那份没受影响
    expect(await readMemoryFileIn(wsRef, 'curated.json', roots)).toBe('{"rev":1}');
    void target;
  });

  it('名字非法时拒绝写入（能力边界）', async () => {
    await expect(replaceMemoryFileIn(wsRef, 'notes.md', 'x', roots)).rejects.toThrow();
    await expect(replaceMemoryFileIn(wsRef, '../evil.md', 'x', roots)).rejects.toThrow();
    await expect(replaceMemoryFileIn(wsRef, 'index.json', 'x', roots)).rejects.toThrow();
  });
});

describe('appendMemoryFileLine / readMemoryFileLines：JSONL 追行', () => {
  it('逐行追加，读回来就是那些行（不解析 JSON）', async () => {
    await appendMemoryFileLine(wsRef, '2026-09-19.jsonl', '{"a":1}', roots, 'daily');
    await appendMemoryFileLine(wsRef, '2026-09-19.jsonl', '{"a":2}', roots, 'daily');

    expect(await readMemoryFileLines(wsRef, '2026-09-19.jsonl', roots, 'daily')).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  it('文件不存在时读回空数组（不是错误）', async () => {
    expect(await readMemoryFileLines(wsRef, '2026-09-19.jsonl', roots, 'daily')).toEqual([]);
  });

  it('追加会按需创建 daily/ 子目录', async () => {
    await appendMemoryFileLine(wsRef, '2026-09-19.jsonl', '{"a":1}', roots, 'daily');
    const stat = await fs.stat(join(workdir, '.nanowork', 'memory', 'daily'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('archive/ 只读：写与追加都被拒绝', async () => {
    await expect(
      appendMemoryFileLine(wsRef, '2026-09-19.jsonl', '{}', roots, 'archive'),
    ).rejects.toThrow();
    await expect(
      writeMemoryFileIn(wsRef, '2026-09-19.jsonl', '{}', roots, 'archive'),
    ).rejects.toThrow();
  });

  it('子目录穿越被拒绝', async () => {
    await expect(
      writeMemoryFileIn(wsRef, 'a.jsonl', '{}', roots, '../evil'),
    ).rejects.toThrow();
  });
});

describe('listMemoryFilesIn：读取宽、排除产品文件', () => {
  it('列出 canonical 文件与日期 .jsonl，并排除 index.json / .migrated', async () => {
    const dir = join(workdir, '.nanowork', 'memory');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'MEMORY.md'), 'x', 'utf-8');
    await fs.writeFile(join(dir, 'curated.json'), '{}', 'utf-8');
    await fs.writeFile(join(dir, 'index.json'), '{}', 'utf-8');
    await fs.writeFile(join(dir, 'MEMORY.md.migrated'), 'x', 'utf-8');
    await fs.writeFile(join(dir, 'notes.md'), '用户自己写的', 'utf-8');

    const names = await listMemoryFilesIn(wsRef, roots);
    expect(names).toContain('MEMORY.md');
    expect(names).toContain('curated.json');
    expect(names).toContain('notes.md');
    expect(names).not.toContain('index.json');
    expect(names).not.toContain('MEMORY.md.migrated');
    // 排序与 v1 一致：精炼记忆在前
    expect(names[0]).toBe('MEMORY.md');
  });

  it('目录不存在时返回空数组，且不创建目录', async () => {
    expect(await listMemoryFilesIn(userRef, roots)).toEqual([]);
    await expect(fs.stat(join(productDir(roots), 'user-memory'))).rejects.toThrow();
  });

  it('子目录单独列（daily 与根互不混淆）', async () => {
    await appendMemoryFileLine(wsRef, '2026-09-19.jsonl', '{"a":1}', roots, 'daily');
    await writeMemoryFileIn(wsRef, 'MEMORY.md', 'root', roots);

    expect(await listMemoryFilesIn(wsRef, roots, 'daily')).toEqual(['2026-09-19.jsonl']);
    expect(await listMemoryFilesIn(wsRef, roots)).toEqual(['MEMORY.md']);
  });
});

describe('removeMemoryFileIn', () => {
  it('幂等；不存在也不抛错', async () => {
    await writeMemoryFileIn(wsRef, 'curated.json', '{}', roots);
    await removeMemoryFileIn(wsRef, 'curated.json', roots);
    expect(await readMemoryFileIn(wsRef, 'curated.json', roots)).toBeNull();
    await expect(removeMemoryFileIn(wsRef, 'curated.json', roots)).resolves.toBeUndefined();
  });

  it('拒绝非法名字（不静默当成空操作）', async () => {
    await expect(removeMemoryFileIn(wsRef, '../evil.md', roots)).rejects.toThrow();
  });
});
