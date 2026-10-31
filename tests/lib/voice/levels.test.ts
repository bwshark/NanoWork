import { describe, expect, it } from 'vitest';
import {
  bandLevels,
  barHeight,
  smoothLevels,
  VOICE_BAR_COUNT,
  VOICE_BAR_SHAPE,
} from '@/lib/voice/levels';

/**
 * 波形电平：这是语音功能里唯一「既能被数值钉住、又直接决定观感」的部分。
 *
 * 变异清单（每条都能让某个用例变红）：
 * - `bandLevels` 改成全频段等分 → 「高频 bin 也分到能量」用例变红
 * - 去掉 NOISE_FLOOR → 「静音段返回 0」变红
 * - `smoothLevels` 的 attack/release 写反 → 「起音快、落音慢」变红
 * - `barHeight` 去掉 clamp → 「超范围电平不越界」变红
 */

/** 造一段频谱：只在 `from..to` 区间填充峰值 */
function spectrum(size: number, ranges: Array<[number, number, number]>): number[] {
  const out = new Array<number>(size).fill(0);
  for (const [from, to, peak] of ranges) {
    for (let i = from; i <= to && i < size; i += 1) out[i] = peak;
  }
  return out;
}

describe('bandLevels：频段分解', () => {
  it('空频谱返回空数组（不是 5 个 0）', () => {
    expect(bandLevels([], VOICE_BAR_COUNT)).toEqual([]);
  });

  it('全静音 → 每段都是 0（底噪被噪声地板吃掉）', () => {
    expect(bandLevels(new Array(512).fill(0), VOICE_BAR_COUNT)).toEqual([0, 0, 0, 0, 0]);
  });

  it('底噪级能量（低于噪声地板）不产生可见电平', () => {
    // 20/255 ≈ 0.078 < NOISE_FLOOR(0.1)
    expect(bandLevels(new Array(512).fill(20), VOICE_BAR_COUNT)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it('低段有强能量时第一段最亮（人声基频落在这里）', () => {
    const levels = bandLevels(spectrum(512, [[2, 6, 255]]), VOICE_BAR_COUNT);
    expect(levels[0]).toBeGreaterThan(0.9);
    // 后段没能量
    expect(levels[levels.length - 1]).toBe(0);
  });

  it('**关键**：高频段有能量时也能被分到（不是全频段等分）', () => {
    // 若按 512 bin 等分 5 段，bin 100 会落在第 1 段；
    // 按对数分桶（只取前 1/4 = 128 bin），bin 100 落在靠后的段
    const levels = bandLevels(spectrum(512, [[100, 110, 255]]), VOICE_BAR_COUNT);
    const lit = levels.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit[0]).toBeGreaterThanOrEqual(2);
  });

  it('段数可自定义（1 段 / 8 段都能跑）', () => {
    const one = bandLevels(new Array(512).fill(255), 1);
    expect(one).toHaveLength(1);
    expect(one[0]).toBeGreaterThan(0.9);
    expect(bandLevels(new Array(512).fill(255), 8)).toHaveLength(8);
  });

  it('count<=0 返回空数组，不进入死循环', () => {
    expect(bandLevels(new Array(512).fill(255), 0)).toEqual([]);
    expect(bandLevels(new Array(512).fill(255), -3)).toEqual([]);
  });

  it('输出恒在 0~1 之间', () => {
    const levels = bandLevels(new Array(512).fill(255), VOICE_BAR_COUNT);
    levels.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  it('满能量时最高值为 1（255 归一化后不被压掉）', () => {
    const levels = bandLevels(new Array(512).fill(255), VOICE_BAR_COUNT);
    expect(Math.max(...levels)).toBeCloseTo(1, 5);
  });
});

describe('smoothLevels：起音快、落音慢', () => {
  it('长度不一致时按较长的补齐 0', () => {
    const out = smoothLevels([0.5], [0.5, 0.9]);
    expect(out).toHaveLength(2);
  });

  it('上升一帧就接近目标（attack=0.5）', () => {
    const out = smoothLevels([0, 0], [1, 1], 0.5, 0.12);
    expect(out[0]).toBeCloseTo(0.5, 5);
  });

  it('**关键**：下降比上升慢（同一帧内 release < attack）', () => {
    const up = smoothLevels([0], [1], 0.5, 0.12)[0];
    const down = smoothLevels([1], [0], 0.5, 0.12)[0];
    // up = 0 + (1-0)*0.5 = 0.5；down = 1 + (0-1)*0.12 = 0.88
    expect(down).toBeGreaterThan(up);
    expect(down).toBeCloseTo(0.88, 5);
  });

  it('多帧连续下降不会瞬间归零（避免气口闪断）', () => {
    let value = [1];
    for (let i = 0; i < 3; i += 1) value = smoothLevels(value, [0]);
    expect(value[0]).toBeGreaterThan(0.5);
  });

  it('空输入不抛错', () => {
    expect(smoothLevels([], [])).toEqual([]);
  });
});

describe('barHeight：电平 → 像素高度', () => {
  it('0 电平取最小高度（条不消失，否则分不清「安静」与「挂了」）', () => {
    expect(barHeight(0, 4, 15)).toBe(4);
  });

  it('满电平取最大高度', () => {
    expect(barHeight(1, 4, 15)).toBe(15);
  });

  it('中间值线性插值', () => {
    expect(barHeight(0.5, 4, 15)).toBeCloseTo(9.5, 5);
  });

  it('超范围电平被 clamp（不越界、不 NaN）', () => {
    expect(barHeight(2, 4, 15)).toBe(15);
    expect(barHeight(-1, 4, 15)).toBe(4);
    expect(barHeight(Number.NaN, 4, 15)).toBe(4);
  });
});

describe('VOICE_BAR_SHAPE：中间高、两侧递减', () => {
  it('5 根条，中间那根权重为 1', () => {
    expect(VOICE_BAR_SHAPE).toHaveLength(5);
    expect(VOICE_BAR_SHAPE[2]).toBe(1);
  });

  it('左右对称（视觉上不会歪）', () => {
    expect(VOICE_BAR_SHAPE[0]).toBe(VOICE_BAR_SHAPE[4]);
    expect(VOICE_BAR_SHAPE[1]).toBe(VOICE_BAR_SHAPE[3]);
  });

  it('从中间向两侧单调递减', () => {
    expect(VOICE_BAR_SHAPE[2]).toBeGreaterThan(VOICE_BAR_SHAPE[1]);
    expect(VOICE_BAR_SHAPE[1]).toBeGreaterThan(VOICE_BAR_SHAPE[0]);
  });
});
