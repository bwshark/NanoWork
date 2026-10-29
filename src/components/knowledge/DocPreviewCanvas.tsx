/**
 * 原格式预览的画布（**pdf.js core，自建文本层 / 自堆连续页 / 自接书签**）——懒加载模块。
 *
 * 与服务端的分工：服务端已经把 pptx/docx/xlsx 转成 PDF（见 `cloud/app/kb/render.py`），
 * 这里只负责把它**当文档读**（连续滚动、可选中、有导航），而不是当幻灯片翻。
 *
 * ## 为什么不用官方 `web/pdf_viewer`（`PDFViewer` 那套）
 *
 * 它把文本层做好了，代价是**把 DOM 与 CSS 的所有权交出去**：注入 `.page` / `.textLayer`
 * 这类全局类名、自带 100KB 样式表、还硬性要求滚动容器 `position: absolute`
 * （它用 `getComputedStyle` 检查，不满足直接抛异常）。在已经用 MUI 主题 + 深色背景的
 * 应用里，这些东西每改一次主题都要靠 `!important` 再压一遍。
 *
 * 所以这里只用 `pdfjs-dist` 的 core API 自己拼：页面顺序、文本层、大纲跳转都在本文件里，
 * 样式只有 `pdfTextLayer.css` 那几十行。代价是**文本层的几何要自己算**，好处是这套几何
 * 被几条公式钉死了，可解释、可测、随时能改。
 *
 * ## 文本层是怎么摆出来的（三条公式）
 *
 * PDF 里每个文本片段都带一个变换矩阵，`Util.transform(viewport.transform, item.transform)`
 * 把它映射到**画布坐标**：
 * - `tx[4]` / `tx[5]` = 该片段左下角的 x / y；
 * - `Math.hypot(tx[2], tx[3])` = 字高（拿它当 `font-size`）；
 * - `item.width × scale` = 这个片段在画布上**应该**占多宽。
 *
 * 第三条是关键：浏览器没有 PDF 内嵌字体，只能先用 `sans-serif` 摆上去，**量出自然宽度后
 * 按 `scaleX(目标宽度 / 自然宽度)` 拉回目标宽度**。少这一步，拉丁文字会明显偏宽、越靠右
 * 偏得越多，拿鼠标一拖选就露馅（而且不报错）。
 *
 * ## 其它四条约定（每条对应一次真实的坑）
 *
 * 1. **`bytes.slice(0)`**：pdf.js 会把 buffer **transfer** 给 worker，转移后原 buffer 变 0
 *    字节 —— 用 props 里那个 buffer 的症状是"翻到第二页就白屏"。
 * 2. **可见页才画**：`IntersectionObserver` 带 600px 余量，离开视野就把 canvas 收掉
 *    （100 页 × A4 的位图是几百 MB，全留着浏览器会开始卡）。
 * 3. **`devicePixelRatio`**：位图按 2 倍分辨率画、CSS 尺寸保持逻辑像素，否则高分屏上字是糊的
 *    —— 这也是"和 Word 比差一口气"的常见原因。
 * 4. **换缩放要记锚点**：换档后页高变了，不还原滚动位置就会"跳到别的页"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, CircularProgress, IconButton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import '@/components/knowledge/pdfTextLayer.css';
import {
  currentOutlineIndex,
  reconcileActive,
  resolveOutline,
  type OutlineResolver,
  type OutlineSource,
  type PdfOutlineNode,
} from '@/lib/kb/pdfOutline';

/**
 * worker 地址走 Vite 的 `?url`：dev 与 build 都会给到一个能 fetch 的地址。
 * ⚠️ 不要改成 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`
 * —— 在 Electron 里那会落到 `file://`，生产环境直接 404，症状是「进度条卡在 0%」。
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 缩略图宽度（px）。够看清版式，又不至于把侧栏撑爆。 */
const THUMB_WIDTH = 104;

/** 缩放档位（倍数）。「适应宽度」是另一条路径，不在这串里。 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** 左栏宽度：大纲与缩略图共用一栏，切换时不跳版 */
const RAIL_WIDTH = 184;

/** 页面之间留白 / 左右留白（px） */
const PAGE_GAP = 12;
const SIDE_PADDING = 16;

/** 位图分辨率上限：2 倍够 retina，再往上只会吃内存 */
const MAX_PIXEL_RATIO = 2;

/** 离视口多远开始画（px）。画得早一点，翻页时不会看到空白页在等 */
const RENDER_MARGIN = '600px 0px';

interface PageSize {
  width: number;
  height: number;
}

interface PageBox extends PageSize {
  /** 1 起 */
  index: number;
  /** 距滚动容器顶部的偏移（px），跳页用它 */
  top: number;
}

export interface DocPreviewCanvasProps {
  /** PDF 字节（已带票取回） */
  bytes: ArrayBuffer;
  /** 文档标题：缩略图的 alt 与画布的控件名 */
  title: string;
}

export function DocPreviewCanvas({ bytes, title }: DocPreviewCanvasProps) {
  const [pdfDoc, setPdfDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [outline, setOutline] = useState<PdfOutlineNode[]>([]);
  /** 当前高亮的大纲下标（-1 = 还没进入任何章节）。按"绝对纵向位置"算，不按页码算 */
  const [activeOutline, setActiveOutline] = useState(-1);
  const [rail, setRail] = useState<'outline' | 'thumbs'>('outline');
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [pageInput, setPageInput] = useState('1');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageLayerRef = useRef<HTMLDivElement | null>(null);
  const shellRefs = useRef(new Map<number, HTMLDivElement>());
  /** 每页按哪个倍率画好了（`scale` 一变就清空，用它判断要不要重画） */
  const renderedRef = useRef(new Map<number, number>());
  const tasksRef = useRef(new Map<number, { cancel: () => void }>());
  /** 已经画好的缩略图（用 ref 累加：中断后接着画，不从头再来） */
  const thumbsRef = useRef<string[]>([]);
  const outlineRailRef = useRef<HTMLDivElement | null>(null);
  /** 换缩放前的锚点（第几页 + 页内比例），换完据此还原滚动位置 */
  const anchorRef = useRef<{ index: number; ratio: number } | null>(null);
  /** 大纲每条的绝对纵向位置（依赖 boxes/scale），滚动回调与点击都读它 */
  const marksRef = useRef<Array<number | null>>([]);
  const activeRef = useRef(-1);
  const pageSizesRef = useRef<PageSize[]>([]);

  // —— 载入 PDF ——
  useEffect(() => {
    let cancelled = false;
    setError('');
    setPdfDoc(null);
    setPageSizes([]);
    setPage(1);
    setOutline([]);
    setThumbs([]);
    setRail('outline');
    thumbsRef.current = [];
    renderedRef.current.clear();
    tasksRef.current.clear();
    // ⚠️ slice：pdf.js 会把这个 buffer 转移给 worker，转移后原 buffer 变空
    const task = pdfjs.getDocument({ data: bytes.slice(0) });
    void task.promise.then(
      (loaded) => {
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setPdfDoc(loaded);
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'PDF 解析失败');
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [bytes]);

  // —— 每页的标准尺寸（scale=1）。先知道全部页尺寸，滚动条长度才是真的 ——
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    void (async () => {
      const sizes: PageSize[] = [];
      for (let index = 1; index <= pdfDoc.numPages; index += 1) {
        const pageProxy = await pdfDoc.getPage(index);
        const viewport = pageProxy.getViewport({ scale: 1 });
        sizes.push({ width: viewport.width, height: viewport.height });
      }
      if (!cancelled) setPageSizes(sizes);
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc]);

  const boxes = useMemo<PageBox[]>(() => {
    const list: PageBox[] = [];
    let top = 0;
    pageSizes.forEach((size, position) => {
      const width = size.width * scale;
      const height = size.height * scale;
      list.push({ index: position + 1, width, height, top });
      top += height + PAGE_GAP;
    });
    return list;
  }, [pageSizes, scale]);

  const boxesRef = useRef<PageBox[]>([]);
  boxesRef.current = boxes;
  pageSizesRef.current = pageSizes;

  /**
   * 大纲每条的**绝对纵向位置**（当前缩放下，距滚动容器顶部的 px）。
   *
   * 只按页码判"当前章节"是不够的：同一页上常有多个标题，那样永远只会亮到该页最后一条。
   * 所以用 `页顶 + (页高 − top) × scale` 精确到行（`top` 的原点在页面左下）。
   */
  const marks = useMemo<Array<number | null>>(
    () =>
      outline.map((node) => {
        const box = node.page >= 1 ? boxes[node.page - 1] : undefined;
        const size = node.page >= 1 ? pageSizes[node.page - 1] : undefined;
        if (!box || !size) return null;
        const within =
          node.top === null
            ? 0
            : Math.min(Math.max(0, (size.height - node.top) * scale), box.height);
        return box.top + within;
      }),
    [outline, boxes, pageSizes, scale],
  );
  marksRef.current = marks;

  /**
   * 当前该高亮第几条。
   *
   * `currentOutlineIndex` 在"还没跨过任何一条"时给 -1（封面、目录页、刚打开）。
   * 侧栏里留一个"全都不亮"的空态比给一个近似答案更糟 —— 用户会以为**选中态坏了**
   * （这次就是被这么报上来的）。所以兜底亮第一条：打开就有个"你正在读第一章"的锚点，
   * 而且它和"点第一条"的结果一致，不会出现两套答案。
   */
  const pickActive = useCallback((offset: number) => {
    const next = currentOutlineIndex(marksRef.current, offset);
    return next >= 0 ? next : marksRef.current.findIndex((at) => at !== null);
  }, []);

  /** 按容器宽度算「适应宽度」的倍率 */
  const fitScale = useCallback(() => {
    const available = Math.max(240, (scrollRef.current?.clientWidth ?? 720) - SIDE_PADDING * 2);
    const widest = pageSizes.reduce((max, size) => Math.max(max, size.width), 0);
    return widest > 0 ? available / widest : 1;
  }, [pageSizes]);

  useEffect(() => {
    if (!fitMode || pageSizes.length === 0) return;
    setScale(fitScale());
  }, [fitMode, pageSizes, fitScale]);

  // 容器宽度变了（开/关侧栏、窗口缩放）：只在「适应宽度」模式下跟着变，
  // 用户手动缩放过就别抢他的档位
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let previous = root.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = root.clientWidth;
      if (Math.abs(next - previous) < 8) return;
      previous = next;
      if (fitMode) setScale(fitScale());
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [fitMode, fitScale]);

  // —— 换档后还原滚动锚点 ——
  useEffect(() => {
    const root = scrollRef.current;
    const anchor = anchorRef.current;
    if (!root || !anchor || boxes.length === 0) return;
    const box = boxes[anchor.index - 1];
    if (box) root.scrollTop = box.top + box.height * anchor.ratio;
    anchorRef.current = null;
  }, [boxes]);

  /** 把 `getTextContent()` 的片段摆成可选中的一层 */
  const buildTextLayer = useCallback(
    async (pageProxy: pdfjs.PDFPageProxy, viewport: pdfjs.PageViewport, layer: HTMLElement) => {
      const content = await pageProxy.getTextContent();
      const fragment = window.document.createDocumentFragment();
      const placed: { span: HTMLSpanElement; targetWidth: number }[] = [];

      for (const item of content.items) {
        if (!('str' in item)) continue;
        // ⚠️ 换行标记常常挂在**空字符串**的片段上（pdf.js 用它标行尾）——
        // 先 `str === ''` 就 `continue` 的话，复制出来会是一整段没有换行的文字
        if (item.str !== '') {
          const tx = pdfjs.Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.hypot(tx[2], tx[3]);
          if (fontHeight > 0) {
            const span = window.document.createElement('span');
            span.textContent = item.str;
            span.style.left = `${tx[4]}px`;
            span.style.top = `${tx[5] - fontHeight}px`;
            span.style.fontSize = `${fontHeight}px`;
            span.style.fontFamily = 'sans-serif';
            fragment.appendChild(span);
            placed.push({ span, targetWidth: item.width * scale });
          }
        }
        // 行尾标记：复制出来才是一行一行，而不是一整段
        if (item.hasEOL) fragment.appendChild(window.document.createElement('br'));
      }

      // 页尾哨兵：让"从这一页拖到下一页"能连续选，而不是整段跳掉
      const tail = window.document.createElement('div');
      tail.className = 'endOfContent';
      fragment.appendChild(tail);
      layer.replaceChildren(fragment);

      // 第二遍才量宽度：不先进 DOM，`getBoundingClientRect` 恒为 0
      for (const { span, targetWidth } of placed) {
        const natural = span.getBoundingClientRect().width;
        if (!(natural > 0) || !(targetWidth > 0)) continue;
        const factor = targetWidth / natural;
        // 极端缩放（字体缺失导致宽度差一个量级）宁可不压，也不要压成一团
        if (Number.isFinite(factor) && factor > 0.2 && factor < 5) {
          span.style.transform = `scaleX(${factor})`;
        }
      }
    },
    [scale],
  );

  /** 单页渲染：位图 + 文本层 */
  const renderPage = useCallback(
    async (index: number) => {
      const doc = pdfDoc;
      const shell = shellRefs.current.get(index);
      if (!doc || !shell) return;
      if (renderedRef.current.get(index) === scale) return;
      tasksRef.current.get(index)?.cancel();

      const pageProxy = await doc.getPage(index);
      const viewport = pageProxy.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

      const canvas = shell.querySelector('canvas');
      const layer = shell.querySelector<HTMLElement>('.kbPdfTextLayer');
      if (!canvas || !layer) return;

      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;

      const task = pageProxy.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      tasksRef.current.set(index, task);
      try {
        await task.promise;
      } catch (reason) {
        // 取消渲染是正常路径（换倍率 / 滚出视野），不当错误报给用户
        if ((reason as { name?: string } | null)?.name === 'RenderingCancelledException') return;
        throw reason;
      }
      renderedRef.current.set(index, scale);
      await buildTextLayer(pageProxy, viewport, layer);
    },
    [pdfDoc, scale, buildTextLayer],
  );

  /** 收掉离屏页的位图（100 页全留着是几百 MB） */
  const releasePage = useCallback((index: number) => {
    if (renderedRef.current.get(index) === undefined) return;
    const shell = shellRefs.current.get(index);
    const canvas = shell?.querySelector('canvas');
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
    shell?.querySelector('.kbPdfTextLayer')?.replaceChildren();
    renderedRef.current.delete(index);
  }, []);

  // —— 可见页才画（600px 余量），滚远了就收 ——
  useEffect(() => {
    const root = scrollRef.current;
    const layer = pageLayerRef.current;
    if (!root || !layer || boxes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.page);
          if (!Number.isFinite(index)) continue;
          if (entry.isIntersecting) {
            void renderPage(index).catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : '页面渲染失败');
            });
          } else {
            releasePage(index);
          }
        }
      },
      { root, rootMargin: RENDER_MARGIN },
    );
    layer.querySelectorAll<HTMLElement>('[data-page]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [boxes, renderPage, releasePage]);

  // —— 滚动时算当前页 + 当前章节（Word 的页码就是"现在看到第几页"）——
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || boxes.length === 0) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = root.scrollTop + 1;
        const found =
          boxes.find((box) => y >= box.top && y < box.top + box.height) ?? boxes[boxes.length - 1];
        if (found) setPage(found.index);
        // 高亮按**绝对位置**算（同一页上有多个标题时，只按页判会永远亮到最后一条）
        const nextActive = reconcileActive(
          activeRef.current,
          pickActive(root.scrollTop),
          marksRef.current,
        );
        if (nextActive !== activeRef.current) {
          activeRef.current = nextActive;
          setActiveOutline(nextActive);
        }
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [boxes, pickActive]);

  // —— 大纲：从书签解析（页码由 destination 决定，不猜）——
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = (await pdfDoc.getOutline()) as OutlineSource[] | null;
        const nodes = await resolveOutline(pdfDoc as unknown as OutlineResolver, raw);
        if (cancelled) return;
        setOutline(nodes);
        // 有书签就默认看大纲（Word 的默认阅读方式），没有就退回缩略图
        setRail(nodes.length > 0 ? 'outline' : 'thumbs');
      } catch {
        if (!cancelled) setOutline([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc]);

  // —— 缩略图：只在真的切到「缩略图」时才画，中断后接着画 ——
  useEffect(() => {
    if (!pdfDoc || rail !== 'thumbs') return;
    if (thumbsRef.current.length >= pdfDoc.numPages) return;
    let cancelled = false;

    void (async () => {
      for (let index = thumbsRef.current.length + 1; index <= pdfDoc.numPages; index += 1) {
        if (cancelled) return;
        const pageProxy = await pdfDoc.getPage(index);
        const natural = pageProxy.getViewport({ scale: 1 });
        const viewport = pageProxy.getViewport({ scale: THUMB_WIDTH / natural.width });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) return;
        await pageProxy.render({ canvasContext: context, viewport }).promise;
        thumbsRef.current = [...thumbsRef.current, canvas.toDataURL('image/png')];
        if (thumbsRef.current.length % 4 === 0 && !cancelled) setThumbs([...thumbsRef.current]);
      }
      if (!cancelled) setThumbs([...thumbsRef.current]);
    })().catch(() => {
      // 缩略图失败不影响阅读：主画布会给真正的错误
    });

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, rail]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  // 大纲晚到 / 换缩放 / 换文档时没有滚动事件，主动同步一次高亮
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const next = pickActive(root.scrollTop);
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActiveOutline(next);
    }
  }, [marks, pickActive]);

  // 当前章节跟着滚动走：40 页的稿子翻到第 30 页时，侧栏别还停在第一章
  useEffect(() => {
    if (rail !== 'outline' || activeOutline < 0) return;
    const node = outlineRailRef.current?.querySelector<HTMLElement>(
      `[data-outline="${activeOutline}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeOutline, rail]);

  const gotoPage = useCallback((target: number) => {
    const root = scrollRef.current;
    const box = boxesRef.current[Math.round(target) - 1];
    if (!root || !box) return;
    root.scrollTop = box.top;
  }, []);

  const step = useCallback(
    (delta: number) => {
      gotoPage(page + delta);
    },
    [gotoPage, page],
  );

  /** 手动缩放：先记锚点，再换档（换完由上面的 effect 还原位置） */
  const applyScale = useCallback((next: number) => {
    const root = scrollRef.current;
    const current = boxesRef.current;
    if (root && current.length > 0) {
      const y = root.scrollTop;
      const box =
        current.find((item) => y >= item.top && y < item.top + item.height) ?? current[0];
      anchorRef.current = { index: box.index, ratio: (y - box.top) / Math.max(1, box.height) };
    }
    renderedRef.current.clear();
    tasksRef.current.forEach((task) => {
      try {
        task.cancel();
      } catch {
        // 已完成的任务取消会抛，忽略
      }
    });
    tasksRef.current.clear();
    setFitMode(false);
    setScale(next);
  }, []);

  const zoomBy = useCallback(
    (direction: 1 | -1) => {
      const next =
        direction > 0
          ? (ZOOM_STEPS.find((value) => value > scale + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
          : ([...ZOOM_STEPS].reverse().find((value) => value < scale - 0.001) ?? ZOOM_STEPS[0]);
      applyScale(next);
    },
    [applyScale, scale],
  );

  /**
   * 点大纲：跳到 `page` + `top` 换算出来的**绝对位置**，并立刻点亮这一条。
   *
   * 位置在大纲解析时就解好了（`resolveOutline` → `readDestination`），这里只做换算，
   * 不再重新解 destination —— 否则"跳转用的位置"与"高亮用的位置"会变成两套算法，
   * 迟早对不上（点了却亮在别处，看起来就是没有选中态）。
   */
  const jumpToOutline = useCallback(
    (node: PdfOutlineNode, index: number) => {
      const root = scrollRef.current;
      const box = boxesRef.current[node.page - 1];
      if (!root || !box) return;
      const size = pageSizesRef.current[node.page - 1];
      const within =
        node.top === null || !size
          ? 0
          : Math.min(Math.max(0, (size.height - node.top) * scale), box.height);
      // 滚动是异步的：先点亮，别等 scroll 事件回来才亮（会晚一拍，看着像"没选中"）
      activeRef.current = index;
      setActiveOutline(index);
      root.scrollTop = Math.max(0, box.top + within);
    },
    [scale],
  );

  if (error !== '') {
    return (
      <Box sx={{ py: 4 }}>
        <Typography sx={{ fontSize: 13, color: 'error.main' }} data-testid="kb-preview-error">
          预览打不开：{error}
        </Typography>
        <Typography sx={{ mt: 1, fontSize: 12, color: 'text.secondary' }}>
          换「正文」标签照样能读内容与检索；需要原格式预览的话，重新上传一次试试。
        </Typography>
      </Box>
    );
  }

  return (
    <Stack direction="row" sx={{ height: '100%', minHeight: 0 }}>
      {/* 左栏：大纲 / 缩略图 */}
      <Box
        sx={{
          width: RAIL_WIDTH,
          flexShrink: 0,
          borderRight: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <Tabs
          value={rail}
          onChange={(_event, next: 'outline' | 'thumbs') => setRail(next)}
          variant="fullWidth"
          sx={{ minHeight: 32, borderBottom: '1px solid', borderColor: 'divider' }}
        >
          <Tab
            value="outline"
            label="大纲"
            sx={{ minHeight: 32, minWidth: 0, py: 0, fontSize: 12 }}
            data-testid="kb-preview-tab-outline"
          />
          <Tab
            value="thumbs"
            label="缩略图"
            sx={{ minHeight: 32, minWidth: 0, py: 0, fontSize: 12 }}
            data-testid="kb-preview-tab-thumbs"
          />
        </Tabs>

        <Box ref={outlineRailRef} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 0.75, px: 0.5 }}>
          {rail === 'outline' ? (
            outline.length === 0 ? (
              <Typography
                sx={{ px: 1, py: 1.5, fontSize: 11.5, color: 'text.disabled', lineHeight: 1.6 }}
                data-testid="kb-preview-outline-empty"
              >
                这篇文档没有大纲。
                <br />
                Word 的大纲按「标题 1/2/3」样式生成 —— 正文里没有使用标题样式（或转换时没导出书签），
                就没有可跳转的章节。
              </Typography>
            ) : (
              outline.map((node, index) => {
                const active = index === activeOutline;
                // 连 destination 都没有的条目点了也没地方去：画成不可点，别让人反复试
                const dead = node.page <= 0 && node.top === null;
                return (
                  <Box
                    key={`${node.title}-${index}`}
                    data-outline={index}
                    data-active={active ? 'true' : 'false'}
                    onClick={() => {
                      if (!dead) jumpToOutline(node, index);
                    }}
                    title={dead ? '这条书签没有可跳转的位置' : node.title}
                    sx={{
                      // 选中态用「左侧色条 + 主色字 + 实色底」三重信号：深色主题下只靠
                      // `action.selected`（8% 白）几乎看不出来，用户会以为没选中
                      borderLeft: '2px solid',
                      borderColor: active ? 'primary.main' : 'transparent',
                      bgcolor: active ? 'action.selected' : 'transparent',
                      color: active ? 'primary.main' : 'text.secondary',
                      fontWeight: active ? 600 : node.depth === 0 ? 500 : 400,
                      pl: 0.5 + Math.min(node.depth, 5) * 1.25,
                      pr: 0.75,
                      py: 0.4,
                      borderRadius: 1,
                      cursor: dead ? 'default' : 'pointer',
                      opacity: dead ? 0.5 : 1,
                      fontSize: 12,
                      lineHeight: 1.5,
                      '&:hover': { bgcolor: dead ? 'transparent' : 'action.hover' },
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {node.title}
                  </Box>
                );
              })
            )
          ) : (
            <Box data-testid="kb-preview-thumbs">
              {thumbs.length === 0 && (
                <Stack alignItems="center" sx={{ py: 3 }}>
                  <CircularProgress size={14} />
                </Stack>
              )}
              {thumbs.map((src, index) => {
                const number = index + 1;
                const active = number === page;
                return (
                  <Box
                    key={number}
                    data-thumb={number}
                    onClick={() => gotoPage(number)}
                    sx={{
                      mb: 1,
                      p: 0.5,
                      borderRadius: 1,
                      cursor: 'pointer',
                      border: '1px solid',
                      borderColor: active ? 'primary.main' : 'transparent',
                      bgcolor: active ? 'action.selected' : 'transparent',
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                  >
                    <Box
                      component="img"
                      src={src}
                      alt={`${title} 第 ${number} 页`}
                      sx={{ width: '100%', display: 'block', borderRadius: '3px' }}
                    />
                    <Typography sx={{ mt: 0.25, fontSize: 10, color: 'text.secondary', textAlign: 'center' }}>
                      {number}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      </Box>

      {/* 右侧：连续滚动区 + 底部状态栏（Word 的心智是"一张长纸"，不是"一页幻灯片"） */}
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        {pdfDoc === null ? (
          <Stack alignItems="center" spacing={1} sx={{ flex: 1, justifyContent: 'center' }}>
            <CircularProgress size={18} />
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>正在打开预览…</Typography>
          </Stack>
        ) : (
          <Box
            ref={scrollRef}
            data-testid="kb-preview-scroll"
            sx={{ flex: 1, minHeight: 0, overflow: 'auto', bgcolor: 'action.hover', py: 1.5 }}
          >
            <Box ref={pageLayerRef} sx={{ px: `${SIDE_PADDING}px` }}>
              {boxes.map((box) => (
                <Box
                  key={box.index}
                  className="kbPdfPage"
                  data-page={box.index}
                  ref={(node: HTMLDivElement | null) => {
                    if (node) shellRefs.current.set(box.index, node);
                    else shellRefs.current.delete(box.index);
                  }}
                  sx={{ width: `${box.width}px`, height: `${box.height}px` }}
                >
                  <canvas className="kbPdfCanvas" aria-label={`${title} 第 ${box.index} 页`} />
                  <Box className="kbPdfTextLayer" />
                </Box>
              ))}
            </Box>
          </Box>
        )}

        <Stack
          direction="row"
          alignItems="center"
          spacing={0.5}
          sx={{ height: 40, px: 1, borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}
        >
          <Tooltip title="上一页">
            <span>
              <IconButton size="small" aria-label="上一页" disabled={page <= 1} onClick={() => step(-1)}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Box
            component="input"
            value={pageInput}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setPageInput(event.target.value.replace(/[^\d]/g, ''))
            }
            onBlur={() => {
              const target = Number(pageInput);
              if (Number.isFinite(target) && target >= 1) gotoPage(target);
              else setPageInput(String(page));
            }}
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            aria-label="跳转到页码"
            sx={{
              width: 38,
              height: 24,
              textAlign: 'center',
              fontSize: 12,
              color: 'text.secondary',
              bgcolor: 'transparent',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              outline: 'none',
              fontFamily: 'inherit',
              '&:focus': { borderColor: 'primary.main' },
            }}
          />
          <Typography sx={{ fontSize: 12, color: 'text.secondary', minWidth: 44 }}>
            / {pageSizes.length === 0 ? '–' : pageSizes.length}
          </Typography>
          <Tooltip title="下一页">
            <span>
              <IconButton
                size="small"
                aria-label="下一页"
                disabled={pageSizes.length === 0 || page >= pageSizes.length}
                onClick={() => step(1)}
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="适应宽度（连续阅读最省力）">
            <span>
              <IconButton size="small" aria-label="适应宽度" onClick={() => setFitMode(true)}>
                <FitScreenIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="缩小">
            <span>
              <IconButton size="small" aria-label="缩小" onClick={() => zoomBy(-1)}>
                <ZoomOutIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', minWidth: 40, textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </Typography>
          <Tooltip title="放大">
            <span>
              <IconButton size="small" aria-label="放大" onClick={() => zoomBy(1)}>
                <ZoomInIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>
    </Stack>
  );
}
