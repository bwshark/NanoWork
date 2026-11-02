/**
 * 「自定义菜单栏」面板：**拖拽排序**的行为判据。
 *
 * ## 这里能测什么、不能测什么
 *
 * jsdom **没有布局**（`getBoundingClientRect()` 恒为 0）。所以「拖到某个像素位置
 * 应该落在第几位」这种几何判定在测试里恒为 0 行距，`dropInsertIndex` 会返回 -1
 * 表示「这一帧不动」——硬测只会得到一条永远为假的断言。
 *
 * 于是本文件分两层：
 * 1. **几何**用纯函数直接测（`dropInsertIndex` / `moveMenuItem` / `normalizeMenuOrder`，
 *    见 `tests/lib/ui/sidebarMenu.test.ts`），那里可以任意造坐标；
 * 2. **行为**在这里测：面板能否打开、行序是否来自 store、松手是否落库、
 *    「恢复默认」是否真恢复。这几条不依赖布局，能稳定复现。
 *
 * 拖拽本身（`pointerdown` → `pointermove` → `pointerup`）在 jsdom 里能跑通事件流，
 * 但行距为 0 导致移动恒被忽略。所以「拖完顺序变了」这条**必须**在几何层用纯函数
 * 覆盖，再用这里的「store 顺序 → 面板行序」证明两端接得上。
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
import { click, dialogRoot, mount, unmount } from './helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';
import { MORE_MENU_IDS, PRIMARY_MENU_IDS } from '@/lib/ui/sidebarMenu';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const settle = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

function renderSidebar(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <SidebarNav />
    </MemoryRouter>,
  );
}

/** 侧边栏里按文案取一行 */
function row(host: HTMLElement, label: string): HTMLElement {
  const hit = Array.from(
    host.querySelectorAll<HTMLElement>('.MuiListItemButton-root'),
  ).find((n) => (n.textContent ?? '').trim() === label);
  expect(hit, `未找到菜单项「${label}」`).toBeTruthy();
  return hit!;
}

/** 「更多」浮层（Popper 挂在 body 上，用底部入口文案定位） */
function morePopover(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('.MuiPaper-root')).find(
      (n) => (n.textContent ?? '').includes('自定义菜单栏'),
    ) ?? null
  );
}

/**
 * 面板里某一段的行文案顺序。
 *
 * 用 `data-menu-section` 定位那一段，而不是找分组标题文案：分组标题「更多」与
 * 菜单项文案可能撞车，靠文案定位会取到错的那一段（实测就是这样把 `[]` 当成了
 * 「更多」组的行序）。
 */
function sectionLabels(sectionKey: 'primary' | 'more'): string[] {
  const dialog = dialogRoot();
  const section = dialog.querySelector(`[data-menu-section="${sectionKey}"]`);
  expect(section, `面板里没有分组「${sectionKey}」`).toBeTruthy();
  // 用行上的 `data-menu-row-label` 取，**不能**按文案取：一级菜单里有一行就叫
  // 「更多」，与二级菜单的分组标题同名 —— 按文案过滤会把那一行误删掉。
  return Array.from(
    section!.querySelectorAll<HTMLElement>('[data-menu-row-label]'),
  ).map((n) => (n.textContent ?? '').trim());
}

/**
 * 给面板里的行**伪造布局**。
 *
 * jsdom 不做布局（`getBoundingClientRect()` 恒为 0），而行距为 0 时
 * `dropInsertIndex` 会一律返回 -1（「这一帧不动」）—— 于是「拖完顺序变了」这条
 * 用例即使功能全坏也会绿。所以这里按行序给每行一个真实的矩形：
 * 高 44、间距 8，与组件里的常量一致。
 *
 * 这不是「为了让测试通过而造假」：几何算法本身在
 * `tests/lib/ui/sidebarMenu.test.ts` 里用任意坐标独立验证过，这里补的是
 * 「指针事件 → 会话快照 → 落库」这条接线。
 */
const ROW_HEIGHT = 44;
const ROW_GAP = 8;
const LIST_TOP = 100;

function stubLayout(sectionKey: 'primary' | 'more'): void {
  const section = dialogRoot().querySelector(`[data-menu-section="${sectionKey}"]`)!;
  const list = section.querySelector<HTMLElement>(
    ':scope > div:last-child',
  ) as HTMLElement;
  const pitch = ROW_HEIGHT + ROW_GAP;
  list.getBoundingClientRect = () => rect(LIST_TOP, list);

  const rows = Array.from(list.children) as HTMLElement[];
  rows.forEach((rowEl, index) => {
    const top = LIST_TOP + index * pitch;
    rowEl.getBoundingClientRect = () => rect(top, rowEl);
  });
}

/** 造一个只关心纵坐标的矩形（jsdom 的其余字段给 0 即可） */
function rect(top: number, el: HTMLElement): DOMRect {
  return {
    top,
    bottom: top + ROW_HEIGHT,
    left: 0,
    right: 0,
    width: 100,
    height: ROW_HEIGHT,
    x: 0,
    y: top,
    toJSON: () => ({ top }),
    // 用 `Object.assign` 造的对象也能被当 DOMRect 用，但类型上要补齐
  } as unknown as DOMRect;
}

/** 某一段里第 index 行的手柄按钮 */
function handleAt(sectionKey: 'primary' | 'more', index: number): HTMLElement {
  const section = dialogRoot().querySelector(`[data-menu-section="${sectionKey}"]`)!;
  const handles = Array.from(
    section.querySelectorAll<HTMLElement>('[data-drag-handle]'),
  );
  expect(handles[index], `第 ${index} 行没有拖拽手柄`).toBeTruthy();
  return handles[index];
}

/** 一次完整的拖拽：按下 → 移到 clientY → 松手 */
function dragTo(handle: HTMLElement, clientY: number): void {
  act(() => {
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: LIST_TOP + 10 }),
    );
  });
  act(() => {
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY }));
  });
  act(() => {
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
}

/** 打开面板（经由「更多」浮层底部的入口，与真实路径一致） */
async function openPanel(host: HTMLElement): Promise<void> {
  hover(row(host, '更多'));
  await settle(150);
  const pop = morePopover();
  expect(pop, '悬停「更多」后应弹出二级菜单').toBeTruthy();
  const entry = Array.from(
    pop!.querySelectorAll<HTMLElement>('.MuiListItemButton-root'),
  ).find((n) => (n.textContent ?? '').trim() === '自定义菜单栏');
  expect(entry, '二级菜单底部缺少「自定义菜单栏」入口').toBeTruthy();
  click(entry);
  await settle(50);
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
    syncMeta: { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null },
  });
  useSessionsStore.setState({ sessions: [], activeId: null, streams: {} });
  useAgentsStore.setState({ agents: [], activeAgentId: null });
});

describe('「自定义菜单栏」面板', () => {
  it('点二级菜单底部入口会打开面板，两段分组都在', async () => {
    const host = renderSidebar();
    await openPanel(host);

    expect(dialogRoot().textContent).toContain('自定义菜单栏');
    expect(sectionLabels('primary')).toEqual([
      '定时任务',
      '知识库',
      '能力扩展',
      '更多',
    ]);
    expect(sectionLabels('more')).toEqual(['项目', '审计']);
  });

  it('面板行序跟着 store 走（自定义顺序会被真正渲染出来）', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, primaryMenuOrder: ['more', 'capabilities', 'tasks', 'knowledge'] },
    }));
    const host = renderSidebar();
    await openPanel(host);

    expect(sectionLabels('primary')).toEqual(['更多', '能力扩展', '定时任务', '知识库']);
  });

  it('「恢复默认」把两段顺序都清回默认', async () => {
    useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        primaryMenuOrder: ['more', 'tasks', 'knowledge', 'capabilities'],
        moreMenuOrder: ['audit', 'projects'],
      },
    }));
    const host = renderSidebar();
    await openPanel(host);
    expect(sectionLabels('primary')).toEqual(['更多', '定时任务', '知识库', '能力扩展']);
    expect(sectionLabels('more')).toEqual(['审计', '项目']);

    click(
      Array.from(dialogRoot().querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').trim() === '恢复默认',
      ),
    );
    await settle(30);

    // 面板当场更新
    expect(sectionLabels('primary')).toEqual(['定时任务', '知识库', '能力扩展', '更多']);
    expect(sectionLabels('more')).toEqual(['项目', '审计']);
    // store 也真的写了（不是只改了本地副本）
    const s = useSettingsStore.getState().settings;
    expect(s.primaryMenuOrder).toEqual([...PRIMARY_MENU_IDS]);
    expect(s.moreMenuOrder).toEqual([...MORE_MENU_IDS]);
  });

  it('关闭面板不写 store（没松手就没有修改）', async () => {
    const before = useSettingsStore.getState().syncMeta.rev;
    const host = renderSidebar();
    await openPanel(host);

    click(
      Array.from(dialogRoot().querySelectorAll('button')).find(
        (b) => (b.getAttribute('aria-label') ?? '') === '关闭自定义菜单栏',
      ),
    );
    await settle(30);

    // 打开 / 关闭面板本身不是「改设置」：rev 不该涨
    expect(useSettingsStore.getState().syncMeta.rev).toBe(before);
  });
});

describe('拖拽排序（端到端）', () => {
  it('把「定时任务」往下拖两格：面板当场重排，松手后落库', async () => {
    const host = renderSidebar();
    await openPanel(host);
    stubLayout('primary');

    expect(sectionLabels('primary')).toEqual(['定时任务', '知识库', '能力扩展', '更多']);

    // 第 0 行拖到第 2 行的位置（列表顶 100 + 行距 52 * 2 = 204，落在第 2 行中段）
    dragTo(handleAt('primary', 0), LIST_TOP + (ROW_HEIGHT + ROW_GAP) * 2 + 20);
    await settle(30);

    expect(sectionLabels('primary')).toEqual(['知识库', '能力扩展', '定时任务', '更多']);
    expect(useSettingsStore.getState().settings.primaryMenuOrder).toEqual([
      'knowledge',
      'capabilities',
      'tasks',
      'more',
    ]);
  });

  it('拖拽只写一次 store（不是每帧都写）', async () => {
    const host = renderSidebar();
    await openPanel(host);
    stubLayout('primary');
    const before = useSettingsStore.getState().syncMeta.rev;

    // 一次拖拽里连发多次 move：只有松手那一下该落库
    const handle = handleAt('primary', 0);
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: LIST_TOP + 10 }),
      );
    });
    for (const y of [120, 150, 180, 210, 240]) {
      act(() => {
        handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: y }));
      });
    }
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await settle(30);

    // 拖拽过程中会重排很多次，但同步 rev 只该涨 1
    expect(useSettingsStore.getState().syncMeta.rev).toBe(before + 1);
  });

  it('按下手柄但没移动：不写 store（不能把「按一下」当成一次修改）', async () => {
    const host = renderSidebar();
    await openPanel(host);
    stubLayout('primary');
    const before = useSettingsStore.getState().syncMeta.rev;

    const handle = handleAt('primary', 1);
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: LIST_TOP + 10 }),
      );
    });
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await settle(30);

    expect(useSettingsStore.getState().syncMeta.rev).toBe(before);
  });

  it('「更多」二级菜单也能拖：顺序独立于一级菜单', async () => {
    const host = renderSidebar();
    await openPanel(host);
    stubLayout('more');

    expect(sectionLabels('more')).toEqual(['项目', '审计']);
    // 只有两行，把第 0 行拖到第 1 行
    dragTo(handleAt('more', 0), LIST_TOP + (ROW_HEIGHT + ROW_GAP) + 20);
    await settle(30);

    expect(sectionLabels('more')).toEqual(['审计', '项目']);
    expect(useSettingsStore.getState().settings.moreMenuOrder).toEqual([
      'audit',
      'projects',
    ]);
    // 一级菜单不该被连带改动
    expect(useSettingsStore.getState().settings.primaryMenuOrder).toEqual([]);
  });
});
