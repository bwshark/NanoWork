/**
 * nanobot 配置片段生成器。
 *
 * 背景：nanobot 的 MCP Server 列表写在 `config.json` 的 `tools.mcpServers`
 * 路径下（启动时一次性加载；运行时无 chat 级热启用），本模块把前端
 * MCPConfig[] 映射为 nanobot 可消费的 JSON 片段，并提供落盘/导出/合并入口。
 *
 * 映射规则：
 *   - transport='url'    → { url, transport: 'streamable_http' | 'sse' }
 *   - transport='command'→ { command, args, transport: 'stdio' }
 *   - auth               → 注入到 env（HTTP 模式时也作为 headers 备份）
 *
 * electron 主进程会把 `tools.mcpServers` 字段合并写入 config.json，并按需
 * 重启 serve 子进程让 MCP 工具在对话中真正生效；web 端降级为下载片段
 * (`{ mcpServers: ... }`) 供用户手动合并。
 */

import { platform } from '@/platform';
import { isElectron } from '@/platform/env';
import { genId } from '@/lib/id';
import type { MCPConfig } from '@/types';

/**
 * nanobot mcpServers 条目结构（与 nanobot 的 MCPServerConfig 对齐）。
 * 注意 nanobot 字段名为 `type`（取值 stdio|sse|streamableHttp，大写 H），
 * 而非本应用内部的 `transport`；nanobot 也会按 command/url 自动探测，
 * 显式给出 type 仅用于消除 HTTP/SSE 歧义。
 */
export interface NanobotMCP {
  [name: string]: {
    type?: 'stdio' | 'sse' | 'streamableHttp';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
}

/**
 * 解析 stdio 启动命令为 token 列表：空格分隔，双引号包裹的段
 * （含内部空格）视为单个 arg，引号本身去掉。
 * 例：`a "b c" d` → ['a', 'b c', 'd']。
 */
function parseCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

/** 单条 MCPConfig → nanobot 条目 */
export function toNanobotEntry(cfg: MCPConfig): NanobotMCP[string] {
  if (cfg.transport === 'command') {
    const parts = parseCommand(cfg.command ?? '');
    const entry: Record<string, unknown> = {
      type: 'stdio',
      command: parts[0],
      args: parts.slice(1),
    };
    // stdio 模式下把 auth 作为环境变量注入（如 API Key）
    if (cfg.auth && Object.keys(cfg.auth).length > 0) {
      entry.env = { ...cfg.auth };
    }
    return entry as NanobotMCP[string];
  }

  // url：优先用回读时保留的 urlType，避免写回时被 URL 路径推断翻转；
  // 兜底：默认按 streamableHttp；若显式含 /sse 路径则按 sse
  const isSse = /\/sse(\/|$)/i.test(cfg.endpoint ?? '');
  const entry: Record<string, unknown> = {
    type: cfg.urlType ?? (isSse ? 'sse' : 'streamableHttp'),
    url: cfg.endpoint,
  };
  // HTTP/SSE 模式：token 注入到 Authorization 头（兼容需要 Bearer 的 MCP server）
  if (cfg.auth?.token) {
    entry.headers = { Authorization: `Bearer ${cfg.auth.token}` };
  }
  return entry as NanobotMCP[string];
}

/** MCPConfig[] → nanobot mcpServers 对象（仅条目，不含包络键） */
export function toNanobotMCP(configs: MCPConfig[]): NanobotMCP {
  const out: NanobotMCP = {};
  for (const c of configs) {
    // 统一启停语义（与 selectEnabledConfigs 对齐）：跳过所有停用条目（builtin/user 一致），
    // 避免停用条目污染运行时；老数据 enabled:undefined 默认启用
    if (c.enabled === false) continue;
    out[c.name] = toNanobotEntry(c);
  }
  return out;
}

/**
 * nanobot mcpServers 快照（键=服务器名）→ 前端 MCPConfig[]（反向映射）。
 * 用于启动时从 nanobot config.json 回显本地缺失的条目：
 *   - type='stdio' 或存在 command → transport='command'，env 回灌 auth；
 *   - 其余（streamableHttp/sse 或存在 url）→ transport='url'，
 *     headers.Authorization 为 `Bearer xxx` 时回灌 auth.token。
 * 非法/空条目直接跳过，不抛异常。
 */
export function fromNanobotMCP(snapshot: Record<string, unknown> | null): MCPConfig[] {
  if (!snapshot) return [];
  const out: MCPConfig[] = [];
  for (const [name, raw] of Object.entries(snapshot)) {
    if (!name || !raw || typeof raw !== 'object') continue;
    const entry = raw as NanobotMCP[string];

    const isStdio =
      entry.type === 'stdio' || (!entry.url && typeof entry.command === 'string');

    if (isStdio) {
      if (typeof entry.command !== 'string' || entry.command.length === 0) continue;
      const args = Array.isArray(entry.args)
        ? entry.args.filter((a): a is string => typeof a === 'string')
        : [];
      // 含空白字符的 arg 用双引号包裹，避免写回时被空格拆碎
      const quotedArgs = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
      const cfg: MCPConfig = {
        id: genId(),
        name,
        transport: 'command',
        command: [entry.command, ...quotedArgs].join(' '),
        status: 'idle',
        source: 'user',
        enabled: true,
      };
      // stdio 正向映射时 auth 注入 env，此处反向回灌（仅保留字符串值）
      if (entry.env) {
        const envAuth = Object.fromEntries(
          Object.entries(entry.env).filter(([, v]) => typeof v === 'string'),
        );
        if (Object.keys(envAuth).length > 0) {
          cfg.auth = envAuth;
        }
      }
      out.push(cfg);
      continue;
    }

    if (typeof entry.url !== 'string' || entry.url.length === 0) continue;
    const cfg: MCPConfig = {
      id: genId(),
      name,
      transport: 'url',
      endpoint: entry.url,
      status: 'idle',
      source: 'user',
      enabled: true,
    };
    // 保留原传输类型，避免写回时 sse 被翻转为 streamableHttp
    if (entry.type === 'sse' || entry.type === 'streamableHttp') {
      cfg.urlType = entry.type;
    }
    // HTTP/SSE 正向映射时 token 写入 Authorization 头，此处解析 Bearer 回灌
    // （HTTP 头大小写不敏感；非字符串值容错跳过，避免整批回读失败）
    const authHeader = entry.headers?.Authorization ?? entry.headers?.authorization;
    if (typeof authHeader === 'string') {
      const bearer = authHeader.match(/^Bearer\s+(\S+)/i);
      if (bearer?.[1]) {
        cfg.auth = { token: bearer[1] };
      }
    }
    out.push(cfg);
  }
  return out;
}

/** 历史形态：`{ mcpServers: { ... } }`，用于 web 下载片段兼容 */
export function buildNanobotConfigFragment(configs: MCPConfig[]): string {
  return JSON.stringify({ mcpServers: toNanobotMCP(configs) }, null, 2);
}

/**
 * 完整 nanobot config 顶层片段：`{ tools: { mcpServers: { ... } } }`，
 * 供 electron 主进程做局部合并，避免覆盖 config.json 的其他字段。
 */
export function buildNanobotMcpConfigPatch(configs: MCPConfig[]): string {
  return JSON.stringify(
    {
      tools: { mcpServers: toNanobotMCP(configs) },
    },
    null,
    2,
  );
}

/**
 * 同步到 nanobot 运行时（片段导出，web 降级路径）：
 * - electron：返回内置空操作（实际合并由 platform.syncNanobotMcp IPC 完成）；
 * - web：触发浏览器下载 `{ mcpServers: ... }` 片段文件，由用户手动合并。
 * 返回写入/下载的目标描述（用于 UI 提示）。
 */
export async function syncToNanobotRuntime(configs: MCPConfig[]): Promise<string> {
  const fragment = buildNanobotConfigFragment(configs);
  const targetName = 'nanobot.mcp.json';
  // electron 端不在这里写盘，避免覆盖主进程的合并结果；统一改走 platform 抽象
  const targetPath = isElectron() ? `$HOME/${targetName}` : targetName;

  await platform.writeTextFile(targetPath, fragment);
  return targetPath;
}
