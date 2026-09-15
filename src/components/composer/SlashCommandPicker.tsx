import { Box, Typography } from '@mui/material';
import { ComposerPickerShell } from './ComposerPickerShell';

/**
 * 斜杠指令浮层（`/`）：列出内置指令 + 已启用技能。
 *
 * 纯展示组件：过滤、键盘导航与「选中后做什么」全部由 Composer 负责，
 * 本组件只负责排版与鼠标交互事件的回传。
 */

/** 一条候选项：内置指令或技能 */
export interface SlashCommandItem {
  /** 内置指令为指令 id（clear/compact/model/new），技能为技能 id */
  id: string;
  /** 展示名：指令形如 `/compact`，技能为技能名 */
  label: string;
  /** 说明文字（技能描述 / 指令用途） */
  description: string;
  /** 前置图标（技能用 emoji，指令用 MUI 图标） */
  icon: React.ReactNode;
  /** 分组：skill = 技能（选中即挂载到当前会话），command = 内置指令 */
  group: 'skill' | 'command';
}

export interface SlashCommandPickerProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  items: SlashCommandItem[];
  activeIndex: number;
  onSelect: (item: SlashCommandItem) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}

/** 单行渲染：图标 + 名称 + 说明 + 分组标签 */
function renderRow(item: SlashCommandItem, active: boolean) {
  return (
    <>
      <Box
        sx={{
          width: 24,
          height: 24,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          color: active ? 'primary.main' : 'text.secondary',
        }}
      >
        {item.icon}
      </Box>
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
          {item.label}
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
          {item.description}
        </Typography>
      </Box>
      <Typography
        sx={{
          fontSize: 11,
          flexShrink: 0,
          color: item.group === 'skill' ? 'primary.main' : 'text.secondary',
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? 'rgba(255,255,255,0.06)'
              : 'rgba(0,0,0,0.04)',
          px: 0.75,
          py: 0.1,
          borderRadius: 0.75,
        }}
      >
        {item.group === 'skill' ? '技能' : '指令'}
      </Typography>
    </>
  );
}

/** 斜杠指令浮层：输入 `/` 后弹出，↑↓ 选择、Enter 确认、Esc 关闭 */
export function SlashCommandPicker({
  open,
  anchorEl,
  items,
  activeIndex,
  onSelect,
  onHover,
  onClose,
}: SlashCommandPickerProps) {
  return (
    <ComposerPickerShell<SlashCommandItem>
      open={open}
      anchorEl={anchorEl}
      title="技能与指令"
      items={items}
      activeIndex={activeIndex}
      onSelect={onSelect}
      onHover={onHover}
      onClose={onClose}
      emptyText="没有匹配的技能或指令"
      renderItem={renderRow}
    />
  );
}
