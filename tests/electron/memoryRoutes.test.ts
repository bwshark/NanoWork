/**
 * 工作区记忆的**路径解析与安全校验**（`electron/memoryRoutes.ts`）。
 *
 * 覆盖两类容易出错、出错代价又高的东西：
 *
 * 1. **归属**——绑定了工作目录的会话，记忆必须落进那个目录（`<workdir>/.nanowork/memory/`）；
 *    没有工作目录的会话落产品目录下的 `memory/default/`，两者不能互相折算
 *    （折算会让「没有工作目录的会话」与「真正绑定兜底目录的会话」共用一份记忆）。
 * 2. **越界**——文件名来自渲染层可达的 IPC。`isMemoryFileName` 是渲染层的一致性问题，
 *    这里才是安全边界：名字过白名单，且最终路径必须**逐字符等于** `<记忆目录>/<名字>`。
 */

import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fallbackMemoryDir,
  isWritableMemoryFileName,
  LEGACY_MEMORY_DIR_NAME,
  resolveCuratedMemoryFile,
  resolveLegacyMemoryFile,
  resolveMemoryFile,
  resolveWorkspaceMemoryDir,
} from '../../electron/memoryRoutes';
import { memoryDir, productDir, type StorageRoots } from '../../electron/storageRoutes';
import { workspaceKeyFor } from '../../src/lib/workspace/workspaceKey';
import {
  CURATED_MEMORY_FILE,
  WORKSPACE_MEMORY_DIR,
  WORKSPACE_MEMORY_SUBDIR,
} from '../../src/lib/memory/workspaceMemory';

const HOME = resolve('/tmp/nw-home');
const USER_DATA = resolve('/tmp/nw-userdata');
const roots: StorageRoots = { home: HOME, electronUserData: USER_DATA };

describe('resolveWorkspaceMemoryDir：落点归属', () => {
  it('绑定了工作目录 → <workdir>/.nanowork/memory/', () => {
    const workdir = resolve('/tmp/proj');
    expect(resolveWorkspaceMemoryDir(workdir, roots)).toBe(
      join(workdir, WORKSPACE_MEMORY_DIR, WORKSPACE_MEMORY_SUBDIR),
    );
  });

  it('相对路径按「没有工作目录」处理，而不是落到进程 cwd 下', () => {
    // 上游出 bug 时，「记忆整体落到一个稳定可解释的位置」比「悄悄落到 cwd 下」
    // 好排查得多。
    expect(resolveWorkspaceMemoryDir('relative/proj', roots)).toBe(fallbackMemoryDir(roots));
    expect(isAbsolute(fallbackMemoryDir(roots))).toBe(true);
  });

  it('空串 / 全空白 / 空字节一律落兜底目录', () => {
    for (const value of ['', '   ', undefined, null, 'a\u0000b']) {
      expect(resolveWorkspaceMemoryDir(value as string | null | undefined, roots)).toBe(
        fallbackMemoryDir(roots),
      );
    }
  });

  it('兜底目录在产品目录下、且与旧落点同在 memory/ 之下', () => {
    expect(fallbackMemoryDir(roots)).toBe(join(memoryDir(roots), 'default'));
    expect(memoryDir(roots)).toBe(join(productDir(roots), LEGACY_MEMORY_DIR_NAME));
  });
});

describe('resolveMemoryFile：文件名白名单 + 越界双保险', () => {
  it('合法名字解析成记忆目录的直接子文件', () => {
    const workdir = resolve('/tmp/proj');
    expect(resolveMemoryFile(workdir, CURATED_MEMORY_FILE, roots)).toBe(
      join(resolveWorkspaceMemoryDir(workdir, roots), CURATED_MEMORY_FILE),
    );
    expect(resolveMemoryFile(workdir, '2026-09-19.md', roots)).toBe(
      join(resolveWorkspaceMemoryDir(workdir, roots), '2026-09-19.md'),
    );
  });

  it('非法名字抛错（而不是静默返回一个别的路径）', () => {
    for (const name of [
      '../MEMORY.md',
      'sub/MEMORY.md',
      'sub\\MEMORY.md',
      '.hidden.md',
      'MEMORY.txt',
      '',
      '..',
      'C:foo.md',
    ]) {
      expect(() => resolveMemoryFile('/tmp/proj', name, roots)).toThrow();
    }
  });

  it('抛错信息里带上那个非法名字（否则排查只能靠猜）', () => {
    expect(() => resolveMemoryFile('/tmp/proj', '../x.md', roots)).toThrow(/'?\.\.\/x\.md'?/);
  });

  it('没有工作目录时落到兜底目录下', () => {
    expect(resolveCuratedMemoryFile(null, roots)).toBe(
      join(fallbackMemoryDir(roots), CURATED_MEMORY_FILE),
    );
  });
});

describe('resolveLegacyMemoryFile：旧落点定位', () => {
  it('按 workspaceKeyFor 反查 ~/.nanowork/memory/<key>.md', () => {
    const workdir = 'D:/Workspace/study/nanowork';
    expect(resolveLegacyMemoryFile(workdir, roots)).toBe(
      join(memoryDir(roots), `${workspaceKeyFor(workdir)}.md`),
    );
  });

  it('没有工作目录时是历史就用的 default.md', () => {
    expect(resolveLegacyMemoryFile(undefined, roots)).toBe(
      join(memoryDir(roots), 'default.md'),
    );
  });
});

describe('isWritableMemoryFileName：与渲染层共用同一条边界', () => {
  it('从渲染层模块转出，两端不会各写一份判据', () => {
    expect(isWritableMemoryFileName(CURATED_MEMORY_FILE)).toBe(true);
    expect(isWritableMemoryFileName('2026-09-19.md')).toBe(true);
    expect(isWritableMemoryFileName('notes.md')).toBe(false);
  });
});
