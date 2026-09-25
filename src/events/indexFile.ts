import type {
  ExecutionMode,
  PermissionMode,
  SessionEvent,
  SessionIndexEntry,
  SessionIndexFile,
  SessionMeta,
} from '@/types/event';

/**
 * 会话索引的 schema 版本（与 `SessionIndexFile.version` 对齐）。
 *
 * v2：条目新增 `messageCount`（有对话记录的判据，见 `SessionIndexEntry`）。
 * 版本不符时 `normalizeSessionIndex` 直接丢弃旧索引，由上层 `rebuildIndex`
 * 重扫 JSONL 重建——索引是**可再生派生物**，这正是它设计好的升级路径
 * （v1 的条目没有这个字段，不重建的话列表会把所有会话都当成空会话）。
 */
export const SESSION_INDEX_VERSION = 2;

/**
 * 索引里的三个计数。
 *
 * 集中成一个结构，是因为它要一路穿过 `applyAppend` / `rebuildSessionIndex`
 * 与三个存储实现（内存参照、Electron、Web）；散成三个平行参数迟早会有一处漏传。
 */
export interface SessionCounters {
  /** 事件总数（含全部类型） */
  eventCount: number;
  /** 最大 seq */
  lastSeq: number;
  /** 用户 / 助手消息事件数（有对话记录的判据） */
  messageCount: number;
}

/**
 * 从一段事件流算出计数（三个存储实现的重建路径共用）。
 *
 * `base` 用于**续算**：`applyAppend` 只看到本次追加的那几条，计数要在既有值上累加。
 */
export function countEvents(
  events: readonly SessionEvent[],
  base: SessionCounters = { eventCount: 0, lastSeq: 0, messageCount: 0 },
): SessionCounters {
  let { lastSeq, messageCount } = base;
  for (const ev of events) {
    if (ev.seq > lastSeq) lastSeq = ev.seq;
    if (ev.type === 'message') messageCount += 1;
  }
  return { eventCount: base.eventCount + events.length, lastSeq, messageCount };
}

/**
 * 会话索引的纯逻辑（D2，设计文档 9.4 的 JSON 落地）。
 *
 * ## 为什么住在 `src/`
 *
 * 主进程（Electron 落盘）与 Web 分片降级**共用**同一套索引语义，所以放在
 * `src/events/` 而不是 `electron/`：本模块不碰 fs、不碰 electron、不依赖
 * `node:path`，渲染层与主进程都可安全 import。`electron/eventIndex.ts` 只是
 * 对本模块的再导出，保留给主进程侧的既有调用点。
 *
 * ## 索引是「可再生派生物」
 *
 * 权威数据是各会话的事件流与元数据；索引只是为「列表查询」做的投影。
 * 因此本模块的所有函数都是**纯函数**：
 * - 读到损坏 / 版本不符的索引时直接丢弃重建，不需要任何补救逻辑；
 * - 索引逻辑可以用普通单测穷举，调用方只负责「读文件 → 调本模块 → 写文件」。
 *
 * ## 为什么不用 SQLite
 *
 * 设计文档原定 SQLite（`sessions` 表 + FTS5）。本项目 V1 改用 JSON 索引：
 * 索引可再生，故其为「零原生依赖」付出的代价（列表扫描线性、无全文检索）
 * 换来的打包与跨端一致性收益更高（见 `SessionIndexFile` 的注释）。
 */

/** 空索引 */
export function emptySessionIndex(): SessionIndexFile {
  return { version: SESSION_INDEX_VERSION, entries: {} };
}

/**
 * 规范化**已解析**的索引对象，**容错**：
 *
 * 结构不符、schema 版本不符、或条目缺计数（旧版残留 / 混合版本写入）一律返回
 * 空索引——索引可再生，丢弃后由上层重建即可，比「尽力抢救」更不容易出错。
 * 字符串入参走 `parseSessionIndex`。
 */
export function normalizeSessionIndex(value: unknown): SessionIndexFile {
  if (!value || typeof value !== 'object') return emptySessionIndex();
  const obj = value as { version?: unknown; entries?: unknown };
  if (obj.version !== SESSION_INDEX_VERSION) return emptySessionIndex();
  if (!obj.entries || typeof obj.entries !== 'object') return emptySessionIndex();
  const entries: Record<string, SessionIndexEntry> = {};
  for (const [id, entry] of Object.entries(obj.entries as Record<string, unknown>)) {
    if (entry && typeof entry === 'object') {
      const e = entry as Partial<SessionIndexEntry>;
      // 三个计数缺一不可：`messageCount` 缺失时这条会话会被列表判成空会话
      // （见 `SessionIndexEntry.messageCount`），与其静默藏起用户的任务，
      // 不如整份丢弃触发重建——索引本来就是可再生派生物。
      if (
        typeof e.eventCount !== 'number' ||
        typeof e.lastSeq !== 'number' ||
        typeof e.messageCount !== 'number'
      ) {
        return emptySessionIndex();
      }
      entries[id] = e as SessionIndexEntry;
    }
  }
  return { version: SESSION_INDEX_VERSION, entries };
}

/** 解析索引文件内容（null / 非法 JSON / 结构不符 → 空索引） */
export function parseSessionIndex(raw: string | null | undefined): SessionIndexFile {
  if (!raw) return emptySessionIndex();
  try {
    return normalizeSessionIndex(JSON.parse(raw));
  } catch {
    return emptySessionIndex();
  }
}

/** 序列化索引（运行时数据，紧凑写；对齐 storageRoutes 的落盘约定） */
export function serializeSessionIndex(index: SessionIndexFile): string {
  return JSON.stringify(index);
}

/**
 * 「未绑定任何 Agent」在 **meta / 索引层**的占位取值。
 *
 * 会话可以不绑专家（「新建任务」的默认态，见 `sessionsStore.createSession` 的
 * `inheritCapabilities`），此时 `Session.agentId` 是空串，请求里省略 `agent_id`。
 * 但 meta / 索引里**空串与「字段缺失」不可区分**，旧数据还可能整个缺这个字段，
 * 于是这一层统一归一成该占位；回到领域层时由 `metaToSession` 还原成空串，
 * 让「新建任务」在重启前后保持同一形态（实时视图 ≡ 重放投影）。
 */
export const UNBOUND_AGENT_SENTINEL = 'default';

/**
 * 规范化**已解析**的会话元数据对象，**容错**：
 *
 * - 非对象 → `null`（调用方跳过该会话，而不是让整次重建失败）；
 * - 缺少 `id` → `null`（无法归属的元数据没有意义）；
 * - 其余字段缺失按安全默认补齐——旧版本写入的 meta 可能没有 `mode` /
 *   `permissionMode` 等字段，重建索引时不应因此丢掉整个会话。
 */
export function normalizeSessionMeta(value: unknown): SessionMeta | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : '';
  if (!id) return null;
  const now = new Date().toISOString();
  return {
    id,
    title: typeof obj.title === 'string' && obj.title ? obj.title : '新任务',
    agentId:
      typeof obj.agentId === 'string' && obj.agentId
        ? obj.agentId
        : UNBOUND_AGENT_SENTINEL,
    groupId: typeof obj.groupId === 'string' ? obj.groupId : null,
    workdir: typeof obj.workdir === 'string' ? obj.workdir : undefined,
    // 语义工作空间（缺省 = 同 workdir）：切换过工作空间的会话才有这个字段
    workspace: typeof obj.workspace === 'string' ? obj.workspace : undefined,
    mode: isExecutionMode(obj.mode) ? obj.mode : 'craft',
    model: typeof obj.model === 'string' ? obj.model : undefined,
    permissionMode: isPermissionMode(obj.permissionMode) ? obj.permissionMode : 'restricted',
    toolApproval: typeof obj.toolApproval === 'boolean' ? obj.toolApproval : undefined,
    skillIds: Array.isArray(obj.skillIds)
      ? (obj.skillIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    channel: typeof obj.channel === 'string' ? obj.channel : undefined,
    readonly: typeof obj.readonly === 'boolean' ? obj.readonly : undefined,
    pinned: typeof obj.pinned === 'boolean' ? obj.pinned : undefined,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : now,
    rev: typeof obj.rev === 'number' ? obj.rev : undefined,
    // 与 `rev` 同处一条纪律：缺失不兜底成 `'unknown'`（那会伪装成一台真实设备），
    // 保持 `undefined` 让读侧知道「这份元数据没记过来源」
    updatedBy: typeof obj.updatedBy === 'string' ? obj.updatedBy : undefined,
    deletedAt: typeof obj.deletedAt === 'string' ? obj.deletedAt : null,
  };
}

/** 解析会话元数据文件内容（null / 非法 JSON / 非对象 → null） */
export function parseSessionMeta(raw: string | null | undefined): SessionMeta | null {
  if (!raw) return null;
  try {
    return normalizeSessionMeta(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 毫秒时间戳 → ISO（缺省取当前时刻） */
function toIso(ms?: number, fallback = 0): string {
  return new Date(ms ?? fallback).toISOString();
}
/** 取若干 ISO 字符串中最大者（同格式下字典序即时序；空值忽略） */
function maxIso(...candidates: Array<string | undefined>): string {
  let best: string | undefined;
  for (const c of candidates) {
    if (!c) continue;
    if (best === undefined || c > best) best = c;
  }
  return best ?? new Date().toISOString();
}

/** 把任意文本收敛为单行标题（折叠空白 + 截断） */
export function summarizeTitle(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

export interface DeriveMetaOptions {
  /** 兜底字段：事件里没有 `session-start` / `message` 时使用 */
  fallback?: Partial<
    Pick<SessionMeta, 'agentId' | 'mode' | 'permissionMode' | 'model' | 'workdir' | 'title'>
  >;
  /** 覆盖 createdAt；缺省取首条事件时间戳 */
  createdAt?: string;
  /** 覆盖 updatedAt；缺省取末条事件时间戳 */
  updatedAt?: string;
}

/**
 * 从事件推导会话元数据。
 *
 * 用途：主进程在 `append` 时若发现 `.meta.json` 缺失，可**不依赖渲染层**
 * 就地补出一份最小可用元数据（`session-start` 事件本身携带了执行上下文）。
 */
export function deriveMetaFromEvents(
  sessionId: string,
  events: readonly SessionEvent[],
  opts: DeriveMetaOptions = {},
): SessionMeta {
  const fallback = opts.fallback ?? {};
  const start = events.find((ev) => ev.type === 'session-start');

  // 标题：末条 ai-title 优先，否则首条用户消息摘要，再退兜底
  let title = '';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.type === 'ai-title') {
      title = ev.title;
      break;
    }
  }
  if (!title) {
    const firstUser = events.find((ev) => ev.type === 'message' && ev.role === 'user');
    if (firstUser && firstUser.type === 'message') title = summarizeTitle(firstUser.content);
  }

  const first = events[0];
  const last = events[events.length - 1];
  // session-start 里的 agentId 可能是空串（未绑定专家的会话，如「新建任务」的默认态），
  // 此时**不能用 `??` 兜底**：空串不是 nullish，`??` 会把它原样留在 meta 里，
  // 于是「空串 / 字段缺失」两种形态同时存在。显式按真值判断后再落到占位。
  const startAgentId = start?.type === 'session-start' ? start.agentId : undefined;
  return {
    id: sessionId,
    title: title || fallback.title || '新任务',
    agentId: startAgentId || fallback.agentId || UNBOUND_AGENT_SENTINEL,
    workdir: (start?.type === 'session-start' ? start.workdir : undefined) ?? fallback.workdir,
    mode: (start?.type === 'session-start' ? start.mode : undefined) ?? fallback.mode ?? 'craft',
    permissionMode:
      (start?.type === 'session-start' ? start.permissionMode : undefined) ??
      fallback.permissionMode ??
      'restricted',
    model: (start?.type === 'session-start' ? start.model : undefined) ?? fallback.model,
    createdAt: opts.createdAt ?? toIso(first?.timestamp),
    updatedAt: opts.updatedAt ?? toIso(last?.timestamp, Date.now()),
  };
}

/** 由元数据 + 计数构造索引条目 */
export function entryFromMeta(meta: SessionMeta, counters: SessionCounters): SessionIndexEntry {
  return {
    id: meta.id,
    title: meta.title,
    agentId: meta.agentId,
    groupId: meta.groupId,
    workdir: meta.workdir,
    mode: meta.mode,
    model: meta.model,
    permissionMode: meta.permissionMode,
    channel: meta.channel,
    readonly: meta.readonly,
    pinned: meta.pinned,
    eventCount: counters.eventCount,
    lastSeq: counters.lastSeq,
    messageCount: counters.messageCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    rev: meta.rev,
    updatedBy: meta.updatedBy,
    deletedAt: meta.deletedAt,
  };
}

/** 不可变地写入一条条目 */
export function upsertEntry(
  index: SessionIndexFile,
  entry: SessionIndexEntry,
): SessionIndexFile {
  return {
    version: SESSION_INDEX_VERSION,
    entries: { ...index.entries, [entry.id]: entry },
  };
}

/** 不可变地移除一条条目 */
export function removeSessionEntry(
  index: SessionIndexFile,
  sessionId: string,
): SessionIndexFile {
  if (!(sessionId in index.entries)) return index;
  const entries = { ...index.entries };
  delete entries[sessionId];
  return { version: SESSION_INDEX_VERSION, entries };
}

/**
 * 把一次追加投影进索引。
 *
 * 语义要点：
 * - **事件数、lastSeq 与对话记录条数只增不减**（append-only 流，无需回退）；
 * - **标题**：本次追加若含 `ai-title` 则以其为准（自动命名晚于首条消息），
 *   否则沿用既有条目 / 元数据里的标题；
 * - **updatedAt** 取「既有、元数据、本次事件时间戳」的最大值，保证列表按
 *   真实活动时间排序，而不是按「何时写索引」。
 *
 * `appended` 为空时退化为「仅用 meta 补/建条目」（幂等）。
 */
export function applyAppend(
  index: SessionIndexFile,
  meta: SessionMeta | null,
  appended: readonly SessionEvent[],
  sessionId: string,
): SessionIndexFile {
  const prev = index.entries[sessionId];

  let maxTs = 0;
  let titleFromAppend: string | undefined;
  for (const ev of appended) {
    if (ev.timestamp > maxTs) maxTs = ev.timestamp;
    if (ev.type === 'ai-title') titleFromAppend = ev.title;
  }
  // 三个计数都从既有条目续算：这里只看到本次追加的那几条
  const counters = countEvents(appended, {
    eventCount: prev?.eventCount ?? 0,
    lastSeq: prev?.lastSeq ?? 0,
    messageCount: prev?.messageCount ?? 0,
  });

  if (appended.length === 0 && !meta && !prev) return index;

  const base: SessionIndexEntry | undefined = prev
    ? prev
    : meta
      ? entryFromMeta(meta, { eventCount: 0, lastSeq: 0, messageCount: 0 })
      : undefined;
  if (!base) return index;

  const merged: SessionIndexEntry = {
    ...base,
    // 元数据是权威：每次追加都用最新 meta 覆盖可同步字段
    ...(meta
      ? {
          title: meta.title,
          agentId: meta.agentId,
          groupId: meta.groupId,
          workdir: meta.workdir,
          mode: meta.mode,
          model: meta.model,
          permissionMode: meta.permissionMode,
          channel: meta.channel,
          readonly: meta.readonly,
          pinned: meta.pinned,
          createdAt: meta.createdAt,
          rev: meta.rev,
          updatedBy: meta.updatedBy,
          deletedAt: meta.deletedAt,
        }
      : {}),
    ...(titleFromAppend ? { title: titleFromAppend } : {}),
    ...counters,
    updatedAt: maxIso(base.updatedAt, meta?.updatedAt, maxTs ? toIso(maxTs) : undefined),
  };

  return upsertEntry(index, merged);
}

/**
 * 按元数据整体重建索引（索引损坏、schema 升级或首次迁移时使用）。
 *
 * `countersById` 提供每个会话的事件计数（由调用方读 JSONL 得到，见 `countEvents`）；
 * 缺省时计数为 0——列表仍可用，只是 `eventCount` / `lastSeq` / `messageCount`
 * 待下次追加时补齐。**注意**计数为 0 的会话会被列表当成空会话，所以重建路径
 * 一定要把 `countersById` 传全（三个存储实现都从 JSONL 现算）。
 */
export function rebuildSessionIndex(
  metas: readonly SessionMeta[],
  countersById: Record<string, SessionCounters> = {},
): SessionIndexFile {
  const entries: Record<string, SessionIndexEntry> = {};
  for (const meta of metas) {
    entries[meta.id] = entryFromMeta(
      meta,
      countersById[meta.id] ?? { eventCount: 0, lastSeq: 0, messageCount: 0 },
    );
  }
  return { version: SESSION_INDEX_VERSION, entries };
}

/**
 * 列表排序：置顶优先 → 最近更新优先 → id 升序（保证稳定）。
 *
 * 已软删除（`deletedAt`）的条目不返回（同步场景下由上层按需放宽）。
 */
export function listSessionEntries(index: SessionIndexFile): SessionIndexEntry[] {
  return Object.values(index.entries)
    .filter((entry) => !entry.deletedAt)
    .sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** 会话执行模式的合法性校验（用于外部输入边界） */
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === 'ask' || value === 'plan' || value === 'craft';
}

/** 权限策略的合法性校验（用于外部输入边界） */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'restricted' || value === 'full';
}
