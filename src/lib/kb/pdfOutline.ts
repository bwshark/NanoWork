/**
 * PDF 书签 → 大纲树（纯逻辑，不碰 DOM、不碰 pdf.js 实例）。
 *
 * ## 为什么大纲只认「书签」，不从正文猜标题
 *
 * 大纲要回答两个问题：**这一章叫什么**、**在文档的哪个位置**。第二个问题只有 PDF 自己知道
 * （书签里存的是精确的 destination）；从文本层里找「这一行看起来像标题」再反推位置，
 * 在目录页、页眉、重复标题上必然错位。
 *
 * 所以服务端转换时必须导书签（`office2pdf` 的 `ExportBookmarks` / `CreateBookmarks`），
 * 前端这里只做三件事：把嵌套书签**摊平**（带层级，侧栏好缩进）、把 destination 解析成
 * **页码 + 页内纵向坐标**、按滚动位置算出"当前读到哪一节"。
 *
 * ## 为什么"当前章节"要算到页内，而不是只算到页
 *
 * 一份 Word 稿子里几个标题落在同一页是**常态**（一个章节的 1.1/1.2、评审意见的几段小标题）。
 * 只按页码判"已经开始"的话，当前章节永远会被算成该页最后一条 —— 点第一条却亮到最后一条，
 * 用户看到的就是"没有选中态"。所以每个条目都要带上页内坐标，判定用**绝对纵向位置**。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑要能在 jsdom 里测：真机验布局，单测验规则，别让两边都靠肉眼。
 */

/** 侧栏只画得下这么多；几百条的大纲比没有更难用（也拖慢滚动高亮） */
export const OUTLINE_LIMIT = 400;

/** 缩进最多 5 级：PDF 书签理论上可以无限嵌套，视觉上 6 级之后就分不清了 */
const MAX_DEPTH = 5;

/** 一条大纲项（已解析） */
export interface PdfOutlineNode {
  title: string;
  /** 层级，0 = 顶层 */
  depth: number;
  /** 1 起的页码；0 = destination 解不出来（点了没地方去，列表里会画成不可点） */
  page: number;
  /**
   * 页内纵向坐标（PDF 用户空间，原点在页面**左下**）；`null` = 目的地不指定位置（`/Fit` 等）。
   *
   * ⚠️ 注意坐标轴方向：`top` 是从**页底**往上量的，距页顶的距离是 `页高 − top`。
   */
  top: number | null;
  /** 原始 destination：留着方便排查，跳转与高亮用的是 `page` + `top` */
  dest: string | unknown[] | null;
}

/** pdf.js `getOutline()` 返回项的最小形状（只声明我们用到的字段） */
export interface OutlineSource {
  title?: string;
  dest?: unknown;
  items?: OutlineSource[] | null;
}

/** 解析位置只需要这两个方法 —— `PDFDocumentProxy` 天然满足，测试里可以给假的 */
export interface OutlineResolver {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

/**
 * 书签目的地的结构（**这里最容易错一位，错了的症状是"点了跳错地方/像没反应"**）。
 *
 * PDF 规范里的目的地数组是两种写法：
 * - **具名类型**：`[页引用, /XYZ, left, top, zoom]`
 * - **pdf.js 归一化后**：`[页引用, { name: 'XYZ' }, left, top, zoom]`
 *   —— 第二项永远占一格，只是从"字符串"变成了"带 name 的对象"。
 *
 * 所以"纵向坐标"的位置取决于**第二项是不是类型名**：
 * - 是 → `XYZ` 的 top 在索引 3、`FitH` 的 top 在索引 2；
 * - 不是（少数生成器省略了类型名）→ `XYZ` 的 top 在索引 2、`FitH` 的 top 在索引 1。
 *
 * 一开始我按"没有类型名"的布局取 `raw[2]`，于是拿到的是 `left`（Word 写的 87），
 * 算出来的偏移接近页尾、再被 clamp 住 —— 用户看到的就是"点第一条没反应"。
 */
export interface DestinationInfo {
  /** 第 0 项：页面引用（可能是 ref 对象，也可能直接是页码索引） */
  pageRef: unknown;
  /** 目的地类型：`XYZ` / `Fit` / `FitH` / `FitV` / `FitR` / `FitB`… 认不出时为空串 */
  kind: string;
  /** 页内纵向坐标（PDF 用户空间，原点在页面**左下**）。`null` = 这个目的地不指定纵向位置 */
  top: number | null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 把目的地数组读成 `{页引用, 类型, 纵向坐标}`；不是数组就给 `null`。 */
export function readDestination(raw: unknown): DestinationInfo | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const pageRef = raw[0];
  const second = raw[1];
  const named =
    typeof second === 'string' ||
    (second !== null && typeof second === 'object' && 'name' in (second as Record<string, unknown>));
  const kind =
    typeof second === 'string'
      ? second
      : named
        ? String((second as { name: unknown }).name ?? '')
        : '';
  // 参数从"类型名之后"开始；没有类型名时从索引 1 开始
  const params = named ? raw.slice(2) : raw.slice(1);

  if (kind === 'XYZ') return { pageRef, kind, top: asNumber(params[1]) };
  // FitH / FitBH 只给一个坐标，就是纵向位置
  if (kind === 'FitH' || kind === 'FitBH') return { pageRef, kind, top: asNumber(params[0]) };
  if (kind !== '') return { pageRef, kind, top: null };
  // 没写类型名：3 项以上按 XYZ 猜，1 项按 FitH 猜，其余当作"不指定位置"
  if (params.length >= 3) return { pageRef, kind: 'XYZ', top: asNumber(params[1]) };
  if (params.length === 1) return { pageRef, kind: 'FitH', top: asNumber(params[0]) };
  return { pageRef, kind: '', top: null };
}

/** destination → `{页码, 页内纵向坐标}`。解不出返回 `{page: 0, top: null}`，不抛错。 */
async function resolveDestination(
  resolver: OutlineResolver,
  dest: unknown,
): Promise<{ page: number; top: number | null }> {
  if (dest === null || dest === undefined) return { page: 0, top: null };
  try {
    // 具名 destination 要去表里查；显式 destination 就是数组本身
    const explicit = typeof dest === 'string' ? await resolver.getDestination(dest) : dest;
    const info = readDestination(explicit);
    if (!info) return { page: 0, top: null };
    const ref = info.pageRef;
    // 数组第一项可能已经是页索引（数字），也可能是页面引用对象（要查一次）
    const index = typeof ref === 'number' ? ref : await resolver.getPageIndex(ref);
    const page = typeof index === 'number' && index >= 0 ? index + 1 : 0;
    return { page, top: info.top };
  } catch {
    // 一条坏书签不该让整份大纲打不开
    return { page: 0, top: null };
  }
}

async function collect(
  resolver: OutlineResolver,
  items: OutlineSource[],
  depth: number,
  out: PdfOutlineNode[],
): Promise<void> {
  for (const item of items) {
    if (out.length >= OUTLINE_LIMIT) return;
    // 书签标题里常有换行与连续空格（Word 长标题折行时会把它们写进去）
    const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
    const dest = (item.dest ?? null) as string | unknown[] | null;
    const resolved = await resolveDestination(resolver, dest);
    out.push({
      title: title === '' ? '（无标题）' : title,
      depth,
      page: resolved.page,
      top: resolved.top,
      dest,
    });
    if (item.items && item.items.length > 0) {
      await collect(resolver, item.items, Math.min(depth + 1, MAX_DEPTH), out);
    }
  }
}

/** 摊平 + 解析位置。顺序 = 文档顺序（父条目在前，子条目紧随其后）。 */
export async function resolveOutline(
  resolver: OutlineResolver,
  items: OutlineSource[] | null | undefined,
): Promise<PdfOutlineNode[]> {
  const out: PdfOutlineNode[] = [];
  if (items && items.length > 0) await collect(resolver, items, 0, out);
  return out;
}

/**
 * 当前滚到 `offset`（滚动容器的 `scrollTop`）时，应该高亮第几条。
 *
 * `marks` 是每条大纲项在**当前缩放下**的绝对纵向位置（`null` = 位置未知，不参与）。
 * 判定是「最后一个 `at <= offset`」—— 摊平后保持文档顺序，这条规则天然落在"最深的、
 * 已经开始的那一节"，不需要额外比较层级。返回 `-1` = 还没进入任何章节（封面、目录页）。
 *
 * 留 1px 余量：`scrollTop` 是整数化过的，而 `at` 是浮点，正好落在边界上时不加余量会差一条。
 */
export function currentOutlineIndex(marks: Array<number | null>, offset: number): number {
  let found = -1;
  for (let index = 0; index < marks.length; index += 1) {
    const at = marks[index];
    if (at !== null && at <= offset + 1) found = index;
  }
  return found;
}

/**
 * 滚动算出来的"下一节"与"当前这条"冲突时，该保留哪个。
 *
 * 冲突只有一种真实成因：**两条书签落在同一个纵向位置上**（`/Fit` 的整页书签、父标题与
 * 紧挨着的子标题、同一行里的两个书签）。这时 `currentOutlineIndex` 只能按"最后一条"给答案，
 * 于是「点第一条 → 亮第二条」，用户看到的就是"没有选中态"。
 *
 * 规则：两者位置**完全相同**时保留 `current`（通常是刚点的那条 / 正在读的那条）；
 * 位置不同（真的滚到了别的地方）就听 `next` 的。
 */
export function reconcileActive(
  current: number,
  next: number,
  marks: Array<number | null>,
): number {
  if (next === current) return current;
  const tied =
    next >= 0 &&
    current >= 0 &&
    marks[next] !== null &&
    marks[next] !== undefined &&
    marks[next] === marks[current];
  return tied ? current : next;
}
