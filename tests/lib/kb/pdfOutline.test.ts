/**
 * PDF 书签 → 大纲树（纯逻辑）。
 *
 * 这一组守的是「大纲不准」的两种典型形态：**层级画平了**（子章节和父章节顶格，
 * 侧栏看不出结构）与**高亮错位**（滚到第 5 页却高亮第 2 章）。两者都不会报错，
 * 只会让人觉得"这个大纲是假的"。
 */

import { describe, expect, it } from 'vitest';
import {
  OUTLINE_LIMIT,
  currentOutlineIndex,
  resolveOutline,
  type OutlineResolver,
  type OutlineSource,
} from '@/lib/kb/pdfOutline';

/** 假文档：`destinations` 是具名 dest 表，`pageRefs` 是页面引用 → 索引 */
function fakePdf(pages: Record<string, number>, named: Record<string, unknown[]> = {}) {
  const resolver: OutlineResolver = {
    getDestination: async (id) => named[id] ?? null,
    getPageIndex: async (ref) => {
      const index = pages[String(ref)];
      if (index === undefined) throw new Error('Unknown page ref');
      return index;
    },
  };
  return resolver;
}

describe('resolveOutline', () => {
  it('摊平嵌套书签，层级跟着缩进走', async () => {
    const doc = fakePdf({ p1: 0, p2: 4, p3: 6 });
    const source: OutlineSource[] = [
      { title: '第一章', dest: ['p1'], items: [{ title: '1.1 小节', dest: ['p2'] }] },
      { title: '第二章', dest: ['p3'] },
    ];

    const nodes = await resolveOutline(doc, source);

    expect(nodes.map((node) => [node.depth, node.title, node.page])).toEqual([
      [0, '第一章', 1],
      [1, '1.1 小节', 5],
      [0, '第二章', 7],
    ]);
  });

  it('具名 destination（字符串）要查表才对', async () => {
    const doc = fakePdf({ p9: 8 }, { 'chapter-2': ['p9'] });

    const nodes = await resolveOutline(doc, [{ title: '第二章', dest: 'chapter-2' }]);

    expect(nodes[0].page).toBe(9);
  });

  it('一条坏书签不该让整份大纲打不开', async () => {
    const doc = fakePdf({ ok: 2 });
    const source: OutlineSource[] = [
      { title: '坏的', dest: ['missing'] },
      { title: '没有 destination', dest: null },
      { title: '好的', dest: ['ok'] },
    ];

    const nodes = await resolveOutline(doc, source);

    // 解不出的给 0（页码显示为「—」），但三条都在，顺序不变
    expect(nodes.map((node) => node.page)).toEqual([0, 0, 3]);
    expect(nodes.map((node) => node.title)).toEqual(['坏的', '没有 destination', '好的']);
  });

  it('标题里的换行与连续空格压成一个空格（Word 长标题折行会写进去）', async () => {
    const doc = fakePdf({ p: 0 });

    const nodes = await resolveOutline(doc, [{ title: '  设备运营管理/设备运行\n概况  ', dest: ['p'] }]);

    expect(nodes[0].title).toBe('设备运营管理/设备运行 概况');
  });

  it('空标题给占位而不是空行（空行在侧栏里点不中）', async () => {
    const doc = fakePdf({ p: 0 });

    const nodes = await resolveOutline(doc, [{ dest: ['p'] }]);

    expect(nodes[0].title).toBe('（无标题）');
  });

  it('没有书签时返回空数组，不抛错', async () => {
    const doc = fakePdf({});

    await expect(resolveOutline(doc, null)).resolves.toEqual([]);
    await expect(resolveOutline(doc, [])).resolves.toEqual([]);
  });

  it('超长大纲截断到上限（几百条的大纲比没有更难用）', async () => {
    const doc = fakePdf({ p: 0 });
    const source: OutlineSource[] = Array.from({ length: OUTLINE_LIMIT + 30 }, (_, index) => ({
      title: `条目 ${index}`,
      dest: ['p'],
    }));

    const nodes = await resolveOutline(doc, source);

    expect(nodes).toHaveLength(OUTLINE_LIMIT);
  });
});

describe('currentOutlineIndex', () => {
  const nodes = [
    { title: '第一章', depth: 0, page: 1, dest: null },
    { title: '1.1', depth: 1, page: 2, dest: null },
    { title: '第二章', depth: 0, page: 6, dest: null },
    { title: '2.1', depth: 1, page: 8, dest: null },
  ];

  it('取「文档顺序里最后一条已经开始」的条目 —— 子章节优先于父章节', () => {
    expect(currentOutlineIndex(nodes, 1)).toBe(0);
    expect(currentOutlineIndex(nodes, 3)).toBe(1);
    expect(currentOutlineIndex(nodes, 7)).toBe(2);
    expect(currentOutlineIndex(nodes, 9)).toBe(3);
  });

  it('还没进入任何章节时返回 -1（封面、目录页）', () => {
    const later = [{ title: '正文', depth: 0, page: 4, dest: null }];
    expect(currentOutlineIndex(later, 1)).toBe(-1);
  });

  it('解析不出页码的条目（page=0）不参与高亮', () => {
    const broken = [
      { title: '坏的', depth: 0, page: 0, dest: null },
      { title: '好的', depth: 0, page: 2, dest: null },
    ];
    expect(currentOutlineIndex(broken, 1)).toBe(-1);
    expect(currentOutlineIndex(broken, 2)).toBe(1);
  });
});
