/**
 * 专家蓝图（自动创建专家 / 专家团的落地格式）。
 *
 * 断言落在四件「做错了不报错」的事上：
 *
 * 1. **坏 JSON 不剥离原文** —— 剥掉之后用户看到一段「凭空消失」的回答，
 *    而解析失败往往正是模型写坏了 JSON，那时原文是唯一线索；
 * 2. **技能白名单只收本地装了的** —— 不拦就会造出「卡片显示 3 技能、实际 0 生效」
 *    的专家，而界面上一切正常；
 * 3. **落库不动全局活跃专家** —— 用户只是想存下来，不是现在换人设；
 * 4. **专家团成员顺序 = 声明顺序** —— 首位是主理人，重排会让主理人跑到中间。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXPERT_BLUEPRINT_MAX_MEMBERS,
  applyExpertBlueprint,
  blueprintFromPluginExpert,
  extractExpertBlueprints,
  normalizeExpertBlueprint,
} from '@/lib/agent/expertBlueprint';
import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import type { PluginExpertPackage } from '@/types/plugin';

const fence = (lang: string, payload: unknown): string =>
  ['```' + lang, JSON.stringify(payload, null, 2), '```'].join('\n');

const agentPayload = {
  kind: 'agent',
  name: '跨境电商合规顾问',
  role: '合规顾问',
  description: '帮跨境卖家过合规',
  icon: '⚖️',
  systemPrompt: '你是跨境电商合规顾问，负责……',
  skillIds: ['web-search', 'not-installed'],
};

const teamPayload = {
  kind: 'team',
  name: '选品作战团',
  role: '选品作战团',
  description: '从选品到定价全流程',
  members: [
    { name: '齐活林', role: '交付总监', systemPrompt: '你是交付总监……' },
    { name: '许清楚', role: '产品经理', systemPrompt: '你是产品经理……' },
  ],
};

beforeEach(() => {
  useAgentsStore.setState({ agents: [], tombstones: {}, activeAgentId: null });
  useExpertGroupsStore.setState({ groups: [], tombstones: {}, activeGroupId: null });
});

describe('extractExpertBlueprints', () => {
  it('抽出蓝图并把代码块换成一行说明', () => {
    const content = `这是你的专家。\n\n${fence('nanowork-expert', agentPayload)}`;
    const { blueprints, stripped } = extractExpertBlueprints(content);
    expect(blueprints).toHaveLength(1);
    expect(blueprints[0].name).toBe('跨境电商合规顾问');
    expect(stripped).toContain('已生成专家蓝图「跨境电商合规顾问」');
    expect(stripped).not.toContain('"kind"');
    expect(stripped).toContain('这是你的专家。');
  });

  it('JSON 写坏时不剥离原文（否则用户看不到模型到底写了什么）', () => {
    const broken = ['```nanowork-expert', '{ "name": "半截" ', '```'].join('\n');
    const content = `说明在前\n\n${broken}`;
    const { blueprints, stripped } = extractExpertBlueprints(content);
    expect(blueprints).toHaveLength(0);
    expect(stripped).toBe(content);
  });

  it('没有围栏时原样返回，不误伤普通回答', () => {
    const content = '## 结论\n\n用 ```js 代码块也没关系';
    expect(extractExpertBlueprints(content)).toEqual({
      blueprints: [],
      stripped: content,
    });
  });

  it('专家团蓝图保留成员声明顺序', () => {
    const { blueprints } = extractExpertBlueprints(fence('nanowork-expert-team', teamPayload));
    expect(blueprints[0].kind).toBe('team');
    expect(blueprints[0].members?.map((m) => m.name)).toEqual(['齐活林', '许清楚']);
  });
});

describe('normalizeExpertBlueprint', () => {
  it('缺 name 直接判定为不可落地', () => {
    expect(normalizeExpertBlueprint({ kind: 'agent', systemPrompt: 'x' })).toBeNull();
  });

  it('没写 kind 但带 members 时按专家团处理', () => {
    const bp = normalizeExpertBlueprint({ name: '团', members: teamPayload.members });
    expect(bp?.kind).toBe('team');
  });

  it('成员数超上限时截断并给出说明', () => {
    const members = Array.from({ length: EXPERT_BLUEPRINT_MAX_MEMBERS + 2 }, (_, i) => ({
      name: `成员${i}`,
      systemPrompt: 'p',
    }));
    const bp = normalizeExpertBlueprint({ kind: 'team', name: '大团', members });
    expect(bp?.members).toHaveLength(EXPERT_BLUEPRINT_MAX_MEMBERS);
    expect(bp?.warnings.join()).toContain('多余');
  });

  it('成员没有提示词时用角色兜底并告警', () => {
    const bp = normalizeExpertBlueprint({
      kind: 'team',
      name: '团',
      members: [{ name: '甲', role: '研究员' }, { name: '乙', systemPrompt: 'p' }],
    });
    expect(bp?.members?.[0].systemPrompt).toContain('你是甲');
    expect(bp?.warnings.join()).toContain('没有提示词');
  });
});

describe('applyExpertBlueprint', () => {
  it('单人专家走 importAgent：落库但不改全局活跃专家', () => {
    useAgentsStore.setState((s) => ({ ...s, activeAgentId: 'builtin:general' }));
    const bp = normalizeExpertBlueprint(agentPayload)!;
    const result = applyExpertBlueprint(bp, {
      importAgent: useAgentsStore.getState().importAgent,
      createGroup: useExpertGroupsStore.getState().createGroup,
    });

    expect(result.agentIds).toHaveLength(1);
    expect(useAgentsStore.getState().activeAgentId).toBe('builtin:general');
    const created = useAgentsStore.getState().agents[0];
    expect(created.name).toBe('跨境电商合规顾问');
    expect(created.avatar).toBe('⚖️');
  });

  it('本地没装的技能被丢弃并说明（不制造「绑了但不生效」的假象）', () => {
    const bp = normalizeExpertBlueprint(agentPayload)!;
    const result = applyExpertBlueprint(
      bp,
      {
        importAgent: useAgentsStore.getState().importAgent,
        createGroup: useExpertGroupsStore.getState().createGroup,
      },
      { knownSkillIds: ['web-search'] },
    );

    expect(useAgentsStore.getState().agents[0].skillIds).toEqual(['web-search']);
    expect(result.warnings.join()).toContain('not-installed');
  });

  it('专家团先建成员再建团，memberIds 顺序与声明一致', () => {
    const bp = normalizeExpertBlueprint(teamPayload)!;
    const result = applyExpertBlueprint(bp, {
      importAgent: useAgentsStore.getState().importAgent,
      createGroup: useExpertGroupsStore.getState().createGroup,
    });

    const group = useExpertGroupsStore.getState().groups[0];
    expect(result.groupId).toBe(group.id);
    expect(group.memberIds).toEqual(result.agentIds);
    expect(group.mode).toBe('coordinator');
    expect(
      group.memberIds.map((id) => useAgentsStore.getState().agents.find((a) => a.id === id)?.name),
    ).toEqual(['齐活林', '许清楚']);
  });

  it('本地没有该模型预设时降级为跟随会话', () => {
    const bp = normalizeExpertBlueprint({ ...agentPayload, model: 'gpt-4o' })!;
    const result = applyExpertBlueprint(
      bp,
      {
        importAgent: useAgentsStore.getState().importAgent,
        createGroup: useExpertGroupsStore.getState().createGroup,
      },
      { knownModels: ['qwen-max'] },
    );
    expect(useAgentsStore.getState().agents[0].model).toBeUndefined();
    expect(result.warnings.join()).toContain('gpt-4o');
  });
});

describe('blueprintFromPluginExpert', () => {
  it('单人专家包用清单 displayName 当名字（md 里的 name 是 kebab 标识）', () => {
    const pkg: PluginExpertPackage = {
      name: 'react-dev',
      displayName: 'React 工程师',
      description: '前端开发',
      expertType: 'agent',
      agents: [
        { agentName: 'react-dev', name: 'react-dev', profession: '前端工程师', systemPrompt: '你是……' },
      ],
    };
    const bp = blueprintFromPluginExpert(pkg);
    expect(bp.kind).toBe('agent');
    expect(bp.name).toBe('React 工程师');
    expect(bp.role).toBe('前端工程师');
    expect(bp.systemPrompt).toBe('你是……');
  });

  it('团队包把全部成员带进蓝图并沿用声明顺序', () => {
    const pkg: PluginExpertPackage = {
      name: 'trading',
      displayName: '交易分析团',
      description: '',
      expertType: 'team',
      agents: [
        { agentName: 'lead', name: '何执舟', profession: '首席策略官', systemPrompt: 'a' },
        { agentName: 'risk', name: '严过关', profession: '风控', systemPrompt: 'b' },
      ],
    };
    const bp = blueprintFromPluginExpert(pkg);
    expect(bp.kind).toBe('team');
    expect(bp.members?.map((m) => m.name)).toEqual(['何执舟', '严过关']);
    expect(bp.mode).toBe('coordinator');
  });
});
