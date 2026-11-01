/**
 * 侧边栏任务列表的 Tooltip：**容器一滚动就必须收起**。
 *
 * ## 为什么这条要单独守
 *
 * MUI Tooltip 只监听 **window** 的 `scroll` 来重新定位/关闭。侧边栏自己那个
 * `overflowY: auto` 容器滚动时，它既不跟随也不关闭 —— 于是行滚走了，那块浮层
 * 还悬在列表中间，看着像凭空冒出来一坨日期（2026-11-02 用户截图：hover 会话行
 * 再滚轮，红框里留下「2026/10/1 15:53:12」，而且**同时叠着两个**）。
 *
 * 修复用的是「受控 + 一个 key」：容器滚动时把 `pinnedTip` 清空。
 *
 * ## 为什么拿「分组头」的浮层来验证，而不是会话行的时间浮层
 *
 * 会话行右侧的槽在 `hoverId === s.id` 时会**从时间换成三点按钮** —— 鼠标一进到
 * 时间文字上，时间元素就被替换掉了，Tooltip 的 child 当场卸载，浮层根本来不及
 * 稳定存在（jsdom 里实测：hover 之后连那个 `<p>` 都找不到了）。
 * 也就是说「行内时间浮层」在组件测试里不可复现，硬测只会得到一条永远为假的断言。
 *
 * 分组头那枚浮层不会替换自身，能稳定弹出，而它走的是**同一套** `pinnedTip` +
 * 同一个滚动容器 —— 机制一致，用它验证即可。
 *
 * 判据只能是「滚动后浮层消失」，**不能**是「浮层位置对不对」：jsdom 没有布局，
 * 位置断言在这里恒真，等于什么都没测。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarNav } from '@/layout/SidebarNav';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { mount, unmount } from './helpers/reactMount';
import type { Session } from '@/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

/**
 * 开启 act 环境。
 *
 * 不开的后果不是「慢一点」，而是**计时器里触发的 setState 只调度不提交**：
 * tooltip 的 `enterDelay` 回调在 setTimeout 里改了 state，DOM 却一直是空的，
 * 用例会稳定地报「浮层没出现」——把功能坏了和测法坏了混成同一句话。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const WORKDIR = 'C:\\Users\\tester\\NanoWork';

/** 一条刚更新过的任务：`updatedAt` 取现在，相对时间恒为「刚刚」（不随日期漂移） */
function freshSession(id: string): Session {
  const now = new Date().toISOString();
  return {
    id,
    agentId: '',
    title: id,
    messages: [],
    messageCount: 2,
    permissionLog: [],
    createdAt: now,
    updatedAt: now,
    workdir: WORKDIR,
  };
}

/**
 * 真实计时器等待，**并且包在 act 里**：Tooltip 的 enterDelay / 关闭过渡都不归
 * React 管，更新必须落在 act 作用域内才会提交到 DOM。
 */
const settle = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** 派发一次冒泡 mouseover —— React 由此派生出 onMouseEnter */
function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

/**
 * 当前挂在 DOM 里的 tooltip 浮层（MUI 走 Portal，不在挂载容器里）。
 *
 * ⚠️ 不能用 `[role="tooltip"]`：MUI v5 的浮层是一个 `styled('div')`，
 * 只带 `MuiTooltip-tooltip` class，**没有 role 属性** —— 用 role 查会永远为空，
 * 于是「浮层出现」和「浮层被关掉」两条断言会一起变成恒假/恒真的假绿。
 */
function visibleTooltips(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.MuiTooltip-tooltip'));
}

function renderSidebar(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <SidebarNav />
    </MemoryRouter>,
  );
}

/** 分组头的标题节点（它的 Tooltip 显示工作空间全路径） */
function groupTitleOf(host: HTMLElement): HTMLElement {
  const el = Array.from(host.querySelectorAll('.MuiListItemText-root')).find((n) =>
    (n.textContent ?? '').includes('默认工作空间'),
  );
  expect(el, '未找到「默认工作空间」分组头').toBeTruthy();
  return el as HTMLElement;
}

function scrollerOf(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('[data-testid="session-list-scroll"]');
  expect(el, '未找到任务列表滚动容器').toBeTruthy();
  return el!;
}

beforeEach(() => {
  vi.restoreAllMocks();
  unmount();
  useStorageInfoStore.setState({ info: null, loading: false, error: null });
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: false,
      autoSummarize: false,
      memoryRecall: true,
      memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
      defaultWorkspacePath: WORKDIR,
    },
    status: 'offline',
  });
  useSessionsStore.setState({
    sessions: [freshSession('recent')],
    activeId: null,
    streams: {},
  });
  useAgentsStore.setState({ agents: [], activeAgentId: null });
});

describe('侧边栏任务列表的悬停浮层', () => {
  it('悬停分组头会弹出浮层（先确认浮层真的会出现）', async () => {
    const host = renderSidebar();

    expect(visibleTooltips(), '悬停前不该有浮层').toHaveLength(0);

    hover(groupTitleOf(host));
    await settle(200); // enterDelay = 100ms

    const tips = visibleTooltips();
    expect(tips, '悬停后应弹出浮层').toHaveLength(1);
    // 分组头浮层的内容是工作空间全路径
    expect(tips[0].textContent).toContain(WORKDIR);
  });

  it('⚠️ 列表滚动时浮层立刻收起（不跟随、不残留在列表中间）', async () => {
    const host = renderSidebar();
    hover(groupTitleOf(host));
    await settle(200);
    expect(visibleTooltips()).toHaveLength(1);

    act(() => {
      scrollerOf(host).dispatchEvent(new Event('scroll'));
    });
    await settle(300); // 关闭过渡（Grow）

    expect(visibleTooltips(), '滚动后浮层必须消失').toHaveLength(0);
  });

  it('浮层收起后再滚一次不会复活（滚动不该把浮层重新打开）', async () => {
    const host = renderSidebar();
    hover(groupTitleOf(host));
    await settle(200);
    expect(visibleTooltips()).toHaveLength(1);

    const scroller = scrollerOf(host);
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    await settle(300);

    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    await settle(150);

    expect(visibleTooltips()).toHaveLength(0);
  });
});
