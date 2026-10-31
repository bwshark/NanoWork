/**
 * 语音输入 Hook：**实时流式**识别（边说边出字）+ 非实时兜底。
 *
 * ## 两种模式
 * | 模式 | 触发条件 | 行为 |
 * |---|---|---|
 * | 实时 | provider 支持 realtime 协议且模型是 realtime 系 | 录音时每 100ms 送 PCM，服务端逐句回 `transcription.text`，文字**边录边进输入框** |
 * | 非实时 | 其它情况（whisper / SenseVoice / 百炼非实时） | 录完转 16kHz WAV 一次性提交，停止后一次回填 |
 *
 * ## 为什么实时模式要「边录边回填」而不是等录完
 * 视频里的目标行为就是这个：用户说话时文字持续增长。实现上有两个必须做对的点：
 * 1. **中间结果要能替换而不是追加**。服务端的 `text` 是「已定稿部分」、`stash` 是
 *    「当前这句的临时尾巴」，同一条会反复下发。若每次都 append，输入框会变成
 *    「你好你好你好…」。因此回填走 `onPartialText`（整体替换语义），由调用方
 *    维护一个「本次语音的草稿区」。
 * 2. **停止时只补最后一段**。commit 之后服务端会把未定稿的尾巴定稿，再发一条
 *    completed。所以 `stop()` 不重新提交音频，只等最终结果。
 *
 * ## 状态机
 * `idle | acquiring | connecting | recording | finishing`
 * - `connecting`：WS 握手 + `session.updated` 回执（实测必须等到它才能送音频，
 *   否则开头几片会被吞）。这段时间麦克风已经开了，但还没开始送流。
 * - `finishing`：已 commit，等最终文本。
 *
 * ## 卸载安全
 * 每个 await 之后都检查 `mountedRef`：`getUserMedia` 与 WS 握手都是异步的，
 * 用户在授权框弹出时切走页面是常态，不检查就会对着已卸载的组件 setState
 * （React 18 不报错，但麦克风**不会停**、WS 也不会关）。
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
import { openRealtimeAsr, toRealtimeUrl, type RealtimeAsrSession } from '@/lib/voice/realtime';
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

/** 显式状态机 */
export type VoicePhase =
  | 'idle'
  | 'acquiring'
  | 'connecting'
  | 'recording'
  | 'finishing'
  | 'transcribing';

export interface UseVoiceInputOptions {
  /**
   * 最终文本回调（**整体替换**语义）。
   *
   * 实时模式下会被多次调用：中间结果是「已说出的全部内容」，
   * 调用方应把它当作「本次语音草稿的最新全文」，而不是要追加的片段。
   */
  onTranscript: (text: string) => void;
  /**
   * 中间结果回调（仅实时模式）。语义同 `onTranscript`：**整体替换**。
   * 调用方通常实现为「把草稿区替换成这个文本」。
   */
  onPartial?: (text: string) => void;
  /** 失败回调（已转成人类可读文案） */
  onError?: (message: string, code: VoiceErrorCode) => void;
  /** 最大录制时长（秒） */
  maxSeconds?: number;
}

export interface UseVoiceInputResult {
  phase: VoicePhase;
  /** 兼容旧调用点：正在录音（含 connecting，因为麦克风已开） */
  recording: boolean;
  /** 兼容旧调用点：正在转写 / 收尾 */
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
  /** 当前是否走实时流式（UI 可据此显示「实时」标识） */
  realtime: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

/** 当前环境是否具备录音能力（保留旧导出名，供既有调用点与测试使用） */
export function isVoiceRecordingSupported(): boolean {
  return isRecordingSupported();
}

/**
 * 判断当前配置能否走实时协议。
 *
 * 两条都满足才算：
 * 1. provider 是 dashscope（目前只有它实现了 realtime 协议）；
 * 2. 模型名带 `realtime`。
 *
 * 名字带 `-streaming` 的**不算**：那是「整段音频 + SSE 流式返回」，
 * 不是边说边出字（实测 `qwen-audio-3.1-asr-flash-streaming` 走 chat 形态会 400）。
 */
export function canUseRealtime(provider: string, model: string): boolean {
  return provider === 'dashscope' && /realtime/i.test(model);
}

/** 语音输入：录音 → 转写 → 文本回填 */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const {
    onTranscript,
    onPartial,
    onError,
    maxSeconds = DEFAULT_MAX_SECONDS,
  } = options;

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [bands, setBands] = useState<number[]>(() =>
    new Array<number>(VOICE_BAR_COUNT).fill(0),
  );
  const [supported] = useState(() => isRecordingSupported());

  // 转录配置：只读当前值，不做响应式订阅——录音过程中用户改不了设置
  const transcription = useSettingsStore((s) => s.settings.transcription);
  const ready =
    transcription?.enabled === true && transcription.model.trim() !== '';
  const realtime = ready && canUseRealtime(transcription.provider, transcription.model);

  const captureRef = useRef<AudioCapture | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  /** 实时会话（非实时模式下为 null） */
  const rtRef = useRef<RealtimeAsrSession | null>(null);
  /** 本次录音是否已被取消（停止后不转写） */
  const cancelledRef = useRef(false);
  const tickRef = useRef<number | null>(null);
  const unsubLevelRef = useRef<(() => void) | null>(null);
  const unsubPcmRef = useRef<(() => void) | null>(null);
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
    unsubPcmRef.current?.();
    unsubPcmRef.current = null;
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

  /** 非实时：音频 → WAV → 转写 → 回填 */
  const runTranscribe = useCallback(
    async (raw: Blob) => {
      if (!mountedRef.current) return;
      setPhase('transcribing');
      try {
        const cfg = useSettingsStore.getState().settings.transcription;
        // 转 WAV 失败时回退原始格式：宁可「可能不支持」也不要「一定失败」
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

  /** 启动电平与计时（两种模式共用） */
  const startMeters = useCallback(
    (capture: AudioCapture) => {
      unsubLevelRef.current = capture.onLevels((freq) => {
        const stamp = Date.now();
        if (stamp - lastSampleRef.current < LEVEL_SAMPLE_MS) return;
        lastSampleRef.current = stamp;
        const raw = bandLevels(freq, VOICE_BAR_COUNT);
        const smoothed = smoothLevels(bandsRef.current, raw);
        bandsRef.current = smoothed;
        if (!mountedRef.current) return;
        setBands(smoothed);
        const avg = smoothed.reduce((sum, v) => sum + v, 0) / (smoothed.length || 1);
        setLevel(Math.min(1, avg));
      });

      setSeconds(0);
      tickRef.current = window.setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next >= maxSeconds) {
            // 到点自动停：实时模式走 stop（commit），非实时走 recorder.stop
            window.setTimeout(() => {
              if (rtRef.current) rtRef.current.finish();
              else if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
            }, 0);
            return maxSeconds;
          }
          return next;
        });
      }, 1000);
    },
    [maxSeconds],
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
      onError?.('未启用语音输入，请先到「设置 → 连接 → 语音输入」配置', 'unsupported');
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
      cancelledRef.current = false;
      startMeters(capture);

      if (realtime) {
        // —— 实时模式 ——
        const cfg = useSettingsStore.getState().settings.transcription;
        const url = toRealtimeUrl(cfg.endpoint, cfg.model, cfg.apiToken);
        setPhase('connecting');

        const rt = openRealtimeAsr({
          url,
          language: cfg.language,
          onPartial: (text) => {
            if (!mountedRef.current) return;
            // 中间结果：整体替换语义（见文件头「为什么中间结果要能替换」）
            onPartial?.(text);
          },
          onFinal: (text) => {
            if (!mountedRef.current) return;
            setPhase('idle');
            onTranscript(text);
          },
          onError: (message) => {
            if (!mountedRef.current) return;
            release();
            setPhase('idle');
            onError?.(message, 'transcribe');
          },
          onReady: () => {
            if (!mountedRef.current) return;
            setPhase('recording');
            // 服务端就绪后才开始送 PCM（见文件头「必须等回执」）
            const unsub = capture.onPcm((frame) => {
              rtRef.current?.push(frame);
            });
            unsubPcmRef.current = unsub;
          },
        });
        rtRef.current = rt;
        return;
      }

      // —— 非实时模式：MediaRecorder ——
      const mime = pickRecorderMime();
      const recorder = new MediaRecorder(
        capture.stream,
        mime ? { mimeType: mime } : undefined,
      );
      mimeRef.current = recorder.mimeType || mime || 'audio/webm';
      recorderRef.current = recorder;
      chunksRef.current = [];

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
    } catch (err) {
      release();
      rtRef.current?.abort();
      rtRef.current = null;
      if (mountedRef.current) setPhase('idle');
      fail(err, 'acquire');
    }
  }, [fail, maxSeconds, onError, onPartial, onTranscript, phase, ready, realtime, release, runTranscribe, startMeters, supported]);

  const stop = useCallback(() => {
    // 实时：commit + finish，等最终文本（不再重复提交音频）
    if (rtRef.current) {
      setPhase('finishing');
      unsubPcmRef.current?.();
      unsubPcmRef.current = null;
      rtRef.current.finish();
      release();
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      cancelledRef.current = false;
      recorder.stop();
    }
  }, [release]);

  const cancel = useCallback(() => {
    if (rtRef.current) {
      cancelledRef.current = true;
      rtRef.current.abort();
      rtRef.current = null;
      release();
      if (mountedRef.current) setPhase('idle');
      return;
    }
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
      rtRef.current?.abort();
      rtRef.current = null;
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      unsubLevelRef.current?.();
      unsubLevelRef.current = null;
      unsubPcmRef.current?.();
      unsubPcmRef.current = null;
      captureRef.current?.dispose();
      captureRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  return {
    phase,
    // connecting 也算「录音中」：麦克风已开、电平在动，UI 应显示计时与波形
    recording: phase === 'recording' || phase === 'connecting',
    transcribing: phase === 'transcribing' || phase === 'finishing',
    seconds,
    level,
    bands,
    supported,
    ready,
    realtime,
    start,
    stop,
    cancel,
  };
}
