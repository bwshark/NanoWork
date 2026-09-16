/**
 * 组件测试的挂载与交互辅助（jsdom + react-dom/client）。
 *
 * 与 `tests/planCard.test.tsx` 里的本地辅助函数同源，抽出来给多个页面级测试共用。
 * 三条约定值得写下来，它们都是踩过的坑：
 *
 * 1. **不用 `@testing-library`**：本项目没有这个依赖，也不打算为此加。直接
 *    `createRoot` + `act` 足够覆盖这些页面关心的「渲染出什么 + 点了会怎样」。
 * 2. **设置受控输入必须走原型上的 value setter**：React 18 在 input 元素上装了
 *    自己的 value tracker，直接 `el.value = x` 后派发 input 事件会被判定为
 *    「值没变」而丢弃，测试看起来过了其实是空转。
 * 3. **MUI Dialog / Menu 走 Portal 渲染到 `document.body`**，不在挂载容器里。
 *    查询弹窗内容要用 `dialogRoot()` 而不是 `mount()` 返回的 host。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** 卸载当前挂载的组件树（幂等） */
export function unmount(): void {
  if (root) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  host?.remove();
  host = null;
}

/** 挂载组件并返回容器；重复调用会先卸载上一棵组件树 */
export function mount(node: React.ReactElement): HTMLDivElement {
  unmount();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  act(() => {
    r.render(node);
  });
  return host;
}

/** 派发一次冒泡 click（找不到元素直接让断言失败，而不是静默通过） */
export function click(el: Element | null | undefined): void {
  expect(el).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * 把点击带来的异步链跑完。
 *
 * 按轮次刷新而不是死等固定延时：`await new Promise(r => setTimeout(r, 0))` 在慢机器上
 * 会让用例随机变红，而固定多跑几轮只是多花几毫秒。
 */
export async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/**
 * 写入受控 input / textarea 的值并触发 React 的 onChange。
 *
 * 必须先通过原型上的 setter 赋值：React 在元素上挂了 value tracker，
 * 直接 `el.value = v` 会让它认为「值没变化」从而不派发 onChange。
 */
export function setInputValue(
  el: HTMLInputElement | HTMLTextAreaElement | null | undefined,
  value: string,
): void {
  expect(el).toBeTruthy();
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  act(() => {
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 按无障碍标签（aria-label）查找元素 */
export function byAria(label: string, scope: ParentNode = document): HTMLElement | null {
  return scope.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
}

/** 按可见文案查找按钮（文案变化频繁时优先用 aria-label） */
export function buttonByText(
  scope: ParentNode,
  text: string,
): HTMLButtonElement | null {
  return (
    (Array.from(scope.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(text),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

/** MUI Dialog 的 Portal 根节点（弹窗内容不在挂载容器内） */
export function dialogRoot(): HTMLElement {
  const el = document.querySelector('[role="dialog"]');
  expect(el).toBeTruthy();
  return el as HTMLElement;
}
