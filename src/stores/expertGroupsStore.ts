import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { BUILTIN_GROUPS } from '@/ai/builtinExpertGroups';
import type { ExpertGroup } from '@/types';

interface ExpertGroupsState {
  groups: ExpertGroup[];
  /** 全局活跃专家团（召唤专家团时设置；新会话无绑定据此兜底，与 agentsStore.activeAgentId 对称） */
  activeGroupId: string | null;
  /** 重新合并内置专家团与持久化数据（启动时调用，保证内置恒在） */
  refresh: () => void;
  createGroup: (partial?: Partial<ExpertGroup>) => ExpertGroup;
  updateGroup: (id: string, patch: Partial<ExpertGroup>) => void;
  removeGroup: (id: string) => void;
  toggleGroup: (id: string) => void;
  setActiveGroup: (id: string | null) => void;
}

const nowIso = () => new Date().toISOString();

/**
 * 基于当前内置目录与持久化数据重新合并。
 * - 内置专家团：以代码中的 BUILTIN_GROUPS 为真源，仅恢复用户覆盖的启用状态；
 *   成员顺序若被用户调整过（长度/内容与内置不同）也一并保留，其余字段以代码为准。
 * - 用户专家团：保留持久化中 source !== 'builtin' 的条目。
 */
function mergeGroups(stored: ExpertGroup[]): ExpertGroup[] {
  const storedMap = new Map(stored.map((g) => [g.id, g]));

  const builtins = BUILTIN_GROUPS.map((b) => {
    const over = storedMap.get(b.id);
    if (!over) return { ...b };
    return {
      ...b,
      enabled: over.enabled,
      // 用户调整过成员（增删/排序）则保留其版本，否则跟随代码升级
      memberIds:
        over.memberIds?.length && over.memberIds.join('|') !== b.memberIds.join('|')
          ? over.memberIds
          : b.memberIds,
      source: 'builtin' as const,
    };
  });

  const userGroups = stored.filter(
    (g) => g.source !== 'builtin' && !BUILTIN_GROUPS.some((b) => b.id === g.id),
  );

  return [...builtins, ...userGroups];
}

export const useExpertGroupsStore = create<ExpertGroupsState>()(
  persist(
    (set, get) => ({
      groups: mergeGroups([]),
      activeGroupId: null,

      refresh: () => {
        set({ groups: mergeGroups(get().groups) });
      },

      createGroup: (partial) => {
        const group: ExpertGroup = {
          id: genId(),
          name: partial?.name ?? '新专家团',
          role: partial?.role,
          description: partial?.description ?? '',
          memberIds: partial?.memberIds ?? [],
          mode: partial?.mode ?? 'sequential',
          icon: partial?.icon,
          enabled: partial?.enabled ?? true,
          createdAt: nowIso(),
          source: 'user',
        };
        set((s) => ({ groups: [...s.groups, group] }));
        return group;
      },

      updateGroup: (id, patch) =>
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        })),

      removeGroup: (id) =>
        set((s) => {
          // 内置专家团不可删除，与 agentsStore / skillsStore 保持一致
          const target = s.groups.find((g) => g.id === id);
          if (target?.source === 'builtin') return s;
          const groups = s.groups.filter((g) => g.id !== id);
          // 删除的若是全局活跃专家团则置空（对齐 agentsStore.removeAgent 的兜底）
          const activeGroupId = s.activeGroupId === id ? null : s.activeGroupId;
          return { groups, activeGroupId };
        }),

      toggleGroup: (id) =>
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g)),
        })),

      setActiveGroup: (id) => set({ activeGroupId: id }),
    }),
    {
      name: STORAGE_KEYS.expertGroups,
      storage: zustandStorage,
      partialize: (s) => ({ groups: s.groups, activeGroupId: s.activeGroupId }),
    },
  ),
);
