import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProcessView } from '@/pages/chat/ProcessView';
import { ReasoningBlock } from '@/pages/chat/ReasoningBlock';
import { AssistantMessage } from '@/pages/chat/AssistantMessage';
import { useSessionsStore } from '@/stores/sessionsStore';
import type { Message, ProcessEvent, ProcessToolRow, ReasoningEvent, Session } from '@/types';

/**
 * 对话消息「过程时间线」行为回归测试。
 *
 * 形态对齐参考实现：深度思考是时间线里的**标记行**，与工具执行行按到达顺序交错；
 * 思考正文只在**仍在写入**时占据 DOM，写完即整段卸载、只留标记行。
 * 消息层面的可见性跟着「对话是否还在进行」：
 * - 流式中自动铺开；
 * - 结束后整块收进 `Collapse unmountOnExit`，只留一行「已完成 1m41s ›」，
 *   点它才重新挂载过程。
 *
 * 这几条断言锁住的就是这两个生命周期与顺序：
 * - 交错顺序正确（不是「思考聚一块、工具聚一块」）；
 * - 只有末尾未闭合的思考算「仍在写」；
 * - 已完成的思考正文不在 DOM 里；
 * - 结束后过程不在 DOM 里、开关行在。
 *
 * 用 createRoot 而非 renderToStaticMarkup 是必须的——限高与滚动写在 emotion 样式里，
 * 服务端渲染拿不到。
 */

function tool(id: string, status: 'running' | 'done' | 'error' = 'done'): ProcessToolRow {
  return {
    id,
    kind: 'tool',
    tool: 'read_file',
    args: { path: `D:\\proj\\src\\file-${id}.ts` },
    status,
  };
}

function reasoning(id: string, content: string, closed = true): ReasoningEvent {
  return { id, kind: 'reasoning', content, closed };
}

const MD = '# 思考\n\n- 第一点\n- 第二点';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactElement) {
  // 同一用例里多次 mount 时先卸掉上一个，避免残留的 root 影响断言
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  const css = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  return { html: host.innerHTML, css };
}

/** 把该会话置为「流式中」，并让消息成为会话最后一条（isStreaming 的两个必要条件） */
function startStreaming(sessionId: string, message: Message) {
  const now = new Date().toISOString();
  const session: Session = {
    id: sessionId,
    agentId: 'nope',
    title: '会话',
    messages: [message],
    permissionLog: [],
    createdAt: now,
    updatedAt: now,
  };
  useSessionsStore.setState({
    sessions: [session],
    activeId: sessionId,
    streams: { [sessionId]: { status: 'streaming', active: true } },
  });
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: [], activeId: null, streams: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('ReasoningBlock', () => {
  it('写入中：正文可见、限高内部滚动、带进度转圈', () => {
    const { html, css } = mount(<ReasoningBlock content={MD} live />);
    expect(html).toContain('深度思考');
    expect(html).toContain('第一点');
    expect(css).toMatch(/max-height:\s*200px/);
    expect(css).toMatch(/overflow-y:\s*auto/);
    expect(html).toContain('MuiCircularProgress');
  });

  it('写入结束：正文整段从 DOM 卸载，只留「深度思考」标记行', () => {
    const { html } = mount(<ReasoningBlock content={MD} />);
    expect(html).toContain('深度思考');
    expect(html).not.toContain('第一点');
  });

  it('卸载后的标记行仍可点开回看（历史思考按需渲染 Markdown）', () => {
    mount(<ReasoningBlock content={MD} />);
    const header = host!.querySelector('[role="button"]')!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 展开是 false → true，同一次提交就挂载正文；收起走过渡则要等动画，
    // 所以反向不在这里断言（jsdom 不跑 CSS 过渡，只会假失败）。
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(host!.innerHTML).toContain('第一点');
  });
});

describe('ProcessView', () => {
  it('按到达顺序交错渲染思考标记与工具行', () => {
    const events: ProcessEvent[] = [
      reasoning('r1', '早先的思考'),
      tool('t1'),
      reasoning('r2', '后来的思考'),
      tool('t2'),
    ];
    const { html } = mount(<ProcessView events={events} live={false} />);
    const iThink1 = html.indexOf('深度思考');
    const iTool1 = html.indexOf('file-t1.ts');
    const iThink2 = html.indexOf('深度思考', iTool1);
    const iTool2 = html.indexOf('file-t2.ts');
    expect(iThink1).toBeGreaterThan(-1);
    expect(iThink1).toBeLessThan(iTool1);
    expect(iTool1).toBeLessThan(iThink2);
    expect(iThink2).toBeLessThan(iTool2);
  });

  it('只有末尾未闭合的思考展开正文；消息不再流式时它也一并卸载', () => {
    const events: ProcessEvent[] = [
      reasoning('r1', '已经写完的思考'),
      tool('t1'),
      reasoning('r2', '正在写的思考', false),
    ];

    const streaming = mount(<ProcessView events={events} live />);
    expect(streaming.html).toContain('正在写的思考');
    expect(streaming.html).not.toContain('已经写完的思考');

    const settled = mount(<ProcessView events={events} live={false} />);
    expect(settled.html).not.toContain('正在写的思考');
    // 卸载的只是正文，标记行还在：过程流里仍能看出「这里想过一轮」
    expect(settled.html).toContain('深度思考');
  });

  it('无事件且无 children 时整体不渲染', () => {
    const { html } = mount(<ProcessView events={[]} live={false} />);
    expect(html).toBe('');
  });

  it('children 为空数组时也不渲染（回归：空数组是真值，不能用 !children 判定）', () => {
    const { html } = mount(
      <ProcessView events={[]} live={false}>
        {[].map(() => null)}
      </ProcessView>,
    );
    expect(html).toBe('');
  });
});

describe('AssistantMessage', () => {
  const base: Message = {
    id: 'm1',
    role: 'assistant',
    content: '这是回答',
    createdAt: new Date().toISOString(),
    durationMs: 101_000,
    process: [reasoning('r1', '第一点'), tool('t1'), tool('t2', 'running')],
  };

  it('结束后：过程整块不在 DOM，只剩一行「已完成 1m41s ›」与回答', () => {
    const { html } = mount(<AssistantMessage message={base} agentId="nope" sessionId="s1" />);
    expect(html).toContain('助手');
    expect(html).toContain('已完成 1m41s');
    // 红色的那条过程流水（思考标记 + 工具行）整体消失
    expect(html).not.toContain('深度思考');
    expect(html).not.toContain('已读取');
    expect(html).not.toContain('file-t1.ts');
    expect(html).not.toContain('第一点');
    expect(html).toContain('这是回答');
  });

  it('点「已完成」才展开过程（思考标记 + 工具行回来，思考正文仍不占 DOM）', () => {
    mount(<AssistantMessage message={base} agentId="nope" sessionId="s1" />);
    const toggle = host!.querySelector('[aria-label="展开执行过程"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host!.innerHTML).toContain('深度思考');
    expect(host!.innerHTML).toContain('file-t1.ts');
    // 展开的是「标记行」，已写完的思考正文仍不挂回（按需再点标记行才渲染）
    expect(host!.innerHTML).not.toContain('第一点');
  });

  it('流式中自动铺开过程，文案为「已处理」', () => {
    startStreaming('s1', base);
    const { html } = mount(<AssistantMessage message={base} agentId="nope" sessionId="s1" />);
    expect(html).toContain('已处理');
    expect(html).toContain('file-t1.ts');
  });

  it('有失败步时在开关行常驻提示（过程收起后失败行看不见了）', () => {
    const { html } = mount(
      <AssistantMessage
        message={{ ...base, process: [tool('t1', 'error')] }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('1 步失败');
    expect(html).toContain('已完成');
  });

  it('无过程时不渲染开关行', () => {
    const { html } = mount(
      <AssistantMessage
        message={{ ...base, process: undefined }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).not.toContain('已完成');
    expect(html).not.toContain('深度思考');
    expect(html).toContain('这是回答');
  });

  it('历史消息缺 durationMs 时开关行不显示耗时', () => {
    const { html } = mount(
      <AssistantMessage
        message={{ ...base, durationMs: undefined }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('已完成');
    expect(html).not.toContain('1m41s');
  });
});
