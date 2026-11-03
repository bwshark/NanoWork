import { describe, expect, it } from 'vitest';
import {
  applyRewrite,
  buildRewriteSystemPrompt,
  buildRewriteUserPrompt,
  extractRewriteResult,
  isValidSelection,
  normalizeSelection,
  rewrittenSelection,
  selectedText,
} from '@/lib/artifact/selectionRewrite';

/** 用 indexOf 算选区，避免手算偏移出错（测试意图也更清楚） */
function sel(content: string, segment: string): { start: number; end: number } {
  const start = content.indexOf(segment);
  expect(start).toBeGreaterThan(-1);
  return { start, end: start + segment.length };
}

describe('normalizeSelection / isValidSelection', () => {
  it('反向选区会 swap 成有序', () => {
    expect(normalizeSelection(9, 3, 20)).toEqual({ start: 3, end: 9 });
  });

  it('越界一律 null（不悄悄夹到边界）', () => {
    expect(normalizeSelection(-1, 5, 20)).toBeNull();
    expect(normalizeSelection(0, 21, 20)).toBeNull();
  });

  it('空选区 null（等于没选，不该触发改写）', () => {
    expect(normalizeSelection(4, 4, 20)).toBeNull();
  });

  it('非整数 / 非有限值 null', () => {
    expect(normalizeSelection(Number.NaN, 3, 20)).toBeNull();
    expect(normalizeSelection(1.5, 3, 20)).toEqual({ start: 1, end: 3 });
  });

  it('isValidSelection 认可落在正文内的有序区间', () => {
    expect(isValidSelection({ start: 0, end: 5 }, 10)).toBe(true);
    expect(isValidSelection({ start: 0, end: 10 }, 10)).toBe(true);
    expect(isValidSelection({ start: 3, end: 3 }, 10)).toBe(false);
    expect(isValidSelection({ start: 0, end: 11 }, 10)).toBe(false);
    expect(isValidSelection(null, 10)).toBe(false);
  });
});

describe('selectedText', () => {
  it('按偏移取那一段，不做 trim', () => {
    const content = '  前文 中间 后文  ';
    expect(selectedText(content, sel(content, '中间'))).toBe('中间');
  });

  it('选区失效返回空串', () => {
    expect(selectedText('abc', { start: 0, end: 9 })).toBe('');
    expect(selectedText('abc', null)).toBe('');
  });
});

describe('buildRewriteSystemPrompt', () => {
  it('包含「只输出改写后的文本」与「不要围栏」两条硬约束', () => {
    const prompt = buildRewriteSystemPrompt({ instruction: '缩短' });
    expect(prompt).toContain('只输出');
    expect(prompt).toContain('```');
    expect(prompt).toContain('不要改动未被选中的上下文');
  });

  it('带 language 时点明语言，便于保持缩进风格', () => {
    const prompt = buildRewriteSystemPrompt({ instruction: '优化', language: 'python' });
    expect(prompt).toContain('python');
  });

  it('空语言不留下空行噪声', () => {
    const prompt = buildRewriteSystemPrompt({ instruction: '优化' });
    expect(prompt).not.toContain('\n\n\n');
  });
});

describe('buildRewriteUserPrompt', () => {
  it('用 <selected> 包住待改内容，避免与正文措辞混淆', () => {
    const content = '第一行\n第二行\n第三行';
    const prompt = buildRewriteUserPrompt(content, { start: 4, end: 7 }, { instruction: '改成英文' });
    expect(prompt).toContain('<selected>');
    expect(prompt).toContain('</selected>');
    expect(prompt).toContain('第二行');
    // 未选中的内容不该出现：模型只该看到要改的那一段
    expect(prompt).not.toContain('第三行');
  });

  it('有标题时带上文件名', () => {
    const prompt = buildRewriteUserPrompt('abc', { start: 0, end: 3 }, {
      instruction: '缩写',
      title: 'main.py',
    });
    expect(prompt).toContain('main.py');
  });
});

describe('extractRewriteResult', () => {
  it('整体被一层围栏包住时剥掉围栏', () => {
    expect(extractRewriteResult('```python\nprint(1)\n```')).toBe('print(1)');
  });

  it('围栏带语言标记也能剥', () => {
    expect(extractRewriteResult('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('⛔ 正文内部自带代码块时**不**剥（否则会吃掉前后内容）', () => {
    const raw = '```md\n说明：\n```js\nx\n```\n结尾\n```';
    // 整段不是「恰好一层围栏」→ 原样返回（只去首尾空白）
    expect(extractRewriteResult(raw)).toBe(raw);
  });

  it('只有开头有围栏、结尾没有 → 不剥', () => {
    const raw = '```python\nprint(1)';
    expect(extractRewriteResult(raw)).toBe(raw);
  });

  it('剥掉「好的，改写如下：」这类引导语', () => {
    expect(extractRewriteResult('好的，改写如下：\n这是新文本')).toBe('这是新文本');
  });

  it('首行不是引导语（太长 / 无冒号）时原样保留', () => {
    const raw = '这是一段很长的正文\n第二行';
    expect(extractRewriteResult(raw)).toBe(raw);
  });

  it('CRLF 归一成 LF（正文比较与替换都按 LF）', () => {
    expect(extractRewriteResult('a\r\nb')).toBe('a\nb');
  });

  it('空 / 纯空白返回空串', () => {
    expect(extractRewriteResult('')).toBe('');
    expect(extractRewriteResult('   \n  ')).toBe('');
  });
});

describe('applyRewrite', () => {
  const content = '前文\n中间那句\n后文';

  it('只替换选区那一段，前后文一字不动', () => {
    const out = applyRewrite(content, sel(content, '中间那句'), '新的那句');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toBe('前文\n新的那句\n后文');
  });

  it('⛔ 选区失效（正文已换）时拒绝，不改正文', () => {
    const out = applyRewrite('abc', { start: 0, end: 9 }, '新内容');
    expect(out).toEqual({ ok: false, reason: '选区已失效（正文可能已切换），请重新圈选' });
  });

  it('⛔ 空改写拒绝：不能把选区悄悄删掉', () => {
    const out = applyRewrite(content, sel(content, '中间那句'), '   ');
    expect(out.ok).toBe(false);
  });

  it('⛔ 与原文相同拒绝：不升版污染版本链', () => {
    const out = applyRewrite(content, sel(content, '中间那句'), '中间那句');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('未产生变更');
  });

  it('⛔ 首行缩进参与比较：只把缩进去掉也是真变更（不能误判为无变化）', () => {
    const indented = 'def f():\n    return 1';
    const out = applyRewrite(indented, sel(indented, '    return 1'), 'return 1');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toBe('def f():\nreturn 1');
  });

  it('替换时保留模型给的缩进（trim 会抹平，这里不会）', () => {
    const src = 'if x:\n    pass';
    const out = applyRewrite(src, sel(src, '    pass'), '        return 1');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toBe('if x:\n        return 1');
  });

  it('新文本比原文短：后文仍从原 end 起算', () => {
    const src = 'aXYb';
    const ok = applyRewrite(src, sel(src, 'XY'), 'Z');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.content).toBe('aZb');
  });

  it('新文本比原文长：拼接不错位', () => {
    const src = 'aXYb';
    const out = applyRewrite(src, sel(src, 'XY'), 'ZZZZ');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.content).toBe('aZZZZb');
  });
});

describe('rewrittenSelection', () => {
  it('起点不变，终点按新文本长度推进', () => {
    expect(rewrittenSelection({ start: 4, end: 10 }, 'abcdef')).toEqual({ start: 4, end: 10 });
    // 首行缩进计入长度：`  abc  ` 只去掉行尾空白 → 长度 5
    expect(rewrittenSelection({ start: 4, end: 10 }, '  abc  ')).toEqual({ start: 4, end: 9 });
  });
});
