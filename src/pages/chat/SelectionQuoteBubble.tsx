import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, ButtonBase, Divider } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import { toast } from '@/components/Toast';
import { getComposerEdit } from '@/lib/editor/composerEditBridge';
import { writeRichClipboard } from '@/lib/editor/richClipboard';
import { useSessionUiStore } from '@/stores/sessionUiStore';
import { clampQuoteText, normalizeQuoteText } from '@/lib/editor/selectionQuote';

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

/** 气泡预估尺寸：只用于把位置夹取到视口内 / 判断放不放得下，真实尺寸由内容决定 */
export const BUBBLE_W = 176;
export const BUBBLE_H = 34;
/** 气泡与选区之间的间距 */
const GAP = 8;

/**
 * 气泡相对选区的落位。
 *
 * `above` 是常态；选区贴着视口顶、上方实在放不下时才翻到 `below`。
 */
type Placement = 'above' | 'below';

/** 一次待处理的选区（`mouseup` 时定格，之后不再重读窗口选区） */
interface PendingSelection {
  /** 选中原文（首尾已去空白、超长已截断） */
  text: string;
  /** 选区所在消息 id */
  messageId: string;
  /** 气泡中心点 X（fixed 坐标） */
  left: number;
  /** 气泡顶部的 fixed 坐标（配合 `placement` 的 translate 决定最终落位） */
  top: number;
  placement: Placement;
}

/**
 * 量出**整个选区**的外框（不是某一行）。
 *
 * ## 为什么必须用整体框
 *
 * 曾按「最后一行」定位（`getClientRects()` 取末个），单行选区看着没问题，
 * 多行就露馅了：最后一行的**上方**正好是倒数第二行所在的位置，而气泡高 34px ——
 * 于是气泡必然压在倒数第二行的文字上，真机截图里就是这个效果（选了 3 行、
 * 气泡盖住第 2 行）。
 *
 * 改成整体外框后，气泡落在**选区外侧**（第一行上方），任何行数都不遮挡；
 * 水平方向也改用整体中心，而不是最后一行的行尾（后者会让气泡偏在一侧）。
 *
 * 布局接口并非处处可用（jsdom 就没有，同 `textHighlight.scrollRangeIntoView`
 * 的判断），取不到就给零矩形 —— 单测只关心状态与交互，真实位置由真机脚本量。
 */
function measureSelectionBox(range: Range): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const empty = { left: 0, right: 0, top: 0, bottom: 0 };
  if (typeof range.getBoundingClientRect !== 'function') return empty;
  const rect = range.getBoundingClientRect();
  if (!rect) return empty;
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

/** 选区外框（fixed 视口坐标） */
export type SelectionBox = ReturnType<typeof measureSelectionBox>;

/**
 * 由选区外框算气泡落位。**纯函数**，好单测（jsdom 没有布局，量不到真实几何）。
 *
 * 三条规则，每条都对应一个真机上踩过的坑：
 *
 * 1. **落在选区外侧**（默认上方）—— 落在选区内部就会遮挡选中的文字；
 * 2. **上方放不下才翻到下方**（选区贴着视口顶时），而不是硬塞到视口外；
 * 3. **水平夹取到视口内**并以**整体**中心对齐 —— 用最后一行的中心会让气泡偏在一侧。
 */
export function computeBubblePlacement(
  box: SelectionBox,
  viewportWidth: number,
  size: { width: number; height: number } = { width: BUBBLE_W, height: BUBBLE_H },
  gap = GAP,
): { left: number; top: number; placement: Placement } {
  const half = size.width / 2;
  const minLeft = half + 8;
  const maxLeft = Math.max(viewportWidth - half - 8, minLeft);
  const left = Math.min(Math.max((box.left + box.right) / 2, minLeft), maxLeft);
  const placement: Placement = box.top - gap - size.height >= 0 ? 'above' : 'below';
  const top = placement === 'above' ? box.top - gap : box.bottom + gap;
  return { left, top, placement };
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
      // 锚在整个选区的**外侧上方**，绝不能压到选中的文字（见 computeBubblePlacement）
      const viewport = typeof window !== 'undefined' ? window.innerWidth : 1024;
      const { left, top, placement } = computeBubblePlacement(
        measureSelectionBox(range),
        viewport,
      );
      return { text, messageId, left, top, placement };
    };

    const onMouseUp = (e: MouseEvent) => {
      // 只响应左键。右键那一轮要留给 `MessageTextContextMenu`：右键**不会**折叠选区，
      // 所以这里若也弹，右键菜单与气泡会同时挂在屏幕上互相遮挡。
      if (e.button !== 0) return;
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
        // `above` 时气泡顶边对齐 `top` 并整体上移（底边即选区上沿）；
        // 翻到下方时不再上移，只把顶边压在选区下沿之下。
        transform:
          pending.placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
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
