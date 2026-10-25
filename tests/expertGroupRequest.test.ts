/**
 * 专家团编排请求的行为测试（FR-2.4 路径②，客户端接线）。
 *
 * 覆盖三个层面：
 *
 * | 层 | 问题 | 手段 |
 * |---|---|---|
 * | 构造 | 「什么时候**不**该编排」「成员模型要不要下发」 | 直接调 `buildExpertGroupRequest` |
 * | 报文形态 | 发出去的 `expert_group` 字段名 / 结构对不对 | 断言 `buildRequest` 的 body / form |
 * | 请求面 | 会话绑定专家团时有没有真的随请求下发 | 捕获 `ChatRequest` |
 *
 * 本文件的重点：
 * 1. **单成员团不触发编排**——引擎默认 `aggregate='lead'` 会让同一名成员再跑一轮收口，
 *    与「单专家一轮」结果相同却多花一倍 token；
 * 2. **带附件的一轮不能丢专家团**——本仓库在 `session_mode` 上踩过同款坑
 *    （multipart 分支漏传 → 带附件那一轮静默退回默认），专家团漏传的后果一样隐蔽。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { useModelsStore } from '@/stores/modelsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { buildExpertGroupRequest } from '@/lib/agent/expertGroupRequest';
import { waitForSessionWrites } from '@/events';
import { resetEventStream } from './helpers/eventStream';
import type { Agent, ExpertGroup, ModelInfo } from '@/types';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/runtime/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

let capturedRequests: ChatRequest[] = [];

/** `buildRequest` 是私有的；这里显式列出它的契约以便断言线上形态。 */
type WireRequest = { headers: Record<string, string>; body?: string; form?: FormData };
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

function group(overrides: Partial<ExpertGroup> = {}): ExpertGroup {
  return {
    id: 'group-test',
    name: '测试专家团',
    description: '',
    memberIds: [],
    mode: 'parallel',
    enabled: true,
    createdAt: new Date().toISOString(),
    source: 'user',
    ...overrides,
  };
}

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
  useAgentsStore.setState({ agents: [], activeAgentId: null });
  useExpertGroupsStore.setState({ groups: [], activeGroupId: null });
  // 空目录 = 未加载：成员模型不做「预设是否还在」的筛选（与 resolveTurnModel 一致）
  useModelsStore.setState({ models: [] });
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
  return { agentId: 'agent-test', messages: [{ role: 'user', content: '你好' }], stream: true, ...overrides };
}

function jsonBody(req: ChatRequest): Record<string, unknown> {
  const { body } = wireClient().buildRequest(req);
  return JSON.parse(body ?? '{}') as Record<string, unknown>;
}

/** 两名启用成员的标准团材料 */
function twoAgents(): Agent[] {
  return [
    agent({ id: 'a-lead', name: '团长', systemPrompt: '你是团长' }),
    agent({ id: 'a-member', name: '成员', systemPrompt: '你是成员' }),
  ];
}

beforeEach(() => {
  resetStores();
  mockGateway();
});

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// 构造：何时编排、下发什么
// ---------------------------------------------------------------------------

describe('buildExpertGroupRequest', () => {
  const agents = twoAgents();

  it('取不到团 / 团已停用 → 不下发', () => {
    expect(buildExpertGroupRequest(undefined, agents, null)).toBeUndefined();
    expect(
      buildExpertGroupRequest(
        group({ enabled: false, memberIds: ['a-lead', 'a-member'] }),
        agents,
        null,
      ),
    ).toBeUndefined();
  });

  it('只有一名启用成员 → 不下发（避免 leader 收口多跑一轮）', () => {
    const g = group({ memberIds: ['a-lead'] });
    expect(buildExpertGroupRequest(g, agents, null)).toBeUndefined();
  });

  it('成员被删除或停用 → 过滤；过滤后不足两名 → 不下发', () => {
    const g = group({ memberIds: ['a-lead', 'gone', 'a-member'] });
    // 'gone' 不在目录里 → 只剩两名启用成员，仍可编排
    expect(buildExpertGroupRequest(g, agents, null)?.members.map((m) => m.id)).toEqual([
      'a-lead',
      'a-member',
    ]);

    const withDisabled = [...agents, agent({ id: 'a-off', enabled: false })];
    expect(
      buildExpertGroupRequest(group({ memberIds: ['a-lead', 'a-off'] }), withDisabled, null),
    ).toBeUndefined();
  });

  it('映射 mode / 人设 / 工具策略', () => {
    const g = group({ mode: 'sequential', memberIds: ['a-lead', 'a-member'] });
    const withTools = [
      agent({ id: 'a-lead', name: '团长', systemPrompt: '你是团长', toolAllow: ['read_file'] }),
      agent({ id: 'a-member', name: '成员', systemPrompt: '你是成员', toolDeny: ['exec'] }),
    ];
    const req = buildExpertGroupRequest(g, withTools, null);
    expect(req).toEqual({
      mode: 'sequential',
      members: [
        { id: 'a-lead', name: '团长', systemPrompt: '你是团长', toolAllow: ['read_file'] },
        { id: 'a-member', name: '成员', systemPrompt: '你是成员', toolDeny: ['exec'] },
      ],
    });
  });

  it('空白名单保留为空数组，空人设不落成空串人设', () => {
    const emptyish = [
      agent({ id: 'a-lead', systemPrompt: '', toolAllow: [] }),
      agent({ id: 'a-member' }),
    ];
    const req = buildExpertGroupRequest(
      group({ memberIds: ['a-lead', 'a-member'] }),
      emptyish,
      null,
    );
    const lead = req!.members[0];
    expect(lead.toolAllow).toEqual([]); // [] = 一个工具都不许，不能被当成「未声明」省略
    expect('systemPrompt' in lead).toBe(false); // 空人设不该变成一段空字符串
  });

  it('成员模型：预设失效则不下发，目录未加载（null）则下发', () => {
    const withModel = [agent({ id: 'a-lead', model: 'gone-preset' }), agent({ id: 'a-member' })];
    const g = group({ memberIds: ['a-lead', 'a-member'] });

    const filtered = buildExpertGroupRequest(g, withModel, new Set(['default']));
    expect('model' in filtered!.members[0]).toBe(false);

    const lenient = buildExpertGroupRequest(g, withModel, null);
    expect(lenient!.members[0].model).toBe('gone-preset');

    const kept = buildExpertGroupRequest(g, withModel, new Set(['gone-preset']));
    expect(kept!.members[0].model).toBe('gone-preset');
  });
});

// ---------------------------------------------------------------------------
// 报文形态
// ---------------------------------------------------------------------------

describe('报文中的 expert_group（FR-2.4）', () => {
  const expertGroup = {
    mode: 'parallel' as const,
    members: [
      { id: 'a-lead', name: '团长', systemPrompt: '你是团长', toolAllow: ['read_file'] },
      { id: 'a-member', name: '成员', toolDeny: ['exec'], model: 'qwen-max' },
    ],
  };

  it('JSON 分支使用 snake_case 的 expert_group.members[]', () => {
    const body = jsonBody(baseRequest({ expertGroup }));
    expect(body.expert_group).toEqual({
      mode: 'parallel',
      members: [
        {
          id: 'a-lead',
          name: '团长',
          system_prompt: '你是团长',
          tool_allow: ['read_file'],
        },
        { id: 'a-member', name: '成员', tool_deny: ['exec'], model: 'qwen-max' },
      ],
    });
  });

  it('未带 expertGroup 时报文里没有该字段', () => {
    expect('expert_group' in jsonBody(baseRequest())).toBe(false);
  });

  it('multipart 分支同样携带专家团（带附件不是编排的旁路）', () => {
    const { form } = wireClient().buildRequest(
      baseRequest({ expertGroup, files: [{ name: 'a.txt', mimeType: 'text/plain', content: '' }] }),
    );
    expect(form).toBeDefined();
    const raw = form!.get('expert_group');
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw as string)).toEqual({
      mode: 'parallel',
      members: [
        { id: 'a-lead', name: '团长', system_prompt: '你是团长', tool_allow: ['read_file'] },
        { id: 'a-member', name: '成员', tool_deny: ['exec'], model: 'qwen-max' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 请求面：会话绑定专家团 → 随请求下发
// ---------------------------------------------------------------------------

describe('会话绑定专家团的请求面（FR-2.4）', () => {
  it('绑定含两名启用成员的团时下发 expertGroup', async () => {
    const agents = twoAgents();
    useAgentsStore.setState({ agents, activeAgentId: 'a-lead' });
    const g = group({ memberIds: ['a-lead', 'a-member'] });
    useExpertGroupsStore.setState({ groups: [g], activeGroupId: g.id });

    // agentId 传 undefined：createSession 才会走「全局活跃专家团」兜底并绑定 groupId
    const session = useSessionsStore.getState().createSession(undefined, '团会话');
    expect(session.groupId).toBe(g.id);

    await useSessionsStore.getState().send('一起看看', session.id);
    await settle(session.id);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].expertGroup?.mode).toBe('parallel');
    expect(capturedRequests[0].expertGroup?.members.map((m) => m.id)).toEqual([
      'a-lead',
      'a-member',
    ]);
  });

  it('团内只有一名启用成员时不编排（退回单专家一轮）', async () => {
    const agents = twoAgents();
    useAgentsStore.setState({ agents, activeAgentId: 'a-lead' });
    // 团里另一名成员已停用 → 实际只剩一名
    const members = [agents[0], agent({ id: 'a-member', enabled: false })];
    useAgentsStore.setState({ agents: members, activeAgentId: 'a-lead' });
    const g = group({ memberIds: ['a-lead', 'a-member'] });
    useExpertGroupsStore.setState({ groups: [g], activeGroupId: g.id });

    const session = useSessionsStore.getState().createSession(undefined, '单成员团');
    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(capturedRequests[0].expertGroup).toBeUndefined();
  });

  it('未绑定专家团的会话不下发 expertGroup', async () => {
    const agents = twoAgents();
    useAgentsStore.setState({ agents, activeAgentId: 'a-lead' });
    const session = useSessionsStore.getState().createSession('a-lead', '普通会话');
    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    expect(capturedRequests[0].expertGroup).toBeUndefined();
  });

  it('成员模型按预设目录筛选（目录非空时）', async () => {
    const agents = [
      agent({ id: 'a-lead', name: '团长', model: 'qwen-max' }),
      agent({ id: 'a-member', name: '成员', model: 'deleted-preset' }),
    ];
    useAgentsStore.setState({ agents, activeAgentId: 'a-lead' });
    useModelsStore.setState({ models: [{ id: 'qwen-max' }] as ModelInfo[] });
    const g = group({ memberIds: ['a-lead', 'a-member'] });
    useExpertGroupsStore.setState({ groups: [g], activeGroupId: g.id });

    const session = useSessionsStore.getState().createSession(undefined, '模型团');
    await useSessionsStore.getState().send('你好', session.id);
    await settle(session.id);

    const [lead, member] = capturedRequests[0].expertGroup!.members;
    expect(lead.model).toBe('qwen-max');
    expect(member.model).toBeUndefined();
  });
});
