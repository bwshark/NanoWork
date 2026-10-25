/**
 * 输入区的**引用胶囊**与**发送拼接**。
 *
 * 这是「选中文本 → 添加到对话」链路的后半段：消息流里的气泡往 store 写一条
 * `QuoteRef`，输入区据此画出一枚可删的胶囊，发送时再把引用拼成 Markdown 引用块。
 *
 * ## 钉住的四件事
 *
 * 1. **按会话收窄**：引用是 `{sessionId, messageId, text}` 三元的，别的会话的引用
 *    在当前输入区里指不到任何东西（原文根本不在屏幕上）。照单全收会让用户看到一枚
 *    删掉也不知道发生了什么、发出去还带着一段陌生文字的胶囊。
 * 2. **发送后清空**：引用已经随消息发出去了，胶囊与消息里的虚线下划线必须一起消失
 *    ——留着就是「发过了还挂在输入框里」。
 * 3. **拼接规则只有一处**：引用在前、输入在后（`buildQuotedMessage`）。这里断言
 *    最终载荷，是为了防止有人日后在 `onSend` 里另拼一套。
 * 4. **发送闸门与按钮态必须同源**：只挂引用、一个字不输也是一次合法发送
 *    （载荷就是纯引用块）。若判据只认 `text` / 附件，会出现「按钮是亮的、点了没反应」
 *    ——这正是本轮修掉的那处不一致，用例把它钉住。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { Composer, type ComposerApi } from '@/pages/chat/Composer';
import { muiTheme } from '@/theme/muiTheme';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { getComposerEdit, registerComposerEdit } from '@/lib/editor/composerEditBridge';
import { quoteChipLabel } from '@/lib/editor/selectionQuote';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { resetEventStream } from './helpers/eventStream';
import { click, flush, mount, unmount } from './helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';

const AGENT_ID = 'agent-test';
const QUOTE_TEXT = '国庆节假期';

/** 最近一次交给 `send` 的载荷（按调用顺序） */
let sent: string[] = [];

/**
 * 替换 `useSessionsStore.send`。
 *
 * 真实 `send` 会拉起流式、读事件流、落盘消息，测「拼了什么」根本用不上，
 * 而且它的前置校验（空文本且无附件 → null）会掩盖输入区自己的闸门。
 */
function stubSend(): void {
  sent = [];
  useSessionsStore.setState({
    send: (async (text: string) => {
      sent.push(text);
      return { sessionId: 's1', error: null };
    }) as never,
  });
}

beforeEach(() => {
  // jsdom 下不置位这个标志，`act()` 只会刷警告而不真正批处理更新
  // ——用例可能照样绿，但「点一下 → 重渲染 → 再断言」的时序就没人保证了。
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
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
    },
    status: 'offline',
  });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  resetEventStream();
  useAgentsStore.setState({
    agents: [
      {
        id: AGENT_ID,
        name: '测试智能体',
        systemPrompt: '你是测试助手',
        skillIds: [],
        imBinding: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    activeAgentId: AGENT_ID,
  });
  useSessionUiStore.setState({ quotes: [] });
  stubSend();
});

afterEach(async () => {
  unmount();
  /**
   * 这里等的不是 React，而是 MUI 的过渡：`Grow` / `Menu` 走
   * react-transition-group 的 `setTimeout`，组件卸载后它还在飞，测试环境销毁时才
   * 落地 —— vitest 记一条 `Unhandled Error`。症状是**所有用例全绿、退出码却是 1**，
   * 而门禁只认退出码，所以这 400ms 必须等。
   */
  await new Promise((r) => setTimeout(r, 400));
});

/** 建一个活跃会话（输入区要按会话过滤引用，必须先有会话 id） */
function openSession(): string {
  const session = useSessionsStore.getState().createSession(AGENT_ID, '新会话');
  return session.id;
}

/**
 * 挂载输入区。
 *
 * 显式把 `apiRef` 作为**可选**入参透传：这个 prop 传不传，是下面那组
 * 「编辑桥接」用例的**全部变量**，不能用一个内部写死的挂载函数糊过去。
 */
function mountComposer(
  apiRef?: React.MutableRefObject<ComposerApi | null>,
): HTMLElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <MemoryRouter>
        <Composer apiRef={apiRef} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 往 store 里塞一条引用（真机上由消息流的气泡写入） */
function addQuote(sessionId: string, text = QUOTE_TEXT, messageId = 'm1'): void {
  act(() => {
    useSessionUiStore.getState().addQuote({ sessionId, messageId, text });
  });
}

describe('输入区编辑桥接：不能挂在可选的 apiRef 上', () => {
  it('⭐ 不传 apiRef 也要注册（「已经在对话里」的输入区走的正是这条）', async () => {
    // 这条是真机跑出来的回归。`registerComposerEdit` 原先写在 `if (!apiRef) return`
    // 之后，而 ChatPage 里**只有空态那个 hero 输入区**传了 `apiRef` ——
    // 一旦开始对话（floating 输入区），桥接整体为 null：
    //   · 消息流「添加到对话」送不去焦点（不报错，只是点了没反应）；
    //   · 标题栏「编辑」菜单的撤销/重做/全选一起失灵。
    // 单测必须显式**不传** apiRef，否则走不到 this 分支，用例会假绿。
    registerComposerEdit(null);
    openSession();
    mountComposer();
    await flush();

    expect(getComposerEdit()).not.toBeNull();
  });

  it('传了 apiRef 时照旧注册，并卸载时两边一起清', async () => {
    openSession();
    const apiRef = { current: null } as React.MutableRefObject<ComposerApi | null>;
    mountComposer(apiRef);
    await flush();

    expect(getComposerEdit()).not.toBeNull();
    expect(apiRef.current).not.toBeNull();

    unmount();
    // 两边都得清：只清一边会留下「指向已卸载输入区」的悬挂引用
    expect(getComposerEdit()).toBeNull();
    expect(apiRef.current).toBeNull();
  });
});

/** 按胶囊文案定位引用胶囊 —— 技能胶囊也在同一行，按内容找才不会认错 */
function quoteChip(host: HTMLElement, text = QUOTE_TEXT): HTMLElement | null {
  const label = quoteChipLabel(text);
  return (
    Array.from(host.querySelectorAll<HTMLElement>('.MuiChip-root')).find(
      (c) => (c.querySelector('.MuiChip-label')?.textContent ?? '') === label,
    ) ?? null
  );
}

/** 输入区本体：唯一带 contentEditable 的元素 */
function editable(host: HTMLElement): HTMLElement {
  const root = host.querySelector<HTMLElement>('[contenteditable="true"]');
  expect(root, '找不到输入区').toBeTruthy();
  return root!;
}

/**
 * 模拟用户敲字。
 *
 * 走 DOM + `input` 事件（真人的那条路），而不是给组件塞受控 `value`：
 * 受控模式会走「外部写入」分支，绕过 `onInput` 的文本镜像同步。
 */
function typeText(host: HTMLElement, value: string): void {
  const root = editable(host);
  root.textContent = value;
  act(() => {
    root.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function sendButton(host: HTMLElement): HTMLButtonElement {
  const icon = host.querySelector('[data-testid="SendIcon"]');
  expect(icon, '找不到发送按钮（只有流式中才会被换成停止按钮）').toBeTruthy();
  return icon!.closest('button') as HTMLButtonElement;
}

describe('输入区：引用胶囊', () => {
  it('引用以胶囊出现，带删除入口', async () => {
    const sid = openSession();
    const host = mountComposer();
    // 挂载时输入区还有异步收尾（模型 / 工作空间等），先让它落定再断言
    await flush();
    addQuote(sid);

    const chip = quoteChip(host);
    expect(chip).toBeTruthy();
    expect(chip!.querySelector('.MuiChip-deleteIcon')).toBeTruthy();
  });

  it('点 × 删掉引用（store 与视图一起收）', async () => {
    const sid = openSession();
    const host = mountComposer();
    await flush();
    addQuote(sid);

    click(quoteChip(host)!.querySelector('.MuiChip-deleteIcon'));

    expect(useSessionUiStore.getState().quotes).toHaveLength(0);
    expect(quoteChip(host)).toBeNull();
  });

  it('别的会话的引用不画在当前输入区', async () => {
    openSession();
    const host = mountComposer();
    await flush();
    // 原文在另一条会话的消息流里；当前输入区里既没有原文，也没有它的位置
    addQuote('another-session');

    expect(quoteChip(host)).toBeNull();
    // 但引用本身还在（切回那条会话应当照旧显示），只是不该出现在这里
    const kept = useSessionUiStore.getState().quotes;
    expect(kept).toHaveLength(1);
    expect(kept[0].sessionId).toBe('another-session');
  });
});

describe('输入区：发送时的引用拼接', () => {
  it('引用拼成 Markdown 引用块放在正文之前，发完即清空', async () => {
    const sid = openSession();
    const host = mountComposer();
    typeText(host, '请接着说明');
    addQuote(sid);

    click(sendButton(host));
    await flush();

    expect(sent).toHaveLength(1);
    // 引用在前、输入在后：引用块后面空一行，正文才不会被当成引用的续行
    expect(sent[0]).toBe('> 国庆节假期\n\n请接着说明');
    expect(useSessionUiStore.getState().quotes).toHaveLength(0);
    expect(quoteChip(host)).toBeNull();
  });

  it('只挂引用、一个字不输也能发（按钮亮着，载荷就是纯引用块）', async () => {
    const sid = openSession();
    const host = mountComposer();
    addQuote(sid);

    expect(sendButton(host).disabled).toBe(false);

    click(sendButton(host));
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('> 国庆节假期');
    expect(useSessionUiStore.getState().quotes).toHaveLength(0);
  });

  it('既无文字也无引用时发送按钮仍然禁用（闸门没被放松）', async () => {
    openSession();
    const host = mountComposer();
    await flush();

    expect(sendButton(host).disabled).toBe(true);
  });

  it('有多条引用时按加入顺序依次拼出（不是倒序、不丢）', async () => {
    const sid = openSession();
    const host = mountComposer();
    typeText(host, '都解释一下');
    addQuote(sid, '第一段', 'm1');
    addQuote(sid, '第二段', 'm2');

    click(sendButton(host));
    await flush();

    expect(sent[0]).toBe('> 第一段\n> 第二段\n\n都解释一下');
  });
});
