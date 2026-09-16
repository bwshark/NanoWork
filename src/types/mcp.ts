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

/**
 * 探针发现的单条 MCP 工具。
 *
 * 它是**运行时事实**，不是配置：只能由一次真实握手（`tools/list`）产出，
 * 因此 `MCPConfig.tools` 是缓存而非声明——重新探测会整体替换。
 */
export interface McpToolInfo {
  name: string;
  description?: string;
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
  /**
   * 认证信息（key/value → 注入到 env / headers）。
   *
   * ⚠️ **它是编辑中的草稿，不是持久化字段**：密钥值只落在主进程的加密保险库
   * （`~/.nanowork/connectors/.credentials.v3.json`）里，持久化时会被剔除
   * （见 `mcpStore` 的 `partialize`）。界面要判断"是否已配置凭据"，看
   * `authKeyNames`——名字清单，不含值。
   */
  auth?: Record<string, string>;
  /**
   * 已配置凭据的 **key 名清单**（如 `['token']`），用于界面显示"已设置"。
   * 只有名字：值在保险库里，从不回传渲染层。
   */
  authKeyNames?: string[];
  /**
   * 工具级授权黑名单：列在这里的工具**不注册进引擎**（其余照常可用）。
   *
   * 刻意做成黑名单而不是白名单：用户的心智是"这个工具我不想让它用"，
   * 而白名单会随服务端新增工具而静默变成"新工具自动被禁"。
   * 引擎侧对应 `MCPServerConfig.disabled_tools`（nanowork 本地扩展字段）。
   */
  disabledTools?: string[];
  /** 最近一次真实探测发现的工具清单（未探测过为 undefined） */
  tools?: McpToolInfo[];
  /** 最近一次真实探测的时间戳（毫秒）；未探测过为 undefined */
  lastProbedAt?: number;
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
