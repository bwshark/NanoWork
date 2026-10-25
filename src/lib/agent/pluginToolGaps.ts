/**
 * 插件声明工具 vs 当前 Agent 工具白名单的落差（FR-3.12 纪律③ 的前端镜像）。
 *
 * ## 为什么存在
 *
 * 引擎侧 `nanobot/nanobot/agent/hooks/plugin_tools.py::policy_gaps` 在每轮第一次
 * 工具调用时算一遍「声明了、但当前 Agent 基线（tool_allow / tool_deny）拿不到」的
 * 工具并 `warn`。前端插件列表此前完全不知道这件事——本模块把同一套语义搬到界面，
 * 让用户在**装完插件、还没跑起来**时就看见「我声明了、但当前 Agent 白名单不给我」
 * 的落差，而不是等到跑起来才发现「我声明了却什么都没发生」。
 *
 * ## 为什么是复刻，不是另立一套
 *
 * 判据**复用引擎 `security/workspace_access.py::agent_blocks_tool`** 的同一种规则，
 * 而不是在前端自己推一个「基线允许集」：两套真相一旦分叉，错的后果是**给用户看一个
 * 错的落差**——比不报更糟，因为它会把人引去改一个本来没问题的地方。引擎侧是
 * `tool_allow` 为 `None` 表示「未声明限制 = 放行全部」，为 `frozenset()` 表示
 * 「显式空集 = 全拒」；前端用 `undefined` 对应前者、`[]` 对应后者，语义一一对应。
 */

/** 一个被收窄的声明工具 */
export interface PluginToolGap {
  /** 工具名（来自插件声明的 `permissions.tools`，已 trim） */
  tool: string;
  /**
   * 被收窄的原因，与引擎 `agent_blocks_tool` 的两类拦截对齐：
   * - `'denied'`：命中 Agent 工具黑名单（`toolDeny`）；
   * - `'not-allowed'`：不在 Agent 工具白名单内（`toolAllow` 显式列了别的）。
   */
  reason: 'denied' | 'not-allowed';
}

/**
 * 复刻引擎 `agent_blocks_tool(scope, tool_name)`。
 *
 * 规则（与引擎逐字对应）：
 * 1. `deny` 命中 → 拦截（优先级最高，盖过白名单）；
 * 2. `allow === undefined` → 放行（Agent 未声明工具限制）；
 * 3. `allow === []` → 全拒（显式空集是合法声明，不是「没声明」）；
 * 4. 否则不在 `allow` 内 → 拦截。
 *
 * 返回 `null` 表示放行；返回原因字符串表示被拦截。
 */
export function agentBlocksTool(
  allow: string[] | undefined,
  deny: string[] | undefined,
  tool: string,
): 'denied' | 'not-allowed' | null {
  const name = tool.trim();
  // 空名不参与：引擎 normalize 也会把含空白/控制符的名丢掉的，这里保持同一口径。
  if (name.length === 0) return null;

  const denySet = new Set((deny ?? []).map((t) => t.trim()));
  if (denySet.has(name)) return 'denied';

  // 关键分支：undefined = Agent 压根没声明工具限制 = 放行全部。
  // 这一支绝不能被「当成空集」——那是 FR-3.12 文档里反复警告的
  // 「声明为空 = 不约束」式安全方向静默失效的另一面。
  if (allow === undefined) return null;

  const allowSet = new Set(allow.map((t) => t.trim()));
  if (allowSet.has(name)) return null;
  return 'not-allowed';
}

/**
 * 计算一个插件声明工具里、被当前 Agent 白名单收窄的那部分。
 *
 * @param declaredTools 插件清单 `permissions.tools`（已声明想要的工具）
 * @param allow         当前 Agent 的 `toolAllow`（undefined = 未声明限制）
 * @param deny          当前 Agent 的 `toolDeny`
 * @returns 按工具名排序的落差数组；无任何收窄时返回空数组。
 */
export function computePluginToolGaps(
  declaredTools: string[],
  allow: string[] | undefined,
  deny: string[] | undefined,
): PluginToolGap[] {
  const gaps: PluginToolGap[] = [];
  for (const tool of declaredTools) {
    const reason = agentBlocksTool(allow, deny, tool);
    if (reason !== null) gaps.push({ tool: tool.trim(), reason });
  }
  // 按工具名排序，保证界面与测试稳定（引擎 policy_gaps 也是 sorted）。
  gaps.sort((a, b) => a.tool.localeCompare(b.tool));
  return gaps;
}
