import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOG_MAX_DATE_DIRS,
  appendLogLine,
  createFileLogger,
  listLogFiles,
  logFileFor,
  logStats,
  logsRoot,
  pruneLogs,
} from '../../electron/logStore';
import {
  DEFAULT_TRACE_MAX_PID_DIRS,
  listTraceFiles,
  pruneTraces,
  traceStats,
  writeTrace,
} from '../../electron/traceStore';
import { buildDiagnosticsBundle } from '../../electron/diagnostics';
import { buildTurnTrace } from '@/observability/trace';
import { logDateSegment } from '@/observability/logging';
import type { LogModule } from '@/observability/logging';
import { readZipText } from '../helpers/zip';

const DAY = 86_400_000;

/**
 * 整个文件**共用一个临时根**，各用例拿子目录当自己的 `userData`。
 *
 * 理由是这台机器上的批量删除守卫：每个用例各建各的临时目录，就会在收尾时各删一次，
 * 而 `fs.rm(recursive)` 在本机偶发几十秒的钩子超时（`tests/electron/*` 的既有 flake）。
 * 收尾只删一次，且**不 await**（`void ...catch()`）——清理失败不该把用例判红。
 */
let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nanowork-diag-'));
});
afterAll(() => {
  if (root) void fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

let caseSeq = 0;
function caseRoot(): string {
  caseSeq += 1;
  return join(root, `case-${caseSeq}`);
}

async function waitForFile(file: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.stat(file);
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe('logStore：落盘形态', () => {
  it('按本地日分目录、按模块分文件，一行一条（只追加）', async () => {
    const userData = caseRoot();
    const at = Date.now();
    expect(await appendLogLine(userData, { at, module: 'chat', level: 'info', message: '第一行' })).toBe(
      true,
    );
    expect(
      await appendLogLine(userData, { at, module: 'chat', level: 'warn', message: '第二行', detail: { a: 1 } }),
    ).toBe(true);

    const file = logFileFor(userData, at, 'chat');
    expect(file).toBe(join(logsRoot(userData), logDateSegment(at), 'chat.log'));
    const lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[chat] INFO 第一行');
    expect(lines[1]).toContain('[chat] WARN 第二行 {"a":1}');
  });

  it('模块名不在白名单里 → 丢弃并返回 false，且不在磁盘上留东西', async () => {
    const userData = caseRoot();
    expect(
      await appendLogLine(userData, {
        at: Date.now(),
        module: 'not-a-module' as LogModule,
        level: 'info',
        message: 'x',
      }),
    ).toBe(false);
    expect(await listLogFiles(userData)).toEqual([]);
  });

  it('listLogFiles 只认日期目录（用户自己放的目录不参与统计与清理）', async () => {
    const userData = caseRoot();
    await appendLogLine(userData, { at: Date.now(), module: 'sync', level: 'info', message: 'a' });
    const stray = join(logsRoot(userData), 'my-notes');
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(join(stray, 'x.log'), 'user data', 'utf-8');

    const files = await listLogFiles(userData);
    expect(files.map((f) => f.relativePath)).toEqual([
      `logs/${logDateSegment(Date.now())}/sync.log`,
    ]);
    expect(files[0]!.bytes).toBeGreaterThan(0);

    const stats = await logStats(userData);
    expect(stats.dir).toBe(logsRoot(userData));
    expect(stats.files).toBe(1);
    expect(stats.dates).toEqual([logDateSegment(Date.now())]);
  });
});

describe('logStore：保留策略', () => {
  it('按天数清理旧日期目录，保留期内的不动', async () => {
    const userData = caseRoot();
    const now = Date.now();
    const old = now - 40 * DAY;
    await appendLogLine(userData, { at: old, module: 'chat', level: 'info', message: '很久以前' });
    await appendLogLine(userData, { at: now, module: 'chat', level: 'info', message: '刚刚' });

    const removed = await pruneLogs(userData, { now, keepDays: 14 });
    expect(removed).toEqual([logDateSegment(old)]);
    expect(await listLogFiles(userData)).toHaveLength(1);
  });

  it('keepDays <= 0 表示不清理（配置写坏时宁可占盘）', async () => {
    const userData = caseRoot();
    const now = Date.now();
    await appendLogLine(userData, { at: now - 400 * DAY, module: 'chat', level: 'info', message: 'x' });
    expect(await pruneLogs(userData, { now, keepDays: 0 })).toEqual([]);
    expect(await listLogFiles(userData)).toHaveLength(1);
  });

  it('含子目录的日期目录放弃删除（不猜用户往里放了什么）', async () => {
    const userData = caseRoot();
    const date = '2020-01-01';
    const dir = join(logsRoot(userData), date);
    await fs.mkdir(join(dir, 'sub'), { recursive: true });
    await fs.writeFile(join(dir, 'sub', 'keep.txt'), 'x', 'utf-8');
    // keepDays=1 且 now 远在未来，按时间它该被清掉，但里面有子目录 → 放弃
    expect(await pruneLogs(userData, { now: Date.now() + 400 * DAY, keepDays: 1 })).toEqual([]);
    expect(await fs.stat(join(dir, 'sub', 'keep.txt'))).toBeTruthy();
  });

  it('日期目录数超上限时从最旧的开始裁（同日狂写的兜底闸）', async () => {
    const userData = caseRoot();
    const base = Date.now() - 500 * DAY;
    const dates = ['2024-01-01', '2024-01-02', '2024-01-03'];
    for (const d of dates) {
      await fs.mkdir(join(logsRoot(userData), d), { recursive: true });
      await fs.writeFile(join(logsRoot(userData), d, 'chat.log'), 'x', 'utf-8');
      // mtime 决定「谁更旧」，逐个抬高
      const ms = base + dates.indexOf(d) * DAY;
      await fs.utimes(join(logsRoot(userData), d, 'chat.log'), ms / 1000, ms / 1000);
    }
    expect(DEFAULT_LOG_MAX_DATE_DIRS).toBeGreaterThan(3);
    const removed = await pruneLogs(userData, { now: Date.now(), keepDays: 0, maxDateDirs: 1 });
    expect(removed.sort()).toEqual(['2024-01-01', '2024-01-02']);
  });
});

describe('logStore：主进程门面', () => {
  it('按最低等级 gate，且写盘是 fire-and-forget（返回时文件可能还没落）', async () => {
    const userData = caseRoot();
    const log = createFileLogger(userData, 'warn');
    log('chat', 'info', '被等级挡掉');
    log('chat', 'error', '要落盘');

    const warnFile = join(logsRoot(userData), logDateSegment(Date.now()), 'chat.log');
    expect(await waitForFile(warnFile)).toBe(true);
    const text = await fs.readFile(warnFile, 'utf-8');
    expect(text).toContain('要落盘');
    expect(text).not.toContain('被等级挡掉');
  });
});

describe('traceStore', () => {
  function sampleTrace(traceId = `trace_${'a'.repeat(32)}`) {
    return buildTurnTrace([], { sessionId: 's1', traceId });
  }

  it('写盘时补上「写它的进程」，文件可原样读回', async () => {
    const userData = caseRoot();
    const res = await writeTrace(userData, sampleTrace(), { pid: 4321, hostname: 'test-host' });
    expect(res?.path).toBe(join(userData, 'traces', '4321', `trace_${'a'.repeat(32)}.json`));

    const text = await fs.readFile(res!.path, 'utf-8');
    const parsed = JSON.parse(text);
    expect(parsed.trace.workerPid).toBe(4321);
    expect(parsed.trace.workerHostname).toBe('test-host');
    expect(parsed.trace.sessionId).toBe('s1');
    expect(parsed.spans).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('traceId 形态不对 → 不写盘（它是文件名的一部分）', async () => {
    const userData = caseRoot();
    for (const bad of ['../evil', 'trace_', 'x'.repeat(80), '']) {
      const file = sampleTrace();
      file.trace.traceId = bad;
      expect(await writeTrace(userData, file, { pid: 1, hostname: 'h' })).toBeNull();
    }
    expect(await listTraceFiles(userData)).toEqual([]);
  });

  it('pid 非法 → 不写盘', async () => {
    const userData = caseRoot();
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 40])
      expect(await writeTrace(userData, sampleTrace(), { pid: bad, hostname: 'h' })).toBeNull();
    expect(await listTraceFiles(userData)).toEqual([]);
  });

  it('listTraceFiles 只认 pid 目录，统计与 listTraceDirs 同源', async () => {
    const userData = caseRoot();
    await writeTrace(userData, sampleTrace(), { pid: 77, hostname: 'h' });
    await fs.mkdir(join(userData, 'traces', 'manual'), { recursive: true });
    await fs.writeFile(join(userData, 'traces', 'manual', 'x.json'), '{"a":1}', 'utf-8');

    const files = await listTraceFiles(userData);
    expect(files.map((f) => f.relativePath)).toEqual([
      `traces/77/trace_${'a'.repeat(32)}.json`,
    ]);
    const stats = await traceStats(userData);
    expect(stats.files).toBe(1);
    expect(stats.bytes).toBe(files[0]!.bytes);
  });

  it('按数量裁剪 pid 目录（一天开 50 次应用 = 50 个目录，时间闸清不掉）', async () => {
    const userData = caseRoot();
    await writeTrace(userData, sampleTrace(`trace_${'1'.repeat(32)}`), { pid: 11, hostname: 'h' });
    await writeTrace(userData, sampleTrace(`trace_${'2'.repeat(32)}`), { pid: 22, hostname: 'h' });

    expect(DEFAULT_TRACE_MAX_PID_DIRS).toBeGreaterThan(0);
    const removed = await pruneTraces(userData, { now: Date.now(), keepDays: 0, maxPidDirs: 1 });
    expect(removed).toEqual(['11']);
    expect((await listTraceFiles(userData)).map((f) => f.relativePath)).toEqual([
      `traces/22/trace_${'2'.repeat(32)}.json`,
    ]);
  });

  it('按天数清理旧 pid 目录', async () => {
    const userData = caseRoot();
    const res = await writeTrace(userData, sampleTrace(), { pid: 33, hostname: 'h' });
    const old = (Date.now() - 30 * DAY) / 1000;
    await fs.utimes(res!.path, old, old);

    const removed = await pruneTraces(userData, {
      now: Date.now(),
      keepDays: 7,
      maxPidDirs: DEFAULT_TRACE_MAX_PID_DIRS,
    });
    expect(removed).toEqual(['33']);
  });
});

describe('diagnostics：诊断包', () => {
  async function seededRoot(): Promise<string> {
    const userData = caseRoot();
    const at = Date.now();
    await appendLogLine(userData, { at, module: 'chat', level: 'info', message: '对话日志' });
    await appendLogLine(userData, { at, module: 'sync', level: 'warn', message: '同步日志' });
    await writeTrace(userData, buildTurnTrace([], { sessionId: 's1' }), {
      pid: 99,
      hostname: 'h',
    });
    return userData;
  }

  it('带上日志与 trace，meta 记数与实际一致', async () => {
    const userData = await seededRoot();
    const now = Date.now();
    const bundle = await buildDiagnosticsBundle({
      userData,
      now,
      appInfo: { version: '9.9.9', platform: 'win32' },
    });

    const text = readZipText(bundle.bytes);
    const names = Object.keys(text).sort();
    expect(names).toContain('README.txt');
    expect(names).toContain('meta.json');
    expect(names.filter((n) => n.startsWith('logs/'))).toHaveLength(2);
    expect(names.filter((n) => n.startsWith('traces/'))).toHaveLength(1);

    const meta = JSON.parse(text['meta.json']!);
    expect(meta.app.version).toBe('9.9.9');
    expect(meta.generatedAt).toBe(new Date(now).toISOString());
    expect(meta.counts.logFiles).toBe(2);
    expect(meta.counts.traceFiles).toBe(1);
    expect(meta.counts.totalAvailable).toEqual({ logs: 2, traces: 1 });
    expect(bundle.skipped).toBe(0);
    expect(bundle.entryCount).toBe(names.length);

    const logEntry = names.find((n) => n.endsWith('chat.log'))!;
    expect(text[logEntry]).toContain('对话日志');
  });

  it('体积上限：先保最新的，并把「跳过了几个」如实写进包', async () => {
    const userData = await seededRoot();
    // 追加几个大文件，逼出预算截断
    const at = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await appendLogLine(userData, {
        at,
        module: 'engine',
        level: 'info',
        message: `大块 ${i} ${'x'.repeat(6000)}`,
      });
    }

    const bundle = await buildDiagnosticsBundle({ userData, now: at, maxBytes: 2048 });
    const text = readZipText(bundle.bytes);
    expect(bundle.skipped).toBeGreaterThan(0);
    expect(text['README.txt']).toContain('跳过');
    // 最旧的 chat.log 是「今天但 mtime 最早」的那个，被截掉时 meta 的记数要跟着少
    const meta = JSON.parse(text['meta.json']!);
    expect(meta.counts.logFiles).toBeLessThan(meta.counts.totalAvailable.logs);
    expect(bundle.entryCount).toBeLessThanOrEqual(2 + 2);
  });

  it('不含任何凭据 / 配置文件（诊断包会被用户发出去）', async () => {
    const userData = await seededRoot();
    // 就算这些文件真躺着，也不该被装进包
    for (const name of ['nanowork.config.json', 'channels.json', 'connectors/.credentials.v3.json']) {
      const p = join(userData, name);
      await fs.mkdir(join(p, '..'), { recursive: true });
      await fs.writeFile(p, '{"apiKey":"sk-secret"}', 'utf-8');
    }
    const bundle = await buildDiagnosticsBundle({ userData, now: Date.now() });
    const names = Object.keys(readZipText(bundle.bytes));
    for (const n of names) {
      expect(n).not.toMatch(/config|channel|credential|\.db/i);
    }
    expect(JSON.stringify(names)).not.toContain('sk-secret');
  });

  it('出口脱敏：日志里夹带的凭据被打码，磁盘原文不动', async () => {
    const userData = caseRoot();
    const at = Date.now();
    const secretLine = '调用失败 api_key=sk-abcdef1234567890XYZ  upstream 401';
    await appendLogLine(userData, { at, module: 'chat', level: 'error', message: secretLine });
    // 磁盘上的原文必须留着：排查「为什么这把密钥 401」时，脱敏过的日志是废纸
    const onDisk = await fs.readFile(logFileFor(userData, at, 'chat'), 'utf-8');
    expect(onDisk).toContain('sk-abcdef1234567890XYZ');

    const bundle = await buildDiagnosticsBundle({ userData, now: Date.now() });
    const text = readZipText(bundle.bytes);
    const logEntry = Object.keys(text).find((n) => n.endsWith('chat.log'))!;
    expect(text[logEntry]).not.toContain('sk-abcdef1234567890XYZ');
    expect(text[logEntry]).toContain('sk-a...0XYZ');

    const meta = JSON.parse(text['meta.json']!);
    // B4-04：除命中数外还带 `patterns` 清单——界面要能告诉用户脱敏覆盖了哪几类。
    expect(meta.redaction).toEqual({
      applied: true,
      hits: 1,
      patterns: ['credential-kv', 'bearer', 'sk', 'jwt'],
    });
    expect(text['README.txt']).toContain('命中 1 处');
  });

  it('token 统计字段不被误脱敏（脱敏不得毁掉诊断能力）', async () => {
    const userData = caseRoot();
    await appendLogLine(userData, {
      at: Date.now(),
      module: 'chat',
      level: 'info',
      message: 'input_tokens=1234 total_tokens: 5678',
    });
    const bundle = await buildDiagnosticsBundle({ userData, now: Date.now() });
    const text = readZipText(bundle.bytes);
    const logEntry = Object.keys(text).find((n) => n.endsWith('chat.log'))!;
    expect(text[logEntry]).toContain('input_tokens=1234');
    expect(text[logEntry]).toContain('total_tokens: 5678');
    expect(JSON.parse(text['meta.json']!).redaction.hits).toBe(0);
  });

  it('进程/端口快照：给了就进包，且只读不删', async () => {
    const userData = await seededRoot();
    const snapshot = {
      self: { pid: 4242, uptimeSec: 12 },
      listeners: [
        { port: 18900, pid: 86424, listening: true },
        { port: 18790, pid: null, listening: false },
        { port: 9900, pid: null, listening: false },
      ],
      gatewayStates: [{ file: 'gateway.abc.json', pid: 999999, verdict: 'stale-dead-pid' as const }],
      listenerSource: 'netstat' as const,
    };
    const bundle = await buildDiagnosticsBundle({
      userData,
      now: Date.now(),
      processSnapshot: snapshot,
    });
    const text = readZipText(bundle.bytes);
    expect(JSON.parse(text['processes.json']!)).toEqual(snapshot);
    expect(text['README.txt']).toContain('processes.json');
    expect(text['README.txt']).toContain('gatewayStates');
    // 快照本体只落 processes.json，meta 里只留指针（一个事实一个落点）
    const meta = JSON.parse(text['meta.json']!);
    expect(meta.processSnapshot).toBeUndefined();
    expect(meta.processSnapshotIncluded).toBe(true);
    expect(meta.listenerSource).toBe('netstat');
  });

  it('不给快照就不生成 processes.json（向后兼容）', async () => {
    const userData = await seededRoot();
    const bundle = await buildDiagnosticsBundle({ userData, now: Date.now() });
    const names = Object.keys(readZipText(bundle.bytes));
    expect(names).not.toContain('processes.json');
    expect(names).not.toContain('meta.json/processSnapshot');
  });
});
