import type { ElectronAPI } from './types';

/**
 * 跨端通知封装。
 * - Electron：经 window.electronAPI.notify 调用主进程系统通知。
 * - Web：使用浏览器 Notification（需用户授权，降级为静默）。
 */
export function notify(title: string, body: string): void {
  try {
    const api = window.electronAPI as ElectronAPI | undefined;
    if (api?.notify) {
      api.notify(title, body);
      return;
    }
  } catch {
    // ignore
  }

  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    // ignore
  }
}
