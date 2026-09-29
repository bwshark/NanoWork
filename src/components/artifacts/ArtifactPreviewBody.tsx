import { useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { isFileArtifact } from '@/lib/fileArtifact';
import { readLocalTextFile } from '@/lib/localFilePreview';
import type { Artifact } from '@/types';

interface ArtifactPreviewBodyProps {
  /** 已按索引 `contentHash` 从内容池回填过正文的产物 */
  artifact: Artifact;
}

/** 正文来源：磁盘回读的三种状态（未尝试 / 读取中 / 成功 / 不可得） */
type DiskState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; content: string; size: number }
  | { status: 'unavailable' };

/**
 * 产物正文渲染（产物面板的预览主体）。
 *
 * ## 文件产物的两级正文来源
 *
 * 1. **写入时快照**（`artifact.content`）：`write_file` 可得，离线也能看；
 * 2. **磁盘回读**（桌面端）：`edit` / `apply_patch` 拿不到改写后的全文，快照为空，
 *    此时按 `path` 回读真实文件——这也是「预览产物文件」最准确的含义（看到的是
 *    当前磁盘内容，而不是某次写入的历史快照）。
 *
 * Web 端或无路径时回读必然失败，降级为一行说明而不是空白（空白会被误读成
 * 「文件是空的」）。
 */
export function ArtifactPreviewBody({ artifact }: ArtifactPreviewBodyProps) {
  const fileNeedsDisk =
    isFileArtifact(artifact) && artifact.content === '' && !!artifact.path?.trim();

  const [disk, setDisk] = useState<DiskState>({ status: 'idle' });

  useEffect(() => {
    if (!fileNeedsDisk) {
      setDisk({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setDisk({ status: 'loading' });
    void readLocalTextFile(artifact.path ?? '').then((result) => {
      if (cancelled) return;
      setDisk(
        result
          ? { status: 'ready', content: result.content, size: result.size }
          : { status: 'unavailable' },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [fileNeedsDisk, artifact.path, artifact.id]);

  if (!fileNeedsDisk) {
    return <ArtifactRenderer artifact={artifact} header={false} />;
  }

  if (disk.status === 'loading' || disk.status === 'idle') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary', py: 2 }}>
        <CircularProgress size={12} sx={{ color: 'text.secondary' }} />
        <Typography sx={{ fontSize: 12.5 }}>读取文件中…</Typography>
      </Box>
    );
  }

  if (disk.status === 'unavailable') {
    return (
      <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.6 }}>
        无法读取该文件内容。该产物由改写类工具（edit / apply_patch）产生，
        只记录了路径与变更，未捕获全文；请在桌面端确认文件仍存在，或用「在资源管理器打开」
        查看。
      </Typography>
    );
  }

  return (
    <ArtifactRenderer artifact={{ ...artifact, content: disk.content }} header={false} />
  );
}