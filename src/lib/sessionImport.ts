import { genId } from '@/lib/id';
import type { Message, Session, ToolCall } from '@/types';

/**
 * nanobot 磁盘会话（JSONL 消息行）→ 本地只读 Session 的共享映射逻辑。
 * IM 频道会话与定时任务执行会话共用，避免两套解析各自漂移。
 */

/** 定时任务执行会话在本地 sessionsStore 中的 id 前缀（`cron:` + 引擎会话键） */
export const CRON_SESSION_ID_PREFIX = 'cron:';

/** 本地时间戳字符串（nanobot 无时区 ISO）→ UTC ISO；解析失败回退当前时间 */
export function toIso(ts: unknown): string {
  if (typeof ts !== 'string' || ts === '') return new Date().toISOString();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** 提取记录 content 的可展示文本（兼容字符串与 content blocks 数组） */
export function recordText(record: Record<string, unknown>): string {
  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

/** 解析 assistant 记录中的 OpenAI 风格 tool_calls 数组 */
export function parseToolCalls(
  record: Record<string, unknown>,
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const raw = record.tool_calls;
  if (!Array.isArray(raw)) return [];
  const result: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const call = item as Record<string, unknown>;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    if (typeof fn.name !== 'string') continue;
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === 'string' && fn.arguments !== '') {
      try {
        const parsed: unknown = JSON.parse(fn.arguments);
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        args = { raw: fn.arguments };
      }
    }
    result.push({
      id: typeof call.id === 'string' ? call.id : genId(),
      name: fn.name,
      args,
    });
  }
  return result;
}

/**
 * 将 nanobot JSONL 消息行映射为本地 Message 列表。
 * - user / assistant 直接映射；
 * - assistant 携带的 tool_calls 与后续 role=tool 的结果按 tool_call_id 关联，
 *   以「已完成」状态展示在对应助手消息卡片中；
 * - 无对应 assistant 的孤立 tool 行忽略。
 */
export function mapRecordsToMessages(
  key: string,
  records: Record<string, unknown>[],
): Message[] {
  // 第一遍：收集工具执行结果（tool_call_id → 文本）
  const toolResults = new Map<string, string>();
  for (const rec of records) {
    if (rec.role === 'tool' && typeof rec.tool_call_id === 'string') {
      toolResults.set(rec.tool_call_id, recordText(rec));
    }
  }

  // 第二遍：按序生成 user / assistant 消息
  const messages: Message[] = [];
  records.forEach((rec, index) => {
    const role = rec.role;
    if (role !== 'user' && role !== 'assistant') return;
    const base: Message = {
      id: `${key}#${index}`,
      role,
      content: recordText(rec),
      createdAt: toIso(rec.timestamp),
    };
    if (role === 'assistant') {
      const calls = parseToolCalls(rec);
      if (calls.length > 0) {
        const toolCalls: ToolCall[] = calls.map((c) => ({
          id: c.id,
          tool: c.name,
          args: c.args,
          sensitive: false,
          status: 'done',
          result: toolResults.get(c.id),
        }));
        base.toolCalls = toolCalls;
      }
    }
    messages.push(base);
  });
  return messages;
}

/**
 * 定时任务执行会话详情 → 本地 Session。
 * 不设置 channel（避免被识别为 IM 频道会话进入出站发送逻辑）。
 * @param key 引擎会话键（`api:cron-{taskId}`）
 * @param title 会话标题（任务名）
 * @param records JSONL 消息行
 * @param createdAt / updatedAt 会话时间（ISO）
 * @param opts.readonly 是否只读（默认 true，驱动聊天页隐藏输入框、持久化白名单排除）；
 *   设为 false 时会话可正常显示在侧边栏列表中并支持持久化
 */
export function cronRecordsToSession(
  key: string,
  title: string,
  records: Record<string, unknown>[],
  createdAt: string,
  updatedAt: string,
  opts?: { readonly?: boolean },
): Session {
  return {
    id: CRON_SESSION_ID_PREFIX + key,
    agentId: '',
    readonly: opts?.readonly !== false, // 默认 true 保持向后兼容
    title,
    messages: mapRecordsToMessages(key, records),
    permissionLog: [],
    createdAt: toIso(createdAt),
    updatedAt: toIso(updatedAt),
  };
}
