import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { genId } from '@/lib/id';
import { BUILTIN_AGENTS } from '@/ai/builtinAgents';
import type { Agent } from '@/types';

interface AgentsState {
  agents: Agent[];
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
      // 头像：内置 Agent 不接受用户上传，因此不取 over.avatar；
      // 派生占位（名称首字符 + hashColor）由 UI 层做
      source: 'builtin' as const,
    };
  });

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
          imBinding: partial?.imBinding ?? null,
          enabled: partial?.enabled ?? true,
          createdAt: nowIso(),
          source: 'user',
        };
        set((s) => ({ agents: [...s.agents, agent], activeAgentId: agent.id }));
        return agent;
      },

      updateAgent: (id, patch) =>
        set((s) => ({
          agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),

      removeAgent: (id) =>
        set((s) => {
          // 内置 Agent 不可删除，保持与 skillsStore 一致
          const target = s.agents.find((a) => a.id === id);
          if (target?.source === 'builtin') return s;
          const agents = s.agents.filter((a) => a.id !== id);
          const activeAgentId =
            s.activeAgentId === id ? agents[0]?.id ?? null : s.activeAgentId;
          return { agents, activeAgentId };
        }),

      toggleAgent: (id) =>
        set((s) => ({
          agents: s.agents.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
        })),

      setActiveAgent: (id) => set({ activeAgentId: id }),
    }),
    {
      name: STORAGE_KEYS.agents,
      storage: zustandStorage,
      partialize: (s) => ({ agents: s.agents, activeAgentId: s.activeAgentId }),
    },
  ),
);
