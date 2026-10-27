/**
 * 懒加载查看器的错误边界（PDF 与表格视图共用）。
 *
 * 为什么必须有：`lazy(() => import(...))` 的 chunk **加载失败**（网络、worker 404、
 * 打包异常）会以「渲染期抛错」的形式冒出来，而在 React 18 里没有边界就是整棵树卸载
 * —— 用户看到的是**整个应用白屏**，只因为他打开了一篇 PPT。失败限制在预览区，
 * 抽屉与正文照样能用。
 *
 * 为什么不各自写一份：两个查看器写两份边界，改一处漏一处时症状是「PDF 打不开是
 * 一句人话，表格打不开是白屏」—— 没人会想到去找边界。
 */

import { Component, type ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

interface ViewerBoundaryProps {
  children: ReactNode;
  /** 失败时那句「还能怎么读」的补充说明 */
  fallbackHint?: string;
}

export class ViewerBoundary extends Component<ViewerBoundaryProps, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : '查看器加载失败' };
  }

  render() {
    if (this.state.error === '') return this.props.children;
    return (
      <Box sx={{ py: 4 }} data-testid="kb-preview-crash">
        <Typography sx={{ fontSize: 13, color: 'error.main' }}>
          预览查看器加载失败：{this.state.error}
        </Typography>
        <Typography sx={{ mt: 1, fontSize: 12, color: 'text.secondary' }}>
          {this.props.fallbackHint ?? '换「正文」标签照样能读内容与检索。'}
        </Typography>
      </Box>
    );
  }
}
