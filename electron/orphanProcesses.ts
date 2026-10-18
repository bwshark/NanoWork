/**
 * 启动时的孤儿引擎回收（FR-13.2 的补齐）。
 *
 * **为什么需要**：退出时本来就有 `will-quit` → `stopNanobotAndWait()` 整树 taskkill，
 * 但它只在**正常退出**路径上跑。应用被任务管理器强杀、主进程崩溃、机器断电时，
 * Python 引擎会活下来继续占住 8900（serve）与 18790（gateway health）。
 * 下次启动时 `startNanobot()` 探测到端口被占 → 走「复用既有网关」分支 →
 * `running=false` 但 `port` 有值 —— 界面就一直指向一个**本应用管不着**的引擎，
 * 症状是「模型列表空 / 面板 Failed to fetch」，而界面上没有任何线索指向真因。
 *
 * **只回收判据确凿的**：命令行走的是本项目的引擎入口（`-m nanobot serve|gateway`），
 * 且它的进程树里没有当前 Electron 主进程 —— 即上一实例的遗留。
 * 拿不到进程树 / 判据不唯一时**只告警不杀**：误杀用户手动起的引擎比留一个孤儿更糟。
 *
 * 用例纪律：判据（`isEngineCommandLine` / `pickOrphanPids`）是纯函数，直接单测；
 * IO 部分只做「列举 → 过滤 → taskkill」，不引入平台分支到判据里。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { buildTreeKillArgs } from './childProcesses';

/** 进程列表里的一条（与 Win32_Process 的字段同名，便于直接映射） */
export interface EngineProcessInfo {
  pid: number;
  parentPid: number | null;
  commandLine: string;
}

export interface ReapOptions {
  /** 当前 Electron 主进程 pid：它的后代一律不算孤儿 */
  selfPid: number;
  /** 便于测试注入替身；默认 `node:child_process` 的 spawn */
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
}

export interface ReapResult {
  /** 实际发起 taskkill 的进程数 */
  reaped: number;
  /** 因判据不足而放弃的候选数 */
  skipped: number;
}

/**
 * 命令行是否是这个引擎的进程。
 *
 * 两种拉法都要认：`python -m nanobot serve`（venv 解释器，本项目走的）与
 * `nanobot.exe serve`（setuptools console script）。判据锚在 `nanobot` 后紧跟的
 * 子命令上，避免把「路径里带 nanobot 的无关 python」误杀。
 */
export function isEngineCommandLine(commandLine: string): boolean {
  const text = commandLine.trim();
  if (text.length === 0) return false;
  return /nanobot(?:\.exe)?["']?\s+(?:--\S+\s+)*serve\b/i.test(text)
    || /nanobot(?:\.exe)?["']?\s+(?:--\S+\s+)*gateway\b/i.test(text)
    || /-m\s+nanobot\s+(?:--\S+\s+)*(?:serve|gateway)\b/i.test(text);
}

/**
 * 从进程表里挑出孤儿：走引擎命令行、且**不在** `selfPid` 的后代树里。
 *
 * 后代判据沿父指针上溯（带环保护与深度上限）：引擎经 `shell:true` 拉起时是
 * 「cmd → shim → 解释器」三层，只比直接子进程会漏。
 */
export function pickOrphanPids(
  processes: readonly EngineProcessInfo[],
  selfPid: number,
): { orphans: number[]; candidates: number[] } {
  const byPid = new Map<number, EngineProcessInfo>();
  for (const p of processes) byPid.set(p.pid, p);

  const isDescendantOfSelf = (pid: number): boolean => {
    let current: number | null | undefined = pid;
    const seen = new Set<number>();
    for (let depth = 0; depth < 16; depth += 1) {
      if (current === undefined || current === null) return false;
      if (current === selfPid) return true;
      if (seen.has(current)) return false; // 父指针成环：判据不足，按「不是后代」处理
      seen.add(current);
      current = byPid.get(current)?.parentPid ?? null;
    }
    return false;
  };

  const candidates: number[] = [];
  const orphans: number[] = [];
  for (const p of processes) {
    if (!isEngineCommandLine(p.commandLine)) continue;
    candidates.push(p.pid);
    if (!isDescendantOfSelf(p.pid)) orphans.push(p.pid);
  }

  // 只保留**链顶**：同一条孤儿链上杀一次就够（taskkill /T 自带子孙）。
  // 逐个杀三次不只是浪费——链上某个子进程若在两次 taskkill 之间重启，
  // 第二次 taskkill 打在同一条链上会连带杀掉刚起来的那棵。
  const orphanSet = new Set(orphans);
  const hasOrphanAncestor = (pid: number): boolean => {
    let current: number | null | undefined = byPid.get(pid)?.parentPid ?? null;
    const seen = new Set<number>([pid]);
    for (let depth = 0; depth < 16 && current !== null && current !== undefined; depth += 1) {
      if (seen.has(current)) return false;
      seen.add(current);
      if (orphanSet.has(current)) return true;
      current = byPid.get(current)?.parentPid ?? null;
    }
    return false;
  };

  const tops = orphans.filter((pid) => !hasOrphanAncestor(pid));
  // 兜底：父指针成环这类病态情况下 tops 可能为空（互相都被判成「有孤儿祖先」）。
  // 那就退回整组全杀——多打一次 taskkill 的代价远小于留下占着端口的孤儿。
  return { orphans: tops.length > 0 || orphans.length === 0 ? tops : orphans, candidates };
}

/** 列举本机进程（Windows 走 CIM；其余平台返回空表 = 本次不回收） */
export function listProcesses(spawnImpl: typeof spawn = spawn): Promise<EngineProcessInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const ps = [
    '$ErrorActionPreference = "Stop";',
    'Get-CimInstance Win32_Process -Filter "Name = \'python.exe\'" |',
    'Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress',
  ].join(' ');
  return new Promise<EngineProcessInfo[]>((resolve) => {
    let out = '';
    let proc: ChildProcess;
    try {
      proc = spawnImpl('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }
    proc.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim() || '[]');
        const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        resolve(
          rows
            .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
            .map((r) => ({
              pid: Number(r.ProcessId ?? 0),
              parentPid: r.ParentProcessId === null ? null : Number(r.ParentProcessId ?? 0),
              commandLine: String(r.CommandLine ?? ''),
            }))
            .filter((p) => p.pid > 0 && p.commandLine !== ''),
        );
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * 回收上一实例遗留的引擎进程；返回回收/放弃数量供调用方记日志。
 *
 * **判据不足就放弃**：拿不到进程表（CIM 失败 / 非 Windows）时返回 `{ reaped: 0, skipped: 0 }`，
 * 由调用方决定要不要另外告警——这里不做「宁可多杀」的兜底。
 */
export async function reapOrphanEngineProcesses(options: ReapOptions): Promise<ReapResult> {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  if (platform !== 'win32') return { reaped: 0, skipped: 0 };

  const processes = await listProcesses(spawnImpl);
  if (processes.length === 0) return { reaped: 0, skipped: 0 };

  const { orphans } = pickOrphanPids(processes, options.selfPid);
  for (const pid of orphans) {
    try {
      spawnImpl('taskkill', buildTreeKillArgs(pid), { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 杀不掉就当没杀：下一实例还会再回收一次 */
    }
  }
  return { reaped: orphans.length, skipped: 0 };
}