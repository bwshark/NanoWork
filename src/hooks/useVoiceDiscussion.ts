/**
 * 语音讨论：把「按住说话 — 说完就答 — 边听边说」做成一个可反复轮转的状态机。
 *
 * ## 与「语音输入」的区别（为什么不能复用 `useVoiceInput`）
 * | | 语音输入 | 语音讨论 |
 * |---|---|---|
 * | 分段 | 用户点按钮分（一整段话） | 客户端静音断句（一句一提交） |
 * | 结果去哪 | 输入框草稿 | 直接发给模型 |
 * | 麦克风 | 录完就关 | 全程开着（要能随时打断播报） |
 * | 收尾 | 交文本 | 生成纪要并落会话 |
 * 共用的是底层（`capture` / `realtime` / `levels`），不是状态机。
 *
 * ## 状态机
 * ```
 * starting → listening ──(静音断句)──→ thinking ──(回复完)──→ speaking
 *                ↑                                              │
 *                └────────────(播完 / 用户插话打断)──────────────┘
 * ```
 * - `listening`：麦克风在送音频，实时识别在出**中间结果**（面板只显示，不发送）。
 * - `thinking`：已提交，等最终文本回来 + 模型流式回复。此**不**开新的识别会话
 *   ——否则用户的下一句会和上一轮的回复抢同一个回合，两条流互相打断。
 * - `speaking`：TTS 播报中，同时**已开好**下一轮识别（否则打断要等 300ms 握手，
 *   用户会觉得「我说了但它没停」）。
 *
 * ## 打断的两条判据
 * 1. 用户开口（`TurnSignal === 'start'`）→ 立刻 `speaker.stop()`。
 * 2. 播报期间 VAD 用 `BARGE_IN_PROFILE`（更高门槛）：否则麦克风收到自己的
 *    外放就会一直自我打断。
 *
 * ## 卸载安全
 * 每个 await 之后都检查 `alive`：`getUserMedia`、WS 握手、模型流都是异步的，
 * 用户随时可能关掉面板。漏检的后果是**麦克风不停**（用户以为在偷听）与
 * 对着已卸载组件 setState。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { connectionManager } from '@/ai/connectionManager';
import { genId } from '@/lib/core/id';
import { acquireMicrophone, isRecordingSupported, type AudioCapture } from '@/lib/voice/capture';
import { describeVoiceError } from '@/lib/voice/errors';
import { bandLevels, smoothLevels, VOICE_BAR_COUNT } from '@/lib/voice/levels';
import { openRealtimeAsr, toRealtimeUrl, type RealtimeAsrSession } from '@/lib/voice/realtime';
import { createSpeaker, type Speaker } from '@/lib/voice/speaker';
import { resolveTtsConfig } from '@/lib/voice/tts';
import { BARGE_IN_PROFILE, createTurnDetector, type TurnDetector } from '@/lib/voice/vad';
import { canUseRealtime } from '@/hooks/useVoiceInput';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ChatMessageParam } from '@/types';

/** 讨论状态（`idle` = 面板关闭） */
export type VoiceDiscussionPhase =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  /** 已结束，正在整理纪要（面板还开着，给用户一个明确的「在处理」） */
  | 'ending';

/** 面板里的一条对话（不是会话消息，讨论结束才落一条纪要） */
export interface DiscussionTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 助手还在流式生成 */
  streaming?: boolean;
}

/** 讨论所依赖的会话上下文（由 Composer 传入，与当前会话保持一致） */
export interface VoiceDiscussionContext {
  agentId: string;
  /** 预设名；空 = 引擎默认模型 */
  model?: string;
  workspace?: string;
  fullAccess?: boolean;
  /** 专家人设：让讨论口吻与主对话一致 */
  persona?: string;
  /** 主对话的最近几条消息（讨论要能接上「我们刚才在聊什么」） */
  history?: ChatMessageParam[];
  /** 与主对话同一份工具黑名单（`toolAllow` 恒为空数组，讨论不执行任何工具） */
  toolDeny?: string[];
}

/** 结束时的纪要素材（落库由调用方负责，见 `sessionsStore.appendVoiceDiscussionRecord`） */
export interface VoiceDiscussionResult {
  durationMs: number;
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** 模型整理的摘要；失败时为空串，落库侧有本地兜底 */
  summary: string;
}

export interface UseVoiceDiscussionOptions {
  context: VoiceDiscussionContext;
  /** 结束时回调（**面板在此之后关闭**：`phase` 回到 idle） */
  onFinish?: (result: VoiceDiscussionResult) => void;
  /** 需要用户知道的问题（麦克风不可用、识别失败…） */
  onError?: (message: string) => void;
  /** 降级提示（云端合成失败改用系统语音等），不打断讨论 */
  onNotice?: (message: string) => void;
}

export interface UseVoiceDiscussionResult {
  phase: VoiceDiscussionPhase;
  /** 面板是否应该打开 */
  open: boolean;
  seconds: number;
  /** 0~1 电平（点阵环用） */
  level: number;
  turns: DiscussionTurn[];
  /** 当前这句的中间识别结果（边说边出字） */
  liveText: string;
  muted: boolean;
  /** 字幕开关（默认关：只看点阵环，与参考视频一致） */
  subtitles: boolean;
  /** 已降级 / 需要提示的一行说明 */
  notice: string | null;
  /** 当前环境能否开讨论（麦克风 + 实时识别模型都就绪） */
  supported: boolean;
  /** 不能开的原因（`supported` 为 false 时的 tooltip 文案） */
  blockedReason: string | null;
  start: () => Promise<void>;
  /** 结束并生成纪要 */
  finish: () => Promise<void>;
  /** 直接关掉，不生成纪要（× 关闭 / Esc） */
  cancel: () => void;
  toggleMute: () => void;
  setSubtitles: (next: boolean) => void;
}

/** 讨论轮次上限：防止离开时对话无限长（上下文与界面都会失控） */
const MAX_TURNS = 40;

/** 电平上报给 UI 的节流间隔（ms）：与语音输入的波形同一档 */
const LEVEL_UI_MS = 66;

/** 讨论的系统提示词 */
function buildSystemPrompt(persona?: string): string {
  const lines = [
    '你正在和用户进行**实时语音讨论**（不是文字聊天）。',
    '要求：',
    '1. 口语化、简短：每次回复控制在 2~3 句（约 80 字以内），像面对面说话。',
    '2. 不要输出 Markdown 标题、列表、表格、代码块或表情符号——这段话会被念出来。',
    '3. 不要调用任何工具，也不要声称已经执行了操作。需要动手时，告诉用户「结束后我来做」。',
    '4. 用户可能在你说话时插话打断：被插话就顺着新话题继续，不要重复被打断的内容。',
    '5. 用户没听清会追问，回答要能独立成立（不要用「上面那个」这类指代）。',
  ];
  if (persona && persona.trim() !== '') {
    lines.push('', '你的人设：', persona.trim());
  }
  return lines.join('\n');
}

/** 纪要提示词：要求短、有结论、可执行 */
const SUMMARY_PROMPT = [
  '把刚才这段语音讨论整理成纪要，用中文，不要客套话。',
  '输出两段：',
  '第一段「讨论内容」：3~5 句话，说明讨论了什么、结论是什么、有没有待办。',
  '第二段「待办」：如果有明确的下一步就逐条列出（最多 3 条）；没有就写「无」。',
  '总长度不超过 400 字。不要重复原话，不要加标题以外的格式。',
].join('\n');

/** 摘要兜底：模型不可用时至少留下「聊了什么、几轮」 */
export function fallbackSummary(turns: Array<{ role: string; text: string }>): string {
  const said = turns.filter((t) => t.role === 'user').map((t) => t.text.trim()).filter(Boolean);
  if (said.length === 0) return '';
  const first = said[0].length > 80 ? `${said[0].slice(0, 80)}…` : said[0];
  return `本次共 ${said.length} 轮发言。用户主要提到：${first}`;
}

export function useVoiceDiscussion(
  options: UseVoiceDiscussionOptions,
): UseVoiceDiscussionResult {
  const { context, onFinish, onError, onNotice } = options;

  const [phase, setPhase] = useState<VoiceDiscussionPhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [turns, setTurns] = useState<DiscussionTurn[]>([]);
  const [liveText, setLiveText] = useState('');
  const [muted, setMuted] = useState(false);
  const [subtitles, setSubtitlesState] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [supported] = useState(() => isRecordingSupported());

  const transcription = useSettingsStore((s) => s.settings.transcription);
  const realtimeReady =
    transcription?.enabled === true &&
    canUseRealtime(transcription.provider, transcription.model);
  const ready = supported && realtimeReady;
  const blockedReason = !supported
    ? '当前环境不支持录音（需要麦克风权限）'
    : !realtimeReady
      ? '语音讨论需要实时识别模型（设置 → 连接 → 语音输入，选择带 realtime 的模型）'
      : null;

  // —— 命令式资源（不进 state：每 100ms 变一次的东西进 state 会让整块面板重渲染） ——
  const phaseRef = useRef<VoiceDiscussionPhase>('idle');
  const captureRef = useRef<AudioCapture | null>(null);
  const asrRef = useRef<RealtimeAsrSession | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const detectorRef = useRef<TurnDetector | null>(null);
  const unsubLevelRef = useRef<(() => void) | null>(null);
  const unsubPcmRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  /** 面板代次：每次 start / cancel 递增，异步回调据此判断「还属于这次讨论吗」 */
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const mutedRef = useRef(false);
  const turnsRef = useRef<DiscussionTurn[]>([]);
  const startedAtRef = useRef(0);
  /** 讨论专用会话 id：给 `client.abort` 寻址，与主会话完全隔离 */
  const chatSessionRef = useRef<string | null>(null);
  /** 模型回合是否在流式中（结束时要 abort） */
  const streamingRef = useRef(false);
  const levelsRef = useRef<number[]>(new Array<number>(VOICE_BAR_COUNT).fill(0));
  const lastUiRef = useRef(0);
  /** 提示只报一次（降级/额度），否则每句都弹 */
  const noticedRef = useRef(false);
  const contextRef = useRef(context);
  contextRef.current = context;

  /**
   * 三个「前向引用」的持有者。
   *
   * `openAsr` / `handleFinal` / `finish` 互相调用（识别回来要提交、提交要开麦、
   * 轮次超限要收尾），而它们又都用 `useCallback` 保证引用稳定。直接互相引用
   * 会踩 TDZ（渲染期读未初始化的 const）。用 ref 转一手，赋值在各自定义之后。
   */
  const openAsrRef = useRef<(() => void) | null>(null);
  const handleFinalRef = useRef<((sessionId: string, text: string) => void) | null>(null);
  const finishRef = useRef<(() => Promise<void>) | null>(null);

  const setPhaseSafe = useCallback((next: VoiceDiscussionPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }, []);

  const pushTurn = useCallback((turn: DiscussionTurn) => {
    turnsRef.current = [...turnsRef.current, turn];
    if (mountedRef.current) setTurns(turnsRef.current);
  }, []);

  const updateTurn = useCallback((id: string, patch: Partial<DiscussionTurn>) => {
    turnsRef.current = turnsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t));
    if (mountedRef.current) setTurns(turnsRef.current);
  }, []);

  const notify = useCallback(
    (message: string) => {
      if (noticedRef.current) return;
      noticedRef.current = true;
      if (mountedRef.current) setNotice(message);
      onNotice?.(message);
    },
    [onNotice],
  );

  /** 断开识别会话（不带状态变化；调用方决定 phase） */
  const closeAsr = useCallback(() => {
    unsubPcmRef.current?.();
    unsubPcmRef.current = null;
    const asr = asrRef.current;
    asrRef.current = null;
    asr?.abort();
  }, []);

  const teardown = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    unsubLevelRef.current?.();
    unsubLevelRef.current = null;
    closeAsr();
    speakerRef.current?.stop();
    speakerRef.current = null;
    captureRef.current?.dispose();
    captureRef.current = null;
    detectorRef.current = null;
    levelsRef.current = new Array<number>(VOICE_BAR_COUNT).fill(0);
    const sessionId = chatSessionRef.current;
    chatSessionRef.current = null;
    if (sessionId && streamingRef.current) {
      streamingRef.current = false;
      void connectionManager.getClient().then((c) => c.abort(sessionId)).catch(() => undefined);
    }
  }, [closeAsr]);

  /** 模型回合：把讨论历史送给引擎，流式回填到最后一条助手气泡 */
  const ask = useCallback(
    async (sessionId: string, messages: ChatMessageParam[]): Promise<string> => {
      const client = await connectionManager.getClient();
      if (chatSessionRef.current !== sessionId) return '';
      const assistantId = genId();
      pushTurn({ id: assistantId, role: 'assistant', text: '', streaming: true });
      let acc = '';
      let failure: string | null = null;
      streamingRef.current = true;
      try {
        await client.chat(
          {
            agentId: contextRef.current.agentId,
            messages,
            stream: true,
            sessionId,
            // 模型：与当前会话一致；空则省略，由引擎用默认预设
            ...(contextRef.current.model ? { model: contextRef.current.model } : {}),
            ...(contextRef.current.workspace ? { workspace: contextRef.current.workspace } : {}),
            ...(contextRef.current.fullAccess ? { accessMode: 'full' as const } : {}),
            // 讨论不执行任何工具：`toolAllow: []` = 一个都不许（与 undefined 语义相反）
            toolAllow: [],
            ...(contextRef.current.toolDeny && contextRef.current.toolDeny.length > 0
              ? { toolDeny: contextRef.current.toolDeny }
              : {}),
            sessionMode: 'craft',
          },
          {
            onToken: (chunk) => {
              acc += chunk;
              if (chatSessionRef.current !== sessionId) return;
              updateTurn(assistantId, { text: acc });
            },
            onToolCall: () => undefined,
            onArtifact: () => undefined,
            onStatus: () => undefined,
            onDone: () => undefined,
            onError: (err) => {
              failure = err.message;
            },
          },
        );
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        streamingRef.current = false;
        updateTurn(assistantId, { streaming: false });
      }
      if (chatSessionRef.current !== sessionId) return acc;
      if (failure) {
        notify(`回复失败：${failure}`);
        // 失败的半截回复不留在气泡里（用户会以为 AI 就是这么说的）
        turnsRef.current = turnsRef.current.filter((t) => t.id !== assistantId);
        if (mountedRef.current) setTurns(turnsRef.current);
        return '';
      }
      return acc;
    },
    [notify, pushTurn, updateTurn],
  );

  /** 结束一轮后的播报 + 开启下一轮监听 */
  const speakAndListen = useCallback(
    (sessionId: string, text: string) => {
      const speaker = speakerRef.current;
      if (chatSessionRef.current !== sessionId) return;
      // 先把麦开好：打断要在用户开口那一刻生效，等播报结束才连就晚了 300ms
      if (!mutedRef.current) openAsrRef.current?.();
      if (!text.trim() || !speaker) {
        setPhaseSafe('listening');
        return;
      }
      detectorRef.current?.configure(BARGE_IN_PROFILE);
      setPhaseSafe('speaking');
      void speaker.speak(text, {
        onEnd: () => {
          if (chatSessionRef.current !== sessionId) return;
          detectorRef.current?.configure(null);
          setPhaseSafe('listening');
        },
        onNotice: (message) => notify(message),
      });
    },
    [notify, setPhaseSafe],
  );

  /** 识别结果落地：入气泡 → 问模型 → 播报 */
  const handleFinal = useCallback(
    (sessionId: string, text: string) => {
      if (chatSessionRef.current !== sessionId) return;
      if (mountedRef.current) setLiveText('');
      const clean = text.trim();
      detectorRef.current?.reset();
      if (clean === '') {
        // 只识别到噪声：不算一轮，继续听
        if (!mutedRef.current) openAsrRef.current?.();
        setPhaseSafe('listening');
        return;
      }
      pushTurn({ id: genId(), role: 'user', text: clean });
      if (turnsRef.current.length > MAX_TURNS) {
        notify(`本次讨论已进行 ${MAX_TURNS} 轮，建议结束并生成纪要`);
        void finishRef.current?.();
        return;
      }
      setPhaseSafe('thinking');
      const messages: ChatMessageParam[] = [
        { role: 'system', content: buildSystemPrompt(contextRef.current.persona) },
        ...(contextRef.current.history ?? []),
        ...turnsRef.current.map((t) => ({ role: t.role, content: t.text })),
      ];
      void ask(sessionId, messages).then((reply) => speakAndListen(sessionId, reply));
    },
    [ask, notify, pushTurn, setPhaseSafe, speakAndListen],
  );

  handleFinalRef.current = handleFinal;

  /**
   * 开一轮识别会话。
   *
   * 每次提交后都会**新开一个** WS：现有实时协议在 `session.finish` 之后
   * 会话即结束（实测只回 completed 再无下文），复用同一连接继续 append
   * 的行为没有任何文档背书，不值得为省 300ms 冒「第二句永远不返回」的险。
   */
  const openAsr = useCallback(() => {
    const gen = genRef.current;
    const capture = captureRef.current;
    if (!capture || mutedRef.current) return;
    closeAsr();
    const cfg = useSettingsStore.getState().settings.transcription;
    const url = toRealtimeUrl(cfg.endpoint, cfg.model, cfg.apiToken);
    const sessionId = chatSessionRef.current;
    if (!sessionId) return;

    const asr = openRealtimeAsr({
      url,
      language: cfg.language,
      onPartial: (text) => {
        if (gen !== genRef.current) return;
        // 中间结果整体替换（同一条会反复下发，追加会变成「你好你好你好」）
        if (mountedRef.current) setLiveText(text);
      },
      onFinal: (text) => {
        if (gen !== genRef.current) return;
        asrRef.current = null;
        unsubPcmRef.current?.();
        unsubPcmRef.current = null;
        handleFinalRef.current?.(sessionId, text);
      },
      onError: (message) => {
        if (gen !== genRef.current) return;
        asrRef.current = null;
        unsubPcmRef.current?.();
        unsubPcmRef.current = null;
        if (mountedRef.current) setLiveText('');
        notify(message);
        // 识别链路断了：退回「监听中」，让用户再说一次（而不是整场讨论报废）
        setPhaseSafe('listening');
        window.setTimeout(() => {
          if (gen === genRef.current && !mutedRef.current) openAsrRef.current?.();
        }, 600);
      },
      onReady: () => {
        if (gen !== genRef.current) return;
        // 服务端就绪后才灌音频（早了开头几片会被吞，见 realtime.ts 文件头）
        unsubPcmRef.current = capture.onPcm((frame) => {
          asrRef.current?.push(frame);
        });
      },
    });
    asrRef.current = asr;
  }, [closeAsr, notify, setPhaseSafe]);

  openAsrRef.current = openAsr;

  /** 提交当前这句（停止送音频 → commit → 等最终文本） */
  const commit = useCallback(() => {
    const asr = asrRef.current;
    if (!asr) return;
    asrRef.current = null;
    unsubPcmRef.current?.();
    unsubPcmRef.current = null;
    setPhaseSafe('thinking');
    asr.finish();
  }, [setPhaseSafe]);

  /** 电平 → VAD → 起说/说完 */
  const onFrame = useCallback(
    (freq: number[]) => {
      const raw = bandLevels(freq, VOICE_BAR_COUNT);
      // 峰值而不是均值：一句话的能量集中在少数频段，均值会被其余静音段稀释，
      // 结果是「在说话但检测不到」（与波形条取峰值是同一个理由）
      const peak = raw.reduce((max, v) => (v > max ? v : max), 0);
      const now = Date.now();

      const smoothed = smoothLevels(levelsRef.current, raw);
      levelsRef.current = smoothed;
      if (now - lastUiRef.current >= LEVEL_UI_MS) {
        lastUiRef.current = now;
        const avg = smoothed.reduce((sum, v) => sum + v, 0) / (smoothed.length || 1);
        if (mountedRef.current) setLevel(Math.min(1, avg * 1.5));
      }

      if (mutedRef.current) return;
      const detector = detectorRef.current;
      if (!detector) return;
      const signal = detector.push(peak, now);
      if (signal === 'start') {
        // 播报中被用户开口打断：立刻闭嘴，识别会话本来就在跑，继续用
        if (phaseRef.current === 'speaking') {
          speakerRef.current?.stop();
          detector.configure(null);
          setPhaseSafe('listening');
        }
        return;
      }
      if (signal === 'end') {
        const p = phaseRef.current;
        if (p === 'listening' || p === 'speaking') {
          if (p === 'speaking') speakerRef.current?.stop();
          commit();
        }
      }
    },
    [commit, setPhaseSafe],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle') return;
    if (!supported) {
      onError?.('当前环境不支持录音（需要麦克风权限）');
      return;
    }
    if (!realtimeReady) {
      onError?.(blockedReason ?? '语音讨论需要实时识别模型');
      return;
    }
    const gen = genRef.current + 1;
    genRef.current = gen;
    noticedRef.current = false;
    turnsRef.current = [];
    if (mountedRef.current) {
      setTurns([]);
      setLiveText('');
      setNotice(null);
      setLevel(0);
      setSeconds(0);
    }
    setPhaseSafe('starting');

    try {
      const capture = await acquireMicrophone();
      if (gen !== genRef.current || !mountedRef.current) {
        capture.dispose();
        return;
      }
      captureRef.current = capture;
      detectorRef.current = createTurnDetector();
      mutedRef.current = false;
      if (mountedRef.current) setMuted(false);

      const ttsCfg = resolveTtsConfig(useSettingsStore.getState().settings);
      speakerRef.current = createSpeaker(ttsCfg);
      if (!ttsCfg.ready) {
        notify(
          ttsCfg.enabled
            ? '云端语音合成未就绪（缺地址或 Key），已改用系统语音播报'
            : '未启用云端语音合成，已改用系统语音播报',
        );
      }

      unsubLevelRef.current = capture.onLevels((freq) => {
        if (gen !== genRef.current) return;
        onFrame(freq);
      });

      startedAtRef.current = Date.now();
      timerRef.current = window.setInterval(() => {
        if (!mountedRef.current) return;
        setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 1000);

      chatSessionRef.current = `voice-discussion:${genId()}`;
      openAsrRef.current?.();
      setPhaseSafe('listening');
    } catch (err) {
      const info = describeVoiceError(err, 'acquire');
      teardown();
      genRef.current += 1;
      setPhaseSafe('idle');
      onError?.(info.message);
    }
  }, [blockedReason, notify, onError, onFrame, realtimeReady, setPhaseSafe, supported, teardown]);

  /** 生成纪要（失败返回空串，落库侧有本地兜底） */
  const summarize = useCallback(
    async (sessionId: string, collected: Array<{ role: 'user' | 'assistant'; text: string }>) => {
      const client = await connectionManager.getClient();
      if (chatSessionRef.current !== sessionId) return '';
      const messages: ChatMessageParam[] = [
        { role: 'system', content: SUMMARY_PROMPT },
        ...collected.map((t) => ({ role: t.role, content: t.text })),
      ];
      let acc = '';
      try {
        await client.chat(
          {
            agentId: contextRef.current.agentId,
            messages,
            stream: true,
            // 纪要单独一个会话键：与讨论正文分开，abort 时互不牵连
            sessionId: `${sessionId}:summary`,
            ...(contextRef.current.model ? { model: contextRef.current.model } : {}),
            ...(contextRef.current.workspace ? { workspace: contextRef.current.workspace } : {}),
            toolAllow: [],
            sessionMode: 'craft',
          },
          {
            onToken: (chunk) => {
              acc += chunk;
            },
            onToolCall: () => undefined,
            onArtifact: () => undefined,
            onStatus: () => undefined,
            onDone: () => undefined,
            // 摘要允许失败（落库侧有本地兜底），但不能把半截流当成完整摘要。
            onError: () => {
              acc = '';
            },
          },
        );
      } catch {
        return '';
      }
      return acc.trim();
    },
    [],
  );

  const finish = useCallback(async () => {
    const current = phaseRef.current;
    if (current === 'idle' || current === 'ending') return;
    const sessionId = chatSessionRef.current;
    const collected = turnsRef.current.filter((t) => t.text.trim() !== '');
    const durationMs = startedAtRef.current > 0 ? Date.now() - startedAtRef.current : 0;
    // 先停麦停播报：纪要生成期间不该继续听（用户以为还在讨论）
    unsubLevelRef.current?.();
    unsubLevelRef.current = null;
    closeAsr();
    speakerRef.current?.stop();
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    detectorRef.current = null;

    if (!collected.some((t) => t.role === 'user') || !sessionId) {
      // 一句话都没说：不生成纪要（一条空纪要是纯噪音）
      teardown();
      genRef.current += 1;
      setPhaseSafe('idle');
      return;
    }

    setPhaseSafe('ending');
    const summary = await summarize(
      sessionId,
      collected.map((t) => ({ role: t.role, text: t.text })),
    );
    teardown();
    genRef.current += 1;
    onFinish?.({
      durationMs,
      turns: collected.map((t) => ({ role: t.role, text: t.text })),
      summary,
    });
    setPhaseSafe('idle');
    if (mountedRef.current) {
      setTurns([]);
      setLiveText('');
      setNotice(null);
      setSeconds(0);
      setLevel(0);
    }
  }, [closeAsr, onFinish, setPhaseSafe, summarize, teardown]);

  finishRef.current = finish;

  const cancel = useCallback(() => {
    teardown();
    genRef.current += 1;
    turnsRef.current = [];
    if (mountedRef.current) {
      setTurns([]);
      setLiveText('');
      setNotice(null);
      setSeconds(0);
      setLevel(0);
      setMuted(false);
    }
    mutedRef.current = false;
    setPhaseSafe('idle');
  }, [setPhaseSafe, teardown]);

  const toggleMute = useCallback(() => {
    if (phaseRef.current === 'idle' || phaseRef.current === 'ending') return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    if (mountedRef.current) setMuted(next);
    if (next) {
      // 静音 = 断掉识别会话（只停送音频不够：服务端会把沉默当一句话的尾巴，
      // 解锁后第一句拿到的是「半句话」）
      closeAsr();
      detectorRef.current?.reset();
      if (mountedRef.current) setLiveText('');
    } else {
      detectorRef.current?.reset();
      // 播报中解锁：只开麦不抢 phase（播报还没结束）
      if (phaseRef.current !== 'speaking') setPhaseSafe('listening');
      openAsrRef.current?.();
    }
  }, [closeAsr, setPhaseSafe]);

  const setSubtitles = useCallback((next: boolean) => {
    setSubtitlesState(next);
  }, []);

  // 卸载兜底：不停轨会让麦克风指示灯常亮（用户会以为应用在偷听）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
      genRef.current += 1;
    };
  }, [teardown]);

  return {
    phase,
    open: phase !== 'idle',
    seconds,
    level,
    turns,
    liveText,
    muted,
    subtitles,
    notice,
    supported: ready,
    blockedReason,
    start,
    finish,
    cancel,
    toggleMute,
    setSubtitles,
  };
}
