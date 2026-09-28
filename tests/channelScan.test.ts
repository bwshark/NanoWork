import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { platform } from '@/platform';
import {
  ChannelScanController,
  createInitialSnapshot,
  nextScanState,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_TRANSPORT_ERRORS,
} from '@/lib/channelScan';
import type { ScanEvent, ScanSnapshot } from '@/lib/channelScan';
import { decodeChannelConnect } from '@/ai/runtime';
import type { ChannelConnectResult } from '@/ai/runtime';
import type { ChannelConnectResponse } from '@/platform/types';

/**
 * 扫码接入：协议解码 + 状态机 + 编排控制器测试。
 *
 * 分三层，各管一段：
 * - `decodeChannelConnect`：wire 载荷 → 领域类型（协议层的唯一入口，容错是重点）；
 * - `nextScanState`：纯状态迁移（无副作用，直接断言快照）；
 * - `ChannelScanController`：编排（链式轮询、退避、硬超时、取消），假定时器 +
 *   mock `platform.channelConnect`。
 *
 * ⚠️ **控制器这一层刻意仍然写 snake_case 载荷**：测试在这里扮演的是**网关**，
 * 而 wire 字段名（`session_id` / `qr_url` …）正是网关发出来的东西。于是这组用例
 * 顺带证明了「解码 → 状态机 → 快照」整条链——把 wire 改成 camelCase 就什么都验不到了。
 * （CI 的 wire 泄漏检查只扫 `src/`，测试里保留 wire 形状是有意为之。）
 */

/** 构造网关的 ok 响应（**wire** 载荷，字段名以网关为准） */
function ok(result: Record<string, unknown>): ChannelConnectResponse {
  return { ok: true, result };
}

/** 构造失败响应 */
function err(error: string): ChannelConnectResponse {
  return { ok: false, error };
}

/** 纯函数层的输入是**解码后**的领域类型（camelCase） */
function decoded(over: ChannelConnectResult): ChannelConnectResult {
  return over;
}

describe('decodeChannelConnect: wire → 领域类型', () => {
  it('snake_case 载荷逐字段解码（网关当前发的就是这套键名）', () => {
    const r = decodeChannelConnect({
      session_id: 's1',
      status: 'pending',
      qr_url: 'https://qr',
      interval_ms: 3000,
      expires_at_ms: 123456,
      message: '请扫码',
      challenge: 'verify_code',
      verification_failed: false,
      instance_id: 'feishu',
      domain: 'feishu',
      app_id: 'cli_x',
      account: 'wx_1',
      requires_restart: true,
    });

    expect(r).toEqual({
      sessionId: 's1',
      status: 'pending',
      qrUrl: 'https://qr',
      intervalMs: 3000,
      expiresAtMs: 123456,
      message: '请扫码',
      challenge: 'verify_code',
      verificationFailed: false,
      instanceId: 'feishu',
      domain: 'feishu',
      appId: 'cli_x',
      account: 'wx_1',
      requiresRestart: true,
    });
  });

  it('camelCase 也认（引擎 pydantic 挂 to_camel，键名会漂移）', () => {
    const r = decodeChannelConnect({
      sessionId: 's2',
      status: 'succeeded',
      qrUrl: 'u',
      intervalMs: 1,
    });
    expect(r.sessionId).toBe('s2');
    expect(r.status).toBe('succeeded');
    expect(r.qrUrl).toBe('u');
    expect(r.intervalMs).toBe(1);
  });

  it('缺字段一律落 undefined —— 不猜默认值（缺 status 时状态机应当不动）', () => {
    const empty = decodeChannelConnect({});
    expect(Object.values(empty).every((v) => v === undefined)).toBe(true);
    // 非对象输入同样不抛错（网关回了 null / 字符串是常态）
    expect(decodeChannelConnect(null).status).toBeUndefined();
    expect(decodeChannelConnect('oops').status).toBeUndefined();
  });

  it('status 不在枚举内 → undefined（不把未知状态当 pending）', () => {
    expect(decodeChannelConnect({ status: 'who-knows' }).status).toBeUndefined();
    expect(decodeChannelConnect({ status: 'pending' }).status).toBe('pending');
  });

  it('类型不符的字段一律丢弃（`"3000"` 不当数字用、`"true"` 不当布尔用）', () => {
    const r = decodeChannelConnect({
      status: 'pending',
      interval_ms: '3000',
      expires_at_ms: Number.NaN,
      verification_failed: 'true',
    });
    expect(r.intervalMs).toBeUndefined();
    expect(r.expiresAtMs).toBeUndefined();
    expect(r.verificationFailed).toBeUndefined();
  });
});

describe('nextScanState: 纯状态迁移', () => {
  const base = createInitialSnapshot();
  const evt = (e: ScanEvent): ScanSnapshot => nextScanState(base, e);

  it('start 返回 pending → 进入 pending 并记录 qr/session/expiry', () => {
    const snap = evt({
      type: 'start',
      payload: decoded({
        status: 'pending',
        sessionId: 's1',
        qrUrl: 'https://qr',
        intervalMs: 3000,
        expiresAtMs: 123456,
        message: '请扫码',
      }),
    });
    expect(snap.state).toBe('pending');
    expect(snap.qrUrl).toBe('https://qr');
    expect(snap.sessionId).toBe('s1');
    expect(snap.expiresAtMs).toBe(123456);
    expect(snap.message).toBe('请扫码');
  });

  it('微信已连接：start 直接返回 succeeded（无 sessionId）→ 直接进成功态', () => {
    const snap = evt({ type: 'start', payload: decoded({ status: 'succeeded', account: 'wx_1' }) });
    expect(snap.state).toBe('succeeded');
    expect(snap.sessionId).toBeUndefined();
  });

  it('poll succeeded / failed / expired / cancelled 分别迁移到对应终态', () => {
    expect(evt({ type: 'poll', payload: decoded({ status: 'succeeded' }) }).state).toBe(
      'succeeded',
    );
    const failed = evt({
      type: 'poll',
      payload: decoded({ status: 'failed', message: '授权被拒绝' }),
    });
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('授权被拒绝');
    const expired = evt({ type: 'poll', payload: decoded({ status: 'expired' }) });
    expect(expired.state).toBe('expired');
    expect(expired.error).toContain('过期');
    expect(evt({ type: 'poll', payload: decoded({ status: 'cancelled' }) }).state).toBe(
      'cancelled',
    );
  });

  it('引擎没给状态（或给了不认识的）→ 状态不动（不猜）', () => {
    expect(evt({ type: 'poll', payload: decoded({}) }).state).toBe('idle');
  });

  it('poll 携带 challenge=verify_code → 进入 challenge', () => {
    const snap = evt({
      type: 'poll',
      payload: decoded({
        status: 'pending',
        challenge: 'verify_code',
        sessionId: 's1',
        message: '请输入验证码',
      }),
    });
    expect(snap.state).toBe('challenge');
  });

  it('verificationFailed → 停留 challenge 并提示验证码不匹配', () => {
    const pending: ScanSnapshot = { state: 'challenge', sessionId: 's1', qrUrl: 'u' };
    const snap = nextScanState(pending, {
      type: 'poll',
      payload: decoded({ status: 'pending', challenge: 'verify_code', verificationFailed: true }),
    });
    expect(snap.state).toBe('challenge');
    expect(snap.error).toContain('不匹配');
  });

  it('pending 响应以最新 qrUrl 覆盖（微信自动换码）', () => {
    const pending: ScanSnapshot = { state: 'pending', qrUrl: 'old', sessionId: 's1' };
    const snap = nextScanState(pending, {
      type: 'poll',
      payload: decoded({ status: 'pending', qrUrl: 'new' }),
    });
    expect(snap.state).toBe('pending');
    expect(snap.qrUrl).toBe('new');
    expect(snap.sessionId).toBe('s1');
  });

  it('传输错误未达阈值 → 状态不变；达到阈值 → failed', () => {
    const pending: ScanSnapshot = { state: 'pending', qrUrl: 'u', sessionId: 's1' };
    const below = nextScanState(pending, {
      type: 'transportError',
      error: 'net',
      consecutiveErrors: MAX_TRANSPORT_ERRORS - 1,
    });
    expect(below.state).toBe('pending');
    const hit = nextScanState(pending, {
      type: 'transportError',
      error: 'net',
      consecutiveErrors: MAX_TRANSPORT_ERRORS,
    });
    expect(hit.state).toBe('failed');
    expect(hit.error).toContain('net');
  });

  it('hardTimeout → expired；cancel → cancelled', () => {
    expect(evt({ type: 'hardTimeout' }).state).toBe('expired');
    expect(evt({ type: 'cancel' }).state).toBe('cancelled');
  });
});

describe('ChannelScanController: 编排（假定时器 + mock channelConnect）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start→pending→succeeded：按 interval_ms 链式轮询', async () => {
    const spy = vi.spyOn(platform, 'channelConnect').mockImplementation(async (action) => {
      if (action === 'start') {
        return ok({
          status: 'pending',
          session_id: 's1',
          qr_url: 'https://qr',
          interval_ms: 2000,
          expires_at_ms: Date.now() + 60_000,
        });
      }
      return ok({ status: 'succeeded' });
    });

    const c = new ChannelScanController('feishu');
    c.start();
    expect(c.getSnapshot().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().state).toBe('pending');
    expect(c.getSnapshot().qrUrl).toBe('https://qr');
    // start 的起始参数由**协议层**按 kind 解析（原在 channelMeta.startParams）
    expect(spy.mock.calls[0]).toEqual([
      'start',
      'feishu',
      { domain: 'feishu', instance_id: 'feishu', mode: 'replace' },
    ]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(c.getSnapshot().state).toBe('succeeded');
    // poll 携带 session_id；成功后不再轮询
    expect(spy.mock.calls[1]).toEqual(['poll', 'feishu', { session_id: 's1' }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('Lark 与飞书共用引擎渠道 feishu，但起始参数按 kind 区分（domain=lark）', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValue(ok({ status: 'succeeded' }));

    const c = new ChannelScanController('lark');
    c.start();
    await vi.advanceTimersByTimeAsync(0);

    // 这条就是「按引擎渠道名索引起始参数」会写错的地方：lark 也用 'feishu' 这个渠道名
    expect(spy.mock.calls[0]).toEqual([
      'start',
      'feishu',
      { domain: 'lark', instance_id: 'lark', mode: 'replace' },
    ]);
  });

  it('微信已连接：start 直接 succeeded，不再轮询', async () => {
    const spy = vi.spyOn(platform, 'channelConnect').mockResolvedValue(
      ok({ status: 'succeeded', account: 'wx_1' }),
    );
    const c = new ChannelScanController('weixin');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().state).toBe('succeeded');
    // weixin 没有起始参数（协议层只给 feishu / lark 定义）
    expect(spy.mock.calls[0]).toEqual(['start', 'weixin', {}]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('poll 返回 expired / failed → 进入对应终态并停止轮询', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 1000, expires_at_ms: Date.now() + 60_000 }),
      )
      .mockResolvedValue(ok({ status: 'expired', message: '码过期了' }));
    const c = new ChannelScanController('feishu');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot().state).toBe('expired');
    expect(c.getSnapshot().error).toBe('码过期了');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('challenge：停止自动轮询，等用户提交验证码后携带 verify_code poll', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 1000, expires_at_ms: Date.now() + 600_000 }),
      )
      .mockResolvedValueOnce(ok({ status: 'pending', challenge: 'verify_code', session_id: 's1', message: '请输入验证码' }))
      .mockResolvedValueOnce(ok({ status: 'succeeded' }));

    const c = new ChannelScanController('weixin');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot().state).toBe('challenge');

    // challenge 下不再自动轮询
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(2);

    // 空验证码不触发
    c.submitVerifyCode('   ');
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(2);

    c.submitVerifyCode('123456');
    await vi.advanceTimersByTimeAsync(0);
    expect(spy.mock.calls[2]).toEqual(['poll', 'weixin', { session_id: 's1', verify_code: '123456' }]);
    expect(c.getSnapshot().state).toBe('succeeded');
  });

  it('verification_failed → 停留 challenge 并提示不匹配', async () => {
    vi.spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 1000, expires_at_ms: Date.now() + 600_000 }))
      .mockResolvedValueOnce(ok({ status: 'pending', challenge: 'verify_code', session_id: 's1' }))
      .mockResolvedValueOnce(
        ok({ status: 'pending', challenge: 'verify_code', session_id: 's1', verification_failed: true }),
      );
    const c = new ChannelScanController('weixin');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot().state).toBe('challenge');
    c.submitVerifyCode('000000');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().state).toBe('challenge');
    expect(c.getSnapshot().error).toContain('不匹配');
  });

  it('连续传输错误指数退避 2s→4s→8s→10s，达到阈值转 failed', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 2000, expires_at_ms: Date.now() + 600_000 }),
      )
      .mockResolvedValue(err('network down'));

    const c = new ChannelScanController('feishu');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().state).toBe('pending');

    // 首次轮询在 2000ms；其后退避 2000 / 4000 / 8000 / 10000
    let t = 2000;
    for (let i = 1; i < MAX_TRANSPORT_ERRORS; i += 1) {
      await vi.advanceTimersByTimeAsync(t);
      expect(c.getSnapshot().state).toBe('pending');
      expect(spy.mock.calls.filter((x) => x[0] === 'poll')).toHaveLength(i);
      t = Math.min(2000 * 2 ** (i - 1), 10_000);
    }
    await vi.advanceTimersByTimeAsync(t);
    expect(c.getSnapshot().state).toBe('failed');
    expect(c.getSnapshot().error).toContain('network down');
    expect(spy.mock.calls.filter((x) => x[0] === 'poll')).toHaveLength(MAX_TRANSPORT_ERRORS);

    // failed 后不再轮询
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.mock.calls.filter((x) => x[0] === 'poll')).toHaveLength(MAX_TRANSPORT_ERRORS);
  });

  it('成功响应重置退避计数（恢复默认间隔）', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 1000, expires_at_ms: Date.now() + 600_000 }),
      )
      .mockResolvedValueOnce(err('net')) // 错误 1 次 → 退避 2000
      .mockResolvedValueOnce(ok({ status: 'pending', session_id: 's1', qr_url: 'u2', interval_ms: 1000 }))
      .mockResolvedValue(ok({ status: 'succeeded' }));

    const c = new ChannelScanController('feishu');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); // poll#1 失败
    expect(c.getSnapshot().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(2000); // 退避后 poll#2 成功恢复
    expect(c.getSnapshot().qrUrl).toBe('u2');
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS - 1000 + 1000); // 按 interval_ms=1000 继续
    expect(c.getSnapshot().state).toBe('succeeded');
  });

  it('按 expires_at_ms 硬超时转 expired，且停止轮询', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 2000, expires_at_ms: Date.now() + 5000 }),
      )
      .mockResolvedValue(ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 2000, expires_at_ms: Date.now() + 5000 }));

    const c = new ChannelScanController('feishu');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000); // 中途一次 pending poll
    expect(c.getSnapshot().state).toBe('pending');
    await vi.advanceTimersByTimeAsync(3000); // 到达 expires_at_ms
    expect(c.getSnapshot().state).toBe('expired');
    const polls = spy.mock.calls.filter((x) => x[0] === 'poll').length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy.mock.calls.filter((x) => x[0] === 'poll')).toHaveLength(polls);
  });

  it('cancel：清定时器 + 尽力通知远端取消（携带 session_id）', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 1000, expires_at_ms: Date.now() + 60_000 }),
      )
      .mockResolvedValue(ok({ status: 'cancelled' }));

    const c = new ChannelScanController('feishu');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().state).toBe('cancelled');
    expect(spy.mock.calls[1]).toEqual(['cancel', 'feishu', { session_id: 's1' }]);

    // 取消后不再轮询
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('成功态取消（弹窗关闭/卸载）不通知远端——会话已被消费', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u', interval_ms: 1000, expires_at_ms: Date.now() + 60_000 }),
      )
      .mockResolvedValueOnce(ok({ status: 'succeeded' }));

    const c = new ChannelScanController('feishu');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot().state).toBe('succeeded');
    c.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(2); // 无 cancel 调用
  });

  it('restart（刷新二维码）作废旧会话：旧响应被忽略', async () => {
    const spy = vi
      .spyOn(platform, 'channelConnect')
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's1', qr_url: 'u1', interval_ms: 1000, expires_at_ms: Date.now() + 60_000 }),
      )
      .mockResolvedValueOnce(
        ok({ status: 'pending', session_id: 's2', qr_url: 'u2', interval_ms: 1000, expires_at_ms: Date.now() + 60_000 }),
      )
      .mockResolvedValue(ok({ status: 'succeeded' }));

    const c = new ChannelScanController('feishu');
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().qrUrl).toBe('u1');
    c.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot().qrUrl).toBe('u2');
    // 旧会话的轮询已作废：下一次 poll 属于 s2
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot().state).toBe('succeeded');
    expect(spy.mock.calls[2]).toEqual(['poll', 'feishu', { session_id: 's2' }]);
  });
});
