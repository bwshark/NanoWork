import { Box, Typography } from '@mui/material';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { ComposerPickerShell } from './ComposerPickerShell';

/**
 * 文件引用浮层（`@`）：列出本会话已出现的文件
 * （用户上传的附件 + 助手产出的产物），选中后在光标处插入 `@文件名` 引用标记。
 */

/** 一条可引用文件 */
export interface FileRefItem {
  /** 唯一键：附件为 `att-<id>`，产物为 `art-<id>` */
  id: string;
  /** 文件名 / 产物标题 */
  name: string;
  /** 来源：attachment = 用户上传，artifact = 助手产出 */
  source: 'attachment' | 'artifact';
  /** 副标题（体积 / 产物类型） */
  subtitle: string;
}

export interface FileReferencePickerProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  items: FileRefItem[];
  activeIndex: number;
  onSelect: (item: FileRefItem) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}

/** 单行渲染：来源图标 + 文件名 + 副标题 */
function renderRow(item: FileRefItem, active: boolean) {
  const Icon = item.source === 'artifact' ? AutoAwesomeIcon : AttachFileIcon;
  return (
    <>
      <Icon
        sx={{
          fontSize: 18,
          flexShrink: 0,
          color: active ? 'primary.main' : 'text.secondary',
        }}
      />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          sx={{
            fontSize: 13,
            color: 'text.primary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.name}
        </Typography>
        <Typography
          sx={{
            fontSize: 11.5,
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.subtitle}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', flexShrink: 0 }}>
        {item.source === 'artifact' ? '产物' : '附件'}
      </Typography>
    </>
  );
}

/** 文件引用浮层：输入 `@` 后弹出，↑↓ 选择、Enter 确认、Esc 关闭 */
export function FileReferencePicker({
  open,
  anchorEl,
  items,
  activeIndex,
  onSelect,
  onHover,
  onClose,
}: FileReferencePickerProps) {
  return (
    <ComposerPickerShell<FileRefItem>
      open={open}
      anchorEl={anchorEl}
      title="引用对话中的文件"
      items={items}
      activeIndex={activeIndex}
      onSelect={onSelect}
      onHover={onHover}
      onClose={onClose}
      emptyText="本会话还没有可引用的文件"
      renderItem={renderRow}
    />
  );
}
