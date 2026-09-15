/**
 * nanobot 网关进程桥（桌面端专用）。
 * 渲染层经此模块控制主进程拉起的 nanobot 子进程；Web 环境下全部为 no-op。
 * 仅依赖 window.electronAPI，不直接 import 'electron'。
 */
import { platform } from './index';

export interface NanobotBridge {
  /** 启动网关子进程，返回是否成功拉起 */
  start(): Promise<boolean>;
  /** 停止网关子进程 */
  stop(): Promise<void>;
  /** 查询网关子进程是否在运行 */
  status(): Promise<boolean>;
}

const noop: NanobotBridge = {
  async start() {
    return false;
  },
  async stop() {
    /* noop */
  },
  async status() {
    return false;
  },
};

const electronBridge: NanobotBridge = {
  start: () => window.electronAPI!.nanobotStart(),
  stop: () => window.electronAPI!.nanobotStop(),
  status: () => window.electronAPI!.nanobotStatus(),
};

/** 根据运行环境返回可用的 nanobot 桥（Web 下为 no-op） */
export const nanobotBridge: NanobotBridge =
  platform.env === 'electron' && typeof window !== 'undefined' && window.electronAPI
    ? electronBridge
    : noop;
