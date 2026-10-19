/**
 * 助理视图的**实时过程**：占位助手消息 + `/v1/turn/progress` 轮询合流。
 *
 * ## 为什么这批用例值得存在
 *
 * 真实故障形态是「界面一片空白」——用户分不清「引擎在思考」与「消息没发出去」，
 * 而这**不会报错**：`/v1/turn` 返回 200 之后，整轮期间磁盘上确实没有任何记录，
 * 4 秒轮询拿到的东西与发送前一模一样。
 *
 * 这里钉住四件事：
 *
 * 1. **事件按到达顺序合流**：思考段与工具行交错，工具开始要闭合当前思考段
 *    （与任务视图 `handleProcessTool` 同一时机）——否则刷新前后时间线排布不一致。
 * 2. **占位消息不写本地事件流**：频道会话的真值在引擎侧，写进去的只是一份
 *    永远对不上消息 id 的垃圾事件。
 * 3. **三种收尾各自正确**：引擎报完成 → 冻结耗时并立刻拉真实记录；老网关不认
 *    这个端点（`unsupported`）→ 立刻摘掉占位消息、停止重试；网关持续不可达 →
 *    摘掉，不再空转。
 * 4. **轮询按会话唯一**：同一会话连发两条不会并发两份计时器（事件会重复叠加）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useChannelSessionsStore } from '@/stores/channelSessionsStore';
import {
  resetChannelTurnWatchesForTest,
  watchChannelTurn,
} from '@/lib/channelTurnLive';
import { setChannelTurnWatching } from '@/lib/channelTurnLiveState';
import type { ChannelTurnProgress, ChannelTurnProgressEvent } from '@/platform/types';

const SESSION_ID = 'nb:feishu.feishu:oc_v3_abc123';
const CHANNEL = 'feishu.feishu';
const CHAT_ID = 'oc_v3_abc123';
/** nanobot session key（= 本地 id 去掉 `nb:` 前缀）：摘要与详情都按它寻址 */
const SESSION_KEY = `${CHANNEL}:${CHAT_ID}`;

/** 每次 `getChannelTurnProgress` 的实参（用于断言游标推进） */
let progressCalls: Array<{ channel: string; chatId: string; since: number }> = [];
/** 待发放的进度响应（按调用顺序消费；用尽后重复最后一条） */
let responses: ChannelTurnProgress[] = [];
let refreshCalls = 0;

beforeEach(() => {
  vi.useFakeTimers();
  progressCalls = [];
  refreshCalls = 0;
  responses = [];
  resetChannelTurnWatchesForTest();
  useSessionsStore.setState({
    sessions: [
      {
        id: SESSION_ID,
        agentId: '',
        channel: CHANNEL,
        title: '飞书会话',
        messages: [],
        permissionLog: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    activeId: SESSION_ID,
    streams: {},
    pendingApprovals: [],
    error: null,
  });
  useChannelSessionsStore.setState({
    summaries: [],
    loading: false,
    refresh: async () => {
      refreshCalls += 1;
    },
  });

  vi.spyOn(platform, 'getChannelTurnProgress').mockImplementation(async (params) => {
    progressCalls.push({ ...params });
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    return (
      next ?? { ok: true, known: false, active: false, seq: 0, events: [] }
    );
  });
});

afterEach(() => {
  resetChannelTurnWatchesForTest();
  setChannelTurnWatching(SESSION_ID, false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function liveMessages() {
  const session = useSessionsStore.getState().sessions.find((s) => s.id === SESSION_ID);
  return (session?.messages ?? []).filter((m) => m.role === 'assistant');
}

/** 把一条进度事件合流进指定占位消息（用例里的常用动作） */
function applyEvent(messageId: string, event: ChannelTurnProgressEvent): void {
  useSessionsStore.getState().applyChannelTurnLiveEvent(SESSION_ID, messageId, event);
}

describe('store：占位助手消息的合流', () => {
  it('创建占位消息即进入「思考中」状态（状态行需要它）', () => {
    const id = useSessionsStore.getState().startChannelTurnLive(SESSION_ID);

    const [live] = liveMessages();
    expect(live.id).toBe(id);
    expect(live.content).toBe('');
    expect(useSessionsStore.getState().streams[SESSION_ID]?.status).toBe('thinking');
  });

  it('思考段连续追加、工具开始闭合思考段、工具结束转 done', () => {
    const id = useSessionsStore.getState().startChannelTurnLive(SESSION_ID);
    const apply = (event: ChannelTurnProgressEvent) => applyEvent(id, event);

    apply({ kind: 'reasoning', content: '先算天数' });
    apply({ kind: 'reasoning', content: '，再核对时区' });
    apply({
      kind: 'tool',
      id: 'call_1',
      tool: 'exec',
      phase: 'start',
      args: { command: 'date' },
    });
    apply({
      kind: 'tool',
      id: 'call_1',
      tool: 'exec',
      phase: 'end',
      args: { command: 'date' },
      result: '2026-10-19',
    });

    const [live] = liveMessages();
    const process = live.process ?? [];
    expect(process).toHaveLength(2);
    expect(process[0]).toMatchObject({
      kind: 'reasoning',
      content: '先算天数，再核对时区',
      closed: true,
    });
    expect(process[1]).toMatchObject({ kind: 'tool', tool: 'exec', status: 'done' });

    // 工具结束后回到「等待模型响应」，而不是继续显示「执行工具」
    expect(useSessionsStore.getState().streams[SESSION_ID]?.status).toBe('thinking');
  });

  it('reasoning_end 只闭合思考段，不改工具行', () => {
    const id = useSessionsStore.getState().startChannelTurnLive(SESSION_ID);
    const apply = (event: ChannelTurnProgressEvent) => applyEvent(id, event);

    apply({ kind: 'reasoning', content: '想想' });
    apply({ kind: 'reasoning_end' });
    apply({ kind: 'reasoning', content: '再想想' });

    const process = liveMessages()[0].process ?? [];
    expect(process).toHaveLength(2);
    expect(process[0]).toMatchObject({ content: '想想', closed: true });
    expect(process[1]).toMatchObject({ content: '再想想' });
    expect((process[1] as { closed?: boolean }).closed).toBeUndefined();
  });

  it('收尾时冻结耗时并把状态复位为 idle（否则新消息会永久转圈）', () => {
    const id = useSessionsStore.getState().startChannelTurnLive(SESSION_ID);
    vi.advanceTimersByTime(4200);

    useSessionsStore.getState().settleChannelTurnLive(SESSION_ID, id);

    const [live] = liveMessages();
    expect(live.durationMs).toBeGreaterThanOrEqual(4000);
    expect(useSessionsStore.getState().streams[SESSION_ID]?.status).toBe('idle');
  });

  it('drop 收尾整条摘掉占位消息', () => {
    const id = useSessionsStore.getState().startChannelTurnLive(SESSION_ID);

    useSessionsStore.getState().settleChannelTurnLive(SESSION_ID, id, { drop: true });

    expect(liveMessages()).toHaveLength(0);
  });
});

describe('轮询：按 seq 增量合流并在收尾时停止', () => {
  it('⭐ 事件逐条上屏，完成后停轮询、冻结耗时并立刻拉真实记录', async () => {
    responses = [
      {
        ok: true,
        known: true,
        active: true,
        seq: 2,
        events: [
          { kind: 'reasoning', content: '先算 10-19 到 01-01' },
          { kind: 'reasoning_end' },
        ],
      },
      {
        ok: true,
        known: true,
        active: true,
        seq: 3,
        events: [
          { kind: 'tool', id: 'call_1', tool: 'exec', phase: 'start', args: { command: 'date' } },
        ],
      },
      {
        ok: true,
        known: true,
        active: false,
        seq: 4,
        events: [
          {
            kind: 'tool',
            id: 'call_1',
            tool: 'exec',
            phase: 'end',
            args: { command: 'date' },
            result: '74 days',
          },
        ],
      },
    ];

    watchChannelTurn({ sessionId: SESSION_ID, channel: CHANNEL, chatId: CHAT_ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]).toMatchObject({ channel: CHANNEL, chatId: CHAT_ID, since: 0 });

    // 第二条：游标必须推进到服务端 seq，否则思考正文会被重复拼接
    await vi.advanceTimersByTimeAsync(600);
    expect(progressCalls[1]?.since).toBe(2);

    // 第三条报告 active=false → 收尾
    await vi.advanceTimersByTimeAsync(600);
    const [live] = liveMessages();
    expect(live.process).toHaveLength(2);
    expect(live.durationMs).toBeGreaterThanOrEqual(0);
    expect(refreshCalls).toBe(1);
    expect(useSessionsStore.getState().streams[SESSION_ID]?.status).toBe('idle');

    // 收尾之后不再轮询（否则一条已结束的会话会永远被 600ms 打一次）
    const settledCalls = progressCalls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(progressCalls).toHaveLength(settledCalls);
  });

  it('老网关不认这个端点（unsupported）→ 摘掉占位消息，退回旧行为', async () => {
    responses = [{ ok: false, unsupported: true, known: false, active: false, seq: 0, events: [] }];

    watchChannelTurn({ sessionId: SESSION_ID, channel: CHANNEL, chatId: CHAT_ID });
    await vi.advanceTimersByTimeAsync(0);

    expect(liveMessages()).toHaveLength(0);
    // 不能每 600ms 失败一次
    await vi.advanceTimersByTimeAsync(5000);
    expect(progressCalls).toHaveLength(1);
  });

  it('引擎始终没登记这一轮 → 宽限期后摘掉占位消息', async () => {
    responses = [{ ok: true, known: false, active: false, seq: 0, events: [] }];

    watchChannelTurn({ sessionId: SESSION_ID, channel: CHANNEL, chatId: CHAT_ID });
    await vi.advanceTimersByTimeAsync(0);
    // 宽限期内必须继续等：客户端可能比 `/v1/turn` 的响应早一步开始轮询
    expect(liveMessages()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(liveMessages()).toHaveLength(0);
  });

  it('网关持续不可达 → 摘掉占位消息并停止重试', async () => {
    responses = [
      {
        ok: false,
        known: false,
        active: false,
        seq: 0,
        events: [],
        error: '网关不可达：ECONNREFUSED',
      },
    ];

    watchChannelTurn({ sessionId: SESSION_ID, channel: CHANNEL, chatId: CHAT_ID });
    await vi.advanceTimersByTimeAsync(0);
    // 失败上限是 8 次（≈5 秒）：单次抖动不该让实时过程消失
    await vi.advanceTimersByTimeAsync(600 * 10);

    expect(liveMessages()).toHaveLength(0);
    const calls = progressCalls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(progressCalls).toHaveLength(calls);
  });
});

describe('磁盘刷新与实时观察的互斥', () => {
  /**
   * 这条是整套机制的**功能前提**：引擎开工时就落一次盘（用户消息），
   * 4 秒轮询一看 `updatedAt` 变了就会整份替换会话 —— 占位助手消息随之消失，
   * 实时过程刚出现就断。表现是「看了眼实时思考，一秒后又空了」，全程零报错。
   */
  it('⭐ 实时观察期间跳过整份替换，解除登记后立刻能替换', async () => {
    const summary = {
      key: SESSION_KEY,
      channel: CHANNEL,
      title: '飞书会话',
      preview: '离元旦还有多久',
      messageCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: '2026-10-19T09:00:00.000Z',
    };
    const detail = {
      key: SESSION_KEY,
      channel: CHANNEL,
      title: '飞书会话',
      createdAt: new Date().toISOString(),
      updatedAt: '2026-10-19T09:00:00.000Z',
      messages: [],
    };
    const readDetail = vi
      .spyOn(platform, 'getNanobotChannelSession')
      .mockResolvedValue(detail as never);

    setChannelTurnWatching(SESSION_ID, true);
    await useChannelSessionsStore.getState().refreshActiveIfChanged([summary]);
    expect(readDetail).not.toHaveBeenCalled();

    setChannelTurnWatching(SESSION_ID, false);
    await useChannelSessionsStore.getState().refreshActiveIfChanged([summary]);
    expect(readDetail).toHaveBeenCalledTimes(1);
  });
});
