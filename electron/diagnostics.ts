/**
 * 诊断包（FR-11.3 的「一键打包诊断」）——把现场一次性带走。
 *
 * ## 包里有什么
 *
 * ```
 * meta.json      应用版本 / 运行时版本 / 平台 / 设备 ID / 各类文件数与体量
 * README.txt     这份包是什么、怎么读、**包含什么隐私**
 * logs/<date>/<module>.log     运行日志（按模块分文件）
 * traces/<pid>/<traceId>.json  全链路 trace（按进程分目录）
 * ```
 *
 * ## 刻意**不**装进包里的东西
 *
 * - `nanowork.config.json` / `channels.json` / `connectors/`：**含明文凭据**
 *   （引擎要读，见 §7.9 的「凭据有三份副本」）。诊断包是会被用户发出去的，
 *   把凭据塞进去等于教用户泄露；需要网关配置时让用户自己挑字段贴出来。
 * - 事件流（`projects/<slug>/<sessionId>.jsonl`）：体积大且**含完整对话正文**。排查「某一轮为什么
 *   这样」时 trace 已经够用（工具参数、结果、状态、耗时都在里面）。
 *
 * ## 体积闸
 *
 * 日志与 trace 都是「越用越多」的东西，直接打包可能变成几百 MB。策略是**先保最新的**：
 * 按 mtime 从新到旧累加，触到上限就停（`meta.json` 里记下被截断的事实，而不是
 * 悄悄少装几个文件——那样拿到包的人会以为「就这些」）。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOG_KEEP_DAYS, LOG_DIR_NAME } from '../src/observability/logging';
import { DEFAULT_TRACE_KEEP_DAYS, TRACE_DIR_NAME } from '../src/observability/trace';
import { listLogFiles, type DiagnosticFileStat } from './logStore';
import { listTraceFiles } from './traceStore';
import { createZip, type ZipEntryInput } from './zipWriter';

/** 诊断包体积上限（解压前）；超出的按 mtime 从旧到新丢弃 */
export const DIAGNOSTICS_MAX_BYTES = 25 * 1024 * 1024;

/** trace 单次最多带多少个（每个可能几百 KB，默认带上最近的 50 个） */
export const DIAGNOSTICS_MAX_TRACES = 50;

export interface DiagnosticsAppInfo {
  appName?: string;
  version?: string;
  electron?: string;
  node?: string;
  chrome?: string;
  platform?: string;
  osVersion?: string;
  arch?: string;
  deviceId?: string;
}

export interface DiagnosticsBundle {
  bytes: Buffer;
  /** 实际进包的条目数（含 meta / README） */
  entryCount: number;
  /** 进包的相对路径 */
  entries: string[];
  /** 因体积上限被丢弃的文件数 */
  skipped: number;
}

export interface BuildDiagnosticsOptions {
  userData: string;
  appInfo?: DiagnosticsAppInfo;
  now?: number;
  maxBytes?: number;
  maxTraces?: number;
}

/** 新→旧排序后累加，直到超过预算 */
function takeWithinBudget(
  files: readonly DiagnosticFileStat[],
  budget: number,
): { taken: DiagnosticFileStat[]; skipped: number } {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const taken: DiagnosticFileStat[] = [];
  let used = 0;
  for (const f of sorted) {
    if (f.bytes > budget - used) continue;
    taken.push(f);
    used += f.bytes;
  }
  return { taken, skipped: sorted.length - taken.length };
}

function readmeText(counts: {
  logFiles: number;
  traceFiles: number;
  skipped: number;
  now: number;
}): string {
  return [
    'NanoWork 诊断包',
    `生成时间：${new Date(counts.now).toISOString()}`,
    '',
    '内容：',
    '  meta.json     应用与运行时版本、平台、设备 ID',
    `  ${LOG_DIR_NAME}/  运行日志（按日期目录 / 模块分文件，一行一条）`,
    `  ${TRACE_DIR_NAME}/  全链路 trace（按进程 pid 分目录，一个回合一份）`,
    `  本次装入：日志 ${counts.logFiles} 个、trace ${counts.traceFiles} 个` +
      (counts.skipped > 0 ? `；因体积上限跳过 ${counts.skipped} 个（已是最新优先）` : ''),
    '',
    '怎么读：',
    '  日志行形如 [ISO 时间] [模块] 级别 消息 [JSON 详情]，直接 grep 模块名或级别即可。',
    '  trace 是 { trace, spans }：trace 给整个回合的起止与状态，spans 给每一步工具调用',
    '  的参数、结果与耗时；排查「哪一步慢 / 哪一步失败 / 为什么被拒」看 spans。',
    '',
    '⚠️ 隐私提示：',
    '  本包含有工具调用的参数与结果，可能涉及文件路径、代码片段与命令输出；',
    '  但**不含**对话提问正文、也不含 API Key / 渠道凭据。发送给他人前请自行确认。',
    '',
  ].join('\n');
}

/** 组装诊断包（只读，不删除任何东西） */
export async function buildDiagnosticsBundle(
  options: BuildDiagnosticsOptions,
): Promise<DiagnosticsBundle> {
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? DIAGNOSTICS_MAX_BYTES;
  const maxTraces = options.maxTraces ?? DIAGNOSTICS_MAX_TRACES;

  const allLogs = await listLogFiles(options.userData);
  const allTraces = (await listTraceFiles(options.userData)).slice();

  // meta / README 也要占额度，先给它们留一个保守的量再分配
  const reserve = 64 * 1024;
  const logsTake = takeWithinBudget(allLogs, Math.max(0, maxBytes - reserve));
  const tracesForBudget = [...allTraces].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxTraces);
  const tracesTake = takeWithinBudget(
    tracesForBudget,
    Math.max(0, maxBytes - reserve - logsTake.taken.reduce((n, f) => n + f.bytes, 0)),
  );

  const meta = {
    generatedAt: new Date(now).toISOString(),
    app: options.appInfo ?? {},
    retention: { logKeepDays: DEFAULT_LOG_KEEP_DAYS, traceKeepDays: DEFAULT_TRACE_KEEP_DAYS },
    counts: {
      logFiles: logsTake.taken.length,
      logBytes: logsTake.taken.reduce((n, f) => n + f.bytes, 0),
      traceFiles: tracesTake.taken.length,
      traceBytes: tracesTake.taken.reduce((n, f) => n + f.bytes, 0),
      totalAvailable: { logs: allLogs.length, traces: allTraces.length },
    },
  };

  const entries: ZipEntryInput[] = [
    { name: 'README.txt', data: readmeText({ ...meta.counts, skipped: logsTake.skipped + tracesTake.skipped, now }) },
    { name: 'meta.json', data: `${JSON.stringify(meta, null, 2)}\n` },
  ];

  for (const f of [...logsTake.taken, ...tracesTake.taken]) {
    try {
      const data = await fs.readFile(join(options.userData, ...f.relativePath.split('/')));
      entries.push({ name: f.relativePath, data, mtimeMs: f.mtimeMs });
    } catch {
      /* 单个文件读不到就跳过：能带走多少带多少 */
    }
  }

  // 计数必须来自**真的进了包**的条目：读失败的文件如果也算进去，
  // 拿到包的人会对着一份少几个文件的包以为「就这些」。
  const pushed = entries.map((e) => e.name);
  return {
    bytes: createZip(entries, now),
    entryCount: pushed.length,
    entries: pushed,
    skipped: allLogs.length + allTraces.length - (pushed.length - 2 /* README + meta */),
  };
}
