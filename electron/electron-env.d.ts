import type { ElectronAPI } from '../src/platform/types';

/** Electron 渲染层全局类型声明（供主进程/打包器使用） */
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
