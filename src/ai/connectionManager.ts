import { useSettingsStore } from '@/stores/settingsStore';
import type { ConnectionStatus as Status } from '@/types';
import { NanobotClient } from './nanobotClient';
import type { AIClient } from './types';

type Listener = () => void;

/**
 * 启动就绪等待的默认上限。
 * 实测 `nanobot serve` 从 spawn 到端口 listen 约 9.4 秒
 * （Python 导入依赖 + 注册工具 + 连接 MCP），留约 3 倍余量。
 */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** 就绪等待的首次重试间隔与退避上限 */
const READY_RETRY_BASE_MS = 300;
const READY_RETRY_MAX_MS = 2000;

/** 稳态心跳间隔：网关中途重启 / 用户手动拉起后可自动恢复「已连接」 */
const DEFAULT_HEARTBEAT_MS = 8000;

/** 可替换的等待实现，便于测试压缩退避时间 */
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 连接管理器（FR-006）。
 * 始终直连 nanobot 网关：probe 可达为 connected，不可达为 offline
 * （发送时由 client 报错）。选择结果通过 onChange 广播，
 * 并同步写入 settingsStore.status（供 ConnectionBanner 读取）。
 *
 * 桌面端启动时序：主进程 spawn `nanobot serve` 与窗口创建是并行的，
 * Python 进程冷启动需要数秒才会真正 listen。若只在应用挂载时探测一次，
 * 首探必然 ECONNREFUSED 并被永久固化为「网关离线」，即使网关随后已就绪。
 * 因此这里提供两层兜底：
 * 1. `waitUntilReady()`：启动阶段带退避重试，直到网关可达或超时；
 * 2. `startHeartbeat()`：稳态周期探测，网关中途起停都能自愈。
 */
class ConnectionManager {
  private nanobot = new NanobotClient();
  private listeners = new Set<Listener>();
  private _status: Status = 'offline';

  /** 进行中的探测（并发去重：同一时刻只发一次网络请求） */
  private inflightProbe: Promise<Status> | null = null;

  /** 稳态心跳定时器句柄 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  get status(): Status {
    return this._status;
  }

  /** 订阅连接状态变化，返回取消订阅函数 */
  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    useSettingsStore.getState().setStatus(this._status);
    this.listeners.forEach((l) => l());
  }

  /** 单次真实探测（并发去重），只返回结果、不写状态 */
  private probeOnce(): Promise<Status> {
    if (this.inflightProbe) return this.inflightProbe;
    this.inflightProbe = (async () => {
      try {
        const ok = await this.nanobot.probe();
        return ok === 'connected' ? 'connected' : 'offline';
      } finally {
        this.inflightProbe = null;
      }
    })();
    return this.inflightProbe;
  }

  /**
   * 探测并按需广播：状态发生变化才通知订阅者，
   * 避免心跳在稳态下反复触发无意义的 UI 刷新。
   */
  private async refreshQuiet(): Promise<Status> {
    const next = await this.probeOnce();
    if (this._status !== next) {
      this._status = next;
      this.emit();
    }
    return next;
  }

  /** 获取直连 AIClient（同时刷新 status 并广播） */
  async getClient(): Promise<AIClient> {
    const ok = await this.probeOnce();
    this._status = ok === 'connected' ? 'connected' : 'offline';
    this.emit();
    return this.nanobot;
  }

  /** 探测当前连接状态（触发一次 getClient） */
  async probe(): Promise<Status> {
    await this.getClient();
    return this._status;
  }

  /**
   * 启动阶段等待网关真正就绪（带退避重试）。
   * 用于应用挂载 / 用户手动点击「启动 Gateway」之后，
   * 吸收 Python 进程冷启动的数秒空窗，避免误报离线。
   * @param timeoutMs 等待上限，超时返回最后一次探测结果
   * @returns 最后一次探测得到的状态
   */
  async waitUntilReady(timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<Status> {
    const deadline = Date.now() + timeoutMs;
    let delay = READY_RETRY_BASE_MS;
    for (;;) {
      const status = await this.refreshQuiet();
      if (status === 'connected') return status;
      const remain = deadline - Date.now();
      if (remain <= 0) return status;
      await sleep(Math.min(delay, remain));
      delay = Math.min(Math.round(delay * 1.6), READY_RETRY_MAX_MS);
    }
  }

  /**
   * 启动稳态心跳：周期探测网关可达性，中途起停自动切换状态。
   * 幂等：重复调用不会叠加定时器。
   * @param intervalMs 探测间隔
   * @param options.immediate 是否立即探测一次（默认 false，由调用方自行首探）
   */
  startHeartbeat(
    intervalMs: number = DEFAULT_HEARTBEAT_MS,
    options: { immediate?: boolean } = {},
  ): void {
    if (this.heartbeatTimer !== null) return;
    if (options.immediate) void this.refreshQuiet();
    this.heartbeatTimer = setInterval(() => {
      void this.refreshQuiet();
    }, intervalMs);
  }

  /** 停止稳态心跳（应用卸载时调用） */
  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export const connectionManager = new ConnectionManager();

/** 仅供测试：替换退避等待实现（默认使用真实 setTimeout） */
export function __setSleepForTest(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}
