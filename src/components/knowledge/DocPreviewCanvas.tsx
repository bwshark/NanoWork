/**
 * 原格式预览的画布（pdf.js **官方 viewer 组件**）——懒加载模块。
 *
 * 与服务端的分工：服务端已经把 pptx/docx/xlsx 转成 PDF（见 `cloud/app/kb/render.py`），
 * 这里只负责把它**当文档读**，而不是当幻灯片翻：连续滚动、文本层可选中、书签大纲。
 *
 * ## 为什么用 `web/pdf_viewer` 而不是自己拼 canvas
 *
 * 自己画一页 canvas 很容易，难的是**文本层的几何**：每个字都要按 `textContent` 的
 * 变换矩阵定位、按缩放重算字宽，错一点点就变成"能拖选但选区和文字错位"。这套计算
 * 是 pdf.js 十年的活，`PDFViewer` 已经做对了，并且顺手给了三件事：可见页懒渲染
 * （100 页不卡）、缩放后重排、`Ctrl+F` 式的页内查找。
 *
 * ## 四条容易踩空的约定
 *
 * 1. **必须引 `pdf_viewer.css`**：文本层的 `span` 全靠它里面的绝对定位与
 *    `--scale-factor` 变量；漏了它，文字会在页面上叠成一堆（而且不报错）。
 * 2. **必须 `bytes.slice(0)`**：pdf.js 会把 buffer **转移**给 worker，转移后原 buffer
 *    变 0 字节 —— 用 props 里那个 buffer 的症状是"翻到第二页就白屏"。
 * 3. **`removePageBorders`**：官方样式给 `.page` 加了 9px 透明边框（原本用来画阴影），
 *    在这里会让页间距忽大忽小；打开它拿到干净的 `0 auto 10px`。
 * 4. **`viewer.cleanup()` 之后还要清 DOM**：cleanup 只解绑与销毁页面视图，
 *    容器里留下的空壳会在下次挂载时和新页面叠在一起。
 * 5. **滚动容器必须 `position: absolute`**：`PDFViewer` 会检查
 *    `getComputedStyle(container).position === 'absolute'`，不是就直接抛
 *    「The `container` must be absolutely positioned」——页面一片空白且只在控制台里有这句话。
 *    所以外面套一层 `position: relative`，滚动层 `inset: 0`。
 *
 * ## 大纲从哪来
 *
 * PDF 的**书签**（服务端转换时按标题样式导出，见 `office2pdf` 的 `ExportBookmarks`/
 * `CreateBookmarks`）。书签自带精确页码，所以"点第三章跳到第三页"是可靠的；
 * 没有书签的文档（老 PDF、没套标题样式的稿子）会明确说"这篇没有大纲"，
 * 而不是给一个空面板让人以为加载失败。
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
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
// 文本层与页面布局全靠这份样式（见文件头第 1 条）。它只在这个懒加载块里生效。
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  currentOutlineIndex,
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

/** 缩放档位（倍数）。`page-width` 是另一条独立路径，不在这串里。 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** 左栏宽度：大纲与缩略图共用一栏，切换时不跳版 */
const RAIL_WIDTH = 184;

export interface DocPreviewCanvasProps {
  /** PDF 字节（已带票取回） */
  bytes: ArrayBuffer;
  /** 文档标题：缩略图的 alt 与画布的无障碍名 */
  title: string;
}

export function DocPreviewCanvas({ bytes, title }: DocPreviewCanvasProps) {
  const [document, setPdfDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState('');
  const [outline, setOutline] = useState<PdfOutlineNode[]>([]);
  const [rail, setRail] = useState<'outline' | 'thumbs'>('outline');
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [pageInput, setPageInput] = useState('1');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const linkServiceRef = useRef<PDFLinkService | null>(null);
  /** 已经画好的缩略图（用 ref 而不是 state：中断后要**接着画**，不能从头再来） */
  const thumbsRef = useRef<string[]>([]);
  const outlineRailRef = useRef<HTMLDivElement | null>(null);

  // —— 载入 PDF ——
  useEffect(() => {
    let cancelled = false;
    setError('');
    setPdfDocument(null);
    setPage(1);
    setPageCount(0);
    setOutline([]);
    setThumbs([]);
    setRail('outline');
    thumbsRef.current = [];
    // ⚠️ slice：pdf.js 会把这个 buffer 转移给 worker，转移后原 buffer 变空
    const task = pdfjs.getDocument({ data: bytes.slice(0) });
    void task.promise.then(
      (loaded) => {
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setPdfDocument(loaded);
        setPageCount(loaded.numPages);
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

  // —— 建 viewer（只在拿到文档之后；jsdom 里到这里之前就报错了，所以单测不受影响）——
  useEffect(() => {
    const container = scrollRef.current;
    const pages = pagesRef.current;
    if (!document || !container || !pages) return;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
      container,
      viewer: pages,
      eventBus,
      linkService,
      findController,
      // 1 = 生成文本层（可选中 + 可查找）；0 = 不要注释层（知识库文档没有表单要填）
      textLayerMode: 1,
      annotationMode: 0,
      removePageBorders: true,
    });
    linkService.setViewer(viewer);
    viewer.scrollMode = ScrollMode.VERTICAL;
    linkService.setDocument(document, null);
    viewer.setDocument(document);
    viewerRef.current = viewer;
    linkServiceRef.current = linkService;

    // 首次布局完成后再定缩放：早于 pagesinit 设 `page-width` 会被后续布局覆盖成 100%
    const onPagesInit = () => {
      viewer.currentScaleValue = 'page-width';
    };
    const onPageChanging = (payload: { pageNumber?: number }) => {
      if (payload?.pageNumber) setPage(payload.pageNumber);
    };
    const onScaleChanging = (payload: { scale?: number }) => {
      if (payload?.scale) setScale(payload.scale);
    };
    eventBus.on('pagesinit', onPagesInit);
    eventBus.on('pagechanging', onPageChanging);
    eventBus.on('scalechanging', onScaleChanging);

    return () => {
      eventBus.off('pagesinit', onPagesInit);
      eventBus.off('pagechanging', onPageChanging);
      eventBus.off('scalechanging', onScaleChanging);
      try {
        viewer.cleanup();
      } catch {
        // 清理失败不该盖住真正的错误（例如文档已被销毁）
      }
      pages.replaceChildren();
      linkService.setDocument(null);
      viewerRef.current = null;
      linkServiceRef.current = null;
    };
  }, [document]);

  // —— 大纲：从书签解析（页码由 destination 决定，不猜）——
  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = (await document.getOutline()) as OutlineSource[] | null;
        const nodes = await resolveOutline(document as unknown as OutlineResolver, raw);
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
  }, [document]);

  // —— 缩略图：只在真的切到「缩略图」时才画，且边画边出现 ——
  // 以前是打开文档就全量渲染（40 页要等好几秒），而大纲模式下根本没人看缩略图。
  // 中断（切回大纲 / 关抽屉）后从**上次画到的那页**接着画，不从头再来。
  useEffect(() => {
    if (!document || rail !== 'thumbs') return;
    if (thumbsRef.current.length >= document.numPages) return;
    let cancelled = false;

    void (async () => {
      for (let index = thumbsRef.current.length + 1; index <= document.numPages; index += 1) {
        if (cancelled) return;
        const pdfPage = await document.getPage(index);
        const natural = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: THUMB_WIDTH / natural.width });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) return;
        await pdfPage.render({ canvasContext: context, viewport }).promise;
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
  }, [document, rail]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const activeOutline = useMemo(() => currentOutlineIndex(outline, page), [outline, page]);

  // 当前章节跟着滚动走：40 页的稿子翻到第 30 页时，侧栏别还停在第一章
  useEffect(() => {
    if (rail !== 'outline') return;
    const node = outlineRailRef.current?.querySelector<HTMLElement>(`[data-outline="${activeOutline}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeOutline, rail]);

  const gotoPage = useCallback(
    (target: number) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const next = Math.min(Math.max(1, Math.round(target)), Math.max(1, pageCount));
      viewer.currentPageNumber = next;
    },
    [pageCount],
  );

  const step = useCallback(
    (delta: number) => {
      gotoPage((viewerRef.current?.currentPageNumber ?? page) + delta);
    },
    [gotoPage, page],
  );

  const zoomBy = useCallback((direction: 1 | -1) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const current = viewer.currentScale || 1;
    // 找"当前倍数之后的下一档"：缩放值可能被 page-width 改成任意小数，不能只按 index 走
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((step_) => step_ > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find((step_) => step_ < current - 0.001) ?? ZOOM_STEPS[0]);
    viewer.currentScaleValue = String(next);
  }, []);

  const fitWidth = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer) viewer.currentScaleValue = 'page-width';
  }, []);

  const jumpToOutline = useCallback(
    (node: PdfOutlineNode) => {
      if (node.dest) {
        // 走 linkService 而不是 gotoPage：destination 可能带缩放与定位（/XYZ top），
        // 这样跳过去能精确到"标题在页顶"，和 Word 的目录点击一致
        void linkServiceRef.current?.goToDestination(node.dest).catch(() => {
          if (node.page > 0) gotoPage(node.page);
        });
        return;
      }
      if (node.page > 0) gotoPage(node.page);
    },
    [gotoPage],
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
                return (
                  <Box
                    key={`${node.title}-${index}`}
                    data-outline={index}
                    onClick={() => jumpToOutline(node)}
                    title={node.title}
                    sx={{
                      pl: 0.75 + Math.min(node.depth, 5) * 1.25,
                      pr: 0.75,
                      py: 0.4,
                      borderRadius: 1,
                      cursor: 'pointer',
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: active ? 'primary.main' : 'text.secondary',
                      bgcolor: active ? 'action.selected' : 'transparent',
                      fontWeight: node.depth === 0 ? 500 : 400,
                      '&:hover': { bgcolor: 'action.hover' },
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
        {/* 外层给 relative：pdf.js 硬性要求滚动容器是 absolute（见文件头第 5 条） */}
        <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <Box
            ref={scrollRef}
            data-testid="kb-preview-scroll"
            sx={{
              position: 'absolute',
              inset: 0,
              overflow: 'auto',
              bgcolor: 'action.hover',
              // 官方样式的默认页间距是为"整页翻页"设计的，连续滚动要更紧凑一点
              '& .pdfViewer': { py: 1.5 },
              '& .pdfViewer .page': {
                mb: 1.5,
                boxShadow: '0 1px 6px rgba(0,0,0,0.28)',
              },
            }}
          >
            <Box ref={pagesRef} className="pdfViewer" />
          </Box>
          {document === null && (
            <Stack
              alignItems="center"
              spacing={1}
              sx={{ position: 'absolute', inset: 0, justifyContent: 'center', pointerEvents: 'none' }}
            >
              <CircularProgress size={18} />
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>正在打开预览…</Typography>
            </Stack>
          )}
        </Box>

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
            / {pageCount === 0 ? '–' : pageCount}
          </Typography>
          <Tooltip title="下一页">
            <span>
              <IconButton
                size="small"
                aria-label="下一页"
                disabled={pageCount === 0 || page >= pageCount}
                onClick={() => step(1)}
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="适应宽度（连续阅读最省力）">
            <span>
              <IconButton size="small" aria-label="适应宽度" onClick={fitWidth}>
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
