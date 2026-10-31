import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTranscribeRequest, transcribeAudio } from '@/lib/voice/transcribe';
import { DEFAULT_TRANSCRIPTION } from '@/stores/settingsStore';
import type { TranscriptionConfig } from '@/types';

/**
 * 转写传输层：**这是原实现里最致命的缺陷所在**。
 *
 * 旧实现打的是 `{网关}/audio/transcriptions`，而引擎 `serve` 进程
 * 根本没有这个路由（`nanobot/api/server.py` 只注册了 chat/models/plugins/
 * usage/dream/approvals/config）。默认配置下必然 404，而错误文案
 * 「转录失败：HTTP 404」完全无法指向真因。
 *
 * 变异清单：
 * - 把 URL 改回「复用网关」→ 「请求打到 provider 默认地址」变红
 * - `enabled=false` 时不抛错 → 「未启用时明确报错」变红
 * - 失败时不读响应体 → 「401 带出服务商 message」变红
 * - 成功但 text 为空时返回空串 → 「空结果报可读错误」变红
 */

/** 构造一份可用配置 */
function cfg(patch: Partial<TranscriptionConfig> = {}): TranscriptionConfig {
  return {
    ...DEFAULT_TRANSCRIPTION,
    enabled: true,
    provider: 'groq',
    endpoint: '',
    model: 'whisper-large-v3',
    apiToken: 'test-key',
    language: 'zh',
    ...patch,
  };
}

/** 造一个最小可用的音频 Blob */
function audioBlob(size = 32000): Blob {
  return new Blob([new Uint8Array(size)], { type: 'audio/wav' });
}

/**
 * 记录 fetch 调用的桩。
 * 返回的 `calls` 供断言 URL / method / headers / body。
 */
function stubFetch(response: Response | ((url: string) => Response)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url) : response;
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

describe('transcribeAudio：地址解析', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('**关键**：endpoint 留空时打到 provider 默认地址，而不是网关', () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: '你好' }), { status: 200 }),
    );
    return transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' }).then(() => {
      expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      // 绝不能打到 127.0.0.1 的网关（那里没有这个路由）
      expect(calls[0].url).not.toContain('127.0.0.1');
    });
  });

  it('用户填了自定义 endpoint → 以用户为准', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
    );
    await transcribeAudio(cfg({ endpoint: 'http://127.0.0.1:8000/v1' }), {
      audio: audioBlob(),
      filename: 'voice.wav',
    });
    expect(calls[0].url).toBe('http://127.0.0.1:8000/v1/audio/transcriptions');
  });
});

describe('transcribeAudio：请求形状', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('用 POST + multipart（不手设 Content-Type，交给浏览器补 boundary）', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: 'hi' }), { status: 200 }),
    );
    await transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' });
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('form 里带 file / model / language / response_format', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: 'hi' }), { status: 200 }),
    );
    await transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' });
    const form = calls[0].init.body as FormData;
    expect(form.get('file')).toBeTruthy();
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('zh');
    expect(form.get('response_format')).toBe('json');
  });

  it('language 为空时不传（让服务端自动检测）', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: 'hi' }), { status: 200 }),
    );
    await transcribeAudio(cfg({ language: '' }), {
      audio: audioBlob(),
      filename: 'voice.wav',
    });
    expect((calls[0].init.body as FormData).get('language')).toBeNull();
  });

  it('model 留空时回退 provider 默认模型（不让请求带空 model）', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: 'hi' }), { status: 200 }),
    );
    await transcribeAudio(cfg({ model: '   ' }), {
      audio: audioBlob(),
      filename: 'voice.wav',
    });
    expect((calls[0].init.body as FormData).get('model')).toBe('whisper-large-v3');
  });
});

describe('transcribeAudio：前置校验', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('未启用 → 明确报错，且**不发请求**（不浪费一次网络往返）', async () => {
    const { fn } = stubFetch(new Response('{}', { status: 200 }));
    await expect(
      transcribeAudio(cfg({ enabled: false }), {
        audio: audioBlob(),
        filename: 'voice.wav',
      }),
    ).rejects.toThrow('未启用');
    expect(fn).not.toHaveBeenCalled();
  });

  it('模型留空 → 回退到 provider 默认模型并发请求（不是报「未配置模型」）', async () => {
    // 目录里每家都有 default_model，用户没填时用它才合理；
    // 报错只会让人回设置页重填一遍，而他并没有漏配什么
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: 'hi' }), { status: 200 }),
    );
    await transcribeAudio(cfg({ model: '  ' }), {
      audio: audioBlob(),
      filename: 'voice.wav',
    });
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((calls[0].init.body as FormData).get('model')).toBe('whisper-large-v3');
  });

  it('公网服务商缺 Key → 明确报错，不发请求', async () => {
    const { fn } = stubFetch(new Response('{}', { status: 200 }));
    await expect(
      transcribeAudio(cfg({ apiToken: '' }), {
        audio: audioBlob(),
        filename: 'voice.wav',
      }),
    ).rejects.toThrow('API Key');
    expect(fn).not.toHaveBeenCalled();
  });

  it('custom 无默认地址且未填 endpoint → 明确报错', async () => {
    const { fn } = stubFetch(new Response('{}', { status: 200 }));
    await expect(
      transcribeAudio(
        cfg({ provider: 'custom', endpoint: '', apiToken: '' }),
        { audio: audioBlob(), filename: 'voice.wav' },
      ),
    ).rejects.toThrow('Endpoint');
    expect(fn).not.toHaveBeenCalled();
  });

  it('custom 无鉴权网关：key 留空也放行', async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
    );
    await transcribeAudio(
      cfg({ provider: 'custom', endpoint: 'http://127.0.0.1:8000/v1', apiToken: '' }),
      { audio: audioBlob(), filename: 'voice.wav' },
    );
    expect(calls[0].init.headers).toEqual({});
  });
});

describe('transcribeAudio：响应处理', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功返回 trim 后的文本', async () => {
    stubFetch(new Response(JSON.stringify({ text: '  你好世界  ' }), { status: 200 }));
    const text = await transcribeAudio(cfg(), {
      audio: audioBlob(),
      filename: 'voice.wav',
    });
    expect(text).toBe('你好世界');
  });

  it('**关键**：401 时带出服务商的 error.message（而不是只有状态码）', async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
      }),
    );
    await expect(
      transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' }),
    ).rejects.toThrow(/Invalid API key/);
  });

  it('错误体是纯文本时也带出来', async () => {
    stubFetch(new Response('upstream overloaded', { status: 503 }));
    await expect(
      transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' }),
    ).rejects.toThrow(/upstream overloaded/);
  });

  it('**关键**：成功但 text 为空 → 报可读错误（不返回空串让 UI 静默无反应）', async () => {
    stubFetch(new Response(JSON.stringify({ text: '   ' }), { status: 200 }));
    await expect(
      transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' }),
    ).rejects.toThrow(/没有识别到/);
  });

  it('响应缺 text 字段 → 同样报可读错误', async () => {
    stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' }),
    ).rejects.toThrow(/没有识别到/);
  });

  it('网络层抛错（fetch reject）被包装成可读文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(
      transcribeAudio(cfg(), { audio: audioBlob(), filename: 'voice.wav' }),
    ).rejects.toThrow(/Failed to fetch/);
  });
});

describe('buildTranscribeRequest：文件名带时长', () => {
  it('由 WAV 字节数算出秒数并写进文件名（服务端日志可读）', () => {
    // 1 秒 16kHz 单声道 16bit = 32000 字节 + 44 头
    const req = buildTranscribeRequest(audioBlob(32044));
    expect(req.filename).toBe('voice-1s.wav');
  });

  it('空音频时长为 0 也不抛错', () => {
    const req = buildTranscribeRequest(audioBlob(44));
    expect(req.filename).toBe('voice-0s.wav');
  });
});
