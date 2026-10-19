/**
 * 导入会话（助理 IM / 定时任务）的**深度思考**映射。
 *
 * ## 背景
 *
 * 引擎把模型的思考逐轮写进 assistant 记录的 `reasoning_content`（真实落盘样例：
 * `feishu.feishu:ou_xxx` 会话里每条 assistant 都带这个键，纯文本字符串）。
 * 任务视图里这份数据进 `message.process` 的「深度思考」段，由 `ProcessView`
 * 渲染成一条与工具行交错的时间线。
 *
 * `mapRecordsToMessages` 原先只映射 `content` 与 `tool_calls`，**完全没读
 * `reasoning_content`** —— 于是助理视图里工具执行行有（`已执行 curl.exe`）、
 * 深度思考却整段消失（2026-10-19 用户截图）。数据在磁盘上，只是没人取。
 *
 * ## 钉住的五件事
 *
 * 1. **思考与正文分家**：`reasoning_content` 进 `process`，绝不混进 `content`
 *    ——混了就会把「模型内心独白」当正式回答显示给用户。
 * 2. **按到达顺序与工具行交错**：`ProcessView` 渲染的是一条**时间线**，先想后做；
 *    把所有思考堆到工具之前会读成「想完才动手」，与真实过程不符。
 * 3. **连续 reasoning 累积成一段**：同一轮里连续多条 assistant 各带一段思考时
 *    应合并（与流式侧 `flushReasoning` 同口径），而不是每条记录一个气泡。
 * 4. **被工具打断后另起一段**：思考 → 工具 → 思考 是三段，不该把后一段并进前一段。
 * 5. **没有思考就不产生空段**：`reasoning_content` 缺失/null/空白一律不建段，
 *    否则会出现一个点开什么都没有的「深度思考」。
 */

import { describe, expect, it } from 'vitest';
import { mapRecordsToMessages, recordReasoning } from '@/lib/sessionImport';
import type { ProcessEvent } from '@/types';

const KEY = 'feishu.feishu:ou_xxx';

/** 构造一条 assistant 记录（只写用得到的字段，贴近真实落盘形状） */
function assistant(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: 'assistant', content, timestamp: '2026-10-19 10:00:00', ...extra };
}
function user(content: string): Record<string, unknown> {
  return { role: 'user', content, timestamp: '2026-10-19 09:59:00' };
}
function toolResult(toolCallId: string, content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: toolCallId, content, timestamp: '2026-10-19 10:00:01' };
}
function toolCall(id: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** 取某条助手消息的过程时间线 */
function processOf(messageIndex = 0): ProcessEvent[] {
  const messages = mapRecordsToMessages(KEY, CURRENT_RECORDS);
  return messages[messageIndex]?.process ?? [];
}

let CURRENT_RECORDS: Record<string, unknown>[] = [];

describe('recordReasoning：三种落盘形态', () => {
  it('纯字符串（deepseek/qwen 等 OpenAI 兼容端点的实际形态）', () => {
    expect(recordReasoning({ reasoning_content: '先确认日期' })).toBe('先确认日期');
  });

  it('content blocks 数组形态', () => {
    expect(
      recordReasoning({
        reasoning_content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
      }),
    ).toBe('第一段第二段');
  });

  it('{ text } 对象形态', () => {
    expect(recordReasoning({ reasoning_content: { text: '想一下' } })).toBe('想一下');
  });

  it('缺失 / null / 空白一律当「没有思考」', () => {
    expect(recordReasoning({})).toBe('');
    expect(recordReasoning({ reasoning_content: null })).toBe('');
    expect(recordReasoning({ reasoning_content: '   ' })).toBe('');
    expect(recordReasoning({ reasoning_content: 42 })).toBe('');
  });
});

describe('深度思考映射进 message.process', () => {
  it('⭐ reasoning_content 变成 reasoning 段，且不进正文', () => {
    const messages = mapRecordsToMessages(KEY, [
      user('离春节还有多久'),
      assistant('', { reasoning_content: '需要查 2027 年春节日期' }),
      assistant('还有 80 天。'),
    ]);
    const reply = messages[1];
    expect(reply.role).toBe('assistant');
    // 正文只有给用户看的回答
    expect(reply.content).toBe('还有 80 天。');
    // 思考在 process 里
    expect(reply.process).toEqual([
      { id: expect.stringContaining('#r'), kind: 'reasoning', content: '需要查 2027 年春节日期' },
    ]);
  });

  it('思考与工具行按到达顺序交错（先想后做）', () => {
    const messages = mapRecordsToMessages(KEY, [
      user('上海天气'),
      assistant('', { reasoning_content: '先查天气', tool_calls: [toolCall('c1', 'exec')] }),
      toolResult('c1', '晴 21℃'),
      assistant('上海今天晴，21℃。'),
    ]);
    const kinds = (messages[1].process ?? []).map((e) => e.kind);
    expect(kinds).toEqual(['reasoning', 'tool']);
  });

  it('工具之后的思考另起一段（不并进前一段）', () => {
    const messages = mapRecordsToMessages(KEY, [
      user('写个文件'),
      assistant('', { reasoning_content: '先想怎么写', tool_calls: [toolCall('c1', 'write_file')] }),
      toolResult('c1', 'ok'),
      assistant('', { reasoning_content: '再确认一下内容' }),
      assistant('写好了。'),
    ]);
    const reasoning = (messages[1].process ?? []).filter((e) => e.kind === 'reasoning');
    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((e) => e.content)).toEqual(['先想怎么写', '再确认一下内容']);
  });

  it('⭐ 连续多段思考累积成一段（与流式 flushReasoning 同口径）', () => {
    const messages = mapRecordsToMessages(KEY, [
      user('你好'),
      assistant('', { reasoning_content: '用户在打招呼' }),
      assistant('', { reasoning_content: '简短回应即可' }),
      assistant('你好！'),
    ]);
    const reasoning = (messages[1].process ?? []).filter((e) => e.kind === 'reasoning');
    // 连续两条 assistant 记录之间没有工具行打断 → 合并为一段
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].content).toBe('用户在打招呼\n\n简短回应即可');
  });

  it('没有思考时不产生空段（不出现空的「深度思考」）', () => {
    const messages = mapRecordsToMessages(KEY, [
      user('你好'),
      assistant('你好！'),
    ]);
    expect(messages[1].process).toBeUndefined();
  });

  it('工具行带结果与状态，供 ProcessView 渲染「已执行 …」', () => {
    const messages = mapRecordsToMessages(KEY, [
      user('上海天气'),
      assistant('', { tool_calls: [toolCall('c1', 'exec', { cmd: 'curl wttr.in' })] }),
      toolResult('c1', '晴 21℃'),
      assistant('21℃。'),
    ]);
    const tool = (messages[1].process ?? []).find((e) => e.kind === 'tool');
    expect(tool).toMatchObject({
      kind: 'tool',
      tool: 'exec',
      status: 'done',
      result: '晴 21℃',
      args: { cmd: 'curl wttr.in' },
    });
  });

  it('跨轮不串段：user 是轮边界，两轮思考各自成段', () => {
    const messages = mapRecordsToMessages(KEY, [
      user('第一问'),
      assistant('', { reasoning_content: '思考一' }),
      assistant('答一'),
      user('第二问'),
      assistant('', { reasoning_content: '思考二' }),
      assistant('答二'),
    ]);
    const first = (messages[1].process ?? []).filter((e) => e.kind === 'reasoning');
    const second = (messages[3].process ?? []).filter((e) => e.kind === 'reasoning');
    expect(first.map((e) => e.content)).toEqual(['思考一']);
    expect(second.map((e) => e.content)).toEqual(['思考二']);
  });

  it('多轮场景：每轮的思考都挂在自己那条消息上', () => {
    CURRENT_RECORDS = [
      user('第一问'),
      assistant('', { reasoning_content: '思考一' }),
      assistant('答一'),
      user('第二问'),
      assistant('', { reasoning_content: '思考二' }),
      assistant('答二'),
    ];
    // messages: [user, assistant, user, assistant]
    expect(processOf(1)).toHaveLength(1);
    expect(processOf(3)).toHaveLength(1);
  });
});