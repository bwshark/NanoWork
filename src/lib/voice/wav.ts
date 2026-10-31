/**
 * 录音转 WAV（16kHz 单声道 16bit PCM）。
 *
 * ## 为什么必须转，而不是把 MediaRecorder 的产物直接传
 * 1. **格式兼容**：`MediaRecorder` 在 Chrome/Electron 只会吐 `audio/webm;codecs=opus`。
 *    Groq / OpenAI 能吃 webm，但硅基流动 SenseVoice、部分自建网关只认
 *    wav/mp3/m4a——直接传就是 400「unsupported format」，而错误文案里往往只有
 *    「转录失败」，排查成本极高。转成 WAV 之后**所有 provider 通吃**。
 * 2. **体积**：48kHz 立体声 opus 约 1.2MB/分钟；16kHz 单声道 16bit PCM 是
 *    32KB/秒 ≈ 1.9MB/分钟——体积没优势，但 Whisper 系模型内部一律重采样到
 *    16kHz，传 48kHz 是**纯浪费带宽**且增加服务端转码时间。
 * 3. **可靠性**：`decodeAudioData` + `OfflineAudioContext` 重采样是浏览器内
 *    唯一「不引入 wasm 编码器」就能做到的高质量降采样路径（手动抽取样本会
 *    产生混叠噪声，反而降低识别率）。
 *
 * ## 为什么把「纯函数」和「浏览器胶水」分开
 * `decodeAudioData` / `OfflineAudioContext` 在 jsdom 里不存在，混在一起写
 * 就等于 `encodeWavHeader` 这种最容易写错的字节序逻辑永远没有测试。
 */

/** 目标采样率：Whisper 系模型的内部工作采样率 */
export const TARGET_SAMPLE_RATE = 16000;

/** 单声道 16bit 的字节宽度 */
const BYTES_PER_SAMPLE = 2;

/** WAV 头长度（44 字节标准 RIFF/PCM 头） */
const HEADER_BYTES = 44;

/**
 * 写 44 字节 RIFF/WAVE 头。
 *
 * ⚠️ 所有多字节字段都是**小端**（WAV 规范），`DataView` 默认即小端，
 * 但必须显式传 `true`——`false` 时是大端，会写出服务端无法解析的头，
 * 而症状只是「转录结果为空」，完全看不出是字节序问题。
 */
export function encodeWavHeader(
  dataBytes: number,
  sampleRate: number = TARGET_SAMPLE_RATE,
  channels = 1,
): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  const blockAlign = channels * BYTES_PER_SAMPLE;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // 文件长度 - 8
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM = 1
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 位深
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * 浮点样本（-1~1）→ 16bit PCM，拼成完整 WAV。
 *
 * 这是纯函数，输入输出都是可断言的字节——单测直接钉住头字段与样本量化。
 *
 * 量化用 `32767` 而非 `32768`：负半轴能到 -32768，正半轴只能到 32767，
 * 用 32768 会让 +1.0 溢出成 -32768（听起来是「啪」的一声爆音）。
 */
export function encodeWav(
  samples: Float32Array | readonly number[],
  sampleRate: number = TARGET_SAMPLE_RATE,
): ArrayBuffer {
  const count = samples.length;
  const dataBytes = count * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  new Uint8Array(buffer, 0, HEADER_BYTES).set(
    new Uint8Array(encodeWavHeader(dataBytes, sampleRate)),
  );

  let offset = HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    const s = samples[i];
    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
    // 对称量化：+1.0 → 32767，-1.0 → -32767（-32768 留给「负溢出」）
    view.setInt16(offset, Math.round(clamped * 32767), true);
    offset += BYTES_PER_SAMPLE;
  }
  return buffer;
}

/**
 * 峰值归一化：把整段录音拉到合适音量。
 *
 * 为什么需要：笔记本内置麦在 0.5m 外说话，峰值往往只有 0.1~0.2，
 * 直接量化成 16bit 后信噪比极差，远端 ASR 的识别率会明显下降。
 * 拉到 0.9 峰值后再量化，等于给所有用户做了一次免费的前级放大。
 *
 * 静音段（peak < 0.01）原样返回——对纯底噪放大只会放大噪声，
 * 让它保持「安静」才能触发后续的静音判定。
 */
export function normalizePeak(
  samples: Float32Array,
  targetPeak = 0.9,
  floor = 0.01,
): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < floor || peak >= targetPeak) return samples;
  const gain = targetPeak / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain;
  return out;
}

/**
 * 浏览器侧：任意录音 Blob → 16kHz 单声道 WAV Blob。
 *
 * 失败时抛错，由调用方决定降级（回退传原始 webm）。
 * 这层不做降级判断：`useVoiceInput` 才知道当前 provider 吃不吃 webm。
 */
export async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) throw new Error('当前环境不支持音频解码');

  // decodeAudioData 需要一个**未分离**的 AudioContext；用完立刻 close，
  // 否则每次录音都会泄漏一个上下文（Chromium 上限约 6 个，超了直接抛错）
  const ctx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    void ctx.close().catch(() => undefined);
  }

  // 用 OfflineAudioContext 做重采样：它内部是 sinc 插值，比手写抽稀干净得多
  const frames = Math.max(1, Math.round(decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();

  const samples = normalizePeak(rendered.getChannelData(0));
  const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
  return new Blob([wav], { type: 'audio/wav' });
}

/**
 * 估算时长（秒），用于「最长录制」与服务端 `duration_ms` 校验。
 * 由 WAV 字节数反推，避免再解一次码。
 */
export function wavDurationSeconds(wav: Blob): number {
  const dataBytes = Math.max(0, wav.size - HEADER_BYTES);
  return dataBytes / (TARGET_SAMPLE_RATE * BYTES_PER_SAMPLE);
}
