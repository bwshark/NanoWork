import { useEffect, useRef } from 'react';
import { Box, IconButton, InputBase, Tooltip, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CloseIcon from '@mui/icons-material/Close';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useSessionUiStore } from '@/stores/sessionUiStore';

/** 搜索条宽度：与头部标题共存，窄窗口下也不会把标题挤没 */
const BAR_WIDTH = 300;

/**
 * 对话内搜索条（内联在会话头部标题右侧）。
 *
 * 与 VSCode / 浏览器「页内查找」同构：
 * - 输入框只改 `searchQuery`，真正的命中统计与着色由 MessageStream 遍历渲染后的
 *   DOM 完成（消息正文是 Markdown 渲染结果，无法在源码层做替换）；
 * - 命中总数经 `searchMatchCount` 回填到这里，用于展示 `n/m`；
 * - 上下箭头 / Enter(Shift+Enter) 切换当前命中，每切换一次就滚动定位到该处。
 */
export function ChatSearchBar() {
  const activeId = useSessionsStore((s) => s.activeId);

  const searchSessionId = useSessionUiStore((s) => s.searchSessionId);
  const query = useSessionUiStore((s) => s.searchQuery);
  const count = useSessionUiStore((s) => s.searchMatchCount);
  const active = useSessionUiStore((s) => s.searchActiveMatch);
  const setSearchQuery = useSessionUiStore((s) => s.setSearchQuery);
  const stepSearchMatch = useSessionUiStore((s) => s.stepSearchMatch);
  const closeSearch = useSessionUiStore((s) => s.closeSearch);

  const inputRef = useRef<HTMLInputElement>(null);

  /** 搜索条仅在「目标会话 == 当前激活会话」时展开 */
  const open = searchSessionId !== null && searchSessionId === activeId;

  // 展开即聚焦并全选，便于直接覆盖上一次的关键词
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  if (!open) return null;

  const hasQuery = query.trim().length > 0;
  /** 有命中时展示「当前序号/总数」，无命中展示 0/0，与参考图一致 */
  const counter = hasQuery ? `${count === 0 ? 0 : active + 1}/${count}` : '';

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        height: 32,
        width: BAR_WIDTH,
        flexShrink: 0,
        pl: 1,
        pr: 0.5,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.045)'
            : 'rgba(15,23,42,0.035)',
      }}
    >
      <SearchIcon
        sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }}
      />
      <InputBase
        inputRef={inputRef}
        value={query}
        placeholder="搜索对话内容"
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeSearch();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            stepSearchMatch(e.shiftKey ? -1 : 1);
          }
        }}
        sx={{ flex: 1, minWidth: 0, fontSize: 13, ml: 0.75 }}
        inputProps={{ 'aria-label': '搜索对话内容' }}
      />
      {counter && (
        <Typography
          sx={{
            fontSize: 11.5,
            color: 'text.secondary',
            flexShrink: 0,
            px: 0.25,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {counter}
        </Typography>
      )}
      <Tooltip title="上一个" placement="bottom">
        <span>
          <IconButton
            size="small"
            sx={{ p: 0.25 }}
            disabled={count === 0}
            onClick={() => stepSearchMatch(-1)}
            aria-label="上一个匹配"
          >
            <KeyboardArrowUpIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="下一个" placement="bottom">
        <span>
          <IconButton
            size="small"
            sx={{ p: 0.25 }}
            disabled={count === 0}
            onClick={() => stepSearchMatch(1)}
            aria-label="下一个匹配"
          >
            <KeyboardArrowDownIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="关闭搜索" placement="bottom">
        <IconButton
          size="small"
          sx={{ p: 0.25 }}
          onClick={closeSearch}
          aria-label="关闭搜索"
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
