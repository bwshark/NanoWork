/**
 * 专家包的生成 / 解析 / 导入对账（FR-3.3）。
 *
 * 用例的重点**不是**「happy path 能跑通」，而是三处「照直觉写就会错」的边界，
 * 每一条都对应一个会在真机上表现为「静默丢配置」的坑：
 *
 * 1. `toolAllow: []` 与「没设置」是两种语义（空数组 = 一个工具都不许）。任何
 *    `?? undefined` / `|| undefined` 的写法都会把最严的配置变成最松的；
 * 2. 头像超限**只丢头像**，不能让整份导出/导入失败（为了头像丢配置不值）；
 * 3. 模型目录为空 ≠ 所有预设都失效（冷启动第一轮不能把绑定悄悄删掉），
 *    但目录非空且查不到时必须丢弃（失效预设会让引擎每轮报错）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildExpertPackage,
  expertPackageFileName,
  expertPackageSlug,
  parseExpertPackage,
  planExpertImport,
  serializeExpertPackage,
} from '@/lib/agent/expertPackage';
import {
  EXPERT_PACKAGE_MAX_AVATAR_CHARS,
  EXPERT_PACKAGE_SCHEMA,
  type ExpertPackage,
} from '@/types/expertPackage';
import type { Agent } from '@/types';

function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: '前端专家',
    systemPrompt: '你是一位前端架构师。',
    skillIds: ['sk-1', 'sk-2'],
    imBinding: null,
    enabled: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    source: 'user',
    ...over,
  };
}

const skillNames: Record<string, string> = { 'sk-1': '代码审查', 'sk-2': '网页抓取' };

function pkgOf(over: Partial<ExpertPackage> = {}): ExpertPackage {
  return {
    schema: EXPERT_PACKAGE_SCHEMA,
    slug: 'frontend',
    version: '1.0.0',
    description: '',
    expertType: 'agent',
    skills: [{ id: 'sk-1', name: '代码审查' }],
    agent: { name: '前端专家', systemPrompt: '你是前端架构师。' },
    ...over,
  };
}

describe('buildExpertPackage：本地实体 → 包', () => {
  it('技能引用带出人类可读名（本地找不到 id 时回落 id 本身）', () => {
    const { pkg, warnings } = buildExpertPackage(makeAgent(), (id) => skillNames[id]);
    expect(pkg.skills).toEqual([
      { id: 'sk-1', name: '代码审查' },
      { id: 'sk-2', name: '网页抓取' },
    ]);
    // 未知技能不能变成空名字，否则导入方的「缺什么」提示里是一行空白
    const unknown = buildExpertPackage(makeAgent({ skillIds: ['sk-x'] }), (id) => skillNames[id]);
    expect(unknown.pkg.skills[0]).toEqual({ id: 'sk-x', name: 'sk-x' });
    expect(warnings).toEqual([]);
  });

  it('toolAllow 空数组必须原样进包（= 一个工具都不许，不能当成「没设置」）', () => {
    const { pkg } = buildExpertPackage(makeAgent({ toolAllow: [] }), (id) => id);
    expect(pkg.agent.toolAllow).toEqual([]);
    // 未设置的字段根本不出现在包里：`undefined` 与 `[]` 在 JSON 里必须能区分
    const none = buildExpertPackage(makeAgent(), (id) => id);
    expect('toolAllow' in none.pkg.agent).toBe(false);
  });

  it('头像超限：剔除头像并给出 warning，**不抛错**', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(EXPERT_PACKAGE_MAX_AVATAR_CHARS);
    const { pkg, warnings } = buildExpertPackage(makeAgent({ avatar: huge }), (id) => id);
    expect(pkg.agent.avatar).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('头像');
  });

  it('emoji 头像原样进包', () => {
    const { pkg, warnings } = buildExpertPackage(makeAgent({ avatar: '🌱' }), (id) => id);
    expect(pkg.agent.avatar).toBe('🌱');
    expect(warnings).toEqual([]);
  });

  it('包带上 schema 与导出时间（将来加版本判定时不用改结构）', () => {
    const { pkg } = buildExpertPackage(makeAgent(), (id) => id);
    expect(pkg.schema).toBe(EXPERT_PACKAGE_SCHEMA);
    expect(pkg.expertType).toBe('agent');
    expect(typeof pkg.exportedAt).toBe('string');
  });
});

describe('slug / 文件名', () => {
  it('中文原样保留，只清掉文件系统非法字符', () => {
    expect(expertPackageSlug('前端/架构师*')).toBe('前端架构师');
    expect(expertPackageSlug('  a  b  ')).toBe('a-b');
  });

  it('清理后为空时回落 expert（不能让文件名变成 `.nanowork-expert.json`）', () => {
    expect(expertPackageSlug('///')).toBe('expert');
    expect(expertPackageFileName('///')).toBe('expert.nanowork-expert.json');
  });
});

describe('parseExpertPackage：不可信文本 → 包', () => {
  it('round-trip：导出的文本能原样解析回来', () => {
    const { pkg } = buildExpertPackage(
      makeAgent({ avatar: '🌱', toolDeny: ['Bash'] }),
      (id) => skillNames[id],
    );
    const parsed = parseExpertPackage(serializeExpertPackage(pkg));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pkg.agent).toEqual(pkg.agent);
    expect(parsed.pkg.skills).toEqual(pkg.skills);
  });

  it('非 JSON → not-json（文案说的是「确认选的是专家包」而不是「文件坏了」）', () => {
    const r = parseExpertPackage('{ not json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('not-json');
  });

  it('schema 不符 → schema-mismatch，不做版本嗅探', () => {
    const r = parseExpertPackage(JSON.stringify({ ...pkgOf(), schema: 'nanowork.expert/v0' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('schema-mismatch');
  });

  it('团队包 → unsupported-expert-type，明确拒绝而不是按个体硬导', () => {
    const r = parseExpertPackage(JSON.stringify({ ...pkgOf(), expertType: 'team' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('unsupported-expert-type');
    expect(r.error).toContain('团队');
  });

  it('缺 name / systemPrompt / skills 一律拒（必填字段半懂不懂地猜最危险）', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ agent: { name: '  ', systemPrompt: '' } }, 'missing-field'],
      [{ agent: { name: 'x' } }, 'missing-field'],
      [{ skills: undefined }, 'missing-field'],
    ];
    for (const [over, kind] of cases) {
      const r = parseExpertPackage(JSON.stringify({ ...pkgOf(), ...over }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe(kind);
    }
  });

  it('单条坏技能引用只忽略那一条（多绑一个少绑一个是细粒度）', () => {
    const r = parseExpertPackage(
      JSON.stringify({ ...pkgOf(), skills: [{ id: 'sk-1' }, { nope: 1 }, 'oops'] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.skills).toEqual([{ id: 'sk-1', name: 'sk-1' }]);
    expect(r.warnings).toHaveLength(2);
  });

  it('包内头像超限 → 忽略头像 + warning，其余配置照常可用', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(EXPERT_PACKAGE_MAX_AVATAR_CHARS);
    const r = parseExpertPackage(
      JSON.stringify({
        ...pkgOf(),
        agent: { name: 'x', systemPrompt: 'y', avatar: huge },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.agent.avatar).toBeUndefined();
    expect(r.warnings.join()).toContain('头像');
  });

  it('可选字段类型不对只丢那个字段（不值得让整份配置作废）', () => {
    const r = parseExpertPackage(
      JSON.stringify({
        ...pkgOf(),
        agent: {
          name: 'x',
          systemPrompt: 'y',
          toolAllow: 'Read',
          model: 42,
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.agent.toolAllow).toBeUndefined();
    expect(r.pkg.agent.model).toBeUndefined();
    expect(r.warnings).toHaveLength(2);
  });

  it('toolAllow 空数组解析后仍是空数组', () => {
    const r = parseExpertPackage(
      JSON.stringify({ ...pkgOf(), agent: { name: 'x', systemPrompt: 'y', toolAllow: [] } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.agent.toolAllow).toEqual([]);
  });
});

describe('planExpertImport：包 + 本机现状 → 落地草稿', () => {
  it('缺技能不阻塞导入，只是不绑定（换台机器就装不进来最糟）', () => {
    const plan = planExpertImport(
      pkgOf({ skills: [{ id: 'sk-1', name: '代码审查' }, { id: 'sk-9', name: '知识库' }] }),
      { existingNames: [], skillIds: ['sk-1'] },
    );
    expect(plan.draft.skillIds).toEqual(['sk-1']);
    expect(plan.missingSkills).toEqual([{ id: 'sk-9', name: '知识库' }]);
  });

  it('重名自动改名，且二次重名也不撞', () => {
    const first = planExpertImport(pkgOf(), { existingNames: ['前端专家'], skillIds: [] });
    expect(first.name).toBe('前端专家（导入）');
    expect(first.renamed).toBe(true);

    const second = planExpertImport(pkgOf(), {
      existingNames: ['前端专家', '前端专家（导入）'],
      skillIds: [],
    });
    expect(second.name).toBe('前端专家（导入 2）');
  });

  it('重名判定忽略首尾空白与英文大小写', () => {
    const plan = planExpertImport(pkgOf({ agent: { name: 'Foo', systemPrompt: '' } }), {
      existingNames: ['  foo '],
      skillIds: [],
    });
    expect(plan.renamed).toBe(true);
  });

  it('模型目录非空且查不到 → 丢弃绑定并如实报出', () => {
    const plan = planExpertImport(
      pkgOf({ agent: { name: 'x', systemPrompt: '', model: 'gpt-x' } }),
      { existingNames: [], skillIds: [], presetIds: ['qwen', 'claude'] },
    );
    expect(plan.draft.model).toBeUndefined();
    expect(plan.missingModel).toBe('gpt-x');
  });

  it('模型目录为空 = 还没拉 → 保留绑定（冷启动第一轮不能把配置悄悄删掉）', () => {
    const plan = planExpertImport(
      pkgOf({ agent: { name: 'x', systemPrompt: '', model: 'gpt-x' } }),
      { existingNames: [], skillIds: [], presetIds: [] },
    );
    expect(plan.draft.model).toBe('gpt-x');
    expect(plan.missingModel).toBeUndefined();

    // 连 presetIds 都不传（未加载）同样放行
    const noCtx = planExpertImport(
      pkgOf({ agent: { name: 'x', systemPrompt: '', model: 'gpt-x' } }),
      { existingNames: [], skillIds: [] },
    );
    expect(noCtx.draft.model).toBe('gpt-x');
  });

  it('toolAllow 空数组在导入侧仍是空数组（把最严配置变成最松是最坏的 bug）', () => {
    const plan = planExpertImport(
      pkgOf({ agent: { name: 'x', systemPrompt: '', toolAllow: [] } }),
      { existingNames: [], skillIds: [] },
    );
    expect(plan.draft.toolAllow).toEqual([]);
    // 未设置时不能凭空长出空数组
    const none = planExpertImport(pkgOf(), { existingNames: [], skillIds: [] });
    expect(none.draft.toolAllow).toBeUndefined();
  });

  it('草稿带上头像 / 提示词 / 全局覆盖等全部可分发字段', () => {
    const plan = planExpertImport(
      pkgOf({
        agent: {
          name: 'x',
          systemPrompt: '你是 x',
          avatar: '🌱',
          promptDomain: 'coding',
          promptStyle: 'concise',
          toolDeny: ['Bash'],
        },
      }),
      { existingNames: [], skillIds: ['sk-1'] },
    );
    expect(plan.draft).toEqual({
      name: 'x',
      systemPrompt: '你是 x',
      skillIds: ['sk-1'],
      avatar: '🌱',
      promptDomain: 'coding',
      promptStyle: 'concise',
      toolDeny: ['Bash'],
    });
  });
});
