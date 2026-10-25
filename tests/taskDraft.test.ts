import { describe, it, expect } from 'vitest';
import type { Message } from '@/types';
import { makeTaskName, buildTaskDraftFromMessage, type TaskDraft } from '@/lib/task/taskDraft';

/** 构造一条最小 Message 用于测试 */
function msg(content: string): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
  };
}

describe('makeTaskName', () => {
  it('短文本原样返回', () => {
    expect(makeTaskName('每周竞品动态汇总')).toBe('每周竞品动态汇总');
  });

  it('超过 20 字截断并补省略号', () => {
    const long = '一'.repeat(25);
    const got = makeTaskName(long);
    expect(got.length).toBe(21);
    expect(got.endsWith('…')).toBe(true);
    expect(got.startsWith('一'.repeat(20))).toBe(true);
  });

  it('空串回退为「新任务」', () => {
    expect(makeTaskName('')).toBe('新任务');
    expect(makeTaskName('   ')).toBe('新任务');
  });

  it('多行文本只取首行并 trim', () => {
    expect(makeTaskName('  首行标题  \n第二行内容')).toBe('首行标题');
  });
});

describe('buildTaskDraftFromMessage', () => {
  it('返回 name/prompt/agentId 且不含 id/createdAt', () => {
    const content = '每周一把竞品动态汇总给我';
    const draft = buildTaskDraftFromMessage(msg(content), 'agent-7');

    expect(draft.name).toBe(makeTaskName(content));
    expect(draft.prompt).toBe(content);
    expect(draft.agentId).toBe('agent-7');

    const keys = Object.keys(draft);
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('createdAt');
  });

  it('name 走 makeTaskName 规则（长消息截断）', () => {
    const long = 'X'.repeat(30);
    const draft = buildTaskDraftFromMessage(msg(long), 'a1');
    expect(draft.name).toBe('X'.repeat(20) + '…');
  });

  it('类型满足 TaskDraft（去 id/createdAt）', () => {
    const draft = buildTaskDraftFromMessage(msg('hello'), 'a');
    // 编译期保证 TaskDraft 不含 id/createdAt；此处仅做运行期形状校验
    const asDraft: TaskDraft = {
      name: draft.name!,
      prompt: draft.prompt!,
      agentId: draft.agentId!,
      status: 'enabled',
      schedule: { kind: 'once', at: new Date().toISOString() },
    };
    expect(asDraft).toBeTruthy();
  });
});

describe('buildTaskDraftFromMessage：从正文推断执行频率（FR-5.5 补）', () => {
  it('⭐ 认得出时间规则就填进草稿', () => {
    const draft = buildTaskDraftFromMessage(msg('每周一早上9点提醒我开周会'), 'a1');
    expect(draft.schedule).toEqual({ kind: 'cron', expr: '0 9 * * 1' });
  });

  it('⭐ 认不出来就**不填** —— 让表单用它自己的默认值，而不是塞一个猜的', () => {
    const draft = buildTaskDraftFromMessage(msg('帮我看看这段报错'), 'a1');
    expect('schedule' in draft).toBe(false);
  });

  it('间隔类同样认', () => {
    const draft = buildTaskDraftFromMessage(msg('每30分钟检查一次构建状态'), 'a1');
    expect(draft.schedule).toEqual({ kind: 'interval', minutes: 30 });
  });

  it('推断只影响 schedule，不动 name / prompt', () => {
    const content = '每天9点把昨日的告警汇总发我';
    const draft = buildTaskDraftFromMessage(msg(content), 'a1');
    expect(draft.name).toBe(makeTaskName(content));
    expect(draft.prompt).toBe(content);
  });
});
