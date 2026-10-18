import { genId } from '@/lib/id';
import { deletedFilePathFrom, deriveFileArtifacts, fileArtifactId } from '@/lib/fileArtifact';
import { extractArtifacts } from '@/ai/runtime/nanobotHttp/artifactExtractor';
import type { Artifact, Message, Session, ToolCall } from '@/types';

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
 * 导入会话的**文本产物**补齐：AssistantMessage 的「执行过程 / 产物」两块数据源
 * 统一挂在 `Session` 上，这里补 `message.artifacts` 与调用方入库所需的 `messageId`。
 */
export function attachImportedTextArtifacts(session: Session): ImportedArtifactRecord[] {
  const records: ImportedArtifactRecord[] = [];
  for (const message of session.messages) {
    // 任务会话是在流结束后对最终文本跑一次提取（`chat.ts` 的 `extractArtifacts`），
    // 这里复用同一个提取器避免漂移；不这么做，同一句带 ``` 围栏的回复在任务里
    // 是内联富产物、在助理里却只是代码块——渲染就分叉了。
    if (message.role !== 'assistant' || !message.content) continue;
    for (const ev of extractArtifacts(message.content)) {
      const artifact: Artifact = {
        id: ev.id,
        type: ev.type,
        title: ev.title,
        content: ev.content,
        createdAt: message.createdAt,
        ...(ev.language !== undefined ? { language: ev.language } : {}),
        ...(ev.url !== undefined ? { url: ev.url } : {}),
      };
      message.artifacts = [...(message.artifacts ?? []), artifact];
      records.push({ messageId: message.id, artifact });
    }
  }
  return records;
}

/** `attachImportedFileArtifacts` 返回的单条待登记产物（`messageId` 供索引切片归属） */
export interface ImportedArtifactRecord {
  messageId: string;
  artifact: Artifact;
}

export interface ImportedArtifactResult {
  /** 按发生顺序排列的产物记录（调用方逐条 `recordArtifact` 入索引切片） */
  records: ImportedArtifactRecord[];
  /** 被后续删除工具收回的产物 id（调用方 `removeArtifacts` 摘除） */
  removedIds: string[];
}

/**
 * 从导入会话（频道 / 定时任务）的已完成工具调用推导**文件产物**。
 *
 * 这类会话的推理发生在引擎侧（IM / cron），本地只有磁盘 JSONL 的重放，收不到
 * 流式 Runtime 回调（`onProcessTool`），产物登记因此完全缺位——右侧「产物」
 * 面板恒为「暂无内容」。这里按发生顺序重放每条助手消息的 toolCalls，判据与
 * 任务会话的 `handleProcessTool` 完全一致（同一套 `deriveFileArtifacts` 白名单、
 * 同样的「删除先于登记」「本会话已见过的路径 = 改写」语义），保证两类会话的
 * 产物卡片与面板表现相同。
 *
 * 就地修改 `session.messages`（把产物挂上 `message.artifacts`，消息流卡片的
 * 数据源）；入库（`recordArtifact` / `removeArtifacts`）由调用方完成——本模块
 * 保持纯计算，不 import store。
 *
 * 幂等性：同一份 JSONL 重放（轮询刷新）会得到相同产物内容，`recordArtifact`
 * 对同 id 同内容直接去重，不会反复升版。
 */
export function attachImportedFileArtifacts(session: Session): ImportedArtifactResult {
  const records: ImportedArtifactRecord[] = [];
  const removedIds: string[] = [];
  /** 本会话内已产出过产物的路径（同路径再写 = 改写既有文件，而非新建） */
  const seenPaths = new Set<string>();

  for (const message of session.messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      // 与流式路径同一纪律：只认成功落地的调用，失败的写入不能凭空造卡片
      if (call.status !== 'done') continue;
      // 「收回」优先于「登记」：删除工具成功后，早先那张卡片必须消失
      // （模型写完临时脚本自己 delete_file 清理是真实场景，面板不能留死卡片）
      const deletedPath = deletedFilePathFrom(call.tool, call.args);
      if (deletedPath !== undefined) {
        const removedId = fileArtifactId(session.id, deletedPath);
        removedIds.push(removedId);
        // 待登记列表里一并摘除（删除可能紧跟在写入之后）
        for (let i = records.length - 1; i >= 0; i -= 1) {
          if (records[i].artifact.id === removedId) records.splice(i, 1);
        }
        continue;
      }
      const drafts = deriveFileArtifacts(call.tool, call.args, call.id);
      for (const draft of drafts) {
        const change =
          seenPaths.has(draft.path) || draft.op === 'edit' ? 'modified' : 'created';
        records.push({
          messageId: message.id,
          artifact: {
            id: fileArtifactId(session.id, draft.path),
            type: 'file',
            title: draft.name,
            content: draft.content,
            createdAt: message.createdAt,
            path: draft.path,
            change,
            ...(draft.size !== undefined ? { size: draft.size } : {}),
            ...(draft.language !== undefined ? { language: draft.language } : {}),
            ...(draft.fingerprint !== undefined ? { fingerprint: draft.fingerprint } : {}),
          },
        });
        seenPaths.add(draft.path);
      }
    }
  }

  // 挂到消息上（按 id 覆盖：导入消息本不该自带 artifacts，防御重复重放）
  for (const { messageId, artifact } of records) {
    const message = session.messages.find((m) => m.id === messageId);
    if (!message) continue;
    const existing = (message.artifacts ?? []).filter((a) => a.id !== artifact.id);
    message.artifacts = [...existing, artifact];
  }

  return { records, removedIds };
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
