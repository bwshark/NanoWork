/**
 * FR-8.9 审计日志（第二条来源）：**应用内操作**留痕。
 *
 * ## 为什么另立一个文件与一套记录形状
 *
 * 引擎侧（`nanobot/security/audit.py`）在工具执行的唯一收口点写
 * `<data_dir>/audit/tool-gateway.ndjson`，那是「模型的每一步动了什么」。但 PRD 要的是
 * **全量**操作留痕，而另有一大类动作根本不过工具网关：技能启停、插件装卸、MCP / 渠道
 * 配置变更、专家增删、任务增删、会话删除、安全策略改动。这些全部发生在渲染层，引擎
 * 一无所知——只审计工具网关就等于「模型做的事有账，人做的事没账」，而事后追责问的
 * 恰恰常是后者。
 *
 * 三条落点纪律：
 * 1. **独立文件、独立 IPC**，不往引擎那份 `tool-gateway.ndjson` 里追加：那是引擎独占
 *    的文件（可由 `NANOBOT_TOOL_AUDIT_LOG` 重定向），两个进程交叉写会把行写花。
 * 2. **只记用户发起的动作**。同步引擎落地远端实体走的是 `setState`（见
 *    `src/sync/syncRegistry.ts`），不经 store 动作，因此天然不会被记成「我改了」——
 *    否则另一端的行为会被记到本机账上，审计就成了误导。
 * 3. **绝不影响业务动作**：写盘失败 / 序列化失败一律静默吞掉（与引擎侧「审计不得
 *    反向影响执行」同一条不变量）。所以入口是 `recordAppAudit()` 这个 void 函数，
 *    调用方不需要 await、也没有返回值可判。
 *
 * ## 为什么 detail 要脱敏
 *
 * 这里的记录会进「导出 CSV」给合规看，可能被贴进工单。渠道 / MCP 的配置里就躺着
 * `appSecret` / `apiToken` 这类字段，因此 detail 只记**字段名与被改的键**，值一律过
 * `sanitizeAuditDetail()`：疑似密钥的键直接落 `***`，字符串截断到 200 字。
 */

import { platform } from '@/platform';
import { currentDeviceId } from '@/lib/core/deviceId';

/**
 * 动作闭集。
 *
 * 刻意是字面量联合而不是自由字符串：动作 id 会被写进审计文件并长期留存，改一次名就
 * 等于让历史记录无法检索。新增动作时必须同时补 `APP_AUDIT_ACTION_LABELS`（`Record`
 * 类型会强制）与一条用例。
 */
export type AppAuditAction =
  | 'agent.create'
  | 'agent.import'
  | 'agent.update'
  | 'agent.delete'
  | 'agent.toggle'
  | 'skill.install'
  | 'skill.remove'
  | 'skill.override'
  | 'plugin.install'
  | 'plugin.uninstall'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'mcp.create'
  | 'mcp.update'
  | 'mcp.delete'
  | 'mcp.toggle'
  | 'mcp.secret.write'
  | 'channel.update'
  | 'channel.delete'
  | 'channel.enable'
  | 'channel.disable'
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'task.toggle'
  | 'session.delete'
  | 'artifact.rewrite'
  // 「把文件换回旧版」：版本号是向前涨的，事后看历史只看到「又生成了一版」，
  // 看不出「有人回到了旧版」——所以回退必须单独留痕。
  | 'artifact.rollback'
  | 'memory.rollback'
  | 'orgAsset.publish'
  | 'orgAsset.update'
  | 'orgAsset.withdraw'
  | 'orgAsset.import'
  // 项目共享记忆（FR-12.7 ③）：它是**团队级**内容，改一次所有人都受影响，
  // 而且会随每轮对话进入提示词——比改一个本地设置更需要事后能查到「谁什么时候改的」。
  | 'project.memory.update'
  | 'security.deny_write'
  | 'security.path_rules'
  // —— 引擎侧（actor=engine，由 nanobot 自己写）——
  | 'dream.accept'
  | 'dream.reject'
  | 'config.reload'
  | 'cron.reload'
  // 网关进程写的：内容被**送出本机**（`POST /v1/send` 把写好的文本投给 IM 渠道）。
  // 它不过工具网关，所以工具那档留痕里一行都不会有——单独一条动作 id 才查得到。
  | 'message.send';

/** 动作的中文标签（界面与 CSV 用；缺一条就渲染成裸 id，等于让人猜）。 */
export const APP_AUDIT_ACTION_LABELS: Record<AppAuditAction, string> = {
  'agent.create': '新建专家',
  'agent.import': '导入专家',
  'agent.update': '修改专家',
  'agent.delete': '删除专家',
  'agent.toggle': '启停专家',
  'skill.install': '安装技能',
  'skill.remove': '移除技能',
  'skill.override': '调整技能启用态',
  'plugin.install': '安装插件',
  'plugin.uninstall': '卸载插件',
  'plugin.enable': '启用插件',
  'plugin.disable': '停用插件',
  'mcp.create': '新建连接器',
  'mcp.update': '修改连接器',
  'mcp.delete': '删除连接器',
  'mcp.toggle': '启停连接器',
  'mcp.secret.write': '写入连接器凭据',
  'channel.update': '修改渠道配置',
  'channel.delete': '删除渠道',
  'channel.enable': '启用渠道',
  'channel.disable': '停用渠道',
  'task.create': '新建定时任务',
  'task.update': '修改定时任务',
  'task.delete': '删除定时任务',
  'task.toggle': '启停定时任务',
  'session.delete': '删除会话',
  'artifact.rewrite': '圈选改写产物',
  'artifact.rollback': '回退产物版本',
  'memory.rollback': '回滚长期记忆',
  'orgAsset.publish': '发布组织资产',
  // 改名称/说明：与「发布」分开记，否则审计里看不出是新增了一条还是改了一条
  'orgAsset.update': '修改组织资产信息',
  'orgAsset.withdraw': '撤回组织资产',
  'orgAsset.import': '导入组织资产',
  'project.memory.update': '修改项目共享记忆',
  'security.deny_write': '切换默认拒绝写入',
  'security.path_rules': '修改路径权限规则',
  // 引擎侧动作：id 与 `nanobot/security/audit.py` 里 `record_app_operation(action=…)`
  // 的取值逐字对应——改一边必须改另一边，否则界面上就是裸 id。
  'dream.accept': '采纳 Dream 合并',
  'dream.reject': '丢弃 Dream 合并',
  'config.reload': '热加载引擎配置',
  'cron.reload': '重载定时任务库',
  'message.send': '外发消息',
};

/** 动作分组（界面按域分组筛选；动作已有 40+，平铺成一个下拉等于让人用滚轮找）。 */
export const APP_AUDIT_ACTION_GROUPS: Record<string, AppAuditAction[]> = {
  '专家': ['agent.create', 'agent.import', 'agent.update', 'agent.delete', 'agent.toggle'],
  '扩展': [
    'skill.install',
    'skill.remove',
    'skill.override',
    'plugin.install',
    'plugin.uninstall',
    'plugin.enable',
    'plugin.disable',
  ],
  '连接与渠道': [
    'mcp.create',
    'mcp.update',
    'mcp.delete',
    'mcp.toggle',
    'mcp.secret.write',
    'channel.update',
    'channel.delete',
    'channel.enable',
    'channel.disable',
    // 「外发」放到渠道这组：它回答的是「这台机器往外送过什么」，
    // 排查时人也是从「哪个渠道」开始找的。
    'message.send',
  ],
  '自动化与数据': [
    'task.create',
    'task.update',
    'task.delete',
    'task.toggle',
    'session.delete',
    'artifact.rewrite',
    'artifact.rollback',
    'memory.rollback',
  ],
  '组织资产': [
    'orgAsset.publish',
    'orgAsset.update',
    'orgAsset.withdraw',
    'orgAsset.import',
    // 共享记忆与组织资产同组：都是「改动会影响别人」的团队级内容
    'project.memory.update',
  ],
  '安全': ['security.deny_write', 'security.path_rules'],
  '引擎侧': ['dream.accept', 'dream.reject', 'config.reload', 'cron.reload'],
};

export type AppAuditOutcome = 'ok' | 'failed';

/** 结果中文标签。 */
export const APP_AUDIT_OUTCOME_LABELS: Record<AppAuditOutcome, string> = {
  ok: '成功',
  failed: '失败',
};

/** detail 允许的取值：**只有标量与小数组**，避免把整对象贴进审计行。 */
export type AppAuditDetailValue = string | number | boolean | string[];

/** 一条应用操作审计记录（渲染层形状；与文件里的一行逐字对应）。 */
export interface AppAuditRecord {
  /** ISO 时间戳（本地时钟；应用操作没有服务端可归一）。 */
  ts: string;
  /** 动作 id（见 `AppAuditAction`）。 */
  action: AppAuditAction | string;
  /** 结果：动作是否真的落库成功。 */
  outcome: AppAuditOutcome | string;
  /**
   * 操作者：已登录时是账户 userId，未登录是 `local`。
   *
   * ⚠️ 本地优先的应用没有「服务端鉴权」这一层，所以这个值**只能用来区分账户**，
   * 不能当作身份凭证。
   */
  actor: string;
  /** 设备标识（`deviceId`），多端排查时用来分辨「哪台机器改的」。 */
  deviceId?: string;
  /** 被操作对象的稳定 id（Agent / 插件名 / 会话 id …）。 */
  targetId?: string;
  /** 被操作对象的可读名（名称 / 标题 / 渠道 kind），便于不查库就能读懂。 */
  targetLabel?: string;
  /** 变更摘要：只记字段名与小标量，密钥值一律 `***`。 */
  detail?: Record<string, AppAuditDetailValue>;
  /** 失败原因（截断 400 字）。 */
  reason?: string;
}

/**
 * 记录来源。
 *
 * - `app`：本机客户端写的（人点的按钮）；
 * - `engine`：引擎自己写的（`nanobot/security/audit.py::record_app_operation`，
 *   例如 Dream 采纳、配置热加载、任务库重载）。
 *
 * 两份文件、同一套行格式，界面合并成一条时间轴——但必须能分辨是谁记的：
 * 「我点了采纳」与「引擎真的把文件改了」是两件事，混在一起就没法追责。
 */
export type AppAuditOrigin = 'app' | 'engine';

/** 解析时附加行号与来源（行号用于稳定排序与溯源，与 `AuditRecord.line` 同职责）。 */
export interface ParsedAppAuditRecord extends AppAuditRecord {
  line: number;
  origin: AppAuditOrigin;
}

/** 操作者中文标签：引擎写的记录 actor 恒为 `engine`，其余是账户 id 或 `local`。 */
export function appAuditActorLabel(actor: string): string {
  if (actor === 'engine') return '引擎';
  if (actor === APP_AUDIT_LOCAL_ACTOR) return '本机';
  return actor;
}

export interface AppAuditParseResult {
  records: ParsedAppAuditRecord[];
  /** 因 JSON 损坏 / 形状不符被跳过的行数。 */
  skipped: number;
}

export interface AppAuditInput {
  action: AppAuditAction;
  targetId?: string;
  targetLabel?: string;
  outcome?: AppAuditOutcome;
  detail?: Record<string, unknown>;
  reason?: string;
}

export interface AppAuditFilters {
  /** 动作筛选；`'all'` 表示不限。 */
  action: AppAuditAction | 'all';
  /** 结果筛选；`'all'` 表示不限。 */
  outcome: AppAuditOutcome | 'all';
  /** 跨字段关键词（动作 / 对象 / 详情 / 原因）。 */
  query: string;
  /** 时间起点（含），`YYYY-MM-DD`；空串不限。 */
  from: string;
  /** 时间终点（含），`YYYY-MM-DD`；空串不限。 */
  to: string;
}

export const DEFAULT_APP_AUDIT_FILTERS: AppAuditFilters = {
  action: 'all',
  outcome: 'all',
  query: '',
  from: '',
  to: '',
};

/** 未登录（或还不知道账户）时的操作者占位。 */
export const APP_AUDIT_LOCAL_ACTOR = 'local';

const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_STRING = 200;
const MAX_DETAIL_ARRAY = 20;
const MAX_REASON = 400;
const MAX_TARGET_LABEL = 120;

/**
 * 疑似密钥的键名。命中即把**值**替换成 `***`，键名本身保留——「改了 appSecret」是
 * 需要留痕的事实，「appSecret 是什么」不需要也不该留痕。
 */
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|apikey|api_key|credential|authorization|cookie|private_?key)/i;

/** 当前操作者的取值来源（登录态只有同步运行时知道，故用注入而不是 import 它）。 */
let actorProvider: (() => string | null | undefined) | null = null;

/**
 * 注册「当前账户 userId」的取值来源。
 *
 * 用注入而不直接 import `@/sync/runtime`：`runtime` 订阅了几乎所有 store，而 store 又
 * 会 import 本模块 → 直接 import 会成环。注入只发生一次（`createSyncRuntime`），
 * 渲染层其余地方不必关心账户态。
 */
export function setAppAuditActorProvider(fn: (() => string | null | undefined) | null): void {
  actorProvider = fn;
}

/** 取当前操作者；provider 缺失 / 抛错 / 返回空串一律落 `local`（审计不该因此失败）。 */
export function currentAppAuditActor(): string {
  try {
    const v = actorProvider?.() ?? '';
    const trimmed = typeof v === 'string' ? v.trim() : '';
    return trimmed === '' ? APP_AUDIT_LOCAL_ACTOR : trimmed;
  } catch {
    return APP_AUDIT_LOCAL_ACTOR;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 清洗 detail：白名单化取值 + 密钥脱敏 + 长度上限。
 *
 * 返回 `undefined` 表示「没有可记的东西」——调用方据此省略该字段，别写 `{}`（读日志的
 * 人分不清「没有变更」和「变更没记下来」）。
 */
export function sanitizeAuditDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, AppAuditDetailValue> | undefined {
  if (!detail) return undefined;
  const out: Record<string, AppAuditDetailValue> = {};
  let keys = 0;
  for (const [key, raw] of Object.entries(detail)) {
    if (keys >= MAX_DETAIL_KEYS) break;
    if (raw == null) continue;
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '***';
      keys += 1;
      continue;
    }
    if (typeof raw === 'string') {
      out[key] = truncate(raw, MAX_DETAIL_STRING);
      keys += 1;
      continue;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      // 非有限数写进 JSON 会变成 `null`，读回来语义就变了 → 直接丢
      if (typeof raw === 'number' && !Number.isFinite(raw)) continue;
      out[key] = raw;
      keys += 1;
      continue;
    }
    if (Array.isArray(raw)) {
      const list = raw
        .filter((v): v is string => typeof v === 'string')
        .slice(0, MAX_DETAIL_ARRAY)
        .map((v) => truncate(v, MAX_DETAIL_STRING));
      if (list.length) {
        out[key] = list;
        keys += 1;
      }
    }
    // 对象 / 函数 / symbol 一律丢弃：审计行必须小且可读，整对象迟早夹带密钥
  }
  return Object.keys(out).length ? out : undefined;
}

/** 构造一条记录（纯函数；不写盘）。`ctx` 供用例固定时间与身份。 */
export function buildAppAuditRecord(
  input: AppAuditInput,
  ctx?: { now?: number | Date; actor?: string; deviceId?: string | null },
): AppAuditRecord {
  const nowDate = ctx?.now == null ? new Date() : new Date(ctx.now);
  const ts = Number.isNaN(nowDate.getTime()) ? new Date().toISOString() : nowDate.toISOString();
  const record: AppAuditRecord = {
    ts,
    action: input.action,
    outcome: input.outcome ?? 'ok',
    actor: (ctx?.actor ?? currentAppAuditActor()) || APP_AUDIT_LOCAL_ACTOR,
  };
  // deviceId 用「已预热的同步读数」：store 动作是同步的，拿不到 Promise；
  // 未预热就不写这个字段（空串会被当成「来源不明」，比缺字段更难排查）。
  const device = ctx && 'deviceId' in ctx ? ctx.deviceId : currentDeviceId();
  if (device && device.trim()) record.deviceId = device.trim();
  if (input.targetId) record.targetId = truncate(input.targetId, MAX_DETAIL_STRING);
  if (input.targetLabel) record.targetLabel = truncate(input.targetLabel, MAX_TARGET_LABEL);
  const detail = sanitizeAuditDetail(input.detail);
  if (detail) record.detail = detail;
  if (input.reason) record.reason = truncate(input.reason, MAX_REASON);
  return record;
}

/** 序列化为一行（不含 `\n`；`JSON.stringify` 不会产出换行，NDJSON 因此天然安全）。 */
export function serializeAppAuditRecord(record: AppAuditRecord): string {
  const wire: Record<string, unknown> = {
    ts: record.ts,
    action: record.action,
    outcome: record.outcome,
    actor: record.actor,
  };
  if (record.deviceId) wire.deviceId = record.deviceId;
  if (record.targetId) wire.targetId = record.targetId;
  if (record.targetLabel) wire.targetLabel = record.targetLabel;
  if (record.detail) wire.detail = record.detail;
  if (record.reason) wire.reason = record.reason;
  return JSON.stringify(wire);
}

/**
 * 落一条应用操作审计（fire-and-forget）。
 *
 * **永不抛、永不 await**：它是业务动作的旁路，写不进去也不能让「停止一个技能」失败。
 * 调用方按「已经发生的事实」调用，不要放在可能回滚的分支里。
 */
export function recordAppAudit(input: AppAuditInput): void {
  try {
    const line = serializeAppAuditRecord(buildAppAuditRecord(input));
    if (!line) return;
    void platform.auditAppendApp([line]).catch(() => undefined);
  } catch {
    // 序列化异常同样吞掉：审计是旁路
  }
}

/** 计算 patch 里真正变化的字段名（供 detail 使用；顺序按 patch 键序，稳定可比）。 */
export function changedFieldNames(
  before: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | undefined,
): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (before && key in before) {
      const prev = (before as Record<string, unknown>)[key];
      // 对象/数组按 JSON 比较：浅比较会把「内容没变的新数组」全判成变更
      if (JSON.stringify(prev) === JSON.stringify(value)) continue;
    }
    out.push(key);
  }
  return out;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function toDetail(value: unknown): Record<string, AppAuditDetailValue> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  // 读的时候再洗一遍：文件可能被手工编辑过 / 由更老的版本写入
  return sanitizeAuditDetail(value as Record<string, unknown>);
}

function toRecord(
  obj: Record<string, unknown>,
  line: number,
  origin: AppAuditOrigin,
): ParsedAppAuditRecord {
  const record: ParsedAppAuditRecord = {
    ts: asString(obj.ts),
    action: asString(obj.action),
    outcome: asString(obj.outcome) || 'ok',
    actor: asString(obj.actor) || APP_AUDIT_LOCAL_ACTOR,
    line,
    origin,
  };
  const deviceId = asString(obj.deviceId);
  if (deviceId) record.deviceId = deviceId;
  const targetId = asString(obj.targetId);
  if (targetId) record.targetId = targetId;
  const targetLabel = asString(obj.targetLabel);
  if (targetLabel) record.targetLabel = targetLabel;
  const detail = toDetail(obj.detail);
  if (detail) record.detail = detail;
  const reason = asString(obj.reason);
  if (reason) record.reason = reason;
  return record;
}

/**
 * 解析应用操作审计 NDJSON。容错：空行忽略、坏行计入 `skipped`，**永不抛**
 * （审计页读到一个手改坏的文件不该白屏）。
 */
export function parseAppAuditLog(text: string, origin: AppAuditOrigin = 'app'): AppAuditParseResult {
  const records: ParsedAppAuditRecord[] = [];
  let skipped = 0;
  if (!text) return { records, skipped };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        skipped += 1;
        continue;
      }
      // 没有 action 的行没有检索价值（多半是别的文件误拷进来的），算坏行
      if (!asString(parsed.action)) {
        skipped += 1;
        continue;
      }
      records.push(toRecord(parsed, i + 1, origin));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

function matchesAppQuery(record: ParsedAppAuditRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    record.action,
    APP_AUDIT_ACTION_LABELS[record.action as AppAuditAction] ?? '',
    record.targetId ?? '',
    record.targetLabel ?? '',
    record.actor,
    record.deviceId ?? '',
    record.reason ?? '',
    record.detail ? JSON.stringify(record.detail) : '',
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(q);
}

/** 按筛选条件过滤（保持输入顺序；排序交给 `sortAppAuditRecords`）。 */
export function filterAppAuditRecords(
  records: readonly ParsedAppAuditRecord[],
  filters: AppAuditFilters,
): ParsedAppAuditRecord[] {
  return records.filter((r) => {
    if (filters.action !== 'all' && r.action !== filters.action) return false;
    if (filters.outcome !== 'all' && r.outcome !== filters.outcome) return false;
    // 坏时间戳在「按日期筛」时一律判不匹配：宁可少显示，也不能把时间不明的记录
    // 混进「某天到底改了什么」的结论里
    if (filters.from && !(r.ts && r.ts.slice(0, 10) >= filters.from)) return false;
    if (filters.to && !(r.ts && r.ts.slice(0, 10) <= filters.to)) return false;
    if (!matchesAppQuery(r, filters.query)) return false;
    return true;
  });
}

/** 按时间倒序（最新在前）；同一毫秒按行号倒序，保证顺序确定。 */
export function sortAppAuditRecords(
  records: readonly ParsedAppAuditRecord[],
  desc = true,
): ParsedAppAuditRecord[] {
  return [...records].sort((a, b) => {
    const at = a.ts || '';
    const bt = b.ts || '';
    const aEmpty = at === '';
    const bEmpty = bt === '';
    if (aEmpty && bEmpty) return desc ? b.line - a.line : a.line - b.line;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (at === bt && a.line !== b.line) return desc ? b.line - a.line : a.line - b.line;
    if (at === bt) {
      // 同秒同行的两份文件（本机 / 引擎）：固定让本机在前，避免排序不稳定
      if (a.origin === b.origin) return 0;
      return a.origin === 'app' ? -1 : 1;
    }
    const cmp = at < bt ? -1 : 1;
    return desc ? -cmp : cmp;
  });
}

/**
 * 合并多个来源的记录（本机 + 引擎）。
 *
 * 只做拼接，排序交给 `sortAppAuditRecords`——两边的行号各自从 1 开始，
 * 直接按行号交错会得到看起来随机的时间轴。
 */
export function mergeAppAuditRecords(
  ...lists: readonly ParsedAppAuditRecord[][]
): ParsedAppAuditRecord[] {
  return lists.flatMap((list) => list);
}

/** 取出现过的动作（按频次降序），供「动作」下拉只列出真有记录的那几项。 */
export function distinctAppAuditActions(
  records: readonly ParsedAppAuditRecord[],
): AppAuditAction[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (!r.action) continue;
    counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => v as AppAuditAction);
}

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导出 CSV（带表头）；列为审计文件的原始字段名（snake-less，与引擎那份不同但各自自洽）。 */
export function exportAppAuditCsv(records: readonly ParsedAppAuditRecord[]): string {
  const header = ['ts', 'action', 'action_label', 'outcome', 'actor', 'device_id', 'target_id', 'target_label', 'detail', 'reason'];
  const rows = records.map((r) =>
    [
      r.ts,
      r.action,
      APP_AUDIT_ACTION_LABELS[r.action as AppAuditAction] ?? r.action,
      r.outcome,
      r.actor,
      r.deviceId ?? '',
      r.targetId ?? '',
      r.targetLabel ?? '',
      r.detail ? JSON.stringify(r.detail) : '',
      r.reason ?? '',
    ]
      .map(csvEscape)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}
