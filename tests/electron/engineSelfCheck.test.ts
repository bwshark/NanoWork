/**
 * 引擎运行时三项自检（FR-13.6，主进程侧）。
 *
 * 两条判据是这次改动的**全部意义**，用例就围着它们转：
 *
 * 1. **三项各自独立**：某一项失败时，另外两项**不得**被连坐判红。只断言「失败项是红的」
 *    证明不了这件事 —— 把 `ok` 写成 `findings.every(...)` 的反面（比如第一项失败就
 *    提前返回），照样能让失败项的断言通过。所以每个用例都同时断言另外两项的状态。
 * 2. **文案里必须有真实路径 / 真实报错**。验收标准①要的是「把 venv 改名 → 引导含
 *    **实际查找过的路径**」，所以这里断言的是**具体路径字符串出现**，而不是「有个 detail」。
 *
 * IO 是注入的：`engineSelfCheck.ts` 把 `exists` / `run` 抽成 `EngineSelfCheckIO`，
 * 正是为了让「解释器缺失」「依赖没装」「配置写坏」这三种在真机上没法复现的情况
 * 可以在单测里各自单独发生。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SELF_CHECK_ORDER,
  engineInterpreterCandidates,
  runEngineSelfCheck,
  type EngineSelfCheckIO,
  type EngineSelfCheckRunResult,
  type EngineSelfCheckTarget,
} from '@/../electron/engineSelfCheck';

const APP_ROOT = join('C:', 'app');

/** 三项全过时子进程的应答（按 `-c` 的脚本内容分流，避免依赖调用顺序） */
function passingRun(_bin: string, args: string[]): EngineSelfCheckRunResult {
  const script = args[1] ?? '';
  if (script.includes('import nanobot')) {
    return { code: 0, stdout: 'nanowork-selfcheck-import-ok\n', stderr: '' };
  }
  if (script.includes('load_config')) {
    return { code: 0, stdout: 'nanowork-selfcheck-config-ok\n', stderr: '' };
  }
  return { code: 1, stdout: '', stderr: `未预期的命令：${script}` };
}

interface StubOptions {
  /** 存在的路径集合（其余一律不存在） */
  existing?: string[];
  run?: (bin: string, args: string[]) => EngineSelfCheckRunResult;
}

function stubIO(options: StubOptions = {}): EngineSelfCheckIO {
  const existing = new Set(options.existing ?? []);
  return {
    exists: (path) => existing.has(path),
    run: async (bin, args) => (options.run ?? passingRun)(bin, args),
  };
}

/** 三者齐备的目标：解释器与配置文件都「存在」 */
function readyTarget(): { target: EngineSelfCheckTarget; candidates: ReturnType<typeof engineInterpreterCandidates>; configPath: string } {
  const candidates = engineInterpreterCandidates(APP_ROOT, process.platform);
  const configPath = join(APP_ROOT, 'nanowork.config.json');
  return {
    candidates,
    configPath,
    target: { bin: candidates.python, config: configPath, engineRoot: APP_ROOT },
  };
}

function statusOf(report: Awaited<ReturnType<typeof runEngineSelfCheck>>, id: string) {
  return report.findings.find((finding) => finding.id === id)?.status;
}

describe('engineInterpreterCandidates', () => {
  it('venv 在**包目录的下一层**（两层 nanobot），不是引擎仓库根', () => {
    // 这条钉的是一个真踩过的错：少一层就会报出一个「根本没找过」的路径，
    // 而验收标准要的就是「文案含**实际**查找过的路径」。
    const c = engineInterpreterCandidates(APP_ROOT, 'win32');
    expect(c.repo).toBe(join(APP_ROOT, 'nanobot'));
    expect(c.venv).toBe(join(APP_ROOT, 'nanobot', 'nanobot', '.venv'));
    expect(c.python).toBe(join(APP_ROOT, 'nanobot', 'nanobot', '.venv', 'Scripts', 'python.exe'));
    expect(c.script).toBe(join(APP_ROOT, 'nanobot', 'nanobot', '.venv', 'Scripts', 'nanobot.exe'));
  });

  it('非 Windows 用 bin/ 下的可执行文件', () => {
    const c = engineInterpreterCandidates(APP_ROOT, 'linux');
    expect(c.python).toBe(join(APP_ROOT, 'nanobot', 'nanobot', '.venv', 'bin', 'python'));
    expect(c.script).toBe(join(APP_ROOT, 'nanobot', 'nanobot', '.venv', 'bin', 'nanobot'));
  });

  it('固定三项顺序（界面按它渲染，不能每次自检顺序不同）', () => {
    expect([...SELF_CHECK_ORDER]).toEqual(['interpreter', 'engine-import', 'config']);
  });
});

describe('三项全过', () => {
  it('三项都是 ok，报告带目标信息', async () => {
    const { target, configPath, candidates } = readyTarget();
    const report = await runEngineSelfCheck(
      target,
      stubIO({ existing: [candidates.python, configPath] }),
    );

    expect(report.ok).toBe(true);
    expect(report.findings.map((finding) => finding.status)).toEqual(['ok', 'ok', 'ok']);
    expect(report.target.bin).toBe(candidates.python);
    expect(report.target.config).toBe(configPath);
    // 候选路径原样进报告：用户要能看出「你找的是哪几个地方」
    expect(report.target.candidates).toContain(candidates.python);
    expect(Date.parse(report.checkedAt)).not.toBeNaN();
  });

  it('成功的项也给 summary（界面显示「通过」，不是留白）', async () => {
    const { target, configPath, candidates } = readyTarget();
    const report = await runEngineSelfCheck(
      target,
      stubIO({ existing: [candidates.python, configPath] }),
    );
    for (const finding of report.findings) {
      expect(finding.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('① 解释器不可达（venv 被改名）', () => {
  it('判红，且**证据与引导里都是实际找过的真实路径**', async () => {
    const { target, candidates } = readyTarget(); // 什么都不存在：venv 被改名了
    const report = await runEngineSelfCheck(target, stubIO({ existing: [] }));

    const interpreter = report.findings[0];
    expect(interpreter.id).toBe('interpreter');
    expect(interpreter.status).toBe('failed');
    expect(report.ok).toBe(false);

    // 验收①：文案含**实际查找过的路径**
    expect(interpreter.detail).toContain(candidates.python);
    expect(interpreter.detail).toContain(candidates.script);
    expect(interpreter.summary).toContain(candidates.python);
    // 引导里的命令必须是可直接执行的（含真实 venv 路径）
    expect(interpreter.remedy?.commands.join('\n')).toContain(candidates.venv);
    expect(interpreter.remedy?.steps.length).toBeGreaterThan(0);
  });

  it('⭐ 另外两项**不被连坐**判红，而是 skipped', async () => {
    const { target } = readyTarget();
    const report = await runEngineSelfCheck(target, stubIO({ existing: [] }));

    // 解释器都没有，跑不出有意义的结论；报两条红只会把注意力引偏
    expect(statusOf(report, 'engine-import')).toBe('skipped');
    expect(statusOf(report, 'config')).toBe('skipped');
  });

  it('bin 是裸命令名（PATH 查找）时判 skipped，不是 failed', async () => {
    const { target, configPath } = readyTarget();
    const report = await runEngineSelfCheck(
      { ...target, bin: 'nanobot' },
      stubIO({ existing: [configPath] }),
    );

    // 「不知道」显示成红色会让新装用户以为坏了；下一步会真实调用它
    expect(statusOf(report, 'interpreter')).toBe('skipped');
    expect(report.ok).toBe(true);
  });
});

describe('② 引擎包导入失败', () => {
  it('判红，且 detail 是**子进程原始报错**', async () => {
    const { target, configPath, candidates } = readyTarget();
    const report = await runEngineSelfCheck(
      target,
      stubIO({
        existing: [candidates.python, configPath],
        run: (bin, args) => {
          const script = args[1] ?? '';
          if (script.includes('import nanobot')) {
            return {
              code: 1,
              stdout: '',
              stderr: "ModuleNotFoundError: No module named 'nanobot'",
            };
          }
          return passingRun(bin, args);
        },
      }),
    );

    const finding = report.findings[1];
    expect(finding.id).toBe('engine-import');
    expect(finding.status).toBe('failed');
    expect(finding.detail).toContain("No module named 'nanobot'");
    // 解释器那一项是好的 —— 这正是「三项独立」的意义：用户要装依赖，不是建 venv
    expect(statusOf(report, 'interpreter')).toBe('ok');
    expect(finding.remedy?.commands.join('\n')).toContain('pip install -e');
  });

  it('只看退出码会被「打印报错但退出 0」骗过，所以还要求哨兵串', async () => {
    const { target, configPath, candidates } = readyTarget();
    const report = await runEngineSelfCheck(
      target,
      stubIO({
        existing: [candidates.python, configPath],
        run: (bin, args) => {
          const script = args[1] ?? '';
          if (script.includes('import nanobot')) {
            return { code: 0, stdout: 'some warning, no sentinel\n', stderr: '' };
          }
          return passingRun(bin, args);
        },
      }),
    );

    expect(statusOf(report, 'engine-import')).toBe('failed');
  });
});

describe('③ 配置校验', () => {
  it('配置文件不存在 → skipped（引擎首次启动会生成，**不是**错误）', async () => {
    const { target, candidates } = readyTarget();
    const report = await runEngineSelfCheck(
      target,
      stubIO({ existing: [candidates.python] }), // 只有配置缺
    );

    const finding = report.findings[2];
    expect(finding.status).toBe('skipped');
    expect(finding.summary).toContain('首次启动');
    expect(finding.detail).toContain(target.config); // 仍然说清「我在看哪个文件」
    expect(report.ok).toBe(true); // 新装用户不该看到红
  });

  it('存在但不符合 schema → 判红，detail 是原始报错', async () => {
    const { target, configPath, candidates } = readyTarget();
    const report = await runEngineSelfCheck(
      target,
      stubIO({
        existing: [candidates.python, configPath],
        run: (bin, args) => {
          const script = args[1] ?? '';
          if (script.includes('load_config')) {
            return {
              code: 1,
              stdout: '',
              stderr: 'ValidationError: agents.defaults.timezone\n  Input should be a valid string',
            };
          }
          return passingRun(bin, args);
        },
      }),
    );

    const finding = report.findings[2];
    expect(finding.status).toBe('failed');
    expect(report.ok).toBe(false);
    expect(finding.detail).toContain('agents.defaults.timezone');
    // 另外两项仍然是好的：只该动配置，不该去重建 venv
    expect(statusOf(report, 'interpreter')).toBe('ok');
    expect(statusOf(report, 'engine-import')).toBe('ok');
    expect(finding.remedy?.commands.join('\n')).toContain(configPath);
  });

  it('校验用的命令把文件路径作为 argv 传，不做字符串拼接引号', async () => {
    const { target, configPath, candidates } = readyTarget();
    const seen: string[][] = [];
    await runEngineSelfCheck(
      target,
      stubIO({
        existing: [candidates.python, configPath],
        run: (bin, args) => {
          seen.push(args);
          return passingRun(bin, args);
        },
      }),
    );

    const configCall = seen.find((args) => (args[1] ?? '').includes('load_config'));
    expect(configCall).toBeDefined();
    // argv 末位就是路径本体：路径里有空格 / 引号时也不会被拆坏
    expect(configCall?.[configCall.length - 1]).toBe(configPath);
    expect(configCall?.[1]).toContain('sys.argv[1]');
  });
});

describe('引导里的文档路径', () => {
  it('文档在就给真实文件路径；不在就给 null（不编 URL）', async () => {
    const { target, candidates, configPath } = readyTarget();
    const docPath = join(APP_ROOT, 'docs', 'engine-dev-setup.md');

    const withDoc = await runEngineSelfCheck(
      { ...target, bin: candidates.script },
      stubIO({ existing: [docPath, configPath] }),
    );
    expect(withDoc.findings[0].remedy?.docPath).toBe(docPath);

    const withoutDoc = await runEngineSelfCheck(target, stubIO({ existing: [] }));
    expect(withoutDoc.findings[0].remedy?.docPath).toBeNull();
  });
});

/**
 * 打包态（`layout: 'bundle'`）的四条判据。
 *
 * 这组用例存在的理由：dev 态与打包态的差异**不在路径本身**，而在"用户看到什么引导"。
 * 打包后让用户 `python -m venv` 是纯粹的误导（安装包里没有引擎源码），而不带
 * PYTHONPATH 去 import 则必然失败、却会显示成"引擎没装好"。
 */
describe('bundle（打包态）布局', () => {
  const RT = join('C:', 'app', 'resources', 'rt');

  function bundleTarget(overrides: Partial<EngineSelfCheckTarget> = {}): EngineSelfCheckTarget {
    return {
      bin: join(RT, 'python', 'python.exe'),
      config: join('C:', 'userdata', 'nanowork.config.json'),
      engineRoot: RT,
      layout: 'bundle',
      env: { PYTHONPATH: join(RT, 'site') },
      ...overrides,
    };
  }

  it('解释器与 site 都在 rt 下，没有双层 nanobot', () => {
    const c = engineInterpreterCandidates(RT, 'win32', 'bundle');
    expect(c.python).toBe(join(RT, 'python', 'python.exe'));
    expect(c.venv).toBe(join(RT, 'site'));
    expect(c.repo).toBe(RT);
    // 便携解释器没有 console script：`-m nanobot` 是唯一入口
    expect(c.script).toBe(c.python);
  });

  it('非 Windows 的便携解释器在 bin/python3', () => {
    const c = engineInterpreterCandidates(RT, 'linux', 'bundle');
    expect(c.python).toBe(join(RT, 'python', 'bin', 'python3'));
  });

  it('解释器缺失时的引导**不再**教用户建 venv / editable 安装', async () => {
    const report = await runEngineSelfCheck(bundleTarget(), stubIO({ existing: [] }));

    const interpreter = report.findings[0];
    expect(interpreter.status).toBe('failed');
    const commands = interpreter.remedy?.commands.join('\n') ?? '';
    expect(commands).not.toContain('-m venv');
    expect(commands).not.toContain('pip install -e');
    // 该做的就是覆盖安装 —— 文案必须说出来，否则用户只会去装 Python
    expect(interpreter.remedy?.steps.join('\n')).toContain('覆盖安装');
  });

  it('子进程拿到 PYTHONPATH（否则 import 必失败，却会显示成"引擎没装好"）', async () => {
    const seen: Array<{ cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    await runEngineSelfCheck(bundleTarget(), {
      exists: () => true,
      run: async (bin, args, options) => {
        seen.push({ cwd: options.cwd, env: options.env });
        return passingRun(bin, args);
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.env?.PYTHONPATH).toBe(join(RT, 'site'));
    }
  });

  it('cwd 是 rt 本身（`<rt>/nanobot` 不存在，execFile 会以 ENOENT 失败）', async () => {
    const cwds: Array<string | undefined> = [];
    await runEngineSelfCheck(bundleTarget(), {
      exists: () => true,
      run: async (bin, args, options) => {
        cwds.push(options.cwd);
        return passingRun(bin, args);
      },
    });

    expect(cwds.length).toBeGreaterThan(0);
    for (const cwd of cwds) expect(cwd).toBe(RT);
  });
});
