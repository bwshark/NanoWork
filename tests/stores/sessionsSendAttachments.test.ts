import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/nanobotClient';
import type { Attachment, Message, Session } from '@/types';
import type { ChatHandle, ChatRequest, StreamHandlers } from '@/ai/types';

/**
 * sessionsStore.send() 附件链路测试。
 *
 * 重点验证：
 * 1. 附件确实被转换成 base64 载荷并随 ChatRequest.files 下发（能到达网关）；
 * 2. 纯附件（无文本）时合成非空占位文本，满足网关 message 非空要求；
 * 3. 两参 / 一参调用（tasksStore / retry 等既有调用方）行为零变化（回归）；
 * 4. history 构造不丢「只有附件」的轮次；
 * 5. 走真实 NanobotClient 时切换为 multipart/form-data。
 */

/** 捕获最近一次下发给 client 的 ChatRequest */
let captured: ChatRequest[] = [];

/** 小图片附件（≤512KB，落库保留 dataUrl，可被重发） */
function imageAttachment(patch: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-img',
    name: '截图.png',
    size: 1024,
    mime: 'image/png',
    kind: 'image',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    ...patch,
  };
}

/** 文档附件（落库会裁掉 dataUrl） */
function docAttachment(patch: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-doc',
    name: '报告.pdf',
    size: 2048,
    mime: 'application/pdf',
    kind: 'document',
    dataUrl: 'data:application/pdf;base64,JVBERi0x',
    ...patch,
  };
}

function session(id: string, messages: Message[]): Session {
  const now = new Date().toISOString();
  return {
    id,
    agentId: 'agent-test',
    title: 'T',
    messages,
    permissionLog: [],
    createdAt: now,
    updatedAt: now,
  };
}

function resetStores() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      memoryEnabled: false,
      autoSummarize: false,
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
    pendingPermission: null,
    error: null,
  });
  useArtifactsStore.setState({ bySession: {} });
}

/** 默认网关 mock：记录请求、立刻回一段文本并结束流 */
function mockGateway() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (req: ChatRequest, handlers: StreamHandlers): ChatHandle => {
      captured.push(req);
      handlers.onStatus('thinking');
      handlers.onStatus('streaming');
      handlers.onToken('收到');
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

beforeEach(() => {
  captured = [];
  resetStores();
  mockGateway();
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

describe('sessionsStore.send: 附件到达网关', () => {
  it('文本 + 附件：附件转成 base64 载荷随 ChatRequest.files 下发', async () => {
    await useSessionsStore.getState().send('看看这个文件', undefined, [docAttachment()]);

    expect(captured).toHaveLength(1);
    const files = captured[0].files;
    expect(files).toBeDefined();
    expect(files).toHaveLength(1);
    expect(files![0]).toEqual({
      name: '报告.pdf',
      content: 'JVBERi0x',
      mimeType: 'application/pdf',
    });

    const user = useSessionsStore.getState().sessions[0].messages[0];
    expect(user.role).toBe('user');
    expect(user.content).toBe('看看这个文件');
    expect(user.attachments).toHaveLength(1);
  });

  it('多附件按序全部下发', async () => {
    await useSessionsStore.getState().send('汇总', undefined, [
      docAttachment(),
      imageAttachment(),
    ]);
    expect(captured[0].files?.map((f) => f.name)).toEqual(['报告.pdf', '截图.png']);
  });

  it('纯附件（无文本）：合成非空「附件：」占位文本，网关不会收到空 message', async () => {
    await useSessionsStore.getState().send('', undefined, [docAttachment()]);

    const user = useSessionsStore.getState().sessions[0].messages[0];
    expect(user.content).toBe('附件：报告.pdf');
    expect(user.content.trim()).not.toBe('');
    expect(user.attachments).toHaveLength(1);
    expect(captured[0].files).toHaveLength(1);
  });

  it('纯附件多文件：文件名以顿号拼接', async () => {
    await useSessionsStore.getState().send('   ', undefined, [
      docAttachment(),
      imageAttachment(),
    ]);
    const user = useSessionsStore.getState().sessions[0].messages[0];
    expect(user.content).toBe('附件：报告.pdf、截图.png');
  });

  it('纯附件时会话标题取首个文件名', async () => {
    await useSessionsStore.getState().send('', undefined, [docAttachment()]);
    expect(useSessionsStore.getState().sessions[0].title).toBe('报告.pdf');
  });

  it('内容已丢失的附件被跳过，不产生空 files 字段', async () => {
    const stripped = docAttachment({ dataUrl: undefined });
    await useSessionsStore.getState().send('重发一下', undefined, [stripped]);
    expect(captured[0].files).toBeUndefined();
    // 元信息仍随消息保留，气泡里看得出「发过什么」
    expect(useSessionsStore.getState().sessions[0].messages[0].attachments).toHaveLength(1);
  });
});

describe('sessionsStore.send: 向后兼容回归', () => {
  it('单参调用 send(text) 行为不变：无 files、无 attachments', async () => {
    const res = await useSessionsStore.getState().send('你好');
    expect(res?.error).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0].files).toBeUndefined();
    const user = useSessionsStore.getState().sessions[0].messages[0];
    expect(user.content).toBe('你好');
    expect(user.attachments).toBeUndefined();
  });

  it('两参调用 send(text, sessionId) 行为不变（tasksStore 调用形态）', async () => {
    const s = useSessionsStore.getState().createSession('agent-test', '定时任务会话');
    const res = await useSessionsStore.getState().send('执行巡检任务', s.id);

    expect(res?.sessionId).toBe(s.id);
    expect(captured).toHaveLength(1);
    expect(captured[0].files).toBeUndefined();
    const target = useSessionsStore.getState().sessions.find((x) => x.id === s.id)!;
    expect(target.messages[0].content).toBe('执行巡检任务');
    expect(target.messages[0].attachments).toBeUndefined();
  });

  it('空文本且无附件直接返回 null，不发请求', async () => {
    const res = await useSessionsStore.getState().send('   ');
    expect(res).toBeNull();
    expect(captured).toHaveLength(0);
    expect(useSessionsStore.getState().sessions).toHaveLength(0);
  });

  it('空数组 attachments 等价无附件，不产生 files 字段', async () => {
    await useSessionsStore.getState().send('你好', undefined, []);
    expect(captured[0].files).toBeUndefined();
    expect(useSessionsStore.getState().sessions[0].messages[0].attachments).toBeUndefined();
  });
});

describe('sessionsStore: 重发链路携带附件', () => {
  it('retry() 带上小图片附件的真实内容重发', async () => {
    await useSessionsStore.getState().send('描述一下', undefined, [imageAttachment()]);
    captured = [];

    await useSessionsStore.getState().retry();

    expect(captured).toHaveLength(1);
    // 图片体积在落库阈值内，dataUrl 被保留 → 能真正重传
    expect(captured[0].files?.map((f) => f.name)).toEqual(['截图.png']);
    expect(captured[0].files?.[0].content).toBe('iVBORw0KGgo=');
  });

  it('retry() 遇到内容已被裁剪的大附件安全跳过，不报错', async () => {
    await useSessionsStore.getState().send('总结', undefined, [docAttachment()]);
    captured = [];

    await expect(useSessionsStore.getState().retry()).resolves.toBeUndefined();

    expect(captured).toHaveLength(1);
    expect(captured[0].files).toBeUndefined();
    expect(useSessionsStore.getState().error).toBeNull();
  });

  it('resendFromMessage() 原地重发并带上原消息附件', async () => {
    await useSessionsStore.getState().send('原始问题', undefined, [imageAttachment()]);
    const s = useSessionsStore.getState().sessions[0];
    const userMsgId = s.messages[0].id;
    captured = [];

    await useSessionsStore.getState().resendFromMessage(s.id, userMsgId, '换个说法');

    expect(captured).toHaveLength(1);
    expect(captured[0].files?.map((f) => f.name)).toEqual(['截图.png']);
    const after = useSessionsStore.getState().sessions[0];
    // 原地覆盖：不新增 user 消息
    expect(after.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(after.messages[0].content).toBe('换个说法');
    expect(after.messages[0].attachments).toHaveLength(1);
  });

  it('resendFromMessage() 空内容时静默 no-op', async () => {
    await useSessionsStore.getState().send('原始问题', undefined, [docAttachment()]);
    const s = useSessionsStore.getState().sessions[0];
    captured = [];

    await useSessionsStore.getState().resendFromMessage(s.id, s.messages[0].id, '   ');
    expect(captured).toHaveLength(0);
  });
});

describe('sessionsStore: history 构造', () => {
  it('「只有附件、文本为空」的历史 user 消息不会被过滤掉', async () => {
    const pureAttachment: Message = {
      id: 'm-pure',
      role: 'user',
      content: '',
      attachments: [docAttachment()],
      createdAt: new Date().toISOString(),
    };
    useSessionsStore.setState({
      sessions: [session('s1', [pureAttachment])],
      activeId: 's1',
    });

    await useSessionsStore.getState().send('继续', 's1');

    const userTurns = captured[0].messages.filter((m) => m.role === 'user');
    // 纯附件轮次（content 为空）必须仍在上下文中
    expect(userTurns.map((m) => m.content)).toContain('');
    expect(userTurns).toHaveLength(2);
  });

  it('「文本与附件皆空」的 user 消息仍被过滤（不制造空轮次）', async () => {
    const empty: Message = {
      id: 'm-empty',
      role: 'user',
      content: '',
      createdAt: new Date().toISOString(),
    };
    useSessionsStore.setState({
      sessions: [session('s1', [empty])],
      activeId: 's1',
    });

    await useSessionsStore.getState().send('继续', 's1');

    const userTurns = captured[0].messages.filter((m) => m.role === 'user');
    expect(userTurns.map((m) => m.content)).toEqual(['继续']);
  });
});

describe('sessionsStore: 真实 NanobotClient 走 multipart 上传', () => {
  it('有附件时请求体为 FormData，且包含 message 与 files 字段', async () => {
    // 放行 client 真实实现（不 mock sendMessage），仅替换 fetch
    vi.restoreAllMocks();
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');

    const fetchMock = vi.fn((_url: unknown, init?: { body?: unknown }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => Promise.resolve({ done: true, value: undefined }),
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await useSessionsStore.getState().send('看看这个文件', undefined, [docAttachment()]);

    const chatCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/chat/completions'),
    );
    expect(chatCall).toBeDefined();
    const body = chatCall![1]?.body;
    expect(body).toBeInstanceOf(FormData);

    const form = body as FormData;
    expect(String(form.get('message'))).toContain('看看这个文件');
    const files = form.getAll('files');
    expect(files).toHaveLength(1);
    expect((files[0] as File).name).toBe('报告.pdf');
    expect((files[0] as File).type).toBe('application/pdf');

    vi.unstubAllGlobals();
  });

  it('无附件时请求体为 JSON 字符串（不切 multipart）', async () => {
    vi.restoreAllMocks();
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');

    const fetchMock = vi.fn((_url: unknown, _init?: { body?: unknown }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => Promise.resolve({ done: true, value: undefined }),
          }),
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await useSessionsStore.getState().send('纯文本提问');

    const chatCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/chat/completions'),
    );
    expect(chatCall).toBeDefined();
    expect(typeof chatCall![1]?.body).toBe('string');
    expect(chatCall![1]?.body).toContain('纯文本提问');

    vi.unstubAllGlobals();
  });
});
