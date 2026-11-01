/**
 * `nanowork-ext://` 协议 —— 扩展 UI 的唯一加载通道。
 *
 * ## 为什么不用 `file://`
 *
 * 三个理由，任何一个都足够：
 * 1. 主窗口 `webSecurity: true`，`file://` iframe 与页面不同源且被 Chromium 特别对待
 *    （部分版本直接拒载）；
 * 2. 一旦放行 `file:`，扩展页面就能请求**磁盘上任意路径** —— 那不是"扩展自己的资源"；
 * 3. 自定义协议让我们能在服务端再判一次"这个请求是否在它自己的包内"，
 *    前端的任何判断都不算数。
 *
 * ## 为什么响应头里带 CSP
 *
 * 扩展页跑在**自己的源**里，但它加载的内容仍是第三方代码。CSP 的作用不是防它
 * 联网（扩展本来就要调自己 fork 的服务与外部 API），而是收窄"它能把这个页面
 * 变成什么"：不允许嵌套 iframe、不允许插件对象、不允许 base 标签劫持相对路径。
 *
 * 与产物预览（`ARTIFACT_PREVIEW_CSP`，`connect-src 'none'`）的差异是刻意的：
 * 产物是**模型生成**的不可信内容，扩展是**用户主动安装**的可信代码。
 */
import { promises as fs } from 'node:fs';
import { extname } from 'node:path';
import { protocol } from 'electron';
import { resolveExtensionRequest } from './extensionPackage';
import { EXTENSION_SCHEME } from '../src/types/extension';

/** 扩展页面的 CSP：允许联网，禁止嵌套与对象插件 */
export const EXTENSION_PAGE_CSP = [
  "default-src 'self' data: blob:",
  // 扩展自带依赖，允许内联（打包成一页的扩展很常见）与 eval（部分框架需要）
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob:",
  // 扩展要调自己 fork 的服务（127.0.0.1 随机端口）与自己的后端
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https: wss:",
  "frame-ancestors 'self'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/** 常见前端资源的 content-type（扩展 UI 只会用这些） */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** 按扩展名取 content-type；未知一律 `application/octet-stream`（不猜） */
export function contentTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 扩展 id → 包根 的映射表。
 *
 * 由扫描结果刷新（`setExtensionRoots`），协议 handler 只读它。
 * **不按 URL 里的 host 直接拼目录名**：那样 `nanowork-ext://../../etc/passwd`
 * 这类请求就变成一次目录探测。
 */
const extensionRoots = new Map<string, string>();

/** 用最新扫描结果替换映射表（扫描后调用；不调用则协议一直 404） */
export function setExtensionRoots(entries: Array<{ id: string; root: string }>): void {
  extensionRoots.clear();
  for (const entry of entries) extensionRoots.set(entry.id, entry.root);
}

/** 当前映射表快照（诊断用） */
export function knownExtensionRoots(): Map<string, string> {
  return new Map(extensionRoots);
}

/**
 * 注册协议 scheme 的**特权**。
 *
 * ⚠️ 必须在 `app.whenReady()` **之前**调用，之后再调无效（Electron 的约束）。
 * `standard: true` 让 URL 有正常的 origin（iframe 才能被 `frame-ancestors 'self'`
 * 之外的同源策略正确处理），`secure: true` 让它享受安全上下文（`crypto.subtle`
 * 等 API 可用）。
 */
export function registerExtensionScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // 扩展页面之间不互相 CORS：每个扩展是独立源，靠 CSP 与 host 隔离
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

/**
 * 安装协议 handler（`app.whenReady()` 之后调）。
 *
 * 404 一律使用同一段无信息量的文案：把"为什么失败"（越界 / 不存在 / 不存在这个
 * 扩展）回显给页面，等于把本机装了哪些扩展告诉任意一个能发请求的页面。
 */
export function installExtensionProtocol(): void {
  protocol.handle(EXTENSION_SCHEME, async (request) => {
    const resolved = resolveExtensionRequest(request.url, extensionRoots);
    if (!resolved) return new Response('Not Found', { status: 404 });

    try {
      const data = await fs.readFile(resolved.filePath);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'content-type': contentTypeFor(resolved.filePath),
          'content-security-policy': EXTENSION_PAGE_CSP,
          // 扩展资源按需更新即可；不强缓存，避免改文件后看不到变化
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
