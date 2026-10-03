/**
 * 审批卡片（`ApprovalCard`）的形态与裁决契约。
 *
 * ## 为什么这不是「又一个 UI 快照测试」
 *
 * 这次改造动的三件事都是**会静默坏掉**的那类：
 *
 * 1. **覆盖输入框而不是居中弹窗**：它现在靠 `position: absolute` + 锚点祖先
 *    的 `relative` 活着。谁把 `ChatPage` 的 `relative` 删了，卡片会贴到视口
 *    底部（看起来「还能用」，但已经不在输入框上了），测试却照样绿——除非有人
 *    真的断言过这条几何关系。这里断言它的**绝对定位**与**贴底**。
 * 2. **摘要先于 JSON**：认得出的工具必须给一句人话；认不出的必须退回完整参数。
 *    判据取自 `@/lib/approvalSummary`，所以这里只钉子「卡片真的用了它」。
 * 3. **三档裁决**：`always` 必须原样回传给引擎（不是被翻译成 `allow`）。
 *    这一条一旦回归，「本会话始终允许」在 UI 上点得动、引擎却永远学不会，
 *    用户会以为功能没生效——而界面上完全看不出异常。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@mui/material';
import { ApprovalCard } from '@/components/ApprovalCard';
import { muiTheme } from '@/theme/muiTheme';
import { useSessionsStore } from '@/stores/sessionsStore';
import {
  useSettingsStore,
  DEFAULT_TRANSCRIPTION,
  DEFAULT_DESKTOP,
} from '@/stores/settingsStore';
import { getRuntime } from '@/ai/runtime';
import type { ApprovalDecision } from '@/ai/runtime/types';
import { resetEventStream } from '../helpers/eventStream';
import { click, flush, mount, mountStrict, unmount } from '../helpers/reactMount';
import { DEFAULT_MEMORY_POLICY } from '@/types';

const SESSION_ID = 'sess-approval-1';
const MESSAGE_ID = 'msg-approval-1';

/** 被 mock 掉的引擎回传通道（只关心「送了什么裁决出去」） */
const respondApproval = vi.fn(
  async (_id: string, _decision: ApprovalDecision, _reason?: string) => {},
);

function enqueueApproval(tool: string, args: Record<string, unknown>): void {
  useSessionsStore.setState((s) => ({
    ...s,
    pendingApprovals: [
      ...s.pendingApprovals,
      {
        id: 'appr-1',
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        toolCallId: 'appr-1',
        tool,
        args,
      },
    ],
  }));
}

function renderCard(): HTMLDivElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <ApprovalCard />
    </ThemeProvider>,
  );
}

/** 卡片根节点（挂载容器里的第一个直接子元素就是定位层） */
function cardLayer(host: HTMLElement): HTMLElement {
  return host.firstElementChild as HTMLElement;
}

/**
 * 收集 emotion 注入到 `<head>` 的全部 CSS 文本。
 *
 * MUI 的 `sx` 不产生内联样式，只产生类名与样式表规则；要断言几何行为
 * （绝对定位、贴底）就只能到这里来找。
 */
function collectCss(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
}

function textOf(host: HTMLElement): string {
  return host.textContent ?? '';
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    (Array.from(host.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(text),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

/** 卡片上真正可见的文本：跳过被折叠（高度为 0）的子树 */
async function visibleText(host: HTMLElement): Promise<string> {
  // 折叠态由 MUI `Collapse` 用内联 height 控制，jsdom 不做布局算不出
  // 「可见」——但 Collapse 收起时会加 `.MuiCollapse-hidden`，直接按它筛。
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.MuiCollapse-hidden').forEach((el) => el.remove());
  return clone.textContent ?? '';
}

beforeEach(() => {
  vi.restoreAllMocks();
  respondApproval.mockClear();
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
  // 建一条真会话：`resolveApproval` 要往它上面写权限日志与工具卡片状态
  resetEventStream();
  const session = useSessionsStore
    .getState()
    .createSession('agent-x', '审批测试', {});
  useSessionsStore.setState({
    activeId: session.id,
    pendingApprovals: [],
    error: null,
  });
  // 把引擎替换成桩：只记下裁决，不真发请求
  const runtime = getRuntime();
  runtime.respondApproval = respondApproval;
});

afterEach(() => unmount());

describe('ApprovalCard：覆盖输入框而不是居中弹窗', () => {
  it('根层用绝对定位贴底（不是 Modal 的居中定位）', () => {
    enqueueApproval('exec', { command: 'ls' });
    const layer = cardLayer(renderCard());

    // ⚠️ 断言 `sx` 编译出的 CSS 规则而不是 `style`：MUI 的 `sx` 走 emotion，
    // 生成的是类名 + 样式表规则，元素上没有内联样式（写 `style.position` 会
    // 永远拿到空串，用例看着在断言其实什么都没验）。
    const css = collectCss();
    expect(css).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/bottom:\s*0/);
    expect(css).toMatch(/left:\s*0/);
    expect(css).toMatch(/right:\s*0/);
    // 定位层必须自己不带遮罩语义：MUI 的 Modal 会渲染 `[role="dialog"]` +
    // 全屏 backdrop，这里两者都不该出现——「不挡消息流」正是本次改造的要点。
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.MuiBackdrop-root')).toBeNull();
    expect(layer).toBeTruthy();
  });

  it('没有待裁决请求时完全不渲染（不留一个透明的定位层挡点击）', () => {
    useSessionsStore.setState({ activeId: null, pendingApprovals: [] });
    const host = renderCard();
    expect(host.firstElementChild).toBeNull();
  });
});

describe('ApprovalCard：摘要先于参数', () => {
  it('认得出的工具给一句人话摘要，并默认收起参数', async () => {
    enqueueApproval('write_file', { path: 'D:/tmp/a.js', content: 'hi' });
    const host = renderCard();

    expect(textOf(host)).toContain('写入文件 D:/tmp/a.js');
    expect(textOf(host)).toContain('查看参数');
    // ⚠️ `Collapse` 收起时子节点**仍在 DOM 里**（只是高度为 0），所以判据
    // 必须是「不可见」而不是「不存在」。写成 `not.toContain` 会永远失败，
    // 逼着人删掉这条断言——而它守的恰恰是「第一眼不该是 JSON」。
    expect(await visibleText(host)).not.toContain('content:');
  });

  it('点「查看参数」后参数才出现（证据是可展开的，不是默认噪音）', async () => {
    enqueueApproval('write_file', { path: 'D:/tmp/a.js', content: 'hi' });
    const host = renderCard();

    click(buttonByText(host, '查看参数'));
    await flush();

    expect(textOf(host)).toContain('path: D:/tmp/a.js');
    expect(textOf(host)).toContain('content: hi');
  });

  it('认不出工具时不给编造的摘要，直接摊开完整参数', () => {
    enqueueApproval('brand_new_tool', { weird: 'value' });
    const host = renderCard();

    expect(textOf(host)).toContain('weird: value');
    expect(textOf(host)).not.toContain('查看参数');
  });

  it('连参数都拿不到时如实说明，而不是摆一个空块', () => {
    enqueueApproval('brand_new_tool', {});
    const host = renderCard();

    expect(textOf(host)).toContain('没有携带可展示的参数');
  });
});

describe('ApprovalCard：三档裁决原样回传', () => {
  it('「允许本次」送出 allow（不是 always）', async () => {
    enqueueApproval('exec', { command: 'ls' });
    const host = renderCard();

    click(buttonByText(host, '允许本次'));
    await flush();

    expect(respondApproval).toHaveBeenCalledTimes(1);
    expect(respondApproval.mock.calls[0][0]).toBe('appr-1');
    expect(respondApproval.mock.calls[0][1]).toBe('allow');
  });

  it('「拒绝」送出 deny，并带上填写的拒绝原因', async () => {
    enqueueApproval('exec', { command: 'rm -rf /' });
    const host = renderCard();

    // 点开原因输入框再写值
    click(buttonByText(host, '拒绝原因'));
    await flush();
    const textarea = host.querySelector('textarea');
    expect(textarea).toBeTruthy();
    // 受控 textarea：走原生 setter + input 事件（React 的 value tracker）
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(textarea, '不要删这个目录');
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    click(buttonByText(host, '拒绝'));
    await flush();

    expect(respondApproval.mock.calls[0][1]).toBe('deny');
    expect(respondApproval.mock.calls[0][2]).toBe('不要删这个目录');
  });

  it('「本会话始终允许」送出 always —— 不能被翻译成 allow', async () => {
    enqueueApproval('exec', { command: 'ls' });
    const host = renderCard();

    // 先展开升级下拉
    click(host.querySelector('[aria-label="更多允许方式"]'));
    await flush();
    expect(textOf(host)).toContain('本会话始终允许');

    click(host.querySelector('[aria-label="本会话始终允许该工具"]'));
    await flush();

    expect(respondApproval).toHaveBeenCalledTimes(1);
    expect(respondApproval.mock.calls[0][1]).toBe('always');
  });

  it('裁决后请求出队，卡片随之消失', async () => {
    enqueueApproval('exec', { command: 'ls' });
    const host = renderCard();
    click(buttonByText(host, '允许本次'));
    await flush();

    expect(useSessionsStore.getState().pendingApprovals).toHaveLength(0);
    expect(host.firstElementChild).toBeNull();
  });

  it('队列里还有请求时提示剩余条数', () => {
    enqueueApproval('exec', { command: 'ls' });
    enqueueApproval('exec', { command: 'pwd' });
    const host = renderCard();
    expect(textOf(host)).toContain('还有 1 条待处理');
  });
});

describe('ApprovalCard：切到下一条请求要清干净上一条的输入', () => {
  it('上一条填的拒绝原因不会带进新卡片（会误伤新操作）', async () => {
    enqueueApproval('exec', { command: 'ls' });
    const host = renderCard();

    click(buttonByText(host, '拒绝原因'));
    await flush();
    const textarea = host.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(textarea, '上一条的原因');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(host.textContent).toContain('上一条的原因');

    // 换下一条请求
    useSessionsStore.setState((s) => ({
      ...s,
      pendingApprovals: [
        {
          id: 'appr-2',
          sessionId: SESSION_ID,
          messageId: MESSAGE_ID,
          toolCallId: 'appr-2',
          tool: 'write_file',
          args: { path: 'b.js' },
        },
      ],
    }));
    await flush();

    expect(host.textContent).not.toContain('上一条的原因');
    expect(host.querySelector('textarea')).toBeNull();
  });

  /**
   * 上面那条用例在 **StrictMode 下曾经是坏的**——而真机 `main.tsx` 就是
   * StrictMode。所以这条不是「同一个断言的重复」，它守的是一条独立的不变量：
   * 「换请求清空状态」这件事**不能依赖渲染期副作用**。
   *
   * 曾经的实现是在渲染期比对 `lastIdRef` 再 `setXxx(false)`。StrictMode 把每次
   * 渲染跑两遍：第一遍把 ref 写掉并排队 `setReasonOpen(false)`，但第一遍输出被
   * 丢弃；第二遍看见 ref 已换 → 直接跳过重置 → 那批 `setXxx(false)` 落空。
   * 症状是「上一条点开的拒绝原因输入框，原样出现在新卡片里」，用户敲下的理由
   * 会被回灌给一个完全无关的工具调用。
   *
   * 现在把「一条请求一份状态」交给 `key={pending.id}`：换请求即卸载重挂，
   * 状态天然归零，与双渲染无关。这条用例就是它的守卫。
   */
  it('StrictMode 下（真机渲染模式）换请求同样清空拒绝原因输入框', async () => {
    enqueueApproval('exec', { command: 'ls' });
    const host = mountStrict(
      <ThemeProvider theme={muiTheme}>
        <ApprovalCard />
      </ThemeProvider>,
    );

    click(buttonByText(host, '拒绝原因'));
    await flush();
    expect(host.querySelector('textarea')).toBeTruthy();

    // 换成下一条请求（模拟引擎取消上一条后队列换人）
    useSessionsStore.setState((s) => ({
      ...s,
      pendingApprovals: [
        {
          id: 'appr-2',
          sessionId: SESSION_ID,
          messageId: MESSAGE_ID,
          toolCallId: 'appr-2',
          tool: 'write_file',
          args: { path: 'b.js' },
        },
      ],
    }));
    await flush();

    // 必须是「入口按钮」而不是「展开的输入框」
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).toContain('拒绝原因');
  });

  it('StrictMode 下换请求，展开的参数区也收回去（同一类状态一律归零）', async () => {
    enqueueApproval('exec', { command: 'ls' });
    const host = mountStrict(
      <ThemeProvider theme={muiTheme}>
        <ApprovalCard />
      </ThemeProvider>,
    );

    click(buttonByText(host, '查看参数'));
    await flush();
    expect(await visibleText(host)).toContain('command: ls');

    useSessionsStore.setState((s) => ({
      ...s,
      pendingApprovals: [
        {
          id: 'appr-2',
          sessionId: SESSION_ID,
          messageId: MESSAGE_ID,
          toolCallId: 'appr-2',
          tool: 'write_file',
          args: { path: 'b.js', content: 'hi' },
        },
      ],
    }));
    await flush();

    // 新请求的参数默认收起：不该继承上一条「已展开」的姿态
    expect(await visibleText(host)).not.toContain('content: hi');
    expect(host.textContent).toContain('查看参数');
  });
});
