/**
 * 技能覆盖表（`SkillOverrideEntry[]`）的纯函数操作。
 *
 * 与 `agent/skillOverrides.ts` 的分工：那边是**三态语义**（归一 / 判定 / 推引擎），
 * 与引擎侧逐字同构；这边是**表的维护**（查找 / 增改 / 移除 / 派生视图）。
 *
 * ## 为什么提示词表要单独抽
 *
 * `skillsStore` 里同时住着「事实」（磁盘扫出来的技能正文）与「用户意图」
 * （三态覆盖 + 置顶）。V1.5 的同步只能搬后者，所以后者必须有一份**独立的、
 * 可枚举的**表示——也就是这张表。表在 store 里被四处写动作同时维护
 * （改档 / 置顶 / 安装 / 卸载），各写各的必然漂移，故收敛到这里。
 *
 * ## 无墓碑
 *
 * 把一条覆盖「删掉」的语义是「回到默认档 `on`」，是**值的变化**而不是删除：
 * 移除条目与「从来没有过」在数据上无法区分（LWW 下无法判谁更新），因此
 * 「回到默认档」写的是 `override: 'on'` 而不是删条目。见 `types/skill.ts`。
 */

import { legacyMeta } from '../sync/syncMeta';
import {
  DEFAULT_SKILL_OVERRIDE,
  resolveSkillOverride,
  withEffectiveOverride,
} from './skillOverrides';
import type { Skill, SkillOverrideEntry } from '@/types';

/** 取某个技能的覆盖条目（无 = 用户没表达过意图，即默认档） */
export function findOverride(
  entries: readonly SkillOverrideEntry[],
  skillId: string,
): SkillOverrideEntry | undefined {
  return entries.find((entry) => entry.skillId === skillId);
}

/**
 * 按 `skillId` 替换或追加一条。
 *
 * 保持**原有顺序**（替换时不搬到末尾）：表顺序会成为同步层的推送顺序，
 * 每次改动都重排会让「同一份意图」产生不同的字节表示，diff 与幂等比较都失去意义。
 */
export function upsertOverride(
  entries: readonly SkillOverrideEntry[],
  entry: SkillOverrideEntry,
): SkillOverrideEntry[] {
  const index = entries.findIndex((item) => item.skillId === entry.skillId);
  if (index < 0) return [...entries, entry];
  return entries.map((item, i) => (i === index ? entry : item));
}

/**
 * 移除一条。**只用于「技能本身已卸载」**——那种情况下留着就是一条指向不存在
 * 技能的僵尸记录，技能重装时会被重新捡起来（表现成「莫名其妙自己变回停用 /
 * 自己置顶」）。「回到默认档」不走这里，见文件头说明。
 */
export function dropOverride(
  entries: SkillOverrideEntry[],
  skillId: string,
): SkillOverrideEntry[] {
  if (!entries.some((item) => item.skillId === skillId)) return entries;
  return entries.filter((item) => item.skillId !== skillId);
}

/** 由覆盖表派生置顶 id 列表（置顶不单独存，见 `skillsStore` 的 `pinnedIds` 说明） */
export function pinnedSkillIds(entries: readonly SkillOverrideEntry[]): string[] {
  return entries.filter((entry) => entry.pinned).map((entry) => entry.skillId);
}

/**
 * 用覆盖表把「事实」合成为**运行时视图**（消费方读的那份 `skills`）。
 *
 * `entries` 里没有的技能走默认档（`withEffectiveOverride` 内部按布尔的 `enabled`
 * 推导，见 `resolveSkillOverride`）——扫描回来的技能天然是 `on`。
 */
export function applyOverrides(
  skills: readonly Skill[],
  entries: readonly SkillOverrideEntry[],
): Skill[] {
  const byId = new Map(entries.map((entry) => [entry.skillId, entry.override]));
  return skills.map((skill) => withEffectiveOverride(skill, byId.get(skill.id)));
}

/**
 * 迁移用：从 v2 的旧形态（`skills` 数组里的 `override` + 独立的 `pinnedIds`）
 * 抽出覆盖表。
 *
 * **只抽「用户真的表达过意图」的条目**：默认档且未置顶 = 什么都没说过，
 * 给它建条目等于凭空往表里塞噪声，还会让 V1.5 的首次全量推送多传一批空意图。
 *
 * 元数据用 `legacyMeta()`（`rev = 0`）：这些意图产生于 SyncMeta 之前，
 * 按保留值落盘，V1.5 据此识别「历史遗留、从未被改写过」。
 */
export function entriesFromLegacy(
  skills: readonly Skill[],
  pinnedIds: readonly string[],
): SkillOverrideEntry[] {
  const pinned = new Set(pinnedIds);
  const entries: SkillOverrideEntry[] = [];
  for (const skill of skills) {
    const override = resolveSkillOverride(skill);
    const isPinned = pinned.has(skill.id);
    if (override === DEFAULT_SKILL_OVERRIDE && !isPinned) continue;
    entries.push({ skillId: skill.id, override, pinned: isPinned, ...legacyMeta() });
  }
  return entries;
}
