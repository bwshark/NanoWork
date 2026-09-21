/**
 * nanobot 网关进程桥（桌面端专用）。
 * 渲染层经此模块控制主进程拉起的 nanobot 子进程；Web 环境下全部为 no-op。
 * 仅依赖 window.electronAPI，不直接 import 'electron'。
 */
import { platform } from './index';
import type { NanobotGatewayInfo } from './types';

export interface NanobotBridge {
  /** 启动网关子进程，返回是否成功拉起 */
  start(): Promise<boolean>;
  /** 停止网关子进程 */
  stop(): Promise<void>;
  /** 查询网关子进程是否在运行 */
  status(): Promise<boolean>;
  /** 查询网关实际监听的地址与端口（端口自动顺延后据此对齐地址） */
  info(): Promise<NanobotGatewayInfo>;
}

/** Web 端的兜底信息：没有子进程，端口恒为未知 */
const NOOP_INFO: NanobotGatewayInfo = {
  running: false,
  host: null,
  port: null,
  preferredPort: 0,
  fallback: false,
};

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
  async info() {
    return { ...NOOP_INFO };
  },
};

const electronBridge: NanobotBridge = {
  start: () => window.electronAPI!.nanobotStart(),
  stop: () => window.electronAPI!.nanobotStop(),
  status: () => window.electronAPI!.nanobotStatus(),
  info: () => window.electronAPI!.nanobotGatewayInfo(),
};

/** 根据运行环境返回可用的 nanobot 桥（Web 下为 no-op） */
export const nanobotBridge: NanobotBridge =
  platform.env === 'electron' && typeof window !== 'undefined' && window.electronAPI
    ? electronBridge
    : noop;
