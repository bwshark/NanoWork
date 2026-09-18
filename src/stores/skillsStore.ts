import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform } from '@/platform';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { SKILLS } from '@/ai/builtinSkills';
import {
  buildOverrideMap,
  resolveSkillOverride,
  withEffectiveOverride,
} from '@/lib/skillOverrides';
import type { Skill, SkillOverride } from '@/types';

interface SkillsState {
  skills: Skill[];
  /**
   * 置顶的技能 id（「我安装的」列表把置顶项排在最前）。
   *
   * 刻意**不**放进 `Skill` 对象里，也刻意**不**推给引擎：
   * - 它不是技能属性，而是**用户对这份列表的排序偏好**。挂进技能对象就要在
   *   `mergeSkills` 里为它单独写一条「内容取最新、这字段取用户选择」的还原路径
   *   （`override` 已经占了一条），多一条就多一处会漂移的地方。
   * - 引擎不关心顺序。混进 `buildOverrideMap` 会让「置顶」变成一条会写进
   *   nanobot 配置的指令，而它在引擎侧没有任何对应语义。
   */
  pinnedIds: string[];
  /** 是否已完成首次本地技能扫描 */
  loaded: boolean;
  /**
   * 最近一次「把三态覆盖推给引擎」的失败原因（null = 无失败）。
   *
   * 刻意留一个**可见**的错误位而不是 console.warn：覆盖同步失败时，
   * 界面会显示「已停用」而引擎照旧把它列给模型——这是最难自查的一类不一致，
   * 必须让用户看见。
   */
  syncError: string | null;
  /**
   * 重新扫描技能目录并合并。
   * @param workspace 当前工作区绝对路径；给了才会扫项目级技能（`<workspace>/skills`）
   */
  refresh: (workspace?: string) => Promise<void>;
  /** 在「启用 / 停用」两档之间切换（保留给只关心开与关的既有入口） */
  toggleSkill: (id: string) => void;
  /** 布尔入口 → 映射到 `on` / `off` 两档 */
  setSkillEnabled: (id: string, enabled: boolean) => void;
  /** 设置三态覆盖（FR-3.1 的完整入口），并推送给引擎 */
  setSkillOverride: (id: string, override: SkillOverride) => void;
  /** 置顶 / 取消置顶（只影响「我安装的」列表顺序，不推引擎） */
  toggleSkillPin: (id: string) => void;
  /** 安装一个技能（Web 端上传或 Electron 端从本地选择） */
  installSkill: (skill: Skill) => void;
  /** 删除本地安装的技能；内置技能不可删除 */
  removeSkill: (id: string) => void;
}

/**
 * 基于当前内置目录与持久化数据重新合并。
 *
 * 合并的**唯一职责**是「内容取最新、状态取用户选择」：
 * 技能正文随代码/磁盘更新，但用户改过的三态覆盖不能被冲掉。
 */
function mergeSkills(stored: Skill[], scanned: Skill[]): Skill[] {
  const storedMap = new Map(stored.map((s) => [s.id, s]));

  // 内置技能：保留当前代码中的版本，仅恢复用户覆盖的状态
  const builtin = SKILLS.map((s) => {
    const over = storedMap.get(s.id);
    return withEffectiveOverride(
      s,
      over && over.source === 'builtin' ? resolveSkillOverride(over) : undefined,
    );
  });

  // 扫描到的技能（用户级 / 项目级 / 本地安装）：内容取磁盘最新
  const restoredMap = new Map(stored.filter((s) => s.source !== 'builtin').map((s) => [s.id, s]));
  const scannedMerged = scanned.map((s) => {
    const st = restoredMap.get(s.id);
    return withEffectiveOverride(s, st ? resolveSkillOverride(st) : undefined);
  });

  return [...builtin, ...scannedMerged];
}

/**
 * 这个技能是否「归用户所有」——即能否从 store 里删掉。
 *
 * 内置技能随应用发布，删了下次启动就回来；项目级技能来自
 * `<workspace>/skills` 目录，`refresh()` 每进一次页面就重扫一遍，
 * 从 store 里抹掉同样会「复活」。两者都不该给删除入口：
 * 前者删了没用，后者真正的删除动作是删文件，不是改状态。
 */
function isUserOwnedSkill(skill: Skill): boolean {
  return skill.source !== 'builtin' && skill.scope !== 'project';
}

/**
 * 把三态覆盖推给引擎（`agents.defaults.skillOverrides`）。
 *
 * 推的是 `buildOverrideMap` 的产物——只含非默认档，
 * 因此「用户把某技能调回启用」表现为**从表里消失**而不是写一个 `on`。
 */
async function pushOverrides(skills: Skill[]): Promise<string | null> {
  try {
    const result = await platform.syncNanobotSkills(JSON.stringify(buildOverrideMap(skills)));
    return result.ok ? null : result.message;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const useSkillsStore = create<SkillsState>()(
  persist(
    (set, get) => ({
      skills: mergeSkills([], []),
      pinnedIds: [],
      loaded: false,
      syncError: null,

      refresh: async (workspace) => {
        const scanned = await platform.loadUserSkills(workspace);
        const stored = get().skills;
        const merged = mergeSkills(stored, scanned);
        set({ skills: merged, loaded: true });
        // 扫描可能带回一批新技能（用户刚往目录里丢了一个），
        // 这些技能的默认档是 `on`，无需推送；但若磁盘上的技能被删了，
        // 覆盖表里可能留下僵尸条目，所以这里也顺带重推一次。
        set({ syncError: await pushOverrides(merged) });
      },

      toggleSkill: (id) => {
        const current = get().skills.find((s) => s.id === id);
        if (!current) return;
        const next = resolveSkillOverride(current) === 'off' ? 'on' : 'off';
        get().setSkillOverride(id, next);
      },

      setSkillEnabled: (id, enabled) => get().setSkillOverride(id, enabled ? 'on' : 'off'),

      setSkillOverride: (id, override) => {
        const skills = get().skills.map((sk) =>
          sk.id === id ? withEffectiveOverride(sk, override) : sk,
        );
        set({ skills });
        // 先落状态再推引擎：界面必须立刻响应，同步是后台的事。
        void pushOverrides(skills).then((error) => set({ syncError: error }));
      },

      toggleSkillPin: (id) =>
        set((s) => ({
          pinnedIds: s.pinnedIds.includes(id)
            ? s.pinnedIds.filter((p) => p !== id)
            : [...s.pinnedIds, id],
        })),

      installSkill: (skill) =>
        set((s) => {
          const next = withEffectiveOverride(skill, 'on');
          if (s.skills.some((sk) => sk.id === skill.id)) {
            return {
              skills: s.skills.map((sk) => (sk.id === skill.id && isUserOwnedSkill(sk) ? next : sk)),
            };
          }
          return { skills: [...s.skills, next] };
        }),

      /*
       * 卸载时顺手把置顶也清掉，否则 `pinnedIds` 会攒下一串指向已卸载技能的
       * 僵尸 id（技能重新装上时会**莫名其妙自己置顶**）。清理是有条件的：
       * 内置技能卸不掉，那种情况下不能把它的置顶悄悄抹掉。
       */
      removeSkill: (id) =>
        set((s) => {
          const removed = s.skills.some((sk) => sk.id === id && isUserOwnedSkill(sk));
          return {
            skills: s.skills.filter((sk) => !(sk.id === id && isUserOwnedSkill(sk))),
            pinnedIds: removed ? s.pinnedIds.filter((p) => p !== id) : s.pinnedIds,
          };
        }),
    }),
    {
      name: STORAGE_KEYS.skills,
      storage: zustandStorage,
      // v2：`enabled: boolean` → `override: on|user-invocable-only|off`（FR-3.1）
      version: 2,
      migrate: (persisted) => {
        const state = persisted as { skills?: Skill[] } | undefined;
        const skills = Array.isArray(state?.skills) ? state.skills : [];
        // 老数据没有 `override`，`withEffectiveOverride` 会按布尔的 `enabled` 推导：
        // `enabled: false` → `off`，其余 → `on`。不猜中间档。
        return { skills: skills.map((s) => withEffectiveOverride(s)), loaded: false, syncError: null };
      },
      /*
       * `pinnedIds` 必须一起落盘：置顶是「下次打开还在」的偏好，
       * 只存在内存里等于每次重启都被清空。不带 version 升级 ——
       * 老数据没有这个 key，浅合并后自然是初始值 `[]`，不存在迁移分支。
       */
      partialize: (s) => ({ skills: s.skills, pinnedIds: s.pinnedIds }),
    },
  ),
);
