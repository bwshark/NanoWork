/**
 * 运行日志的落盘（FR-11.3）——`<userData>/logs/<date>/<module>.log`。
 *
 * ## 为什么与 `eventStore` / `artifactIndex` 一样单独成模块
 *
 * `main.ts` 无法被 import（顶层依赖 `app.whenReady` + 一堆副作用），自然无法单测。
 * 把 IO 抽成「只依赖 `node:fs`、根从外部注入」的模块后，就能用 `mkdtemp` 把
 * 「追加 → 列目录 → 清理」整条链路跑通，`main.ts` 只留「把方法挂到 IPC」一件事。
 * 这是本项目新增存储能力的一贯做法。
 *
 * ## 三条形态约定
 *
 * 1. **一行一条，只追加**。`appendFile` 不读全文——日志是「越写越多」的东西，
 *    read-modify-write 会随文件增长越来越慢，并在并发时互相覆盖。
 * 2. **按模块分文件，按本地日分目录**。目录回答「我哪天用的」，行内 ISO 时间回答
 *    「精确到毫秒的先后」（见 `@/observability/logging` 的 `formatLogLine`）。
 * 3. **失败静默**。日志写不进去（磁盘满 / 权限）不该让业务调用失败——调用方全是
 *    fire-and-forget 的埋点。这与「审计 fail-open」是同一条纪律。
 *
 * 模块名与等级走 `@/observability/logging` 的**白名单**，于是「模块名拼进路径」
 * 这条攻击面根本不成立（不需要在这里再挡一次路径穿越）。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LOG_KEEP_DAYS,
  DEFAULT_LOG_LEVEL,
  LOG_DIR_NAME,
  formatLogLine,
  isLogDateSegment,
  isLogModule,
  logDateSegment,
  logDateSegmentToMs,
  logFileName,
  logRetentionCutoff,
  normalizeLogLevel,
  shouldLog,
  type LogLevel,
  type LogLineInput,
  type LogModule,
} from '../src/observability/logging';
import {
  selectOverflowDirs,
  selectPrunableDirs,
  type RetainedDirEntry,
} from '../src/observability/retention';

/** 日志根目录：`<userData>/logs` */
export function logsRoot(userData: string): string {
  return join(userData, LOG_DIR_NAME);
}

/** 某天某模块的日志文件绝对路径 */
export function logFileFor(userData: string, at: number | Date, module: LogModule): string {
  return join(logsRoot(userData), logDateSegment(at), logFileName(module));
}

/**
 * 追加一行。
 *
 * `module` 非法时**直接丢弃并返回 false**，而不是抛错：调用方是埋点，
 * 埋点写错一个模块名不该把用户的发送流程打挂（症状会变成「发消息报错」，
 * 与真正的原因相隔十万八千里）。
 */
export async function appendLogLine(userData: string, input: LogLineInput): Promise<boolean> {
  if (!isLogModule(input.module)) return false;
  const dir = join(logsRoot(userData), logDateSegment(input.at));
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(logFileFor(userData, input.at, input.module), `${formatLogLine(input)}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出全部日期目录，供保留策略决策。
 *
 * `newestMs` 取**目录名对应的本地零点**，不取文件 mtime——理由见
 * `@/observability/logging` 的 `logDateSegmentToMs`：目录名才是「这批日志属于哪一天」
 * 这个事实，mtime 只是「最后一次往里写」。名字解析不出来的给 0（可清）。
 */
export async function listLogDirs(userData: string): Promise<RetainedDirEntry[]> {
  const root = logsRoot(userData);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: RetainedDirEntry[] = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ name, newestMs: logDateSegmentToMs(name) ?? 0 });
  }
  return out;
}

/**
 * 删除一个只含文件的目录（**浅删除**）。
 *
 * ⚠️ 刻意**不用** `fs.rm(dir, { recursive: true })`：本机宿主的批量删除守卫会拦下
 * 递归删除并让调用挂住几十秒（`tests/electron/*` 的既有 flake 就出在这个形态上）。
 * 日志目录只有若干 `.log` 文件、没有子目录，逐个 unlink 再 rmdir 完全够用，
 * 且不触发守卫。出现子目录时**整个目录放弃删除**——宁可留着，也不猜用户放了什么。
 */
async function removeDirShallow(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory())) return false;
    for (const e of entries) await fs.unlink(join(dir, e.name));
    await fs.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

export interface LogPruneOptions {
  /** 当前时刻（epoch ms） */
  now: number;
  /** 保留天数；`<= 0` 表示不按时间清理 */
  keepDays?: number;
  /** 日期目录数上限（同一天狂写时的兜底闸） */
  maxDateDirs?: number;
}

/** 默认日期目录上限：14 天 × 单日几个目录足够，超过基本意味着异常 */
export const DEFAULT_LOG_MAX_DATE_DIRS = 30;

/** 按保留策略清理旧日志目录；返回删除的目录名 */
export async function pruneLogs(
  userData: string,
  options: LogPruneOptions,
): Promise<string[]> {
  const keepDays = options.keepDays ?? DEFAULT_LOG_KEEP_DAYS;
  const maxDateDirs = options.maxDateDirs ?? DEFAULT_LOG_MAX_DATE_DIRS;
  const dirs = await listLogDirs(userData);
  const byAge = selectPrunableDirs(
    dirs,
    logRetentionCutoff(options.now, keepDays),
    isLogDateSegment,
  );
  const remaining = dirs.filter((d) => !byAge.includes(d.name));
  const byCount = selectOverflowDirs(remaining, maxDateDirs, isLogDateSegment);

  const removed: string[] = [];
  for (const name of new Set([...byAge, ...byCount])) {
    if (await removeDirShallow(join(logsRoot(userData), name))) removed.push(name);
  }
  return removed;
}

export interface DiagnosticFileStat {
  /** 相对 `<userData>` 的路径（正斜杠），诊断包里也用这个形态 */
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

/** 列出全部日志文件的相对路径与大小（诊断包与界面统计共用） */
export async function listLogFiles(userData: string): Promise<DiagnosticFileStat[]> {
  const root = logsRoot(userData);
  const out: DiagnosticFileStat[] = [];
  let dateDirs: string[];
  try {
    dateDirs = await fs.readdir(root);
  } catch {
    return out;
  }
  for (const date of dateDirs) {
    if (!isLogDateSegment(date)) continue;
    const dir = join(root, date);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const st = await fs.stat(join(dir, name));
        if (!st.isFile()) continue;
        out.push({ relativePath: `${LOG_DIR_NAME}/${date}/${name}`, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* 单个文件读不到就跳过，不让统计整体失败 */
      }
    }
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export interface LogStats {
  dir: string;
  files: number;
  bytes: number;
  /** 有日志的日期（升序） */
  dates: string[];
}

/** 界面用的统计（「诊断」分区显示落点与体量） */
export async function logStats(userData: string): Promise<LogStats> {
  const files = await listLogFiles(userData);
  const dates = [...new Set(files.map((f) => f.relativePath.split('/')[1] ?? ''))].filter(Boolean);
  return {
    dir: logsRoot(userData),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    dates: dates.sort(),
  };
}

/** 主进程侧的行写入口（同步返回、异步落盘、失败静默） */
export type LeveledFileLogFn = (
  module: LogModule,
  level: LogLevel,
  message: string,
  detail?: unknown,
) => void;

/**
 * 造一个「写进日志文件」的门面（主进程自己用）。
 *
 * 与渲染层那份（`@/observability/logger`）的区别只在**传输方式**：渲染层要过 IPC，
 * 主进程直接落盘。等级 gate、格式化、模块白名单三件事两侧共用同一份纯模块
 * ——这正是「日志两侧各写一遍必然漂移」的预防措施。
 */
export function createFileLogger(
  userData: string,
  minLevel: LogLevel = DEFAULT_LOG_LEVEL,
): LeveledFileLogFn {
  return (module, level, message, detail) => {
    if (!isLogModule(module)) return;
    if (!shouldLog(normalizeLogLevel(level), minLevel)) return;
    void appendLogLine(userData, { at: Date.now(), module, level, message, detail });
  };
}
