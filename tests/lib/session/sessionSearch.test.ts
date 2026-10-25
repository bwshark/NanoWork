import { describe, it, expect, beforeEach } from 'vitest';
import { getEventStore, __setEventStoreForTest, createMemoryEventStore } from '@/events';
import type { EventStore } from '@/events/store';
import { startEvent, msgEvent } from '../../events/fixtures';
import { searchSessions, clearSearchBodyCache } from '@/lib/session/sessionSearch';
import { DEFAULT_TASK_FILTERS, type TaskFilters } from '@/lib/task/taskQuery';
import type { Message, Session } from '@/types';

/** 构造一条「未水合」的会话（messages 留白），模拟列表态只持有索引/元数据的场景 */
function unhydratedSession(
  id: string,
  agentId: string,
  shard: string,
  title: string,
  updatedAt: string,
): Session {
  return {
    id,
    agentId,
    title,
    workdir: shard,
    streamWorkdir: shard,
    messages: [],
    permissionLog: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

const ALL: TaskFilters = { ...DEFAULT_TASK_FILTERS };
const DEF = 'D:/proj/a';

let store: EventStore;

beforeEach(() => {
  store = createMemoryEventStore();
  __setEventStoreForTest(store);
  clearSearchBodyCache();
});

describe('searchSessions: 跨会话全文检索（列表态消息留白）', () => {
  // 三条会话都**未水合**（messages 为空），正文只能从事件流读回
  const a = unhydratedSession('s-a', 'a1', DEF, '排查网关离线', '2026-09-10T00:00:00.000Z');
  const b = unhydratedSession('s-b', 'a2', 'D:/proj/b', '牧场数据整理', '2026-09-08T00:00:00.000Z');
  const c = unhydratedSession('s-c', '', DEF, '默认助手会话', '2026-09-05T00:00:00.000Z');
  const all = [a, b, c];

  beforeEach(async () => {
    // 用与 session.streamWorkdir 一致的 shard 落盘事件流
    await store.append({
      sessionId: 's-a',
      workdir: DEF,
      events: [startEvent('s-a'), msgEvent(2, '端口 8900 报错', 'user', 's-a'), msgEvent(3, '已重启服务', 'assistant', 's-a')],
    });
    await store.append({
      sessionId: 's-b',
      workdir: 'D:/proj/b',
      events: [startEvent('s-b'), msgEvent(2, '牛只移动轨迹异常', 'user', 's-b')],
    });
    await store.append({
      sessionId: 's-c',
      workdir: DEF,
      events: [startEvent('s-c'), msgEvent(2, '网关端口配置', 'user', 's-c')],
    });
  });

  it('关键词命中未水合会话的正文（全文，而非只有标题）', async () => {
    const out = await searchSessions(all, { query: '8900', filters: ALL });
    expect(out.map((s) => s.id)).toEqual(['s-a']);
  });

  it('正文全文命中多条会话，结果按 updatedAt 倒序', async () => {
    const out = await searchSessions(all, { query: '端口', filters: ALL });
    expect(out.map((s) => s.id)).toEqual(['s-a', 's-c']);
  });

  it('标题同步命中（无需读事件流也能命中）', async () => {
    const out = await searchSessions(all, { query: '网关', filters: ALL });
    // s-a 标题含「网关」，s-c 正文含「网关」
    expect(out.map((s) => s.id).sort()).toEqual(['s-a', 's-c']);
  });

  it('Agent 维度与全文组合（AND）', async () => {
    const out = await searchSessions(all, {
      query: '端口',
      filters: { ...ALL, agentId: 'a1' },
    });
    expect(out.map((s) => s.id)).toEqual(['s-a']);
  });

  it('工作空间维度与全文组合（AND），默认工作空间按 key 空串匹配', async () => {
    const out = await searchSessions(all, {
      query: '网关',
      filters: { ...ALL, workspace: '' },
      defaultWorkspacePath: DEF,
    });
    // 落在 DEF 上的 s-a / s-c 都属默认工作空间分组
    expect(out.map((s) => s.id).sort()).toEqual(['s-a', 's-c']);
  });

  it('无关键词时等价于纯维度筛选（不读事件流）', async () => {
    const out = await searchSessions(all, {
      query: '',
      filters: { ...ALL, agentId: 'a2' },
    });
    expect(out.map((s) => s.id)).toEqual(['s-b']);
  });

  it('已水合会话的正文同步匹配（不依赖事件流读回）', async () => {
    const hydratedA: Session = {
      ...a,
      messages: [
        { id: 'm', role: 'user', content: '端口 8900 报错', createdAt: a.updatedAt } as unknown as Message,
      ],
    };
    const out = await searchSessions([hydratedA, b, c], { query: '8900', filters: ALL });
    expect(out.map((s) => s.id)).toEqual(['s-a']);
  });
});
