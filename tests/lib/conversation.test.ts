/**
 * 「有没有对话记录」的判据（`@/lib/conversation`）。
 *
 * 这个判据决定两件用户直接看得见的事：
 * 1. 侧边栏里这条任务、以及它所在的工作空间分组要不要显示；
 * 2. 输入框里还要不要显示工作空间选择入口。
 *
 * 它曾经被写成 `session.messages.length > 0`，而消息是**按需水合**的：启动时列表
 * 只读索引，JSONL 要等点进去才读。于是重启后没点开过的会话消息留白，全被判成
 * 空任务——侧边栏只剩当前打开的那一条，别的工作空间看起来「一个任务都没有」。
 * 索引里的 `messageCount` 就是为这条判据准备的持久数据。
 */

import { describe, expect, it } from 'vitest';
import { conversationCount, hasConversation } from '@/lib/conversation';
import type { Message, Session } from '@/types';

function session(over: Partial<Session>): Session {
  return {
    id: 's1',
    agentId: '',
    title: '任务',
    messages: [],
    permissionLog: [],
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    ...over,
  };
}

const message = (content: string): Message =>
  ({ id: `m-${content}`, role: 'user', content }) as Message;

describe('conversationCount / hasConversation', () => {
  it('未水合（messages 留白）时用索引里的持久条数', () => {
    const s = session({ messages: [], messageCount: 14 });
    expect(conversationCount(s)).toBe(14);
    expect(hasConversation(s)).toBe(true);
  });

  it('已水合时以消息为准（活跃时间线的真实条数）', () => {
    const s = session({ messages: [message('a'), message('b')], messageCount: 9 });
    expect(conversationCount(s)).toBe(2);
    expect(hasConversation(s)).toBe(true);
  });

  it('从未用过的新任务：两个来源都是空 → 不算有记录', () => {
    const fresh = session({ messages: [], messageCount: 0 });
    expect(conversationCount(fresh)).toBe(0);
    expect(hasConversation(fresh)).toBe(false);
    // 本进程新建、还没落盘的会话连字段都没有
    const unborn = session({ messages: [] });
    expect(conversationCount(unborn)).toBe(0);
    expect(hasConversation(unborn)).toBe(false);
  });

  it('索引说有记录、但活跃时间线为空时仍算有记录（宁可显示也不要藏起来）', () => {
    // 理论上只可能出现在「消息都在废弃分支上」的极端情形：此时磁盘上确实有对话
    // 记录，把它从列表里藏掉会让用户找不到自己的任务
    const s = session({ messages: [], messageCount: 3 });
    expect(hasConversation(s)).toBe(true);
  });
});
