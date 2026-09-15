/** 当前连接状态：已直连 / 离线 */
export type ConnectionStatus = 'connected' | 'offline';

// DesktopConfig 定义在 platform/types（主进程与渲染层共用）：
// 先 import 供本文件的 Settings 引用，再转出，方便设置层从 '@/types' 统一取用
import type { DesktopConfig } from '../platform/types';
export type { DesktopConfig };

/**
 * 语音转录（STT）配置：走 OpenAI 兼容的 `/audio/transcriptions`。
 * 未启用时 Composer 的语音按钮保持禁用（不申请麦克风权限）。
 */
export interface TranscriptionConfig {
  /** 是否启用语音输入 */
  enabled: boolean;
  /** 转录服务 endpoint（OpenAI 兼容前缀）；留空则复用网关 endpoint */
  endpoint: string;
  /** 转录模型名（如 whisper-1 / whisper-large-v3） */
  model: string;
  /** 转录服务 API Key；留空则复用网关 apiToken */
  apiToken: string;
  /** 语言提示（ISO-639-1，如 zh / en）；留空由服务端自动检测 */
  language: string;
}

/** 全局设置（持久化） */
export interface Settings {
  /** nanobot 网关 endpoint（OpenAI 兼容 API 前缀），默认 http://127.0.0.1:8765/v1 */
  gatewayEndpoint: string;
  /** nanobot apiToken / key */
  apiToken: string;
  /** UI 主题偏好：浅色 / 深色 / 跟随系统 */
  theme: 'light' | 'dark' | 'system';
  /** 是否将 MEMORY.md 以标签块注入 system prompt 末尾（默认 true） */
  memoryEnabled: boolean;
  /** 会话结束时是否自动沉淀摘要（默认 false） */
  autoSummarize: boolean;
  // —— 语音输入（STT）——
  /** 语音转录服务配置：未启用时 Composer 语音按钮禁用 */
  transcription: TranscriptionConfig;
  // —— 桌面端（Electron）——
  /**
   * 系统托盘 / 全局快捷键 / 开机自启等桌面专有行为。
   * Web 端无对应能力，该项仅作占位（保持结构一致，避免 undefined 分支）。
   */
  desktop: DesktopConfig;
  // —— 侧边栏工作空间显示名 ——
  /**
   * 工作空间别名表。key 为会话的 workdir（绝对路径），
   * value 为侧边栏分组要展示的显示名。设了别名后，
   * 「重命名工作空间」改的是这张表，绝不会写回 workdir。
   * 存 mapping 而不是每个 session 各自存别名，是因为同一文件夹下的多个 session
   * 应该共享同一别名，否则只重命名单个 session 就破坏了「工作空间」语义。
   * 兜底默认 `{}`，老用户迁移见 settingsStore 的 v6 迁移函数。
   */
  workspaceAliases?: Record<string, string>;
  // —— 窗口外壳 ——
  /**
   * 侧边栏是否收起。桌面端由窗口标题栏最左侧的图标切换，
   * 收起后标题栏改为显示「展开侧边栏 + 新建任务」。
   * 属布局偏好，持久化，重开应用保持上次状态。默认 false。
   */
  sidebarCollapsed?: boolean;
  // —— 侧边栏分组的「从列表中移除」——
  /**
   * 已从侧边栏隐藏的会话 id 列表。
   *
   * 语义是「只从列表里拿掉，不删数据」：会话仍在 sessionsStore 中，
   * 只是不参与侧边栏分组渲染（仍可通过运行记录等方式访问）。
   * 存会话 id 而非分组 key，是因为这样有天然的恢复路径——
   * 定时任务下次执行会生成新的会话 id，不在表内，该分组便自动重新出现。
   *
   * 兜底默认 `[]`，老用户迁移见 settingsStore 的 v8 迁移函数。
   */
  hiddenSessions?: string[];
}
