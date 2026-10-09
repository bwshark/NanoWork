/**
 * 选中文本气泡：**复制** / **添加到对话**。
 *
 * 这组用例守三件在真机上很难回头查的事：
 *
 * 1. **文案在松手那一刻定格**：点击气泡会先派发 `mousedown`，浏览器默认行为会把
 *    选区折叠掉。若点按钮时再去读 `window.getSelection()`，拿到的就是空选区
 *    ——症状是「点了添加到对话，什么都没发生」。用例通过「点完仍能拿到原文」来钉它。
 * 2. **只在消息正文里响应**：从工具输出 / 过程时间线拖一段不该弹气泡，
 *    否则用户会以为「加进对话」是在引用助手的结论。
 * 3. **收起路径齐全**：Esc / 点别处 / 滚动都要收，气泡是 `position: fixed`，
 *    留在屏幕上会挂在一个已经滚走或换了内容的位置上。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { ThemeProvider } from '@mui/material';
import {
  BUBBLE_H,
  computeBubblePlacement,
  SelectionQuoteBubble,
  type SelectionBox,
} from '@/pages/chat/SelectionQuoteBubble';
import { muiTheme } from '@/theme/muiTheme';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { click, flush, mount, unmount } from './helpers/reactMount';

const BODY_TEXT = '明天是国庆节假期的第7天';
const QUOTE_TEXT = '国庆节假期';
/** 下标从正文现算：手数字符数错了不会报错，只会让断言莫名其妙地差一个字符 */
const QUOTE_FROM = BODY_TEXT.indexOf(QUOTE_TEXT);
const QUOTE_TO = QUOTE_FROM + QUOTE_TEXT.length;

function Harness({ sessionId = 's1' }: { sessionId?: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  return (
    <ThemeProvider theme={muiTheme}>
      <>
        <div ref={rootRef}>
          <div data-message-id="m1">
            <div data-quote-body="">{BODY_TEXT}</div>
          </div>
          <div data-message-id="m2">
            {/* 过程 / 工具区：没有 data-quote-body，选区落在这里不该弹气泡 */}
            <div data-proc="">工具输出的另一段文字</div>
          </div>
        </div>
        <SelectionQuoteBubble rootRef={rootRef} sessionId={sessionId} />
      </>
    </ThemeProvider>
  );
}

/** 在某个元素的首个文本节点上建立选区 */
function selectText(el: Element, start: number, end: number): void {
  const node = el.firstChild as Text;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** 在某个元素上松开鼠标（冒泡到 document，由气泡的监听消费） */
function mouseUpOn(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

/** 右键（`contextmenu` 那一轮）：mousedown / mouseup 都要派发，button = 2 */
function rightClickOn(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }));
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
}

const bubbleEl = () => document.querySelector('[data-selection-bubble]');

/** 走一遍「选中 → 松手」，返回气泡根节点 */
function openBubbleOnBody(host: HTMLElement): HTMLElement {
  const body = host.querySelector('[data-quote-body]') as HTMLElement;
  selectText(body, QUOTE_FROM, QUOTE_TO);
  mouseUpOn(body);
  const bubble = bubbleEl();
  expect(bubble).toBeTruthy();
  return bubble as HTMLElement;
}

beforeEach(() => {
  // jsdom 下不置位这个标志，`act()` 只会在控制台刷警告而不真正批处理更新
  // ——用例可能照样绿，但事件派发带来的重渲染时机就变得不可控。
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useSessionUiStore.setState({ quotes: [] });
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  unmount();
  window.getSelection()?.removeAllRanges();
});

/**
 * 气泡落位：**必须在选区外侧**，绝不能压住选中的文字。
 *
 * 这组用例守的是一次真机回归：原先按「选区**最后一行**」定位
 * （`getClientRects()` 取末个 rect），单行选区看着没问题，多行就露馅 ——
 * 最后一行的**上方**正好是倒数第二行的位置，而气泡高 34px，于是选了 3 行、
 * 气泡压在第 2 行上（用户截图）。
 *
 * 位置计算抽成纯函数是因为 jsdom 没有布局（量不到真实几何），
 * 真机那边另有 `tasks/verify-selection-quote.mjs` 量实际矩形。
 */
describe('气泡落位：整体外框 + 放不下才下翻', () => {
  const VIEWPORT = 1440;
  const box = (over: Partial<SelectionBox> = {}): SelectionBox => ({
    left: 100,
    right: 500,
    top: 300,
    bottom: 400,
    ...over,
  });
  /** 气泡实际的上下沿（transform 决定朝上还是朝下展开） */
  const bubbleEdges = (r: ReturnType<typeof computeBubblePlacement>) =>
    r.placement === 'above'
      ? { top: r.top - BUBBLE_H, bottom: r.top }
      : { top: r.top, bottom: r.top + BUBBLE_H };

  it('多行选区：落在**第一行**上方（不是最后一行上方）', () => {
    const target = box({ top: 300, bottom: 420 });
    const r = computeBubblePlacement(target, VIEWPORT);

    expect(r.placement).toBe('above');
    expect(r.top).toBe(292);
    // 核心不变式：气泡与选区**零重叠**
    const edges = bubbleEdges(r);
    expect(edges.bottom <= target.top).toBe(true);
  });

  it('单行选区：同样落在该行上方', () => {
    const target = box({ top: 300, bottom: 328 });
    const r = computeBubblePlacement(target, VIEWPORT);

    expect(r.placement).toBe('above');
    expect(r.top).toBe(292);
    expect(bubbleEdges(r).bottom <= target.top).toBe(true);
  });

  it('选区贴着视口顶、上方放不下 → 翻到选区下方（而不是塞出视口）', () => {
    const target = box({ top: 10, bottom: 110 });
    const r = computeBubblePlacement(target, VIEWPORT);

    expect(r.placement).toBe('below');
    expect(r.top).toBe(118);
    expect(bubbleEdges(r).top >= target.bottom).toBe(true);
  });

  it('水平以选区**整体**中心对齐（用最后一行的中心会偏在一侧）', () => {
    const target = box({ left: 100, right: 500 });
    expect(computeBubblePlacement(target, VIEWPORT).left).toBe(300);
  });

  it('贴视口左右边缘时夹取到视口内，不被裁掉', () => {
    expect(computeBubblePlacement(box({ left: -100, right: 20 }), VIEWPORT).left).toBe(96);
    // 88 = BUBBLE_W/2；夹取上界 = 1440 - 88 - 8
    expect(computeBubblePlacement(box({ left: 1300, right: 1420 }), VIEWPORT).left).toBe(1344);
  });

  it('视口窄到放不下气泡时也不会算出负坐标', () => {
    const r = computeBubblePlacement(box(), 100);
    expect(r.left).toBeGreaterThanOrEqual(0);
  });
});

/**
 * 组件真实路径上的落位（jsdom 桩布局）。
 *
 * 上面那组只钉纯函数；这条钉的是**组件实际用哪个矩形**—— 用户截图里的那个 bug
 * 正是「喂了最后一行给纯函数」，纯函数怎么测都抓不到。
 *
 * jsdom 干脆**没有** `Range.prototype.getBoundingClientRect` / `getClientRects`
 * （生产代码里那句 `typeof … !== 'function'` 判的就是它），所以只能**直接定义**，
 * 不能 `vi.spyOn`。两个都桩上：
 * - `getBoundingClientRect` 给**整体**外框（三行，top 300 / bottom 420）；
 * - `getClientRects` 给**三行**的 rect（末行 top = 400）。
 * 于是「用整体」得到 `top: 292px`，「用最后一行」得到 `412px` —— 两者可区分。
 */
describe('气泡落位：组件真实路径', () => {
  const WHOLE = { left: 100, right: 500, top: 300, bottom: 420 };
  const LINES = [
    { left: 100, right: 500, top: 300, bottom: 328 },
    { left: 100, right: 500, bottom: 378, top: 350 },
    { left: 100, right: 500, bottom: 420, top: 400 },
  ];

  /** 定义两个几何 API，返回还原函数 */
  function stubRangeGeometry(
    whole: Partial<DOMRect>,
    lines: Array<Partial<DOMRect>>,
  ): () => void {
    const proto = Range.prototype as unknown as Record<string, unknown>;
    proto.getBoundingClientRect = () => ({ ...WHOLE, ...whole }) as DOMRect;
    proto.getClientRects = () => lines.map((l) => ({ ...l })) as unknown as DOMRectList;
    return () => {
      delete proto.getBoundingClientRect;
      delete proto.getClientRects;
    };
  }

  it('多行选区时气泡顶边落在选区**整体**上沿之上', () => {
    const restore = stubRangeGeometry({}, LINES);
    try {
      const host = mount(<Harness />);
      const body = host.querySelector('[data-quote-body]') as HTMLElement;
      selectText(body, QUOTE_FROM, QUOTE_TO);
      mouseUpOn(body);

      const bubble = document.querySelector('[data-selection-bubble]') as HTMLElement | null;
      expect(bubble, '气泡应该弹出').toBeTruthy();
      const cs = window.getComputedStyle(bubble!);
      // 300 - 8（间距）；旧写法会用末行 top=400 → 412
      expect(cs.top).toBe('292px');
      // `above` 落位：整体再上移一个自身高度（底边即选区上沿）
      expect(cs.transform).toContain('-100%');
      // 水平：`left` 存的是**中心**坐标（减半宽由 `translateX(-50%)` 负责），
      // 整体中心 = (100 + 500) / 2 = 300
      expect(cs.left).toBe('300px');
    } finally {
      restore();
    }
  });

  it('选区贴视口顶、上方放不下 → 改为落在选区下方（transform 不再上移）', () => {
    const restore = stubRangeGeometry({ top: 10, bottom: 130 }, []);
    try {
      const host = mount(<Harness />);
      const body = host.querySelector('[data-quote-body]') as HTMLElement;
      selectText(body, QUOTE_FROM, QUOTE_TO);
      mouseUpOn(body);

      const bubble = document.querySelector('[data-selection-bubble]') as HTMLElement | null;
      expect(bubble).toBeTruthy();
      const cs = window.getComputedStyle(bubble!);
      expect(cs.top).toBe('138px'); // 130 + 8
      expect(cs.transform).not.toContain('-100%');
    } finally {
      restore();
    }
  });
});

describe('选中文本气泡：弹出与动作', () => {
  it('在消息正文里松手后弹出「复制 / 添加到对话」', () => {
    const host = mount(<Harness />);
    const bubble = openBubbleOnBody(host);

    expect(bubble.querySelector('[aria-label="复制"]')).toBeTruthy();
    expect(bubble.querySelector('[aria-label="添加到对话"]')).toBeTruthy();
  });

  it('复制：写剪贴板、收起气泡、不产生引用', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const host = mount(<Harness />);
    click(openBubbleOnBody(host).querySelector('[aria-label="复制"]'));
    await flush();

    expect(writeText).toHaveBeenCalledWith(QUOTE_TEXT);
    expect(bubbleEl()).toBeNull();
    expect(useSessionUiStore.getState().quotes).toHaveLength(0);
  });

  it('添加到对话：写入引用（带来源消息 id）、收起气泡、清掉原生选区', () => {
    const host = mount(<Harness />);
    click(openBubbleOnBody(host).querySelector('[aria-label="添加到对话"]'));

    const quotes = useSessionUiStore.getState().quotes;
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      sessionId: 's1',
      messageId: 'm1',
      text: QUOTE_TEXT,
    });
    expect(bubbleEl()).toBeNull();
    // 原生选区让位给引用下划线：蓝底选中与虚线同时挂着会很脏
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it('同一段文字加两次仍然只有一枚引用（幂等）', () => {
    const host = mount(<Harness />);
    click(openBubbleOnBody(host).querySelector('[aria-label="添加到对话"]'));
    click(openBubbleOnBody(host).querySelector('[aria-label="添加到对话"]'));

    expect(useSessionUiStore.getState().quotes).toHaveLength(1);
  });
});

describe('选中文本气泡：不响应的场景', () => {
  it('选区落在正文之外（工具输出 / 过程区）时不弹出', () => {
    const host = mount(<Harness />);
    const proc = host.querySelector('[data-proc]') as HTMLElement;
    selectText(proc, 0, 4);
    mouseUpOn(proc);

    expect(bubbleEl()).toBeNull();
  });

  it('折叠选区（只是点了一下）不弹出', () => {
    const host = mount(<Harness />);
    const body = host.querySelector('[data-quote-body]') as HTMLElement;
    selectText(body, 3, 3);
    mouseUpOn(body);

    expect(bubbleEl()).toBeNull();
  });

  it('点气泡以外的地方收起', () => {
    const host = mount(<Harness />);
    openBubbleOnBody(host);

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(bubbleEl()).toBeNull();
  });

  it('Esc 收起', () => {
    const host = mount(<Harness />);
    openBubbleOnBody(host);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(bubbleEl()).toBeNull();
  });

  it('滚动收起（fixed 坐标已失效，不能挂在原地）', () => {
    const host = mount(<Harness />);
    openBubbleOnBody(host);

    act(() => {
      host.dispatchEvent(new Event('scroll'));
    });

    expect(bubbleEl()).toBeNull();
  });

  it('⭐ 右键不弹气泡（那一轮归右键菜单，两个浮层不能叠在一起）', () => {
    // 真机抓到的：右键**不折叠选区**，于是 `mouseup` 里读到的选区仍有效 → 气泡重新弹出，
    // 而此时 `MessageTextContextMenu` 已经把右键菜单弹出来了，两个浮层互相压着。
    // 修法是气泡只认左键（`e.button !== 0` 直接返回）。
    const host = mount(<Harness />);
    const body = host.querySelector('[data-quote-body]') as HTMLElement;
    selectText(body, QUOTE_FROM, QUOTE_TO);

    rightClickOn(body);

    expect(bubbleEl()).toBeNull();
    // 选区仍在（浏览器行为：右键不折叠选区）—— 这是「菜单能复制到字」的前提
    expect(window.getSelection()?.toString()).toBe(QUOTE_TEXT);
  });
});
