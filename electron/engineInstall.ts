/**
 * 引擎一键修复（B4-03）：创建 venv → 安装引擎 → 验证导入。
 *
 * ## 为什么命令必须由主进程**自己**生成
 *
 * 渲染层只说「修复」，**不传任何命令**。若允许它传命令，这个入口就变成了
 * 「把渲染层的字符串交给主进程 spawn」——那是任意代码执行，比不提供一键修复更糟。
 * recipe 因此固定在本模块，且与 `engineSelfCheck` 的 remedy **同一套路径与引号规则**：
 * 用户在界面上看到的可复制命令，与实际执行的是同一串字符。
 *
 * ## 为什么进度要做成状态机而不是「最后给个结果」
 *
 * `pip install` 可能跑几分钟。只给「成功/失败」的话，用户会以为卡死并反复点；
 * 而中途失败时最需要的恰恰是**失败那一步的原始输出**（网络、权限、包版本的
 * 修法完全不同）。所以每一步都带 status + outputTail，失败即停，后续步骤标 skipped。
 *
 * ## 取消
 *
 * `pip` 会拉起子进程（下载、解压），只 kill 父进程会留下孤儿。取消走
 * `killProcessTree`（Windows `taskkill /T /F`，POSIX SIGTERM），与引擎进程清理同一套。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EngineInstallState,
  EngineInstallStep,
  EngineInstallStepId,
} from '../src/types/engine';
import {
  engineInterpreterCandidates,
  quote,
  type EngineSelfCheckTarget,
} from './engineSelfCheck';
import { killProcessTree } from './childProcesses';

/** 验证导入的哨兵：只看退出码会被「打印了报错但退出 0」的脚本骗过。 */
export const INSTALL_VERIFY_SENTINEL = 'nanowork-install-verify-ok';

/** 单步输出尾部保留上限（字符）。够看到 pip 的报错，又不会把 IPC 帧撑爆。 */
const DEFAULT_OUTPUT_TAIL_LIMIT = 8_000;

/** 输出节流：pip 的进度条会刷出大量 chunk，逐条 IPC 没有必要。 */
const EMIT_INTERVAL_MS = 100;

/** 去掉 ANSI 颜色码：终端能显示，等宽块里只会变成乱码。 */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export interface InstallCommand {
  id: EngineInstallStepId;
  title: string;
  bin: string;
  args: string[];
  /** 展示用命令（含真实路径；与 remedy 里的命令同源） */
  display: string;
}

/**
 * 生成修复步骤。
 *
 * @param venvExists 规范 venv 的解释器已存在时跳过「创建 venv」——否则会对一个
 *   正在被使用的 venv 重跑 `python -m venv`，轻则白等，重则覆盖 Scripts 里的启动器。
 *   这个判断必须由调用方查磁盘得出，不能拍脑袋。
 */
export function buildEngineInstallRecipe(
  target: EngineSelfCheckTarget,
  options: { platform?: NodeJS.Platform; venvExists?: boolean } = {},
): InstallCommand[] {
  const platform = options.platform ?? process.platform;
  const venv = engineInterpreterCandidates(target.engineRoot, platform);
  const repo = join(target.engineRoot, 'nanobot');
  const steps: InstallCommand[] = [];

  if (!options.venvExists) {
    // 建 venv 用的是**系统** Python（PATH 上的 python / python3）——venv 还不存在时，
    // 没有别的解释器可用。这一步失败通常意味着机器上没装 Python，或 PATH 里没有。
    const systemPython = platform === 'win32' ? 'python' : 'python3';
    steps.push({
      id: 'venv',
      title: '创建虚拟环境',
      bin: systemPython,
      args: ['-m', 'venv', venv.venv],
      display: `${quote(systemPython)} -m venv ${quote(venv.venv)}`,
    });
  }

  steps.push({
    id: 'install',
    title: '安装引擎',
    // 装到**规范 venv** 里，而不是 `target.bin`：后者可能是用户手填的别处路径，
    // 往一个自检都不认识的位置装包，只会让下一次自检继续失败。
    bin: venv.python,
    args: ['-m', 'pip', 'install', '-e', repo],
    display: `${quote(venv.python)} -m pip install -e ${quote(repo)}`,
  });

  steps.push({
    id: 'verify',
    title: '验证导入',
    bin: venv.python,
    args: ['-c', `import nanobot; print('${INSTALL_VERIFY_SENTINEL}')`],
    display: `${quote(venv.python)} -c "import nanobot; print('${INSTALL_VERIFY_SENTINEL}')"`,
  });

  return steps;
}

/** 子进程最小面（便于单测注入替身，不依赖真实 spawn）。 */
export interface InstallChildProcess {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  kill(signal?: string): boolean;
}

export type SpawnInstallProcess = (
  bin: string,
  args: string[],
  options: { windowsHide: boolean },
) => InstallChildProcess;

const defaultSpawn: SpawnInstallProcess = (bin, args, options) =>
  spawn(bin, args, options) as unknown as InstallChildProcess;

export interface EngineInstallerDeps {
  /** 与自检共用的目标解析（`readNanobotConfig` 那一套）。 */
  resolveTarget: () => Promise<EngineSelfCheckTarget>;
  /** 状态推送（生产环境是 `webContents.send`）。 */
  emit: (state: EngineInstallState) => void;
  spawn?: SpawnInstallProcess;
  exists?: (path: string) => boolean;
  killTree?: (proc: InstallChildProcess) => void;
  platform?: NodeJS.Platform;
  now?: () => Date;
  outputTailLimit?: number;
}

export interface EngineInstaller {
  getState(): EngineInstallState;
  start(): Promise<EngineInstallState>;
  cancel(): EngineInstallState;
}

function cloneState(state: EngineInstallState): EngineInstallState {
  return { ...state, steps: state.steps.map((step) => ({ ...step })) };
}

export function createEngineInstaller(deps: EngineInstallerDeps): EngineInstaller {
  const spawnProcess = deps.spawn ?? defaultSpawn;
  const exists = deps.exists ?? existsSync;
  const killTree =
    deps.killTree ??
    ((proc: InstallChildProcess) => killProcessTree(proc as unknown as ChildProcess));
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => new Date());
  const tailLimit = deps.outputTailLimit ?? DEFAULT_OUTPUT_TAIL_LIMIT;

  let state: EngineInstallState = { phase: 'idle', steps: [] };
  let running: Promise<EngineInstallState> | null = null;
  let canceled = false;
  let current: InstallChildProcess | null = null;
  let lastEmitAt = 0;

  const push = (force = false): void => {
    const at = Date.now();
    if (!force && at - lastEmitAt < EMIT_INTERVAL_MS) return;
    lastEmitAt = at;
    deps.emit(cloneState(state));
  };

  const findStep = (id: EngineInstallStepId): EngineInstallStep | undefined =>
    state.steps.find((step) => step.id === id);

  const runCommand = (command: InstallCommand): Promise<{ code: number; output: string }> =>
    new Promise((resolve) => {
      let output = '';
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        current = null;
        resolve({ code, output });
      };
      const append = (chunk: unknown): void => {
        const text = String(chunk).replace(ANSI_RE, '');
        output = (output + text).slice(-tailLimit);
        const step = findStep(command.id);
        if (step) step.outputTail = output;
        push();
      };

      let child: InstallChildProcess;
      try {
        child = spawnProcess(command.bin, command.args, { windowsHide: true });
      } catch (err) {
        append(err instanceof Error ? err.message : String(err));
        finish(1);
        return;
      }
      current = child;
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (err) => {
        append(`\n${err.message}`);
        finish(1);
      });
      child.on('close', (code) => finish(code ?? 1));
    });

  const start = async (): Promise<EngineInstallState> => {
    if (running) return running;
    running = (async () => {
      canceled = false;
      const target = await deps.resolveTarget();
      const venv = engineInterpreterCandidates(target.engineRoot, platform);
      const recipe = buildEngineInstallRecipe(target, {
        platform,
        venvExists: exists(venv.python),
      });

      state = {
        phase: 'running',
        startedAt: now().toISOString(),
        steps: recipe.map((command) => ({
          id: command.id,
          title: command.title,
          status: 'pending',
          command: command.display,
        })),
      };
      push(true);

      let failed = false;
      for (const command of recipe) {
        if (canceled) break;
        const step = findStep(command.id);
        if (!step) continue;
        step.status = 'running';
        push(true);

        const result = await runCommand(command);
        if (canceled) {
          step.status = 'skipped';
          push(true);
          break;
        }
        if (result.code === 0) {
          step.status = 'ok';
          push(true);
          continue;
        }
        step.status = 'failed';
        failed = true;
        state.message = `${command.title}失败（退出码 ${result.code}）。原始输出见下方。`;
        push(true);
        break;
      }

      // 失败/取消后，没跑到的步骤标 skipped：留着 pending 会让人以为「还在排队」。
      for (const step of state.steps) {
        if (step.status === 'pending') step.status = 'skipped';
      }
      if (canceled) {
        state.phase = 'canceled';
        state.message = state.message ?? '已取消。';
      } else if (failed) {
        state.phase = 'failed';
      } else {
        state.phase = 'succeeded';
      }
      state.endedAt = now().toISOString();
      push(true);
      running = null;
      return cloneState(state);
    })();
    return running;
  };

  return {
    getState: () => cloneState(state),
    start,
    cancel() {
      if (state.phase !== 'running') return cloneState(state);
      canceled = true;
      if (current) killTree(current);
      state.phase = 'canceled';
      state.message = state.message ?? '已取消。';
      state.endedAt = now().toISOString();
      for (const step of state.steps) {
        if (step.status === 'running') step.status = 'skipped';
      }
      push(true);
      return cloneState(state);
    },
  };
}
