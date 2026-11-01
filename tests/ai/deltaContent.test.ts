import { describe, expect, it } from 'vitest';
import { deltaContentText } from '@/ai/runtime/nanobotHttp/deltaContent';

/**
 * 收流时的正文归一化。
 *
 * 回归的是 2026-11-01 那张截图：某个提供方把正文包成内容块数组，
 * `fullText += delta.content` 把它 String() 成了 `[object Object],[object Object],…`，
 * 围栏 ``` 与语言名来自别的帧，于是围栏语法完好、内容全毁 —— 产物卡片标题正常、
 * 正文却是这串垃圾，而且不可恢复。
 */
describe('deltaContentText：把一帧 delta.content 收成纯文本', () => {
  it('字符串原样返回', () => {
    expect(deltaContentText('```nanowork-expert\n')).toBe('```nanowork-expert\n');
    expect(deltaContentText('')).toBe('');
  });

  it('内容块数组拼成文本，绝不出现 [object Object]', () => {
    const blocks = [
      { type: 'text', text: '{"kind":"agent",' },
      { type: 'text', text: '"name":"Web GIS 专家"}' },
    ];
    const text = deltaContentText(blocks);
    expect(text).toBe('{"kind":"agent","name":"Web GIS 专家"}');
    expect(text).not.toContain('[object Object]');
  });

  it('省略 type 的文本块按 text 处理（部分实现不给这个字段）', () => {
    expect(deltaContentText([{ text: '甲' }, { text: '乙' }])).toBe('甲乙');
  });

  it('非正文块（tool_use / image / thinking）一律丢弃，不 stringify 成占位符', () => {
    expect(
      deltaContentText([
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 't1', name: 'read_file' },
        { type: 'image', source: { data: 'xx' } },
      ]),
    ).toBe('好的');
  });

  it('完全认不出的形状返回空串（调用方据此跳过打点与渲染，不塞空 chunk）', () => {
    expect(deltaContentText(undefined)).toBe('');
    expect(deltaContentText(null)).toBe('');
    expect(deltaContentText({ type: 'text', text: 'x' })).toBe('');
    expect(deltaContentText(42)).toBe('');
    expect(deltaContentText([{ type: 'text' }])).toBe('');
  });
});
