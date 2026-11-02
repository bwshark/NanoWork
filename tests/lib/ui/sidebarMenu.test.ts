/**
 * 侧边栏菜单顺序模型的纯函数（`lib/ui/sidebarMenu`）。
 *
 * ## 为什么这些逻辑要单独测，而不是只在组件里测
 *
 * 拖拽的真实判据是**几何**：指针在哪个高度、应该落到第几位。jsdom 没有布局
 * （`getBoundingClientRect()` 恒 0），组件测试里行距永远是 0，`dropInsertIndex`
 * 会一律返回 -1（「这一帧不动」）—— 那样「拖完顺序变了」这条用例即使功能全坏
 * 也会绿。所以几何必须在这里用可任意构造的坐标测，组件测试只负责证明
 * 「store 顺序 → 面板行序」这条接线是通的。
 *
 * 归一化的风险同理：它只在**老用户升级**那一刻暴露（表里缺项 / 有非法 id），
 * 而那种状态在正常开发里永远构造不出来。
 */

import { describe, expect, it } from 'vitest';
import {
  MORE_MENU_IDS,
  PRIMARY_MENU_IDS,
  dropInsertIndex,
  moveMenuItem,
  normalizeMenuOrder,
} from '@/lib/ui/sidebarMenu';

describe('normalizeMenuOrder：把持久化表收敛成合法且完整的顺序', () => {
  it('空表 / undefined / null / 非数组 → 默认顺序（老用户升级的形态）', () => {
    for (const saved of [undefined, null, [], 'tasks', 42, {}]) {
      expect(normalizeMenuOrder(saved, PRIMARY_MENU_IDS)).toEqual([
        ...PRIMARY_MENU_IDS,
      ]);
    }
  });

  it('保留用户顺序，并**补回**表里缺失的项（新增菜单项不能因此消失）', () => {
    // 老用户的表里没有后加的 `more`：它必须被补到末尾，而不是不显示
    expect(normalizeMenuOrder(['knowledge', 'tasks'], PRIMARY_MENU_IDS)).toEqual([
      'knowledge',
      'tasks',
      'capabilities',
      'more',
    ]);
  });

  it('丢弃非法 id 与重复项', () => {
    expect(
      normalizeMenuOrder(
        ['more', 'more', 'deleted-menu', 'tasks'],
        PRIMARY_MENU_IDS,
      ),
    ).toEqual(['more', 'tasks', 'knowledge', 'capabilities']);
  });

  it('非字符串项不会让函数崩（手工改坏的持久化）', () => {
    expect(
      normalizeMenuOrder([1, null, { id: 'tasks' }, 'knowledge'], PRIMARY_MENU_IDS),
    ).toEqual(['knowledge', 'tasks', 'capabilities', 'more']);
  });
});

describe('moveMenuItem：把某一行挪到指定位置', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('往后挪（b → 第 3 位）', () => {
    expect(moveMenuItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('往前挪（d → 第 1 位）', () => {
    expect(moveMenuItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('原地不动返回同一引用（避免无意义重渲染）', () => {
    expect(moveMenuItem(list, 1, 1)).toBe(list);
  });

  it('越界夹到两端，不抛错、不丢项', () => {
    expect(moveMenuItem(list, 0, 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveMenuItem(list, 3, -5)).toEqual(['d', 'a', 'b', 'c']);
    // 源下标越界 = 没这回事，原样返回
    expect(moveMenuItem(list, 9, 0)).toBe(list);
  });
});

describe('dropInsertIndex：指针高度 → 目标下标', () => {
  const PITCH = 52; // 44 行高 + 8 间距
  const TOP = 100;
  const COUNT = 4;

  it('落在某行中段 → 该行的下标', () => {
    // 第 2 行（下标 1）的中段：100 + 52*1 + 26 = 178
    expect(dropInsertIndex(178, TOP, PITCH, COUNT)).toBe(1);
  });

  it('按行距而不是行高推进（用行高会逐行累积 8px 偏差，拖到中段就落错行）', () => {
    // 挑一个「用行距算 0、用行高算 1」的坐标：距列表顶 50px。
    // 行距 52 → floor(50/52) = 0（还在第 1 行）；行高 44 → floor(50/44) = 1（误判成第 2 行）。
    // 用「两者结果相同」的坐标测这条等于什么都没测。
    expect(dropInsertIndex(TOP + 50, TOP, PITCH, COUNT)).toBe(0);
    expect(dropInsertIndex(TOP + 50, TOP, 44, COUNT)).toBe(1);
  });

  it('拖到列表上方 / 下方一律夹到两端', () => {
    expect(dropInsertIndex(-500, TOP, PITCH, COUNT)).toBe(0);
    expect(dropInsertIndex(9999, TOP, PITCH, COUNT)).toBe(COUNT - 1);
  });

  it('行距未测量出来时返回 -1（这一帧不动，而不是把整列翻过来）', () => {
    expect(dropInsertIndex(200, TOP, 0, COUNT)).toBe(-1);
    expect(dropInsertIndex(200, TOP, -1, COUNT)).toBe(-1);
    expect(dropInsertIndex(200, TOP, PITCH, 0)).toBe(-1);
  });

  it('同一个指针位置恒得同一个下标（与「当前排布」无关，因此拖动不会抖）', () => {
    // 这条是「不抖」的判据：函数只看入参，不读任何行当前的位置
    for (let y = TOP; y < TOP + PITCH * COUNT; y += 4) {
      expect(dropInsertIndex(y, TOP, PITCH, COUNT)).toBe(
        dropInsertIndex(y, TOP, PITCH, COUNT),
      );
    }
  });
});

describe('菜单 id 表', () => {
  it('一级菜单可拖拽的四行与「更多」两行都不重复', () => {
    expect(new Set(PRIMARY_MENU_IDS).size).toBe(PRIMARY_MENU_IDS.length);
    expect(new Set(MORE_MENU_IDS).size).toBe(MORE_MENU_IDS.length);
  });
});
