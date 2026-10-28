/**
 * PDF 书签 → 大纲树（纯逻辑，不碰 DOM、不碰 pdf.js 实例）。
 *
 * ## 为什么大纲只认「书签」，不从正文猜标题
 *
 * 大纲要回答两个问题：**这一章叫什么**、**在第几页**。第二个问题只有 PDF 自己知道
 * （书签里存的是精确的 destination）；从文本层里找「这一行看起来像标题」再反推页码，
 * 在目录页、页眉、重复标题上必然错位。
 *
 * 所以服务端转换时必须导书签（`office2pdf` 的 `ExportBookmarks` / `CreateBookmarks`），
 * 前端这里只做两件事：把嵌套书签**摊平**（带层级，侧栏好缩进）、把 destination
 * **解析成页码**（滚动时用它判断"当前读到第几章"）。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑要能在 jsdom 里测：`PDFViewer` 需要 canvas 与布局，单测跑不了；
 * 但"摊平对不对、当前章节选中哪一个"是纯函数，可以被钉死 —— 让真机验布局、
 * 单测验规则，别让两边都靠肉眼。
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
  /** 1 起的页码；0 = destination 解不出来（仍可点击，跳转交给 linkService） */
  page: number;
  /** 原始 destination：点击时原样交给 `PDFLinkService.goToDestination` */
  dest: string | unknown[] | null;
}

/** pdf.js `getOutline()` 返回项的最小形状（只声明我们用到的字段） */
export interface OutlineSource {
  title?: string;
  dest?: unknown;
  items?: OutlineSource[] | null;
}

/** 解析页码只需要这两个方法 —— `PDFDocumentProxy` 天然满足，测试里可以给假的 */
export interface OutlineResolver {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

/**
 * destination → 页码（1 起，解不出返回 0）。
 *
 * destination 有两种写法（PDF 规范）：**具名**（字符串，要去 `getDestination` 查表）
 * 与**显式**（数组，第一项是页面引用）。嵌套书签里两种都常见，所以两条都要走。
 * 任何一步失败都返回 0 而不是抛错：一条坏书签不该让整份大纲打不开。
 */
async function resolvePage(resolver: OutlineResolver, dest: unknown): Promise<number> {
  if (dest === null || dest === undefined) return 0;
  try {
    const explicit = typeof dest === "string" ? await resolver.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return 0;
    const first = explicit[0];
    // 数组第一项可能已经是页索引（数字），也可能是页面引用对象（要查一次）
    const index = typeof first === "number" ? first : await resolver.getPageIndex(first);
    return typeof index === "number" && index >= 0 ? index + 1 : 0;
  } catch {
    return 0;
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
    const title = (item.title ?? "").replace(/\s+/g, " ").trim();
    const dest = (item.dest ?? null) as string | unknown[] | null;
    out.push({
      title: title === "" ? "（无标题）" : title,
      depth,
      page: await resolvePage(resolver, dest),
      dest,
    });
    if (item.items && item.items.length > 0) {
      await collect(resolver, item.items, Math.min(depth + 1, MAX_DEPTH), out);
    }
  }
}

/** 摊平 + 解析页码。顺序 = 文档顺序（父条目在前，子条目紧随其后）。 */
export async function resolveOutline(
  resolver: OutlineResolver,
  items: OutlineSource[] | null | undefined,
): Promise<PdfOutlineNode[]> {
  const out: PdfOutlineNode[] = [];
  if (items && items.length > 0) await collect(resolver, items, 0, out);
  return out;
}

/**
 * 当前滚动到第 `page` 页时，应该高亮第几条。
 *
 * 规则：**文档顺序里最后一个 `page <= 当前页` 的条目**。因为摊平后保持文档顺序，
 * 这条规则天然选中"最深的、已经开始的那一节" —— 不需要额外比较层级。
 * 返回 `-1` 表示"还没进入任何章节"（当前页在第一章之前，比如封面/目录页）。
 */
export function currentOutlineIndex(nodes: PdfOutlineNode[], page: number): number {
  let found = -1;
  for (let index = 0; index < nodes.length; index += 1) {
    const target = nodes[index].page;
    if (target > 0 && target <= page) found = index;
  }
  return found;
}
