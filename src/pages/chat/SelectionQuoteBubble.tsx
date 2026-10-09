import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, ButtonBase, Divider } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import { toast } from '@/components/Toast';
import { getComposerEdit } from '@/lib/composerEditBridge';
import { writeRichClipboard } from '@/lib/richClipboard';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { clampQuoteText, normalizeQuoteText } from '@/lib/selectionQuote';

/**
 * 消息流里「选中文本」后浮出的操作气泡：**复制** / **添加到对话**。
 *
 * 三条设计约束（都是踩过才知道的）：
 *
 * 1. **文案在 `mouseup` 那一刻就存进 state**，点击时不再去读 `window.getSelection()`。
 *    点击气泡本身也会先派发 `mousedown`，浏览器默认行为会把选区折叠掉，
 *    「点了按钮却读到空选区」就是从这个缝隙漏进来的。
 * 2. **监听挂在 `document` 上，不挂滚动容器**。容器 ref 会经历
 *    `null → 元素`（「先无会话、后有会话」时整个消息流重新挂载），
 *    挂容器的 effect 依赖没变就不会重跑，监听再也装不上。挂 document 只需在
 *    回调里判一次 `root.contains`，省掉这一整类时序坑。
 * 3. **气泡经 Portal 挂到 `body`**：`position: fixed` 会被祖先元素的 `transform`
 *    变成「相对该祖先定位」，那样它会跟着滚动容器一起滚、还会被 `overflow: auto` 裁掉。
 */
export interface SelectionQuoteBubbleProps {
  /** 消息流的滚动容器：只有落在它内部的选区才响应（输入区有自己的右键菜单） */
  rootRef: { current: HTMLDivElement | null };
  /** 当前会话 id：引用要跟着会话走（切会话时上层会清理） */
  sessionId: string;
}

/** 气泡预估尺寸：只用于把位置夹取到视口内，真实尺寸由内容决定 */
const BUBBLE_W = 176;
const BUBBLE_H = 34;
/** 气泡底边与选区之间的间距 */
const GAP = 8;

/** 一次待处理的选区（`mouseup` 时定格，之后不再重读窗口选区） */
interface PendingSelection {
  /** 选中原文（首尾已去空白、超长已截断） */
  text: string;
  /** 选区所在消息 id */
  messageId: string;
  /** 气泡中心点 X（fixed 坐标） */
  left: number;
  /** 气泡底边 Y（fixed 坐标；配合 translate(-50%, -100%) 呈现在选区上方） */
  top: number;
}

/**
 * 量出选区最后一行的位置。
 *
 * - 多行选区取**最后一行**：跟着鼠标松开的位置走，和参考实现一致；
 * - 布局接口并非处处可用（jsdom 就没有，同 `textHighlight.scrollRangeIntoView` 的判断），
 *   取不到就给零矩形——单测只关心状态与交互，真实位置由真机脚本量。
 */
function measureSelectionRange(range: Range): {
  left: number;
  width: number;
  top: number;
} {
  if (typeof range.getBoundingClientRect !== 'function') {
    return { left: 0, width: 0, top: 0 };
  }
  const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
  const picked =
    rects && rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!picked) return { left: 0, width: 0, top: 0 };
  return { left: picked.left, width: picked.width, top: picked.top };
}

export function SelectionQuoteBubble({ rootRef, sessionId }: SelectionQuoteBubbleProps) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const addQuote = useSessionUiStore((s) => s.addQuote);

  useEffect(() => {
    /** 读当前窗口选区；不落在「消息正文」里就返回 null（不弹气泡） */
    const readSelection = (): PendingSelection | null => {
      const root = rootRef.current;
      if (!root) return null;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      // 只认带 `data-quote-body` 的正文容器：过程时间线 / 工具卡片 / 产物卡片不参与。
      // 从工具输出里拖一段也能弹气泡的话，用户会以为「把它加进对话」是在引用助手的结论。
      const anchor = range.commonAncestorContainer;
      const el =
        anchor.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element)
          : anchor.parentElement;
      const body = el?.closest?.('[data-quote-body]');
      if (!body || !root.contains(body)) return null;
      const host = body.closest('[data-message-id]');
      const messageId = host?.getAttribute('data-message-id') ?? '';
      if (!messageId) return null;
      const raw = sel.toString();
      if (normalizeQuoteText(raw) === '') return null;
      const text = clampQuoteText(raw);
      if (text === '') return null;
      // 锚在**选区最后一行**的上方：多行选区取整体 rect 的顶边会飘到第一行去，
      // 而参考实现的气泡跟着鼠标松开的位置走（即最后一行的行尾附近）。
      // 布局接口并非处处可用（jsdom 就没有，见 textHighlight 的同款判断）：
      // 取不到就给一个零矩形 —— 单测只关心状态与交互，真实位置由真机脚本量。
      const box = measureSelectionRange(range);
      const half = BUBBLE_W / 2;
      const viewport = typeof window !== 'undefined' ? window.innerWidth : 1024;
      const left = Math.min(
        Math.max(box.left + box.width / 2, half + 8),
        Math.max(viewport - half - 8, half + 8),
      );
      const top = Math.max(box.top - GAP, BUBBLE_H + 8);
      return { text, messageId, left, top };
    };

    const onMouseUp = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // 点在气泡自身（Portal 到 body，不在 root 内）：保持当前 pending 不动
      if (target?.closest?.('[data-selection-bubble]')) return;
      const root = rootRef.current;
      if (!root || !target || !root.contains(target)) return;
      setPending(readSelection());
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('[data-selection-bubble]')) return;
      setPending(null);
    };
    // fixed 坐标在滚动 / 缩放后立刻失效：直接收起，别把它挂在一个已经滚走的位置上
    const onScroll = () => setPending(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null);
    };

    document.addEventListener('mouseup', onMouseUp);
    // 捕获阶段：早于气泡内部的点击处理，但白名单已排除气泡自身，不会误关
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [rootRef]);

  // 换会话即收起：气泡锚在「某条消息的某段文字」上，换了内容就指错了
  useEffect(() => {
    setPending(null);
  }, [sessionId]);

  const handleCopy = useCallback(() => {
    if (!pending) return;
    const text = pending.text;
    setPending(null);
    // 复用输入区那条三段降级链路（ClipboardItem → writeText → execCommand），
    // 不必为「复制一句话」再写一套剪贴板兼容代码
    void writeRichClipboard(
      text,
      JSON.stringify({ rich: text, attachments: [] }),
      false,
    ).then((ok) => {
      if (ok) toast.success('已复制');
      else toast.error('复制失败');
    });
  }, [pending]);

  const handleAdd = useCallback(() => {
    if (!pending) return;
    addQuote({ sessionId, messageId: pending.messageId, text: pending.text });
    // 收掉原生选区：让位给引用下划线（蓝底选中 + 虚线同时挂着很脏，
    // 而且用户下一步多半是去输入框补一句话）
    window.getSelection()?.removeAllRanges();
    setPending(null);
    // 直接把人送到输入框——加引用的下一步就是接着打字
    getComposerEdit()?.focus();
  }, [pending, sessionId, addQuote]);

  if (!pending) return null;

  return createPortal(
    <Box
      data-selection-bubble=""
      // 不改变选区：真正要用的文案已经在 mouseup 时存进 state，
      // 这里 preventDefault 只是避免选区在点击瞬间视觉上闪一下
      onMouseDown={(e) => e.preventDefault()}
      sx={{
        position: 'fixed',
        left: pending.left,
        top: pending.top,
        transform: 'translate(-50%, -100%)',
        zIndex: (theme) => theme.zIndex.tooltip,
        display: 'flex',
        alignItems: 'center',
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '10px',
        boxShadow: 6,
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <BubbleAction
        icon={<ContentCopyIcon sx={{ fontSize: 15 }} />}
        label="复制"
        onClick={handleCopy}
      />
      <Divider orientation="vertical" flexItem sx={{ my: 0.75 }} />
      <BubbleAction
        icon={<AddCommentOutlinedIcon sx={{ fontSize: 15 }} />}
        label="添加到对话"
        onClick={handleAdd}
      />
    </Box>,
    document.body,
  );
}

/**
 * 气泡里的一个动作按钮：图标 + 文案。
 *
 * 刻意**不套 Tooltip**：文案就在按钮上，再挂一层悬停提示只会多出一个
 * 与按钮同名的 `aria-label` 锚点（真机脚本按 `aria-label` 定位时每颗按钮命中两个元素）。
 */
function BubbleAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-label={label}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        px: '12px',
        py: '7px',
        fontSize: 12.5,
        whiteSpace: 'nowrap',
        color: 'text.secondary',
        '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
      }}
    >
      {icon}
      {label}
    </ButtonBase>
  );
}
