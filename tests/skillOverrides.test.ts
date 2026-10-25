/**
 * 技能三态覆盖的纯函数层（FR-3.1）。
 *
 * 这些规则**与引擎侧逐字同构**（`nanobot/nanobot/agent/skills.py` 的
 * `SKILL_OVERRIDE_*` / `normalize_skill_override` / `is_skill_listed_to_model`）。
 * 两边的用例刻意写成镜像的：归一规则一旦分叉，就会出现
 * 「界面显示已停用、模型照样在用」这种最难查的不一致。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKILL_OVERRIDE,
  SKILL_OVERRIDE_META,
  SKILL_OVERRIDE_OFF,
  SKILL_OVERRIDE_ON,
  SKILL_OVERRIDE_USER_INVOCABLE_ONLY,
  SKILL_OVERRIDES,
  buildOverrideMap,
  isReservedSkillName,
  isSkillEnabled,
  isSkillListedToModel,
  isSkillUserInvocable,
  normalizeSkillOverride,
  resolveSkillOverride,
  withEffectiveOverride,
} from '@/lib/agent/skillOverrides';
import type { Skill, SkillOverride } from '@/types';

function skill(partial: Partial<Skill> & Pick<Skill, 'id'>): Skill {
  return {
    name: partial.id,
    description: '',
    category: 'Other',
    prompt: 'x',
    source: 'local',
    enabled: true,
    ...partial,
  } as Skill;
}

describe('normalizeSkillOverride', () => {
  it('三个已知取值原样通过', () => {
    expect(normalizeSkillOverride('on')).toBe(SKILL_OVERRIDE_ON);
    expect(normalizeSkillOverride('user-invocable-only')).toBe(SKILL_OVERRIDE_USER_INVOCABLE_ONLY);
    expect(normalizeSkillOverride('off')).toBe(SKILL_OVERRIDE_OFF);
  });

  it('容忍大小写与首尾空白', () => {
    expect(normalizeSkillOverride('  OFF ')).toBe(SKILL_OVERRIDE_OFF);
    expect(normalizeSkillOverride('On')).toBe(SKILL_OVERRIDE_ON);
    expect(normalizeSkillOverride('USER-INVOCABLE-ONLY')).toBe(
      SKILL_OVERRIDE_USER_INVOCABLE_ONLY,
    );
  });

  it('未知取值 fail-closed 收敛为 off，而不是 on', () => {
    // 写错状态名时意图显然是「别让它跑」；读成 on 等于悄悄撤销用户的限制
    for (const bogus of ['disabled', 'false', '0', 'manual', 'ONLY', '']) {
      expect(normalizeSkillOverride(bogus)).toBe(SKILL_OVERRIDE_OFF);
    }
  });

  it('非字符串取值同样 fail-closed', () => {
    for (const bogus of [null, undefined, true, false, 1, 0, [], {}, ['on']]) {
      expect(normalizeSkillOverride(bogus)).toBe(SKILL_OVERRIDE_OFF);
    }
  });
});

describe('状态判定', () => {
  it('on 是唯一列给模型的档', () => {
    expect(isSkillListedToModel(SKILL_OVERRIDE_ON)).toBe(true);
    expect(isSkillListedToModel(SKILL_OVERRIDE_USER_INVOCABLE_ONLY)).toBe(false);
  });

  it('只有 off 会同时切断模型与用户两侧入口', () => {
    expect(isSkillUserInvocable(SKILL_OVERRIDE_ON)).toBe(true);
    expect(isSkillUserInvocable(SKILL_OVERRIDE_USER_INVOCABLE_ONLY)).toBe(true);
    expect(isSkillUserInvocable(SKILL_OVERRIDE_OFF)).toBe(false);

    expect(isSkillEnabled(SKILL_OVERRIDE_ON)).toBe(true);
    expect(isSkillEnabled(SKILL_OVERRIDE_USER_INVOCABLE_ONLY)).toBe(true);
    expect(isSkillEnabled(SKILL_OVERRIDE_OFF)).toBe(false);
  });

  it('三档都有面向用户的标签与说明', () => {
    for (const value of SKILL_OVERRIDES) {
      expect(SKILL_OVERRIDE_META[value].label).toBeTruthy();
      expect(SKILL_OVERRIDE_META[value].description).toBeTruthy();
    }
  });
});

describe('resolveSkillOverride：老数据兼容', () => {
  it('有 override 时以 override 为准', () => {
    expect(resolveSkillOverride({ override: 'off', enabled: true })).toBe(SKILL_OVERRIDE_OFF);
    expect(
      resolveSkillOverride({ override: 'user-invocable-only', enabled: true }),
    ).toBe(SKILL_OVERRIDE_USER_INVOCABLE_ONLY);
  });

  it('override 缺失时按布尔的 enabled 推导', () => {
    expect(resolveSkillOverride({ enabled: true })).toBe(SKILL_OVERRIDE_ON);
    expect(resolveSkillOverride({ enabled: false })).toBe(SKILL_OVERRIDE_OFF);
  });

  it('override 缺失不会被猜成中间档', () => {
    // 老数据里没有 user-invocable-only 的语义，猜成中间档会让模型凭空少看到一批技能
    for (const enabled of [true, false]) {
      expect(resolveSkillOverride({ enabled })).not.toBe(SKILL_OVERRIDE_USER_INVOCABLE_ONLY);
    }
  });

  it('override 是脏值时收敛为 off，不被 enabled 救回来', () => {
    // 脏值只可能来自手改过的持久化数据 / 外部写入，类型上先绕过去再断言
    expect(
      resolveSkillOverride({ override: 'weird' as SkillOverride, enabled: true }),
    ).toBe(SKILL_OVERRIDE_OFF);
  });
});

describe('withEffectiveOverride：enabled 必须是 override 的派生值', () => {
  it('写入 override 的同时派生 enabled', () => {
    const off = withEffectiveOverride(skill({ id: 'a' }), 'off');
    expect(off.override).toBe('off');
    expect(off.enabled).toBe(false);

    const only = withEffectiveOverride(skill({ id: 'a' }), 'user-invocable-only');
    expect(only.override).toBe('user-invocable-only');
    // 中间档在客户端仍是「能用」——它只是不让模型自己伸手，用户照样挂得上
    expect(only.enabled).toBe(true);
  });

  it('不传 override 时沿用技能自身状态', () => {
    const derived = withEffectiveOverride(skill({ id: 'a', enabled: false }));
    expect(derived.override).toBe('off');
    expect(derived.enabled).toBe(false);
  });

  it('对任意状态都保持 enabled === (override !== off) 的不变量', () => {
    for (const value of SKILL_OVERRIDES) {
      const result = withEffectiveOverride(skill({ id: 'a' }), value);
      expect(result.enabled).toBe(value !== SKILL_OVERRIDE_OFF);
    }
  });
});

describe('buildOverrideMap：只写非默认档', () => {
  it('跳过 on（默认档写进去只会制造噪声与僵尸条目）', () => {
    const map = buildOverrideMap([
      skill({ id: 'alpha', override: 'on' }),
      skill({ id: 'beta', override: 'off' }),
      skill({ id: 'gamma', override: 'user-invocable-only' }),
    ]);
    expect(map).toEqual({ beta: 'off', gamma: 'user-invocable-only' });
  });

  it('把技能调回启用表现为从表里消失', () => {
    expect(buildOverrideMap([skill({ id: 'alpha', override: 'on' })])).toEqual({});
    expect(buildOverrideMap([skill({ id: 'alpha', enabled: true })])).toEqual({});
  });

  it('老数据（只有 enabled）也能正确导出', () => {
    const map = buildOverrideMap([
      skill({ id: 'alpha', enabled: false }),
      skill({ id: 'beta', enabled: true }),
    ]);
    expect(map).toEqual({ alpha: 'off' });
  });

  it('空列表得到空表', () => {
    expect(buildOverrideMap([])).toEqual({});
  });

  it('DEFAULT_SKILL_OVERRIDE 就是 on', () => {
    expect(DEFAULT_SKILL_OVERRIDE).toBe(SKILL_OVERRIDE_ON);
  });
});

describe('保留名保护（PRD §12.4）', () => {
  it('内置模式名不可被覆盖', () => {
    for (const name of ['ask', 'plan', 'craft', 'ASK', ' craft ']) {
      expect(isReservedSkillName(name)).toBe(true);
    }
    expect(isReservedSkillName('summarize')).toBe(false);
  });
});
