import { describe, expect, it } from 'vitest';
import type { Agent, PromptSlotState, Skill } from '@/types';
import type { OrgAsset } from '@/types/orgAsset';
import {
  agentPayload,
  landAgent,
  landPrompt,
  landSkill,
  promptPayload,
  publishCandidates,
  publishDraft,
  skillPayload,
} from '@/lib/orgAsset/orgAssetPayload';

function agentOf(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: '审稿人',
    systemPrompt: '你是严格的审稿人。\n只指出问题。',
    skillIds: ['skill-1'],
    imBinding: null,
    enabled: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function skillOf(over: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    name: '读文件',
    description: '先读再答',
    category: '工程',
    prompt: '先读文件再回答',
    source: 'local',
    enabled: true,
    scope: 'user',
    path: 'C:/Users/boss/.nanowork/skills/read/SKILL.md',
    installedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function slotOf(over: Partial<PromptSlotState> = {}): PromptSlotState {
  const slot = {
    kind: 'mode' as const,
    key: 'plan',
    label: '计划模式',
    description: '先出方案再动手',
    builtin: '内置：先出方案',
  };
  return { slot, override: '自定义：先出方案', effective: '自定义：先出方案', ...over };
}

function assetOf(over: Partial<OrgAsset> = {}): OrgAsset {
  return {
    id: 'asset-1',
    orgId: 'o1',
    kind: 'agent',
    name: '审稿人',
    description: '',
    payload: { systemPrompt: '你是严格的审稿人。' },
    publishedBy: 'u1',
    publishedByEmail: 'boss@corp.example',
    publishedAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    ...over,
  };
}

describe('agentPayload（白名单构造）', () => {
  it('⛔ 机器 / 账号专属字段一律不上云', () => {
    const payload = agentPayload(
      agentOf({
        imBinding: { platform: 'wecom', account: 'bot-1', status: 'online' },
        knowledge: { orgId: 'o1', kbIds: ['kb-1'] },
      }),
    );
    // 这三个键都是「发布者本机的状态」，带到导入方就是一份指不到东西的坏配置
    expect('imBinding' in payload).toBe(false);
    expect('knowledge' in payload).toBe(false);
    expect('path' in payload).toBe(false);
  });

  it('⛔ toolAllow: [] 必须原样带上（空数组 = 一个工具都不许）', () => {
    const payload = agentPayload(agentOf({ toolAllow: [], toolDeny: ['exec'] }));
    expect(payload.toolAllow).toEqual([]);
    expect(payload.toolDeny).toEqual(['exec']);
  });

  it('未设置 toolAllow 时不能落成空数组（那会变成「一个都不许」）', () => {
    const payload = agentPayload(agentOf());
    expect('toolAllow' in payload).toBe(false);
  });

  it('data: 头像不上云；emoji 头像带上', () => {
    expect('avatar' in agentPayload(agentOf({ avatar: 'data:image/png;base64,AAAA' }))).toBe(
      false,
    );
    expect(agentPayload(agentOf({ avatar: '🌱' })).avatar).toBe('🌱');
  });
});

describe('skillPayload', () => {
  it('⛔ 剥掉 path / installedAt / scope / source', () => {
    const payload = skillPayload(skillOf());
    for (const key of ['path', 'installedAt', 'scope', 'source', 'enabled', 'id']) {
      expect(key in payload).toBe(false);
    }
  });

  it('保留正文与工具面（allowedTools: [] 也是有效值）', () => {
    const payload = skillPayload(skillOf({ allowedTools: [] }));
    expect(payload.prompt).toBe('先读文件再回答');
    expect(payload.allowedTools).toEqual([]);
  });
});

describe('promptPayload', () => {
  it('优先取自定义正文', () => {
    expect(promptPayload(slotOf()).text).toBe('自定义：先出方案');
  });

  it('没有自定义时退回内置（只是兜底：界面只列自定义过的槽位）', () => {
    const state = slotOf({ override: null, effective: '内置：先出方案' });
    expect(promptPayload(state).text).toBe('内置：先出方案');
  });
});

describe('publishCandidates', () => {
  const source = {
    agents: [agentOf({ id: 'builtin:x', name: '内置专家' }), agentOf()],
    skills: [skillOf({ id: 'builtin:s', source: 'builtin', name: '内置技能' }), skillOf()],
    promptStates: [
      slotOf(),
      slotOf({
        slot: { kind: 'style', key: 'plain', label: '朴素', description: '', builtin: 'x' },
        override: null,
        effective: 'x',
      }),
    ],
  };

  it('排除内置专家与内置技能', () => {
    expect(publishCandidates('agent', source).map((c) => c.name)).toEqual(['审稿人']);
    expect(publishCandidates('skill', source).map((c) => c.name)).toEqual(['读文件']);
  });

  it('提示词只列自定义过的槽位（发布内置默认等于抄一份出厂内容进组织库）', () => {
    expect(publishCandidates('prompt', source).map((c) => c.id)).toEqual(['mode.plan']);
  });
});

describe('publishDraft', () => {
  const source = { agents: [agentOf()], skills: [skillOf()], promptStates: [slotOf()] };

  it('专家的说明取系统提示词首行（他自己写的一句话定位）', () => {
    const draft = publishDraft('agent', 'a1', source);
    expect(draft?.description).toBe('你是严格的审稿人。');
  });

  it('选不到（被删 / 换了种类）返回 null', () => {
    expect(publishDraft('agent', 'nope', source)).toBeNull();
    expect(publishDraft('prompt', 'a1', source)).toBeNull();
  });

  it('草稿里的载荷已经是剥干净的（不含 path）', () => {
    const draft = publishDraft('skill', 'skill-1', source);
    expect(draft?.payload).not.toHaveProperty('path');
  });
});

describe('landAgent', () => {
  it('未知技能被丢弃并给出说明（不是静默）', () => {
    const { draft, warnings } = landAgent(
      assetOf({
        payload: { systemPrompt: 'x', skillIds: ['skill-1', 'gone'] },
      }),
      { knownSkillIds: ['skill-1'] },
    );
    expect(draft.skillIds).toEqual(['skill-1']);
    expect(warnings.join('')).toContain('gone');
  });

  it('⛔ 本地没有的模型预设要丢弃（留着会让每轮都发不出去）', () => {
    const { draft, warnings } = landAgent(
      assetOf({ payload: { systemPrompt: 'x', model: 'gone-model' } }),
      { knownPresetIds: ['agnes-3.0-flash'] },
    );
    expect(draft.model).toBeUndefined();
    expect(warnings.join('')).toContain('gone-model');
  });

  it('预设目录还没加载（空集）时不校验模型 —— 不能把「没加载」当成「全都失效」', () => {
    const { draft } = landAgent(
      assetOf({ payload: { systemPrompt: 'x', model: 'some-model' } }),
      { knownPresetIds: [] },
    );
    expect(draft.model).toBe('some-model');
  });

  it('⛔ toolAllow: [] 落地后仍是 []（不能变成「不限制」）', () => {
    const { draft } = landAgent(
      assetOf({ payload: { systemPrompt: 'x', toolAllow: [] } }),
      {},
    );
    expect(draft.toolAllow).toEqual([]);
  });

  it('重名走与专家包导入同一条规则（「（导入）」后缀）', () => {
    const { draft, warnings } = landAgent(assetOf(), { existingNames: ['审稿人'] });
    expect(draft.name).toBe('审稿人（导入）');
    expect(warnings.join('')).toContain('同名');
  });

  it('脏载荷不会炸：字段类型错就当没给', () => {
    const { draft } = landAgent(
      assetOf({ payload: { systemPrompt: 42, skillIds: 'nope', toolAllow: 'nope' } }),
      {},
    );
    expect(draft.systemPrompt).toBe('');
    expect(draft.skillIds).toEqual([]);
    expect(draft.toolAllow).toBeUndefined();
  });
});

describe('landSkill', () => {
  it('id 用 org:<资产 id>，重复导入是覆盖而不是装两份', () => {
    const skill = landSkill(assetOf({ kind: 'skill', payload: { prompt: '正文' } }));
    expect(skill.id).toBe('org:asset-1');
    // `installSkill` 的可删判据：非 builtin 且不是项目级
    expect(skill.source).toBe('market');
    expect(skill.scope).toBeUndefined();
  });

  it('正文缺失时是空串（由页面拦下并提示，不在这一层抛错）', () => {
    expect(landSkill(assetOf({ kind: 'skill', payload: {} })).prompt).toBe('');
  });
});

describe('landPrompt', () => {
  it('正常载荷 → 三元组', () => {
    expect(
      landPrompt(
        assetOf({ kind: 'prompt', payload: { kind: 'mode', key: 'plan', text: '新正文' } }),
      ),
    ).toEqual({ kind: 'mode', key: 'plan', text: '新正文' });
  });

  it('槽位种类不在闭集 / 正文为空 / key 为空 → null', () => {
    const bad = (payload: Record<string, unknown>) =>
      landPrompt(assetOf({ kind: 'prompt', payload }));
    expect(bad({ kind: 'whatever', key: 'plan', text: 'x' })).toBeNull();
    expect(bad({ kind: 'mode', key: 'plan', text: '   ' })).toBeNull();
    expect(bad({ kind: 'mode', key: '', text: 'x' })).toBeNull();
  });
});
