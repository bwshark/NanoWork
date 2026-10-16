/**
 * 网关运行态内省（FR-13.4 僵尸清理 + FR-11.9 诊断进程维度）。
 *
 * 用**临时目录 + 注入 pidAlive**，不起真进程——被测的是「什么算僵尸」这条规则，
 * 不是 `process.kill` 的行为（后者由 `isPidAlive` 自己的两条用例覆盖）。
 *
 * 变异验证目标：
 * - 去掉 `stale-foreign-config` 分支 → 「活着的他项目状态文件」用例变红；
 * - 把 `isPidAlive` 的 `EPERM` 改成判死 → 「EPERM 保守判活」用例变红；
 * - `isGatewayStateFileName` 放开成 `startsWith('gateway')` → 「.clients.json / .lock 不碰」用例变红。
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildListenerRows,
  classifyGatewayState,
  collectPortListeners,
  isGatewayStateFileName,
  isPidAlive,
  normalizePathForCompare,
  parseGatewayState,
  parseNetstatListening,
  scanGatewayStates,
  sweepStaleGatewayStates,
  type GatewayStateInfo,
} from '../../electron/gatewayRuntimeState';

const CURRENT_CONFIG = 'D:\\Workspace\\study\\nanowork\\nanowork.config.json';

function info(over: Partial<GatewayStateInfo> = {}): GatewayStateInfo {
  return { pid: null, configPath: null, port: null, startedAt: null, ...over };
}

describe('normalizePathForCompare', () => {
  it('盘符大小写、斜杠方向、末尾分隔符都不影响比较', () => {
    expect(normalizePathForCompare('D:\\A\\b.json')).toBe(normalizePathForCompare('d:/A/b.json'));
    expect(normalizePathForCompare('D:\\A\\b\\')).toBe(normalizePathForCompare('D:\\A\\b'));
  });
});

describe('parseGatewayState', () => {
  it('取出四个字段，缺的一律 null', () => {
    const parsed = parseGatewayState(
      JSON.stringify({ pid: 123, port: 18790, config_path: CURRENT_CONFIG, started_at: 'x' }),
    );
    expect(parsed).toEqual({
      pid: 123,
      configPath: CURRENT_CONFIG,
      port: 18790,
      startedAt: 'x',
    });
    expect(parseGatewayState('{}')).toEqual(info());
  });

  it('非法 JSON / 非对象 / 数组一律 null（调用方按 stale-unparseable 处理）', () => {
    expect(parseGatewayState('{ 半截')).toBeNull();
    expect(parseGatewayState('"string"')).toBeNull();
    expect(parseGatewayState('[1,2]')).toBeNull();
  });

  it('pid 不是数字时按缺失处理（不猜、不 Number() 强转）', () => {
    expect(parseGatewayState('{"pid":"123"}')?.pid).toBeNull();
    expect(parseGatewayState('{"pid":null}')?.pid).toBeNull();
  });
});

describe('classifyGatewayState', () => {
  const alive = () => true;
  const dead = () => false;

  it('解析失败 → stale-unparseable', () => {
    expect(classifyGatewayState(null, { pidAlive: alive, currentConfigPath: CURRENT_CONFIG })).toBe(
      'stale-unparseable',
    );
  });

  it('pid 缺失/非正 → stale-no-pid', () => {
    expect(classifyGatewayState(info(), { pidAlive: alive, currentConfigPath: CURRENT_CONFIG })).toBe(
      'stale-no-pid',
    );
    expect(
      classifyGatewayState(info({ pid: -1 }), { pidAlive: alive, currentConfigPath: CURRENT_CONFIG }),
    ).toBe('stale-no-pid');
  });

  it('pid 已死 → stale-dead-pid（最硬的一条）', () => {
    expect(
      classifyGatewayState(info({ pid: 999, configPath: CURRENT_CONFIG }), {
        pidAlive: dead,
        currentConfigPath: CURRENT_CONFIG,
      }),
    ).toBe('stale-dead-pid');
  });

  it('pid 活着且 config 指纹匹配 → live', () => {
    expect(
      classifyGatewayState(info({ pid: 999, configPath: CURRENT_CONFIG }), {
        pidAlive: alive,
        currentConfigPath: CURRENT_CONFIG,
      }),
    ).toBe('live');
  });

  it('pid 活着但属于别的项目 → stale-foreign-config（本机真实堆过这种）', () => {
    expect(
      classifyGatewayState(
        info({ pid: 999, configPath: 'D:\\Workspace\\Codes\\sciherd-cloud-smartagent\\nanobot.config.json' }),
        { pidAlive: alive, currentConfigPath: CURRENT_CONFIG },
      ),
    ).toBe('stale-foreign-config');
  });

  it('任一侧没有 config 路径 → 跳过指纹判据（「不知道」不等于「不匹配」）', () => {
    expect(
      classifyGatewayState(info({ pid: 999 }), { pidAlive: alive, currentConfigPath: CURRENT_CONFIG }),
    ).toBe('live');
    expect(
      classifyGatewayState(info({ pid: 999, configPath: '/somewhere/else.json' }), {
        pidAlive: alive,
        currentConfigPath: null,
      }),
    ).toBe('live');
  });
});

describe('isPidAlive', () => {
  it('EPERM 判活（跨会话进程；误判活的代价只是多留一个文件）', () => {
    const original = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, sig: number) => {
      const err = new Error('nope') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }) as typeof process.kill;
    try {
      expect(isPidAlive(4242)).toBe(true);
    } finally {
      (process as { kill: typeof process.kill }).kill = original;
    }
  });

  it('ESRCH 判死；pid 非法直接判死', () => {
    const original = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, sig: number) => {
      const err = new Error('nope') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }) as typeof process.kill;
    try {
      expect(isPidAlive(4242)).toBe(false);
    } finally {
      (process as { kill: typeof process.kill }).kill = original;
    }
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  it('自己这个进程是活的', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('isGatewayStateFileName', () => {
  it('只认状态文件本身，.clients.json 与各种 .lock 一律不碰', () => {
    expect(isGatewayStateFileName('gateway.json')).toBe(true);
    expect(isGatewayStateFileName('gateway.2643f60cd27bcdc8.json')).toBe(true);
    // 引擎的 lease 现场：clients 清单与两把文件锁，删了会破坏引用计数
    expect(isGatewayStateFileName('gateway.2643f60cd27bcdc8.clients.json')).toBe(false);
    expect(isGatewayStateFileName('gateway.2643f60cd27bcdc8.json.lock')).toBe(false);
    expect(isGatewayStateFileName('gateway.2643f60cd27bcdc8.json.transition.lock')).toBe(false);
    expect(isGatewayStateFileName('gateway.log')).toBe(false);
    expect(isGatewayStateFileName('other.json')).toBe(false);
    expect(isGatewayStateFileName('gateway.zz.json')).toBe(false);
  });
});

describe('sweepStaleGatewayStates', () => {
  async function tempRunDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'nanowork-run-'));
  }

  async function seed(dir: string, name: string, obj: unknown): Promise<void> {
    await fs.writeFile(join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
  }

  it('死 pid / 他项目 / 解析失败 → 删；活着的同项目 → 留', async () => {
    const dir = await tempRunDir();
    await seed(dir, 'gateway.deadbeefdeadbeef.json', {
      pid: 999_999,
      config_path: CURRENT_CONFIG,
    });
    await seed(dir, 'gateway.cafecafecafecafe.json', {
      pid: 888_888,
      config_path: 'D:\\Workspace\\Codes\\sciherd-cloud-smartagent\\nanobot.config.json',
    });
    await seed(dir, 'gateway.1234567890abcdef.json', '{ 写了一半就崩了');
    await seed(dir, 'gateway.abcdef1234567890.json', { pid: process.pid, config_path: CURRENT_CONFIG });

    const result = await sweepStaleGatewayStates({
      runDir: dir,
      currentConfigPath: CURRENT_CONFIG,
      pidAlive: (pid) => pid === process.pid,
    });

    expect(result.removed.sort()).toEqual([
      'gateway.1234567890abcdef.json',
      'gateway.cafecafecafecafe.json',
      'gateway.deadbeefdeadbeef.json',
    ]);
    expect(result.kept).toEqual(['gateway.abcdef1234567890.json']);
    expect(result.failed).toEqual([]);
    expect((await fs.readdir(dir)).sort()).toEqual(['gateway.abcdef1234567890.json']);
  });

  it('删失败如实记进 failed，且不抛（fail-open）', async () => {
    const dir = await tempRunDir();
    await seed(dir, 'gateway.deadbeefdeadbeef.json', { pid: 999_999, config_path: CURRENT_CONFIG });

    const result = await sweepStaleGatewayStates({
      runDir: dir,
      currentConfigPath: CURRENT_CONFIG,
      pidAlive: () => false,
      removeFile: () => Promise.reject(new Error('EBUSY')),
    });

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual(['gateway.deadbeefdeadbeef.json']);
    // 文件还在——没删掉就是没删掉，不能报成删掉了
    expect(await fs.readdir(dir)).toEqual(['gateway.deadbeefdeadbeef.json']);
  });

  it('run 目录不存在 → 空结果，不抛', async () => {
    const result = await sweepStaleGatewayStates({
      runDir: join(tmpdir(), 'nanowork-run-does-not-exist-xyz'),
      currentConfigPath: CURRENT_CONFIG,
    });
    expect(result).toEqual({ removed: [], kept: [], failed: [], files: [] });
  });

  it('scanGatewayStates 只读不删（诊断包的契约）', async () => {
    const dir = await tempRunDir();
    await seed(dir, 'gateway.deadbeefdeadbeef.json', { pid: 999_999, config_path: CURRENT_CONFIG });

    const files = await scanGatewayStates(dir, {
      currentConfigPath: CURRENT_CONFIG,
      pidAlive: () => false,
    });

    expect(files).toHaveLength(1);
    expect(files[0]!.verdict).toBe('stale-dead-pid');
    expect(files[0]!.info?.pid).toBe(999_999);
    expect(await fs.readdir(dir)).toEqual(['gateway.deadbeefdeadbeef.json']);
  });
});

describe('parseNetstatListening', () => {
  it('只取 LISTENING 行，TCP 与 TCP6 都认', () => {
    const out = [
      '  TCP    127.0.0.1:18900         0.0.0.0:0              LISTENING       86424',
      '  TCP    [::]:9900               [::]:0                 LISTENING       1234',
      '  TCP    127.0.0.1:18900         127.0.0.1:52344        TIME_WAIT       0',
      '  UDP    0.0.0.0:5353            *:*                                    5555',
      '',
    ].join('\r\n');
    expect(parseNetstatListening(out)).toEqual([
      { port: 18900, pid: 86424 },
      { port: 9900, pid: 1234 },
    ]);
  });

  it('空输出 / 完全不匹配 → 空数组', () => {
    expect(parseNetstatListening('')).toEqual([]);
    expect(parseNetstatListening('活动连接\r\n')).toEqual([]);
  });
});

describe('buildListenerRows', () => {
  it('关注的端口逐个有行，没被占的 pid 为 null', () => {
    const rows = buildListenerRows([18900, 18790, 9900], [{ port: 9900, pid: 1234 }]);
    expect(rows).toEqual([
      { port: 18900, pid: null, listening: false },
      { port: 18790, pid: null, listening: false },
      { port: 9900, pid: 1234, listening: true },
    ]);
  });
});

describe('collectPortListeners', () => {
  it('非 Windows 返回 unavailable，不猜', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const r = await collectPortListeners([18900]);
      expect(r).toEqual({ listeners: [], source: 'unavailable' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('netstat 挂了也返回 unavailable，不抛', async () => {
    const r = await collectPortListeners([18900], () => Promise.reject(new Error('boom')));
    expect(r.source).toBe('unavailable');
  });
});
