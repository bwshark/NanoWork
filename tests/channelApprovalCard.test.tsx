/**
 * 助理视图的**逐条批准卡片**（IM 会话那条独立的审批通道）。
 *
 * ## 为什么这批用例值得存在
 *
 * IM 侧（飞书）的审批卡早就通了，用户在飞书里回「允许」能放行工具。桌面端
 * 这条路是**独立实现**的——数据来源、裁决端点、引擎进程全都不同——所以它
 * 有一整类「界面上完全看不出异常」的失效：
 *
 * 1. **裁决必须落在 gateway 进程**：IM 轮次跑在 gateway，它的 `PENDING_APPROVALS`
 *    与 serve 进程的那张不是同一张。打错进程 → 409 → 用户点了「允许」却什么都没
 *    发生，**全程零报错**。
 * 2. **轮询必须独立于「桌面端发起的轮次」**：`turn_progress.begin()` 只由
 *    `/v1/turn` 调用，而「用户在飞书里让智能体建文件」是渠道入站触发的——
 *    桌面端是旁观者。挂在轮次上就永远看不到这张卡。
 * 3. **卡片位置必须与任务视图一致**：贴在输入框上（覆盖输入框），不是居中弹窗。
 * 4. **换请求要清干净上一条的输入**：拒绝原因不能带进新卡片。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@mui/material';
import { ChannelApprovalCard } from '@/components/ChannelApprovalCard';
import { muiTheme } from '@/theme/muiTheme';
import { platform } from '@/platform';
import { useToastStore } from '@/components/Toast';
import {
  resetChannelApprovalWatchersForTest,
  useChannelApprovalsStore,
} from '@/stores/channelApprovalsStore';
import type { ChannelApproval } from '@/platform/types';
import { buttonByText, click, mount, unmount } from './helpers/reactMount';

const SESSION_ID = 'nb:feishu.feishu:oc_v3_abc123';
const CHANNEL = 'feishu.feishu';
const CHAT_ID = 'oc_v3_abc123';

/** 每次 `getChannelApprovals` 的实参 */
let queryCalls: Array<{ channel: string; chatId: string }> = [];
/** 待发放的审批快照（按调用顺序消费；用尽后重复最后一条） */
let snapshots: ChannelApproval[][] = [];
/** `resolveChannelApproval` 的实参（裁决送去了哪个端点的什么内容） */
let resolveCalls: Array<{
  channel: string;
  chatId: string;
  requestId: string;
  decision: string;
  reason?: string;
}> = [];
/** 裁决端点的返回值（默认成功；失败用例改成 ok=false） */
let resolveOutcome: { ok: boolean; error?: string } = { ok: true };
/**
 * 查询端点的返回值覆盖（null = 走快照逻辑）。
 *
 * ⚠️ 不要在用例体内再 `vi.spyOn(platform, 'getChannelApprovals')`：**二次 spyOn 会顶掉
 * beforeEach 里那个带 `queryCalls.push` 记录逻辑的 spy**，`queryCalls` 于是永远停在 0
 * ——断言 `toBe(calls)` 就变成 0===0 的**假绿**，用例会绿而轮询行为根本没被验证。
 */
let queryOutcome: {
  ok: boolean;
  unsupported?: boolean;
  error?: string;
  approvals: ChannelApproval[];
} | null = null;

function approval(overrides: Partial<ChannelApproval> = {}): ChannelApproval {
  return {
    id: 'appr-1',
    tool: 'write_file',
    args: { path: 'D:/tmp/a.js', content: 'hi' },
    callId: 'call_1',
    timeoutSeconds: 300,
    shortCode: 'appr-1',
    ...overrides,
  };
}

function renderCard(): HTMLDivElement {
  return mount(
    <ThemeProvider theme={muiTheme}>
      <ChannelApprovalCard sessionId={SESSION_ID} channel={CHANNEL} />
    </ThemeProvider>,
  );
}

/**
 * 让挂起的 Promise 链与 0ms 定时器跑完。
 *
 * 不能用 `tests/helpers/reactMount` 的 `flush()`：它内部 `await setTimeout(0)`，
 * 而本文件开了假定时器 —— 那个 setTimeout 永远不到期，flush 会一直挂着直到
 * 用例超时（表现为「Test timed out in 5000ms」，看不出真正原因）。
 */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  queryCalls = [];
  snapshots = [];
  resolveCalls = [];
  resolveOutcome = { ok: true };
  queryOutcome = null;
  useToastStore.setState({ items: [] });
  resetChannelApprovalWatchersForTest();

  vi.spyOn(platform, 'getChannelApprovals').mockImplementation(async (params) => {
    queryCalls.push({ channel: params.channel, chatId: params.chatId });
    if (queryOutcome) return queryOutcome;
    const next = snapshots.length > 1 ? snapshots.shift()! : snapshots[0];
    return { ok: true, approvals: next ?? [] };
  });
  vi.spyOn(platform, 'resolveChannelApproval').mockImplementation(async (params) => {
    resolveCalls.push({
      channel: params.channel,
      chatId: params.chatId,
      requestId: params.requestId,
      decision: params.decision,
      reason: params.reason,
    });
    return resolveOutcome;
  });
});

afterEach(() => {
  unmount();
  resetChannelApprovalWatchersForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('轮询：查的是「当前会话」的待裁决审批', () => {
  it('⭐ 用运行时渠道名 + chatId 查询（找错会话 = 永远查不到那张卡）', async () => {
    snapshots = [[approval()]];

    renderCard();
    await vi.advanceTimersByTimeAsync(0);

    expect(queryCalls[0]).toEqual({ channel: CHANNEL, chatId: CHAT_ID });
  });

  it('⭐ 挂上即轮询（不等 4 秒的会话刷新——那条路看不到审批）', async () => {
    snapshots = [[approval()]];

    renderCard();
    await vi.advanceTimersByTimeAsync(0);

    // 立刻就有一次查询：切回一个已有挂起的会话时卡片应当马上出现
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('有挂起请求时把卡片渲染出来（工具名与摘要都在）', async () => {
    snapshots = [[approval({ tool: 'write_file', args: { path: 'D:/tmp/a.js' } })]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    expect(host.querySelector('[data-testid="approval-card"]')).toBeTruthy();
    expect(host.textContent).toContain('write_file');
    expect(host.textContent).toContain('写入文件 D:/tmp/a.js');
  });

  it('没有挂起请求时不渲染卡片（不留透明层挡点击）', async () => {
    snapshots = [[]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    expect(host.firstElementChild).toBeNull();
  });

  it('多条挂起时显示剩余条数（与任务视图同款提示）', async () => {
    snapshots = [[approval({ id: 'appr-1' }), approval({ id: 'appr-2' })]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    expect(host.textContent).toContain('还有 1 条待处理');
  });

  it('老网关不认这个端点（unsupported）→ 停止轮询，不每秒失败一次', async () => {
    queryOutcome = { ok: false, unsupported: true, approvals: [] };

    renderCard();
    await vi.advanceTimersByTimeAsync(0);
    const calls = queryCalls.length;
    await vi.advanceTimersByTimeAsync(5000);

    // 挂上立刻查了一次；unsupported 之后计时器被清掉，不再每秒空转
    expect(calls).toBe(1);
    expect(queryCalls.length).toBe(1);
  });

  it('网关持续不可达 → 连续失败到上限后停止轮询', async () => {
    queryOutcome = {
      ok: false,
      approvals: [],
      error: '网关不可达：ECONNREFUSED',
    };

    renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000 * 12);
    const calls = queryCalls.length;

    // 失败上限是 8 次（首次那回也算）：之后不再空转
    expect(calls).toBe(8);
    await vi.advanceTimersByTimeAsync(1000 * 5);
    expect(queryCalls.length).toBe(calls);
  });
});

describe('裁决：必须落在 gateway 端点上', () => {
  it('⭐「允许本次」送出 allow，并带上正确的会话与请求 id', async () => {
    snapshots = [[approval({ id: 'appr-xyz' })]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    click(buttonByText(host, '允许本次'));
    await tick();

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toMatchObject({
      channel: CHANNEL,
      chatId: CHAT_ID,
      requestId: 'appr-xyz',
      decision: 'allow',
    });
  });

  it('「拒绝」送出 deny，并带上填写的拒绝原因', async () => {
    snapshots = [[approval()]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    click(buttonByText(host, '拒绝原因'));
    await tick();
    const textarea = host.querySelector('textarea');
    expect(textarea).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(textarea, '不要建这个文件');
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    click(buttonByText(host, '拒绝'));
    await tick();

    expect(resolveCalls[0].decision).toBe('deny');
    expect(resolveCalls[0].reason).toBe('不要建这个文件');
  });

  it('「本会话始终允许」送出 always —— 不能被翻译成 allow', async () => {
    snapshots = [[approval()]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    click(host.querySelector('[aria-label="更多允许方式"]'));
    await tick();
    click(host.querySelector('[aria-label="本会话始终允许该工具"]'));
    await tick();

    expect(resolveCalls[0].decision).toBe('always');
  });

  it('裁决后该条出队，卡片随之消失', async () => {
    snapshots = [[approval()]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    click(buttonByText(host, '允许本次'));
    await tick();

    expect(
      useChannelApprovalsStore.getState().bySession[SESSION_ID],
    ).toHaveLength(0);
    expect(host.firstElementChild).toBeNull();
  });

  it('裁决失败时如实提示（不假装放行成功）', async () => {
    resolveOutcome = { ok: false, error: '审批请求不存在、已过期或不属于该会话' };
    snapshots = [[approval()]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    click(buttonByText(host, '允许本次'));
    await tick();

    expect(resolveCalls).toHaveLength(1);
    // 必须有一条 error 级别的提示：静默失败会让用户以为「已经放行了」
    const toasts = useToastStore.getState().items;
    expect(toasts.some((t) => t.severity === 'error')).toBe(true);
    expect(toasts.map((t) => t.message).join()).toContain('已过期');
  });
});

describe('卡片形态：与任务视图一致', () => {
  it('⭐ 贴在输入框上（绝对定位贴底），不是居中弹窗', async () => {
    snapshots = [[approval()]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(css).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/bottom:\s*0/);
    // 不该有模态语义：Modal 会渲染 [role="dialog"] + 全屏 backdrop
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.MuiBackdrop-root')).toBeNull();
  });

  it('换到下一条请求时清干净上一条的拒绝原因输入框', async () => {
    snapshots = [[approval({ id: 'appr-1' })]];

    const host = renderCard();
    await vi.advanceTimersByTimeAsync(0);
    await tick();

    click(buttonByText(host, '拒绝原因'));
    await tick();
    const textarea = host.querySelector('textarea')!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(textarea, '上一条的原因');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(host.textContent).toContain('上一条的原因');

    // 引擎那边换了一条（超时后用户又发起了新的一轮）
    snapshots = [[approval({ id: 'appr-2', tool: 'write_file', args: { path: 'b.js' } })]];
    await vi.advanceTimersByTimeAsync(1000);
    await tick();

    expect(host.textContent).not.toContain('上一条的原因');
    expect(host.querySelector('textarea')).toBeNull();
  });
});
