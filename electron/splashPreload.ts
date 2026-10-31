/**
 * 启动屏 preload：**只暴露启动屏需要的那四个能力**。
 *
 * 为什么不复用主窗口的 `preload.ts`：那个桥面暴露了几十个 IPC（存储、文件、托盘…），
 * 而启动屏是一个无边框、无导航、只活几秒的窗口。让它拿到整张能力表，等于给一个
 * 临时窗口开全套后门——安全档位表（`windowPreferences`）给 `splash` 角色的沙箱与
 * 同源策略都是最严的，桥面也必须跟着最严。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** 与 `electron/splashState.ts` 的 `SplashView` 同构（页面只用，不做类型校验） */
type SplashView = Record<string, unknown>;

const api = {
  /** 订阅状态；返回取消订阅函数（页面卸载时用得上） */
  onState(callback: (view: SplashView) => void): () => void {
    const listener = (_event: IpcRendererEvent, view: SplashView): void => callback(view);
    ipcRenderer.on('splash:state', listener);
    return () => {
      ipcRenderer.removeListener('splash:state', listener);
    };
  },
  /** 错误卡片上的「重试」 */
  retry(): void {
    ipcRenderer.send('splash:retry');
  },
  /** 错误卡片上的「先进入应用」/ 用户主动跳过 */
  enterApp(): void {
    ipcRenderer.send('splash:continue');
  },
  /** 打不开时的自救入口：打开日志目录 */
  openLogs(): void {
    ipcRenderer.send('splash:open-logs');
  },
};

contextBridge.exposeInMainWorld('nanoworkSplash', api);
