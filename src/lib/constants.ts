import type { ConnectionStatus } from '@/types';

/**
 * 侧边栏顶部展示的品牌名（中文主名 + 英文副名）。
 * 与窗口标题栏解耦：桌面端标题栏只放操作图标，品牌名落在侧边栏顶部，
 * 折叠侧边栏后靠托盘图标 / 任务栏标题识别应用。
 */
export const APP_DISPLAY_NAME = 'NanoWork';
export const APP_DISPLAY_SUB = 'Workbench';

/** 完整应用名（「关于」弹窗标题与复制信息用，与侧边栏品牌名保持一致） */
export const APP_NAME = `${APP_DISPLAY_NAME} ${APP_DISPLAY_SUB}`;

/** 默认 nanobot 网关（OpenAI 兼容 API 前缀，与 nanobot serve 默认端口 8900 对齐） */
export const DEFAULT_GATEWAY = 'http://127.0.0.1:8900/v1';

/**
 * 会话（任务）占位标题：首条消息发送前标题为占位值，
 * 发送时由 sessionsStore.send 自动替换为首条消息摘要。
 */
export const PLACEHOLDER_TITLES = ['新会话', '新任务'] as const;

/** 默认连接状态（启动后由 ConnectionManager 探测并更新） */
export const DEFAULT_STATUS: ConnectionStatus = 'offline';

/** 路由路径集中管理 */
export const ROUTES = {
  chat: '/chat',
  agents: '/agents',
  myAgents: '/agents/mine',
  skills: '/skills',
  mcp: '/mcp',
  tasks: '/tasks',
  settings: '/settings',
  artifacts: '/artifacts',
  memory: '/memory',
  im: '/im',
} as const;

/** 持久化存储 key 前缀集中管理 */
export const STORAGE_KEYS = {
  settings: 'nanowork.settings',
  sessions: 'nanowork.sessions',
  agents: 'nanowork.agents',
  expertGroups: 'nanowork.expertGroups',
  skills: 'nanowork.skills',
  mcp: 'nanowork.mcp',
  tasks: 'nanowork.tasks',
  artifacts: 'nanowork.artifacts',
  channels: 'nanowork.channels',
} as const;

/**
 * 工作区文件记忆（MEMORY.md）相关常量。
 * 读写统一走 platform.storage（Web/Electron 一致）；Electron 下主进程把
 * `nanowork.memory.<workspaceKey>` 路由成 `~/.nanowork/memory/<workspaceKey>.md`
 * 真实文件（见 electron/storageRoutes.ts）。
 */
/** 记忆文本在 storage 中的 key 前缀，完整 key = MEMORY_KEY_PREFIX + workspaceKey */
export const MEMORY_KEY_PREFIX = 'nanowork.memory.';

/** 记忆文件名（记忆页「导出」动作使用该名；Electron 下解析到 ~/.nanowork/） */
export const MEMORY_FILENAME = 'MEMORY.md';

/** 注入 system 段的记忆块起始标签（便于解析与去重） */
export const MEMORY_TAG_OPEN = '<!-- MEMORY -->';

/** 注入 system 段的记忆块结束标签 */
export const MEMORY_TAG_CLOSE = '<!-- /MEMORY -->';

/**
 * 敏感工具集合：文件读写 / 终端命令 / 网络访问。
 * 命中时触发权限门控（PermissionDialog）。
 */
export const SENSITIVE_TOOLS = ['files', 'shell', 'network'] as const;

/** 判断工具名是否属于敏感类别 */
export function isSensitiveTool(tool: string): boolean {
  return (SENSITIVE_TOOLS as readonly string[]).includes(tool);
}
