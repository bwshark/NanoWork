import type { Skill, SkillOverride } from '@/types';

/**
 * 技能三态覆盖的归一与判定（FR-3.1）。
 *
 * 这个文件里的规则**与引擎侧逐字同构**，两侧必须同步修改：
 * `nanobot/nanobot/agent/skills.py` 的 `SKILL_OVERRIDE_*` /
 * `normalize_skill_override` / `is_skill_listed_to_model`。
 * 客户端决定「界面显示成什么档」，引擎决定「这一档实际怎么拦」——
 * 归一规则一旦分叉，就会出现「界面显示已停用、模型照样在用」这种最难查的不一致。
 */

export const SKILL_OVERRIDE_ON: SkillOverride = 'on';
export const SKILL_OVERRIDE_USER_INVOCABLE_ONLY: SkillOverride = 'user-invocable-only';
export const SKILL_OVERRIDE_OFF: SkillOverride = 'off';

/** 默认态。未在覆盖表里出现过的技能等同于 `on`。 */
export const DEFAULT_SKILL_OVERRIDE: SkillOverride = SKILL_OVERRIDE_ON;

/** 全部合法取值（顺序即 UI 展示顺序：从严到宽，或从宽到严都只在这一处定） */
export const SKILL_OVERRIDES: readonly SkillOverride[] = [
  SKILL_OVERRIDE_ON,
  SKILL_OVERRIDE_USER_INVOCABLE_ONLY,
  SKILL_OVERRIDE_OFF,
];

/** 三态的用户可读标签与说明（UI 与提示文案的唯一来源） */
export const SKILL_OVERRIDE_META: Record<
  SkillOverride,
  { label: string; description: string }
> = {
  [SKILL_OVERRIDE_ON]: {
    label: '启用',
    description: '模型可见、可自主加载，你也能在会话里显式挂载',
  },
  [SKILL_OVERRIDE_USER_INVOCABLE_ONLY]: {
    label: '仅手动调用',
    description: '不列给模型（它不知道有这个技能），只有你显式挂载或 $调用时才生效',
  },
  [SKILL_OVERRIDE_OFF]: {
    label: '停用',
    description: '当它不存在：模型看不到，你也挂载不上',
  },
};

/**
 * 把任意输入收敛到三个已知状态之一。
 *
 * **未知 / 畸形取值一律收敛为 `off`（fail-closed），不是 `on`。**
 * 覆盖表是一条*限制性*配置：用户写 `"disabled"` 或把状态名拼错时，
 * 意图显然是「别让它跑」；读成 `on` 等于悄悄撤销用户的限制，
 * 而读成 `off` 只是让技能从列表里消失，可见且可恢复。
 */
export function normalizeSkillOverride(value: unknown): SkillOverride {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if ((SKILL_OVERRIDES as readonly string[]).includes(normalized)) {
      return normalized as SkillOverride;
    }
  }
  return SKILL_OVERRIDE_OFF;
}

/**
 * 取技能当前生效的三态。
 *
 * 兼容路径：老数据（以及内置技能定义）只有布尔的 `enabled`、没有 `override`。
 * `enabled === false` 是用户明确停用过 → 读作 `off`；其余 → `on`。
 * **不要**把缺失读成 `user-invocable-only`：老数据里没有这一档的语义，
 * 猜成中间档会让模型凭空少看到一批技能。
 */
export function resolveSkillOverride(skill: Pick<Skill, 'override' | 'enabled'>): SkillOverride {
  if (skill.override === undefined || skill.override === null) {
    return skill.enabled === false ? SKILL_OVERRIDE_OFF : DEFAULT_SKILL_OVERRIDE;
  }
  return normalizeSkillOverride(skill.override);
}

/** 有效态：这一档下技能是否还能用（模型可见或用户可挂载）。 */
export function isSkillEnabled(override: SkillOverride): boolean {
  return override !== SKILL_OVERRIDE_OFF;
}

/** 这一档下技能是否列给模型（模型能否自主发现并加载它）。 */
export function isSkillListedToModel(override: SkillOverride): boolean {
  return override === SKILL_OVERRIDE_ON;
}

/** 这一档下技能是否可由用户显式挂载 / `$调用`。 */
export function isSkillUserInvocable(override: SkillOverride): boolean {
  return override !== SKILL_OVERRIDE_OFF;
}

/**
 * 把 `override` 与派生的 `enabled` 一次性写回技能对象。
 *
 * **只在这里派生 `enabled`**：它必须是 `override` 的函数，
 * 任何一处单独写 `enabled` 都会制造出「界面显示已启用、实际是 off」的漂移。
 */
export function withEffectiveOverride(skill: Skill, override?: SkillOverride): Skill {
  const resolved = override ?? resolveSkillOverride(skill);
  return {
    ...skill,
    override: resolved,
    enabled: isSkillEnabled(resolved),
  };
}

/**
 * 构造要写进引擎的覆盖表（`agents.defaults.skillOverrides`）。
 *
 * **只写非默认档**：默认档是 `on`，写进去只会制造噪声，还会在技能被删除后
 * 留下一堆没有对应技能的僵尸条目。把 `on` 省略掉，引擎侧读不到即视为 `on`，
 * 两边语义天然一致。
 */
export function buildOverrideMap(skills: readonly Skill[]): Record<string, SkillOverride> {
  const map: Record<string, SkillOverride> = {};
  for (const skill of skills) {
    const override = resolveSkillOverride(skill);
    if (override !== DEFAULT_SKILL_OVERRIDE) map[skill.id] = override;
  }
  return map;
}

/**
 * 「内置模式名 / 内置技能名不可被覆盖」的护栏（PRD §12.4 保留名保护）。
 *
 * 反过来的风险更要紧：装一个插件就能劫持内置模式的行为。
 * 这里只暴露判据，真正的拦截在引擎侧的发现顺序里（内置排在最后、先到先得）。
 */
export const RESERVED_SKILL_NAMES: readonly string[] = ['ask', 'plan', 'craft'];

export function isReservedSkillName(name: string): boolean {
  return RESERVED_SKILL_NAMES.includes(name.trim().toLowerCase());
}
