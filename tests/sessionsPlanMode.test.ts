/**
 * 执行模式与计划审批的行为测试（M2 / FR-1.4 / FR-1.5）。
 *
 * 覆盖三个层面，每层回答一个问题：
 *
 * | 层 | 问题 | 手段 |
 * |---|---|---|
 * | 请求面 | 模式有没有真的随每一轮请求发给引擎？ | 捕获 `ChatRequest` |
 * | 事件面 | 模式切换 / 计划 / 裁决有没有落盘？ | 读事件流 |
 * | 视图面 | 刷新后还能不能原样看到待裁决的计划？ | 实时视图 ≡ 重放投影 |
 *
 * 第三层是本文件的重点：计划是**唯一需要用户做决定**的产物，若它只活在内存里，
 * 刷新即消失，用户就再也无法批准那份已经摆在眼前的计划。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { waitForSessionWrites, type EventStore } from '@/events';
import { projectSession } from '@/events/project';
import { resetEventStream } from './helpers/eventStream';
import type { ChatHandle, ChatRequest, PlanProposal, StreamHandlers } from '@/ai/runtime/types';
import type { SessionEvent } from '@/types/event';
import { DEFAULT_MEMORY_POLICY } from '@/types';

let store: EventStore;
/** 最近一次请求的 `sessionMode`（用于在 UI 之外验证「模式真的发出了」） */
let capturedRequests: ChatRequest[] = [];

const PLAN: PlanProposal = {
  planId: 'plan-test-1',
  steps: [
    { id: 's1', text: '读一遍现有实现', status: 'pending' },
    { id: 's2', text: '写下改动方案', status: 'pending' },
  ],
};

function resetStores() {
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
  useArtifactsStore.setState({ bySession: {} });
  capturedRequests = [];
  store = resetEventStream();
}

/**
 * 模拟网关：
 * - 用户对 LEVEL 里含「计划」的一轮 → 下发一份计划（`kind=plan`）；
 * - 其余 → 纯文本回复。
 *
 * 刻意按**文本内容**分支而不是「第几次调用」：后者在 `execute: true` 触发第二
 * 轮时会错开一次计数，让测试变成对调用顺序的脆弱断言。
 */
function mockPlanGateway() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
      capturedRequests.push(req);
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
      handlers.onStatus('thinking');
      if (/计划/.test(text)) {
        handlers.onToken('我先给出一份计划。');
        handlers.onPlan?.(PLAN);
      } else {
        handlers.onToken('好的，已执行。');
      }
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

async function settle(sessionId: string) {
  await waitForSessionWrites(sessionId);
  await new Promise((r) => setTimeout(r, 0));
}

function eventsOf(sessionId: string): Promise<SessionEvent[]> {
  return store.readEvents(sessionId);
}

beforeEach(() => {
  resetStores();
  mockPlanGateway();
  useAgentsStore.setState({
    agents: [
      {
        id: 'agent-test',
        name: '测试智能体',
        systemPrompt: '你是测试助手',
        skillIds: [],
        imBinding: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ],
    activeAgentId: 'agent-test',
  });
});

afterEach(() => vi.restoreAllMocks());

describe('执行模式（FR-1.4）', () => {
  it('会话可建在指定模式，并随 session-start 与 meta 落盘', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '计划会话', {
      mode: 'plan',
    });
    await settle(session.id);

    expect(session.mode).toBe('plan');
    const events = await eventsOf(session.id);
    const start = events.find((e) => e.type === 'session-start');
    expect(start).toMatchObject({ mode: 'plan' });
    expect(await store.readMeta(session.id)).toMatchObject({ mode: 'plan' });
  });

  it('默认会话按 craft 记账（旧会话无需迁移）', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '普通会话');
    await settle(session.id);
    expect(session.mode).toBeUndefined();
    expect(await store.readMeta(session.id)).toMatchObject({ mode: 'craft' });
  });

  it('模式随每一轮请求下发给引擎', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '提问模式', {
      mode: 'ask',
    });
    await useSessionsStore.getState().send('这是什么', session.id);
    await settle(session.id);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].sessionMode).toBe('ask');
  });

  it('切换模式落 mode-change 事件并刷新 meta；重复切换到同一值不记事件', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '切换会话');
    await settle(session.id);

    useSessionsStore.getState().setSessionMode(session.id, 'plan');
    useSessionsStore.getState().setSessionMode(session.id, 'plan');
    useSessionsStore.getState().setSessionMode(session.id, 'ask');
    await settle(session.id);

    const events = await eventsOf(session.id);
    const changes = events.filter((e) => e.type === 'mode-change');
    expect(changes).toEqual([
      expect.objectContaining({ from: 'craft', to: 'plan' }),
      expect.objectContaining({ from: 'plan', to: 'ask' }),
    ]);
    expect(useSessionsStore.getState().sessions[0].mode).toBe('ask');
    expect(await store.readMeta(session.id)).toMatchObject({ mode: 'ask' });
  });

  it('重放后模式与切换前一致（否则用户会以为自己在 Plan 里）', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '重放会话');
    useSessionsStore.getState().setSessionMode(session.id, 'plan');
    await settle(session.id);

    const meta = await store.readMeta(session.id);
    const replayed = projectSession(meta!, await eventsOf(session.id));
    expect(replayed.mode).toBe('plan');
  });
});

describe('计划审批（FR-1.5）', () => {
  /** 在 plan 模式下跑一轮，返回会话 id 与挂载计划的助手消息 id */
  async function runPlanTurn() {
    const session = useSessionsStore.getState().createSession('agent-test', '计划会话', {
      mode: 'plan',
    });
    await useSessionsStore.getState().send('帮我计划一下重构', session.id);
    await settle(session.id);
    const assistant = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === session.id)!
      .messages.find((m) => m.role === 'assistant')!;
    return { sessionId: session.id, messageId: assistant.id };
  }

  it('计划挂到助手消息上，并以 plan 事件落盘', async () => {
    const { sessionId, messageId } = await runPlanTurn();

    const live = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)!;
    const liveAssistant = live.messages.find((m) => m.id === messageId)!;
    expect(liveAssistant.plan).toEqual({
      planId: 'plan-test-1',
      steps: PLAN.steps,
      status: 'pending',
    });

    const recorded = (await eventsOf(sessionId)).find(
      (e) => e.type === 'plan',
    );
    expect(recorded).toMatchObject({ planId: 'plan-test-1', messageId });
  });

  it('批准切到 Craft 并把批准范围作为一轮用户消息发出', async () => {
    const { sessionId, messageId } = await runPlanTurn();

    const ok = await useSessionsStore.getState().resolvePlan('plan-test-1', 'approved', {
      approvedStepIds: ['s1'],
      execute: true,
    });
    expect(ok).toBe(true);

    const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)!;
    expect(session.mode).toBe('craft');
    const assistant = session.messages.find((m) => m.id === messageId)!;
    expect(assistant.plan).toMatchObject({ status: 'approved', approvedStepIds: ['s1'] });

    // 批准后的执行轮：范围被显式写进用户消息，而不是一句「用户批准了计划」
    const followUp = session.messages.filter((m) => m.role === 'user');
    expect(followUp).toHaveLength(2);
    expect(followUp[1].content).toContain('1. 读一遍现有实现');
    expect(followUp[1].content).not.toContain('写下改动方案');
    // 第二轮请求必须是 craft，否则执行不了
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[1].sessionMode).toBe('craft');
  });

  it('仅批准不自动执行：只切模式、不新增用户消息', async () => {
    const { sessionId } = await runPlanTurn();

    await useSessionsStore.getState().resolvePlan('plan-test-1', 'approved');

    const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)!;
    expect(session.mode).toBe('craft');
    expect(session.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(capturedRequests).toHaveLength(1);
  });

  it('打回留在 Plan 模式并记录意见；已裁决的计划不得二次裁决', async () => {
    const { sessionId, messageId } = await runPlanTurn();

    const first = await useSessionsStore.getState().resolvePlan('plan-test-1', 'rejected', {
      reason: '范围太大，先只改渲染层',
    });
    const second = await useSessionsStore.getState().resolvePlan('plan-test-1', 'approved');
    expect(first).toBe(true);
    expect(second).toBe(false);

    const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)!;
    // 打回不切模式：用户还要在 Plan 里继续讨论修订版
    expect(session.mode).toBe('plan');
    expect(session.messages.find((m) => m.id === messageId)!.plan).toMatchObject({
      status: 'rejected',
      reason: '范围太大，先只改渲染层',
    });
  });

  it('待裁决的计划：实时视图 ≡ 重放投影（刷新后仍可批准）', async () => {
    const { sessionId } = await runPlanTurn();

    const before = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)!;
    const meta = await store.readMeta(sessionId);
    const replayed = projectSession(meta!, await eventsOf(sessionId));

    expect(replayed.messages).toEqual(before.messages);

    // 更强的断言：重放出来的这份计划**仍然可以被批准**——
    // 它必须是一个 pending 状态、步骤完整的对象，而不是一份只读的历史记录
    const plan = replayed.messages.find((m) => m.role === 'assistant')!.plan!;
    expect(plan.status).toBe('pending');
    expect(plan.steps).toHaveLength(2);
  });

  it('裁决后的计划同样可重放（含批准范围与理由）', async () => {
    const { sessionId } = await runPlanTurn();
    await useSessionsStore.getState().resolvePlan('plan-test-1', 'approved', {
      approvedStepIds: ['s2'],
    });
    await settle(sessionId);

    const live = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)!;
    const meta = await store.readMeta(sessionId);
    const replayed = projectSession(meta!, await eventsOf(sessionId));

    expect(replayed.messages).toEqual(live.messages);
    expect(replayed.messages.find((m) => m.role === 'assistant')!.plan).toMatchObject({
      status: 'approved',
      approvedStepIds: ['s2'],
    });
  });
});
