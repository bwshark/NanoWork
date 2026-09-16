/**
 * 计划清单卡片（PlanCard）的冒烟测试（FR-1.5）。
 *
 * 只锁两件事——它们之外的布局/样式不属于这里：
 * 1. **卡片真的渲染出可勾选清单**：计划是助手消息里唯一需要用户动手的东西，
 *    渲染不出来等于 Plan 模式不存在；
 * 2. **「按选中项执行」接通了 store**：点了要能看到模式切到 Craft 且多出一轮
 *    携带范围的用户消息。这条不断言任何视觉细节，只断言链表。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanCard } from '@/pages/chat/PlanCard';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { resetEventStream } from './helpers/eventStream';
import type { ChatHandle, StreamHandlers } from '@/ai/runtime/types';
import type { Message, MessagePlan, Session } from '@/types';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactElement) {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
}

function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * 把点击带来的异步链跑完。
 *
 * 「按选中项执行」内部还会再发一轮请求（`loadSession` → `send` → 流式），
 * 若干个事件循环才能落定；这里按轮次刷新而不是死等某个固定延时——
 * 后者会让用例在慢机器上随机变红。
 */
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** 按无障碍标签找按钮（按钮文案会随国际化/排版变化，语义标签更稳） */
function buttonByText(host: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(text),
    ) as HTMLButtonElement | undefined
  ) ?? null;
}

const PLAN: MessagePlan = {
  planId: 'plan-ui-1',
  steps: [
    { id: 's1', text: '先读一遍实现', status: 'pending' },
    { id: 's2', text: '再改渲染层', status: 'pending' },
  ],
  status: 'pending',
};

const MESSAGE_ID = 'msg-ui';
let SESSION_ID = '';

/**
 * 会话必须**由 store 自己创建**：`createSession` 会登记水合标记与记录器，
 * 之后 `send` 走同步快路径、内存里的消息不会被 `loadSession` 按事件流重放覆盖
 * ——手工 setState 一个「只有视图没有事件」的会话，第二轮就会被清成空列表。
 * 计划没有对应的 `handlePlan` 调用（那是流式回调的职责），这里只注入视图状态。
 */
function seedSession(): string {
  const session = useSessionsStore.getState().createSession('agent-ui', '计划会话', {
    mode: 'plan',
  });
  const assistant: Message = {
    id: MESSAGE_ID,
    role: 'assistant',
    content: '我先给出计划。',
    plan: PLAN,
    createdAt: new Date().toISOString(),
  };
  useSessionsStore.setState((s) => ({
    sessions: s.sessions.map((x) =>
      x.id === session.id
        ? {
            ...x,
            messages: [
              {
                id: 'msg-user',
                role: 'user' as const,
                content: '帮我计划一下',
                createdAt: new Date().toISOString(),
              },
              assistant,
            ],
          }
        : x,
    ),
  }));
  return session.id;
}

beforeEach(() => {
  resetEventStream();
  useAgentsStore.setState({
    agents: [
      {
        id: 'agent-ui',
        name: 'UI 测试智能体',
        systemPrompt: '',
        skillIds: [],
        imBinding: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    activeAgentId: 'agent-ui',
  });
  SESSION_ID = seedSession();
  // resolvePlan(execute) 会再发一轮：必须有网关桩，否则用例会打到真实网络
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (_req, handlers: StreamHandlers): ChatHandle => {
      handlers.onStatus('streaming');
      handlers.onToken('已执行');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe('PlanCard', () => {
  it('渲染出可勾选的计划清单与待裁决状态', () => {
    const el = mount(
      <PlanCard sessionId={SESSION_ID} messageId={MESSAGE_ID} planId="plan-ui-1" />,
    );

    const text = el.textContent ?? '';
    expect(text).toContain('执行计划');
    expect(text).toContain('先读一遍实现');
    expect(text).toContain('再改渲染层');
    expect(text).toContain('待裁决');
    // 两个步骤各一个复选框（type=checkbox 的 input）
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it('「按选中项执行」接通 store：切到 Craft 并发出带范围的下一轮', async () => {
    const el = mount(
      <PlanCard sessionId={SESSION_ID} messageId={MESSAGE_ID} planId="plan-ui-1" />,
    );

    await act(async () => {
      click(buttonByText(el, '按选中项执行'));
    });
    await flush();

    const session = useSessionsStore.getState().sessions.find((s) => s.id === SESSION_ID)!;
    expect(session.mode).toBe('craft');
    const followUp = session.messages.filter((m) => m.role === 'user');
    expect(followUp).toHaveLength(2);
    expect(followUp[1].content).toContain('先读一遍实现');
  });

  it('已裁决的计划不再显示执行按钮（避免重复批准）', () => {
    const settled: Message = {
      id: MESSAGE_ID,
      role: 'assistant',
      content: '计划已打回',
      plan: { ...PLAN, status: 'rejected', reason: '范围太大' },
      createdAt: new Date().toISOString(),
    };
    useSessionsStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === SESSION_ID ? { ...x, messages: [x.messages[0], settled] } : x,
      ),
    }));

    const el = mount(
      <PlanCard sessionId={SESSION_ID} messageId={MESSAGE_ID} planId="plan-ui-1" />,
    );

    expect(el.textContent).toContain('已打回');
    expect(el.textContent).toContain('范围太大');
    expect(buttonByText(el, '按选中项执行')).toBeNull();
  });
});
