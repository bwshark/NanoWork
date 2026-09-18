import type { Skill, SkillOverride, SkillScope } from '@/types';
import {
  SKILL_OVERRIDE_OFF,
  SKILL_OVERRIDE_ON,
  resolveSkillOverride,
} from '@/lib/skillOverrides';

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

/**
 * 「基本信息」面板里的字段行：**只放「稳定的身份字段」**——版本 / 来源 / 分类。
 *
 * 详情弹窗（市场）与详情窗口（已安装）共用同一份 —— 同一个技能在两个入口的
 * 基本信息栏里出现不同字段，是用户最容易察觉的不一致（而且很难解释为什么）。
 *
 * 刻意**不收**这三项（2026-09-18 按用户要求移除）：
 * - `工具白名单`：一长串 `Bash(npx:*)` 会把两列网格撑成五六行，把版式压垮；
 *   它是「能力细节」而不是「身份」，需要时看 SKILL.md 的 frontmatter 更清楚。
 * - `手动调用`：开关/菜单里已经有「仅手动调用」这一档，同一事实两处出现会打架
 *   （菜单写着「仅手动调用」、信息栏写着「可手动调用」时用户不知道该信哪个）。
 * - `本地路径`：真正的入口是菜单里的「打开文件夹」，把绝对路径铺在面板上既占位
 *   又容易泄露用户名，且用户拿到路径也没法直接操作。
 *
 * 只列**真实存在的字段**：缺哪项就不渲染哪行。补一个「v1.0.0」之类的兜底值
 * 比不写更糟 —— 用户会拿它做版本判断。
 */
export function skillInfoRows(skill: Skill): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (skill.version) rows.push({ label: '版本', value: skill.version });
  rows.push({ label: '来源', value: skillSourceLabel(skill) });
  if (skill.category) rows.push({ label: '分类', value: skill.category });
  return rows;
}

/**
 * 自动触发开关的下一档取值。
 *
 * 开关是**二元**的（`off` ↔ `on`），刻意不经过中间档：中间档
 * （模型不可见、用户可挂载）表达不出「能不能用」，只能由菜单里
 * 那一项独立承担，塞进开关会让用户以为状态只有两种。
 */
export function nextAutoTriggerOverride(skill: Skill): SkillOverride {
  return resolveSkillOverride(skill) === SKILL_OVERRIDE_OFF
    ? SKILL_OVERRIDE_ON
    : SKILL_OVERRIDE_OFF;
}

/**
 * 开关切换后的反馈文案。
 *
 * 措辞统一放这里：卡片与详情页是**同一个开关的两个入口**，说成
 * 「已停用」vs「已关闭自动触发」会让用户以为是两件事 —— 后者才是真实语义
 * （技能还在磁盘上、描述还能看，只是模型不再自动触发它）。
 */
export function autoTriggerToast(skill: Skill): string {
  return resolveSkillOverride(skill) === SKILL_OVERRIDE_OFF
    ? `${skill.name} 已开启自动触发`
    : `${skill.name} 已关闭自动触发`;
}
