import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyGatewayEndpointInfo, connectionManager, __setSleepForTest } from '@/ai/connectionManager';
import { NanobotClient } from '@/ai/runtime/nanobotHttp/chat';
import { useSettingsStore, DEFAULT_TRANSCRIPTION, DEFAULT_DESKTOP } from '@/stores/settingsStore';
import { DEFAULT_MEMORY_POLICY } from '@/types';

function resetSettings() {
  useSettingsStore.setState({
    settings: {
      gatewayEndpoint: 'http://127.0.0.1:8765/v1',
      apiToken: '',
      theme: 'dark',
      processDetail: 'key',
      memoryEnabled: true,
      autoSummarize: false,
      memoryRecall: true,
      memoryPolicy: { ...DEFAULT_MEMORY_POLICY },
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

    // 先并发发起两次（都不 await），确认 probe 只被调用一次后再放行。
    // probe 现在排在一次**异步的地址对齐**之后（心跳里先对齐再探），断言前需放过微任务队列；
    // 去重本身没变——`inflightProbe` 仍是同步置位的，第二次调用照样被折叠掉。
    const p1 = connectionManager.getClient();
    const p2 = connectionManager.getClient();
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe('connected');
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(b);
  });
});

/**
 * 地址对齐必须与「那条横幅显不显示」无关。
 *
 * 回归背景：本项目 AppLayout 里 `ConnectionBanner` 是注释掉的，地址对齐曾整条挂在这个
 * 可选组件上 —— 于是所有 REST 请求都打死出厂默认端口（模型列表空、Dream 面板
 * Failed to fetch），而界面上没有任何元素解释得了。现在对齐下沉到心跳，判据仍在这里。
 */
describe('applyGatewayEndpointInfo: 探测前把地址对齐到真实监听端口', () => {
  it('复用既有网关（running=false 但 port 有值）同样要对齐', () => {
    resetSettings();
    const changed = applyGatewayEndpointInfo({
      running: false, host: '127.0.0.1', port: 8900, preferredPort: 18900, fallback: true,
    });
    expect(changed).toBe(true);
    expect(useSettingsStore.getState().settings.gatewayEndpoint).toBe('http://127.0.0.1:8900/v1');
  });

  it('端口尚未解析出来时不动地址', () => {
    resetSettings();
    const changed = applyGatewayEndpointInfo({
      running: false, host: null, port: null, preferredPort: 18900, fallback: false,
    });
    expect(changed).toBe(false);
    expect(useSettingsStore.getState().settings.gatewayEndpoint).toBe('http://127.0.0.1:8765/v1');
  });

  it('用户填的是内网网关时不覆盖（那是他的配置，不是本机子进程）', () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, gatewayEndpoint: 'http://10.0.0.8:8900/v1' },
    });
    const changed = applyGatewayEndpointInfo({
      running: true, host: '127.0.0.1', port: 8900, preferredPort: 8900, fallback: false,
    });
    expect(changed).toBe(false);
    expect(useSettingsStore.getState().settings.gatewayEndpoint).toBe('http://10.0.0.8:8900/v1');
  });

  it('已对齐时返回 false，不产生无谓写入', () => {
    resetSettings();
    const changed = applyGatewayEndpointInfo({
      running: true, host: '127.0.0.1', port: 8765, preferredPort: 8765, fallback: false,
    });
    expect(changed).toBe(false);
    expect(useSettingsStore.getState().settings.gatewayEndpoint).toBe('http://127.0.0.1:8765/v1');
  });
});
