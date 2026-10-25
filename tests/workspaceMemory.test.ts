/**
 * 工作区记忆的**目录约定**纯逻辑（`src/lib/memory/workspaceMemory.ts`）。
 *
 * 这个文件守的是三方（渲染层 / 主进程 / Web 端）共用的那几条判据。它们此前各写
 * 一遍、各自漂移，症状是「界面上列得出这个文件、磁盘上却读不到」。所以这里把每条
 * 规则连同**它排除的那个具体故障**一起钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  CURATED_MEMORY_FILE,
  dailyMemoryFileName,
  isDailyMemoryFileName,
  isMemoryFileName,
  isSameMemoryWorkspace,
  isWritableMemoryFileName,
  mergeMemoryFiles,
  sortMemoryFileNames,
  workspaceMemoryDirPath,
  WORKSPACE_MEMORY_DIR,
  WORKSPACE_MEMORY_SUBDIR,
} from '@/lib/memory/workspaceMemory';

describe('isMemoryFileName：读侧白名单（比写侧宽松）', () => {
  it('接受精炼记忆、日期文件与用户手写的 .md', () => {
    expect(isMemoryFileName('MEMORY.md')).toBe(true);
    expect(isMemoryFileName('2026-09-19.md')).toBe(true);
    // 用户往目录里丢一份 notes.md 是极自然的行为，读不到才是 bug
    expect(isMemoryFileName('notes.md')).toBe(true);
    expect(isMemoryFileName('需求笔记.md')).toBe(true);
    expect(isMemoryFileName('README.MD')).toBe(true);
  });

  it('排除路径穿越与分隔符', () => {
    expect(isMemoryFileName('../MEMORY.md')).toBe(false);
    expect(isMemoryFileName('sub/MEMORY.md')).toBe(false);
    expect(isMemoryFileName('sub\\MEMORY.md')).toBe(false);
    expect(isMemoryFileName('..')).toBe(false);
  });

  it('排除隐藏文件（首字符是点）', () => {
    expect(isMemoryFileName('.hidden.md')).toBe(false);
    expect(isMemoryFileName('.md')).toBe(false);
  });

  it('排除 Windows 非法字符与控制字符（`:` 会被解释成数据流）', () => {
    expect(isMemoryFileName('C:foo.md')).toBe(false);
    expect(isMemoryFileName('a*b.md')).toBe(false);
    expect(isMemoryFileName('a?b.md')).toBe(false);
    expect(isMemoryFileName('a\u0000b.md')).toBe(false);
  });

  it('排除首尾空白（Windows 会静默裁掉，于是「列表里有它、读的是另一个文件」）', () => {
    expect(isMemoryFileName(' MEMORY.md')).toBe(false);
    expect(isMemoryFileName('MEMORY.md ')).toBe(false);
  });

  it('排除非 .md、空串、超长名与非字符串', () => {
    expect(isMemoryFileName('MEMORY.txt')).toBe(false);
    expect(isMemoryFileName('')).toBe(false);
    expect(isMemoryFileName('a'.repeat(65) + '.md')).toBe(false);
    expect(isMemoryFileName(null)).toBe(false);
    expect(isMemoryFileName(42)).toBe(false);
  });
});

describe('isWritableMemoryFileName：写侧白名单（能力边界）', () => {
  it('只放行精炼记忆与日期文件', () => {
    expect(isWritableMemoryFileName(CURATED_MEMORY_FILE)).toBe(true);
    expect(isWritableMemoryFileName('2026-09-19.md')).toBe(true);
  });

  it('不放行用户手写的 .md（读得到，但不许应用去发明名字）', () => {
    expect(isWritableMemoryFileName('notes.md')).toBe(false);
    expect(isWritableMemoryFileName('1.md')).toBe(false);
    expect(isWritableMemoryFileName('2026-9-19.md')).toBe(false);
    expect(isWritableMemoryFileName('20260919.md')).toBe(false);
    expect(isWritableMemoryFileName('2026-09-19.md.bak')).toBe(false);
    expect(isWritableMemoryFileName('../2026-09-19.md')).toBe(false);
    expect(isWritableMemoryFileName(null)).toBe(false);
  });

  it('日期文件判定与写入白名单同源', () => {
    expect(isDailyMemoryFileName('2026-09-19.md')).toBe(true);
    expect(isDailyMemoryFileName('2026-13-01.md')).toBe(true); // 形态合法即可，不校验日历
    expect(isDailyMemoryFileName('MEMORY.md')).toBe(false);
  });
});

describe('dailyMemoryFileName：按**本地时间**命名', () => {
  it('补零到两位数', () => {
    expect(dailyMemoryFileName(new Date(2026, 0, 5))).toBe('2026-01-05.md');
    expect(dailyMemoryFileName(new Date(2026, 11, 31))).toBe('2026-12-31.md');
  });

  it('用本地时间而不是 UTC——否则 UTC+8 的早晨会写进「昨天」的文件名', () => {
    // 本地 2026-09-20 07:00（UTC+8）→ UTC 还是 09-19。文件名必须跟用户心里的「今天」一致。
    const localMorning = new Date(2026, 8, 20, 7, 0, 0);
    expect(dailyMemoryFileName(localMorning)).toBe('2026-09-20.md');
  });

  it('接受 ISO 串与时间戳，非法值回落当前时刻', () => {
    expect(dailyMemoryFileName('2026-09-19T00:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    expect(dailyMemoryFileName(Date.now())).toBe(dailyMemoryFileName(new Date()));
    expect(dailyMemoryFileName('不是时间')).toBe(dailyMemoryFileName(new Date()));
  });
});

describe('sortMemoryFileNames：注入顺序', () => {
  it('精炼记忆 → 日期文件（升序）→ 其它 .md（升序）', () => {
    expect(
      sortMemoryFileNames(['2026-09-20.md', 'notes.md', 'MEMORY.md', '2026-09-19.md']),
    ).toEqual(['MEMORY.md', '2026-09-19.md', '2026-09-20.md', 'notes.md']);
  });

  it('不修改入参（调用方常直接传 listMemoryFiles 的结果）', () => {
    const input = ['b.md', 'a.md'];
    sortMemoryFileNames(input);
    expect(input).toEqual(['b.md', 'a.md']);
  });
});

describe('mergeMemoryFiles：合并注入正文', () => {
  it('按注入顺序拼接，块间以空行分隔', () => {
    const merged = mergeMemoryFiles([
      { name: '2026-09-19.md', content: '日期内容' },
      { name: 'MEMORY.md', content: '精炼内容' },
    ]);
    expect(merged).toBe('精炼内容\n\n日期内容');
  });

  it('跳过空文件与纯空白文件（否则正文里会多出连续空行）', () => {
    const merged = mergeMemoryFiles([
      { name: 'MEMORY.md', content: '   \n ' },
      { name: '2026-09-19.md', content: '只有这份有内容' },
    ]);
    expect(merged).toBe('只有这份有内容');
  });

  it('忽略非法文件名，全空时返回空串', () => {
    expect(mergeMemoryFiles([{ name: '../x.md', content: '越界' }])).toBe('');
    expect(mergeMemoryFiles([])).toBe('');
  });
});

describe('workspaceMemoryDirPath：展示用落点', () => {
  it('按传入路径自带的分隔符拼接（跨平台显示不串味）', () => {
    expect(workspaceMemoryDirPath('D:\\test')).toBe(
      `D:\\test\\${WORKSPACE_MEMORY_DIR}\\${WORKSPACE_MEMORY_SUBDIR}\\`,
    );
    expect(workspaceMemoryDirPath('/home/me/proj/')).toBe(
      `/home/me/proj/${WORKSPACE_MEMORY_DIR}/${WORKSPACE_MEMORY_SUBDIR}/`,
    );
  });

  it('没有工作目录时给产品目录下的兜底目录', () => {
    expect(workspaceMemoryDirPath(null)).toBe(
      `~/${WORKSPACE_MEMORY_DIR}/${WORKSPACE_MEMORY_SUBDIR}/default/`,
    );
    expect(workspaceMemoryDirPath('   ')).toBe(workspaceMemoryDirPath(undefined));
  });
});

describe('isSameMemoryWorkspace：快照过期判据', () => {
  it('同一路径的不同字面量视为相同（否则每轮发送都白读一次盘）', () => {
    expect(isSameMemoryWorkspace('D:\\work', 'd:/work/')).toBe(true);
    expect(isSameMemoryWorkspace('D:/a', 'D:/a')).toBe(true);
  });

  it('两侧都为空视为相同——这与 isSameWorkspacePath 刻意不同', () => {
    // `isSameWorkspacePath` 的契约是「任一侧为空一律 false」（`undefined` = 未指定），
    // 那是给侧边栏分组用的；快照判定里「之前没有工作目录、现在还是没有」必须是
    // 「同一份快照仍然有效」。
    expect(isSameMemoryWorkspace(null, undefined)).toBe(true);
    expect(isSameMemoryWorkspace('', '')).toBe(true);
    expect(isSameMemoryWorkspace('   ', null)).toBe(true);
  });

  it('一侧为空、另一侧有值视为不同', () => {
    expect(isSameMemoryWorkspace(null, 'D:/work')).toBe(false);
    expect(isSameMemoryWorkspace('D:/work', null)).toBe(false);
  });

  it('不同目录视为不同', () => {
    expect(isSameMemoryWorkspace('D:/a', 'D:/b')).toBe(false);
  });
});
