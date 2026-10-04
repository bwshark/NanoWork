/**
 * 运行日志的分级与命名（FR-11.3）——**纯逻辑，两侧共用**。
 *
 * ## 为什么单独一个模块
 *
 * 日志这条链路上有两个进程：渲染层产生绝大多数日志（聊天 / 同步 / 技能 / 插件），
 * 而**只有主进程能写文件**（`<userData>/logs/<date>/<module>.log`）。于是：
 *
 * ```
 * 渲染层  logger.info('chat', '…')  →  platform.appendLog(entry)  ┐
 *                                                                  ├→ 主进程 logStore 落盘
 * 主进程  自身的事件（启动 / 网关 / IPC）────────────────────────┘
 * ```
 *
 * 两侧必须对**等级顺序、模块名、行格式、目录命名**有完全一致的理解，否则会
 * 出现「渲染层写了两条、主进程只认出其中一条」这类静默偏差。所以这一份放在
 * 纯模块里，两端 `import` 同一份——本文件**不得** import `node:*`
 * （渲染层 bundle 里没有 node 内置模块），路径拼接留在 `electron/logStore.ts`。
 *
 * ## 为什么不按等级开多个文件
 *
 * WorkBuddy 的做法是 `logs/<date>/<module>.log`——按**模块**分文件。按等级分
 * （`error.log` / `info.log`）看似好查，实际是把「谁在说话」和「说了多严重」
 * 两个正交维度压进一个维度：排查某个模块的问题时仍要跨文件拼接。等级只作为
 * 行内字段，需要时 `grep ERROR` 即可。
 */

/** 日志等级，由低到高 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 等级 → 权重。数值比较替代 `switch`，新增等级只需改这一处 */
export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * 允许的模块名白名单——**它同时是文件名的取值域**。
 *
 * 不做自由字符串有两个原因：
 *
 * 1. **文件名来自这个值**。自由字符串意味着 `module` 一旦拼进路径就能写出
 *    `logs/` 之外的文件（`../../` 那一类），必须在主进程再挡一次；白名单让
 *    这条攻击面根本不存在，而不是「记得去挡」。
 * 2. 模块名会进 `grep` 与诊断包的文件清单，**有限的取值**才能让人一眼看出
 *    「有哪些东西在说话」。新增模块改这一行，成本极低。
 */
export const LOG_MODULES = [
  'app', // 应用生命周期（启动 / 退出 / 单实例）
  'chat', // 对话与流式
  'engine', // nanobot serve 子进程
  'events', // 事件流读写
  'gateway', // 网关（端口解析 / 桥接）
  'ipc', // 主进程 IPC 异常
  'mcp', // 连接器
  'memory', // 记忆链路
  'plugin', // 插件与市场
  'settings', // 配置读写
  'skills', // 技能
  'storage', // 落盘路由
  'sync', // 跨端同步
  'task', // 定时任务
  'trace', // trace 落盘自身的失败
  'window', // 窗口 / 托盘 / 快捷键
] as const;

export type LogModule = (typeof LOG_MODULES)[number];

/** 默认最低等级：`debug` 只在开发态有意义，落盘只会淹掉有用信息 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** 日志目录名（`<userData>/logs`）；trace 侧另有 `traces` */
export const LOG_DIR_NAME = 'logs';

/** 默认保留天数；`<= 0` 表示不清理 */
export const DEFAULT_LOG_KEEP_DAYS = 14;

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVEL_RANK, value)
  );
}

export function isLogModule(value: unknown): value is LogModule {
  return typeof value === 'string' && (LOG_MODULES as readonly string[]).includes(value);
}

/**
 * 把任意输入收敛成合法等级。
 *
 * 非法值一律折回 `fallback`（默认 `info`）而**不抛错**：日志是旁路，
 * 它自己出问题不该把业务调用打断——与「审计 fail-open」同一条纪律。
 */
export function normalizeLogLevel(value: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  return isLogLevel(value) ? value : fallback;
}

/** 该等级是否应当落盘（`min` 是配置的最低等级） */
export function shouldLog(level: LogLevel, min: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[min];
}

/** `<module>.log`；`module` 已由白名单保证是单段安全文件名 */
export function logFileName(module: LogModule): string {
  return `${module}.log`;
}

/** 本地日目录名 `YYYY-MM-DD`（**本地**时区：日志是给本机排查用的，不该按 UTC 归日） */
export function logDateSegment(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 合法日期段（主进程清理旧目录时要挡掉任何非本格式的名字） */
export function isLogDateSegment(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 日期段 → 该日的**本地零点**时间戳；非法返回 `null`。
 *
 * 日志目录的年龄按**目录名**判，不按文件 mtime：目录名就是「这批日志属于哪一天」，
 * 而 mtime 是「最后一次往里写是什么时候」——把一个很久以前的日志目录拷进来查看，
 * mtime 会是「刚刚」，于是它永远不会被清理；反过来，名字是唯一的权威事实。
 *
 * ⚠️ 光靠正则不够：`2026-13-99` 也符合 `YYYY-MM-DD` 的形状，而 `new Date(2026, 12, 40)`
 * 会**静默滚到 2027 年**——那样这个目录的年龄被算错一个年级别，还会和相邻目录撞名。
 * 故做一次往返校验。
 */
export function logDateSegmentToMs(segment: string): number | null {
  if (!isLogDateSegment(segment)) return null;
  const [y, m, d] = segment.split('-').map((p) => Number(p));
  if (y === undefined || m === undefined || d === undefined) return null;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

export interface LogLineInput {
  /** 发生时刻（epoch ms） */
  at: number;
  level: LogLevel;
  module: LogModule;
  message: string;
  /** 结构化补充（对象会被 JSON 化；字符串原样；其余走 String()） */
  detail?: unknown;
}

/** 把 detail 压成**单行**文本；失败不抛（环状引用 / BigInt 等） */
function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return '';
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * 格式化一行日志（**不带换行符**，调用方自己补 `\n`）。
 *
 * 形态：`[ISO] [module] LEVEL message detail`
 *
 * - ISO 用 UTC（`Z` 结尾）：多机诊断包合并时不会因为时区不同而错序；
 *   目录名仍是本地日——**目录回答「我哪天用的」，行内时间回答「精确到毫秒的先后」**。
 * - 换行一律转义成 `\n` 字面量：一行一条是 `grep` / 追加写入的前提，
 *   消息里带真实换行会把一条日志劈成两行、让解析器把后半截当成新记录。
 */
export function formatLogLine(input: LogLineInput): string {
  const iso = new Date(input.at).toISOString();
  const message = String(input.message).replace(/\r?\n/g, '\\n');
  const detail = formatDetail(input.detail);
  return `[${iso}] [${input.module}] ${input.level.toUpperCase()} ${message}${detail ? ` ${detail}` : ''}`;
}

/**
 * 保留期截止时间（epoch ms）：早于它的文件可清。
 *
 * `keepDays <= 0` / 非有限数 → 返回 0，语义是「不要清理」。这个方向是刻意的：
 * 配置写坏时宁可占盘也不能把用户还没来得及导出的日志删掉。
 */
export function logRetentionCutoff(now: number, keepDays: number): number {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return 0;
  return now - keepDays * 24 * 60 * 60 * 1000;
}
