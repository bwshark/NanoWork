import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useSettingsStore, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { resetEventStream } from '../helpers/eventStream';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

/**
 * 「跑了一半才断」的轮次必须自报家门。
 *
 * ## 锁住的是什么
 *
 * 静默超时（网关在超时窗口内一个字节都没吐）走的是 `onError`，**不是**
 * `onInterrupted`。若只认后者，这一轮就会既留下正文、又在消息头显示「已完成」——
 * 而事实是最后那一步工具的结果根本没回来。
 *
 * 2026-10-01 报障就是这个形态：会话写着「已完成 11m52s」，最后一行却永远在转圈
 * （客户端 120s 静默超时掐断了一轮仍在跑 `exec` 的回合；事件流里 3 条
 * `function-call` 只配到 2 条 `function-call-result`）。
 *
 * ## 为什么判据要带「是否已经产出过东西」
 *
 * 一开口就连不上（没有任何正文与过程行）属于彻底的连接失败，走 toast 即可；
 * 把它标成「被引擎中断」会让用户以为「回答写了一半」，那是另一种误导。
 */

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
      transcription: {
        enabled: false,
        endpoint: '',
        model: 'whisper-1',
        apiToken: '',
        language: 'zh',
      },
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
  resetEventStream();
}

/**
 * 网关桩：按 `script` 决定这一轮怎么走。
 *
 * 两种脚本共用同一份「先产出、再报错」的骨架——差别只在产出多少。
 */
function mockGateway(script: (handlers: StreamHandlers) => void) {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (_req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
      handlers.onStatus('thinking');
      script(handlers);
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

/** 助手消息（send 之后会话里的最后一条） */
function assistantMessage() {
  const msgs = useSessionsStore.getState().sessions[0]?.messages ?? [];
  return msgs.filter((m) => m.role === 'assistant').at(-1);
}

beforeEach(() => {
  resetStores();
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

describe('sessionsStore.send：部分产出后中断（静默超时）', () => {
  it('已有正文与工具行时报错 → 消息标记 interrupted（不再显示「已完成」）', async () => {
    mockGateway((handlers) => {
      handlers.onToken?.('我来创建一个小游戏');
      handlers.onProcessTool?.({
        id: 'call-1',
        tool: 'exec',
        args: { command: 'python verify.py' },
        phase: 'start',
      });
      // 引擎此后再无任何数据 → 客户端静默超时，走的是 onError 而非 onInterrupted
      handlers.onError(new Error('响应超时：已收到部分结果，但此后 121 秒无新数据。'));
    });

    await useSessionsStore.getState().send('写一个游戏');

    const msg = assistantMessage();
    expect(msg?.interrupted, '部分产出的轮次必须标记为中断').toBe(true);
    // 与「用户按了停止」区分开：这不是 abort
    expect(msg?.aborted).toBeFalsy();
    expect(useSessionsStore.getState().error).toContain('响应超时');
  });

  it('只有工具行、还没有正文时报错 → 同样标记 interrupted', async () => {
    mockGateway((handlers) => {
      handlers.onProcessTool?.({
        id: 'call-1',
        tool: 'exec',
        args: { command: 'python verify.py' },
        phase: 'start',
      });
      handlers.onError(new Error('响应超时：已收到部分结果，但此后 120 秒无新数据。'));
    });

    await useSessionsStore.getState().send('跑一下');

    expect(assistantMessage()?.interrupted).toBe(true);
  });

  it('一开口就连不上（无任何产出）→ 不标记 interrupted（那是连接失败，不是半截回答）', async () => {
    mockGateway((handlers) => {
      handlers.onError(new Error('响应超时：120 秒内网关没有返回任何内容。'));
    });

    await useSessionsStore.getState().send('在吗');

    const msg = assistantMessage();
    expect(msg?.interrupted, '零产出不该被说成「回答写了一半」').toBeFalsy();
    expect(useSessionsStore.getState().error).toContain('响应超时');
  });

  it('未收到结果的工具行在数据层仍保持 running（视图层据「回合已结束」呈现，不篡改数据）', async () => {
    mockGateway((handlers) => {
      handlers.onProcessTool?.({
        id: 'call-1',
        tool: 'exec',
        args: { command: 'python verify.py' },
        phase: 'start',
      });
      handlers.onError(new Error('响应超时'));
    });

    await useSessionsStore.getState().send('跑一下');

    const rows = (assistantMessage()?.process ?? []).filter((e) => e.kind === 'tool');
    expect(rows).toHaveLength(1);
    // 事件流里确实没有结果事件 —— 数据如实记录「没等到结果」，
    // 「不再转圈」是渲染层根据 `live` 做的判断，不是把数据改成 done。
    expect(rows[0].status).toBe('running');
  });
});
