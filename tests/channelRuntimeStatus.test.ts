import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { platform } from '@/platform';
import { useChannelsStore } from '@/stores/channelsStore';
import type { ChannelRuntimeHealthReport } from '@/platform/types';

/**
 * FR-6.6 渠道实时健康：channelsStore 的 refreshHealth / 轮询 / 自动重连。
 *
 * 归一化（engine features → health 报告）由主进程 electron/main.ts 完成，
 * 这里以 mock platform.getChannelRuntimeStatus 返回「已归一的报告」来验证
 * store 的合并、网关可达性判定与 weixin 退避自动重连逻辑。
 */

function resetStore() {
  useChannelsStore.setState({
    configs: [],
    tombstones: {},
    lastSync: null,
    vaultAvailable: null,
    secretKeys: {},
    health: {},
    healthError: null,
    gatewayUp: null,
    lastHealthAt: null,
    reconnectAttempts: {},
  });
}

const originalEnv = platform.env;

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (platform as { env: 'electron' | 'web' }).env = originalEnv;
});

/** 构造一份带 feishu 多实例（feishu + lark）与 weixin 失败的归一化报告 */
function reportWith(
  overrides: Partial<ChannelRuntimeHealthReport> = {},
): ChannelRuntimeHealthReport {
  return {
    ok: true,
    gatewayUp: true,
    fetchedAt: '2026-10-06T00:00:00.000Z',
    health: {
      weixin: { kind: 'weixin', state: 'failed', running: false, error: 'token 失效' },
      feishu: { kind: 'feishu', state: 'running', running: true, error: null },
      lark: { kind: 'lark', state: 'running', running: true, error: null },
    },
    ...overrides,
  };
}

describe('channelsStore: refreshHealth 合并', () => {
  it('合并 health / gatewayUp / fetchedAt，并按 feishu 多实例拆出 feishu + lark', async () => {
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue(reportWith());
    await useChannelsStore.getState().refreshHealth();
    const s = useChannelsStore.getState();
    expect(s.gatewayUp).toBe(true);
    expect(s.lastHealthAt).toBe('2026-10-06T00:00:00.000Z');
    expect(s.health.weixin?.state).toBe('failed');
    expect(s.health.weixin?.error).toBe('token 失效');
    expect(s.health.feishu?.state).toBe('running');
    expect(s.health.lark?.state).toBe('running');
  });

  it('网关不可达 → gatewayUp=false 且健康置空', async () => {
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue({
      ok: false,
      gatewayUp: false,
      health: {},
      fetchedAt: '2026-10-06T00:00:00.000Z',
      error: '网关未运行',
    });
    await useChannelsStore.getState().refreshHealth();
    const s = useChannelsStore.getState();
    expect(s.gatewayUp).toBe(false);
    expect(s.healthError).toBe('网关未运行');
    expect(Object.keys(s.health)).toHaveLength(0);
  });

  it('web 端（返回 null）安全降级：gatewayUp 为 null 不抛异常', async () => {
    (platform as { env: 'electron' | 'web' }).env = 'web';
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue(null);
    await expect(useChannelsStore.getState().refreshHealth()).resolves.toBeUndefined();
    const s = useChannelsStore.getState();
    expect(s.gatewayUp).toBeNull();
  });

  it('查询抛异常 → gatewayUp=false + healthError', async () => {
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockRejectedValue(new Error('boom'));
    await useChannelsStore.getState().refreshHealth();
    const s = useChannelsStore.getState();
    expect(s.gatewayUp).toBe(false);
    expect(s.healthError).toBe('渠道健康查询失败');
  });
});

describe('channelsStore: weixin 退避自动重连', () => {
  it('已启用 weixin 失败 → 退避触发 syncAll（最多 3 次后停止）', async () => {
    (platform as { env: 'electron' | 'web' }).env = 'electron';
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue(
      reportWith({ health: { weixin: { kind: 'weixin', state: 'failed', running: false, error: 'x' } } }),
    );
    // weixin 已启用
    useChannelsStore.setState({
      configs: [{ id: 'w1', kind: 'weixin', enabled: true, allowFrom: ['*'], syncStatus: 'synced' }],
    });
    const sync = vi.spyOn(platform, 'syncNanobotChannels').mockResolvedValue({
      ok: true,
      message: 'ok',
      changed: true,
    });
    // 模拟每次 ~30s 轮询：每轮 refreshHealth 检测掉线并按退避安排一次重连
    await useChannelsStore.getState().refreshHealth();
    await vi.advanceTimersByTimeAsync(1000); // 第 1 次退避（1s）
    expect(sync).toHaveBeenCalledTimes(1);
    await useChannelsStore.getState().refreshHealth();
    await vi.advanceTimersByTimeAsync(2000); // 第 2 次退避（2s）
    expect(sync).toHaveBeenCalledTimes(2);
    await useChannelsStore.getState().refreshHealth();
    await vi.advanceTimersByTimeAsync(4000); // 第 3 次退避（4s）
    expect(sync).toHaveBeenCalledTimes(3);
    await useChannelsStore.getState().refreshHealth(); // 已达上限
    await vi.advanceTimersByTimeAsync(10000);
    expect(sync).toHaveBeenCalledTimes(3); // 超过上限不再触发
  });

  it('weixin 已恢复（running）→ 重置自动重连计数，不再触发 syncAll', async () => {
    (platform as { env: 'electron' | 'web' }).env = 'electron';
    // 首次：failed
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue(
      reportWith({ health: { weixin: { kind: 'weixin', state: 'failed', running: false, error: 'x' } } }),
    );
    useChannelsStore.setState({
      configs: [{ id: 'w1', kind: 'weixin', enabled: true, allowFrom: ['*'], syncStatus: 'synced' }],
    });
    const sync = vi.spyOn(platform, 'syncNanobotChannels').mockResolvedValue({ ok: true, message: 'ok', changed: true });
    await useChannelsStore.getState().refreshHealth();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(1);

    // 恢复为 running
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue(
      reportWith({ health: { weixin: { kind: 'weixin', state: 'running', running: true, error: null } } }),
    );
    await useChannelsStore.getState().refreshHealth();
    await vi.advanceTimersByTimeAsync(1000);
    // 仍是 1 次：running 不应再触发重连，且计数已重置（后续失败会重新从 1s 起算）
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('channelsStore: 手动重连', () => {
  it('reconnectChannel(weixin) 调用 syncAll 并重置计数', async () => {
    (platform as { env: 'electron' | 'web' }).env = 'electron';
    const sync = vi.spyOn(platform, 'syncNanobotChannels').mockResolvedValue({ ok: true, message: 'ok', changed: true });
    vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue(reportWith());
    await useChannelsStore.getState().reconnectChannel('weixin');
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('channelsStore: 轮询开关', () => {
  it('startHealthPolling 立即取一次；stopHealthPolling 清理定时器', async () => {
    const get = vi.spyOn(platform, 'getChannelRuntimeStatus').mockResolvedValue(reportWith());
    useChannelsStore.getState().startHealthPolling();
    expect(get).toHaveBeenCalledTimes(1);
    useChannelsStore.getState().stopHealthPolling();
    // 停止后即便再 advance 也不会再触发（定时器已清）
    await vi.advanceTimersByTimeAsync(35000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
