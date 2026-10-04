import { describe, expect, it } from 'vitest';
import {
  TRACE_FIELD_MAX_CHARS,
  buildTurnTrace,
  isValidTraceId,
  newSpanId,
  newTraceId,
} from '@/observability/trace';
import type { SessionEvent } from '@/types/event';

const T0 = Date.UTC(2026, 9, 4, 6, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** 一个「用户提问 → 工具 → 回答」的完整回合（含一个没有结果的调用与一次拒绝） */
function turn(over: { reason?: 'done' | 'error' | 'aborted' | 'interrupted'; interrupted?: boolean } = {}): SessionEvent[] {
  const events: SessionEvent[] = [
    {
      id: 'e1',
      sessionId: 's1',
      parentId: null,
      seq: 1,
      type: 'message',
      timestamp: T0,
      messageId: 'm1',
      role: 'user',
      content: '帮我改一下 a.ts',
    },
    {
      id: 'e2',
      sessionId: 's1',
      parentId: 'e1',
      seq: 2,
      type: 'reasoning',
      timestamp: T0 + 100,
      messageId: 'm2',
      content: '先读文件',
      done: true,
    },
    {
      id: 'e3',
      sessionId: 's1',
      parentId: 'e2',
      seq: 3,
      type: 'function-call',
      timestamp: T0 + 200,
      messageId: 'm2',
      callId: 'c1',
      name: 'read_file',
      args: { path: 'a.ts' },
      provider: { model: 'Qwen3.8-Flash', agent: 'software-engineer' },
    },
    {
      id: 'e4',
      sessionId: 's1',
      parentId: 'e3',
      seq: 4,
      type: 'function-call-result',
      timestamp: T0 + 500,
      messageId: 'm2',
      callId: 'c1',
      name: 'read_file',
      status: 'ok',
      result: 'file-body',
    },
    {
      id: 'e5',
      sessionId: 's1',
      parentId: 'e4',
      seq: 5,
      type: 'function-call',
      timestamp: T0 + 600,
      messageId: 'm2',
      callId: 'c2',
      name: 'exec',
      args: { cmd: 'ls' },
    },
    {
      id: 'e6',
      sessionId: 's1',
      parentId: 'e5',
      seq: 6,
      type: 'permission-decision',
      timestamp: T0 + 700,
      messageId: 'm2',
      callId: 'c3',
      tool: 'write_file',
      args: { path: 'b.ts' },
      decision: 'rejected',
      reason: '用户拒绝',
      source: 'engine',
    },
    {
      id: 'e7',
      sessionId: 's1',
      parentId: 'e6',
      seq: 7,
      type: 'message',
      timestamp: T0 + 3000,
      messageId: 'm2',
      role: 'assistant',
      content: '改好了',
      createdAt: iso(T0 + 150),
      ...(over.interrupted ? { interrupted: true } : {}),
    },
    {
      id: 'e8',
      sessionId: 's1',
      parentId: 'e7',
      seq: 8,
      type: 'session-end',
      timestamp: T0 + 3000,
      reason: over.reason ?? 'done',
    },
  ];
  return events;
}

function build(events: SessionEvent[], over: Parameters<typeof buildTurnTrace>[1] = { sessionId: 's1' }) {
  return buildTurnTrace(events, over);
}

describe('trace 标识', () => {
  it('traceId / spanId 的形态对齐 WorkBuddy（trace_32hex / span_24hex）', () => {
    expect(newTraceId()).toMatch(/^trace_[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^span_[0-9a-f]{24}$/);
    // 两次调用不重复（随机会被用到文件名上，撞号就是覆盖别人的 trace）
    expect(newTraceId()).not.toBe(newTraceId());
  });

  it('isValidTraceId 是文件名校验的收口点（挡路径穿越）', () => {
    expect(isValidTraceId(newTraceId())).toBe(true);
    for (const bad of ['', 'trace_', '../../etc/passwd', 'trace_A1B2C3D4', 'x'.repeat(80), null])
      expect(isValidTraceId(bad)).toBe(false);
  });
});

describe('buildTurnTrace：外层信封', () => {
  it('键名与 WorkBuddy 同形，跨度覆盖整个回合', () => {
    const { trace, spans } = build(turn());

    expect(Object.keys(trace).sort()).toEqual(
      [
        'agentName',
        'duration',
        'endedAt',
        'metadata',
        'modelInfo',
        'name',
        'sessionId',
        'spanCount',
        'startedAt',
        'status',
        'totalTokens',
        'traceId',
        'workerHostname',
        'workerPid',
      ].sort(),
    );
    expect(trace.name).toBe('Agent workflow');
    expect(trace.sessionId).toBe('s1');
    expect(trace.startedAt).toBe(iso(T0));
    expect(trace.endedAt).toBe(iso(T0 + 3000));
    expect(trace.duration).toBe(3000);
    expect(trace.spanCount).toBe(spans.length);
    expect(trace.totalTokens).toBe(0);
    // pid / hostname 由主进程在落盘时补，渲染层不假装知道
    expect(trace.workerPid).toBe(0);
    expect(trace.workerHostname).toBe('');
  });

  it('agentName 取事件里的 provider.agent；models 去重', () => {
    const { trace } = build(turn());
    expect(trace.agentName).toBe('software-engineer');
    expect(trace.modelInfo).toEqual({ models: ['Qwen3.8-Flash'] });
  });

  it('agentId 是兜底：事件里没有 provider.agent 时才用它', () => {
    const noProvider = turn().filter((e) => !e.provider);
    expect(build(noProvider, { sessionId: 's1', agentId: 'default' }).trace.agentName).toBe(
      'default',
    );
  });

  it('不落提问正文，只记长度（诊断包会被用户发出去）', () => {
    const { trace } = build(turn());
    expect(trace.metadata.promptChars).toBe('帮我改一下 a.ts'.length);
    expect(JSON.stringify(trace)).not.toContain('帮我改一下');
  });

  it('空事件不抛错，产出一份零跨度 trace（回合收尾路径不该被可观测性打断）', () => {
    const { trace, spans } = build([], { sessionId: 's1' });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.type).toBe('agent');
    expect(trace.status).toBe('ok');
    expect(trace.duration).toBe(0);
  });
});

describe('buildTurnTrace：span', () => {
  it('根是 agent、子 span 挂根上，parentId 成链', () => {
    const { trace, spans } = build(turn());
    const [root, ...rest] = spans;
    expect(root?.parentId).toBeNull();
    expect(root?.type).toBe('agent');
    expect(root?.spanId).toBeDefined();
    for (const s of rest) {
      expect(s.parentId).toBe(root!.spanId);
      expect(s.traceId).toBe(trace.traceId);
      expect(s.spanId).not.toBe(root!.spanId);
    }
  });

  it('生成窗口对齐助手消息的占位时刻与落盘时刻', () => {
    const gen = build(turn()).spans.find((s) => s.type === 'generation');
    expect(gen?.startedAt).toBe(iso(T0 + 150));
    expect(gen?.endedAt).toBe(iso(T0 + 3000));
    expect(gen?.duration).toBe(2850);
    expect(gen?.status).toBe('ok');
  });

  it('工具 span：配对上的记 ok，未配对的记 error 且文案是「结果未返回」而不是「失败」', () => {
    const fns = build(turn()).spans.filter((s) => s.type === 'function');
    expect(fns.map((s) => s.name)).toEqual(['read_file', 'exec']);

    const ok = fns[0]!;
    expect(ok.status).toBe('ok');
    expect(ok.error).toBeNull();
    expect(ok.toolName).toBe('read_file');
    expect(JSON.parse(ok.toolInput!)).toEqual({ path: 'a.ts' });
    expect(ok.toolOutput).toBe('file-body');
    expect(ok.duration).toBe(300);

    const missing = fns[1]!;
    expect(missing.status).toBe('error');
    expect(missing.error).toContain('结果未返回');
    expect(missing.duration).toBe(0);
  });

  it('工具返回 error 时 span 记 error 并带上原因', () => {
    const events = turn();
    const res = events.find((e) => e.type === 'function-call-result')!;
    if (res.type === 'function-call-result') {
      res.status = 'error';
      res.error = 'boom';
    }
    const fn = build(events).spans.find((s) => s.type === 'function');
    expect(fn?.status).toBe('error');
    expect(fn?.error).toBe('boom');
  });

  it('审批裁决记成 custom span，拒绝时 status=error（排障高频问题）', () => {
    const perm = build(turn()).spans.find((s) => s.type === 'custom');
    expect(perm?.name).toBe('permission');
    expect(perm?.toolName).toBe('write_file');
    expect(perm?.toolOutput).toBe('rejected');
    expect(perm?.status).toBe('error');
    expect(perm?.error).toBe('用户拒绝');
  });

  it('超长入参与结果被截断（trace 是诊断件，不是全文备份）', () => {
    const events = turn();
    const call = events.find((e) => e.type === 'function-call')!;
    if (call.type === 'function-call') call.args = { blob: 'x'.repeat(TRACE_FIELD_MAX_CHARS * 3) };
    const fn = build(events).spans.find((s) => s.type === 'function');
    expect(fn!.toolInput!.length).toBeLessThan(TRACE_FIELD_MAX_CHARS + 64);
    expect(fn!.toolInput).toContain('已截断');
  });
});

describe('buildTurnTrace：回合状态', () => {
  it('正常收尾是 ok', () => {
    expect(build(turn()).trace.status).toBe('ok');
  });

  it('中断 / 报错记 error，原因进 metadata', () => {
    const interrupted = build(turn({ reason: 'interrupted' }));
    expect(interrupted.trace.status).toBe('error');
    expect(interrupted.trace.metadata.reason).toBe('interrupted');
    expect(interrupted.spans[0]?.error).toContain('中断');

    const errored = build(turn({ reason: 'error' }));
    expect(errored.trace.status).toBe('error');
    expect(errored.spans[0]?.error).toContain('报错');
  });

  it('用户主动停止（aborted）**不算** error —— 否则失败率会被正常操作污染', () => {
    const aborted = build(turn({ reason: 'aborted' }));
    expect(aborted.trace.status).toBe('ok');
    expect(aborted.trace.metadata.reason).toBe('aborted');
  });

  it('回合内有 error 事件也判 error（不依赖 session-end 的 reason）', () => {
    const events = turn();
    events.splice(events.length - 1, 0, {
      id: 'e9',
      sessionId: 's1',
      parentId: 'e7',
      seq: 9,
      type: 'error',
      timestamp: T0 + 2500,
      message: 'boom',
    });
    expect(build(events).trace.status).toBe('error');
  });

  it('助手回合被中断时，generation span 也要记 error', () => {
    const gen = build(turn({ interrupted: true })).spans.find((s) => s.type === 'generation');
    expect(gen?.status).toBe('error');
    expect(gen?.error).toContain('未正常收尾');
  });
});

describe('buildTurnTrace：确定性（供测试注入 id）', () => {
  it('注入 traceId / spanId 工厂后，id 可预测、关系可断言', () => {
    let n = 0;
    const { trace, spans } = buildTurnTrace(turn(), {
      sessionId: 's1',
      traceId: 'trace_00000000000000000000000000000001',
      spanIdFactory: () => `span_${String(++n).padStart(24, '0')}`,
    });
    expect(trace.traceId).toBe('trace_00000000000000000000000000000001');
    expect(spans.map((s) => s.spanId)).toEqual([
      'span_000000000000000000000001',
      'span_000000000000000000000002',
      'span_000000000000000000000003',
      'span_000000000000000000000004',
      'span_000000000000000000000005',
    ]);
    expect(spans[1]?.parentId).toBe('span_000000000000000000000001');
  });

  it('乱序输入按 seq 归位（事件流读出来不保证顺序）', () => {
    const ordered = turn();
    const shuffled = [...ordered].reverse();
    expect(build(shuffled).trace.startedAt).toBe(build(ordered).trace.startedAt);
    expect(build(shuffled).spans.map((s) => s.name)).toEqual(
      build(ordered).spans.map((s) => s.name),
    );
  });
});
