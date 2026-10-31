/**
 * 引擎运行时三项自检（FR-13.6，Electron 主进程）。
 *
 * ## 要解决的是什么
 *
 * 本项目**不打包 CPython**（PRD §1.5）：引擎需要一个本机的 venv。于是「装不上 /
 * 找不到引擎」对用户曾经是**黑盒** —— `fallbackLaunchConfig()` 在全部候选路径都
 * 失败后会退到 PATH 上的裸 `nanobot`，spawn 直接 ENOENT，界面上只见「网关离线」。
 * 用户能拿到的最多是一句 `spawn nanobot ENOENT`，而它既没说是哪个路径、也没说该
 * 怎么办。这里把那个黑盒拆成三条可判定的检查 + 每条的**真实命令**。
 *
 * ## 三个设计决定
 *
 * 1. **候选路径只有一份真相**：`engineInterpreterCandidates()` 同时被
 *    `main.ts` 的 `fallbackLaunchConfig()` 和本模块使用。验收标准①要的是
 *    「文案含实际查找过的路径」—— 如果自检自己另写一套候选，它报出来的路径
 *    与启动器真正找的路径就会分叉，那种报告比没有更坏。
 * 2. **IO 注入**（`EngineSelfCheckIO`）：三项各有独立失败用例是硬性验收，而
 *    「跑不起来」「装不上」这些情况在真实机器上没法复现。把 `exists` / `run`
 *    抽出来，测试就能让任意一项单独失败，并断言**另外两项仍然通过** ——
 *    后者才是「三项独立」的真正证明（只测「失败项是红的」证明不了别的项没被连坐）。
 * 3. **子进程一律带超时 + `windowsHide`**：自检跑在窗口显示**之后**（不阻塞首屏），
 *    但主进程不能被它挂住；且 Windows 上不隐藏会闪黑框。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EngineSelfCheckFinding,
  EngineSelfCheckId,
  EngineSelfCheckReport,
  EngineSelfCheckRemedy,
} from '../src/types/engine';

/** 单条子进程的输出（只保留判定与展示所需的三项） */
export interface EngineSelfCheckRunResult {
  /** 退出码；被超时杀掉时由实现给一个非 0 值 */
  code: number;
  stdout: string;
  stderr: string;
}

export interface EngineSelfCheckIO {
  exists(path: string): boolean;
  run(
    bin: string,
    args: string[],
    options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<EngineSelfCheckRunResult>;
}

/**
 * 引擎运行时的两种布局。
 *
 * - `repo`：开发态。引擎是同级 git 仓库，venv 固定建在 `<root>/nanobot/nanobot/.venv`。
 * - `bundle`：打包态。便携解释器与预装依赖都在 `<resources>/rt/` 下（`python/` + `site/`）。
 *
 * 为什么要显式区分而不是"探测哪个存在"：两种布局的**引导文案**必须不同 —— dev 态该教用户
 * 建 venv，打包态让用户建 venv 是彻头彻尾的误导（安装包里根本没有引擎源码）。探测式实现
 * 会让"文案该说什么"取决于磁盘巧合，那正是这类工单反复出现的原因。
 */
export type EngineLayout = 'repo' | 'bundle';

/** 自检目标（由 `main.ts` 的启动配置解析给出，不在本模块里另算） */
export interface EngineSelfCheckTarget {
  bin: string;
  config: string;
  engineRoot: string;
  /** 缺省 `repo`：既有调用点与用例保持不变。 */
  layout?: EngineLayout;
  /**
   * 子进程环境。
   *
   * 打包态**必须**带 `PYTHONPATH=<rt>/site`，否则 `import nanobot` 一定失败 ——
   * 那种失败会显示成"引擎没装好"，而真实原因只是自检没带上运行时的 import 路径。
   * dev 态留空，沿用进程环境。
   */
  env?: NodeJS.ProcessEnv;
}

/** 子进程超时。首次 `import nanobot` 要加载 pydantic 等一堆依赖，给足但不无限等。 */
export const SELF_CHECK_TIMEOUT_MS = 20_000;

/** 判定「命令真的跑通了」的哨兵：只看退出码会被「打印了报错但退出 0」的脚本骗过 */
const IMPORT_SENTINEL = 'nanowork-selfcheck-import-ok';
const CONFIG_SENTINEL = 'nanowork-selfcheck-config-ok';

/**
 * 解释器候选路径（**唯一真相**，`fallbackLaunchConfig()` 也用这一份）。
 *
 * ⚠️ dev 布局的目录深度是**两层 `nanobot`**，别拍平：`<appRoot>/nanobot/` 是引擎仓库，
 * 而 venv 建在**包目录的下一层** —— `<appRoot>/nanobot/nanobot/.venv/`（见
 * `docs/engine-dev-setup.md`）。少一层就会报出一个「根本没找过」的路径，
 * 而验收标准①要的恰恰是「文案含**实际**查找过的路径」。
 *
 * ⚠️ bundle 布局**没有**两层：`<resources>/rt/python/` 是便携解释器本体，
 * `<resources>/rt/site/` 是引擎与依赖。`repo` 字段在 bundle 下就是 rt 根（自检把它
 * 当作"引擎根"报给用户），`venv` 字段借位表示 site 目录 —— 调用方只关心"包在哪"。
 *
 * 返回顺序即优先级：先 venv 的 python（可以用 `-m nanobot`），再 venv 里的 console
 * script。调用方在两者都不存在时会退到 PATH 上的裸 `nanobot`。
 */
export function engineInterpreterCandidates(
  appRoot: string,
  platform: NodeJS.Platform,
  layout: EngineLayout = 'repo',
): { repo: string; venv: string; python: string; script: string } {
  const isWin = platform === 'win32';

  if (layout === 'bundle') {
    const python = isWin
      ? join(appRoot, 'python', 'python.exe')
      : join(appRoot, 'python', 'bin', 'python3');
    return {
      repo: appRoot,
      venv: join(appRoot, 'site'),
      python,
      // 便携解释器没有 console script：`-m nanobot` 是唯一入口，两者同路径。
      script: python,
    };
  }

  const repo = join(appRoot, 'nanobot');
  const venv = join(repo, 'nanobot', '.venv');
  return {
    repo,
    venv,
    python: isWin ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python'),
    script: isWin ? join(venv, 'Scripts', 'nanobot.exe') : join(venv, 'bin', 'nanobot'),
  };
}

/** 默认 IO：`existsSync` + 带超时的 `execFile` */
export const defaultSelfCheckIO: EngineSelfCheckIO = {
  exists: existsSync,
  run(bin, args, options) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          timeout: options.timeoutMs,
          cwd: options.cwd,
          // 打包态必须用构造好的环境（含 PYTHONPATH=<rt>/site），否则 import 必失败；
          // dev 态传 undefined，execFile 会自动沿用 process.env（保持原行为）。
          ...(options.env ? { env: options.env } : {}),
          windowsHide: true,
          // 报错原文可能很长；给足缓冲，否则 stderr 被截断后引导就失去了「真实报错」
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === 'number'
                ? ((error as { code?: number }).code as number)
                : 1;
          // 超时被杀的进程 stderr 为空，只留一句 `ETIMEDOUT`；补一句人话，
          // 否则用户看到的「失败」没有任何解释。
          const timedOut = (error as { killed?: boolean } | null)?.killed === true;
          resolve({
            code: timedOut ? 124 : code,
            stdout: String(stdout ?? ''),
            stderr:
              String(stderr ?? '') ||
              (timedOut ? `命令超过 ${options.timeoutMs} ms 未返回，已终止` : String(error ?? '')),
          });
        },
      );
    });
  },
};

/**
 * 命令与路径放进 shell 里要能直接用：含空格 / 引号时加引号。
 *
 * 导出给 `engineInstall.ts` 复用：一键执行的 recipe 与界面上「可复制命令」
 * 必须是同一个渲染函数，否则两处各写一份，含空格的路径迟早会在一边漏引号。
 */
export function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** 把子进程原始输出裁剪成可展示的证据（保留尾部：报错总在最后几行） */
function tail(text: string, limit = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `…（前文省略）\n${trimmed.slice(-limit)}`;
}

function docPathFor(engineRoot: string, io: EngineSelfCheckIO): string | null {
  const candidate = join(engineRoot, 'docs', 'engine-dev-setup.md');
  return io.exists(candidate) ? candidate : null;
}

function isAbsolutePathLike(bin: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(bin);
}

/**
 * ① 解释器可达。
 *
 * `bin` 是绝对路径 → 查存在性；是裸命令名（PATH 查找）→ **`skipped`**：
 * 「不知道」不该显示成红色，而且下一步（导入检查）会真正判定它能不能跑。
 */
export function checkInterpreter(
  target: EngineSelfCheckTarget,
  io: EngineSelfCheckIO,
): EngineSelfCheckFinding {
  const candidates = interpreterCandidateList(target, io);
  const base = {
    id: 'interpreter' as const,
    title: '引擎解释器',
    detail: `按优先级找过这些路径：\n${candidates.map((p) => `  - ${p}`).join('\n')}`,
    remedy: null as EngineSelfCheckRemedy | null,
  };

  if (!isAbsolutePathLike(target.bin)) {
    return {
      ...base,
      status: 'skipped',
      summary: `未固定解释器路径，将按 PATH 查找「${target.bin}」（无法预检，下一步会实际调用它）`,
    };
  }
  if (io.exists(target.bin)) {
    return { ...base, status: 'ok', summary: `解释器可用：${target.bin}` };
  }
  const layout = target.layout ?? 'repo';
  const venv = engineInterpreterCandidates(target.engineRoot, process.platform, layout);
  if (layout === 'bundle') {
    /*
     * 打包态的引导**绝不能**出现 `python -m venv` / `pip install -e`：
     * 安装包里没有引擎源码，让用户建 venv 只会把他引向一个必然失败的路径，
     * 而真正该做的是覆盖安装。这条分叉是 FR-13.6 在打包形态下的唯一正确文案。
     */
    return {
      ...base,
      status: 'failed',
      summary: `找不到随包的引擎运行时：${target.bin}`,
      remedy: {
        steps: [
          '本应用自带引擎运行时（resources/rt），不依赖本机安装的 Python —— 所以「装个 Python」修不好它。',
          '上面列出的路径都找过了，都没有：最常见的原因是安装目录被部分删除，或被安全软件隔离了文件。',
          '重新运行安装包做一次覆盖安装即可恢复；若仍失败，请导出诊断包并附上本页报告。',
        ],
        commands: [`${quote(target.bin)} --version`],
        docPath: docPathFor(target.engineRoot, io),
      },
    };
  }
  return {
    ...base,
    status: 'failed',
    summary: `找不到引擎解释器：${target.bin}`,
    remedy: {
      steps: [
        '本项目不打包 Python 运行时，引擎要用本机的一个虚拟环境（venv）。',
        '上面列出的路径都找过了，都没有 —— 最常见的原因是 nanobot 的 .venv 被重命名或移走。',
        '重建 venv（下面第一条命令），或把 venv 改回候选路径之一。',
        '也可以显式指定解释器：在应用数据目录的 nanowork.nanobot.json 里写 bin 字段。',
      ],
      commands: [
        `${quote(process.platform === 'win32' ? 'python' : 'python3')} -m venv ${quote(venv.venv)}`,
        `${quote(venv.python)} -m pip install -e ${quote(venv.repo)}`,
        `${quote(target.bin)} --version`,
      ],
      docPath: docPathFor(target.engineRoot, io),
    },
  };
}

function interpreterCandidateList(target: EngineSelfCheckTarget, io: EngineSelfCheckIO): string[] {
  const venv = engineInterpreterCandidates(
    target.engineRoot,
    process.platform,
    target.layout ?? 'repo',
  );
  const list = [target.bin, venv.python, venv.script];
  // 去重但保序：`bin` 常常就等于 venv.python，重复列出来会让「找过这些路径」看着
  // 像找了更多地方，反而掩盖了真实候选数
  const unique = [...new Set(list)];
  if (io.exists(target.bin) && !unique.includes(target.bin)) unique.unshift(target.bin);
  return unique;
}

/**
 * 子进程的工作目录。
 *
 * dev 态指到引擎仓库根：`import nanobot` 在未 `pip install -e` 时靠 cwd 生效（装过则是
 * site-packages 生效，两者都覆盖）。
 *
 * 打包态**不能**再用 `<rt>/nanobot` —— 那个目录不存在，`execFile` 会直接以
 * `ENOENT` 失败，而报错内容与"引擎没装好"完全无关，只会把排查带偏。
 */
function engineCwd(target: EngineSelfCheckTarget): string {
  return (target.layout ?? 'repo') === 'bundle'
    ? target.engineRoot
    : join(target.engineRoot, 'nanobot');
}

/** ② 引擎包可导入：`python -c "import nanobot"` */
export async function checkEngineImport(
  target: EngineSelfCheckTarget,
  io: EngineSelfCheckIO,
  interpreterOk: boolean,
): Promise<EngineSelfCheckFinding> {
  const base = { id: 'engine-import' as const, title: '引擎包导入', remedy: null };
  if (!interpreterOk) {
    // 解释器都没有，跑不出有意义的结论 —— 报两条红只会把用户的注意力引偏
    return {
      ...base,
      status: 'skipped',
      summary: '解释器不可达，跳过（先解决上一项）',
      detail: null,
    };
  }
  // cwd 见 `engineCwd`：dev 指引擎仓库根，bundle 指 rt（`<rt>/nanobot` 不存在）
  const engineRepo = engineCwd(target);
  const result = await io.run(
    target.bin,
    ['-c', `import nanobot; print('${IMPORT_SENTINEL}')`],
    { timeoutMs: SELF_CHECK_TIMEOUT_MS, cwd: engineRepo, env: target.env },
  );
  if (result.code === 0 && result.stdout.includes(IMPORT_SENTINEL)) {
    return {
      ...base,
      status: 'ok',
      summary: '引擎包可导入',
      detail: null,
    };
  }
  return {
    ...base,
    status: 'failed',
    summary: '解释器能跑，但导入 nanobot 失败',
    detail: tail([result.stderr, result.stdout].filter(Boolean).join('\n')) || null,
    remedy: {
      steps: [
        '解释器本身是可用的（上一项通过），失败发生在导入阶段。',
        '常见原因：依赖没装齐，或者装到了**另一个**解释器里（比如系统 Python 而不是这个 venv）。',
        '下面第一条命令就是往当前解释器里装引擎（可编辑安装）。',
      ],
      commands: [
        `${quote(target.bin)} -m pip install -e ${quote(join(target.engineRoot, 'nanobot'))}`,
        `${quote(target.bin)} -c "import nanobot, sys; print(nanobot.__file__); print(sys.executable)"`,
      ],
      docPath: docPathFor(target.engineRoot, io),
    },
  };
}

/** ③ 配置可加载：交给**引擎自己的** loader 校验，不在这里重写一套 schema 判断 */
export async function checkConfig(
  target: EngineSelfCheckTarget,
  io: EngineSelfCheckIO,
  interpreterOk: boolean,
): Promise<EngineSelfCheckFinding> {
  const base = { id: 'config' as const, title: '配置文件校验', remedy: null };
  const engineRepo = engineCwd(target);
  const loadCommand = [
    'import sys',
    'from pathlib import Path',
    'from nanobot.config.loader import load_config',
    'load_config(Path(sys.argv[1]))',
    `print('${CONFIG_SENTINEL}')`,
  ].join('; ');

  if (!interpreterOk) {
    return {
      ...base,
      status: 'skipped',
      summary: '解释器不可达，跳过（先解决第一项）',
      detail: null,
    };
  }
  if (!io.exists(target.config)) {
    // 缺文件**不是**错误：引擎首次启动会生成默认配置。报红会让新装用户以为坏了。
    return {
      ...base,
      status: 'skipped',
      summary: '配置文件还不存在，引擎首次启动时会生成默认配置',
      detail: `期望路径：${target.config}`,
    };
  }
  const result = await io.run(target.bin, ['-c', loadCommand, target.config], {
    timeoutMs: SELF_CHECK_TIMEOUT_MS,
    cwd: engineRepo,
    env: target.env,
  });
  if (result.code === 0 && result.stdout.includes(CONFIG_SENTINEL)) {
    return {
      ...base,
      status: 'ok',
      summary: '配置文件通过引擎 schema 校验',
      detail: null,
    };
  }
  return {
    ...base,
    status: 'failed',
    summary: '配置文件未通过引擎 schema 校验',
    detail: tail([result.stderr, result.stdout].filter(Boolean).join('\n')) || null,
    remedy: {
      steps: [
        '引擎能跑、包也能导入，问题只在这份配置文件的内容上。',
        '下面的原始报错里通常直接指出是哪个字段（pydantic 会给出字段路径）。',
        '拿不准就先把它改名备份，让引擎重新生成一份默认配置，再逐项搬回你的改动。',
      ],
      commands: [
        `${quote(target.bin)} -c "${loadCommand.replace(/"/g, '\\"')}" ${quote(target.config)}`,
        `Rename-Item ${quote(target.config)} ${quote(`${target.config}.bak`)}`,
      ],
      docPath: docPathFor(target.engineRoot, io),
    },
  };
}

/** 跑完三项，汇总成报告 */
export async function runEngineSelfCheck(
  target: EngineSelfCheckTarget,
  io: EngineSelfCheckIO = defaultSelfCheckIO,
): Promise<EngineSelfCheckReport> {
  const interpreter = checkInterpreter(target, io);
  const engineImport = await checkEngineImport(target, io, interpreter.status === 'ok');
  const config = await checkConfig(target, io, interpreter.status === 'ok');
  const findings = [interpreter, engineImport, config];
  return {
    checkedAt: new Date().toISOString(),
    ok: findings.every((finding) => finding.status !== 'failed'),
    findings,
    target: {
      bin: target.bin,
      config: target.config,
      engineRoot: target.engineRoot,
      candidates: interpreterCandidateList(target, io),
    },
  };
}

/** 供 UI 索引文案：三项的固定顺序（界面按它渲染，避免每次自检顺序不同） */
export const SELF_CHECK_ORDER: readonly EngineSelfCheckId[] = [
  'interpreter',
  'engine-import',
  'config',
] as const;
