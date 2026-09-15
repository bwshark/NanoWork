import { BUILTIN_MCP_PREFIX, type MCPConfig } from '@/types';

/**
 * 内置 MCP Server 目录（FR-004 扩展）。
 *
 * 这些条目随应用发布，source 为 'builtin'，在管理页可启用/停用，
 * 但不可删除（store 层 enforce）。同步后会与用户自定义条目
 * 一同合并进 nanobot config.json 的 `tools.mcpServers`，
 * 网关重启后即可在对话中加载 MCP 工具。
 *
 * 选择标准：
 *   1. 与工作场景直接相关的领域数据源（如 smartdata 牧场数据）；
 *   2. 与 nanobot 自身生态相关的知识/工具（如 nanobot 官方文档 / 通用 filesystem）；
 *   3. 涵盖两种传输类型（HTTP/SSE + stdio），便于测试配置链路完整。
 */
export const MCP_SERVERS: MCPConfig[] = [
  {
    id: `${BUILTIN_MCP_PREFIX}smartagent-cloudbase`,
    name: 'CloudBase 控制台',
    description: '腾讯云开发 CloudBase MCP，控制台环境/数据库/云函数管理（HTTP）。',
    category: '云服务',
    icon: '☁️',
    source: 'builtin',
    enabled: false,
    status: 'idle',
    transport: 'url',
    endpoint: 'https://mcp.cloudbase.com/v1',
    version: '1.0.0',
  },
  {
    id: `${BUILTIN_MCP_PREFIX}filesystem`,
    name: '本地文件系统（stdio）',
    description:
      'filesystem MCP（stdio，npx 拉取）。授权后可在对话中读/写当前工作目录文件。需用户手动授权。',
    category: '系统',
    icon: '📁',
    source: 'builtin',
    enabled: false,
    status: 'idle',
    transport: 'command',
    command: 'npx -y @modelcontextprotocol/server-filesystem ${WORKSPACE}',
    version: '1.0.0',
  },
];
