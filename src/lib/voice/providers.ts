/**
 * 语音转录（STT）供应商目录。
 *
 * ⚠️ **这份数据是引擎 `nanobot/audio/transcription_registry.py` 的镜像，不是独立设计。**
 * 与 `src/lib/model/modelProviders.ts` 同一套约定：
 *
 * - `name`     ← `TranscriptionProviderSpec.name`（注册表里的权威名）
 * - `model`    ← `TranscriptionProviderSpec.default_model`
 * - `apiBase`  ← `nanobot/providers/transcription.py` 里各适配器的默认 URL
 * - `protocol` ← 该适配器的**请求形状**（不是所有家都吃 OpenAI 的 multipart）
 *
 * ## 为什么客户端必须自带这份目录
 * 引擎的 `/v1` 路由表里**没有** `/audio/transcriptions`（只有 chat/models/plugins/
 * usage/dream/approvals/config）。STT 在引擎侧只服务 channel 消息（飞书语音等），
 * 走 `channels/base.py::transcribe_audio`，客户端够不到。
 * 所以客户端只能**直连服务商**——那就必须知道每家叫什么、默认模型是什么、
 * 请求怎么发。
 *
 * ## 错位的后果
 * `name` 写错 → 设置页选了个引擎不认识的名字（这里仅用于展示与默认值，
 * 真正的 provider 解析在引擎侧，所以不会崩，但会「选了 A 用 B」）。
 * `protocol` 写错 → 请求发出去 400/404，用户只看到「转录失败」。
 */

/** 请求形状：决定 `transcribe` 用哪种编码与端点路径 */
export type TranscriptionProtocol =
  /** OpenAI 兼容 multipart：`POST {base}/audio/transcriptions`，字段 file + model */
  | 'openai-multipart'
  /** AssemblyAI：先上传字节拿 upload_url，再提交 transcript 任务并轮询 */
  | 'assemblyai'
  /** StepFun：SSE 流式，`POST {base}/audio/asr/sse`，body 为 base64 */
  | 'stepfun-sse'
  /** 小米 MiMo：OpenAI chat 形状，音频以 input_audio 塞进 messages */
  | 'mimo-chat'
  /**
   * 阿里云百炼（DashScope）OpenAI 兼容模式：`POST {base}/chat/completions`，
   * 音频以 base64 data URI 塞进 `messages[0].content[0].input_audio.data`。
   *
   * ⚠️ **它没有 `/audio/transcriptions` 路由**（实测该路径返回 404 空体），
   * 与 `mimo-chat` 形状相近但**响应与参数不同**，因此单独一类：
   * - 语言提示走顶层 `asr_options.language`（不是 `language` 字段）
   * - 结果在 `choices[0].message.content`
   * - `qwen-audio-*` 系列只接受**公网 URL**，传 base64 会回
   *   `400 url error, please check url`；只有 `qwen3-asr-flash` 接受 base64。
   *   这个坑实测踩过：用户按文档填了 streaming 模型，症状是「录音正常、
   *   一停就失败」，而错误文案完全指向不了真因。
   */
  | 'dashscope-chat';

export interface TranscriptionProviderSpec {
  /** 引擎注册表名（snake_case） */
  name: string;
  /** 展示名 */
  label: string;
  /** 默认模型（注册表 default_model） */
  model: string;
  /** 默认 API base；`''` 表示必须由用户填写（本地部署 / 自建网关） */
  apiBase: string;
  /** 请求形状 */
  protocol: TranscriptionProtocol;
  /**
   * 是否需要单独的服务商 API Key。
   * `false` 表示「复用网关凭据」是合理默认（自建 OpenAI 兼容网关），
   * `true` 表示该服务商在公网，必须自带 key。
   */
  needsKey: boolean;
}

/**
 * 目录顺序即设置页下拉顺序：把国内可直连、中文识别好的放前面。
 *
 * 只收录引擎注册表里真实存在的 7 家；**不收录**引擎没有的供应商——
 * 客户端凭空多出一家，用户选了之后行为无从验证。
 */
export const TRANSCRIPTION_PROVIDERS: readonly TranscriptionProviderSpec[] = [
  {
    name: 'groq',
    label: 'Groq（whisper-large-v3，速度快）',
    model: 'whisper-large-v3',
    apiBase: 'https://api.groq.com/openai/v1',
    protocol: 'openai-multipart',
    needsKey: true,
  },
  {
    name: 'siliconflow',
    label: '硅基流动（SenseVoice，中文友好）',
    model: 'FunAudioLLM/SenseVoiceSmall',
    apiBase: 'https://api.siliconflow.cn/v1',
    protocol: 'openai-multipart',
    needsKey: true,
  },
  {
    name: 'dashscope',
    label: '阿里云百炼（Qwen3-ASR，中文强）',
    // ⛔ 必须是 `qwen3-asr-flash`：`qwen-audio-*` 系列在 chat 形态下**只吃公网 URL**，
    // 传 base64 会回 `400 url error`。默认值选错 = 用户开箱即失败。
    model: 'qwen3-asr-flash',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'dashscope-chat',
    needsKey: true,
  },
  {
    name: 'openai',
    label: 'OpenAI（whisper-1）',
    model: 'whisper-1',
    apiBase: 'https://api.openai.com/v1',
    protocol: 'openai-multipart',
    needsKey: true,
  },
  {
    name: 'openrouter',
    label: 'OpenRouter（openai/whisper-1）',
    model: 'openai/whisper-1',
    apiBase: 'https://openrouter.ai/api/v1',
    protocol: 'openai-multipart',
    needsKey: true,
  },
  {
    name: 'xiaomi_mimo',
    label: '小米 MiMo ASR',
    model: 'mimo-v2.5-asr',
    apiBase: 'https://api.xiaomimimo.com/v1',
    protocol: 'mimo-chat',
    needsKey: true,
  },
  {
    name: 'stepfun',
    label: '阶跃星辰 StepAudio',
    model: 'stepaudio-2.5-asr',
    apiBase: 'https://api.stepfun.com/v1',
    protocol: 'stepfun-sse',
    needsKey: true,
  },
  {
    name: 'assemblyai',
    label: 'AssemblyAI（长音频）',
    model: 'universal-3-pro',
    apiBase: 'https://api.assemblyai.com/v2',
    protocol: 'assemblyai',
    needsKey: true,
  },
  {
    name: 'custom',
    label: '自定义（OpenAI 兼容网关）',
    model: 'whisper-1',
    apiBase: '',
    protocol: 'openai-multipart',
    needsKey: false,
  },
];

/** 按 name 取 spec；未知返回 undefined（调用方据此回退 custom） */
export function findTranscriptionProvider(
  name: string,
): TranscriptionProviderSpec | undefined {
  return TRANSCRIPTION_PROVIDERS.find((p) => p.name === name);
}

/** 全部合法 provider 名：设置迁移的归一化判据（见 `settingsStore` 的 v15 分支） */
export const TRANSCRIPTION_PROVIDER_NAMES: readonly string[] =
  TRANSCRIPTION_PROVIDERS.map((p) => p.name);

/** 默认供应商：Groq。速度与中文准确率在免费额度内最均衡 */
export const DEFAULT_TRANSCRIPTION_PROVIDER = 'groq';

/**
 * 归一化 endpoint：
 * - 尾部空白与斜杠去掉（拼接路径时不出现双斜杠）
 * - **去掉尾部逗号 / 分号**：用户从文档里复制地址时经常连带标点一起粘进来
 *   （实测就遇到 `.../compatible-mode/v1,`），拼出 `/v1,/chat/completions`
 *   必然 404，而报错只显示「HTTP 404」，完全看不出是多了个逗号。
 * - 已带完整路径的 URL 原样返回（用户从文档直接粘贴端点很常见）
 */
export function normalizeSttEndpoint(raw: string): string {
  return raw
    .trim()
    // 尾部标点（逗号 / 分号 / 中文逗号）——复制粘贴最常见的污染
    .replace(/[,;，；]+$/, '')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * 由 provider 与用户填写的 endpoint 算出**最终请求 URL**。
 *
 * 用户留空 → 用目录里的默认 base；填了 → 以用户为准（自建网关 / 代理）。
 */
export function resolveTranscriptionUrl(
  spec: TranscriptionProviderSpec,
  endpointOverride: string,
): string {
  const base = normalizeSttEndpoint(endpointOverride) || spec.apiBase;
  switch (spec.protocol) {
    case 'openai-multipart':
    case 'mimo-chat':
    case 'dashscope-chat':
      // 用户可能已经贴了完整端点，此时不再重复拼接
      return base.includes('/audio/') || base.includes('/chat/')
        ? base
        : spec.protocol === 'openai-multipart'
          ? `${base}/audio/transcriptions`
          : // mimo-chat 与 dashscope-chat 都是 chat 形态
            `${base}/chat/completions`;
    case 'stepfun-sse':
      return base.includes('/audio/') ? base : `${base}/audio/asr/sse`;
    case 'assemblyai':
      return base;
    default:
      return base;
  }
}
