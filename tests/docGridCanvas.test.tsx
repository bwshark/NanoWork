/**
 * 表格视图组件（`.xlsx` 的「表格」标签）。
 *
 * 这组用例守的是用户在截图里要的四件事，且都在 jsdom 里可判定：
 *
 * 1. **像表格**：列头是 A/B/C，行号是 1/2/3，单元格里是真文字；
 * 2. **单元格能选中**：点一下就把引用（C2）与内容写进公式栏，方向键继续走；
 * 3. **行列宽高能拖**：拖列头右边界后，右边那一列整体右移 —— 不是画了一条假线；
 * 4. **工作表能切**：多张表时底部有标签，点了换内容。
 *
 * ⚠️ 这里**不覆盖**「滚动时会话如何虚拟化」：jsdom 没有布局，clientWidth/scrollTop
 * 全是 0。那条靠真机验（可视窗口的取值逻辑在 `tests/lib/kb/workbook.test.ts` 里钉住）。
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DocGridCanvas } from '@/components/knowledge/DocGridCanvas';
import type { KbWorkbook } from '@/lib/kb/workbook';
import { click, flush, mount, unmount } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
});

function workbook(): KbWorkbook {
  return {
    version: 1,
    activeSheet: 0,
    totalCells: 5,
    warnings: [],
    sheets: [
      {
        id: 'sheet-1',
        name: '银行信息列表',
        order: 0,
        row: 6,
        column: 4,
        defaultRowHeight: 19,
        defaultColWidth: 73,
        celldata: [
          { r: 0, c: 0, v: { v: 'ID', m: 'ID', bl: 1 } },
          { r: 0, c: 1, v: { v: '银行名称', m: '银行名称', bl: 1 } },
          { r: 1, c: 0, v: { v: 'dc89911ac', m: 'dc89911ac' } },
          { r: 1, c: 1, v: { v: '未知银行', m: '未知银行' } },
          { r: 1, c: 2, v: { v: 1, m: '1' } },
          { r: 2, c: 0, v: { v: 'da16a96b2', m: 'da16a96b2' } },
        ],
      },
      {
        id: 'sheet-2',
        name: '第二张表',
        order: 1,
        row: 4,
        column: 3,
        celldata: [{ r: 0, c: 0, v: { v: '另一张表的内容', m: '另一张表的内容' } }],
      },
    ],
  };
}

function renderGrid() {
  const host = mount(<DocGridCanvas workbook={workbook()} title="银行信息列表" />);
  return host;
}

function text(host: ParentNode, testId: string): string {
  return (host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '').trim();
}

/** 鼠标按下 / 移动 / 松开（组件监听的是 window 上的 move/up） */
function mouseDown(target: Element | null, init: MouseEventInit = {}): void {
  expect(target).toBeTruthy();
  act(() => {
    target!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...init }));
  });
}

function mouseMove(init: MouseEventInit): void {
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...init }));
  });
}

function mouseUp(): void {
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

describe('表格渲染', () => {
  it('列头是 A/B/C/D，行号从 1 开始，单元格里是真文字', () => {
    const host = renderGrid();

    expect(text(host, 'kb-grid-col-0')).toBe('A');
    expect(text(host, 'kb-grid-col-3')).toBe('D');
    expect(text(host, 'kb-grid-row-0')).toBe('1');
    expect(text(host, 'kb-grid-cell-0-1')).toContain('银行名称');
    expect(text(host, 'kb-grid-cell-1-0')).toContain('dc89911ac');
  });

  it('工作表名与规模写在工具条上（不靠猜「这是哪张表」）', () => {
    const host = renderGrid();
    expect(text(host, 'kb-grid-sheet-name')).toBe('银行信息列表');
    expect(host.textContent).toContain('6 行 × 4 列');
  });

  it('没渲染出来的内容要说出来（图表/条件格式不能在界面上凭空消失）', () => {
    const host = mount(
      <DocGridCanvas
        workbook={{
          ...workbook(),
          warnings: ['有 1 张工作表含图表或图片，表格视图不显示'],
        }}
        title="银行信息列表"
      />,
    );
    expect(text(host, 'kb-grid-warnings')).toContain('1 处内容没有渲染');
  });
});

describe('选中单元格', () => {
  it('点一下就把引用与内容写进公式栏', () => {
    const host = renderGrid();

    // 初始停在 A1
    expect(text(host, 'kb-grid-ref')).toBe('A1');
    expect(text(host, 'kb-grid-value')).toBe('ID');

    mouseDown(host.querySelector('[data-testid="kb-grid-cell-1-2"]'), { button: 0 });

    expect(text(host, 'kb-grid-ref')).toBe('C2');
    expect(text(host, 'kb-grid-value')).toBe('1');
    // 选区框跟着走（画在单元格之上，但不吃鼠标事件）
    expect(host.querySelector('[data-testid="kb-grid-selection"]')).toBeTruthy();
  });

  it('方向键继续走，Shift 点选拉出区域', () => {
    const host = renderGrid();
    mouseDown(host.querySelector('[data-testid="kb-grid-cell-0-0"]'), { button: 0 });

    const scroller = host.querySelector('[data-testid="kb-grid-scroll"]');
    act(() => {
      scroller!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(text(host, 'kb-grid-ref')).toBe('B1');

    act(() => {
      scroller!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(text(host, 'kb-grid-ref')).toBe('B2');

    // Shift + 点 = 从锚点拉到这一格（公式栏写区域）
    mouseDown(host.querySelector('[data-testid="kb-grid-cell-2-2"]'), {
      button: 0,
      shiftKey: true,
    });
    expect(text(host, 'kb-grid-ref')).toBe('B2:C3');
  });

  it('拖选：按下后移到右下，区域跟着变大', () => {
    const host = renderGrid();
    mouseDown(host.querySelector('[data-testid="kb-grid-cell-0-0"]'), { button: 0 });

    // jsdom 没有布局：getBoundingClientRect 全是 0，所以这里按 offsets 直接给坐标
    // （A 列 73px、行高 19px → 落在 (0,0) 的格子就是 A1，x=80 落到 B 列）
    mouseMove({ clientX: 80, clientY: 25 });
    mouseUp();

    expect(text(host, 'kb-grid-ref')).toBe('A1:B2');
  });
});

describe('拖拽调整行列', () => {
  it('拖列头右边界 → 右邻列整体右移，宽度真的变了', () => {
    const host = renderGrid();

    const before = host.querySelector<HTMLElement>('[data-testid="kb-grid-cell-0-1"]')!.style.left;
    expect(before).toBe('73px');

    mouseDown(host.querySelector('[data-testid="kb-grid-col-resize-0"]'), { clientX: 73 });
    mouseMove({ clientX: 133 });
    mouseUp();
    act(() => undefined);

    const after = host.querySelector<HTMLElement>('[data-testid="kb-grid-cell-0-1"]')!.style.left;
    expect(after).toBe('133px');
  });

  it('拖行号下边界 → 下面那一行整体下移', () => {
    const host = renderGrid();

    expect(host.querySelector<HTMLElement>('[data-testid="kb-grid-cell-1-0"]')!.style.top).toBe(
      '19px',
    );

    mouseDown(host.querySelector('[data-testid="kb-grid-row-resize-0"]'), { clientY: 19 });
    mouseMove({ clientY: 49 });
    mouseUp();

    expect(host.querySelector<HTMLElement>('[data-testid="kb-grid-cell-1-0"]')!.style.top).toBe(
      '49px',
    );
  });
});

describe('单元格样式', () => {
  it('颜色按服务端格式（带 `#`）还原，不能被拼成非法 CSS 让字色继承', () => {
    const wb = workbook();
    // 与服务端一致：`_color()` 产出的就是 `#RRGGBB`
    wb.sheets[0].celldata[0] = {
      r: 0,
      c: 0,
      v: { v: 'ID', m: 'ID', bl: 1, bg: '#eef1f5', fc: '#1f2329' },
    };
    const host = mount(<DocGridCanvas workbook={wb} title="银行信息列表" />);
    const cell = host.querySelector<HTMLElement>('[data-testid="kb-grid-cell-0-0"]')!;

    // 曾经这里是空串（`##1f2329` 被浏览器丢掉 → 继承父级浅色 → 「整张表像蒙了一层」）
    expect(cell.style.color).not.toBe('');
    expect(cell.style.color.toLowerCase()).toMatch(/rgb\(31,\s*35,\s*41\)|#1f2329/);
    expect(cell.style.backgroundColor.toLowerCase()).toMatch(/rgb\(238,\s*241,\s*245\)|#eef1f5/);
  });

  it('没有字色时用默认深色（不是跟着暗色主题变浅）', () => {
    const host = renderGrid();
    const cell = host.querySelector<HTMLElement>('[data-testid="kb-grid-cell-1-0"]')!;
    expect(cell.style.color.toLowerCase()).toMatch(/rgb\(31,\s*35,\s*41\)|#1f2329/);
  });
});

describe('工作表切换', () => {
  it('底部标签点了换内容，且换表后选区回到 A1', () => {
    const host = renderGrid();
    expect(text(host, 'kb-grid-cell-0-0')).toContain('ID');

    click(host.querySelector('[data-testid="kb-grid-sheet-1"]'));
    // 切表是同步 setState，但列宽/选区重置在 effect 里，跑一轮 tick 再断言
    return flush().then(() => {
      expect(text(host, 'kb-grid-sheet-name')).toBe('第二张表');
      expect(text(host, 'kb-grid-cell-0-0')).toContain('另一张表的内容');
      expect(text(host, 'kb-grid-ref')).toBe('A1');
    });
  });
});
