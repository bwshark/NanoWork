/**
 * 播报器：把一段回复念出来，并且**随时可被打断**。
 *
 * ## 为什么要有这一层（而不是在 hook 里直接 new Audio）
 * 「语音讨论」的核心体验是边听边说：用户一开口，AI 就得立刻闭嘴。
 * 这要求播放侧满足四条：
 * 1. **可取消**：`stop()` 后不能再有任何 `onEnd` 回调（否则状态机会误判成
 *    「播报结束，继续听」，把刚打断的那句话又还回去一半）；
 * 2. **可降级**：云端额度用尽时退回系统语音，而不是让 AI 变成哑巴；
 * 3. **可流式**：模型还在生成时就该把已经成句的部分念出来。等全集生成完
 *    再开口，用户体感是「说完话要等好几秒」——而这几乎全部是白等；
 * 4. **按句排队**：单次合成上限 600 字符，长回复必须分句逐句合成。
 *
 * ## 取消令牌（generation token）而不是 AbortController 单飞
 * `fetch` 可以被 abort，但 `<audio>` 与 `speechSynthesis` 不能。
 * 用一个自增的 generation 号做「这一轮还算不算数」的唯一判据：
 * `stop()` 递增它，正在跑的循环在每个 await 之后比对，不等就静默退出。
 * 这样三条链路（fetch / audio / TTS utterance）共用一套取消语义。
 *
 * ## 两处曾经踩过的坑（改之前先读）
 * - **`cloudOk` 必须跨次记忆**：额度用尽 / 鉴权失败是账号级状态，
 *   一次失败后整场讨论都不该再试。每次重试的代价是每句话前白等一次
 *   网络往返（实测 1~3 秒），且它 99% 会以同样的错误失败。
 * - **不能等全文再开口**：`stream()` 让模型每凑出一句就开念，
 *   首句延迟从「生成完整段」降到「生成第一句」。
 */

import { splitSpeech, synthesizeSpeech, type ResolvedTtsConfig, type TtsAudio } from './tts';

export interface SpeakOptions {
  /** 真正开始出声（第一段音频开始播） */
  onStart?: () => void;
  /** 全部念完（被 `stop()` 打断时**不**触发） */
  onEnd?: () => void;
  /** 降级 / 失败的提示（只报一次，避免逐句刷屏） */
  onNotice?: (message: string) => void;
}

/**
 * 流式播报控制器：模型一边生成，调用方一边 `push`。
 *
 * `push` 的粒度由调用方决定（建议一整句），内部再按 TTS 上限切一次。
 */
export interface SpeakerStream {
  /** 追加要念的文本（可反复调用；`end()` 之后调用无效） */
  push: (text: string) => void;
  /** 不会再有新文本：队列念空后触发 `onEnd` */
  end: () => void;
}

export interface Speaker {
  /** 念一段文本（会打断上一段：讨论里同一时刻只该有一个声音） */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  /**
   * 流式播报：先拿到控制器，再陆续 `push` 句子。
   *
   * 与 `speak()` 的差别只在「什么时候算结束」——这里由 `end()` 决定，
   * 而 `speak()` 是一次性把整段塞进去后立即 `end()`。
   */
  stream: (options?: SpeakOptions) => SpeakerStream;
  /** 立刻静音并清空队列；不触发 `onEnd` */
  stop: () => void;
  /** 当前是否真的在出声 */
  readonly speaking: boolean;
}

/** 系统语音是否可用（Electron / Chromium 都有，Web 端部分环境没有） */
export function systemSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

/** 挑一个中文音色：`lang` 为 zh 的优先，其次用系统默认 */
function pickChineseVoice(): SpeechSynthesisVoice | null {
  if (!systemSpeechAvailable()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  return (
    voices.find((v) => /^zh[-_]CN/i.test(v.lang)) ??
    voices.find((v) => /^zh/i.test(v.lang)) ??
    null
  );
}

/**
 * 播放一段 URL / base64 音频，返回是否**完整播完**。
 *
 * ⚠️ 不能用 `new Audio()` 直接 `play()` 后靠 `ended` 收尾：用户 `stop()` 时
 * 我们 `pause()`，`ended` 永远不会来，Promise 会挂到天荒地老（表现为
 * 「打断后状态机卡在播报中」）。所以取消也要能 resolve —— 由调用方按
 * generation 判据丢弃这次结果。
 */
function playAudio(
  audio: TtsAudio,
  onCancel: (cb: () => void) => void,
): Promise<boolean> {
  const src = audio.url ?? (audio.data ? `data:audio/${audio.format ?? 'wav'};base64,${audio.data}` : '');
  if (src === '') return Promise.resolve(false);
  if (typeof Audio === 'undefined') return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const el = new Audio(src);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      // 释放：不 detach 的话 OSS 直链的 audio 元素会一直占着解码缓冲
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* 已销毁 */
      }
      resolve(ok);
    };
    el.onended = () => done(true);
    el.onerror = () => done(false);
    onCancel(() => done(false));
    void el.play().catch(() => done(false));
  });
}

/**
 * 系统语音播报一段文本，返回是否完整播完。
 *
 * Chromium 的 `speechSynthesis` 在**没有音色**时不报错也不出声（静默成功），
 * 所以这里不把 onend 当作「用户听到了」的证据——只用于串行排队。
 */
function playSystemSpeech(text: string, onCancel: (cb: () => void) => void): Promise<boolean> {
  if (!systemSpeechAvailable()) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickChineseVoice();
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang ?? 'zh-CN';
    utter.rate = 1.05;
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    utter.onend = () => done(true);
    utter.onerror = () => done(false);
    onCancel(() => {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      done(false);
    });
    try {
      window.speechSynthesis.speak(utter);
    } catch {
      done(false);
    }
  });
}

/** 待播报队列（播报途中可继续追加，这就是流式播报的全部机制） */
interface SpeechQueue {
  /** 已切好的片段，先进先出 */
  segments: string[];
  /** 不会再有新片段了（`end()` 之后为 true） */
  ended: boolean;
  /** 循环挂起时的唤醒函数：push / end / stop 都必须能叫醒它 */
  wake: (() => void) | null;
}

function createQueue(): SpeechQueue {
  return { segments: [], ended: false, wake: null };
}

/** 唤醒挂起的循环（只生效一次，之后清空） */
function signal(queue: SpeechQueue): void {
  const wake = queue.wake;
  queue.wake = null;
  wake?.();
}

export function createSpeaker(cfg: ResolvedTtsConfig): Speaker {
  /** 当前轮次；`stop()` 递增使进行中的循环作废 */
  let generation = 0;
  /** 当前段的可取消动作（audio / utterance） */
  let cancelCurrent: (() => void) | null = null;
  let speaking = false;
  /** 正在跑的队列：`stop()` 要靠它唤醒挂起的等待，否则循环永远挂着 */
  let active: SpeechQueue | null = null;

  /**
   * 云端合成是否可用。
   *
   * ⚠️ **跨次记忆**（不在每次 `speak` 里重置）：额度用尽 / 鉴权失败是账号级
   * 状态，一次失败后整场讨论都不该再试。每轮重试的代价是「每句话前白等一次
   * 网络往返」（实测 1~3 秒），而且它 99% 会以同一个错误失败——云端额度用尽
   * 的用户每一轮都要先付这笔钱才降级到系统语音，这正是「说完话要等好久」的
   * 主要来源。下次讨论会新建 speaker，届时重新判定。
   */
  let cloudOk = cfg.ready;

  const stop = () => {
    generation += 1;
    speaking = false;
    const cancel = cancelCurrent;
    cancelCurrent = null;
    cancel?.();
    // 叫醒正在 `waitForWork` 的循环：它会看到 generation 变了然后退出，
    // 不唤醒就会留下一个永远挂着的 Promise（每轮泄漏一个）
    if (active) signal(active);
  };

  /** 播放循环：从队列取片段 → 合成 → 播；队列空且未 end 时挂起等待 */
  const run = async (
    queue: SpeechQueue,
    mine: number,
    options: SpeakOptions,
  ): Promise<void> => {
    const { onStart, onEnd, onNotice } = options;
    const alive = () => generation === mine;
    let started = false;
    let noticeSent = false;
    const notice = (message: string) => {
      if (noticeSent) return;
      noticeSent = true;
      onNotice?.(message);
    };

    const markStarted = () => {
      if (started) return;
      started = true;
      onStart?.();
    };

    for (;;) {
      if (!alive()) return;
      const segment = queue.segments.shift();
      if (segment === undefined) {
        if (queue.ended) break;
        // 流式：这段已念完，下一句模型还没生成出来 —— 挂起等 push
        await new Promise<void>((resolve) => {
          queue.wake = resolve;
        });
        continue;
      }

      let played = false;

      if (cloudOk) {
        try {
          const audio = await synthesizeSpeech(segment, cfg);
          if (!alive()) return;
          markStarted();
          played = await playAudio(audio, (cb) => {
            cancelCurrent = cb;
          });
          if (!alive()) return;
          cancelCurrent = null;
        } catch (err) {
          if (!alive()) return;
          // 云端失败：**本次讨论剩余部分**一律走系统语音，不再逐句重试。
          // 逐句重试会让每句话前都卡 1~3 秒，而且 90% 的失败是额度/鉴权，
          // 重试只是把同一个错误再犯一遍。
          cloudOk = false;
          notice(err instanceof Error ? err.message : String(err));
        }
      }

      if (!played && cfg.fallbackToSystem && systemSpeechAvailable()) {
        if (!alive()) return;
        markStarted();
        played = await playSystemSpeech(segment, (cb) => {
          cancelCurrent = cb;
        });
        if (!alive()) return;
        cancelCurrent = null;
      }

      // 云端与系统都播不出来：继续尝试下一句没有意义（同样的原因只会再失败一次）。
      // 但**仍然要收尾**——不调 onEnd 会让状态机永远停在「播报中」，
      // 表现为「AI 不说话也不听你说话」，比静默降级严重得多。
      if (!played) break;
    }

    if (!alive()) return;
    if (active === queue) active = null;
    speaking = false;
    onEnd?.();
  };

  /** 开一轮新的播报（打断上一轮） */
  const begin = (options: SpeakOptions): { queue: SpeechQueue; mine: number } => {
    stop();
    const mine = generation;
    const queue = createQueue();
    active = queue;
    speaking = true;
    return { queue, mine };
  };

  const speak = async (text: string, options: SpeakOptions = {}) => {
    const segments = splitSpeech(text);
    if (segments.length === 0) {
      // 空文本也要打断上一段：调用方的语义是「这一轮没有话要说了」，
      // 留着上一句继续响会让用户以为 AI 在自说自话
      stop();
      return;
    }
    const { queue, mine } = begin(options);
    queue.segments.push(...segments);
    queue.ended = true;
    await run(queue, mine, options);
  };

  const stream = (options: SpeakOptions = {}): SpeakerStream => {
    const { queue, mine } = begin(options);
    void run(queue, mine, options);
    const alive = () => generation === mine;
    return {
      push: (text) => {
        if (!alive() || queue.ended) return;
        const segments = splitSpeech(text);
        if (segments.length === 0) return;
        queue.segments.push(...segments);
        signal(queue);
      },
      end: () => {
        if (!alive()) return;
        queue.ended = true;
        signal(queue);
      },
    };
  };

  return {
    speak,
    stream,
    stop,
    get speaking() {
      return speaking;
    },
  };
}
