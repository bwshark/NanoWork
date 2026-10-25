/**
 * 每轮检索一次知识库，把命中变成提示词段（`agent/agentKnowledge.ts` 负责渲染）。
 *
 * ## 为什么是"每轮预取"而不是给引擎加一个检索工具
 *
 * 1. **凭据不出渲染层**：检索要带账户 access token。做成引擎工具就得把 token
 *    写进引擎配置（那是一个长期存活的文件，且引擎进程还跑着用户自己的代码）。
 *    预取的调用方是渲染层，token 只在这一跳里出现。
 * 2. **权限收窄只有一次解释**：云端按角色过滤 + 按绑定收窄都在服务端做，
 *    引擎侧不需要知道"谁能看哪本库"这套规则。工具形态则要在引擎里再实现一遍
 *    "这次调用的用户是谁"，而引擎根本没有账户概念。
 * 3. 代价是**不能多轮追问检索**（模型拿不到"再搜一次更具体的关键词"的能力）。
 *    这是本期明确接受的边界，写进 FR-4.7 的"未做"里，不假装已有。
 *
 * ## fail-soft 的四条
 *
 * - **没有 provider**（未登录 / 测试环境）：直接跳过，不发请求。
 * - **超时**：`KNOWLEDGE_TIMEOUT_MS` 到点就当没有资料。云端是可选能力，
 *   它慢不能变成"整轮回复都慢"。
 * - **失败**（网络 / 4xx / 5xx）：一律当"这轮没有资料"，绝不抛给调用方
 *   —— 检索失败不该让用户连问题都发不出去。
 * - **失败必须留痕**：`console.warn` 打一行（带 reason / status）。这一整套是
 *   "静默降级"设计的典型，而本项目的教训是**静默降级不能连日志都静默**，
 *   否则"专家绑了库却从不引用"会被当成模型不听话查一整天。
 */

import {
  buildKnowledgeSection,
  hasKnowledgeBinding,
  type AgentKnowledgeBinding,
} from '@/lib/agent/agentKnowledge';
import type { KbApiResult, KbSearchHit } from '@/lib/kb/kbClient';

/** 等云端的最长时间。超过就当本轮没有资料。 */
export const KNOWLEDGE_TIMEOUT_MS = 2500;

/** 每轮取几条候选（渲染时还会按预算再裁一次）。 */
export const KNOWLEDGE_TOP_K = 5;

export interface KnowledgeSearchInput {
  orgId: string;
  /** 空数组 = 该组织里我可见的全部库（见 `agent/agentKnowledge.ts` 文件头第 1 条） */
  kbIds: string[];
  query: string;
  topK: number;
}

/** 检索函数（由 `sync/runtime` 注入真实实现，用例直接传桩）。 */
export type KnowledgeSearchFn = (input: KnowledgeSearchInput) => Promise<KbApiResult<KbSearchHit[]>>;

/**
 * 检索实现的一次性注入口。
 *
 * 为什么不直接 `import '@/sync/runtime'`：那个模块订阅了全部 store（含
 * `sessionsStore`），而本模块被 `sessionsStore` 使用 —— 直接 import 必成环。
 * 与 `lib/audit/appAudit.ts` 的 `setAppAuditActorProvider` 是同一个手法。
 */
let searchProvider: KnowledgeSearchFn | null = null;

export function setKnowledgeSearchProvider(fn: KnowledgeSearchFn | null): void {
  searchProvider = fn;
}

export function getKnowledgeSearchProvider(): KnowledgeSearchFn | null {
  return searchProvider;
}

/** 本轮知识库检索的结果（`reason` 供测试与日志定位，不进提示词）。 */
export type KnowledgeSkipReason =
  | 'injected'
  | 'no-binding'
  | 'no-query'
  | 'not-logged-in'
  | 'timeout'
  | 'error'
  | 'empty';

export interface KnowledgeTurnResult {
  /** 要注入的段；空串 = 本轮不注入（装配器会整段跳过） */
  section: string;
  hitCount: number;
  reason: KnowledgeSkipReason;
  /** 失败时的原因（服务端 detail / 超时说明），仅用于日志与排查 */
  message: string;
}

const SKIPPED = (reason: KnowledgeSkipReason, message = ''): KnowledgeTurnResult => ({
  section: '',
  hitCount: 0,
  reason,
  message,
});

class KnowledgeTimeout extends Error {}

/**
 * 本轮要不要检索、检索到什么。
 *
 * 调用方（`sessionsStore.streamAssistantReply`）**不 try/catch** —— 本函数承诺不抛。
 */
export async function resolveKnowledgeSection(input: {
  binding?: AgentKnowledgeBinding;
  query: string;
  /** 显式指定检索实现（用例用）；缺省取注入的 provider */
  search?: KnowledgeSearchFn | null;
  timeoutMs?: number;
}): Promise<KnowledgeTurnResult> {
  if (!hasKnowledgeBinding(input.binding)) return SKIPPED('no-binding');
  const query = input.query.trim();
  if (query === '') return SKIPPED('no-query');

  const search = input.search ?? searchProvider;
  if (!search) return SKIPPED('not-logged-in');

  const timeoutMs = Math.max(1, input.timeoutMs ?? KNOWLEDGE_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new KnowledgeTimeout(`知识库检索超时（${timeoutMs}ms）`)), timeoutMs);
  });

  let result: KbApiResult<KbSearchHit[]>;
  try {
    result = await Promise.race([
      search({
        orgId: input.binding.orgId,
        kbIds: input.binding.kbIds,
        query,
        topK: KNOWLEDGE_TOP_K,
      }),
      timeout,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '知识库检索失败';
    const reason: KnowledgeSkipReason = error instanceof KnowledgeTimeout ? 'timeout' : 'error';
    warnOnce(reason, message);
    return SKIPPED(reason, message);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!result.ok) {
    // 401 单独一类：它不是"这次检索失败"，是"这轮根本不该发"（token 过期）。
    // 混进 error 会让日志看起来像云端故障，实际是登录态问题。
    const reason: KnowledgeSkipReason = result.unauthorized ? 'not-logged-in' : 'error';
    warnOnce(reason, `${result.status} ${result.message}`);
    return SKIPPED(reason, result.message);
  }

  const section = buildKnowledgeSection(result.data);
  if (section === '') return SKIPPED('empty');
  return { section, hitCount: result.data.length, reason: 'injected', message: '' };
}

function warnOnce(reason: KnowledgeSkipReason, message: string): void {
  // 用 console 而不是 toast：超时/网络抖动不该在聊天界面上反复弹提示，
  // 但排查"为什么没引用资料"时必须能在这里看到一行。
  console.warn(`[knowledge] 本轮未注入知识库资料：${reason}${message ? ` — ${message}` : ''}`);
}
