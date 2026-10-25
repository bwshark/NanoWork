/**
 * 「这条会话有没有对话记录」的**唯一判据**。
 *
 * ## 为什么不能只看 `session.messages.length`
 *
 * 消息是**按需水合**的：启动时列表只读索引，会话的 JSONL 要等用户点进去才读
 * （见 `sessionsStore.loadSessions`）。未点开的会话 `messages` 是 `[]`——不是
 * 「没有对话」，而是「还没读」。拿 `messages.length > 0` 当「有没有内容」的判据，
 * 重启之后几乎所有任务都会被判成空会话：侧边栏只剩当前打开的那一条，别的
 * 工作空间看起来「一个任务都没有」（用户报的正是这个现象）。
 *
 * 所以持久化那一侧必须带上条数：`Session.messageCount`（源自索引条目
 * `SessionIndexEntry.messageCount`，由追加时累加、重建时扫 JSONL 现算）。
 *
 * ## 两个来源的分工
 *
 * | 情形 | 用哪个 | 为什么 |
 * |---|---|---|
 * | 已水合（点开过 / 本进程新建） | `messages.length` | 活跃时间线的真实条数（编辑重发会废弃旧分支，索引里算的是全量） |
 * | 未水合（只读索引加载出来） | `messageCount` | 唯一可得的数据；为 `undefined` 说明本来就没有对话记录 |
 *
 * 两处调用：侧边栏任务列表（决定哪些任务与工作空间分组要显示）与输入框工具条
 * （有对话记录的会话不再显示工作空间选择）。判据必须共用一份，否则「侧边栏看得见、
 * 输入框却不认」这类漂移迟早出现。
 */

import type { Session } from '@/types';

/** 参与判定的字段（允许传入只带这两个字段的轻量对象，便于测试与选择器复用） */
type ConversationSource = Pick<Session, 'messages' | 'messageCount'>;

/**
 * 对话记录条数。
 *
 * 已水合的会话按活跃时间线算（`messages.length`）；未水合的回退到索引里的
 * 持久计数。两者都是 0 / 未知时才返回 0。
 */
export function conversationCount(session: ConversationSource): number {
  if (session.messages.length > 0) return session.messages.length;
  return session.messageCount ?? 0;
}

/** 这条会话是否已有对话记录（= 是否算得上一件「已经开工的任务」） */
export function hasConversation(session: ConversationSource): boolean {
  return conversationCount(session) > 0;
}
