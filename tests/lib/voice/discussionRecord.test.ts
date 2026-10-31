import { describe, expect, it } from 'vitest';
import { buildDiscussionRecord, formatRecordDuration } from '@/lib/voice/discussionRecord';

describe('voice discussion record', () => {
  it('纪要包含时长、轮次、模型摘要与双方记录', () => {
    const text = buildDiscussionRecord({
      durationMs: 65_400,
      summary: '讨论了语音讨论入口，结论是放在麦克风与发送之间。',
      turns: [
        { role: 'user', text: '把语音讨论放在哪里？' },
        { role: 'assistant', text: '放在麦克风和发送之间。' },
      ],
    });
    expect(text).toContain('**语音讨论纪要** · 01:05 · 1 轮');
    expect(text).toContain('讨论了语音讨论入口');
    expect(text).toContain('- **你**：把语音讨论放在哪里？');
    expect(text).toContain('- **助手**：放在麦克风和发送之间。');
  });

  it('模型摘要失败时有本地兜底，不产空纪要', () => {
    const text = buildDiscussionRecord({
      durationMs: 1000,
      summary: '   ',
      turns: [{ role: 'user', text: '只说了这一句' }],
    });
    expect(text).toContain('本次共 1 轮发言，内容见下方记录。');
    expect(text).toContain('只说了这一句');
  });

  it('长讨论只保留最近 16 条，并说明省略数量', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `第 ${i + 1} 条`,
    }));
    const text = buildDiscussionRecord({ durationMs: 0, summary: '摘要', turns });
    expect(text).toContain('（更早的 4 条已省略）');
    expect(text).not.toContain('第 1 条');
    expect(text).toContain('第 20 条');
  });

  it('时长不为负，单条发言会折叠空白并截断', () => {
    expect(formatRecordDuration(-1)).toBe('00:00');
    const text = buildDiscussionRecord({
      durationMs: 0,
      summary: '摘要',
      turns: [{ role: 'user', text: `  多\n 行 ${'字'.repeat(200)}  ` }],
    });
    expect(text).toContain('多 行');
    expect(text).toContain('…');
  });
});
