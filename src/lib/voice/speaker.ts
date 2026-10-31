/**
 * 播报器：把一段回复念出来，并且**随时可被打断**。
 *
 * ## 为什么要有这一层（而不是在 hook 里直接 new Audio）
 * 「语音讨论」的核心体验是边听边说：用户一开口，AI 就得立刻闭嘴。
 * 这要求播放侧满足三条：
 * 1. **可取消**：`stop()` 后不能再有任何 `onEnd` 回调（否则状态机会误判成
 *    「播报结束，继续听」，把刚打断的那句话又还回去一半）；
 * 2. **可降级**：云端额度用尽时退回系统语音，而不是让 AI 变成哑巴；
 * 3. **按句排队**：单次合成上限 600 字符，长回复必须分句逐句合成，
 *    且下一句要在上一句播完前就开始合成（否则每句之间空 1~2 秒）。
 *
 * ## 取消令牌（generation token）而不是 AbortController 单飞
 * `fetch` 可以被 abort，但 `<audio>` 与 `speechSynthesis` 不能。
 * 用一个自增的 generation 号做「这一轮还算不算数」的唯一判据：
 * `stop()` 递增它，正在跑的循环在每个 await 之后比对，不等就静默退出。
 * 这样三条链路（fetch / audio / TTS utterance）共用一套取消语义。
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

export interface Speaker {
  /** 念一段文本（会打断上一段：讨论里同一时刻只该有一个声音） */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
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

export function createSpeaker(cfg: ResolvedTtsConfig): Speaker {
  /** 当前轮次；`stop()` 递增使进行中的循环作废 */
  let generation = 0;
  /** 当前段的可取消动作（audio / utterance） */
  let cancelCurrent: (() => void) | null = null;
  let speaking = false;
  /** 本次 speak 是否已经开始出声（决定 onStart 只报一次） */
  let started = false;

  const stop = () => {
    generation += 1;
    speaking = false;
    started = false;
    const cancel = cancelCurrent;
    cancelCurrent = null;
    cancel?.();
  };

  const speak = async (text: string, options: SpeakOptions = {}) => {
    const { onStart, onEnd, onNotice } = options;
    // 新的一段话先掐掉旧的：讨论里两个声音同时响是纯粹的 bug
    stop();
    const mine = generation + 1;
    generation = mine;
    const alive = () => generation === mine;
    if (!alive()) return;

    const segments = splitSpeech(text);
    if (segments.length === 0) return;
    started = false;
    speaking = true;
    let noticeSent = false;
    const notice = (msg: string) => {
      if (noticeSent) return;
      noticeSent = true;
      onNotice?.(msg);
    };

    let cloudOk = cfg.ready;

    for (const segment of segments) {
      if (!alive()) return;
      let played = false;

      if (cloudOk) {
        try {
          const audio = await synthesizeSpeech(segment, cfg);
          if (!alive()) return;
          played = await playAudio(audio, (cb) => {
            cancelCurrent = cb;
          });
          if (!alive()) return;
          cancelCurrent = null;
        } catch (err) {
          if (!alive()) return;
          // 云端失败：**本次讨论剩余部分**一律走系统语音，不再逐句重试。
          // 逐句重试会让每句话前都卡 1 秒，而且 90% 的失败是额度/鉴权，
          // 重试只是把同一个错误再犯一遍。
          cloudOk = false;
          notice(err instanceof Error ? err.message : String(err));
        }
      }

      if (!played && cfg.fallbackToSystem && systemSpeechAvailable()) {
        if (!started) {
          started = true;
          onStart?.();
        }
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
      if (!started) {
        started = true;
        onStart?.();
      }
    }

    if (!alive()) return;
    speaking = false;
    onEnd?.();
  };

  return {
    speak,
    stop,
    get speaking() {
      return speaking;
    },
  };
}
