/**
 * 侧边栏「默认工作空间」分组头的 hover 操作：更多操作 + 新建任务。
 *
 * ## 为什么这组用例必须存在
 *
 * 默认工作空间分组的 key 是**空字符串**（见 `groupSessionsByWorkdir`：落在默认路径上的
 * 会话与 `workdir` 为空的会话合并成 `key=""` 的同一个语义分组）。空字符串在所有
 * 「判空」写法里都是假值，于是这个分组天然踩两个坑，而且**都不报错**：
 *
 * 1. `hoveredGroup === g.key && g.key !== ""` 这类「默认分组例外」的条件，会让它的
 *    行尾操作图标永远不出现；
 * 2. 处理函数里 `if (!key) return` / `groupMenu.key ? find() : undefined` 会把
 *    `""` 当成「没传 key」，菜单里点了菜单项却什么都不发生。
 *
 * 所以这里既钉住「图标出现」，也钉住「点了真的生效」——第 2 类问题光看渲染结果
 * 是查不出来的。
 *
 * 唯一与其它分组不同的地方：默认分组**没有**「重命名」。它的名字由语义决定
 * （组内就是设置里那个默认路径下的任务），别名会让名字漂移，
 * 见 `tests/lib/workspace/workspaceLabel.test.ts`。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarNav } from '@/layout/SidebarNav';
import { platform } from '@/platform';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { byAria, click, flush, mount, unmount } from './helpers/reactMount';
import type { Session } from '@/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

const DEFAULT_DIR = 'C:\\Users\\tester\\NanoWork';
const OTHER_DIR = 'D:\\work\\ranch';

/** 一条「已经开工」的任务（列表只显示有对话记录的会话，条数走索引里的 messageCount） */
function session(id: string, workdir?: string): Session {
  return {
    id,
    agentId: '',
    title: id,
    messages: [],
    messageCount: 3,
    permissionLog: [],
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    ...(workdir ? { workdir } : {}),
  };
}

function renderSidebar(): HTMLElement {
  return mount(
    <MemoryRouter>
      <SidebarNav />
    </MemoryRouter>,
  );
}

/** 按标题文案找到工作空间分组行（分组头是 ListItemButton） */
function groupRow(host: HTMLElement, label: string): HTMLElement {
  const row = Array.from(host.querySelectorAll('.MuiListItemButton-root')).find(
    (n) => (n.textContent ?? '').includes(label),
  );
  expect(row, `未找到分组行「${label}」`).toBeTruthy();
  return row as HTMLElement;
}

/** 派发一次冒泡 mouseover —— React 由此派生出 onMouseEnter（onMouseEnter 无原生事件） */
function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

/** 按文案找已打开的菜单项（MUI Menu 挂在 Portal 上，不在挂载容器里） */
function menuItem(text: string): HTMLElement | null {
  return (
    (Array.from(document.querySelectorAll('[role="menuitem"]')).find((n) =>
      (n.textContent ?? '').includes(text),
    ) as HTMLElement | undefined) ?? null
  );
}

/** 展开默认分组的「更多操作」菜单 */
async function openGroupMenu(host: HTMLElement): Promise<void> {
  const row = groupRow(host, '默认工作空间');
  hover(row);
  click(byAria('更多操作', row));
  await flush();
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
      defaultWorkspacePath: DEFAULT_DIR,
    },
    status: 'offline',
  });
  useSessionsStore.setState({
    sessions: [session('legacy'), session('bound', DEFAULT_DIR), session('ranch', OTHER_DIR)],
    activeId: null,
    streams: {},
  });
  useAgentsStore.setState({ agents: [], activeAgentId: null });
});

describe('侧边栏默认工作空间分组的行尾操作', () => {
  it('悬停时和别的分组一样出现「更多操作」与「新建任务」', () => {
    const host = renderSidebar();
    const row = groupRow(host, '默认工作空间');

    expect(byAria('更多操作', row), '未悬停时不该渲染').toBeNull();

    hover(row);

    expect(byAria('更多操作', row)).toBeTruthy();
    expect(byAria('新建任务', row)).toBeTruthy();
  });

  it('「更多操作」里的「打开文件夹」打的是默认工作空间路径', async () => {
    const openPath = vi.spyOn(platform, 'openPath').mockResolvedValue({ ok: true });

    const host = renderSidebar();
    await openGroupMenu(host);

    // 有真实目录才渲染这一项：默认分组的 fullPath 就是设置里那个默认路径
    const item = menuItem('打开文件夹');
    expect(item, '默认分组缺「打开文件夹」').toBeTruthy();

    click(item);
    await flush();

    expect(openPath).toHaveBeenCalledWith(DEFAULT_DIR);
  });

  it('不提供「重命名」：分组的名字由它的语义决定，改了设置会漂移', async () => {
    const host = renderSidebar();
    await openGroupMenu(host);

    // 菜单确实打开了（同一分组仍有别的项），否则下面的断言会「因为啥都没有而通过」
    expect(menuItem('从列表中移除')).toBeTruthy();
    expect(menuItem('重命名')).toBeNull();
  });

  it('「新建任务」以默认工作空间为 workdir 开工', async () => {
    const host = renderSidebar();
    const row = groupRow(host, '默认工作空间');
    hover(row);

    click(byAria('新建任务', row));
    await flush();

    const created = useSessionsStore
      .getState()
      .sessions.find((s) => s.id !== 'legacy' && s.id !== 'bound' && s.id !== 'ranch');
    expect(created, '没有新建出任务').toBeTruthy();
    expect(created!.workdir).toBe(DEFAULT_DIR);
  });
});
