/**
 * IM 渠道扫码接入：纯状态机 + 编排控制器 + React hook。
 *
 * 分层：
 * - `nextScanState`：纯函数状态迁移（可单测），输入当前快照 + 事件 → 新快照；
 * - `ChannelScanController`：编排层（链式 setTimeout 轮询、指数退避、
 *   硬超时、远端 cancel），只调用 **runtime 的 `channelConnect`**；
 * - `useChannelScan(kind)`：React hook，薄包装控制器（订阅快照 + 卸载清理）。
 *
 * 协议细节不在这里：载荷字段与起始参数都是引擎 wire（`session_id` / `qr_url` …），
 * 只允许出现在 `src/ai/runtime/nanobotHttp/channelConnect.ts`（ADR-020）。本模块
 * 消费的是它解码后的 camelCase 领域类型，因此改引擎协议只需要改那一处。
 *
 * 轮询策略：
 * - 链式 `setTimeout`（禁止 setInterval），间隔取响应 `intervalMs`（兜底 2000）；
 * - 连续传输错误（ok:false）指数退避 2s → 4s → 8s，上限 10s；
 *   累计达 `MAX_TRANSPORT_ERRORS` 次转 `failed`；
 * - 按 `expiresAtMs` 硬超时转 `expired`；
 * - `challenge:'verify_code'`（微信）时停止自动轮询，等待用户提交验证码。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { channelConnect } from '@/ai/runtime';
import type { ChannelConnectResult } from '@/ai/runtime';
import { getChannelMeta } from '@/lib/channel/channelMeta';
import type { ChannelKind } from '@/types';

/** 扫码接入状态机 */
export type ChannelScanState =
  | 'idle'
  | 'starting'
  | 'pending'
  | 'challenge'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** 扫码流程对外快照（UI 可消费的全部字段） */
export interface ScanSnapshot {
  state: ChannelScanState;
  /** 最新二维码内容（微信会自动换码，每次 pending 响应覆盖） */
  qrUrl?: string;
  /** 服务端附加提示（pending 时展示） */
  message?: string;
  /** 错误提示（failed / expired / 验证码不匹配） */
  error?: string;
  sessionId?: string;
  expiresAtMs?: number;
}

/** 驱动状态迁移的事件 */
export type ScanEvent =
  | { type: 'start'; payload: ChannelConnectResult }
  | { type: 'poll'; payload: ChannelConnectResult }
  | { type: 'transportError'; error: string; consecutiveErrors: number }
  | { type: 'hardTimeout' }
  | { type: 'cancel' };

/** 默认轮询间隔（毫秒；响应未给出 intervalMs 时兜底） */
export const DEFAULT_POLL_INTERVAL_MS = 2000;
/** 传输错误退避基数（毫秒） */
export const ERROR_BACKOFF_BASE_MS = 2000;
/** 传输错误退避上限（毫秒） */
export const ERROR_BACKOFF_MAX_MS = 10000;
/** 连续传输错误阈值：达到即放弃并转 failed */
export const MAX_TRANSPORT_ERRORS = 5;

/** 初始快照 */
export function createInitialSnapshot(): ScanSnapshot {
  return { state: 'idle' };
}

/**
 * 纯状态迁移函数：由当前快照 + 事件推导新快照。
 * 不触碰任何副作用（定时器 / 网络），便于单测覆盖全迁移。
 */
export function nextScanState(snap: ScanSnapshot, event: ScanEvent): ScanSnapshot {
  switch (event.type) {
    case 'start':
    case 'poll': {
      const p = event.payload;
      // 验证码校验失败：停留在 challenge，等待重新输入
      if (p.verificationFailed) {
        return {
          ...snap,
          state: 'challenge',
          error: '验证码不匹配，请核对后重新输入',
          qrUrl: p.qrUrl ?? snap.qrUrl,
          message: p.message ?? snap.message,
          expiresAtMs: p.expiresAtMs ?? snap.expiresAtMs,
        };
      }
      switch (p.status) {
        case 'succeeded':
          // 微信已连接过：start 直接返回 succeeded（无 sessionId）
          return {
            ...snap,
            state: 'succeeded',
            sessionId: p.sessionId ?? snap.sessionId,
            message: p.message ?? snap.message,
            error: undefined,
          };
        case 'failed':
          return {
            ...snap,
            state: 'failed',
            error: p.message ?? '连接失败，请刷新二维码重试',
            sessionId: p.sessionId ?? snap.sessionId,
          };
        case 'expired':
          return {
            ...snap,
            state: 'expired',
            error: p.message ?? '二维码已过期，请刷新后重试',
            sessionId: p.sessionId ?? snap.sessionId,
          };
        case 'cancelled':
          return { ...snap, state: 'cancelled' };
        case 'pending': {
          const base = {
            ...snap,
            // 每次 pending 响应以最新 qrUrl 更新（微信自动换码）
            qrUrl: p.qrUrl ?? snap.qrUrl,
            sessionId: p.sessionId ?? snap.sessionId,
            expiresAtMs: p.expiresAtMs ?? snap.expiresAtMs,
            message: p.message ?? snap.message,
            error: undefined,
          };
          if (p.challenge === 'verify_code') {
            return { ...base, state: 'challenge' };
          }
          return { ...base, state: 'pending' };
        }
        // 引擎没给状态 / 给了不认识的值：什么都不做（不猜）
        default:
          return snap;
      }
    }
    case 'transportError':
      if (event.consecutiveErrors >= MAX_TRANSPORT_ERRORS) {
        return {
          ...snap,
          state: 'failed',
          error: `连接服务暂不可用：${event.error}`,
        };
      }
      // 未达阈值：保持现状，由编排层按退避间隔继续轮询
      return snap;
    case 'hardTimeout':
      return { ...snap, state: 'expired', error: '二维码已过期，请刷新后重试' };
    case 'cancel':
      return { ...snap, state: 'cancelled' };
    default:
      return snap;
  }
}

/**
 * 扫码接入编排控制器（非 React，可直接在测试中驱动）。
 * 生命周期：start → 链式轮询 → 终态（或 challenge 等待用户输入）；
 * cancel / dispose 清定时器并尽力通知远端取消（fire-and-forget）。
 *
 * 只持有 `kind` 与 `engineChannel`：起始参数是协议细节，由 runtime 层按 `kind`
 * 解析（飞书与 Lark 共用引擎渠道 `feishu`，但参数不同——放在这里必然写错一份）。
 */
export class ChannelScanController {
  readonly kind: ChannelKind;
  private readonly engineChannel: string;

  private snapshot: ScanSnapshot = createInitialSnapshot();
  private listeners = new Set<() => void>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId?: string;
  private consecutiveErrors = 0;
  /** 递增的运行代次：作废过期的异步响应（重启 / 取消后旧响应一律忽略） */
  private runId = 0;

  constructor(kind: ChannelKind) {
    this.kind = kind;
    this.engineChannel = getChannelMeta(kind).scanConnect?.engineChannel ?? kind;
  }

  getSnapshot = (): ScanSnapshot => this.snapshot;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(next: ScanSnapshot): void {
    if (next === this.snapshot) return;
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * 发起扫码会话。
   * @param opts.force 微信失败后重登场景携带（透传网关 force 参数）
   */
  start = (opts?: { force?: boolean }): void => {
    if (!getChannelMeta(this.kind).scanConnect) {
      this.set({ state: 'failed', error: '该渠道不支持扫码接入' });
      return;
    }
    this.clearTimers();
    this.runId += 1;
    const runId = this.runId;
    this.consecutiveErrors = 0;
    this.sessionId = undefined;
    this.set({ state: 'starting' });

    void channelConnect({
      action: 'start',
      kind: this.kind,
      engineChannel: this.engineChannel,
      force: opts?.force,
    }).then((res) => {
      if (runId !== this.runId) return;
      if (!res.ok) {
        this.set({ state: 'failed', error: res.error });
        return;
      }
      const payload = res.result;
      if (payload.sessionId) this.sessionId = payload.sessionId;
      const next = nextScanState(this.snapshot, { type: 'start', payload });
      this.set(next);
      // 微信已连接过：start 直接 succeeded，无需轮询
      if (next.state === 'pending') {
        this.scheduleNext(payload.intervalMs, payload.expiresAtMs);
      }
    });
  };

  /** 重新发起（刷新二维码；与 start 同语义） */
  restart = (opts?: { force?: boolean }): void => this.start(opts);

  /**
   * 提交验证码（微信 challenge 场景）：
   * 带 {sessionId, verifyCode} 发起一次 poll，由响应决定后续走向。
   */
  submitVerifyCode = (code: string): void => {
    const trimmed = code.trim();
    if (!trimmed || this.snapshot.state !== 'challenge') return;
    // 在途保护：作废当前在途的另一路响应（如退避中的旧 poll），
    // 防止并发迟到响应翻回状态覆盖本次提交结果（与 cancel 对齐）
    this.runId += 1;
    void this.doPoll(trimmed);
  };

  /**
   * 取消：清定时器 + 作废在途响应；若存在会话则尽力通知远端取消
   * （fire-and-forget，不阻塞、不抛错）。成功态的会话已被消费，不再取消。
   */
  cancel = (): void => {
    this.clearTimers();
    this.runId += 1;
    const sid = this.sessionId;
    const cancellable =
      !!sid && this.snapshot.state !== 'succeeded' && this.snapshot.state !== 'cancelled';
    if (this.snapshot.state !== 'cancelled') {
      this.set(nextScanState(this.snapshot, { type: 'cancel' }));
    }
    if (cancellable && sid) {
      void channelConnect({
        action: 'cancel',
        kind: this.kind,
        engineChannel: this.engineChannel,
        sessionId: sid,
      }).catch(() => undefined);
    }
  };

  /** 卸载清理：与 cancel 同语义 */
  dispose = (): void => this.cancel();

  /** 链式调度下一次轮询 + 按 expiresAtMs 布防硬超时 */
  private scheduleNext(intervalMs?: number, expiresAtMs?: number): void {
    this.clearTimers();
    this.pollTimer = setTimeout(
      () => void this.doPoll(),
      Math.max(intervalMs ?? DEFAULT_POLL_INTERVAL_MS, 100),
    );
    if (expiresAtMs && expiresAtMs > 0) {
      this.expiryTimer = setTimeout(() => {
        this.expiryTimer = null;
        if (this.snapshot.state === 'pending' || this.snapshot.state === 'challenge') {
          this.clearTimers();
          // 硬超时同样作废在途响应（与 cancel 对齐）：
          // 防止迟到响应把 expired 终态翻回其它状态（如刷新前的旧 poll 返回 succeeded）
          this.runId += 1;
          this.set(nextScanState(this.snapshot, { type: 'hardTimeout' }));
        }
      }, Math.max(expiresAtMs - Date.now(), 0));
    }
  }

  /** 执行一次 poll（`verifyCode` 仅在验证码场景传入） */
  private async doPoll(verifyCode?: string): Promise<void> {
    const runId = this.runId;

    let res: Awaited<ReturnType<typeof channelConnect>>;
    try {
      res = await channelConnect({
        action: 'poll',
        kind: this.kind,
        engineChannel: this.engineChannel,
        sessionId: this.sessionId,
        verifyCode,
      });
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (runId !== this.runId) return;

    if (!res.ok) {
      // 网络 / 传输错误：指数退避重试，累计超阈值转 failed
      this.consecutiveErrors += 1;
      const next = nextScanState(this.snapshot, {
        type: 'transportError',
        error: res.error,
        consecutiveErrors: this.consecutiveErrors,
      });
      this.set(next);
      if (next.state === 'failed') {
        this.clearTimers();
        return;
      }
      const backoff = Math.min(
        ERROR_BACKOFF_BASE_MS * 2 ** (this.consecutiveErrors - 1),
        ERROR_BACKOFF_MAX_MS,
      );
      this.pollTimer = setTimeout(() => void this.doPoll(), backoff);
      return;
    }

    this.consecutiveErrors = 0;
    const payload = res.result;
    if (payload.sessionId) this.sessionId = payload.sessionId;
    const next = nextScanState(this.snapshot, { type: 'poll', payload });
    this.set(next);

    if (next.state === 'pending') {
      this.scheduleNext(payload.intervalMs, payload.expiresAtMs ?? next.expiresAtMs);
    } else {
      // challenge：停止自动轮询，等待用户输入验证码；
      // 终态（succeeded / failed / expired / cancelled）：停止一切定时器
      this.clearTimers();
    }
  }
}

/** useChannelScan 返回值：快照字段 + 动作 */
export interface UseChannelScanResult extends ScanSnapshot {
  start: (opts?: { force?: boolean }) => void;
  cancel: () => void;
  submitVerifyCode: (code: string) => void;
  restart: (opts?: { force?: boolean }) => void;
}

/**
 * 扫码接入 hook：编排控制器 + 订阅快照。
 * 卸载时自动取消轮询并尽力通知远端（弹窗关闭 / 切模式均安全）。
 */
export function useChannelScan(kind: ChannelKind): UseChannelScanResult {
  const [controller, setController] = useState(() => new ChannelScanController(kind));

  // kind 变化时重建控制器（旧控制器经 dispose 取消会话）
  useEffect(() => {
    if (controller.kind !== kind) {
      controller.dispose();
      setController(new ChannelScanController(kind));
    }
  }, [kind, controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  return {
    ...snap,
    start: controller.start,
    cancel: controller.cancel,
    submitVerifyCode: controller.submitVerifyCode,
    restart: controller.restart,
  };
}
