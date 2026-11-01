import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `synthesizeSpeech` 必须可控：要能按次返回成功 / 失败，并数出调用次数
 * （「云端额度用尽后不再重试」这条判据全靠调用次数）。
 */
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));

vi.mock('@/lib/voice/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice/tts')>();
  return {
    ...actual,
    synthesizeSpeech: (...args: unknown[]) => synthesize(...args),
  };
});

const { createSpeaker } = await import('@/lib/voice/speaker');

/** jsdom 没有真正的音频解码，用一个「下一轮事件循环就播完」的替身 */
class FakeAudio {
  static played = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public src: string) {}
  play() {
    FakeAudio.played += 1;
    setTimeout(() => this.onended?.(), 0);
    return Promise.resolve();
  }
  pause() {}
  removeAttribute() {}
  load() {}
}

const cfg = {
  enabled: true,
  url: 'https://example.com/tts',
  model: 'm',
  voice: 'v',
  apiToken: 'k',
  // 关掉系统语音降级：jsdom 里没有 speechSynthesis，走不到那条分支，
  // 但关掉能让「云端失败 → 直接收尾」的路径更清晰
  fallbackToSystem: false,
  ready: true,
};

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio);
  FakeAudio.played = 0;
  synthesize.mockResolvedValue({ url: 'blob:fake' });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('voice speaker', () => {
  it('云端合成失败一次后，本轮讨论不再重试云端', async () => {
    synthesize.mockRejectedValueOnce(new Error('额度已用尽'));
    const notice = vi.fn();
    const speaker = createSpeaker(cfg);

    await speaker.speak('第一句话。', { onNotice: notice });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);

    // 第二轮：不该再付一次注定失败的网络往返（这正是「说完要等好久」的主因）
    await speaker.speak('第二句话。', { onNotice: notice });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('流式播报：push 一句就开念，end 之前不收尾', async () => {
    const onEnd = vi.fn();
    const speaker = createSpeaker(cfg);
    const stream = speaker.stream({ onEnd });

    stream.push('第一句话。');
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    // 还有后续句子没到，不能宣布播完
    expect(onEnd).not.toHaveBeenCalled();

    stream.push('第二句话。');
    stream.end();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('end() 之后队列念空才会收尾，中途不会提前结束', async () => {
    const onEnd = vi.fn();
    const speaker = createSpeaker(cfg);
    const stream = speaker.stream({ onEnd });

    stream.push('第一句话。');
    stream.push('第二句话。');
    stream.end();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('stop() 之后 push 无效，也不触发 onEnd', async () => {
    const onEnd = vi.fn();
    const speaker = createSpeaker(cfg);
    const stream = speaker.stream({ onEnd });

    stream.push('第一句话。');
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));

    speaker.stop();
    stream.push('这句话不该被念出来。');
    await wait();

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('被打断时 speak() 的 Promise 也要 resolve（否则状态机卡在播报中）', async () => {
    const speaker = createSpeaker(cfg);
    const pending = speaker.speak('一段很长的话。');
    speaker.stop();
    await expect(pending).resolves.toBeUndefined();
  });

  it('cloudOk 初始为 false 时一次云端请求都不发', async () => {
    const speaker = createSpeaker({ ...cfg, ready: false });
    await speaker.speak('第一句话。');
    expect(synthesize).not.toHaveBeenCalled();
  });
});
