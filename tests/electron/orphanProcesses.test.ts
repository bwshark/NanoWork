/**
 * 启动时的孤儿引擎回收。
 *
 * 变异验证目标：
 * - `isEngineCommandLine` 去掉 `-m nanobot` 分支 → `python -m nanobot serve` 用例变红；
 * - `pickOrphanPids` 去掉 `current === selfPid` 判据 → 「自己的后代不算孤儿」用例变红；
 * - `pickOrphanPids` 只看直接父进程（不上溯）→ 三层 shim 链用例变红。
 */

import { describe, expect, it, vi } from 'vitest';
import type { spawn } from 'node:child_process';
import { isEngineCommandLine, pickOrphanPids, type EngineProcessInfo } from '../../electron/orphanProcesses';

const PY = 'D:\\Workspace\\study\\nanowork\\nanobot\\nanobot\\.venv\\Scripts\\python.exe';

describe('isEngineCommandLine', () => {
  it('认 venv 解释器 + -m nanobot serve（项目实际拉法）', () => {
    expect(isEngineCommandLine(`${PY} -m nanobot serve --host 127.0.0.1 --port 8900`)).toBe(true);
  });

  it('认 -m nanobot gateway --foreground', () => {
    expect(isEngineCommandLine(`${PY} -m nanobot gateway --foreground --config x.json`)).toBe(true);
  });

  it('认 console script 拉法 nanobot.exe serve', () => {
    expect(isEngineCommandLine('C:\\tools\\nanobot.exe serve --port 8900')).toBe(true);
  });

  it('不认与引擎无关的 python', () => {
    expect(isEngineCommandLine('C:\\Python313\\python.exe manage.py runserver')).toBe(false);
    expect(isEngineCommandLine('')).toBe(false);
  });

  it('不认路径里带 nanobot 目录但没有引擎子命令的进程', () => {
    expect(
      isEngineCommandLine('D:\\Workspace\\study\\nanowork\\nanobot\\tools\\build.py --serve'),
    ).toBe(false);
  });
});

describe('pickOrphanPids', () => {
  const selfPid = 60004;

  function chain(): EngineProcessInfo[] {
    // Electron(60004) → cmd/shim(49220) → 中间(44720) → 真正监听者(58196)
    return [
      { pid: 60004, parentPid: 61980, commandLine: 'electron.exe nanowork' },
      { pid: 49220, parentPid: 60004, commandLine: `${PY} -m nanobot serve --port 8900` },
      { pid: 44720, parentPid: 49220, commandLine: `${PY} -m nanobot serve --port 8900` },
      { pid: 58196, parentPid: 44720, commandLine: `${PY} -m nanobot serve --port 8900` },
      { pid: 61832, parentPid: 60004, commandLine: `${PY} -m nanobot gateway --foreground` },
    ];
  }

  it('自己拉起的整条进程树（含三层 shim）都不算孤儿', () => {
    const { orphans } = pickOrphanPids(chain(), selfPid);
    expect(orphans).toEqual([]);
  });

  it('上一实例遗留的引擎（父进程已不存在）算孤儿', () => {
    const stale: EngineProcessInfo[] = [
      // 上一实例的 Electron 已死，父 pid 不在表里
      { pid: 11111, parentPid: 9999, commandLine: `${PY} -m nanobot serve --port 8900` },
      { pid: 22222, parentPid: 11111, commandLine: `${PY} -m nanobot serve --port 8900` },
      { pid: 33333, parentPid: 9999, commandLine: `${PY} -m nanobot gateway --foreground` },
    ];
    const { orphans } = pickOrphanPids(stale, selfPid);
    // 每条链只回收链顶（taskkill /T 会带走子孙），否则会对同一棵树杀三次
    expect(orphans).toEqual([11111, 33333]);
  });

  it('非引擎进程即便无父也不动（不越界杀无关 python）', () => {
    const others: EngineProcessInfo[] = [
      { pid: 44444, parentPid: 9999, commandLine: 'C:\\Python313\\python.exe train.py' },
    ];
    expect(pickOrphanPids(others, selfPid).orphans).toEqual([]);
  });

  it('父指针成环时不误判成自己的后代（判据不足 → 视为孤儿候选）', () => {
    const cyclic: EngineProcessInfo[] = [
      { pid: 700, parentPid: 701, commandLine: `${PY} -m nanobot serve` },
      { pid: 701, parentPid: 700, commandLine: `${PY} -m nanobot serve` },
    ];
    expect(pickOrphanPids(cyclic, selfPid).orphans).toEqual([700, 701]);
  });
});

describe('reapOrphanEngineProcesses: 非 Windows 直接不回收', () => {
  it('不 spawn 任何东西', async () => {
    const { reapOrphanEngineProcesses } = await import('../../electron/orphanProcesses');
    const spawnImpl = vi.fn() as unknown as typeof spawn;
    const result = await reapOrphanEngineProcesses({ selfPid: 1, platform: 'darwin', spawnImpl });
    expect(result).toEqual({ reaped: 0, skipped: 0 });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});