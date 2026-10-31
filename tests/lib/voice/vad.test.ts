import { describe, expect, it } from 'vitest';
import { BARGE_IN_PROFILE, createTurnDetector } from '@/lib/voice/vad';

describe('voice turn detector', () => {
  it('持续超过最小时长才起说，安静足够久才结束', () => {
    const detector = createTurnDetector({ minSpeechMs: 200, silenceMs: 500 });
    expect(detector.push(0.4, 0)).toBeNull();
    expect(detector.push(0.4, 100)).toBeNull();
    expect(detector.push(0.4, 199)).toBeNull();
    expect(detector.push(0.4, 200)).toBe('start');
    expect(detector.speaking).toBe(true);

    expect(detector.push(0, 300)).toBeNull();
    expect(detector.push(0, 699)).toBeNull();
    expect(detector.push(0, 700)).toBe('end');
    expect(detector.speaking).toBe(false);
    // 同一段静音不能重复提交
    expect(detector.push(0, 1000)).toBeNull();
  });

  it('咳嗽式尖峰会重新计时，不起说', () => {
    const detector = createTurnDetector({ minSpeechMs: 200 });
    detector.push(0.5, 0);
    detector.push(0.5, 100);
    detector.push(0, 120);
    detector.push(0.5, 150);
    expect(detector.push(0.5, 300)).toBeNull();
    expect(detector.push(0.5, 350)).toBe('start');
  });

  it('起说后使用较低 release 阈值，轻声气口不会切断一句话', () => {
    const detector = createTurnDetector({ minSpeechMs: 100, silenceMs: 300 });
    detector.push(0.4, 0);
    expect(detector.push(0.4, 100)).toBe('start');
    // 低于 onset=0.16、高于 release=0.08：仍然算在说话
    expect(detector.push(0.1, 200)).toBeNull();
    expect(detector.push(0, 300)).toBeNull();
    // 最后一段有声在 200，500 时静音达到 300ms，切句
    expect(detector.push(0, 500)).toBe('end');
  });

  it('单句到达上限会强制结束', () => {
    const detector = createTurnDetector({ minSpeechMs: 100, maxUtteranceMs: 1000 });
    detector.push(0.4, 0);
    expect(detector.push(0.4, 100)).toBe('start');
    expect(detector.push(0.4, 1099)).toBeNull();
    expect(detector.push(0.4, 1100)).toBe('end');
  });

  it('切换播报期门槛不会清掉正在说的一句话', () => {
    const detector = createTurnDetector({ minSpeechMs: 100, silenceMs: 300 });
    detector.push(0.4, 0);
    expect(detector.push(0.4, 100)).toBe('start');
    detector.configure(BARGE_IN_PROFILE);
    expect(detector.speaking).toBe(true);
    expect(detector.push(0, 900)).toBe('end');
    detector.configure(null);
    detector.push(0.3, 1000);
    expect(detector.push(0.3, 1220)).toBe('start');
  });

  it('时间回拨与非有限电平不会产生负时长或误触发', () => {
    const detector = createTurnDetector();
    expect(detector.push(Number.NaN, 100)).toBeNull();
    expect(detector.push(0.5, 50)).toBeNull();
    expect(detector.speaking).toBe(false);
  });
});
