import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectionManager, __setSleepForTest } from '@/ai/connectionManager';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';

function resetSettings() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      memoryEnabled: true,
      autoSummarize: false,
      transcription: DEFAULT_TRANSCRIPTION,
      desktop: DEFAULT_DESKTOP,
    },
    status: 'offline',
  });
}

describe('connectionManager: 直连选路与状态广播 (FR-006)', () => {
  afterEach(async () => {
    connectionManager.stopHeartbeat();
    __setSleepForTest((ms) => new Promise((r) => setTimeout(r, ms)));
    vi.useRealTimers();
    vi.restoreAllMocks();
    // 单例私有状态归零：把连接状态强制拉回 offline，避免用例间互相污染
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    await connectionManager.probe();
    vi.restoreAllMocks();
  });

  it('网关可达时返回引擎实现（nanobot-http），状态为 connected', async () => {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
    resetSettings();
    const client = await connectionManager.getClient();
    // D1 起 getClient() 返回的是契约层实现，kind 标识实现而非引擎族
    expect(client.kind).toBe('nanobot-http');
    expect(connectionManager.status).toBe('connected');
    expect(useSettingsStore.getState().status).toBe('connected');
  });

  it('网关不可达时状态 offline，仍返回引擎实现', async () => {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    resetSettings();
    const client = await connectionManager.getClient();
    expect(client.kind).toBe('nanobot-http');
    expect(connectionManager.status).toBe('offline');
    expect(useSettingsStore.getState().status).toBe('offline');
  });

  it('probe() 返回当前连接状态', async () => {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');
    resetSettings();
    const status = await connectionManager.probe();
    expect(status).toBe('connected');
    expect(connectionManager.status).toBe('connected');
  });

  it('onChange 订阅在 getClient 时被触发，且可移除', async () => {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    resetSettings();
    const cb = vi.fn();
    const unsub = connectionManager.onChange(cb);
    await connectionManager.getClient();
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    cb.mockClear();
    await connectionManager.getClient();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('connectionManager: 启动就绪等待（吸收 Python 冷启动空窗）', () => {
  afterEach(async () => {
    connectionManager.stopHeartbeat();
    __setSleepForTest((ms) => new Promise((r) => setTimeout(r, ms)));
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    await connectionManager.probe();
    vi.restoreAllMocks();
  });

  it('首探失败后重试到可达 → connected（回归：不再永久停留离线）', async () => {
    const probe = vi
      .spyOn(NanobotClient.prototype, 'probe')
      .mockResolvedValueOnce('offline')
      .mockResolvedValueOnce('offline')
      .mockResolvedValue('connected');
    // 压缩退避等待，避免测试真的睡几秒
    __setSleepForTest(async () => undefined);
    resetSettings();

    const status = await connectionManager.waitUntilReady(5000);

    expect(status).toBe('connected');
    expect(probe).toHaveBeenCalledTimes(3);
    expect(useSettingsStore.getState().status).toBe('connected');
  });

  it('始终不可达时在超时后返回 offline，不无限重试', async () => {
    const probe = vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    __setSleepForTest(async () => undefined);
    resetSettings();

    const status = await connectionManager.waitUntilReady(0);

    expect(status).toBe('offline');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('就绪等待期间状态变化才广播，避免稳态下无谓刷新', async () => {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    __setSleepForTest(async () => undefined);
    resetSettings();
    await connectionManager.probe(); // 先把内部状态推到 offline

    const cb = vi.fn();
    const unsub = connectionManager.onChange(cb);
    await connectionManager.waitUntilReady(0);
    expect(cb).not.toHaveBeenCalled(); // offline → offline，无变化

    unsub();
  });
});

describe('connectionManager: 稳态心跳（网关中途起停自愈）', () => {
  afterEach(async () => {
    connectionManager.stopHeartbeat();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    await connectionManager.probe();
    vi.restoreAllMocks();
  });

  it('网关中途就绪后心跳自动把状态切到 connected', async () => {
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    resetSettings();
    await connectionManager.probe(); // 初始 offline
    expect(useSettingsStore.getState().status).toBe('offline');

    vi.restoreAllMocks();
    vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('connected');

    vi.useFakeTimers();
    connectionManager.startHeartbeat(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(useSettingsStore.getState().status).toBe('connected');
    connectionManager.stopHeartbeat();
  });

  it('心跳幂等：重复 startHeartbeat 不叠加定时器', async () => {
    const probe = vi.spyOn(NanobotClient.prototype, 'probe').mockResolvedValue('offline');
    resetSettings();

    vi.useFakeTimers();
    connectionManager.startHeartbeat(1000);
    connectionManager.startHeartbeat(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(probe).toHaveBeenCalledTimes(1);
    connectionManager.stopHeartbeat();
  });

  it('并发探测去重：同时触发只发一次网络请求', async () => {
    let resolveProbe: (v: 'connected') => void = () => undefined;
    const probe = vi.spyOn(NanobotClient.prototype, 'probe').mockImplementation(
      () =>
        new Promise<'connected'>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    resetSettings();

    // 先并发发起两次（都不 await），确认 probe 只被调用一次后再放行
    const p1 = connectionManager.getClient();
    const p2 = connectionManager.getClient();
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe('connected');
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(b);
  });
});
