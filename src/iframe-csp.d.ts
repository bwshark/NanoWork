/**
 * iframe 的 `csp` 属性类型补全（FR-8.12）。
 *
 * React 18 的 `IframeHTMLAttributes` 尚未收录 `csp`（该属性用于给 iframe 内文档
 * 套一层内容安全策略，Chrome/Edge 已支持）。这里仅做最小幅度的类型增强，
 * 不改动任何运行时行为。
 */
import 'react';

declare module 'react' {
  interface IframeHTMLAttributes<T> {
    /** 应用到 iframe 内文档的 CSP（字符串形式），如 `default-src 'none'; connect-src 'none'` */
    csp?: string;
  }
}
