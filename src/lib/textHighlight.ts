/**
 * 会话内搜索的文本命中工具。
 *
 * 目标是在**已渲染的消息 DOM** 里给关键词着色，而消息正文是 Markdown 渲染结果，
 * 无法在源码字符串层面简单替换（会破坏代码块/链接）。因此采用
 * CSS Custom Highlight API（Chromium 105+，Electron 31 自带 Chromium 126）：
 * 只登记 `Range` 交浏览器着色，**完全不改动 DOM**，与 React 的渲染结果零冲突。
 *
 * 浏览器不支持该 API 时 `isHighlightSupported()` 返回 false，
 * 调用方降级为「整条消息高亮」（复用 MessageStream 原有的 highlightMessageId）。
 */

/** 全部命中项的高亮名（对应 index.css 的 `::highlight(search-hit)`） */
export const SEARCH_HL_ALL = 'search-hit';
/** 当前选中命中项的高亮名（对应 `::highlight(search-hit-active)`） */
export const SEARCH_HL_ACTIVE = 'search-hit-active';

/** 单次搜索最多登记的命中数：防止超长会话在极端关键词下卡顿 */
const MAX_HITS = 2000;

/** `CSS.highlights` 的最小接口（TS 标准库尚未收录 Highlight 类型） */
interface HighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => boolean;
}

/** 取 Highlight 构造器；不支持则返回 null */
function getHighlightCtor(): (new (...ranges: Range[]) => unknown) | null {
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return typeof ctor === 'function'
    ? (ctor as new (...ranges: Range[]) => unknown)
    : null;
}

/** 取高亮注册表；不支持则返回 null */
function getRegistry(): HighlightRegistryLike | null {
  const reg = (globalThis as { CSS?: { highlights?: unknown } }).CSS?.highlights;
  if (!reg) return null;
  const candidate = reg as Partial<HighlightRegistryLike>;
  if (typeof candidate.set !== 'function' || typeof candidate.delete !== 'function') {
    return null;
  }
  return candidate as HighlightRegistryLike;
}

/** 当前运行环境是否支持 CSS Custom Highlight API */
export function isHighlightSupported(): boolean {
  return getHighlightCtor() !== null && getRegistry() !== null;
}

/**
 * 遍历 `root` 下的文本节点，收集关键词的全部命中位置。
 *
 * 命中按**文档顺序**返回，序号即搜索条上 `n/m` 里的 `n`；
 * 单个文本节点内的重复命中会全部展开（同一段落出现多次也算多个命中）。
 * 跳过 script/style 与纯空白节点。
 */
export function collectSearchRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const haystack = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      if (ranges.length >= MAX_HITS) return ranges;
      // 允许重叠命中（如 aaa 里搜 aa）时步进 1；此处按不重叠步进，避免视觉粘连
      from = at + needle.length;
    }
  }

  return ranges;
}

/**
 * 按名字登记一组高亮 Range。
 *
 * 抽成通用底座，是因为「会话内搜索命中」与「加入对话的引用下划线」是**同一件事**：
 * 都只把 `Range` 交给浏览器着色，**完全不改动 DOM**（与 React 渲染结果零冲突）。
 * 空数组 = 撤掉该名字的高亮，不留一个空 Highlight 常驻注册表。
 *
 * 返回 false 表示环境不支持（调用方据此降级为「不着色」）。
 */
export function setHighlight(name: string, ranges: Range[]): boolean {
  const ctor = getHighlightCtor();
  const registry = getRegistry();
  if (!ctor || !registry) return false;
  if (ranges.length === 0) {
    registry.delete(name);
    return true;
  }
  registry.set(name, new ctor(...ranges));
  return true;
}

/** 撤掉某个名字的高亮；环境不支持时静默无事 */
export function clearHighlight(name: string): void {
  getRegistry()?.delete(name);
}

/**
 * 把命中 Range 交给浏览器着色：全部命中走 `search-hit`，
 * 当前选中项走更醒目的 `search-hit-active`。
 * 返回 false 表示环境不支持（调用方应降级）。
 */
export function paintSearchRanges(ranges: Range[], activeIndex: number): boolean {
  if (!setHighlight(SEARCH_HL_ALL, ranges)) return false;
  const active = ranges[activeIndex];
  setHighlight(SEARCH_HL_ACTIVE, active ? [active] : []);
  return true;
}

/** 清空搜索高亮（收起搜索条 / 切换会话时调用） */
export function clearSearchHighlights(): void {
  clearHighlight(SEARCH_HL_ALL);
  clearHighlight(SEARCH_HL_ACTIVE);
}

/**
 * 把某个命中滚动到滚动容器可视区中部。
 *
 * 用 Range 的 boundingRect 精确算位移，比 `element.scrollIntoView` 更准：
 * 命中点可能位于一个超长段落的底部，按元素滚动会把焦点留在段落之外。
 * 未完成布局（rect 全 0）时退化为元素级滚动。
 */
export function scrollRangeIntoView(
  range: Range,
  scroller: HTMLElement | null,
): void {
  // 布局接口并非处处可用（如 jsdom / 尚未完成布局）：缺失时按「无位移」处理，
  // 直接退化为元素级滚动，避免抛错中断搜索导航。
  const rect =
    typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : ({ top: 0, height: 0, width: 0 } as DOMRect);
  const collapsed = rect.width === 0 && rect.height === 0;

  if (!scroller || collapsed) {
    const target = range.startContainer.parentElement;
    // `scrollIntoView` 并非处处可用（jsdom 就没有）：缺了就放弃定位，
    // 让「命中计数」这类不依赖布局的部分照常工作，不因为滚动失败抛断整条链路。
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    return;
  }

  const box = scroller.getBoundingClientRect();
  const delta = rect.top - box.top - box.height / 2 + rect.height / 2;
  scroller.scrollBy({ top: delta, behavior: 'smooth' });
}
