/**
 * 启动时的任务列表：**未水合的会话必须照样出现**。
 *
 * 用户报的现象：侧边栏里 `temp` / `tmp` / `test` 等工作空间显示成
 * 「暂无任务」，而磁盘上那些目录里明明躺着几十条对话（索引里 `D:\test` 就有 18 条）。
 * 根因不是分组规则，而是列表拿 `session.messages.length > 0` 当「有没有内容」的判据——
 * 消息是按需水合的（启动只读索引，JSONL 等点开才读），于是**所有没点开过的任务**
 * 都被判成空任务：侧边栏只剩当前打开的那一条，其余工作空间看起来一个任务都没有。
 *
 * 现在判据是 `hasConversation`（先看消息、再看索引里的持久条数 `messageCount`），
 * 这里锁两件事：
 * 1. `loadSessions` 把索引里的 `messageCount` 带进会话视图（且**不做水合**）；
 * 2. 用侧边栏那套规则过滤 + 分组后，只有**真有对话记录**的工作空间才有分组——
 *    工作空间下没有对话记录就不显示（这正是用户要的口径）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionsStore } from '@/stores/sessionsStore';
import { groupSessionsByWorkdir } from '@/layout/SidebarNav';
import { hasConversation } from '@/lib/session/conversation';
import { resetEventStream } from './helpers/eventStream';
import { msgEvent, sessionMeta, startEvent } from './events/fixtures';
import type { EventStore } from '@/events';

const CHATTY = 'D:\\work\\ranch';
const IDLE = 'D:\\work\\empty';
const FARM = 'D:\\work\\farm';

let store: EventStore;

/** 造一条「已经聊过」的会话：session-start + 用户/助手各一条消息 */
async function seedChatty(id: string, workdir: string, title: string): Promise<void> {
  await store.writeMeta(sessionMeta({ id, title, workdir }));
  await store.append({
    sessionId: id,
    workdir,
    events: [startEvent(id), msgEvent(2, '你好', 'user', id), msgEvent(3, '你好呀', 'assistant', id)],
  });
}

/** 造一条「建了但从没聊过」的会话：只有 session-start */
async function seedIdle(id: string, workdir: string): Promise<void> {
  await store.writeMeta(sessionMeta({ id, title: '新任务', workdir }));
  await store.append({ sessionId: id, workdir, events: [startEvent(id)] });
}

beforeEach(async () => {
  store = resetEventStream();
  useSessionsStore.setState({ sessions: [], activeId: null });
  await seedChatty('s-ranch', CHATTY, '牧场改一版');
  await seedIdle('s-empty', IDLE);
  await seedChatty('s-farm', FARM, '牛只数据');
  await useSessionsStore.getState().loadSessions();
});

describe('启动水合：列表不依赖消息水合', () => {
  it('索引里的会话全部进内存视图，且消息仍然留白（不为此读 JSONL）', () => {
    const sessions = useSessionsStore.getState().sessions;
    expect(sessions.map((s) => s.id).sort()).toEqual(['s-empty', 's-farm', 's-ranch']);
    for (const s of sessions) expect(s.messages).toEqual([]);
  });

  it('把索引里的对话记录条数带进视图（有对话的 > 0，没聊过的 = 0）', () => {
    const byId = new Map(useSessionsStore.getState().sessions.map((s) => [s.id, s]));
    expect(byId.get('s-ranch')?.messageCount).toBe(2);
    expect(byId.get('s-farm')?.messageCount).toBe(2);
    expect(byId.get('s-empty')?.messageCount).toBe(0);
  });

  it('侧边栏可见性 + 分组：只有真有对话记录的工作空间成组', () => {
    const listed = useSessionsStore
      .getState()
      .sessions.filter((s) => hasConversation(s) && !s.channel && !s.readonly);
    const groups = groupSessionsByWorkdir(listed, undefined, undefined);

    expect(groups.map((g) => g.key).sort()).toEqual([CHATTY, FARM].sort());
    // 只建了任务、从没聊过的工作空间不出现在侧边栏
    expect(groups.some((g) => g.key === IDLE)).toBe(false);
    // 每个组都真的带着任务（没有空分组占位）
    for (const g of groups) expect(g.sessions.length).toBeGreaterThan(0);
  });
});
