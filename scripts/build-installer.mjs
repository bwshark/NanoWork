/**
 * 一键打安装包（Windows Setup.exe / macOS dmg+zip / Linux AppImage+deb）。
 *
 * ## 为什么要包一层，而不是直接用 electron-builder
 *
 * 这条链路上有一堆**只在真机才暴露**的坑，每一个都会让 `electron-builder` 直接退出，
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
 * 5. **（mac）架构与引擎运行时必须成对**：`build/rt` 里的便携 Python 是**单架构**的
 *    （PBS 按 triple 分发）。配置里若给 dmg 写了 `arch: [arm64, x64]`，在 arm64 机器上
 *    electron-builder 会**成功**产出两份包，其中 x64 那份里的 python 根本跑不起来 ——
 *    错误发生在用户的机器上，而不是构建日志里。所以本脚本按"一个架构一次构建"，
 *    并在预检阶段核对 `manifest.json` 的 `pbsAsset` 与目标架构。
 * 6. **（mac）未签名 ≠ 能装**：`identity` 缺省时 electron-builder 只警告一句就产出 dmg，
 *    而 macOS 15 起 arm64 包连门都进不去。降级必须显式记账（`--strict` 下直接失败），
 *    并告诉用户 `xattr -dr com.apple.quarantine` 这条临时通道。
 * 7. **（linux）deb/AppImage 的构建工具链是下载来的**（`fpm` / `appimage`），
 *    在受限网络里表现为 `Cannot download ... failed`，换镜像即可，不必改产物。
 * 8. **（linux）`rt` 必须带可执行位**：从 Windows 拷过来的解压树会丢 `+x`，
 *    打出来的包能装能启动，但引擎 exec 时 EACCES —— 这个必须在打包前用 stat 判掉。
 *
 * 所以这个脚本做四件事：**预检**（别等到第 6 分钟才失败）、**按错误特征自动换招重试**、
 * **按平台原生方式校验产物里确实有引擎运行时**、**产出一句话可验证的结论**，
 * 而不是"退出码 0 就当成功"。
 *
 * ## 用法
 *
 *   node scripts/build-installer.mjs                     # 当前平台 + 当前架构
 *   node scripts/build-installer.mjs --out D:/dist        # 指定输出目录
 *   node scripts/build-installer.mjs --platform mac --arch arm64   # 须在 macOS 上跑
 *   node scripts/build-installer.mjs --platform linux --arch x64   # 须在 Linux 上跑
 *   node scripts/build-installer.mjs --strict             # 禁止"降低产物质量"的降级（发版用）
 *   node scripts/build-installer.mjs --check              # 先跑 tsc 再打包
 *   node scripts/build-installer.mjs --skip-frontend      # 跳过 vite/esbuild，复用现有产物
 *   node scripts/build-installer.mjs --skip-engine-check  # 明知 build/rt 缺失仍然打包
 *
 * ### 为什么 mac 不提供 `--arch both`
 *
 * 一次构建只能带一份 `build/rt`，而它按架构分发（arm64 的 python 不能在 x64 上跑）。
 * 想同时出两个架构，就在两台 runner 上各跑一次（见 `.github/workflows/release.yml`
 * 的 macos-14 / macos-13 两个 job），**不要**在这里伪造"一次出双架构"。
 *
 * ## 自动补救（`--strict` 下只保留"不改变产物质量"的两条）
 *
 * | 平台 | 触发特征 | 处理 | 代价 |
 * |---|---|---|---|
 * | win | 预检：建不了符号链接 | 一开始就加 `--config.win.signAndEditExecutable=false` | exe 无图标与版本号 |
 * | win | `Cannot create symbolic link` | 同上（预检没拦住时的兜底） | exe 无图标与版本号 |
 * | win | `Command failed: <输出目录>/*.exe`（`Exit code: 2` 或 `null`） | 输出目录改到**盘根**下重试，并清掉那个 213 KB 的假安装包 | 换个位置取产物 |
 * | 全平台 | `Exit code: 8` | `-mx` 9 → 5 → 3（走 `ELECTRON_BUILDER_COMPRESSION_LEVEL`） | 安装包略大 |
 * | linux | 下载 `fpm` / `appimage` 失败（网络受限） | 换 `ELECTRON_BUILDER_BINARIES_MIRROR` 重试 | 无（只是换下载源） |
 * | mac | `Resource busy` / 上一轮 dmg 挂载点残留 | `hdiutil detach` 后重试 | 无 |
 * | mac | 无 Developer ID 证书 | 关闭签名 + 关闭 hardenedRuntime | **不能分发**，需 `xattr -dr` 才能打开 |
 * | 全平台 | `cannot allocate memory` / `unpack-electron` | **不重试**，直接报"打包机内存不足" | — |
 *
 * 只有**产物质量**相关的项会进"降级"清单；换输出目录、换下载镜像只提示，不算降级。
 *
 * @see docs/plan-packaging-and-release.md §7 / §8
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORM_META, normalizeArch, parseRuntimeAsset } from './lib/installerPlan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RT_DIR = join(REPO_ROOT, 'build', 'rt');
const ICON_ICO = join(REPO_ROOT, 'electron', 'assets', 'icon.ico');
const ICON_PNG = join(REPO_ROOT, 'electron', 'assets', 'icon.png');
const ICON_ICNS = join(REPO_ROOT, 'electron', 'assets', 'icon.icns');
const ENTITLEMENTS = join(REPO_ROOT, 'electron', 'assets', 'entitlements.mac.plist');
const BUILDER_CONFIG = join(REPO_ROOT, 'electron', 'builder.config.json');
const ENGINE_BUILDER = join(REPO_ROOT, 'scripts', 'build-engine.mjs');

/** 小于这个体积的"安装包"一定是构建中间产物（实测那个中间产物固定 213743 字节） */
const MIN_ARTIFACT_BYTES = 32 * 1024 * 1024;

/** 国内网络下 electron-builder 的 fpm/appimage 工具链拉不动时换这个源（只换下载源，不改产物） */
const BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

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

function hostPlatform() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'linux') return 'linux';
  return null;
}

function defaultOut(platform) {
  // Windows 默认**不写进项目的 `release/`**。
  //
  // 本机实测（2026-10-31，两次复现）：放在工作区路径下的 exe，在构建期被运行时起不来
  // ——那一步是 NSIS 要跑一次自己的中间产物来生成卸载器，结果只报 `Exit code: 2/null`，
  // 白跑约 5 分钟才失败。产物放盘根既避开这个限制，也不会被 `--emptyOutDir` 之类误删。
  // 想放回 release/ 就显式给 `--out release`（脚本会自动迁移并提示）。
  //
  // macOS / Linux 没有这个限制（dmg 用 hdiutil、AppImage 用 mksquashfs，都不需要
  // 运行产物里的可执行文件），所以仍然落在项目内的 `release/`。
  return platform === 'win'
    ? join(parse(REPO_ROOT).root, 'nanowork-release')
    : join(REPO_ROOT, 'release');
}

function parseArgs(argv) {
  const platform = hostPlatform() ?? fail(`不支持的宿主平台：${process.platform}`);
  const options = {
    out: null,
    platform,
    arch: normalizeArch(process.arch) ?? 'x64',
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
    else if (arg === '--arch') {
      const arch = normalizeArch(next());
      if (!arch) fail(`--arch 只支持 x64 / arm64，收到 ${argv[i]}`);
      options.arch = arch;
    } else if (arg === '--compression') options.compression = Number(next());
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--skip-frontend') options.skipFrontend = true;
    else if (arg === '--skip-engine-check') options.skipEngineCheck = true;
    else if (arg === '--publish') options.publish = next();
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/build-installer.mjs [选项]');
      console.log('  --out <dir>            输出目录（Windows 默认 <盘符>:\\nanowork-release，其余平台默认 release/）');
      console.log('  --platform <p>         win | mac | linux（默认当前平台）');
      console.log('  --arch <a>             x64 | arm64（默认当前架构；换架构要先重建 build/rt）');
      console.log('  --compression <1-9>    7z 压缩等级（默认 5）');
      console.log('  --strict               禁止"降低产物质量"的降级（换输出目录等环境适配仍会做）');
      console.log('  --check                打包前跑 typecheck 与 typecheck:electron');
      console.log('  --skip-frontend        跳过 vite/esbuild');
      console.log('  --skip-engine-check    完全不检查 build/rt（明知缺失仍然打包，产物可能不含引擎）');
      process.exit(0);
    } else fail(`未知参数：${arg}`, '用 --help 看可用参数');
  }
  if (!PLATFORM_META[options.platform]) {
    fail(`--platform 只支持 win / mac / linux，收到 ${options.platform}`);
  }
  if (!Number.isFinite(options.compression) || options.compression < 1 || options.compression > 9) {
    fail('--compression 必须是 1–9 的整数');
  }
  options.out ??= defaultOut(options.platform);
  return options;
}

/* ─────────────────────────── 执行 ─────────────────────────── */

/**
 * 跑一条命令并**同时**收集输出。
 *
 * 不用 `stdio: 'inherit'` 是因为失败后要按特征匹配错误（符号链接 / 退出码 8 / 中间 exe /
 * fpm 下载失败），靠人眼看日志再手改参数，正是"一键"要消灭的步骤。
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

function canExecute(path) {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/* ─────────────────────────── 引擎运行时核对 ─────────────────────────── */

/**
 * 从 `build/rt/manifest.json` 反推这份运行时是**哪个平台哪个架构**的。
 *
 * 判据是 `pbsAsset`（构建时写下的 PBS 资产名），因为它同时含平台与架构；不用
 * `pyVersion`（只有版本号），也不用"当前进程架构"（那会把打包机当成目标机）。
 *
 * 两种命名都要认：
 * - uv：`cpython-3.12.11-windows-x86_64-none` / `...-macos-aarch64-none`
 * - PBS：`cpython-3.12.11+20241016-x86_64-apple-darwin-install_only.tar.gz`
 */
function readRuntimeFacts() {
  const manifestPath = join(RT_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { malformed: true, manifestPath };
  }
  const asset = String(manifest.pbsAsset ?? '');
  const { platform, arch } = parseRuntimeAsset(asset);
  return { platform, arch, asset, manifest };
}

/**
 * 核对运行时与目标平台/架构。
 *
 * 这里**必须硬失败**（而不是警告）：架构错配的产物在构建日志里一切正常，
 * 只有用户装完点开才发现引擎起不来。而修复它的动作很便宜（重建 build/rt）。
 */
function assertRuntimeMatches(options) {
  if (options.skipEngineCheck) {
    warn('已跳过 build/rt 检查：产物可能不含引擎运行时（能装不能跑）');
    return;
  }
  const rt = readRuntimeFacts();
  if (!rt) {
    fail(
      `引擎运行时不存在：${join(RT_DIR, 'manifest.json')}`,
      `先跑 npm run build:engine（首次约 10 分钟），或加 --skip-engine-check 明知故犯`,
    );
  }
  if (rt.malformed) {
    fail(
      `引擎运行时 manifest 无法解析：${rt.manifestPath}`,
      '删掉 build/rt 后重建：node scripts/build-engine.mjs',
    );
  }
  if (!rt.platform) {
    warn(`manifest.pbsAsset 无法识别平台（${rt.asset}），跳过平台核对`);
  } else if (rt.platform !== options.platform) {
    const rebuild = `在 ${PLATFORM_META[options.platform].label} 上执行：node scripts/build-engine.mjs`;
    fail(
      `build/rt 是 ${PLATFORM_META[rt.platform].label} 的运行时（${rt.asset}），目标却是 ${PLATFORM_META[options.platform].label}`,
      `便携 Python 不能跨平台复用。${rebuild}；然后重跑本脚本`,
    );
  }
  if (!rt.arch) {
    warn(`manifest.pbsAsset 无法识别架构（${rt.asset}），跳过架构核对`);
  } else if (rt.arch !== options.arch) {
    fail(
      `build/rt 是 ${rt.arch} 架构（${rt.asset}），目标是 ${options.arch}`,
      `两个架构的 python 不能互换。用 --arch ${rt.arch} 打当前这份，或先重建：node scripts/build-engine.mjs`,
    );
  }
  log('preflight', `引擎运行时 ${rt.arch ?? '?'} / ${rt.platform ?? '?'} ✓（${rt.asset}）`);
}

/**
 * 判据：随包的 python 解释器必须**可执行**。
 *
 * 从 Windows 拷过来的解压树会丢 `+x`（zip 不带权限位），打出来的包能装能开，
 * 但引擎 exec 时 EACCES。这个判据 10 毫秒就能做完，而撞上它的用户要重装。
 */
function assertRuntimeExecutable(options) {
  if (options.skipEngineCheck) return;
  const python =
    options.platform === 'win'
      ? join(RT_DIR, 'python', 'python.exe')
      : join(RT_DIR, 'python', 'bin', 'python3');
  if (!existsSync(python)) {
    fail(`运行时里找不到解释器：${python}`, 'build/rt 结构不对，重新执行 node scripts/build-engine.mjs');
  }
  if (options.platform !== 'win' && !canExecute(python)) {
    fail(
      `随包解释器没有可执行位：${python}`,
      'chmod +x build/rt/python/bin/* && chmod -R +x build/rt/python/lib 后重跑（zip 解压会丢权限位）',
    );
  }
  log('preflight', `解释器 ${python} 可执行 ✓`);
}

/* ─────────────────────────── 预检 ─────────────────────────── */

/**
 * 宿主平台与目标平台必须一致。
 *
 * 这不是"保守"——三条链路各有**只在目标系统上存在**的工具：
 * dmg 要 `hdiutil`、签名要 `codesign`；deb 要 `fpm`（linux 二进制）、AppImage 要
 * `mksquashfs`；NSIS 要 `makensis`。硬跨平台跑出来的是"退出码 0 + 空目录"。
 */
function assertHostMatches(options) {
  const meta = PLATFORM_META[options.platform];
  if (process.platform === meta.host) return;
  const hints = {
    win: 'Windows 的 NSIS 安装器依赖 makensis，只能在 Windows 上构建',
    mac: 'dmg 依赖 hdiutil、签名依赖 codesign，只能在 macOS 上构建（CI 用 macos-14 / macos-15-intel 各出一份）',
    linux:
      'deb/AppImage 的 fpm / mksquashfs 是 Linux 工具链；在 Windows 上用 WSL 或 release.yml 的 ubuntu-22.04 job',
  };
  fail(
    `当前宿主是 ${process.platform}，不能构建 ${meta.label} 包`,
    `${hints[options.platform]}。本脚本会在目标系统上自动选择对应 target，无需手工改配置`,
  );
}

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

/**
 * 探测本机可用的 macOS 签名身份。
 *
 * electron-builder 的"自动发现"在有证书时**顺手就签**，在没证书时**只打一行警告**；
 * 而两者的产物差别是"能分发"和"用户要手动 xattr"。所以不问 electron-builder，
 * 自己先问钥匙串：有 Developer ID 才走签名，没有就把降级说清楚。
 */
function macSigningIdentity() {
  if (process.platform !== 'darwin') return null;
  const listed = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    echo: false,
  });
  if (!listed.ok) return null;
  const match = /"([^"]*Developer ID Application[^"]*)"/.exec(listed.output);
  return match ? match[1] : null;
}

/** mac 上残留的 dmg 挂载点会让下一次 `hdiutil create` 报 Resource busy */
function detachStaleDmgVolumes() {
  if (process.platform !== 'darwin') return;
  const listed = run('/usr/bin/hdiutil', ['info'], { echo: false });
  if (!listed.ok) return;
  for (const line of listed.output.split('\n')) {
    const match = /\/Volumes\/(nanowork[^\s]*)/i.exec(line);
    if (match) {
      warn(`清理残留挂载点 /Volumes/${match[1]}`);
      run('/usr/bin/hdiutil', ['detach', `/Volumes/${match[1]}`, '-force'], { echo: false });
    }
  }
}

function preflight(options) {
  if (!existsSync(BUILDER_CONFIG)) fail(`找不到 ${BUILDER_CONFIG}`);

  // 引擎运行时缺失时打出来的包能装、但对话一定失败 —— 这种"能装不能跑"的包
  // 比打包失败更糟（要走完整装机流程才发现）。所以默认拦住。
  assertRuntimeMatches(options);
  assertRuntimeExecutable(options);

  let skipExeEdit = false;
  let identity = undefined;

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

  if (options.platform === 'mac') {
    if (!existsSync(ICON_ICNS)) fail(`找不到图标 ${ICON_ICNS}`);
    if (!existsSync(ENTITLEMENTS)) fail(`找不到 entitlements：${ENTITLEMENTS}`);
    if (!existsSync('/usr/bin/hdiutil')) {
      fail('找不到 /usr/bin/hdiutil，这台机器不是完整的 macOS 环境', '用真实 macOS runner，不要在 Linux 容器里打 dmg');
    }
    detachStaleDmgVolumes();

    // 证书判定：有 Developer ID 才签名；没有就显式降级（--strict 直接失败）。
    //
    // ⚠️ 必须先看 CSC_LINK / CSC_NAME：CI 里的证书是**由 electron-builder 在构建过程中**
    // 导入临时钥匙串的，本脚本动手时 `security find-identity` 还看不到它。只看钥匙串
    // 会把"配好了证书的 CI"误判成"没有证书"，于是自动降级成未签名包 —— 而且是静默的。
    const cscMaterial = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
    const found = macSigningIdentity();
    if (cscMaterial) {
      // 'auto' 表示"让 electron-builder 自己解析"：它知道 CSC_LINK 导进来的身份是谁。
      identity = process.env.CSC_NAME || 'auto';
      log('preflight', '检测到 CSC_LINK / CSC_NAME，交给 electron-builder 完成签名 ✓');
    } else if (found) {
      identity = found;
      log('preflight', `签名身份 ${found} ✓（rt/** 由 afterSign 递归签名）`);
    } else if (options.strict) {
      fail(
        '找不到 Developer ID Application 证书，--strict 下不产出未签名包',
        '配 CSC_LINK + CSC_KEY_PASSWORD（或 CSC_NAME），或去掉 --strict 只打内测包',
      );
    } else {
      identity = null;
      degrade(
        '没有 Developer ID Application 证书',
        '跳过签名并关闭 hardenedRuntime',
        '不能分发：用户需 xattr -dr com.apple.quarantine 才能打开',
      );
    }
  }

  if (options.platform === 'linux') {
    if (!existsSync(ICON_PNG)) fail(`找不到图标 ${ICON_PNG}`);
    log('preflight', 'Linux target = AppImage + deb ✓');
  }

  if (!options.skipFrontend) {
    requireModule('vite/bin/vite.js');
    requireModule('esbuild/bin/esbuild');
    requireModule('electron-builder/cli.js');
  }
  if (options.check) requireModule('typescript/bin/tsc');
  log('preflight', `输出目录 ${options.out}`);
  return { skipExeEdit, identity };
}

/* ─────────────────────────── 构建 ─────────────────────────── */

function buildFrontend() {
  run(process.execPath, [requireModule('vite/bin/vite.js'), 'build', '--emptyOutDir', 'false']);
  for (const entry of ['main', 'preload', 'splashPreload']) {
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

/** electron-builder 参数：输出目录、架构、签名与"是否改写 exe 资源"都在这里决定 */
function builderArgs(options, variant) {
  const args = [
    requireModule('electron-builder/cli.js'),
    '--config',
    BUILDER_CONFIG,
    `--${options.platform}`,
    // 架构必须显式给：配置里不再写死 arch 数组（见 builder.config.json 的注释），
    // 否则 electron-builder 会按"配置里的架构"打包，与 build/rt 的实际架构脱钩。
    options.arch === 'arm64' ? '--arm64' : '--x64',
    '--publish',
    options.publish,
    `--config.directories.output=${variant.out}`,
  ];
  // 没有代码签名证书时，改写 exe 资源（图标/版本号）会强制下载 winCodeSign，
  // 而它解压要建符号链接 —— 无特权机器上必失败。见文件头的坑 1。
  if (options.platform === 'win' && variant.skipExeEdit) {
    args.push('--config.win.signAndEditExecutable=false');
  }
  // 未签名时 hardenedRuntime 没有意义（还会让 electron-builder 反复警告），一起关掉。
  if (options.platform === 'mac' && variant.identity === null) {
    args.push('--config.mac.hardenedRuntime=false');
  }
  if (options.platform === 'mac' && variant.identity) {
    // 'auto' 时不传 identity：electron-builder 自己会从 CSC_LINK 导入的钥匙串里解析，
    // 传一个字符串反而会把"它已经算好的身份"覆盖掉。
    if (variant.identity !== 'auto') args.push(`--config.mac.identity=${variant.identity}`);
    // 公证是签名之后的独立一步：没有 APPLE_ID/TEAM_ID 就让它保持 false，
    // 否则 electron-builder 会抛 notarytool 认证错误，把"没配凭据"说成"公证失败"。
    if (process.env.APPLE_ID && process.env.APPLE_TEAM_ID) {
      args.push('--config.mac.notarize=true');
    }
  }
  return args;
}

function attemptBuild(options, variant) {
  log(
    'builder',
    `输出=${variant.out} arch=${options.arch} compression=${variant.compression}` +
      `${variant.skipExeEdit ? ' 改写exe资源=关' : ''}` +
      `${options.platform === 'mac' ? ` 签名=${variant.identity ?? '未签名'}` : ''}` +
      `${variant.mirror ? ' 工具链镜像=cn' : ''}`,
  );
  return run(process.execPath, builderArgs(options, variant), {
    env: {
      ELECTRON_BUILDER_COMPRESSION_LEVEL: String(variant.compression),
      // 未签名：让 electron-builder 连"自动发现证书"这一步都跳过，否则它会拿着
      // 一个不匹配的身份去签，失败信息只有一句 cannot be signed。
      ...(options.platform === 'mac' && variant.identity === null
        ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
        : {}),
      ...(variant.mirror ? { ELECTRON_BUILDER_BINARIES_MIRROR: BUILDER_BINARIES_MIRROR } : {}),
    },
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

  // linux：构建工具链（fpm / appimage）是下载来的，受限网络下必然失败。
  // 换镜像不改变产物，因此不受 --strict 约束（放在 strict 判定之前）。
  if (options.platform === 'linux' && !current.mirror) {
    if (has(/Cannot download|ECONNRESET|ETIMEDOUT|socket hang up|fpm.*(?:failed|download)|appimage.*(?:failed|download)/i)) {
      warn(`下载打包工具链失败（fpm / appimage）→ 改用国内镜像 ${BUILDER_BINARIES_MIRROR} 重试`);
      return { ...current, mirror: true };
    }
  }

  // mac：上一轮 dmg 挂载点残留（Resource busy / already mounted）
  if (options.platform === 'mac' && !current.detached && has(/Resource busy|already mounted|hdiutil: create failed/i)) {
    detachStaleDmgVolumes();
    return { ...current, detached: true };
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
  // linux：磁盘满（deb 与 AppImage 都要在临时目录里展开整棵树）
  if (has(/ENOSPC|No space left on device/i)) {
    warn('磁盘空间不足。清理输出目录所在分区后重跑，本脚本不自动重试');
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
function findArtifact(outDir, spec) {
  if (!existsSync(outDir)) fail(`输出目录不存在：${outDir}`);
  const candidates = readdirSync(outDir)
    .filter((name) => spec.ext.test(name))
    .map((name) => ({ path: join(outDir, name), size: statSync(join(outDir, name)).size }))
    .sort((a, b) => b.size - a.size);
  return candidates[0] ?? null;
}

function sevenZipBinary() {
  const relative =
    process.platform === 'win32'
      ? 'win/x64/7za.exe'
      : process.platform === 'darwin'
        ? 'mac/7za'
        : 'linux/x64/7za';
  const path = join(REPO_ROOT, 'node_modules', '7zip-bin', relative);
  return existsSync(path) ? path : null;
}

/** 用平台原生工具列出归档条目（比 7z 更权威，且失败信息可读） */
function listEntries(platform, kind, path) {
  if (platform === 'linux' && kind === 'deb' && existsSync('/usr/bin/dpkg-deb')) {
    const listed = run('/usr/bin/dpkg-deb', ['--contents', path], { echo: false });
    if (listed.ok) return listed.output;
  }
  if (platform === 'mac' && kind === 'zip') {
    const listed = run('/usr/bin/unzip', ['-l', path], { echo: false });
    if (listed.ok) return listed.output;
  }
  const sevenZip = sevenZipBinary();
  if (sevenZip) {
    const listed = run(sevenZip, ['l', path], { echo: false });
    if (listed.ok) return listed.output;
  }
  return null;
}

/**
 * mac 的 dmg 用挂载来验证。
 *
 * 只 `hdiutil verify` 只能证明"镜像没坏"，证明不了"里面的 app 带引擎"。
 * 挂载后直接 stat 那个解释器，是唯一能一句话说清的判据（而且只需几秒）。
 */
function verifyMacDmg(path, spec) {
  const verify = run('/usr/bin/hdiutil', ['verify', path], { echo: false });
  if (!verify.ok) fail(`dmg 校验失败：${path}`, '删掉产物重跑；磁盘空间不足时会产出截断的 dmg');

  const mountPoint = mkdtempSync(join(tmpdir(), 'nw-dmg-'));
  const attach = run(
    '/usr/bin/hdiutil',
    ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, path],
    { echo: false },
  );
  if (!attach.ok) {
    fail(
      `dmg 无法挂载：${path}`,
      `常见原因是本机不允许挂载磁盘映像。手动执行：hdiutil attach "${path}"`,
    );
  }
  try {
    const entries = [];
    const stack = [mountPoint];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const name of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, name.name);
        if (name.isDirectory()) stack.push(full);
        else if (name.isFile() || name.isSymbolicLink()) entries.push(full);
        if (entries.length > 50000) break;
      }
    }
    const hasRuntime = entries.some((entry) => /Contents\/Resources\/rt\/python\/bin\/python3$/.test(entry));
    if (!hasRuntime) {
      fail(
        `dmg 里没有引擎运行时（Contents/Resources/rt/python/bin/python3）：${path}`,
        '检查 builder.config.json 的 extraResources 是否仍指向 build/rt，以及 build/rt 是否被清空',
      );
    }
    log('verify', `${spec.kind} 内含 Contents/Resources/rt/python/bin/python3 ✓`);
  } finally {
    run('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { echo: false });
    rmSync(mountPoint, { recursive: true, force: true });
  }
}

/**
 * Linux 的 AppImage 用 `--appimage-extract` 验证。
 *
 * 不用 7z 读 squashfs（对 AppImage 的分块压缩支持不稳），也不挂载（需要 FUSE，
 * CI 容器里通常没有）。`--appimage-extract` 在无 FUSE 时也能跑，正好顺带验证
 * "用户在无 FUSE 机器上能解包"这条验收判据。
 */
function verifyLinuxAppImage(path, spec) {
  if (!canExecute(path)) {
    // 权限位丢了 AppImage 就无法直接运行；chmod 即可，不算产物质量降级
    try {
      chmodSync(path, statSync(path).mode | 0o111);
      log('verify', 'AppImage 缺少可执行位，已补 +x');
    } catch {
      warn(`AppImage 缺少可执行位且无法自动修复：${path}`);
    }
  }
  const probeDir = mkdtempSync(join(tmpdir(), 'nw-appimage-'));
  try {
    // squashfs-root 会落在**子进程的当前工作目录**，所以 cwd 指到临时目录
    const extracted = run(path, ['--appimage-extract'], { echo: false, cwd: probeDir });
    if (!extracted.ok) {
      // 解包失败不代表产物不能用（有些发行版限制自解压），只告警，不判死
      warn(
        `AppImage 解包探测失败（不影响产物可用性）：${extracted.output.trim().split('\n').slice(-2).join(' | ')}`,
      );
      return;
    }
    const python = join(probeDir, 'squashfs-root', 'resources', 'rt', 'python', 'bin', 'python3');
    if (!existsSync(python)) {
      fail(
        `AppImage 里没有引擎运行时（resources/rt/python/bin/python3）：${path}`,
        '检查 builder.config.json 的 extraResources 与 build/rt 内容',
      );
    }
    if (!canExecute(python)) {
      fail(
        `AppImage 里的解释器没有可执行位：${python}`,
        'build/rt 在打包前就丢了权限位，先跑 chmod -R +x build/rt/python/bin 再重打',
      );
    }
    log('verify', `${spec.kind} 内含 resources/rt/python/bin/python3（+x）✓`);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function verifyArtifacts(options, outDir) {
  const meta = PLATFORM_META[options.platform];
  const verified = [];

  for (const spec of meta.artifacts) {
    const artifact = findArtifact(outDir, spec);
    if (!artifact) {
      fail(
        `没有产出 ${spec.kind}：${outDir}`,
        options.platform === 'linux'
          ? 'deb 依赖 fpm（首次会下载）；看日志里是否有 fpm/Cannot download，必要时设 ELECTRON_BUILDER_BINARIES_MIRROR'
          : '检查 electron-builder 是否真的产出了该 target（日志末尾 12 行会有原因）',
      );
    }
    if (artifact.size < MIN_ARTIFACT_BYTES) {
      fail(
        `${spec.kind} 只有 ${artifact.size} 字节，不是安装包`,
        '这是构建中间产物（NSIS 卸载器生成器）。删掉它重跑，并确认 electron-builder 退出码为 0',
      );
    }

    if (options.platform === 'mac' && spec.kind === 'dmg') {
      verifyMacDmg(artifact.path, spec);
    } else if (options.platform === 'linux' && spec.kind === 'AppImage') {
      verifyLinuxAppImage(artifact.path, spec);
    } else {
      const entries = listEntries(options.platform, spec.kind, artifact.path);
      if (!entries) {
        warn(`${spec.kind} 无法列目录（缺少 7za/dpkg-deb/unzip），只按体积判定`);
      } else {
        const count = /(\d+)\s+files?,\s*(\d+)\s+folders?/.exec(entries);
        if (count) log('verify', `${spec.kind} 内含 ${count[1]} 个文件 / ${count[2]} 个目录 ✓`);
        // deb 用 dpkg-deb 列目录是权威的，缺引擎就是坏包 → 硬失败；
        // NSIS 与 mac zip 的归档列表在个别 electron-builder 版本里是嵌套的 app-*.7z
        // （只能看到那个内层归档，看不到里面的路径），所以只告警 —— 用告警区分
        // "确定坏"与"看不见"，避免把好包判死。
        if (!meta.runtimeProbe.test(entries)) {
          const message = `${spec.kind} 的归档列表里看不到引擎运行时：${artifact.path}`;
          if (spec.kind === 'deb') {
            fail(message, '检查 builder.config.json 的 extraResources 是否仍指向 build/rt');
          }
          warn(message);
        } else {
          log('verify', `${spec.kind} 内含引擎运行时 ✓`);
        }
      }
    }

    log('verify', `${spec.kind} ${artifact.path}（${(artifact.size / 1048576).toFixed(0)} MiB）✓`);
    verified.push({ ...artifact, kind: spec.kind });
  }
  return verified;
}

/**
 * 产物不在项目里时，在 `release/` 留一张指路牌。
 *
 * 产物默认落在盘根是基于环境限制的妥协（见 `defaultOut` 的注释），但人的习惯是去
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
      `本次参数：platform=${options.platform} arch=${options.arch} compression=${options.compression} strict=${options.strict}`,
    ];
    writeFileSync(join(pointerDir, 'ARTIFACT.txt'), `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 指路牌是锦上添花，写不了也不该让构建失败
  }
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  assertHostMatches(options);
  log(
    'start',
    `平台=${options.platform} 架构=${options.arch} 压缩=${options.compression} 严格模式=${options.strict}`,
  );
  const preflightResult = preflight(options);
  if (options.check) typecheck();
  if (!options.skipFrontend) buildFrontend();

  let variant = {
    out: options.out,
    compression: options.compression,
    // 预检已经知道建不了符号链接时直接跳过第一次尝试：那一趟要白等约 9 分钟
    skipExeEdit: preflightResult.skipExeEdit,
    identity: preflightResult.identity,
    movedOut: false,
    mirror: false,
    detached: false,
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

  const artifacts = verifyArtifacts(options, variant.out);
  const primary = artifacts[0];
  writeArtifactPointer(primary, options);

  // 给 CI 用的机器可读产物清单。
  //
  // 为什么要专门写一个文件：Windows 上产物可能因为环境限制被"挪到盘根"
  // （见 nextVariant 的坑 3），于是"产物在哪个目录"不是常量。让脚本自己报，
  // 比在 workflow 里猜两个路径可靠。
  if (process.env.NANOWORK_ARTIFACT_REPORT) {
    writeFileSync(
      process.env.NANOWORK_ARTIFACT_REPORT,
      `${JSON.stringify({ platform: options.platform, arch: options.arch, artifacts }, null, 2)}\n`,
      'utf8',
    );
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);

  console.log('');
  log('done', `耗时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒，尝试 ${attempts} 次`);
  for (const artifact of artifacts) {
    console.log(`[build-installer] 产物（${artifact.kind}）：${artifact.path}`);
    console.log(
      `[build-installer] 大小：${artifact.size} 字节（${(artifact.size / 1048576).toFixed(0)} MiB）`,
    );
  }

  if (degraded.length > 0) {
    console.log('');
    console.warn('[build-installer] 本次构建发生了降级，产物不能直接发版：');
    for (const item of degraded) {
      console.warn(`  · ${item.reason} → ${item.action}（${item.cost}）`);
    }
    console.warn('[build-installer] 想消除降级：Windows 上开启开发者模式；macOS 上配 CSC_LINK 证书；或用 --strict 让它直接失败。');
  }
}

// 只有作为脚本执行时才跑；被测试 import 时只导出纯函数（见 scripts/lib/installerPlan.mjs 的说明）。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
