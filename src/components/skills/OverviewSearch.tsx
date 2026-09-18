import { useEffect, useRef, useState, type RefObject } from 'react';
import { Box, IconButton, InputBase, Tooltip, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CloseIcon from '@mui/icons-material/Close';
import {
  clearSearchHighlights,
  collectSearchRanges,
  paintSearchRanges,
  scrollRangeIntoView,
} from '@/lib/textHighlight';
import { skillCardIconButtonSx, skillOverviewSearchSx } from './skillCardSx';

/**
 * 技能概述内的搜索（参考样式里「概述」标题右侧那枚放大镜）。
 *
 * ## 为什么能不改 DOM 就着色
 *
 * 概述正文是 Markdown 渲染结果，在源码字符串层替换会破坏代码块与链接；
 * 所以复用对话内搜索那套 CSS Custom Highlight API（`@/lib/textHighlight`）：
 * 只登记 `Range` 交浏览器着色，React 的渲染结果一个字节都不动，不存在
 * 「我把节点换了、React 下次 diff 找不到它」的冲突。
 *
 * ## 为什么命中要重算
 *
 * `Range` 指向的是**已渲染的 DOM 节点**。换一个技能（`resetKey` 变）之后
 * 容器整棵子树都是新的，旧 Range 指向的节点已经脱离文档，留着只会让高亮错位。
 * 因此以 `resetKey` + 关键字为依赖重算，面板收起时把它清掉。
 *
 * 拿不到 Highlight API 时（老浏览器 / jsdom）匹配**照常统计**，只是不高亮：
 * 计数来自 `collectSearchRanges`，与 API 是否存在无关 —— 有数没色，
 * 好过按钮点下去什么都不发生。
 */
export function OverviewSearch({
  containerRef,
  resetKey,
}: {
  /** 概述正文的滚动容器；命中从它内部遍历 */
  containerRef: RefObject<HTMLElement | null>;
  /** 内容身份（技能 id）：变化即重算命中 */
  resetKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const rangesRef = useRef<Range[]>([]);

  useEffect(() => {
    if (!open) {
      clearSearchHighlights();
      rangesRef.current = [];
      setCount(0);
      setIndex(0);
      return;
    }
    const root = containerRef.current;
    if (!root) return;
    const ranges = collectSearchRanges(root, query);
    rangesRef.current = ranges;
    setCount(ranges.length);
    setIndex(0);
    paintSearchRanges(ranges, 0);
  }, [open, query, resetKey, containerRef]);

  // 卸载即清高亮：窗口一关，概述容器就没了，留着高亮会挂到下一个技能的正文上
  useEffect(() => () => clearSearchHighlights(), []);

  const step = (delta: number) => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const next = (index + delta + ranges.length) % ranges.length;
    setIndex(next);
    paintSearchRanges(ranges, next);
    scrollRangeIntoView(ranges[next], containerRef.current);
  };

  if (!open) {
    return (
      <Tooltip title="搜索概述">
        <IconButton
          size="small"
          aria-label="搜索概述"
          onClick={() => setOpen(true)}
          sx={skillCardIconButtonSx}
        >
          <SearchIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Tooltip>
    );
  }

  const hasQuery = query.trim().length > 0;

  return (
    <Box sx={skillOverviewSearchSx}>
      <SearchIcon sx={{ fontSize: 15, color: 'text.secondary', flexShrink: 0 }} />
      <InputBase
        autoFocus
        value={query}
        placeholder="搜索概述"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
        sx={{ flex: 1, minWidth: 0, fontSize: 12.5, ml: 0.5 }}
        inputProps={{ 'aria-label': '搜索概述内容' }}
      />
      {hasQuery && (
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
          {count === 0 ? '0/0' : `${index + 1}/${count}`}
        </Typography>
      )}
      <IconButton
        size="small"
        sx={{ p: 0.25 }}
        disabled={count === 0}
        onClick={() => step(-1)}
        aria-label="上一个匹配"
      >
        <KeyboardArrowUpIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <IconButton
        size="small"
        sx={{ p: 0.25 }}
        disabled={count === 0}
        onClick={() => step(1)}
        aria-label="下一个匹配"
      >
        <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <IconButton
        size="small"
        sx={{ p: 0.25 }}
        onClick={() => setOpen(false)}
        aria-label="关闭概述搜索"
      >
        <CloseIcon sx={{ fontSize: 15 }} />
      </IconButton>
    </Box>
  );
}
