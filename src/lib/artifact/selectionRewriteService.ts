/**
 * FR-7.5 人机双写：**圈选改写**的模型调用与落库。
 *
 * ## 为什么不用会话里的那条链路
 *
 * 改写是「只改一段、只回一段」的**一次性**任务，不属于会话对话：它不该在消息流里
 * 多出一条助手回复，也不该把改写意图混进会话上下文（用户下一轮问「刚才那句」时，
 * 模型会拿改写指令当上下文）。所以这里走 `connectionManager.getClient()` 直接发一次
 * 流式请求，只收集文本、不落任何 UI 状态 —— 与 `MemoryService.summarize` 同一套做法。
 *
 * ## 三条纪律
 *
 * 1. **不改正文就不升版**。`applyRewrite` 判失败的三种情形一律不落库：选区失效、
 *    空结果、与原文相同。写进去只会污染版本链（用户回看时看到一串「v2/v3/v4 全一样」）。
 * 2. **升版只走 `recordArtifactVersion`**，不自己拼索引条目。会话 `rev` 的自增、
 *    `bodies` 的写入、镜像落盘都在那里，重写一遍就是「同一改动涨两次」。
 * 3. **失败可取消**。用户点「取消」时 `abort()` 掉底层流（按 `sessionId` 寻址），
 *    并把结果收敛成 `ok: false`，**不抛**——调用方（面板）只负责提示。
 *
 * ## 为什么改写用一个独立 sessionId
 *
 * `abort(sessionId)` 是按会话键寻址的。若借用真实会话的 id，用户取消改写会把正在
 * 进行的**正常对话**一起打断。这里固定用 `rewrite:<artifactId>`：既是隔离，
 * 也保证「同一产物并发两次改写」时后一次能取消前一次。
 */

import { connectionManager } from '@/ai/connectionManager';
import type { ChatRequest, StreamHandlers } from '@/ai/runtime/types';
import { useArtifactsStore, resolveArtifactContent } from '@/stores/artifactsStore';
import type { Artifact } from '@/types';
import { recordAppAudit } from '@/lib/audit/appAudit';
import {
  applyRewrite,
  buildRewriteSystemPrompt,
  buildRewriteUserPrompt,
  extractRewriteResult,
  isValidSelection,
  type RewriteContext,
  type TextSelection,
} from './selectionRewrite';

/** 改写请求（界面只需要这些） */
export interface RewriteRequest {
  artifact: Artifact;
  /** 要改的那一段在正文里的位置 */
  selection: TextSelection;
  /** 用户这句要求（「改成过去时」） */
  instruction: string;
}

/** 改写结果 */
export type RewriteResult =
  | { ok: true; content: string; version: number }
  | { ok: false; reason: string };

/** 进行中的改写（供界面取消） */
export interface RewriteHandle {
  /** 取消：中断底层流，结果收敛成 `ok: false` */
  cancel(): void;
  /** 结果（正常完成 / 出错 / 被取消都会解析，不 reject） */
  result: Promise<RewriteResult>;
}

/** 同一产物并发改写时，新的一次取消旧的一次 */
const activeHandles = new Map<string, { cancel(): void }>();

/** 改写用的会话键：与真实会话隔离，取消改写不会打断正常对话 */
function rewriteSessionKey(artifactId: string): string {
  return `rewrite:${artifactId}`;
}

/**
 * 取产物的**当前正文**。
 *
 * 面板上的 `artifact.content` 可能是空的（文件产物的正文在内容池，或需要回读磁盘），
 * 所以这里按索引的 `contentHash` 从 `bodies` 回填 —— 与面板 `previewResolved` 同一套
 * 判据。回填不到就用传入的 `content`（围栏产物只有快照，它本来就在里面）。
 */
function currentContent(artifact: Artifact): string {
  const store = useArtifactsStore.getState();
  const hash = store.index[artifact.id]?.contentHash;
  if (!hash) return artifact.content;
  return resolveArtifactContent(hash, store.bodies, artifact.content);
}

/**
 * 发起一次圈选改写。
 *
 * 返回**同步**的句柄（界面要立刻拿到 `cancel`），实际工作跑在后台。
 * 调用方不需要 await；等 `result` 即可。
 */
export function startSelectionRewrite(req: RewriteRequest): RewriteHandle {
  const content = currentContent(req.artifact);
  let cancelled = false;
  let cancelStream = () => undefined as void;

  const promise = (async (): Promise<RewriteResult> => {
    if (!isValidSelection(req.selection, content.length)) {
      return { ok: false, reason: '选区已失效（正文可能已切换），请重新圈选' };
    }
    const instruction = req.instruction.trim();
    if (instruction === '') return { ok: false, reason: '请先说明想怎么改' };

    const ctx: RewriteContext = {
      instruction,
      title: req.artifact.title,
      language: req.artifact.language,
    };

    let text = '';
    let errored = false;
    const handlers: StreamHandlers = {
      onToken: (chunk) => {
        text += chunk;
      },
      // 改写不需要工具 / 产物 / 过程事件：模型只要吐那一段文本
      onToolCall: () => undefined,
      onArtifact: () => undefined,
      onStatus: () => undefined,
      onDone: () => undefined,
      // 上报过错误的流，已累积的 text 不可信（前半截正常、后半截是报错），整段丢弃
      onError: () => {
        errored = true;
      },
    };

    const request: ChatRequest = {
      agentId: '',
      messages: [
        { role: 'system', content: buildRewriteSystemPrompt(ctx) },
        { role: 'user', content: buildRewriteUserPrompt(content, req.selection, ctx) },
      ],
      stream: true,
      sessionId: rewriteSessionKey(req.artifact.id),
      // 改写是纯文本任务：不给工具、不写文件，让模型没有别的出路
      toolAllow: [],
    };

    try {
      const client = await connectionManager.getClient();
      if (cancelled) return { ok: false, reason: '已取消' };
      cancelStream = () => {
        void client.abort(request.sessionId ?? '').catch(() => undefined);
      };
      await client.chat(request, handlers);
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      // 取消导致的 abort 不该报成「改写失败」（用户自己按的）
      if (cancelled || name === 'AbortError') return { ok: false, reason: '已取消' };
      return { ok: false, reason: '改写请求失败，请检查连接后重试' };
    }

    if (cancelled) return { ok: false, reason: '已取消' };
    if (errored) return { ok: false, reason: '改写请求失败，请检查连接后重试' };

    const rewritten = extractRewriteResult(text);
    const applied = applyRewrite(content, req.selection, rewritten);
    if (!applied.ok) return applied;

    // 落库：只走 store 动作（rev 自增 / bodies 写入 / 镜像落盘都在那里）
    const store = useArtifactsStore.getState();
    store.recordArtifactVersion(req.artifact.id, {
      ...req.artifact,
      content: applied.content,
      // 改写产物不再带指纹：正文已经是全文，指纹只会让下一次寻址对不上
      fingerprint: undefined,
      createdAt: new Date().toISOString(),
    });

    const version = useArtifactsStore.getState().index[req.artifact.id]?.version ?? 1;
    recordAppAudit({
      action: 'artifact.rewrite',
      targetId: req.artifact.id,
      targetLabel: req.artifact.title ?? req.artifact.path,
      detail: { instruction, from: req.selection.start, to: req.selection.end, version },
    });
    return { ok: true, content: applied.content, version };
  })();

  const handle: RewriteHandle = {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancelStream();
    },
    result: promise,
  };

  // 同一产物只保留最新一次（旧的那次自行 abort，避免两段改写叠在一起）
  activeHandles.get(req.artifact.id)?.cancel();
  activeHandles.set(req.artifact.id, handle);
  void promise.finally(() => {
    if (activeHandles.get(req.artifact.id) === handle) activeHandles.delete(req.artifact.id);
  });

  return handle;
}
