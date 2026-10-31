import { describe, expect, it } from 'vitest';
import { encodeWav, encodeWavHeader, normalizePeak, TARGET_SAMPLE_RATE, wavDurationSeconds } from '@/lib/voice/wav';

/**
 * WAV 编码：**字节序与量化是这里最容易错、又最难在真机上发现的**。
 *
 * 变异清单：
 * - `setUint32(..., true)` 改成 `false`（大端）→ 「RIFF 长度字段小端」变红
 * - 量化用 32768 而不是 32767 → 「+1.0 不溢出成 -32768」变红
 * - 去掉 `normalizePeak` 的 floor → 「纯静音不放大底噪」变红
 */

/** 读 4 字节 ASCII（小端无关，纯文本标签） */
function ascii(view: DataView, offset: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe('encodeWavHeader：RIFF 头字段', () => {
  it('44 字节固定长度', () => {
    expect(encodeWavHeader(0).byteLength).toBe(44);
  });

  it('四个 ASCII 标签正确（RIFF / WAVE / fmt / data）', () => {
    const view = new DataView(encodeWavHeader(100));
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(ascii(view, 36, 4)).toBe('data');
  });

  it('**关键**：RIFF 长度字段为小端且等于 36 + 数据长度', () => {
    const view = new DataView(encodeWavHeader(1000));
    // 小端读 = 正确；若代码误写大端，这里会读出 0x2C010000 这种巨大值
    expect(view.getUint32(4, true)).toBe(36 + 1000);
  });

  it('data 块长度 = 数据字节数', () => {
    const view = new DataView(encodeWavHeader(1000));
    expect(view.getUint32(40, true)).toBe(1000);
  });

  it('采样率 / 声道 / 位深写入正确', () => {
    const view = new DataView(encodeWavHeader(0, TARGET_SAMPLE_RATE, 1));
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // 单声道
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // 16bit
  });

  it('byteRate 与 blockAlign 自洽（服务端会据此算时长）', () => {
    const view = new DataView(encodeWavHeader(0, TARGET_SAMPLE_RATE, 1));
    expect(view.getUint32(28, true)).toBe(TARGET_SAMPLE_RATE * 1 * 2);
    expect(view.getUint16(32, true)).toBe(1 * 2);
  });
});

describe('encodeWav：完整文件', () => {
  it('总长度 = 头 44 + 样本数 × 2', () => {
    const wav = encodeWav(new Float32Array(100));
    expect(wav.byteLength).toBe(44 + 200);
  });

  it('**关键**：+1.0 量化为 32767（不是 32768 溢出成 -32768）', () => {
    const wav = encodeWav(new Float32Array([1]));
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(32767);
  });

  it('-1.0 量化为 -32767（对称，不踩负溢出）', () => {
    const wav = encodeWav(new Float32Array([-1]));
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(-32767);
  });

  it('0 量化为 0（静音段真正静音）', () => {
    const wav = encodeWav(new Float32Array([0]));
    expect(new DataView(wav).getInt16(44, true)).toBe(0);
  });

  it('超范围样本被 clamp（不产生回绕爆音）', () => {
    const wav = encodeWav(new Float32Array([2, -3]));
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });

  it('多字节样本按小端逐个小端写入', () => {
    const wav = encodeWav(new Float32Array([0.5, -0.5]));
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 32767));
    expect(view.getInt16(46, true)).toBe(Math.round(-0.5 * 32767));
  });

  it('空样本也能产出合法（可解析的）空 WAV', () => {
    const wav = encodeWav(new Float32Array(0));
    expect(wav.byteLength).toBe(44);
    expect(new DataView(wav).getUint32(40, true)).toBe(0);
  });
});

describe('normalizePeak：峰值归一化', () => {
  it('小声放大到目标峰值', () => {
    const out = normalizePeak(new Float32Array([0.1, -0.2]));
    expect(Math.max(...Array.from(out, Math.abs))).toBeCloseTo(0.9, 5);
  });

  it('**关键**：纯静音不放大（否则把底噪拉满，ASR 反而更差）', () => {
    const quiet = new Float32Array([0.001, -0.002]);
    const out = normalizePeak(quiet);
    expect(Array.from(out)).toEqual(Array.from(quiet));
  });

  it('已经够响的音频不再放大（避免削顶）', () => {
    const loud = new Float32Array([0.95, -0.9]);
    expect(Array.from(normalizePeak(loud))).toEqual(Array.from(loud));
  });

  it('归一化保持相对关系（不改变波形形状）', () => {
    const out = normalizePeak(new Float32Array([0.1, 0.2, -0.1]));
    // 原比例 1:2:-1，放大后仍应是这个比例
    expect(out[1] / out[0]).toBeCloseTo(2, 5);
    expect(out[2] / out[0]).toBeCloseTo(-1, 5);
  });

  it('返回新数组而不是原地改（调用方可能还要用原始数据）', () => {
    const input = new Float32Array([0.1, 0.2]);
    const out = normalizePeak(input);
    expect(out).not.toBe(input);
  });
});

describe('wavDurationSeconds：由字节数反推时长', () => {
  it('1 秒 16kHz 单声道 = 32000 字节', () => {
    // 用 encodeWav 造一个真实 1 秒的音频
    const wav = encodeWav(new Float32Array(TARGET_SAMPLE_RATE));
    const blob = new Blob([wav]);
    expect(wavDurationSeconds(blob)).toBeCloseTo(1, 5);
  });

  it('空 WAV 时长为 0（不出现负时长）', () => {
    expect(wavDurationSeconds(new Blob([encodeWav(new Float32Array(0))]))).toBe(0);
  });
});
