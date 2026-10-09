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
import { SelectionQuoteBubble } from '@/pages/chat/SelectionQuoteBubble';
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
});
