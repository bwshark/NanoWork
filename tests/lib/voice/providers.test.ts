import { describe, expect, it } from 'vitest';
import {
  findTranscriptionProvider,
  normalizeSttEndpoint,
  resolveTranscriptionUrl,
  TRANSCRIPTION_PROVIDERS,
  TRANSCRIPTION_PROVIDER_NAMES,
  DEFAULT_TRANSCRIPTION_PROVIDER,
} from '@/lib/voice/providers';

/**
 * STT 供应商目录：这份数据是引擎注册表的镜像，**错位不会报错，只会打错地址**。
 *
 * 变异清单：
 * - `resolveTranscriptionUrl` 拼成 `{base}/v1/audio/transcriptions`（重复 /v1）→ 变红
 * - 用户已贴完整端点时仍重复拼接 → 变红
 * - `TRANSCRIPTION_PROVIDER_NAMES` 与目录脱钩 → 变红
 */

describe('TRANSCRIPTION_PROVIDERS：目录自身的一致性', () => {
  it('至少收录 OpenAI 兼容 + 自定义网关两条路', () => {
    const names = TRANSCRIPTION_PROVIDERS.map((p) => p.name);
    expect(names).toContain('openai');
    expect(names).toContain('custom');
  });

  it('每个 provider 都有非空 name / label / model', () => {
    TRANSCRIPTION_PROVIDERS.forEach((p) => {
      expect(p.name.trim()).not.toBe('');
      expect(p.label.trim()).not.toBe('');
      expect(p.model.trim()).not.toBe('');
    });
  });

  it('name 唯一（重复会让设置页出现两个同值选项）', () => {
    const names = TRANSCRIPTION_PROVIDERS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('**关键**：只有 custom 允许无默认 apiBase（其余无地址就无法请求）', () => {
    TRANSCRIPTION_PROVIDERS.forEach((p) => {
      if (p.name !== 'custom') expect(p.apiBase).not.toBe('');
    });
  });

  it('custom 不需要自带 Key（自建网关常无鉴权）', () => {
    expect(findTranscriptionProvider('custom')?.needsKey).toBe(false);
  });

  it('默认 provider 必须在目录内（否则设置页选中态为空）', () => {
    expect(TRANSCRIPTION_PROVIDER_NAMES).toContain(DEFAULT_TRANSCRIPTION_PROVIDER);
  });

  it('TRANSCRIPTION_PROVIDER_NAMES 与目录同源（不脱钩）', () => {
    expect(TRANSCRIPTION_PROVIDER_NAMES).toEqual(
      TRANSCRIPTION_PROVIDERS.map((p) => p.name),
    );
  });
});

describe('findTranscriptionProvider', () => {
  it('已知 name 命中', () => {
    expect(findTranscriptionProvider('groq')?.model).toBe('whisper-large-v3');
  });

  it('未知 name 返回 undefined（调用方据此回退 custom）', () => {
    expect(findTranscriptionProvider('no-such-provider')).toBeUndefined();
  });

  it('空字符串返回 undefined（不抛错）', () => {
    expect(findTranscriptionProvider('')).toBeUndefined();
  });
});

describe('normalizeSttEndpoint', () => {
  it('去掉尾部斜杠', () => {
    expect(normalizeSttEndpoint('https://api.groq.com/openai/v1/')).toBe(
      'https://api.groq.com/openai/v1',
    );
  });

  it('多个尾部斜杠一并去掉', () => {
    expect(normalizeSttEndpoint('http://x/v1///')).toBe('http://x/v1');
  });

  it('前后空白被裁掉（用户从文档复制常带空格）', () => {
    expect(normalizeSttEndpoint('  http://x/v1  ')).toBe('http://x/v1');
  });

  it('空串返回空串', () => {
    expect(normalizeSttEndpoint('')).toBe('');
  });
});

describe('resolveTranscriptionUrl：最终请求地址', () => {
  const groq = findTranscriptionProvider('groq')!;

  it('endpoint 留空 → 用 provider 默认 base 拼 /audio/transcriptions', () => {
    expect(resolveTranscriptionUrl(groq, '')).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions',
    );
  });

  it('用户填了 base → 以用户为准（自建网关/代理）', () => {
    expect(resolveTranscriptionUrl(groq, 'http://127.0.0.1:8000/v1')).toBe(
      'http://127.0.0.1:8000/v1/audio/transcriptions',
    );
  });

  it('用户填了 base 带尾斜杠 → 不出现双斜杠', () => {
    expect(resolveTranscriptionUrl(groq, 'http://127.0.0.1:8000/v1/')).toBe(
      'http://127.0.0.1:8000/v1/audio/transcriptions',
    );
  });

  it('**关键**：用户已贴完整端点 → 不重复拼接', () => {
    expect(
      resolveTranscriptionUrl(groq, 'https://api.groq.com/openai/v1/audio/transcriptions'),
    ).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('**关键**：不会拼出 /v1/audio/... 的重复 /v1', () => {
    const url = resolveTranscriptionUrl(groq, '');
    expect(url).not.toContain('/v1/v1');
  });

  it('custom 无默认 base + 用户填了 → 正常拼接', () => {
    const custom = findTranscriptionProvider('custom')!;
    expect(resolveTranscriptionUrl(custom, 'http://192.168.1.5:8080/v1')).toBe(
      'http://192.168.1.5:8080/v1/audio/transcriptions',
    );
  });
});

describe('normalizeSttEndpoint：复制粘贴污染', () => {
  it('**关键**：去掉尾部逗号（从文档复制地址最常见的污染）', () => {
    // 实测踩过：`.../compatible-mode/v1,` 拼出 `/v1,/chat/completions` 必 404
    expect(normalizeSttEndpoint('https://x/compatible-mode/v1,')).toBe(
      'https://x/compatible-mode/v1',
    );
  });

  it('去掉尾部中文逗号 / 分号', () => {
    expect(normalizeSttEndpoint('https://x/v1，')).toBe('https://x/v1');
    expect(normalizeSttEndpoint('https://x/v1;')).toBe('https://x/v1');
  });

  it('逗号 + 斜杠混在一起也能清干净', () => {
    expect(normalizeSttEndpoint('https://x/v1/,')).toBe('https://x/v1');
  });
});

describe('dashscope：百炼走 chat 形态而非 /audio/transcriptions', () => {
  const ds = findTranscriptionProvider('dashscope')!;

  it('**关键**：默认模型是 qwen3-asr-flash（不是 qwen-audio-*）', () => {
    // qwen-audio-* 在 chat 形态下只吃公网 URL，传 base64 回 400 url error
    expect(ds.model).toBe('qwen3-asr-flash');
  });

  it('**关键**：协议是 dashscope-chat（不是 openai-multipart）', () => {
    expect(ds.protocol).toBe('dashscope-chat');
  });

  it('**关键**：URL 拼成 /chat/completions，不拼 /audio/transcriptions', () => {
    const url = resolveTranscriptionUrl(ds, '');
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(url).not.toContain('/audio/');
  });

  it('用户填专属工作空间域名也能正确拼接', () => {
    expect(
      resolveTranscriptionUrl(ds, 'https://ws-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),
    ).toBe(
      'https://ws-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
  });

  it('用户填的地址尾部带逗号也能拼出正确 URL', () => {
    expect(
      resolveTranscriptionUrl(ds, 'https://ws-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1,'),
    ).toBe(
      'https://ws-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
  });
});
