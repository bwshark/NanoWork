import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ImageIcon from '@mui/icons-material/Image';
import DescriptionIcon from '@mui/icons-material/Description';
import ArticleIcon from '@mui/icons-material/Article';
import VideoFileIcon from '@mui/icons-material/VideoFile';
import AudioFileIcon from '@mui/icons-material/AudioFile';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import {
  attachmentPreviewSrc,
  formatBytes,
} from '@/lib/artifact/attachments';
import type { Attachment, AttachmentKind } from '@/types';

/**
 * 附件预览条（Composer 输入框上方 / 用户消息气泡下方共用）。
 *
 * - 图片：显示缩略图（优先 object URL，其次小图 dataUrl）；
 * - 其余：按大类显示图标 + 文件名 + 体积；
 * - 传入 onRemove 即进入可编辑态（Composer），不传则为只读展示（消息气泡）。
 */

/** 大类 → 图标（与 ExtensionKind 一一对应，兜底用通用文件图标） */
export const KIND_ICON: Record<AttachmentKind, typeof InsertDriveFileIcon> = {
  image: ImageIcon,
  document: DescriptionIcon,
  text: ArticleIcon,
  video: VideoFileIcon,
  audio: AudioFileIcon,
  other: InsertDriveFileIcon,
};

/** 大类 → 中文名（用于 tooltip 提示） */
export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: '图片',
  document: '文档',
  text: '文本',
  video: '视频',
  audio: '音频',
  other: '文件',
};

export interface AttachmentBarProps {
  attachments: Attachment[];
  /** 删除回调；不传则渲染为只读展示（无删除按钮） */
  onRemove?: (id: string) => void;
  /** 单条附件的最大宽度（气泡内需要比 Composer 更紧凑） */
  maxWidth?: number;
  /**
   * 内嵌模式：用于已发送消息的彩色气泡内。
   * 关闭外边距与自身底色，文字继承气泡的前景色以保证对比度。
   */
  inset?: boolean;
}

export function AttachmentBar({
  attachments,
  onRemove,
  maxWidth = 200,
  inset = false,
}: AttachmentBarProps) {
  if (attachments.length === 0) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1,
        // Composer 内需要贴着输入框边缘留出内边距；气泡内由 Paper 自己控制
        px: inset ? 0 : 1.5,
        pt: inset ? 0.75 : 1.25,
        pb: inset ? 0 : 0.5,
      }}
    >
      {attachments.map((a) => {
        // 历史持久化的 kind 可能是旧版本未覆盖的值，统一兜底到通用文件
        const Icon = KIND_ICON[a.kind] ?? InsertDriveFileIcon;
        const kindLabel = KIND_LABEL[a.kind] ?? KIND_LABEL.other;
        const preview = attachmentPreviewSrc(a);
        const editable = typeof onRemove === 'function';
        return (
          <Tooltip
            key={a.id}
            title={`${a.name} · ${kindLabel} · ${formatBytes(a.size)}`}
          >
            <Box
              sx={{
                position: 'relative',
                maxWidth,
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: preview ? 0.5 : 1,
                py: 0.5,
                borderRadius: 1.5,
                border: '1px solid',
                borderColor: 'divider',
                // 气泡内不再叠一层灰底（会与 primary 底色打架），改为透明 + 继承前景色
                bgcolor: inset ? 'transparent' : 'action.hover',
                overflow: 'hidden',
              }}
            >
              {preview ? (
                // 图片：固定高度缩略图，宽度随比例自适应
                <Box
                  component="img"
                  src={preview}
                  alt={a.name}
                  sx={{
                    height: 40,
                    width: 'auto',
                    maxWidth: 72,
                    objectFit: 'cover',
                    borderRadius: 1,
                    display: 'block',
                  }}
                />
              ) : (
                <Icon
                  sx={{
                    fontSize: 20,
                    color: inset ? 'inherit' : 'text.secondary',
                    opacity: inset ? 0.85 : 1,
                    flexShrink: 0,
                  }}
                />
              )}
              <Box sx={{ minWidth: 0, pr: editable ? 2.5 : 0.25 }}>
                <Typography
                  sx={{
                    fontSize: 12,
                    color: inset ? 'inherit' : 'text.primary',
                    maxWidth: preview ? 88 : 148,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.name}
                </Typography>
                {!preview && (
                  <Typography
                    sx={{
                      fontSize: 11,
                      color: inset ? 'inherit' : 'text.secondary',
                      opacity: inset ? 0.75 : 1,
                    }}
                  >
                    {formatBytes(a.size)}
                  </Typography>
                )}
              </Box>
              {editable && (
                <IconButton
                  size="small"
                  onClick={() => onRemove?.(a.id)}
                  aria-label={`移除附件 ${a.name}`}
                  sx={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    p: 0.25,
                    color: 'text.secondary',
                    bgcolor: 'background.paper',
                    '&:hover': { color: 'error.main', bgcolor: 'action.selected' },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              )}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
