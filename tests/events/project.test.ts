import { describe, expect, it } from 'vitest';
import { EventFactory } from '@/events/factory';
import {
  UNBOUND_AGENT_SENTINEL,
  deriveMetaFromEvents,
  parseSessionMeta,
} from '@/events/indexFile';
import {
  activePath,
  metaToSession,
  projectMessages,
  projectPermissionLog,
  projectSession,
} from '@/events/project';
import type { SessionEvent } from '@/types/event';

/**
 * 投影模块单测：把事件流折回视图的语义基准。
 *
 * 重点覆盖三类容易出错的地方：
 * 1. **顺序陷阱**——助手 `message` 事件在回合末尾落盘，其 `seq` 晚于同回合的
 *    工具 / 思考事件，因此归属必须靠 `messageId` 而不能靠「就近」；
 * 2. **分支废弃**——「编辑后重发」留下的旧事件仍在文件里，必须靠 DAG 回溯排除；
 * 3. **容错**——缺字段 / 断链 / 环不应抛错，最坏只是少渲染一条。
 */

function makeFactory(sessionId = 's1') {
  let n = 0;
  return new EventFactory({
    sessionId,
    now: () => 1_700_000_000_000 + n * 10,
    genId: () => `e${++n}`,
  });
}

function start(f: EventFactory) {
  return f.sessionStart({ agentId: 'a1', mode: 'craft', permissionMode: 'restricted' });
}

describe('activePath：从尖端回溯出活跃时间线', () => {
  it('空事件集返回空数组', () => {
    expect(activePath([])).toEqual([]);
  });

  it('线性链全部返回，且按 seq 升序', () => {
    const f = makeFactory();
    const events = [
      start(f),
      f.message({ messageId: 'u1', role: 'user', content: '你好' }),
      f.message({ messageId: 'a1', role: 'assistant', content: '在的' }),
    ];
    expect(activePath(events).map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('输入乱序也按 seq 归一', () => {
    const f = makeFactory();
    const events = [
      start(f),
      f.message({ messageId: 'u1', role: 'user', content: '你好' }),
    ];
    expect(activePath([events[1], events[0]]).map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('排除废弃分支：分叉后旧分支不再出现在时间线上', () => {
    const f = makeFactory();
    const s = start(f);
    const u1 = f.message({ messageId: 'u1', role: 'user', content: '原始' });
    const a1 = f.message({ messageId: 'a1', role: 'assistant', content: '旧回答' });
    // 「编辑后重发」：新事件从被替换消息处（u1）分叉，复用同一个 messageId
    const u1b = f.message({ messageId: 'u1', role: 'user', content: '改过的' }, { parentId: u1.id });
    const a1b = f.message({ messageId: 'a2', role: 'assistant', content: '新回答' });

    const path = activePath([s, u1, a1, u1b, a1b]);
    // u1 → u1b → a1b 在链上；a1 被绕开
    expect(path.map((e) => e.id)).toEqual([s.id, u1.id, u1b.id, a1b.id]);
    expect(path.some((e) => e.id === a1.id)).toBe(false);
  });

  it('parentId 指向缺失事件时截断而不抛错', () => {
    const broken = {
      id: 'x2',
      sessionId: 's1',
      parentId: 'missing',
      seq: 2,
      type: 'message',
      timestamp: 2,
      messageId: 'u1',
      role: 'user',
      content: '孤岛',
    } as SessionEvent;
    expect(activePath([broken]).map((e) => e.id)).toEqual(['x2']);
  });

  it('环（数据损坏）不会死循环', () => {
    const a = { id: 'a', sessionId: 's1', parentId: 'b', seq: 1, type: 'session-end' } as SessionEvent;
    const b = { id: 'b', sessionId: 's1', parentId: 'a', seq: 2, type: 'session-end' } as SessionEvent;
    expect(activePath([a, b]).length).toBeLessThanOrEqual(3);
  });
});

describe('projectMessages：一条 message 事件一条消息', () => {
  it('助手事件 seq 晚于同回合工具事件时，工具仍归属该助手消息', () => {
    const f = makeFactory();
    const path = [
      start(f),
      f.message({ messageId: 'u1', role: 'user', content: '读一下文件' }),
      f.functionCall({
        messageId: 'a1',
        callId: 'c1',
        name: 'read_file',
        args: { path: '/a.txt' },
      }),
      f.functionCallResult({
        messageId: 'a1',
        callId: 'c1',
        name: 'read_file',
        status: 'ok',
        result: '内容',
      }),
      // 回合结束才落盘的助手终值
      f.message({ messageId: 'a1', role: 'assistant', content: '文件内容是…', durationMs: 1234 }),
    ];

    const messages = projectMessages(path);

    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toBe('文件内容是…');
    expect(messages[1].durationMs).toBe(1234);
    expect(messages[1].process).toEqual([
      { id: 'c1', kind: 'tool', tool: 'read_file', args: { path: '/a.txt' }, status: 'done', result: '内容' },
    ]);
  });

  it('reasoning 段聚合：未闭合续写、done 后闭合并另开新段', () => {
    const f = makeFactory();
    const path = [
      f.message({ messageId: 'a1', role: 'assistant', content: '答' }),
      f.reasoning({ messageId: 'a1', content: '第一段' }),
      f.reasoning({ messageId: 'a1', content: '（续）' }),
      f.reasoning({ messageId: 'a1', content: '第二段', done: true }),
    ];

    const messages = projectMessages(path);
    expect(messages[0].process).toEqual([
      { id: 'e2', kind: 'reasoning', content: '第一段（续）' },
      { id: 'e4', kind: 'reasoning', content: '第二段', closed: true },
    ]);
  });

  it('工具结果先于请求到达时也能补齐出行', () => {
    const f = makeFactory();
    const path = [
      f.functionCallResult({
        messageId: 'a1',
        callId: 'c9',
        name: 'exec',
        status: 'error',
        error: '权限不足',
      }),
      f.message({ messageId: 'a1', role: 'assistant', content: '失败' }),
    ];

    const messages = projectMessages(path);
    expect(messages[0].process).toEqual([
      { id: 'c9', kind: 'tool', tool: 'exec', args: {}, status: 'error', error: '权限不足' },
    ]);
  });

  it('permission-decision 落成工具卡片与权限记录', () => {
    const f = makeFactory();
    const path = [
      f.message({ messageId: 'a1', role: 'assistant', content: '写好了' }),
      f.permissionDecision({
        messageId: 'a1',
        callId: 'req-1',
        tool: 'write_file',
        args: { path: '/b.txt' },
        decision: 'rejected',
        reason: '越界',
        source: 'engine',
      }),
    ];

    const messages = projectMessages(path);
    expect(messages[0].toolCalls).toEqual([
      { id: 'req-1', tool: 'write_file', args: { path: '/b.txt' }, sensitive: true, status: 'rejected' },
    ]);
    // 审计日志走独立入口（扫全量事件，见 projectPermissionLog 的说明）
    const permissionLog = projectPermissionLog(path);
    expect(permissionLog).toHaveLength(1);
    expect(permissionLog[0]).toMatchObject({ tool: 'write_file', decision: 'rejected' });
    // reason 不进 PermissionLog（视图模型没有该字段），但决策本身要如实落位
    expect(permissionLog[0].args).toEqual({ path: '/b.txt' });
  });

  it('artifact 还原为内联产物', () => {
    const f = makeFactory();
    const path = [
      f.message({ messageId: 'a1', role: 'assistant', content: '见图' }),
      f.artifact({
        messageId: 'a1',
        artifactId: 'art1',
        kind: 'html',
        name: '页面',
        content: '<h1>hi</h1>',
        language: 'html',
      }),
    ];

    const messages = projectMessages(path);
    expect(messages[0].artifacts).toEqual([
      {
        id: 'art1',
        type: 'html',
        title: '页面',
        content: '<h1>hi</h1>',
        language: 'html',
        createdAt: new Date(1_700_000_000_000 + 20).toISOString(),
      },
    ]);
  });

  it('附件 / 富文本 / 中断标记往返一致', () => {
    const f = makeFactory();
    const path = [
      f.message({
        messageId: 'u1',
        role: 'user',
        content: '看这个',
        richContent: '看这个\uE000att1\uE001',
        attachments: [{ id: 'att1', name: 'a.pdf', kind: 'document', mime: 'application/pdf', size: 10 }],
      }),
      f.message({ messageId: 'a1', role: 'assistant', content: '好', aborted: true }),
    ];

    const messages = projectMessages(path);
    expect(messages[0].attachments).toEqual([
      { id: 'att1', name: 'a.pdf', size: 10, mime: 'application/pdf', kind: 'document' },
    ]);
    expect(messages[0].richContent).toBe('看这个\uE000att1\uE001');
    expect(messages[1].aborted).toBe(true);
  });

  it('引擎侧中断（interrupted）与用户中断（aborted）必须分开复原', () => {
    // 两者在界面上是不同文案（已中断 / 已停止）、在上下文重建与记忆写入上的处置也不同，
    // 合并成一个字段会让「上游断流」看起来像用户自己按了停止。
    const f = makeFactory();
    const path = [
      f.message({ messageId: 'a1', role: 'assistant', content: '半截', interrupted: true }),
      f.message({ messageId: 'a2', role: 'assistant', content: '半截', aborted: true }),
    ];

    const messages = projectMessages(path);
    expect(messages[0].interrupted).toBe(true);
    expect(messages[0].aborted).toBeUndefined();
    expect(messages[1].aborted).toBe(true);
    expect(messages[1].interrupted).toBeUndefined();
  });

  it('附件 kind 非法时降级为 other；缺 size/mime 补安全默认', () => {
    const f = makeFactory();
    const path = [
      f.message({
        messageId: 'u1',
        role: 'user',
        content: 'x',
        attachments: [{ id: 'a1', name: 'x.bin', kind: 'weird' }],
      }),
    ];
    const messages = projectMessages(path);
    expect(messages[0].attachments).toEqual([
      { id: 'a1', name: 'x.bin', size: 0, mime: '', kind: 'other' },
    ]);
  });

  it('无 messageId 的回合内事件被忽略（不误挂到别的消息上）', () => {
    const f = makeFactory();
    const path = [
      f.message({ messageId: 'a1', role: 'assistant', content: '答' }),
      f.reasoning({ content: '游离的思考' }),
      f.functionCall({ callId: 'c1', name: 'x', args: {} }),
    ];

    const messages = projectMessages(path);
    expect(messages).toHaveLength(1);
    expect(messages[0].process).toBeUndefined();
  });

  it('同一 messageId 多條 message 事件时取最后一条（重发后新内容生效）', () => {
    const f = makeFactory();
    const u1 = f.message({ messageId: 'u1', role: 'user', content: '原始' });
    const u1b = f.message({ messageId: 'u1', role: 'user', content: '改过的' }, { parentId: u1.id });
    const messages = projectMessages([u1, u1b]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('改过的');
  });

  it('不影响消息的事件类型被安全跳过', () => {
    const f = makeFactory();
    const path = [
      start(f),
      f.message({ messageId: 'u1', role: 'user', content: 'hi' }),
      f.aiTitle({ title: '自动标题' }),
      f.usage({ inputTokens: 1, outputTokens: 2 }),
      f.error({ message: 'boom' }),
      f.sessionEnd({ reason: 'done' }),
    ];
    const messages = projectMessages(path);
    expect(messages.map((m) => m.id)).toEqual(['u1']);
  });
});

describe('projectSession：元数据 + 事件流 → 会话视图', () => {
  it('meta 字段映射到 Session（含权限两轴与技能）', () => {
    const session = metaToSession({
      id: 's1',
      title: '标题',
      agentId: 'a1',
      groupId: 'g1',
      workdir: '/w',
      mode: 'craft',
      model: 'm',
      permissionMode: 'full',
      toolApproval: true,
      skillIds: ['sk1'],
      pinned: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(session).toMatchObject({
      id: 's1',
      title: '标题',
      agentId: 'a1',
      groupId: 'g1',
      workdir: '/w',
      fullAccess: true,
      toolApproval: true,
      skillIds: ['sk1'],
      pinned: true,
      model: 'm',
    });
  });

  it('permissionMode=restricted 时不落 fullAccess 字段（保持「未设置」语义）', () => {
    const session = metaToSession({
      id: 's1',
      title: 't',
      agentId: 'a1',
      mode: 'ask',
      permissionMode: 'restricted',
      createdAt: 'x',
      updatedAt: 'y',
    });
    expect('fullAccess' in session).toBe(false);
  });

  it('projectSession 串联元数据与事件流', () => {
    const f = makeFactory();
    const events = [
      start(f),
      f.message({ messageId: 'u1', role: 'user', content: '你好' }),
      f.message({ messageId: 'a1', role: 'assistant', content: '在的' }),
    ];
    const session = projectSession(
      {
        id: 's1',
        title: '会话',
        agentId: 'a1',
        mode: 'craft',
        permissionMode: 'restricted',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      events,
    );

    expect(session.messages.map((m) => m.content)).toEqual(['你好', '在的']);
    expect(session.permissionLog).toEqual([]);
  });
});

/**
 * 「新建任务」刻意不绑专家，此时 `Session.agentId` 是空串，请求里省略 `agent_id`。
 *
 * 但 meta / 索引层**区分不了空串与字段缺失**（旧版本写下的 meta 甚至没有这个字段），
 * 所以那一层统一用占位表达「未绑定」，回到领域层再由 `metaToSession` 还原成空串。
 * 这组用例守的就是这条往返：不还原的话，白纸会话重启后会变成绑定 `default` 专家，
 * 输入框里又冒出 chip——实时视图与重放投影从此发散。
 */
describe('未绑定专家：meta 层用占位表达，回到领域层还原为空串', () => {
  it('session-start 的 agentId 是空串 → meta 落占位（不是留空串）', () => {
    const f = makeFactory();
    const meta = deriveMetaFromEvents('s1', [
      f.sessionStart({ agentId: '', mode: 'craft', permissionMode: 'restricted' }),
    ]);

    expect(meta.agentId).toBe(UNBOUND_AGENT_SENTINEL);
  });

  it('缺 session-start 且无兜底时也落占位（表单形态唯一）', () => {
    const f = makeFactory();
    const meta = deriveMetaFromEvents('s1', [
      f.message({ messageId: 'u1', role: 'user', content: '你好' }),
    ]);

    expect(meta.agentId).toBe(UNBOUND_AGENT_SENTINEL);
  });

  it('占位还原成空串——白纸会话重启后仍是白纸', () => {
    const session = metaToSession({
      id: 's1',
      title: '新任务',
      agentId: UNBOUND_AGENT_SENTINEL,
      mode: 'craft',
      permissionMode: 'restricted',
      createdAt: 'x',
      updatedAt: 'y',
    });

    expect(session.agentId).toBe('');
  });

  it('真实专家 id 原样保留，不被占位误伤', () => {
    const session = metaToSession({
      id: 's1',
      title: '标题',
      agentId: 'agent-test',
      mode: 'craft',
      permissionMode: 'restricted',
      createdAt: 'x',
      updatedAt: 'y',
    });

    expect(session.agentId).toBe('agent-test');
  });

  it('索引往返（推导 → 落盘 → 读回 → 还原）之后仍是空串', () => {
    const f = makeFactory();
    const meta = deriveMetaFromEvents('s1', [
      f.sessionStart({ agentId: '', mode: 'craft', permissionMode: 'restricted' }),
    ]);

    const reread = parseSessionMeta(JSON.stringify(meta));
    expect(reread).not.toBeNull();
    expect(metaToSession(reread!).agentId).toBe('');
  });
});
