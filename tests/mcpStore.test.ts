import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useMcpStore, selectEnabledConfigs } from '@/stores/mcpStore';
import { platform } from '@/platform';
import type { MCPConfig } from '@/types';

/**
 * mcpStore 启用状态语义测试：
 * builtin/user 统一为 `enabled !== false`（老数据 undefined 默认启用）。
 * 同步链路新语义：electron 端空 targets 也照常提交空字典（清空运行时）；
 * web 端空 targets 提前返回。测试中 mock platform.syncNanobotMcp
 *（参考 channelsStore 测试的 platform mock 方式）。
 */

/** 构造一条最小 user 配置 */
const userCfg = (patch: Partial<MCPConfig> = {}): MCPConfig => ({
  id: 'u-1',
  name: 'user mcp',
  transport: 'url',
  endpoint: 'http://localhost:8080/mcp',
  connectionStatus: 'unknown',
  syncStatus: 'idle',
  source: 'user',
  ...patch,
});

/** 构造一条最小 builtin 配置 */
const builtinCfg = (patch: Partial<MCPConfig> = {}): MCPConfig => ({
  id: 'builtin:demo',
  name: 'builtin mcp',
  transport: 'url',
  endpoint: 'http://localhost:9090/mcp',
  connectionStatus: 'unknown',
  syncStatus: 'idle',
  source: 'builtin',
  ...patch,
});

/** 重置 store 到空态，避免跨用例串扰 */
function resetStore() {
  useMcpStore.setState({ configs: [] });
}

beforeEach(() => {
  resetStore();
});

describe('selectEnabledConfigs: 启用过滤（builtin/user 统一语义）', () => {
  it('user 条目 enabled:false 被过滤', () => {
    const out = selectEnabledConfigs([userCfg({ enabled: false })]);
    expect(out).toHaveLength(0);
  });

  it('user 条目 enabled:undefined 默认启用（老数据向后兼容）', () => {
    const out = selectEnabledConfigs([userCfg({ enabled: undefined })]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('u-1');
  });

  it('builtin 条目 enabled:false 被过滤', () => {
    const out = selectEnabledConfigs([builtinCfg({ enabled: false })]);
    expect(out).toHaveLength(0);
  });

  it('builtin 条目 enabled:true 与 undefined 均保留', () => {
    const out = selectEnabledConfigs([
      builtinCfg({ id: 'builtin:a', enabled: true }),
      builtinCfg({ id: 'builtin:b', enabled: undefined }),
    ]);
    expect(out.map((c) => c.id)).toEqual(['builtin:a', 'builtin:b']);
  });
});

describe('toggleMcp: user 条目启停切换', () => {
  it('enabled:undefined 的 user 条目首次切换为 false', () => {
    useMcpStore.setState({ configs: [userCfg({ enabled: undefined })] });
    useMcpStore.getState().toggleMcp('u-1');
    expect(useMcpStore.getState().configs[0].enabled).toBe(false);
  });

  it('enabled:true 的 user 条目切换为 false，再切回 true', () => {
    useMcpStore.setState({ configs: [userCfg({ enabled: true })] });
    useMcpStore.getState().toggleMcp('u-1');
    expect(useMcpStore.getState().configs[0].enabled).toBe(false);
    useMcpStore.getState().toggleMcp('u-1');
    expect(useMcpStore.getState().configs[0].enabled).toBe(true);
  });

  it('切换后 selectEnabledConfigs 结果同步变化', () => {
    useMcpStore.setState({ configs: [userCfg({ enabled: true })] });
    useMcpStore.getState().toggleMcp('u-1');
    expect(selectEnabledConfigs(useMcpStore.getState().configs)).toHaveLength(0);
  });
});

describe('toggleMcp: builtin 条目启停切换（一致性补齐）', () => {
  it('enabled:false 的 builtin 条目切换为 true', () => {
    useMcpStore.setState({ configs: [builtinCfg({ enabled: false })] });
    useMcpStore.getState().toggleMcp('builtin:demo');
    expect(useMcpStore.getState().configs[0].enabled).toBe(true);
  });

  it('enabled:undefined 的 builtin 条目首次切换为 true，再切回 false', () => {
    // toggleMcp 对 builtin 的 undefined 回退默认值为 disabled（!isBuiltinMcpId → false），
    // 故首次切换为 true；与 selectEnabledConfigs 的 undefined 视为启用互为独立语义
    useMcpStore.setState({ configs: [builtinCfg({ enabled: undefined })] });
    useMcpStore.getState().toggleMcp('builtin:demo');
    expect(useMcpStore.getState().configs[0].enabled).toBe(true);
    useMcpStore.getState().toggleMcp('builtin:demo');
    expect(useMcpStore.getState().configs[0].enabled).toBe(false);
  });
});

describe('syncEnabled: electron 端空集照常提交（新语义）', () => {
  let originalEnv: typeof platform.env;

  beforeEach(() => {
    originalEnv = platform.env;
    // 测试环境默认无 electronAPI，env 为 'web'；此处强制按 electron 处理
    platform.env = 'electron';
    vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      changed: true,
      message: '已合并写入 config.json',
    });
  });

  afterEach(() => {
    platform.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('停用最后一个启用条目后 syncEnabled 提交空字典 {}', async () => {
    useMcpStore.setState({ configs: [userCfg({ enabled: true })] });
    useMcpStore.getState().toggleMcp('u-1'); // → enabled:false，空 targets

    const result = await useMcpStore.getState().syncEnabled();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('已清空');
    const sync = vi.mocked(platform.syncNanobotMcp);
    expect(sync).toHaveBeenCalledTimes(1);
    // 入参为 toNanobotMCP([]) 序列化后的空字典，主进程全量替换即清空 tools.mcpServers
    expect(JSON.parse(sync.mock.calls[0][0])).toEqual({});
  });

  it('删除最后一条启用条目后 removeConfig 触发的同步提交空字典', async () => {
    useMcpStore.setState({ configs: [userCfg({ enabled: true })] });
    useMcpStore.getState().removeConfig('u-1');
    // removeConfig 内部 void syncEnabled()（后台非阻塞），等待微任务排空
    await new Promise((r) => setTimeout(r, 0));

    const sync = vi.mocked(platform.syncNanobotMcp);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sync.mock.calls[0][0])).toEqual({});
  });

  it('仍有启用条目时提交非空字典（含停用条目被过滤）', async () => {
    useMcpStore.setState({
      configs: [userCfg({ enabled: true }), userCfg({ id: 'u-2', name: 'off mcp', enabled: false })],
    });

    await useMcpStore.getState().syncEnabled();

    const sync = vi.mocked(platform.syncNanobotMcp);
    expect(sync).toHaveBeenCalledTimes(1);
    const dict = JSON.parse(sync.mock.calls[0][0]) as Record<string, unknown>;
    expect(Object.keys(dict)).toEqual(['user mcp']);
  });
});

describe('syncEnabled: web 端空集提前返回', () => {
  // 测试环境无 electronAPI，platform.env 默认即 'web'，可直接验证
  beforeEach(() => {
    platform.env = 'web';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('空 targets 直接返回、不调用 platform.syncNanobotMcp', async () => {
    const sync = vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      message: 'stub',
    });
    useMcpStore.setState({ configs: [userCfg({ enabled: false })] });

    const result = await useMcpStore.getState().syncEnabled();

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.message).toContain('无需同步');
    expect(sync).not.toHaveBeenCalled();
  });
});

/**
 * 回归：`connectionStatus` 与 `syncStatus` **各管一件事，互不污染**。
 *
 * 拆字段之前两者共用同一个 `status`，于是同步动作能覆盖连接事实，界面自相矛盾
 * （截图实拍）：
 *   - 开关显示「停用」而徽章写「已连接」（停用不清状态）；
 *   - 连接测试失败后点一下同步，徽章又变成「已连接」（同步成功写成 connected）。
 *
 * 现在的不变量：
 *   - `connectionStatus` 只由 `testConfig` 的真实握手与「停用即失连」的清理写入；
 *   - `syncStatus` 只由 `syncConfig` / `syncEnabled` 写入，**永不**触碰连接状态；
 *   - 落盘时 `connectionStatus` 归零（运行时事实会过期），`syncStatus` 保留
 *     （已发生的事实），但 `syncing` 瞬态收敛为 `idle`。
 */
describe('connectionStatus 与 syncStatus 互不污染（回归）', () => {
  let originalEnv: typeof platform.env;

  beforeEach(() => {
    originalEnv = platform.env;
    platform.env = 'electron';
    vi.spyOn(platform, 'syncNanobotMcp').mockResolvedValue({
      ok: true,
      changed: true,
      message: '已合并写入 config.json',
    });
  });

  afterEach(() => {
    platform.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('停用条目时清掉遗留的连接状态（开关与徽章不再互相矛盾）', () => {
    useMcpStore.setState({
      configs: [userCfg({ enabled: true, connectionStatus: 'connected' })],
    });

    useMcpStore.getState().toggleMcp('u-1');

    const after = useMcpStore.getState().configs[0];
    expect(after.enabled).toBe(false);
    expect(after.connectionStatus).toBe('unknown');
  });

  it('setMcpEnabled(false) 同样清掉连接状态', () => {
    useMcpStore.setState({
      configs: [userCfg({ enabled: true, connectionStatus: 'connected' })],
    });

    useMcpStore.getState().setMcpEnabled('u-1', false);

    expect(useMcpStore.getState().configs[0].connectionStatus).toBe('unknown');
  });

  it('重新启用不回填旧状态：连接事实必须靠再测一次', () => {
    useMcpStore.setState({
      configs: [userCfg({ enabled: false, connectionStatus: 'unknown' })],
    });

    useMcpStore.getState().toggleMcp('u-1');

    const after = useMcpStore.getState().configs[0];
    expect(after.enabled).toBe(true);
    expect(after.connectionStatus).toBe('unknown');
  });

  it('syncEnabled 只动同步状态，绝不碰连接状态', async () => {
    // 模拟一次真实握手失败之后的状态
    useMcpStore.setState({
      configs: [userCfg({ enabled: true, connectionStatus: 'error' })],
    });

    await useMcpStore.getState().syncEnabled();

    const after = useMcpStore.getState().configs[0];
    expect(after.syncStatus).toBe('synced');
    expect(typeof after.lastSyncedAt).toBe('number');
    // ★ 核心断言：同步成功只说明配置写进了引擎，不代表连上了 ——
    //   连接状态必须原封不动（仍是那次失败的 error），这正是拆字段要保住的东西
    expect(after.connectionStatus).toBe('error');
  });

  it('syncConfig 同样只动同步状态', async () => {
    useMcpStore.setState({
      configs: [userCfg({ enabled: true, connectionStatus: 'error' })],
    });

    await useMcpStore.getState().syncConfig('u-1');

    const after = useMcpStore.getState().configs[0];
    expect(after.syncStatus).toBe('synced');
    expect(after.connectionStatus).toBe('error');
  });

  it('同步失败只标 syncStatus=error，同样不污染连接状态', async () => {
    vi.mocked(platform.syncNanobotMcp).mockRejectedValueOnce(new Error('写盘失败'));
    useMcpStore.setState({
      configs: [userCfg({ enabled: true, connectionStatus: 'connected' })],
    });

    await useMcpStore.getState().syncEnabled();

    const after = useMcpStore.getState().configs[0];
    expect(after.syncStatus).toBe('error');
    expect(after.connectionStatus).toBe('connected');
  });

  it('落盘把 connectionStatus 归零，而 syncStatus 这类「已发生的事实」保留', () => {
    const partialize = useMcpStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf('function');

    const out = partialize!({
      configs: [
        userCfg({ connectionStatus: 'connected', syncStatus: 'synced', lastSyncedAt: 999 }),
      ],
      tombstones: {},
    } as never) as { configs: MCPConfig[] };

    expect(out.configs[0].connectionStatus).toBe('unknown');
    expect(out.configs[0].syncStatus).toBe('synced');
    expect(out.configs[0].lastSyncedAt).toBe(999);
  });

  it('落盘把 syncing 瞬态收敛为 idle（应用被杀不会永久卡在「同步中」）', () => {
    const partialize = useMcpStore.persist.getOptions().partialize!;

    const out = partialize({
      configs: [userCfg({ syncStatus: 'syncing' })],
      tombstones: {},
    } as never) as { configs: MCPConfig[] };

    expect(out.configs[0].syncStatus).toBe('idle');
  });

  it('落盘仍保留 tools / lastProbedAt（工具授权视图依赖，不能一起剔掉）', () => {
    const partialize = useMcpStore.persist.getOptions().partialize!;

    const out = partialize({
      configs: [userCfg({ connectionStatus: 'connected', tools: [], lastProbedAt: 123 })],
      tombstones: {},
    } as never) as { configs: MCPConfig[] };

    expect(out.configs[0].tools).toEqual([]);
    expect(out.configs[0].lastProbedAt).toBe(123);
  });

  it('v1 → v2 迁移：老的单一 status 被丢弃，两个新字段各自重置', () => {
    const migrate = useMcpStore.persist.getOptions().migrate;
    expect(migrate).toBeTypeOf('function');

    // v1 的存量形态：只有一个混装两种语义的 status
    const out = migrate!(
      {
        configs: [{ id: 'u-1', name: '旧数据', transport: 'url', status: 'connected' }],
        tombstones: {},
      },
      1,
    ) as { configs: MCPConfig[] };

    // 不映射是刻意的：无法区分这条 connected 是「连上了」还是「刚同步完」
    expect(out.configs[0].connectionStatus).toBe('unknown');
    expect(out.configs[0].syncStatus).toBe('idle');
    expect((out.configs[0] as unknown as Record<string, unknown>).status).toBeUndefined();
  });
});
