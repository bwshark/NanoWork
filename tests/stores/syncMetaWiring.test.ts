/**
 * 批次 2：五个可变实体 store 的同步元数据接线（design §19.2 / architecture-syncmeta §七）。
 *
 * 每个 store 守两条判据，都是**可证伪**的：
 * 1. 「改 → `rev` 递增」：误把 `rev` 写成常量、或漏标记某条写动作，这里会红；
 * 2. 「删 → 留墓碑且不出现在列表」：墓碑丢了（同步传不出删除）或条目没摘除
 *    （列表里留下删不掉的幽灵）都会红。
 *
 * 另有三条 store 特有的：
 * - `channelsStore`：墓碑**按 `kind` 键控**，且引擎回读不能把删掉的渠道搬回来；
 * - `mcpStore`：运行时事实（`status`）不算改动 —— 否则每点一次「测试」就涨一次
 *   `rev`，版本号里掺进噪声，LWW 的「谁改的更新」就没法判；
 * - `tasksStore`：墓碑 id 不被引擎镜像重放复活。
 *
 * `@/ai/runtime` 被整体替换成内存桩：这些 store 都会在写动作后触发**防抖自动同步**，
 * 不桩掉就会在用例结束前后真的发请求（失败是静默的，但会把用例变成看运气）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存化的 runtime：`read` 按 collection 分发，`sync` 恒成功 */
const runtimeStub = vi.hoisted(() => ({
  /** `read('channels')` 返回的内容（回读用例用） */
  channels: [] as unknown[],
}));

vi.mock('@/ai/runtime', () => ({
  getRuntime: () => ({
    read: async (collection: string) => (collection === 'channels' ? runtimeStub.channels : []),
    sync: async () => ({ ok: true, message: '' }),
  }),
}));

import { STORAGE_KEYS } from '@/lib/constants';
import { platform } from '@/platform';
import { SKILLS } from '@/ai/builtinSkills';
import { useAgentsStore } from '@/stores/agentsStore';
import { useChannelsStore } from '@/stores/channelsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { useTasksStore } from '@/stores/tasksStore';
import type { ChannelConfig, Skill, SkillOverrideEntry } from '@/types';

beforeEach(() => {
  window.localStorage.clear();
  runtimeStub.channels = [];
  vi.restoreAllMocks();
  /*
   * 每个 store 全量回到出厂状态。
   * 墓碑表必须一起清：它是**跨用例残留**最隐蔽的一处——上一条用例删掉的 id
   * 会让这条用例的「新建同 id」被当成「删除后又建回来」而拒绝写入。
   */
  useAgentsStore.setState({ agents: [], tombstones: {}, activeAgentId: null });
  useExpertGroupsStore.setState({ groups: [], tombstones: {}, activeGroupId: null });
  useTasksStore.setState({
    tasks: [],
    tombstones: {},
    runs: [],
    lastSync: null,
    syncing: false,
  });
  useMcpStore.setState({ configs: [], tombstones: {}, vaultAvailable: null, secretKeys: {} });
  useChannelsStore.setState({ configs: [], tombstones: {}, lastSync: null });
});

describe('agentsStore：改 → rev+1，删 → 墓碑且不在列表', () => {
  it('新建 rev=1、改动 rev=2、删除 rev=3 且墓碑带 deletedAt', () => {
    const agent = useAgentsStore.getState().createAgent({ name: '被改的 Agent' });
    expect(agent.rev).toBe(1);
    expect(agent.deletedAt).toBeNull();
    expect(agent.updatedAt).not.toBe('');

    useAgentsStore.getState().updateAgent(agent.id, { name: '改过名' });
    const edited = useAgentsStore.getState().agents.find((a) => a.id === agent.id);
    expect(edited?.rev).toBe(2);
    expect(edited?.name).toBe('改过名');

    useAgentsStore.getState().removeAgent(agent.id);

    // 条目被真正摘除（列表天生干净），删除痕迹只留在墓碑表里
    expect(useAgentsStore.getState().agents.some((a) => a.id === agent.id)).toBe(false);
    const tombstone = useAgentsStore.getState().tombstones[agent.id];
    expect(tombstone).toBeTruthy();
    expect(tombstone.rev).toBe(3);
    expect(tombstone.deletedAt).not.toBeNull();
  });

  it('重复删除不推进 rev（幂等），且不复活已有墓碑', () => {
    const agent = useAgentsStore.getState().createAgent({ name: '删两次' });
    useAgentsStore.getState().removeAgent(agent.id);
    const first = useAgentsStore.getState().tombstones[agent.id];

    useAgentsStore.getState().removeAgent(agent.id);

    expect(useAgentsStore.getState().tombstones[agent.id]).toBe(first);
  });

  it('内置 Agent 删不掉：不留墓碑，也不从列表消失', () => {
    // 先让内置条目进 state
    useAgentsStore.setState({ agents: [], tombstones: {}, activeAgentId: null });
    useAgentsStore.getState().refresh();
    const builtinId = useAgentsStore.getState().agents[0].id;

    useAgentsStore.getState().removeAgent(builtinId);

    expect(useAgentsStore.getState().agents.some((a) => a.id === builtinId)).toBe(true);
    expect(useAgentsStore.getState().tombstones[builtinId]).toBeUndefined();
  });
});

describe('expertGroupsStore：改 → rev+1，删 → 墓碑且不在列表', () => {
  it('新建 rev=1、改动 rev=2、删除 rev=3', () => {
    const group = useExpertGroupsStore.getState().createGroup({ name: '被改的团' });
    expect(group.rev).toBe(1);

    useExpertGroupsStore.getState().updateGroup(group.id, { name: '改过名' });
    expect(useExpertGroupsStore.getState().groups.find((g) => g.id === group.id)?.rev).toBe(2);

    useExpertGroupsStore.getState().removeGroup(group.id);

    expect(useExpertGroupsStore.getState().groups.some((g) => g.id === group.id)).toBe(false);
    expect(useExpertGroupsStore.getState().tombstones[group.id]?.rev).toBe(3);
  });
});

describe('tasksStore：改 → rev+1，删 → 墓碑且不被镜像重放复活', () => {
  it('新建 rev=1、改动 rev=2、删除 rev=3', () => {
    const task = useTasksStore.getState().addTask({ name: '被改的任务' });
    expect(task?.rev).toBe(1);

    useTasksStore.getState().updateTask(task!.id, { name: '改过名' });
    expect(useTasksStore.getState().tasks.find((t) => t.id === task!.id)?.rev).toBe(2);

    useTasksStore.getState().removeTask(task!.id);

    expect(useTasksStore.getState().tasks.some((t) => t.id === task!.id)).toBe(false);
    expect(useTasksStore.getState().tombstones[task!.id]?.rev).toBe(3);
  });

  it('同一 id 再来一次（引擎 job 镜像重放）不会复活已删任务', () => {
    const task = useTasksStore.getState().addTask({ name: '跑完就删' });
    useTasksStore.getState().removeTask(task!.id);

    const replay = useTasksStore.getState().addTask({ id: task!.id, name: '镜像重放' });

    expect(replay).toBeNull();
    expect(useTasksStore.getState().tasks.some((t) => t.id === task!.id)).toBe(false);
  });
});

describe('mcpStore：改 → rev+1，删 → 墓碑不在列表，运行时事实不算改动', () => {
  it('新建 rev=1、改声明 rev=2、删 rev=3', () => {
    const config = useMcpStore.getState().addConfig({ name: 'my-mcp' });
    expect(config.rev).toBe(1);
    expect(config.createdAt).toBe(config.updatedAt);

    useMcpStore.getState().updateConfig(config.id, { endpoint: 'http://127.0.0.1:9/mcp' });
    expect(useMcpStore.getState().configs.find((c) => c.id === config.id)?.rev).toBe(2);

    useMcpStore.getState().removeConfig(config.id);

    expect(useMcpStore.getState().configs.some((c) => c.id === config.id)).toBe(false);
    expect(useMcpStore.getState().tombstones[config.id]?.rev).toBe(3);
  });

  it('写入运行时事实（status / tools）不推进 rev', () => {
    const config = useMcpStore.getState().addConfig({ name: '探测结果不算改动' });
    const revAfterCreate = useMcpStore.getState().configs[0].rev;

    useMcpStore.getState().setStatus(config.id, 'connected');

    // 连接状态是本机探测结果，跨设备同步会得到「从未探测过却已连接」的假状态。
    // 若它推进 rev，LWW 就会把「谁真的改了配置」淹没在探测噪声里
    const stored = useMcpStore.getState().configs.find((c) => c.id === config.id);
    expect(stored?.status).toBe('connected');
    expect(stored?.rev).toBe(revAfterCreate);
  });
});

describe('channelsStore：改 → rev+1，删 → 墓碑（按 kind 键控）', () => {
  const liveChannel = (kind: ChannelConfig['kind']) =>
    useChannelsStore.getState().configs.find((c) => c.kind === kind);

  it('新建 rev=1、启停 rev=2、删 rev=3，墓碑键是 kind', () => {
    const config = useChannelsStore.getState().saveConfig({ kind: 'dingtalk' });
    expect(config.rev).toBe(1);

    useChannelsStore.getState().setEnabled('dingtalk', false);
    expect(liveChannel('dingtalk')?.rev).toBe(2);

    useChannelsStore.getState().removeConfig('dingtalk');

    expect(liveChannel('dingtalk')).toBeUndefined();
    // 键必须是 kind：渠道的 id 是本地随机数，且回读每次重新生成，
    // 按 id 键控的墓碑在回读侧永远匹配不上（见下一条用例）
    expect(Object.keys(useChannelsStore.getState().tombstones)).toEqual(['dingtalk']);
    expect(useChannelsStore.getState().tombstones.dingtalk.rev).toBe(3);
  });

  it('引擎回读不能把删掉的渠道搬回来（墓碑按 kind 命中）', async () => {
    useChannelsStore.getState().saveConfig({ kind: 'weixin', enabled: true });
    useChannelsStore.getState().removeConfig('weixin');

    // 引擎侧还留着这个渠道（上一次同步失败、或引擎自行写入），且回读会重新 genId()
    runtimeStub.channels = [
      {
        id: 'read-back-1',
        kind: 'weixin',
        enabled: true,
        allowFrom: ['*'],
        syncStatus: 'synced',
      } satisfies ChannelConfig,
    ];

    const added = await useChannelsStore.getState().hydrateFromNanobot();

    expect(added).toBe(false);
    expect(liveChannel('weixin')).toBeUndefined();
  });

  it('重新配置同 kind 会清掉旧墓碑（否则同步会把它按已删除推出去）', () => {
    useChannelsStore.getState().saveConfig({ kind: 'wecom' });
    useChannelsStore.getState().removeConfig('wecom');
    expect(useChannelsStore.getState().tombstones.wecom).toBeTruthy();

    const rebuilt = useChannelsStore.getState().saveConfig({ kind: 'wecom' });

    expect(useChannelsStore.getState().tombstones.wecom).toBeUndefined();
    expect(rebuilt.rev).toBe(1);
    expect(liveChannel('wecom')).toBeTruthy();
  });
});

describe('skillsStore：覆盖表是用户意图的唯一来源', () => {
  const seedBuiltins = () =>
    useSkillsStore.setState({
      skills: SKILLS.map((s) => ({ ...s, override: 'on', enabled: true })),
      overrides: [],
      pinnedIds: [],
      loaded: false,
      syncError: null,
    });

  const entryOf = (id: string): SkillOverrideEntry | undefined =>
    useSkillsStore.getState().overrides.find((e) => e.skillId === id);

  beforeEach(() => {
    seedBuiltins();
    vi.spyOn(platform, 'syncNanobotSkills').mockResolvedValue({ ok: true, message: '' });
  });

  it('改档 → rev+1，视图的 override 跟着表走', () => {
    const id = SKILLS[0].id;

    useSkillsStore.getState().setSkillOverride(id, 'off');
    expect(entryOf(id)?.rev).toBe(1);
    expect(entryOf(id)?.updatedAt).not.toBe('');
    expect(useSkillsStore.getState().skills.find((s) => s.id === id)?.override).toBe('off');

    useSkillsStore.getState().setSkillOverride(id, 'user-invocable-only');
    expect(entryOf(id)?.rev).toBe(2);
    expect(useSkillsStore.getState().skills.find((s) => s.id === id)?.override).toBe(
      'user-invocable-only',
    );
  });

  it('置顶也走覆盖表（换一次 rev+1），但不改覆盖档、不推引擎', () => {
    const id = SKILLS[1].id;
    useSkillsStore.getState().setSkillOverride(id, 'user-invocable-only');

    const callsBefore = vi.mocked(platform.syncNanobotSkills).mock.calls.length;
    useSkillsStore.getState().toggleSkillPin(id);

    expect(entryOf(id)?.pinned).toBe(true);
    expect(entryOf(id)?.rev).toBe(2);
    // 置顶不是「打开技能」：档位必须原样保留，否则用户点一下排序就被顺手开了
    expect(entryOf(id)?.override).toBe('user-invocable-only');
    expect(useSkillsStore.getState().pinnedIds).toEqual([id]);
    expect(vi.mocked(platform.syncNanobotSkills).mock.calls.length).toBe(callsBefore);

    useSkillsStore.getState().toggleSkillPin(id);
    expect(entryOf(id)?.pinned).toBe(false);
    expect(useSkillsStore.getState().pinnedIds).toEqual([]);
  });

  it('卸载用户级技能会连带清掉覆盖条目（不留指向不存在技能的僵尸）', () => {
    const mine: Skill = {
      id: 'mine',
      name: 'mine',
      description: '',
      category: 'Other',
      prompt: 'x',
      source: 'local',
      scope: 'user',
      override: 'off',
      enabled: false,
    };
    useSkillsStore.setState((s) => ({
      skills: [...s.skills, mine],
      overrides: [
        ...s.overrides,
        { skillId: 'mine', override: 'off', pinned: true, rev: 1, updatedAt: '', updatedBy: '', deletedAt: null },
      ],
      pinnedIds: ['mine'],
    }));

    useSkillsStore.getState().removeSkill('mine');

    expect(useSkillsStore.getState().overrides.some((e) => e.skillId === 'mine')).toBe(false);
    expect(useSkillsStore.getState().pinnedIds).toEqual([]);
  });

  it('重新安装把覆盖档拉回默认 on（否则刚装上就被上次的停用压回去）', () => {
    const mine: Skill = {
      id: 'mine',
      name: 'mine',
      description: '',
      category: 'Other',
      prompt: 'x',
      source: 'local',
      scope: 'user',
      override: 'off',
      enabled: false,
    };
    useSkillsStore.setState((s) => ({
      skills: [...s.skills, mine],
      overrides: [
        ...s.overrides,
        { skillId: 'mine', override: 'off', pinned: true, rev: 1, updatedAt: '', updatedBy: '', deletedAt: null },
      ],
      pinnedIds: ['mine'],
    }));

    useSkillsStore.getState().installSkill({ ...mine, override: 'on', enabled: true });

    expect(entryOf('mine')?.override).toBe('on');
    expect(entryOf('mine')?.rev).toBe(2);
    // 置顶是排序偏好，与安装无关，必须保留
    expect(entryOf('mine')?.pinned).toBe(true);
    expect(useSkillsStore.getState().skills.find((s) => s.id === 'mine')?.enabled).toBe(true);
  });
});

describe('skillsStore：v2 老数据迁移出覆盖表', () => {
  it('只抽有意图的条目（非默认档 / 已置顶），元数据按 rev=0 落盘', async () => {
    // 存储链路上有两层 JSON：适配器一层 + createJSONStorage 再一层
    window.localStorage.setItem(
      STORAGE_KEYS.skills,
      JSON.stringify(
        JSON.stringify({
          state: {
            skills: [
              { id: 'alpha', name: 'alpha', source: 'local', enabled: false },
              { id: 'beta', name: 'beta', source: 'local', enabled: true },
              { id: 'gamma', name: 'gamma', source: 'local', enabled: true },
            ],
            pinnedIds: ['gamma'],
          },
          version: 2,
        }),
      ),
    );

    await useSkillsStore.persist.rehydrate();

    const entries = useSkillsStore.getState().overrides;
    // beta 是默认档且未置顶 = 用户什么都没说过，不该在表里占位
    expect(entries.map((e) => e.skillId).sort()).toEqual(['alpha', 'gamma']);

    const alpha = entries.find((e) => e.skillId === 'alpha');
    expect(alpha?.override).toBe('off');
    // rev=0 是**保留值**：这批意图产生于 SyncMeta 之前，V1.5 据此识别历史遗留，
    // 若给它 rev=1 就会与真新建的条目撞车
    expect(alpha?.rev).toBe(0);
    expect(alpha?.updatedBy).toBe('');

    expect(entries.find((e) => e.skillId === 'gamma')?.pinned).toBe(true);
    expect(useSkillsStore.getState().pinnedIds).toEqual(['gamma']);
    // 视图照旧由表合成
    expect(useSkillsStore.getState().skills.find((s) => s.id === 'alpha')?.enabled).toBe(false);
  });
});
