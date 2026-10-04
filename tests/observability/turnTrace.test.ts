import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { useSessionsStore } from '@/stores/sessionsStore';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { takeTurnEvents } from '@/events';
import { resetEventStream } from '../helpers/eventStream';
import type { ChatHandle, StreamHandlers } from '@/ai/runtime/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';
import type { TraceFile } from '@/observability/trace';

/**
 * 回合结束时的可观测性接线（FR-11.2 / FR-11.3）。
 *
 * 这里验的是**接线**，不是构建逻辑：`buildTurnTrace` 的形状由
 * `tests/observability/trace.test.ts` 逐字段钉住，本文件只回答三个问题——
 * 「`send` 完一轮之后，有没有真的送出一份 trace」「它是不是这一轮的事件」
 * 「出错时有没有落一行日志」。
 *
 * 之所以必须有一条**接线**用例：本仓库在 `session_mode` 上踩过
 * 「函数对了但没接线」的坑——纯函数全绿而生产链路零调用。
 */

function resetStores() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: true,
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
  resetEventStream();
}

/** 一轮里带一次工具调用的回复（工具事件是 trace 里最有信息量的部分） */
function mockGatewayWithTool() {
  vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
  vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
    (_req, handlers: StreamHandlers): ChatHandle => {
      handlers.onStatus('thinking');
      handlers.onReasoning?.('先读文件');
      handlers.onProcessTool?.({
        id: 'call-1',
        tool: 'read_file',
        args: { path: 'a.ts' },
        phase: 'start',
      });
      handlers.onProcessTool?.({
        id: 'call-1',
        tool: 'read_file',
        args: { path: 'a.ts' },
        phase: 'end',
        result: 'file-body',
      });
      handlers.onStatus('streaming');
      handlers.onToken('读完了。');
      handlers.onStatus('done');
      handlers.onDone();
      return { done: Promise.resolve(), abort: () => {} };
    },
  );
}

let writeTrace: ReturnType<typeof vi.spyOn>;
let appendLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStores();
  mockGatewayWithTool();
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
  // 两条通道都是 fire-and-forget（真机里走 IPC 且主进程自行吞错），
  // 测试里换成 spy 即可断言「送出去了什么」，不碰文件系统。
  writeTrace = vi.spyOn(platform, 'writeTrace').mockImplementation(() => {});
  appendLog = vi.spyOn(platform, 'appendLog').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('回合 trace 的接线（FR-11.2）', () => {
  it('send 完一轮就送出一份 trace，且内容就是这一轮', async () => {
    await useSessionsStore.getState().send('读一下 a.ts');
    const sessionId = useSessionsStore.getState().sessions[0]!.id;

    expect(writeTrace).toHaveBeenCalledTimes(1);
    const file = writeTrace.mock.calls[0]![0] as Parameters<typeof platform.writeTrace>[0];

    expect(file.trace.sessionId).toBe(sessionId);
    expect(file.trace.name).toBe('Agent workflow');
    expect(file.trace.status).toBe('ok');
    expect(file.trace.traceId).toMatch(/^trace_[0-9a-f]{32}$/);
    expect(file.trace.spanCount).toBe(file.spans.length);

    // 工具 span 是这一轮的证据：名字、入参、结果、状态都在
    const tool = file.spans.find((s) => s.type === 'function');
    expect(tool?.name).toBe('read_file');
    expect(tool?.status).toBe('ok');
    expect(JSON.parse(tool!.toolInput!)).toEqual({ path: 'a.ts' });
    expect(tool?.toolOutput).toBe('file-body');

    // 根 span 覆盖整轮，且是 agent 类型
    expect(file.spans[0]?.type).toBe('agent');
    expect(file.spans[0]?.parentId).toBeNull();
    // 提问正文不入 trace（诊断包会被用户发出去），只留长度
    expect(file.trace.metadata.promptChars).toBe('读一下 a.ts'.length);
    expect(JSON.stringify(file)).not.toContain('读一下');
  });

  it('回合缓冲取完即清：下一轮不会把上一轮的事件重复算进来', async () => {
    await useSessionsStore.getState().send('第一轮');
    await useSessionsStore.getState().send('第二轮');

    expect(writeTrace).toHaveBeenCalledTimes(2);
    const [first, second] = writeTrace.mock.calls.map((c) => c[0]) as Array<
      Parameters<typeof platform.writeTrace>[0]
    >;
    expect(first!.trace.traceId).not.toBe(second!.trace.traceId);
    expect(first!.trace.metadata.promptChars).toBe('第一轮'.length);
    expect(second!.trace.metadata.promptChars).toBe('第二轮'.length);
    // 判据落在**工具 span 的条数**上：桩每轮都发一次工具事件，所以正常情况两轮
    // 各 1 条。若缓冲没取完即清，第二轮会拿到「第一轮 + 第二轮」= 2 条——
    // 只断言「两轮 traceId 不同」抓不到这种串轮。
    const fnCount = (t: TraceFile) => t.spans.filter((s) => s.type === 'function').length;
    expect(fnCount(first!)).toBe(1);
    expect(fnCount(second!)).toBe(1);
  });

  it('发送抛错也照样收尾：trace 记 error，并落一行 error 日志', async () => {
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(() => {
      throw new Error('连接被重置');
    });

    await useSessionsStore.getState().send('你好');

    expect(writeTrace).toHaveBeenCalledTimes(1);
    const file = writeTrace.mock.calls[0]![0] as Parameters<typeof platform.writeTrace>[0];
    expect(file.trace.status).toBe('error');
    expect(file.trace.metadata.reason).toBe('error');
    expect(file.spans[0]?.error).toBeTruthy();

    const chatError = appendLog.mock.calls
      .map((c) => c[0] as Parameters<typeof platform.appendLog>[0])
      .find((e) => e.module === 'chat' && e.level === 'error');
    expect(chatError).toBeDefined();
    expect(chatError!.line).toContain('发送请求失败');
    expect(chatError!.line).toContain('连接被重置');
    expect(chatError!.line.startsWith('[')).toBe(true);
  });

  it('⭐ 协议级失败（onError）也必须落日志——它不会抛到外层 catch', async () => {
    vi.spyOn(NanobotClient.prototype, 'sendMessage').mockImplementation(
      (_req, handlers: StreamHandlers): ChatHandle => {
        handlers.onStatus('thinking');
        handlers.onError(new Error('SSE 请求失败：HTTP 500'));
        return { done: Promise.resolve(), abort: () => {} };
      },
    );

    await useSessionsStore.getState().send('你好');

    const chatError = appendLog.mock.calls
      .map((c) => c[0] as Parameters<typeof platform.appendLog>[0])
      .find((e) => e.module === 'chat' && e.level === 'error');
    // 2026-10-04 真机验证抓到的缺陷：只有外层 catch 落了日志，而「引擎报错 /
    // 断流超时」这些**绝大多数**失败都走 onError —— 结果是跑一轮失败对话，
    // 日志里一条都没有。
    expect(chatError).toBeDefined();
    expect(chatError!.line).toContain('对话流失败');
    expect(chatError!.line).toContain('HTTP 500');

    // 两条路径的 phase 不同：下一步该查的东西不一样（引擎 vs 网关地址）
    expect(chatError!.line).toContain('"phase":"stream"');
  });

  it('记录器不存在时不产 trace 也不抛（可观测性拿不到数据只是少一份材料）', () => {
    expect(takeTurnEvents('从未创建的会话')).toEqual([]);
  });
});

describe('渲染层日志门面（FR-11.3）', () => {
  it('行里带模块与等级，且模块名走白名单取值', async () => {
    const { log } = await import('@/observability/logger');
    log.warn('sync', '同步失败', { status: 500 });

    const entry = appendLog.mock.calls
      .map((c) => c[0] as Parameters<typeof platform.appendLog>[0])
      .at(-1)!;
    expect(entry.module).toBe('sync');
    expect(entry.level).toBe('warn');
    expect(entry.line).toContain('[sync] WARN 同步失败 {"status":500}');
    // 行内自带 ISO 时间，主进程只负责追加
    expect(entry.line).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });
});
