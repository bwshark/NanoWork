import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  insertNodeAtSelection,
  placeCaretAtEnd,
  splitRichContent,
} from '@/lib/editableText';

/**
 * insertNodeAtSelection 单测：覆盖「多段文本+附件交错插入时不产生空 textNode、不打乱 chip 顺序」
 * 这条契约。
 *
 * 关键回归用例：`textNode 末尾 offset + 后续 chip 插入` 必须保持 chip 顺序与插入顺序一致。
 * 旧实现用 `range.insertNode` 会在这里 split 出空 textNode，导致 chip 被推到更末尾。
 */
describe('insertNodeAtSelection 基础位置', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    placeCaretAtEnd(root);
  });
  afterEach(() => {
    root.remove();
  });

  it('root 为空 + 选区在 root 末尾 → appendChild', () => {
    insertNodeAtSelection(root, document.createTextNode('hello'));
    expect(root.childNodes.length).toBe(1);
    expect(root.firstChild?.nodeValue).toBe('hello');
  });

  it('选区在 root element offset 0 → insertBefore 第一个 child', () => {
    root.appendChild(document.createTextNode('B'));
    // selection 在 (root, 0)
    const range = document.createRange();
    range.setStart(root, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    insertNodeAtSelection(root, document.createTextNode('A'));
    expect(root.childNodes.length).toBe(2);
    expect(root.childNodes[0].nodeValue).toBe('A');
    expect(root.childNodes[1].nodeValue).toBe('B');
  });

  it('选区在 root element offset 1 → insertBefore childNodes[1]', () => {
    root.appendChild(document.createTextNode('A'));
    root.appendChild(document.createTextNode('C'));
    const range = document.createRange();
    range.setStart(root, 1);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    insertNodeAtSelection(root, document.createTextNode('B'));
    expect([...root.childNodes].map((n) => n.nodeValue)).toEqual(['A', 'B', 'C']);
  });

  it('选区在 textNode 末尾 offset → insertBefore textNode.nextSibling（不产生空 textNode）', () => {
    const ta = document.createTextNode('AAA');
    const tb = document.createTextNode('BBB');
    root.appendChild(ta);
    root.appendChild(tb);
    const range = document.createRange();
    range.setStart(ta, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    insertNodeAtSelection(root, document.createTextNode('X'));
    // 不应产生空 textNode；X 应插在 ta 之后、tb 之前
    expect(root.childNodes.length).toBe(3);
    expect([...root.childNodes].map((n) => n.nodeValue)).toEqual(['AAA', 'X', 'BBB']);
    expect(root.querySelectorAll('br').length).toBe(0);
  });

  it('选区在 textNode offset 0 → insertBefore textNode（不 split）', () => {
    const t = document.createTextNode('HELLO');
    root.appendChild(t);
    const range = document.createRange();
    range.setStart(t, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    insertNodeAtSelection(root, document.createTextNode('prefix-'));
    expect(root.childNodes.length).toBe(2);
    expect([...root.childNodes].map((n) => n.nodeValue)).toEqual(['prefix-', 'HELLO']);
  });

  it('选区在 textNode 中间 offset → splitText + insertBefore', () => {
    const t = document.createTextNode('HELLO');
    root.appendChild(t);
    const range = document.createRange();
    range.setStart(t, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    insertNodeAtSelection(root, document.createTextNode('XX'));
    expect([...root.childNodes].map((n) => n.nodeValue)).toEqual(['HE', 'XX', 'LLO']);
  });

  it('选区不在 root 内 → appendChild', () => {
    root.appendChild(document.createTextNode('inside'));
    const other = document.createElement('div');
    other.contentEditable = 'true';
    document.body.appendChild(other);
    other.appendChild(document.createTextNode('z'));
    // jsdom 的 focus() 不会自动迁移 selection；显式把 selection 放在 other 里
    const range = document.createRange();
    range.setStart(other, 0);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    insertNodeAtSelection(root, document.createTextNode('fallback'));
    // fallback 应追加到 root 末尾（选区不在 root 内）
    expect(root.lastChild?.nodeValue).toBe('fallback');
    other.remove();
  });
});

describe('insertNodeAtSelection 回归用例：富粘贴 chip 顺序', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    placeCaretAtEnd(root);
  });
  afterEach(() => {
    root.remove();
  });

  /** 构造 chip span（与 Composer 端 makeChipSpan 保持同构：data-att-id + contentEditable=false） */
  const makeChip = (id: string): HTMLSpanElement => {
    const s = document.createElement('span');
    s.dataset.attId = id;
    s.contentEditable = 'false';
    return s;
  };

  it('复现原 bug 场景：text → chip1 → text → chip2，顺序与 segments 一致', () => {
    // 模拟粘贴 "分析一下这张 \uE000<img>\uE001 图片 \uE000<doc>\uE001"
    const segments = splitRichContent(
      '分析一下这张 \uE000img-id\uE001 图片 \uE000doc-id\uE001',
    );
    expect(segments.map((s) => s.type)).toEqual([
      'text',
      'att',
      'text',
      'att',
    ]);

    for (const seg of segments) {
      if (seg.type === 'text') {
        insertNodeAtSelection(root, document.createTextNode(seg.text));
      } else {
        insertNodeAtSelection(root, makeChip(seg.id));
      }
    }

    // 视觉序列：text-img-chip-text-doc-chip，chip 顺序 [img, doc] 与 segments 一致
    const visual = [...root.childNodes].map((n) => {
      if (n.nodeType === Node.TEXT_NODE) return `text:${n.nodeValue}`;
      if (n instanceof HTMLSpanElement && n.dataset.attId) {
        return `chip:${n.dataset.attId}`;
      }
      return `node:${n.nodeType}`;
    });
    expect(visual).toEqual([
      'text:分析一下这张 ',
      'chip:img-id',
      'text: 图片 ',
      'chip:doc-id',
    ]);
    // 不应产生空 textNode
    const emptyTexts = [...root.childNodes].filter(
      (n) => n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? '').length === 0,
    );
    expect(emptyTexts.length).toBe(0);
  });

  it('三 chip 交错：text → chipA → text → chipB → text → chipC 顺序保持', () => {
    for (const id of ['a', 'b', 'c']) {
      insertNodeAtSelection(root, document.createTextNode('T-'));
      insertNodeAtSelection(root, makeChip(id));
    }
    const chips = [...root.childNodes].filter(
      (n) => n instanceof HTMLSpanElement && n.dataset.attId,
    );
    expect(chips.map((c) => (c as HTMLSpanElement).dataset.attId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('root 已有内容时：在末尾按 segments 顺序插入（不破坏已有内容）', () => {
    root.appendChild(document.createTextNode('prefix-'));
    placeCaretAtEnd(root);
    insertNodeAtSelection(root, document.createTextNode('A-'));
    insertNodeAtSelection(root, makeChip('x'));
    insertNodeAtSelection(root, document.createTextNode('B-'));
    const visual = [...root.childNodes].map((n) => {
      if (n.nodeType === Node.TEXT_NODE) return `t:${n.nodeValue}`;
      if (n instanceof HTMLSpanElement && n.dataset.attId) return `c:${n.dataset.attId}`;
      return '?';
    });
    expect(visual).toEqual(['t:prefix-', 't:A-', 'c:x', 't:B-']);
  });

  it('在已有 chip 之后继续插入不应打乱 chip 顺序', () => {
    // 先插一段 text + chip1
    insertNodeAtSelection(root, document.createTextNode('first '));
    insertNodeAtSelection(root, makeChip('1'));
    // 再插一段 text + chip2（模拟原 bug 触发点：在 chip1 之后插 text）
    insertNodeAtSelection(root, document.createTextNode(' second '));
    insertNodeAtSelection(root, makeChip('2'));
    const chips = [...root.childNodes].filter(
      (n) => n instanceof HTMLSpanElement && n.dataset.attId,
    );
    expect(chips.map((c) => (c as HTMLSpanElement).dataset.attId)).toEqual(['1', '2']);
  });
});