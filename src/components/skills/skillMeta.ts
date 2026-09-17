import type { Skill, SkillScope } from '@/types';

/**
 * 技能页的展示派生值与小助手。
 *
 * 放在页面之外的原因只有一个：市场卡 / 已安装卡 / 详情弹窗 / 操作菜单
 * **四个组件都要用同一份判据**。判断「能不能卸载」「本地文件在哪」这类问题
 * 一旦在两个组件里各写一遍，迟早会出现「卡片上有卸载、菜单里没有」的分叉。
 */

/** 来源层级徽标文案（PRD §12.4 的发现顺序） */
export const SKILL_SCOPE_LABEL: Record<SkillScope, string> = {
  builtin: '内置',
  user: '用户级',
  project: '项目级',
};

/**
 * 技能来源的一句话说明。
 *
 * `scope` 缺失（内置技能定义不带这个字段）时按 `source` 兜底，
 * 而不是硬写成「内置」—— 本地安装的技能同样可能没有 scope。
 */
export function skillSourceLabel(skill: Pick<Skill, 'scope' | 'source'>): string {
  if (skill.scope) return SKILL_SCOPE_LABEL[skill.scope];
  return skill.source === 'builtin' ? '内置' : '本地';
}

/**
 * 能否从列表里卸载这个技能。
 *
 * 内置技能随应用发布，删了下次启动就回来；项目级技能来自
 * `<workspace>/skills` 目录、每进一次页面就重扫一遍，从列表里抹掉同样会「复活」。
 * 两者的真实删除动作都不在界面上（前者改代码，后者删文件），
 * 所以不给可用的卸载入口 —— 与 `skillsStore.isUserOwnedSkill` 的判据保持一致。
 *
 * 返回 `null` 表示可删；返回字符串则是「不可删的原因」，直接作为菜单里的说明文案。
 */
export function skillUninstallBlockReason(skill: Skill): string | null {
  if (skill.source === 'builtin') return '内置不可卸载';
  if (skill.scope === 'project') return '需删目录';
  return null;
}

/** 本地文件落点：`dir` 是技能目录，`md` 是它的 SKILL.md */
export interface SkillFileTargets {
  dir?: string;
  md?: string;
}

/**
 * 由 `skill.path` 推出「目录」与「SKILL.md」两个落点。
 *
 * `path` 的形态是**目录或文件都可能有**（类型定义写的是「所在目录或文件路径」），
 * 所以先看后缀：已经是 .md 的就是文件本身，其余按目录拼 SKILL.md。
 * 分隔符跟随原字符串（Windows 上是反斜杠），避免混用后 openPath 找不到文件。
 */
export function skillFileTargets(skill: Pick<Skill, 'path'>): SkillFileTargets {
  const raw = skill.path?.trim();
  if (!raw) return {};
  if (/\.md$/i.test(raw)) {
    const dir = raw.replace(/[\\/][^\\/]*$/, '');
    return { md: raw, dir: dir && dir !== raw ? dir : undefined };
  }
  const sep = raw.includes('\\') ? '\\' : '/';
  const trimmed = raw.endsWith(sep) ? raw.slice(0, -sep.length) : raw;
  return { dir: trimmed, md: `${trimmed}${sep}SKILL.md` };
}

/** 本地技能路径是否可被主进程打开（Web 端没有文件系统） */
export function canOpenLocalFile(skill: Skill, env: string): boolean {
  return env === 'electron' && !!skill.path;
}
