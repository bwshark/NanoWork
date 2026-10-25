import { describe, it, expect } from 'vitest';
import {
  activeFilterCount,
  deriveTaskStatus,
  filterTasks,
  isFilterDefault,
  matchAgent,
  matchQuery,
  matchStatus,
  matchTime,
  matchWorkspace,
  workspaceKeyOf,
  type TaskFilters,
} from '@/lib/task/taskQuery';
import type { Message, Session } from '@/types';

/** 构造测试用消息：只需 role + 可选 aborted / content */
function msg(role: Message['role'], extra: Partial<Message> = {}): Message {
  return {
    id: `${role}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    content: '',
    createdAt: new Date().toISOString(),
    ...extra,
  } as Message;
}

/** 构造测试用会话：只填被测逻辑真正读取的字段 */
function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    agentId: 'a1',
    title: '新任务',
    messages: [],
    permissionLog: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

const ALL: TaskFilters = { status: 'all', time: 'all', agentId: 'all', workspace: 'all' };

describe('deriveTaskStatus: 由会话推导任务状态', () => {
  it('流式进行中优先于任何历史消息形态', () => {
    const s = session({ messages: [msg('user'), msg('assistant')] });
    expect(deriveTaskStatus(s, 'streaming')).toBe('running');
    expect(deriveTaskStatus(s, 'thinking')).toBe('running');
    expect(deriveTaskStatus(s, 'tooling')).toBe('running');
  });

  it('流式已收敛（idle / done）时回落到历史推导', () => {
    const s = session({ messages: [msg('user'), msg('assistant')] });
    expect(deriveTaskStatus(s, 'idle')).toBe('done');
    expect(deriveTaskStatus(s, 'done')).toBe('done');
  });

  it('无任何消息 → 规划中', () => {
    expect(deriveTaskStatus(session())).toBe('planning');
  });

  it('末条是用户提问 → 待处理', () => {
    const s = session({ messages: [msg('assistant'), msg('user')] });
    expect(deriveTaskStatus(s)).toBe('pending');
  });

  it('末条助手回复带 aborted → 失败', () => {
    const s = session({
      messages: [msg('user'), msg('assistant', { aborted: true })],
    });
    expect(deriveTaskStatus(s)).toBe('failed');
  });

  it('末条助手回复正常 → 已完成', () => {
    const s = session({ messages: [msg('user'), msg('assistant')] });
    expect(deriveTaskStatus(s)).toBe('done');
  });

  it('历史里有 aborted 但末条正常，不算失败（只看末条）', () => {
    const s = session({
      messages: [
        msg('user'),
        msg('assistant', { aborted: true }),
        msg('user'),
        msg('assistant'),
      ],
    });
    expect(deriveTaskStatus(s)).toBe('done');
  });
});

describe('matchStatus: 状态维度筛选', () => {
  it('全部状态恒通过', () => {
    expect(matchStatus(session(), 'all')).toBe(true);
  });

  it('按派生状态精确匹配', () => {
    const s = session({ messages: [msg('user')] });
    expect(matchStatus(s, 'pending')).toBe(true);
    expect(matchStatus(s, 'done')).toBe(false);
  });

  it('流式状态参与 running 判定', () => {
    const s = session({ messages: [msg('user'), msg('assistant')] });
    expect(matchStatus(s, 'running', 'streaming')).toBe(true);
    expect(matchStatus(s, 'done', 'streaming')).toBe(false);
  });
});

describe('matchTime: 时间维度筛选（基于 updatedAt）', () => {
  // 固定"当前时刻"为 2026-09-12 12:00 本地时间，避免测试随时间漂移
  const now = new Date(2026, 8, 12, 12, 0, 0).getTime();
  const at = (y: number, m: number, d: number, h = 12) =>
    new Date(y, m - 1, d, h, 0, 0).toISOString();

  it('全部时间恒通过', () => {
    expect(matchTime(session(), 'all', now)).toBe(true);
  });

  it('今天：同自然日通过，昨天不通过', () => {
    expect(matchTime(session({ updatedAt: at(2026, 9, 12, 1) }), 'today', now)).toBe(true);
    expect(matchTime(session({ updatedAt: at(2026, 9, 11) }), 'today', now)).toBe(false);
  });

  it('最近 7 天：含今天在内的 7 个自然日', () => {
    // 今天往前数第 6 天（9/6）仍在窗口内，第 7 天（9/5）已超出
    expect(matchTime(session({ updatedAt: at(2026, 9, 6, 1) }), 'week', now)).toBe(true);
    expect(matchTime(session({ updatedAt: at(2026, 9, 5, 23) }), 'week', now)).toBe(false);
  });

  it('最近 30 天：含今天在内的 30 个自然日', () => {
    expect(matchTime(session({ updatedAt: at(2026, 8, 14, 1) }), 'month', now)).toBe(true);
    expect(matchTime(session({ updatedAt: at(2026, 8, 1) }), 'month', now)).toBe(false);
  });

  it('updatedAt 不可解析时不淘汰（脏数据不该把任务藏起来）', () => {
    expect(matchTime(session({ updatedAt: 'not-a-date' }), 'today', now)).toBe(true);
  });
});

describe('matchQuery: 关键词匹配标题 / 工作空间 / 消息正文', () => {
  const base = session({
    title: '排查网关离线',
    workdir: 'D:/Workspace/Codes/nanowork',
    messages: [msg('user', { content: '端口 8900 报错' })],
  });

  it('空关键词恒通过', () => {
    expect(matchQuery(base, '')).toBe(true);
    expect(matchQuery(base, '   ')).toBe(true);
  });

  it('命中标题', () => {
    expect(matchQuery(base, '网关')).toBe(true);
  });

  it('命中工作空间路径', () => {
    expect(matchQuery(base, 'nanowork')).toBe(true);
  });

  it('命中消息正文（只匹配标题会让「搜任务」几乎没用）', () => {
    expect(matchQuery(base, '8900')).toBe(true);
  });

  it('大小写不敏感且首尾空白被裁剪', () => {
    expect(matchQuery(base, '  NANOWORK  ')).toBe(true);
  });

  it('未命中任意字段返回 false', () => {
    expect(matchQuery(base, '不存在的关键词xyz')).toBe(false);
  });
});

describe('filterTasks: 组合筛选与排序', () => {
  const older = session({
    id: 'older',
    title: '旧任务',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messages: [msg('user'), msg('assistant')],
  });
  const newer = session({
    id: 'newer',
    title: '新任务',
    updatedAt: '2026-09-11T00:00:00.000Z',
    messages: [msg('user')],
  });
  const broken = session({
    id: 'broken',
    title: '坏数据',
    updatedAt: 'not-a-date',
    messages: [msg('user'), msg('assistant')],
  });

  it('结果按最近更新倒序，脏时间排到最后', () => {
    const out = filterTasks([older, newer, broken], { filters: ALL });
    expect(out.map((s) => s.id)).toEqual(['newer', 'older', 'broken']);
  });

  it('状态与关键词同时生效（AND 语义）', () => {
    const out = filterTasks([older, newer], {
      query: '任务',
      filters: { status: 'pending', time: 'all', agentId: 'all', workspace: 'all' },
    });
    expect(out.map((s) => s.id)).toEqual(['newer']);
  });

  it('筛选条件不匹配时返回空数组', () => {
    const out = filterTasks([older, newer], {
      filters: { status: 'failed', time: 'all', agentId: 'all', workspace: 'all' },
    });
    expect(out).toEqual([]);
  });

  it('流式状态参与筛选（流式中的会话可被「进行中」命中）', () => {
    const out = filterTasks([older, newer], {
      filters: { status: 'running', time: 'all', agentId: 'all', workspace: 'all' },
      streams: { older: { status: 'streaming' } },
    });
    expect(out.map((s) => s.id)).toEqual(['older']);
  });
});

describe('matchAgent: Agent 维度筛选', () => {
  it('全部 Agent 恒通过', () => {
    expect(matchAgent(session({ agentId: 'a1' }), 'all')).toBe(true);
    expect(matchAgent(session({ agentId: '' }), 'all')).toBe(true);
  });

  it('按具体 Agent id 精确匹配', () => {
    expect(matchAgent(session({ agentId: 'a1' }), 'a1')).toBe(true);
    expect(matchAgent(session({ agentId: 'a2' }), 'a1')).toBe(false);
  });

  it('空串匹配「未绑定专家」的会话', () => {
    expect(matchAgent(session({ agentId: '' }), '')).toBe(true);
    expect(matchAgent(session({ agentId: 'a1' }), '')).toBe(false);
  });
});

describe('matchWorkspace / workspaceKeyOf: 工作空间维度筛选', () => {
  // 默认工作空间落点（设置里那个默认路径）
  const def = 'C:/Users/xinmi/NanoWork';

  it('workspaceKeyOf：落在默认路径 → 空串；否则取 workdir', () => {
    expect(workspaceKeyOf(session({ workdir: def }), def)).toBe('');
    expect(workspaceKeyOf(session({ workdir: undefined }), def)).toBe('');
    expect(workspaceKeyOf(session({ workdir: 'D:/proj/x' }), def)).toBe('D:/proj/x');
  });

  it('全部工作空间恒通过', () => {
    expect(matchWorkspace(session({ workdir: def }), 'all', def)).toBe(true);
  });

  it('默认工作空间分组匹配 key 为空的会话', () => {
    expect(matchWorkspace(session({ workdir: def }), '', def)).toBe(true);
    expect(matchWorkspace(session({ workdir: 'D:/proj/x' }), '', def)).toBe(false);
  });

  it('具体工作空间分组按 key 精确匹配', () => {
    expect(matchWorkspace(session({ workdir: 'D:/proj/x' }), 'D:/proj/x', def)).toBe(true);
    expect(matchWorkspace(session({ workdir: def }), 'D:/proj/x', def)).toBe(false);
  });

  it('未传 defaultWorkspacePath 时也能区分默认组与具体路径', () => {
    expect(matchWorkspace(session({ workdir: 'D:/proj/x' }), 'D:/proj/x')).toBe(true);
    expect(matchWorkspace(session({ workdir: 'D:/proj/x' }), '')).toBe(false);
  });
});

describe('filterTasks: 组合维度（Agent / 工作空间）', () => {
  const def = 'C:/Users/xinmi/NanoWork';
  const a = session({ id: 'a', agentId: 'a1', workdir: def, title: 'A' });
  const b = session({ id: 'b', agentId: 'a2', workdir: 'D:/proj/x', title: 'B' });
  const c = session({ id: 'c', agentId: '', workdir: def, title: 'C' });

  it('按 Agent 维度收窄', () => {
    const out = filterTasks([a, b, c], {
      filters: { status: 'all', time: 'all', agentId: 'a2', workspace: 'all' },
      defaultWorkspacePath: def,
    });
    expect(out.map((s) => s.id)).toEqual(['b']);
  });

  it('按工作空间维度收窄（默认工作空间）', () => {
    const out = filterTasks([a, b, c], {
      filters: { status: 'all', time: 'all', agentId: 'all', workspace: '' },
      defaultWorkspacePath: def,
    });
    expect(out.map((s) => s.id).sort()).toEqual(['a', 'c']);
  });

  it('多维度 AND 组合', () => {
    const out = filterTasks([a, b, c], {
      filters: { status: 'all', time: 'all', agentId: 'a1', workspace: '' },
      defaultWorkspacePath: def,
    });
    expect(out.map((s) => s.id)).toEqual(['a']);
  });
});

describe('筛选条件的元信息辅助', () => {
  it('isFilterDefault 仅在四个维度都是 all 时为真', () => {
    expect(isFilterDefault(ALL)).toBe(true);
    expect(isFilterDefault({ status: 'running', time: 'all', agentId: 'all', workspace: 'all' })).toBe(false);
    expect(isFilterDefault({ status: 'all', time: 'today', agentId: 'all', workspace: 'all' })).toBe(false);
    expect(isFilterDefault({ status: 'all', time: 'all', agentId: 'a1', workspace: 'all' })).toBe(false);
    expect(isFilterDefault({ status: 'all', time: 'all', agentId: 'all', workspace: 'D:/x' })).toBe(false);
  });

  it('activeFilterCount 统计生效的维度数（用于漏斗图标高亮）', () => {
    expect(activeFilterCount(ALL)).toBe(0);
    expect(activeFilterCount({ status: 'done', time: 'all', agentId: 'all', workspace: 'all' })).toBe(1);
    expect(activeFilterCount({ status: 'done', time: 'week', agentId: 'all', workspace: 'all' })).toBe(2);
    expect(activeFilterCount({ status: 'done', time: 'week', agentId: 'a1', workspace: 'all' })).toBe(3);
    expect(activeFilterCount({ status: 'done', time: 'week', agentId: 'a1', workspace: 'D:/x' })).toBe(4);
  });
});
