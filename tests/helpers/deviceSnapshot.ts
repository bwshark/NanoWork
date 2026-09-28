/**
 * 「两台设备」的 store 快照 / 换装（规格 §I.1 的隔离手段）。
 *
 * 本项目所有 store 都是**模块级单例**，同一进程里无法真的起两套并存的 store。
 * 于是把「一台设备」定义为**一份 store 同步相关切片的深拷贝**：测试在任一时点
 * `snapshotStores()` 拍一张快照，随后 `restoreStores(dev)` 把全局 store 换装成该
 * 设备的状态，再驱动**属于该设备的 `SyncEngine`** `syncNow()`。两台设备交替
 * 「换装 + 同步」即可在单进程内模拟双端。
 *
 * 覆盖 7 个可同步 store 的同步切片 + `sessionsStore` 的 `sessions` /
 * `sessionTombstones`（§G.3 订阅的那 8 个 store 与之一一对应）。
 *
 * 快照用 `structuredClone`（深拷贝）：store 切片都是纯数据（数组 / 普通对象），
 * 不需要结构化共享，也不会把函数 clone 进去。
 */

import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useChannelsStore } from '@/stores/channelsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { DEFAULT_DESKTOP, DEFAULT_TRANSCRIPTION } from '@/stores/settingsStore';
import type {
  Agent,
  ChannelConfig,
  ConnectionStatus,
  ExpertGroup,
  MCPConfig,
  Session,
  Settings,
  Skill,
  SkillOverrideEntry,
  SyncMeta,
  SyncTombstones,
  TaskConfig,
  TaskRunRecord,
} from '@/types';

/** 一台设备在「同步相关切片」上的完整状态（深拷贝后即为隔离副本）。 */
export interface StoreSnapshot {
  agents: { agents: Agent[]; tombstones: SyncTombstones };
  expertGroups: { groups: ExpertGroup[]; tombstones: SyncTombstones };
  tasks: { tasks: TaskConfig[]; tombstones: SyncTombstones; runs: TaskRunRecord[] };
  mcp: { configs: MCPConfig[]; tombstones: SyncTombstones };
  channels: { configs: ChannelConfig[]; tombstones: SyncTombstones };
  skills: { skills: Skill[]; overrides: SkillOverrideEntry[]; pinnedIds: string[] };
  settings: { settings: Settings; status: ConnectionStatus; syncMeta: SyncMeta };
  sessions: {
    sessions: Session[];
    activeId: string | null;
    sessionTombstones: Record<string, SyncMeta>;
  };
}

/** 拍一张全局 store 的同步切片快照（深拷贝，与后续 store 改动解耦）。 */
export function snapshotStores(): StoreSnapshot {
  const agents = useAgentsStore.getState();
  const groups = useExpertGroupsStore.getState();
  const tasks = useTasksStore.getState();
  const mcp = useMcpStore.getState();
  const channels = useChannelsStore.getState();
  const skills = useSkillsStore.getState();
  const settings = useSettingsStore.getState();
  const sessions = useSessionsStore.getState();

  return structuredClone({
    agents: { agents: agents.agents, tombstones: agents.tombstones },
    expertGroups: { groups: groups.groups, tombstones: groups.tombstones },
    tasks: { tasks: tasks.tasks, tombstones: tasks.tombstones, runs: tasks.runs },
    mcp: { configs: mcp.configs, tombstones: mcp.tombstones },
    channels: { configs: channels.configs, tombstones: channels.tombstones },
    skills: { skills: skills.skills, overrides: skills.overrides, pinnedIds: skills.pinnedIds },
    settings: {
      settings: settings.settings,
      status: settings.status,
      syncMeta: settings.syncMeta,
    },
    sessions: {
      sessions: sessions.sessions,
      activeId: sessions.activeId,
      sessionTombstones: sessions.sessionTombstones,
    },
  }) as StoreSnapshot;
}

/** 把全局 store 换装成给定快照（再次深拷贝，避免快照被后续 store 改动污染）。 */
export function restoreStores(snap: StoreSnapshot): void {
  const next = structuredClone(snap);
  useAgentsStore.setState(next.agents);
  useExpertGroupsStore.setState(next.expertGroups);
  useTasksStore.setState(next.tasks);
  useMcpStore.setState(
    next.mcp as unknown as Partial<ReturnType<typeof useMcpStore.getState>>,
  );
  useChannelsStore.setState(
    next.channels as unknown as Partial<ReturnType<typeof useChannelsStore.getState>>,
  );
  useSkillsStore.setState(next.skills);
  useSettingsStore.setState(next.settings);
  useSessionsStore.setState(next.sessions);
}

/** 缺省 `Settings`（本机环境字段按缺省，`defaultWorkspacePath` 由调用方给定）。 */
export function settingsFor(defaultWorkspacePath: string): Settings {
  return {
    gatewayEndpoint: 'http://127.0.0.1:8765/v1',
    apiToken: '',
    theme: 'system',
    memoryEnabled: true,
    autoSummarize: true,
    transcription: { ...DEFAULT_TRANSCRIPTION },
    desktop: { ...DEFAULT_DESKTOP },
    workspaceAliases: {},
    knownWorkspaces: [],
    sidebarCollapsed: false,
    hiddenSessions: [],
    shortcuts: {},
    defaultWorkspacePath,
  };
}

/**
 * 造一台「全新设备」的空状态：所有集合为空，设置只带本机默认工作空间。
 *
 * 两台的差别就在 `defaultWorkspacePath`——用来验证「拉来的会话 `streamWorkdir`
 * 被重定向为**本机**默认」（§D.5），错指向对端时断言会红。
 */
export function emptyDevice(defaultWorkspacePath: string): StoreSnapshot {
  return {
    agents: { agents: [], tombstones: {} },
    expertGroups: { groups: [], tombstones: {} },
    tasks: { tasks: [], tombstones: {}, runs: [] },
    mcp: { configs: [], tombstones: {} },
    channels: { configs: [], tombstones: {} },
    skills: { skills: [], overrides: [], pinnedIds: [] },
    settings: {
      settings: settingsFor(defaultWorkspacePath),
      status: 'offline',
      syncMeta: { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null },
    },
    sessions: { sessions: [], activeId: null, sessionTombstones: {} },
  };
}

/** 把全局 store 复位成「一台空设备」。 */
export function resetStoresEmpty(defaultWorkspacePath = '/local/default-ws'): void {
  restoreStores(emptyDevice(defaultWorkspacePath));
}

/** 造一个带同步元数据的用户 Agent（同步相关字段：id / name / enabled）。 */
export function makeAgent(
  id: string,
  over: Partial<Agent> = {},
): Agent {
  return {
    id,
    name: id,
    systemPrompt: '',
    skillIds: [],
    imBinding: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'user',
    rev: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'dev',
    deletedAt: null,
    ...over,
  };
}

/** 造一条带同步元数据的会话（`workdir` 是语义工作空间，`streamWorkdir` 是本机分片）。 */
export function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agentId: 'a1',
    title: `会话-${id}`,
    messages: [],
    permissionLog: [],
    workdir: '/remote/path',
    streamWorkdir: '/devA/ws',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    updatedBy: 'dev-a',
    ...over,
  };
}
