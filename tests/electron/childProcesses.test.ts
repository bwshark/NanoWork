/**
 * 子进程树清理（FR-13.2）。
 *
 * 用例纪律：不 mock `node:child_process` 的 spawn——被测的行为是「taskkill 参数对不对」
 * 与「等没等进程退出」，注入一个记录调用的替身 spawn 就足以断言，且比 mock 模块更稳。
 *
 * 变异验证目标：
 * - 去掉 `waitForProcessExit` 的 `clearTimeout` → 超时用例会挂住（vitest 报未退出句柄）；
 * - 把 `waitForProcessExit` 改成「立即 resolve(true)」→ 超时用例必须变红；
 * - 去掉 `platform === 'win32' && pid` 里的 `pid` 判据 → 「无 pid 不 spawn」用例变红。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  buildTreeKillArgs,
  cleanupChildProcesses,
  killProcessTree,
  waitForProcessExit,
} from '../../electron/childProcesses';

/** 记录调用的 spawn 替身 */
type FakeSpawn = ReturnType<typeof vi.fn> & typeof spawn;
function fakeSpawn(): FakeSpawn {
  return vi.fn(() => new EventEmitter()) as unknown as FakeSpawn;
}

/** 造一个最小 ChildProcess 替身：真进程的 pid / exitCode / signalCode / kill */
function fakeProc(options: { pid?: number; exited?: boolean } = {}) {
  const emitter = new EventEmitter();
  const kill = vi.fn();
  const proc = emitter as unknown as ChildProcess;
  Object.defineProperties(proc, {
    pid: { value: options.pid, configurable: true },
    exitCode: { value: options.exited ? 0 : null, writable: true, configurable: true },
    signalCode: { value: null, writable: true, configurable: true },
    kill: { value: kill, configurable: true },
  });
  return { proc, kill };
}

describe('buildTreeKillArgs', () => {
  it('生成 taskkill 的整树强杀参数', () => {
    expect(buildTreeKillArgs(4242)).toEqual(['/pid', '4242', '/T', '/F']);
  });
});

describe('killProcessTree', () => {
  it('Windows 上走 taskkill 整树强杀', () => {
    const spawnImpl = fakeSpawn();
    const { proc, kill } = fakeProc({ pid: 1234 });

    killProcessTree(proc, { platform: 'win32', spawnImpl });

    expect(spawnImpl).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T', '/F'], {
      stdio: 'ignore',
    });
    // 整树杀就不该再走 proc.kill（那只会杀掉 cmd，Python 引擎会活下来）
    expect(kill).not.toHaveBeenCalled();
  });

  it('非 Windows 走 SIGTERM，不调 taskkill', () => {
    const spawnImpl = fakeSpawn();
    const { proc, kill } = fakeProc({ pid: 1234 });

    killProcessTree(proc, { platform: 'linux', spawnImpl });

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('pid 缺失时不发起 taskkill（避免拉起一个报「找不到进程」的 cmd 黑框）', () => {
    const spawnImpl = fakeSpawn();
    const { proc } = fakeProc({ pid: undefined });

    killProcessTree(proc, { platform: 'win32', spawnImpl });

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('spawn 抛错时静默（进程可能已自己退出，清理失败不该反向影响退出流程）', () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('boom');
    }) as unknown as FakeSpawn;
    const { proc } = fakeProc({ pid: 1234 });

    expect(() => killProcessTree(proc, { platform: 'win32', spawnImpl })).not.toThrow();
  });
});

describe('waitForProcessExit', () => {
  it('进程已退出时立即返回 true', async () => {
    const { proc } = fakeProc({ pid: 1, exited: true });
    await expect(waitForProcessExit(proc, 50)).resolves.toBe(true);
  });

  it('进程随后退出时返回 true', async () => {
    const { proc } = fakeProc({ pid: 1 });
    const pending = waitForProcessExit(proc, 1000);

    setTimeout(() => proc.emit('exit', 0), 10);

    await expect(pending).resolves.toBe(true);
  });

  it('超时未退出时返回 false（不无限等，退出不能被清理卡死）', async () => {
    const { proc } = fakeProc({ pid: 1 });
    await expect(waitForProcessExit(proc, 20)).resolves.toBe(false);
  });
});

describe('cleanupChildProcesses', () => {
  it('并发清理多个进程并回报已确认退出的数量', async () => {
    const spawnImpl = fakeSpawn();
    const a = fakeProc({ pid: 11 });
    const b = fakeProc({ pid: 22 });
    const platform = 'win32';

    const pending = cleanupChildProcesses([a.proc, null, b.proc], {
      platform,
      spawnImpl,
      exitTimeoutMs: 500,
    });

    setTimeout(() => {
      a.proc.emit('exit', 0);
      b.proc.emit('exit', 0);
    }, 10);

    await expect(pending).resolves.toEqual({ killed: 2, reaped: 2 });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('进程没死透时如实回报（调用方据此记日志）', async () => {
    const spawnImpl = fakeSpawn();
    const a = fakeProc({ pid: 11 });
    const b = fakeProc({ pid: 22 });

    const pending = cleanupChildProcesses([a.proc, b.proc], {
      platform: 'win32',
      spawnImpl,
      exitTimeoutMs: 20,
    });

    setTimeout(() => a.proc.emit('exit', 0), 5);

    await expect(pending).resolves.toEqual({ killed: 2, reaped: 1 });
  });

  it('没有子进程时零清理', async () => {
    await expect(cleanupChildProcesses([null, undefined], { exitTimeoutMs: 10 })).resolves.toEqual({
      killed: 0,
      reaped: 0,
    });
  });
});
