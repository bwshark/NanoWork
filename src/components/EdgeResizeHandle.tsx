import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Box } from "@mui/material";

/**
 * 右侧抽屉 / 面板**左边缘**的拖宽抓手。
 *
 * ## 为什么抽成组件
 *
 * 这个产品里「右边一块可以任意宽的容器」已经不止一处（产物面板、文档阅读抽屉、
 * 新建文档抽屉）。指针捕获、宽度钳制、拖动期间禁掉文本选层这套细节，每处重写
 * 一遍必然走样 —— 最典型的是漏掉 `setPointerCapture`：拖快了指针一离开抓手就
 * 断线，手感像「拖到一半卡住」。
 *
 * ## 起点为什么读父容器的实际宽度
 *
 * 父级可能正处在「全宽」或响应式断点下，此时它渲染出来的宽度与传进来的 `width`
 * 根本不是一回事。用 `width` 当起点，第一次 `pointermove` 就会把抽屉猛地拽回
 * 默认值。jsdom 没有布局（`getBoundingClientRect().width === 0`），退回 `width`。
 *
 * ## 键盘也要能动
 *
 * 抓手是 `role="separator"`，可聚焦：方向键按 `step` 调宽度。鼠标坏掉 / 手抖
 * 拖不准的人都得有条路 —— 而且这也让「宽度变了」在测试里可断言（`aria-valuenow`）。
 */
export interface EdgeResizeHandleProps {
  /** 当前宽度（px）：拖动起点、aria 值与键盘步进的基准 */
  width: number;
  min: number;
  max: number;
  /** 每一帧的新宽度，已钳制在 [min, max] 内 */
  onResize: (width: number) => void;
  /** 拖动开始 / 结束（父级据此关掉宽度过渡，否则宽度会追不上指针） */
  onDraggingChange?: (dragging: boolean) => void;
  /** 双击复位（不传则不响应双击） */
  onReset?: () => void;
  ariaLabel: string;
  /** 方向键单次步进（px），默认 24 */
  step?: number;
}

export function EdgeResizeHandle({
  width,
  min,
  max,
  onResize,
  onDraggingChange,
  onReset,
  ariaLabel,
  step = 24,
}: EdgeResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = (value: number) => Math.max(min, Math.min(value, max));

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    // 只认主键：右键 / 中键在抓手上下压不该开始拖
    if (event.button !== 0) return;
    /**
     * 拦住默认行为：不拦的话按下抓手会把焦点抢走，右侧正在编辑的正文会
     * **丢掉插入点**（内容没丢，但光标回到开头，等于让人重新找刚才写到哪）。
     * 抓手仍可用 Tab 聚焦 —— 键盘那条路不经过这里。
     */
    event.preventDefault();
    const rect = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    dragRef.current = {
      startX: event.clientX,
      startWidth: rect > 0 ? Math.round(rect) : width,
    };
    // 指针捕获：拖出抓手范围（甚至划过 canvas / iframe）也不会丢事件
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    onDraggingChange?.(true);
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    // 抓手贴在右侧容器的左边缘：指针往左 = 变宽，所以用 startX - clientX
    onResize(clamp(Math.round(drag.startWidth + (drag.startX - event.clientX))));
  };

  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    onDraggingChange?.(false);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 左方向键把边缘往左推 = 变宽（与拖动同向，肌肉记忆一致）
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (delta === 0) return;
    event.preventDefault();
    onResize(clamp(width + delta));
  };

  /** 拖动期间禁掉文本选中与默认光标，否则会拖出一片蓝色选区 */
  useEffect(() => {
    if (!dragging) return;
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [dragging]);

  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      // 宽度挂在 separator 上：屏幕阅读器读得到当前宽度，用例也据此断言拖拽生效
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid="edge-resize-handle"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={keyDown}
      onDoubleClick={onReset}
      sx={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 8,
        zIndex: 3,
        cursor: "col-resize",
        // 触屏上别把拖动当成滚动
        touchAction: "none",
        outline: "none",
        "&:hover .edge-resize-bar, &:focus-visible .edge-resize-bar": { opacity: 1 },
        ...(dragging ? { "& .edge-resize-bar": { opacity: 1 } } : {}),
      }}
    >
      {/* 平时看不见的一条 2px 竖线，hover / 聚焦 / 拖动时点亮：既不干扰阅读，
          又让人知道这里能拖（没有这条线，抓手是一个完全隐形的交互） */}
      <Box
        className="edge-resize-bar"
        sx={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 2,
          bgcolor: "primary.main",
          opacity: 0,
          transition: "opacity .12s",
        }}
      />
    </Box>
  );
}
