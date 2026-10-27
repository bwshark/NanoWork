/**
 * 表格视图的**懒加载边界**（与 `DocPreviewView` 同一个理由）。
 *
 * 表格渲染器是知识库抽屉里最重的一块（虚拟化 + 单元格样式 + 拖拽），而它只在
 * 「打开一篇 .xlsx」时才需要 —— 会话列表、知识库列表都不该为它付费。
 *
 * ⚠️ 不要在这里静态 import `./DocGridCanvas`：那会把它拽回入口的静态依赖图，
 * 判据是 `tasks/verify-b5-first-paint.mjs` 量的首屏预算。
 */

import { Suspense, lazy } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { ViewerBoundary } from '@/components/knowledge/ViewerBoundary';
import type { KbWorkbook } from '@/lib/kb/workbook';

const DocGridCanvas = lazy(() =>
  import('./DocGridCanvas').then((m) => ({ default: m.DocGridCanvas })),
);

export interface DocGridViewProps {
  /** 工作簿 JSON；`null` = 还没取到 */
  workbook: KbWorkbook | null;
  title: string;
  /** 准备阶段的人话（"正在解析表格…" / 失败原因） */
  hint?: string;
  /** 还在准备（解析 / 取 JSON） */
  busy?: boolean;
}

export function DocGridView({ workbook, title, hint, busy = false }: DocGridViewProps) {
  if (workbook === null) {
    return (
      <Stack alignItems="center" spacing={1.25} sx={{ py: 8 }} data-testid="kb-grid-waiting">
        {busy ? <CircularProgress size={20} /> : null}
        <Typography
          sx={{ fontSize: 12.5, color: 'text.secondary', textAlign: 'center', maxWidth: 420 }}
        >
          {hint ?? '正在准备表格视图…'}
        </Typography>
        {busy ? (
          <Typography
            sx={{ fontSize: 11, color: 'text.disabled', textAlign: 'center', maxWidth: 420 }}
          >
            表格视图是直接解析原文件得到的（不需要 Office 转换），通常一两秒就好。
          </Typography>
        ) : null}
      </Stack>
    );
  }

  return (
    <Box
      // 百分比高度（而不是 `flex: 1`）：`flex: 1` 要求祖先一定是 flex 容器，
      // 否则整块塌成 0 高 —— 那正是「只剩工具条、单元格不见了」的形态。
      sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      data-testid="kb-grid-body"
    >
      <ViewerBoundary fallbackHint="换「正文」标签照样能读内容与检索；表格视图是一条独立的解析链路。">
        <Suspense
          fallback={
            <Stack alignItems="center" spacing={1} sx={{ py: 8 }}>
              <CircularProgress size={18} />
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                正在加载表格视图…
              </Typography>
            </Stack>
          }
        >
          <DocGridCanvas workbook={workbook} title={title} />
        </Suspense>
      </ViewerBoundary>
    </Box>
  );
}
