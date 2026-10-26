/**
 * 图片引用（内部 scheme）与「浏览器能加载的地址」之间的双向替换。
 *
 * ## 为什么正文里存的是 `asset:<id>` 而不是 URL
 *
 * - 不能是 `data:`（base64）—— 一张 200KB 的图会把整块文本撑到几十万字，
 *   切块与检索当场失效。
 * - 不能是某个地址——云端与客户端分离，将来迁对象存储地址还会变。
 * - 所以正文里永远存 `asset:<id>`，**文档与图片的绑定不依赖任何可变的地址**。
 *
 * ## 为什么要「替换成可加载地址」这一步
 *
 * `<img src>` **不会**带 `Authorization` 头，而知识库的接口一律要 Bearer 票。
 * 所以图片只能由 JS 带票取回字节，再换成 `blob:` 地址给 `<img>` 用
 * （见 `assetLoader.ts`）。渲染前在**文本层**替换，而不是在 DOM 里改 ——
 * 只读路径（`remark-gfm`）与编辑器路径（`richText.markdownToHtml`）因此共用
 * 同一份逻辑，两边不会走偏。
 *
 * ## 为什么要能反向换回去
 *
 * 编辑器里显示的是 `blob:` 地址，用户一保存，正文里就会留下
 * `blob:http://localhost:5176/8f3a-…` 这种一次性的地址 —— 换个环境就全成了坏图。
 * 所以保存前必须把它换回 `asset:<id>`。
 */

/**
 * `![图注](asset:<id>)`
 *
 * 图注段允许**转义**的 `]`：Markdown 的 alt 以第一个未转义的 `]` 结束，所以
 * `![图 1\] 架构](asset:x)` 是合法写法。图注现在是**用户手打**的（`[草稿]`、
 * `图 1]` 这类写法随时会出现），只认 `[^\]]*` 会让整条引用匹配不上 ——
 * 症状是「补了图注再保存，图片变成坏图」。
 */
const ASSET_REF = /!\[((?:[^\]\\]|\\.)*)\]\(asset:([A-Za-z0-9_-]+)\)/g;


/**
 * 加载失败时的占位：1×1 透明 GIF。
 *
 * 为什么不用「让浏览器显示坏图图标」：那看起来像文档坏了，而真实原因只是
 * 这张图暂时取不到（比如权限刚被收窄）。占位 + 图注文本更接近实情。
 */
export const FAILED_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 正文里引用的全部资产 id（按出现顺序，去重）。 */
export function collectAssetIds(markdown: string): string[] {
  const seen: string[] = [];
  for (const match of markdown.matchAll(ASSET_REF)) {
    const assetId = match[2];
    if (!seen.includes(assetId)) seen.push(assetId);
  }
  return seen;
}

/**
 * 把 `asset:<id>` 换成可加载地址。
 *
 * `resolve` 返回 `null` 表示这张图取不到（没权限 / 网络失败）：这时**保留原引用**，
 * 换成占位图 —— 静默把图删掉会让用户以为原文里本来就没有这张图。
 *
 * 返回的 `map` 是「可加载地址 → 资产 id」，保存时用它反向换回去。
 */
export function replaceAssetRefs(
  markdown: string,
  resolve: (assetId: string) => string | null,
): { text: string; map: Map<string, string> } {
  const map = new Map<string, string>();
  const text = markdown.replace(ASSET_REF, (match, alt: string, assetId: string) => {
    const url = resolve(assetId);
    if (!url) return `![${alt}](${FAILED_IMAGE_PLACEHOLDER})`;
    map.set(url, assetId);
    return `![${alt}](${url})`;
  });
  return { text, map };
}

/**
 * 把可加载地址换回 `asset:<id>`（保存前做）。
 *
 * 用 `split`/`join` 而不是正则：`blob:` 地址里有 `:` `/` `?` 等正则元字符，
 * 拿它拼正则迟早漏转义。
 */
export function restoreAssetRefs(markdown: string, map: Map<string, string>): string {
  // 按长度倒序：先换长的，避免短地址是长地址前缀时把长的替换坏
  const entries = [...map.entries()].sort((left, right) => right[0].length - left[0].length);
  let out = markdown;
  for (const [url, assetId] of entries) {
    out = out.split(url).join(`asset:${assetId}`);
  }
  return out;
}


/**
 * 文件 → base64（不带 data URL 前缀）。
 *
 * 走 base64 JSON 而不是 multipart：服务端不愿为此引入 `python-multipart`
 * （与文件上传那条路同一套理由）。代价是体积 +1/3，图片通常几百 KB，可以接受。
 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
