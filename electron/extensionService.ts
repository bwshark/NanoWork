/**
 * 扩展后台服务的生命周期（`extension.json` 的 `service` 字段）。
 *
 * 对齐 WorkBuddy 的 `service: { entry, process: 'fork' }`，但有三处**刻意的收紧**：
 *
 * 1. **不自动启动**。原版随宿主启动；本项目要求用户在扩展页显式点「启动」。
 *    第三方 node 代码常驻不是默认该发生的事。
 * 2. **环境变量白名单**。`fork` 默认继承父进程环境，那等于把 `*_API_KEY`、
 *    网关 token 一并交给扩展。这里只传运行必需的基础变量 + 扩展自己的标识。
 * 3. **崩溃退避有上限**。无限重启会把 CPU 打满还刷爆日志；三次之后停在
 *    `crashed`，等用户手动重启。
 *
 * 本模块把「能不能 fork」与「怎么 fork」分开：`validateServiceEntry`、
 * `nextRestartDelay`、`appendLogLine`、`buildServiceEnv` 都是纯函数（可单测），
 * `ExtensionServiceManager` 只负责把它们串起来。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolveInside } from './extensionPackage';
import type {
  ExtensionActionResult,
  ExtensionServiceSpec,
  ExtensionServiceStatus,
} from '../src/types/extension';

/** 每个服务保留的日志行数（够排障，又不会把内存吃掉） */
export const SERVICE_LOG_LINES = 60;

/** 单行日志最大字符数：一行几 MB 的堆栈会把这个环形缓冲变成内存黑洞 */
export const SERVICE_LOG_LINE_MAX = 2000;

/** 崩溃后最多自动重启几次 */
export const SERVICE_MAX_RESTARTS = 3;

/** 第 n 次重启前的等待（毫秒）；超出表长按最后一档 */
const RESTART_DELAYS = [1000, 3000, 8000];

/** 第 `restarts` 次重启前的等待毫秒数（`restarts` 从 0 开始） */
export function nextRestartDelay(restarts: number): number {
  if (restarts <= 0) return RESTART_DELAYS[0];
  return RESTART_DELAYS[Math.min(restarts, RESTART_DELAYS.length - 1)];
}

/** 往环形缓冲追加一行（超长截断；返回新数组，便于单测断言） */
export function appendLogLine(buffer: readonly string[], line: string): string[] {
  const trimmed = line.replace(/\r?\n$/, '');
  const safe =
    trimmed.length > SERVICE_LOG_LINE_MAX
      ? `${trimmed.slice(0, SERVICE_LOG_LINE_MAX)}…（已截断）`
      : trimmed;
  const next = [...buffer, safe];
  return next.length > SERVICE_LOG_LINES ? next.slice(next.length - SERVICE_LOG_LINES) : next;
}

/**
 * 传给扩展服务的环境变量。
 *
 * 白名单而不是黑名单：黑名单永远漏（新加一个 `*_TOKEN` 就漏一个），
 * 而扩展服务真正需要的只有「能找到 node 与临时目录」这几项。
 */
export function buildServiceEnv(
  extensionId: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'ComSpec',
    'LANG',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }
  env.NANOWORK_EXTENSION_ID = extensionId;
  // 明确告诉扩展"我没有你的凭据"：比让它读到空串再猜要好
  env.NANOWORK_EXTENSION_ENV = 'restricted';
  return env;
}

/** 校验服务入口：必须在包内、必须是文件、必须是 js */
export async function validateServiceEntry(
  root: string,
  spec: ExtensionServiceSpec,
): Promise<{ ok: true; entryPath: string } | { ok: false; error: string }> {
  if (spec.process !== 'fork') {
    return { ok: false, error: `不支持的服务进程模型：${String(spec.process)}` };
  }
  const entryPath = resolveInside(root, spec.entry);
  if (!entryPath) {
    return { ok: false, error: `service.entry 越出扩展目录：${spec.entry}` };
  }
  try {
    const stat = await fs.stat(entryPath);
    if (!stat.isFile()) return { ok: false, error: `service.entry 不是文件：${spec.entry}` };
  } catch {
    return { ok: false, error: `service.entry 不存在：${spec.entry}` };
  }
  return { ok: true, entryPath };
}

/** 一个服务的运行时状态（含子进程句柄，不外泄） */
interface ServiceRuntime {
  id: string;
  state: ExtensionServiceStatus['state'];
  child: ChildProcess | null;
  log: string[];
  error?: string;
  restarts: number;
  /** 用户主动停止：崩溃回调里据此决定是否重启 */
  stopRequested: boolean;
  restartTimer: NodeJS.Timeout | null;
  /** 最近一次 fork 的参数，供崩溃重启复用 */
  spec?: ExtensionServiceSpec;
  root?: string;
}

const runtimes = new Map<string, ServiceRuntime>();

function runtimeOf(id: string): ServiceRuntime {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const created: ServiceRuntime = {
    id,
    state: 'stopped',
    child: null,
    log: [],
    restarts: 0,
    stopRequested: false,
    restartTimer: null,
  };
  runtimes.set(id, created);
  return created;
}

function snapshot(rt: ServiceRuntime): ExtensionServiceStatus {
  return {
    id: rt.id,
    state: rt.state,
    ...(rt.child?.pid !== undefined ? { pid: rt.child.pid } : {}),
    log: [...rt.log],
    ...(rt.error ? { error: rt.error } : {}),
    restarts: rt.restarts,
  };
}

/** 挂上 stdout/stderr 的收集（逐行；不完整的行先在本地攒着） */
function pipeLogs(rt: ServiceRuntime, child: ChildProcess): void {
  const attach = (stream: NodeJS.ReadableStream | null): void => {
    if (!stream) return;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) rt.log = appendLogLine(rt.log, line);
      }
      // 没有换行的长输出也要能看见（否则进度条式输出会一直不显示）
      if (pending.length > SERVICE_LOG_LINE_MAX) {
        rt.log = appendLogLine(rt.log, pending);
        pending = '';
      }
    });
    stream.on('end', () => {
      if (pending.trim()) rt.log = appendLogLine(rt.log, pending);
      pending = '';
    });
  };
  attach(child.stdout);
  attach(child.stderr);
}

/** 真正 fork 一次（含崩溃回调与重启编排） */
function spawnService(rt: ServiceRuntime, root: string, spec: ExtensionServiceSpec, entryPath: string): void {
  rt.spec = spec;
  rt.root = root;
  const child = fork(entryPath, spec.args ?? [], {
    cwd: root,
    env: buildServiceEnv(rt.id),
    // 不继承宿主的 execArgv：`--inspect` 之类会把端口抢走
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  rt.child = child;
  rt.state = 'running';
  pipeLogs(rt, child);
  rt.log = appendLogLine(rt.log, `[宿主] 已启动，pid=${child.pid ?? '?'}`);

  child.on('error', (err) => {
    rt.error = err.message;
    rt.log = appendLogLine(rt.log, `[宿主] 进程错误：${err.message}`);
  });

  child.on('exit', (code, signal) => {
    rt.child = null;
    const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? '?'}`;
    rt.log = appendLogLine(rt.log, `[宿主] 进程结束（${reason}）`);
    if (rt.stopRequested) {
      rt.state = 'stopped';
      return;
    }
    if (rt.restarts >= SERVICE_MAX_RESTARTS) {
      rt.state = 'crashed';
      rt.error = `连续崩溃 ${rt.restarts} 次，已停止自动重启（${reason}）`;
      return;
    }
    rt.restarts += 1;
    rt.state = 'crashed';
    rt.error = `已崩溃（${reason}），${nextRestartDelay(rt.restarts - 1)}ms 后第 ${rt.restarts} 次重启`;
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      if (rt.stopRequested || !rt.spec || !rt.root) return;
      void startExtensionService(rt.id, rt.root, rt.spec);
    }, nextRestartDelay(rt.restarts - 1));
  });
}

/**
 * 启动一个扩展服务。
 *
 * `root` 由调用方从扫描结果里取，**不按 id 拼路径**（避免 id 与目录名不一致时
 * 启动到别的地方）。
 */
export async function startExtensionService(
  id: string,
  root: string,
  spec: ExtensionServiceSpec,
): Promise<ExtensionActionResult> {
  const rt = runtimeOf(id);
  if (rt.state === 'running' || rt.state === 'starting') {
    return { ok: true, status: snapshot(rt) };
  }

  const validated = await validateServiceEntry(root, spec);
  if (!validated.ok) {
    rt.state = 'crashed';
    rt.error = validated.error;
    rt.log = appendLogLine(rt.log, `[宿主] 启动失败：${validated.error}`);
    return { ok: false, error: validated.error, status: snapshot(rt) };
  }

  rt.stopRequested = false;
  rt.state = 'starting';
  rt.error = undefined;
  rt.log = appendLogLine(rt.log, '[宿主] 正在启动…');
  try {
    spawnService(rt, root, spec, validated.entryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rt.state = 'crashed';
    rt.error = `fork 失败：${message}`;
    rt.log = appendLogLine(rt.log, `[宿主] fork 失败：${message}`);
    return { ok: false, error: rt.error, status: snapshot(rt) };
  }
  return { ok: true, status: snapshot(rt) };
}

/** 停止一个扩展服务（SIGTERM，3s 未退再 SIGKILL） */
export async function stopExtensionService(id: string): Promise<ExtensionActionResult> {
  const rt = runtimes.get(id);
  if (!rt) return { ok: true };
  rt.stopRequested = true;
  if (rt.restartTimer) {
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
  }
  const child = rt.child;
  if (!child) {
    rt.state = 'stopped';
    return { ok: true, status: snapshot(rt) };
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });

  rt.state = 'stopped';
  rt.log = appendLogLine(rt.log, '[宿主] 已停止');
  return { ok: true, status: snapshot(rt) };
}

/** 某个扩展的服务状态（未启动过时给 stopped 快照，不返回 undefined） */
export function extensionServiceStatus(id: string): ExtensionServiceStatus {
  const rt = runtimes.get(id);
  if (!rt) return { id, state: 'stopped', log: [], restarts: 0 };
  return snapshot(rt);
}

/** 全部服务状态（页面批量刷新用） */
export function allExtensionServiceStatus(): ExtensionServiceStatus[] {
  return [...runtimes.values()].map(snapshot);
}

/**
 * 关闭全部服务（宿主退出前调用）。
 *
 * 不等待优雅退出：`app.on('before-quit')` 里等太久会让进程"关不掉"，
 * 而扩展服务的 stdin 已断、进程会自己退。
 */
export function stopAllExtensionServices(): void {
  for (const rt of runtimes.values()) {
    rt.stopRequested = true;
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer);
      rt.restartTimer = null;
    }
    try {
      rt.child?.kill('SIGTERM');
    } catch {
      /* 已经退了 */
    }
    rt.child = null;
    rt.state = 'stopped';
  }
}
