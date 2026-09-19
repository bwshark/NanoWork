/**
 * 输入框工具条的工作空间入口：**只在还没开工的任务上出现**。
 *
 * 口径（对齐 WorkBuddy）：会话一旦有了对话记录，输入框里就没有工作空间选择——
 * 工作空间是「这条任务在哪儿干活、记录落在哪儿」的建时决定，有记录后再改只可能
 * 半生效（已落盘的记录不会跟着换目录），留一个改了不生效的入口比没有入口更糟。
 *
 * 判据必须是「持久化能回答」的（`hasConversation`）。若退回 `messages.length`，
 * 重启后打开一条有 14 条记录、但还没水合完的任务时，这个按钮会闪现一下再消失。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ComposerControls } from '@/components/ComposerControls';
import { useSessionsStore } from '@/stores/sessionsStore';
import { __setRuntimeForTest } from '@/ai/runtime';
import { buttonByText, mount, unmount } from './helpers/reactMount';
import type { AgentRuntime } from '@/ai/runtime/types';
import type { Message, Session } from '@/types';

const RANCH = 'D:\\work\\ranch';

function session(over: Partial<Session>): Session {
  return {
    id: 's1',
    agentId: '',
    title: '任务',
    messages: [],
    permissionLog: [],
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    ...over,
  };
}

const userMessage = { id: 'm1', role: 'user', content: '你好' } as Message;

/** 把当前活跃会话设为给定会话并挂载工具条，返回容器 */
function renderWith(s: Session | null): HTMLElement {
  useSessionsStore.setState({ sessions: s ? [s] : [], activeId: s?.id ?? null });
  return mount(<ComposerControls />);
}

beforeEach(() => {
  unmount();
  // 执行模式能力打开：用来确认「只去掉了工作空间入口，其余控件照旧」
  __setRuntimeForTest({
    capabilities: { executionModes: true },
  } as unknown as AgentRuntime);
  useSessionsStore.setState({ sessions: [], activeId: null });
});

describe('ComposerControls 的工作空间入口', () => {
  it('新任务（没有对话记录）显示工作空间，用来选这条任务在哪儿干活', () => {
    const host = renderWith(session({ workdir: RANCH, messageCount: 0 }));

    expect(buttonByText(host, 'ranch')).toBeTruthy();
    // 其余控件不受影响
    expect(buttonByText(host, '默认权限')).toBeTruthy();
    expect(buttonByText(host, 'Craft')).toBeTruthy();
  });

  it('已有对话记录（未水合，条数来自索引）时不显示工作空间', () => {
    // 关键场景：重启后打开这条任务，消息还是留白的
    const host = renderWith(session({ workdir: RANCH, messages: [], messageCount: 6 }));

    expect(buttonByText(host, 'ranch')).toBeNull();
    expect(buttonByText(host, '默认权限')).toBeTruthy();
    expect(buttonByText(host, 'Craft')).toBeTruthy();
  });

  it('已有对话记录（已水合）时不显示工作空间', () => {
    const host = renderWith(
      session({ workdir: RANCH, messages: [userMessage], messageCount: undefined }),
    );

    expect(buttonByText(host, 'ranch')).toBeNull();
  });

  it('未绑定工作空间的新任务显示「默认工作空间」入口', () => {
    const host = renderWith(session({ messages: [] }));

    expect(buttonByText(host, '默认工作空间')).toBeTruthy();
  });
});
