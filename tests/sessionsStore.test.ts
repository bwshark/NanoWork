import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { resetEventStream } from './helpers/eventStream';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';

/** 重置所有相关 store 到初始态，避免用例之间跨用例串扰 */
function resetStores() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      memoryEnabled: true,
      autoSummarize: false,
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
  // 会话数据只走事件流：每个用例都换一份干净的内存事件存储 + 清空记录器
  resetEventStream();
}

/**
 * 模拟网关流式行为：
 * - 文本含「读文件」→ 下发逐条批准请求（引擎在工具执行前挂起，等裁决回传）；
 * - 其余 → 纯文本流式回复。
 */
function mockGateway() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (req, handlers: StreamHandlers): ChatHandle => {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
      handlers.onStatus('thinking');

      if (/读文件/.test(text)) {
        handlers.onStatus('streaming');
        handlers.onToken('好的，我来读取文件。\n');
        handlers.onApprovalRequest?.({
          id: 'appr-files-1',
          tool: 'files',
          args: { operation: 'read', path: '/workspace/sample.txt' },
        });
        // 真实引擎此刻阻塞在工具执行前、流不会结束；测试在此收尾，
        // 后续状态由 store 的 resolveApproval 驱动。
        handlers.onStatus('done');
        handlers.onDone();
        return { done: Promise.resolve(), abort: () => {} };
      }

      handlers.onStatus('streaming');
      handlers.onToken('你好，我是测试回复。');
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

beforeEach(() => {
  resetStores();
  mockGateway();
  // 确保至少有一个 agent 供会话绑定
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

describe('sessionsStore: 会话发送与流式 (FR-001)', () => {
  it('send 后生成 user + assistant 消息，并流式累积文本到 assistant', async () => {
    const store = useSessionsStore.getState();
    await store.send('你好，请介绍一下你自己');

    const state = useSessionsStore.getState();
    expect(state.sessions).toHaveLength(1);
    const session = state.sessions[0];
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].content).toContain('测试回复');
    expect(state.streams).toEqual({});
    expect(state.error).toBeNull();
  });

  it('多会话可并发流式：一个会话流式不阻塞其他会话发送', async () => {
    // 让网关流「挂起」，直到测试手动放行，用于观察并发状态
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
      (_req, handlers: StreamHandlers): ChatHandle => {
        handlers.onStatus('thinking');
        let resolveDone!: () => void;
        const done = new Promise<void>((r) => {
          resolveDone = r;
        });
        void gate.then(() => {
          handlers.onStatus('streaming');
          handlers.onToken('并发回复');
          handlers.onStatus('done');
          handlers.onDone();
          resolveDone();
        });
        return { done, abort: () => {} };
      },
    );

    const s1 = useSessionsStore.getState().createSession('agent-test', '会话A');
    const s2 = useSessionsStore.getState().createSession('agent-test', '会话B');

    // 会话A 发起流式（不等待完成）
    const p1 = useSessionsStore.getState().send('第一条', s1.id);
    // 会话B 应能同时发起，不被全局锁拦截
    const p2 = useSessionsStore.getState().send('第二条', s2.id);

    // 两个会话均处于流式中
    const mid = useSessionsStore.getState();
    expect(mid.streams[s1.id]).toBeDefined();
    expect(mid.streams[s2.id]).toBeDefined();

    // 同一会话重复发送应被拒绝（返回 null）
    const dup = await useSessionsStore.getState().send('重复', s1.id);
    expect(dup).toBeNull();

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.error).toBeNull();
    expect(r2?.error).toBeNull();

    const after = useSessionsStore.getState();
    expect(after.streams).toEqual({});
    const a1 = after.sessions.find((s) => s.id === s1.id)!;
    const a2 = after.sessions.find((s) => s.id === s2.id)!;
    expect(a1.messages.at(-1)?.content).toContain('并发回复');
    expect(a2.messages.at(-1)?.content).toContain('并发回复');
  });
});

describe('sessionsStore: 逐条批准 (FR-1.5)', () => {
  it('引擎挂起时入队并落 pending 行；允许后回传裁决并写入权限日志', async () => {
    const respond = vi
      .spyOn(NanobotClient.prototype, 'respondApproval')
      .mockResolvedValue(undefined);

    const session = useSessionsStore
      .getState()
      .createSession('agent-test', '逐条批准会话', { toolApproval: true });

    await useSessionsStore.getState().send('请帮我读文件 /workspace/sample.txt', session.id);

    const queued = useSessionsStore.getState();
    expect(queued.pendingApprovals).toHaveLength(1);
    expect(queued.pendingApprovals[0].tool).toBe('files');
    expect(queued.pendingApprovals[0].sessionId).toBe(session.id);

    const before = queued.sessions
      .find((s) => s.id === session.id)!
      .messages.find((m) => m.role === 'assistant')!;
    expect(before.toolCalls?.find((t) => t.tool === 'files')?.status).toBe('pending');

    await useSessionsStore.getState().resolveApproval('allow');

    expect(respond).toHaveBeenCalledWith('appr-files-1', 'allow', undefined);
    const after = useSessionsStore.getState();
    expect(after.pendingApprovals).toHaveLength(0);
    const cur = after.sessions.find((s) => s.id === session.id)!;
    const assistant = cur.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.toolCalls?.find((t) => t.tool === 'files')?.status).toBe('approved');
    expect(cur.permissionLog.some((l) => l.decision === 'approved')).toBe(true);
  });

  it('拒绝时把原因回传给引擎并记录 rejected', async () => {
    const respond = vi
      .spyOn(NanobotClient.prototype, 'respondApproval')
      .mockResolvedValue(undefined);

    await useSessionsStore.getState().send('请帮我读文件 /workspace/sample.txt');
    await useSessionsStore.getState().resolveApproval('deny', '这个文件不该读');

    expect(respond).toHaveBeenCalledWith('appr-files-1', 'deny', '这个文件不该读');
    const after = useSessionsStore.getState();
    const session = after.sessions[0];
    const assistant = session.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.toolCalls?.find((t) => t.tool === 'files')?.status).toBe('rejected');
    expect(session.permissionLog.some((l) => l.decision === 'rejected')).toBe(true);
    expect(after.pendingApprovals).toHaveLength(0);
  });

  it('裁决回传失败（请求已超时/失效）时仍出队，不假装授权成功', async () => {
    vi.spyOn(NanobotClient.prototype, 'respondApproval').mockRejectedValue(
      new Error('该工具调用已失效（可能已超时或被取消），请重新发起'),
    );

    await useSessionsStore.getState().send('请帮我读文件 /workspace/sample.txt');
    await useSessionsStore.getState().resolveApproval('allow');

    const after = useSessionsStore.getState();
    expect(after.pendingApprovals).toHaveLength(0);
    // 队列清空，用户不会被一条死请求反复拦住
    expect(after.pendingApprovals).toEqual([]);
  });

  it('空队列时 resolveApproval 静默 no-op', async () => {
    const respond = vi.spyOn(NanobotClient.prototype, 'respondApproval');
    await useSessionsStore.getState().resolveApproval('allow');
    expect(respond).not.toHaveBeenCalled();
  });

  it('逐条批准开关透传为请求级 approval_mode=ask；完全访问覆盖之', async () => {
    const reqs: ChatRequest[] = [];
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
      (req, handlers: StreamHandlers): ChatHandle => {
        reqs.push(req);
        handlers.onStatus('streaming');
        handlers.onToken('ok');
        handlers.onStatus('done');
        handlers.onDone();
        return { done: Promise.resolve(), abort: () => {} };
      },
    );

    const approvalSession = useSessionsStore
      .getState()
      .createSession('agent-test', '逐条批准', { toolApproval: true });
    await useSessionsStore.getState().send('hi', approvalSession.id);
    expect(reqs[0].approvalMode).toBe('ask');

    // 完全访问是更粗的开关：开启后不再逐条询问，两开关不叠加
    const fullSession = useSessionsStore
      .getState()
      .createSession('agent-test', '完全访问', { toolApproval: true, fullAccess: true });
    await useSessionsStore.getState().send('hi', fullSession.id);
    expect(reqs[1].approvalMode).toBeUndefined();
    expect(reqs[1].accessMode).toBe('full');
  });
});

describe('sessionsStore: 会话 CRUD', () => {
  it('createSession / selectSession / deleteSession 行为正确', () => {
    const s1 = useSessionsStore.getState().createSession('agent-test', '会话A');
    const s2 = useSessionsStore.getState().createSession('agent-test', '会话B');
    expect(useSessionsStore.getState().sessions).toHaveLength(2);
    expect(useSessionsStore.getState().activeId).toBe(s2.id);

    useSessionsStore.getState().selectSession(s1.id);
    expect(useSessionsStore.getState().activeId).toBe(s1.id);

    useSessionsStore.getState().deleteSession(s1.id);
    const after = useSessionsStore.getState();
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0].id).toBe(s2.id);
    // 删除当前激活会话后回退到剩余第一条
    expect(after.activeId).toBe(s2.id);
  });

  it('retry 复用最后一条 user 消息重新发送', async () => {
    await useSessionsStore.getState().send('你好');
    const before = useSessionsStore.getState().sessions[0].messages.length;
    await useSessionsStore.getState().retry();
    const after = useSessionsStore.getState().sessions[0].messages.length;
    // 重试应再追加 user+assistant 两条
    expect(after).toBe(before + 2);
  });
});

describe('sessionsStore: 记忆注入 (T22~T28)', () => {
  it('createSession 在存在记忆时异步回填 session.memory 并置 memoryLoaded', async () => {
    // 预先写入一条记忆
    const { MemoryService } = await import('@/lib/memory');
    await MemoryService.save('> [2025-01-01T00:00:00.000Z] 来自「测试」\n> 用户偏好中文');

    const session = useSessionsStore.getState().createSession('agent-test', '带记忆会话');
    // 轮询等待 fire-and-forget 的 loadMemoryInto 完成（最多 ~1s）
    for (let i = 0; i < 20; i++) {
      const cur = useSessionsStore.getState().sessions.find((s) => s.id === session.id);
      if (cur?.memory) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const loaded = useSessionsStore.getState().sessions.find((s) => s.id === session.id);
    expect(loaded?.memory).toBeTruthy();
    expect(loaded?.memory).toContain('用户偏好中文');

    const mem = useSessionsStore.getState().memoryLoaded;
    expect(mem.injected).toBe(true);
    expect(mem.count).toBeGreaterThanOrEqual(1);
    expect(mem.dismissed).toBe(false);
  });

  it('dismissMemoryBar 关闭提示条', async () => {
    const { MemoryService } = await import('@/lib/memory');
    await MemoryService.save('> [2025-01-01T00:00:00.000Z] 来自「t」\n> 记忆内容');
    useSessionsStore.getState().createSession('agent-test', '会话x');
    await new Promise((r) => setTimeout(r, 50));

    useSessionsStore.getState().dismissMemoryBar();
    expect(useSessionsStore.getState().memoryLoaded.dismissed).toBe(true);
  });

  it('memoryEnabled=false 时 createSession 不加载记忆', async () => {
    useSettingsStore.getState().setSettings({ memoryEnabled: false });
    const { MemoryService } = await import('@/lib/memory');
    await MemoryService.save('> [2025-01-01T00:00:00.000Z] 来自「t」\n> 不应被加载');

    const session = useSessionsStore.getState().createSession('agent-test', '会话y');
    await new Promise((r) => setTimeout(r, 50));

    const loaded = useSessionsStore.getState().sessions.find((s) => s.id === session.id);
    expect(loaded?.memory).toBeUndefined();
    expect(useSessionsStore.getState().memoryLoaded.injected).toBe(false);
  });
});

/**
 * 分组级「从列表中移除」改为**真删**后引入的批量删除。
 *
 * 与单条 `deleteSession` 的关键差别：批量路径**刻意不做自动沉淀**——
 * 一个自动任务分组动辄几十条执行记录，逐条调模型总结既慢又无检索价值。
 * 这里把这个「不做」也钉成断言，避免以后有人「顺手对齐」单条逻辑。
 */
describe('deleteSessions：分组级批量删除', () => {
  it('一次删掉整组会话，其它会话不受影响', () => {
    const a = useSessionsStore.getState().createSession('agent-test', '自动任务-09-06 (09:00)');
    const b = useSessionsStore.getState().createSession('agent-test', '自动任务-09-06 (10:00)');
    const keep = useSessionsStore.getState().createSession('agent-test', '保留的会话');

    useSessionsStore.getState().deleteSessions([a.id, b.id]);

    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual([keep.id]);
  });

  it('活跃会话被删时退回列表首位；未删到活跃会话则保持不动', () => {
    const a = useSessionsStore.getState().createSession('agent-test', 'A');
    const b = useSessionsStore.getState().createSession('agent-test', 'B');
    useSessionsStore.getState().selectSession(b.id);

    useSessionsStore.getState().deleteSessions([a.id]);
    expect(useSessionsStore.getState().activeId).toBe(b.id);

    useSessionsStore.getState().deleteSessions([b.id]);
    expect(useSessionsStore.getState().activeId).toBeNull();
  });

  it('空数组与全部未命中都不改动 state（避免无意义重渲染）', () => {
    useSessionsStore.getState().createSession('agent-test', 'A');
    const before = useSessionsStore.getState().sessions;

    useSessionsStore.getState().deleteSessions([]);
    expect(useSessionsStore.getState().sessions).toBe(before);

    useSessionsStore.getState().deleteSessions(['不存在的会话']);
    expect(useSessionsStore.getState().sessions).toBe(before);
  });

  it('不做自动沉淀：autoSummarize 打开且会话有消息时也不调模型', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', 'A');
    await useSessionsStore.getState().send('你好，请介绍一下你自己', session.id);

    useSettingsStore.getState().setSettings({ autoSummarize: true });
    const { MemoryService } = await import('@/lib/memory');
    const spy = vi.spyOn(MemoryService, 'summarize');

    useSessionsStore.getState().deleteSessions([session.id]);

    expect(spy).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().sessions).toHaveLength(0);
  });
});
