/**
 * 语音合成（TTS）：配置解析 + 请求形状 + 分句 + 响应解析。
 *
 * ## 协议（实测确认，不是照 OpenAI 文档猜的）
 * 百炼的合成**没有** OpenAI 兼容的 `/audio/speech`——用本机工作区地址实测
 * `POST .../compatible-mode/v1/audio/speech` 回 **404 空体**（与 `/audio/transcriptions`
 * 是同一个坑：兼容层只做了 chat / models）。真正的非流式合成走：
 *
 * ```
 * POST https://{workspace}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 * Authorization: Bearer <key>
 * { "model": "qwen3-tts-flash",
 *   "input": { "text": "要说的话", "voice": "Cherry", "language_type": "Chinese" } }
 * → { "output": { "audio": { "url": "https://dashscope-result.../x.wav" } } }
 * ```
 *
 * 三个必须照做的细节：
 * 1. 返回的是 **OSS 直链（24 小时有效）**，不是音频字节，也不是 base64；
 *    播放侧必须按 URL 拿（`<audio>` 不需要 CORS，`fetch` 才需要）。
 * 2. 单次输入上限 **600 字符**（超了直接 400），所以长回复必须先分句再逐句合成。
 * 3. 额度错误是 `AllocationQuota.FreeTierOnly`（本机三个 TTS 模型全部命中），
 *    与「协议写错」的补救动作完全不同：前者要充值/换模型，后者要改代码。
 *    错误文案必须能分清这两件事。
 *
 * ## 为什么不把请求塞进 `transcribe.ts`
 * 那个文件是「音频 → 文字」的四种请求形状（multipart / SSE / chat …），
 * 合成是反方向、另一套路径、另一套错误码。合并只会让两边的分支互相污染。
 */

import type { Settings, TtsConfig } from '@/types';
import { normalizeSttEndpoint } from './providers';

/** 默认模型：目录里存在且支持非流式 HTTP（实测 403 额度而非 404，说明路由与模型名都对） */
export const DEFAULT_TTS_MODEL = 'qwen3-tts-flash';

/** 默认音色：Cherry（女声，中文自然度最好的一档） */
export const DEFAULT_TTS_VOICE = 'Cherry';

/** 默认域名：本机未配置时的兜底（工作区专用域名会由用户的 endpoint 覆盖） */
const DEFAULT_TTS_ORIGIN = 'https://dashscope.aliyuncs.com';

/** 合成路由（相对域名） */
const TTS_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/**
 * 单次合成上限。官方限制 600，这里留余量：分句是按标点切的，
 * 拼接后可能略超（标点与引号），280 能让一句的音频不至于太长、打断响应更快。
 */
export const TTS_SEGMENT_CHARS = 280;

/** 解析后的 TTS 配置（调用方不再关心回退链） */
export interface ResolvedTtsConfig {
  /** 云端播报是否可用（关掉后讨论只有字幕） */
  enabled: boolean;
  /** 已换算成合成路由的完整 URL */
  url: string;
  model: string;
  voice: string;
  apiToken: string;
  /** 云端失败时是否退回系统语音合成 */
  fallbackToSystem: boolean;
  /**
   * 云端是否**可能**成功：`enabled && url && model && apiToken`。
   *
   * 为 false 时调用方直接走系统语音，连一次注定失败的请求都不发——
   * 那个请求除了在控制台留一条 401 之外没有任何价值。
   */
  ready: boolean;
}

/** 默认 TTS 配置（与 `DEFAULT_TRANSCRIPTION` 同处的默认值口径） */
export const DEFAULT_TTS: TtsConfig = {
  enabled: false,
  endpoint: '',
  model: DEFAULT_TTS_MODEL,
  voice: DEFAULT_TTS_VOICE,
  apiToken: '',
  fallbackToSystem: true,
};

/**
 * 把用户填的 endpoint 换算成合成路由。
 *
 * 三种输入都要能吃：
 * - 空：用官方域名（公网 key 通常就是这种）；
 * - 与转录同一个工作区地址（`.../compatible-mode/v1`）：**去掉兼容前缀**再拼
 *   `/api/v1/...`——直接拼会得到 `/compatible-mode/v1/api/v1/...`，404；
 * - 已经贴了完整合成路由（从文档复制的）：原样返回，不重复拼接。
 */
export function resolveTtsEndpoint(endpoint: string): string {
  const base = normalizeSttEndpoint(endpoint);
  if (base === '') return `${DEFAULT_TTS_ORIGIN}${TTS_PATH}`;
  // 已带完整路由：用户从文档里复制过来的
  if (base.includes('/api/v1/services/')) return base;
  const origin = /^(https?:\/\/[^/]+)/i.exec(base)?.[1];
  if (!origin) return `${DEFAULT_TTS_ORIGIN}${TTS_PATH}`;
  return `${origin}${TTS_PATH}`;
}

/**
 * 解析生效配置：`tts` 缺省时整体跟随 `transcription`。
 *
 * 「跟随」只发生在 `tts` **整段缺失**时。一旦用户显式存了 `tts`，
 * 空 endpoint / 空 token 就按「没配」处理（回退到官方域名 + 系统语音），
 * 而不是继续偷偷用转录的凭据——否则删掉 key 也断不掉，用户无法自证「到底在用什么」。
 */
export function resolveTtsConfig(
  settings: Pick<Settings, 'tts' | 'transcription'>,
): ResolvedTtsConfig {
  const tts = settings.tts;
  const stt = settings.transcription;
  const endpoint = tts?.endpoint?.trim() ?? '';
  /**
   * 字段级回退只在**地址也留空**时发生：地址留空说明用户没打算单独配一个
   * 合成服务，沿用转录的工作区与凭据是安全的。一旦显式填了外部地址，
   * 空 token 就按「没配」处理，绝不能把转录的凭据发到第三方域名。
   */
  const inheritFromStt = endpoint === '';
  const merged: TtsConfig = tts
    ? {
        ...tts,
        endpoint: inheritFromStt ? (stt?.endpoint ?? '') : endpoint,
        apiToken: inheritFromStt && tts.apiToken.trim() === ''
          ? (stt?.apiToken ?? '')
          : tts.apiToken,
      }
    : {
        ...DEFAULT_TTS,
        // 未单独配置时：转录开着就意味着「这台机器上有可用的语音工作区」，
        // 地址与凭据直接沿用（同一工作区的 key 两边通用）。
        enabled: stt?.enabled === true,
        endpoint: stt?.endpoint ?? '',
        apiToken: stt?.apiToken ?? '',
      };
  const url = resolveTtsEndpoint(merged.endpoint);
  const model = merged.model.trim() || DEFAULT_TTS_MODEL;
  const apiToken = merged.apiToken.trim();
  return {
    enabled: merged.enabled === true,
    url,
    model,
    voice: merged.voice.trim() || DEFAULT_TTS_VOICE,
    apiToken,
    fallbackToSystem: merged.fallbackToSystem !== false,
    ready: merged.enabled === true && apiToken !== '' && url !== '',
  };
}

/** 一段待合成的文本 */
export interface SpeechSegment {
  text: string;
}

/**
 * 按句子切分，保证每段 ≤ `max` 字符。
 *
 * 为什么按标点切而不是按固定长度硬切：合成引擎会在段内自行处理语气与停顿，
 * 从句子中间切断会让每段结尾都带上「话没说完」的语调（实测很明显）。
 * 硬切只作为超长单句的兜底（没有人会在 280 字里不写一个标点，但代码不能假设）。
 */
export function splitSpeech(text: string, max: number = TTS_SEGMENT_CHARS): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (clean === '') return [];
  const limit = Math.max(40, Math.floor(max));

  // 句末标点 + 换行都算断点；保留标点本身（丢掉会让语音语调变成陈述一半）
  const pieces = clean.match(/[^。！？!?；;…\n]+[。！？!?；;…]*|\n/g) ?? [clean];
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t !== '') out.push(t);
    buf = '';
  };

  for (const raw of pieces) {
    const piece = raw.replace(/\n/g, ' ').trim();
    if (piece === '') continue;
    // 单句本身就超限：先冲掉缓冲，再按上限硬切
    if (piece.length > limit) {
      flush();
      for (let i = 0; i < piece.length; i += limit) {
        const chunk = piece.slice(i, i + limit).trim();
        if (chunk !== '') out.push(chunk);
      }
      continue;
    }
    if (buf.length + piece.length > limit) flush();
    buf += piece;
  }
  flush();
  return out;
}

/** 合成结果：直链优先（百炼），base64 作为其它兼容实现的兜底 */
export interface TtsAudio {
  url?: string;
  data?: string;
  format?: string;
}

/**
 * 从响应里取音频地址。
 *
 * 宽容解析：不同版本/网关可能把音频放在 `output.audio`（对象）、
 * `output.audio.url`（字符串）或 `output.audio.data`（base64）。
 * 只认一种的后果是「接口 200 但播放端拿不到东西」，且错误完全无声。
 */
export function parseTtsAudio(payload: unknown): TtsAudio | null {
  if (!payload || typeof payload !== 'object') return null;
  const output = (payload as { output?: unknown }).output;
  if (!output || typeof output !== 'object') return null;
  const audio = (output as { audio?: unknown }).audio;
  if (typeof audio === 'string') return audio ? { url: audio } : null;
  if (!audio || typeof audio !== 'object') return null;
  const rec = audio as Record<string, unknown>;
  const url = typeof rec.url === 'string' ? rec.url : undefined;
  const data = typeof rec.data === 'string' ? rec.data : undefined;
  const format = typeof rec.format === 'string' ? rec.format : undefined;
  if (!url && !data) return null;
  return { url, data, format };
}

/** 从服务端错误体里提炼一句人话（区分额度与协议） */
export function describeTtsError(status: number, body: string): string {
  if (/FreeTierOnly|free quota|quota has been exhausted/i.test(body)) {
    return '云端语音合成额度已用尽，已改用系统语音播报';
  }
  if (status === 401 || status === 403) {
    return '语音合成鉴权失败（API Key 无效或无权限），已改用系统语音播报';
  }
  if (status === 404) {
    return '语音合成路由不存在：请把 endpoint 填成工作区域名（不能带 /compatible-mode/v1）';
  }
  const detail = body.slice(0, 200).replace(/\s+/g, ' ');
  return `语音合成失败（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}

/**
 * 发起一次合成请求，返回可播放的音频。
 *
 * 只做「一次请求」：分句、排队、打断都在 `speaker.ts`，这样本函数在单测里
 * 只需要一个 fetch mock，不必伪造 Audio。
 */
export async function synthesizeSpeech(
  text: string,
  cfg: ResolvedTtsConfig,
  signal?: AbortSignal,
): Promise<TtsAudio> {
  const body = {
    model: cfg.model,
    input: {
      text,
      voice: cfg.voice,
      // Auto：中英混说时由模型自己分段，写死 Chinese 会把英文词念成拼音
      language_type: 'Auto',
    },
  };
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(describeTtsError(res.status, raw));
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('语音合成返回了无法解析的内容');
  }
  const audio = parseTtsAudio(json);
  if (!audio) throw new Error('语音合成没有返回音频地址');
  return audio;
}
