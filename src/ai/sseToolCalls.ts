/**
 * 标准 OpenAI 风格 tool_calls 增量解析器。
 *
 * 背景：nanobot 当前版本（经源码确认）的 /v1/chat/completions 仅流式返回
 * `delta.content` 纯文本，**不**下发 `delta.tool_calls`。但作为对标 WorkBuddy
 * 的客户端，本模块按 OpenAI 规范实现 tool_calls 的增量拼接，使未来 nanobot
 * 升级（或用户在前置代理中补全 tool_calls）时无需改动上层：
 *
 *   delta.tool_calls = [{ index, id?, type?, function: { name?, arguments? } }]
 *
 * 同名 function.arguments 以增量方式拼接（OpenAI 流式契约）。
 * 当某次 delta 不含 tool_calls 时，本解析器静默跳过，不影响文本流。
 */

import type { ToolCallEvent } from './types';
import { isSensitiveTool } from '@/lib/constants';

/** 流式累计的单个工具调用中间态（按 index 拼接） */
interface PartialToolCall {
  index: number;
  id?: string;
  type?: string;
  name?: string;
  argsBuffer: string;
  /** 已发 pending 事件，避免重复 */
  emittedPending: boolean;
}

/** SSE delta 中的原始 tool_call 片段（结构对齐 OpenAI） */
export interface RawToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * 增量解析器：跨多次 delta 维护工具调用拼接状态。
 * 调用方在每次收到 delta.tool_calls 时调用 `ingest`，
 * 在流结束或某工具调用参数闭合时调用 `flush` 取出完整 ToolCallEvent。
 */
export class ToolCallAccumulator {
  private partials = new Map<number, PartialToolCall>();
  private order: number[] = [];

  /** 摄入一次 delta.tool_calls 片段，返回本批新进入 pending 的事件 */
  ingest(deltas: RawToolCallDelta[]): ToolCallEvent[] {
    const pendingEvents: ToolCallEvent[] = [];
    for (const d of deltas) {
      const idx = d.index ?? 0;
      let p = this.partials.get(idx);
      if (!p) {
        p = { index: idx, argsBuffer: '', emittedPending: false };
        this.partials.set(idx, p);
        this.order.push(idx);
      }
      if (d.id) p.id = d.id;
      if (d.type) p.type = d.type;
      if (d.function?.name) p.name = d.function.name;
      if (d.function?.arguments) p.argsBuffer += d.function.arguments;

      // 首次拿到 name 即视为工具已声明，发出 pending（等待权限门控）
      if (p.name && !p.emittedPending) {
        p.emittedPending = true;
        pendingEvents.push(this.toEvent(p, 'pending'));
      }
    }
    return pendingEvents;
  }

  /**
   * 流结束/参数闭合后，将所有已声明（有 name）的工具调用以 done 状态吐出。
   * 返回每个工具调用的完整事件（含解析后的 args）。
   */
  flush(): ToolCallEvent[] {
    const events: ToolCallEvent[] = [];
    for (const idx of this.order) {
      const p = this.partials.get(idx);
      if (!p || !p.name) continue;
      events.push(this.toEvent(p, 'done'));
    }
    this.partials.clear();
    this.order = [];
    return events;
  }

  private toEvent(p: PartialToolCall, status: ToolCallEvent['status']): ToolCallEvent {
    const tool = (p.name ?? 'unknown').replace(/^nanobot\//, '');
    let args: Record<string, unknown> = {};
    if (p.argsBuffer.trim()) {
      try {
        args = JSON.parse(p.argsBuffer);
      } catch {
        // 参数非严格 JSON（罕见），原样保留为字符串
        args = { raw: p.argsBuffer };
      }
    }
    return {
      id: p.id ?? `tc-${p.index}-${tool}`,
      tool,
      args,
      sensitive: isSensitiveTool(tool),
      status,
    };
  }
}

/**
 * 从单条 SSE delta 的 tool_calls 字段提取原始片段（防御性解析）。
 * 返回空数组表示本条 delta 不含工具调用。
 */
export function extractRawToolCalls(
  delta: unknown,
): RawToolCallDelta[] {
  const arr = (delta as { tool_calls?: RawToolCallDelta[] })?.tool_calls;
  return Array.isArray(arr) ? arr : [];
}
