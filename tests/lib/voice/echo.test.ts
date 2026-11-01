import { describe, expect, it } from 'vitest';
import {
  coverRatio,
  isEchoTranscript,
  normalizeSpeech,
  speechSimilarity,
} from '@/lib/voice/echo';

describe('normalizeSpeech', () => {
  it('去掉空白与标点，只留说过的字', () => {
    expect(normalizeSpeech('你好呀！我在呢，有什么想聊的。')).toBe(
      '你好呀我在呢有什么想聊的',
    );
    expect(normalizeSpeech('  Hello,  World! ')).toBe('helloworld');
  });
});

describe('speechSimilarity', () => {
  it('相同句子为 1，完全无关接近 0', () => {
    expect(speechSimilarity('今天天气不错', '今天天气不错')).toBe(1);
    expect(speechSimilarity('今天天气不错', '帮我建一个定时任务')).toBeLessThan(0.2);
  });

  it('标点差异不影响判定', () => {
    expect(speechSimilarity('你好呀，我在呢。', '你好呀!我在呢')).toBe(1);
  });
});

describe('isEchoTranscript', () => {
  const reply = '你好呀！我在呢，有什么想聊的或者需要帮忙的，直接说就行。';

  it('识别结果就是助手刚说的话时判为回声', () => {
    expect(isEchoTranscript(reply, [reply])).toBe(true);
    // 识别补了自己的标点
    expect(isEchoTranscript('你好呀 我在呢 有什么想聊的或者需要帮忙的 直接说就行', [reply])).toBe(
      true,
    );
  });

  it('识别吞掉开头几个字仍然判为回声', () => {
    expect(isEchoTranscript('我在呢，有什么想聊的或者需要帮忙的，直接说就行', [reply])).toBe(true);
  });

  /**
   * 实测形态：TTS 还在响，用户已经开始说话，识别把两者拼成一句。
   * 多出来的尾巴会让 Dice 掉到 0.80 以下，靠覆盖率兜住。
   */
  it('回声后面粘上用户自己的话仍判为回声', () => {
    const mixed =
      '你好呀，我在呢。有什么想聊的或者需要帮忙的，直接说就行。就这样被你占断了所有路我';
    expect(coverRatio(mixed, reply)).toBeGreaterThanOrEqual(0.95);
    expect(isEchoTranscript(mixed, [reply])).toBe(true);
  });

  it('用户追问式复述不算回声', () => {
    expect(
      isEchoTranscript('你刚才说有什么想聊的或者需要帮忙的，是什么意思', [reply]),
    ).toBe(false);
  });

  it('短句不参与判定（双方都会反复说）', () => {
    expect(isEchoTranscript('好的', ['好的'])).toBe(false);
    expect(isEchoTranscript('放在发送键旁边吧', ['放在发送键旁边'])).toBe(false);
  });

  it('只与最近几条助手回复比较，无关内容不误判', () => {
    const assistantTexts = ['第一段回复讲的是排期问题，要延期两天', '第二段回复讲的是资源分配'];
    expect(isEchoTranscript('帮我把这个任务取消掉吧', assistantTexts)).toBe(false);
  });

  it('没有助手文本时不判回声', () => {
    expect(isEchoTranscript(reply, [])).toBe(false);
  });
});
