/**
 * contentEditable 输入区 DOM 工具：纯文本抽取、光标偏移换算、区间替换。
 *
 * 约定（抽取与定位两套遍历必须严格同构）：
 * - 附件徽章 `[data-att-id]` 为不可编辑岛，不占文本长度；
 * - `<br>` 计一个 `\n`；
 * - 块级子节点（Chrome 回车产生的 div/p）折行计一个 `\n`，首块不补前导换行；
 * - 仅含单个 `<br>` 的空块计一个 `\n`（空行）。
 *
 * 渲染层不重绘 editable 子节点（非受控 DOM），React 只经 createPortal
 * 往 `[data-att-id]` span 内挂徽章，避免破坏光标与中文输入法组合。
 */

interface DomPoint {
  node: Node;
  offset: number;
}

function isChip(node: Node): boolean {
  return node instanceof HTMLElement && node.dataset.attId !== undefined;
}

function isBr(node: Node): boolean {
  return node.nodeName === 'BR';
}

function isBlockEl(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = (node as HTMLElement).tagName;
  return tag === 'DIV' || tag === 'P';
}

/** 递归累加纯文本（规则见文件头）；chipText 提供时徽章以 token 占位 */
function appendNode(
  node: Node,
  out: string[],
  state: { emitted: boolean },
  chipText?: (id: string) => string,
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const v = node.nodeValue ?? '';
    if (v) state.emitted = true;
    out.push(v);
    return;
  }
  if (isChip(node)) {
    if (chipText) out.push(chipText((node as HTMLElement).dataset.attId!));
    return;
  }
  if (isBr(node)) {
    state.emitted = true;
    out.push('\n');
    return;
  }
  if (isBlockEl(node)) {
    const el = node as HTMLElement;
    if (el.childNodes.length === 1 && isBr(el.firstChild!)) {
      // 空行 <div><br></div>：单个换行
      if (state.emitted) out.push('\n');
      state.emitted = true;
      return;
    }
    if (state.emitted) out.push('\n');
    for (const child of Array.from(el.childNodes))
      appendNode(child, out, state, chipText);
    state.emitted = true;
    return;
  }
  // 其余内联元素（极少数情况）：直接递归
  for (const child of Array.from(node.childNodes))
    appendNode(child, out, state, chipText);
}

/** 抽取输入区纯文本（徽章不占长度） */
export function extractEditableText(root: HTMLElement): string {
  const out: string[] = [];
  const state = { emitted: false };
  for (const child of Array.from(root.childNodes)) appendNode(child, out, state);
  return out.join('');
}

/** 徽章 token 定界符（私用区字符，用户输入不可达） */
export const ATT_TOKEN_OPEN = '\uE000';
export const ATT_TOKEN_CLOSE = '\uE001';

/** Custom MIME for in-app rich copy: payload is { rich, attachments } JSON; pasting back into the input field restores the inline layout losslessly */
export const RICH_CLIP_MIME = 'application/x-nanowork-chat';

/**
 * 富文本抽取：徽章以 `\uE000<attId>\uE001` token 占位，
 * 随消息落库为 richContent，供气泡内联混排渲染。
 */
export function extractEditableRichText(root: HTMLElement): string {
  const out: string[] = [];
  const state = { emitted: false };
  for (const child of Array.from(root.childNodes)) {
    appendNode(child, out, state, (id) => `${ATT_TOKEN_OPEN}${id}${ATT_TOKEN_CLOSE}`);
  }
  return out.join('');
}

/** 富文本分段：text 段与 att 段交错，供气泡渲染 */
export type RichSegment =
  | { type: 'text'; text: string }
  | { type: 'att'; id: string };

export function splitRichContent(rich: string): RichSegment[] {
  const segments: RichSegment[] = [];
  const re = new RegExp(
    `${ATT_TOKEN_OPEN}([^${ATT_TOKEN_CLOSE}]*)${ATT_TOKEN_CLOSE}`,
    'g',
  );
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rich))) {
    if (m.index > last) segments.push({ type: 'text', text: rich.slice(last, m.index) });
    segments.push({ type: 'att', id: m[1] });
    last = m.index + m[0].length;
  }
  if (last < rich.length) segments.push({ type: 'text', text: rich.slice(last) });
  return segments;
}

/** 当前光标相对纯文本的偏移；选区不在输入区内时返回文本长度（视作末尾） */
export function editableCaretOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return extractEditableText(root).length;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) {
    return extractEditableText(root).length;
  }
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const frag = pre.cloneContents();
  const out: string[] = [];
  const state = { emitted: false };
  for (const child of Array.from(frag.childNodes)) appendNode(child, out, state);
  return out.join('').length;
}

/** 选区是否落在输入区内（决定徽章插入「光标处」还是「末尾」） */
export function hasSelectionInside(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  return root.contains(sel.getRangeAt(0).startContainer);
}

/**
 * 取当前选区 range：仅当起点在 root 内**且未折叠**时返回，否则 null。
 * 复制 / 剪贴 / 删除都必须基于「有实际选中内容」的 range。
 */
function selectionRange(root: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  if (range.collapsed) return null;
  return range;
}

/**
 * 抽取选区内容（与全文抽取严格同构）。
 * chipText 提供时徽章以 token 占位，否则徽章计 0 字符（与 extractEditableText 一致）。
 * 选区无效（折叠 / 不在 root 内）时返回 null —— 调用方据此区分「空选区」与「选区无内容」。
 */
function extractRangeText(
  root: HTMLElement,
  chipText?: (id: string) => string,
): string | null {
  const range = selectionRange(root);
  if (!range) return null;
  const frag = range.cloneContents();
  const out: string[] = [];
  const state = { emitted: false };
  for (const child of Array.from(frag.childNodes)) {
    appendNode(child, out, state, chipText);
  }
  return out.join('');
}

/** 抽取选区纯文本（徽章不占长度）；无有效选区返回 null */
export function extractSelectionText(root: HTMLElement): string | null {
  return extractRangeText(root);
}

/** 抽取选区富文本（徽章 → `\uE000<id>\uE001`）；无有效选区返回 null */
export function extractSelectionRichText(root: HTMLElement): string | null {
  return extractRangeText(
    root,
    (id) => `${ATT_TOKEN_OPEN}${id}${ATT_TOKEN_CLOSE}`,
  );
}

/** 选区内包含的徽章 id（按 DOM 顺序，供剪贴后同步移除附件） */
export function selectionChipIds(root: HTMLElement): string[] {
  const range = selectionRange(root);
  if (!range) return [];
  const ids: string[] = [];
  const walk = (node: Node): void => {
    if (isChip(node)) {
      ids.push((node as HTMLElement).dataset.attId!);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(range.cloneContents().childNodes)) walk(child);
  return ids;
}

/**
 * 删除选区内容（含徽章 span），光标落在删除处。
 * @returns 被删除的徽章 id 列表 —— 调用方据此从 attachments 状态移除并释放 objectURL
 */
export function deleteSelection(root: HTMLElement): string[] {
  const range = selectionRange(root);
  if (!range) return [];
  const ids = selectionChipIds(root);
  range.deleteContents();
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return ids;
}

// ——— 撤销 / 重做快照 ———

/** 输入区快照：DOM 结构 + 富文本副本 + 光标纯文本偏移 */
export interface EditSnapshot {
  /** 输入区 innerHTML（含徽章 span，contenteditable=false 会随属性序列化保留） */
  html: string;
  /** 富文本副本（徽章 → token），供校验与文本镜像重建 */
  rich: string;
  /** 光标相对纯文本的偏移（还原时按此定位） */
  caret: number;
}

/** 捕获当前输入区快照 */
export function captureSnapshot(root: HTMLElement): EditSnapshot {
  return {
    html: root.innerHTML,
    rich: extractEditableRichText(root),
    caret: editableCaretOffset(root),
  };
}

/**
 * 还原快照到输入区：整体重写 innerHTML 并尽量恢复光标偏移。
 *
 * 注意：徽章内部的 React portal 内容不会被 innerHTML 序列化，还原后需由调用方
 * 经 `collectChipSpans` 重建 `chipSpans` 映射，React 重渲染时会重新 createPortal 挂载。
 */
export function restoreSnapshot(root: HTMLElement, snap: EditSnapshot): void {
  root.innerHTML = snap.html;
  // 光标还原是「尽力而为」：DOM 结构重建后偏移可能越界，失败则退到末尾
  try {
    replaceEditableRange(root, snap.caret, snap.caret, '');
  } catch {
    placeCaretAtEnd(root);
  }
}

/** 从 DOM 重建「徽章 id → span」映射（还原快照后调用，供 React portal 重新挂载） */
export function collectChipSpans(
  root: HTMLElement,
): Map<string, HTMLSpanElement> {
  const map = new Map<string, HTMLSpanElement>();
  root
    .querySelectorAll<HTMLSpanElement>('[data-att-id]')
    .forEach((el) => {
      const id = el.dataset.attId;
      if (id) map.set(id, el);
    });
  return map;
}

/**
 * 把纯文本偏移换算回 DOM 点（与 appendNode 同构遍历）。
 * target 落在文本节点内 → 节点内偏移；落在换行边界 → 父节点子序号边界。
 */
function findPosition(root: HTMLElement, target: number): DomPoint {
  let cum = 0;
  let emitted = false;
  let point: DomPoint = { node: root, offset: 0 };
  let done = false;

  const walkChildren = (parent: Node): void => {
    const children = Array.from(parent.childNodes);
    for (let i = 0; i < children.length && !done; i++) {
      const child = children[i];
      if (child.nodeType === Node.TEXT_NODE) {
        const len = (child.nodeValue ?? '').length;
        if (target <= cum + len) {
          point = { node: child, offset: target - cum };
          done = true;
          return;
        }
        cum += len;
        emitted = true;
        point = { node: parent, offset: i + 1 };
      } else if (isChip(child)) {
        continue;
      } else if (isBr(child)) {
        if (target === cum) {
          point = { node: parent, offset: i };
          done = true;
          return;
        }
        cum += 1;
        emitted = true;
        point = { node: parent, offset: i + 1 };
      } else if (isBlockEl(child)) {
        const el = child as HTMLElement;
        if (el.childNodes.length === 1 && isBr(el.firstChild!)) {
          if (emitted) {
            if (target === cum) {
              point = { node: parent, offset: i };
              done = true;
              return;
            }
            cum += 1;
          }
          emitted = true;
          point = { node: parent, offset: i + 1 };
          continue;
        }
        if (emitted) {
          if (target === cum) {
            point = { node: parent, offset: i };
            done = true;
            return;
          }
          cum += 1;
          point = { node: parent, offset: i + 1 };
        }
        walkChildren(el);
        if (done) return;
        emitted = true;
        point = { node: parent, offset: i + 1 };
      } else {
        walkChildren(child);
        if (done) return;
      }
    }
  };

  walkChildren(root);
  return point;
}

/**
 * 删除纯文本区间 [start, end) 并在原处插入 snippet，光标落在插入内容之后。
 * snippet 为空串即纯删除。
 */
export function replaceEditableRange(
  root: HTMLElement,
  start: number,
  end: number,
  snippet: string,
): void {
  const range = document.createRange();
  const p1 = findPosition(root, Math.max(0, start));
  const p2 = end > start ? findPosition(root, end) : p1;
  range.setStart(p1.node, p1.offset);
  range.setEnd(p2.node, p2.offset);
  range.deleteContents();
  if (snippet) {
    const tn = document.createTextNode(snippet);
    range.insertNode(tn);
    range.setStartAfter(tn);
  }
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** 在当前光标处插入文本（选区不在输入区内时追加到末尾） */
export function insertAtEditableCaret(root: HTMLElement, snippet: string): void {
  const offset = editableCaretOffset(root);
  replaceEditableRange(root, offset, offset, snippet);
}

/** 光标移到输入区末尾 */
export function placeCaretAtEnd(root: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * 在当前 selection 起点处插入 node（不依赖 range.insertNode）。
 *
 * 为什么不用 range.insertNode：当光标落在 textNode 末尾 offset（offset === length）时，
 * range.insertNode 会先 split textNode 产生一个空 textNode（[length, length)），再把新节点
 * 插到这个空 textNode 之后。这把 chip 之间的相对位置完全打乱 —— 多段文本+附件交错插入时，
 * 先插入的 chip 会被后续 text 产生的空 textNode 挤到更末尾，最终 chip 顺序与 segments 相反。
 *
 * 这里改用「textNode 末尾 → insertBefore textNode.nextSibling」「textNode 中间 → splitText +
 * insertBefore 新 textNode」「root element offset → insertBefore childNodes[offset]」「其他 →
 * appendChild」四条路径，避免空 textNode 产生。移动 selection 到 node 之后。
 */
export function insertNodeAtSelection(root: HTMLElement, node: Node): void {
  const sel = window.getSelection();
  if (
    !sel ||
    sel.rangeCount === 0 ||
    !root.contains(sel.getRangeAt(0).startContainer)
  ) {
    root.appendChild(node);
    placeCaretAtEnd(root);
    return;
  }
  const range = sel.getRangeAt(0);
  let target: Node | null = null;
  if (range.startContainer === root) {
    target = range.startContainer.childNodes[range.startOffset] ?? null;
  } else if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const textNode = range.startContainer as Text;
    const len = (textNode.nodeValue ?? "").length;
    if (range.startOffset === len) {
      target = textNode.nextSibling;
    } else if (range.startOffset === 0) {
      target = textNode;
    } else {
      target = textNode.splitText(range.startOffset);
    }
  }
  if (target) root.insertBefore(node, target);
  else root.appendChild(node);
  const newRange = document.createRange();
  newRange.setStartAfter(node);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

/** 清空全部内容（含徽章 span；调用方自行同步状态与卸载 portal） */
export function clearEditableContent(root: HTMLElement): void {
  root.textContent = '';
}

/**
 * 空态归一：内容删光后浏览器常残留 `<br>`/空块，导致 `:empty::before`
 * 占位符不显示；确认无文本且无徽章时清空 innerHTML。
 */
export function normalizeEditableEmpty(root: HTMLElement): void {
  if (root.childNodes.length === 0) return;
  if (root.querySelector('[data-att-id]')) return;
  if (extractEditableText(root) !== '') return;
  root.innerHTML = '';
}

/**
 * 外部受控写入（如点击提示词标签整体替换输入）：
 * 移除全部文本/换行节点、保留徽章顺序，新文本追加在徽章之后，光标置末。
 */
export function replaceEditableTextKeepChips(root: HTMLElement, text: string): void {
  for (const child of Array.from(root.childNodes)) {
    if (!isChip(child)) root.removeChild(child);
  }
  if (text) root.appendChild(document.createTextNode(text));
  placeCaretAtEnd(root);
}
