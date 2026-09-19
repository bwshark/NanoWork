/**
 * 全局快捷键派发器。
 *
 * 分区界面（`shortcutsSection.test.tsx`）只证明「键位能存下来」，存下来之后
 * **有没有真的被拿去匹配按键**，是另一回事——这一层专门锁后者。典型失效是
 * 「设置里改了键、覆盖表也写进去了，但按下新键毫无反应」，根因往往在派发器
 * 读的是默认值、或者在依赖数组里缓存了旧的覆盖表。
 *
 * 同时固定两条容易被无意破坏的边界：
 * - 没做任何事时**不吞按键**（否则 Web 端 Ctrl+F 会连浏览器查找一起挡掉）；
 * - 裸键在输入控件里**不劫持**（否则把命令绑成 `K` 之后，输入框里就打不出 k）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSettingsUiStore } from '@/stores/settingsUiStore';
import { flush, mount, unmount } from './helpers/reactMount';

/** 只挂派发器，不渲染任何界面：它本身就是个纯副作用 hook */
function DispatcherHost() {
  useGlobalShortcuts();
  return null;
}

function mountDispatcher(): void {
  mount(
    <MemoryRouter>
      <DispatcherHost />
    </MemoryRouter>,
  );
}

/** 在 `target` 上按一次键；默认打在 window 上（模拟「焦点不在输入框里」） */
function press(
  target: EventTarget,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function onWindow(init: KeyboardEventInit): KeyboardEvent {
  return press(window, init);
}

beforeEach(() => {
  unmount();
  const settings = useSettingsStore.getState();
  useSettingsStore.setState({
    settings: { ...settings.settings, shortcuts: {} },
  });
  useSessionsStore.setState({ sessions: [], activeId: null });
  useSettingsUiStore.setState({ open: false, section: 'general' });
  useSessionUiStore.setState({ searchSessionId: null, artifactPanelOpen: false });
});

describe('全局快捷键派发', () => {
  it('Ctrl+, 打开设置弹窗', () => {
    mountDispatcher();
    onWindow({ key: ',', code: 'Comma', ctrlKey: true });
    expect(useSettingsUiStore.getState().open).toBe(true);
  });

  it('改键后立即生效：旧键位失效、新键位接上', () => {
    const s = useSettingsStore.getState();
    useSettingsStore.setState({
      settings: {
        ...s.settings,
        shortcuts: { 'settings.open': 'Ctrl+Alt+O' },
      },
    });
    mountDispatcher();

    onWindow({ key: ',', code: 'Comma', ctrlKey: true });
    expect(
      useSettingsUiStore.getState().open,
      '默认键位在已被覆盖的情况下仍被匹配',
    ).toBe(false);

    onWindow({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true });
    expect(useSettingsUiStore.getState().open).toBe(true);
  });

  it('没有活跃会话时 Ctrl+F 不吞按键（浏览器查找仍可用）', () => {
    mountDispatcher();
    const event = onWindow({ key: 'f', code: 'KeyF', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(useSessionUiStore.getState().searchSessionId).toBeNull();
  });

  it('有活跃会话时 Ctrl+F 打开会话内搜索', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '搜索会话');
    await flush();
    mountDispatcher();

    onWindow({ key: 'f', code: 'KeyF', ctrlKey: true });
    expect(useSessionUiStore.getState().searchSessionId).toBe(session.id);
  });

  it('Ctrl+N 新建任务', async () => {
    useSessionsStore.getState().createSession('agent-test', '已有任务');
    await flush();
    const before = useSessionsStore.getState().sessions.length;

    mountDispatcher();
    onWindow({ key: 'n', code: 'KeyN', ctrlKey: true });
    await flush();

    expect(useSessionsStore.getState().sessions.length).toBe(before + 1);
  });

  it('Ctrl+] / Ctrl+[ 在任务间前后移动', async () => {
    const store = useSessionsStore.getState();
    const first = store.createSession('agent-test', '任务一');
    const second = store.createSession('agent-test', '任务二');
    await flush();
    useSessionsStore.setState({ activeId: first.id });

    mountDispatcher();

    onWindow({ key: ']', code: 'BracketRight', ctrlKey: true });
    expect(useSessionsStore.getState().activeId).toBe(second.id);

    onWindow({ key: '[', code: 'BracketLeft', ctrlKey: true });
    expect(useSessionsStore.getState().activeId).toBe(first.id);
  });

  it('Ctrl+B 在 Web 端不响应（没有标题栏，收起后无法展开）', () => {
    mountDispatcher();
    const event = onWindow({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(useSettingsStore.getState().settings.sidebarCollapsed).toBeFalsy();
  });

  it('裸键落在输入控件里不劫持（否则输入框里打不出这个字母）', () => {
    const s = useSettingsStore.getState();
    useSettingsStore.setState({
      settings: { ...s.settings, shortcuts: { 'settings.open': 'K' } },
    });
    mountDispatcher();

    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, { key: 'k', code: 'KeyK' });

    expect(
      useSettingsUiStore.getState().open,
      '在输入框里打字不应触发快捷键',
    ).toBe(false);
  });

  it('同一个裸键在非输入区域仍可触发', () => {
    const s = useSettingsStore.getState();
    useSettingsStore.setState({
      settings: { ...s.settings, shortcuts: { 'settings.open': 'K' } },
    });
    mountDispatcher();

    onWindow({ key: 'k', code: 'KeyK' });
    expect(useSettingsUiStore.getState().open).toBe(true);
  });

  it('被禁用的命令（绑定为空串）不再响应', () => {
    const s = useSettingsStore.getState();
    useSettingsStore.setState({
      settings: { ...s.settings, shortcuts: { 'settings.open': '' } },
    });
    mountDispatcher();

    const event = onWindow({ key: ',', code: 'Comma', ctrlKey: true });
    expect(useSettingsUiStore.getState().open).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
