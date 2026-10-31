/**
 * 语音输入 Hook：录音 → 转 WAV → 转写 → 文本回填。
 *
 * 生命周期：
 *   start()  → 申请麦克风（三级降级）→ MediaRecorder 采集 + 电平分析
 *   stop()   → 停止采集 → Blob 转 16kHz WAV → transcribeAudio() → onTranscript
 *   cancel() → 停止采集但丢弃音频（用户主动放弃，或录制期间按 Esc）
 *
 * ## 与旧实现的三个关键差异
 * 1. **转写不再走网关**：旧实现打 `{网关}/audio/transcriptions`，而引擎 `serve`
 *    没有该路由（STT 只在 gateway 的 WS 通道里，客户端够不到）→ 默认必 404。
 *    现在直连服务商，见 `lib/voice/transcribe.ts`。
 * 2. **上传前转 WAV**：各家服务商对 webm 的支持参差不齐，转 16kHz 单声道 WAV
 *    后通吃，且省掉服务端重采样。
 * 3. **状态机显式化**：`idle | acquiring | recording | transcribing`。
 *    旧实现用 `recording` + `transcribing` 两个布尔，存在
 *    「两个都 false 但其实正在申请麦克风」的空档——这段时间里按钮可点，
 *    连点两次会开两个 MediaRecorder。
 *
 * ## 卸载安全
 * 每个 await 之后都检查 `mountedRef`：`getUserMedia` 与 `decodeAudioData`
 * 都是异步的，用户在授权框弹出时切走页面是常态，不检查就会对着已卸载
 * 的组件 setState（React 18 不报错，但麦克风**不会停**）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  acquireMicrophone,
  isRecordingSupported,
  pickRecorderMime,
  type AudioCapture,
} from '@/lib/voice/capture';
import { describeVoiceError, type VoiceErrorCode } from '@/lib/voice/errors';
import { bandLevels, smoothLevels, VOICE_BAR_COUNT } from '@/lib/voice/levels';
import { transcribeAudio } from '@/lib/voice/transcribe';
import { blobToWav } from '@/lib/voice/wav';

/** 默认最大录制时长（秒）。引擎侧 `transcription.max_duration_sec` 默认 120 */
const DEFAULT_MAX_SECONDS = 120;

/** 电平降频间隔（ms）：capture 侧 33ms 一跳，这里再降到 ~15fps 才 setState */
const LEVEL_SAMPLE_MS = 66;

/** 时长格式化 mm:ss */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/** 显式状态机（见文件头注释第 3 点） */
export type VoicePhase = 'idle' | 'acquiring' | 'recording' | 'transcribing';

export interface UseVoiceInputOptions {
  /** 转录成功回调：把文本回填到输入框光标处 */
  onTranscript: (text: string) => void;
  /** 失败回调（已转成人类可读文案） */
  onError?: (message: string, code: VoiceErrorCode) => void;
  /** 最大录制时长（秒） */
  maxSeconds?: number;
}

export interface UseVoiceInputResult {
  phase: VoicePhase;
  /** 兼容旧调用点：正在录音 */
  recording: boolean;
  /** 兼容旧调用点：正在转写 */
  transcribing: boolean;
  /** 已录制秒数（UI 计时展示） */
  seconds: number;
  /** 0~1 总电平（脉冲扩散用） */
  level: number;
  /** 5 段频段电平（0~1），波形条用 */
  bands: number[];
  /** 当前环境是否支持录音 */
  supported: boolean;
  /** 转录配置是否就绪（未配置时 UI 应引导去设置，而不是让用户白录一段） */
  ready: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

/** 当前环境是否具备录音能力（保留旧导出名，供既有调用点与测试使用） */
export function isVoiceRecordingSupported(): boolean {
  return isRecordingSupported();
}

/** 语音输入：录音 → 转写 → 文本回填 */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { onTranscript, onError, maxSeconds = DEFAULT_MAX_SECONDS } = options;

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [bands, setBands] = useState<number[]>(() =>
    new Array<number>(VOICE_BAR_COUNT).fill(0),
  );
  const [supported] = useState(() => isRecordingSupported());

  // 转录配置：只读当前值，不做响应式订阅——录音过程中用户改不了设置
  // （设置页在另一个路由），订阅只会多一条渲染链
  const transcription = useSettingsStore((s) => s.settings.transcription);
  const ready =
    transcription?.enabled === true && transcription.model.trim() !== '';

  const captureRef = useRef<AudioCapture | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  /** 本次录音是否已被取消（停止后不转写） */
  const cancelledRef = useRef(false);
  const tickRef = useRef<number | null>(null);
  const unsubLevelRef = useRef<(() => void) | null>(null);
  const bandsRef = useRef<number[]>(new Array<number>(VOICE_BAR_COUNT).fill(0));
  const lastSampleRef = useRef(0);
  const mountedRef = useRef(true);
  /** 上一次点击时间：抑制双击（500ms 内第二次点击直接忽略） */
  const lastToggleRef = useRef(0);

  /** 释放采集与定时器（幂等，可重复调用） */
  const release = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    unsubLevelRef.current?.();
    unsubLevelRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    bandsRef.current = new Array<number>(VOICE_BAR_COUNT).fill(0);
    if (mountedRef.current) {
      setLevel(0);
      setBands(new Array<number>(VOICE_BAR_COUNT).fill(0));
    }
  }, []);

  const fail = useCallback(
    (err: unknown, context: 'acquire' | 'transcribe') => {
      const info = describeVoiceError(err, context);
      onError?.(info.message, info.code);
    },
    [onError],
  );

  /** 音频 → WAV → 转写 → 回填 */
  const runTranscribe = useCallback(
    async (raw: Blob) => {
      if (!mountedRef.current) return;
      setPhase('transcribing');
      try {
        const cfg = useSettingsStore.getState().settings.transcription;
        // 转 WAV 失败时回退原始格式：宁可「可能不支持」也不要「一定失败」，
        // 因为有些网关确实吃 webm，而解码失败往往是环境问题（无 AudioContext）
        let audio = raw;
        let filename = `voice-${Date.now()}.webm`;
        try {
          audio = await blobToWav(raw);
          filename = 'voice.wav';
        } catch {
          audio = raw;
        }
        if (!mountedRef.current) return;

        const text = await transcribeAudio(cfg, { audio, filename });
        if (!mountedRef.current) return;
        onTranscript(text);
      } catch (err) {
        if (!mountedRef.current) return;
        fail(err, 'transcribe');
      } finally {
        if (mountedRef.current) setPhase('idle');
      }
    },
    [fail, onTranscript],
  );

  const start = useCallback(async () => {
    // 双击抑制：录音按钮是「点一下开、再点一下关」，误双击会立刻开-关-再开
    const now = Date.now();
    if (now - lastToggleRef.current < 500) return;
    lastToggleRef.current = now;

    if (phase !== 'idle') return;
    if (!supported) {
      onError?.('当前环境不支持录音（需要浏览器麦克风权限）', 'unsupported');
      return;
    }
    if (!ready) {
      onError?.(
        '未启用语音输入，请先到「设置 → 连接 → 语音输入」配置',
        'unsupported',
      );
      return;
    }

    setPhase('acquiring');
    setSeconds(0);
    try {
      const capture = await acquireMicrophone();
      if (!mountedRef.current) {
        capture.dispose();
        setPhase('idle');
        return;
      }
      captureRef.current = capture;

      // 电平订阅：capture 侧 33ms 一跳，这里降频再 setState，
      // 避免高频重渲染打断输入区的中文输入法组合
      unsubLevelRef.current = capture.onLevels((freq) => {
        const stamp = Date.now();
        if (stamp - lastSampleRef.current < LEVEL_SAMPLE_MS) return;
        lastSampleRef.current = stamp;
        const raw = bandLevels(freq, VOICE_BAR_COUNT);
        const smoothed = smoothLevels(bandsRef.current, raw);
        bandsRef.current = smoothed;
        if (!mountedRef.current) return;
        setBands(smoothed);
        // 总电平取各段均值：只看中间那根会让「纯环境噪声」也显示满格
        const avg =
          smoothed.reduce((sum, v) => sum + v, 0) / (smoothed.length || 1);
        setLevel(Math.min(1, avg));
      });

      const mime = pickRecorderMime();
      const recorder = new MediaRecorder(
        capture.stream,
        mime ? { mimeType: mime } : undefined,
      );
      mimeRef.current = recorder.mimeType || mime || 'audio/webm';
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        release();
        recorderRef.current = null;
        if (!mountedRef.current) return;
        setPhase('idle');
        if (cancelledRef.current) {
          cancelledRef.current = false;
          return;
        }
        if (chunks.length === 0) {
          onError?.('没有录到声音，请重试', 'empty');
          return;
        }
        void runTranscribe(new Blob(chunks, { type: mimeRef.current }));
      };

      // 每 250ms 吐一次数据：长录时不会一次性把整段音频压在内存里
      recorder.start(250);
      setPhase('recording');

      tickRef.current = window.setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next >= maxSeconds) {
            // 到点自动停（onstop 里走转写流程）
            window.setTimeout(() => {
              if (recorderRef.current?.state === 'recording') {
                recorderRef.current.stop();
              }
            }, 0);
            return maxSeconds;
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      release();
      if (mountedRef.current) setPhase('idle');
      fail(err, 'acquire');
    }
  }, [fail, maxSeconds, onError, phase, ready, release, runTranscribe, supported]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      cancelledRef.current = false;
      recorder.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      cancelledRef.current = true;
      recorder.stop();
    } else {
      release();
      if (mountedRef.current) setPhase('idle');
    }
  }, [release]);

  // 卸载兜底：必须停轨，否则麦克风指示灯常亮（用户会以为在偷听）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        cancelledRef.current = true;
        recorder.stop();
      }
      // onstop 是异步的，这里同步释放一次，不依赖它
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      unsubLevelRef.current?.();
      unsubLevelRef.current = null;
      captureRef.current?.dispose();
      captureRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  return {
    phase,
    recording: phase === 'recording',
    transcribing: phase === 'transcribing',
    seconds,
    level,
    bands,
    supported,
    ready,
    start,
    stop,
    cancel,
  };
}
