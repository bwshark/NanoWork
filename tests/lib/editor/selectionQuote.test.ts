/**
 * 「选中文本 → 添加到对话」的纯逻辑。
 *
 * 这一组用例盯的是**回归定位**（`findTextRange`）——它是整条链路里唯一
 * 「看起来能跑、实际很容易悄悄指错地方」的一环：
 * 消息正文是 Markdown 渲染结果，一句话会被 `<strong>` / `<code>` / `<a>`
 * 切成好几个文本节点，块级元素之间还会被浏览器插入换行。按字符下标记位置
 * 在重渲染后必然失效，所以走归一化文本查找。下面每条断言都在钉其中一个失败模式。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_QUOTE_CHARS,
  buildQuotedMessage,
  clampQuoteText,
  clearQuoteHighlights,
  findTextRange,
  normalizeQuoteText,
  normalizeWithIndex,
  paintQuoteHighlights,
  quoteChipLabel,
} from '@/lib/editor/selectionQuote';

/** 造一块可控 DOM 作为查找根节点 */
function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('归一化：引文与正文两侧必须同一口径', () => {
  it('连续空白折叠成单个空格，并映射回第一个空白字符的原始下标', () => {
    const { text, origin } = normalizeWithIndex('a  b\n\tc');
    expect(text).toBe('a b c');
    // 归一化后的每个字符都指向真实存在的原始位置（不是越界值）
    expect(origin).toHaveLength(text.length);
    expect(origin[0]).toBe(0);
    expect(origin[2]).toBe(3); // 折叠出来的那个空格 → 原始串里第一段空白的起点
    expect(origin[3]).toBe(4);
  });

  it('normalizeQuoteText 折叠空白并去掉首尾', () => {
    expect(normalizeQuoteText('  国庆节  假期 \n')).toBe('国庆节 假期');
  });
});

describe('findTextRange：在渲染后的消息 DOM 里找回原文', () => {
  it('单个文本节点内按子串定位', () => {
    const root = mount('<p>明天是国庆节假期的第7天</p>');
    const range = findTextRange(root, '国庆节假期');
    expect(range).toBeTruthy();
    expect(range!.toString()).toBe('国庆节假期');
    expect(range!.startOffset).toBe(3);
  });

  it('跨内联节点也能命中（Markdown 把一句话切成多个节点）', () => {
    const root = mount('<p>明天是<strong>国庆节</strong><code>假期</code>的第7天</p>');
    const range = findTextRange(root, '国庆节假期');
    expect(range).toBeTruthy();
    expect(range!.toString()).toBe('国庆节假期');
  });

  it('块级元素之间由浏览器插入的换行不参与比较', () => {
    const root = mount('<p>第一行</p>\n<p>第二行</p>');
    const range = findTextRange(root, '第一行 第二行');
    expect(range).toBeTruthy();
    expect(range!.toString()).toBe('第一行\n第二行');
  });

  it('跳过 script / style 里的同名文本', () => {
    const root = mount('<script>关键词</script><p>关键词</p>');
    const range = findTextRange(root, '关键词');
    expect(range).toBeTruthy();
    expect(range!.startContainer.parentElement?.tagName).toBe('P');
  });

  it('找不到 / 空引文都返回 null（调用方据此静默跳过，而不是拿整条消息凑合）', () => {
    const root = mount('<p>明天是国庆节</p>');
    expect(findTextRange(root, '劳动节')).toBeNull();
    expect(findTextRange(root, '   ')).toBeNull();
    expect(findTextRange(root, '')).toBeNull();
  });

  it('只处理第一个命中（同一句话出现多次时不许跳着选）', () => {
    const root = mount('<p>假期从1号开始</p><p>假期到7号结束</p>');
    const range = findTextRange(root, '假期');
    expect(range!.startContainer.parentElement?.textContent).toContain('1号开始');
  });
});

describe('高亮登记：环境不支持时降级为「不着色」而不是抛错', () => {
  it('jsdom 无 CSS Custom Highlight API：paint 返回 false，clear 不抛', () => {
    const root = mount('<p>国庆节</p>');
    const range = findTextRange(root, '国庆节')!;
    expect(() => paintQuoteHighlights([range])).not.toThrow();
    expect(paintQuoteHighlights([range])).toBe(false);
    expect(() => clearQuoteHighlights()).not.toThrow();
  });
});

describe('引用文案与发送拼接', () => {
  it('胶囊文案折叠空白并按上限截断', () => {
    expect(quoteChipLabel('  国庆节 假期 ')).toBe('国庆节 假期');
    const long = quoteChipLabel('一'.repeat(40), 22);
    expect(long).toHaveLength(23); // 22 个字 + 省略号
    expect(long.endsWith('…')).toBe(true);
  });

  it('收录引用时去首尾空白并截断到上限', () => {
    expect(clampQuoteText('  国庆节  ')).toBe('国庆节');
    expect(clampQuoteText('啊'.repeat(MAX_QUOTE_CHARS + 50))).toHaveLength(
      MAX_QUOTE_CHARS,
    );
  });

  it('没有引用时原样返回待发文本', () => {
    expect(buildQuotedMessage('你好', [])).toBe('你好');
  });

  it('引用在前、输入在后，中间隔一个空行', () => {
    expect(buildQuotedMessage('请接着说明', [{ text: '国庆节假期' }])).toBe(
      '> 国庆节假期\n\n请接着说明',
    );
  });

  it('多行引用逐行加 > ，空行写成裸 >（否则引用会在空行处断成两段）', () => {
    expect(buildQuotedMessage('x', [{ text: '第一行\n\n第二行' }])).toBe(
      '> 第一行\n>\n> 第二行\n\nx',
    );
  });

  it('只挂了引用、没打字时只发引用块（用户看到胶囊就能预期发出去的是什么）', () => {
    expect(buildQuotedMessage('   ', [{ text: '国庆节假期' }])).toBe(
      '> 国庆节假期',
    );
  });

  it('多条引用拼成连续的引用块', () => {
    expect(
      buildQuotedMessage('x', [{ text: 'A' }, { text: 'B' }]),
    ).toBe('> A\n> B\n\nx');
  });
});
