/**
 * 消息流「选中文本 → 复制 / 添加到对话」的纯逻辑。
 *
 * 这里收着两件事：
 *
 * 1. **回归定位**：把用户选中的那段文字，在**已渲染的消息 DOM** 里重新找回来。
 *    消息正文是 Markdown 渲染结果（`<strong>` / `<code>` / `<a>` 会把一句话切成好几个
 *    文本节点），所以**不能**按「第 N 个字符」记位置——那是渲染细节，消息内容一变
 *    （流式追加、产物挂载、切换档位）就失效，引用会静默飘到别的字上。
 *    改用**归一化文本查找**：把整块正文下所有文本节点拼成一个串（连续空白折叠成
 *    单个空格），在拼接串上找 needle，再映射回 `(文本节点, 偏移)`。因此：
 *    - 跨内联节点（加粗 / 行内代码 / 链接）也能命中；
 *    - 浏览器在块级元素之间插入的换行不参与比较；
 *    - 消息重渲染后依然找得到（这是引用下划线能"跟着内容走"的前提）。
 *
 * 2. **着色**：命中交给 CSS Custom Highlight API（与 `session/textHighlight.ts` 同一个底座），
 *    **零 DOM 改动** —— 绝不去包裹 / 切分 React 渲染出来的文本节点。
 *    环境不支持该 API 时（jsdom / 老浏览器）只是**没有下划线**，功能本身照常工作。
 *
 * 测试入口：`tests/lib/editor/selectionQuote.test.ts`。
 */

import { clearHighlight, setHighlight } from '../session/textHighlight';

/** 引用下划线的高亮名（对应 `theme/index.css` 的 `::highlight(quote-ref)`） */
export const QUOTE_HL = 'quote-ref';

/** 单条引用最多收录的字符数：防止「全选一整篇回答」把输入区与请求载荷撑爆 */
export const MAX_QUOTE_CHARS = 2000;

/** 胶囊上展示的摘要长度（超出截断成 `…`） */
export const QUOTE_LABEL_MAX = 22;

/**
 * 一条「加入对话」的引用。
 *
 * - `messageId` + `text` 是**定位依据**：重渲染后据此在消息 DOM 里把原文找回来；
 * - `sessionId` 是**归属**：切会话时按它过滤与清理（引用的消息 id 在别的会话里
 *   指不到任何东西，留着只会让下划线凭空消失、胶囊又删不掉）。
 */
export interface QuoteRef {
  id: string;
  messageId: string;
  sessionId: string;
  text: string;
}

/** 折叠空白并去掉首尾空白 —— 引文与查找共用它，保证两侧口径一致 */
export function normalizeQuoteText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * 归一化并记录「归一化下标 → 原始下标」的映射。
 *
 * 连续空白被折叠成**一个**空格；该空格记录到空白串的**第一个**字符上，
 * 于是映射回 DOM 时落在真实存在的位置上，而不是越界到下一个节点。
 */
export function normalizeWithIndex(raw: string): { text: string; origin: number[] } {
  let text = '';
  const origin: number[] = [];
  for (let i = 0; i < raw.length; ) {
    if (/\s/.test(raw[i])) {
      origin.push(i);
      text += ' ';
      while (i < raw.length && /\s/.test(raw[i])) i += 1;
    } else {
      origin.push(i);
      text += raw[i];
      i += 1;
    }
  }
  return { text, origin };
}

/** 拼接串里的一个文本节点（`start` = 该节点首字符在拼接串中的下标） */
interface TextSpan {
  node: Text;
  start: number;
}

/** 收集 root 下全部可参与匹配的文本节点（跳过 script / style） */
function collectTextSpans(root: HTMLElement): { spans: TextSpan[]; raw: string } {
  const spans: TextSpan[] = [];
  let raw = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    spans.push({ node: text, start: raw.length });
    raw += text.nodeValue ?? '';
  }
  return { spans, raw };
}

/** 拼接串下标 → DOM 位置；越过全部节点时收敛到最后一个节点的末尾 */
function pointAt(spans: TextSpan[], rawIndex: number): { node: Text; offset: number } | null {
  for (const span of spans) {
    const len = span.node.nodeValue?.length ?? 0;
    if (rawIndex < span.start + len) {
      return { node: span.node, offset: rawIndex - span.start };
    }
  }
  const last = spans[spans.length - 1];
  return last ? { node: last.node, offset: last.node.nodeValue?.length ?? 0 } : null;
}

/**
 * 在 `root` 内按**归一化文本**查找 needle，返回第一个命中的 `Range`。
 *
 * 命中可跨越多个内联节点；找不到返回 `null`（引用来源的消息被编辑过、
 * 或那段文字已不在正文里 —— 调用方应静默跳过，而不是拿整条消息凑合）。
 */
export function findTextRange(root: HTMLElement, needle: string): Range | null {
  const target = normalizeQuoteText(needle);
  if (!target) return null;
  const { spans, raw } = collectTextSpans(root);
  if (spans.length === 0 || raw === '') return null;
  const { text: haystack, origin } = normalizeWithIndex(raw);
  const at = haystack.indexOf(target);
  if (at < 0) return null;
  const startRaw = origin[at];
  const endRaw = origin[at + target.length - 1];
  if (startRaw === undefined || endRaw === undefined) return null;
  const start = pointAt(spans, startRaw);
  const end = pointAt(spans, endRaw);
  if (!start || !end) return null;
  const startLen = start.node.nodeValue?.length ?? 0;
  const endLen = end.node.nodeValue?.length ?? 0;
  const range = document.createRange();
  range.setStart(start.node, Math.min(start.offset, startLen));
  range.setEnd(end.node, Math.min(end.offset + 1, endLen));
  return range;
}

/** 重新登记全部引用下划线（空数组 = 撤掉）；返回 false 表示环境不支持 */
export function paintQuoteHighlights(ranges: Range[]): boolean {
  return setHighlight(QUOTE_HL, ranges);
}

/** 撤掉引用下划线（消息流卸载时调用） */
export function clearQuoteHighlights(): void {
  clearHighlight(QUOTE_HL);
}

/** 收录引用时截断超长选区（保留原有换行：发出去是引用块，段落结构有意义） */
export function clampQuoteText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_QUOTE_CHARS ? trimmed.slice(0, MAX_QUOTE_CHARS) : trimmed;
}

/** 胶囊文案：折叠空白 + 截断（超出补 `…`），保证一行放得下 */
export function quoteChipLabel(text: string, max: number = QUOTE_LABEL_MAX): string {
  const flat = normalizeQuoteText(text);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/** 把一段文本转成 Markdown 引用块（空行也要带 `>`，否则引用会断成两段） */
function toQuoteBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * 发送前把待发文本与引用拼成最终消息体：引用块在前、用户输入在后。
 *
 * 没有引用时原样返回；只挂了引用时只发引用块 —— 拼接规则写在一处，
 * 用户看到胶囊就能预期发出去的是什么（而不是各调用点各拼一套）。
 */
export function buildQuotedMessage(text: string, quotes: Array<{ text: string }>): string {
  if (quotes.length === 0) return text;
  const block = quotes.map((q) => toQuoteBlock(q.text)).join('\n');
  const body = text.trim();
  return body === '' ? block : `${block}\n\n${body}`;
}
