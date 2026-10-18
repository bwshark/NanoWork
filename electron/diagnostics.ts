/**
 * 诊断包（FR-11.3 的「一键打包诊断」）——把现场一次性带走。
 *
 * ## 包里有什么
 *
 * ```
 * meta.json      应用版本 / 运行时版本 / 平台 / 设备 ID / 各类文件数与体量
 * README.txt     这份包是什么、怎么读、**包含什么隐私**
 * processes.json 进程与端口快照（本进程 pid、引擎端口被谁占、run/ 状态文件死活）
 * logs/<date>/<module>.log     运行日志（按模块分文件，**已脱敏**）
 * traces/<pid>/<traceId>.json  全链路 trace（按进程分目录，**已脱敏**）
 * ```
 *
 * ## 出口脱敏（FR-11.9）
 *
 * 日志与 trace 进包前会过一遍 `secretRedaction`（键值对 / Bearer / sk- / JWT 四类模式）。
 * **本地日志保持原文**——排查「为什么这把密钥 401」时脱敏过的日志是废纸；只有要被
 * 发出去的这份才脱敏。⚠️ 模式匹配覆盖不了「长得不像凭据的凭据」，这一层不自称完备，
 * 真正的保证仍然是下面那条「含凭据的文件根本不进包」。
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
import { redactSecrets } from './secretRedaction';
import type { ProcessSnapshot } from './gatewayRuntimeState';

/** 诊断包体积上限（解压前）；超出的按 mtime 从旧到新丢弃 */
export const DIAGNOSTICS_MAX_BYTES = 25 * 1024 * 1024;

/** trace 单次最多带多少个（每个可能几百 KB，默认带上最近的 50 个） */
export const DIAGNOSTICS_MAX_TRACES = 50;

/**
 * 会话首字延迟样本的文件名。
 *
 * ⚠️ **与 `main.ts` 的写入点共用这一个常量**：两处各写一份 `'session-latency.jsonl'`
 * 时，改名只会在一边生效，表现为「包里永远没有延迟摘要」且没有任何报错。
 */
export const SESSION_LATENCY_FILE = 'session-latency.jsonl';

/** 启动剖析报告文件名；只有 `NANOWORK_STARTUP_PROFILE=1` 时才会存在。 */
export const STARTUP_PROFILE_FILE = 'startup-profile.jsonl';

/** 额外文件（启动剖析 / 延迟样本）的读取上限：摘要不需要把无限增长的文件整份读进内存。 */
const MAX_EXTRA_READ_BYTES = 2 * 1024 * 1024;

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
  /**
   * 本次进包时被脱敏的匹配数。
   *
   * 必须回传给界面：用户要能看见「这包被改过多少处」才敢发出去。
   * 只写在包内 README 里等于把清单藏在用户最不方便看的那个地方。
   */
  redactionHits: number;
}

/** 单个延迟指标的四分位摘要（毫秒）。 */
export interface LatencyMetric {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

/** `session-latency.jsonl` 的摘要（**不**整份进包：原始样本会无限增长）。 */
export interface LatencySummary {
  /** 解析到的样本行数（含未测到的行）。 */
  count: number;
  /** `ttftMs` 有效样本的摘要；一条有效值都没有时缺省。 */
  ttftMs?: LatencyMetric;
  /** `firstTokenLatencyMs` 有效样本的摘要；同上。 */
  firstTokenLatencyMs?: LatencyMetric;
  /** 最近若干条，供报告直接画时间轴（只带 at 与 ttft，不重复整份记录）。 */
  recent: Array<{ at: number; ttftMs: number | null }>;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  // 最近秩法：p95 落在「第 95% 个样本」上。样本很少时退化为最大值，
  // 而不是插值出一个不存在的耗时——报告要能被对照回真实请求。
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[rank];
}

function metricOf(values: readonly number[]): LatencyMetric | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

function readTail(text: string, maxLines: number): string[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.slice(-maxLines);
}

/**
 * 把 `session-latency.jsonl` 聚合成摘要。
 *
 * 逐行解析、坏行忽略：这个文件是**运行期追加**的，进程被杀时最后一行可能是半条；
 * 一条坏行不该让整份摘要消失。
 */
export function summarizeLatencySamples(
  text: string,
  options: { maxLines?: number; recentLimit?: number } = {},
): LatencySummary | null {
  const lines = readTail(text, options.maxLines ?? 5000);
  if (lines.length === 0) return null;

  const ttft: number[] = [];
  const firstToken: number[] = [];
  const recent: Array<{ at: number; ttftMs: number | null }> = [];
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : null;
    const ttftMs =
      typeof record.ttftMs === 'number' && Number.isFinite(record.ttftMs)
        ? record.ttftMs
        : null;
    const firstTokenLatencyMs =
      typeof record.firstTokenLatencyMs === 'number' &&
      Number.isFinite(record.firstTokenLatencyMs)
        ? record.firstTokenLatencyMs
        : null;
    if (ttftMs !== null) ttft.push(ttftMs);
    if (firstTokenLatencyMs !== null) firstToken.push(firstTokenLatencyMs);
    if (at !== null) recent.push({ at, ttftMs });
  }

  if (ttft.length === 0 && firstToken.length === 0) return null;
  return {
    count: lines.length,
    ttftMs: metricOf(ttft),
    firstTokenLatencyMs: metricOf(firstToken),
    recent: recent.slice(-(options.recentLimit ?? 50)),
  };
}

/** 截断到上限内，并在换行处收口（避免留下半条 JSON，让人误判为坏数据）。 */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return cut > 0 ? text.slice(0, cut + 1) : text.slice(0, max);
}

export interface BuildDiagnosticsOptions {
  userData: string;
  appInfo?: DiagnosticsAppInfo;
  /** 进程/端口快照（FR-11.9）；不给就不生成 processes.json */
  processSnapshot?: ProcessSnapshot;
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
  hasProcesses: boolean;
  hasStartupProfile: boolean;
  hasLatencySummary: boolean;
  redactedHits: number;
}): string {
  return [
    'NanoWork 诊断包',
    `生成时间：${new Date(counts.now).toISOString()}`,
    '',
    '内容：',
    '  meta.json       应用与运行时版本、平台、设备 ID',
    ...(counts.hasProcesses
      ? ['  processes.json  进程与端口快照（本进程 pid / 引擎端口占用者 / run 状态文件死活）']
      : []),
    `  ${LOG_DIR_NAME}/  运行日志（按日期目录 / 模块分文件，一行一条）`,
    `  ${TRACE_DIR_NAME}/  全链路 trace（按进程 pid 分目录，一个回合一份）`,
    ...(counts.hasStartupProfile
      ? ['  startup-profile.jsonl  启动剖析（每次启动一行；仅开启 NANOWORK_STARTUP_PROFILE 时存在）']
      : []),
    ...(counts.hasLatencySummary
      ? ['  session-latency.summary.json  会话首字延迟摘要（min / p50 / p95 / max + 最近样本）']
      : []),
    `  本次装入：日志 ${counts.logFiles} 个、trace ${counts.traceFiles} 个` +
      (counts.skipped > 0 ? `；因体积上限跳过 ${counts.skipped} 个（已是最新优先）` : ''),
    '',
    '怎么读：',
    '  日志行形如 [ISO 时间] [模块] 级别 消息 [JSON 详情]，直接 grep 模块名或级别即可。',
    '  trace 是 { trace, spans }：trace 给整个回合的起止与状态，spans 给每一步工具调用',
    '  的参数、结果与耗时；排查「哪一步慢 / 哪一步失败 / 为什么被拒」看 spans。',
    ...(counts.hasProcesses
      ? [
          '  processes.json 的 listeners 回答「18900 / 18790 / 9900 有没有被占、被谁占」；',
          '  gatewayStates 回答「run/ 里每份状态文件是活的还是僵尸（verdict 字段）」。',
        ]
      : []),
    '',
    '脱敏说明：',
    `  日志、trace 与启动剖析进包前已做凭据脱敏（本次命中 ${counts.redactedHits} 处，形如 ab12...wxyz）。`,
    '  模式：键值对（api_key / apikey / access_key / secret / token / password /',
    '  credential / authorization）、Authorization: Bearer、sk-…、三段式 JWT。',
    '  脱敏是模式匹配，覆盖不了长得不像凭据的凭据；真正的保证是含凭据的配置文件',
    '  （nanowork.config.json / channels.json / connectors/）根本不进这个包。',
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

  // 先把文件读出来并脱敏，再按**实际进包的内容**统计——脱敏后体积会变小，
  // 若按原始体积报数字，拿到包的人会对不上数。
  const fileEntries: ZipEntryInput[] = [];
  let redactedHits = 0;
  let logBytes = 0;
  let traceBytes = 0;
  for (const f of [...logsTake.taken, ...tracesTake.taken]) {
    try {
      const raw = await fs.readFile(join(options.userData, ...f.relativePath.split('/')));
      // 出口脱敏（FR-11.9）：只有进包的这份被改，磁盘上的原文不动。
      const { text, hits } = redactSecrets(raw.toString('utf-8'));
      redactedHits += hits;
      const data = Buffer.from(text, 'utf-8');
      if (f.relativePath.startsWith(`${LOG_DIR_NAME}/`)) logBytes += data.length;
      else traceBytes += data.length;
      fileEntries.push({ name: f.relativePath, data, mtimeMs: f.mtimeMs });
    } catch {
      /* 单个文件读不到就跳过：能带走多少带多少 */
    }
  }

  // —— 额外产物：启动剖析 + 延迟摘要（B4-04）——
  // 两者都不是「日志」，但都是排查「启动慢 / 首字慢」的直接证据；缺席才是常态
  // （剖析默认关、新装用户没有对话样本），所以读不到时静默跳过，不报错。
  const extraEntries: ZipEntryInput[] = [];
  let hasStartupProfile = false;
  let hasLatencySummary = false;
  try {
    const raw = capText(
      await fs.readFile(join(options.userData, STARTUP_PROFILE_FILE), 'utf-8'),
      MAX_EXTRA_READ_BYTES,
    );
    const { text, hits } = redactSecrets(raw);
    redactedHits += hits;
    if (text.trim()) {
      extraEntries.push({ name: STARTUP_PROFILE_FILE, data: text });
      hasStartupProfile = true;
    }
  } catch {
    /* 未开启剖析：没有这个文件是常态 */
  }
  try {
    const raw = capText(
      await fs.readFile(join(options.userData, SESSION_LATENCY_FILE), 'utf-8'),
      MAX_EXTRA_READ_BYTES,
    );
    const summary = summarizeLatencySamples(raw);
    if (summary) {
      extraEntries.push({
        name: 'session-latency.summary.json',
        data: `${JSON.stringify(summary, null, 2)}\n`,
      });
      hasLatencySummary = true;
    }
  } catch {
    /* 还没跑过对话：没有样本是常态 */
  }

  const counts = {
    logFiles: fileEntries.filter((e) => e.name.startsWith(`${LOG_DIR_NAME}/`)).length,
    logBytes,
    traceFiles: fileEntries.length - fileEntries.filter((e) => e.name.startsWith(`${LOG_DIR_NAME}/`)).length,
    traceBytes,
    totalAvailable: { logs: allLogs.length, traces: allTraces.length },
  };

  const meta = {
    generatedAt: new Date(now).toISOString(),
    app: options.appInfo ?? {},
    retention: { logKeepDays: DEFAULT_LOG_KEEP_DAYS, traceKeepDays: DEFAULT_TRACE_KEEP_DAYS },
    counts,
    // 脱敏是「出口」行为：如实记下这包被改过、改了多少处，别让拿到包的人
    // 以为里面的值就是日志里的原值。patterns 是**清单**，让用户不用读代码
    // 就知道脱敏覆盖了哪几类。
    redaction: {
      applied: true,
      hits: redactedHits,
      patterns: ['credential-kv', 'bearer', 'sk', 'jwt'],
    },
    // 额外产物的「有没有」只记事实，不重复正文（同一事实一个落点）。
    artifacts: {
      startupProfile: hasStartupProfile,
      latencySummary: hasLatencySummary,
    },
    // 快照本体只放 processes.json，meta 里只留一个「有没有」的指针——
    // 同一份事实放两处，早晚会不一致（一个事实一个落点）。
    ...(options.processSnapshot
      ? { processSnapshotIncluded: true, listenerSource: options.processSnapshot.listenerSource }
      : { processSnapshotIncluded: false }),
  };

  const readme = readmeText({
    ...counts,
    skipped: logsTake.skipped + tracesTake.skipped,
    now,
    hasProcesses: Boolean(options.processSnapshot),
    hasStartupProfile,
    hasLatencySummary,
    redactedHits,
  });

  const entries: ZipEntryInput[] = [
    { name: 'README.txt', data: readme },
    { name: 'meta.json', data: `${JSON.stringify(meta, null, 2)}\n` },
    ...(options.processSnapshot
      ? [{ name: 'processes.json', data: `${JSON.stringify(options.processSnapshot, null, 2)}\n` }]
      : []),
    ...extraEntries,
    ...fileEntries,
  ];

  // 计数必须来自**真的进了包**的条目：读失败的文件如果也算进去，
  // 拿到包的人会对着一份少几个文件的包以为「就这些」。
  const pushed = entries.map((e) => e.name);
  return {
    bytes: createZip(entries, now),
    entryCount: pushed.length,
    entries: pushed,
    skipped: allLogs.length + allTraces.length - fileEntries.length,
    redactionHits: redactedHits,
  };
}
