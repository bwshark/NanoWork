/**
 * 一键打安装包（Windows Setup.exe / macOS dmg / Linux AppImage+deb）。
 *
 * ## 为什么要包一层，而不是直接用 electron-builder
 *
 * 这条链路上有四个**只在真机才暴露**的坑，每一个都会让 `electron-builder` 直接退出，
 * 而错误信息既不点名原因、也不给下一步动作：
 *
 * 1. `winCodeSign` 解压要建符号链接 → 普通用户没有 `SeCreateSymbolicLinkPrivilege`
 *    （实测 `ln -s` 直接 `Operation not permitted`）。electron-builder 会不断换目录重试，
 *    最终只留下一句 `Cannot create symbolic link`。
 * 2. `7za a -mx=9` 在内存紧张的机器上返回**退出码 8**（7-Zip 的 "Not enough memory"），
 *    而 `-mx` 默认就是 9，错误里只有命令原文。
 * 3. 非一键 NSIS 安装器要在构建期**运行一次中间 exe** 来生成卸载器。那个 exe 只有 213 KB、
 *    名字却和最终安装包一模一样 —— 它写临时文件失败时只报 `Exit code: 2`，
 *    很容易被当成"安装包坏了"（双击它只会弹 "Error writing temporary file"）。
 * 4. 失败之后产物目录里仍会留着上面那个同名的 213 KB 文件，下次双击继续报同一个错。
 *
 * 所以这个脚本做三件事：**预检**（别等到第 6 分钟才失败）、**按错误特征自动换招重试**、
 * **产出一句话可验证的结论**（大小 + 内含条目数），而不是"退出码 0 就当成功"。
 *
 * ## 用法
 *
 *   node scripts/build-installer.mjs                     # Windows Setup.exe → release/
 *   node scripts/build-installer.mjs --out D:/dist        # 指定输出目录
 *   node scripts/build-installer.mjs --platform mac       # dmg + zip（须在 macOS 上跑）
 *   node scripts/build-installer.mjs --strict             # 禁止"降低产物质量"的降级（发版用）
 *   node scripts/build-installer.mjs --check              # 先跑三套 tsc 再打包
 *   node scripts/build-installer.mjs --skip-frontend      # 跳过 vite/esbuild，复用现有产物
 *   node scripts/build-installer.mjs --skip-engine-check  # 明知 build/rt 缺失仍然打包
 *
 * ## 自动补救（前两条 `--strict` 下仍生效，因为不改变产物质量）
 *
 * | 触发特征 | 处理 | 代价 |
 * |---|---|---|
 * | 预检：建不了符号链接 | 一开始就加 `--config.win.signAndEditExecutable=false` | exe 无图标与版本号 |
 * | `Cannot create symbolic link` | 同上（预检没拦住时的兜底） | exe 无图标与版本号 |
 * | `Command failed: <输出目录>/*.exe`（`Exit code: 2` 或 `null`） | 输出目录改到**盘根**下重试，并清掉那个 213 KB 的假安装包 | 换个位置取产物 |
 * | `Exit code: 8` | `-mx` 9 → 5 → 3（走 `ELECTRON_BUILDER_COMPRESSION_LEVEL`） | 安装包略大 |
 * | `cannot allocate memory` / `unpack-electron` | **不重试**，直接报"打包机内存不足" | — |
 *
 * 只有**前两条**和**压缩等级**会进"降级"清单（它们改变产物）；换输出目录只提示，不算降级。
 * `--strict` 会拦住后两条里的质量降级，但**不会**拦住"换输出目录"——那是环境适配。
 *
 * @see docs/plan-packaging-and-release.md §4.8
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RT_DIR = join(REPO_ROOT, 'build', 'rt');
const ICON_ICO = join(REPO_ROOT, 'electron', 'assets', 'icon.ico');
const BUILDER_CONFIG = join(REPO_ROOT, 'electron', 'builder.config.json');

/** 小于这个体积的"安装包"一定是构建中间产物（实测那个中间产物固定 213743 字节） */
const MIN_ARTIFACT_BYTES = 32 * 1024 * 1024;

/* ─────────────────────────── 日志 ─────────────────────────── */

const degraded = [];

function log(step, message) {
  console.log(`[build-installer] ${step} ${message}`);
}

function warn(message) {
  console.warn(`[build-installer] 警告 ${message}`);
}

function degrade(reason, action, cost) {
  degraded.push({ reason, action, cost });
  console.warn(`[build-installer] 降级 ${reason} → ${action}（代价：${cost}）`);
}

function fail(message, hint) {
  console.error(`\n[build-installer] 失败：${message}`);
  if (hint) console.error(`[build-installer] 处理：${hint}`);
  process.exit(1);
}

/* ─────────────────────────── 参数 ─────────────────────────── */

function parseArgs(argv) {
  const options = {
    // Windows 默认**不写进项目的 `release/`**。
    //
    // 本机实测（2026-10-31，两次复现）：放在工作区路径下的 exe，在构建期被运行时起不来
    // ——那一步是 NSIS 要跑一次自己的中间产物来生成卸载器，结果只报 `Exit code: 2/null`，
    // 白跑约 5 分钟才失败。产物放盘根既避开这个限制，也不会被 `--emptyOutDir` 之类误删。
    // 想放回 release/ 就显式给 `--out release`（脚本会自动迁移并提示）。
    out:
      process.platform === 'win32'
        ? join(parse(REPO_ROOT).root, 'nanowork-release')
        : join(REPO_ROOT, 'release'),
    platform: process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux',
    // 5 而不是默认的 9：-mx=9 在 32 GB 机器上实测返回退出码 8（内存不足），
    // 而 -mx=5 只慢一点、体积只差几 MB，对安装包完全够用。
    compression: 5,
    strict: false,
    check: false,
    skipFrontend: false,
    skipEngineCheck: false,
    publish: 'never',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) fail(`${arg} 缺少取值`);
      i += 1;
      return value;
    };
    if (arg === '--out') options.out = resolve(next());
    else if (arg === '--platform') options.platform = next();
    else if (arg === '--compression') options.compression = Number(next());
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--skip-frontend') options.skipFrontend = true;
    else if (arg === '--skip-engine-check') options.skipEngineCheck = true;
    else if (arg === '--publish') options.publish = next();
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/build-installer.mjs [选项]');
      console.log('  --out <dir>            输出目录（Windows 默认 <盘符>:\\nanowork-release）');
      console.log('  --platform <p>         win | mac | linux（默认当前平台）');
      console.log('  --compression <1-9>    7z 压缩等级（默认 5）');
      console.log('  --strict               禁止"降低产物质量"的降级（换输出目录等环境适配仍会做）');
      console.log('  --check                打包前跑 typecheck 与 typecheck:electron');
      console.log('  --skip-frontend        跳过 vite/esbuild');
      console.log('  --skip-engine-check    不检查 build/rt');
      process.exit(0);
    } else fail(`未知参数：${arg}`, '用 --help 看可用参数');
  }
  if (!['win', 'mac', 'linux'].includes(options.platform)) {
    fail(`--platform 只支持 win / mac / linux，收到 ${options.platform}`);
  }
  if (!Number.isFinite(options.compression) || options.compression < 1 || options.compression > 9) {
    fail('--compression 必须是 1–9 的整数');
  }
  return options;
}

/* ─────────────────────────── 执行 ─────────────────────────── */

/**
 * 跑一条命令并**同时**收集输出。
 *
 * 不用 `stdio: 'inherit'` 是因为失败后要按特征匹配错误（符号链接 / 退出码 8 / 中间 exe），
 * 靠人眼看日志再手改参数，正是"一键"要消灭的步骤。
 */
function run(command, commandArgs, options = {}) {
  if (options.echo !== false) log('run', `${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (options.echo !== false && output.trim()) process.stdout.write(output);
  if (result.error) return { ok: false, status: -1, output: `${output}\n${result.error.message}` };
  return { ok: result.status === 0, status: result.status ?? -1, output };
}

function requireModule(relative) {
  const full = join(REPO_ROOT, 'node_modules', relative);
  if (!existsSync(full)) fail(`缺少 node_modules/${relative}`, '先执行 npm install');
  return full;
}

/* ─────────────────────────── 预检 ─────────────────────────── */

/**
 * 读 ICO 里最大的一张图的宽高。
 *
 * ⚠️ 判据是**至少有一张 ≥256×256**，不是"所有尺寸都 ≥256"——一个正常的多尺寸 ico 里
 * 必然带 16/32/48 这些小图。取最小值会把合格图标误判为不合格（本脚本第一版就错在这里，
 * 真跑时才暴露）。
 *
 * 另外必须分开看宽高：我们的图源曾是 1024×931，导出的 ico 最大一张是 256×233，
 * 宽度够、高度不够，而 electron-builder 只报一句 `must be at least 256x256`。
 */
function icoMaxSize(path) {
  const fd = openSync(path, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(6 + 16 * 32);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    buffer = buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  if (buffer.length < 6 || buffer.readUInt16LE(2) !== 1) return { width: 0, height: 0 };
  const count = buffer.readUInt16LE(4);
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    if (offset + 2 > buffer.length) break;
    // ICO 的宽/高字段只有一个字节，0 表示 256
    width = Math.max(width, buffer.readUInt8(offset) || 256);
    height = Math.max(height, buffer.readUInt8(offset + 1) || 256);
  }
  return { width, height };
}

/**
 * 本机能不能创建符号链接。
 *
 * 这个探测值得单独写：`winCodeSign` 的失败**要等约 9 分钟**才浮现（electron-builder 会
 * 在不同目录里反复重试解压），而这 9 分钟在动手之前 10 毫秒就能测出来。
 * 判定依据与 electron-builder 一致：Windows 建符号链接需要
 * `SeCreateSymbolicLinkPrivilege`（管理员或开发者模式），否则 EPERM。
 */
function canCreateSymlink() {
  const dir = mkdtempSync(join(tmpdir(), 'nw-symlink-probe-'));
  try {
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'x');
    symlinkSync(target, join(dir, 'b.txt'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function preflight(options) {
  if (!existsSync(BUILDER_CONFIG)) fail(`找不到 ${BUILDER_CONFIG}`);

  // 引擎运行时缺失时打出来的包能装、但对话一定失败 —— 这种"能装不能跑"的包
  // 比打包失败更糟（要走完整装机流程才发现）。所以默认拦住。
  if (!options.skipEngineCheck && !existsSync(join(RT_DIR, 'manifest.json'))) {
    fail(
      `引擎运行时不存在：${join(RT_DIR, 'manifest.json')}`,
      '先跑 npm run build:engine（首次约 10 分钟），或加 --skip-engine-check 明知故犯',
    );
  }

  let skipExeEdit = false;
  if (options.platform === 'win') {
    if (!existsSync(ICON_ICO)) fail(`找不到图标 ${ICON_ICO}`);
    const { width, height } = icoMaxSize(ICON_ICO);
    if (width < 256 || height < 256) {
      fail(
        `icon.ico 最大一张只有 ${width}×${height}，electron-builder 要求最大一张 ≥256×256`,
        '用正方形原图重新生成：先透明补边成正方形，再导出 16/24/32/48/64/128/256 多尺寸 ico',
      );
    }
    log('preflight', `icon.ico 最大 ${width}×${height} ✓`);

    if (!canCreateSymlink()) {
      const hint = '设置 → 系统 → 开发者选项 → 打开「开发人员模式」，之后重跑即可恢复图标与版本号';
      if (options.strict) {
        fail(`本机无法创建符号链接，winCodeSign 解压必失败；--strict 下不降级`, hint);
      }
      degrade('本机无法创建符号链接（未开开发者模式，非管理员）', '直接关闭 exe 资源改写', '无图标与版本号，不能发版');
      skipExeEdit = true;
      warn(`想彻底解决：${hint}`);
    } else {
      log('preflight', '符号链接可用 ✓');
    }
  }

  if (!options.skipFrontend) {
    requireModule('vite/bin/vite.js');
    requireModule('esbuild/bin/esbuild');
    requireModule('electron-builder/cli.js');
  }
  if (options.check) requireModule('typescript/bin/tsc');
  log('preflight', `输出目录 ${options.out}`);
  return { skipExeEdit };
}

/* ─────────────────────────── 构建 ─────────────────────────── */

function buildFrontend() {
  run(process.execPath, [requireModule('vite/bin/vite.js'), 'build', '--emptyOutDir', 'false']);
  for (const entry of ['main', 'preload']) {
    run(process.execPath, [
      requireModule('esbuild/bin/esbuild'),
      join(REPO_ROOT, 'electron', `${entry}.ts`),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--external:electron',
      `--outfile=${join(REPO_ROOT, 'electron', `${entry}.cjs`)}`,
      '--log-level=warning',
    ]);
  }
  log('frontend', '渲染层与主进程产物已重建');
}

function typecheck() {
  const tsc = requireModule('typescript/bin/tsc');
  const runs = [
    ['typecheck', [tsc, '--noEmit']],
    ['typecheck:electron', [tsc, '--noEmit', '-p', 'tsconfig.node.json']],
  ];
  for (const [name, args] of runs) {
    if (!run(process.execPath, args).ok) fail(`${name} 未通过`, '先修类型错误再打包');
    log('check', `${name} ✓`);
  }
}

/** electron-builder 参数：输出目录与"是否改写 exe 资源"都在这里决定 */
function builderArgs(options, variant) {
  const args = [
    requireModule('electron-builder/cli.js'),
    '--config',
    BUILDER_CONFIG,
    `--${options.platform}`,
    '--publish',
    options.publish,
    `--config.directories.output=${variant.out}`,
  ];
  // 没有代码签名证书时，改写 exe 资源（图标/版本号）会强制下载 winCodeSign，
  // 而它解压要建符号链接 —— 无特权机器上必失败。见文件头的坑 1。
  if (options.platform === 'win' && variant.skipExeEdit) {
    args.push('--config.win.signAndEditExecutable=false');
  }
  return args;
}

function attemptBuild(options, variant) {
  log(
    'builder',
    `输出=${variant.out} compression=${variant.compression}${variant.skipExeEdit ? ' 改写exe资源=关' : ''}`,
  );
  return run(process.execPath, builderArgs(options, variant), {
    env: { ELECTRON_BUILDER_COMPRESSION_LEVEL: String(variant.compression) },
  });
}

/** 按失败特征决定下一步；返回新的 variant，null 表示没有可用的补救 */
function nextVariant(options, current, output) {
  const has = (pattern) => pattern.test(output);

  // 坑 3（放在 --strict 判定**之前**）：构建期要运行一次中间 exe，而受限目录里它起不来。
  //
  // ① 这条不受 `--strict` 约束：换输出目录**不改变产物质量**（图标、版本号、压缩率都不动），
  //    它属于环境适配，不属于降级。把 strict 理解成"什么都不许改"就正好卡死在这里
  //    （2026-10-31 实测：strict 一次都没重试，直接失败）。
  // ② 判据不能只认 `Exit code: 2`：同一件事在别的机器/别的杀软下表现为
  //    `Exit code: null`（进程被终止）。所以按"命令行里跑的是不是输出目录里的那个 exe"来判。
  const failedExe = /Command failed:\s*"?([^"\n]+\.(?:exe|AppImage|dmg))"?/i.exec(output);
  if (!current.movedOut && failedExe && failedExe[1].toLowerCase().startsWith(current.out.toLowerCase())) {
    const out = join(parse(REPO_ROOT).root, 'nanowork-release');
    warn(`构建期需要运行 ${failedExe[1]}，但它在该目录下起不来（受限环境）→ 输出改到 ${out} 重试`);
    removeStaleArtifacts(current.out);
    return { ...current, out, movedOut: true };
  }

  if (options.strict) return null;

  // 坑 1：符号链接特权
  if (!current.skipExeEdit && (has(/Cannot create symbolic link/i) || has(/winCodeSign/i))) {
    degrade(
      'winCodeSign 无法创建符号链接（需要管理员或开发者模式）',
      '关闭 exe 资源改写',
      '无图标与版本号，不能发版',
    );
    return { ...current, skipExeEdit: true };
  }
  // 坑 2：7-Zip 退出码 8 = 内存不足
  if (has(/Exit code: 8\b/) && current.compression > 3) {
    const next = current.compression > 5 ? 5 : 3;
    degrade(`7za -mx=${current.compression} 内存不足（退出码 8）`, `压缩等级降到 ${next}`, '安装包略大');
    return { ...current, compression: next };
  }
  // 坑 2 的同源：app-builder 解 electron 时也报内存，换参数救不了
  if (has(/cannot allocate memory/i) || has(/unpack-electron/i)) {
    warn('打包机内存不足（app-builder 解 electron 失败）。关掉占内存的程序后重跑，本脚本不自动重试');
    return null;
  }
  return null;
}

/**
 * 清掉"长得像安装包但其实是构建中间产物"的文件。
 *
 * 不清的话，构建失败后用户会双击它，得到的是 "Error writing temporary file"，
 * 于是排查方向被引到"安装包坏了"——这就是我们实际走过的弯路。
 */
function removeStaleArtifacts(outDir) {
  if (!existsSync(outDir)) return;
  const uninstaller = join(outDir, '__uninstaller-nsis-nanowork.exe');
  if (existsSync(uninstaller)) rmSync(uninstaller, { force: true });
  for (const name of readdirSync(outDir)) {
    if (!/\.(exe|AppImage|dmg)$/i.test(name)) continue;
    const path = join(outDir, name);
    if (statSync(path).size < MIN_ARTIFACT_BYTES) {
      rmSync(path, { force: true });
      log('cleanup', `已删除同名的中间产物 ${name}（双击它只会报临时文件错误）`);
    }
  }
}

/* ─────────────────────────── 产物校验 ─────────────────────────── */

/**
 * 找构建产物。
 *
 * 不复刻 `artifactName` 模板：模板里有 `${version}` `${os}` `${arch}`，复刻一遍就等于
 * 把同一规则写了两份，配置一改这里就静默失配。改成"按扩展名找最大的那个文件"。
 */
function findArtifact(options, outDir) {
  const ext = { win: /\.exe$/i, mac: /\.dmg$/i, linux: /\.AppImage$/i }[options.platform];
  if (!existsSync(outDir)) fail(`输出目录不存在：${outDir}`);
  const candidates = readdirSync(outDir)
    .filter((name) => ext.test(name))
    .map((name) => ({ path: join(outDir, name), size: statSync(join(outDir, name)).size }))
    .sort((a, b) => b.size - a.size);
  if (candidates.length === 0) fail(`输出目录里没有安装包：${outDir}`, '检查 electron-builder 是否真的产出了 target');
  return candidates[0];
}

function verifyArtifact(options, outDir) {
  const artifact = findArtifact(options, outDir);
  if (artifact.size < MIN_ARTIFACT_BYTES) {
    fail(
      `产物只有 ${artifact.size} 字节，不是安装包`,
      '这是 NSIS 的卸载器生成器（中间产物）。删掉它重跑，并确认 electron-builder 退出码为 0',
    );
  }

  // 能列出条目才算真的把 app 打进去了 —— 只看文件体积会被"截断的包"骗过。
  // electron-builder 把 app 压成一段 7z 流附加在 NSIS 头部之后，7za 能直接读出来。
  const sevenZip = join(
    REPO_ROOT,
    'node_modules',
    '7zip-bin',
    process.platform === 'win32' ? 'win/x64/7za.exe' : process.platform === 'darwin' ? 'mac/7za' : 'linux/x64/7za',
  );
  if (options.platform === 'win' && existsSync(sevenZip)) {
    const listed = run(sevenZip, ['l', artifact.path], { echo: false });
    const match = /(\d+)\s+files?,\s+(\d+)\s+folders?/.exec(listed.output);
    if (!match) fail('7za 无法解析产物，安装包可能被截断', '删掉产物重跑');
    log('verify', `内含 ${match[1]} 个文件 / ${match[2]} 个目录 ✓`);
  }
  log('verify', `产物 ${artifact.path}（${(artifact.size / 1048576).toFixed(0)} MiB）✓`);
  return artifact;
}

/**
 * 产物不在项目里时，在 `release/` 留一张指路牌。
 *
 * 产物默认落在盘根是基于环境限制的妥协（见 `parseArgs` 的注释），但人的习惯是去
 * `release/` 找 —— 找不到就会以为"没打出来"，这正是前面几轮误会的来源之一。
 */
function writeArtifactPointer(artifact, options) {
  const pointerDir = join(REPO_ROOT, 'release');
  const inProject = artifact.path.toLowerCase().startsWith(pointerDir.toLowerCase());
  if (inProject) return;
  try {
    mkdirSync(pointerDir, { recursive: true });
    const lines = [
      `最近一次构建：${new Date().toISOString()}`,
      `产物：${artifact.path}`,
      `大小：${artifact.size} 字节（${(artifact.size / 1048576).toFixed(0)} MiB）`,
      '',
      `为什么不在本目录：本机在构建期无法运行放在项目路径下的 exe（NSIS 要跑一次`,
      `自己的中间产物来生成卸载器），所以输出目录改到了盘根。`,
      `想放回本目录：node scripts/build-installer.mjs --out "${pointerDir}"（会自动迁移并提示）。`,
      '',
      `本次参数：platform=${options.platform} compression=${options.compression} strict=${options.strict}`,
    ];
    writeFileSync(join(pointerDir, 'ARTIFACT.txt'), `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 指路牌是锦上添花，写不了也不该让构建失败
  }
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

log('start', `平台=${options.platform} 压缩=${options.compression} 严格模式=${options.strict}`);
const preflightResult = preflight(options);
if (options.check) typecheck();
if (!options.skipFrontend) buildFrontend();

let variant = {
  out: options.out,
  compression: options.compression,
  // 预检已经知道建不了符号链接时直接跳过第一次尝试：那一趟要白等约 9 分钟
  skipExeEdit: preflightResult.skipExeEdit,
  movedOut: false,
};
let result = attemptBuild(options, variant);
let attempts = 1;
while (!result.ok && attempts < 4) {
  const next = nextVariant(options, variant, result.output);
  if (!next) break;
  variant = next;
  attempts += 1;
  log('retry', `第 ${attempts} 次尝试`);
  result = attemptBuild(options, variant);
}
if (!result.ok) {
  const tail = result.output.trim().split('\n').slice(-12).join('\n');
  fail(`electron-builder 退出码 ${result.status}，自动重试已用尽`, `最后 12 行输出：\n${tail}`);
}

const artifact = verifyArtifact(options, variant.out);
writeArtifactPointer(artifact, options);
const seconds = Math.round((Date.now() - startedAt) / 1000);

console.log('');
log('done', `耗时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒，尝试 ${attempts} 次`);
console.log(`[build-installer] 产物：${artifact.path}`);
console.log(`[build-installer] 大小：${artifact.size} 字节（${(artifact.size / 1048576).toFixed(0)} MiB）`);

if (degraded.length > 0) {
  console.log('');
  console.warn('[build-installer] 本次构建发生了降级，产物不能直接发版：');
  for (const item of degraded) {
    console.warn(`  · ${item.reason} → ${item.action}（${item.cost}）`);
  }
  console.warn('[build-installer] 想消除降级：Windows 上开启开发者模式后重跑，或用 --strict 让它直接失败。');
}
