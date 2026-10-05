import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { ensureMetaList, pickMeta, withTombstone, withoutTombstone } from '@/lib/syncMeta';
import { metaForDelete, metaForEdit, metaForNew } from '@/lib/syncStamp';
import { BUILTIN_AGENTS } from '@/ai/builtinAgents';
import type { Agent, SyncTombstones } from '@/types';

interface AgentsState {
  agents: Agent[];
  /**
   * 已删除条目的墓碑表（`id → 删除元数据`）。
   *
   * 与 `agents` **分开存**：存活数组天生只含存活项，因此 UI（`s.agents`）与
   * `mergeAgents` 都不必知道墓碑的存在。理由与被否决的「内联 `deletedAt` 方案」
   * 见 `types/sync.ts` 的 `SyncTombstones`。
   */
  tombstones: SyncTombstones;
  activeAgentId: string | null;
  /** 重新合并内置 Agent 与持久化数据（启动时调用，保证内置恒在） */
  refresh: () => void;
  createAgent: (partial?: Partial<Agent>) => Agent;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  removeAgent: (id: string) => void;
  toggleAgent: (id: string) => void;
  setActiveAgent: (id: string) => void;
}

const nowIso = () => new Date().toISOString();

/** 默认激活的 Agent：内置通用助手（稳定 id，避免随机 id 导致重启失效） */
const DEFAULT_AGENT_ID = 'builtin:general';

/**
 * 基于当前内置目录与持久化数据重新合并。
 * - 内置 Agent：以代码中的 BUILTIN_AGENTS 为真源，仅恢复用户在持久化中覆盖的启用状态；
 *   prompt / skillIds 等以代码版本为准（升级即生效）。
 * - 用户 Agent：保留持久化中 source !== 'builtin' 的条目；
 *   为避免老版本随机 id 的「通用助手」与内置重复，名称命中内置者予以剔除。
 */
function mergeAgents(stored: Agent[]): Agent[] {
  const storedMap = new Map(stored.map((a) => [a.id, a]));
  const builtinNames = new Set(BUILTIN_AGENTS.map((b) => b.name.trim()));

  const builtins = BUILTIN_AGENTS.map((b) => {
    const over = storedMap.get(b.id);
    if (!over) return { ...b };
    // 代码为真源，但保留用户在 UI 上对启用状态 / 提示词 / 技能 / 头像的用户覆盖
    return {
      ...b,
      enabled: over.enabled,
      systemPrompt: over.systemPrompt?.trim() ? over.systemPrompt : b.systemPrompt,
      skillIds: over.skillIds?.length ? over.skillIds : b.skillIds,
      // FR-2.2：工具策略的用户覆盖同样以「用户设过就用用户的」为准。
      // 判据是「字段存在」而不是长度——空白名单是有效取值（一个工具都不许）。
      toolAllow: over.toolAllow ?? b.toolAllow,
      toolDeny: over.toolDeny ?? b.toolDeny,
      // design §13.1：Agent 级提示词覆盖。同样按「字段存在」判据，未设则沿用内置值
      // （内置 Agent 本身没声明时仍是 undefined = 跟随全局设置）。
      promptDomain: over.promptDomain ?? b.promptDomain,
      promptStyle: over.promptStyle ?? b.promptStyle,
      // FR-2.3 模型绑定：清空时 UI 传的是**空串**（与任务表单的模型选择一致），
      // `'' ?? b.model` 求值为 `''` —— 即「清掉就真的清掉」；传 undefined 则会
      // 回落到内置绑定。所以两条路径的取值约定必须一致，别一处清成空串、一处删字段。
      model: over.model ?? b.model,
      // 头像：内置 Agent 不接受用户上传，因此不取 over.avatar；
      // 派生占位（名称首字符 + hashColor）由 UI 层做
      // 同步元数据随用户覆盖一起保留：内置条目的真源是代码，`rev` 只有在用户
      // 改动过它时才存在。不透传的话「改了内置 Agent 的启用状态」在下次启动
      // 重建后查无对证（`rev` 回到缺省，被当成从未改过的老数据）
      ...pickMeta(over),
      source: 'builtin' as const,
    };
  });

  // 用户 Agent：保留持久化中 source !== 'builtin' 的条目。
  // 本函数只处理**存活**条目——删除的痕迹在 `tombstones` 表里，与此无关
  const userAgents = stored.filter(
    (a) =>
      a.source !== 'builtin' &&
      !BUILTIN_AGENTS.some((b) => b.id === a.id) &&
      !builtinNames.has(a.name.trim()),
  );

  return [...builtins, ...userAgents];
}

export const useAgentsStore = create<AgentsState>()(
  persist(
    (set, get) => ({
      agents: mergeAgents([]),
      tombstones: {},
      activeAgentId: DEFAULT_AGENT_ID,

      refresh: () => {
        set({ agents: mergeAgents(get().agents) });
      },

      createAgent: (partial) => {
        const agent: Agent = {
          id: genId(),
          name: partial?.name ?? '新 Agent',
          systemPrompt: partial?.systemPrompt ?? '',
          skillIds: partial?.skillIds ?? [],
          // FR-2.2：工具策略。刻意用 `?? undefined` 而不是 `?? []`——
          // 空数组是「一个工具都不许」，不能拿来充当「用户还没设置」。
          toolAllow: partial?.toolAllow,
          toolDeny: partial?.toolDeny,
          // design §13.1：Agent 级领域 / 风格覆盖。同上，省略 = 跟随全局设置。
          // 必须在创建时一并落库：这是白名单式构造，漏掉就等于「新建时选的覆盖
          // 在保存瞬间消失」，而编辑已有 Agent 走的是 updateAgent 的展开赋值，
          // 两条路径行为不一致的话，只有新建会遇到这个坑。
          promptDomain: partial?.promptDomain,
          promptStyle: partial?.promptStyle,
          // FR-2.3 模型绑定。⚠️ 这个字段**必须**在白名单里：本函数是白名单式构造，
          // 漏掉就等于「新建 Agent 时选的模型在保存瞬间消失」，而编辑已有 Agent 走
          // `updateAgent` 的展开赋值不会有此问题——两条路径行为不一致的话，
          // 只有「新建」会遇到这个坑，而它又最难被注意到。
          model: partial?.model,
          imBinding: partial?.imBinding ?? null,
          enabled: partial?.enabled ?? true,
          createdAt: nowIso(),
          ...metaForNew(),
          source: 'user',
        };
        set((s) => ({
          agents: [...s.agents, agent],
          // 同 id 重新出现 = 「删除后又建回来」：必须清掉旧墓碑，否则同步会把这个
          // 刚建好的条目按「已删除」推出去，而本机看起来一切正常
          tombstones: withoutTombstone(s.tombstones, agent.id),
          activeAgentId: agent.id,
        }));
        return agent;
      },

      // 元数据在 `patch` **之后**展开：调用方传进来的 patch 里若夹带元数据字段
      // （如从别处整对象回填），不得覆盖本次改动的标记
      updateAgent: (id, patch) =>
        set((s) => ({
          agents: s.agents.map((a) =>
            a.id === id ? { ...a, ...patch, ...metaForEdit(a) } : a,
          ),
        })),

      removeAgent: (id) =>
        set((s) => {
          // 内置 Agent 不可删除，保持与 skillsStore 一致
          const target = s.agents.find((a) => a.id === id);
          if (!target || target.source === 'builtin') return s;
          const agents = s.agents.filter((a) => a.id !== id);
          return {
            agents,
            // 删除 = 摘除条目 + 留墓碑。摘除让列表天然干净（无需任何过滤器），
            // 墓碑让删除能被 LWW 传播到别的设备——两者缺一不可
            tombstones: withTombstone(s.tombstones, id, metaForDelete(target)),
            // 删掉的是当前激活项时，退到剩余列表的第一条（对齐原实现）
            activeAgentId: s.activeAgentId === id ? agents[0]?.id ?? null : s.activeAgentId,
          };
        }),

      toggleAgent: (id) =>
        set((s) => ({
          agents: s.agents.map((a) =>
            a.id === id ? { ...a, enabled: !a.enabled, ...metaForEdit(a) } : a,
          ),
        })),

      setActiveAgent: (id) => set({ activeAgentId: id }),
    }),
    {
      name: STORAGE_KEYS.agents,
      storage: zustandStorage,
      // v1：给存量数据补同步元数据四字段（缺字段按 `LEGACY_REV` 落盘）、补空墓碑表
      version: 1,
      migrate: (persisted) => {
        const p = persisted as
          | { agents?: Agent[]; tombstones?: SyncTombstones; activeAgentId?: string | null }
          | undefined;
        return {
          agents: ensureMetaList(p?.agents),
          tombstones: p?.tombstones ?? {},
        };
      },
      partialize: (s) => ({
        agents: s.agents,
        tombstones: s.tombstones,
        activeAgentId: s.activeAgentId,
      }),
    },
  ),
);
