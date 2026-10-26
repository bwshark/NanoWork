/**
 * 富文本 ⇄ Markdown 转换（编辑器保存链路的唯一转换层）。
 *
 * 这一层坏掉的后果不是「样式丢了」，而是**用户没动过的内容被改写**：反序列化多一个
 * `**`、序列化少一个空行，都会在每次「打开 → 保存」里累积。所以这里全部用往返断言
 * （markdown → html → markdown 必须逐字相同），而不是只检查"包含某个标签"。
 */

import { describe, expect, it } from 'vitest';
import { countChars, htmlToMarkdown, markdownToHtml } from '@/lib/kb/richText';

/** 往返：markdown → html → markdown */
function roundTrip(markdown: string): string {
  return htmlToMarkdown(markdownToHtml(markdown));
}

describe('markdown → html', () => {
  it('标题按层级出 h1/h2/h3，段落出 div（与 contentEditable 的行元素一致）', () => {
    const html = markdownToHtml('# 标题\n\n## 二级\n\n正文一段');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<h2>二级</h2>');
    expect(html).toContain('<div>正文一段</div>');
  });

  it('列表、引用、代码块、分割线各自成形', () => {
    const html = markdownToHtml('- 一\n- 二\n\n> 引用\n\n```\ncode\n```\n\n---');
    expect(html).toContain('<ul><li>一</li><li>二</li></ul>');
    expect(html).toContain('<blockquote>引用</blockquote>');
    expect(html).toContain('<pre><code>code</code></pre>');
    expect(html).toContain('<hr>');
  });

  it('行内代码里的星号不会被当成加粗', () => {
    const html = markdownToHtml('`a**b**c`');
    expect(html).toContain('<code>a**b**c</code>');
    expect(html).not.toContain('<strong>');
  });

  it('HTML 特殊字符被转义（正文里写 <script> 不该变成标签）', () => {
    expect(markdownToHtml('a < b & c')).toContain('a &lt; b &amp; c');
  });
});

describe('html → markdown', () => {
  it('认得 <b>/<strong>、<i>/<em>、<s>、<u>、<code>、<a>', () => {
    const html =
      '<div><b>粗</b>与<strong>也粗</strong>、<i>斜</i>、<s>删</s>、<u>下划线</u>、' +
      '<code>x</code>、<a href="https://e.com">链接</a></div>';
    expect(htmlToMarkdown(html)).toBe(
      '**粗**与**也粗**、*斜*、~~删~~、<u>下划线</u>、`x`、[链接](https://e.com)',
    );
  });

  it('浏览器给的空壳元素只留文字（span / font / 未知标签）', () => {
    expect(htmlToMarkdown('<div><span style="color:red">文字</span></div>')).toBe('文字');
  });

  it('嵌套列表按缩进还原', () => {
    const html = '<ul><li>一<ul><li>一甲</li></ul></li></ul>';
    expect(htmlToMarkdown(html)).toBe('- 一\n  - 一甲');
  });

  it('空内容与纯空白都得到空串（而不是一堆空行）', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('<div><br></div>')).toBe('');
    expect(htmlToMarkdown('<div> </div><div>&nbsp;</div>'.replace('&nbsp;', ' '))).toBe('');
  });
});

describe('往返不失真（打开 → 保存 不该改动用户没动的内容）', () => {
  const DOC = [
    '# 快速了解团队知识库',
    '',
    '这份资料会告诉你：知识库在 nanowork 里承担什么角色。',
    '',
    '## 一、它是什么',
    '',
    '**一句话介绍**：团队专属的资料库。',
    '',
    '- 成员上传的制度会切成块并建索引',
    '- 提问时先在服务端按可见范围检索',
    '',
    '1. 一份资料只入一次库',
    '2. 删除先进回收站',
    '',
    '> 引用一段别人的话',
    '',
    '```',
    'const a = 1;',
    '```',
    '',
    '---',
  ].join('\n');

  it('一份典型文档往返后逐字相同', () => {
    expect(roundTrip(DOC)).toBe(DOC);
  });

  it('行内样式混排往返后逐字相同', () => {
    const line = '**粗** *斜* ~~删~~ <u>下划线</u> `code` [链接](https://e.com)';
    expect(roundTrip(line)).toBe(line);
  });

  it('空行数量稳定（连续空行压成一个，且不会被反复删除）', () => {
    expect(roundTrip('一段\n\n\n\n二段')).toBe('一段\n\n二段');
    expect(roundTrip('一段\n\n二段')).toBe('一段\n\n二段');
  });
});

/**
 * 表格与图片（P0）。
 *
 * 这一组守的不是「能渲染」，而是**存回去还是不是原来那张表**：转换层没有
 * `table`/`img` 分支时不会报错，只会把表格塌成一行竖线文字、把图片整个吃掉。
 * 症状是「打开一次文档，表格/图就没了」，每存一次丢一次。
 */
describe('表格', () => {
  const TABLE = [
    '| 城市 | 住宿上限 | 说明 |',
    '| :--- | ---: | :---: |',
    '| 北京 | 600 | 一线 |',
    '| 杭州 | 450 | 二线 |',
  ].join('\n');

  it('markdown → html 产出真表格，而不是一行带竖线的文字', () => {
    const html = markdownToHtml(TABLE);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead><tr><th data-align="left"><div>城市</div></th>');
    expect(html).toContain('<td data-align="right"><div>600</div></td>');
    // 旧实现（无 table 分支）会产出 <div>| 城市 | 住宿上限 | 说明 |</div>
    expect(html).not.toContain('| 城市 |');
  });

  it('表格往返后逐字相同（对齐与列宽都不漂移）', () => {
    expect(roundTrip(TABLE)).toBe(TABLE);
  });

  it('单元格里的 | 转义后往返仍是一格（不转义就多出一列）', () => {
    const markdown = '| 写法 | 含义 |\n| --- | --- |\n| a \\| b | 或 |';
    expect(roundTrip(markdown)).toBe(markdown);
    // DOM 里那一格应当是「a | b」，而不是被拆成两格
    // 单元格里有一层块级元素：裸文本的 td 在 contentEditable 里点不进去
    expect(markdownToHtml(markdown)).toContain('<td><div>a | b</div></td>');
  });

  it('表格夹在段落之间，顺序不乱、前后空行稳定', () => {
    const doc = ['前一段', '', TABLE, '', '后一段'].join('\n');
    expect(roundTrip(doc)).toBe(doc);
  });

  it('空单元格往返后被补成空串（不塌列）', () => {
    const markdown = '| 甲 | 乙 |\n| --- | --- |\n| 1 |  |';
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('只有表头的表也能往返（GFM 合法的最小形态）', () => {
    const markdown = '| 甲 | 乙 |\n| --- | --- |';
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('没有分隔行的竖线文字不当表格处理', () => {
    const html = markdownToHtml('甲 | 乙 是两种写法');
    expect(html).toBe('<div>甲 | 乙 是两种写法</div>');
  });

  it('包在 div 里的表格按块展开（浏览器会把块级元素塞进 div）', () => {
    const html = '<div><table><tr><th>a</th></tr><tr><td>1</td></tr></table></div>';
    expect(htmlToMarkdown(html)).toBe('| a |\n| --- |\n| 1 |');
  });
});

describe('图片', () => {
  it('图片往返后保留 alt 与地址', () => {
    const markdown = '前一段\n\n![架构图](asset:abc123)\n\n后一段';
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('data: 内嵌图被丢弃（base64 写进库会把整块撑爆）', () => {
    const html = '<div><img src="data:image/png;base64,iVBORw0KGgo" alt="x"></div>';
    expect(htmlToMarkdown(html)).toBe('');
    expect(markdownToHtml('![x](data:image/png;base64,AAAA)')).toBe('');
  });

  it('图片在链接之前识别（否则 ![a](b) 会变成 !<a>a</a>）', () => {
    expect(markdownToHtml('![图](https://e.com/a.png)')).toContain('<img src="https://e.com/a.png"');
    expect(markdownToHtml('![图](https://e.com/a.png)')).not.toContain('<a href');
  });

  it('figure 的 figcaption 在没有 alt 时顶替 alt（图注是唯一的检索信号）', () => {
    const html = '<figure><img src="asset:1"><figcaption>系统架构</figcaption></figure>';
    expect(htmlToMarkdown(html)).toBe('![系统架构](asset:1)');
  });
});

describe('图注（图片下方那行可编辑的字）', () => {
  it('独占一行的图片变成 figure + figcaption（alt 里藏着等于用户看不见）', () => {
    const html = markdownToHtml('![系统架构](asset:abc)');

    expect(html).toContain('<figure>');
    expect(html).toContain('<figcaption>系统架构</figcaption>');
    // alt 仍然写：figure 被浏览器拆掉时图注还能留住
    expect(html).toContain('alt="系统架构"');
  });

  it('改过 figcaption 之后以图注为准（alt 只是打开时的快照）', () => {
    const html =
      '<figure><img src="asset:1" alt="旧图注"><figcaption>新写的图注</figcaption></figure>';

    expect(htmlToMarkdown(html)).toBe('![新写的图注](asset:1)');
  });

  it('句子中间的图片不变成 figure（那里没有「下方」这个位置）', () => {
    const html = markdownToHtml('看图 ![a](asset:1) 就懂');

    expect(html).not.toContain('figure');
    expect(htmlToMarkdown(html)).toBe('看图 ![a](asset:1) 就懂');
  });

  it('图注里的方括号转义后往返不破（未转义的 ] 会提前结束 alt）', () => {
    const markdown = '![图 1\\] 架构](asset:abc)';

    expect(roundTrip(markdown)).toBe(markdown);
    // 编辑器里给人看的是没转义的那句
    expect(markdownToHtml(markdown)).toContain('<figcaption>图 1] 架构</figcaption>');
  });

  it('空图注往返后仍是空的（占位提示只走 CSS，不落进正文）', () => {
    expect(roundTrip('![](asset:abc)')).toBe('![](asset:abc)');
  });

  it('图注里回车产生的 div 之间补空格（不然后两行粘成一个词）', () => {
    const html = '<figure><img src="asset:1"><figcaption><div>第一行</div><div>第二行</div></figcaption></figure>';

    expect(htmlToMarkdown(html)).toBe('![第一行 第二行](asset:1)');
  });

  it('图被删掉但图注还在时，那段字留成普通段落（不静默吞掉用户打的字）', () => {
    const html = '<figure><figcaption>只剩说明</figcaption></figure>';

    expect(htmlToMarkdown(html)).toBe('只剩说明');
  });
});

describe('countChars', () => {
  it('不数空白（与列表页的字数口径一致）', () => {
    expect(countChars('一 二\n三')).toBe(3);
  });
});
