/**
 * 富文本 ⇄ Markdown：知识库文档编辑器的**唯一真相转换层**。
 *
 * ## 为什么存 Markdown 而不是 HTML
 *
 * 检索吃的是纯文本。若把编辑器产出的 HTML 存进库，切块出来的每一段都会带着标签，
 * 检索命中时返回的片段就是一堆 `<span style=...>`；要么在服务端再剥一遍标签（多一份
 * 实现、多一处会说谎的地方），要么让用户搜到标签。Markdown 既是**人能读的纯文本**，
 * 又能表达标题/列表/引用/行内样式，还是 `.md` 上传的原始格式 —— 三者同一种表示。
 *
 * ## 为什么 DOM 不是真相
 *
 * `contentEditable` 的 DOM 是**浏览器给的**形态（换行可能是 `<div>` 也可能是 `<br>`，
 * 加粗可能是 `<b>` 也可能是 `<strong>`）。所以编辑器只把它当输入面：每次改动就
 * 序列化回 Markdown，重新打开时再从 Markdown 反序列化。任何「直接把 DOM 存起来」
 * 的做法都会在某次浏览器升级后悄悄变形。
 *
 * ## 支持的子集（刻意很小）
 *
 * 块：段落 / H1-H3 / 无序列表 / 有序列表 / 引用 / 代码块 / 分割线 / **GFM 表格**。
 * 行内：`**粗**` `*斜*` `<u>下划线</u>` `~~删除~~` `` `代码` `` `[文字](链接)` / **图片**。
 *
 * 子集之外的东西**原样保留为文本**，不做"猜你想表达什么"的转换：编辑器不该在
 * 用户不知情的情况下改写他没动过的内容。
 *
 * ## 图片为什么渲染成 `<figure>`
 *
 * 图注（`![图注](asset:<id>)` 里的那一段）在纯 Markdown 里是**看不见的** ——
 * 它藏在 `alt` 里，只有读屏软件、加载失败和检索能读到。而图注是图片**唯一的检索
 * 信号**（图片本体不进切块、不进向量），用户必须看得见、改得动。所以独占一行的
 * 图片在这里变成 `<figure><img><figcaption>`：正文里多出一行可编辑的字，
 * 序列化时以 `figcaption` 为准（`alt` 只是兜底，见 `figureToBlock`）。
 *
 * ## 表格为什么必须在这里（不加就是静默丢数据）
 *
 * `contentEditable` 里 `<table>` 是浏览器一等的可编辑结构：从 `.docx` 解析出来的、
 * 用户自己敲出来的表格都以 `<table>` 形态出现在 DOM 里。这个转换层若没有 `table`
 * 分支，它就落到 `default` → `inlineToMarkdown` → 表格塌成一串没有分隔的文字，
 * 而**保存时不报错**。症状是「打开一次文档表格就没了」，且每存一次丢一次。
 *
 * 图片同理：`data:` 协议的 `<img>` 一律**丢弃**（见 `inlineToMarkdown` 的 `img` 分支）
 * —— 把 base64 写进 Markdown 会把整块文本撑爆，检索随之失效。
 *
 * ## 对齐信息为什么用 `data-align` 而不是 `style`
 *
 * 浏览器与 `execCommand` 会改写 `style`（合并、去重、加 `!important`），而 `data-*`
 * 它们不碰。往返的稳定性全靠这一点。
 */

export type BlockKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'quote'
  | 'code'
  | 'divider';

/** 标题层级 → `formatBlock` 的参数（两处必须一致，否则工具栏点了没反应）。 */
export const BLOCK_TAGS: Record<'paragraph' | 'h1' | 'h2' | 'h3', string> = {
  paragraph: 'div',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
};

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => ESCAPE[char] ?? char);
}

/** 属性值只需补引号：文本已经过 `escapeHtml`，再转一次 `&` 会变成 `&amp;amp;`。 */
function attrValue(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/**
 * 图注 → Markdown 的 alt 段：转义 `\` `[` `]`。
 *
 * `]` 会提前结束 alt，`[` 会让嵌套的 `![` 被当成新图片，`\` 是转义符本身 ——
 * 三个都必须处理，否则「图注里写了个方括号」这一条就能把整条引用改成坏图。
 * 与服务端的 `parsing._escape_alt` 保持一致（同一个格式，两处要写同一套规则）。
 */
function escapeCaption(caption: string): string {
  return caption.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/]/g, '\\]');
}

/** `escapeCaption` 的逆运算（读回 Markdown 时用）。 */
function unescapeCaption(caption: string): string {
  return caption
    .replace(/\\\]/g, ']')
    .replace(/\\\[/g, '[')
    .replace(/\\\\/g, '\\');
}

/**
 * 切一行 GFM 表格：去掉首尾管道，按**未转义**的 `|` 分格，`\|` 还原成 `|`。
 *
 * 必须手写扫描而不是 `split('|')`：单元格里合法地可以出现 `|`（转义成 `\|`），
 * 用 split 会把一格拆成两格 —— 症状是「表格存回去多了一列」。
 */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let buffer = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
      buffer += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += char;
  }
  cells.push(buffer.trim());
  return cells;
}

/** 分隔行：`| --- | :--: | ---: |`。它是「表格」与「一行带竖线的普通文字」的唯一判据。 */
export function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function isTableRowLine(line: string): boolean {
  return line.trim() !== '' && line.includes('|');
}

/** 分隔行的对齐 → `data-align`。 */
function alignOf(cell: string): '' | 'left' | 'center' | 'right' {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

/** 对齐 → 分隔行里的写法（`---` / `:---` / `:---:` / `---:`）。 */
function separatorCell(align: string | null): string {
  if (align === 'center') return ':---:';
  if (align === 'right') return '---:';
  if (align === 'left') return ':---';
  return '---';
}

/**
 * 行内 Markdown → HTML。
 *
 * 顺序是刻意的：先把行内代码抽成占位符，再处理强调。否则 `` `a**b**c` `` 里的 `**`
 * 会被当成加粗，把一个代码片段拆成一堆标签。
 */
function inlineToHtml(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    // 单星号斜体：前后不能是星号（否则会把 ** 的残余吃掉）
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    // 下划线在 Markdown 里没有语法，用 HTML 标签表达（编辑器也是这么产出的）
    .replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/g, '<u>$1</u>')
    // 图片必须在链接**之前**：先跑链接的话 `![a](b)` 会变成 `!<a ...>a</a>`
    // 注意这里 `text` 已经被 `escapeHtml` 过一次，所以 src / 图注都**不要**再转义
    // （再转一次 `&` 会变成 `&amp;amp;`，图片地址带查询串时直接失效）
    .replace(
      /!\[((?:[^\]\\]|\\.)*)\]\(([^)\s]+)\)/g,
      (match, rawCaption: string, src: string) =>
        // `data:` = base64 内嵌图：不进 DOM（进了就会被存回 Markdown，把块撑爆）
        src.startsWith('data:')
          ? ''
          : `<img src="${attrValue(src)}" alt="${attrValue(unescapeCaption(rawCaption))}">`,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    const code = codes[Number(index)] ?? '';
    return `<code>${escapeHtml(code)}</code>`;
  });
}

/**
 * Markdown 图片 → `<figure>`（图片 + 一行**可编辑的图注**）。
 *
 * ## 为什么不是裸 `<img alt="...">`
 *
 * `alt` 只在图片加载失败、读屏软件、以及检索时可见 —— 用户根本看不出自己「已经
 * 写过图注」，更没法改。而图注是图片**唯一的检索信号**（图片本体不进切块、不进
 * 向量），所以它必须是正文里一行看得见、点得进去的字。
 *
 * ## 为什么 alt 仍然要写
 *
 * 图注与 alt 是同一份内容的两处落点：
 * - `figcaption` 给人改（编辑时可见）；
 * - `alt` 给「figure 被浏览器拆掉」这种情况兜底（粘贴、拖拽、某些 execCommand
 *   都会把结构打散），也让导出 .md 后别的渲染器还能显示图注。
 *
 * 序列化时**以 figcaption 为准**（见 `figureToBlock`）：用户改的是它。
 */
function figureHtml(src: string, caption: string): string {
  const safe = escapeHtml(caption);
  return (
    `<figure><img src="${attrValue(escapeHtml(src))}" alt="${attrValue(safe)}">` +
    `<figcaption>${safe}</figcaption></figure>`
  );
}

/**
 * Markdown → HTML（编辑器初始内容）。
 *
 * 段落输出 `<div>` 而不是 `<p>`：Chromium 在 contentEditable 里回车生成的就是 `<div>`，
 * 两种混用会让「序列化时按什么分组」出现两套规则。
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // 代码块：成对围栏之间的内容**原样**输出（不做行内转换）
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // 列表：连续的同类行合成一个 ul / ol
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const ordered = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const tag = bullet ? 'ul' : 'ol';
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const match = bullet
          ? /^(\s*)[-*+]\s+(.*)$/.exec(current)
          : /^(\s*)\d+\.\s+(.*)$/.exec(current);
        if (!match) break;
        items.push(`<li>${inlineToHtml(match[2])}</li>`);
        index += 1;
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // 引用：连续多行合一个 blockquote
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoted.push(inlineToHtml(lines[index].replace(/^>\s?/, '')));
        index += 1;
      }
      html.push(`<blockquote>${quoted.join('<br>')}</blockquote>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineToHtml(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    // 独占一行的图片 → `<figure>`：图注是图片下方那行**可编辑**的字。
    //
    // 只认「这一行只有一个图片」，不认「句子中间夹一张图」：后者没有「下方」这个
    // 位置，硬塞一个 figcaption 会把一句话劈成两半。多图同行同理（会得到两个
    // figure，序列化回来变成两个块 —— 用户没动过的东西不该被改写）。
    const imageOnly = /^!\[((?:[^\]\\]|\\.)*)\]\(([^)\s]+)\)$/.exec(line.trim());
    if (imageOnly) {
      if (!imageOnly[2].startsWith('data:')) {
        html.push(figureHtml(imageOnly[2], unescapeCaption(imageOnly[1])));
      }
      index += 1;
      continue;
    }

    // GFM 表格：本行有管道 **且下一行是分隔行**。判据必须是这个组合 ——
    // 只看「含 |」会把 `甲 | 乙` 这种普通文字当成表格，那是很常见的正文写法。
    if (isTableRowLine(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[index + 1]).map(alignOf);
      const body: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && isTableRowLine(lines[cursor])) {
        body.push(splitTableRow(lines[cursor]));
        cursor += 1;
      }

      const column = (tag: 'th' | 'td', text: string, at: number) => {
        const align = aligns[at] ?? '';
        // 单元格里必须有一层块级元素：裸文本的 `<td>` 在 contentEditable 里
        // **点不进去**（Chromium 没有可放置 caret 的内部块），用户想改这一格却
        // 只能把光标落到表格前面。Chromium 自己插入的表格也是 `<td><div>` 结构。
        return `<${tag}${align === '' ? '' : ` data-align="${align}"`}><div>${inlineToHtml(text)}</div></${tag}>`;
      };
      const width = header.length;
      const head = `<thead><tr>${header
        .map((text, at) => column('th', text, at))
        .join('')}</tr></thead>`;
      const rows = body
        .map((cells) => {
          // 补齐到表头宽度：GFM 允许某些行少写格子，但 DOM 表格行列不等宽会错位
          const filled = Array.from({ length: width }, (_v, at) => cells[at] ?? '');
          return `<tr>${filled.map((text, at) => column('td', text, at)).join('')}</tr>`;
        })
        .join('');
      html.push(`<table>${head}${rows === '' ? '' : `<tbody>${rows}</tbody>`}</table>`);
      index = cursor;
      continue;
    }

    // 空行不产出空段落：`<div><br></div>` 会让 caret 定位变怪
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // 行内转换后可能变空（例如整行只有一个 `data:` 图片，被丢弃了）：
    // 不跳过就会在编辑器里留下一个空段落，用户看到的是莫名其妙多出来的空行
    const inline = inlineToHtml(line);
    if (inline !== '') html.push(`<div>${inline}</div>`);
    index += 1;
  }

  return html.join('');
}

/** 行内 DOM → Markdown（标签名按小写比，`<b>` 与 `<strong>` 都要认）。 */
function inlineToMarkdown(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';

  if (node.nodeType !== 1) return '';

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const inner = Array.from(element.childNodes).map(inlineToMarkdown).join('');

  switch (tag) {
    case 'br':
      return '\n';
    case 'b':
    case 'strong':
      return inner.trim() === '' ? inner : `**${inner}**`;
    case 'i':
    case 'em':
      return inner.trim() === '' ? inner : `*${inner}*`;
    case 'u':
      return inner.trim() === '' ? inner : `<u>${inner}</u>`;
    case 's':
    case 'strike':
    case 'del':
      return inner.trim() === '' ? inner : `~~${inner}~~`;
    case 'code':
      return inner.trim() === '' ? inner : `\`${inner}\``;
    case 'a': {
      const href = element.getAttribute('href') ?? '';
      if (href === '' || inner.trim() === '') return inner;
      return `[${inner}](${href})`;
    }
    case 'img': {
      const src = element.getAttribute('src') ?? '';
      const alt = element.getAttribute('alt') ?? '';
      // `data:` 丢弃而不是保留：base64 写进 Markdown 会把整块文本撑到几十万字，
      // 切块与检索当场失效（用户看到的是「保存后文档体积暴涨、搜不到内容」）
      if (src === '' || src.startsWith('data:')) return '';
      return `![${escapeCaption(alt)}](${src})`;
    }
    default:
      // span / font / 未知行内元素：只保留文字（浏览器会塞各种样式壳子进来）
      return inner;
  }
}

/** 列表项 → 若干行（支持一层嵌套：`  - `）。 */
function listToLines(list: HTMLElement, ordered: boolean, depth: number): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);
  let counter = 1;

  for (const child of Array.from(list.children)) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    const item = child as HTMLElement;
    const nested = Array.from(item.children).filter((element) =>
      ['ul', 'ol'].includes(element.tagName.toLowerCase()),
    );
    // 行内内容只取非列表子节点，否则子列表的文本会被拼进父项
    const inline = Array.from(item.childNodes)
      .filter((node) => !(node.nodeType === 1 && ['ul', 'ol'].includes((node as HTMLElement).tagName.toLowerCase())))
      .map(inlineToMarkdown)
      .join('')
      .trim();
    const prefix = ordered ? `${counter}. ` : '- ';
    counter += 1;
    lines.push(`${indent}${prefix}${inline}`.trimEnd());
    for (const sub of nested) {
      lines.push(
        ...listToLines(sub as HTMLElement, sub.tagName.toLowerCase() === 'ol', depth + 1),
      );
    }
  }
  return lines;
}

/**
 * 单元格 → GFM 单元格文本。
 *
 * 两处必须处理：
 * - **换行压成空格**：GFM 表格的一个单元格里不能有真换行（那会把表格切断）
 * - **`|` 必须转义成 `\|`**：不转义就等于凭空多出一列
 */
function cellToGfm(cell: HTMLElement): string {
  return inlineToMarkdown(cell)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `<table>` → GFM 表格的行（一个块）。
 *
 * 第一行当表头：GFM 表格**必须**有表头，而 `execCommand` 插出来的表格常常没有
 * `<thead>`。与其报错，不如按「第一行是列名」处理 —— 这也正是人写表格的习惯。
 */
function tableToBlock(table: HTMLElement): string[] {
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    // 嵌套表格里的 tr 归内层表：不过滤的话内外两层会串成一张
    (row) => row.closest('table') === table,
  );
  const cellsOf = (row: Element) =>
    Array.from(row.children)
      .filter((cell) => ['td', 'th'].includes(cell.tagName.toLowerCase()))
      .map((cell) => cellToGfm(cell as HTMLElement));

  const parsed = rows.map(cellsOf).filter((cells) => cells.length > 0 && cells.some((cell) => cell !== ''));
  if (parsed.length === 0) return [];

  const header = parsed[0];
  const width = header.length;
  const aligns = Array.from(rows[0].children)
    .filter((cell) => ['td', 'th'].includes(cell.tagName.toLowerCase()))
    .map((cell) => (cell as HTMLElement).getAttribute('data-align'));

  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_v, at) => cells[at] ?? '').join(' | ')} |`;
  const separator = `| ${Array.from({ length: width }, (_v, at) => separatorCell(aligns[at] ?? null)).join(' | ')} |`;

  return [line(header), separator, ...parsed.slice(1).map(line)];
}

/**
 * 图注文本：块级子元素（回车会插 `<div>`、软回车是 `<br>`）之间补一个空格。
 *
 * 直接取 `textContent` 会让「第一行 / 第二行」粘成「第一行第二行」，
 * 而 `innerText` 依赖排版（jsdom 里没有实现，用例会拿到 undefined）——
 * 所以手动在块边界插空格。
 */
function captionText(node: HTMLElement | null): string {
  if (!node) return '';
  const clone = node.cloneNode(true) as HTMLElement;
  for (const br of Array.from(clone.querySelectorAll('br'))) br.replaceWith(' ');
  for (const block of Array.from(clone.querySelectorAll('div, p'))) block.append(' ');
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * `<figure>` → 图片行。
 *
 * **图注优先，且「有 figcaption 就以它为准（哪怕它是空的）」**：
 * `figcaption` 是用户改的那份（看得见、点得进去），`alt` 只是打开文档那一刻的快照。
 * 反过来先取 alt，症状是「图注改完保存又变回原样」—— 而且用户完全看不出是哪一步
 * 把字吃掉的。
 *
 * 空图注也**不能**退回 alt：用户把说明删干净了，保存后它又冒出来，是同一种症状。
 * `alt` 只在**根本没有 figcaption 元素**时兜底（粘贴进来的 `<figure>` 可能只有 alt）。
 */
function figureToBlock(figure: HTMLElement): string[][] {
  const image = figure.querySelector('img');
  const node = figure.querySelector('figcaption');
  const caption = node ? captionText(node) : (image?.getAttribute('alt') ?? '').trim();
  if (!image) {
    // 只剩图注、没有图了（回车把 figure 拆开，或用户删掉了图）：把那段文字当普通
    // 段落留下。直接丢块等于「用户打的字没了」，而且没有任何提示。
    return caption === '' ? [] : [[caption]];
  }
  const src = image.getAttribute('src') ?? '';
  if (src === '' || src.startsWith('data:')) return [];
  return [[`![${escapeCaption(caption)}](${src})`]];
}

/**
 * 一个 DOM 节点 → **若干块**（每块是若干行）。
 *
 * 为什么返回值是「块」而不是扁平的行：Markdown 里块与块之间必须是空行，而块内部
 * （列表项之间、引用行之间）不是。扁平化之后再靠"要不要插空行"去猜，猜错就会在
 * 用户没动的地方多出或少掉一个空行 —— 这种漂移每保存一次就累积一次。
 */
function nodeToBlocks(node: Node): string[][] {
  if (node.nodeType === 3) {
    const text = (node.nodeValue ?? '').replace(/\u200b/g, '');
    if (text.trim() === '') return [];
    // 顶层裸文本（浏览器偶尔会这样）每行算一块
    return text.split('\n').map((line) => [line.trimEnd()]);
  }
  if (node.nodeType !== 1) return [];

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3': {
      const level = Number(tag[1]);
      return [[`${'#'.repeat(level)} ${inlineToMarkdown(element).trim()}`]];
    }
    case 'ul':
      return [listToLines(element, false, 0)];
    case 'ol':
      return [listToLines(element, true, 0)];
    case 'blockquote': {
      const inner = Array.from(element.childNodes)
        .map((child) => nodeToBlocks(child).map((block) => block.join('\n')).join('\n'))
        .join('\n');
      return [inner.split('\n').map((line) => `> ${line}`.trimEnd())];
    }
    case 'pre': {
      const text = element.textContent ?? '';
      return [['```', ...text.replace(/\n$/, '').split('\n'), '```']];
    }
    case 'hr':
      return [['---']];
    case 'table':
      return [tableToBlock(element)];
    case 'figure':
      return figureToBlock(element);
    case 'div':
    case 'p':
      // 浏览器会把块级元素包进 div（粘贴、execCommand 插入都一样）。直接走
      // inlineToMarkdown 会把里面的表格/列表**拍平**成一行文字 —— 所以先看有没有
      // 块级子元素，有就按子节点展开。
      if (element.querySelector('table, ul, ol, blockquote, pre, figure, hr')) {
        return Array.from(element.childNodes).flatMap(nodeToBlocks);
      }
      return [[inlineToMarkdown(element)]];
    case 'li':
      return [[inlineToMarkdown(element)]];
    default:
      return [[inlineToMarkdown(element)]];
  }
}

/** 收尾：去掉行尾空白、丢掉空块、去掉首尾空行。 */
function tidy(blocks: string[][]): string {
  const kept = blocks
    .map((block) => block.map((line) => line.replace(/[ \t]+$/, '')))
    .filter((block) => block.some((line) => line.trim() !== ''));
  while (kept.length > 0 && kept[0].every((line) => line.trim() === '')) kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].every((line) => line.trim() === '')) kept.pop();
  return kept.map((block) => block.join('\n')).join('\n\n');
}

/**
 * HTML → Markdown（保存前做的事）。
 *
 * 用 `document.createElement` 解析而不是正则：contentEditable 产出的嵌套结构
 * （列表里套列表、引用里套段落）用正则拆必然出错。
 */
export function htmlToMarkdown(html: string): string {
  if (html.trim() === '') return '';
  const root = document.createElement('div');
  root.innerHTML = html;
  const blocks: string[][] = [];
  for (const node of Array.from(root.childNodes)) {
    blocks.push(...nodeToBlocks(node));
  }
  return tidy(blocks);
}

/** 字数：编辑器的「N 字」与列表页的 `chars` 口径一致（都数原始字符，不数空白差异）。 */
export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}
