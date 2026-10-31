import { describe, expect, it } from 'vitest';
import { canUseRealtime } from '@/hooks/useVoiceInput';
import { toRealtimeUrl } from '@/lib/voice/realtime';

/**
 * 实时语音：地址换算与模式判定。
 *
 * 这些都是**实测**出来的规则，不是照文档写的：
 * - 鉴权只能走 `?api_key=`（浏览器无法设 header，子协议不合法）
 * - 事件名是 `delta` 不是 `text`
 * - `qwen-audio-*` realtime 可用，`qwen3-asr-flash-realtime` 在本机额度耗尽
 *
 * 变异清单：
 * - 把 `compatible-mode/v1` 不换成 `api-ws/v1/realtime` → 「URL 走 api-ws」变红
 * - 不转 wss → 「scheme 必须是 wss」变红
 * - 明文 ws 也拼 key → 「明文不拼 key」变红
 * - `canUseRealtime` 把 `-streaming` 也当实时 → 「streaming 不算实时」变红
 */

describe('toRealtimeUrl：REST 地址 → realtime WS', () => {
  it('**关键**：compatible-mode/v1 换成 api-ws/v1/realtime', () => {
    expect(
      toRealtimeUrl(
        'https://ws-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        'qwen-audio-3.1-realtime-flash',
        'sk-test',
      ),
    ).toContain('/api-ws/v1/realtime');
  });

  it('**关键**：scheme 必须是 wss（api_key 在 URL 里，不能走明文）', () => {
    const url = toRealtimeUrl('https://x.com/compatible-mode/v1', 'm', 'sk-test');
    expect(url.startsWith('wss://')).toBe(true);
    expect(url).not.toContain('/compatible-mode/');
  });

  it('附带 model 与 api_key 查询参数', () => {
    const url = toRealtimeUrl('https://x.com/compatible-mode/v1', 'qwen-audio-3.1-realtime-flash', 'sk-abc');
    expect(url).toContain('model=qwen-audio-3.1-realtime-flash');
    expect(url).toContain('api_key=sk-abc');
  });

  it('**关键**：明文 ws 下不拼 key（凭据会裸奔）', () => {
    const url = toRealtimeUrl('http://x.com/compatible-mode/v1', 'm', 'sk-abc');
    expect(url.startsWith('ws://')).toBe(true);
    expect(url).not.toContain('api_key=');
  });

  it('endpoint 尾部逗号被清理（复制文档常见污染）', () => {
    const url = toRealtimeUrl('https://x.com/compatible-mode/v1,', 'm', 'k');
    expect(url).not.toContain('v1,');
    expect(url).toContain('/api-ws/v1/realtime');
  });

  it('用户直接填 WS 地址时原样使用（只补 model/key）', () => {
    const url = toRealtimeUrl('wss://x.com/api-ws/v1/realtime', 'm', 'k');
    expect(url.startsWith('wss://x.com/api-ws/v1/realtime')).toBe(true);
    expect(url).toContain('model=m');
  });

  it('已有 model 参数时不重复追加', () => {
    const url = toRealtimeUrl('wss://x.com/api-ws/v1/realtime?model=m', 'm2', 'k');
    expect(url).not.toContain('model=m2');
    expect(url).toContain('api_key=k');
  });

  it('自建网关 .../v1 前缀也能换算', () => {
    const url = toRealtimeUrl('https://my.gw/v1', 'm', 'k');
    expect(url).toContain('/api-ws/v1/realtime');
  });

  it('apiKey 为空时不加 api_key 参数（自建无鉴权网关）', () => {
    const url = toRealtimeUrl('https://x.com/compatible-mode/v1', 'm', '');
    expect(url).not.toContain('api_key=');
  });
});

describe('canUseRealtime：哪些配置能走实时', () => {
  it('dashscope + realtime 模型 → 实时', () => {
    expect(canUseRealtime('dashscope', 'qwen-audio-3.1-realtime-flash')).toBe(true);
  });

  it('**关键**：`-streaming` 不算实时（那是整段音频 + SSE，不是边说边出字）', () => {
    // 实测 qwen-audio-3.1-asr-flash-streaming 走 chat 形态会 400 url error
    expect(canUseRealtime('dashscope', 'qwen-audio-3.1-asr-flash-streaming')).toBe(false);
  });

  it('非 dashscope 一律非实时（whisper / SenseVoice 没有该协议）', () => {
    expect(canUseRealtime('groq', 'whisper-large-v3')).toBe(false);
    expect(canUseRealtime('openai', 'whisper-1')).toBe(false);
    expect(canUseRealtime('siliconflow', 'FunAudioLLM/SenseVoiceSmall')).toBe(false);
  });

  it('custom 走非实时（用户可能配任何网关）', () => {
    expect(canUseRealtime('custom', 'qwen-audio-3.1-realtime-flash')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(canUseRealtime('dashscope', 'QWEN3-ASR-FLASH-REALTIME')).toBe(true);
  });
});
