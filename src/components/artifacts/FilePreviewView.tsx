import { useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import { ArtifactRenderer } from '@/components/ArtifactRenderer';
import { formatBytes, languageForFileName } from '@/lib/artifact/fileArtifact';
import { platform } from '@/platform';
import type { WorkspaceReadResult } from '@/platform/types';

type State =
  | { status: 'loading' }
  | { status: 'ready'; result: WorkspaceReadResult }
  | { status: 'error'; message: string };

/**
 * 单个文件的只读预览（文件树里点开的那个标签）。
 *
 * 与产物预览的区别只有一处：正文**只来自磁盘**，没有「写入时快照」这一层
 * ——用户点的是工作空间里的一个真实文件，看到的就该是它此刻的内容。
 *
 * 复用 `ArtifactRenderer`：扩展名 → 语言 / markdown 的那套映射已经在了，
 * 这里再写一遍「.md 要按文档渲染、.ts 要高亮」只会两处漂移。
 */
export function FilePreviewView({ path, name }: { path: string; name: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void platform.workspaceReadText(path).then((result) => {
      if (cancelled) return;
      setState(result.ok ? { status: 'ready', result } : { status: 'error', message: result.error ?? '读取失败' });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (state.status === 'loading') {
    return (
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
        <CircularProgress size={13} sx={{ color: 'text.disabled' }} />
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>读取文件中…</Typography>
      </Box>
    );
  }

  if (state.status === 'error') {
    return (
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, px: 3 }}>
        <InsertDriveFileIcon sx={{ fontSize: 30, color: 'text.disabled' }} />
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', textAlign: 'center' }}>
          {state.message}
        </Typography>
      </Box>
    );
  }

  const { result } = state;

  if (result.binary) {
    return (
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, px: 3 }}>
        <InsertDriveFileIcon sx={{ fontSize: 30, color: 'text.disabled' }} />
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>这是一个二进制文件，无法按文本预览</Typography>
        <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
          {formatBytes(result.size) ?? ''}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {/* 路径常驻在最上面：同名文件在不同目录下很常见，只给文件名会让人认错 */}
      <Typography
        noWrap
        title={path}
        sx={{ px: 1.5, py: 0.75, fontSize: 11, color: 'text.disabled' }}
      >
        {path}
        {result.truncated ? '（文件过大，仅显示前 512 KB）' : ''}
      </Typography>
      <Box sx={{ px: 1.5, pb: 2 }}>
        <ArtifactRenderer
          artifact={{
            id: `file:${path}`,
            type: 'file',
            title: name,
            content: result.content ?? '',
            language: languageForFileName(name),
            createdAt: new Date().toISOString(),
          }}
          header={false}
        />
      </Box>
    </Box>
  );
}
