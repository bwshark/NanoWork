/**
 * 扩展后台服务的纯逻辑（`electron/extensionService.ts`）。
 *
 * 这里的每一条都对应一次"出事了但不报错"：
 *
 * 1. **环境变量泄漏**：`fork` 默认继承父进程环境，等于把 `*_API_KEY` / 网关 token
 *    交给扩展。所以 `buildServiceEnv` 是白名单，用例直接断言"敏感变量不出现"；
 * 2. **日志撑爆内存**：一行几 MB 的堆栈会把环形缓冲变成黑洞，超长必须截断；
 * 3. **崩溃重启风暴**：退避要递增且有上限，否则一个必崩的扩展能把 CPU 打满；
 * 4. **entry 越界**：`../../evil.cjs` 一旦被接受就是"任意 node 脚本执行"。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVICE_LOG_LINES,
  SERVICE_LOG_LINE_MAX,
  appendLogLine,
  buildServiceEnv,
  nextRestartDelay,
  validateServiceEntry,
} from '../../electron/extensionService';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nanowork-ext-svc-'));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

describe('nextRestartDelay', () => {
  it('逐次递增并封顶（不会无限变长，也不会一直是 0）', () => {
    const first = nextRestartDelay(0);
    const second = nextRestartDelay(1);
    const third = nextRestartDelay(2);
    const beyond = nextRestartDelay(9);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThanOrEqual(first);
    expect(third).toBeGreaterThanOrEqual(second);
    expect(beyond).toBe(third);
  });
});

describe('appendLogLine', () => {
  it('只保留最近 N 行（旧行被挤掉，顺序不变）', () => {
    let buffer: string[] = [];
    for (let i = 0; i < SERVICE_LOG_LINES + 5; i += 1) buffer = appendLogLine(buffer, `line-${i}`);
    expect(buffer).toHaveLength(SERVICE_LOG_LINES);
    expect(buffer[buffer.length - 1]).toBe(`line-${SERVICE_LOG_LINES + 4}`);
    expect(buffer[0]).toBe('line-5');
  });

  it('超长行被截断并标注（否则一行堆栈就是几 MB）', () => {
    const [line] = appendLogLine([], 'x'.repeat(SERVICE_LOG_LINE_MAX + 100));
    expect(line.length).toBeLessThanOrEqual(SERVICE_LOG_LINE_MAX + 10);
    expect(line).toContain('已截断');
  });

  it('不修改传入的数组（便于在 store 快照里安全复用）', () => {
    const original = ['a'];
    const next = appendLogLine(original, 'b');
    expect(original).toEqual(['a']);
    expect(next).toEqual(['a', 'b']);
  });
});

describe('buildServiceEnv', () => {
  it('不把宿主的凭据交给扩展（白名单，而不是黑名单）', () => {
    const env = buildServiceEnv('hello', {
      PATH: '/usr/bin',
      HOME: '/home/u',
      DASHSCOPE_API_KEY: 'sk-secret',
      NANOWORK_TOKEN: 'token-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.DASHSCOPE_API_KEY).toBeUndefined();
    expect(env.NANOWORK_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('带上扩展标识，并明确标注是受限环境', () => {
    const env = buildServiceEnv('hello', {});
    expect(env.NANOWORK_EXTENSION_ID).toBe('hello');
    expect(env.NANOWORK_EXTENSION_ENV).toBe('restricted');
  });
});

describe('validateServiceEntry', () => {
  it('包内 js 入口通过', async () => {
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server', 'index.cjs'), 'console.log(1)', 'utf8');
    const result = await validateServiceEntry(root, {
      entry: './server/index.cjs',
      process: 'fork',
    });
    expect(result.ok).toBe(true);
  });

  it('越界 entry 被拒（这是"任意脚本执行"的唯一一道门）', async () => {
    const outside = join(root, '..', 'evil.cjs');
    writeFileSync(outside, 'x', 'utf8');
    const result = await validateServiceEntry(root, { entry: '../evil.cjs', process: 'fork' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('越出');
    rmSync(outside, { force: true });
  });

  it('入口不存在时如实报错（不静默变成"启动了但没进程"）', async () => {
    const result = await validateServiceEntry(root, {
      entry: './server/missing.cjs',
      process: 'fork',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('不存在');
  });

  it('非 fork 进程模型被拒', async () => {
    const result = await validateServiceEntry(root, {
      entry: './server/index.cjs',
      // 故意构造非法取值：清单层已拦，函数自身也要守住（可能被直接调用）
      process: 'spawn' as unknown as 'fork',
    });
    expect(result.ok).toBe(false);
  });
});
