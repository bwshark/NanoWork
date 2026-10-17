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

import type { NanobotFileToolsPolicy, NanobotPathRule } from '../src/platform/types';

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

/**
 * [LOCAL PATCH] FR-8.13：路径规则在 `tools.file` 下的键名（camel + snake）。
 *
 * 与 `DENY_WRITE_KEY` 同一套理由：引擎 `Base` 两种键名都收，**读**要两种都认，
 * **写**只写 camel（跟随现存 config.json 的 tools 段现状）。
 */
export const PATH_RULES_KEY = 'pathRules';
export const PATH_RULES_KEY_SNAKE = 'path_rules';

/** 三种动作（与引擎 `security/path_rules.ACTION_KINDS` 同序） */
const RULE_ACTIONS = ['read', 'write', 'delete'] as const;
const RULE_VERDICTS = ['allow', 'deny'] as const;

/** 引擎侧的默认值（`FileToolsConfig.path_rules: list = []`） */
export const DEFAULT_PATH_RULES: never[] = [];

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
 * [LOCAL PATCH] FR-8.13：把 `tools.file.pathRules` 收敛成界面可直接渲染的规则。
 *
 * **坏条目丢掉而不是抛错**，且**绝不猜**：一条写错的规则（`action` 拼错、`path`
 * 不是字符串）丢掉它，其余的照常生效；整体形状不对（不是数组）当成「没有规则」。
 * 反过来抛错会让「改错一行」表现为「整个安全分区打不开」—— 而用户此刻最需要
 * 看见其它规则还在。
 *
 * ⚠️ 这里只做**形状**校验，不解析路径语义（那在引擎侧 `normalize_path_rules`）。
 * 两份都做等于两份真相，而客户端这份一旦与引擎不一致，界面显示的就是假的。
 */
export function parsePathRules(value: unknown): NanobotPathRule[] {
  if (!Array.isArray(value)) return [];
  const rules: NanobotPathRule[] = [];
  for (const item of value) {
    const entry = asObject(item);
    if (!entry) continue;
    const path = entry.path;
    if (typeof path !== 'string' || path.trim() === '') continue;
    const action: Record<string, string> = {};
    const rawAction = asObject(entry.action);
    if (rawAction) {
      for (const kind of RULE_ACTIONS) {
        const verdict = rawAction[kind];
        if (typeof verdict === 'string' && (RULE_VERDICTS as readonly string[]).includes(verdict)) {
          action[kind] = verdict;
        }
      }
    }
    // 一个有效动作都没有的条目对引擎毫无意义（引擎会连规则一起丢掉），
    // 界面也没必要显示一个空行
    if (Object.keys(action).length === 0) continue;
    rules.push({ path, action });
  }
  return rules;
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
    return {
      defaultDenyWrite: DEFAULT_DENY_WRITE,
      supported: true,
      pathRules: parsePathRules(file[PATH_RULES_KEY] ?? file[PATH_RULES_KEY_SNAKE]),
    };
  }
  // 走到这里说明至少有一个键写了，但值可能压根不是布尔（`'true'` / `1`）——
  // `asBoolean` 对**缺失**也返回 null，所以必须先判「键在不在」再判「值对不对」，
  // 顺序反了就会把「没写」和「写坏了」都当成默认值兜底。
  const value = asBoolean(file[DENY_WRITE_KEY]) ?? asBoolean(file[DENY_WRITE_KEY_SNAKE]);
  if (value === null) return null;
  return {
    defaultDenyWrite: value,
    supported: true,
    // FR-8.13：规则**缺省就是空数组**（引擎默认值），不影响 `supported` 的判定
    pathRules: parsePathRules(file[PATH_RULES_KEY] ?? file[PATH_RULES_KEY_SNAKE]),
  };
}

/**
 * 幂等签名：只比 `tools.file.defaultDenyWrite` 与 `tools.file.pathRules`。
 *
 * 与模型变更那套同口径——拿整份 `data` 比对是不行的，`tools` 段还有 mcpServers /
 * ssrfWhitelist 等别人也会写的键，任何外部改动都会被算成「本次有变更」，于是
 * 「再点一次保存」永远报「已修改」（而实际上什么都没改）。
 *
 * [LOCAL PATCH] FR-8.13：规则也进签名。少了它，「删掉一条规则再保存」会被判成
 * 「没有变更」而不写盘 —— 而用户看到的却是「保存成功」。
 */
export function fileToolsSignature(data: Record<string, unknown>): string {
  const root = asObject(data);
  const file = root ? asObject(root.tools) : null;
  const policy = file ? asObject(file.file) : null;
  const value = policy ? asBoolean(policy[DENY_WRITE_KEY]) : null;
  const rules = policy ? parsePathRules(policy[PATH_RULES_KEY] ?? policy[PATH_RULES_KEY_SNAKE]) : [];
  // 按路径排序后再签名：规则的**书写顺序不改变语义**（引擎按「最具体匹配」裁决，
  // 不按先后）。不排序的话，用户只是把列表整理整齐就会触发一次网关重启。
  const canonical = [...rules].sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify({ denyWrite: value, pathRules: canonical });
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

/**
 * [LOCAL PATCH] FR-8.13：把 `tools.file.pathRules` 合并进整份配置。
 *
 * 与 `mergeDefaultDenyWrite` 同套路（只合并这一段、显式补空壳段），差别只在
 * 值是**数组**：整体替换语义在这里是对的（规则表就该整表替换），但 `tools` 段
 * 与 `tools.file` 段里别人的键仍然原样保留。
 *
 * @returns `changed` 为 false 表示配置形状不安全（`tools` 不是对象），调用方应中止。
 */
export function mergePathRules(
  data: Record<string, unknown>,
  pathRules: NanobotPathRule[],
): { data: Record<string, unknown>; changed: boolean } {
  const root = asObject(data);
  if (!root) return { data, changed: false };
  const tools = asObject(root.tools) ?? {};
  const file = asObject(tools.file) ?? {};
  // 只写**有效动作**，且键序固定（read / write / delete）：落盘的形状稳定，
  // 用户两次保存同一份规则时 diff 才是空的。
  const normalized = pathRules.map((rule) => ({
    path: rule.path,
    action: Object.fromEntries(
      RULE_ACTIONS.filter((kind) => rule.action[kind] !== undefined).map((kind) => [
        kind,
        rule.action[kind],
      ]),
    ),
  }));
  const next: Record<string, unknown> = { ...file, [PATH_RULES_KEY]: normalized };
  const nextTools: Record<string, unknown> = { ...tools, file: next };
  return { data: { ...root, tools: nextTools }, changed: true };
}
