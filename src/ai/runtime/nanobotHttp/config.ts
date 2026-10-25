/**
 * nanobot **MCP 连接器域**：领域对象 ⇄ 引擎配置片段。
 *
 * 背景：nanobot 的 MCP Server 列表写在 config.json 的 `tools.mcpServers`
 * 路径下（启动时一次性加载；运行时无 chat 级热启用）。本模块把前端
 * `MCPConfig[]` 映射为 nanobot 可消费的结构，并提供同步/回读入口。
 *
 * 映射规则（对齐 nanobot 的 MCPServerConfig）：
 *   - transport='url'    → { url, type: 'streamableHttp' | 'sse' }
 *   - transport='command'→ { command, args, type: 'stdio' }
 *   - auth               → 注入到 env（stdio）/ Authorization 头（http）
 * 注意 nanobot 字段名为 `type`（取值 stdio|sse|streamableHttp），而非本应用
 * 内部的 `transport`；nanobot 也会按 command/url 自动探测，显式给出 type
 * 仅用于消除 HTTP/SSE 歧义。
 *
 * 同步链路：electron 下 `platform.syncNanobotMcp` 会把 `tools.mcpServers`
 * 合并写入 config.json 并按需重启 serve 子进程；web 下同一接口降级为
 * 下载片段文件供用户手动合并。两条路径都在 platform 层，本模块不分支。
 */
import { platform } from '@/platform';
import { genId } from '@/lib/core/id';
import { joinCommand, parseCommand, readStr } from '../codec';
import type { SyncResult } from '../types';
import type { MCPConfig } from '@/types';

/** nanobot mcpServers 条目结构（键为 server 名） */
export interface NanobotMCP {
  [name: string]: {
    type?: 'stdio' | 'sse' | 'streamableHttp';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    /**
     * 工具级授权黑名单（nanowork 本地扩展字段）。
     * 引擎侧 `MCPServerConfig.disabled_tools` 挂了 `alias_generator=to_camel`，
     * 所以这里必须是 camelCase；写成 snake_case 会被当成未知字段静默忽略。
     */
    disabledTools?: string[];
  };
}

/** 归一黑名单：只留非空字符串；空集返回 undefined（不下发） */
function normalizeDisabledTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return list.length > 0 ? list : undefined;
}

/** 单条 MCPConfig → nanobot 条目 */
export function toNanobotEntry(cfg: MCPConfig): NanobotMCP[string] {
  const entry: Record<string, unknown> = {};

  if (cfg.transport === 'command') {
    const parts = parseCommand(cfg.command ?? '');
    entry.type = 'stdio';
    entry.command = parts[0];
    entry.args = parts.slice(1);
    // stdio 模式下把 auth 作为环境变量注入（如 API Key）
    if (cfg.auth && Object.keys(cfg.auth).length > 0) {
      entry.env = { ...cfg.auth };
    }
  } else {
    // url：优先用回读时保留的 urlType，避免写回时被 URL 路径推断翻转；
    // 兜底：默认按 streamableHttp；若显式含 /sse 路径则按 sse
    const isSse = /\/sse(\/|$)/i.test(cfg.endpoint ?? '');
    entry.type = cfg.urlType ?? (isSse ? 'sse' : 'streamableHttp');
    entry.url = cfg.endpoint;
    // HTTP/SSE 模式：token 注入到 Authorization 头（兼容需要 Bearer 的 MCP server）
    if (cfg.auth?.token) {
      entry.headers = { Authorization: `Bearer ${cfg.auth.token}` };
    }
  }

  // 工具级授权黑名单：空集**不下发**——引擎的缺省就是「不限制」，
  // 下发空数组只会让 config.json 多一行永远为空的噪音。
  const disabledTools = normalizeDisabledTools(cfg.disabledTools);
  if (disabledTools) entry.disabledTools = disabledTools;

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
    // 工具级授权黑名单在两个分支里都要回灌，故在分叉前取一次
    const disabledTools = normalizeDisabledTools(entry.disabledTools);

    const isStdio =
      entry.type === 'stdio' || (!entry.url && typeof entry.command === 'string');

    if (isStdio) {
      if (typeof entry.command !== 'string' || entry.command.length === 0) continue;
      const args = Array.isArray(entry.args)
        ? entry.args.filter((a): a is string => typeof a === 'string')
        : [];
      const cfg: MCPConfig = {
        id: genId(),
        name,
        transport: 'command',
        command: joinCommand([entry.command, ...args]),
        connectionStatus: 'unknown',
        syncStatus: 'idle',
        source: 'user',
        enabled: true,
      };
      if (disabledTools) cfg.disabledTools = disabledTools;
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
      connectionStatus: 'unknown',
      syncStatus: 'idle',
      source: 'user',
      enabled: true,
    };
    if (disabledTools) cfg.disabledTools = disabledTools;
    // 保留原传输类型，避免写回时 sse 被翻转为 streamableHttp
    if (entry.type === 'sse' || entry.type === 'streamableHttp') {
      cfg.urlType = entry.type;
    }
    // HTTP/SSE 正向映射时 token 写入 Authorization 头，此处解析 Bearer 回灌
    // （HTTP 头大小写不敏感，经 codec 统一归一；非字符串值容错跳过）
    const authHeader = entry.headers
      ? readStr(entry.headers as Record<string, unknown>, 'Authorization', 'authorization')
      : undefined;
    if (authHeader) {
      const bearer = authHeader.match(/^Bearer\s+(\S+)/i);
      if (bearer?.[1]) {
        cfg.auth = { token: bearer[1] };
      }
    }
    out.push(cfg);
  }
  return out;
}

/**
 * 把连接器配置同步进引擎运行时。
 *
 * 入参是**待推送的启用条目**（调用方自行用 `selectEnabledConfigs` 过滤），
 * 本函数只负责序列化与结果语义修正：
 *
 * - 空集在 electron 下**必须照常提交**：主进程对 `tools.mcpServers` 是
 *   全量替换语义，提交空字典（`toNanobotMCP([])` → `{}`）才能把已停用 /
 *   已删除的条目从 config.json 真正清空；否则网关重启仍会加载残留条目，
 *   且 hydrate 会按名称回读「复活」。web 端则无需下载空片段，直接短路。
 */
export async function syncMcpToRuntime(targets: MCPConfig[]): Promise<SyncResult> {
  const isEmpty = targets.length === 0;
  // 用 platform.env 而非 isElectron()：环境判定统一走 platform 抽象层，
  // 不在这里直接摸 window（也便于测试替换环境）。
  if (isEmpty && platform.env !== 'electron') {
    return { ok: true, changed: false, message: '未启用任何 MCP，无需同步' };
  }
  const result = await platform.syncNanobotMcp(JSON.stringify(toNanobotMCP(targets)));
  // 空集提交成功：改写 message 以准确描述「清空运行时」语义
  if (isEmpty && result.ok) {
    return { ...result, message: '未启用任何 MCP，已清空运行时的 MCP 同步' };
  }
  return result;
}

/**
 * 从引擎回读连接器配置。
 * 非 electron 端无文件系统权限：**直接短路**，不发起 IPC 往返
 * （能力判定放在 adapter 一处，避免每个 store 各写一遍 env 分支）。
 */
export async function readMcpFromRuntime(): Promise<MCPConfig[]> {
  if (platform.env !== 'electron') return [];
  const snapshot = await platform.getNanobotMcp();
  return fromNanobotMCP(snapshot);
}
