/**
 * 每轮读一次项目共享记忆，把它变成提示词段（渲染在 `lib/project/projectMemory.ts`）。
 *
 * ## 为什么是「每轮预取」而不是缓存一份在本地
 *
 * 共享记忆的写入方是**别人**（项目负责人 / 组织管理员）。缓存到本机会有两个后果：
 * ① 别人刚写的约定，我这边要等重启才看到 —— 而这正是共享记忆最容易出问题的场景
 *    （两个人按不同的约定各干一半）；② 缓存迟早要落盘，落盘就有第二份真相。
 *
 * 代价是每轮多一次 GET。它和知识库检索走同一个 token 通道，超时预算也是同一档
 * （`PROJECT_MEMORY_TIMEOUT_MS`），失败一律降级成「本轮没有共享记忆」。
 *
 * ## fail-soft 的四条（与 `agentKnowledgeTurn.ts` 逐条对应）
 *
 * - **会话不属任何项目**：直接跳过，不发请求（绝大多数会话是这种）。
 * - **没有 provider**（未登录 / 测试环境）：跳过。
 * - **超时 / 失败**：当本轮没有共享记忆，绝不抛给调用方 —— 云端慢不该让用户发不出消息。
 * - **失败必须留痕**：`console.warn` 一行。静默降级不能连日志都静默。
 *
 * ## 为什么不带项目名
 *
 * 段里那句「以下是「X」项目的共享记忆」需要项目名，而会话上只有 `projectId`。
 * 为了一个展示用的名字多打一次 `GET /api/projects/{id}` 不划算（每轮一次），
 * 所以 `projectName` 留成可选参数：调用方顺手有就传，没有就退化成「本项目」。
 */

import type { ApiResult } from '@/lib/net/authedRequest';
import { buildProjectMemorySection } from '@/lib/project/projectMemory';
import type { ProjectMemory } from '@/lib/project/projectClient';

/** 等云端的最长时间。超过就当本轮没有共享记忆。 */
export const PROJECT_MEMORY_TIMEOUT_MS = 2000;

export interface ProjectMemoryFetchInput {
  projectId: string;
}

/** 读共享记忆的实现（由 `sync/runtime` 注入真实网关，用例直接传桩）。 */
export type ProjectMemoryFetchFn = (
  input: ProjectMemoryFetchInput,
) => Promise<ApiResult<ProjectMemory>>;

/**
 * 一次性注入口（同 `setKnowledgeSearchProvider` 的手法）。
 *
 * 为什么不直接 `import '@/sync/runtime'`：那个模块订阅了 `sessionsStore`，而本模块
 * 被 `sessionsStore` 使用 —— 直接 import 必成环。
 */
let memoryProvider: ProjectMemoryFetchFn | null = null;

export function setProjectMemoryProvider(fn: ProjectMemoryFetchFn | null): void {
  memoryProvider = fn;
}

export function getProjectMemoryProvider(): ProjectMemoryFetchFn | null {
  return memoryProvider;
}

export type ProjectMemorySkipReason =
  | 'injected'
  | 'no-project'
  | 'not-logged-in'
  | 'timeout'
  | 'error'
  | 'empty';

export interface ProjectMemoryTurnResult {
  /** 要注入的段；空串 = 本轮不注入（装配器整段跳过） */
  section: string;
  /** 注入的字符数（日志/调试用） */
  chars: number;
  /** 读到的那一版；没注入时为 0 */
  rev: number;
  reason: ProjectMemorySkipReason;
  message: string;
}

const SKIPPED = (reason: ProjectMemorySkipReason, message = ''): ProjectMemoryTurnResult => ({
  section: '',
  chars: 0,
  rev: 0,
  reason,
  message,
});

class ProjectMemoryTimeout extends Error {}

/**
 * 本轮要不要读共享记忆、读到什么。
 *
 * 调用方（`sessionsStore.streamAssistantReply`）**不 try/catch** —— 本函数承诺不抛。
 */
export async function resolveProjectMemorySection(input: {
  /** 会话所属项目；缺省 = 不属于任何项目 → 跳过 */
  projectId?: string;
  projectName?: string;
  /** 显式指定读取实现（用例用）；缺省取注入的 provider */
  fetch?: ProjectMemoryFetchFn | null;
  timeoutMs?: number;
}): Promise<ProjectMemoryTurnResult> {
  const projectId = (input.projectId ?? '').trim();
  if (projectId === '') return SKIPPED('no-project');

  const fetchMemory = input.fetch ?? memoryProvider;
  if (!fetchMemory) return SKIPPED('not-logged-in');

  const timeoutMs = Math.max(1, input.timeoutMs ?? PROJECT_MEMORY_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProjectMemoryTimeout(`共享记忆读取超时（${timeoutMs}ms）`)),
      timeoutMs,
    );
  });

  let result: ApiResult<ProjectMemory>;
  try {
    result = await Promise.race([fetchMemory({ projectId }), timeout]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '共享记忆读取失败';
    const reason: ProjectMemorySkipReason =
      error instanceof ProjectMemoryTimeout ? 'timeout' : 'error';
    warn(reason, message);
    return SKIPPED(reason, message);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!result.ok) {
    // 401 单独一类：不是「这次读失败」，是「这轮根本没登录」（与知识库同口径）
    const reason: ProjectMemorySkipReason = result.unauthorized ? 'not-logged-in' : 'error';
    warn(reason, `${result.status} ${result.message}`);
    return SKIPPED(reason, result.message);
  }

  const section = buildProjectMemorySection({
    text: result.data.text,
    projectName: input.projectName,
  });
  // 空正文 = 项目还没写共享记忆 → 不注入（不要塞占位句，见 projectMemory.ts 文件头第 3 条）
  if (section === '') return SKIPPED('empty');
  return { section, chars: section.length, rev: result.data.rev, reason: 'injected', message: '' };
}

function warn(reason: ProjectMemorySkipReason, message: string): void {
  console.warn(
    `[project-memory] 本轮未注入共享记忆：${reason}${message ? ` — ${message}` : ''}`,
  );
}
