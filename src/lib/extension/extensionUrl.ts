/**
 * 扩展 UI 的地址换算（渲染层与主进程共用）。
 *
 * ## 为什么单独一个文件
 *
 * `toExtensionUrl` 两个世界都要用：主进程用它把清单里的相对路径变成协议 URL 去记日志，
 * 渲染层用它填 `<iframe src>`。写在 `electron/extensionPackage.ts` 里的话渲染层
 * **不能 import**（`src/` 不得依赖 `electron/`，这是本仓的 CI 纪律），于是同一段
 * 换算会出现两份实现——两份必然漂移，症状是"主进程说这是 xx.html，界面却请求
 * 另一个路径"，两边各自都自洽。
 *
 * ⚠️ 本文件不得 import 任何 `@/` 别名模块：主进程通过相对路径引它。
 */
import { EXTENSION_SCHEME } from '../../types/extension';

// 协议名单一出处是 `types/extension.ts`（领域常量）；这里只做转发，
// 避免两处各写一个字面量后悄悄漂移。
export { EXTENSION_SCHEME };

/** 是否是 http(s) 绝对地址（这类扩展界面由用户自己托管，不经协议） */
export function isExtensionHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * 把清单里的 url 变成 iframe 真正能用的 src。
 *
 * - `http(s)`：原样返回（用户托管的界面）；
 * - 包内相对路径：`nanowork-ext://<id>/<path>`。
 *
 * `./` 前缀会被去掉：协议 URL 的 pathname 不该带它（`nanowork-ext://x/./a.html`
 * 在部分解析器里会被规范成 `/a.html`，另一些不会，导致同一份清单在两边请求不同路径）。
 */
export function toExtensionUrl(id: string, url: string): string {
  if (isExtensionHttpUrl(url)) return url;
  const cleaned = url.replace(/^\.\//, '').replace(/\\/g, '/');
  return `${EXTENSION_SCHEME}://${id}/${cleaned}`;
}

/**
 * 反向判断：这个 src 是不是协议 URL（用于决定是否走"扩展页面"的 postMessage 桥）。
 *
 * 用户托管的 http(s) 页面与我们不同源、也不认我们的消息协议，硬套桥只会
 * 往控制台刷"message channel closed"。
 */
export function isExtensionSchemeUrl(url: string): boolean {
  return url.startsWith(`${EXTENSION_SCHEME}://`);
}
