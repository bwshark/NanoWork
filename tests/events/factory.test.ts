import { describe, expect, it } from 'vitest';
import { EventFactory } from '@/events/factory';
import type { SessionEvent } from '@/types/event';

/** 确定性工厂：固定时间源与 id 序列，便于断言链结构 */
function makeFactory(opts?: { sessionId?: string; startSeq?: number }) {
  let n = 0;
  const f = new EventFactory({
    sessionId: opts?.sessionId ?? 's1',
    ...(opts?.startSeq !== undefined ? { startSeq: opts.startSeq } : {}),
    now: () => 1_700_000_000_000,
    genId: () => `e${++n}`,
  });
  return f;
}

describe('EventFactory: 链结构与公共字段', () => {
  it('线性追加：seq 从 1 递增，parentId 串成单链，根为 null', () => {
    const f = makeFactory();
    const a = f.sessionStart({ agentId: 'a1', mode: 'craft', permissionMode: 'restricted' });
    const b = f.message({ messageId: 'm2', role: 'user', content: '你好' });
    const c = f.reasoning({ content: '思考中' });

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);

    expect(a.parentId).toBeNull();
    expect(b.parentId).toBe(a.id);
    expect(c.parentId).toBe(b.id);

    // 公共字段统一落位
    for (const ev of [a, b, c]) {
      expect(ev.sessionId).toBe('s1');
      expect(ev.timestamp).toBe(1_700_000_000_000);
      expect(typeof ev.id).toBe('string');
    }
  });

  it('tip 与 lastSeq 跟随链尖推进', () => {
    const f = makeFactory();
    expect(f.tip).toBeNull();
    expect(f.lastSeq).toBe(0);

    const a = f.message({ messageId: 'm1', role: 'user', content: 'hi' });
    expect(f.tip).toBe(a.id);
    expect(f.lastSeq).toBe(1);
  });

  it('各事件类型的判别字段正确落位（抽查）', () => {
    const f = makeFactory();
    const call = f.functionCall({ callId: 'c1', name: 'write_file', args: { path: '/a' } });
    expect(call.type).toBe('function-call');
    expect(call.callId).toBe('c1');
    expect(call.args).toEqual({ path: '/a' });

    const decision = f.permissionDecision({
      callId: 'c1',
      tool: 'write_file',
      decision: 'rejected',
      reason: '路径越界',
      source: 'engine',
    });
    expect(decision.decision).toBe('rejected');
    expect(decision.source).toBe('engine');

    const usage = f.usage({ model: 'gpt-x', inputTokens: 10, outputTokens: 20, cost: 0.001 });
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(20);
  });

  it('provider 逐事件透传；未提供时字段缺省（不落 undefined 语义）', () => {
    const f = makeFactory();
    const withProvider = f.message(
      { messageId: 'm1', role: 'assistant', content: 'ok' },
      { provider: { model: 'm1', traceId: 't1' } },
    );
    expect(withProvider.provider).toEqual({ model: 'm1', traceId: 't1' });

    const without = f.message({ messageId: 'm2', role: 'assistant', content: 'ok2' });
    expect(without.provider).toBeUndefined();
    expect('provider' in without).toBe(false);
  });
});

describe('EventFactory: 分支与续写', () => {
  it('显式 parentId 从既有节点分叉，且后续事件挂在新链尖', () => {
    const f = makeFactory();
    const root = f.sessionStart({ agentId: 'a1', mode: 'craft', permissionMode: 'restricted' });
    const first = f.message({ messageId: 'm1', role: 'user', content: '第一次' });
    // 从 root 处分叉：重走一遍
    const branch = f.message(
      { messageId: 'm2', role: 'user', content: '重走' },
      { parentId: root.id },
    );

    expect(branch.parentId).toBe(root.id);
    expect(branch.seq).toBe(3); // seq 仍单调递增，不因分叉回退

    // 分叉后链尖切到 branch，后续线性追加挂在 branch 上
    const after = f.reasoning({ content: '新分支的思考' });
    expect(after.parentId).toBe(branch.id);
    expect(first.parentId).toBe(root.id);
    expect(f.tip).toBe(after.id);
  });

  it('parentId: null 显式开新的根', () => {
    const f = makeFactory();
    f.message({ messageId: 'm1', role: 'user', content: 'a' });
    const rooted = f.message({ messageId: 'm2', role: 'user', content: 'b' }, { parentId: null });
    expect(rooted.parentId).toBeNull();
  });

  it('resumeFrom：对齐 seq 与链尖以安全续写（输入乱序也能归一）', () => {
    const f = makeFactory({ sessionId: 's9', startSeq: 1 });
    const history = [
      { id: 'h2', seq: 2 },
      { id: 'h1', seq: 1 },
      { id: 'h3', seq: 3 },
    ] as unknown as SessionEvent[];

    f.resumeFrom(history);
    expect(f.lastSeq).toBe(3);
    expect(f.tip).toBe('h3');

    const next = f.message({ messageId: 'm1', role: 'user', content: '继续' });
    expect(next.seq).toBe(4);
    expect(next.parentId).toBe('h3');
    expect(next.sessionId).toBe('s9');
  });

  it('resumeFrom 空数组为 no-op', () => {
    const f = makeFactory({ startSeq: 5 });
    f.resumeFrom([]);
    expect(f.lastSeq).toBe(4);
    expect(f.tip).toBeNull();
  });

  it('startSeq 支持续写既有会话（首条从给定序号开始）', () => {
    const f = makeFactory({ startSeq: 11 });
    const ev = f.message({ messageId: 'm1', role: 'user', content: 'x' });
    expect(ev.seq).toBe(11);
  });
});
