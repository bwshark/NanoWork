import { useCallback, useEffect, useRef, useState } from 'react';
import { connectionManager } from '@/ai/connectionManager';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * 语音输入 Hook：封装 MediaRecorder 采集 + 转录回填。
 *
 * 生命周期：
 *   start() → 申请麦克风 → 录音（同时采集音量电平用于 UI 动效）
 *   stop()  → 停止采集 → 拿音频 Blob 调 client.transcribe() → onTranscript(文本)
 *   cancel()→ 停止采集但丢弃音频（用户主动放弃）
 *
 * 所有浏览器 API 缺失/拒绝授权的情况统一转成中文错误文案走 onError，
 * 组件侧只需 toast 提示，不必关心具体内核差异。
 */

/** 默认最大录制时长（秒）：超时自动停止并转录，避免忘记点停止导致内存堆积 */
const DEFAULT_MAX_SECONDS = 300;

/** 音量电平采样间隔（ms） */
const LEVEL_INTERVAL = 100;

/** 浏览器可编码的录音 MIME 候选，按优先级探测 */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export interface UseVoiceInputOptions {
  /** 转录成功回调：把文本回填到输入框光标处 */
  onTranscript: (text: string) => void;
  /** 失败回调（已转成人类可读文案） */
  onError?: (message: string) => void;
  /** 最大录制时长（秒） */
  maxSeconds?: number;
}

export interface UseVoiceInputResult {
  /** 正在录音 */
  recording: boolean;
  /** 录音已结束、正在转写 */
  transcribing: boolean;
  /** 已录制秒数（UI 计时展示） */
  seconds: number;
  /** 0~1 音量电平（UI 做脉冲/波形动效） */
  level: number;
  /** 当前环境是否支持录音（不支持时 UI 应直接禁用按钮） */
  supported: boolean;
  /** 开始录音；失败时通过 onError 上报 */
  start: () => Promise<void>;
  /** 停止并转写 */
  stop: () => void;
  /** 取消本次录音（不转写） */
  cancel: () => void;
}

/** 当前环境是否具备录音能力 */
export function isVoiceRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== 'undefined'
  );
}

/** 挑一个当前内核真正支持的编码格式（Safari / Chrome / Firefox 各不相同） */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** 由录音 MIME 推断上传文件扩展名（服务端据此判别音频格式） */
function extFromMime(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

/** 秒数格式化为 mm:ss */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/** 语音输入：录音 → 转写 → 文本回填 */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { onTranscript, onError, maxSeconds = DEFAULT_MAX_SECONDS } = options;

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [supported] = useState(() => isVoiceRecordingSupported());

  /** 麦克风流 / 录音器 / 数据块 */
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  /** 本次录音是否已被用户取消 */
  const cancelledRef = useRef(false);
  /** 计时器 / 音量采样器 */
  const tickRef = useRef<number | null>(null);
  const levelRef = useRef<number | null>(null);
  /** 音量分析链路 */
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** 是否已卸载（避免卸载后回调仍 setState） */
  const mountedRef = useRef(true);

  /** 释放麦克风与音频分析资源 */
  const releaseResources = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (levelRef.current !== null) {
      window.clearInterval(levelRef.current);
      levelRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    if (mountedRef.current) setLevel(0);
  }, []);

  /** 把音频送转录，成功后回填文本 */
  const runTranscribe = useCallback(
    async (blob: Blob) => {
      if (!mountedRef.current) return;
      setTranscribing(true);
      try {
        const client = await connectionManager.getClient();
        const { language } = useSettingsStore.getState().settings.transcription ?? {
          language: '',
        };
        const text = await client.transcribe({
          audio: blob,
          filename: `voice-${Date.now()}.${extFromMime(mimeRef.current)}`,
          ...(language.trim() !== '' ? { language: language.trim() } : {}),
        });
        if (!mountedRef.current) return;
        onTranscript(text);
      } catch (err) {
        if (!mountedRef.current) return;
        onError?.(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setTranscribing(false);
      }
    },
    [onError, onTranscript],
  );

  const start = useCallback(async () => {
    if (recording || transcribing) return;
    if (!supported) {
      onError?.('当前环境不支持录音（需要浏览器麦克风权限）');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      chunksRef.current = [];
      cancelledRef.current = false;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      mimeRef.current = recorder.mimeType || mimeType || 'audio/webm';
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        releaseResources();
        if (!mountedRef.current) return;
        setRecording(false);
        // 用户取消 / 无有效音频：直接收尾，不发起转录
        if (cancelledRef.current) {
          cancelledRef.current = false;
          return;
        }
        if (chunks.length === 0) {
          onError?.('没有录到声音，请重试');
          return;
        }
        const blob = new Blob(chunks, { type: mimeRef.current });
        void runTranscribe(blob);
      };

      // 每 250ms 吐一次数据，避免长录时一次性堆积在内存
      recorder.start(250);
      setSeconds(0);
      setRecording(true);

      // 计时：到点自动停止并转写
      tickRef.current = window.setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next >= maxSeconds) {
            // 到达上限：立即停（onstop 里会走转录流程）
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

      // 音量电平：用 AnalyserNode 采样时域波形求均方根
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (Ctor) {
          const ctx = new Ctor();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const buffer = new Uint8Array(analyser.frequencyBinCount);
          levelRef.current = window.setInterval(() => {
            analyser.getByteTimeDomainData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i += 1) {
              const v = (buffer[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / buffer.length);
            // 放大并截断到 0~1，便于 UI 直接当强度用
            if (mountedRef.current) setLevel(Math.min(1, rms * 3));
          }, LEVEL_INTERVAL);
        }
      } catch {
        // 音量分析只是锦上添花，失败不影响录音与转录
      }
    } catch (err) {
      releaseResources();
      const name = err instanceof DOMException ? err.name : '';
      const message =
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在浏览器/系统设置中允许后重试'
          : name === 'NotFoundError'
            ? '未检测到麦克风设备'
            : `无法开始录音：${err instanceof Error ? err.message : String(err)}`;
      onError?.(message);
    }
  }, [
    maxSeconds,
    onError,
    recording,
    releaseResources,
    runTranscribe,
    supported,
    transcribing,
  ]);

  /** 停止并转写 */
  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      cancelledRef.current = false;
      recorder.stop();
    }
  }, []);

  /** 取消：停止但丢弃音频 */
  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      cancelledRef.current = true;
      recorder.stop();
    } else {
      // 未在录音时调用：确保资源也被回收
      releaseResources();
      if (mountedRef.current) setRecording(false);
    }
  }, [releaseResources]);

  // 卸载时兜底清理：停止录音、释放麦克风与定时器
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        // 已卸载则无需转写，直接丢弃
        cancelledRef.current = true;
        recorder.stop();
      }
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      if (levelRef.current !== null) window.clearInterval(levelRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  return { recording, transcribing, seconds, level, supported, start, stop, cancel };
}
