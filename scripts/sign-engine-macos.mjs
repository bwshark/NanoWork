/**
 * macOS 打包的 afterSign 钩子：把 `Contents/Resources/rt/**` 里的可执行文件补签一遍。
 *
 * ## 为什么必须单独做这一步
 *
 * electron-builder 的签名只覆盖它自己认识的 bundle 内容（Electron Framework、app 本体、
 * 它复制进去的 Resources）。`extraResources` 搬进去的 `rt/`（便携 Python + site-packages）
 * **完全不在它的签名范围里** —— 里面有几十个 `.so` / `.dylib` 和一个 `python3` 可执行文件。
 *
 * 后果分两级：
 * 1. **公证**（notarytool）直接失败：`code object is not signed at all`，整个发布链断在最后一步；
 * 2. 就算不做公证，Gatekeeper 在 arm64 上拒绝加载未签名、且带 `com.apple.quarantine` 的 dylib
 *    → 用户看到的是"应用启动后立刻退出"，日志里只有一句 codesign 相关报错。
 *
 * ## 顺序为什么是"先内层、再 app"
 *
 * 签名是**逐层密封**的：外层签名记录内层内容的摘要。先改 `rt/**` 再重签 app 才成立；
 * 反过来（先签 app 再去改 Resources）会把 app 的签名弄坏，`codesign --verify` 立刻报
 * `resource envelope is obsolete` / `a sealed resource is missing or invalid`。
 *
 * ## 未签名构建时
 *
 * 本机没有 Developer ID（`CSC_IDENTITY_AUTO_DISCOVERY=false`）时直接返回：那种产物本来
 * 就不签，硬签会得到一个"半签"的 bundle，比不签更难排查。
 *
 * @see docs/plan-packaging-and-release.md §7.2
 */

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Mach-O 魔数（含 32/64 位、大小端与 fat binary） */
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function log(message) {
  console.log(`[sign-engine-macos] ${message}`);
}

function warn(message) {
  console.warn(`[sign-engine-macos] 警告 ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * 判 Mach-O 用**读前 4 字节魔数**，而不是 `file(1)`。
 *
 * rt 下有近两万个文件，每个都 fork 一个 `file` 进程会让这一步从几秒变成几分钟；
 * 而魔数判断只需要 4 个字节。
 */
function isMachO(path) {
  let fd;
  try {
    if (!statSync(path).isFile() || statSync(path).size < 4) return false;
    fd = openSync(path, 'r');
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(header.readUInt32BE(0)) || MACHO_MAGIC.has(header.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 深度优先收集：先签叶子，再签容器（顺序不能反） */
function collectTargets(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && isMachO(full)) found.push(full);
    }
  }
  return found;
}

function findIdentity() {
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  const listed = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!listed.ok) return null;
  const match = /"([^"]*Developer ID Application[^"]*)"/.exec(listed.output);
  return match ? match[1] : null;
}

/**
 * electron-builder 的 afterSign 签名：`(context) => Promise<void>`。
 *
 * `context.appOutDir` 是 `<out>/mac-arm64` 这类目录，app 在它下面（productName 决定名字）。
 */
export default async function afterSign(context) {
  if (process.platform !== 'darwin') {
    // electron-builder 在 Windows/Linux 上也会调用 afterSign 钩子。那是正常路径，
    // 不是问题，所以只留一行 info，不用 warning（否则每次 win 构建都多一条"警告"）。
    log('非 macOS 宿主，跳过引擎运行时签名');
    return;
  }

  const identity = findIdentity();
  if (!identity) {
    log('没有 Developer ID 证书（或已被 CSC_IDENTITY_AUTO_DISCOVERY=false 关闭），跳过递归签名');
    return;
  }

  const appOutDir = context?.appOutDir;
  const productName = context?.packager?.appInfo?.productFilename ?? 'nanowork';
  if (!appOutDir || !existsSync(appOutDir)) {
    warn(`afterSign 拿不到 appOutDir（${appOutDir}），跳过`);
    return;
  }
  const appPath = join(appOutDir, `${productName}.app`);
  const runtimeRoot = join(appPath, 'Contents', 'Resources', 'rt');
  if (!existsSync(runtimeRoot)) {
    // 没有 rt 说明 build/rt 没被 extraResources 带进来 —— 这个包能装但没引擎，
    // 必须让构建停下，而不是签完就发出去。
    throw new Error(`签名阶段找不到引擎运行时：${runtimeRoot}（extraResources 没生效）`);
  }

  const entitlements = join(
    context?.packager?.info?.projectDir ?? process.cwd(),
    'electron',
    'assets',
    'entitlements.mac.plist',
  );
  const entitlementsArgs = existsSync(entitlements) ? ['--entitlements', entitlements] : [];
  if (!existsSync(entitlements)) warn(`找不到 ${entitlements}，将不带 entitlements 签名`);

  const targets = collectTargets(runtimeRoot);
  log(`rt 下发现 ${targets.length} 个 Mach-O（.so/.dylib/python3），开始逐个重签`);
  if (targets.length === 0) {
    throw new Error(`rt 下没有任何 Mach-O 文件：${runtimeRoot}（运行时结构不对，或平台不匹配）`);
  }

  let signed = 0;
  const failures = [];
  for (const target of targets) {
    const result = run('/usr/bin/codesign', [
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      ...entitlementsArgs,
      '--sign',
      identity,
      target,
    ]);
    if (result.ok) signed += 1;
    else failures.push({ target, output: result.output.trim().split('\n').slice(-2).join(' | ') });
  }
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 5)) warn(`签名失败 ${failure.target}：${failure.output}`);
    throw new Error(`${failures.length} 个文件签名失败（rt 下的 dylib 必须全部签上）`);
  }
  log(`${signed} 个 Mach-O 已签名`);

  // 最后重签 app 本体：上面动了 Resources，electron-builder 之前那份签名已经失效。
  const resignApp = run('/usr/bin/codesign', [
    '--force',
    '--timestamp',
    '--options',
    'runtime',
    ...entitlementsArgs,
    '--sign',
    identity,
    appPath,
  ]);
  if (!resignApp.ok) {
    throw new Error(`重签 ${appPath} 失败：${resignApp.output.trim().split('\n').slice(-3).join(' | ')}`);
  }

  const verified = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (!verified.ok) {
    throw new Error(`签名校验失败：${verified.output.trim().split('\n').slice(-3).join(' | ')}`);
  }
  log('签名校验通过（codesign --verify --deep --strict）');
  log(`提示：公证（notarize）需要 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID；本 hook 不负责公证`);
}

// 允许单独执行本文件做一次"结构体检"（不参与构建）：
//   node scripts/sign-engine-macos.mjs <path/to/app>
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('用法：node scripts/sign-engine-macos.mjs <nanowork.app>');
    process.exit(1);
  }
  const runtimeRoot = join(appPath, 'Contents', 'Resources', 'rt');
  if (!existsSync(runtimeRoot)) {
    console.error(`找不到 ${runtimeRoot}`);
    process.exit(1);
  }
  const targets = collectTargets(runtimeRoot);
  console.log(`[sign-engine-macos] ${runtimeRoot} 下有 ${targets.length} 个 Mach-O`);
  const manifest = join(runtimeRoot, 'manifest.json');
  if (existsSync(manifest)) {
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    console.log(
      `[sign-engine-macos] 运行时 ${data.pbsAsset ?? '?'} / buildId=${data.buildId ?? '?'}`,
    );
  }
}
