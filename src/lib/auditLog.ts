/**
 * FR-8.9 工具网关审计日志：纯解析 / 筛选 / 导出逻辑。
 *
 * 引擎（`nanobot/security/audit.py`）在工具执行的唯一收口点写一条记录到
 * `<data_dir>/audit/tool-gateway.ndjson`（NDJSON，每行一个 JSON 对象）。本模块
 * 只负责把这些原始文本变成可检索、可筛选、可导出的结构——**不碰 IPC、不碰 DOM**，
 * 因此能在 `tests/lib/` 下纯单测（与 `taskQuery.ts` 同一类纯逻辑）。
 *
 * 引擎写到文件里的字段是 snake_case（`approved_by` / `args_digest` / `session_key` /
 * `agent_id` / `approval_mode` / `request_id`），这里统一折成 camelCase 的渲染层对象，
 * 让 UI 与测试都不必记得下划线命名。
 */

/** 网关档位：与引擎 `AuditTier` 一一对应（PRD 11.1 决策优先级表）。 */
export type AuditTier = 'allow' | 'sandbox' | 'deny';
/** 实际结果：与引擎 `AuditOutcome` 一一对应。 */
export type AuditOutcome = 'executed' | 'refused' | 'error';
/** 放行来源：与引擎 `AuditApprovedBy` 一一对应。 */
export type AuditApprovedBy = 'user' | 'read_only' | 'policy' | 'none';

/** 一条审计记录（渲染层视图；字段从 NDJSON 的 snake_case 折成 camelCase）。 */
export interface AuditRecord {
  /** ISO UTC 时间戳（引擎 `datetime.now(timezone.utc).isoformat()`）。 */
  timestamp: string;
  /** 工具名（如 `write_file` / `Bash`）。 */
  tool: string;
  /** 网关档位（allow / sandbox / deny）。 */
  tier: AuditTier | string;
  /** 实际结果（executed / refused / error）。 */
  outcome: AuditOutcome | string;
  /** 放行来源（user / read_only / policy / none）。 */
  approvedBy: AuditApprovedBy | string;
  /** 参数规范化 JSON 的 sha256（命令哈希；摘要被截断时仍能关联同一指令）。 */
  argsDigest: string;
  /** 截断后的参数摘要对象（可能为 null）。 */
  args: Record<string, unknown> | null;
  /** 会话键（可选）。 */
  sessionKey?: string;
  /** 来源渠道（可选）。 */
  channel?: string;
  /** 对哪个 Agent 执行的（可选）：FR-8.9 的关键检索键——没有它说不清「是谁越的权」。 */
  agentId?: string;
  /** 会话的 tool_approval 轴（可选，如 ask）。 */
  approvalMode?: string;
  /** 请求 id（可选）。 */
  requestId?: string;
  /** 拒绝/原因说明（可选，截断到 400 字）。 */
  reason?: string;
  /** 解析来源行号（1-based），便于溯源与稳定排序。 */
  line: number;
}

export interface AuditLogParseResult {
  records: AuditRecord[];
  /** 因 JSON 损坏被跳过的行数。 */
  skipped: number;
}

export interface AuditFilters {
  /** 网关档位筛选；`'all'` 表示不限。 */
  tier: AuditTier | 'all';
  /** 实际结果筛选；`'all'` 表示不限。 */
  outcome: AuditOutcome | 'all';
  /** 放行来源筛选；`'all'` 表示不限。 */
  approvedBy: AuditApprovedBy | 'all';
  /** Agent 筛选；空串 `''` 表示不限，其它为具体 agentId（含未绑定）。 */
  agentId: string;
  /** 工具名筛选；空串 `''` 表示不限。 */
  tool: string;
  /** 跨字段关键词（tool / agentId / reason / argsDigest / sessionKey / channel / args）。 */
  query: string;
  /** 时间起点（含），`YYYY-MM-DD`；空串不限。 */
  from: string;
  /** 时间终点（含），`YYYY-MM-DD`；空串不限。 */
  to: string;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  tier: 'all',
  outcome: 'all',
  approvedBy: 'all',
  agentId: '',
  tool: '',
  query: '',
  from: '',
  to: '',
};

/** 网关档位中文标签（渲染用）。 */
export const TIER_LABELS: Record<string, string> = {
  allow: '放行',
  sandbox: '沙箱',
  deny: '拦截',
};

/** 实际结果中文标签（渲染用）。 */
export const OUTCOME_LABELS: Record<string, string> = {
  executed: '已执行',
  refused: '已拒绝',
  error: '出错',
};

/** 放行来源中文标签（渲染用）。 */
export const APPROVED_BY_LABELS: Record<string, string> = {
  user: '用户批准',
  read_only: '只读放行',
  policy: '策略放行',
  none: '无',
};

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function asOptionalString(value: unknown): string | undefined {
  const s = asString(value);
  return s ? s : undefined;
}

function toRecord(obj: Record<string, unknown>, line: number): AuditRecord {
  return {
    timestamp: asString(obj.timestamp),
    tool: asString(obj.tool),
    tier: asString(obj.tier),
    outcome: asString(obj.outcome),
    approvedBy: asString(obj.approved_by) || 'none',
    argsDigest: asString(obj.args_digest),
    args:
      obj.args != null && typeof obj.args === 'object' && !Array.isArray(obj.args)
        ? (obj.args as Record<string, unknown>)
        : null,
    sessionKey: asOptionalString(obj.session_key),
    channel: asOptionalString(obj.channel),
    agentId: asOptionalString(obj.agent_id),
    approvalMode: asOptionalString(obj.approval_mode),
    requestId: asOptionalString(obj.request_id),
    reason: asOptionalString(obj.reason),
    line,
  };
}

/**
 * 解析 NDJSON 审计文本。容错：空行忽略、JSON 损坏的行计入 `skipped` 并跳过，
 * 不抛出（审计日志永远不应让界面崩）。
 */
export function parseAuditLog(text: string): AuditLogParseResult {
  const records: AuditRecord[] = [];
  let skipped = 0;
  if (!text) return { records, skipped };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(toRecord(parsed, i + 1));
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

function matchesQuery(record: AuditRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    record.tool,
    record.agentId ?? '',
    record.reason ?? '',
    record.argsDigest,
    record.sessionKey ?? '',
    record.channel ?? '',
    record.approvalMode ?? '',
    record.args ? JSON.stringify(record.args) : '',
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(q);
}

function sameDateOrAfter(timestamp: string, date: string): boolean {
  return timestamp.slice(0, 10) >= date;
}

function sameDateOrBefore(timestamp: string, date: string): boolean {
  return timestamp.slice(0, 10) <= date;
}

/** 按筛选条件过滤审计记录（保持输入顺序，排序由调用方决定）。 */
export function filterAuditRecords(
  records: readonly AuditRecord[],
  filters: AuditFilters,
): AuditRecord[] {
  return records.filter((r) => {
    if (filters.tier !== 'all' && r.tier !== filters.tier) return false;
    if (filters.outcome !== 'all' && r.outcome !== filters.outcome) return false;
    if (filters.approvedBy !== 'all' && r.approvedBy !== filters.approvedBy) return false;
    if (filters.agentId && r.agentId !== filters.agentId) return false;
    if (filters.tool && r.tool !== filters.tool) return false;
    if (filters.from && !(r.timestamp && sameDateOrAfter(r.timestamp, filters.from))) return false;
    if (filters.to && !(r.timestamp && sameDateOrBefore(r.timestamp, filters.to))) return false;
    if (!matchesQuery(r, filters.query)) return false;
    return true;
  });
}

/** 按时间戳排序；`desc=true`（默认）最新在前。空/坏时间戳永远沉底（无论升序降序）。 */
export function sortAuditRecords(
  records: readonly AuditRecord[],
  desc = true,
): AuditRecord[] {
  return [...records].sort((a, b) => {
    const at = a.timestamp || '';
    const bt = b.timestamp || '';
    // 空时间戳视为未知，永远排在最后（沉底），不参与方向比较
    const aEmpty = at === '';
    const bEmpty = bt === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (at === bt) return 0;
    // 升序比较后按 desc 翻转
    const cmp = at < bt ? -1 : 1;
    return desc ? -cmp : cmp;
  });
}

/** 取某字段的去重非空值（按出现频次降序，供筛选下拉）。 */
export function distinctValues(
  records: readonly AuditRecord[],
  key: 'tool' | 'agentId',
): string[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const v = key === 'tool' ? r.tool : r.agentId ?? '';
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => v);
}

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 导出为 CSV 文本（带表头）。字段用引擎原始 snake_case 值，便于机器处理。 */
export function exportAuditCsv(records: readonly AuditRecord[]): string {
  const header = [
    'timestamp',
    'tool',
    'tier',
    'outcome',
    'approved_by',
    'agent_id',
    'session_key',
    'channel',
    'approval_mode',
    'args_digest',
    'reason',
    'args',
  ];
  const rows = records.map((r) =>
    [
      r.timestamp,
      r.tool,
      r.tier,
      r.outcome,
      r.approvedBy,
      r.agentId ?? '',
      r.sessionKey ?? '',
      r.channel ?? '',
      r.approvalMode ?? '',
      r.argsDigest,
      r.reason ?? '',
      r.args ? JSON.stringify(r.args) : '',
    ]
      .map(csvEscape)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}
