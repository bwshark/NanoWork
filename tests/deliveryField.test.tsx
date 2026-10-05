/**
 * 结果推送目标选择器（DeliveryField）的接线测试（FR-5.6）。
 *
 * 只锁「接线」这三件事——纯映射（会话 key → 投递目标、文案）已在
 * `tests/taskDelivery.test.ts` 里逐条钉过，这里不重复：
 * 1. 从渠道会话列表里挑一个，真的产出 `{channel, chatId}`（而不是只画了个菜单）；
 * 2. 删掉最后一个目标要**收敛成 `undefined`**（不留「配了 delivery 却没有 targets」的中间态）；
 * 3. 「推送时机」只在真有目标时才出现（没有目标时那个控件不会有任何效果）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryField } from '@/components/tasks/DeliveryField';
import { useChannelSessionsStore } from '@/stores/channelSessionsStore';
import { act } from 'react';
import { buttonByText, click, mount, unmount } from './helpers/reactMount';
import type { NanobotChannelSessionSummary } from '@/platform/types';
import type { TaskDelivery, TaskDeliveryTarget } from '@/types';

function summary(
  key: string,
  extra: Partial<NanobotChannelSessionSummary> = {},
): NanobotChannelSessionSummary {
  return {
    key,
    channel: key.split(':')[0] ?? key,
    title: '',
    preview: '',
    messageCount: 3,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...extra,
  };
}

const WECOM = summary('wecom:chat-1', { title: '研发群' });
const FEISHU = summary('feishu.feishu:ou_1', { preview: '帮我看看这个报错' });

/** 点击 Portal 里那个菜单项（MUI Menu 渲染到 body，不在挂载容器内） */
function clickMenuItem(text: string): void {
  const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
  const hit = items.find((el) => (el.textContent ?? '').includes(text));
  expect(hit, `菜单里应有「${text}」：${items.map((i) => i.textContent).join(' / ')}`).toBeTruthy();
  click(hit);
}

function render(value: TaskDelivery | undefined) {
  const onChange = vi.fn<(next: TaskDelivery | undefined) => void>();
  const host = mount(<DeliveryField value={value} onChange={onChange} />);
  return { host, onChange };
}

beforeEach(() => {
  useChannelSessionsStore.setState({ summaries: [WECOM, FEISHU], loading: false });
  /*
   * 组件挂载时会补拉一次频道会话（4s 轮询存在空窗）。在 jsdom 里那会打到 platform 层，
   * 而对 Web 端它是空实现 —— 拉完会把上面种进去的列表刷没。这里换成空操作。
   */
  vi.spyOn(useChannelSessionsStore.getState(), 'refresh').mockResolvedValue(undefined);
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
  useChannelSessionsStore.setState({ summaries: [], loading: false });
});

describe('DeliveryField：添加推送目标', () => {
  it('挑一个渠道会话 → 产出 (channel, chatId) 两个值（chatId 才是能不能推出去的关键）', async () => {
    const { host, onChange } = render(undefined);

    click(buttonByText(host, '添加推送目标'));
    await act(async () => {
      await Promise.resolve();
    });
    clickMenuItem('研发群');

    expect(onChange).toHaveBeenCalledWith({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'complete',
    });
  });

  it('owner 限定渠道名整串带下去（`feishu.feishu` 是引擎的实例身份，截断会推不出去）', async () => {
    const { host, onChange } = render(undefined);

    click(buttonByText(host, '添加推送目标'));
    await act(async () => {
      await Promise.resolve();
    });
    clickMenuItem('飞书');

    expect(onChange).toHaveBeenCalledWith({
      targets: [{ channel: 'feishu.feishu', chatId: 'ou_1' }],
      on: 'complete',
    });
  });

  it('已在列表里的会话不再出现在可选项里（重复添加只会让引擎发两遍）', async () => {
    const { host, onChange } = render({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'complete',
    });

    click(buttonByText(host, '添加推送目标'));
    await act(async () => {
      await Promise.resolve();
    });

    // 菜单里只该剩飞书——企业微信已经选过，不该再出现
    const menuText = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .map((el) => el.textContent ?? '')
      .join(' | ');
    expect(menuText).not.toContain('研发群');
    expect(menuText).toContain('飞书');

    clickMenuItem('飞书');
    expect(onChange).toHaveBeenCalledWith({
      targets: [
        { channel: 'wecom', chatId: 'chat-1' },
        { channel: 'feishu.feishu', chatId: 'ou_1' },
      ],
      on: 'complete',
    });
  });
});

describe('DeliveryField：已选目标的展示与移除', () => {
  it('每个目标一个 Chip，文案是「渠道 · 会话名」', () => {
    const { host } = render({
      targets: [
        { channel: 'wecom', chatId: 'chat-1' },
        { channel: 'feishu.feishu', chatId: 'ou_1' },
      ],
      on: 'complete',
    });

    const labels = Array.from(host.querySelectorAll('.MuiChip-label')).map(
      (el) => el.textContent ?? '',
    );
    expect(labels.join(' | ')).toContain('企业微信 · 研发群');
    expect(labels.join(' | ')).toContain('飞书 · 帮我看看这个报错');
  });

  it('⭐ 删掉最后一个目标 → 收敛成 undefined，而不是留一个空 targets 的壳', () => {
    const { host, onChange } = render({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'error',
    });

    click(host.querySelector('.MuiChip-deleteIcon'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('删掉其中一个 → 另一个原样保留（且时机不变）', () => {
    const { host, onChange } = render({
      targets: [
        { channel: 'wecom', chatId: 'chat-1' },
        { channel: 'feishu.feishu', chatId: 'ou_1' },
      ],
      on: 'error',
    });

    const firstChipDelete = host
      .querySelectorAll('.MuiChip-root')[0]
      ?.querySelector('.MuiChip-deleteIcon');
    click(firstChipDelete);

    expect(onChange).toHaveBeenCalledWith({
      targets: [{ channel: 'feishu.feishu', chatId: 'ou_1' }],
      on: 'error',
    });
  });
});

describe('DeliveryField：推送时机', () => {
  it('没有目标时不渲染时机开关（它此时不会有任何效果）', () => {
    const { host } = render(undefined);
    expect(host.textContent).not.toContain('仅失败时');
  });

  it('有目标时可选，切到「仅失败时」原样带上现有目标', () => {
    const { host, onChange } = render({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'complete',
    });

    click(buttonByText(host, '仅失败时'));
    expect(onChange).toHaveBeenCalledWith({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'error',
    });
  });

  it('点已选中的那一档不产生变更（MUI 给出 null，不该被当成「清空时机」）', () => {
    const { host, onChange } = render({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'complete',
    });

    click(buttonByText(host, '每次执行后'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('三档同时在，切到「开始时」原样带上现有目标', () => {
    const { host, onChange } = render({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'complete',
    });

    // 「开始时」必须与「每次执行后」并排可见：它是在结果之外**多推一条**，
    // 单看这三个字会读成「只推开始、不推结果」
    const text = host.textContent ?? '';
    expect(text).toContain('仅失败时');
    expect(text).toContain('每次执行后');
    expect(text).toContain('开始时');

    click(buttonByText(host, '开始时'));
    expect(onChange).toHaveBeenCalledWith({
      targets: [{ channel: 'wecom', chatId: 'chat-1' }],
      on: 'start',
    });
  });
});

describe('DeliveryField：没有可用会话时', () => {
  beforeEach(() => {
    useChannelSessionsStore.setState({ summaries: [], loading: false });
  });

  it('给出「去哪儿接入」的提示，而不是一个空菜单', () => {
    const { host } = render(undefined);
    expect(host.textContent).toContain('助理设置');
    expect((buttonByText(host, '添加推送目标') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DeliveryField：目标里已有的会话被清掉之后', () => {
  it('Chip 退到「渠道 · 会话 id」，不会渲染成半截文案', () => {
    // 会话文件被删 / 引擎换了 workspace 时会出现：目标还在，但列表里找不到它
    useChannelSessionsStore.setState({ summaries: [], loading: false });
    const stale: TaskDeliveryTarget = { channel: 'wecom', chatId: 'chat-gone' };
    const { host } = render({ targets: [stale], on: 'complete' });

    expect(host.querySelector('.MuiChip-label')?.textContent).toBe('企业微信 · chat-gone');
  });
});
