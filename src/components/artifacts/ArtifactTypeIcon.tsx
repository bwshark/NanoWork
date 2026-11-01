import ArticleIcon from '@mui/icons-material/Article';
import ImageIcon from '@mui/icons-material/Image';
import MovieIcon from '@mui/icons-material/Movie';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import CodeIcon from '@mui/icons-material/Code';
import type { ArtifactType } from '@/types';

/**
 * 富产物类型 → 图标。
 *
 * 文件产物（`type: 'file'`）不在这里：它要看扩展名，走 `FileIcon` 的彩色角标。
 * 单独抽一个组件是因为**标签栏和列表行都要用**——两处各写一份 switch，
 * 新增一种产物类型时必然漏掉一处（症状是标签有图标、列表没有，没人会当成 bug 报）。
 */
export function ArtifactTypeIcon({ type, size = 15 }: { type: ArtifactType; size?: number }) {
  const sx = { fontSize: size } as const;
  switch (type) {
    case 'image':
    case 'svg':
      return <ImageIcon sx={sx} />;
    case 'video':
      return <MovieIcon sx={sx} />;
    case 'mermaid':
      return <AccountTreeIcon sx={sx} />;
    case 'html':
    case 'code':
      return <CodeIcon sx={sx} />;
    default:
      return <ArticleIcon sx={sx} />;
  }
}
