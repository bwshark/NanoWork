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
  readDestination,
  reconcileActive,
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

describe('currentOutlineIndex（按绝对纵向位置判定当前章节）', () => {
  // 前三条同在第 1 页（0 / 300 / 700 px），第四条在第 2 页（1500 px）
  const marks = [0, 300, 700, 1500];

  it('跨过哪一条就亮哪一条', () => {
    expect(currentOutlineIndex(marks, 0)).toBe(0);
    expect(currentOutlineIndex(marks, 100)).toBe(0);
    expect(currentOutlineIndex(marks, 320)).toBe(1);
    expect(currentOutlineIndex(marks, 900)).toBe(2);
    expect(currentOutlineIndex(marks, 1800)).toBe(3);
  });

  it('同一页上的多个标题也能各自亮对 —— 这是"只按页码判"做不到的', () => {
    // 全在一页里：页号相同，但位置不同（用户点的第一条必须亮第一条，而不是该页最后一条）
    expect(currentOutlineIndex([0, 300], 50)).toBe(0);
    expect(currentOutlineIndex([0, 300], 350)).toBe(1);
  });

  it('正好落在边界上算"已进入"（scrollTop 取整会差零点几像素，所以留 1px 容差）', () => {
    expect(currentOutlineIndex(marks, 298)).toBe(0);
    expect(currentOutlineIndex(marks, 299)).toBe(1);
    expect(currentOutlineIndex(marks, 300)).toBe(1);
  });

  it('还没进入任何章节时返回 -1（封面、目录页）', () => {
    expect(currentOutlineIndex([400, 900], 100)).toBe(-1);
  });

  it('位置未知（null）的条目既不参与也不打断后面的判定', () => {
    expect(currentOutlineIndex([null, 300, null, 900], 500)).toBe(1);
    expect(currentOutlineIndex([null, null], 500)).toBe(-1);
  });
});

describe('readDestination（书签目的地的结构）', () => {
  const page = { num: 3, gen: 0 };

  it('pdf.js 归一化后的 XYZ（第二项是 {name}）：top 在索引 3', () => {
    const info = readDestination([page, { name: 'XYZ' }, 87, 769, 0]);

    expect(info).toEqual({ pageRef: page, kind: 'XYZ', top: 769 });
  });

  it('具名类型的 XYZ（第二项是字符串）：top 同样在索引 3', () => {
    expect(readDestination([page, 'XYZ', 87, 769, 0])?.top).toBe(769);
  });

  it('省略类型名的 XYZ：参数整体左移一格，top 在索引 2', () => {
    expect(readDestination([page, 87, 769, 0])?.top).toBe(769);
  });

  it('FitH / FitBH 的纵向坐标在索引 2 —— 取错就会跳到页尾', () => {
    expect(readDestination([page, { name: 'FitH' }, 640])).toEqual({
      pageRef: page,
      kind: 'FitH',
      top: 640,
    });
    expect(readDestination([page, { name: 'FitBH' }, 640])?.top).toBe(640);
  });

  it('Fit / FitV 不指定纵向位置（整页），返回 null 而不是硬掰一个数', () => {
    expect(readDestination([page, { name: 'Fit' }])?.top).toBeNull();
    expect(readDestination([page, { name: 'FitV' }, 42])?.top).toBeNull();
  });

  it('top 是 null / 非数字时给 null（有些书签只给 left）', () => {
    expect(readDestination([page, { name: 'XYZ' }, 87, null, 0])?.top).toBeNull();
    expect(readDestination([page, { name: 'XYZ' }, 87, '769', 0])?.top).toBeNull();
  });

  it('不是数组（例如 getDestination 查不到具名 dest 时返回 null）给 null', () => {
    expect(readDestination(null)).toBeNull();
    expect(readDestination('chapter-2')).toBeNull();
    expect(readDestination([])).toBeNull();
  });
});

describe('reconcileActive（同位置并列时保留当前条）', () => {
  const marks = [100, 100, 400];

  it('两条书签在同一位置：保留当前（刚点的那条），不被"最后一条"抢走', () => {
    expect(reconcileActive(0, 1, marks)).toBe(0);
    expect(reconcileActive(1, 0, marks)).toBe(1);
  });

  it('位置不同就听滚动算出来的（用户真的滚走了）', () => {
    expect(reconcileActive(0, 2, marks)).toBe(2);
    expect(reconcileActive(2, 0, marks)).toBe(0);
  });

  it('没有任何一条命中（-1）时照实给 -1，留给调用方兜底', () => {
    expect(reconcileActive(0, -1, marks)).toBe(-1);
  });
});
