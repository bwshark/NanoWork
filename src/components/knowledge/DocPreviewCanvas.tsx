/**
 * 原格式预览的画布（pdf.js）——**懒加载模块**。
 *
 * 与服务端的分工：服务端已经把 pptx/docx/xlsx 转成 PDF（见 `cloud/app/kb/render.py`），
 * 这里只负责把 PDF 画出来。四类文件因此收敛成同一种视图：左缩略图、右页面、翻页与缩放。
 *
 * ## 为什么带票取字节，而不是给 pdf.js 一个 URL
 *
 * pdf.js 的 URL 模式内部自己发请求，**带不上 `Authorization` 头**，而知识库的接口
 * 一律要 Bearer 票。所以出口在 `kbClient.getPreviewPdf`（带票取回 Blob），
 * 这里只接 `ArrayBuffer`。
 *
 * ## 为什么 `bytes.slice(0)`
 *
 * pdf.js 会把传入的 buffer **转移**给 worker（transferable），转移之后原 buffer 变成
 * 0 字节。直接用 props 里那个 buffer，用户一翻页/一缩放就会拿到空文档 —— 症状是
 * 「第二页是白的」。复制一份最省事，PDF 通常几百 KB，代价可以忽略。
 *
 * ## 为什么缩略图要分批刷新
 *
 * 40 页的稿子如果等 40 张缩略图都画完再一次性 setState，用户在头两秒里看到的是
 * 一个空白侧栏。每 4 页刷一次，缩略图是"边转边出现"的。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, CircularProgress, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * worker 地址走 Vite 的 `?url`：dev 与 build 都会给到一个能 fetch 的地址。
 * ⚠️ 不要改成 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)`
 * —— 在 Electron 里那会落到 `file://`，生产环境直接 404，症状是「进度条卡在 0%」。
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 缩略图宽度（px）。够看清版式，又不至于把侧栏撑爆。 */
const THUMB_WIDTH = 104;

/** 缩放档位。`1` = 按容器宽度自适应。 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export interface DocPreviewCanvasProps {
  /** PDF 字节（已带票取回） */
  bytes: ArrayBuffer;
  /** 文档标题：缩略图的 alt 与画布的无障碍名 */
  title: string;
}

export function DocPreviewCanvas({ bytes, title }: DocPreviewCanvasProps) {
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);

  // 载入文档（`bytes` 换一次就重新载一次：抽屉里换文档时就是这种情况）
  useEffect(() => {
    let cancelled = false;
    setError("");
    setPage(1);
    setThumbs([]);
    setPageCount(0);
    // ⚠️ slice：pdf.js 会把这个 buffer 转移给 worker，转移后原 buffer 变空
    const task = pdfjs.getDocument({ data: bytes.slice(0) });
    void task.promise.then(
      (loaded) => {
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setDocument(loaded);
        setPageCount(loaded.numPages);
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "PDF 解析失败");
        }
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [bytes]);

  // 主页面：按容器宽度 × 缩放档位渲染
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!document || !canvas) return;
    let cancelled = false;
    let rendering: { cancel: () => void } | null = null;

    void (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) return;
      const available = Math.max(320, (stageRef.current?.clientWidth ?? 720) - 32);
      const base = available / pdfPage.getViewport({ scale: 1 }).width;
      const viewport = pdfPage.getViewport({ scale: base * zoom });
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const task = pdfPage.render({ canvasContext: context, viewport });
      rendering = task;
      await task.promise;
    })().catch((reason: unknown) => {
      // 取消渲染是**正常路径**（翻页/缩放会取消上一张），不能当错误报给用户
      if (cancelled || (reason as { name?: string } | null)?.name === "RenderingCancelledException") {
        return;
      }
      setError(reason instanceof Error ? reason.message : "页面渲染失败");
    });

    return () => {
      cancelled = true;
      rendering?.cancel();
    };
  }, [document, page, zoom]);

  // 缩略图：顺序渲染，每 4 页刷一次（边转边出现，而不是等全部画完）
  useEffect(() => {
    if (!document) return;
    let cancelled = false;

    void (async () => {
      const rendered: string[] = [];
      for (let index = 1; index <= document.numPages; index += 1) {
        if (cancelled) return;
        const pdfPage = await document.getPage(index);
        const natural = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: THUMB_WIDTH / natural.width });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) continue;
        await pdfPage.render({ canvasContext: context, viewport }).promise;
        rendered.push(canvas.toDataURL("image/png"));
        if (rendered.length % 4 === 0) {
          if (!cancelled) setThumbs([...rendered]);
        }
      }
      if (!cancelled) setThumbs(rendered);
    })().catch(() => {
      // 缩略图失败不影响主页面的阅读：静默即可（主画布会给出真正的错误）
    });

    return () => {
      cancelled = true;
    };
  }, [document]);

  // 缩略图跟着当前页滚动（40 页的稿子翻到第 30 页时，侧栏别还停在第一屏）
  useEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>(`[data-thumb="${page}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [page]);

  const step = useCallback(
    (delta: number) => {
      setPage((current) => Math.min(Math.max(1, current + delta), Math.max(1, pageCount)));
    },
    [pageCount],
  );

  const zoomBy = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const index = ZOOM_STEPS.indexOf(current);
      const next = (index < 0 ? 2 : index) + direction;
      return ZOOM_STEPS[Math.min(Math.max(0, next), ZOOM_STEPS.length - 1)];
    });
  }, []);

  if (error !== "") {
    return (
      <Box sx={{ py: 4 }}>
        <Typography sx={{ fontSize: 13, color: "error.main" }} data-testid="kb-preview-error">
          预览打不开：{error}
        </Typography>
        <Typography sx={{ mt: 1, fontSize: 12, color: "text.secondary" }}>
          换「正文」标签照样能读内容与检索；需要原格式预览的话，重新上传一次试试。
        </Typography>
      </Box>
    );
  }

  return (
    <Stack direction="row" sx={{ height: "100%", minHeight: 0 }}>
      {/* 缩略图栏：一页一张，点一下跳过去 */}
      <Box
        ref={railRef}
        data-testid="kb-preview-thumbs"
        sx={{
          width: 122,
          flexShrink: 0,
          overflowY: "auto",
          borderRight: "1px solid",
          borderColor: "divider",
          py: 1,
          px: 0.75,
        }}
      >
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
              onClick={() => setPage(number)}
              sx={{
                mb: 1,
                p: 0.5,
                borderRadius: 1,
                cursor: "pointer",
                border: "1px solid",
                borderColor: active ? "primary.main" : "transparent",
                bgcolor: active ? "action.selected" : "transparent",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Box
                component="img"
                src={src}
                alt={`${title} 第 ${number} 页`}
                sx={{ width: "100%", display: "block", borderRadius: "3px" }}
              />
              <Typography sx={{ mt: 0.25, fontSize: 10, color: "text.secondary", textAlign: "center" }}>
                {number}
              </Typography>
            </Box>
          );
        })}
      </Box>

      {/* 页面 + 底部工具条 */}
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Box
          ref={stageRef}
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            p: 2,
            bgcolor: "action.hover",
          }}
        >
          {document === null ? (
            <Stack alignItems="center" spacing={1} sx={{ py: 6 }}>
              <CircularProgress size={18} />
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>正在打开预览…</Typography>
            </Stack>
          ) : (
            <Box
              component="canvas"
              ref={canvasRef}
              aria-label={`${title} 第 ${page} 页`}
              data-testid="kb-preview-canvas"
              sx={{ maxWidth: "100%", bgcolor: "background.paper", boxShadow: 1 }}
            />
          )}
        </Box>

        <Stack
          direction="row"
          alignItems="center"
          spacing={0.5}
          sx={{ height: 40, px: 1, borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}
        >
          <Tooltip title="上一页">
            <span>
              <IconButton size="small" aria-label="上一页" disabled={page <= 1} onClick={() => step(-1)}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Typography sx={{ fontSize: 12, color: "text.secondary", minWidth: 56, textAlign: "center" }}>
            {pageCount === 0 ? "– / –" : `${page} / ${pageCount}`}
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
          <Tooltip title="缩小">
            <span>
              <IconButton size="small" aria-label="缩小" onClick={() => zoomBy(-1)}>
                <ZoomOutIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary", minWidth: 40, textAlign: "center" }}>
            {Math.round(zoom * 100)}%
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
