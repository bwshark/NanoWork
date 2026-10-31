import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TTS_MODEL,
  describeTtsError,
  parseTtsAudio,
  resolveTtsConfig,
  resolveTtsEndpoint,
  splitSpeech,
  synthesizeSpeech,
} from '@/lib/voice/tts';
import type { TranscriptionConfig } from '@/types';

const STT: TranscriptionConfig = {
  enabled: true,
  provider: 'dashscope',
  endpoint: 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3-asr-flash-realtime',
  apiToken: 'test-stt-token',
  language: 'zh',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('tts config', () => {
  it('未单独配置时沿用实时识别的工作区地址与凭据', () => {
    const cfg = resolveTtsConfig({ transcription: STT });
    expect(cfg.enabled).toBe(true);
    expect(cfg.ready).toBe(true);
    expect(cfg.model).toBe(DEFAULT_TTS_MODEL);
    expect(cfg.apiToken).toBe('test-stt-token');
    expect(cfg.url).toBe(
      'https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
  });

  it('endpoint 三种形态都归一到真实合成路由', () => {
    expect(resolveTtsEndpoint('')).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(resolveTtsEndpoint('https://example.com/compatible-mode/v1')).toBe(
      'https://example.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    const full = 'https://example.com/api/v1/services/aigc/multimodal-generation/generation';
    expect(resolveTtsEndpoint(full)).toBe(full);
  });

  it('显式配置但地址留空时仍沿用转录凭据', () => {
    const cfg = resolveTtsConfig({
      transcription: STT,
      tts: {
        enabled: true,
        endpoint: '',
        model: '',
        voice: '',
        apiToken: '',
        fallbackToSystem: true,
      },
    });
    expect(cfg.ready).toBe(true);
    expect(cfg.apiToken).toBe('test-stt-token');
    expect(cfg.url).toContain('ws-example.cn-beijing.maas.aliyuncs.com/api/v1/services/');
  });

  it('填了外部地址就不再回退转录凭据，避免把 key 发给第三方', () => {
    const cfg = resolveTtsConfig({
      transcription: STT,
      tts: {
        enabled: true,
        endpoint: 'https://third-party.example.com/v1',
        model: DEFAULT_TTS_MODEL,
        voice: 'Cherry',
        apiToken: '',
        fallbackToSystem: true,
      },
    });
    expect(cfg.ready).toBe(false);
    expect(cfg.apiToken).toBe('');
  });

  it('显式关闭时不发云端请求，但保留系统语音降级', () => {
    const cfg = resolveTtsConfig({
      transcription: STT,
      tts: {
        enabled: false,
        endpoint: '',
        model: '',
        voice: '',
        apiToken: '',
        fallbackToSystem: true,
      },
    });
    expect(cfg.ready).toBe(false);
    expect(cfg.fallbackToSystem).toBe(true);
  });
});

describe('speech text and response parsing', () => {
  it('按标点组合短句，所有分段都不超过上限', () => {
    const segments = splitSpeech(`第一句。第二句！${'很长的没有标点的话'.repeat(40)}`);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((s) => s.length > 0 && s.length <= 280)).toBe(true);
    expect(segments.join('')).toContain('第一句。第二句！');
  });

  it('空文本不产生请求段', () => {
    expect(splitSpeech(' \n ')).toEqual([]);
  });

  it('兼容 OSS 直链、字符串与 base64 三种返回', () => {
    expect(parseTtsAudio({ output: { audio: { url: 'https://example.com/a.wav' } } })).toEqual({
      url: 'https://example.com/a.wav',
      data: undefined,
      format: undefined,
    });
    expect(parseTtsAudio({ output: { audio: 'https://example.com/b.wav' } })).toEqual({
      url: 'https://example.com/b.wav',
    });
    expect(parseTtsAudio({ output: { audio: { data: 'QUJD', format: 'mp3' } } })).toEqual({
      url: undefined,
      data: 'QUJD',
      format: 'mp3',
    });
    expect(parseTtsAudio({ output: {} })).toBeNull();
  });

  it('额度与鉴权错误有明确的人话提示', () => {
    expect(describeTtsError(403, '{"code":"AllocationQuota.FreeTierOnly"}')).toContain('额度已用尽');
    expect(describeTtsError(401, 'bad key')).toContain('鉴权失败');
    expect(describeTtsError(404, '')).toContain('路由不存在');
  });
});

describe('synthesizeSpeech', () => {
  it('使用百炼 multimodal-generation 请求形状并解析音频地址', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ output: { audio: { url: 'https://example.com/result.wav' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const cfg = resolveTtsConfig({ transcription: STT });

    await expect(synthesizeSpeech('你好', cfg)).resolves.toEqual({
      url: 'https://example.com/result.wav',
      data: undefined,
      format: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(cfg.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-stt-token' });
    expect(JSON.parse(String(init.body))).toEqual({
      model: DEFAULT_TTS_MODEL,
      input: { text: '你好', voice: 'Cherry', language_type: 'Auto' },
    });
  });
});
