/**
 * 原格式预览的**懒加载边界**（与 `MarkdownView` 同一个理由）。
 *
 * `pdfjs-dist` 打包后约 400 KB（含 worker 另算），而它只在「打开一篇 Office/PDF 文档
 * 并且切到原文标签」时才需要 —— 会话列表、任何一页骨架都不该为它付费。
 *
 * ⚠️ 不要在这里静态 import `./DocPreviewCanvas`：那会把 pdf.js 拽回入口的静态依赖图，
 * 判据是 `tasks/verify-b5-first-paint.mjs` 量的首屏预算。
 */

import { Suspense, lazy } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { ViewerBoundary } from '@/components/knowledge/ViewerBoundary';

const DocPreviewCanvas = lazy(() =>
  import('./DocPreviewCanvas').then((m) => ({ default: m.DocPreviewCanvas })),
);

export interface DocPreviewViewProps {
  /** PDF 字节（已带票取回）；`null` = 还没取到 */
  bytes: ArrayBuffer | null;
  title: string;
  /** 准备阶段的人话（"正在生成原格式预览…" / 失败原因） */
  hint?: string;
  /** 还在准备（转 PDF / 取字节） */
  busy?: boolean;
}

export function DocPreviewView({ bytes, title, hint, busy = false }: DocPreviewViewProps) {
  if (bytes === null) {
    return (
      <Stack alignItems="center" spacing={1.25} sx={{ py: 8 }} data-testid="kb-preview-waiting">
        {busy ? <CircularProgress size={20} /> : null}
        <Typography sx={{ fontSize: 12.5, color: "text.secondary", textAlign: "center", maxWidth: 420 }}>
          {hint ?? "正在准备预览…"}
        </Typography>
        {busy ? (
          <Typography sx={{ fontSize: 11, color: "text.disabled", textAlign: "center", maxWidth: 420 }}>
            首次打开要把原文件转成 PDF（通常几秒），转好之后就不必再等。
          </Typography>
        ) : null}
      </Stack>
    );
  }

  return (
    <Box sx={{ height: "100%", minHeight: 0 }} data-testid="kb-preview-body">
      <ViewerBoundary>
        <Suspense
          fallback={
          <Stack alignItems="center" spacing={1} sx={{ py: 8 }}>
            <CircularProgress size={18} />
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>正在加载查看器…</Typography>
          </Stack>
        }
      >
          <DocPreviewCanvas bytes={bytes} title={title} />
        </Suspense>
      </ViewerBoundary>
    </Box>
  );
}
