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
  status: 'idle',
  source: 'user',
  ...patch,
});

/** 构造一条最小 builtin 配置 */
const builtinCfg = (patch: Partial<MCPConfig> = {}): MCPConfig => ({
  id: 'builtin:demo',
  name: 'builtin mcp',
  transport: 'url',
  endpoint: 'http://localhost:9090/mcp',
  status: 'idle',
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
