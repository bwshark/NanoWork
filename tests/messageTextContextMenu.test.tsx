/**
 * 消息正文的右键菜单（剪切 / 复制 / 粘贴 / 全选）。
 *
 * ## 为什么要有这个组件
 *
 * 应用菜单被 `Menu.setApplicationMenu(null)` 置空后，Chromium 的原生编辑菜单
 * 随之失效 —— 消息流里右键**什么都不弹**。而「选中一段话 → 右键复制」是高频操作。
 *
 * ## 钉住的四件事
 *
 * 1. **只在正文里响应**：作用域与选区气泡完全一致（`[data-quote-body]`）。
 *    过程时间线 / 工具卡片里右键不弹 —— 那里没有「消息正文」可操作。
 * 2. **剪切 / 粘贴置灰，且说清为什么**：消息正文是渲染出来的历史内容，往里粘东西
 *    没有意义。这里锁的是「禁用项也要挂 title」—— 只置灰不说原因，用户只会以为坏了。
 * 3. **文案在右键那一刻定格**：菜单 `autoFocus` 会移动焦点，点「复制」时再去读
 *    `window.getSelection()` 未必还是刚才那段。用例通过「菜单开着时把选区改掉」来钉它。
 * 4. **「全选」选的是这条消息，不是整个文档**：用 `execCommand('selectAll')` 会选中
 *    整个页面 —— 那是肉眼可见的错，且很难在截图里被当成 bug 报上来。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { ThemeProvider } from '@mui/material';
import { MessageTextContextMenu } from '@/pages/chat/MessageTextContextMenu';
import { muiTheme } from '@/theme/muiTheme';
import { click, flush, mount, unmount } from './helpers/reactMount';

const BODY_TEXT = '明天是国庆节假期的第 7 天，记得提前安排好值班。';
const QUOTE_TEXT = '国庆节假期';
/**
 * 下标从正文现算。
 *
 * 手数字符数是个反复踩的坑：「国庆节假期」是 **5** 个字，写成 `3 + 6` 就会多带一个
 * 「的」，断言莫名其妙地差一个字，而报错信息只会告诉你实际值 —— 根因要自己回溯。
 */
const QUOTE_FROM = BODY_TEXT.indexOf(QUOTE_TEXT);
const QUOTE_TO = QUOTE_FROM + QUOTE_TEXT.length;

function Harness({ sessionId = 's1' }: { sessionId?: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // ⚠️ `return (<JSX>,)` 的**逗号运算符**不能加：TS 5.9 会报 TS1109「Expression expected」，
  // 而 vite / vitest 都能正常解析 —— 两边结论相反，极易误判成「文件写坏了」。
  // 症状是报错落在收尾的 `);` 那一行，与真正的病灶隔着几十行。本文件就是踩了这个坑。
  return (
    <ThemeProvider theme={muiTheme}>
      <>
        <div ref={rootRef}>
          <div data-message-id="m1">
            <div data-quote-body="">{BODY_TEXT}</div>
          </div>
          <div data-message-id="m2">
            {/* 过程 / 工具区：没有 data-quote-body，右键不该弹菜单 */}
            <div data-proc="">工具输出的另一段文字</div>
          </div>
        </div>
        <MessageTextContextMenu rootRef={rootRef} sessionId={sessionId} />
      </>
    </ThemeProvider>
  );
}

/** 在正文的首个文本节点上建立选区，返回派发的右键事件（用于查 defaultPrevented） */
function selectAndRightClick(host: HTMLElement, from = QUOTE_FROM, to = QUOTE_TO): MouseEvent {
  const body = host.querySelector('[data-quote-body]') as HTMLElement;
  const node = body.firstChild as Text;
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 240,
  });
  act(() => {
    body.dispatchEvent(event);
  });
  return event;
}

function rightClickOn(el: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 120,
    clientY: 240,
  });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

/** 菜单项（MUI Menu 经 Portal 渲染到 document.body，不在挂载容器里） */
function menuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function menuItem(label: string): HTMLElement | null {
  return menuItems().find((el) => (el.textContent ?? '').trim() === label) ?? null;
}

const isDisabled = (el: HTMLElement | null) => el?.getAttribute('aria-disabled') === 'true';

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.getSelection()?.removeAllRanges();
});

afterEach(async () => {
  unmount();
  // MUI Menu 的 Grow 过渡走 react-transition-group 的 setTimeout（不归 React 管），
  // 不等它就会在环境销毁后触发 → 「全绿但退出码 1」。判门禁看退出码，所以必须等。
  await new Promise((r) => setTimeout(r, 400));
});

describe('消息正文右键菜单：弹出与作用域', () => {
  it('正文里右键弹出四个菜单项，且拦掉浏览器原生菜单', async () => {
    const host = mount(<Harness />);
    const event = selectAndRightClick(host);
    await flush();

    expect(menuItems().map((el) => (el.textContent ?? '').trim())).toEqual([
      '剪切',
      '复制',
      '粘贴',
      '全选',
    ]);
    // Web 端不 preventDefault 会与原生菜单**同时**出现（两份一模一样的条目）
    expect(event.defaultPrevented).toBe(true);
  });

  it('正文之外（过程 / 工具区）右键不弹菜单', async () => {
    const host = mount(<Harness />);
    const proc = host.querySelector('[data-proc]') as HTMLElement;
    const event = rightClickOn(proc);
    await flush();

    expect(menuItems()).toHaveLength(0);
    // 也不该拦原生菜单：这里不归我们管
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('消息正文右键菜单：只读语义的置灰', () => {
  it('剪切 / 粘贴置灰且给出原因；复制与全选可用', async () => {
    const host = mount(<Harness />);
    selectAndRightClick(host);
    await flush();

    expect(isDisabled(menuItem('剪切'))).toBe(true);
    expect(isDisabled(menuItem('粘贴'))).toBe(true);
    // 置灰要说清为什么，否则用户只会以为坏了
    expect(menuItem('剪切')?.getAttribute('title')).toContain('只读');
    expect(menuItem('粘贴')?.getAttribute('title')).toContain('只读');

    expect(isDisabled(menuItem('复制'))).toBe(false);
    expect(isDisabled(menuItem('全选'))).toBe(false);
  });

  it('没有选区时「复制」也置灰（全选仍可用）', async () => {
    const host = mount(<Harness />);
    rightClickOn(host.querySelector('[data-quote-body]') as HTMLElement);
    await flush();

    expect(isDisabled(menuItem('复制'))).toBe(true);
    expect(isDisabled(menuItem('全选'))).toBe(false);
  });
});

describe('消息正文右键菜单：动作', () => {
  it('「复制」写的是右键那一刻定格的选区（菜单开着时改选区也不影响）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const host = mount(<Harness />);
    selectAndRightClick(host);
    await flush();

    // 菜单 autoFocus 后把选区挪到别处：若动作现读 selection，复制到的就是这段
    act(() => {
      const body = host.querySelector('[data-quote-body]') as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    click(menuItem('复制'));
    await flush();

    expect(writeText).toHaveBeenCalledWith(QUOTE_TEXT);
  });

  it('「全选」选中这条消息的正文，而不是整个文档', async () => {
    const host = mount(<Harness />);
    rightClickOn(host.querySelector('[data-quote-body]') as HTMLElement);
    await flush();

    click(menuItem('全选'));
    // MUI Menu 的退场过渡有 duration，DOM 还留着；断言菜单已收必须等它跑完
    await flush();

    const selected = window.getSelection()?.toString() ?? '';
    // 文档里还有侧栏等其它文本；全选到「整页」时这里会是全文
    expect(selected).toBe(BODY_TEXT);
    expect(menuItems()).toHaveLength(0);
  });
});

describe('消息正文右键菜单：收起路径', () => {
  it('滚动时关闭（fixed 锚点已失效）', async () => {
    const host = mount(<Harness />);
    selectAndRightClick(host);
    await flush();
    expect(menuItems().length).toBeGreaterThan(0);

    act(() => {
      host.dispatchEvent(new Event('scroll'));
    });
    await flush();

    expect(menuItems()).toHaveLength(0);
  });

  it('换会话即关闭（菜单锚在某条消息的某段文字上）', async () => {
    const host = mount(<Harness />);
    selectAndRightClick(host);
    await flush();
    expect(menuItems().length).toBeGreaterThan(0);

    mount(<Harness sessionId="s2" />);
    await flush();

    expect(menuItems()).toHaveLength(0);
  });
});