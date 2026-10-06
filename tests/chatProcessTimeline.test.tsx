import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProcessView } from '@/pages/chat/ProcessView';
import { ReasoningBlock } from '@/pages/chat/ReasoningBlock';
import { AssistantMessage } from '@/pages/chat/AssistantMessage';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  MemberEvent,
  Message,
  ProcessEvent,
  ProcessToolRow,
  ReasoningEvent,
  Session,
} from '@/types';

/**
 * 对话消息「过程时间线」行为回归测试。
 *
 * 形态对齐参考实现：深度思考是时间线里的**标记行**，与工具执行行按到达顺序交错；
 * 思考正文只在**仍在写入**时占据 DOM，写完即整段卸载、只留标记行。
 * 消息层面的可见性跟着「对话是否还在进行」：
 * - 流式中自动铺开；
 * - 结束后默认整块收进 `Collapse unmountOnExit`，只留一行「已完成 1m41s ›」，
 *   点它才重新挂载过程。
 *
 * 同时覆盖「展示档位」的三档差异（默认 `key`）：
 * - `key`（关键细节）：非关键的 done 工具行（read_file 等）聚合为一行汇总；
 * - `full`（完整过程）：结束时仍保持展开、全部逐行铺开；
 * - `result`（聚焦结果）：常规动作不渲染，开关行退化为静态文案（无 chevron）。
 *
 * 这几条断言锁住的就是这些生命周期、顺序与档位契约：
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

/** 构造成员相位事件（FR-2.4 第 3 步） */
function memberEv(
  id: string,
  memberId: string,
  phase: MemberEvent['phase'],
  extra: { name?: string; text?: string; error?: string } = {},
): ProcessEvent {
  return {
    id,
    kind: 'member',
    memberId,
    memberName: extra.name ?? memberId,
    phase,
    ...(extra.text !== undefined ? { text: extra.text } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
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
  // 显式把档位置为默认档 `key`：不让用例依赖持久化残留
  useSettingsStore.getState().setSettings({ processDetail: 'key' });
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
  // 这四处用 `tier="full"` 保留「t1/t2 为 read_file 的交错逐行」原始断言：
  // key 档会把这些 read_file 聚合成一行，file-t1.ts 便不再出现。
  it('按到达顺序交错渲染思考标记与工具行', () => {
    const events: ProcessEvent[] = [
      reasoning('r1', '早先的思考'),
      tool('t1'),
      reasoning('r2', '后来的思考'),
      tool('t2'),
    ];
    const { html } = mount(<ProcessView events={events} live={false} tier="full" />);
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

    const streaming = mount(<ProcessView events={events} live tier="full" />);
    expect(streaming.html).toContain('正在写的思考');
    expect(streaming.html).not.toContain('已经写完的思考');

    const settled = mount(<ProcessView events={events} live={false} tier="full" />);
    expect(settled.html).not.toContain('正在写的思考');
    // 卸载的只是正文，标记行还在：过程流里仍能看出「这里想过一轮」
    expect(settled.html).toContain('深度思考');
  });

  it('无事件且无 children 时整体不渲染', () => {
    const { html } = mount(<ProcessView events={[]} live={false} tier="full" />);
    expect(html).toBe('');
  });

  it('children 为空数组时也不渲染（回归：空数组是真值，不能用 !children 判定）', () => {
    const { html } = mount(
      <ProcessView events={[]} live={false} tier="full">
        {[].map(() => null)}
      </ProcessView>,
    );
    expect(html).toBe('');
  });

  it('key 档：连续非关键工具行聚合为一行汇总，点开才逐行铺出', () => {
    const events: ProcessEvent[] = [tool('t1'), tool('t2'), tool('t3')];
    const { html } = mount(<ProcessView events={events} live={false} tier="key" />);
    // 聚合为一行摘要，原始单行默认不出现
    expect(html).toContain('已读取 3 个文件');
    expect(html).not.toContain('file-t1.ts');

    const summary = host!.querySelector('[role="button"]')!;
    act(() => {
      summary.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 展开后逐行铺出原始行（保持到达顺序）
    expect(host!.innerHTML).toContain('file-t1.ts');
    expect(host!.innerHTML).toContain('file-t3.ts');
  });

  /**
   * `running` 行的落点由「回合是否还在进行」决定，而不是由数据里的 status 决定。
   *
   * 引擎只发 start / end 两个相位，结果事件可能在链路中断时永远不到——此时事件流
   * 里那条行就一直是 `running`（不是漏更新，是真没有结果）。回合一旦结束，
   * 它不会再执行了，所以不能再转圈：2026-10-01 用户截图里那行就是这么永远转下去的。
   *
   * 说「结果未返回」而不是「失败」：工具可能已经成功执行，只是结果没送到——
   * 说成失败同样是骗人。
   */
  it('running 行：流式中转圈；回合结束后改说「结果未返回」，不再永远转下去', () => {
    const events: ProcessEvent[] = [tool('t1', 'running')];

    const streaming = mount(<ProcessView events={events} live tier="full" />);
    expect(streaming.html).toContain('MuiCircularProgress');
    expect(streaming.html).not.toContain('结果未返回');

    const settled = mount(<ProcessView events={events} live={false} tier="full" />);
    expect(settled.html).not.toContain('MuiCircularProgress');
    expect(settled.html).toContain('结果未返回');
  });

  /**
   * 专家团成员行（FR-2.4 第 3 步）。
   *
   * 这一层的验收标准是「**能标出成员 A / 成员 B，且事件不串**」，所以断言落在
   * 成员名与各成员的产出上；另加两条诚实性规则，它们都是「不说反话」的具体化：
   * - 回合结束但成员停在中途 → 「结果未返回」，不转圈（同 `running` 工具行）；
   * - 回合结束且最后动作是**汇总** → 「已结束」：汇总的产出就是下面那条最终回答，
   *   写「结果未返回」会与用户正读到的正文自相矛盾。
   */
  it('成员组：名字 + 状态可见，产出默认折叠、点开才铺出', () => {
    const events: ProcessEvent[] = [
      memberEv('e1', 'm1', 'started', { name: '架构师' }),
      memberEv('e2', 'm1', 'finished', { name: '架构师', text: '## 结论\n\n先做 A 再做 B' }),
    ];
    const { html } = mount(<ProcessView events={events} live={false} tier="key" />);

    expect(html).toContain('架构师');
    expect(html).toContain('完成');
    // 同一成员的两个相位合成一行：只有一处成员名
    expect(html.split('架构师').length - 1).toBe(1);
    // 产出默认折叠
    expect(html).not.toContain('先做 A 再做 B');

    const header = host!.querySelector('[aria-label="展开成员产出"]')!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(host!.innerHTML).toContain('先做 A 再做 B');
  });

  it('成员组：流式中显示动作并转圈；回合结束后停在中途的成员说「结果未返回」', () => {
    const events: ProcessEvent[] = [memberEv('e1', 'm1', 'started', { name: '审校' })];

    const streaming = mount(<ProcessView events={events} live tier="full" />);
    expect(streaming.html).toContain('执行中');
    expect(streaming.html).toContain('MuiCircularProgress');
    expect(streaming.html).not.toContain('结果未返回');

    const settled = mount(<ProcessView events={events} live={false} tier="full" />);
    expect(settled.html).not.toContain('MuiCircularProgress');
    expect(settled.html).toContain('结果未返回');
    // 说「结果未返回」而不是「失败」：成员可能已经跑完，只是相位没送到
    expect(settled.html).not.toContain('失败');
  });

  it('团长汇总中：流式中说「汇总中」，回合结束后说「已结束」（不与最终回答自相矛盾）', () => {
    const events: ProcessEvent[] = [
      memberEv('e1', 'lead', 'planned', { name: '团长', text: '先分头看，再收口' }),
      memberEv('e2', 'lead', 'aggregating', { name: '团长' }),
    ];

    const streaming = mount(<ProcessView events={events} live tier="full" />);
    expect(streaming.html).toContain('汇总中');
    // full 档默认展开：计划正文直接可见（key 档则要一次点击，下面另有用例锁）
    expect(streaming.html).toContain('收起团队计划');
    expect(streaming.html).toContain('先分头看，再收口');

    const settled = mount(<ProcessView events={events} live={false} tier="full" />);
    expect(settled.html).toContain('已结束');
    expect(settled.html).not.toContain('结果未返回');
  });

  it('成员失败：状态说「失败」，原因是常驻文案（不折进一次点击里）', () => {
    const events: ProcessEvent[] = [
      memberEv('e1', 'm1', 'started', { name: '审校' }),
      memberEv('e2', 'm1', 'failed', { name: '审校', error: 'provider 429' }),
    ];
    const { html } = mount(<ProcessView events={events} live={false} tier="key" />);

    expect(html).toContain('失败');
    expect(html).toContain('provider 429');
    // 失败且无产出 → 没有可展开的内容，头部不该是可点的
    expect(host!.querySelector('[role="button"]')).toBeNull();
  });

  it('result 档：正常成员不渲染，失败成员照旧可见（异常永不隐身）', () => {
    const events: ProcessEvent[] = [
      memberEv('e1', 'ok', 'finished', { name: '正常成员', text: '产出' }),
      memberEv('e2', 'bad', 'failed', { name: '翻车成员', error: 'boom' }),
    ];
    const { html } = mount(<ProcessView events={events} live={false} tier="result" />);

    expect(html).not.toContain('正常成员');
    expect(html).toContain('翻车成员');
    expect(html).toContain('boom');
  });

  it('parallel 交错的成员事件：界面上每个成员只出现一次（事件不串）', () => {
    const events: ProcessEvent[] = [
      memberEv('e1', 'a', 'started', { name: '成员A' }),
      memberEv('e2', 'b', 'started', { name: '成员B' }),
      memberEv('e3', 'a', 'finished', { name: '成员A', text: 'A 的结论' }),
      memberEv('e4', 'b', 'finished', { name: '成员B', text: 'B 的结论' }),
    ];
    const { html } = mount(<ProcessView events={events} live={false} tier="full" />);

    expect(html.split('成员A').length - 1).toBe(1);
    expect(html.split('成员B').length - 1).toBe(1);
    // 各自的产出归到各自名下：A 在前、B 在后（首次出现顺序）
    expect(html.indexOf('成员A')).toBeLessThan(html.indexOf('成员B'));
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

  it('结束后（默认 key 档）：过程整块不在 DOM，只剩一行「已完成 1m41s ›」与回答', () => {
    const { html } = mount(<AssistantMessage message={base} agentId="nope" sessionId="s1" />);
    expect(html).toContain('助手');
    expect(html).toContain('已完成 1m41s');
    // 过程流水（思考标记 + 工具行）整体消失
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
    // key 档：done 的 read_file（t1）被聚合成一行汇总，不再逐行列出 file-t1.ts
    expect(host!.innerHTML).toContain('已读取 1 个文件');
    expect(host!.innerHTML).not.toContain('file-t1.ts');
    // running 行（t2）是档位豁免项，仍逐行可见
    expect(host!.innerHTML).toContain('file-t2.ts');
    // 展开的是「标记行」，已写完的思考正文仍不挂回（按需再点标记行才渲染）
    expect(host!.innerHTML).not.toContain('第一点');
  });

  it('流式中自动铺开过程，文案为「已处理」', () => {
    startStreaming('s1', base);
    const { html } = mount(<AssistantMessage message={base} agentId="nope" sessionId="s1" />);
    expect(html).toContain('已处理');
    // key 档：t1（done, read_file）被聚合为汇总行
    expect(html).toContain('已读取 1 个文件');
    // t2（running）豁免，仍逐行可见
    expect(html).toContain('file-t2.ts');
  });

  it('有失败步时在开关行常驻提示，且失败行本身恒可见（异常永不隐身）', () => {
    const { html } = mount(
      <AssistantMessage
        message={{ ...base, process: [tool('t1', 'error')] }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('1 步失败');
    expect(html).toContain('已完成');
    // errors>0 → 默认保持展开；error 行是档位豁免项，逐行渲染
    expect(html).toContain('file-t1.ts');
  });

  it('完整过程档：流结束后仍保持展开、全部逐行铺开（AC4）', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'full' });
    const { html } = mount(<AssistantMessage message={base} agentId="nope" sessionId="s1" />);
    expect(html).toContain('已完成');
    expect(html).toContain('深度思考');
    expect(html).toContain('file-t1.ts');
    expect(html).toContain('file-t2.ts');
  });

  it('聚焦结果档：常规动作不渲染，开关行退化为一行静态文案（AC1）', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'result' });
    const { html } = mount(
      <AssistantMessage
        message={{ ...base, process: [tool('t1'), tool('t3')] }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    // 状态文案仍在（hasProcess 口径不变），但不是可点的过程开关
    expect(html).toContain('已完成 1m41s');
    expect(html).not.toContain('file-t1.ts');
    expect(html).not.toContain('展开执行过程');
    expect(html).not.toContain('收起执行过程');
    expect(html).toContain('这是回答');
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

  /**
   * 用户气泡靠右对齐（`maxWidth: '75%'` + `justify-content: flex-end`），
   * 右边界就是消息列的右边界；助手内容一旦被压窄，两者右边界之间就会空出一条
   * 竖带——这正是曾经的 `maxWidth: '85%'` 造成的（实测差 139px）。
   * 几何本身由 `tasks/verify-chat-column-align.mjs` 真机量，这里只钉住
   * 「不许再给这层加宽度上限」这条不变量。
   */
  it('助手内容占满整个消息列，不得再加宽度上限', () => {
    const { css } = mount(
      <AssistantMessage message={base} agentId="nope" sessionId="s1" />,
    );
    const wrapper = host!.firstElementChild as HTMLElement;
    // emotion 把 sx 编译成类名规则，取该元素命中的那几条拼起来看
    const rules = Array.from(wrapper.classList)
      .map((c) => css.match(new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`))?.[1] ?? '')
      .join(';');
    expect(rules).toMatch(/width:\s*100%/);
    expect(rules).not.toMatch(/max-width/);
  });

  // —— 以下为新增的档位状态机 / H 行上移证伪点 ——

  it('聚焦结果档无 running/error：开关行退化为静态状态文案，无任何交互语义（AC1）', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'result' });
    const { html } = mount(
      <AssistantMessage
        message={{ ...base, process: [tool('t1'), tool('t3')] }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('已完成 1m41s');
    // 常规 done 行全部被过滤
    expect(html).not.toContain('file-t1.ts');
    // processInteractive === false → 无 aria-label、无 role=button（点了不该有反应）
    expect(host!.querySelector('[aria-label="展开执行过程"]')).toBeNull();
    expect(host!.querySelector('[aria-label="收起执行过程"]')).toBeNull();
    expect(host!.querySelector('[role="button"]')).toBeNull();
  });

  it('聚焦结果档存在 error 行：失败行仍渲染，开关行标出「· N 步失败」（AC2）', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'result' });
    const { html } = mount(
      <AssistantMessage
        message={{ ...base, process: [tool('t1', 'done'), tool('err', 'error')] }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('1 步失败');
    // error 行是档位豁免项：即便在 result 档也逐行渲染
    expect(html).toContain('file-err.ts');
    // 常规 done 行仍被过滤，证明「只有异常被放行」而非「整块没过滤」
    expect(html).not.toContain('file-t1.ts');
    // errors>0 → 默认展开 → 开关行是可点的「收起执行过程」
    expect(host!.querySelector('[aria-label="收起执行过程"]')).not.toBeNull();
  });

  it('errors>0 时，非流式下过程块在三档都保持展开（AC3）', () => {
    for (const tier of ['result', 'key', 'full'] as const) {
      useSettingsStore.getState().setSettings({ processDetail: tier });
      const { html } = mount(
        <AssistantMessage
          message={{ ...base, process: [tool('r1', 'done'), tool('boom', 'error')] }}
          agentId="nope"
          sessionId="s1"
        />,
      );
      expect(html, `${tier} 档应标出失败步数`).toContain('1 步失败');
      // error 行可见 = 过程块没有在结束后自动收起
      expect(html, `${tier} 档应保持展开`).toContain('file-boom.ts');
    }
  });

  it('完整过程档：非流式仍保持展开，点击开关行可收起（AC4）', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'full' });
    const { html } = mount(<AssistantMessage message={base} agentId="nope" sessionId="s1" />);
    // 结束后不自动收起：交错的行都在 DOM 里
    expect(html).toContain('深度思考');
    expect(html).toContain('file-t1.ts');

    const toggle = host!.querySelector('[aria-label="收起执行过程"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 只断言状态翻转：收起走过渡动画，jsdom 里内容卸载时机不稳定，不做反向 DOM 断言
    expect(
      host!.querySelector('[aria-label="展开执行过程"]')!.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('折叠态下 H 行（敏感 / 待授权卡片）仍可见，而 inline 卡片被折叠隐藏（PRD §3.2 H）', () => {
    const message: Message = {
      ...base,
      process: undefined,
      toolCalls: [
        {
          id: 'tc-pinned',
          tool: 'shell',
          args: { command: 'rm -rf /' },
          sensitive: true,
          status: 'pending',
        },
        {
          id: 'tc-inline',
          tool: 'web_search',
          args: { query: 'x' },
          sensitive: false,
          status: 'done',
        },
      ],
    };
    const { html } = mount(<AssistantMessage message={message} agentId="nope" sessionId="s1" />);
    // 默认 key 档、非流式 → 过程折叠区收起
    expect(
      host!.querySelector('[aria-label="展开执行过程"]')!.getAttribute('aria-expanded'),
    ).toBe('false');
    // 敏感卡片从折叠区上移到兄弟节点：折叠态下依然挂在 DOM 里。
    // 断言落在**卡片内容**（主参数）而不是工具名——工具名已经按「只说人话」的
    // 口径收进展开区（见 ToolCallCard），拿它当锚点会变成在钉实现细节。
    expect(html).toContain('rm -rf /');
    expect(html).toContain('敏感');
    expect(html).toContain('等待授权');
    // 非敏感卡片仍在折叠区内 → 收起时被 unmount
    expect(html).not.toContain('web_search');
    expect(html).toContain('这是回答');
  });

  // —— 以下为「同一次动作不重复显示」的证伪点 ——

  it('过程行已覆盖的**已批准**调用不再单独渲染卡片（同一动作不重复显示）', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'full' });
    const args = { path: 'D:\\aaa\\bubble_sort.py' };
    const { html } = mount(
      <AssistantMessage
        message={{
          ...base,
          process: [{ id: 'call-1', kind: 'tool', tool: 'write_file', args, status: 'done' }],
          toolCalls: [
            { id: 'call-1', tool: 'write_file', args, sensitive: true, status: 'approved' },
          ],
        }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    // 动作本身仍在：过程行以「已写入 + 路径」呈现
    expect(html).toContain('已写入');
    expect(html).toContain('bubble_sort.py');
    // 但不再叠一张卡片（卡片折叠态才有这个 aria-label）
    expect(html).not.toContain('展开工具调用详情');
  });

  it('引擎未给 call_id（老数据）时按「工具名 + 参数」兜底去重', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'full' });
    const args = { path: 'D:\\aaa\\bubble_sort.py' };
    const { html } = mount(
      <AssistantMessage
        message={{
          ...base,
          process: [{ id: 'call-1', kind: 'tool', tool: 'write_file', args, status: 'done' }],
          // 审批请求 id 与过程行 id 不同——正是老数据积累下来的形态
          toolCalls: [
            { id: 'appr-1', tool: 'write_file', args, sensitive: true, status: 'approved' },
          ],
        }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('已写入');
    expect(html).not.toContain('展开工具调用详情');
  });

  it('已拒绝的调用即使过程行已覆盖，仍保留卡片——审批结论是过程行给不出的', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'full' });
    const args = { command: 'rm -rf /' };
    const { html } = mount(
      <AssistantMessage
        message={{
          ...base,
          process: [{ id: 'call-2', kind: 'tool', tool: 'exec', args, status: 'running' }],
          toolCalls: [{ id: 'call-2', tool: 'exec', args, sensitive: true, status: 'rejected' }],
        }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('已拒绝');
    expect(html).toContain('展开工具调用详情');
  });

  /**
   * 静默超时掐断的轮次：既有正文、又是「已完成」，而最后一步的结果从未返回。
   *
   * 两个信号必须同时在场——只有常驻警告、没有那一行，用户会以为「是界面卡住」；
   * 只有「结果未返回」、没有警告，用户会以为「工具就是失败了」。2026-10-01
   * 报障里两者都缺：消息写着「已完成 11m52s」，最后一行永远在转圈。
   */
  it('被中断的轮次：常驻警告行可见，最后一行说「结果未返回」且不再转圈', () => {
    useSettingsStore.getState().setSettings({ processDetail: 'full' });
    const { html } = mount(
      <AssistantMessage
        message={{
          ...base,
          interrupted: true,
          process: [tool('ok'), { ...tool('stuck'), status: 'running' }],
        }}
        agentId="nope"
        sessionId="s1"
      />,
    );
    expect(html).toContain('被引擎中断');
    expect(html).toContain('结果未返回');
    expect(html).not.toContain('MuiCircularProgress');
  });
});
