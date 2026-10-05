/**
 * 侧栏「助理」Tab 的渠道分组与筛选（FR-6.4）。
 *
 * 钉三件事，都是「错了不报错」的类型：
 *
 * 1. **分组键是渠道原始首段**。此前分组走 `ChannelKind`（只有 5 个成员），
 *    telegram / slack 这类引擎支持、但客户端没有图形的渠道会被**图标**的回退规则
 *    悄悄并进「钉钉」组——用户看到的是「钉钉」组里躺着一条 Telegram 会话，
 *    而代码里没有任何一行写着「把 telegram 当 dingtalk」。
 * 2. **筛选真的会减少可见分组**，不是只把 chip 点亮。
 * 3. **只有一个渠道时不出现筛选条**：没有可筛的东西，白占一行高度。
 *
 * 场景数据刻意让「微信」有两个会话、Telegram 只有一个：这样「筛选只影响可见性、
 * 不影响数据」也能顺带被钉住（全局 3 条不变，筛完只剩 1 条）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarNav } from '@/layout/SidebarNav';
import { useChannelSessionsStore } from '@/stores/channelSessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useStorageInfoStore } from '@/stores/storageInfoStore';
import { DEFAULT_MEMORY_POLICY } from '@/types';
import { buttonByText, click, mount, unmount } from './helpers/reactMount';
import type { NanobotChannelSessionSummary } from '@/platform/types';

const DEFAULT_DIR = 'C:\\Users\\tester\\NanoWork';

/** 用 key 当标题，方便断言「这条会话在不在屏幕上」 */
function summary(key: string, channel: string): NanobotChannelSessionSummary {
  return {
    key,
    channel,
    title: key,
    preview: 'hi',
    messageCount: 2,
    createdAt: '2026-10-05T09:00:00.000Z',
    updatedAt: '2026-10-05T09:00:00.000Z',
  };
}

function renderSidebar(): HTMLElement {
  return mount(
    <MemoryRouter>
      <SidebarNav />
    </MemoryRouter>,
  );
}

/** 切到「助理」Tab */
function openChannelsTab(host: HTMLElement): void {
  const tab = Array.from(host.querySelectorAll('[role="tab"]')).find((n) =>
    (n.textContent ?? '').includes('助理'),
  );
  click(tab);
}

/** 渠道筛选 chip（`data-testid` 由 ChannelFilterChip 透传） */
function chips(host: HTMLElement): HTMLElement[] {
  return Array.from(
    host.querySelectorAll('[data-testid="channel-filter-chip"]'),
  ) as HTMLElement[];
}

function chipByText(host: HTMLElement, text: string): HTMLElement | null {
  return (
    chips(host).find((c) => (c.textContent ?? '').trim() === text) ?? null
  );
}

/** chip 是否处于选中态（ChannelFilterChip 自报） */
function isSelected(chip: HTMLElement): boolean {
  return chip.getAttribute('data-selected') === 'true';
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
  useSessionsStore.setState({ sessions: [], activeId: null, streams: {} });
  useAgentsStore.setState({ agents: [], activeAgentId: null });
  useChannelSessionsStore.setState({ summaries: [], loading: false });
  useSessionUiStore.setState({ channelFilter: null });
});

describe('渠道筛选条', () => {
  it('多渠道时出现「全部」+ 每个渠道一个 chip', () => {
    useChannelSessionsStore.setState({
      summaries: [
        summary('weixin:u1', 'weixin'),
        summary('telegram:t1', 'telegram'),
        summary('weixin:u2', 'weixin'),
      ],
    });
    const host = renderSidebar();
    openChannelsTab(host);

    const labels = chips(host).map((c) => (c.textContent ?? '').trim());
    expect(labels).toEqual(['全部', '微信', 'Telegram']);
    expect(isSelected(chipByText(host, '全部')!)).toBe(true);
  });

  it('只有一个渠道时不出现筛选条', () => {
    useChannelSessionsStore.setState({
      summaries: [summary('weixin:u1', 'weixin'), summary('weixin:u2', 'weixin')],
    });
    const host = renderSidebar();
    openChannelsTab(host);
    expect(chips(host)).toHaveLength(0);
  });

  it('未知渠道自成一组，不会被并进钉钉', () => {
    useChannelSessionsStore.setState({
      summaries: [
        summary('dingtalk:d1', 'dingtalk'),
        summary('telegram:t1', 'telegram'),
      ],
    });
    const host = renderSidebar();
    openChannelsTab(host);
    // 两个渠道 → 两条会话各在自己组里，两个分组头都在
    expect(host.textContent).toContain('dingtalk:d1');
    expect(host.textContent).toContain('telegram:t1');
    const labels = chips(host).map((c) => (c.textContent ?? '').trim());
    expect(labels).toEqual(['全部', '钉钉', 'Telegram']);
  });
});

describe('筛选真的改变可见内容', () => {
  function setup(): HTMLElement {
    useChannelSessionsStore.setState({
      summaries: [
        summary('weixin:u1', 'weixin'),
        summary('telegram:t1', 'telegram'),
        summary('weixin:u2', 'weixin'),
      ],
    });
    const host = renderSidebar();
    openChannelsTab(host);
    return host;
  }

  it('点某个渠道只留该渠道的会话', () => {
    const host = setup();
    click(chipByText(host, 'Telegram'));

    expect(host.textContent).toContain('telegram:t1');
    expect(host.textContent).not.toContain('weixin:u1');
    expect(host.textContent).not.toContain('weixin:u2');
    expect(isSelected(chipByText(host, 'Telegram')!)).toBe(true);
    expect(isSelected(chipByText(host, '全部')!)).toBe(false);
  });

  it('点「全部」恢复所有渠道', () => {
    const host = setup();
    click(chipByText(host, 'Telegram'));
    click(chipByText(host, '全部'));

    expect(host.textContent).toContain('weixin:u1');
    expect(host.textContent).toContain('telegram:t1');
    expect(host.textContent).toContain('weixin:u2');
    expect(isSelected(chipByText(host, '全部')!)).toBe(true);
  });

  it('筛选只影响可见性，不改动数据本身', () => {
    const host = setup();
    click(chipByText(host, 'Telegram'));
    // summaris 是全局数据：筛完仍是 3 条
    expect(useChannelSessionsStore.getState().summaries).toHaveLength(3);
  });

  it('选中的渠道在后续刷新里消失时，给「查看全部」的退路而不是空白', () => {
    const host = setup();
    click(chipByText(host, 'Telegram'));
    // 模拟下一轮轮询：Telegram 那条没了（渠道断开 / 会话被清）
    // 必须在 act 内 setState，否则订阅者的重渲染不会在本用例内 flush
    act(() => {
      useChannelSessionsStore.setState({
        summaries: [summary('weixin:u1', 'weixin')],
      });
    });

    expect(host.textContent).toContain('该渠道下暂无会话');
    // 退路可点，且点了真的回到全部。
    // 注意此时筛选条已收起（只剩一个渠道），所以「查看全部」是空态里那个按钮，
    // 而不是筛选条上的 chip —— 这正是空态必须自带退路的原因。
    expect(chips(host)).toHaveLength(0);
    click(buttonByText(host, '查看全部'));
    expect(host.textContent).toContain('weixin:u1');
  });
});
