import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import NorthEastIcon from '@mui/icons-material/NorthEast';
import { FileIcon } from './FileIcon';
import type { ArtifactActions } from './useArtifactActions';
import { formatBytes } from '@/lib/artifact/fileArtifact';
import type { Artifact } from '@/types';

interface FileArtifactCardProps {
  /** 文件产物（引用或其正文快照） */
  artifact: Artifact;
  /** 变更次数（来自索引的版本链；0 = 只写过一次） */
  changes?: number;
  /** 共用的产物动作（预览 / 打开位置 / 复制路径 / 定位消息） */
  actions: ArtifactActions;
  /** 处于预览中（右侧面板正打开它）时高亮 */
  selected?: boolean;
}

/** 元信息一行：体积 · 新建/已修改 · N 次变更（缺项自动省略） */
function metaText(artifact: Artifact, changes: number): string {
  const parts: string[] = [];
  const size = formatBytes(artifact.size);
  if (size) parts.push(size);
  parts.push(artifact.change === 'modified' ? '已修改' : '新建');
  if (changes > 0) parts.push(`${changes} 次变更`);
  return parts.join(' · ');
}

/**
 * 文件产物卡片（对齐参考稿：类型角标 + 文件名 + 体积，悬停露出操作）。
 *
 * 交互约定（产品明确要求）：
 * - **点击卡片本体 = 在右侧面板打开预览**，而不是就地展开——右侧面板才是产物的
 *   阅读位置，就地展开会把对话流顶得很长；
 * - 「定位到消息」常驻显示（参考稿右侧的箭头），其余操作悬停才露出，保持卡片干净；
 * - 所有操作按钮 `stopPropagation`，否则点「复制路径」会连带触发预览。
 */
export function FileArtifactCard({
  artifact,
  changes = 0,
  actions,
  selected = false,
}: FileArtifactCardProps) {
  const name = artifact.title?.trim() || artifact.path || artifact.id;
  const path = artifact.path?.trim() || '';
  const meta = metaText(artifact, changes);

  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={`预览产物 ${name}`}
      onClick={() => actions.preview(artifact)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          actions.preview(artifact);
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.25,
        py: 0.9,
        minWidth: 0,
        borderRadius: 2,
        border: '1px solid',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? 'action.selected' : 'background.paper',
        cursor: 'pointer',
        transition: 'border-color .15s, background-color .15s',
        '&:hover': {
          borderColor: 'primary.main',
          bgcolor: 'action.hover',
        },
        '&:hover .artifact-card-action': { opacity: 1 },
      }}
    >
      <FileIcon name={name} />

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Tooltip title={path || name} enterDelay={700}>
          <Typography
            noWrap
            sx={{ fontSize: 13, fontWeight: 500, color: 'text.primary', lineHeight: 1.35 }}
          >
            {name}
          </Typography>
        </Tooltip>
        <Typography noWrap sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.35 }}>
          {meta}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        {/* 次要操作：悬停才露出，避免卡片常驻一排图标 */}
        <Tooltip title="在资源管理器打开" placement="top">
          <IconButton
            className="artifact-card-action"
            size="small"
            aria-label={`打开所在位置 ${name}`}
            sx={{ p: 0.4, opacity: 0, transition: 'opacity .15s' }}
            onClick={(e) => {
              e.stopPropagation();
              actions.reveal(artifact);
            }}
          >
            <FolderOpenIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="复制路径" placement="top">
          <IconButton
            className="artifact-card-action"
            size="small"
            aria-label={`复制路径 ${name}`}
            sx={{ p: 0.4, opacity: 0, transition: 'opacity .15s' }}
            onClick={(e) => {
              e.stopPropagation();
              actions.copyPath(artifact);
            }}
          >
            <ContentCopyIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        {/* 主操作：定位到产生它的那条消息（参考稿右侧常驻的箭头） */}
        <Tooltip title="定位到消息" placement="top">
          <IconButton
            size="small"
            aria-label={`定位到消息 ${name}`}
            sx={{ p: 0.4, color: 'text.secondary' }}
            onClick={(e) => {
              e.stopPropagation();
              actions.locate(artifact);
            }}
          >
            <NorthEastIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}