/**
 * 子进程树清理（FR-13.2）。
 *
 * **为什么需要整树杀**：引擎是经 `spawn(bin, args, { shell: true })` 拉起的
 * （Windows 上必须走 shell 才能找到 `.cmd` / venv 入口），于是 nanobot 是 `cmd`
 * 的**孙进程**——只 `proc.kill()` 杀的是 cmd，Python 引擎会活下来继续占端口。
 *
 * **为什么需要 `waitForProcessExit`**：`killProcessTree` 只是**发起** taskkill，
 * 而 taskkill 本身是异步的。原实现在 `before-quit` 里发起就返回，主进程会在进程树
 * 还没死透时退出，留下孤儿占住 18900 / 18790——下一次启动必然 `EADDRINUSE`。
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** Windows 上结束进程树的 taskkill 参数 */
export function buildTreeKillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F'];
}

export interface KillProcessTreeOptions {
  platform?: NodeJS.Platform;
  /** 便于测试注入替身；默认 `node:child_process` 的 spawn */
  spawnImpl?: typeof spawn;
}

/** 进程是否已经退出（`exitCode` 在退出后被置为非 null） */
function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * 结束单个进程：Windows 走 taskkill 整树，其它平台 SIGTERM。
 *
 * 失败静默：进程可能已经自己退了，而清理失败**不该**反向影响退出流程
 * （退出是用户意图，孤儿是卫生问题，不能为了卫生把退出卡死）。
 */
export function killProcessTree(proc: ChildProcess, options: KillProcessTreeOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  const pid = proc.pid;
  try {
    // pid 为空说明 spawn 本身就失败了，没有进程可杀；此时若仍去 spawn taskkill，
    // 会拉起一个报「找不到进程」的 cmd 黑框。
    if (platform === 'win32' && pid) {
      spawnImpl('taskkill', buildTreeKillArgs(pid), { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    /* ignore */
  }
}

/**
 * 等待进程真正退出，超时返回 false。
 *
 * 超时**不是错误**：taskkill 可能因为句柄被占用而慢半拍，退出流程不能无限等。
 * 调用方据此决定是否补一次 kill（或接受孤儿并记日志）。
 */
export function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once('exit', onExit);
  });
}

export interface CleanupChildProcessesOptions extends KillProcessTreeOptions {
  /** 单个进程等待退出的上限（毫秒） */
  exitTimeoutMs?: number;
}

export interface CleanupChildProcessesResult {
  /** 实际发起过清理的进程数 */
  killed: number;
  /** 已确认退出的进程数 */
  reaped: number;
}

/**
 * 清理一组子进程：先整树杀，再等它们真退。
 *
 * 并发而不是串行等待——多个引擎进程之间没有依赖关系，串行会把退出时间乘以进程数。
 */
export async function cleanupChildProcesses(
  procs: readonly (ChildProcess | null | undefined)[],
  options: CleanupChildProcessesOptions = {},
): Promise<CleanupChildProcessesResult> {
  const exitTimeoutMs = options.exitTimeoutMs ?? 3000;
  const targets = procs.filter((p): p is ChildProcess => Boolean(p));
  let reaped = 0;
  await Promise.all(
    targets.map(async (proc) => {
      killProcessTree(proc, options);
      const ok = await waitForProcessExit(proc, exitTimeoutMs);
      if (ok) reaped += 1;
    }),
  );
  return { killed: targets.length, reaped };
}
