/**
 * 工作簿模型适配层（`src/lib/kb/workbook.ts`）。
 *
 * 这一层是**坐标系的唯一真相**：单元格的 left/top、合并区宽度、选区框、
 * 拖拽命中的行列号全从它出发。所以断言重点不是「函数能跑」，而是三条容易错的边界：
 *
 * 1. 列字母与 A1 引用的进位（Z → AA 这一段最容易写错一）；
 * 2. 隐藏列宽度记 0（记 1px 会留一条「看得见但点不中」的缝）；
 * 3. 合并区里被盖住的格子必须列出来（否则合并区里会透出一份重复的文字）。
 */

import { describe, expect, it } from 'vitest';
import {
  axisIndexAt,
  borderCss,
  buildColumnAxis,
  buildRowAxis,
  cellRef,
  columnLabel,
  cssColor,
  displayText,
  indexSheet,
  inputText,
  isNumericCell,
  rangeRef,
  renderedText,
  visibleSpan,
  type KbSheet,
} from '@/lib/kb/workbook';

function sheet(overrides: Partial<KbSheet> = {}): KbSheet {
  return {
    id: 'sheet-1',
    name: '银行信息列表',
    row: 5,
    column: 3,
    celldata: [
      { r: 0, c: 0, v: { v: 'ID', m: 'ID', bl: 1 } },
      { r: 0, c: 1, v: { v: '银行代码', m: '银行代码' } },
      { r: 1, c: 0, v: { v: 'dc89911ac', m: 'dc89911ac' } },
      { r: 1, c: 2, v: { v: 1, m: '1' } },
    ],
    defaultRowHeight: 19,
    defaultColWidth: 73,
    ...overrides,
  };
}

describe('列字母与单元格引用', () => {
  it('0 → A，25 → Z，26 → AA（进位只多一位，不是 26 进制）', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(27)).toBe('AB');
    expect(columnLabel(51)).toBe('AZ');
    expect(columnLabel(52)).toBe('BA');
    expect(columnLabel(701)).toBe('ZZ');
    expect(columnLabel(702)).toBe('AAA');
  });

  it('非法输入返回空串，不抛错（脏数据不该打崩抽屉）', () => {
    expect(columnLabel(-1)).toBe('');
    expect(columnLabel(Number.NaN)).toBe('');
  });

  it('A1 引用从 1 开始数行，单格不写成区域', () => {
    expect(cellRef(0, 0)).toBe('A1');
    expect(cellRef(4, 4)).toBe('E5');
    expect(rangeRef(4, 4, 4, 4)).toBe('E5');
    expect(rangeRef(0, 0, 2, 2)).toBe('A1:C3');
  });
});

describe('行列轴', () => {
  it('默认宽高 + 覆盖值 → 前缀和；总长等于最后一格的右边界', () => {
    const axis = buildColumnAxis(3, 73, { 1: 120 });
    expect(axis.sizes).toEqual([73, 120, 73]);
    expect(axis.offsets).toEqual([0, 73, 193, 266]);
    expect(axis.total).toBe(266);
  });

  it('隐藏列宽度记 0（留 1px 会变成一条点不中的缝）', () => {
    const axis = buildColumnAxis(3, 73, {}, { 1: 0 });
    expect(axis.sizes).toEqual([73, 0, 73]);
    expect(axis.offsets).toEqual([0, 73, 73, 146]);
  });

  it('拖出来的宽高有上下限：太小点不中，太大撑爆布局', () => {
    const narrow = buildColumnAxis(1, 73, { 0: 2 });
    expect(narrow.sizes[0]).toBe(24);
    const huge = buildColumnAxis(1, 73, { 0: 999_999 });
    expect(huge.sizes[0]).toBe(2000);
    const shortRow = buildRowAxis(1, 19, { 0: 1 });
    expect(shortRow.sizes[0]).toBe(12);
  });

  it('坐标 → 索引：边界落在下一格，越界收到首/末格', () => {
    const axis = buildColumnAxis(3, 100);
    expect(axisIndexAt(axis.offsets, 0)).toBe(0);
    expect(axisIndexAt(axis.offsets, 99)).toBe(0);
    // 100 正好是第二格的起点 → 第二格
    expect(axisIndexAt(axis.offsets, 100)).toBe(1);
    expect(axisIndexAt(axis.offsets, -50)).toBe(0);
    expect(axisIndexAt(axis.offsets, 9999)).toBe(2);
  });

  it('可视窗口按 scrollTop/高度取闭区间', () => {
    const axis = buildRowAxis(100, 20);
    const span = visibleSpan(axis.offsets, 100, 60);
    // 100..160 → 第 6 格到第 8 格（0 起）
    expect(span.first).toBe(5);
    expect(span.last).toBe(8);
  });
});

describe('单元格索引', () => {
  it('稀疏表按 r:c 索引，合并区的被盖格子单独列出', () => {
    const merged = sheet({
      celldata: [
        { r: 0, c: 0, v: { v: '牛只档案', m: '牛只档案', mc: { r: 0, c: 0, rs: 2, cs: 2 } } },
        { r: 2, c: 0, v: { v: 'A-区-2号栏', m: 'A-区-2号栏' } },
      ],
    });
    const index = indexSheet(merged);

    expect(index.cells.get('2:0')?.v.m).toBe('A-区-2号栏');
    expect(index.merged.get('0:0')).toEqual({ r: 0, c: 0, rs: 2, cs: 2 });
    // 锚点自己不在 covered 里（它要被画出来）
    expect(index.covered.has('0:0')).toBe(false);
    expect(index.covered.has('0:1')).toBe(true);
    expect(index.covered.has('1:0')).toBe(true);
    expect(index.covered.has('1:1')).toBe(true);
  });

  it('borderInfo 按 row_index/col_index 落成每格四边', () => {
    const bordered = sheet({
      config: {
        borderInfo: [
          {
            rangeType: 'cell',
            value: {
              row_index: 1,
              col_index: 2,
              l: { style: '1', color: '000000' },
              b: { style: '13', color: 'FF0000' },
            },
          },
        ],
      },
    });
    const index = indexSheet(bordered);

    expect(index.borders.get('1:2')?.l).toEqual({ style: '1', color: '000000' });
    expect(index.borders.get('1:2')?.r).toBeUndefined();
  });

  it('脏数据（行列号不是数字）直接跳过，不让它变成 NaN:NaN 的怪键', () => {
    const dirty = sheet({
      celldata: [{ r: Number.NaN, c: 0, v: { v: 'x', m: 'x' } }],
      config: { borderInfo: [{ rangeType: 'cell', value: { row_index: 1 } }] },
    } as unknown as Partial<KbSheet>);
    const index = indexSheet(dirty);
    expect(index.cells.size).toBe(0);
    expect(index.borders.size).toBe(0);
  });
});

describe('显示文本', () => {
  it('优先用 Excel 算好的 m（日期/百分比不重算）', () => {
    expect(displayText({ r: 0, c: 0, v: { v: 0.125, m: '12.5%' } })).toBe('12.5%');
    expect(displayText({ r: 0, c: 0, v: { v: 0.5, m: '2022-08-01' } })).toBe('2022-08-01');
  });

  it('只有原值时退回原值，布尔值按 Excel 的写法', () => {
    expect(displayText({ r: 0, c: 0, v: { v: 592.2 } })).toBe('592.2');
    expect(displayText({ r: 0, c: 0, v: { v: true } })).toBe('TRUE');
    expect(displayText(undefined)).toBe('');
  });

  it('公式栏显示公式（含等号），没有公式才显示文本', () => {
    const formula = { r: 0, c: 0, v: { v: 3, m: '3', f: '=1+2' } };
    expect(inputText(formula)).toBe('=1+2');
    expect(inputText({ r: 0, c: 0, v: { v: 3, m: '3' } })).toBe('3');
  });

  it('数字默认右对齐（General 行为），文本不是', () => {
    expect(isNumericCell({ r: 0, c: 0, v: { v: 1.5, m: '1.5' } })).toBe(true);
    expect(isNumericCell({ r: 0, c: 0, v: { v: '1.5', m: '1.5' } })).toBe(false);
    expect(isNumericCell(undefined)).toBe(false);
  });

  it('超长文本截断并留省略号（不让一格撑爆布局）', () => {
    const long = 'x'.repeat(1500);
    const text = renderedText({ r: 0, c: 0, v: { v: long, m: long } });
    expect(text.length).toBe(1001);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('颜色归一化（服务端已经带 `#`，客户端不能再拼一个）', () => {
  it('带井号、不带井号、8 位 ARGB 都归成 #RRGGBB', () => {
    expect(cssColor('#000000')).toBe('#000000');
    expect(cssColor('#eef1f5')).toBe('#eef1f5');
    expect(cssColor('000000')).toBe('#000000');
    // AARRGGBB：丢掉透明度
    expect(cssColor('FFC0392B')).toBe('#c0392b');
    expect(cssColor('  #C0392B  ')).toBe('#c0392b');
  });

  it('认不出来的给 null（宁可回退成默认色，也不要拼出 ##000000 这种非法值）', () => {
    // 这条就是「整张表像蒙了一层」的根因：`##000000` 是非法 CSS，
    // 字色会静默继承父级（暗色主题下是浅灰）
    expect(cssColor('')).toBeNull();
    expect(cssColor(undefined)).toBeNull();
    expect(cssColor('red')).toBeNull();
    expect(cssColor('#12345')).toBeNull();
  });
});

describe('边框编号 → CSS', () => {
  it('OOXML 的 medium(2) 在这套编号里是 hair —— 只按粗细还原观感', () => {
    expect(borderCss({ style: '1', color: '000000' })).toEqual({
      width: 1,
      style: 'solid',
      color: '#000000',
    });
    expect(borderCss({ style: '8', color: 'FF0000' })?.width).toBe(2);
    expect(borderCss({ style: '13', color: '00FF00' })?.width).toBe(3);
    expect(borderCss({ style: '4', color: '000000' })?.style).toBe('dashed');
    expect(borderCss(undefined)).toBeNull();
  });

  it('边框色也走同一个归一化（服务端给的是 "#000000"）', () => {
    expect(borderCss({ style: '1', color: '#9AA4B2' })?.color).toBe('#9aa4b2');
    expect(borderCss({ style: '1', color: '' })?.color).toBe('#000000');
  });
});
