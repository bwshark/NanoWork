/**
 * 产物卡片的**跨面板共用动作**（预览 / 打开所在位置 / 复制路径 / 定位消息）。
 *
 * 消息底部的卡片区与右侧产物面板都要这四个动作，且语义必须完全一致——两处各写
 * 一遍必然漂移（最典型的是「复制路径」一处复制了绝对路径、另一处复制了文件名）。
 * 故收敛成一个 hook。
 */

import { useCallback, useMemo } from 'react';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import type { Artifact } from '@/types';

/** 产物动作集合（与产物无绑定关系，调用时传具体产物） */
export interface ArtifactActions {
  /** 在右侧面板内预览该产物（面板已关则一并展开） */
  preview: (artifact: Artifact) => void;
  /** 在系统文件管理器中打开所在位置（仅桌面端；Web 端给出提示） */
  reveal: (artifact: Artifact) => void;
  /** 复制文件路径到剪贴板 */
  copyPath: (artifact: Artifact) => void;
  /** 滚动定位到产生该产物的那条消息 */
  locate: (artifact: Artifact) => void;
}

/**
 * 构造产物动作集合。
 *
 * @param sessionId 当前会话 id：预览需要它来展开面板（面板是会话级视图）
 */
export function useArtifactActions(sessionId: string): ArtifactActions {
  const preview = useCallback(
    (artifact: Artifact) => {
      // 一次调用同时完成「展开面板 + 选中产物」，避免两次 setState 造成中间态闪烁
      useSessionUiStore.getState().openArtifactPanel(sessionId, { previewId: artifact.id });
    },
    [sessionId],
  );

  const reveal = useCallback((artifact: Artifact) => {
    const path = artifact.path?.trim();
    if (!path) {
      toast.warning('该产物没有本地路径');
      return;
    }
    void platform.openPath(path).then((result) => {
      if (!result.ok) toast.error(result.error ?? '打开所在位置失败');
    });
  }, []);

  const copyPath = useCallback((artifact: Artifact) => {
    const path = artifact.path?.trim();
    if (!path) {
      toast.warning('该产物没有本地路径');
      return;
    }
    // 走 async 包装：`navigator.clipboard` 在某些环境（jsdom / 非安全上下文）根本
    // 不存在，直接取 `writeText` 会**同步抛错**，`.catch()` 接不住
    void writeClipboard(path)
      .then(() => toast.success('已复制路径'))
      .catch(() => toast.error('复制失败，请手动复制'));
  }, []);

  const locate = useCallback((artifact: Artifact) => {
    // 归属消息由索引切片给出（实时与重放两条路径都会写 messageId），
    // 卡片自己不必知道「我是哪条消息里的产物」
    const messageId = useArtifactsStore.getState().index[artifact.id]?.messageId;
    if (!messageId) {
      toast.warning('找不到产生该产物的消息');
      return;
    }
    useSessionUiStore.getState().focusMessage(messageId);
  }, []);

  return useMemo(() => ({ preview, reveal, copyPath, locate }), [
    preview,
    reveal,
    copyPath,
    locate,
  ]);
}

/** 写剪贴板；被 `copyPath` 包在 Promise 链里，故用 async 把同步异常转成 rejection */
async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}