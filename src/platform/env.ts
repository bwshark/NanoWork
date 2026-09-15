/**
 * 运行环境检测。
 * 依据 window.electronAPI 是否存在判断是否为 Electron 桌面环境。
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

/** 是否为 Web（浏览器）环境 */
export function isWeb(): boolean {
  return !isElectron();
}
