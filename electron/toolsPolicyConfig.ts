/**
 * `tools.file.default_deny_write`（FR-8.4「默认拒绝写入」）的读写转换。
 *
 * 与 `modelFallbacksConfig.ts` 同一套路：抽成独立模块是为了**能单测**，而且这几段的
 * 错法都很安静——把 `tools` 段整体替换掉会**连 mcpServers 一起吞掉**，界面上只表现为
 * 「MCP 服务器列表空了」，没有任何报错；而幂等比对比错字段则会让「点了保存但没落盘」。
 * 都属于「不靠用例就发现不了」的那类。
 *
 * 本模块**不 import electron**，只用纯逻辑，因此可以在 vitest 里直接跑。
 */

import type { NanobotFileToolsPolicy } from '../src/platform/types';

/**
 * 引擎 `FileToolsConfig` 里的字段名。
 *
 * 引擎 `Base` 是 `alias_generator=to_camel` + `populate_by_name=True`，也就是
 * **camelCase 与 snake_case 都收**，两种都认。这里取 camelCase 是因为现存
 * config.json 的 `tools` 段本来就是 camel（`cliApps` / `imageGeneration` /
 * `mcpServers`），跟着文件现状走，diff 里才只多一个键。
 */
export const DENY_WRITE_KEY = 'defaultDenyWrite';

/**
 * `DENY_WRITE_KEY` 的 snake_case 写法。
 *
 * 引擎 `Base` 两种键名都收，所以**读**的时候必须两种都认——否则一份手写成
 * `default_deny_write` 的配置会被读成「这个开关没写」（= 引擎默认 False），
 * 界面于是显示「已关闭」，而磁盘上明明是开着。
 * **写**只写 camelCase：现存 config.json 的 tools 段本来就是 camel 那套。
 */
export const DENY_WRITE_KEY_SNAKE = 'default_deny_write';

/** 引擎侧的默认值（`FileToolsConfig.default_deny_write: bool = False`） */
export const DEFAULT_DENY_WRITE = false;

/** 只接受明确的布尔：引擎 `extra` 是 ignore，写错类型会被静默丢掉、开关看起来没生效 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 从整个 config.json 的 `tools` 段解析写策略。
 *
 * `supported` 判的是「引擎认不认 `tools.file` 这个段」——**段在就认**，哪怕里面
 * 还没有这个键（那种情况就是引擎默认值 False）。真正返回 `null` 的只有
 * 「段整个不存在」和「段在但这个值不是布尔」：前者说明这份配置里压根没有
 * 文件系统工具的落点，后者说明有人把值写坏了，两者界面都得给另一句话，
 * 不能都显示成「关闭」。
 *
 * @returns 见上；解析不了时返回 `null`。
 */
export function parseFileToolsPolicy(tools: unknown): NanobotFileToolsPolicy | null {
  const root = asObject(tools);
  if (!root) return null;
  const file = asObject(root.file);
  if (!file) return null;
  // 两种键都没写 = 引擎默认值 False；「段在」本身就说明引擎认它
  if (!(DENY_WRITE_KEY in file) && !(DENY_WRITE_KEY_SNAKE in file)) {
    return { defaultDenyWrite: DEFAULT_DENY_WRITE, supported: true };
  }
  // 走到这里说明至少有一个键写了，但值可能压根不是布尔（`'true'` / `1`）——
  // `asBoolean` 对**缺失**也返回 null，所以必须先判「键在不在」再判「值对不对」，
  // 顺序反了就会把「没写」和「写坏了」都当成默认值兜底。
  const value = asBoolean(file[DENY_WRITE_KEY]) ?? asBoolean(file[DENY_WRITE_KEY_SNAKE]);
  if (value === null) return null;
  return { defaultDenyWrite: value, supported: true };
}

/**
 * 幂等签名：只比 `tools.file.defaultDenyWrite`。
 *
 * 与模型变更那套同口径——拿整份 `data` 比对是不行的，`tools` 段还有 mcpServers /
 * ssrfWhitelist 等别人也会写的键，任何外部改动都会被算成「本次有变更」，于是
 * 「再点一次保存」永远报「已修改」（而实际上什么都没改）。
 */
export function fileToolsSignature(data: Record<string, unknown>): string {
  const root = asObject(data);
  const file = root ? asObject(root.tools) : null;
  const policy = file ? asObject(file.file) : null;
  const value = policy ? asBoolean(policy[DENY_WRITE_KEY]) : null;
  return JSON.stringify({ denyWrite: value });
}

/**
 * 把 `tools.file.defaultDenyWrite` 合并进整份配置。
 *
 * **只合并这一段**：`tools` 段是多个子系统共用的（MCP 走 `tools.mcpServers`、
 * 沙箱走 `tools.restrictToWorkspace`…），整体替换会顺手把别人写的键抹掉，
 * 而 diff 上完全看不出来——MCP 服务器"集体消失"是本项目已经踩过的形态。
 * 同理 `tools.file` 段里除这个键之外的（FR-8.3 的删除留痕、批量阈值）也原样留着。
 *
 * @returns `changed` 为 false 表示「无法安全合并」，调用方应当中止并报配置格式非法，
 *   **不能**把原样的数据写回磁盘（那会把 tmp 改名流程走一遍却什么都没变）。
 */
export function mergeDefaultDenyWrite(
  data: Record<string, unknown>,
  defaultDenyWrite: boolean,
): { data: Record<string, unknown>; changed: boolean } {
  const root = asObject(data);
  if (!root) return { data, changed: false };
  // tools 段缺失时**显式补一棵 `tools.file`**：第一台机器装上 nanowork 时这份配置
  // 往往还没有这个段，而 fail-closed 会让「打开开关 → 报格式非法」显得像 bug。
  // 补的是**空壳段**（只带这一个字段），没有别的东西要往里填。
  const tools = asObject(root.tools) ?? {};
  const file = asObject(tools.file) ?? {};
  const next: Record<string, unknown> = { ...file, [DENY_WRITE_KEY]: defaultDenyWrite };
  const nextTools: Record<string, unknown> = { ...tools, file: next };
  return { data: { ...root, tools: nextTools }, changed: true };
}
