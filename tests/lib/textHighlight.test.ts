import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  clearSearchHighlights,
  collectSearchRanges,
  isHighlightSupported,
  paintSearchRanges,
  scrollRangeIntoView,
} from '@/lib/textHighlight';

/** 造一块可控 DOM 作为搜索根节点 */
function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('textHighlight: 命中收集（对话内搜索的核心）', () => {
  it('按文档顺序收集全部命中，序号即 n/m 里的 n', () => {
    const root = mount(
      '<p>前文 网关 后文</p><p>网关 又一处 网关</p>',
    );
    const ranges = collectSearchRanges(root, '网关');
    expect(ranges).toHaveLength(3);
    // 第 3 个命中在第二个段落，且落在第二个「网关」上
    expect(ranges[2].startContainer.textContent).toContain('网关 又一处 网关');
    expect(ranges[2].toString()).toBe('网关');
  });

  it('匹配大小写不敏感（英文关键词）', () => {
    const root = mount('<p>Composer 与 composer 都算命中</p>');
    expect(collectSearchRanges(root, 'composer')).toHaveLength(2);
    expect(collectSearchRanges(root, 'COMPOSER')).toHaveLength(2);
  });

  it('跨多个文本节点分别计数（Markdown 拆分成多个 <span> 也能逐个命中）', () => {
    const root = mount('<p><strong>网关</strong>与<span>网关</span></p>');
    expect(collectSearchRanges(root, '网关')).toHaveLength(2);
  });

  it('忽略空白关键词与仅空白文本节点', () => {
    const root = mount('<p>   </p><p>网关</p>');
    expect(collectSearchRanges(root, '   ')).toHaveLength(0);
    expect(collectSearchRanges(root, '')).toHaveLength(0);
    expect(collectSearchRanges(root, '网关')).toHaveLength(1);
  });

  it('跳过 script / style 内容', () => {
    const root = mount(
      '<script>const 网关 = 1</script><style>/* 网关 */</style><p>网关</p>',
    );
    const ranges = collectSearchRanges(root, '网关');
    expect(ranges).toHaveLength(1);
  });

  it('同一文本节点内的重复命中不重叠推进（"aaaa" 里搜 "aa" 得 2 处）', () => {
    const root = mount('<p>aaaa</p>');
    const ranges = collectSearchRanges(root, 'aa');
    expect(ranges).toHaveLength(2);
    expect(ranges[0].startOffset).toBe(0);
    expect(ranges[1].startOffset).toBe(2);
  });

  it('无命中时返回空数组', () => {
    const root = mount('<p>网关</p>');
    expect(collectSearchRanges(root, '不存在的词')).toHaveLength(0);
  });
});

describe('textHighlight: 着色的降级行为', () => {
  it('jsdom 无 CSS Custom Highlight API 时 isHighlightSupported 为 false', () => {
    expect(isHighlightSupported()).toBe(false);
  });

  it('不支持时不抛错，返回 false（调用方据此退化为不打点）', () => {
    const root = mount('<p>网关</p>');
    const ranges = collectSearchRanges(root, '网关');
    expect(() => paintSearchRanges(ranges, 0)).not.toThrow();
    expect(paintSearchRanges(ranges, 0)).toBe(false);
    expect(() => clearSearchHighlights()).not.toThrow();
  });
});

describe('textHighlight: 定位滚动', () => {
  it('把命中滚动到可视区中部（按 rect 相对位移算，比元素级滚动更准）', () => {
    const root = mount('<p>网关</p>');
    const range = collectSearchRanges(root, '网关')[0];

    // 命中点位于容器可视区下方：960 需上移 160px 才能与容器中心 750 对齐
    range.getBoundingClientRect = () =>
      ({ top: 900, height: 20, width: 30 }) as DOMRect;
    const scroller = document.createElement('div');
    scroller.getBoundingClientRect = () =>
      ({ top: 500, height: 500 }) as DOMRect;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy;

    scrollRangeIntoView(range, scroller);
    expect(scrollBy).toHaveBeenCalledWith({ top: 160, behavior: 'smooth' });
  });

  it('未完成布局（rect 全 0）时退化为元素级 scrollIntoView', () => {
    const root = mount('<p>网关</p>');
    const range = collectSearchRanges(root, '网关')[0];
    // jsdom 不实现 Range 的布局接口：显式给出全 0 rect 模拟「尚未完成布局」
    range.getBoundingClientRect = () =>
      ({ top: 0, height: 0, width: 0 }) as DOMRect;
    const el = range.startContainer.parentElement as HTMLElement;
    const spy = vi.fn();
    el.scrollIntoView = spy;

    scrollRangeIntoView(range, null);
    expect(spy).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });
});
