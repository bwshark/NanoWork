/**
 * 工作簿模型（`.xlsx` 表格视图的客户端一半）。
 *
 * ## 为什么要自己算「行列轴」，而不是直接渲染表格
 *
 * 服务端给的是 `celldata`（**稀疏**的 `{r,c,v}` 列表），不是二维数组。Excel 里最常见
 * 的形态是「一万行的表 + 二十来列 + 大量空格」，摊成二维矩阵会得到一个 20 万格的数组，
 * 而其中九成是空的。所以这里保留稀疏形态：`Map<"r:c", cell>` + 两个前缀和数组
 * （列宽、行高），渲染时只取可视窗口内的那一块。
 *
 * 前缀和数组（`offsets`）是这套坐标系的唯一真相：单元格的 `left/top`、合并区的宽度、
 * 选区框、拖拽命中的行列号，全部从它出发 —— 只要有一处另算一套，就会出现「选区比
 * 单元格偏一格」这种最难查的错位。
 *
 * ## 为什么把「数字怎么显示」也放这里
 *
 * `m`（formatted text）是 Excel 存盘时**算好的显示文本**：`592.2`、`2022/8/1`、
 * `12.5%` 都在里面。客户端不再做一次格式化 —— 重算一遍等于把「看得见的正确」换成
 * 「看起来像对的错误」（服务端 `workbook.py` 的同一句话）。
 */

/** 服务端的合并区描述（与 FortuneSheet 的 `mc` 同形）。 */
export interface KbMerge {
  r: number;
  c: number;
  /** 跨几行 / 几列（含锚点自身） */
  rs: number;
  cs: number;
}

/**
 * 单元格的值与样式。
 *
 * 字段名沿用 FortuneSheet（服务端按那套约定产出）：`v` 原值、`m` 显示文本、
 * `f` 公式、`bg`/`fc` 底色与字色、`bl`/`it`/`un`/`cl` 加粗/斜体/下划线/删除线、
 * `fs` 字号、`ht` 水平对齐（0 居中 1 左 2 右）、`vt` 垂直对齐（0 居中 1 顶 2 底）、
 * `tb` 文本行为（`"2"` = 自动换行）。
 */
export interface KbCellValue {
  v?: string | number | boolean | null;
  m?: string | number | boolean;
  f?: string;
  bg?: string;
  fc?: string;
  bl?: number;
  it?: number;
  un?: number;
  cl?: number;
  fs?: number;
  ht?: number;
  vt?: number;
  tb?: string;
  mc?: KbMerge;
  ct?: { fa?: string; t?: string };
}

export interface KbCell {
  r: number;
  c: number;
  v: KbCellValue;
}

/** 边框：`style` 是 FortuneSheet 的编号（不是 OOXML 的，见服务端 `_BORDER_STYLES`）。 */
export interface KbBorderSide {
  style: string;
  color: string;
}

export interface KbCellBorders {
  l?: KbBorderSide;
  r?: KbBorderSide;
  t?: KbBorderSide;
  b?: KbBorderSide;
}

/** `borderInfo` 的一项：`rangeType: 'cell'` 时 `value` 带 row_index/col_index。 */
export interface KbBorderEntry {
  rangeType: string;
  value: KbCellBorders & { row_index?: number; col_index?: number };
}

export interface KbSheetConfig {
  /** 键是 `"r_c"`（锚点） */
  merge?: Record<string, KbMerge>;
  rowlen?: Record<string, number>;
  columnlen?: Record<string, number>;
  rowhidden?: Record<string, number>;
  colhidden?: Record<string, number>;
  borderInfo?: KbBorderEntry[];
}

export interface KbFrozen {
  type: 'row' | 'column' | 'both';
  range: { row_focus: number; column_focus: number };
}

export interface KbSheet {
  id: string;
  name: string;
  order?: number;
  row: number;
  column: number;
  celldata: KbCell[];
  defaultRowHeight?: number;
  defaultColWidth?: number;
  showGridLines?: boolean | number;
  zoomRatio?: number;
  config?: KbSheetConfig;
  frozen?: KbFrozen;
}

/** `GET …/preview.workbook` 的响应体。 */
export interface KbWorkbook {
  version: number;
  sheets: KbSheet[];
  /** 没渲染出来的东西（图表 / 条件格式 / 超限截断）：**必须给用户看** */
  warnings?: string[];
  truncated?: boolean;
  totalCells?: number;
  activeSheet?: number;
}

/** 默认列宽 / 行高（px）。服务端没给时用 Excel 的观感值。 */
export const DEFAULT_COLUMN_WIDTH = 73;
export const DEFAULT_ROW_HEIGHT = 19;

/** 拖出来的宽高下限：再小就点不中单元格了。 */
const MIN_COLUMN_WIDTH = 24;
const MIN_ROW_HEIGHT = 12;
/** 上限：防一个手滑把列拖到 20000px（那会让总宽度溢出成天文数字）。 */
const MAX_SIZE = 2000;

/** 0 → A，25 → Z，26 → AA（列表头的字母，与服务端 `cellRef` 同一套口径）。 */
export function columnLabel(index: number): string {
  if (!Number.isFinite(index) || index < 0) return '';
  let remaining = Math.floor(index);
  let label = '';
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

/** (0,0) → `A1`。公式栏与无障碍标签共用。 */
export function cellRef(row: number, column: number): string {
  return `${columnLabel(column)}${row + 1}`;
}

/** `A1:C3` 这种区域写法（单格就只写一格）。 */
export function rangeRef(r1: number, c1: number, r2: number, c2: number): string {
  if (r1 === r2 && c1 === c2) return cellRef(r1, c1);
  return `${cellRef(r1, c1)}:${cellRef(r2, c2)}`;
}

function clampSize(value: number, min: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_SIZE, Math.max(min, Math.round(value)));
}

export interface Axis {
  /** 每一格的尺寸（px，含隐藏列的 0） */
  sizes: number[];
  /** 前缀和，长度 `count + 1`：`offsets[i]` = 第 i 格的起点，`offsets[count]` = 总长 */
  offsets: number[];
  total: number;
}

/**
 * 行列轴：默认尺寸 + 覆盖值 + 隐藏标记 → 尺寸数组与前缀和。
 *
 * `overrides` / `hidden` 的键可能来自 JSON（字符串键），用数字下标访问是同一份数据
 * （JS 会把数字转成字符串再查），所以这里不必预先转换。
 *
 * `min` 是拖拽下限：列给 24px（再窄点不中），行给 12px。同一个函数两套下限，
 * 是因为「太窄」对它们的含义不同 —— 列窄了点不中，行窄了至少还能点。
 */
export function buildAxis(
  count: number,
  defaultSize: number,
  options: {
    overrides?: Record<string, number>;
    hidden?: Record<string, number>;
    min?: number;
    fallback?: number;
  } = {},
): Axis {
  const overrides = options.overrides ?? {};
  const hidden = options.hidden ?? {};
  const fallbackDefault = options.fallback ?? DEFAULT_ROW_HEIGHT;
  const min = options.min ?? MIN_ROW_HEIGHT;
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const fallback = clampSize(defaultSize, min, fallbackDefault);
  const sizes: number[] = new Array(safeCount);
  const offsets: number[] = new Array(safeCount + 1);
  let total = 0;
  offsets[0] = 0;
  for (let index = 0; index < safeCount; index += 1) {
    // 隐藏列宽度记 0：留 1px 会变成一条「看得见但点不中」的缝
    const size =
      hidden[index] !== undefined ? 0 : clampSize(overrides[index] ?? fallback, min, fallback);
    sizes[index] = size;
    total += size;
    offsets[index + 1] = total;
  }
  return { sizes, offsets, total };
}

/** 列轴：下限 24px、缺省列宽 73px。 */
export function buildColumnAxis(
  count: number,
  defaultSize: number,
  overrides: Record<string, number> = {},
  hidden: Record<string, number> = {},
): Axis {
  return buildAxis(count, defaultSize || DEFAULT_COLUMN_WIDTH, {
    overrides,
    hidden,
    min: MIN_COLUMN_WIDTH,
    fallback: DEFAULT_COLUMN_WIDTH,
  });
}

/** 行轴：下限 12px、缺省行高 19px。 */
export function buildRowAxis(
  count: number,
  defaultSize: number,
  overrides: Record<string, number> = {},
  hidden: Record<string, number> = {},
): Axis {
  return buildAxis(count, defaultSize || DEFAULT_ROW_HEIGHT, {
    overrides,
    hidden,
    min: MIN_ROW_HEIGHT,
    fallback: DEFAULT_ROW_HEIGHT,
  });
}

/** 坐标 → 索引：最后一个 `offsets[i] <= position` 的 i（落在右侧则取最后一格）。 */
export function axisIndexAt(offsets: number[], position: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  if (!Number.isFinite(position) || position <= 0) return 0;
  if (position >= offsets[count]) return count - 1;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** 可视窗口对应的索引闭区间（虚拟化只渲染这一块）。 */
export function visibleSpan(
  offsets: number[],
  start: number,
  length: number,
): { first: number; last: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { first: 0, last: -1 };
  const first = axisIndexAt(offsets, Math.max(0, start));
  const last = axisIndexAt(offsets, Math.max(0, start) + Math.max(0, length));
  return { first, last: Math.max(first, last) };
}

export interface SheetIndex {
  /** `"r:c"` → 单元格。空串键（有样式无内容）也在里面 */
  cells: Map<string, KbCell>;
  /** 锚点键 → 合并区 */
  merged: Map<string, KbMerge>;
  /** 被合并区盖住的格子（不含锚点）：渲染时要跳过，否则合并区里会出现重影 */
  covered: Set<string>;
  /** `"r:c"` → 边框 */
  borders: Map<string, KbCellBorders>;
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

/**
 * 把服务端的稀疏 `celldata` 收成可 O(1) 查询的三张索引。
 *
 * 为什么要 `covered`：合并区的锚点单元格带 `mc`，被盖住的格子在 Excel 里根本不显示；
 * 如果照常渲染，「A1:B2 合并」的右下角会透出一份重复的文字。
 */
export function indexSheet(sheet: KbSheet): SheetIndex {
  const cells = new Map<string, KbCell>();
  const merged = new Map<string, KbMerge>();
  const covered = new Set<string>();
  const borders = new Map<string, KbCellBorders>();

  for (const cell of sheet.celldata ?? []) {
    if (!Number.isFinite(cell.r) || !Number.isFinite(cell.c)) continue;
    cells.set(cellKey(cell.r, cell.c), cell);
    const merge = cell.v?.mc;
    if (merge && Number.isFinite(merge.rs) && Number.isFinite(merge.cs)) {
      merged.set(cellKey(merge.r, merge.c), merge);
      for (let row = merge.r; row < merge.r + merge.rs; row += 1) {
        for (let column = merge.c; column < merge.c + merge.cs; column += 1) {
          if (row === merge.r && column === merge.c) continue;
          covered.add(cellKey(row, column));
        }
      }
    }
  }

  for (const entry of sheet.config?.borderInfo ?? []) {
    const value = entry?.value;
    if (!value) continue;
    const row = value.row_index;
    const column = value.col_index;
    if (typeof row !== 'number' || typeof column !== 'number') continue;
    borders.set(cellKey(row, column), { l: value.l, r: value.r, t: value.t, b: value.b });
  }

  return { cells, merged, covered, borders };
}

/** 显示文本：优先 `m`（Excel 算好的），退回原值 —— 数字不对齐比显示不出来好。 */
export function displayText(cell: KbCell | undefined): string {
  const value = cell?.v;
  if (!value) return '';
  if (value.m !== undefined && value.m !== null) return String(value.m);
  if (value.v === undefined || value.v === null) return value.f ?? '';
  if (typeof value.v === 'boolean') return value.v ? 'TRUE' : 'FALSE';
  return String(value.v);
}

/** 公式栏里的内容：有公式显示公式（含 `=`），否则显示文本。 */
export function inputText(cell: KbCell | undefined): string {
  const formula = cell?.v?.f;
  if (typeof formula === 'string' && formula !== '') return formula;
  return displayText(cell);
}

/** 数字默认右对齐（Excel 的 General 行为）——日期 / 金额列靠这一条才立起来。 */
export function isNumericCell(cell: KbCell | undefined): boolean {
  const value = cell?.v;
  if (!value) return false;
  if (typeof value.v === 'number') return true;
  if (typeof value.v === 'string') return false;
  // 只有 `m` 没有 `v` 的情况（极少）：按是否纯数字猜，但**不**改写显示文本
  if (typeof value.m === 'string') return /^-?\d+(\.\d+)?$/.test(value.m.trim());
  return false;
}

/**
 * 颜色归一化：`#RRGGBB` / `RRGGBB` / 8 位 `AARRGGBB` → `#RRGGBB`；认不出来给 `null`。
 *
 * ⚠️ 这条不是洁癖：服务端 `_color()` 产出的**已经带 `#`**（`"#000000"`），
 * 客户端若再拼一个 `#` 就得到 `##000000` —— 非法 CSS，字色会**静默回退成继承色**。
 * 症状是「整张表像蒙了一层、字看不清」（暗色主题下的继承色是浅灰），
 * 而不是报错，所以这条必须有单一入口。
 */
export function cssColor(value: string | undefined | null): string | null {
  if (!value) return null;
  let raw = value.trim().replace(/^#/, '').toLowerCase();
  // 8 位是 Excel 的 AARRGGBB（透明度在最前）；表格视图不透明确度，丢掉 alpha
  if (/^[0-9a-fA-F]{8}$/.test(raw)) raw = raw.slice(2);
  return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw}` : null;
}

/**
 * FortuneSheet 边框编号 → CSS。
 *
 * 两套编号不是一回事（见服务端注释）：这里只按**粗细/线型**还原观感，不追求逐像素
 * 与 Excel 一致 —— 表格视图的职责是「看得出一格到哪、哪块有框」，不是打印预览。
 */
export function borderCss(side: KbBorderSide | undefined): {
  width: number;
  style: string;
  color: string;
} | null {
  if (!side) return null;
  const color = cssColor(side.color) ?? '#000000';
  switch (side.style) {
    case '2':
      return { width: 1, style: 'solid', color };
    case '3':
      return { width: 1, style: 'dotted', color };
    case '4':
    case '5':
      return { width: 1, style: 'dashed', color };
    case '6':
    case '12':
      return { width: 1, style: 'dotted', color };
    case '7':
      return { width: 3, style: 'double', color };
    case '8':
      return { width: 2, style: 'solid', color };
    case '9':
      return { width: 2, style: 'dashed', color };
    case '10':
    case '11':
      return { width: 2, style: 'dotted', color };
    case '13':
      return { width: 3, style: 'solid', color };
    default:
      return { width: 1, style: 'solid', color };
  }
}

/** 单格文本上限：与服务端 `MAX_CELL_CHARS` 同量级，超了截断（不让一格里塞一篇文章）。 */
export const MAX_CELL_TEXT = 1000;

/** 单元格里真正要画的那一行字（截断长文本，避免一行 div 撑爆布局）。 */
export function renderedText(cell: KbCell | undefined): string {
  const text = displayText(cell);
  return text.length > MAX_CELL_TEXT ? `${text.slice(0, MAX_CELL_TEXT)}…` : text;
}
