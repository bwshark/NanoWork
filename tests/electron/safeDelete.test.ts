/**
 * 回收站删除（FR-8.11）fail-closed 验证。
 *
 * 核心不变量：trashItem（或任意注入的 trash）失败时**必须**原样抛错，
 * 绝不回退物理删除。若有人给 safeDelete 加一行「失败则 fs.rm」，
 * 下面的「失败即抛错」「trash 仍被调用」两个用例会同时变红。
 */

import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeDelete, type TrashFn } from '../../electron/safeDelete';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'safe-delete-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('safeDelete 基本语义', () => {
  it('存在的文件调用 trash 并传入正确路径', async () => {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'x');
    const trash = vi.fn<TrashFn>().mockResolvedValue(undefined);

    await safeDelete(file, trash);

    expect(trash).toHaveBeenCalledTimes(1);
    expect(trash).toHaveBeenCalledWith(file);
  });

  it('路径不存在 → 幂等成功，trash 不被调用', async () => {
    const missing = join(dir, 'nope');
    const trash = vi.fn<TrashFn>().mockResolvedValue(undefined);

    await expect(safeDelete(missing, trash)).resolves.toBeUndefined();
    expect(trash).not.toHaveBeenCalled();
  });

  it('目录也能整体送回收站', async () => {
    const sub = join(dir, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'f'), 'y');
    const trash = vi.fn<TrashFn>().mockResolvedValue(undefined);

    await safeDelete(sub, trash);

    expect(trash).toHaveBeenCalledWith(sub);
  });
});

describe('FR-8.11 fail-closed：trash 失败绝不降级物理删除', () => {
  it('trash 抛错 → safeDelete 原样抛错（不静默吞掉）', async () => {
    const file = join(dir, 'b.txt');
    await writeFile(file, 'z');
    const boom = new Error('recycle bin busy');
    const trash = vi.fn<TrashFn>().mockRejectedValue(boom);

    await expect(safeDelete(file, trash)).rejects.toBe(boom);
  });

  it('trash 失败时不调用任何物理删除兜底', async () => {
    const file = join(dir, 'c.txt');
    await writeFile(file, 'z');
    const trash = vi.fn<TrashFn>().mockRejectedValue(new Error('x'));

    // 即便 trash 失败，safeDelete 也只允许「抛错」，不允许偷偷 rm。
    // 这里用 rejects 守住主不变量；同时确认 trash 真的被尝试过（不是被短路跳过）。
    await expect(safeDelete(file, trash)).rejects.toThrow();
    expect(trash).toHaveBeenCalledTimes(1);
  });
});
