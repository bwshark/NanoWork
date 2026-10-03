/**
 * 批次 4：`createDefaultRegistry` 的 7 个新 collection 契约（规格 §A / §B / §C / §D）。
 *
 * 覆盖 §I.3 变异清单里属于注册表范围的行：
 * - **D-①** `keyOf` 改成常量 → 「两条独立实体各自落地」变红；
 * - **D-②** `apply` 改用 store 业务动作 → 「pull 落地后 `rev` 等于 incoming」变红；
 * - **D-③** 从 `MCP_SYNC_OMIT_KEYS` 删 `auth` → 「payload 不含 `auth`」变红；
 * - **A.2** `tasks` 的 `runs` 永不进负载；
 * - **A.4 / B-2** `channels` 落地保住本机 `id`；
 * - **A.5** `skillOverrides` 落地后重算派生视图（`skills` / `pinnedIds`）；
 * - **A.8** 不注册 `sessionEvents`。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@/sync/syncRegistry';
import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useChannelsStore } from '@/stores/channelsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  Agent,
  ChannelConfig,
  ExpertGroup,
  MCPConfig,
  Settings,
  Skill,
  SkillOverrideEntry,
  TaskConfig,
} from '@/types';
import { DEFAULT_MEMORY_POLICY } from '@/types';

const META = { rev: 2, updatedAt: '2026-06-01T00:00:00.000Z', updatedBy: 'dev-a' };

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    systemPrompt: '',
    skillIds: [],
    imBinding: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'user',
    ...over,
  };
}

function group(id: string, over: Partial<ExpertGroup> = {}): ExpertGroup {
  return {
    id,
    name: id,
    description: '',
    memberIds: [],
    mode: 'parallel',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function task(id: string, over: Partial<TaskConfig> = {}): TaskConfig {
  return {
    id,
    name: id,
    schedule: { kind: 'interval', minutes: 30 },
    prompt: '',
    agentId: 'a1',
    status: 'enabled',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function mcp(id: string, over: Partial<MCPConfig> = {}): MCPConfig {
  return {
    id,
    name: id,
    transport: 'url',
    connectionStatus: 'unknown',
    syncStatus: 'idle',
    ...over,
  };
}

function channel(id: string, kind: ChannelConfig['kind'], over: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id,
    kind,
    enabled: true,
    allowFrom: [],
    syncStatus: 'idle',
    ...over,
  };
}

function skill(id: string, over: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    description: '',
    category: 'general',
    prompt: '',
    source: 'local',
    enabled: true,
    ...over,
  };
}

function override(skillId: string, over: Partial<SkillOverrideEntry> = {}): SkillOverrideEntry {
  return {
    skillId,
    override: 'off',
    pinned: false,
    rev: 1,
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedBy: 'dev-a',
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  useAgentsStore.setState({ agents: [], tombstones: {} });
  useExpertGroupsStore.setState({ groups: [], tombstones: {} });
  useTasksStore.setState({ tasks: [], tombstones: {}, runs: [] });
  useMcpStore.setState({ configs: [], tombstones: {} });
  useChannelsStore.setState({ configs: [], tombstones: {} });
  useSkillsStore.setState({ skills: [], overrides: [], pinnedIds: [] });
});

// ─────────────────────── A.8 注册集合的范围 ───────────────────────

describe('createDefaultRegistry：注册的 collection 范围', () => {
  it('登记了 8 个 collection（agents + 批次 4 的 7 个）', () => {
    const collections = createDefaultRegistry()
      .entries()
      .map((s) => s.collection);
    expect(collections.sort()).toEqual(
      ['agents', 'channels', 'expertGroups', 'mcp', 'sessionMeta', 'settings', 'skillOverrides', 'tasks'].sort(),
    );
  });

  it('不注册 sessionEvents（§A.8：append-only / 异步事实源 / 落点未定）', () => {
    const collections = createDefaultRegistry()
      .entries()
      .map((s) => s.collection);
    expect(collections).not.toContain('sessionEvents');
  });
});

// ─────────────────────── D-① keyOf 区分实体 ───────────────────────

describe('keyOf：区分不同实体（D-① 常量 keyOf 会互相覆盖）', () => {
  it('id 键的五个 collection：不同 id → 不同 key', () => {
    const reg = createDefaultRegistry();
    for (const collection of ['agents', 'expertGroups', 'tasks', 'mcp', 'sessionMeta'] as const) {
      const spec = reg.get(collection)!;
      expect(spec.keyOf({ id: 'a' })).toBe('a');
      expect(spec.keyOf({ id: 'a' })).not.toBe(spec.keyOf({ id: 'b' }));
    }
  });

  it('channels：key 是 kind，且对墓碑记录（只有 id=kind）容错', () => {
    const spec = createDefaultRegistry().get('channels')!;
    expect(spec.keyOf({ kind: 'feishu' })).toBe('feishu');
    expect(spec.keyOf({ kind: 'feishu' })).not.toBe(spec.keyOf({ kind: 'lark' }));
    // 墓碑记录：`tombstoneEntries()` 产出 `{ id: <落点键=kind>, ...meta }`，无 kind
    expect(spec.keyOf({ id: 'feishu' })).toBe('feishu');
  });

  it('skillOverrides：key 是 skillId，对缺失 skillId 的记录回退 id', () => {
    const spec = createDefaultRegistry().get('skillOverrides')!;
    expect(spec.keyOf({ skillId: 'sk1' })).toBe('sk1');
    expect(spec.keyOf({ id: 'sk1' })).toBe('sk1');
  });

  it('两条独立实体各自落地、不互相覆盖（D-①）', () => {
    const reg = createDefaultRegistry();
    reg.get('agents')!.apply({ ...agent('a1'), ...META });
    reg.get('agents')!.apply({ ...agent('a2'), ...META });
    expect(useAgentsStore.getState().agents.map((a) => a.id).sort()).toEqual(['a1', 'a2']);

    reg.get('expertGroups')!.apply({ ...group('g1'), ...META });
    reg.get('expertGroups')!.apply({ ...group('g2'), ...META });
    expect(useExpertGroupsStore.getState().groups.map((g) => g.id).sort()).toEqual(['g1', 'g2']);
  });
});

// ─────────────── D-② apply 不调业务动作（rev 原样） ───────────────

describe('apply 落地：元数据原样采用，不被 store 业务动作污染（D-②）', () => {
  it('expertGroups：落地 incoming 的 rev / updatedAt / updatedBy', () => {
    const spec = createDefaultRegistry().get('expertGroups')!;
    spec.apply({
      ...group('g1', { name: '远端名' }),
      rev: 7,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-b',
      deletedAt: null,
    });
    const g = useExpertGroupsStore.getState().groups.find((x) => x.id === 'g1')!;
    expect(g.name).toBe('远端名');
    expect(g.rev).toBe(7);
    expect(g.updatedBy).toBe('dev-b');
  });

  it('mcp：落地保留 incoming 元数据', () => {
    const spec = createDefaultRegistry().get('mcp')!;
    spec.apply({
      ...mcp('m1'),
      rev: 3,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-b',
      deletedAt: null,
    });
    const cfg = useMcpStore.getState().configs.find((x) => x.id === 'm1')!;
    expect(cfg.rev).toBe(3);
    expect(cfg.updatedBy).toBe('dev-b');
  });

  it('tasks：墓碑落地入表 + 从存活数组摘除', () => {
    useTasksStore.setState({ tasks: [task('t1')], tombstones: {}, runs: [] });
    const spec = createDefaultRegistry().get('tasks')!;
    spec.apply({ id: 't1', rev: 4, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-a', deletedAt: '2026-09-01T00:00:00.000Z' });
    const state = useTasksStore.getState();
    expect(state.tasks.find((t) => t.id === 't1')).toBeUndefined();
    expect(state.tombstones.t1).toMatchObject({ rev: 4 });
  });
});

// ─────────────────────── A.2 tasks 的 runs ───────────────────────

describe('A.2 tasks：runs 是 store 级字段，永不进同步负载', () => {
  it('payload 不含 runs（即便 store 里 runs 非空）', () => {
    useTasksStore.setState({
      tasks: [task('t1')],
      tombstones: {},
      runs: [
        {
          id: 'r1',
          taskId: 't1',
          taskName: 't1',
          trigger: 'manual',
          startedAt: '2026-01-01T00:00:00.000Z',
          status: 'success',
        },
      ],
    });
    const spec = createDefaultRegistry().get('tasks')!;
    const { entities } = spec.read();
    const payload = spec.payload(entities[0]);
    expect('runs' in payload).toBe(false);
  });
});

// ─────────────────────── D-③ mcp omit 清单 ───────────────────────

describe('A.3 / D-③ mcp：payload 剔除运行时事实 + authKeyNames + auth', () => {
  it('payload 不含 7 个 omit 键，且保留声明字段', () => {
    const spec = createDefaultRegistry().get('mcp')!;
    const config: MCPConfig = {
      ...mcp('m1'),
      endpoint: 'http://x/mcp',
      enabled: true,
      connectionStatus: 'connected',
      syncStatus: 'synced',
      lastProbedAt: 1,
      lastSyncedAt: 2,
      tools: [{ name: 'tool' }],
      auth: { token: 'secret-value' },
      authKeyNames: ['token'],
    };
    const payload = spec.payload({ ...config });

    for (const key of ['connectionStatus', 'syncStatus', 'tools', 'lastProbedAt', 'lastSyncedAt', 'authKeyNames', 'auth']) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload).toMatchObject({ id: 'm1', name: 'm1', endpoint: 'http://x/mcp', enabled: true });
  });
});

// ─────────────── A.4 / B-1 / B-2 channels 身份 ───────────────

describe('A.4 / B：channels 落地保住本机 id（应用对端负载）', () => {
  it('落地对端 id 不覆盖本机 id（B-2）', () => {
    useChannelsStore.setState({ configs: [channel('local-id', 'feishu')], tombstones: {} });
    const spec = createDefaultRegistry().get('channels')!;
    spec.apply({
      id: 'remote-random',
      kind: 'feishu',
      enabled: true,
      allowFrom: ['u1'],
      syncStatus: 'idle',
      rev: 5,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'dev-b',
      deletedAt: null,
    });
    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'feishu')!;
    expect(cfg.id).toBe('local-id'); // 本机 id 保留
    expect(cfg.allowFrom).toEqual(['u1']); // 对端声明字段落地
    expect(cfg.rev).toBe(5);
  });

  it('本机没有该 kind 时分配新 id', () => {
    useChannelsStore.setState({ configs: [], tombstones: {} });
    const spec = createDefaultRegistry().get('channels')!;
    spec.apply({ id: 'remote-random', kind: 'lark', enabled: true, allowFrom: [], syncStatus: 'idle', rev: 1, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-b', deletedAt: null });
    const cfg = useChannelsStore.getState().configs.find((c) => c.kind === 'lark')!;
    expect(cfg).toBeTruthy();
    expect(cfg.id).not.toBe('remote-random'); // 用 genId 重新分配
  });

  it('channel 墓碑（id=kind）落地：按 kind 摘除同名渠道', () => {
    useChannelsStore.setState({ configs: [channel('abc', 'feishu')], tombstones: {} });
    const spec = createDefaultRegistry().get('channels')!;
    spec.apply({ id: 'feishu', rev: 3, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-a', deletedAt: '2026-09-01T00:00:00.000Z' });
    const state = useChannelsStore.getState();
    expect(state.configs.find((c) => c.kind === 'feishu')).toBeUndefined();
    expect(state.tombstones.feishu).toMatchObject({ rev: 3 });
  });

  it('channels payload 剔除凭据（clientSecret 等）', () => {
    const spec = createDefaultRegistry().get('channels')!;
    const payload = spec.payload({ ...channel('c1', 'dingtalk', { clientId: 'id', clientSecret: 'sec', allowFrom: ['u'] }) });
    expect(payload).not.toHaveProperty('clientSecret');
    expect(payload).not.toHaveProperty('clientId');
    expect(payload).toMatchObject({ kind: 'dingtalk', allowFrom: ['u'] });
  });
});

// ─────────────── A.5 skillOverrides 派生视图重算 ───────────────

describe('A.5 skillOverrides：无墓碑 + 落地后重算派生视图', () => {
  it('read 返回空墓碑表', () => {
    const spec = createDefaultRegistry().get('skillOverrides')!;
    expect(spec.read().tombstones).toEqual({});
  });

  it('落地 off→on 后 skills.enabled 随派生视图变真', () => {
    useSkillsStore.setState({ skills: [skill('sk1', { enabled: true, override: 'off' })], overrides: [], pinnedIds: [] });
    const spec = createDefaultRegistry().get('skillOverrides')!;
    spec.apply({ ...override('sk1', { override: 'off', rev: 2, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-a' }) });
    expect(useSkillsStore.getState().skills.find((s) => s.id === 'sk1')!.enabled).toBe(false);

    // pull 一条把 override 改回 on 的条目 → enabled 必须变真（漏重算 → 变红）
    spec.apply({ ...override('sk1', { override: 'on', rev: 3, updatedAt: '2026-09-02T00:00:00.000Z', updatedBy: 'dev-b' }) });
    const state = useSkillsStore.getState();
    expect(state.overrides.find((o) => o.skillId === 'sk1')!.override).toBe('on');
    expect(state.skills.find((s) => s.id === 'sk1')!.enabled).toBe(true);
  });

  it('pinned 随派生视图重算', () => {
    useSkillsStore.setState({ skills: [skill('sk1')], overrides: [], pinnedIds: [] });
    const spec = createDefaultRegistry().get('skillOverrides')!;
    spec.apply({ ...override('sk1', { pinned: true, override: 'on' }) });
    expect(useSkillsStore.getState().pinnedIds).toEqual(['sk1']);
  });
});

// ─────────────── A.6 / C settings 单例 keyOf + 实体形状 ───────────────

describe('A.6 / C：settings 单例', () => {
  it('keyOf 恒为 local（含缺 id 的墓碑记录）', () => {
    const spec = createDefaultRegistry().get('settings')!;
    expect(spec.keyOf({ id: 'local' })).toBe('local');
    expect(spec.keyOf({})).toBe('local');
  });

  it('read 恰好一条实体，且带 id + 四元数据（合成）', () => {
    useSettingsStore.setState({
      settings: baseSettingsForRegistryTest(),
      syncMeta: { rev: 9, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'dev-a', deletedAt: null },
    });
    const spec = createDefaultRegistry().get('settings')!;
    const { entities, tombstones } = spec.read();
    expect(entities).toHaveLength(1);
    expect(tombstones).toEqual({});
    expect(entities[0]).toMatchObject({ id: 'local', rev: 9, updatedBy: 'dev-a' });
  });

  it('payload 恒等（实体已是裁剪后形态）', () => {
    const spec = createDefaultRegistry().get('settings')!;
    const entity = { id: 'local', theme: 'dark', rev: 1 };
    expect(spec.payload(entity)).toBe(entity);
  });
});

/** 最小合法 `Settings`（仅为让 settingsEntity 的 `toSyncPayload` 有输入）。 */
function baseSettingsForRegistryTest(): Settings {
  return {
    gatewayEndpoint: 'http://127.0.0.1:8000',
    apiToken: 'secret',
    theme: 'dark',
    processDetail: 'key',
    memoryEnabled: true,
    autoSummarize: true,
    memoryRecall: true,
    memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
    transcription: { enabled: false, endpoint: 'http://local', model: 'whisper-1', apiToken: '', language: 'zh' },
    desktop: { closeToTray: true, hotkey: '', openAtLogin: false, showInDock: true },
    workspaceAliases: {},
    knownWorkspaces: [],
    sidebarCollapsed: false,
    hiddenSessions: [],
    shortcuts: {},
  };
}
