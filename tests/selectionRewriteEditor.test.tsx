/**
 * FR-7.5 圈选改写**编辑器**的行为判据。
 *
 * 为什么不只测纯逻辑：`selectionRewrite.ts` 全绿只能证明「算得对」，不能证明
 * 「界面真的把选区送进去了」——本仓反复踩过「函数对但没人调」。
 *
 * 这里钉住五件事：
 * 1. 正文为空时不进入编辑（空 textarea 一保存就是把文件清空）；
 * 2. 文件产物读不到磁盘时如实说明，也不给空编辑框；
 * 3. 没圈选时按钮不可点（不让用户白点一次才知道要先选）；
 * 4. 圈选后点击，**真的**把选区偏移与意图传给了改写服务；
 * 5. 改写失败时不回调 `onApplied`（不能假装成功）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { SelectionRewriteEditor } from '@/components/artifacts/SelectionRewriteEditor';
import { byAria, click, flush, mount, setInputValue, unmount, waitForSettled } from './helpers/reactMount';
import type { Artifact } from '@/types';

const { startSelectionRewriteMock } = vi.hoisted(() => ({
  startSelectionRewriteMock: vi.fn(),
}));

vi.mock('@/lib/artifact/selectionRewriteService', () => ({
  startSelectionRewrite: startSelectionRewriteMock,
}));

vi.mock('@/lib/artifact/localFilePreview', () => ({
  readLocalTextFile: vi.fn(async () => null),
}));

vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/**
 * 在 textarea 上伪造一段选区。
 *
 * 两个 jsdom 坑，都实测过：
 * 1. ⛔ **没有 `setSelectionRange`**（与「jsdom 无布局」同一类缺口：它不实现选区），
 *    直接调用抛 `not a function` → 手动 `defineProperty` 设 `selectionStart/End`；
 * 2. ⛔ 派发合成的 **`select` 事件不会触发 React 的 `onSelect`**（实测无反应），
 *    必须派发 **`mouseup`** —— 被测组件的 `onMouseUp` 处理器读的正是那两个属性。
 *    真机上两者都会到，测试只走能跑通的那条。
 */
function selectRange(area: HTMLTextAreaElement, start: number, end: number): void {
  Object.defineProperty(area, 'selectionStart', { value: start, configurable: true });
  Object.defineProperty(area, 'selectionEnd', { value: end, configurable: true });
  act(() => {
    area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

/** 正文 textarea 本体（`aria-label` 落在 MUI 外层 div 上，要往里取一层） */
function bodyArea(): HTMLTextAreaElement {
  const el = inputIn('产物正文（可圈选）');
  expect(el).toBeTruthy();
  return el as HTMLTextAreaElement;
}

/**
 * 取 aria-label 容器里的真实 input / textarea。
 *
 * MUI 的 TextField 会把 `aria-label` 落在**外层 div**（不是内部控件），
 * 直接把那个 div 当输入框去赋值会报「不是 HTMLInputElement 的有效实例」。
 */
function inputIn(label: string): HTMLTextAreaElement | HTMLInputElement | null {
  const wrapper = byAria(label);
  if (!wrapper) return null;
  if (wrapper.matches('input, textarea')) return wrapper as HTMLInputElement;
  return wrapper.querySelector('input, textarea') as HTMLInputElement | null;
}

function art(over: Partial<Artifact> & { id: string }): Artifact {
  const { id, ...rest } = over;
  return { type: 'code', content: '', createdAt: '2026-11-03T00:00:00.000Z', ...rest, id };
}

function renderEditor(artifact: Artifact, onApplied: (v: number) => void) {
  return mount(
    <SelectionRewriteEditor artifact={artifact} onApplied={onApplied} onClose={() => undefined} />,
  );
}

beforeEach(() => {
  startSelectionRewriteMock.mockReset();
});

describe('SelectionRewriteEditor', () => {
  it('⛔ 正文为空且非文件产物时不进入编辑', async () => {
    const host = renderEditor(art({ id: 'a1' }), vi.fn());
    await flush();
    expect(host.textContent).toContain('这个产物没有可编辑的正文快照');
    expect(byAria('产物正文（可圈选）')).toBeNull();
    unmount();
  });

  it('文件产物读不到磁盘时如实说明，也不给空编辑框', async () => {
    const host = renderEditor(art({ id: 'f1', type: 'file', path: 'C:/x/y.txt' }), vi.fn());
    await flush();
    expect(host.textContent).toContain('无法读取该文件内容');
    expect(byAria('产物正文（可圈选）')).toBeNull();
    unmount();
  });

  it('没圈选时「让 AI 改写」不可点', () => {
    const host = renderEditor(art({ id: 'a2', content: 'hello world' }), vi.fn());
    const button = Array.from(host.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('让 AI 改写'),
    );
    expect(button).toBeTruthy();
    expect(button!.hasAttribute('disabled')).toBe(true);
    expect(host.textContent).toContain('未选择');
    unmount();
  });

  it('⛔ 圈选 + 填意图后点击，真的把选区偏移与意图传给了改写服务', async () => {
    const onApplied = vi.fn();
    const host = renderEditor(art({ id: 'a3', content: 'hello world' }), onApplied);

    const area = bodyArea();
    selectRange(area, 0, 5);

    await waitForSettled(() => (host.textContent ?? '').includes('已选 5 字'));
    expect(host.textContent).toContain('已选 5 字');

    setInputValue(inputIn('改写要求'), '改成大写');

    startSelectionRewriteMock.mockReturnValue({
      cancel: vi.fn(),
      result: Promise.resolve({ ok: true, content: 'HELLO world', version: 2 }),
    });

    const button = Array.from(host.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('让 AI 改写'),
    );
    expect(button!.hasAttribute('disabled')).toBe(false);
    click(button);

    await waitForSettled(() => startSelectionRewriteMock.mock.calls.length > 0);
    expect(startSelectionRewriteMock).toHaveBeenCalledTimes(1);

    const arg = startSelectionRewriteMock.mock.calls[0][0] as {
      selection: { start: number; end: number };
      instruction: string;
    };
    expect(arg.selection).toEqual({ start: 0, end: 5 });
    expect(arg.instruction).toBe('改成大写');

    await waitForSettled(() => onApplied.mock.calls.length > 0);
    expect(onApplied).toHaveBeenCalledWith(2);
    unmount();
  });

  it('⛔ 改写失败时不回调 onApplied（不能假装成功）', async () => {
    const onApplied = vi.fn();
    const host = renderEditor(art({ id: 'a4', content: 'hello world' }), onApplied);

    selectRange(bodyArea(), 0, 5);
    await waitForSettled(() => (host.textContent ?? '').includes('已选 5 字'));

    setInputValue(inputIn('改写要求'), '改');
    startSelectionRewriteMock.mockReturnValue({
      cancel: vi.fn(),
      result: Promise.resolve({ ok: false, reason: '模型没有返回改写结果' }),
    });

    const button = Array.from(host.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('让 AI 改写'),
    );
    click(button);

    await waitForSettled(() => startSelectionRewriteMock.mock.calls.length > 0);
    await flush();
    expect(onApplied).not.toHaveBeenCalled();
    unmount();
  });
});
