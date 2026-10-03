/**
 * 记忆 v2 的**目录与文件名策略**（`src/lib/memoryPaths.ts`）。
 *
 * 这一层是两端（渲染层 / 主进程）共用的判据，所以它的每条规则都对应一种**真实故障**，
 * 而不是风格偏好。本文件按故障类型组织用例，而不是按函数组织：
 *
 * 1. **越界**：名字里带分隔符 / 上跳（`../`）必须被拒——IPC 是渲染层可达的，
 *    `isMemoryFileName` 在前端只是「界面与磁盘一致」，安全边界在主进程，但两端必须
 *    得出同一个结论，否则会出现「前端能存、主进程拒绝」这类只在某一端复现的差异。
 * 2. **静默忽略**：读取侧必须收下用户手写的笔记（`notes.md`），但必须**排除**同目录下
 *    的产品文件（`index.json` 是旧工作区索引、`.migrated` 是留档）——否则它们会被当成
 *    记忆内容注入 prompt。
 * 3. **不对称**：读取宽、写入严。反过来（写入宽）等于给了一条往工作区任意位置写文件的
 *    跳板；一样宽则会让产品文件被当成记忆。
 * 4. **跨端一致**：工作区标识（事实日志里的归属字段）与 Web 端 localStorage 后缀必须
 *    稳定，改算法等于让所有既有记忆失联。
 */

import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SUBDIR,
  CURATED_MEMORY_FILE,
  CURATED_STATE_FILE,
  DAILY_SUBDIR,
  DEFAULT_WORKSPACE_ID,
  PROFILE_FILE,
  isFactLogFileName,
  isLegacyDailyMemoryFileName,
  isMemoryContentFileName,
  isMemoryEntryName,
  isMemoryFileName,
  isMemorySubdirName,
  isWritableMemoryEntryName,
  isWritableMemoryFileName,
  isWritableMemoryFileNameIn,
  memoryDirDisplayPath,
  memoryEntryName,
  scopeIdFor,
  splitMemoryEntryName,
  webMemoryDirKey,
  workspaceIdFor,
} from '../../src/lib/memoryPaths';

describe('文件名合法性：越界与非法字符', () => {
  it('拒绝含路径分隔符的名字（路径穿越的第一步）', () => {
    expect(isMemoryFileName('../MEMORY.md')).toBe(false);
    expect(isMemoryFileName('a/b.md')).toBe(false);
    expect(isMemoryFileName('a\\b.md')).toBe(false);
    expect(isMemoryFileName('/etc/passwd')).toBe(false);
  });

  it('拒绝以点开头的名字（既排除 .. 也排除隐藏文件）', () => {
    expect(isMemoryFileName('.hidden.md')).toBe(false);
    expect(isMemoryFileName('..')).toBe(false);
    expect(isMemoryFileName('.')).toBe(false);
  });

  it('拒绝 Windows 非法字符与控制字符（写盘会失败，: 还会被当成数据流）', () => {
    for (const name of ['a:b.md', 'a*b.md', 'a?b.md', 'a"b.md', 'a<b.md', 'a>b.md', 'a|b.md']) {
      expect(isMemoryFileName(name), name).toBe(false);
    }
    expect(isMemoryFileName('a\u0000b.md')).toBe(false);
    expect(isMemoryFileName('a\nb.md')).toBe(false);
  });

  it('拒绝首尾空白（Windows 会静默裁掉，于是「列表里有它、读的是另一个文件」）', () => {
    expect(isMemoryFileName(' MEMORY.md')).toBe(false);
    expect(isMemoryFileName('MEMORY.md ')).toBe(false);
  });

  it('收下正常的单段名字与三类后缀', () => {
    expect(isMemoryFileName(CURATED_MEMORY_FILE)).toBe(true);
    expect(isMemoryFileName('2026-09-19.md')).toBe(true);
    expect(isMemoryFileName(CURATED_STATE_FILE)).toBe(true);
    expect(isMemoryFileName('2026-09-19.jsonl')).toBe(true);
    expect(isMemoryFileName('notes.markdown')).toBe(false);
    expect(isMemoryFileName('')).toBe(false);
    expect(isMemoryFileName(undefined)).toBe(false);
  });
});

describe('读取侧：宽，但排除产品文件', () => {
  it('收下用户手写的笔记（静默忽略才是 bug）', () => {
    expect(isMemoryContentFileName('notes.md')).toBe(true);
    expect(isMemoryContentFileName('my-notes.json')).toBe(true);
  });

  it('排除 index.json（旧工作区索引，不是记忆内容）', () => {
    expect(isMemoryContentFileName('index.json')).toBe(false);
  });

  it('排除 .migrated 留档', () => {
    expect(isMemoryContentFileName('MEMORY.md.migrated')).toBe(false);
    // `.migrated` 不以 .md/.json/.jsonl 结尾，本来就过不了第一道
    expect(isMemoryFileName('MEMORY.md.migrated')).toBe(false);
  });
});

describe('写入侧：严（能力边界，不是提示）', () => {
  it('允许 v2 的 canonical 文件与 v1 的兼容文件', () => {
    expect(isWritableMemoryFileName(CURATED_MEMORY_FILE)).toBe(true);
    expect(isWritableMemoryFileName(CURATED_STATE_FILE)).toBe(true);
    expect(isWritableMemoryFileName(PROFILE_FILE)).toBe(true);
    // v1 的日期 .md 继续可写：记忆页的文件编辑器与 legacy 迁移依赖它
    expect(isWritableMemoryFileName('2026-09-19.md')).toBe(true);
  });

  it('不允许应用写入用户手写的名字（读得进、写不得，这条不对称是刻意的）', () => {
    expect(isWritableMemoryFileName('notes.md')).toBe(false);
    expect(isWritableMemoryFileName('index.json')).toBe(false);
    expect(isWritableMemoryFileName('whatever.json')).toBe(false);
  });

  it('子目录白名单：daily 可写、archive 只读', () => {
    expect(isWritableMemoryFileNameIn(DAILY_SUBDIR, '2026-09-19.jsonl')).toBe(true);
    expect(isWritableMemoryFileNameIn(DAILY_SUBDIR, '2026-09-19.md')).toBe(false);
    expect(isWritableMemoryFileNameIn(ARCHIVE_SUBDIR, '2026-09-19.jsonl')).toBe(false);
  });
});

describe('子目录名合法性', () => {
  it('拒绝穿越与非法字符', () => {
    expect(isMemorySubdirName('../evil')).toBe(false);
    expect(isMemorySubdirName('a/b')).toBe(false);
    expect(isMemorySubdirName('.hidden')).toBe(false);
    expect(isMemorySubdirName('')).toBe(false);
  });

  it('收下 daily / archive', () => {
    expect(isMemorySubdirName(DAILY_SUBDIR)).toBe(true);
    expect(isMemorySubdirName(ARCHIVE_SUBDIR)).toBe(true);
  });
});

describe('带子目录的相对名', () => {
  it('拼接与拆分互为逆运算', () => {
    expect(memoryEntryName('a.jsonl', 'daily')).toBe('daily/a.jsonl');
    expect(memoryEntryName('a.jsonl')).toBe('a.jsonl');
    expect(splitMemoryEntryName('daily/a.jsonl')).toEqual({ subdir: 'daily', name: 'a.jsonl' });
    expect(splitMemoryEntryName('a.jsonl')).toEqual({ subdir: '', name: 'a.jsonl' });
  });

  it('可读但不可写的组合被如实区分', () => {
    // 读：archive 在白名单内
    expect(isMemoryEntryName('archive/2026-09-19.jsonl')).toBe(true);
    // 写：archive 不在写入白名单内
    expect(isWritableMemoryEntryName('archive/2026-09-19.jsonl')).toBe(false);
    // 写：daily 在白名单内
    expect(isWritableMemoryEntryName('daily/2026-09-19.jsonl')).toBe(true);
  });

  it('穿越与伪造子目录一律拒绝', () => {
    expect(isMemoryEntryName('../MEMORY.md')).toBe(false);
    expect(isMemoryEntryName('daily/../MEMORY.md')).toBe(false);
    expect(isMemoryEntryName('evil/a.jsonl')).toBe(false);
    expect(isMemoryEntryName('daily/nested/a.jsonl')).toBe(false);
    expect(isWritableMemoryEntryName('daily/notes.md')).toBe(false);
  });
});

describe('日期文件判定', () => {
  it('v1 的 .md 与 v2 的 .jsonl 是两套形态，不互相误判', () => {
    expect(isLegacyDailyMemoryFileName('2026-09-19.md')).toBe(true);
    expect(isLegacyDailyMemoryFileName('2026-09-19.jsonl')).toBe(false);
    expect(isFactLogFileName('2026-09-19.jsonl')).toBe(true);
    expect(isFactLogFileName('2026-09-19.md')).toBe(false);
    expect(isFactLogFileName('2026-9-19.jsonl')).toBe(false);
  });
});

describe('标识符：跨端稳定', () => {
  it('工作区标识对同一目录的多种字面量得到同一个值（大小写 / 分隔符 / 尾斜杠）', () => {
    const a = workspaceIdFor('D:\\Work\\proj');
    expect(workspaceIdFor('d:/work/proj')).toBe(a);
    expect(workspaceIdFor('D:\\Work\\proj\\')).toBe(a);
  });

  it('不同目录得到不同标识', () => {
    expect(workspaceIdFor('/a/b')).not.toBe(workspaceIdFor('/a/c'));
  });

  it('没有工作目录回落 default（与 DEFAULT_WORKSPACE_KEY 同值，两类标识可互推）', () => {
    expect(workspaceIdFor(null)).toBe(DEFAULT_WORKSPACE_ID);
    expect(workspaceIdFor('')).toBe(DEFAULT_WORKSPACE_ID);
    expect(workspaceIdFor('   ')).toBe(DEFAULT_WORKSPACE_ID);
    expect(workspaceIdFor(undefined)).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('用户作用域目录名是 u_<hash8>，不把账号标识里的字符带进路径', () => {
    const id = scopeIdFor('someone@example.com');
    expect(id).toMatch(/^u_[0-9a-f]+$/);
    expect(id).not.toContain('@');
    expect(id).not.toContain('/');
    expect(scopeIdFor('a')).toBe(scopeIdFor('a'));
    expect(scopeIdFor('a')).not.toBe(scopeIdFor('b'));
  });

  it('Web 端存储 key：工作区按 workspaceKeyFor，用户级按 scopeId', () => {
    expect(webMemoryDirKey({ kind: 'workspace', workdir: null })).toBe('nanowork.mem2.ws.default');
    // 形态与 v1 的 `nanowork.wsmem.<basename>-<hash8>` 同后缀，便于人肉对照
    expect(webMemoryDirKey({ kind: 'workspace', workdir: 'D:\\p\\proj' })).toMatch(
      /^nanowork\.mem2\.ws\.proj-[0-9a-f]{8}$/,
    );
    expect(webMemoryDirKey({ kind: 'user', userScope: 'me' })).toBe(
      `nanowork.mem2.user.${scopeIdFor('me')}`,
    );
  });
});

describe('展示路径：两种根各自可读', () => {
  it('工作区级给用户能自己找到的路径', () => {
    expect(memoryDirDisplayPath({ kind: 'workspace', workdir: 'D:\\p\\proj' })).toBe(
      'D:/p/proj/.nanowork/memory/',
    );
  });

  it('用户级指向 user-memory（不是 v1 的单文件）', () => {
    const p = memoryDirDisplayPath({ kind: 'user', userScope: 'me' });
    expect(p).toContain('/user-memory/');
    expect(p.startsWith('~/.nanowork/user-memory/')).toBe(true);
  });

  it('没有工作目录时指向产品目录下的兜底位置', () => {
    expect(memoryDirDisplayPath({ kind: 'workspace', workdir: null })).toBe(
      '~/.nanowork/memory/default/',
    );
  });
});
