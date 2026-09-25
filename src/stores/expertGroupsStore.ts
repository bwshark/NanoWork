import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { ensureMetaList, pickMeta, withTombstone, withoutTombstone } from '@/lib/syncMeta';
import { metaForDelete, metaForEdit, metaForNew } from '@/lib/syncStamp';
import { BUILTIN_GROUPS } from '@/ai/builtinExpertGroups';
import type { ExpertGroup, SyncTombstones } from '@/types';

interface ExpertGroupsState {
  groups: ExpertGroup[];
  /**
   * 已删除条目的墓碑表（`id → 删除元数据`）。
   * 与 `groups` 分开存，理由同 `agentsStore.tombstones`。
   */
  tombstones: SyncTombstones;
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
      // 同步元数据随用户覆盖一起保留（理由同 agentsStore 的 mergeAgents）
      ...pickMeta(over),
      source: 'builtin' as const,
    };
  });

  // 本函数只处理**存活**条目——删除的痕迹在 `tombstones` 表里，与此无关
  const userGroups = stored.filter(
    (g) => g.source !== 'builtin' && !BUILTIN_GROUPS.some((b) => b.id === g.id),
  );

  return [...builtins, ...userGroups];
}

export const useExpertGroupsStore = create<ExpertGroupsState>()(
  persist(
    (set, get) => ({
      groups: mergeGroups([]),
      tombstones: {},
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
          ...metaForNew(),
          source: 'user',
        };
        set((s) => ({
          groups: [...s.groups, group],
          // 同 id 重新出现 = 「删除后又建回来」：清掉旧墓碑（理由同 agentsStore.createAgent）
          tombstones: withoutTombstone(s.tombstones, group.id),
        }));
        return group;
      },

      // 元数据在 patch 之后展开，理由同 agentsStore.updateAgent
      updateGroup: (id, patch) =>
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch, ...metaForEdit(g) } : g)),
        })),

      removeGroup: (id) =>
        set((s) => {
          // 内置专家团不可删除，与 agentsStore / skillsStore 保持一致
          const target = s.groups.find((g) => g.id === id);
          if (!target || target.source === 'builtin') return s;
          return {
            // 删除 = 摘除条目 + 留墓碑（理由同 agentsStore.removeAgent）
            groups: s.groups.filter((g) => g.id !== id),
            tombstones: withTombstone(s.tombstones, id, metaForDelete(target)),
            // 删除的若是全局活跃专家团则置空（对齐 agentsStore.removeAgent 的兜底）
            activeGroupId: s.activeGroupId === id ? null : s.activeGroupId,
          };
        }),

      toggleGroup: (id) =>
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id ? { ...g, enabled: !g.enabled, ...metaForEdit(g) } : g,
          ),
        })),

      setActiveGroup: (id) => set({ activeGroupId: id }),
    }),
    {
      name: STORAGE_KEYS.expertGroups,
      storage: zustandStorage,
      // v1：补同步元数据四字段与空墓碑表（同 agentsStore）
      version: 1,
      migrate: (persisted) => {
        const p = persisted as
          | { groups?: ExpertGroup[]; tombstones?: SyncTombstones; activeGroupId?: string | null }
          | undefined;
        return {
          groups: ensureMetaList(p?.groups),
          tombstones: p?.tombstones ?? {},
        };
      },
      partialize: (s) => ({
        groups: s.groups,
        tombstones: s.tombstones,
        activeGroupId: s.activeGroupId,
      }),
    },
  ),
);
