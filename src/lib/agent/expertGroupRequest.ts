/**
 * 由「会话绑定的专家团」构造引擎侧编排请求（FR-2.4 路径②）。
 *
 * 为什么单独成一个可单测的纯函数，而不是内联进 `sessionsStore`——
 * 这段映射里有两处判断错了**都不会报错**，只会静默改变行为：
 *
 * 1. 「什么时候**不**该触发编排」：成员不足时若仍下发 `expert_group`，引擎的默认
 *    `aggregate='lead'` 会让同一名成员多跑一轮收口（白白多花一倍 token）；
 * 2. 「成员模型要不要下发」：把已删除的预设名发下去，引擎会直接报错——
 *    与 `resolveTurnModel` 是同一类坑（见 `lib/agent/agentBinding.ts` 的长注释）。
 *
 * 集中在这里之后，两者都能用普通断言覆盖，不必拉起整个 store 与流式链路。
 */

import type { Agent, ExpertGroup } from '@/types';
import type { ExpertGroupMember, ExpertGroupRequest } from '@/ai/runtime/types';

/**
 * 触发编排的最少**启用**成员数。
 *
 * 只有一名启用成员时**不**下发 `expert_group`：那与「单专家一轮」在结果上没有区别，
 * 而引擎默认的 `aggregate='lead'` 会让这唯一一名成员再跑一轮收口——纯属多花一倍
 * token。不足这个数就退回「以团内首位启用成员为 agentId 的单专家一轮」（既有行为）。
 */
export const MIN_MEMBERS_FOR_ORCHESTRATION = 2;

/**
 * 构造专家团编排请求；不该编排时返回 `undefined`。
 *
 * @param group 会话绑定的专家团（取不到时传 `undefined`）
 * @param agents 当前 Agent 目录（用于解析成员的人设 / 工具 / 模型）
 * @param availablePresetIds 可用模型预设 id 集合；**`null` 表示目录未加载**（不筛），
 *   语义与 `availablePresetIds()` 一致
 */
export function buildExpertGroupRequest(
  group: ExpertGroup | undefined,
  agents: readonly Agent[],
  availablePresetIds: ReadonlySet<string> | null,
): ExpertGroupRequest | undefined {
  // 停用的团不触发——与 `createSession` 只认启用团一致
  if (!group || !group.enabled) return undefined;

  const byId = new Map(agents.map((a) => [a.id, a]));
  const members: ExpertGroupMember[] = [];
  for (const id of group.memberIds) {
    const agent = byId.get(id);
    // 成员被删除或停用 → 跳过。判据是「**当下**仍在且启用」，与 `createSession`
    // 取 leader 的判据保持一致；否则会把已删成员的 id 发下去，引擎按 id 找不到人。
    if (!agent || !agent.enabled) continue;
    members.push({
      id: agent.id,
      name: agent.name,
      ...(agent.systemPrompt.trim() !== '' ? { systemPrompt: agent.systemPrompt } : {}),
      // 判据是「不是 undefined」：空数组是**已声明的空白名单**（一个工具都不许），
      // 用真值判断会把它当成「未声明」而静默放开全部工具。
      ...(agent.toolAllow !== undefined ? { toolAllow: agent.toolAllow } : {}),
      ...(agent.toolDeny !== undefined ? { toolDeny: agent.toolDeny } : {}),
      // 成员模型同样只在「预设仍存在」时下发；目录未加载（null）时不筛。
      // 理由与 `resolveTurnModel` 完全一致：引擎收到未知预设会直接报错。
      ...(agent.model && (availablePresetIds === null || availablePresetIds.has(agent.model))
        ? { model: agent.model }
        : {}),
    });
  }

  if (members.length < MIN_MEMBERS_FOR_ORCHESTRATION) return undefined;

  // lead 缺省交由引擎取首位成员（与 UI 文案「由首位成员担任协调 Agent」一致），
  // aggregate / maxConcurrent 也用引擎默认值——客户端暂未提供这两个控件。
  return { mode: group.mode, members };
}
