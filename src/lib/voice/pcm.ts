/**
 * PCM 抽取：把麦克风流降采样成 16kHz 单声道 PCM16（实时识别协议的输入格式）。
 *
 * ## 为什么用 AudioWorklet 而不是 ScriptProcessorNode
 * - `ScriptProcessorNode` 已废弃，且它跑在**主线程**上：每 128 帧回调一次，
 *   输入区正在打字时会被这个回调抢占，表现为「说话时打字卡顿」。
 * - `AudioWorklet` 跑在独立音频线程，主线程只负责转发，不阻塞 UI。
 *
 * ## 为什么在 Worklet 里做重采样
 * 浏览器的 `AudioContext` 采样率通常锁在 48kHz（由设备/系统决定，改不了）。
 * 把 48kHz 的帧原样送到主线程再降采样，等于每 100ms 搬 4800 个样本；
 * 在 Worklet 里先降到 16kHz 再回传，数据量只有 1/3。
 *
 * 降采样用**块平均**（box filter）而不是抽稀：直接每隔 3 个取 1 个会把
 * 3kHz 以上的能量折叠进可听频段（混叠），ASR 会把气声听成噪声。
 * 块平均是廉价但有效的低通，对语音识别足够。
 */

/** Worklet 源码：内联为 Blob URL，避免额外的构建产物与 CSP 路径问题 */
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    // 输入采样率由浏览器决定（多为 48000）
    this.ratio = sampleRate / this.targetRate;
    this.buffer = new Float32Array(0);
    // 每帧回传的样本数（100ms @16kHz = 1600）
    this.frameSize = Math.round(this.targetRate / 10);
    this.acc = 0;
    this.accCount = 0;
    this.out = new Int16Array(this.frameSize);
    this.outLen = 0;
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'stop') this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i += 1) {
      // 块平均：累积到 ratio 个输入样本后吐一个输出样本
      this.acc += ch[i];
      this.accCount += 1;
      if (this.accCount >= this.ratio) {
        const v = this.acc / this.accCount;
        this.acc = 0;
        this.accCount = 0;
        const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
        this.out[this.outLen++] = Math.round(clamped * 32767);
        if (this.outLen >= this.frameSize) {
          this.port.postMessage(this.out.slice(0, this.outLen));
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

/** 目标采样率（realtime 协议只接受 16000 / 8000） */
export const PCM_TARGET_RATE = 16000;

/**
 * 创建 PCM 采集节点并接到指定 AudioContext。
 *
 * @returns 取消函数；若环境不支持 AudioWorklet 则返回 `null`
 */
export async function attachPcmCapture(
  ctx: AudioContext,
  stream: MediaStream,
  onFrame: (pcm: Int16Array) => void,
): Promise<(() => void) | null> {
  if (!ctx.audioWorklet) return null;

  try {
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      // 模块加载完就能撤销：Worklet 已持有编译后的代码
      URL.revokeObjectURL(url);
    }

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetRate: PCM_TARGET_RATE },
    });
    node.port.onmessage = (e) => {
      const data = e.data as Int16Array | { type: string };
      if (data instanceof Int16Array) onFrame(data);
    };
    source.connect(node);

    return () => {
      try {
        node.port.postMessage({ type: 'stop' });
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
      } catch {
        /* 已断开 */
      }
    };
  } catch {
    return null;
  }
}
