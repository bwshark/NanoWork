import { useEffect, useRef, useState } from 'react';
import { Box, CircularProgress, Collapse } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { MarkdownView } from '@/components/MarkdownView';

/**
 * 一段深度思考：标记行「深度思考」+ 可展开的正文。
 *
 * 版式对齐参考形态：思考是**过程时间线里的一个标记行**，与工具执行行按到达顺序交错，
 * 而不是聚成独立的一块区域。所以这里自带的行距与工具行一致（`py: 0.4`），
 * 左边界也对齐——这样交错渲染出来才是一条连续的流。
 *
 * 正文的生命周期跟着「这段思考是否仍在写」，而不是用户点没点过：
 * - **写入中**：默认展开，逐字追加（流式中走纯文本——每来一个 chunk 都重排 Markdown 太贵），
 *   限高 200px 内部滚动，并在用户没上翻时自动贴底；
 * - **写入结束**：整段正文**从 DOM 卸载**，只留「深度思考」标记行。
 *   参考形态里那一排排孤零零的「深度思考」就是卸载后的样子：它标记了「这里想过一轮」，
 *   但不把已经读过的长文继续挂在消息里。
 *
 * 卸载后用户仍可点标记行把历史思考重新展开（此时才走 Markdown 渲染）。
 */

/**
 * 思考正文最大高度：超出即**内部滚动**，而不是让整条消息无节制变长。
 * 思考动辄几十行，不设上限的话会把真正的回答顶出屏幕。
 */
const BODY_MAX_HEIGHT = 200;

/**
 * 判定「仍然贴底」的容差：小于此距离视为用户仍跟随最新思考。
 * 一旦用户往上翻过这段距离就停手，不抢滚动权。
 */
const STICK_TOLERANCE = 24;

/**
 * 思考正文的排版覆盖：`.md-body` 默认 14px，在过程区里偏大。
 * 写成 `&.md-body` 是为了拿到**两个类**的选择器权重——
 * 单靠 `sx={{ fontSize }}` 与 `.md-body` 同权重，谁生效取决于样式注入顺序。
 */
export const REASONING_MD_SX = {
  color: 'text.secondary',
  '&.md-body': { fontSize: 12.5, lineHeight: 1.7 },
  '&.md-body p': { margin: '2px 0' },
  '&.md-body ul, &.md-body ol': { paddingLeft: 20, margin: '2px 0' },
  '&.md-body h1, &.md-body h2, &.md-body h3, &.md-body h4': {
    fontSize: 13,
    margin: '6px 0 4px',
  },
  '&.md-body pre': { margin: '4px 0' },
  '&.md-body code': { fontSize: 12 },
};

/**
 * `live` 只标记「此刻正在写的那一段」：它转圈提示进度、自动贴底，
 * 并且是唯一默认展开（因而正文留在 DOM 里）的一段。
 */
export function ReasoningBlock({
  content,
  live = false,
}: {
  content: string;
  /** 该段是否仍在流式写入（仅最后一段未闭合时为 true） */
  live?: boolean;
}) {
  /** 用户手动开关：null = 尚未表态，跟随 `live` 自动决策；点过之后以其选择为准 */
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? live;
  const bodyRef = useRef<HTMLDivElement>(null);

  // 流式中自动跟到最新思考：与过程体同样的「贴底才跟随」策略
  useEffect(() => {
    if (!live || !open) return;
    const el = bodyRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > STICK_TOLERANCE) return;
    el.scrollTop = el.scrollHeight;
  }, [live, content, open]);

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={open ? '收起深度思考' : '展开深度思考'}
        onClick={() => setManualOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setManualOpen(!open);
          }
        }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.4,
          py: 0.4,
          fontSize: 13,
          color: 'text.secondary',
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { color: 'text.primary' },
          // 折叠态不画箭头（参考形态就是一条素文字），悬停时才浮出来提示「可展开」
          '&:hover .reasoning-chevron': { opacity: 1 },
        }}
      >
        <span>深度思考</span>
        {live && <CircularProgress size={9} sx={{ color: 'text.secondary' }} />}
        <ChevronRightIcon
          className="reasoning-chevron"
          sx={{
            fontSize: 14,
            opacity: open ? 1 : 0,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .15s, opacity .15s',
          }}
        />
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box
          ref={bodyRef}
          sx={{
            mt: 0.5,
            mb: 0.25,
            ml: 0.25,
            pl: 1.25,
            pr: 1,
            py: 0.75,
            borderLeft: '2px solid',
            borderColor: 'divider',
            bgcolor: 'action.hover',
            borderRadius: '0 8px 8px 0',
            maxHeight: BODY_MAX_HEIGHT,
            overflowY: 'auto',
            // 滚动条出现/消失不引起正文横向跳动，思考长度变化时才不「抖」
            scrollbarGutter: 'stable',
            // 思考滚到底后不再把外层消息流一起卷走
            overscrollBehavior: 'contain',
            // 滚动条收窄一档，避免在思考区里过于抢眼（与过程区一致）
            '&::-webkit-scrollbar': { width: 6 },
          }}
        >
          {live ? (
            <Box
              sx={{
                fontSize: 12.5,
                lineHeight: 1.7,
                color: 'text.secondary',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {content}
            </Box>
          ) : (
            <MarkdownView content={content} sx={REASONING_MD_SX} />
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
