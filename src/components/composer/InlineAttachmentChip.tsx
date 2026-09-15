import { Box, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import { attachmentPreviewSrc, formatBytes } from '@/lib/attachments';
import { KIND_ICON, KIND_LABEL } from './AttachmentBar';
import type { Attachment } from '@/types';

/**
 * 内联附件徽章：在输入区内与文字同行排布（WorkBuddy 风格）。
 *
 * - 默认：类型图标 + 文件名；
 * - 可编辑态（传 onRemove 且非 readonly）：悬停时图标切换为 × 删除按钮；
 * - 悬停提示：图片展开大图预览，其余类型显示「文件名 · 类型 · 体积」；
 * - onPrimary：用于 primary 底色气泡，半透明白底 + 继承前景色。
 */
export interface InlineAttachmentChipProps {
  attachment: Attachment;
  /** 删除回调；不传或 readonly 时渲染为只读展示 */
  onRemove?: (id: string) => void;
  /** 只读（已发送消息气泡）：不显示悬停删除 */
  readonly?: boolean;
  /** 彩色气泡内：半透明白底、前景色继承气泡 */
  onPrimary?: boolean;
}

export function InlineAttachmentChip({
  attachment: a,
  onRemove,
  readonly = false,
  onPrimary = false,
}: InlineAttachmentChipProps) {
  const Icon = KIND_ICON[a.kind] ?? InsertDriveFileIcon;
  const preview = attachmentPreviewSrc(a);
  const editable = typeof onRemove === 'function' && !readonly;

  return (
    <Tooltip
      title={
        preview ? (
          // 图片：悬停展开大图预览（白底卡片风格，贴近参考图）
          <Box
            component="img"
            src={preview}
            alt={a.name}
            sx={{
              display: 'block',
              width: 'auto',
              height: 'auto',
              maxWidth: 360,
              maxHeight: 300,
              borderRadius: 0.5,
            }}
          />
        ) : (
          a.localPath ??
          `${a.name} · ${KIND_LABEL[a.kind] ?? KIND_LABEL.other} · ${formatBytes(a.size)}`
        )
      }
      placement="top-start"
      enterDelay={120}
      slotProps={{
        tooltip: preview
          ? {
              // 图片预览需要去掉 Tooltip 默认的深色底与宽度限制
              sx: {
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                p: 0.5,
                maxWidth: 'none',
                boxShadow: 8,
              },
            }
          : { sx: { maxWidth: 'none' } },
      }}
    >
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          height: 24,
          pl: 0.75,
          pr: 0.875,
          borderRadius: 1.5,
          bgcolor: (theme) =>
            onPrimary
              ? theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.16)'
                : 'rgba(0,0,0,0.08)'
              : 'action.hover',
          color: onPrimary ? 'inherit' : 'text.primary',
          maxWidth: 260,
          userSelect: 'none',
          '&:hover': {
            bgcolor: (theme) =>
              onPrimary
                ? theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.24)'
                  : 'rgba(0,0,0,0.12)'
                : 'action.selected',
          },
          // 可编辑态：悬停时类型图标让位给删除按钮
          ...(editable
            ? {
                '&:hover .chip-icon': { display: 'none' },
                '&:hover .chip-del': { display: 'inline-flex' },
              }
            : {}),
        }}
      >
        <Box
          component="span"
          className="chip-icon"
          sx={{ display: 'inline-flex', alignItems: 'center' }}
        >
          <Icon
            sx={{ fontSize: 16, color: onPrimary ? 'inherit' : 'primary.main' }}
          />
        </Box>
        {editable && (
          <Box
            component="span"
            className="chip-del"
            role="button"
            aria-label={`移除附件 ${a.name}`}
            onClick={(e) => {
              // 不冒泡到输入区的「点击聚焦」逻辑
              e.stopPropagation();
              onRemove?.(a.id);
            }}
            sx={{
              display: 'none',
              alignItems: 'center',
              cursor: 'pointer',
              color: onPrimary ? 'inherit' : 'text.secondary',
              '&:hover': { color: onPrimary ? 'inherit' : 'error.main' },
            }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </Box>
        )}
        <Typography
          sx={{
            fontSize: 13,
            lineHeight: '24px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {a.name}
        </Typography>
      </Box>
    </Tooltip>
  );
}
