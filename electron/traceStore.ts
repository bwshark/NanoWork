/**
 * 全链路 trace 的落盘（FR-11.2）——`<userData>/traces/<pid>/<traceId>.json`。
 *
 * 布局与 WorkBuddy 同构（`traces/<pid>/trace_*.json`）：同构的价值是排障经验与
 * 工具可以直接复用，不必为「我们家的 trace 在哪」重新建立心智模型。
 *
 * ## 为什么 `workerPid` / `workerHostname` 在这里补
 *
 * 渲染层不知道**写文件那个进程**的 pid（它拿到的是渲染进程的），而在诊断数据里
 * 写一个「看起来像答案的错值」比缺字段更坏——查的人会据此去另一个进程上找。
 * 所以 trace 由渲染层按事件流派生（那是它独有的知识），而「谁写的」由主进程在
 * 落盘时盖上，文件里永远是事实。
 *
 * ## 为什么不需要读入口
 *
 * trace 的**权威**是磁盘上这些文件本身，没有任何内存态需要与它对齐。诊断包导出
 * 时直接按字节复制文件（见 `electron/diagnostics.ts`），因此不提供「读一条 trace」
 * 的能力——多一个读入口就多一个「谁是权威」的歧义。
 */

import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TRACE_KEEP_DAYS,
  TRACE_DIR_NAME,
  isValidTraceId,
  type TraceFile,
} from '../src/observability/trace';
import {
  selectOverflowDirs,
  selectPrunableDirs,
  type RetainedDirEntry,
} from '../src/observability/retention';
import type { DiagnosticFileStat } from './logStore';

/** trace 根目录：`<userData>/traces` */
export function tracesRoot(userData: string): string {
  return join(userData, TRACE_DIR_NAME);
}

/** pid 是单段数字目录名，其余一律不认（渲染层传进来的值必须先过这一关） */
export function isValidTracePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 2 ** 31;
}

export function traceDirFor(userData: string, pid: number): string {
  return join(tracesRoot(userData), String(pid));
}

export function traceFileFor(userData: string, pid: number, traceId: string): string {
  return join(traceDirFor(userData, pid), `${traceId}.json`);
}

export interface WriteTraceResult {
  path: string;
  bytes: number;
}

/**
 * 写入一份 trace；不合法（pid / traceId 形态不对）返回 `null` 而不抛。
 *
 * 失败方向是「静默丢弃」：可观测性产物写不进去不该影响用户这一轮对话
 * ——调用点在回合收尾路径上。
 */
export async function writeTrace(
  userData: string,
  file: TraceFile,
  origin: { pid: number; hostname: string } = { pid: process.pid, hostname: hostname() },
): Promise<WriteTraceResult | null> {
  const traceId = file?.trace?.traceId;
  if (!isValidTraceId(traceId)) return null;
  if (!isValidTracePid(origin.pid)) return null;

  const dir = traceDirFor(userData, origin.pid);
  const stamped: TraceFile = {
    trace: {
      ...file.trace,
      workerPid: origin.pid,
      workerHostname: origin.hostname,
    },
    spans: file.spans,
  };
  const text = `${JSON.stringify(stamped)}\n`;
  try {
    await fs.mkdir(dir, { recursive: true });
    const path = traceFileFor(userData, origin.pid, traceId);
    await fs.writeFile(path, text, 'utf-8');
    return { path, bytes: Buffer.byteLength(text) };
  } catch {
    return null;
  }
}

/** pid 目录内最新文件 mtime；空目录返回 0 */
async function newestMtimeMs(dir: string): Promise<number> {
  try {
    const names = await fs.readdir(dir);
    let newest = 0;
    for (const name of names) {
      try {
        const st = await fs.stat(join(dir, name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* 单个文件查不到不影响整体判断 */
      }
    }
    return newest;
  } catch {
    return 0;
  }
}

export async function listTraceDirs(userData: string): Promise<RetainedDirEntry[]> {
  const root = tracesRoot(userData);
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
    out.push({ name, newestMs: await newestMtimeMs(dir) });
  }
  return out;
}

/** 浅删除（理由见 `logStore.removeDirShallow`：避开宿主批量删除守卫） */
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

export interface TracePruneOptions {
  now: number;
  keepDays?: number;
  maxPidDirs?: number;
}

/**
 * pid 目录上限。
 *
 * 只有天数闸是不够的：**每次启动都是一个新的 pid**，所以「一天开了 50 次应用」
 * 就是 50 个目录，而它们全是「今天的」——时间闸一个都清不掉。
 */
export const DEFAULT_TRACE_MAX_PID_DIRS = 40;

export async function pruneTraces(
  userData: string,
  options: TracePruneOptions,
): Promise<string[]> {
  const keepDays = options.keepDays ?? DEFAULT_TRACE_KEEP_DAYS;
  const maxPidDirs = options.maxPidDirs ?? DEFAULT_TRACE_MAX_PID_DIRS;
  const dirs = await listTraceDirs(userData);
  const isPid = (n: string) => /^\d+$/.test(n);
  const byAge = selectPrunableDirs(
    dirs,
    keepDays > 0 ? options.now - keepDays * 24 * 60 * 60 * 1000 : 0,
    isPid,
  );
  const remaining = dirs.filter((d) => !byAge.includes(d.name));
  const byCount = selectOverflowDirs(remaining, maxPidDirs, isPid);

  const removed: string[] = [];
  for (const name of new Set([...byAge, ...byCount])) {
    if (await removeDirShallow(join(tracesRoot(userData), name))) removed.push(name);
  }
  return removed;
}

/** 列出全部 trace 文件（诊断包与界面统计共用；不含读内容——权威就是文件本身） */
export async function listTraceFiles(userData: string): Promise<DiagnosticFileStat[]> {
  const root = tracesRoot(userData);
  const out: DiagnosticFileStat[] = [];
  let pidDirs: string[];
  try {
    pidDirs = await fs.readdir(root);
  } catch {
    return out;
  }
  for (const pid of pidDirs) {
    if (!/^\d+$/.test(pid)) continue;
    const dir = join(root, pid);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const st = await fs.stat(join(dir, name));
        if (!st.isFile()) continue;
        out.push({
          relativePath: `${TRACE_DIR_NAME}/${pid}/${name}`,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export interface TraceStats {
  dir: string;
  files: number;
  bytes: number;
}

export async function traceStats(userData: string): Promise<TraceStats> {
  const files = await listTraceFiles(userData);
  return {
    dir: tracesRoot(userData),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  };
}
