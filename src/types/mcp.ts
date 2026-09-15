/** MCP 传输类型 */
export type MCPTransport = 'url' | 'command';

/** MCP 连接状态 */
export type MCPStatus = 'idle' | 'syncing' | 'connected' | 'error';

/**
 * MCP 来源。
 * - builtin：随应用发布的官方预设（不可删除，可启用切换）
 * - user：用户在 MCP 管理页自定义添加的
 */
export type MCPSource = 'builtin' | 'user';

/**
 * 内置 MCP 的稳定 id 前缀，便于与用户条目区分、序列化兼容。
 * 用户自定义条目则使用 genId() 生成的随机 id。
 */
export const BUILTIN_MCP_PREFIX = 'builtin:' as const;

/** 内置 MCP id 是否命中 builtin 前缀 */
export function isBuiltinMcpId(id: string): boolean {
  return id.startsWith(BUILTIN_MCP_PREFIX);
}

/** MCP Server 配置（FR-004） */
export interface MCPConfig {
  id: string;
  name: string;
  transport: MCPTransport;
  /** url 模式下的地址 */
  endpoint?: string;
  /**
   * url 模式下的 nanobot 传输类型（sse/streamableHttp）。
   * 仅回读回显时写入，用于写回时保持原类型，避免被 URL 路径推断翻转；
   * 不影响现有 UI。
   */
  urlType?: 'sse' | 'streamableHttp';
  /** command 模式下的启动命令（含空格分隔的 args） */
  command?: string;
  /** 认证信息（key/value → 注入到 env / headers） */
  auth?: Record<string, string>;
  status: MCPStatus;
  /** 来源（builtin/user）；老数据无此字段时按 'user' 处理 */
  source?: MCPSource;
  /** 是否启用：builtin/user 均可在管理页切换；undefined 视为启用（老数据兼容） */
  enabled?: boolean;
  /** 能力说明（仅 builtin 有意义） */
  description?: string;
  /** 分类（仅 builtin：用于分组/筛选） */
  category?: string;
  /** 图标（emoji 或 MUI icon 名；仅 builtin） */
  icon?: string;
  /** 版本号（仅 builtin） */
  version?: string;
}
