/**
 * 快捷键设置分区的渲染与交互。
 *
 * 这里锁的是三类「界面看起来对、功能其实没接上」的失效：
 *
 * 1. **列表漏项**：注册表里加了命令，界面却没渲染出来（或反之，界面手写了一份列表）；
 * 2. **不可改的项被做成可改**（或反之）：参考图里固定的 `@` / `/` 两项必须没有「恢复默认」入口，
 *    否则点了会改掉一个根本不参与按键匹配的串；
 * 3. **改键没落到 store**：录入器弹出来了、按了组合键，但覆盖表没写进去——
 *    表现就是「设置里显示新键位，实际按下去没反应」。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { ShortcutsSection } from '@/components/settings/sections/ShortcutsSection';
import { SHORTCUTS } from '@/lib/shortcuts';
import { useSettingsStore } from '@/stores/settingsStore';
import { byAria, buttonByText, flush, mount, setInputValue, unmount } from './helpers/reactMount';

beforeEach(() => {
  unmount();
  const s = useSettingsStore.getState();
  useSettingsStore.setState({ settings: { ...s.settings, shortcuts: {} } });
});

/** 在某个元素上派发一次真实按键（React 的键盘事件走冒泡委托） */
function pressKey(el: Element, init: KeyboardEventInit): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
}

function searchBox(): HTMLInputElement | null {
  return document.querySelector(
    'input[placeholder="搜索快捷键"]',
  ) as HTMLInputElement | null;
}

describe('快捷键分区', () => {
  it('注册表里的每条命令都渲染出来', () => {
    const host = mount(<ShortcutsSection />);
    const text = host.textContent ?? '';
    for (const def of SHORTCUTS) {
      expect(text, `命令「${def.label}」未渲染`).toContain(def.label);
    }
  });

  it('表头三列与默认键位都对得上（含 Plus/Minus 的引号写法）', () => {
    const host = mount(<ShortcutsSection />);
    const text = host.textContent ?? '';
    expect(text).toContain('命令');
    expect(text).toContain('按键绑定');
    expect(text).toContain('操作');
    // 默认键位直接取自注册表，展示串按 formatBinding 还原
    expect(text).toContain('Ctrl+,');
    expect(text).toContain('Ctrl+Shift+B');
    expect(text).toContain('Enter');
  });

  it('固定的两项没有「恢复默认」入口', () => {
    mount(<ShortcutsSection />);
    // 只给不可改的两条命令做无障碍标签判定：它们不该存在
    for (const def of SHORTCUTS.filter((d) => d.group === 'fixed')) {
      expect(
        byAria(`恢复「${def.label}」的默认按键`),
        `固定的「${def.label}」不应有恢复入口`,
      ).toBeNull();
    }
  });

  it('搜索按命令名过滤', async () => {
    const host = mount(<ShortcutsSection />);
    setInputValue(searchBox(), '产物');
    await flush();

    expect(host.textContent).toContain('切换右侧产物面板');
    expect(host.textContent).not.toContain('打开设置');
  });

  it('搜索无结果时给出空状态，而不是留一片空白', async () => {
    const host = mount(<ShortcutsSection />);
    setInputValue(searchBox(), 'zzz-不存在的命令');
    await flush();
    expect(host.textContent).toContain('没有匹配的快捷键');
  });

  it('「全部恢复默认」在没有改过键时是禁用的', () => {
    mount(<ShortcutsSection />);
    const btn = buttonByText(document.body, '全部恢复默认');
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
  });

  it('点键帽打开录入器，按下组合键后写入覆盖表', async () => {
    mount(<ShortcutsSection />);

    const keycap = byAria('修改「新建对话」的按键绑定');
    expect(keycap, '「新建对话」的键帽未渲染').toBeTruthy();

    act(() => {
      keycap!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // 录入器出现（Popover 走 Portal 渲染到 body）
    expect(document.body.textContent).toContain('请按下组合键');

    const recorder = byAria('按键录制区');
    expect(recorder, '录入器未渲染').toBeTruthy();

    pressKey(recorder!, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
    await flush();

    expect(
      useSettingsStore.getState().settings.shortcuts?.['chat.new'],
    ).toBe('Ctrl+Alt+N');
  });

  it('录入时按 Esc 取消，保留原有键位', async () => {
    // 先放一个自定义值：若断言「没有写过」就等于什么都没验证
    const s = useSettingsStore.getState();
    useSettingsStore.setState({
      settings: { ...s.settings, shortcuts: { 'chat.new': 'Ctrl+Alt+K' } },
    });

    mount(<ShortcutsSection />);

    const keycap = byAria('修改「新建对话」的按键绑定');
    act(() => {
      keycap!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const recorder = byAria('按键录制区');
    expect(recorder, '录入器未渲染').toBeTruthy();
    pressKey(recorder!, { key: 'Escape', code: 'Escape' });
    await flush();

    expect(useSettingsStore.getState().settings.shortcuts?.['chat.new']).toBe(
      'Ctrl+Alt+K',
    );
  });

  it('录入时按 Backspace 清空 = 禁用（表项留空串，不是删除）', async () => {
    mount(<ShortcutsSection />);

    const keycap = byAria('修改「新建对话」的按键绑定');
    act(() => {
      keycap!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const recorder = byAria('按键录制区');
    expect(recorder, '录入器未渲染').toBeTruthy();
    pressKey(recorder!, { key: 'Backspace', code: 'Backspace' });
    await flush();

    expect(useSettingsStore.getState().settings.shortcuts?.['chat.new']).toBe('');
  });
});
