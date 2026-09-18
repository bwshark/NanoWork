import type { Skill, SkillOverride, SkillScope } from '@/types';
import { APP_DISPLAY_NAME } from '@/lib/constants';
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
 * （`orderInstalledSkills` 只被页面用，放这里是因为它同样是「页面展示规则」，
 * 与「这个技能能不能装」属于同一类判断，没必要为它单开一个文件。）
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
 * 「⋯」菜单相对锚点的对齐方向。
 *
 * 这里把几何约束**写成可测的函数**而不是内联在 JSX 里，原因是这个决定
 * 看起来「只是个样式」，很容易在后续整理时被统一成一套对齐 —— 而那是错的：
 *
 * - **卡片**：⋯ 贴在卡片右上角，必须**右对齐**（`right`），菜单向左展开才留在
 *   卡片（以及视口）内；换成左对齐会让最后一列的菜单冲出屏幕。
 * - **窗口**：⋯ 在第二行跟在「去试试」后面，距窗口右缘还有 300 多 px。
 *   右对齐会把菜单整个甩到窗口左侧 —— 实测菜单左缘距窗口左缘只剩 7px
 *   （内容内边距是 24px），看起来像贴窗口边框飘出去的一块面板，和 ⋯ 脱节。
 *   所以窗口里用**左对齐**（`left`）：菜单左上角正好落在 ⋯ 左下角，向右下展开。
 *
 * 竖向两边都是 `bottom` → `top`，即贴着按钮下沿往下展开。
 */
export type MenuOrigin = {
  horizontal: 'left' | 'center' | 'right';
  vertical: 'top' | 'center' | 'bottom';
};

export function skillMenuOrigin(context: 'card' | 'window'): {
  anchorOrigin: MenuOrigin;
  transformOrigin: MenuOrigin;
} {
  const horizontal: MenuOrigin['horizontal'] = context === 'window' ? 'left' : 'right';
  return {
    anchorOrigin: { horizontal, vertical: 'bottom' },
    transformOrigin: { horizontal, vertical: 'top' },
  };
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

/**
 * 自动触发开关的**悬停说明**：说清「按下去会发生什么」，而不是复述按钮名。
 *
 * 原来的文案是「点击停用自动触发」—— 它只重复了按钮本身（用户已经看见是个开关了），
 * 没回答真正的问题：关掉之后这个技能会变成什么样。参考样式给的正是这个答案，
 * 所以照它的句式改写：**当前状态的反面 + 后果**。
 *
 * 开关是二元的，两句话必须**成对**存在：只写「关掉会怎样」的话，
 * 已经关着的技能（开关在左边）就没有任何解释，用户不敢往回开。
 *
 * 文案里带应用名（`APP_DISPLAY_NAME`）而不是写死「WorkBuddy」：这是本应用的
 * 行为说明，用户在自己的客户端里看到别的产品名会直接不信这条提示。
 */
export function autoTriggerHint(skill: Skill): string {
  return resolveSkillOverride(skill) === SKILL_OVERRIDE_OFF
    ? `开启自动触发后，${APP_DISPLAY_NAME} 将在对话中按需自动触发此技能`
    : `关闭自动触发后，${APP_DISPLAY_NAME} 将不在对话中自动触发此技能，仅支持手动触发`;
}

/**
 * 「我安装的」列表的展示顺序：**置顶的排到最前，其余保持原序**。
 *
 * 只做一件事：把置顶项提到前面。刻意不引入第二套排序键（名称 / 来源 / 时间）——
 * 排序键一多，用户就再也说不清「某个技能为什么在这个位置」，
 * 而列表本身的顺序（store 的合并顺序：内置在前、磁盘扫描在后）是稳定的，
 * 用户对它的记忆不会被无谓地打乱。
 *
 * `[...skills]` 是必需的：`Array.prototype.sort` **原地排序**，
 * 直接对 `skills` 调用会把 store 里的数组也翻个个儿（zustand 的引用没变，
 * 但 React 之外的地方读到的顺序会被悄悄改掉）。sort 本身在 ES2019 起是稳定的，
 * 所以返回 0 的项之间不会被打乱。
 */
export function orderInstalledSkills(
  skills: readonly Skill[],
  pinnedIds: readonly string[],
): Skill[] {
  if (pinnedIds.length === 0) return [...skills];
  const pinned = new Set(pinnedIds);
  const rank = (s: Skill) => (pinned.has(s.id) ? 0 : 1);
  return [...skills].sort((a, b) => rank(a) - rank(b));
}
