/**
 * 语音转录客户端：把音频送到服务商并拿回文本。
 *
 * ## 为什么不再复用 `nanobotHttp/chat.ts` 的 `transcribe()`
 * 那条实现打的是 `{网关}/audio/transcriptions`，而引擎的 `serve` 进程
 * **没有这个路由**（`nanobot/api/server.py` 只注册了 chat/completions、models、
 * plugins、usage、dream、approvals、config）。引擎侧 STT 只服务 channel
 * （`channels/base.py::transcribe_audio`），走的是 gateway 的 WebSocket 事件，
 * 客户端 HTTP 够不到。
 *
 * 因此客户端必须**直连服务商**。这也顺带解决了一个更隐蔽的问题：
 * 原来「endpoint 留空则复用网关」的默认值在默认安装下**必然 404**，
 * 而错误文案是「转录失败：HTTP 404」，用户根本不知道该填什么。
 *
 * ## 与网关链路的隔离
 * 这里刻意**不**走 `connectionManager.getClient()`：那条链路持有会话、
 * 会触发探活与重连，语音转写是一次性的短请求，耦合进去只会让
 * 「网关没起」连带语音不可用。
 */

import type { TranscriptionConfig } from '@/types';
import { describeVoiceError } from './errors';
import {
  findTranscriptionProvider,
  resolveTranscriptionUrl,
  type TranscriptionProviderSpec,
} from './providers';
import { wavDurationSeconds } from './wav';

/** 单次转写请求的超时（ms）。STT 服务端排队时 30s 常见，给足余量 */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

export interface TranscribeOptions {
  audio: Blob;
  /** 文件名（含扩展名）；服务商据此判断格式 */
  filename: string;
  /** 语言提示（ISO-639-1） */
  language?: string;
  /** 上下文提示词，可提升专有名词识别率（Whisper 支持） */
  prompt?: string;
}

/**
 * 服务商报错时把响应体读出来。
 *
 * 只抛 `HTTP 401` 是没有价值的信息——服务商通常会在 body 里写
 * `{"error":{"message":"Invalid API key"}}`，那句才是用户要看的。
 * 读不出来时退回状态码，绝不吞成「转录失败」。
 */
async function describeHttpFailure(res: Response, label: string): Promise<Error> {
  let detail = '';
  try {
    const text = await res.text();
    if (text) {
      try {
        const json = JSON.parse(text) as {
          error?: { message?: string } | string;
          message?: string;
        };
        const nested = json.error;
        detail =
          (typeof nested === 'string' ? nested : nested?.message) ??
          json.message ??
          text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // 读不出 body 就只能靠状态码
  }
  const trimmed = detail.trim().slice(0, 300);
  return new Error(
    `${label}失败：HTTP ${res.status}${trimmed ? ` · ${trimmed}` : ''}`,
  );
}

/** 带超时的 fetch：AbortController + setTimeout，超时按 AbortError 上报 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = TRANSCRIBE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 兼容 multipart：file + model + 可选 language/prompt */
async function transcribeOpenAICompatible(
  spec: TranscriptionProviderSpec,
  cfg: TranscriptionConfig,
  opts: TranscribeOptions,
  apiKey: string,
): Promise<string> {
  const url = resolveTranscriptionUrl(spec, cfg.endpoint);
  const form = new FormData();
  form.append('file', opts.audio, opts.filename);
  form.append('model', cfg.model.trim() || spec.model);
  const language = (opts.language ?? '').trim() || cfg.language.trim();
  if (language) form.append('language', language);
  if (opts.prompt?.trim()) form.append('prompt', opts.prompt.trim());
    // response_format 固定 json：verbose_json 会多一层 segments，各家字段名还不一致
  form.append('response_format', 'json');

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    // multipart 不设 Content-Type（浏览器自动补 boundary），只带鉴权
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: form,
  });
  if (!res.ok) throw await describeHttpFailure(res, '语音转写');

  const json = (await res.json()) as { text?: string };
  const text = (json.text ?? '').trim();
  if (text === '') throw new Error('没有识别到语音内容，请靠近麦克风重试');
  return text;
}

/** Blob → base64（不带前缀）；分块拼接避免大文件时 `String.fromCharCode(...)` 爆栈 */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 阿里云百炼（DashScope）OpenAI 兼容 chat 形态的语音识别。
 *
 * ## 请求形状（实测确认）
 * `POST {base}/chat/completions`，音频以 **base64 data URI** 塞进
 * `messages[0].content[0].input_audio.data`；语言提示走**顶层**
 * `asr_options.language`（不是 OpenAI 的 `language` 字段）。
 * 结果在 `choices[0].message.content`。
 *
 * ## 为什么不能走 `/audio/transcriptions`
 * 百炼**没有这个路由**（实测返回 404 空体）。它与 OpenAI 的 whisper 端点
 * 只是「长得像」，不是同一套 API。
 *
 * ## 为什么默认模型必须是 `qwen3-asr-flash`
 * `qwen-audio-*` 系列在 chat 形态下**只接受公网 URL**，传 base64 会回
 * `400 url error, please check url`。这个错误文案完全指不出「模型不支持
 * 内联音频」，用户只会以为地址填错了——实测就是在这里卡住的。
 * 所以这里对 `qwen-audio-*` + base64 的组合**提前拦截并给出可执行的建议**，
 * 而不是把 400 原样抛给用户。
 */
async function transcribeDashScopeChat(
  spec: TranscriptionProviderSpec,
  cfg: TranscriptionConfig,
  opts: TranscribeOptions,
  apiKey: string,
): Promise<string> {
  const url = resolveTranscriptionUrl(spec, cfg.endpoint);
  const model = (cfg.model.trim() || spec.model).trim();

  // 提前拦截：qwen-audio 系列不接受内联音频
  if (model.startsWith('qwen-audio') || model.includes('-streaming')) {
    throw new Error(
      `「${model}」不支持直接上传音频（它只接受公网 URL，或是实时流式模型）。` +
        `请改用 qwen3-asr-flash，或在服务商处换用非流式模型。`,
    );
  }

  const mime = opts.audio.type || 'audio/wav';
  const dataUri = `data:${mime};base64,${await blobToBase64(opts.audio)}`;
  const language = (opts.language ?? '').trim() || cfg.language.trim();

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: dataUri } }],
      },
    ],
    // 必须显式 false：默认可能走流式，响应体就变成 SSE 而不是 JSON
    stream: false,
  };
  if (language) body.asr_options = { language };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await describeHttpFailure(res, '语音转写');

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const raw = json.choices?.[0]?.message?.content;
  // content 可能是字符串，也可能是分块数组（部分兼容实现如此）
  const text = (
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).join('')
        : ''
  ).trim();
  if (text === '') throw new Error('没有识别到语音内容，请靠近麦克风重试');
  return text;
}

/**
 * 转写入口。
 *
 * 只支持 OpenAI 兼容路径（含自定义网关）——这是覆盖 90% 场景的一条；
 * 其余协议在 `providers.ts` 里标注了，但**没有实现就不该假装支持**：
 * 半实现的适配器比「不支持」更糟，它会让用户以为配好了。
 */
export async function transcribeAudio(
  cfg: TranscriptionConfig,
  opts: TranscribeOptions,
): Promise<string> {
  if (!cfg.enabled) {
    throw new Error('未启用语音输入，请先到「设置 → 连接 → 语音输入」开启');
  }

  const spec =
    findTranscriptionProvider(cfg.provider) ??
    findTranscriptionProvider('custom')!;
  // 模型留空时**回退到 provider 默认模型**而不是报错：
  // 目录里每家都有 default_model，用户没填时用它是唯一合理的解释；
  // 抛「未配置模型」只会让人去设置页重填一遍，而他根本没漏配什么。
  // （设置页保存时仍会拦空模型，这一层是兜底而非主校验。）
  if (cfg.model.trim() === '' && spec.model.trim() === '') {
    throw new Error('未配置转录模型（如 whisper-large-v3）');
  }

  if (!spec.apiBase && !cfg.endpoint.trim()) {
    throw new Error('该转录服务需要填写 Endpoint（例如 http://127.0.0.1:8000/v1）');
  }

  // key 优先级：转录专用 key > 网关 key（自建网关通常两者相同）
  const apiKey = cfg.apiToken.trim();
  if (spec.needsKey && apiKey === '') {
    throw new Error(`「${spec.label}」需要填写 API Key`);
  }

  try {
    switch (spec.protocol) {
      case 'openai-multipart':
        return await transcribeOpenAICompatible(spec, cfg, opts, apiKey);
      case 'dashscope-chat':
        return await transcribeDashScopeChat(spec, cfg, opts, apiKey);
      default:
        // 没实现就不假装支持：半实现的适配器比「不支持」更糟，
        // 它会让用户以为配好了，然后对着一条看不懂的报错反复试。
        throw new Error(
          `暂不支持「${spec.label}」的请求协议（${spec.protocol}），请改用 OpenAI 兼容服务或阿里云百炼`,
        );
    }
  } catch (err) {
    // 统一在这里包一层：调用方只需要 toast(message)，不必区分阶段
    const { message } = describeVoiceError(err, 'transcribe');
    throw new Error(message);
  }
}

/**
 * 由 WAV Blob 构造请求参数（文件名带真实时长信息，便于服务端日志排查）。
 * 导出为纯函数以便单测。
 */
export function buildTranscribeRequest(audio: Blob): TranscribeOptions {
  const seconds = Math.round(wavDurationSeconds(audio));
  return { audio, filename: `voice-${seconds}s.wav` };
}
