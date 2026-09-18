/**
 * 事件投影（D2 Phase D）：把 append-only 的事件流折叠回渲染层视图。
 *
 * ## 为什么是纯函数
 *
 * 投影是**读路径的唯一形状定义**：磁盘上是什么、UI 上就长什么样。把它做成
 * 不碰 IO、不碰 store、不依赖平台的纯函数，才能用普通单测穷举「分支废弃 /
 * 乱序 / 缺字段」等边界，也才能让 Electron 与 Web 两端读到完全一致的语义。
 *
 * ## 两条推导路径必须同源
 *
 * 视图有**两个产地**：
 *
 * | 产地 | 用法 | 实现 |
 * |---|---|---|
 * | 实时增量 | 流式过程中逐 token / 逐事件就地更新 store | `sessionsStore` 的各 action |
 * | 批量重放 | 启动或打开会话时，从事件流一次性重建 | 本模块 |
 *
 * 两者必须对同一批输入给出同一结果，否则「刷新前 / 刷新后」会看到不同的东西。
 * 本模块定义了**语义基准**，并在 `tests/events/equivalence.test.ts` 里拿实时
 * 路径跑一遍再投影，逐字段比对，把两条路径钉死。
 *
 * ## 分支废弃：为什么需要 `activePath`
 *
 * 「编辑后重发」会把被替换消息之后的内容整段作废，但事件流**只增不改**，
 * 那些事件仍留在文件里。好在 `parentId` 构成 DAG：重发时新事件从被替换的
 * 消息处分叉，于是**从最新事件沿 `parentId` 回溯到根**这条链，天然不含任何
 * 废弃分支。`activePath` 就是这条链。
 *
 * ## 归属靠 `messageId` 而非顺序
 *
 * 助手正文是流式累积的，`message` 事件只能在回合结束时以终值落盘，因此同回合
 * 的工具 / 思考事件 `seq` 都**小于**承载它们的 `message` 事件。若按「就近归属」
 * 会算到上一条消息头上，故一律走 `MessageScoped.messageId` 显式关联
 * （见 `@/types/event` 的说明）。
 */

import type { Artifact, ArtifactType } from '@/types/artifact';
import type { SessionEvent, SessionMeta } from '@/types/event';
import type { Attachment, AttachmentKind, Message, MessagePlan } from '@/types/message';
import { UNBOUND_AGENT_SENTINEL } from './indexFile';
import type { PermissionLog } from '@/types/permission';
import type { ProcessEvent, ProcessToolRow, ReasoningEvent as ReasoningRow } from '@/types/process';
import type { Session } from '@/types/session';
import type { ToolCall } from '@/types/toolcall';

/** 事件里附件的最小形状（内容不入事件流，见 `MessageEvent.attachments`） */
export interface EventAttachment {
  id: string;
  name: string;
  kind?: string;
  mime?: string;
  size?: number;
  path?: string;
}

const ATTACHMENT_KINDS: readonly AttachmentKind[] = [
  'image',
  'document',
  'text',
  'video',
  'audio',
  'other',
];

function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(value);
}

/** 事件附件 → 视图附件（读方向） */
export function toViewAttachment(a: EventAttachment): Attachment {
  return {
    id: a.id,
    name: a.name,
    size: a.size ?? 0,
    mime: a.mime ?? '',
    kind: isAttachmentKind(a.kind) ? a.kind : 'other',
    // 本地来源路径：桌面端选择/拖拽文件时可得，悬停提示要显示「目录 + 名称」
    ...(a.path ? { localPath: a.path } : {}),
  };
}

/**
 * 视图附件 → 事件附件（写方向）。
 *
 * 刻意**丢掉** `previewUrl` / `dataUrl` / `richContent` 里的 base64 内容：
 * 事件流是逐行 JSON，塞进大体积 base64 会让单个 JSONL 膨胀到不可读，
 * 且这些字段本就不可跨端复原（object URL 是进程内的临时句柄）。
 */
export function toEventAttachment(a: Attachment): EventAttachment {
  return {
    id: a.id,
    name: a.name,
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.mime ? { mime: a.mime } : {}),
    ...(a.size ? { size: a.size } : {}),
    ...(a.localPath ? { path: a.localPath } : {}),
  };
}

/**
 * 取「活跃时间线」：以最大 `seq` 的事件为尖端，沿 `parentId` 回溯到根，再反转。
 *
 * - 不在链上的事件 = 废弃分支（被「编辑后重发」作废），**不返回**；
 * - `parentId` 指向不存在的事件（截断的流）→ 到此为止，不报错；
 * - 环（数据损坏）→ `seen` 集合兜底，最多遍历一次。
 */
export function activePath(events: readonly SessionEvent[]): SessionEvent[] {
  if (events.length === 0) return [];
  const byId = new Map<string, SessionEvent>();
  let tip: SessionEvent | null = null;
  for (const ev of events) {
    byId.set(ev.id, ev);
    if (!tip || ev.seq > tip.seq) tip = ev;
  }

  const chain: SessionEvent[] = [];
  const seen = new Set<string>();
  let cur: SessionEvent | null = tip;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId === null ? null : byId.get(cur.parentId) ?? null;
  }
  chain.reverse();
  return chain;
}

/**
 * 投影结果。
 *
 * 两个字段的**取值范围不同**，这是刻意的：
 *
 * - `messages` 只取**活跃时间线**（`activePath`）——「编辑后重发」作废的分支不得出现；
 * - `permissionLog` 取**全量事件**——它是敏感操作的审计记录，遵循事件流的
 *   append-only 语义：一次裁决发生过就应留痕，不因后续重发/回滚而消失。
 */
export interface Projection {
  messages: Message[];
  permissionLog: PermissionLog[];
}

/**
 * `messageId` → 该消息在活跃时间线上的 `message` 事件 id。
 *
 * 用途是**定位分支点**：「编辑后重发」要让新事件从被替换的消息处分叉，
 * 就必须知道那条消息当初落盘的事件 id（同一 messageId 可能有多条事件，
 * 取活跃链上的最后一条）。用 `activePath` 而非全量事件，是为了避免把废弃
 * 分支上的事件当成分叉点。
 */
export function messageEventIndex(path: readonly SessionEvent[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const ev of path) {
    if (ev.type === 'message') index.set(ev.messageId, ev.id);
  }
  return index;
}

/** 毫秒时间戳 → ISO 8601（视图模型统一用 ISO 字符串） */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 在过程时间线里按 id 定位工具行（结果事件可能先于/后于请求事件到达） */
function findToolRow(rows: ProcessEvent[], callId: string): ProcessToolRow | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === 'tool' && row.id === callId) return row;
  }
  return undefined;
}

/** 在过程时间线里按 id 定位工具行下标（返回可变引用供原地更新） */
function findToolRowIndex(rows: ProcessEvent[], callId: string): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === 'tool' && row.id === callId) return i;
  }
  return -1;
}

/**
 * 折叠**活跃时间线** → 消息列表。
 *
 * 一条 `message` 事件 = 一条消息；同回合的思考 / 工具 / 产物事件按 `messageId`
 * 归到该消息上。**只处理 `activePath` 的输出**（传入未过滤的事件集合会包含废弃
 * 分支）。权限决策在消息上的体现（工具卡片）在这里处理，**审计日志**请用
 * `projectPermissionLog`——它需要全量事件，见 `Projection` 的说明。
 */
export function projectMessages(path: readonly SessionEvent[]): Message[] {
  /** 消息出现顺序（按各消息 `message` 事件的 `seq`，即传入顺序） */
  const order: string[] = [];
  /** messageId → 该消息的 message 事件（多条时取最后一条，即终值） */
  const heads = new Map<string, Extract<SessionEvent, { type: 'message' }>>();
  /** messageId → 过程时间线（可变，原地聚合） */
  const processes = new Map<string, ProcessEvent[]>();
  /** messageId → 工具调用行（仅审批门控产生，见下方 permission-decision 分支） */
  const toolCalls = new Map<string, ToolCall[]>();
  /** messageId → 内联产物 */
  const artifacts = new Map<string, Artifact[]>();
  /** messageId → 本轮挂载的计划（plan 事件产出，plan-decision 更新裁决） */
  const plans = new Map<string, MessagePlan>();

  /** 取（必要时新建）该消息的过程时间线 */
  const processOf = (messageId: string): ProcessEvent[] => {
    let rows = processes.get(messageId);
    if (!rows) {
      rows = [];
      processes.set(messageId, rows);
    }
    return rows;
  };

  for (const ev of path) {
    switch (ev.type) {
      case 'message': {
        if (!heads.has(ev.messageId)) order.push(ev.messageId);
        heads.set(ev.messageId, ev);
        break;
      }
      case 'reasoning': {
        if (!ev.messageId) break;
        const rows = processOf(ev.messageId);
        const last = rows[rows.length - 1];
        /**
         * 两种生产方，语义互斥：
         * - `done: true` = **完整段落**（内容已是终值）→ 独立成段，不与前段合并；
         * - `done` 缺省 = **分段追加**（流式切片）→ 续写末段（末段已闭合则另开）。
         *
         * 当前生产方（`sessionsStore.closeReasoning`）走第一种：一段思考闭合时
         * 落一条终值事件，避免逐 chunk 写盘。第二种保留给未来的分片写入。
         */
        if (ev.done) {
          rows.push({ id: ev.id, kind: 'reasoning', content: ev.content, closed: true });
        } else if (last && last.kind === 'reasoning' && !last.closed) {
          (last as ReasoningRow).content += ev.content;
        } else {
          rows.push({ id: ev.id, kind: 'reasoning', content: ev.content });
        }
        break;
      }
      case 'function-call': {
        if (!ev.messageId) break;
        const rows = processOf(ev.messageId);
        const idx = findToolRowIndex(rows, ev.callId);
        if (idx === -1) {
          rows.push({
            id: ev.callId,
            kind: 'tool',
            tool: ev.name,
            args: ev.args,
            status: 'running',
          });
        } else {
          const row = rows[idx] as ProcessToolRow;
          row.tool = ev.name;
          row.args = ev.args;
          row.status = 'running';
        }
        break;
      }
      case 'function-call-result': {
        if (!ev.messageId) break;
        const rows = processOf(ev.messageId);
        const existing = findToolRow(rows, ev.callId);
        const next: ProcessToolRow = {
          id: ev.callId,
          kind: 'tool',
          tool: ev.name,
          args: existing?.args ?? {},
          status: ev.status === 'ok' ? 'done' : 'error',
          ...(ev.result !== undefined ? { result: ev.result } : {}),
          ...(ev.error !== undefined ? { error: ev.error } : {}),
        };
        const idx = findToolRowIndex(rows, ev.callId);
        if (idx === -1) rows.push(next);
        else rows[idx] = next;
        break;
      }
      case 'permission-decision': {
        // 视图上的工具卡片**只由审批门控产生**（`capabilities.toolCalls === false`
        // 时引擎不报通用 tool_calls），故这里与实时视图的 handleApprovalRequest /
        // resolveApproval 对齐：一条决策事件 = 一张状态确定的工具卡片。
        // （审计日志不走这里，见 `projectPermissionLog`。）
        if (ev.messageId) {
          const args = ev.args ?? {};
          const list = toolCalls.get(ev.messageId) ?? [];
          const idx = list.findIndex((t) => t.id === ev.callId);
          const row: ToolCall = {
            id: ev.callId,
            tool: ev.tool,
            args,
            sensitive: true,
            status: ev.decision,
          };
          if (idx === -1) list.push(row);
          else list[idx] = { ...list[idx], ...row };
          toolCalls.set(ev.messageId, list);
        }
        break;
      }
      case 'plan': {
        if (!ev.messageId) break;
        // 步骤做值拷贝而非共享引用：视图上会就地改 step.status 表达勾选，
        // 直接复用事件对象会让这份「UI 态」回写进事件。
        plans.set(ev.messageId, {
          planId: ev.planId,
          steps: ev.steps.map((s) => ({ ...s })),
          status: 'pending',
        });
        break;
      }
      case 'plan-decision': {
        if (!ev.messageId) break;
        const cur = plans.get(ev.messageId);
        // 决策先于计划到达 / 计划被分支废弃 → 不凭空造一张计划卡。
        // 宁可少显示，也不要显示一份用户没见过的东西。
        if (!cur) break;
        plans.set(ev.messageId, {
          ...cur,
          status: ev.decision,
          // 与实时路径同源：缺省按「全批准」展开，保证两条路径的字段完全一致
          approvedStepIds: ev.approvedStepIds ?? cur.steps.map((s) => s.id),
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
        });
        break;
      }
      case 'artifact': {
        if (!ev.messageId) break;
        const list = artifacts.get(ev.messageId) ?? [];
        list.push({
          id: ev.artifactId,
          type: ev.kind as ArtifactType,
          ...(ev.name ? { title: ev.name } : {}),
          content: ev.content,
          ...(ev.language ? { language: ev.language } : {}),
          ...(ev.url ? { url: ev.url } : {}),
          createdAt: toIso(ev.timestamp),
        });
        artifacts.set(ev.messageId, list);
        break;
      }
      default:
        // session-start / session-end / ai-title / usage / error / mode-change /
        // commit / file-history-snapshot / plan / plan-decision：不影响消息本身
        break;
    }
  }

  const messages: Message[] = [];
  for (const messageId of order) {
    const ev = heads.get(messageId);
    if (!ev) continue;
    const process = processes.get(messageId);
    const calls = toolCalls.get(messageId);
    const arts = artifacts.get(messageId);
    const viewPlan = plans.get(messageId);
    messages.push({
      id: ev.messageId,
      role: ev.role,
      content: ev.content,
      ...(ev.attachments && ev.attachments.length > 0
        ? { attachments: ev.attachments.map(toViewAttachment) }
        : {}),
      ...(calls && calls.length > 0 ? { toolCalls: calls } : {}),
      ...(arts && arts.length > 0 ? { artifacts: arts } : {}),
      ...(viewPlan ? { plan: viewPlan } : {}),
      ...(process && process.length > 0 ? { process } : {}),
      ...(ev.richContent ? { richContent: ev.richContent } : {}),
      // 消息创建时间优先取事件自带的 `createdAt`（助手消息在回合开始即有占位，
      // 事件却在回合结束才落盘，用事件时间戳会整体偏晚一个回合的时长）
      createdAt: ev.createdAt ?? toIso(ev.timestamp),
      ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
      ...(ev.aborted ? { aborted: true } : {}),
    });
  }

  return messages;
}

/**
 * 敏感操作审计日志：扫**全部**事件，不做活跃时间线过滤。
 *
 * 为什么不吃 `activePath`：审计记录回答的是「这条会话里发生过哪些敏感裁决」，
 * 与「当前可见的消息是哪一支」是两个问题。一次批准过的写文件不会因为用户随后
 * 编辑了提问就变成没发生过——事件流只增不改，审计也应如此。
 */
export function projectPermissionLog(events: readonly SessionEvent[]): PermissionLog[] {
  const log: PermissionLog[] = [];
  for (const ev of events) {
    if (ev.type !== 'permission-decision') continue;
    log.push({
      id: ev.id,
      tool: ev.tool,
      args: ev.args ?? {},
      decision: ev.decision,
      at: toIso(ev.timestamp),
    });
  }
  return log;
}

/** 折叠事件流 → 投影（消息走活跃时间线；审计日志扫全量，见 `Projection`） */
export function project(events: readonly SessionEvent[]): Projection {
  return {
    messages: projectMessages(activePath(events)),
    permissionLog: projectPermissionLog(events),
  };
}

/** 会话元数据 → 会话视图（消息待填充） */
export function metaToSession(meta: SessionMeta): Omit<Session, 'messages' | 'permissionLog'> {
  return {
    id: meta.id,
    // meta / 索引层用 `default` 占位表达「未绑定专家」（见 UNBOUND_AGENT_SENTINEL），
    // 回到领域层一律还原成空串：请求据此**省略** `agent_id`（由网关用默认 Agent 应答），
    // 且让「新建任务」在重启前后是同一份形态（实时增量视图 ≡ 批量重放投影）。
    agentId:
      meta.agentId === UNBOUND_AGENT_SENTINEL ? '' : meta.agentId,
    ...(meta.groupId !== undefined ? { groupId: meta.groupId } : {}),
    ...(meta.skillIds && meta.skillIds.length > 0 ? { skillIds: [...meta.skillIds] } : {}),
    ...(meta.workdir !== undefined ? { workdir: meta.workdir } : {}),
    ...(meta.permissionMode === 'full' ? { fullAccess: true } : {}),
    ...(meta.toolApproval !== undefined ? { toolApproval: meta.toolApproval } : {}),
    // 执行模式在 meta 里是**必填**的（缺省也已由写入方归一为 craft），
    // 因此这里无条件带上，读路径不再需要第二处默认值
    mode: meta.mode,
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    ...(meta.channel !== undefined ? { channel: meta.channel } : {}),
    ...(meta.readonly !== undefined ? { readonly: meta.readonly } : {}),
    ...(meta.pinned !== undefined ? { pinned: meta.pinned } : {}),
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

/** 元数据 + 事件流 → 完整会话视图（打开会话 / 启动水合的唯一入口） */
export function projectSession(meta: SessionMeta, events: readonly SessionEvent[]): Session {
  return { ...metaToSession(meta), ...project(events) };
}
