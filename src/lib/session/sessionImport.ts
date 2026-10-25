import { genId } from '@/lib/core/id';
import { deletedFilePathFrom, deriveFileArtifacts, fileArtifactId } from '@/lib/artifact/fileArtifact';
import { extractArtifacts } from '@/ai/runtime/nanobotHttp/artifactExtractor';
import type { Artifact, Message, ProcessEvent, Session, ToolCall } from '@/types';

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
 * 提取 assistant 记录里的深度思考正文（`reasoning_content`）。
 *
 * ## 为什么单独一个函数
 *
 * 引擎把思考**逐轮**写进 assistant 记录的 `reasoning_content`（真实落盘样例：
 * `feishu.feishu:ou_xxx` 会话里每条 assistant 都带这个键，纯文本字符串）。
 * 它与 `content` 是两回事：`content` 是给用户看的回答，`reasoning_content` 是
 * 模型自己的思考——任务视图里前者进消息正文、后者进 `message.process` 的
 * 「深度思考」段。两者混用就会出现「把内心独白当回答显示」。
 *
 * 兼容三种形态（不同 provider / 不同版本引擎的落盘差异）：
 * - `string`：绝大多数（deepseek / qwen 等 OpenAI 兼容端点）
 * - `{ text }` 对象 / content blocks 数组：部分 provider 的分段形式
 * - 缺失 / `null` / 非字符串非对象：一律当作「这一轮没有思考」
 */
export function recordReasoning(record: Record<string, unknown>): string {
  const raw = record.reasoning_content;
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .map((b) => (typeof b.text === 'string' ? b.text : typeof b.reasoning === 'string' ? b.reasoning : ''))
      .join('')
      .trim();
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text.trim();
    if (typeof obj.reasoning === 'string') return obj.reasoning.trim();
  }
  return '';
}

/**
 * 将 nanobot JSONL 消息行映射为本地 Message 列表。
 * - user 直接映射；
 * - **同一轮的全部 assistant / tool 记录合并为一条 assistant 消息**（见下）；
 * - 无对应 assistant 的孤立 tool 行忽略。
 *
 * ## 为什么必须按「轮」合并
 *
 * nanobot 落盘时把一轮对话拆成多条记录：`assistant(带 tool_calls，常无正文)` →
 * `tool(结果)` → `assistant(最终回复文本)`。任务会话是流式聚合成**一条**助手
 * 消息的——过程行、产物卡片、正文都在同一个气泡里，正文在底部；若这里一条
 * 记录映射一条消息，同一轮会裂成两个「助手」气泡：产物卡片跟着第一条（带
 * 工具调用的），正文孤立在第二条——与任务视图完全对不上（2026-10-19 用户
 * 截图报的就是这个）。合并后，`AssistantMessage` 拿到的形状与流式聚合一致：
 * toolCalls 驱动过程行与产物卡片，content 是最终正文。
 *
 * ## 深度思考（`process`）
 *
 * 同一轮里每条 assistant 记录各带一段 `reasoning_content`，必须按**到达顺序**
 * 与工具行交错铺进 `message.process`——`ProcessView` 渲染的是一条时间线，
 * 顺序错了就变成「先全部思考、再全部工具」。同一轮内**连续**的 reasoning 记录
 * 累积成一段（与流式侧 `flushReasoning` 的聚合口径一致：一段思考被工具调用或
 * 正文打断后才开新段）。
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

  // 第二遍：按序生成消息；assistant 侧聚合「当前轮」，遇 user（或收尾）才落一条
  const messages: Message[] = [];
  /** 当前正在聚合的同一轮：id / 时间取首轮记录，正文、工具调用与过程行按序累积 */
  let turn: {
    id: string;
    createdAt: string;
    texts: string[];
    toolCalls: ToolCall[];
    process: ProcessEvent[];
  } | null = null;

  const flushTurn = () => {
    if (!turn) return;
    const message: Message = {
      id: turn.id,
      role: 'assistant',
      content: turn.texts.join('\n\n'),
      createdAt: turn.createdAt,
    };
    if (turn.toolCalls.length > 0) message.toolCalls = turn.toolCalls;
    if (turn.process.length > 0) message.process = turn.process;
    messages.push(message);
    turn = null;
  };

  records.forEach((rec, index) => {
    const role = rec.role;
    if (role === 'user') {
      // user 是轮的边界：先落掉上一轮，再独立成条
      flushTurn();
      messages.push({
        id: `${key}#${index}`,
        role: 'user',
        content: recordText(rec),
        createdAt: toIso(rec.timestamp),
      });
      return;
    }
    if (role !== 'assistant') return; // tool 结果行是关联数据，不产生消息
    const text = recordText(rec);
    if (!turn) {
      turn = {
        id: `${key}#${index}`,
        createdAt: toIso(rec.timestamp),
        texts: [],
        toolCalls: [],
        process: [],
      };
    }
    // 深度思考先于本记录的工具行：引擎一条记录里两者并存时，模型是先想再动手
    const reasoning = recordReasoning(rec);
    if (reasoning !== '') {
      const last = turn.process[turn.process.length - 1];
      // 连续 reasoning 累积成一段；被工具行打断后另起一段（与流式聚合同口径）
      if (last && last.kind === 'reasoning' && last.closed !== true) {
        turn.process[turn.process.length - 1] = {
          ...last,
          content: last.content ? `${last.content}\n\n${reasoning}` : reasoning,
        };
      } else {
        turn.process.push({
          id: `${key}#r${index}`,
          kind: 'reasoning',
          content: reasoning,
        });
      }
    }
    if (text !== '') turn.texts.push(text);
    for (const c of parseToolCalls(rec)) {
      turn.toolCalls.push({
        id: c.id,
        tool: c.name,
        args: c.args,
        sensitive: false,
        status: 'done',
        result: toolResults.get(c.id),
      });
      // 工具行与思考段共处一条时间线，插在思考之后（先想后做）。
      // id 用 tool_call_id，与任务视图的进度事件同源，便于 ProcessView 归并。
      turn.process.push({
        id: c.id,
        kind: 'tool',
        tool: c.name,
        args: c.args,
        status: 'done',
        ...(toolResults.get(c.id) !== undefined ? { result: toolResults.get(c.id) as string } : {}),
      });
    }
  });
  flushTurn();
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
