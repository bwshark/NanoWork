/**
 * DevTools 手开快捷键判据（`electron/devtoolsShortcut.ts`）。
 *
 * 这组用例守的是**两个相反方向的错**，且两种错都会真实伤到用户：
 * - **漏判** → `Ctrl+Shift+I` 没反应，而 DevTools 的自动打开已被默认关掉、
 *   应用菜单也被 `setApplicationMenu(null)` 置空 → 用户**再也进不去 DevTools**；
 * - **误判** → 在输入框里打一个 `i` 就弹出 DevTools，比没有这个功能更糟。
 *
 * 所以下面「裸 `i` 不算」「`Shift+I` 不算」「`Ctrl+I` 不算」这几条否定判据
 * 与肯定判据同等重要，缺了任何一条这组测试就失去意义。
 */

import { describe, expect, it } from 'vitest';
import { isDevToolsShortcut } from '../../electron/devtoolsShortcut';

describe('isDevToolsShortcut：DevTools 手开键位', () => {
  it('F12 三平台通用', () => {
    expect(isDevToolsShortcut({ key: 'F12' })).toBe(true);
    // 大小写不敏感：Electron 在不同平台/键盘布局下给的可能是小写
    expect(isDevToolsShortcut({ key: 'f12' })).toBe(true);
  });

  it('Windows / Linux：Ctrl+Shift+I', () => {
    expect(isDevToolsShortcut({ key: 'I', control: true, shift: true })).toBe(true);
    expect(isDevToolsShortcut({ key: 'i', control: true, shift: true })).toBe(true);
  });

  it('macOS：Cmd+Opt+I', () => {
    expect(isDevToolsShortcut({ key: 'i', meta: true, alt: true })).toBe(true);
  });

  it('**否定判据**：裸 i / Shift+I / Ctrl+I 都不算（否则输入框里打字就会弹面板）', () => {
    expect(isDevToolsShortcut({ key: 'i' })).toBe(false);
    expect(isDevToolsShortcut({ key: 'i', shift: true })).toBe(false);
    expect(isDevToolsShortcut({ key: 'i', control: true })).toBe(false);
    expect(isDevToolsShortcut({ key: 'i', meta: true })).toBe(false);
  });

  it('判据刻意**宽松**：多按一个修饰键不该让用户打不开面板', () => {
    // Ctrl+Shift+I 已经成立，再叠一个 Alt 仍算——否则「手上多按了一个键」
    // 就会表现为「快捷键没反应」，而 DevTools 已默认不自动开，用户会以为坏了
    expect(isDevToolsShortcut({ key: 'i', control: true, shift: true, alt: true })).toBe(true);
  });

  it('**否定判据**：其他控制键组合不得误判', () => {
    expect(isDevToolsShortcut({ key: 'c', control: true, shift: true })).toBe(false);
    expect(isDevToolsShortcut({ key: 'F5' })).toBe(false);
    expect(isDevToolsShortcut({ key: 'Escape' })).toBe(false);
  });

  it('缺 key 时不抛错、也不判成快捷键（事件对象字段不全也要安全）', () => {
    expect(isDevToolsShortcut({ key: '' })).toBe(false);
    expect(isDevToolsShortcut({ key: '', control: true, shift: true })).toBe(false);
  });
});
