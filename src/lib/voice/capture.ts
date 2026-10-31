/**
 * 麦克风采集：申请流 + 电平分析。
 *
 * ## 为什么把「约束降级」写在这里
 * 我们想要的是**适合语音识别**的音频：单声道、开回声消除/降噪/AGC、低采样率。
 * 但设备能力千差万别：
 * - 部分虚拟声卡（VB-Cable / Loopback）对 `channelCount:1` 直接回
 *   `OverconstrainedError`；
 * - 老内置麦不支持 `echoCancellation`；
 * - 少数 USB 麦的 `sampleRate` 只能给 48000。
 *
 * 这些**都不该报给用户**：用户的诉求是「我要说话」，不是「我要配声卡」。
 * 所以按「严格 → 宽松 → 裸奔」三级降级，只有三级全失败才报错。
 *
 * ## 为什么关了 AGC 之外还要再归一化
 * `autoGainControl` 在部分驱动上形同虚设（尤其 Windows 的 WASAPI 共享模式）。
 * 采集层尽力要求，量化前再用 `normalizePeak` 兜一层（见 `wav.ts`）。
 */

/**
 * 期望采样率；实际以 `track.getSettings()` 为准（浏览器会静默改）。
 *
 * ⚠️ 必须定义在 `CONSTRAINT_TIERS` **之前**：后者是模块顶层常量，
 * 在模块求值时就读取 `TARGET_RATE`，写在后面会踩 TDZ（`Cannot access
 * before initialization`），而且报错发生在 import 阶段、整页白屏。
 */
const TARGET_RATE = 16000;

/** 三级降级：每一级只保留上一级失败的约束，越往后越宽松 */
const CONSTRAINT_TIERS: readonly MediaTrackConstraints[] = [
  {
    // 一级：最适合 ASR 的组合
    channelCount: 1,
    sampleRate: TARGET_RATE,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  {
    // 二级：去掉采样率与声道要求（虚拟声卡最常见的卡点）
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  {
    // 三级：只要「有麦克风」就行
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
];

export interface AudioCapture {
  stream: MediaStream;
  /** 实际生效的采样率（用于日志与诊断，不参与编码——编码固定 16kHz） */
  sampleRate: number;
  /** 释放：停轨 + 关 AudioContext */
  dispose: () => void;
  /** 注册电平回调（0~1 的频段数组）；返回取消注册函数 */
  onLevels: (cb: (levels: number[]) => void) => () => void;
}

/**
 * 申请麦克风并挂上电平分析。
 *
 * 返回的 `dispose` 必须被调用（组件卸载 / 录音结束），否则：
 * - 麦克风指示灯常亮（用户会以为应用在偷听）
 * - `AudioContext` 泄漏，Chromium 上限约 6 个，超了之后**再也录不了音**
 */
export async function acquireMicrophone(): Promise<AudioCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('getUserMedia 不可用', 'SecurityError');
  }

  let stream: MediaStream | null = null;
  let lastErr: unknown = null;
  for (const constraints of CONSTRAINT_TIERS) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      break;
    } catch (err) {
      lastErr = err;
      const name = typeof err === 'object' && err !== null && 'name' in err
        ? String((err as { name: unknown }).name)
        : '';
      // 权限拒绝 / 无设备 / 被占用：再降级也没用，立刻停（否则会弹三次授权框）
      if (
        name === 'NotAllowedError' ||
        name === 'PermissionDeniedError' ||
        name === 'NotFoundError' ||
        name === 'NotReadableError'
      ) {
        throw err;
      }
      // 其余（Overconstrained / TypeError）继续降级
    }
  }
  if (!stream) throw lastErr ?? new Error('无法获取麦克风');

  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  const sampleRate = typeof settings.sampleRate === 'number' ? settings.sampleRate : TARGET_RATE;

  const disposers: Array<() => void> = [];

  // —— 电平分析 ——
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  let audioCtx: AudioContext | null = null;
  const levelSubs = new Set<(levels: number[]) => void>();
  let levelTimer: number | null = null;

  if (Ctor) {
    try {
      audioCtx = new Ctor();
      // 部分平台创建后是 suspended，必须显式 resume 才有数据
      void audioCtx.resume().catch(() => undefined);
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      // fftSize=1024 → 512 个频域 bin，时间分辨率与频率分辨率都够用
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);

      const freq = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (levelSubs.size === 0) return;
        analyser.getByteFrequencyData(freq);
        // 复制一份再分发：同一个 Uint8Array 被多个消费者读会被覆盖
        const snapshot = Array.from(freq);
        levelSubs.forEach((cb) => cb(snapshot));
      };
      // 30fps 足够做波形动效，又不会让 React 每帧重渲染
      levelTimer = window.setInterval(tick, 33);
      disposers.push(() => {
        if (levelTimer !== null) window.clearInterval(levelTimer);
        levelTimer = null;
      });
    } catch {
      // 电平只是观感，失败不影响录音
      audioCtx = null;
    }
  }

  const dispose = () => {
    disposers.forEach((fn) => fn());
    disposers.length = 0;
    levelSubs.clear();
    stream?.getTracks().forEach((t) => t.stop());
    if (audioCtx) void audioCtx.close().catch(() => undefined);
    audioCtx = null;
  };

  return {
    stream,
    sampleRate,
    dispose,
    onLevels: (cb) => {
      levelSubs.add(cb);
      return () => levelSubs.delete(cb);
    },
  };
}

/**
 * 录音格式候选：优先 webm/opus（体积小、Chrome 全支持），
 * 退化到 mp4（Safari / 部分 Electron 版本）。
 *
 * 注意：**编码格式只影响中间产物**，最终一律转 WAV 再上传，
 * 所以这里的选择只关乎「能否录到」，不关乎兼容性。
 */
const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return RECORDER_MIME_CANDIDATES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** 当前环境是否具备录音能力（不支持时 UI 应禁用按钮而不是报错） */
export function isRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== 'undefined'
  );
}
