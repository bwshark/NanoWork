import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { platform } from '@/platform';
import { useAgentsStore } from '@/stores/agentsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useSkillsStore } from '@/stores/skillsStore';
import type { Skill } from '@/types';

/**
 * FR-8.9 第二条来源的**接线**契约：store 的用户动作必须真的留下一条记录。
 *
 * 为什么单独一组用例：`lib/appAudit.ts` 的纯逻辑全绿**不能**证明接上了线——
 * 「函数对但没人调」正是本仓反复踩过的静默失效（`hook_manifest` 那次）。
 * 因此这里断言的是「某个具体动作 → 落出某个具体 action id」。
 *
 * 只覆盖有代表性的四类（专家 / 定时任务 / 连接器 / 技能）；渠道与安全策略的写入
 * 需要主进程 IO，留给真机验收（见 docs 的 FR-8.9 落地口径）。
 */

/** 取出最后一次写入的审计行并解析 */
function lastLine(spy: MockInstance<typeof platform.auditAppendApp>): Record<string, unknown> {
  const calls = spy.mock.calls as unknown as [string[]][];
  expect(calls.length).toBeGreaterThan(0);
  const lines = calls[calls.length - 1][0];
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

let spy: MockInstance<typeof platform.auditAppendApp>;

beforeEach(() => {
  spy = vi.spyOn(platform, 'auditAppendApp').mockResolvedValue({ ok: true });
  useAgentsStore.setState({ agents: [], tombstones: {}, activeAgentId: null });
  useTasksStore.setState({ tasks: [], tombstones: {} });
  useMcpStore.setState({ configs: [], tombstones: {} });
  useSkillsStore.setState({ skills: [], overrides: [], pinnedIds: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('专家（agentsStore）', () => {
  it('新建 / 启停 / 修改 / 删除各留一条', () => {
    const agent = useAgentsStore.getState().createAgent({ name: '写作专家' });
    expect(lastLine(spy)).toMatchObject({
      action: 'agent.create',
      targetId: agent.id,
      targetLabel: '写作专家',
      outcome: 'ok',
    });

    useAgentsStore.getState().toggleAgent(agent.id);
    expect(lastLine(spy)).toMatchObject({ action: 'agent.toggle', detail: { enabled: false } });

    useAgentsStore.getState().updateAgent(agent.id, { name: '写作专家 v2' });
    const update = lastLine(spy);
    expect(update.action).toBe('agent.update');
    expect(update.detail).toEqual({ fields: ['name'] });

    useAgentsStore.getState().removeAgent(agent.id);
    expect(lastLine(spy)).toMatchObject({ action: 'agent.delete', targetId: agent.id });
  });

  it('内置专家不可删除时不留「删过」的假账', () => {
    useAgentsStore.setState({
      agents: [
        {
          id: 'builtin:x',
          name: '内置',
          prompt: '',
          source: 'builtin',
          enabled: true,
          skillIds: [],
        } as never,
      ],
    });
    spy.mockClear();
    useAgentsStore.getState().removeAgent('builtin:x');
    expect(spy).not.toHaveBeenCalled();
  });

  it('patch 无实际变化时不记（避免空转刷屏）', () => {
    const agent = useAgentsStore.getState().createAgent({ name: '不变' });
    spy.mockClear();
    useAgentsStore.getState().updateAgent(agent.id, { name: '不变' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('定时任务（tasksStore）', () => {
  it('表单新建留痕；引擎镜像（自带 id）不留痕', () => {
    const created = useTasksStore.getState().addTask({ name: '日报' });
    expect(created).not.toBeNull();
    expect(lastLine(spy)).toMatchObject({ action: 'task.create', targetLabel: '日报' });

    spy.mockClear();
    useTasksStore.getState().addTask({ id: 'engine-job-1', name: '模型建的' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('启停与删除留痕', () => {
    const task = useTasksStore.getState().addTask({ name: '周报' });
    spy.mockClear();
    useTasksStore.getState().toggleTask(task!.id);
    expect(lastLine(spy)).toMatchObject({ action: 'task.toggle', detail: { enabled: false } });
    useTasksStore.getState().removeTask(task!.id);
    expect(lastLine(spy)).toMatchObject({ action: 'task.delete', targetId: task!.id });
  });
});

describe('连接器（mcpStore）', () => {
  it('新建 / 启停留痕，且字段名进 detail', () => {
    const cfg = useMcpStore.getState().addConfig({ name: 'docs', transport: 'url' });
    expect(lastLine(spy)).toMatchObject({ action: 'mcp.create', targetLabel: 'docs' });

    useMcpStore.getState().toggleMcp(cfg.id);
    expect(lastLine(spy)).toMatchObject({ action: 'mcp.toggle', detail: { enabled: false } });
  });

  it('只改凭据字段的 update 不算「改配置」（saveSecrets 内部走同一入口）', () => {
    const cfg = useMcpStore.getState().addConfig({ name: 'vaulted', transport: 'url' });
    spy.mockClear();
    useMcpStore.getState().updateConfig(cfg.id, { authKeyNames: ['apiKey'] });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('技能（skillsStore）', () => {
  const skill: Skill = {
    id: 's1',
    name: '周报助手',
    description: '',
    category: 'writing',
    prompt: '',
    source: 'local',
    enabled: true,
    override: 'on',
  };

  it('安装 / 改档 / 卸载各留一条', () => {
    useSkillsStore.getState().installSkill(skill);
    expect(lastLine(spy)).toMatchObject({ action: 'skill.install', targetId: 's1' });

    useSkillsStore.getState().setSkillOverride('s1', 'off');
    expect(lastLine(spy)).toMatchObject({
      action: 'skill.override',
      targetId: 's1',
      detail: { override: 'off' },
    });

    useSkillsStore.getState().removeSkill('s1');
    expect(lastLine(spy)).toMatchObject({ action: 'skill.remove', targetId: 's1' });
  });
});
