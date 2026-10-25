/**
 * 工作区记忆的磁盘读写（`electron/workspaceMemoryStore.ts`）。
 *
 * 用**真机临时目录**跑，不打桩 fs：这一层的价值恰恰在「真的把文件写到了哪里」，
 * 桩掉 fs 之后测试只能证明「我调用了 writeFile 这个名字」。
 *
 * 覆盖的重点是**旧数据懒迁移**与**清空范围**这两件不可逆的事：
 * 迁移写错位置会让旧记忆凭空消失，清空多删一个文件会让用户的工作目录里少东西。
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMemoryFiles,
  LEGACY_ARCHIVE_SUFFIX,
  listMemoryFiles,
  migrateLegacyMemory,
  readMemoryFile,
  removeMemoryFile,
  writeMemoryFile,
} from '../../electron/workspaceMemoryStore';
import { resolveLegacyMemoryFile } from '../../electron/memoryRoutes';
import { memoryDir, type StorageRoots } from '../../electron/storageRoutes';
import { CURATED_MEMORY_FILE } from '../../src/lib/memory/workspaceMemory';

let root = '';
/** 当作「用户的工作目录」的临时目录 */
let workdir = '';
let roots: StorageRoots;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'nw-mem-'));
  workdir = join(root, 'proj');
  roots = { home: join(root, 'home'), electronUserData: join(root, 'userdata') };
  await fs.mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** 记忆目录的绝对路径（测试里要直接往里面放东西） */
function memDir(): string {
  return join(workdir, '.nanowork', 'memory');
}

describe('list / read / write：基本文件操作', () => {
  it('目录不存在时 list 返回空数组，且**不创建目录**', async () => {
    expect(await listMemoryFiles(workdir, roots)).toEqual([]);
    // 只是读一下就凭空留一个 .nanowork/ 目录，会让每个被打开过的项目都多一个空文件夹
    await expect(fs.access(join(workdir, '.nanowork'))).rejects.toThrow();
  });

  it('write 自动建目录，read 原样读回，list 按注入顺序返回', async () => {
    await writeMemoryFile(workdir, '2026-09-20.md', '第二天的日志', roots);
    await writeMemoryFile(workdir, CURATED_MEMORY_FILE, '精炼记忆', roots);

    expect(await readMemoryFile(workdir, CURATED_MEMORY_FILE, roots)).toBe('精炼记忆');
    expect(await readMemoryFile(workdir, '2026-09-20.md', roots)).toBe('第二天的日志');
    expect(await listMemoryFiles(workdir, roots)).toEqual([
      CURATED_MEMORY_FILE,
      '2026-09-20.md',
    ]);
  });

  it('读取不存在的文件返回 null（区别于「存在但是空的」）', async () => {
    expect(await readMemoryFile(workdir, CURATED_MEMORY_FILE, roots)).toBeNull();
    await writeMemoryFile(workdir, CURATED_MEMORY_FILE, '', roots);
    expect(await readMemoryFile(workdir, CURATED_MEMORY_FILE, roots)).toBe('');
  });

  it('write 拒绝白名单外的名字（这条 IPC 的能力边界）', async () => {
    await expect(writeMemoryFile(workdir, 'notes.md', 'x', roots)).rejects.toThrow();
    await expect(writeMemoryFile(workdir, '../escape.md', 'x', roots)).rejects.toThrow();
    await expect(writeMemoryFile(workdir, 'MEMORY.txt', 'x', roots)).rejects.toThrow();
  });

  it('写目标被目录占用时抛错，而不是静默失败', async () => {
    await fs.mkdir(join(memDir(), CURATED_MEMORY_FILE), { recursive: true });
    await expect(
      writeMemoryFile(workdir, CURATED_MEMORY_FILE, 'x', roots),
    ).rejects.toThrow(/非普通文件/);
  });

  it('目录里的非 .md 文件不会被误当成记忆', async () => {
    await fs.mkdir(memDir(), { recursive: true });
    await fs.writeFile(join(memDir(), 'index.json'), '{}', 'utf-8');
    await fs.writeFile(join(memDir(), CURATED_MEMORY_FILE), '真的记忆', 'utf-8');

    expect(await listMemoryFiles(workdir, roots)).toEqual([CURATED_MEMORY_FILE]);
  });

  it('用户手写的 .md 会被读进来（静默忽略才是 bug）', async () => {
    await fs.mkdir(memDir(), { recursive: true });
    await fs.writeFile(join(memDir(), 'notes.md'), '用户自己写的笔记', 'utf-8');

    expect(await listMemoryFiles(workdir, roots)).toEqual(['notes.md']);
    expect(await readMemoryFile(workdir, 'notes.md', roots)).toBe('用户自己写的笔记');
  });
});

describe('remove / clear：删除范围', () => {
  it('removeMemoryFile 是幂等的', async () => {
    await writeMemoryFile(workdir, CURATED_MEMORY_FILE, 'x', roots);
    await removeMemoryFile(workdir, CURATED_MEMORY_FILE, roots);
    expect(await readMemoryFile(workdir, CURATED_MEMORY_FILE, roots)).toBeNull();
    // 再删一次不抛错
    await expect(removeMemoryFile(workdir, CURATED_MEMORY_FILE, roots)).resolves.toBeUndefined();
  });

  it('clearMemoryFiles 只删记忆文件，不删目录、也不动其它文件', async () => {
    await writeMemoryFile(workdir, CURATED_MEMORY_FILE, 'a', roots);
    await writeMemoryFile(workdir, '2026-09-19.md', 'b', roots);
    await fs.writeFile(join(memDir(), 'index.json'), '{}', 'utf-8');

    expect(await clearMemoryFiles(workdir, roots)).toBe(2);

    expect(await listMemoryFiles(workdir, roots)).toEqual([]);
    // 目录还在（用户的目录不该被应用顺手删掉），别人的文件也还在
    expect(await fs.readFile(join(memDir(), 'index.json'), 'utf-8')).toBe('{}');
  });

  it('目录不存在时清空返回 0（幂等，不抛错）', async () => {
    expect(await clearMemoryFiles(workdir, roots)).toBe(0);
  });
});

describe('migrateLegacyMemory：旧单文件落点懒迁移', () => {
  /** 造一个旧落点文件，并把 mtime 设成指定日期 */
  async function seedLegacy(content: string, mtime: Date): Promise<string> {
    const legacy = resolveLegacyMemoryFile(workdir, roots);
    await fs.mkdir(memoryDir(roots), { recursive: true });
    await fs.writeFile(legacy, content, 'utf-8');
    await fs.utimes(legacy, mtime, mtime);
    return legacy;
  }

  it('没有旧文件时不做任何事', async () => {
    expect(await migrateLegacyMemory(workdir, roots)).toEqual([]);
    expect(await listMemoryFiles(workdir, roots)).toEqual([]);
  });

  it('旧内容按**最后修改日**归档成日期文件，旧文件改名留档而不是删除', async () => {
    const legacy = await seedLegacy('旧记忆正文\n', new Date(2026, 8, 12, 10, 0, 0));

    expect(await migrateLegacyMemory(workdir, roots)).toEqual(['2026-09-12.md']);
    expect(await readMemoryFile(workdir, '2026-09-12.md', roots)).toBe('旧记忆正文\n');

    // 旧文件保留为 `<key>.md.migrated`：迁移逻辑一旦有偏差，用户手上还有原件
    await expect(fs.access(legacy)).rejects.toThrow();
    expect(await readMemoryFileAt(`${legacy}${LEGACY_ARCHIVE_SUFFIX}`)).toBe('旧记忆正文\n');
  });

  it('迁移是幂等的：第二次调用不再重复搬', async () => {
    await seedLegacy('旧记忆正文\n', new Date(2026, 8, 12));
    await migrateLegacyMemory(workdir, roots);
    expect(await migrateLegacyMemory(workdir, roots)).toEqual([]);
    expect(await listMemoryFiles(workdir, roots)).toEqual(['2026-09-12.md']);
  });

  it('新目录里已有记忆就整个跳过——不覆盖用户在新目录里的后续编辑', async () => {
    await writeMemoryFile(workdir, CURATED_MEMORY_FILE, '新目录里的内容', roots);
    const legacy = await seedLegacy('旧记忆正文\n', new Date(2026, 8, 12));

    expect(await migrateLegacyMemory(workdir, roots)).toEqual([]);
    expect(await readMemoryFile(workdir, CURATED_MEMORY_FILE, roots)).toBe('新目录里的内容');
    // 旧文件原样留在原处，一个字节都没动
    expect(await readMemoryFileAt(legacy)).toBe('旧记忆正文\n');
  });

  it('旧文件是空的也留档，否则每次启动都要重新检查它一遍', async () => {
    const legacy = await seedLegacy('', new Date(2026, 8, 12));

    expect(await migrateLegacyMemory(workdir, roots)).toEqual([]);
    await expect(fs.access(legacy)).rejects.toThrow();
    await expect(fs.access(`${legacy}${LEGACY_ARCHIVE_SUFFIX}`)).resolves.toBeUndefined();
  });

  it('迁移目标已存在同名留档时直接覆盖（它是同一份文件的上一轮留档）', async () => {
    const legacy = resolveLegacyMemoryFile(workdir, roots);
    await fs.mkdir(memoryDir(roots), { recursive: true });
    await fs.writeFile(`${legacy}${LEGACY_ARCHIVE_SUFFIX}`, '上一轮留档', 'utf-8');
    await fs.writeFile(legacy, '这一轮的内容\n', 'utf-8');

    await migrateLegacyMemory(workdir, roots);

    expect(await readMemoryFileAt(`${legacy}${LEGACY_ARCHIVE_SUFFIX}`)).toBe('这一轮的内容\n');
  });

  it('没有工作目录的会话迁移 default.md', async () => {
    const legacy = resolveLegacyMemoryFile(null, roots);
    await fs.mkdir(memoryDir(roots), { recursive: true });
    await fs.writeFile(legacy, '兜底记忆\n', 'utf-8');

    // 没有工作目录 → 记忆落在产品目录下的兜底目录
    const written = await migrateLegacyMemory(null, roots);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    expect(await listMemoryFiles(null, roots)).toEqual(written);
    expect(await readMemoryFile(null, written[0], roots)).toBe('兜底记忆\n');
  });
});

/** 直接读一个绝对路径（旧落点/留档不在记忆目录里，不能走 readMemoryFile） */
async function readMemoryFileAt(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}
