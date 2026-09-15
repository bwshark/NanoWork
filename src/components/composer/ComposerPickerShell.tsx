import { useEffect, useRef } from 'react';
import { Box, Popover, Typography } from '@mui/material';
import type { Theme } from '@mui/material';

/**
 * Composer 触发式浮层的公共外壳（`/` 指令 / `@` 引用共用）。
 *
 * 设计要点：
 * - 挂在 body 上的 Popover，避免被输入框卡片的 `overflow: hidden` 裁剪；
 * - `hideBackdrop` + 根层 `pointerEvents: none`：浮层打开时输入框与工具条仍可正常交互；
 * - 禁用焦点接管：光标必须留在 textarea 里，键盘导航由 Composer 的 onKeyDown 处理；
 * - 列表区独立滚动：技能数量多时限制面板高度，↑↓ 导航会把高亮项滚进视野。
 *
 * 注意：`hideBackdrop` 会让 MUI 失去「点击外部关闭」的能力（该能力依赖 backdrop 捕获点击），
 * 因此 Composer 侧补了文档级 mousedown 监听，靠根节点的 `data-composer-picker` 判断点击是否落在浮层内。
 */

export interface ComposerPickerShellProps<T> {
  open: boolean;
  /** 锚点元素（输入框卡片） */
  anchorEl: HTMLElement | null;
  /** 浮层标题（如「技能与指令」） */
  title: string;
  items: T[];
  /** 当前高亮项下标（由 Composer 持有，便于键盘导航） */
  activeIndex: number;
  /** 单项渲染器；active 决定高亮底色 */
  renderItem: (item: T, active: boolean) => React.ReactNode;
  onSelect: (item: T) => void;
  onHover: (index: number) => void;
  onClose: () => void;
  /** 无匹配项时的提示文案 */
  emptyText?: string;
}

/** 浮层面板样式（与 ComposerMenu 的子菜单保持视觉一致） */
export const PICKER_PAPER_SX = {
  minWidth: 300,
  maxWidth: 380,
  // 面板整体限高（视口越矮、限高越紧），内部列表区再独立滚动
  maxHeight: 'min(60vh, 420px)',
  display: 'flex',
  flexDirection: 'column',
  bgcolor: 'background.paper',
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 2,
  boxShadow: (theme: Theme) => theme.shadows[8],
  overflow: 'hidden',
  pointerEvents: 'auto' as const,
};

export function ComposerPickerShell<T>({
  open,
  anchorEl,
  title,
  items,
  activeIndex,
  renderItem,
  onSelect,
  onHover,
  onClose,
  emptyText = '没有匹配项',
}: ComposerPickerShellProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘导航时把高亮项滚进可视区，否则长列表下高亮会跑到滚动区之外看不见
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-picker-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      hideBackdrop
      disableAutoFocus
      disableEnforceFocus
      disableRestoreFocus
      disableScrollLock
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{
        root: { sx: { pointerEvents: 'none' } },
        paper: { sx: PICKER_PAPER_SX },
      }}
    >
      {/* 根节点带 data 标记：Composer 的文档级点击监听据此判断「点击是否落在浮层内」 */}
      <Box
        data-composer-picker=""
        // 浮层内任意点击（标题、列表空白、滚动条）都不让 textarea 失焦，
        // 否则 onBlur 会把浮层关掉 —— 拖滚动条时尤其容易误触
        onMouseDown={(e) => e.preventDefault()}
        sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        <Typography
          sx={{
            flexShrink: 0,
            px: 1.5,
            py: 0.75,
            fontSize: 11,
            color: 'text.secondary',
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: (theme) =>
              theme.palette.mode === 'dark'
                ? 'rgba(255,255,255,0.03)'
                : 'rgba(0,0,0,0.02)',
          }}
        >
          {title}
        </Typography>
        {items.length === 0 ? (
          <Typography
            sx={{ px: 1.5, py: 1.5, fontSize: 13, color: 'text.secondary' }}
          >
            {emptyText}
          </Typography>
        ) : (
          <Box
            ref={listRef}
            sx={{
              flex: 1,
              // flex 子项可收缩，否则内容会把面板顶高、滚动失效
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              // 细滚动条，避免默认粗条挤占本就不宽的内容区
              '&::-webkit-scrollbar': { width: 8 },
              '&::-webkit-scrollbar-track': { bgcolor: 'transparent' },
              '&::-webkit-scrollbar-thumb': {
                bgcolor: 'action.disabled',
                borderRadius: 4,
              },
            }}
          >
            {items.map((item, index) => (
              <Box
                key={index}
                data-picker-index={index}
                onMouseEnter={() => onHover(index)}
                // 用 mousedown 而非 click：抢在 textarea 失焦前完成选中，避免光标跳走
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(item);
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  px: 1.5,
                  py: 0.75,
                  cursor: 'pointer',
                  bgcolor:
                    index === activeIndex ? 'action.selected' : 'transparent',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                {renderItem(item, index === activeIndex)}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Popover>
  );
}
