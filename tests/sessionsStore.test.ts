import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/nanobotClient';
import type { ChatHandle, StreamHandlers } from '@/ai/types';

/** 重置所有相关 store 到初始态，避免 persist 跨用例串扰 */
function resetStores() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      memoryEnabled: true,
      autoSummarize: false,
      transcription: DEFAULT_TRANSCRIPTION,
    },
    status: 'offline',
  });
  useSessionsStore.setState({
    sessions: [],
    activeId: null,
    streams: {},
    pendingPermission: null,
    error: null,
  });
  useArtifactsStore.setState({ bySession: {} });
}

/**
 * 模拟网关流式行为：
 * - 文本含「读文件」→ 下发敏感工具 files 的 pending 事件（等待前端权限决策）；
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
        handlers.onToolCall({
          id: 'call-files-1',
          tool: 'files',
          args: { operation: 'read', path: '/workspace/sample.txt' },
          sensitive: true,
          status: 'pending',
        });
        // 真实网关会等待前端 approval 回执后继续；测试在此结束流，
        // 后续状态由 store 的 approve/reject 驱动。
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

describe('sessionsStore: 敏感工具权限门控 (FR-009)', () => {
  it('敏感工具触发 pending 弹窗，批准后写入权限日志', async () => {
    await useSessionsStore.getState().send('请帮我读文件 /workspace/sample.txt');

    const state = useSessionsStore.getState();
    expect(state.pendingPermission).not.toBeNull();

    useSessionsStore.getState().approvePermission();

    const after = useSessionsStore.getState();
    const session = after.sessions[0];
    const assistant = session.messages.find((m) => m.role === 'assistant')!;

    const fileCall = assistant.toolCalls?.find((t) => t.tool === 'files');
    expect(fileCall).toBeDefined();
    expect(fileCall!.status).toBe('approved');
    expect(session.permissionLog.some((l) => l.decision === 'approved')).toBe(true);
    expect(after.pendingPermission).toBeNull();
  });

  it('敏感工具被拒绝后写入 rejected 日志', async () => {
    await useSessionsStore.getState().send('请帮我读文件 /workspace/sample.txt');

    useSessionsStore.getState().rejectPermission();

    const after = useSessionsStore.getState();
    const session = after.sessions[0];
    const assistant = session.messages.find((m) => m.role === 'assistant')!;

    const fileCall = assistant.toolCalls?.find((t) => t.tool === 'files');
    expect(fileCall?.status).toBe('rejected');
    expect(session.permissionLog.some((l) => l.decision === 'rejected')).toBe(true);
    expect(after.pendingPermission).toBeNull();
  });

  it('会话开启完全访问时敏感工具自动批准，不弹窗', async () => {
    const session = useSessionsStore
      .getState()
      .createSession('agent-test', '完全访问会话', { fullAccess: true });

    await useSessionsStore.getState().send('请帮我读文件 /workspace/sample.txt');

    const after = useSessionsStore.getState();
    const cur = after.sessions.find((s) => s.id === session.id)!;
    const assistant = cur.messages.find((m) => m.role === 'assistant')!;

    const fileCall = assistant.toolCalls?.find((t) => t.tool === 'files');
    expect(fileCall?.status).toBe('approved');
    expect(after.pendingPermission).toBeNull();
    expect(cur.permissionLog.some((l) => l.decision === 'approved')).toBe(true);
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
