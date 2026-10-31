/**
 * 引擎子进程的环境构造（打包态的唯一入口）。
 *
 * ## 为什么必须有这个模块
 *
 * 打包后引擎不是"本机某个 venv 里的 python"，而是随包的便携解释器。它能不能起来，
 * 有一半取决于**进程环境**：`PYTHONPATH` 指不指得到 `rt/site`、`PYTHONHOME` 有没有被
 * 继承污染、`PIP_USER` 开没开（插件安装要往只读区之外写）、`TIKTOKEN_CACHE_DIR`
 * 有没有预置（首次分词会联网）。
 *
 * 这些变量如果散落在各个 `spawn` 调用点手写，迟早会出现"一个进程设了、另一个没设"——
 * 症状是 serve 正常但 gateway 起不来，或者反过来，而日志里一个字都不会提环境。
 *
 * ## 与 `sanitizeGatewayEnv` 的关系
 *
 * 原来的 CA 变量清理（指向不存在文件的 `SSL_CERT_FILE` 等会让 httpx 直接抛
 * `FileNotFoundError`）**原样搬进来**，不另写一份：清理 CA 与注入运行时变量是同一
 * 件事的两个步骤，都发生在"把一个干净的 env 交给引擎"这一刻。
 *
 * @see docs/plan-packaging-and-release.md §3.3
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { EngineLayout } from './engineSelfCheck';

/** 指向证书文件的环境变量：值指向不存在的文件时，httpx 建连会直接抛错 */
const CA_FILE_VARS = [
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTPLIB2_CA_CERTS',
] as const;

export interface EngineEnvOptions {
  /** `repo`（开发态）只做 CA 清理；`bundle`（打包态）额外注入运行时变量 */
  layout: EngineLayout;
  /** bundle 下是 `<resources>/rt`；repo 下不使用 */
  runtimeRoot: string;
  /** `app.getPath('userData')`：插件落点与分词缓存都挂在这里 */
  userData: string;
  baseEnv?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * 大小写不敏感地删除一个变量。
 *
 * Windows 的环境变量名不区分大小写，而 `process.env` 的键保留创建时的大小写：
 * 用户机器上完全可能存在 `PythonPath` / `PythonHome`。只 `delete env['PYTHONPATH']`
 * 会把它们留下来，而 Python 启动时是**大小写不敏感**读取的 —— 于是"我明明设了
 * PYTHONPATH"变成一句无法复现的抱怨。
 */
function deleteEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): void {
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) delete env[key];
  }
}

/**
 * 大小写不敏感地找环境变量的**实际键名**。
 *
 * Windows 上常见的是 `Path` 而不是 `PATH`：直接写 `env.PATH = ...` 会多出一个新键，
 * 而 Windows 取的是第一个（大小写不敏感）匹配，于是我明明加进去了却不生效。
 */
function findEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper);
}

/**
 * 构造交给引擎子进程的环境。
 *
 * 纯函数（IO 可注入）：`exists` 只用于判断 CA 目录是否存在，测试可替换。
 */
export function buildEngineEnv(options: EngineEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
  const exists = options.exists ?? existsSync;

  // ① 原有的 CA 清理（行为与 sanitizeGatewayEnv 逐字一致）
  for (const key of CA_FILE_VARS) {
    const value = env[key];
    if (value && !exists(value)) delete env[key];
  }
  // SSL_CERT_DIR 是目录，缺失同样会让 ssl 上下文初始化失败
  const certDir = env['SSL_CERT_DIR'];
  if (certDir && !exists(certDir)) delete env['SSL_CERT_DIR'];

  if (options.layout !== 'bundle') return env;

  // ② 打包态：先清掉继承的 Python 变量，再注入我们的
  //    PYTHONHOME 一旦继承，Python 会去加载别处的 stdlib → ModuleNotFoundError 满天飞
  deleteEnvCaseInsensitive(env, 'PYTHONHOME');
  deleteEnvCaseInsensitive(env, 'PYTHONPATH');

  env['PYTHONPATH'] = join(options.runtimeRoot, 'site');
  // 插件 `pip install` 落到 userData，而不是只读的 rt/site（AppImage / deb / Program Files）
  env['PYTHONUSERBASE'] = join(options.userData, 'pyuser');
  env['PIP_USER'] = '1';
  // Windows 控制台默认 GBK：引擎日志里有中文，编码异常会把进程打挂
  env['PYTHONUTF8'] = '1';
  env['PYTHONIOENCODING'] = 'utf-8';
  // 只读挂载点写 pyc 会**静默失败**：构建期已 --compile-bytecode 预编译，这里禁写
  env['PYTHONDONTWRITEBYTECODE'] = '1';
  // tiktoken 首次 get_encoding 会联网下载 BPE；缓存预置在这里才算离线可用
  env['TIKTOKEN_CACHE_DIR'] = join(options.userData, 'tiktoken');

  /*
   * ③ 把随包解释器放到 PATH **最前面**。
   *
   * 为什么必须做：引擎的 shell 工具执行的是模型写的命令，里面常出现裸 `python`
   * （`python -m http.server 8000`、`python build.py`）。真机上 PATH 第一个 `python`
   * 是**用户自己装的那个** —— 实测踩到 `C:\python27\python.exe`：脚本因 Python 2 语法
   * 直接失败，而 Windows 防火墙弹窗会把这个野路径亮给用户（"Publisher: Unknown"），
   * 用户根本认不出那是谁的程序。
   *
   * 前置之后：裸 `python` 命中的是随包 3.12，路径落在安装目录内；功能与"弹窗里显示的
   * 那个路径"都可预期。**不能覆盖已有的 PATH** —— 插件与工具还要用 curl、git、node。
   */
  const pythonDirs =
    process.platform === 'win32'
      ? [join(options.runtimeRoot, 'python'), join(options.runtimeRoot, 'python', 'Scripts')]
      : [join(options.runtimeRoot, 'python', 'bin')];
  const pathKey = findEnvKey(env, 'PATH') ?? 'PATH';
  const inheritedPath = env[pathKey] ?? '';
  const pathParts = inheritedPath.split(delimiter).filter(Boolean);
  const alreadyFirst = pathParts[0] === pythonDirs[0];
  if (!alreadyFirst) {
    env[pathKey] = [...pythonDirs, ...pathParts].join(delimiter);
  }

  return env;
}
