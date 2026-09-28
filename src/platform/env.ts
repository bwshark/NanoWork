import type { ElectronAPI, PlatformName } from './types';

/**
 * 运行环境检测。
 *
 * 本模块与 `index.ts` / `storage.*` / `notification.ts` 同属**渲染层唯一允许知道
 * `window.electronAPI` 存在的地方**——CI 的平台边界检查（`.github/workflows/ci.yml`
 * 检查一）只放行 `src/platform/`，其余代码一律经 `platform` 暴露的能力访问主进程。
 */

/**
 * preload 桥（非 Electron 环境为 `undefined`）。
 *
 * 给 `src/events/electronStore.ts` 这类**本身就是平台实现**的模块用：它是
 * `EventStore` 契约的桌面端实现，需要的是主进程的事件流 IPC，而 `PlatformAdapter`
 * 刻意不含事件流能力（那属 `@/events` 的抽象层）。除它之外，新代码不要用这个函数
 * ——加一条适配层能力比到处判桥更好收口。
 */
export function electronBridge(): ElectronAPI | undefined {
  return typeof window === 'undefined' ? undefined : window.electronAPI;
}

/** 是否为 Electron 桌面环境（依据 preload 桥是否存在） */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

/** 是否为 Web（浏览器）环境 */
export function isWeb(): boolean {
  return !isElectron();
}

/**
 * Web 端的操作系统推断（只服务「macOS 显示分支」这类**展示**逻辑）。
 *
 * 桌面端不要用这个：那边有主进程给的权威值（`electronBridge().getPlatform()`）。
 * 浏览器只能按 UA 粗判，判错的最坏后果是标题栏画了自绘窗口控件。
 */
export function webPlatformOs(): PlatformName {
  const ua =
    typeof navigator === 'undefined'
      ? ''
      : `${navigator.userAgent} ${navigator.platform ?? ''}`;
  if (/mac|iphone|ipad|ipod/i.test(ua)) return 'darwin';
  if (/linux|android|x11/i.test(ua)) return 'linux';
  return 'win32';
}
