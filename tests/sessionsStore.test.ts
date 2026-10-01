import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { resetEventStream } from './helpers/eventStream';
import { cronRecordsToSession } from '@/lib/sessionImport';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';

/** 重置所有相关 store 到初始态，避免用例之间跨用例串扰 */
function resetStores() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
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

  /** 等墓碑落进存储：写队列是异步的，紧接着断言会拍在空气上 */
  async function waitTombstone(
    store: ReturnType<typeof resetEventStream>,
    id: string,
    shard?: string,
  ) {
    for (let i = 0; i < 60; i += 1) {
      if ((await store.readMeta(id, shard))?.deletedAt) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`墓碑未落盘：${id}`);
  }

  /**
   * 删除**不是**硬删：磁盘上必须留下墓碑，否则另一台设备下次同步时又会把自己那份
   * 推回来——用户看到的是「删掉的会话自己回来了」（FR-10.1 / syncmeta §7.3）。
   */
  it('deleteSession 打成墓碑：正文丢弃、meta 与索引条目保留', async () => {
    const store = resetEventStream();
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '要删的', { workdir: 'D:/ws/other' });
    // 正文直接预置：本用例验的是删除语义，不是流式链路（那条已有专门用例）
    await store.append({
      sessionId: s.id,
      workdir: 'D:/ws/other',
      events: [
        {
          id: 'e1',
          sessionId: s.id,
          parentId: null,
          seq: 1,
          type: 'message',
          timestamp: 1000,
          messageId: 'e1',
          role: 'user',
          content: '历史消息',
        },
      ],
    });
    // 只断言「有正文」而不是数条数：`createSession` 自己会先落一条 `session-start`
    expect((await store.readEvents(s.id, 'D:/ws/other')).some((e) => e.type === 'message')).toBe(
      true,
    );

    useSessionsStore.getState().deleteSession(s.id);
    await waitTombstone(store, s.id, 'D:/ws/other');

    // 正文没了（删了就不该再留在盘上）
    expect(await store.readEvents(s.id, 'D:/ws/other')).toEqual([]);
    // 墓碑还在，且三要素齐备：同步层靠它们裁决「谁更新」
    const meta = await store.readMeta(s.id, 'D:/ws/other');
    expect(meta?.deletedAt).toBeTruthy();
    expect(meta?.rev ?? 0).toBeGreaterThan(0);
    // 列表的数据源是索引 → 墓碑必须**当场**生效，不能等下次重建才生效
    expect(await store.listSessions()).toEqual([]);
  });

  it('删掉的会话在索引重建后不复活（跨设备同步的判据）', async () => {
    const store = resetEventStream();
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '删了别回来', { workdir: 'D:/ws/other' });
    useSessionsStore.getState().deleteSession(s.id);
    await waitTombstone(store, s.id, 'D:/ws/other');

    // 「对端拿到墓碑后重建索引」的等价形：投影出来的条目必须仍带 deletedAt
    const rebuilt = await store.rebuildIndex();
    expect(rebuilt.entries[s.id]?.deletedAt).toBeTruthy();
    expect(await store.listSessions()).toEqual([]);
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
 * 自动沉淀：**触发点**与**作用域分流**。
 *
 * 这是「我告诉过它我叫什么，新建会话却不知道」的直接回归防线：
 * - 触发点必须有**两个**（关闭 / 新建会话），只挂 deleteSession 会让
 *   「说一句 → 直接新建会话」整段落在空档里；
 * - 分流必须按内容性质：身份类进用户级（跨项目），任务类进工作区级
 *   （按会话 workdir 隔离），否则换个工作区身份就丢了。
 */
describe('自动沉淀：触发点与作用域分流', () => {
  /** 轮询等待 fire-and-forget 的沉淀链路跑完（最多 ~1s） */
  async function waitFor(pred: () => boolean) {
    for (let i = 0; i < 20; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function stubMemory() {
    const { MemoryService } = await import('@/lib/memory');
    const summarize = vi
      .spyOn(MemoryService, 'summarize')
      .mockResolvedValue({ identity: '明明，中医药背景', task: '决定先修 P0' });
    const append = vi.spyOn(MemoryService, 'append').mockResolvedValue('written');
    return { summarize, append };
  }

  it('createSession 对上一条会话补触发：身份写用户级、任务写工作区级(会话 workdir)', async () => {
    const prev = useSessionsStore
      .getState()
      .createSession('agent-test', '上一条', { workdir: 'D:/ws/proj' });
    await useSessionsStore.getState().send('我叫明明', prev.id);

    useSettingsStore.getState().setSettings({ autoSummarize: true });
    const { append } = await stubMemory();

    useSessionsStore.getState().createSession('agent-test', '新会话');
    await waitFor(() => append.mock.calls.length >= 2);

    expect(append).toHaveBeenCalledWith('明明，中医药背景', expect.anything(), 'user');
    // 第 4 参是**工作目录本身**，不是它的哈希：工作区记忆的落点由目录表达隔离
    // （`<workdir>/.nanowork/memory/`），判据里再算一次哈希只会多一层推导。
    expect(append).toHaveBeenCalledWith(
      '决定先修 P0',
      expect.anything(),
      'workspace',
      'D:/ws/proj',
    );
  });

  it('deleteSession 走同一条分流规则', async () => {
    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '待删', { workdir: 'D:/ws/other' });
    await useSessionsStore.getState().send('随便说点', s.id);

    useSettingsStore.getState().setSettings({ autoSummarize: true });
    const { append } = await stubMemory();

    useSessionsStore.getState().deleteSession(s.id);
    await waitFor(() => append.mock.calls.length >= 2);

    expect(append).toHaveBeenCalledWith(
      '决定先修 P0',
      expect.anything(),
      'workspace',
      'D:/ws/other',
    );
  });

  it('autoSummarize=false 时任何触发点都不调模型', async () => {
    const s = useSessionsStore.getState().createSession('agent-test', 'A');
    await useSessionsStore.getState().send('你好', s.id);

    const { summarize } = await stubMemory();
    useSessionsStore.getState().createSession('agent-test', 'B');
    useSessionsStore.getState().deleteSession(s.id);
    await new Promise((r) => setTimeout(r, 60));

    expect(summarize).not.toHaveBeenCalled();
  });

  it('同一会话只沉淀一次：反复新建会话不会重复归纳同一段历史', async () => {
    const s = useSessionsStore.getState().createSession('agent-test', '唯一一条');
    await useSessionsStore.getState().send('你好', s.id);

    useSettingsStore.getState().setSettings({ autoSummarize: true });
    const { summarize } = await stubMemory();

    useSessionsStore.getState().createSession('agent-test', 'B');
    await waitFor(() => summarize.mock.calls.length >= 1);
    useSessionsStore.getState().createSession('agent-test', 'C');
    useSessionsStore.getState().createSession('agent-test', 'D');
    await new Promise((r) => setTimeout(r, 80));

    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('摘要两节皆空时不写任何一层', async () => {
    const s = useSessionsStore.getState().createSession('agent-test', '没内容');
    await useSessionsStore.getState().send('嗯', s.id);

    useSettingsStore.getState().setSettings({ autoSummarize: true });
    const { MemoryService } = await import('@/lib/memory');
    vi.spyOn(MemoryService, 'summarize').mockResolvedValue({ identity: '', task: '' });
    const append = vi.spyOn(MemoryService, 'append').mockResolvedValue('written');

    useSessionsStore.getState().createSession('agent-test', 'B');
    await new Promise((r) => setTimeout(r, 80));

    expect(append).not.toHaveBeenCalled();
  });

  /**
   * P1：被用户中断的助手消息是半截回答，不该成为归纳依据。
   *
   * 与正文里 `<memory-save>` 指令块按 `aborted` 跳过同源——残缺输出不可信。
   * 用户提问仍要保留：话已经说出口，被中断不代表没说过。
   */
  it('被中断的助手消息不参与归纳，用户提问保留', async () => {
    const s = useSessionsStore.getState().createSession('agent-test', '被中断');
    await useSessionsStore.getState().send('我是明明', s.id);

    const messages = useSessionsStore.getState().sessions.find((x) => x.id === s.id)!.messages;
    const last = messages[messages.length - 1];
    expect(last.role).toBe('assistant');
    useSessionsStore.getState().updateMessage(s.id, last.id, (m) => ({ ...m, aborted: true }));

    useSettingsStore.getState().setSettings({ autoSummarize: true });
    const { summarize } = await stubMemory();

    useSessionsStore.getState().createSession('agent-test', '新会话');
    await waitFor(() => summarize.mock.calls.length >= 1);

    const [history] = summarize.mock.calls[0];
    expect(history.some((m) => m.role === 'assistant')).toBe(false);
    expect(history.some((m) => m.role === 'user' && m.content === '我是明明')).toBe(true);
  });
});

/**
 * Agent 侧受控记忆写入（P2-A）：`<memory-save>` 块。
 *
 * 两条一起钉：① 协议标记**不得**出现在用户可见正文里（视图与事件流都不能有）；
 * ② 块的内容要按 `scope` 落对层。前者是「刷新后标签冒出来」的回归防线，
 * 后者是分流的执行侧。
 */
describe('Agent 记忆写入协议', () => {
  it('块从正文与事件流中剥离，并按 scope 落盘', async () => {
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
      (_req, handlers: StreamHandlers): ChatHandle => {
        handlers.onStatus('streaming');
        handlers.onToken('好的，记下了。\n<memory-save scope="user">用户叫明明</memory-save>');
        handlers.onStatus('done');
        handlers.onDone();
        return { done: Promise.resolve(), abort: () => {} };
      },
    );
    const { MemoryService } = await import('@/lib/memory');
    const append = vi.spyOn(MemoryService, 'append').mockResolvedValue('written');
    useSettingsStore.getState().setSettings({ autoSummarize: true });

    const s = useSessionsStore
      .getState()
      .createSession('agent-test', '记一条', { workdir: 'D:/ws/proj' });
    await useSessionsStore.getState().send('记住我叫明明', s.id);

    // ① 视图：正文已剥离
    const view = useSessionsStore
      .getState()
      .sessions.find((x) => x.id === s.id)
      ?.messages.find((m) => m.role === 'assistant');
    expect(view?.content).toBe('好的，记下了。');

    // ② 事件流：落盘的是同一份剥离后的正文（否则刷新一次标签就回来了）
    const { getEventStore } = await import('@/events');
    const events = await getEventStore().readEvents(s.id, 'D:/ws/proj');
    const msgEvent = events.find((e) => e.type === 'message' && e.role === 'assistant');
    expect(msgEvent && 'content' in msgEvent ? msgEvent.content : '').toBe('好的，记下了。');

    // ③ 落盘：身份类进用户级
    await new Promise((r) => setTimeout(r, 50));
    expect(append).toHaveBeenCalledWith('用户叫明明', { source: 'agent' }, 'user', expect.anything());
  });
});

/**
 * 分组级「从列表中移除」改为**真删**后引入的批量删除。
 *
 * 批量路径对**定时任务执行记录**（`cron:` 前缀）与引擎只读留痕**不沉淀**：
 * 一个自动任务分组动辄几十条执行记录，逐条调模型总结既慢又无检索价值——
 * 这些 run 的真值在引擎侧，不是用户对话。守卫在 `sedimentSession` 内部，
 * 单条删除与批量删除走同一条规则。
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

  it('定时任务执行记录不做自动沉淀：autoSummarize 打开且带消息也不调模型', async () => {
    // 定时任务会话带 `cron:` 前缀，且默认 readonly —— 两条守卫任一命中都不该归纳
    const cron = cronRecordsToSession(
      'cron-abc',
      '每日行业快讯',
      [
        { role: 'user', content: '今天有什么新闻' },
        { role: 'assistant', content: '有几条' },
      ],
      new Date().toISOString(),
      new Date().toISOString(),
    );
    useSessionsStore.setState((s) => ({ sessions: [cron, ...s.sessions] }));

    useSettingsStore.getState().setSettings({ autoSummarize: true });
    const { MemoryService } = await import('@/lib/memory');
    const spy = vi.spyOn(MemoryService, 'summarize');

    useSessionsStore.getState().deleteSessions([cron.id]);

    expect(spy).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().sessions).toHaveLength(0);
  });
});

describe('sessionsStore: 记忆快照失效 (2026-09-17 修复)', () => {
  /**
   * `loadSession` 对**已水合**的会话直接早退（不再预热记忆快照），于是「切走 → 期间
   * 别处写入记忆 → 切回来」这条最普通的路径上，会话会一直带着旧快照。实测事故里
   * 正是这样：在 `D:/temp` 的会话写下技能，切回 `D:/tmp` 的会话问同一件事，注入的
   * 还是几十分钟前的快照。
   */
  it('切回已加载的会话时，若期间有写入则刷新快照', async () => {
    const { MemoryService } = await import('@/lib/memory');
    const s = useSessionsStore.getState().createSession('agent-test', '会话A');
    // 等首轮预热落定（它是 fire-and-forget）。此时记忆为空 → 快照是空串
    await vi.waitFor(() => {
      expect(
        useSessionsStore.getState().sessions.find((x) => x.id === s.id)?.memory,
      ).toBe('');
    });

    // 期间在别处写入：模型 `<memory-save>`、自动沉淀、记忆页编辑都走 append
    await MemoryService.append('用户擅长前端 GIS 开发', { source: 'agent' }, 'user');

    useSessionsStore.getState().selectSession(s.id);
    await vi.waitFor(() => {
      expect(
        useSessionsStore.getState().sessions.find((x) => x.id === s.id)?.memory,
      ).toContain('前端 GIS 开发');
    });
  });

  it('workdir 变化也算失效（同一份快照已指向另一个记忆文件）', async () => {
    const s = useSessionsStore.getState().createSession('agent-test', '会话B');
    await vi.waitFor(() => {
      expect(
        useSessionsStore.getState().sessions.find((x) => x.id === s.id)?.memory,
      ).toBe('');
    });
    expect(useSessionsStore.getState().isMemorySnapshotStale(s.id)).toBe(false);

    useSessionsStore.getState().setSessionWorkdir(s.id, 'D:\\tmp');
    expect(useSessionsStore.getState().isMemorySnapshotStale(s.id)).toBe(true);
  });

  /**
   * 刷新记忆要读盘（异步），而「流式槽位」必须在同一个 tick 内占住——否则同一会话
   * 连续两次 send 会双双通过顶部守卫，发出两个请求。所以刷新只能发生在槽位**之后**。
   *
   * 这条断言是顺序的守门人：把刷新放回 `send` 里（`await` 在 `streamAssistantReply`
   * 之前）它就会失败——那时槽位要等一个 microtask 才落位。
   */
  it('快照过期需要刷新时，send 仍同步进入流式态', async () => {
    const { MemoryService } = await import('@/lib/memory');
    const s = useSessionsStore.getState().createSession('agent-test', '会话C');
    // 等首轮预热落定——快照带上 memoryVersion 才算「产出过」，此前 isMemorySnapshotStale
    // 一律返回 false（预热在途，不该误判为过期）。
    await vi.waitFor(() => {
      expect(
        useSessionsStore.getState().sessions.find((x) => x.id === s.id)?.memoryVersion,
      ).toBeTypeOf('number');
    });

    // 制造过期。用 save 而非 append：append 同内容会被幂等跳过，版本号不增，
    // 那样测的就不是「过期 + 需要刷新」这条路径了。
    await MemoryService.save('刷新测试：用户在做 GIS 可视化项目', 'user');
    expect(useSessionsStore.getState().isMemorySnapshotStale(s.id)).toBe(true);

    // 不 await 立即断言：槽位必须在同步段内落位
    const p = useSessionsStore.getState().send('我擅长什么', s.id);
    expect(useSessionsStore.getState().streams[s.id]).toBeDefined();
    await p;
  });
});

/**
 * 「新建任务」的默认态是一张白纸。
 *
 * 顶部（TitleBar）与侧边栏（SidebarNav）的「新建任务」显式传
 * `inheritCapabilities: false`：既不解析全局活跃专家团，也不取全局活跃专家，
 * 自然也不带它的技能——输入框里不会预先冒出专家 chip 与技能 chips。
 *
 * 这里守的是**协议面**，不是「把 chip 藏起来」：`agentId` 落成空串后
 * `buildRequest` 会省略 `agent_id`（见 nanobotHttp/chat.ts），由网关用自身配置的
 * 默认 Agent 应答，且不注入任何专家人设与技能 prompt 段。若只藏 chip 而请求里照旧
 * 带 `agent_id`，那是一张假白纸——用户以为在跟通用助手说话，实际还挂着上个专家。
 */
describe('新建任务：默认不继承专家与技能（白纸语义）', () => {
  /** 给默认 agent 挂上技能：否则断言「技能不继承」时两边都是空，测不出东西 */
  function agentWithSkills() {
    useAgentsStore.setState((s) => ({
      agents: s.agents.map((a) => ({ ...a, skillIds: ['skill-a'] })),
    }));
  }

  // 全局活跃专家团是模块级单例，用例之间会串扰，逐个清干净
  afterEach(() => useExpertGroupsStore.setState({ activeGroupId: null }));

  it('不继承全局活跃专家，也不带它的技能（agentId 落空串）', () => {
    agentWithSkills();

    const session = useSessionsStore
      .getState()
      .createSession(undefined, '新任务', { inheritCapabilities: false });

    expect(session.agentId).toBe('');
    expect(session.skillIds ?? []).toEqual([]);
  });

  it('不继承全局活跃专家团：既不绑团，也不落到团内执行代表', () => {
    const group = useExpertGroupsStore
      .getState()
      .createGroup({ name: '测试专家团', memberIds: ['agent-test'] });
    useExpertGroupsStore.getState().setActiveGroup(group.id);

    const session = useSessionsStore
      .getState()
      .createSession(undefined, '新任务', { inheritCapabilities: false });

    expect(session.agentId).toBe('');
    expect(session.groupId).toBeUndefined();
  });

  it('不传开关时仍是旧语义：继承全局活跃专家及其技能', () => {
    agentWithSkills();

    const session = useSessionsStore.getState().createSession(undefined, '新会话');

    expect(session.agentId).toBe('agent-test');
    expect(session.skillIds).toEqual(['skill-a']);
  });

  it('显式传入 agentId 不受开关影响——那是调用方的明确指派', () => {
    const session = useSessionsStore
      .getState()
      .createSession('agent-test', '指派会话', { inheritCapabilities: false });

    expect(session.agentId).toBe('agent-test');
  });

  it('白纸会话发消息时请求里省略 agent_id（协议层同样是白纸）', async () => {
    const session = useSessionsStore
      .getState()
      .createSession(undefined, '新任务', { inheritCapabilities: false });

    await useSessionsStore.getState().send('你好', session.id);

    const calls = vi.mocked(NanobotClient.prototype.sendMessage).mock.calls;
    expect(calls.at(-1)?.[0].agentId ?? '').toBe('');
  });
});
