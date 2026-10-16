/**
 * 网关运行态内省（FR-13.4 僵尸清理 + FR-11.9 诊断进程维度）。
 *
 * ## 背景：`run/` 里为什么会堆垃圾
 *
 * 引擎（`nanobot/gateway/runtime.py`）每次拉起 gateway 都会往
 * `<config 所在目录>/run/gateway.<hash>.json` 写一份状态：pid、端口、config 路径、
 * 启动时间。进程**正常退出**时它会自己删掉；被 kill / 崩了 / 换了项目跑，文件就留下来。
 * 实测（2026-10-16）本机 `run/` 堆了 3 份，其中一份的 `config_path` 指向
 * **另一个项目**（`D:\Workspace\Codes\sciherd-cloud-smartagent\…`）——两个项目的引擎
 * 互相把对方的状态文件当成自己的，`GatewayInstance.resolve` 的指纹空间是脏的。
 *
 * ## 为什么清理放在客户端而不是引擎
 *
 * 引擎侧本来就有完整的 lease / supervisor（`runtime.py` 的 `_live_state()` 会做 PID 裁剪），
 * 但 **Electron 从不 acquire**——`spawn('gateway --foreground')` 绕过了整套引用计数。
 * 修那条要改引擎契约（另立）；在这之前，客户端至少该把自己的目录扫干净。
 *
 * ## 三条判据（按顺序，越靠前越不信任文件内容）
 *
 * 1. **解析失败** → stale。文件写了一半（崩溃发生在写盘中途）时就是这样。
 * 2. **pid 缺失/非法** → stale。没有 pid 就无从判断死活。
 * 3. **pid 已死** → stale。这是最硬的一条，与「谁在跑」无关。
 * 4. **config 指纹不属于当前 config** → stale。活着的进程也可能是别的项目的
 *    （本机 3 份里有 1 份就是），它的状态文件对当前项目没有意义。
 * 5. 其余 → live，**不动**。
 *
 * ⚠️ **只删文件，从不杀进程**。看到一个活着的 pid 就 taskkill 是错的：那可能是用户
 * 自己手动拉起的网关，杀了等于替用户做决定。进程该不该死由引擎的 lease 管。
 *
 * ## 端口占用者怎么来
 *
 * `netstat -ano` 解析（Windows）。没有引原生依赖——诊断包里只需要「端口被谁占」，
 * 一次 `netstat` 足够。非 Windows 平台返回空并在快照里标注，不猜。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** 状态文件名：`gateway.json`（默认实例）或 `gateway.<hash>.json`（显式 config/workspace） */
const GATEWAY_STATE_RE = /^gateway(\.[0-9a-f]{6,64})?\.json$/;

/** 从状态文件里取出的字段（缺字段一律 null，不猜） */
export interface GatewayStateInfo {
  pid: number | null;
  configPath: string | null;
  port: number | null;
  startedAt: string | null;
}

export type GatewayStateVerdict =
  | 'live'
  | 'stale-unparseable'
  | 'stale-no-pid'
  | 'stale-dead-pid'
  | 'stale-foreign-config';

export interface GatewayStateFile {
  /** 文件名（不含目录） */
  file: string;
  path: string;
  info: GatewayStateInfo | null;
  verdict: GatewayStateVerdict;
}

/**
 * 路径归一化，仅用于**比较**（不用于 IO）。
 *
 * Windows 上 `D:\A\b.json` 与 `d:/A/b.json` 是同一个文件，但字符串不相等；
 * 状态文件里的 `config_path` 是引擎写的，本项目解析出来的可能是另一种写法。
 * 不做这层归一化，「指纹匹配」会稳定误判成 foreign-config，把活着的状态文件删掉。
 */
export function normalizePathForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 解析状态文件内容；解析失败返回 null（调用方按 stale-unparseable 处理） */
export function parseGatewayState(content: string): GatewayStateInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  return {
    pid: num(obj.pid),
    configPath: str(obj.config_path),
    port: num(obj.port),
    startedAt: str(obj.started_at),
  };
}

/**
 * 判定单个状态文件的命运。
 *
 * @param info `parseGatewayState` 的结果（null = 解析失败）
 * @param opts.pidAlive pid 存活判定（注入以便测试；默认走 `process.kill(pid, 0)`）
 * @param opts.currentConfigPath 当前项目的 config 路径；null 表示不知道（跳过指纹判据）
 */
export function classifyGatewayState(
  info: GatewayStateInfo | null,
  opts: { pidAlive?: (pid: number) => boolean; currentConfigPath?: string | null },
): GatewayStateVerdict {
  if (!info) return 'stale-unparseable';
  if (info.pid === null || !Number.isInteger(info.pid) || info.pid <= 0) return 'stale-no-pid';
  const pidAlive = opts.pidAlive ?? isPidAlive;
  if (!pidAlive(info.pid)) return 'stale-dead-pid';
  // 指纹判据：只有两边都有路径时才比。缺一边就跳过——「不知道」不等于「不匹配」。
  if (opts.currentConfigPath && info.configPath) {
    if (normalizePathForCompare(info.configPath) !== normalizePathForCompare(opts.currentConfigPath)) {
      return 'stale-foreign-config';
    }
  }
  return 'live';
}

/**
 * pid 是否存活。
 *
 * `EPERM` 判活是**刻意的保守**：Windows 上跨会话/跨用户的进程会返回 EPERM 而非成功，
 * 把它判死的代价是「删掉一个别人正在用的状态文件」，判活只是多留一个文件。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 是否是本模块负责清理的状态文件名（排除 `.clients.json` 与各种 `.lock`） */
export function isGatewayStateFileName(name: string): boolean {
  return GATEWAY_STATE_RE.test(name);
}

export interface SweepStaleGatewayStatesOptions {
  runDir: string;
  currentConfigPath: string | null;
  pidAlive?: (pid: number) => boolean;
  /** 注入以便测试；默认 `fs.unlink` */
  removeFile?: (path: string) => Promise<void>;
}

export interface SweepResult {
  /** 已删除的文件名 */
  removed: string[];
  /** 判定为 live 而保留的文件名 */
  kept: string[];
  /** 想删但删失败的文件名（磁盘占用/权限）——**不阻塞启动** */
  failed: string[];
  /** 全部文件的判定明细（诊断包直接用它） */
  files: GatewayStateFile[];
}

/**
 * 只读扫描 `run/` 里的网关状态文件并判定死活（**不删任何东西**）。
 *
 * 诊断包用它：`buildDiagnosticsBundle` 的契约是「只读，不删除任何东西」，
 * 拿导出动作去清磁盘是不可接受的副作用。
 */
export async function scanGatewayStates(
  runDir: string,
  opts: { currentConfigPath: string | null; pidAlive?: (pid: number) => boolean },
): Promise<GatewayStateFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(runDir);
  } catch {
    return [];
  }
  const out: GatewayStateFile[] = [];
  for (const name of names) {
    if (!isGatewayStateFileName(name)) continue;
    const path = join(runDir, name);
    let content: string | null = null;
    try {
      content = await fs.readFile(path, 'utf-8');
    } catch {
      content = null;
    }
    const info = content === null ? null : parseGatewayState(content);
    out.push({
      file: name,
      path,
      info,
      verdict: classifyGatewayState(info, {
        pidAlive: opts.pidAlive,
        currentConfigPath: opts.currentConfigPath,
      }),
    });
  }
  return out;
}

/**
 * 扫并清 `run/` 里的僵尸网关状态文件。
 *
 * **fail-open**：目录不存在、读失败、删失败一律不抛——这是卫生问题不是安全问题，
 * 没有理由让它把启动链路挡住。失败只体现在返回值里，由调用方记日志。
 */
export async function sweepStaleGatewayStates(
  opts: SweepStaleGatewayStatesOptions,
): Promise<SweepResult> {
  const removeFile = opts.removeFile ?? ((p: string) => fs.unlink(p));
  const files = await scanGatewayStates(opts.runDir, {
    currentConfigPath: opts.currentConfigPath,
    pidAlive: opts.pidAlive,
  });

  const result: SweepResult = { removed: [], kept: [], failed: [], files };
  for (const f of files) {
    if (f.verdict === 'live') {
      result.kept.push(f.file);
      continue;
    }
    try {
      await removeFile(f.path);
      result.removed.push(f.file);
    } catch {
      result.failed.push(f.file);
    }
  }
  return result;
}

/** `netstat -ano` 里一条 LISTENING 记录 */
export interface PortListener {
  port: number;
  pid: number;
}

/**
 * 解析 Windows `netstat -ano` 输出里的 LISTENING 行。
 *
 * 形如：
 * ```
 *   TCP    127.0.0.1:18900         0.0.0.0:0              LISTENING       86424
 *   TCP    [::]:9900               [::]:0                 LISTENING       1234
 * ```
 * 只取 LISTENING——TIME_WAIT 之类的没有监听意义，混进来会让「端口被占」的判据失真。
 */
export function parseNetstatListening(output: string): PortListener[] {
  const out: PortListener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:TCP|TCP6)\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (Number.isFinite(port) && Number.isFinite(pid)) out.push({ port, pid });
  }
  return out;
}

/** 诊断包用的进程/端口快照 */
export interface ProcessSnapshot {
  /** 本进程 */
  self: { pid: number; uptimeSec: number };
  /** 关注的端口是否有监听者（含占用者 pid） */
  listeners: Array<{ port: number; pid: number | null; listening: boolean }>;
  /** `run/` 状态文件的判定明细 */
  gatewayStates: Array<{ file: string; pid: number | null; verdict: GatewayStateVerdict }>;
  /** 端口归属是怎么取到的（非 Windows 取不到，必须让人知道） */
  listenerSource: 'netstat' | 'unavailable';
}

/**
 * 取端口监听者。非 Windows 返回空 + `listenerSource: 'unavailable'`——
 * **不猜**：诊断包里写「未知」比写一个错的 pid 有用得多。
 */
export async function collectPortListeners(
  ports: readonly number[],
  execFile?: (cmd: string, args: string[]) => Promise<string>,
): Promise<{ listeners: PortListener[]; source: 'netstat' | 'unavailable' }> {
  if (process.platform !== 'win32') return { listeners: [], source: 'unavailable' };
  const run =
    execFile ??
    (async (cmd: string, args: string[]) => {
      const { execFile: nodeExecFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(nodeExecFile)(cmd, args, { windowsHide: true });
      return String(stdout);
    });
  try {
    const out = await run('netstat', ['-ano']);
    const all = parseNetstatListening(out);
    return { listeners: all.filter((l) => ports.includes(l.port)), source: 'netstat' };
  } catch {
    return { listeners: [], source: 'unavailable' };
  }
}

/** 由监听者列表 + 关注的端口列表拼出快照的端口段 */
export function buildListenerRows(
  ports: readonly number[],
  listeners: readonly PortListener[],
): ProcessSnapshot['listeners'] {
  return ports.map((port) => {
    const hit = listeners.find((l) => l.port === port);
    return { port, pid: hit ? hit.pid : null, listening: Boolean(hit) };
  });
}
