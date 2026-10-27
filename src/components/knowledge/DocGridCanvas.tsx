/**
 * 表格视图（`.xlsx` 的「原文」）—— **懒加载模块**。
 *
 * ## 为什么不再把 xlsx 转成 PDF
 *
 * PDF 是**打印**抽象：分页、纸张、固定排版。它能让人「看到这张表长什么样」，
 * 但单元格点不中、列宽拖不动、sheet 标签不存在 —— 而这些正是用户打开一张
 * 电子表格最先要找的东西（截图里那种「一页一张图、左边一排缩略图」的观感，
 * 本质是在浏览器里看打印稿）。
 *
 * 所以这条线读的是服务端解析出的**工作簿模型**（`cloud/app/kb/workbook.py`），
 * 在这里画成一张真表格：可以选单元格、可以拖行列、可以切工作表、有公式栏。
 *
 * ## 三条不装作能做的事
 *
 * 1. **不重算公式**。格子里显示的是 Excel 存盘时的缓存值；没有缓存就原样显示公式
 *    （服务端已在 `warnings` 里说清）。自己算一遍公式，等于把「看得见的正确」
 *    换成「看起来像对的错误」。
 * 2. **只读**。原文件在服务端是字节，改一个格子意味着重写 xlsx 并重新入库 ——
 *    那是另一条产品线。要改内容走「正文」。
 * 3. **图表 / 图片 / 条件格式不在这里**。服务端把没渲染的东西写进 `warnings`，
 *    这里原样摆出来：少一句话，用户就会以为资料缺了一块。
 *
 * ## 为什么用 DOM 而不是 canvas
 *
 * 表格里的字是真文字：可以选中、可以 Ctrl+F、跟着系统字号与主题走。canvas 画得再像，
 * 也只是像素 —— 而这一版不需要「像 Excel」，需要的是「这张表能读、能选、能拖」。
 *
 * ## 虚拟化的边界在哪
 *
 * 只渲染可视窗口内的单元格（行列各多留一行/列）。服务端已经把单篇上限压到
 * 5 万格、2 万行，但没有虚拟化时「2 万行 × 26 列」= 52 万个 div，任何机器都会卡死。
 * 滚动时**只在跨越行/列边界时**才 setState（`visible` 的引用不变就 bail out），
 * 像素级的位移交给浏览器原生滚动 —— 否则每个 scroll 事件都重建 1000 个节点。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { toast } from '@/components/Toast';
import {
  axisIndexAt,
  borderCss,
  buildColumnAxis,
  buildRowAxis,
  columnLabel,
  cssColor,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  displayText,
  indexSheet,
  inputText,
  isNumericCell,
  rangeRef,
  renderedText,
  visibleSpan,
  type Axis,
  type KbCell,
  type KbCellBorders,
  type KbSheet,
  type KbWorkbook,
} from '@/lib/kb/workbook';

/** 行号列宽 / 列头行高（px）。与 Excel 的观感对齐：再窄就放不下三位数行号。 */
const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 26;

/**
 * 量不到容器尺寸时的兜底（jsdom 与「抽屉还没布局完」都会给 0）。
 * 900×520 是抽屉常规宽度下的可视区，用它可以先画出一屏，布局完再按真实尺寸重算。
 */
const FALLBACK_VIEWPORT = { width: 900, height: 520 };

/**
 * 表格的配色是**文档色**，刻意写死不跟主题走：一张电子表格在深色界面里也是白纸，
 * 与 PDF 预览里的那张纸是同一类东西（跟着主题变暗会让数字对比度掉到看不清）。
 */
const SURFACE = '#ffffff';
const LINE = '#e4e7ec';
const HEADER_BG = '#f6f7f9';
const HEADER_TEXT = '#5f6672';
const BODY_TEXT = '#1f2329';
const ACCENT = '#1a73e8';
const HEADER_ACTIVE_BG = '#e8f0fe';

/** 空工作簿（`sheets` 为空时兜底）：让下面那串 hook 不必层层判空。 */
const EMPTY_SHEET: KbSheet = { id: '', name: '', row: 0, column: 0, celldata: [] };

interface Selection {
  /** 选区锚点（用户按下鼠标的那一格） */
  anchorRow: number;
  anchorCol: number;
  /** 选区另一端（拖到 / Shift 点到的那一格） */
  focusRow: number;
  focusCol: number;
}

interface CellWindow {
  rows: { first: number; last: number };
  cols: { first: number; last: number };
}

/** 坐标 → 可视窗口（行列索引闭区间） */
function computeWindow(
  left: number,
  top: number,
  viewport: { width: number; height: number },
  columnAxis: Axis,
  rowAxis: Axis,
): CellWindow {
  return {
    rows: visibleSpan(rowAxis.offsets, top, viewport.height),
    cols: visibleSpan(columnAxis.offsets, left, viewport.width),
  };
}

function sameWindow(a: CellWindow, b: CellWindow): boolean {
  return (
    a.rows.first === b.rows.first &&
    a.rows.last === b.rows.last &&
    a.cols.first === b.cols.first &&
    a.cols.last === b.cols.last
  );
}

/** 选区归一化成左上/右下（拖拽可以从右下往左上拉） */
function normalize(selection: Selection) {
  return {
    r1: Math.min(selection.anchorRow, selection.focusRow),
    r2: Math.max(selection.anchorRow, selection.focusRow),
    c1: Math.min(selection.anchorCol, selection.focusCol),
    c2: Math.max(selection.anchorCol, selection.focusCol),
  };
}

export interface DocGridCanvasProps {
  workbook: KbWorkbook;
  /** 文档标题：只用在无障碍标签上（表名在工具条里） */
  title: string;
}

export function DocGridCanvas({ workbook, title }: DocGridCanvasProps) {
  const sheets = workbook.sheets;
  const [sheetIndex, setSheetIndex] = useState(() => {
    const initial = workbook.activeSheet ?? 0;
    return initial >= 0 && initial < sheets.length ? initial : 0;
  });
  const sheet: KbSheet = sheets[sheetIndex] ?? sheets[0] ?? EMPTY_SHEET;
  const index = useMemo(() => indexSheet(sheet), [sheet]);

  /** 用户拖出来的宽高（只作用于当前工作表，切表即失效） */
  const [columnOverrides, setColumnOverrides] = useState<Record<number, number>>({});
  const [rowOverrides, setRowOverrides] = useState<Record<number, number>>({});

  const columnAxis = useMemo(
    () =>
      buildColumnAxis(
        sheet?.column ?? 0,
        sheet?.defaultColWidth ?? DEFAULT_COLUMN_WIDTH,
        { ...(sheet?.config?.columnlen ?? {}), ...columnOverrides },
        sheet?.config?.colhidden ?? {},
      ),
    [sheet, columnOverrides],
  );
  const rowAxis = useMemo(
    () =>
      buildRowAxis(
        sheet?.row ?? 0,
        sheet?.defaultRowHeight ?? DEFAULT_ROW_HEIGHT,
        { ...(sheet?.config?.rowlen ?? {}), ...rowOverrides },
        sheet?.config?.rowhidden ?? {},
      ),
    [sheet, rowOverrides],
  );

  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [visible, setVisible] = useState<CellWindow>(() =>
    computeWindow(0, 0, FALLBACK_VIEWPORT, columnAxis, rowAxis),
  );
  const [selection, setSelection] = useState<Selection>({
    anchorRow: 0,
    anchorCol: 0,
    focusRow: 0,
    focusCol: 0,
  });
  /** 拖拽中给光标与手柄用（不需要像素级精度，所以走 state 无妨） */
  const [resizing, setResizing] = useState<{ kind: 'column' | 'row'; index: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const columnHeaderRef = useRef<HTMLDivElement | null>(null);
  const rowHeaderRef = useRef<HTMLDivElement | null>(null);
  const selectingRef = useRef(false);
  const resizeRef = useRef<{ kind: 'column' | 'row'; index: number; start: number; base: number } | null>(
    null,
  );

  // 换工作表 / 换文档：清掉拖拽结果与选区（列宽是上一张表的，选区也可能越界）
  useEffect(() => {
    setColumnOverrides({});
    setRowOverrides({});
    setSelection({ anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 });
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
      scrollRef.current.scrollLeft = 0;
    }
    // ⚠️ 依赖里要有 `workbook`：换一篇文档时工作表 id 往往还是 `sheet-1`，
    // 只盯 id 的话滚动位置与选区会从上一篇带过来（清不干净）
  }, [workbook, sheet?.id]);

  // 量容器尺寸（ResizeObserver 在 jsdom 里不存在 → 用兜底尺寸，不报错）
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth || FALLBACK_VIEWPORT.width;
      const height = element.clientHeight || FALLBACK_VIEWPORT.height;
      setViewport((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 表头/行号跟着滚动走：直接改 transform（不走 state，避免每个 scroll 都重渲染）
  const syncOffsets = useCallback((left: number, top: number) => {
    if (columnHeaderRef.current) {
      columnHeaderRef.current.style.transform = `translateX(${-left}px)`;
    }
    if (rowHeaderRef.current) {
      rowHeaderRef.current.style.transform = `translateY(${-top}px)`;
    }
  }, []);

  // 轴/视口变了要重算可视窗口（拖列宽、缩放窗口、切表都走这里）
  useEffect(() => {
    const element = scrollRef.current;
    const left = element?.scrollLeft ?? 0;
    const top = element?.scrollTop ?? 0;
    syncOffsets(left, top);
    setVisible(computeWindow(left, top, viewport, columnAxis, rowAxis));
  }, [viewport, columnAxis, rowAxis, syncOffsets]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    syncOffsets(element.scrollLeft, element.scrollTop);
    const next = computeWindow(element.scrollLeft, element.scrollTop, viewport, columnAxis, rowAxis);
    // 返回同一个引用时 React 会 bail out —— 这是「滚动不卡」的关键
    setVisible((previous) => (sameWindow(previous, next) ? previous : next));
  }, [viewport, columnAxis, rowAxis, syncOffsets]);

  /** 屏幕坐标 → 行列号（拖选与拖拽调整宽高共用） */
  const hitTest = useCallback(
    (clientX: number, clientY: number) => {
      const content = contentRef.current;
      if (!content) return null;
      const rect = content.getBoundingClientRect();
      return {
        row: axisIndexAt(rowAxis.offsets, clientY - rect.top),
        column: axisIndexAt(columnAxis.offsets, clientX - rect.left),
      };
    },
    [rowAxis, columnAxis],
  );

  const ensureVisible = useCallback(
    (row: number, column: number) => {
      const element = scrollRef.current;
      if (!element) return;
      const top = rowAxis.offsets[row];
      const bottom = top + rowAxis.sizes[row];
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) {
        element.scrollTop = bottom - element.clientHeight;
      }
      const left = columnAxis.offsets[column];
      const right = left + columnAxis.sizes[column];
      if (left < element.scrollLeft) element.scrollLeft = left;
      else if (right > element.scrollLeft + element.clientWidth) {
        element.scrollLeft = right - element.clientWidth;
      }
    },
    [rowAxis, columnAxis],
  );

  // 全局鼠标监听：拖选单元格、拖拽行列边界。挂一次，靠 ref 判是不是在拖。
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (selectingRef.current) {
        const hit = hitTest(event.clientX, event.clientY);
        if (hit) {
          setSelection((previous) =>
            previous.focusRow === hit.row && previous.focusCol === hit.column
              ? previous
              : { ...previous, focusRow: hit.row, focusCol: hit.column },
          );
        }
        return;
      }
      const resize = resizeRef.current;
      if (!resize) return;
      const delta =
        resize.kind === 'column' ? event.clientX - resize.start : event.clientY - resize.start;
      const size = Math.max(0, Math.round(resize.base + delta));
      if (resize.kind === 'column') setColumnOverrides((p) => ({ ...p, [resize.index]: size }));
      else setRowOverrides((p) => ({ ...p, [resize.index]: size }));
    };
    const onUp = () => {
      selectingRef.current = false;
      if (resizeRef.current !== null) {
        resizeRef.current = null;
        setResizing(null);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [hitTest]);

  const bounds = normalize(selection);
  const anchorCell = index.cells.get(`${selection.anchorRow}:${selection.anchorCol}`);
  const showGridLines = sheet?.showGridLines !== false && sheet?.showGridLines !== 0;

  const copySelection = useCallback(async () => {
    const lines: string[] = [];
    for (let row = bounds.r1; row <= bounds.r2; row += 1) {
      const cells: string[] = [];
      for (let column = bounds.c1; column <= bounds.c2; column += 1) {
        cells.push(displayText(index.cells.get(`${row}:${column}`)));
      }
      lines.push(cells.join('\t'));
    }
    const text = lines.join('\n');
    if (text.replace(/[\t\n]/g, '') === '') {
      toast.error('选中的区域里没有内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${(bounds.r2 - bounds.r1 + 1) * (bounds.c2 - bounds.c1 + 1)} 个单元格`);
    } catch {
      // 剪贴板被拒（或非安全上下文）：如实说，不要假装复制成功
      toast.error('复制失败：浏览器没有授予剪贴板权限');
    }
  }, [bounds, index]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copySelection();
      return;
    }
    const maxRow = Math.max(0, sheet.row - 1);
    const maxColumn = Math.max(0, sheet.column - 1);
    // 翻页按「当前可视行数」走，而不是写死一个 20 —— 抽屉全宽时一屏远不止 20 行
    const page = Math.max(1, visible.rows.last - visible.rows.first);
    let row = selection.focusRow;
    let column = selection.focusCol;
    switch (event.key) {
      case 'ArrowUp':
        row = Math.max(0, row - 1);
        break;
      case 'ArrowDown':
        row = Math.min(maxRow, row + 1);
        break;
      case 'ArrowLeft':
        column = Math.max(0, column - 1);
        break;
      case 'ArrowRight':
        column = Math.min(maxColumn, column + 1);
        break;
      case 'Home':
        column = 0;
        break;
      case 'End':
        column = maxColumn;
        break;
      case 'PageDown':
        row = Math.min(maxRow, row + page);
        break;
      case 'PageUp':
        row = Math.max(0, row - page);
        break;
      default:
        return;
    }
    event.preventDefault();
    setSelection({ anchorRow: row, anchorCol: column, focusRow: row, focusCol: column });
    ensureVisible(row, column);
  };

  if (sheets.length === 0) {
    return (
      <Typography sx={{ py: 4, fontSize: 12.5, color: 'text.secondary' }}>
        这份工作簿里没有可显示的工作表。
      </Typography>
    );
  }

  const bodyStartTop = rowAxis.offsets[bounds.r1];
  const bodyStartLeft = columnAxis.offsets[bounds.c1];

  return (
    <Stack
      // ⚠️ 用 `height: 100%` 而不是 `flex: 1`：`flex: 1` 只在父级是 flex 容器时才有高度，
      // 父级一旦是普通块（或 flex-basis 0 的列）整块会塌成 0 —— 症状是「只剩工具条与列头，
      // 单元格区和行号全不见了」（本机渲染台实测）。百分比高度在两种父级下都不会塌。
      sx={{ height: "100%", minHeight: 0 }}
      data-testid="kb-grid"
      aria-label={`${title} 表格视图`}
    >
      {/* 工具条：表名 + 规模 + 只读说明 + 未渲染项 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ px: 1.5, height: 36, flexShrink: 0, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Typography
          data-testid="kb-grid-sheet-name"
          sx={{ fontSize: 12.5, fontWeight: 600, color: 'text.primary', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {sheet.name}
        </Typography>
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
          {sheet.row} 行 × {sheet.column} 列
        </Typography>
        <Typography
          sx={{
            fontSize: 10.5,
            px: 0.75,
            py: 0.125,
            borderRadius: '4px',
            bgcolor: 'action.hover',
            color: 'text.secondary',
          }}
        >
          只读
        </Typography>
        <Box sx={{ flex: 1 }} />
        {(workbook.warnings ?? []).length > 0 && (
          <Tooltip
            title={
              <Stack spacing={0.5} sx={{ py: 0.5 }}>
                {(workbook.warnings ?? []).map((warning) => (
                  <Typography key={warning} sx={{ fontSize: 11.5 }}>
                    · {warning}
                  </Typography>
                ))}
              </Stack>
            }
          >
            <Typography
              data-testid="kb-grid-warnings"
              sx={{ fontSize: 11.5, color: 'warning.main', cursor: 'help' }}
            >
              {(workbook.warnings ?? []).length} 处内容没有渲染（悬停查看）
            </Typography>
          </Tooltip>
        )}
        {workbook.truncated === true && (
          <Typography sx={{ fontSize: 11.5, color: 'warning.main' }}>数据量超限，已截断</Typography>
        )}
      </Stack>

      {/* 公式栏：选中哪一格就显示哪一格（只读，不给人「能改」的错觉） */}
      <Stack
        direction="row"
        alignItems="center"
        sx={{ height: 30, flexShrink: 0, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Typography
          data-testid="kb-grid-ref"
          sx={{
            width: 96,
            px: 1.25,
            fontSize: 11.5,
            color: 'text.primary',
            fontVariantNumeric: 'tabular-nums',
            borderRight: '1px solid',
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          {rangeRef(bounds.r1, bounds.c1, bounds.r2, bounds.c2)}
        </Typography>
        <Typography sx={{ px: 1.25, fontSize: 11.5, color: 'text.disabled', fontStyle: 'italic' }}>
          fx
        </Typography>
        <Typography
          data-testid="kb-grid-value"
          title={inputText(anchorCell)}
          sx={{
            flex: 1,
            minWidth: 0,
            px: 0.5,
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'text.primary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {inputText(anchorCell)}
        </Typography>
      </Stack>

      {/* 网格本体：滚动容器 + 两层表头覆盖层（左上角留白） */}
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <Box
          ref={scrollRef}
          data-testid="kb-grid-scroll"
          role="grid"
          tabIndex={0}
          aria-rowcount={sheet.row}
          aria-colcount={sheet.column}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          sx={{
            position: 'absolute',
            inset: 0,
            pt: `${COLUMN_HEADER_HEIGHT}px`,
            // ⚠️ 必须带单位：`pl` 是 spacing 属性，写数字会被乘 8（46 → 368px）
            pl: `${ROW_HEADER_WIDTH}px`,
            overflow: 'auto',
            bgcolor: SURFACE,
            outline: 'none',
            cursor: resizing === null ? 'cell' : resizing.kind === 'column' ? 'col-resize' : 'row-resize',
            userSelect: 'none',
          }}
        >
          <Box
            ref={contentRef}
            sx={{ position: 'relative', width: columnAxis.total, height: rowAxis.total }}
          >
            {/* 单元格 */}
            {(() => {
              const nodes: React.ReactElement[] = [];
              for (let row = visible.rows.first; row <= visible.rows.last; row += 1) {
                const height = rowAxis.sizes[row];
                if (height === 0) continue;
                for (let column = visible.cols.first; column <= visible.cols.last; column += 1) {
                  const width = columnAxis.sizes[column];
                  if (width === 0) continue;
                  if (index.covered.has(`${row}:${column}`)) continue;
                  const cell = index.cells.get(`${row}:${column}`);
                  if (cell?.v?.mc) continue; // 合并区锚点单独画（要跨格）
                  nodes.push(
                    <CellBox
                      key={`${row}:${column}`}
                      row={row}
                      column={column}
                      left={columnAxis.offsets[column]}
                      top={rowAxis.offsets[row]}
                      width={width}
                      height={height}
                      cell={cell}
                      borders={index.borders.get(`${row}:${column}`)}
                      showGridLines={showGridLines}
                      onMouseDown={(event) => {
                        if (event.button !== 0) return;
                        // 防原生文本选区：拖选时会拖出一片蓝色高亮，看起来像选中了整段
                        event.preventDefault();
                        scrollRef.current?.focus();
                        const extra = event.shiftKey;
                        setSelection((previous) =>
                          extra
                            ? { ...previous, focusRow: row, focusCol: column }
                            : { anchorRow: row, anchorCol: column, focusRow: row, focusCol: column },
                        );
                        selectingRef.current = true;
                      }}
                    />,
                  );
                }
              }
              // 合并单元格：盖在被合并的格子上，只画锚点那份内容
              for (const merge of index.merged.values()) {
                const lastRow = merge.r + merge.rs - 1;
                const lastColumn = merge.c + merge.cs - 1;
                if (
                  lastRow < visible.rows.first ||
                  merge.r > visible.rows.last ||
                  lastColumn < visible.cols.first ||
                  merge.c > visible.cols.last
                ) {
                  continue;
                }
                const cell = index.cells.get(`${merge.r}:${merge.c}`);
                const left = columnAxis.offsets[merge.c];
                const top = rowAxis.offsets[merge.r];
                nodes.push(
                  <CellBox
                    key={`merge-${merge.r}:${merge.c}`}
                    row={merge.r}
                    column={merge.c}
                    left={left}
                    top={top}
                    width={columnAxis.offsets[Math.min(lastColumn + 1, columnAxis.offsets.length - 1)] - left}
                    height={rowAxis.offsets[Math.min(lastRow + 1, rowAxis.offsets.length - 1)] - top}
                    cell={cell}
                    borders={undefined}
                    showGridLines={showGridLines}
                    elevated
                    onMouseDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      scrollRef.current?.focus();
                      setSelection({
                        anchorRow: merge.r,
                        anchorCol: merge.c,
                        focusRow: merge.r,
                        focusCol: merge.c,
                      });
                    }}
                  />,
                );
              }
              return nodes;
            })()}

            {/* 选区框：画在单元格之上、不吃事件 */}
            <Box
              data-testid="kb-grid-selection"
              sx={{
                position: 'absolute',
                left: bodyStartLeft,
                top: bodyStartTop,
                width:
                  columnAxis.offsets[Math.min(bounds.c2 + 1, columnAxis.offsets.length - 1)] -
                  bodyStartLeft,
                height:
                  rowAxis.offsets[Math.min(bounds.r2 + 1, rowAxis.offsets.length - 1)] -
                  bodyStartTop,
                border: `2px solid ${ACCENT}`,
                backgroundColor: 'rgba(26, 115, 232, 0.06)',
                pointerEvents: 'none',
                zIndex: 5,
                boxSizing: 'border-box',
              }}
            />
          </Box>
        </Box>

        {/* 列头：跟着横向滚动平移（transform 由 onScroll 直接改） */}
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: ROW_HEADER_WIDTH,
            right: 0,
            height: COLUMN_HEADER_HEIGHT,
            overflow: 'hidden',
            bgcolor: HEADER_BG,
            borderBottom: `1px solid ${LINE}`,
            zIndex: 4,
          }}
        >
          <Box
            ref={columnHeaderRef}
            sx={{ position: 'absolute', top: 0, left: 0, height: '100%', width: columnAxis.total }}
          >
            {Array.from({ length: Math.max(0, visible.cols.last - visible.cols.first + 1) }, (_, offset) => {
              const column = visible.cols.first + offset;
              if (column >= sheet.column || columnAxis.sizes[column] === 0) return null;
              const active = column >= bounds.c1 && column <= bounds.c2;
              return (
                <Box
                  key={column}
                  data-testid={`kb-grid-col-${column}`}
                  role="columnheader"
                  sx={{
                    position: 'absolute',
                    left: columnAxis.offsets[column],
                    top: 0,
                    width: columnAxis.sizes[column],
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRight: `1px solid ${LINE}`,
                    bgcolor: active ? HEADER_ACTIVE_BG : HEADER_BG,
                    color: active ? ACCENT : HEADER_TEXT,
                    fontSize: 11.5,
                    fontWeight: active ? 600 : 400,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {columnLabel(column)}
                  <Box
                    data-testid={`kb-grid-col-resize-${column}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      resizeRef.current = {
                        kind: 'column',
                        index: column,
                        start: event.clientX,
                        base: columnAxis.sizes[column],
                      };
                      setResizing({ kind: 'column', index: column });
                    }}
                    sx={{
                      position: 'absolute',
                      right: -3,
                      top: 0,
                      width: 6,
                      height: '100%',
                      cursor: 'col-resize',
                      zIndex: 2,
                      '&:hover': { bgcolor: ACCENT },
                    }}
                  />
                </Box>
              );
            })}
          </Box>
        </Box>

        {/* 行号列：跟着纵向滚动平移 */}
        <Box
          sx={{
            position: 'absolute',
            top: COLUMN_HEADER_HEIGHT,
            left: 0,
            bottom: 0,
            width: ROW_HEADER_WIDTH,
            overflow: 'hidden',
            bgcolor: HEADER_BG,
            borderRight: `1px solid ${LINE}`,
            zIndex: 4,
          }}
        >
          <Box
            ref={rowHeaderRef}
            sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: rowAxis.total }}
          >
            {Array.from({ length: Math.max(0, visible.rows.last - visible.rows.first + 1) }, (_, offset) => {
              const row = visible.rows.first + offset;
              if (row >= sheet.row || rowAxis.sizes[row] === 0) return null;
              const active = row >= bounds.r1 && row <= bounds.r2;
              return (
                <Box
                  key={row}
                  data-testid={`kb-grid-row-${row}`}
                  role="rowheader"
                  sx={{
                    position: 'absolute',
                    top: rowAxis.offsets[row],
                    left: 0,
                    width: '100%',
                    height: rowAxis.sizes[row],
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderBottom: `1px solid ${LINE}`,
                    bgcolor: active ? HEADER_ACTIVE_BG : HEADER_BG,
                    color: active ? ACCENT : HEADER_TEXT,
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {row + 1}
                  <Box
                    data-testid={`kb-grid-row-resize-${row}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      resizeRef.current = {
                        kind: 'row',
                        index: row,
                        start: event.clientY,
                        base: rowAxis.sizes[row],
                      };
                      setResizing({ kind: 'row', index: row });
                    }}
                    sx={{
                      position: 'absolute',
                      bottom: -3,
                      left: 0,
                      height: 6,
                      width: '100%',
                      cursor: 'row-resize',
                      zIndex: 2,
                      '&:hover': { bgcolor: ACCENT },
                    }}
                  />
                </Box>
              );
            })}
          </Box>
        </Box>

        {/* 左上角：既不动也不滚 */}
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: ROW_HEADER_WIDTH,
            height: COLUMN_HEADER_HEIGHT,
            bgcolor: HEADER_BG,
            borderRight: `1px solid ${LINE}`,
            borderBottom: `1px solid ${LINE}`,
            zIndex: 5,
          }}
        />
      </Box>

      {/* 工作表标签：多张表时才有意义，但一张表也留着 —— 用户要能看出「只有一张」 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.25}
        sx={{
          height: 34,
          flexShrink: 0,
          px: 1,
          borderTop: '1px solid',
          borderColor: 'divider',
          overflowX: 'auto',
        }}
      >
        {sheets.map((item, position) => {
          const active = position === sheetIndex;
          return (
            <Box
              key={item.id}
              component="button"
              type="button"
              data-testid={`kb-grid-sheet-${position}`}
              onClick={() => setSheetIndex(position)}
              sx={{
                border: 'none',
                cursor: 'pointer',
                px: 1.25,
                py: 0.5,
                borderRadius: '4px',
                bgcolor: active ? 'action.selected' : 'transparent',
                color: active ? 'text.primary' : 'text.secondary',
                fontSize: 11.5,
                fontWeight: active ? 600 : 400,
                whiteSpace: 'nowrap',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              {item.name}
            </Box>
          );
        })}
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 10.5, color: 'text.disabled', pr: 0.5, whiteSpace: 'nowrap' }}>
          拖动列头/行号边界可调整宽高 · ⌘/Ctrl+C 复制选区
        </Typography>
      </Stack>
    </Stack>
  );
}

interface CellBoxProps {
  row: number;
  column: number;
  left: number;
  top: number;
  width: number;
  height: number;
  cell: KbCell | undefined;
  borders: KbCellBorders | undefined;
  showGridLines: boolean;
  elevated?: boolean;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}

/**
 * 一个单元格。
 *
 * 为什么用内联 `style` 而不是 `sx`：一屏有上千个格子，`sx` 每个都要过一遍
 * emotion（序列化 + 生成 class），滚动时会明显掉帧；几何与颜色也必须是**原始像素**。
 */
function CellBox({
  row,
  column,
  left,
  top,
  width,
  height,
  cell,
  borders,
  showGridLines,
  elevated = false,
  onMouseDown,
}: CellBoxProps) {
  const value = cell?.v;
  const wrap = value?.tb === '2';
  const numeric = value?.ht === undefined && isNumericCell(cell);
  const align =
    value?.ht === 0 ? 'center' : value?.ht === 2 || numeric ? 'flex-end' : 'flex-start';
  const valign = value?.vt === 1 ? 'flex-start' : value?.vt === 2 ? 'flex-end' : 'center';

  const leftBorder = borderCss(borders?.l);
  const rightBorder = borderCss(borders?.r);
  const topBorder = borderCss(borders?.t);
  const bottomBorder = borderCss(borders?.b);

  const text = renderedText(cell);
  const decorations: string[] = [];
  if (value?.un) decorations.push('underline');
  if (value?.cl) decorations.push('line-through');
  // ⚠️ 走 `cssColor`：服务端给的已经是 `#RRGGBB`，再拼一个 `#` 会变成非法 CSS，
  // 字色静默回退成继承色（暗色主题下就是浅灰）——「像蒙了一层」就是这么来的
  const background = cssColor(value?.bg);
  const foreground = cssColor(value?.fc);

  const style: React.CSSProperties = {
    position: 'absolute',
    left,
    top,
    width,
    height,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: valign,
    justifyContent: align,
    // 左右留 4px（Excel 的默认内缩约 3px）：73px 的默认列宽下，能多显示半个字
    padding: '0 4px',
    overflow: 'hidden',
    backgroundColor: background ?? (elevated ? SURFACE : 'transparent'),
    color: foreground ?? BODY_TEXT,
    fontSize: value?.fs && value.fs > 0 ? `${Math.min(28, Math.max(9, value.fs))}px` : '13px',
    fontWeight: value?.bl ? 600 : 400,
    fontStyle: value?.it ? 'italic' : 'normal',
    textDecoration: decorations.length > 0 ? decorations.join(' ') : undefined,
    // 有显式边框就不再画网格线：两份叠在一起会变成「一格两条线」
    borderRight: rightBorder
      ? `${rightBorder.width}px ${rightBorder.style} ${rightBorder.color}`
      : showGridLines
        ? `1px solid ${LINE}`
        : undefined,
    borderBottom: bottomBorder
      ? `${bottomBorder.width}px ${bottomBorder.style} ${bottomBorder.color}`
      : showGridLines
        ? `1px solid ${LINE}`
        : undefined,
    borderLeft: leftBorder
      ? `${leftBorder.width}px ${leftBorder.style} ${leftBorder.color}`
      : undefined,
    borderTop: topBorder ? `${topBorder.width}px ${topBorder.style} ${topBorder.color}` : undefined,
    zIndex: elevated ? 3 : 1,
    cursor: 'cell',
  };

  return (
    <div
      style={style}
      role="gridcell"
      aria-rowindex={row + 1}
      aria-colindex={column + 1}
      data-testid={`kb-grid-cell-${row}-${column}`}
      data-row={row}
      data-col={column}
      title={text.length > 0 ? text : undefined}
      onMouseDown={onMouseDown}
    >
      <span
        style={{
          display: 'block',
          maxWidth: '100%',
          // 行高 19px（服务端按 15pt 折算）配 11pt 字 ≈ 14.7px：1.2 倍行距刚好不出格
          lineHeight: 1.2,
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          wordBreak: wrap ? 'break-word' : 'normal',
          overflow: 'hidden',
          textOverflow: wrap ? undefined : 'ellipsis',
          maxHeight: wrap ? '100%' : undefined,
        }}
      >
        {text}
      </span>
    </div>
  );
}
