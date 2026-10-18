/**
 * 引擎一键修复（B4-03）。
 *
 * 真实 `pip install` 只能在真机验证，但「命令怎么排、失败停在哪、取消杀不杀进程」
 * 是纯逻辑，而且错了**不会报错**：比如失败后继续跑下一步，用户会看到一份
 * 「前一步红、后一步也红」的误导性报告；或者取消只 kill 父进程，留下孤儿 pip。
 * 这里用替身把每条路径钉死。
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  INSTALL_VERIFY_SENTINEL,
  buildEngineInstallRecipe,
  createEngineInstaller,
  type InstallChildProcess,
  type SpawnInstallProcess,
} from '../../electron/engineInstall';
import type { EngineInstallState } from '../../src/types/engine';
import type { EngineSelfCheckTarget } from '../../electron/engineSelfCheck';

const TARGET: EngineSelfCheckTarget = {
  bin: 'C:\\app\\nanobot\\nanobot\\.venv\\Scripts\\python.exe',
  config: 'C:\\app\\nanowork.config.json',
  engineRoot: 'C:\\app',
};

class FakeChild {
  pid = 1;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  private closeHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  on(event: string, listener: (...args: any[]) => void): this {
    if (event === 'close') {
      this.closeHandlers.push(listener as (code: number | null, signal: string | null) => void);
    } else if (event === 'error') {
      this.errorHandlers.push(listener as (err: Error) => void);
    }
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  close(code: number | null): void {
    for (const handler of this.closeHandlers) handler(code, null);
  }

  fail(err: Error): void {
    for (const handler of this.errorHandlers) handler(err);
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor timed out');
}

function harness(options: { venvExists?: boolean; platform?: NodeJS.Platform } = {}) {
  const spawned: FakeChild[] = [];
  const emitted: EngineInstallState[] = [];
  const killed: InstallChildProcess[] = [];

  const spawnFake: SpawnInstallProcess = () => {
    const child = new FakeChild();
    spawned.push(child);
    return child as unknown as InstallChildProcess;
  };

  const installer = createEngineInstaller({
    resolveTarget: async () => TARGET,
    emit: (state) => emitted.push(state),
    spawn: spawnFake,
    exists: () => options.venvExists ?? false,
    killTree: (proc) => {
      killed.push(proc);
      // 真实实现会 taskkill / proc.kill；替身里显式调用，让「确实杀了」可断言。
      (proc as unknown as FakeChild).kill();
    },
    platform: options.platform ?? 'win32',
    now: () => new Date('2026-10-18T00:00:00.000Z'),
  });

  return { installer, spawned, emitted, killed };
}

describe('buildEngineInstallRecipe', () => {
  it('venv 不存在时三步：建 venv → 装引擎 → 验证导入', () => {
    const recipe = buildEngineInstallRecipe(TARGET, {
      platform: 'win32',
      venvExists: false,
    });

    expect(recipe.map((step) => step.id)).toEqual(['venv', 'install', 'verify']);
    expect(recipe[0].bin).toBe('python');
    expect(recipe[0].display).toContain('python -m venv');
    expect(recipe[1].display).toContain('pip install -e');
    expect(recipe[1].display).toContain('C:\\app\\nanobot');
    expect(recipe[2].display).toContain(INSTALL_VERIFY_SENTINEL);
  });

  it('venv 已存在时跳过建环境（不覆盖正在使用的 Scripts）', () => {
    const recipe = buildEngineInstallRecipe(TARGET, {
      platform: 'win32',
      venvExists: true,
    });

    expect(recipe.map((step) => step.id)).toEqual(['install', 'verify']);
  });

  it('非 Windows 用 python3 建环境', () => {
    const recipe = buildEngineInstallRecipe(
      { ...TARGET, engineRoot: '/app' },
      { platform: 'linux', venvExists: false },
    );

    // ⚠️ 路径分隔符由宿主 `node:path` 决定（本测试跑在 Windows 上），
    // 这里只断言「用 python3」与「装到 venv 的 bin 目录」，不断言分隔符。
    expect(recipe[0].bin).toBe('python3');
    expect(recipe[1].bin).toContain('bin');
    expect(recipe[1].bin.endsWith('python')).toBe(true);
  });
});

describe('createEngineInstaller', () => {
  it('三步全成功：每一步 ok，整体 succeeded', async () => {
    const { installer, spawned, emitted } = harness();
    const done = installer.start();

    await waitFor(() => spawned.length === 1);
    spawned[0].stdout.emit('data', 'creating venv\n');
    spawned[0].close(0);

    await waitFor(() => spawned.length === 2);
    // ANSI 颜色码必须去掉：等宽块里只会变成乱码
    spawned[1].stderr.emit('data', '\u001b[31mInstalling...\u001b[0m\n');
    spawned[1].close(0);

    await waitFor(() => spawned.length === 3);
    spawned[2].stdout.emit('data', `${INSTALL_VERIFY_SENTINEL}\n`);
    spawned[2].close(0);

    const final = await done;

    expect(final.phase).toBe('succeeded');
    expect(final.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok']);
    expect(final.steps[1].outputTail).toContain('Installing...');
    expect(final.steps[1].outputTail).not.toContain('\u001b');
    // 至少推过一次 running 和一次 succeeded（节流不能把最终态吞掉）
    expect(emitted.some((state) => state.phase === 'running')).toBe(true);
    expect(emitted.at(-1)?.phase).toBe('succeeded');
  });

  it('某一步失败即停：后续步骤标 skipped，并保留原始输出', async () => {
    const { installer, spawned } = harness();
    const done = installer.start();

    await waitFor(() => spawned.length === 1);
    spawned[0].close(0);

    await waitFor(() => spawned.length === 2);
    spawned[1].stderr.emit('data', 'ERROR: Could not find a version that satisfies\n');
    spawned[1].close(1);

    const final = await done;

    expect(final.phase).toBe('failed');
    expect(final.steps.map((step) => step.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(final.message).toContain('退出码 1');
    expect(final.steps[1].outputTail).toContain('Could not find a version');
    // 失败后不得再 spawn 第三步
    expect(spawned).toHaveLength(2);
  });

  it('取消会杀进程树，并把当前步骤标 skipped', async () => {
    const { installer, spawned, killed } = harness();
    const done = installer.start();

    await waitFor(() => spawned.length === 1);
    const canceled = installer.cancel();

    expect(canceled.phase).toBe('canceled');
    expect(killed).toHaveLength(1);
    expect((killed[0] as unknown as FakeChild).killed).toBe(true);

    // 替身不会被真的杀掉，手动收尾让 runCommand 的 promise 结算
    spawned[0].close(null);
    const final = await done;

    expect(final.phase).toBe('canceled');
    expect(final.steps[0].status).toBe('skipped');
    expect(spawned).toHaveLength(1);
  });

  it('并发 start 只跑一条链（不会装两遍）', async () => {
    const { installer, spawned } = harness();
    const first = installer.start();
    const second = installer.start();

    await waitFor(() => spawned.length === 1);
    spawned[0].close(0);
    await waitFor(() => spawned.length === 2);
    spawned[1].close(0);
    await waitFor(() => spawned.length === 3);
    spawned[2].close(0);

    const [a, b] = await Promise.all([first, second]);
    expect(a.phase).toBe('succeeded');
    expect(b.phase).toBe('succeeded');
    expect(spawned).toHaveLength(3);
  });

  it('spawn 本身抛错时收成 failed，而不是未处理异常', async () => {
    const { installer, emitted } = harness();
    // 重新建一个 spawn 会抛错的实例
    const failing = createEngineInstaller({
      resolveTarget: async () => TARGET,
      emit: (state) => emitted.push(state),
      spawn: () => {
        throw new Error('spawn ENOENT');
      },
      exists: () => true,
      platform: 'win32',
    });

    const final = await failing.start();

    expect(final.phase).toBe('failed');
    expect(final.steps[0].outputTail).toContain('spawn ENOENT');
    expect(installer.getState().phase).toBe('idle');
  });
});
