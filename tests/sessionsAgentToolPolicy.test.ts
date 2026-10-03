/**
 * Agent 工具白名单的行为测试（M2 / FR-2.2）。
 *
 * 覆盖两个层面：
 *
 * | 层 | 问题 | 手段 |
 * |---|---|---|
 * | 请求面 | Agent 的策略有没有真的随每一轮请求发出去？ | 捕获 `ChatRequest` |
 * | 线上形态 | 发出去的报文里字段名对不对、空值有没有被吞？ | 直接断言 `buildRequest` 的 body / form |
 *
 * 第二层不是多余的：本仓库已经在 `session_mode` 上踩过一次同类坑——
 * multipart 分支漏传，导致「带附件的那一轮」静默退回默认值（见 chat.ts 注释）。
 * 工具白名单漏传的后果更重：最小权限会在带附件的轮次里整体失效。
 *
 * 本文件的重点是「**未声明** 与 **声明为空白名单** 必须可区分」：
 * 前者不限制，后者一个工具都不许。把两者混成同一个值，要么让用户没碰过的
 * Agent 被锁死，要么让一次手误变成完全放开。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { waitForSessionWrites } from '@/events';
import { resetEventStream } from './helpers/eventStream';
import type { Agent } from '@/types';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

let capturedRequests: ChatRequest[] = [];

/** `buildRequest` 是私有的；这里显式列出它的契约以便断言线上形态。 */
type WireRequest = {
  headers: Record<string, string>;
  body?: string;
  form?: FormData;
};
type WireBuildable = { buildRequest(req: ChatRequest): WireRequest };

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-test',
    name: '测试智能体',
    systemPrompt: '你是测试助手',
    skillIds: [],
    imBinding: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStores(a: Agent) {
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
  useAgentsStore.setState({ agents: [a], activeAgentId: a.id });
  capturedRequests = [];
  resetEventStream();
}

function mockGateway() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
      capturedRequests.push(req);
      handlers.onToken('好的。');
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

function wireClient(): WireBuildable {
  return new NanobotClient() as unknown as WireBuildable;
}

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    agentId: 'agent-test',
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
    ...overrides,
  };
}

function jsonBody(req: ChatRequest): Record<string, unknown> {
  const { body } = wireClient().buildRequest(req);
  return JSON.parse(body ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  resetStores(agent());
  mockGateway();
});

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// 请求面：策略随每一轮下发
// ---------------------------------------------------------------------------

describe('Agent 工具策略的请求面（FR-2.2）', () => {
  it('Agent 声明了白名单时随每轮请求下发', async () => {
    resetStores(agent({ toolAllow: ['read_file', 'grep'] }));
    const session = useSessionsStore.getState().createSession('agent-test', '白名单会话');
    await useSessionsStore.getState().send('读一下', session.id);
    await settle(session.id);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].toolAllow).toEqual(['read_file', 'grep']);
    expect(capturedRequests[0].toolDeny).toBeUndefined();
  });

  it('只声明黑名单时也只下发黑名单', async () => {
    resetStores(agent({ toolDeny: ['exec'] }));
    const session = useSessionsStore.getState().createSession('agent-test', '黑名单会话');
    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(capturedRequests[0].toolDeny).toEqual(['exec']);
    expect(capturedRequests[0].toolAllow).toBeUndefined();
  });

  it('未声明策略时下发 undefined，而不是空数组', async () => {
    // 这是本文件最要紧的一条：undefined = 不限制；[] = 一个工具都不许。
    // 把前者落成后者，会让每一个「用户没碰过这个开关」的 Agent 直接失效。
    const session = useSessionsStore.getState().createSession('agent-test', '默认会话');
    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(capturedRequests[0].toolAllow).toBeUndefined();
    expect(capturedRequests[0].toolDeny).toBeUndefined();
  });

  it('空白名单原样下发（不能被当成「没声明」省略掉）', async () => {
    resetStores(agent({ toolAllow: [] }));
    const session = useSessionsStore.getState().createSession('agent-test', '空名单会话');
    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(capturedRequests[0].toolAllow).toEqual([]);
  });

  it('策略镜像当前 Agent 配置，而不是会话创建时的快照', async () => {
    const session = useSessionsStore.getState().createSession('agent-test', '改配置会话');
    await useSessionsStore.getState().send('第一轮', session.id);
    await settle(session.id);
    expect(capturedRequests[0].toolAllow).toBeUndefined();

    // 收紧该 Agent 的权限后，同一会话的下一轮必须立刻收紧。
    useAgentsStore.getState().updateAgent('agent-test', { toolAllow: ['read_file'] });
    await useSessionsStore.getState().send('第二轮', session.id);
    await settle(session.id);

    expect(capturedRequests[1].toolAllow).toEqual(['read_file']);
  });
});

// ---------------------------------------------------------------------------
// 线上形态：字段名与空值语义
// ---------------------------------------------------------------------------

describe('报文中的工具策略（FR-2.2）', () => {
  it('JSON 分支使用 tool_allow / tool_deny / agent_id', () => {
    const body = jsonBody(
      baseRequest({ toolAllow: ['read_file'], toolDeny: ['exec'], }),
    );
    expect(body.tool_allow).toEqual(['read_file']);
    expect(body.tool_deny).toEqual(['exec']);
    expect(body.agent_id).toBe('agent-test');
  });

  it('未声明的字段不出现在报文里', () => {
    const body = jsonBody(baseRequest());
    expect('tool_allow' in body).toBe(false);
    expect('tool_deny' in body).toBe(false);
  });

  it('空白名单在报文里保留为空数组', () => {
    const body = jsonBody(baseRequest({ toolAllow: [] }));
    expect(body.tool_allow).toEqual([]);
  });

  it('multipart 分支同样携带工具策略（带附件不是最小权限的旁路）', () => {
    // 与 session_mode 当年的漏法同源：multipart 只认它自己解析的字段。
    const { form } = wireClient().buildRequest(
      baseRequest({
        toolAllow: ['read_file', 'grep'],
        toolDeny: ['exec'],
        files: [{ name: 'a.txt', mimeType: 'text/plain', content: '' }],
      }),
    );
    expect(form).toBeDefined();
    expect(form!.get('tool_allow')).toBe('read_file,grep');
    expect(form!.get('tool_deny')).toBe('exec');
    expect(form!.get('agent_id')).toBe('agent-test');
  });

  it('multipart 下的空白名单发成空串而不是被省略', () => {
    // 「字段出现」即为「已声明」——空串必须仍然出现，否则引擎无法把它和
    // 「没声明」分开（见 server.py 的 _parse_multipart）。
    const { form } = wireClient().buildRequest(
      baseRequest({
        toolAllow: [],
        files: [{ name: 'a.txt', mimeType: 'text/plain', content: '' }],
      }),
    );
    expect(form!.has('tool_allow')).toBe(true);
    expect(form!.get('tool_allow')).toBe('');
  });

  it('multipart 下未声明时不发字段', () => {
    const { form } = wireClient().buildRequest(
      baseRequest({
        files: [{ name: 'a.txt', mimeType: 'text/plain', content: '' }],
      }),
    );
    expect(form!.has('tool_allow')).toBe(false);
    expect(form!.has('tool_deny')).toBe(false);
  });
});
