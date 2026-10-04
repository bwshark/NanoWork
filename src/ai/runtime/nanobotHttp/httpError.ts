/**
 * nanobotHttp 请求层的错误判定。
 *
 * 为什么单独一个文件：`AbortError` 的判定**只有一种正确写法**，而它极易写错
 * （见下面的注释）。原先只有插件域用得上，用量域也要用 —— 与其抄第二份
 * （抄错的代价是「网关没起」被显示成 `AbortError: The user aborted a request`
 * 这种用户看不懂的文案），不如收口到一处。
 */

/**
 * 跨 realm 安全的 AbortError 判定 —— **只看 `name`，不看 `instanceof`**。
 *
 * `AbortController.abort()` 抛出的是 `DOMException`，而它在浏览器 / jsdom / Node
 * 里是不同的构造函数：`err instanceof Error` 与 `err instanceof DOMException`
 * 在跨 realm（iframe、测试环境注入的全局、Electron 的渲染进程）时都可能为 false，
 * 于是「超时」被误报成裸错误文本，用户看到的是技术栈而不是结论。
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}
