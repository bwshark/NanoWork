/**
 * 打包态引擎运行时的构建脚本（B1 方案的 P0 地基）。
 *
 * 产出 `build/rt/`：
 *
 *   build/rt/
 *     python/                 ← python-build-standalone 的 install_only 产物
 *     site/                   ← 引擎 wheel + 全部依赖（含预编译 pyc）
 *     config.template.json    ← 首启配置模板（已剔除凭据）
 *     manifest.json           ← 版本 + sha256，供自检与排障
 *
 * ## 为什么不直接把现有 .venv 拷进来
 *
 * 实测过：venv 搬迁后 `sys.base_prefix` 仍指向构建机的解释器，`site-packages` 里还有
 * `_editable_impl_nanobot_ai.pth` 写死源码路径。venv 不是可分发单元，可重定位的
 * **解释器本体**才是 —— 这就是选 python-build-standalone（PBS）的原因。
 *
 * ## 用法
 *
 *   node scripts/build-engine.mjs            # 总是重建
 *   node scripts/build-engine.mjs --ensure   # 已有 manifest 就跳过（build:electron 用）
 *   node scripts/build-engine.mjs --force    # 与默认一致，写出来方便 CI 表达意图
 *
 * 环境变量：
 *   PBS_TAG        钉死 python-build-standalone 的 release tag（推荐在 CI 里钉）
 *   PBS_ASSET_URL  直接给 tarball URL（内网/镜像场景，跳过 GitHub API）
 *   PBS_PY_MINOR   Python 小版本，默认 3.12（引擎 pyproject 要求 >=3.11）
 *   ENGINE_DIR     引擎仓库路径，默认 <repo>/nanobot
 *
 * @see docs/plan-packaging-and-release.md §4
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(REPO_ROOT, 'build');
const RT_DIR = join(BUILD_DIR, 'rt');
const SITE_DIR = join(RT_DIR, 'site');
const PYTHON_DIR = join(RT_DIR, 'python');
const WHEEL_DIR = join(BUILD_DIR, 'wheels');
const PBS_CACHE = join(BUILD_DIR, 'pbs');
const ENGINE_DIR = process.env.ENGINE_DIR ? resolve(process.env.ENGINE_DIR) : join(REPO_ROOT, 'nanobot');

const PBS_PY_MINOR = process.env.PBS_PY_MINOR ?? '3.12';
const IS_WIN = process.platform === 'win32';

/**
 * 凭据识别的**判据是词**，不是整名。
 *
 * 只按固定名剔除（`token` / `apiKey`）会漏掉 `tokenIssueSecret`、`identityKey`
 * 这类驼峰复合词 —— 本机实测就漏了三个，其中一个 `tokenIssueSecret` 还是非空真值，
 * 它会跟着安装包发到每一个用户手上（同一个密钥出现在所有安装里）。
 *
 * 反过来，含 `token` 字样但**不是**凭据的字段必须显式豁免，否则会静默删掉配置
 * （`maxTokens` 被删 = 模型请求长度变了，这种错误没人能在界面上看出来）。
 */
const SECRET_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'credential']);

/** 名字里含凭据词、语义上却不是凭据的例外（每个都要写清理由） */
const NOT_SECRET_NAMES = new Set([
  'maxtokens', // 生成上限，不是凭据
  'contextwindowtokens', // 上下文窗口，不是凭据
  'allowedenvkeys', // 允许透传的环境变量名白名单
  'tokenissuepath', // 令牌签发端点路径
  'tokenissueurl',
  'tokenttls',
  'websocketrequirestoken', // 布尔开关
  'sslkeyfile', // 证书文件路径
  'sslcertfile',
  'hotkey', // 快捷键
]);

function splitWords(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

function isSecretName(key) {
  if (NOT_SECRET_NAMES.has(key.toLowerCase())) return false;
  return splitWords(key).some((word) => SECRET_WORDS.has(word));
}

const args = process.argv.slice(2);
const ENSURE_ONLY = args.includes('--ensure');

function log(step, message) {
  console.log(`[build-engine] ${step} ${message}`);
}

function fail(message, hint) {
  console.error(`\n[build-engine] 失败：${message}`);
  if (hint) console.error(`[build-engine] 处理：${hint}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  log('run', `${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) fail(`${command} 无法执行：${result.error.message}`, '确认该命令在 PATH 上');
  if (result.status !== 0) fail(`${command} 退出码 ${result.status}`);
}

function tryCapture(command, commandArgs, cwd) {
  try {
    return execFileSync(command, commandArgs, { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function pythonExecutable() {
  return IS_WIN ? join(PYTHON_DIR, 'python.exe') : join(PYTHON_DIR, 'bin', 'python3');
}

async function dirSize(dir) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        try {
          total += (await fs.stat(full)).size;
        } catch {
          /* 读不到就跳过：体积报告不值得让构建失败 */
        }
      }
    }
  }
  return { bytes: total, files };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 引擎版本：从 pyproject 的 [project] 段取，别用 package.json（那是渲染层版本） */
async function readEngineMeta() {
  const pyproject = join(ENGINE_DIR, 'pyproject.toml');
  if (!existsSync(pyproject)) {
    fail(
      `找不到引擎仓库：${ENGINE_DIR}`,
      '引擎是独立 git 仓库，父仓库 .gitignore 忽略了它；见 docs/engine-dev-setup.md',
    );
  }
  const text = await fs.readFile(pyproject, 'utf-8');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  if (!version) fail('无法从 pyproject.toml 解析版本号');
  const commit = tryCapture('git', ['rev-parse', 'HEAD'], ENGINE_DIR) ?? 'unknown';
  const dirty =
    (tryCapture('git', ['status', '--porcelain'], ENGINE_DIR) ?? '').length > 0;
  return { version, commit, dirty };
}

/** PBS 资产名：cpython-<ver>+<tag>-<triple>-install_only.tar.gz */
function pbsTriple() {
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  return fail(`不支持的平台：${process.platform}`);
}

/**
 * 取得便携解释器。三条路径，按"可控程度"从高到低：
 *
 * 1. `PBS_ASSET_URL`：直接给 tarball（内网镜像 / 已缓存），完全不碰网络发现。
 * 2. `PBS_TAG`：钉一个 release tag，走 GitHub API 找资产。**CI 里应该用这条**（可复现）。
 * 3. 都不给：`uv python install` —— uv 自己就是 PBS 的消费者，下下来的是同一份
 *    install_only 产物（Windows 上 20 MiB / 8 秒），且能通过 `UV_PYTHON_INSTALL_MIRROR`
 *    走镜像。本机实测 GitHub API 常被 403（未认证限流），这条路是默认兜底。
 */
async function resolvePbsAsset() {
  if (process.env.PBS_ASSET_URL) {
    return { kind: 'tarball', url: process.env.PBS_ASSET_URL, tag: process.env.PBS_TAG ?? 'custom' };
  }
  if (!process.env.PBS_TAG) {
    log('pbs', `未设置 PBS_TAG，改用 uv python install ${PBS_PY_MINOR}（可用 UV_PYTHON_INSTALL_MIRROR 走镜像）`);
    return { kind: 'uv', version: `uv-python-${PBS_PY_MINOR}` };
  }

  const tag = process.env.PBS_TAG;
  const triple = pbsTriple();
  const assetPattern = new RegExp(
    `^cpython-${PBS_PY_MINOR.replace('.', '\\.')}\\.\\d+\\+${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${triple}-install_only\\.tar\\.gz$`,
  );
  const res = await fetch(
    `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${tag}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) {
    fail(
      `查询 PBS release ${tag} 失败（HTTP ${res.status}）`,
      '去掉 PBS_TAG 走 uv（默认兜底），或设置 PBS_ASSET_URL 直接给 tarball',
    );
  }
  const body = await res.json();
  const asset = (body.assets ?? []).find((item) => assetPattern.test(item.name));
  if (!asset) {
    fail(
      `release ${tag} 里找不到匹配 ${PBS_PY_MINOR} / ${triple} 的 install_only 资产`,
      '用 PBS_ASSET_URL 直接指定 tarball',
    );
  }
  return { kind: 'tarball', url: asset.browser_download_url, tag };
}

async function download(url, target) {
  if (existsSync(target)) {
    log('download', `复用缓存 ${target}`);
    return target;
  }
  log('download', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`下载失败（HTTP ${res.status}）：${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  log('download', `${mb(buffer.length)} → ${target}`);
  return target;
}

function pruneList() {
  const minor = `python${PBS_PY_MINOR}`;
  /*
   * 只裁「确定用不到」的东西。**pip 不能裁**：
   * 运行期插件安装走 `PIP_USER=1` + `python -m pip install`，把它删掉会让"装渠道依赖"
   * 这条功能静默失效（引擎只会抛一句 pip 不存在）。
   */
  return [
    join('site', 'nanobot', 'web', 'dist'), // 引擎自带 webui，本应用不用（-7.4 MB）
    join('python', 'Lib', 'test'), // win
    join('python', 'lib', minor, 'test'), // posix
    join('python', 'Lib', 'idlelib'),
    join('python', 'lib', minor, 'idlelib'),
    join('python', 'tcl'), // tkinter 用不到，约 -25 MB
  ];
}

/** 递归剔除凭据键，并把 workspace 换成占位符 */
function sanitizeConfig(node, isRoot = false) {
  if (Array.isArray(node)) return node.map((item) => sanitizeConfig(item));
  if (node === null || typeof node !== 'object') return node;
  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (isSecretName(key)) continue;
    result[key] = sanitizeConfig(value);
  }
  if (isRoot) {
    result.agents ??= {};
    result.agents.defaults ??= {};
    result.agents.defaults.workspace = '__NANOWORK_WORKSPACE__';
  }
  return result;
}

/**
 * 兜底自检：模板里若还留着"名字像凭据 + 值非空"的字段，**让构建失败**。
 *
 * 这条不做成静默剔除，是因为漏网意味着把一个真实密钥发给所有用户；而失败会迫使
 * 维护者当场决定"这是凭据（删）"还是"这不是凭据（加进 NOT_SECRET_NAMES）"。
 */
function assertNoSecrets(node, path = '', found = []) {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    if (isSecretName(key) && typeof value === 'string' && value.trim() !== '') {
      found.push(here);
    }
    assertNoSecrets(value, here, found);
  }
  return found;
}

async function writeConfigTemplate() {
  const repoConfig = join(REPO_ROOT, 'nanowork.config.json');
  let template;
  if (existsSync(repoConfig)) {
    // 仓库里那份是开发机配置：含凭据且被 .gitignore 忽略。拷一份**脱敏**的作模板。
    const raw = JSON.parse(await fs.readFile(repoConfig, 'utf-8'));
    template = sanitizeConfig(raw, true);
    log('template', `由仓库配置脱敏生成（workspace 已占位）`);
  } else {
    // CI 里拿不到这份文件（.gitignore）。只写「必须由客户端决定」的那一个字段，
    // 其余交给引擎默认值 —— 不要在这里编造一份看似完整的配置。
    template = { agents: { defaults: { workspace: '__NANOWORK_WORKSPACE__' } } };
    log('template', '仓库配置不存在，生成最小模板（仅 workspace 占位）');
  }
  const leaked = assertNoSecrets(template);
  if (leaked.length > 0) {
    fail(
      `配置模板里仍有凭据字段：${leaked.join('、')}`,
      '把该词补进 SECRET_WORDS，或加进 NOT_SECRET_NAMES 并写明"为什么它不是凭据"',
    );
  }
  const target = join(RT_DIR, 'config.template.json');
  await fs.writeFile(target, `${JSON.stringify(template, null, 2)}\n`, 'utf-8');
  return target;
}

/**
 * 在随包解释器的 site-packages 里写 sitecustomize.py。
 *
 * 只做一件事：把 `<rt>/site` 交给 `site.addsitedir()`，从而让 `.pth` 生效。
 * 路径靠"向上找同时含 site/ 与 python/ 的目录"得到，不在构建期写死，
 * 因此安装到任意位置（含 AppImage 的 /tmp/.mount_xxx）都成立。
 */
async function writeSiteCustomize() {
  const sitePackages = IS_WIN
    ? join(PYTHON_DIR, 'Lib', 'site-packages')
    : join(PYTHON_DIR, 'lib', `python${PBS_PY_MINOR}`, 'site-packages');
  await fs.mkdir(sitePackages, { recursive: true });

  const content = `"""Nanowork: 把 <rt>/site 作为真正的 site 目录接入。

为什么不能用 PYTHONPATH 代替：PYTHONPATH 只往 sys.path 塞目录，**不读 .pth 文件**
（那是 site 模块的职责）。pywin32 依赖 pywin32.pth 挂载 win32/lib 并执行 bootstrap，
只设 PYTHONPATH 时 serve 能起、gateway 一 import mcp 就报 No module named 'pywintypes'。

本文件由 scripts/build-engine.mjs 生成，不要手改。
"""

import site
from pathlib import Path

_target = None
for _ancestor in Path(__file__).resolve().parents:
    if (_ancestor / "site").is_dir() and (_ancestor / "python").is_dir():
        _target = _ancestor / "site"
        break

if _target is not None:
    site.addsitedir(str(_target))
`;

  const target = join(sitePackages, 'sitecustomize.py');
  await fs.writeFile(target, content, 'utf-8');
  log('sitecustomize', `已写入 ${target}`);
}

async function main() {
  const manifestPath = join(RT_DIR, 'manifest.json');
  if (ENSURE_ONLY && existsSync(manifestPath)) {
    log('skip', `已存在 ${manifestPath}（--ensure）`);
    return;
  }

  const engine = await readEngineMeta();
  log(
    'engine',
    `version=${engine.version} commit=${engine.commit.slice(0, 8)}${engine.dirty ? ' (dirty)' : ''}`,
  );
  if (engine.dirty) {
    log('warn', '引擎工作区有未提交改动：产物不可复现，发版前请先提交');
  }

  // ① 引擎 wheel（跳过它自带的 webui 构建，省 7.4 MB）
  await fs.mkdir(WHEEL_DIR, { recursive: true });
  run('uv', ['build', '--wheel', '--out-dir', WHEEL_DIR, '.'], {
    cwd: ENGINE_DIR,
    env: { NANOBOT_SKIP_WEBUI_BUILD: '1' },
  });
  const wheels = (await fs.readdir(WHEEL_DIR)).filter((name) => name.endsWith('.whl'));
  const wheelName = wheels.find((name) => name.startsWith('nanobot'));
  if (!wheelName) fail('uv build 没有产出 nanobot wheel');
  const wheelPath = join(WHEEL_DIR, wheelName);
  const wheelSha = createHash('sha256')
    .update(await fs.readFile(wheelPath))
    .digest('hex');

  // ② 便携解释器
  const asset = await resolvePbsAsset();
  await fs.rm(RT_DIR, { recursive: true, force: true });
  await fs.mkdir(RT_DIR, { recursive: true });

  let pbsAssetName;
  let pbsTag;
  if (asset.kind === 'tarball') {
    pbsAssetName = asset.url.split('/').pop() ?? 'python.tar.gz';
    pbsTag = asset.tag;
    const tarball = await download(asset.url, join(PBS_CACHE, pbsAssetName));
    // PBS install_only 包里顶层就是 python/，直接解到 rt 根即可
    run('tar', ['-xzf', tarball, '-C', RT_DIR]);
  } else {
    /*
     * 装在**系统临时目录**里，再复制进 build/rt。
     *
     * 为什么不直接装到 build/：uv 装完会把 `.temp/.tmpXXX/python` rename 成最终目录，
     * 而在仓库目录内做这个 rename 会被宿主 / 杀软 / 索引服务持有句柄打断，报
     * `拒绝访问 (os error 5)`（本机实测）。临时目录不受这套影响，且天然跨构建复用。
     */
    const uvDir = join(tmpdir(), `nanowork-pbs-${process.platform}`);
    await fs.mkdir(uvDir, { recursive: true });
    run('uv', ['python', 'install', PBS_PY_MINOR], {
      env: { UV_PYTHON_INSTALL_DIR: uvDir },
    });
    const installed = (await fs.readdir(uvDir))
      .filter((name) => name.startsWith('cpython-'))
      .sort();
    const picked = installed.at(-1);
    if (!picked) fail('uv python install 没有产出 cpython-* 目录');
    pbsAssetName = picked;
    pbsTag = 'uv-managed';
    await fs.cp(join(uvDir, picked), PYTHON_DIR, { recursive: true });
  }

  if (!existsSync(pythonExecutable())) {
    fail(`找不到解释器：${pythonExecutable()}`, '检查 PBS 产物是否 install_only 布局');
  }

  // ②b 确保运行期有 pip：插件安装走 `PIP_USER=1` + `python -m pip`，没有 pip 就等于
  //     "渠道依赖永远装不上"，而症状只是一句 pip 不存在。
  if (tryCapture(pythonExecutable(), ['-m', 'pip', '--version'], RT_DIR) === null) {
    log('pip', '随包解释器没有 pip，执行 ensurepip');
    run(pythonExecutable(), ['-m', 'ensurepip', '--upgrade'], { cwd: RT_DIR });
  }

  // ③ 安装引擎与依赖
  const installArgs = [
    'pip',
    'install',
    '--target',
    SITE_DIR,
    '--python',
    pythonExecutable(),
    wheelPath,
    'aiohttp', // serve 的硬依赖（缺了 serve 直接 Exit(1)）
  ];
  const uvAvailable = spawnSync('uv', ['--version']).status === 0;
  if (uvAvailable) {
    run('uv', installArgs);
  } else {
    log('warn', '未找到 uv，回退到随包 pip（速度慢一些，行为一致）');
    run(pythonExecutable(), [
      '-m',
      'pip',
      'install',
      '--target',
      SITE_DIR,
      '--no-warn-script-location',
      wheelPath,
      'aiohttp',
    ]);
  }

  /*
   * ③b 预编译字节码。
   *
   * 必须**单独一步**、而且**可失败**：
   * - 放在 `uv pip install --compile-bytecode` 里时，一旦某个文件编译失败，整条安装
   *   命令以非 0 退出，而 uv 只给一句 "Failed to bytecode-compile"，不说是哪个文件 ——
   *   排查成本极高（本机实测踩过）。
   * - 而 pyc 只是启动优化：没有它引擎照样跑，只是每次冷启多几百毫秒。
   */
  const compile = spawnSync(
    pythonExecutable(),
    ['-m', 'compileall', '-q', '-j', '0', SITE_DIR],
    { stdio: 'inherit', cwd: RT_DIR },
  );
  if (compile.status !== 0) {
    log('warn', '字节码预编译未全部成功：运行不受影响，仅冷启变慢（可忽略）');
  }

  /*
   * ③c 让 `<rt>/site` 成为一个**真正的 site 目录**。
   *
   * PYTHONPATH 只往 sys.path 里塞目录，**完全不读 `.pth` 文件** —— 而 `.pth` 是 site
   * 模块的机制。pywin32 就靠 `pywin32.pth` 挂 `win32` / `win32\lib` 并执行
   * `import pywin32_bootstrap`（那一步还负责 DLL 目录）。
   *
   * 症状非常阴：`serve` 起得来（不 import mcp 的 stdio），`gateway` 一 import mcp 就报
   * `ModuleNotFoundError: No module named 'pywintypes'`。本机实测踩到过。
   *
   * 解法：在随包解释器的 site-packages 里放一个 sitecustomize.py（解释器启动时由
   * site 自动导入），用相对定位找到 `<rt>/site` 并 `site.addsitedir()` —— .pth 的语义
   * 就与正常安装完全一致了。路径不在构建期写死，所以 AppImage / deb / 任意安装目录都能用。
   */
  await writeSiteCustomize();

  // ③d 判据：用**真实运行方式**（-P + PYTHONPATH）探一次关键导入，别等用户去撞
  const probes = ['import nanobot'];
  if (IS_WIN) probes.push('import pywintypes', 'import win32api');
  const probe = spawnSync(
    pythonExecutable(),
    ['-P', '-c', `${probes.join('; ')}; print('nanowork-runtime-probe-ok')`],
    {
      cwd: RT_DIR,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: SITE_DIR, PYTHONIOENCODING: 'utf-8' },
    },
  );
  if (probe.status !== 0 || !(probe.stdout ?? '').includes('nanowork-runtime-probe-ok')) {
    fail(
      `随包运行时的导入自检失败：${(probe.stderr ?? probe.stdout ?? '').trim().split('\n').slice(-4).join(' | ')}`,
      '常见原因：sitecustomize.py 没写进解释器的 site-packages，或缺 .pth 需要的目录',
    );
  }
  log('probe', `导入自检通过（${probes.join(' / ')}）`);

  // ④ 裁剪（best-effort：体积优化不该让发版失败）
  for (const relative of pruneList()) {
    try {
      await fs.rm(join(RT_DIR, relative), { recursive: true, force: true });
    } catch (error) {
      /*
       * 删不掉通常是宿主/杀软/索引服务持有句柄，或开发机上的批量删除保护。
       * 那会让包大几 MB，但运行时行为完全不受影响 —— 因此只告警，不失败。
       */
      log('warn', `裁剪跳过 ${relative}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ⑤ 模板与 manifest
  const templatePath = await writeConfigTemplate();
  const pythonVersion = tryCapture(pythonExecutable(), ['--version'], RT_DIR) ?? 'unknown';
  const site = await dirSize(SITE_DIR);
  const python = await dirSize(PYTHON_DIR);
  const buildId = createHash('sha256')
    .update(`${engine.version}|${engine.commit}|${pythonVersion}|${wheelSha}`)
    .digest('hex')
    .slice(0, 16);

  const manifest = {
    engineVersion: engine.version,
    engineCommit: engine.commit,
    engineDirty: engine.dirty,
    pyVersion: pythonVersion,
    pbsTag,
    pbsAsset: pbsAssetName,
    wheel: wheelName,
    wheelSha256: wheelSha,
    buildId,
    siteFiles: site.files,
    siteBytes: site.bytes,
    builtAt: new Date().toISOString(),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  log('done', `python ${mb(python.bytes)} / site ${mb(site.bytes)}（${site.files} 个文件）`);
  log('done', `buildId=${buildId} 模板=${templatePath}`);
  log('next', '用 node scripts/build-engine.mjs --ensure 可在后续构建中跳过');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
