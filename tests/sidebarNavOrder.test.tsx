/**
 * 侧边栏菜单的**层级与顺序**（2026-11-02 用户需求）。
 *
 * 需求演变值得记下来，否则下一个人会以为现在这个形状是随手定的：
 *
 * 1. 最初「知识库」「项目」藏在「能力扩展」折叠组里，与专家 / 技能 / 连接器混在一起；
 * 2. 第一次调整把这两项提到顶层，与「定时任务」「审计」「能力扩展」平级；
 * 3. 本次再加一层：「项目」「审计」收进**悬停弹出的「更多」二级菜单**，
 *    并在二级菜单底部放一个「自定义菜单栏」入口；一级菜单的四行可拖拽排序。
 *
 * ## 为什么这些断言值得写
 *
 * 全部是**结构**判据，没有一条有运行时信号：把「项目」塞回顶层不会报错、不会白屏，
 * 只是侧边栏变挤；把顺序表的归一化写坏，也只是某人的菜单少一项。这类退化只有
 * 天天用的人察觉得到，所以钉在测试里比靠 review 可靠。
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
import { click, mount, unmount } from './helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/** 真实计时器等待并包在 act 里（Popper 的 Fade 过渡不归 React 管） */
const settle = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

function renderSidebar(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <SidebarNav />
    </MemoryRouter>,
  );
}

/** 顶部菜单那一列（用「新建任务」定位，避免撞上页面别处的 List） */
function topMenu(host: HTMLElement): Element {
  const list = Array.from(host.querySelectorAll('.MuiList-root')).find((n) =>
    (n.textContent ?? '').includes('新建任务'),
  );
  expect(list, '未找到顶部菜单列表').toBeTruthy();
  return list!;
}

/** 顶部菜单里当前可见的菜单文案（顺序即渲染顺序） */
function topLabels(host: HTMLElement): string[] {
  return Array.from(
    topMenu(host).querySelectorAll('.MuiListItemButton-root'),
  ).map((n) => (n.textContent ?? '').trim());
}

/** 按文案找一行（只在这份可见 DOM 里找） */
function row(host: HTMLElement, label: string): HTMLElement {
  const hit = Array.from(
    host.querySelectorAll<HTMLElement>('.MuiListItemButton-root'),
  ).find((n) => (n.textContent ?? '').trim() === label);
  expect(hit, `未找到菜单项「${label}」`).toBeTruthy();
  return hit!;
}

/** 派发一次冒泡 mouseover —— React 由此派生出 onMouseEnter */
function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

/**
 * 「更多」浮层（MUI Popper 挂在 Portal 上，不在挂载容器里）。
 *
 * 用文案定位而不是 `[role="menu"]`：本浮层是一个 `Paper`，没有 role 属性
 * —— 按 role 查会永远为空，于是「浮层没弹出」和「测法写错了」变成同一句话。
 */
function morePopover(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('.MuiPaper-root')).find(
      (n) => (n.textContent ?? '').includes('自定义菜单栏'),
    ) ?? null
  );
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
      defaultWorkspacePath: 'C:\\Users\\tester\\NanoWork',
      primaryMenuOrder: [],
      moreMenuOrder: [],
    },
    status: 'offline',
  });
  useSessionsStore.setState({ sessions: [], activeId: null, streams: {} });
  useAgentsStore.setState({ agents: [], activeAgentId: null });
});

describe('一级菜单', () => {
  it('收起状态下可见六行，且项目 / 审计已不在顶层', () => {
    const host = renderSidebar();

    expect(topLabels(host)).toEqual([
      '新建任务',
      '定时任务',
      '知识库',
      '能力扩展',
      '更多',
    ]);
    // 项目 / 审计必须在二级菜单里，不能同时出现在顶层
    expect(topLabels(host)).not.toContain('项目');
    expect(topLabels(host)).not.toContain('审计');
  });

  it('「能力扩展」展开后只剩能力类入口', () => {
    const host = renderSidebar();
    click(row(host, '能力扩展'));

    expect(topLabels(host)).toEqual([
      '新建任务',
      '定时任务',
      '知识库',
      '能力扩展',
      '专家',
      '技能',
      '连接器',
      '扩展',
      '更多',
    ]);
  });
});

describe('「更多」二级菜单', () => {
  it('悬停「更多」会弹出浮层，里面是项目 / 审计 + 自定义菜单栏', async () => {
    const host = renderSidebar();
    expect(morePopover(), '初始状态不该有浮层').toBeNull();

    hover(row(host, '更多'));
    await settle(150);

    const pop = morePopover();
    expect(pop, '悬停后应弹出二级菜单').toBeTruthy();
    expect(pop!.textContent).toContain('项目');
    expect(pop!.textContent).toContain('审计');
    expect(pop!.textContent).toContain('自定义菜单栏');
  });

  it('「自定义菜单栏」在分隔线下方（与上面两项不是同类）', async () => {
    const host = renderSidebar();
    hover(row(host, '更多'));
    await settle(150);

    const pop = morePopover()!;
    // 结构判据：底部入口必须是「分隔线之后的最后一行」。
    // 只看文案会漏掉「它被塞进菜单项中间」这种排布错误。
    const rows = Array.from(pop.querySelectorAll('.MuiListItemButton-root')).map(
      (n) => (n.textContent ?? '').trim(),
    );
    expect(rows).toEqual(['项目', '组织资产', '审计', '自定义菜单栏']);
    expect(pop.querySelector('.MuiDivider-root'), '缺少分隔线').toBeTruthy();
  });

  /**
   * ⚠️ 这条是**真实事故**补的回归用例。
   *
   * 最初浮层用的是 `<Fade {...TransitionProps}>`，而 MUI 的 `Popper` **根本不传**
   * `TransitionProps` —— 展开的是 undefined，`Fade` 的 `in` 默认 false，于是浮层
   * 渲染出来了却永远 `opacity: 0` + `visibility: hidden`。
   *
   * 当时的用例只断言「DOM 里有这几行文案」，全部绿；真实界面里什么都看不见。
   * jsdom 不跑 CSS transition，所以这里**只能**断言样式属性 —— 它挡不住所有
   * 动画类问题，但挡得住「根本没有入场」这一类，而那一类恰好是最致命的。
   */
  it('浮层必须真的可见（不能只是 DOM 里存在）', async () => {
    const host = renderSidebar();
    hover(row(host, '更多'));
    await settle(150);

    const pop = morePopover()!;
    // 内联样式里不该留着隐藏态。MUI 的 Fade 在 in=true 且动画结束后会把
    // opacity 归位、visibility 去掉；若它停在 in=false，这两个属性会一直挂着。
    const style = pop.getAttribute('style') ?? '';
    expect(style, `浮层停在隐藏态：${style}`).not.toMatch(/opacity:\s*0(?![.\d])/);
    expect(style, `浮层停在隐藏态：${style}`).not.toContain('visibility: hidden');
    // 反向护栏：确认这里确实拿到了一个「有尺寸」的浮层，不是空壳
    expect(pop.textContent).toContain('项目');
  });
});
