import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform } from '@/platform';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { SKILLS } from '@/ai/builtinSkills';
import type { Skill } from '@/types';

interface SkillsState {
  skills: Skill[];
  /** 是否已完成首次本地技能扫描 */
  loaded: boolean;
  /** 重新扫描本地技能目录并合并 */
  refresh: () => Promise<void>;
  toggleSkill: (id: string) => void;
  setSkillEnabled: (id: string, enabled: boolean) => void;
  /** 安装一个技能（Web 端上传或 Electron 端从本地选择） */
  installSkill: (skill: Skill) => void;
  /** 删除本地安装的技能；内置技能不可删除 */
  removeSkill: (id: string) => void;
}

/** 基于当前内置目录与持久化数据重新合并 */
function mergeSkills(stored: Skill[], userSkills: Skill[]): Skill[] {
  const storedMap = new Map(stored.map((s) => [s.id, s]));

  // 内置技能：保留当前代码中的版本，仅恢复用户覆盖的启用状态
  const builtin = SKILLS.map((s) => {
    const over = storedMap.get(s.id);
    return over && over.source === 'builtin' ? { ...s, enabled: over.enabled } : { ...s };
  });

  // 本地技能：用户目录扫描结果 + 持久化的本地技能，后者优先保留 enabled 覆盖
  const localStored = stored.filter((s) => s.source === 'local');
  const localStoredMap = new Map(localStored.map((s) => [s.id, s]));
  const local = userSkills.map((s) => {
    const st = localStoredMap.get(s.id);
    return st ? { ...s, enabled: st.enabled } : { ...s };
  });

  return [...builtin, ...local];
}

export const useSkillsStore = create<SkillsState>()(
  persist(
    (set, get) => ({
      skills: mergeSkills([], []),
      loaded: false,

      refresh: async () => {
        const userSkills = await platform.loadUserSkills();
        const stored = get().skills;
        set({ skills: mergeSkills(stored, userSkills), loaded: true });
      },

      toggleSkill: (id) =>
        set((s) => ({
          skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)),
        })),

      setSkillEnabled: (id, enabled) =>
        set((s) => ({
          skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled } : sk)),
        })),

      installSkill: (skill) =>
        set((s) => {
          if (s.skills.some((sk) => sk.id === skill.id)) {
            return {
              skills: s.skills.map((sk) =>
                sk.id === skill.id && sk.source === 'local' ? { ...skill, enabled: true } : sk,
              ),
            };
          }
          return { skills: [...s.skills, { ...skill, enabled: true }] };
        }),

      removeSkill: (id) =>
        set((s) => ({
          skills: s.skills.filter((sk) => !(sk.id === id && sk.source === 'local')),
        })),
    }),
    {
      name: STORAGE_KEYS.skills,
      storage: zustandStorage,
      partialize: (s) => ({ skills: s.skills }),
    },
  ),
);
