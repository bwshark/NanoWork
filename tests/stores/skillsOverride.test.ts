/**
 * 技能三态覆盖的 store 行为（FR-3.1）。
 *
 * 两条关键不变量：
 * 1. `enabled` 是 `override` 的**派生值**（`enabled === (override !== 'off')`）。
 *    任何一处单独写 `enabled` 都会制造出「界面显示已启用、实际是 off」的漂移。
 * 2. 覆盖表变化必须**推给引擎**。不推的话界面上的「停用」只是本地不显示，
 *    引擎照旧把该技能列进模型的可用技能清单——那是最难自查的一类不一致。
 *
 * 另外覆盖老数据的迁移：v1 只有布尔的 `enabled`，v2 起是三态。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { useSkillsStore } from '@/stores/skillsStore';
import { SKILLS } from '@/ai/builtinSkills';
import type { Skill } from '@/types';

const FIRST_BUILTIN = SKILLS[0].id;

/** 每个用例都从一个干净的、已水合完成的 store 开始 */
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // 出厂状态：内置技能齐全、状态全 on、无同步错误、覆盖表为空
  // （`overrides` 必须显式清：它是用户意图的权威表，跨用例残留会让依赖其现值的
  // 动作读到上一条用例的状态）
  useSkillsStore.setState({
    skills: SKILLS.map((s) => ({ ...s, override: 'on', enabled: true })),
    overrides: [],
    pinnedIds: [],
    loaded: false,
    syncError: null,
  });
});

function skillAt(id: string): Skill {
  const found = useSkillsStore.getState().skills.find((s) => s.id === id);
  expect(found).toBeTruthy();
  return found as Skill;
}

/** 捕获推给引擎的覆盖表（按调用顺序） */
function spySync(ok = true): string[] {
  const payloads: string[] = [];
  vi.spyOn(platform, 'syncNanobotSkills').mockImplementation(async (json: string) => {
    payloads.push(json);
    return ok ? { ok: true, message: '' } : { ok: false, message: '写入失败：磁盘只读' };
  });
  return payloads;
}

describe('setSkillOverride', () => {
  it('三档都能写入，并且同步派生 enabled', () => {
    const spy = spySync();

    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'off');
    expect(skillAt(FIRST_BUILTIN).override).toBe('off');
    expect(skillAt(FIRST_BUILTIN).enabled).toBe(false);

    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'user-invocable-only');
    expect(skillAt(FIRST_BUILTIN).override).toBe('user-invocable-only');
    // 中间档在客户端仍然「能用」：只是不让模型自己伸手
    expect(skillAt(FIRST_BUILTIN).enabled).toBe(true);

    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'on');
    expect(skillAt(FIRST_BUILTIN).override).toBe('on');
    expect(skillAt(FIRST_BUILTIN).enabled).toBe(true);

    expect(spy).toHaveLength(3);
  });

  it('对不存在的 id 是空操作，不会凭空加技能', () => {
    spySync();
    const before = useSkillsStore.getState().skills.length;
    useSkillsStore.getState().setSkillOverride('does-not-exist', 'off');
    expect(useSkillsStore.getState().skills).toHaveLength(before);
  });

  it('保持「只有 off 才是停用」的不变量', () => {
    spySync();
    for (const value of ['on', 'user-invocable-only', 'off'] as const) {
      useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, value);
      const skill = skillAt(FIRST_BUILTIN);
      expect(skill.enabled).toBe(value !== 'off');
    }
  });
});

describe('toggleSkill / setSkillEnabled 的既有入口', () => {
  it('toggleSkill 只在 on 与 off 之间往返，不落进中间档', () => {
    spySync();

    useSkillsStore.getState().toggleSkill(FIRST_BUILTIN);
    expect(skillAt(FIRST_BUILTIN).override).toBe('off');

    useSkillsStore.getState().toggleSkill(FIRST_BUILTIN);
    expect(skillAt(FIRST_BUILTIN).override).toBe('on');

    // 从中间档 toggle 一次 → off（用户点「关」就是要关掉，不是降一档）
    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'user-invocable-only');
    useSkillsStore.getState().toggleSkill(FIRST_BUILTIN);
    expect(skillAt(FIRST_BUILTIN).override).toBe('off');
  });

  it('setSkillEnabled 映射到 on / off 两档', () => {
    spySync();
    useSkillsStore.getState().setSkillEnabled(FIRST_BUILTIN, false);
    expect(skillAt(FIRST_BUILTIN).override).toBe('off');
    useSkillsStore.getState().setSkillEnabled(FIRST_BUILTIN, true);
    expect(skillAt(FIRST_BUILTIN).override).toBe('on');
  });
});

describe('推送覆盖表给引擎', () => {
  it('只推非默认档（把技能调回启用表现为从表里消失）', async () => {
    const payloads = spySync();

    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'off');
    await Promise.resolve();
    expect(JSON.parse(payloads[0])).toEqual({ [FIRST_BUILTIN]: 'off' });

    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'on');
    await Promise.resolve();
    expect(JSON.parse(payloads[1])).toEqual({});
  });

  it('同步失败时把错误暴露出来（而不是只 console.warn）', async () => {
    spySync(false);
    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'off');
    // fire-and-forget 的 promise 在下一个 microtask 落地
    await vi.waitFor(() => {
      expect(useSkillsStore.getState().syncError).toContain('磁盘只读');
    });
    // 本地状态照旧写入：界面不该因为写不了引擎就没有反馈
    expect(skillAt(FIRST_BUILTIN).override).toBe('off');
  });

  it('同步成功后清掉上一次的错误', async () => {
    const spy = vi
      .spyOn(platform, 'syncNanobotSkills')
      .mockResolvedValueOnce({ ok: false, message: '第一次失败' })
      .mockResolvedValueOnce({ ok: true, message: '' });

    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'off');
    await vi.waitFor(() => expect(useSkillsStore.getState().syncError).toContain('第一次失败'));

    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'user-invocable-only');
    await vi.waitFor(() => expect(useSkillsStore.getState().syncError).toBeNull());
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('refresh：扫描与合并', () => {
  it('磁盘上新增的技能默认 on，且用户既有覆盖不被冲掉', async () => {
    spySync();
    useSkillsStore.getState().setSkillOverride(FIRST_BUILTIN, 'off');

    const scanned: Skill = {
      id: 'from-disk',
      name: 'from-disk',
      description: '磁盘上的技能',
      category: 'Other',
      prompt: '正文',
      source: 'local',
      scope: 'project',
      enabled: true,
      override: 'on',
    };
    // 磁盘上同一个技能（含内置的）也带一份，模拟重扫
    const rescanBuiltin: Skill = { ...SKILLS[0], enabled: true, override: 'on' };
    vi.spyOn(platform, 'loadUserSkills').mockResolvedValue([scanned, rescanBuiltin]);

    await useSkillsStore.getState().refresh('/ws');

    expect(skillAt('from-disk').scope).toBe('project');
    expect(skillAt('from-disk').override).toBe('on');
    // 重扫回来的内置技能必须是 'on'（磁盘不给状态），但用户的 off 要保住
    expect(skillAt(FIRST_BUILTIN).override).toBe('off');
    expect(skillAt(FIRST_BUILTIN).enabled).toBe(false);
  });

  it('把当前工作区传给扫描（项目级技能要按 workspace 找）', async () => {
    spySync();
    const loader = vi.spyOn(platform, 'loadUserSkills').mockResolvedValue([]);
    await useSkillsStore.getState().refresh('/ws/proj');
    expect(loader).toHaveBeenCalledWith('/ws/proj');
  });
});

describe('removeSkill：只允许删用户自己的技能', () => {
  it('内置技能删不掉（下次启动就回来，给入口只会误导）', () => {
    spySync();
    useSkillsStore.getState().removeSkill(FIRST_BUILTIN);
    expect(useSkillsStore.getState().skills.some((s) => s.id === FIRST_BUILTIN)).toBe(true);
  });

  it('项目级技能删不掉（来自仓库目录，重进页面就重扫回来）', () => {
    spySync();
    useSkillsStore.setState((s) => ({
      skills: [
        ...s.skills,
        {
          id: 'proj',
          name: 'proj',
          description: '',
          category: 'Other',
          prompt: 'x',
          source: 'local',
          scope: 'project',
          override: 'on',
          enabled: true,
        } as Skill,
      ],
    }));
    useSkillsStore.getState().removeSkill('proj');
    expect(useSkillsStore.getState().skills.some((s) => s.id === 'proj')).toBe(true);
  });

  it('用户级技能可以删', () => {
    spySync();
    useSkillsStore.setState((s) => ({
      skills: [
        ...s.skills,
        {
          id: 'mine',
          name: 'mine',
          description: '',
          category: 'Other',
          prompt: 'x',
          source: 'local',
          scope: 'user',
          override: 'on',
          enabled: true,
        } as Skill,
      ],
    }));
    useSkillsStore.getState().removeSkill('mine');
    expect(useSkillsStore.getState().skills.some((s) => s.id === 'mine')).toBe(false);
  });
});

describe('持久化迁移 v1（只有 enabled）→ v2（三态）', () => {
  /**
   * 写入一份「旧版本」持久化数据并重新水合，模拟老用户升级。
   *
   * 存储链路上有两层 JSON：platform.storage 适配器自身会 JSON.parse，
   * 外层 createJSONStorage 再 parse 一次。因此落盘必须是
   * 「JSON 字符串的 JSON 字符串」，与真实 setItem 的形态一致。
   */
  async function rehydrateLegacy(skills: unknown[], version: number): Promise<void> {
    localStorage.setItem(
      STORAGE_KEYS.skills,
      JSON.stringify(JSON.stringify({ state: { skills }, version })),
    );
    await useSkillsStore.persist.rehydrate();
  }

  it('enabled:false 的老数据迁移为 off，enabled:true 迁移为 on', async () => {
    await rehydrateLegacy(
      [
        { id: 'alpha', name: 'alpha', source: 'local', enabled: false },
        { id: 'beta', name: 'beta', source: 'local', enabled: true },
      ],
      1,
    );

    const skills = useSkillsStore.getState().skills;
    const alpha = skills.find((s) => s.id === 'alpha');
    const beta = skills.find((s) => s.id === 'beta');
    expect(alpha?.override).toBe('off');
    expect(alpha?.enabled).toBe(false);
    expect(beta?.override).toBe('on');
    expect(beta?.enabled).toBe(true);
  });

  it('老数据不会被猜成中间档', async () => {
    await rehydrateLegacy([{ id: 'alpha', name: 'alpha', source: 'local', enabled: true }], 1);
    const alpha = useSkillsStore.getState().skills.find((s) => s.id === 'alpha');
    expect(alpha?.override).not.toBe('user-invocable-only');
  });

  it('脏的 override 值迁移后收敛为 off', async () => {
    await rehydrateLegacy(
      [{ id: 'alpha', name: 'alpha', source: 'local', enabled: true, override: 'nonsense' }],
      1,
    );
    const alpha = useSkillsStore.getState().skills.find((s) => s.id === 'alpha');
    expect(alpha?.override).toBe('off');
  });
});
