/**
 * 导入专家包对话框（FR-3.3）。
 *
 * 断言落在四件「做错了不报错」的事上：
 *
 * 1. **头像必须活着到 store** —— `createAgent` 是白名单式构造，漏一个字段就是
 *    「预览里显示含头像、导入后变回首字占位」，全程没有异常；
 * 2. **导入不动当前激活专家** —— 收下一个别人给的专家不等于立刻换人设，
 *    换了会让用户下一步正在打字的会话悄悄变人；
 * 3. **用户取消系统选文件框不算失败** —— 不该弹红色错误，也不该留一个空对话框；
 * 4. **缺技能只警告、不拦截** —— 拦掉就等于「这个包换台机器就装不进来」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformMocks = vi.hoisted(() => ({
  pickFile: vi.fn(),
}));

vi.mock('@/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform')>();
  return {
    ...actual,
    platform: { ...actual.platform, pickFile: platformMocks.pickFile },
  };
});

import { useAgentsStore } from '@/stores/agentsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { useModelsStore } from '@/stores/modelsStore';
import { ExpertPackageImportDialog } from '@/components/agents/ExpertPackageImportDialog';
import { EXPERT_PACKAGE_SCHEMA } from '@/types/expertPackage';
import type { Skill } from '@/types';
import { buttonByText, click, dialogRoot, flush, mount, unmount, waitForSettled } from './helpers/reactMount';

/** 最小可用专家包文本 */
function pkgText(over: Record<string, unknown> = {}, agent: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: EXPERT_PACKAGE_SCHEMA,
    slug: 'frontend',
    version: '1.2.0',
    description: '前端专家包',
    expertType: 'agent',
    skills: [{ id: 'sk-review', name: '代码审查' }],
    agent: {
      name: '导入的前端专家',
      systemPrompt: '你是一位前端架构师。',
      ...agent,
    },
    ...over,
  });
}

function seedSkills(): void {
  const skill: Skill = {
    id: 'sk-review',
    name: '代码审查',
    description: '',
    category: 'dev',
    prompt: 'p',
    source: 'builtin',
    enabled: true,
  } as Skill;
  // enabled 是派生字段，测试只需要 id/name 被读到
  useSkillsStore.setState({ skills: [skill] });
}

beforeEach(() => {
  platformMocks.pickFile.mockReset();
  seedSkills();
  useModelsStore.setState({ models: [] });
});

afterEach(() => {
  unmount();
});

/** 打开对话框并等它从「正在读取」走到终态 */
async function openAndSettle(): Promise<void> {
  mount(<ExpertPackageImportDialog open onClose={() => undefined} />);
  // 读到文件后 phase 会离开 reading：以「导入按钮存在」为界
  await waitForSettled(() => !!buttonByText(document, '导入'));
  await flush();
}

describe('导入专家包对话框', () => {
  it('成功导入：头像字段活着到 store，且不改当前激活专家', async () => {
    platformMocks.pickFile.mockResolvedValue({ name: 'pkg.json', content: pkgText({}, { avatar: '🌱' }) });

    const before = useAgentsStore.getState();
    const beforeCount = before.agents.length;
    const beforeActive = before.activeAgentId;

    await openAndSettle();
    click(buttonByText(dialogRoot(), '导入'));
    await flush();

    const after = useAgentsStore.getState();
    expect(after.agents).toHaveLength(beforeCount + 1);
    const created = after.agents[after.agents.length - 1];
    expect(created.name).toBe('导入的前端专家');
    expect(created.systemPrompt).toBe('你是一位前端架构师。');
    expect(created.skillIds).toEqual(['sk-review']);
    // ⚠️ 这条钉的是 createAgent 白名单漏 avatar 的老坑
    expect(created.avatar).toBe('🌱');
    // 导入 ≠ 立刻换人设
    expect(after.activeAgentId).toBe(beforeActive);
  });

  it('重名时落库用加过后缀的名字（预览里已可见）', async () => {
    useAgentsStore.setState({
      agents: [
        ...useAgentsStore.getState().agents,
        {
          id: 'u-existing',
          name: '导入的前端专家',
          systemPrompt: '',
          skillIds: [],
          imBinding: null,
          enabled: true,
          createdAt: '2026-10-01T00:00:00.000Z',
          source: 'user',
        },
      ],
    });
    platformMocks.pickFile.mockResolvedValue({ name: 'pkg.json', content: pkgText() });

    await openAndSettle();
    expect(dialogRoot().textContent).toContain('重名，已加后缀');
    click(buttonByText(dialogRoot(), '导入'));
    await flush();

    const names = useAgentsStore.getState().agents.map((a) => a.name);
    expect(names).toContain('导入的前端专家（导入）');
  });

  it('缺技能：给出警告但仍可导入，导入后只绑本地有的那些', async () => {
    platformMocks.pickFile.mockResolvedValue({
      name: 'pkg.json',
      content: pkgText({
        skills: [
          { id: 'sk-review', name: '代码审查' },
          { id: 'sk-missing', name: '知识库检索' },
        ],
      }),
    });

    await openAndSettle();
    const text = dialogRoot().textContent ?? '';
    expect(text).toContain('本机没有');
    expect(text).toContain('知识库检索');

    const importBtn = buttonByText(dialogRoot(), '导入');
    expect(importBtn?.disabled).toBe(false);
    click(importBtn);
    await flush();

    const created = useAgentsStore.getState().agents.at(-1);
    expect(created?.skillIds).toEqual(['sk-review']);
  });

  it('用户取消选文件 → 自动关闭，不新增专家、不报错误', async () => {
    platformMocks.pickFile.mockResolvedValue(null);
    const onClose = vi.fn();
    mount(<ExpertPackageImportDialog open onClose={onClose} />);
    await flush();

    expect(onClose).toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('坏文件：显示解析错误且导入按钮禁用', async () => {
    platformMocks.pickFile.mockResolvedValue({ name: 'bad.json', content: '{ nope' });

    await openAndSettle();
    expect(dialogRoot().textContent).toContain('不是合法 JSON');
    const importBtn = buttonByText(dialogRoot(), '导入');
    expect(importBtn?.disabled).toBe(true);
  });

  it('团队包被明确拒绝（不按个体硬导）', async () => {
    platformMocks.pickFile.mockResolvedValue({
      name: 'team.json',
      content: pkgText({ expertType: 'team' }),
    });

    await openAndSettle();
    expect(dialogRoot().textContent).toContain('团队');
    expect(buttonByText(dialogRoot(), '导入')?.disabled).toBe(true);
  });
});
