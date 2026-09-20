import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcpStore } from '@/stores/mcpStore';
import { platform } from '@/platform';
import { getRuntime } from '@/ai/runtime';
import { fromNanobotMCP, toNanobotEntry, toNanobotMCP } from '@/ai/runtime/nanobotHttp/config';
import type { MCPConfig } from '@/types';

/**
 * FR-3.2 客户端语义测试：工具级授权 + 真实连接测试 + 凭据不回传渲染层。
 *
 * 三条最容易悄悄失效、又最难自查的约定：
 * 1. `disabledTools` 必须以 **camelCase** 下发（引擎挂了 `alias_generator=to_camel`，
 *    写成 snake_case 会被当成未知字段静默忽略——界面显示已禁用、模型照旧在用）；
 * 2. 探测失败**不清空**已有工具清单（一次抖动不该把授权视图擦掉）；
 * 3. electron 上凭据既不落持久化、也不从引擎配置回灌渲染层。
 */

const cfg = (patch: Partial<MCPConfig> = {}): MCPConfig => ({
  id: 'u-1',
  name: 'user mcp',
  transport: 'url',
  endpoint: 'http://localhost:8080/mcp',
  status: 'idle',
  source: 'user',
  ...patch,
});

beforeEach(() => {
  useMcpStore.setState({ configs: [], vaultAvailable: null, secretKeys: {} });
});

// ——————————————————————————————————————————————
// 映射层
// ——————————————————————————————————————————————

describe('toNanobotEntry: 工具黑名单下发', () => {
  it('非空黑名单以 camelCase disabledTools 下发', () => {
    const entry = toNanobotEntry(cfg({ disabledTools: ['danger', 'other'] }));
    expect(entry.disabledTools).toEqual(['danger', 'other']);
    // 绝不能是 snake_case
    expect((entry as Record<string, unknown>).disabled_tools).toBeUndefined();
  });

  it('空数组不下发（引擎缺省即"不限制"，不下发噪音键）', () => {
    expect(toNanobotEntry(cfg({ disabledTools: [] })).disabledTools).toBeUndefined();
  });

  it('缺省不下发', () => {
    expect(toNanobotEntry(cfg()).disabledTools).toBeUndefined();
  });

  it('空白与非法条目被剔除，全空则不下发', () => {
    expect(
      toNanobotEntry(cfg({ disabledTools: ['  ', 'ok'] })).disabledTools,
    ).toEqual(['ok']);
    expect(
      toNanobotEntry(cfg({ disabledTools: ['', ' '] })).disabledTools,
    ).toBeUndefined();
  });

  it('stdio 与 url 两种传输都要带上黑名单', () => {
    expect(
      toNanobotEntry(cfg({ transport: 'command', command: 'npx x', disabledTools: ['t'] }))
        .disabledTools,
    ).toEqual(['t']);
  });

  it('toNanobotMCP 批量映射同样带上', () => {
    const dict = toNanobotMCP([cfg({ disabledTools: ['t'] })]);
    expect(dict['user mcp'].disabledTools).toEqual(['t']);
  });
});

describe('fromNanobotMCP: 工具黑名单回读', () => {
  it('camelCase disabledTools 回读为 disabledTools', () => {
    const out = fromNanobotMCP({
      srv: { type: 'streamableHttp', url: 'http://x/mcp', disabledTools: ['a', 'b'] },
    });
    expect(out[0].disabledTools).toEqual(['a', 'b']);
  });

  it('stdio 条目同样回读', () => {
    const out = fromNanobotMCP({
      srv: { type: 'stdio', command: 'npx', args: ['x'], disabledTools: ['a'] },
    });
    expect(out[0].disabledTools).toEqual(['a']);
  });

  it('缺失 / 非数组 / 空数组都不产出该字段', () => {
    expect(fromNanobotMCP({ s: { url: 'http://x', disabledTools: 'oops' } })[0].disabledTools)
      .toBeUndefined();
    expect(fromNanobotMCP({ s: { url: 'http://x', disabledTools: [] } })[0].disabledTools)
      .toBeUndefined();
  });
});

// ——————————————————————————————————————————————
// store：工具授权
// ——————————————————————————————————————————————

describe('setToolDisabled: 黑名单增删', () => {
  it('禁用后进入黑名单并保持有序', () => {
    useMcpStore.setState({ configs: [cfg()] });
    useMcpStore.getState().setToolDisabled('u-1', 'zeta', true);
    useMcpStore.getState().setToolDisabled('u-1', 'alpha', true);
    expect(useMcpStore.getState().configs[0].disabledTools).toEqual(['alpha', 'zeta']);
  });

  it('恢复允许后移出黑名单', () => {
    useMcpStore.setState({ configs: [cfg({ disabledTools: ['a', 'b'] })] });
    useMcpStore.getState().setToolDisabled('u-1', 'a', false);
    expect(useMcpStore.getState().configs[0].disabledTools).toEqual(['b']);
  });

  it('清空后收敛为 undefined（"无限制"只有一种表示）', () => {
    useMcpStore.setState({ configs: [cfg({ disabledTools: ['a'] })] });
    useMcpStore.getState().setToolDisabled('u-1', 'a', false);
    expect(useMcpStore.getState().configs[0].disabledTools).toBeUndefined();
  });

  it('重复禁用幂等', () => {
    useMcpStore.setState({ configs: [cfg()] });
    useMcpStore.getState().setToolDisabled('u-1', 'a', true);
    useMcpStore.getState().setToolDisabled('u-1', 'a', true);
    expect(useMcpStore.getState().configs[0].disabledTools).toEqual(['a']);
  });

  it('不影响其它条目', () => {
    useMcpStore.setState({ configs: [cfg(), cfg({ id: 'u-2', name: 'other' })] });
    useMcpStore.getState().setToolDisabled('u-1', 'a', true);
    expect(useMcpStore.getState().configs[1].disabledTools).toBeUndefined();
  });
});

// ——————————————————————————————————————————————
// store：真实连接测试
// ——————————————————————————————————————————————

describe('testConfig: 走真实探针', () => {
  it('请求里**不带密钥**，只带地址与名字（密钥由主进程查保险库）', async () => {
    const probe = vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [{ name: 'echo' }],
      latencyMs: 12,
    });

    useMcpStore.setState({
      configs: [cfg({ auth: { token: 'must-not-leak' } })],
    });
    await useMcpStore.getState().testConfig('u-1');

    const request = probe.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(request.name).toBe('user mcp');
    expect(request.endpoint).toBe('http://localhost:8080/mcp');
    expect(JSON.stringify(request)).not.toContain('must-not-leak');
    expect(request).not.toHaveProperty('secrets');
  });

  it('成功：状态置 connected，缓存工具清单与探测时间', async () => {
    vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [{ name: 'echo', description: 'e' }, { name: 'ping' }],
      latencyMs: 5,
    });

    useMcpStore.setState({ configs: [cfg()] });
    const result = await useMcpStore.getState().testConfig('u-1');

    expect(result.ok).toBe(true);
    const stored = useMcpStore.getState().configs[0];
    expect(stored.status).toBe('connected');
    expect(stored.tools?.map((t) => t.name)).toEqual(['echo', 'ping']);
    expect(typeof stored.lastProbedAt).toBe('number');
  });

  it('失败：状态置 error，但**保留**上次的工具清单', async () => {
    vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: false,
      status: 'error',
      tools: [],
      error: '连接超时',
      latencyMs: 8000,
    });

    useMcpStore.setState({
      configs: [cfg({ status: 'connected', tools: [{ name: 'echo' }], lastProbedAt: 111 })],
    });
    const result = await useMcpStore.getState().testConfig('u-1');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('连接超时');
    const stored = useMcpStore.getState().configs[0];
    expect(stored.status).toBe('error');
    expect(stored.tools?.map((t) => t.name)).toEqual(['echo']);
    expect(stored.lastProbedAt).toBe(111);
  });

  it('成功且实测出传输方式时回写 urlType（引擎按它挑 client）', async () => {
    vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [{ name: 'echo' }],
      transport: 'sse',
      latencyMs: 30,
    });

    useMcpStore.setState({ configs: [cfg()] });
    await useMcpStore.getState().testConfig('u-1');

    // 不写回的话：这里测试通过、引擎按 streamableHttp 去连 → 「聊天时连不上」
    expect(useMcpStore.getState().configs[0].urlType).toBe('sse');
  });

  it('探测未报传输方式时不动 urlType（不拿 undefined 覆盖已有值）', async () => {
    vi.spyOn(platform, 'probeMcpServer').mockResolvedValue({
      ok: true,
      status: 'connected',
      tools: [],
      latencyMs: 3,
    });

    useMcpStore.setState({ configs: [cfg({ urlType: 'sse' })] });
    await useMcpStore.getState().testConfig('u-1');

    expect(useMcpStore.getState().configs[0].urlType).toBe('sse');
  });

  it('条目不存在时返回失败而不是抛异常', async () => {
    const result = await useMcpStore.getState().testConfig('missing');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未找到');
  });
});

// ——————————————————————————————————————————————
// store：凭据（electron 写保险库 / web 明文）
// ——————————————————————————————————————————————

describe('saveSecrets: electron 写保险库', () => {
  let originalEnv: typeof platform.env;

  beforeEach(() => {
    originalEnv = platform.env;
    platform.env = 'electron';
    vi.spyOn(platform, 'secretsKeys').mockResolvedValue({});
    vi.spyOn(platform, 'secretsStatus').mockResolvedValue({ available: true, path: '/v' });
  });

  afterEach(() => {
    platform.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('写入成功：落 authKeyNames、清掉内存里的明文草稿', async () => {
    const set = vi.spyOn(platform, 'secretsSet').mockResolvedValue({ ok: true });
    useMcpStore.setState({ configs: [cfg()] });

    const result = await useMcpStore.getState().saveSecrets('u-1', { token: 'abc' });

    expect(result.ok).toBe(true);
    expect(set).toHaveBeenCalledWith('user mcp', { token: 'abc' });
    const stored = useMcpStore.getState().configs[0];
    expect(stored.authKeyNames).toEqual(['token']);
    expect(stored.auth).toBeUndefined();
  });

  it('写入失败：不更新 authKeyNames（否则界面显示已设置、实际保险库是空的）', async () => {
    vi.spyOn(platform, 'secretsSet').mockResolvedValue({
      ok: false,
      error: '没有可用的系统凭据库',
    });
    useMcpStore.setState({ configs: [cfg()] });

    const result = await useMcpStore.getState().saveSecrets('u-1', { token: 'abc' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('凭据库');
    expect(useMcpStore.getState().configs[0].authKeyNames).toBeUndefined();
  });

  it('清空凭据：key 名清单变空、同步刷新保险库视图', async () => {
    vi.spyOn(platform, 'secretsSet').mockResolvedValue({ ok: true });
    const refresh = vi.spyOn(platform, 'secretsKeys').mockResolvedValue({});
    useMcpStore.setState({ configs: [cfg({ authKeyNames: ['token'] })] });

    await useMcpStore.getState().saveSecrets('u-1', {});

    expect(useMcpStore.getState().configs[0].authKeyNames).toEqual([]);
    expect(refresh).toHaveBeenCalled();
  });
});

describe('saveSecrets: web 保持明文（浏览器无凭据库）', () => {
  it('不走 IPC，直接把凭据与 key 名写进配置', async () => {
    platform.env = 'web';
    const set = vi.spyOn(platform, 'secretsSet');
    useMcpStore.setState({ configs: [cfg()] });

    const result = await useMcpStore.getState().saveSecrets('u-1', { token: 'plain' });

    expect(result.ok).toBe(true);
    expect(set).not.toHaveBeenCalled();
    const stored = useMcpStore.getState().configs[0];
    expect(stored.auth).toEqual({ token: 'plain' });
    expect(stored.authKeyNames).toEqual(['token']);
  });
});

describe('refreshSecrets: 读保险库视图', () => {
  it('写回可用性与 key 名清单', async () => {
    vi.spyOn(platform, 'secretsStatus').mockResolvedValue({ available: false, path: '/v' });
    vi.spyOn(platform, 'secretsKeys').mockResolvedValue({ srv: ['token'] });

    await useMcpStore.getState().refreshSecrets();

    expect(useMcpStore.getState().vaultAvailable).toBe(false);
    expect(useMcpStore.getState().secretKeys).toEqual({ srv: ['token'] });
  });
});

// ——————————————————————————————————————————————
// store：回读与持久化不得夹带明文
// ——————————————————————————————————————————————

describe('hydrateFromNanobot: electron 端不回灌明文凭据', () => {
  let originalEnv: typeof platform.env;

  beforeEach(() => {
    originalEnv = platform.env;
    platform.env = 'electron';
  });

  afterEach(() => {
    platform.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('引擎配置里的明文被剔除，凭据改为按 key 名标注', async () => {
    vi.spyOn(getRuntime(), 'read').mockResolvedValue([
      cfg({
        id: 'remote',
        name: 'remote srv',
        auth: { token: 'engine-plaintext' },
      }),
    ]);
    useMcpStore.setState({ configs: [], secretKeys: { 'remote srv': ['token'] } });

    await useMcpStore.getState().hydrateFromNanobot();

    const added = useMcpStore.getState().configs.find((c) => c.name === 'remote srv');
    expect(added).toBeTruthy();
    expect(added?.auth).toBeUndefined();
    expect(added?.authKeyNames).toEqual(['token']);
  });
});

describe('partialize: electron 端凭据不落盘', () => {
  it('持久化结果里不含 auth 明文', () => {
    platform.env = 'electron';
    const options = useMcpStore.persist.getOptions();
    const partialize = options.partialize as (
      state: ReturnType<typeof useMcpStore.getState>,
    ) => { configs: MCPConfig[] };

    const out = partialize({
      ...useMcpStore.getState(),
      configs: [cfg({ auth: { token: 'must-not-persist' } })],
    });

    expect(out.configs[0].auth).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('must-not-persist');
  });

  it('web 端保留（浏览器没有系统凭据库，界面会标注未加密）', () => {
    platform.env = 'web';
    const options = useMcpStore.persist.getOptions();
    const partialize = options.partialize as (
      state: ReturnType<typeof useMcpStore.getState>,
    ) => { configs: MCPConfig[] };

    const out = partialize({
      ...useMcpStore.getState(),
      configs: [cfg({ auth: { token: 'plain' } })],
    });

    expect(out.configs[0].auth).toEqual({ token: 'plain' });
  });
});
