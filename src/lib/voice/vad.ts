/**
 * 断句器（VAD）：把连续的电平变成「开始说」/「说完了」两个信号。
 *
 * ## 为什么客户端自己做端点检测
 * 实时识别协议里 `turn_detection: 'server_vad'` 也能切句，但它按服务端的
 * 静音阈值切，客户端拿不到「切在哪、为什么切」，也无法在 TTS 播报时
 * 用更高的门槛过滤回声。语音**输入**（一句话落进输入框）那边刻意用
 * Manual 模式也是同一个理由：分段权必须在客户端。
 *
 * ## 两个阈值（迟滞）+ 最小语音时长
 * 只用单阈值的经典毛病：电平在阈值附近抖动时，一帧算「说完了」、下一帧又
 * 「开始说」，一句话被切成十几段。因此：
 * - 起说用**较高**门槛 `onset`（避免被环境噪声触发）；
 * - 结束用**较低**门槛 `release`（已经开口后，轻声的气口不该被当成结束）；
 * - 起说还要连续超过 `minSpeechMs`（咳嗽、敲键盘是几十毫秒的尖峰）。
 *
 * ## 为什么是纯函数
 * 「什么时候算说完」决定了一句话会不会说一半就被发出去，是这个功能里
 * 唯一能被数值钉住的判据。放进 hook 就只能靠手动试麦克风，永远测不到。
 */

/** 默认参数：实测在笔记本内置麦 + `noiseSuppression` 下可用 */
const DEFAULTS = {
  /** 起说门槛（0~1，已扣掉噪声地板，见 levels.ts） */
  onset: 0.16,
  /** 继续说门槛（迟滞下沿） */
  release: 0.08,
  /** 起说前必须持续的时长：挡住咳嗽 / 键盘声 */
  minSpeechMs: 220,
  /** 静音多久算说完 */
  silenceMs: 900,
  /** 单句上限：超过就强制切（避免用户一直说、模型一直等） */
  maxUtteranceMs: 25000,
} as const;

export interface TurnDetectorOptions {
  onset?: number;
  release?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxUtteranceMs?: number;
}

export type TurnSignal = 'start' | 'end' | null;

export interface TurnDetector {
  /**
   * 送入一帧电平（0~1）与时间戳（ms，单调递增）。
   *
   * 返回 `start` = 用户开始说话了（调用方可以据此打断播报）；
   * 返回 `end` = 这一句说完了（调用方提交识别）。
   * 同一次「说话-说完」只会各报一次。
   */
  push: (level: number, nowMs: number) => TurnSignal;
  /**
   * 换一套门槛（`null` = 回到默认）。**不清除**当前状态：
   * 播报期间调到打断门槛、播报结束调回来，是同一句话的语境切换，
   * 清状态会把「用户说到一半时 AI 开始播报」这种情况下的半句话弄丢。
   */
  configure: (options: TurnDetectorOptions | null) => void;
  /** 复位到「没在说话」（切换会话 / 静音后重新开始） */
  reset: () => void;
  /** 当前是否处于「已开口」状态 */
  readonly speaking: boolean;
}

export function createTurnDetector(options: TurnDetectorOptions = {}): TurnDetector {
  let onset = options.onset ?? DEFAULTS.onset;
  let release = options.release ?? DEFAULTS.release;
  let minSpeechMs = options.minSpeechMs ?? DEFAULTS.minSpeechMs;
  let silenceMs = options.silenceMs ?? DEFAULTS.silenceMs;
  let maxUtteranceMs = options.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs;

  let speaking = false;
  /** 连续高于 onset 的累计时长 */
  let speechMs = 0;
  /** 最近一帧高于 release 的时间：静音从这里开始计 */
  let lastVoiceMs = 0;
  /** 本句开始时间（用于单句上限） */
  let utteranceStartMs = 0;
  let lastMs: number | null = null;

  const reset = () => {
    speaking = false;
    speechMs = 0;
    lastVoiceMs = 0;
    utteranceStartMs = 0;
    lastMs = null;
  };

  const push = (level: number, nowMs: number): TurnSignal => {
    const lv = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    // 时间戳跳变（时钟回拨 / 首帧）按 0 处理，绝不让 dt 变成负数
    const dt = lastMs === null ? 0 : Math.max(0, nowMs - lastMs);
    lastMs = nowMs;

    if (!speaking) {
      if (lv >= onset) {
        speechMs += dt;
        if (speechMs >= minSpeechMs) {
          speaking = true;
          utteranceStartMs = nowMs;
          lastVoiceMs = nowMs;
          return 'start';
        }
      } else {
        // 不高于 onset 就归零：中间有任何一帧塌下来就重新计
        speechMs = 0;
      }
      return null;
    }

    if (lv >= release) lastVoiceMs = nowMs;
    if (nowMs - lastVoiceMs >= silenceMs || nowMs - utteranceStartMs >= maxUtteranceMs) {
      reset();
      return 'end';
    }
    return null;
  };

  return {
    push,
    configure: (next) => {
      const src = next ?? DEFAULTS;
      onset = src.onset ?? DEFAULTS.onset;
      release = src.release ?? DEFAULTS.release;
      minSpeechMs = src.minSpeechMs ?? DEFAULTS.minSpeechMs;
      silenceMs = src.silenceMs ?? DEFAULTS.silenceMs;
      maxUtteranceMs = src.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs;
    },
    reset,
    get speaking() {
      return speaking;
    },
  };
}

/**
 * 播报期间的打断门槛：更高、更持久。
 *
 * 播报时麦克风必然会收到扬声器的声音（即使用户戴耳机，外放场景也很常见）。
 * 用正常门槛会把 AI 自己的声音当成「用户开口」，于是每句话都被自己打断。
 * `echoCancellation` 只能压掉一部分，剩下的靠这道门槛兜住。
 */
export const BARGE_IN_PROFILE: TurnDetectorOptions = {
  onset: 0.34,
  release: 0.2,
  minSpeechMs: 320,
  silenceMs: 800,
};
