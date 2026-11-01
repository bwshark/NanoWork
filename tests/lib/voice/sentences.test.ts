import { describe, expect, it } from 'vitest';
import { createSentenceSplitter } from '@/lib/voice/sentences';

describe('createSentenceSplitter', () => {
  it('成句就交出去，半句留在缓冲区', () => {
    const s = createSentenceSplitter();
    expect(s.feed('你好呀')).toEqual([]);
    expect(s.feed('！我在呢。')).toEqual(['你好呀！', '我在呢。']);
    expect(s.feed('接下来')).toEqual([]);
    expect(s.flush()).toBe('接下来');
  });

  it('太短的碎片不单独成段（「嗯。」不该被念成一句）', () => {
    const s = createSentenceSplitter();
    expect(s.feed('嗯。好的，我看看。')).toEqual(['嗯。好的，我看看。']);
  });

  it('一次到达多句时逐句吐出（首句不能被后面那句子拖住）', () => {
    const s = createSentenceSplitter();
    expect(s.feed('第一句。第二句。第三句')).toEqual(['第一句。', '第二句。']);
    expect(s.flush()).toBe('第三句');
  });

  it('流式逐字到达也能在句号处立刻切出', () => {
    const s = createSentenceSplitter();
    const out: string[] = [];
    for (const ch of '现在几点了？我看看。') out.push(...s.feed(ch));
    expect(out).toEqual(['现在几点了？', '我看看。']);
  });

  it('没有句末标点的长句会按上限硬切，不会一直等到流结束', () => {
    const s = createSentenceSplitter(40);
    const long = '啊'.repeat(45);
    const out = s.feed(long);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBeLessThanOrEqual(40);
    expect(s.flush()).toBe('啊'.repeat(5));
  });

  it('硬切优先落在逗号上，而不是按字符数截断', () => {
    const s = createSentenceSplitter(12);
    const out = s.feed('一二三四五六七八九十，十一十二');
    expect(out[0].endsWith('，')).toBe(true);
  });

  it('纯标点不会单独成段', () => {
    const s = createSentenceSplitter();
    expect(s.feed('。。嗯，好的。')).toEqual(['嗯，好的。']);
  });

  it('flush 之后缓冲区清空', () => {
    const s = createSentenceSplitter();
    s.feed('一个没有标点的句子');
    expect(s.flush()).toBe('一个没有标点的句子');
    expect(s.flush()).toBe('');
  });
});
