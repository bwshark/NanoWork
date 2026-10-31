/**
 * 打包计划里的**纯逻辑**（无 IO、无 process、无副作用）。
 *
 * ## 为什么要单独一个文件
 *
 * 这些判断全都有"错了也不报错"的特性：
 * - 从 `pbsAsset` 反推平台/架构，错了就打出架构错配的包，构建日志一切正常；
 * - 按扩展名认产物，错了就是"没打出来"与"打出来两个"都判不准；
 * - 输出目录默认值，错了会让 Windows 上白跑 5 分钟。
 *
 * 放在主脚本里就没法测（一 import 就会执行构建）。抽出来之后单测可以逐条钉住，
 * 而主脚本只负责"按计划执行 + 报告"。
 *
 * @see scripts/build-installer.mjs
 */

/**
 * 三个平台各自的"宿主"与"产物"，**只写一次**。
 *
 * 之前这些事实散落在各个 if 里，结果是 mac 的 dmg 校验写成了"按 exe 找"，
 * 在 mac 上永远找不到产物却报"没打出来"。集中成表之后，加一个 target 只改一处。
 */
export const PLATFORM_META = {
  win: {
    label: 'Windows',
    host: 'win32',
    /** PBS 资产名里出现的平台关键词（uv 与 install_only 两种命名都覆盖） */
    pbsHints: ['windows'],
    artifacts: [{ kind: 'nsis', ext: /\.exe$/i }],
    /** 产物里应能找到的引擎解释器路径（用于证明包里有运行时） */
    runtimeProbe: /resources[\\/]rt[\\/]python[\\/]python\.exe/i,
  },
  mac: {
    label: 'macOS',
    host: 'darwin',
    pbsHints: ['darwin', 'macos'],
    artifacts: [
      { kind: 'dmg', ext: /\.dmg$/i },
      { kind: 'zip', ext: /\.zip$/i },
    ],
    runtimeProbe: /Contents\/Resources\/rt\/python\/bin\/python3/i,
  },
  linux: {
    label: 'Linux',
    host: 'linux',
    pbsHints: ['linux'],
    artifacts: [
      { kind: 'AppImage', ext: /\.AppImage$/i },
      { kind: 'deb', ext: /\.deb$/i },
    ],
    runtimeProbe: /resources\/rt\/python\/bin\/python3/i,
  },
};

/** 架构归一：node 的 `process.arch`、PBS 的 triple、用户输入三种写法 */
export const ARCH_ALIASES = {
  x64: ['x64', 'x86_64', 'amd64', 'x86-64'],
  arm64: ['arm64', 'aarch64', 'arm64e'],
};

export function normalizeArch(value) {
  const needle = String(value ?? '').toLowerCase();
  for (const [arch, aliases] of Object.entries(ARCH_ALIASES)) {
    if (aliases.includes(needle)) return arch;
  }
  return null;
}

/** 平台关键字的匹配顺序：先 mac 的 `darwin|macos`，避免 `linux` 之类误配 */
export function detectPlatform(asset) {
  const lower = String(asset ?? '').toLowerCase();
  for (const [key, meta] of Object.entries(PLATFORM_META)) {
    if (meta.pbsHints.some((hint) => lower.includes(hint))) return key;
  }
  return null;
}

/**
 * 从 PBS / uv 的资产名反推 `{ platform, arch }`。
 *
 * 两种命名都要认：
 * - uv：`cpython-3.12.11-windows-x86_64-none` / `cpython-3.12.11-macos-aarch64-none`
 * - PBS：`cpython-3.12.11+20241016-x86_64-apple-darwin-install_only.tar.gz`
 *
 * ⚠️ 架构判断必须先看 aarch64，再看 x86_64：`x86_64-apple-darwin` 里既没有 arm 字样，
 * 但 `aarch64-apple-darwin` 里含 `x86`? 不含。反过来 `x86_64` 里也不含 `aarch64`，
 * 所以两者互斥；顺序只是让意图更明确。
 */
export function parseRuntimeAsset(asset) {
  const lower = String(asset ?? '').toLowerCase();
  const platform = detectPlatform(lower);
  const arch = ARCH_ALIASES.arm64.some((alias) => lower.includes(alias))
    ? 'arm64'
    : ARCH_ALIASES.x64.some((alias) => lower.includes(alias))
      ? 'x64'
      : null;
  return { platform, arch };
}
