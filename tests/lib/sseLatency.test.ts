/**
 * 会话延迟埋点（FR-11.7）。
 *
 * **最要紧的一组断言是「缺失必须是 null，不是 0」**：两者都渲染成 0 时，
 * 报表会把一批未采集的样本算成一个极快的成绩 —— 「首字延迟 ≤ 3s」这条指标
 * 就会因为采集坏掉而变好看，而没有任何人会去怀疑一个更好看的数字。
 *
 * 其次是「首字节即首 token」这条边界：它**确实**等于 0，且与「缺失」不是一回事。
 */

import { describe, expect, it } from 'vitest';
import { createSseLatencyTracker } from '@/lib/sseLatency';

describe('createSseLatencyTracker', () => {
  it('三个时刻齐备时给出两段延迟', () => {
    const tracker = createSseLatencyTracker(() => 0);
    tracker.markStart(100);
    tracker.markFirstByte(180);
    tracker.markFirstToken(420);
    expect(tracker.sample()).toEqual({
      startedAtMs: 100,
      firstByteAtMs: 180,
      firstTokenAtMs: 420,
      ttftMs: 240,
      firstTokenLatencyMs: 320,
    });
    expect(tracker.hasFirstToken).toBe(true);
  });

  it('边界：首字节即首 token → ttft 是 0，且**不是** null', () => {
    // 一个 chunk 里就带着第一个字（小响应、模型极快、或首帧即完整答案）。
    // 这条与「没测到」必须区分开：0 是一个真实的测量结果。
    const tracker = createSseLatencyTracker(() => 0);
    tracker.markStart(100);
    tracker.markFirstByte(300);
    tracker.markFirstToken(300);
    const sample = tracker.sample();
    expect(sample.ttftMs).toBe(0);
    expect(sample.ttftMs).not.toBeNull();
    expect(sample.firstTokenLatencyMs).toBe(200);
  });

  it('边界：从未在字节层打点就收到 token → 认作同一时刻（ttft 0，非 null）', () => {
    // 调用方漏了传输层埋点。token 必然经由字节到达，故不把 firstByte 留成 null ——
    // 留成 null 会让整批样本被判为「未采集」，那才是真的丢信息。
    const tracker = createSseLatencyTracker(() => 0);
    tracker.markStart(50);
    tracker.markFirstToken(250);
    const sample = tracker.sample();
    expect(sample.firstByteAtMs).toBe(250);
    expect(sample.ttftMs).toBe(0);
    expect(sample.firstTokenLatencyMs).toBe(200);
  });

  it('没收到首 token → 两个派生量都是 null，绝不是 0', () => {
    const tracker = createSseLatencyTracker(() => 0);
    tracker.markStart(100);
    tracker.markFirstByte(180);
    const sample = tracker.sample();
    expect(sample.firstTokenAtMs).toBeNull();
    expect(sample.ttftMs).toBeNull();
    expect(sample.firstTokenLatencyMs).toBeNull();
    expect(tracker.hasFirstToken).toBe(false);
  });

  it('没打过响应头 → 只有 ttft 有效，用户侧等待为 null', () => {
    const tracker = createSseLatencyTracker(() => 0);
    tracker.markFirstByte(180);
    tracker.markFirstToken(300);
    const sample = tracker.sample();
    expect(sample.ttftMs).toBe(120);
    expect(sample.firstTokenLatencyMs).toBeNull();
  });

  it('完全没打过点 → 全 null（不是全 0）', () => {
    const tracker = createSseLatencyTracker(() => 0);
    expect(tracker.sample()).toEqual({
      startedAtMs: null,
      firstByteAtMs: null,
      firstTokenAtMs: null,
      ttftMs: null,
      firstTokenLatencyMs: null,
    });
  });

  it('重复打点以第一次为准（第二个 token 不是「首」token）', () => {
    const tracker = createSseLatencyTracker(() => 0);
    tracker.markStart(100);
    tracker.markStart(999);
    tracker.markFirstByte(150);
    tracker.markFirstByte(999);
    tracker.markFirstToken(300);
    tracker.markFirstToken(999);
    const sample = tracker.sample();
    expect(sample.startedAtMs).toBe(100);
    expect(sample.firstByteAtMs).toBe(150);
    expect(sample.firstTokenAtMs).toBe(300);
    expect(sample.ttftMs).toBe(150);
  });

  it('未传时刻时取注入时钟', () => {
    let current = 1000;
    const tracker = createSseLatencyTracker(() => {
      current += 10;
      return current;
    });
    tracker.markStart();
    tracker.markFirstByte();
    tracker.markFirstToken();
    const sample = tracker.sample();
    expect(sample.ttftMs).toBe(10);
    expect(sample.firstTokenLatencyMs).toBe(20);
  });

  it('时钟回拨钳到 0，绝不产出负数（负延迟会污染后续所有平均值）', () => {
    const tracker = createSseLatencyTracker(() => 0);
    tracker.markStart(500);
    tracker.markFirstByte(400);
    tracker.markFirstToken(300);
    const sample = tracker.sample();
    expect(sample.ttftMs).toBe(0);
    expect(sample.firstTokenLatencyMs).toBe(0);
  });
});
