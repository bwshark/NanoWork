/**
 * 会话头部的外部来源标记与只读标题（FR-6.4）。
 *
 * 两件事必须一起成立，所以放在同一个文件里对照着钉：
 *
 * 1. **外部来源要看得出来**。IM 会话在本地只是网关那份记录的镜像，用户点开时
 *    若头部与本机新建的会话长得一模一样，就无从判断「这条对话是别人在微信里
 *    跟机器人聊的」还是「我自己刚建的」——而这正是 FR-6.4 要补的信息。
 *
 * 2. **外部来源的标题不许行内编辑**。标题来自网关，本地改名只改这一份镜像，
 *    下一次轮询（`channelSessionsStore.refreshActiveIfChanged`）就把它盖回去，
 *    用户看到的是「改了又自己变回去」。所以这里断言 IM 会话**没有**重命名入口
 *    ——它是一个「缺了会静默出错」的负向断言，比正向断言更值得钉。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatHeader } from '@/pages/chat/ChatHeader';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { byAria, mount, unmount } from './helpers/reactMount';
import type { Session } from '@/types';

function session(id: string, channel?: string): Session {
  return {
    id,
    agentId: '',
    title: id,
    messages: [],
    permissionLog: [],
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    ...(channel ? { channel } : {}),
  };
}

function renderHeader(s: Session): HTMLElement {
  useSessionsStore.setState({
    sessions: [s],
    activeId: s.id,
    streams: {},
    memoryLoaded: { injected: false, dismissed: false, count: 0 },
  });
  return mount(
    <MemoryRouter>
      <ChatHeader />
    </MemoryRouter>,
  );
}

/** 来源标记 chip（MUI Chip 把 data-testid 透传到根节点） */
function badge(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[data-testid="external-source-badge"]');
}

beforeEach(() => {
  unmount();
  useSessionUiStore.setState({ searchSessionId: null, channelFilter: null });
});

/**
 * 收尾：卸组件 + **把过渡定时器跑完**。
 *
 * 头部挂了 MUI `Tooltip`（以及 IconButton 的 TouchRipple），它们用
 * react-transition-group 的 `setTimeout`，**不归 React 管**：用例结束时若还有一次
 * 过渡在飞，它会在测试环境销毁之后触发，vitest 记一条 `Unhandled Error`——
 * 所有用例都绿，但整个 run 的退出码是 1。判门禁看退出码，所以这 400ms 必须等。
 */
afterEach(async () => {
  unmount();
  await new Promise((r) => setTimeout(r, 400));
});

describe('IM 频道会话的头部', () => {
  it('显示「来自 xx」的来源标记', () => {
    const host = renderHeader(session('nb:weixin:wxid_a', 'weixin'));
    const el = badge(host);
    expect(el, '未渲染来源标记').toBeTruthy();
    expect(el!.textContent).toContain('来自');
    expect(el!.textContent).toContain('微信');
  });

  it('owner 限定形态的渠道同样认得出（feishu.feishu → 飞书）', () => {
    const host = renderHeader(session('nb:feishu.feishu:ou_x', 'feishu.feishu'));
    expect(badge(host)!.textContent).toContain('飞书');
  });

  it('标题只读：没有重命名入口', () => {
    const host = renderHeader(session('nb:weixin:wxid_a', 'weixin'));
    expect(byAria('重命名', host)).toBeNull();
  });

  it('标题文案仍然照常显示（只读不等于不显示）', () => {
    const host = renderHeader(session('nb:weixin:wxid_a', 'weixin'));
    expect(host.textContent).toContain('nb:weixin:wxid_a');
  });

  it('快捷入口（搜索 / 历史提问 / 产物）仍在 —— 它们都是只读动作', () => {
    const host = renderHeader(session('nb:weixin:wxid_a', 'weixin'));
    expect(byAria('对话内搜索', host)).toBeTruthy();
    expect(byAria('历史提问', host)).toBeTruthy();
    expect(byAria('产物面板', host)).toBeTruthy();
  });
});

describe('本机会话的头部（对照组）', () => {
  it('没有来源标记', () => {
    const host = renderHeader(session('sess-local'));
    expect(badge(host)).toBeNull();
  });

  it('可以重命名', () => {
    const host = renderHeader(session('sess-local'));
    expect(byAria('重命名', host)).toBeTruthy();
  });
});
