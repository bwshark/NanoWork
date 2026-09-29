/**
 * 两条推导路径的等价性测试（D2 Phase C/D 的收口）。
 *
 * ## 为什么需要它
 *
 * 会话视图有**两个产地**：
 *
 * | 产地 | 触发时机 | 实现 |
 * |---|---|---|
 * | 实时增量 | 流式过程中逐 token / 逐事件就地更新 store | `sessionsStore` 的各 action |
 * | 批量重放 | 启动或打开会话时从事件流一次性重建 | `@/events/project` |
 *
 * 两者若不发散的保证只能靠「构造一次、两处消费」——事件由 `recordFor` 构造，
 * 内存视图直接消费同一批事件对象（或从事件取派生值，如 `createdAt`、权限日志的
 * `id`/`at`）。一旦有人给视图另造一份值，刷新前后就会不一致。
 *
 * 本文件用 store 的**真实动作**跑完一轮会话（发送、流式 token、两段思考、
 * 工具调用、审批、产物、中断、编辑后重发），再把记录下的事件投影回消息，
 * 逐字段比对。它是这条不变量唯一的自动化守卫。
 *
 * ## 三处**刻意**的取值范围差异（不是 bug，见各自用例）
 *
 * 1. `Session.updatedAt`：每次 `updateMessage` 都刷新，而 meta 只在「非事件型
 *    变更」时落盘，两者本就不同步 → 本测试只比对由事件流推导的部分。
 * 2. 附件 `dataUrl` / `previewUrl`：视图态，刻意不入事件流（附件库属 R7 / M4）。
 * 3. 未裁决的审批请求：视图有 `pending` 卡片，事件流没有对应事件——引擎侧
 *    悬空请求会被判超时拒绝，持久化一个 `pending` 无意义。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { waitForSessionWrites, type EventStore } from '@/events';
import { projectSession } from '@/events/project';
import { resetEventStream } from '../helpers/eventStream';
import type { Attachment, Message } from '@/types';
import type { ChatHandle, StreamHandlers } from '@/ai/runtime/types';

let store: EventStore;

/** 重置所有相关 store 到初始态 + 换一份干净的内存事件存储 */
function resetStores() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      memoryEnabled: false,
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
  store = resetEventStream();
}

/**
 * 一轮「什么都来一点」的回合：两段思考、一次工具调用、一个产物、一次审批，
 * 以及多次 token。顺序贴近真实引擎（思考 → 工具 → 思考 → 正文，审批在工具
 * 执行前挂起、由 `resolveApproval` 收尾）。
 */
function mockRichTurn() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (_req, handlers: StreamHandlers): ChatHandle => {
      handlers.onStatus('thinking');
      handlers.onReasoning?.('先思考');
      handlers.onReasoning?.('一下');
      handlers.onReasoningEnd?.();
      handlers.onProcessTool?.({
        id: 'call-1',
        tool: 'read_file',
        args: { path: 'a.txt' },
        phase: 'start',
      });
      handlers.onProcessTool?.({
        id: 'call-1',
        tool: 'read_file',
        args: { path: 'a.txt' },
        phase: 'end',
        result: '文件内容',
      });
      handlers.onReasoning?.('再确认');
      handlers.onArtifact?.({
        id: 'art-1',
        type: 'html',
        title: '示例片段',
        content: '<h1>hi</h1>',
      });
      handlers.onStatus('streaming');
      handlers.onToken('这是');
      handlers.onToken('回答。');
      // Plan 模式下同一轮还会产出一份待裁决计划：它是**消息的一部分**，
      // 因而必须能与思考 / 工具 / 产物共存而不互相挤压
      handlers.onPlan?.({
        planId: 'plan-rich-1',
        steps: [
          { id: 's1', text: '读取 a.txt', status: 'pending' },
          { id: 's2', text: '给出示例片段', status: 'pending' },
        ],
      });
      handlers.onApprovalRequest?.({
        id: 'appr-1',
        tool: 'files',
        args: { operation: 'read' },
      });
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

/** 纯文本 + 一段思考的简单回合（不涉审批，用于「编辑后重发」） */
function mockPlainTurn() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (_req, handlers: StreamHandlers): ChatHandle => {
      handlers.onStatus('thinking');
      handlers.onReasoning?.('想一下');
      handlers.onReasoningEnd?.();
      handlers.onStatus('streaming');
      handlers.onToken('你好，我是测试回复。');
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

/** 排空该会话的写队列，并让「非事件型」的 meta 写入（fire-and-forget）落到内存实现 */
async function settle(sessionId: string) {
  await waitForSessionWrites(sessionId);
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * 去掉**视图态**附件字段后比对。
 *
 * `dataUrl` / `previewUrl` 刻意不入事件流（见 `toEventAttachment` 的说明：
 * 逐行 JSON 塞 base64 会让单个 JSONL 膨胀到不可读，且 object URL 本就不可跨端
 * 复原）。因此「发过一张小图」在当前会话里能看缩略图，刷新后只剩图标 —— 这是
 * V1 已记录的缺口（附件库属 R7 / M4），不是本测试要掩盖的不一致。
 */
function stripVolatileAttachment(a: Attachment): Omit<Attachment, 'dataUrl' | 'previewUrl'> {
  const copy: Attachment = { ...a };
  delete copy.dataUrl;
  delete copy.previewUrl;
  return copy;
}

function stripVolatile(messages: Message[]): Message[] {
  return messages.map((m) => ({
    ...m,
    ...(m.attachments && m.attachments.length > 0
      ? { attachments: m.attachments.map(stripVolatileAttachment) }
      : {}),
  }));
}

/** 读取磁盘事件并投影，返回与视图同形的 `Session` */
async function replay(sessionId: string) {
  const meta = await store.readMeta(sessionId);
  if (!meta) throw new Error(`meta 缺失：${sessionId}`);
  const events = await store.readEvents(sessionId);
  return projectSession(meta, events);
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

describe('事件投影等价性：实时增量视图 ≡ 批量重放投影', () => {
  it('一轮完整回合（思考 / 工具 / 产物 / 审批）两条路径逐字段一致', async () => {
    mockRichTurn();
    vi.spyOn(NanobotClient.prototype, 'respondApproval').mockResolvedValue(undefined);

    const attachment: Attachment = {
      id: 'att-1',
      name: 'notes.txt',
      size: 12,
      mime: 'text/plain',
      kind: 'text',
    };

    // 用占位标题建会话 → 首条消息触发自动标题（ai-title 事件 + meta 落盘）
    const session = useSessionsStore.getState().createSession('agent-test');
    await useSessionsStore
      .getState()
      .send('请读取 a.txt 并给出示例', session.id, [attachment]);
    await useSessionsStore.getState().resolveApproval('allow');
    await settle(session.id);

    const live = useSessionsStore.getState().sessions.find((s) => s.id === session.id)!;
    const replayed = await replay(session.id);

    // 1) 消息序列：条数、顺序、逐字段
    expect(stripVolatile(replayed.messages)).toEqual(stripVolatile(live.messages));

    // 2) 权限审计日志：id 与时间都取自事件，故刷新前后是同一条记录
    expect(replayed.permissionLog).toEqual(live.permissionLog);
    expect(replayed.permissionLog).toHaveLength(1);

    // 3) 标题：占位标题被首条消息摘要替换，并随 meta 落盘
    expect(replayed.title).toBe(live.title);
    expect(replayed.title).toBe('请读取 a.txt 并给出示例');

    // 4) 关键结构确实被覆盖到（避免「两边都空」也能通过的假绿）
    const assistant = replayed.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('这是回答。');
    expect(assistant.process?.map((p) => (p.kind === 'tool' ? p.tool : p.content))).toEqual([
      '先思考一下',
      'read_file',
      '再确认',
    ]);
    expect(assistant.artifacts?.[0]?.title).toBe('示例片段');
    // 计划本体随事件复原：步骤与待裁决状态都在，刷新后仍能批准
    expect(assistant.plan).toEqual({
      planId: 'plan-rich-1',
      steps: [
        { id: 's1', text: '读取 a.txt', status: 'pending' },
        { id: 's2', text: '给出示例片段', status: 'pending' },
      ],
      status: 'pending',
    });
    expect(assistant.toolCalls?.[0]).toMatchObject({
      id: 'appr-1',
      tool: 'files',
      status: 'approved',
      sensitive: true,
    });
  });

  it('编辑后重发：废弃分支不进投影，与视图的截断结果一致', async () => {
    mockPlainTurn();
    const session = useSessionsStore.getState().createSession('agent-test', '重发会话');
    await useSessionsStore.getState().send('第一版问题', session.id);
    await settle(session.id);

    const firstUser = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === session.id)!
      .messages.find((m) => m.role === 'user')!;

    // 事件流只增不改：新分支从被替换消息处分叉，旧助手回合整段作废
    await useSessionsStore
      .getState()
      .resendFromMessage(session.id, firstUser.id, '第二版问题（改过）');
    await settle(session.id);

    const live = useSessionsStore.getState().sessions.find((s) => s.id === session.id)!;
    const replayed = await replay(session.id);

    // 视图截断掉了旧助手回复；投影也必须只保留活跃时间线
    expect(live.messages).toHaveLength(2);
    expect(stripVolatile(replayed.messages)).toEqual(stripVolatile(live.messages));
    expect(replayed.messages[0].content).toBe('第二版问题（改过）');

    // 磁盘上确实留着废弃分支（只增不改），但活跃时间线把它排除了
    const raw = await store.readEvents(session.id);
    const assistantMessages = raw.filter((e) => e.type === 'message' && e.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(replayed.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('中断的回合：aborted 与耗时都随事件复原', async () => {
    // 流挂在「流式中」不结束，由测试触发 abort —— 句柄的 abort() 收敛 done，
    // 与真实链路一致（runtime.chat 登记句柄 → runtime.abort 找到它并中断）
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
    let finish!: () => void;
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
      (_req, handlers: StreamHandlers): ChatHandle => {
        handlers.onStatus('streaming');
        handlers.onToken('部分输出');
        return {
          done: new Promise<void>((r) => {
            finish = r;
          }),
          abort: () => finish(),
        };
      },
    );

    const session = useSessionsStore.getState().createSession('agent-test', '中断会话');
    const pending = useSessionsStore.getState().send('长任务', session.id);
    // `send` 建流式上下文是同步的（无 await 边界），可直接断言
    expect(useSessionsStore.getState().streams[session.id]?.active).toBe(true);
    // 让引擎侧完成 `getClient()` 并把句柄登记进 inflight，abort 才找得到它
    await new Promise((r) => setTimeout(r, 0));
    useSessionsStore.getState().abort(session.id);
    await pending;
    await settle(session.id);

    const live = useSessionsStore.getState().sessions.find((s) => s.id === session.id)!;
    const replayed = await replay(session.id);

    const liveAssistant = live.messages.find((m) => m.role === 'assistant')!;
    expect(liveAssistant.aborted).toBe(true);
    expect(stripVolatile(replayed.messages)).toEqual(stripVolatile(live.messages));
    expect(replayed.messages.find((m) => m.role === 'assistant')?.aborted).toBe(true);
  });

  it('引擎侧中断的回合：interrupted 随事件复原，且不会被记成 aborted', async () => {
    // 断流 / 引擎报错 / 撞上迭代上限走的是这一条：内容收下了，但本轮没走完。
    // 它必须与「用户按了停止」分开——否则重放后界面会把上游故障说成用户操作。
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
      (_req, handlers: StreamHandlers): ChatHandle => {
        handlers.onStatus('streaming');
        handlers.onToken('我先创建游戏文件');
        handlers.onInterrupted?.('engine_error');
        return { done: Promise.resolve(), abort: () => undefined };
      },
    );

    const session = useSessionsStore.getState().createSession('agent-test', '断流会话');
    await useSessionsStore.getState().send('帮我写一个俄罗斯方块小游戏', session.id);
    await settle(session.id);

    const live = useSessionsStore.getState().sessions.find((s) => s.id === session.id)!;
    const replayed = await replay(session.id);

    const liveAssistant = live.messages.find((m) => m.role === 'assistant')!;
    expect(liveAssistant.interrupted).toBe(true);
    expect(liveAssistant.aborted).toBeUndefined();
    expect(stripVolatile(replayed.messages)).toEqual(stripVolatile(live.messages));
    expect(replayed.messages.find((m) => m.role === 'assistant')?.interrupted).toBe(true);
  });

  it('附件元信息跨重放保留；dataUrl 为视图态、刻意不入事件流（V1 缺口）', async () => {
    mockPlainTurn();
    const image: Attachment = {
      id: 'img-1',
      name: 'shot.png',
      size: 1024,
      mime: 'image/png',
      kind: 'image',
      dataUrl: 'data:image/png;base64,AAAA',
    };

    const session = useSessionsStore.getState().createSession('agent-test', '附件会话');
    await useSessionsStore.getState().send('看这张图', session.id, [image]);
    await settle(session.id);

    const live = useSessionsStore.getState().sessions.find((s) => s.id === session.id)!;
    const replayed = await replay(session.id);

    const liveAtt = live.messages.find((m) => m.role === 'user')!.attachments![0];
    const replayedAtt = replayed.messages.find((m) => m.role === 'user')!.attachments![0];

    // 元信息（id / 名称 / 体积 / MIME / 大类）必须一致
    expect(stripVolatileAttachment(replayedAtt)).toEqual(stripVolatileAttachment(liveAtt));

    // 已知缺口：内容不入事件流 → 当前会话有 dataUrl，重放后没有（附件库落地后消除）
    expect(liveAtt.dataUrl).toBe('data:image/png;base64,AAAA');
    expect(replayedAtt.dataUrl).toBeUndefined();
  });

  it('未裁决的审批只有视图侧 pending 卡片；事件流不留 pending（与引擎超时判拒一致）', async () => {
    mockRichTurn();
    const session = useSessionsStore.getState().createSession('agent-test', '待裁决会话');
    await useSessionsStore.getState().send('请读文件', session.id);
    await settle(session.id);

    const live = useSessionsStore.getState().sessions.find((s) => s.id === session.id)!;
    const replayed = await replay(session.id);

    // 视图：请求已入队，消息上有一张 pending 卡片
    expect(useSessionsStore.getState().pendingApprovals).toHaveLength(1);
    expect(live.messages.find((m) => m.role === 'assistant')!.toolCalls?.[0]).toMatchObject({
      id: 'appr-1',
      status: 'pending',
    });
    // 投影：裁决尚未发生 → 无卡片、无审计记录（持久化 pending 无意义）
    expect(replayed.messages.find((m) => m.role === 'assistant')!.toolCalls).toBeUndefined();
    expect(replayed.permissionLog).toEqual([]);
  });
});
