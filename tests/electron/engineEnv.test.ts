/**
 * 引擎子进程环境的构造（`electron/engineEnv.ts`）。
 *
 * 这里钉的是**三条会静默出错的规则**：
 *
 * 1. dev 布局不许注入 PYTHONPATH —— 那个 venv 已经自己管好了 import 路径，
 *    多指一个不存在的 `rt/site` 会让引擎在开发机上直接起不来。
 * 2. 打包布局必须**先清掉继承的** PYTHONHOME/PYTHONPATH 再注入 —— 用户机器上完全
 *    可能存在 `PythonPath` 这种大小写变体，而 Python 读取时是大小写不敏感的。
 * 3. CA 变量清理在两种布局下都要做（原 `sanitizeGatewayEnv` 的行为不能丢）。
 */

import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEngineEnv } from '@/../electron/engineEnv';

const RT = join('C:', 'app', 'resources', 'rt');
const USER_DATA = join('C:', 'userdata');

const bundleOptions = {
  layout: 'bundle' as const,
  runtimeRoot: RT,
  userData: USER_DATA,
};

describe('bundle（打包态）', () => {
  it('注入 8 项运行时变量', () => {
    const env = buildEngineEnv({ ...bundleOptions, baseEnv: {} });

    expect(env['PYTHONPATH']).toBe(join(RT, 'site'));
    expect(env['PYTHONUSERBASE']).toBe(join(USER_DATA, 'pyuser'));
    expect(env['PIP_USER']).toBe('1');
    expect(env['PYTHONUTF8']).toBe('1');
    expect(env['PYTHONIOENCODING']).toBe('utf-8');
    expect(env['PYTHONDONTWRITEBYTECODE']).toBe('1');
    expect(env['TIKTOKEN_CACHE_DIR']).toBe(join(USER_DATA, 'tiktoken'));
  });

  it('先清掉继承的 PYTHONHOME / PYTHONPATH（大小写不敏感）', () => {
    // Windows 的 env 键保留创建时大小写，而 Python 读取时不区分大小写：
    // 只 delete 大写那份，会留下 PythonPath 继续劫持 import
    const env = buildEngineEnv({
      ...bundleOptions,
      baseEnv: {
        PYTHONHOME: 'D:\\other\\python',
        PythonPath: 'D:\\stale\\site-packages',
      },
    });

    expect(env['PYTHONHOME']).toBeUndefined();
    expect(env['PythonPath']).toBeUndefined();
    expect(env['PYTHONPATH']).toBe(join(RT, 'site'));
  });

  it('不碰无关变量（代理/自定义变量要保留，否则需要代理的场景直接断网）', () => {
    const env = buildEngineEnv({
      ...bundleOptions,
      baseEnv: { HTTPS_PROXY: 'http://127.0.0.1:7890', NANOWORK_CUSTOM: 'keep-me' },
    });

    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:7890');
    expect(env['NANOWORK_CUSTOM']).toBe('keep-me');
  });
});

describe('repo（开发态）', () => {
  it('不注入 PYTHONPATH / PIP_USER（venv 自己管 import 路径）', () => {
    const env = buildEngineEnv({
      layout: 'repo',
      runtimeRoot: join('D:', 'proj'),
      userData: USER_DATA,
      baseEnv: { PATH: '/usr/bin' },
    });

    expect(env['PYTHONPATH']).toBeUndefined();
    expect(env['PIP_USER']).toBeUndefined();
    expect(env['PYTHONHOME']).toBeUndefined();
  });

  it('仍然清理指向不存在文件的 CA 变量（原 sanitizeGatewayEnv 的行为）', () => {
    const missing = join('C:', 'nope', 'ca.pem');
    const env = buildEngineEnv({
      layout: 'repo',
      runtimeRoot: join('D:', 'proj'),
      userData: USER_DATA,
      baseEnv: { SSL_CERT_FILE: missing, REQUESTS_CA_BUNDLE: missing, SSL_CERT_DIR: missing },
      exists: () => false,
    });

    expect(env['SSL_CERT_FILE']).toBeUndefined();
    expect(env['REQUESTS_CA_BUNDLE']).toBeUndefined();
    expect(env['SSL_CERT_DIR']).toBeUndefined();
  });

  it('CA 文件真实存在时保留（不能无条件删，那会让企业自签证书场景失效）', () => {
    const env = buildEngineEnv({
      layout: 'repo',
      runtimeRoot: join('D:', 'proj'),
      userData: USER_DATA,
      baseEnv: { SSL_CERT_FILE: join('C:', 'corp', 'ca.pem') },
      exists: () => true,
    });

    expect(env['SSL_CERT_FILE']).toBe(join('C:', 'corp', 'ca.pem'));
  });
});

describe('不修改传入的 baseEnv', () => {
  it('返回新对象，原地删除不会污染调用方的 process.env 快照', () => {
    const base: NodeJS.ProcessEnv = { PYTHONHOME: 'x', SSL_CERT_FILE: 'y' };
    buildEngineEnv({ ...bundleOptions, baseEnv: base, exists: () => false });

    expect(base['PYTHONHOME']).toBe('x');
    expect(base['SSL_CERT_FILE']).toBe('y');
  });
});

describe('PATH 收口（裸 python 必须命中随包解释器）', () => {
  // 引擎的 shell 工具跑的是模型写的命令，里面常出现裸 `python`。
  // 真机上 PATH 第一个 python 可能是 `C:/python27/python.exe`：脚本因 py2 语法失败，
  // 防火墙弹窗还会把这个野路径当成"我们的程序"亮给用户看。
  const pythonBin = join(RT, 'python');
  const pythonScripts = join(RT, 'python', 'Scripts');

  it('打包态：rt/python 与 rt/python/Scripts 排在 PATH 最前，原有项一个不丢', () => {
    const inherited = ['C://Windows//system32', 'C://python27'].join(delimiter);
    const env = buildEngineEnv({ ...bundleOptions, baseEnv: { Path: inherited } });

    const parts = env['Path']?.split(delimiter) ?? [];
    expect(parts.slice(0, 2)).toEqual([pythonBin, pythonScripts]);
    expect(parts).toContain('C://Windows//system32');
    expect(parts).toContain('C://python27');
    // 键名必须复用已有的 `Path`，不能额外造一个 `PATH`（Windows 取第一个匹配）
    expect(env['PATH']).toBeUndefined();
  });

  it('重复调用不会把目录越叠越多', () => {
    const once = buildEngineEnv({ ...bundleOptions, baseEnv: { PATH: 'C://Windows' } });
    const twice = buildEngineEnv({ ...bundleOptions, baseEnv: once });

    const parts = twice['PATH']?.split(delimiter) ?? [];
    expect(parts.filter((part) => part === pythonBin)).toHaveLength(1);
  });

  it('dev（repo）布局不碰 PATH：那个 venv 自己就是对的，改 PATH 只会串味', () => {
    const inherited = 'C://Windows;C://python27';
    const env = buildEngineEnv({
      layout: 'repo',
      runtimeRoot: RT,
      userData: USER_DATA,
      baseEnv: { PATH: inherited },
    });

    expect(env['PATH']).toBe(inherited);
  });
});
