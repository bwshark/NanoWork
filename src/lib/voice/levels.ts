/**
 * 语音波形可视化：频段分解 + 电平平滑。
 *
 * 为什么单独成模块：这些是**纯函数**，jsdom 里能完整单测；而 `AnalyserNode` /
 * `MediaRecorder` 在 jsdom 里不存在，留在 hook 里就等于永远测不到。
 * 「录音时波形条该怎么跳」是本功能里唯一既影响观感、又能被数值钉住的部分。
 */

/** 波形条数量：与参考图的 5 根一致（中间最高、两侧递减） */
export const VOICE_BAR_COUNT = 5;

/**
 * 每根条的「形状权重」。
 *
 * 参考图里中间那根最长、两侧依次缩短，这不是随机噪声，而是固定的视觉形状——
 * 把权重和实时电平相乘，才能在「安静时」也保留可辨认的轮廓（全塌成一条线
 * 会让人以为按钮没在工作）。
 */
export const VOICE_BAR_SHAPE: readonly number[] = [0.62, 0.86, 1, 0.86, 0.62];

/**
 * 低于这个强度一律当静音。
 *
 * 麦克风底噪（空调、风扇、笔记本内置麦的自噪）经 AGC 放大后能稳定在 0.05~0.1，
 * 不设地板的话「不说话时波形条也一直小幅抖动」——用户会以为麦克风坏了。
 */
const NOISE_FLOOR = 0.1;

/** 人声能量集中区占整个频谱的比例（经验值，见 `bandLevels` 注释） */
const VOICE_SPECTRUM_RATIO = 4;

/**
 * 把 `AnalyserNode.getByteFrequencyData` 的频域数据压成 N 段强度（0~1）。
 *
 * ## 为什么不能按全频段等分
 * 48kHz 采样 + `fftSize=1024` 时 `frequencyBinCount=512`，每 bin 约 93.75Hz。
 * 人声基频与主要共振峰落在 300Hz–3kHz，即 **前 ~32 个 bin**；后 480 个 bin
 * 基本是静音与电路噪声。若按 512 个 bin 等分 5 段，后 4 段永远接近 0，
 * 视觉上就是「只有最左边一根条在动」。
 *
 * 因此这里只取前 `1/4` 频段，并在该区间内按**对数**分桶：低频 bin 密、高频 bin 疏，
 * 正好对应人耳与人声的能量分布，每根条都能分到有意义的能量。
 */
export function bandLevels(
  freq: ArrayLike<number>,
  count: number = VOICE_BAR_COUNT,
): number[] {
  const bins = freq.length;
  if (bins === 0 || count <= 0) return [];

  // 跳过 DC 分量（bin 0 恒为直流偏移，不代表任何频段能量）
  const usable = Math.max(count + 1, Math.floor(bins / VOICE_SPECTRUM_RATIO));
  const edges: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    // 几何级数：低频区间窄、高频区间宽
    edges.push(Math.max(1, Math.round(Math.pow(usable, i / count))));
  }

  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const from = edges[i];
    const to = Math.max(from + 1, edges[i + 1]);
    let peak = 0;
    for (let b = from; b < to && b < bins; b += 1) {
      if (freq[b] > peak) peak = freq[b];
    }
    // 取峰值而非均值：一段里只要有一个 bin 有能量就说明该频段在发声，
    // 均值会被同段内的静音 bin 稀释，导致「说话但条不跳」。
    const level = peak / 255;
    out.push(level < NOISE_FLOOR ? 0 : (level - NOISE_FLOOR) / (1 - NOISE_FLOOR));
  }
  return out;
}

/**
 * 电平平滑：起音快、落音慢（attack / release）。
 *
 * 直接画原始电平会「抽搐」——每一帧都是独立采样，相邻帧可能从 0.9 掉到 0.1。
 * 真实音频表头都是这个策略：上升立刻跟上（否则听不到起音），下降缓慢回落
 * （否则气口处条子闪断，看起来像卡顿）。
 */
export function smoothLevels(
  prev: readonly number[],
  next: readonly number[],
  attack = 0.5,
  release = 0.12,
): number[] {
  const len = Math.max(prev.length, next.length);
  const out: number[] = [];
  for (let i = 0; i < len; i += 1) {
    const p = prev[i] ?? 0;
    const n = next[i] ?? 0;
    const k = n > p ? attack : release;
    out.push(p + (n - p) * k);
  }
  return out;
}

/**
 * 由电平算出某根条的像素高度。
 *
 * `min` 是静音时的高度（不能为 0：一条 0 高度的圆角条会整个消失，
 * 用户就分不清「安静」和「组件挂了」）；`max` 是满电平高度。
 */
export function barHeight(level: number, min: number, max: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  return min + (max - min) * clamped;
}
