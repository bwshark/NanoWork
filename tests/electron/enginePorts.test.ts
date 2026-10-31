/**
 * 网关端口落地（`electron/enginePorts.ts`）。
 *
 * 判据只有一条，但它决定"装完能不能用"：**端口被占时必须顺延并把结果写回配置**。
 * 只顺延不写回 = 进程监听 A、我们探测 B，症状是"进程在跑但就绪探测永远等不到"；
 * 只写回不检查 = 下次启动继续撞。
 *
 * `canBind` / `resolvePort` 都是注入的：真 socket 留给 gatewayPort 自己的用例，
 * 这里测的是"判定与写回的编排"。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATEWAY_HEALTH_PORT,
  DEFAULT_GATEWAY_WEBUI_PORT,
  ensureServicePorts,
  type ServicePortsIO,
} from '@/../electron/enginePorts';

const CONFIG = join('C:', 'userdata', 'nanowork.config.json');

function stubIO(initial?: string) {
  let content = initial;
  const writes: string[] = [];
  const io: ServicePortsIO = {
    exists: () => content !== undefined,
    readFile: async () => content as string,
    writeFile: async (_path, data) => {
      content = data;
      writes.push(data);
    },
  };
  return { io, writes, get: () => content };
}

/** busy 里的端口判为不可绑；顺延时返回 preferred + 1 */
function stubBind(busy: number[]) {
  return {
    canBind: async (_host: string, port: number) => !busy.includes(port),
    resolvePort: async (_host: string, preferred: number) => preferred + 1,
  };
}

describe('端口都可用', () => {
  it('保持配置里的值，且不写文件（幂等：否则 mtime 每次启动都变）', async () => {
    const { io, writes } = stubIO(
      JSON.stringify({ gateway: { port: 18790 }, channels: { websocket: { port: 9900 } } }),
    );

    const result = await ensureServicePorts({ configPath: CONFIG, host: '127.0.0.1', io, ...stubBind([]) });

    expect(result).toEqual({ gatewayPort: 18790, webuiPort: 9900, changed: false });
    expect(writes).toEqual([]);
  });
});

describe('端口被占', () => {
  it('health 被占 → 顺延并写回，其它键原样保留', async () => {
    const { io, get } = stubIO(
      JSON.stringify({
        gateway: { port: 18790, restartMode: 'auto' },
        channels: { websocket: { port: 9900 }, sendProgress: true },
        agents: { defaults: { workspace: 'D:/mine' } },
      }),
    );

    const result = await ensureServicePorts({
      configPath: CONFIG,
      host: '127.0.0.1',
      io,
      ...stubBind([18790]),
    });

    expect(result).toMatchObject({ gatewayPort: 18791, webuiPort: 9900, changed: true });
    const saved = JSON.parse(get() ?? '{}');
    expect(saved.gateway.port).toBe(18791);
    // 同一对象里的其它键不能被覆盖掉
    expect(saved.gateway.restartMode).toBe('auto');
    expect(saved.channels.sendProgress).toBe(true);
    expect(saved.channels.websocket.port).toBe(9900);
    expect(saved.agents.defaults.workspace).toBe('D:/mine');
  });

  it('webui 被占 → 只动 channels.websocket.port', async () => {
    const { io, get } = stubIO(
      JSON.stringify({ gateway: { port: 18790 }, channels: { websocket: { port: 9900 } } }),
    );

    const result = await ensureServicePorts({
      configPath: CONFIG,
      host: '127.0.0.1',
      io,
      ...stubBind([9900]),
    });

    expect(result).toMatchObject({ gatewayPort: 18790, webuiPort: 9901, changed: true });
    const saved = JSON.parse(get() ?? '{}');
    expect(saved.channels.websocket.port).toBe(9901);
    expect(saved.gateway.port).toBe(18790);
  });

  it('两个都被占 → 都顺延', async () => {
    const { io } = stubIO(
      JSON.stringify({ gateway: { port: 18790 }, channels: { websocket: { port: 9900 } } }),
    );

    const result = await ensureServicePorts({
      configPath: CONFIG,
      host: '127.0.0.1',
      io,
      ...stubBind([18790, 9900]),
    });

    expect(result).toMatchObject({ gatewayPort: 18791, webuiPort: 9901, changed: true });
  });
});

describe('配置缺失或不可写', () => {
  it('没有配置文件时按默认端口探测，且不试图写文件', async () => {
    const { io, writes } = stubIO(undefined);

    const result = await ensureServicePorts({ configPath: CONFIG, host: '127.0.0.1', io, ...stubBind([]) });

    expect(result).toMatchObject({
      gatewayPort: DEFAULT_GATEWAY_HEALTH_PORT,
      webuiPort: DEFAULT_GATEWAY_WEBUI_PORT,
      changed: false,
    });
    expect(writes).toEqual([]);
  });

  it('没有配置且端口冲突 → 仍返回可用端口，但给出「写不回去」的告警', async () => {
    const { io } = stubIO(undefined);

    const result = await ensureServicePorts({
      configPath: CONFIG,
      host: '127.0.0.1',
      io,
      ...stubBind([DEFAULT_GATEWAY_HEALTH_PORT]),
    });

    expect(result.gatewayPort).toBe(DEFAULT_GATEWAY_HEALTH_PORT + 1);
    expect(result.warning).toContain('无法写回');
  });

  it('写回失败也返回可用端口（本次启动必须能起来），并告警', async () => {
    const initial = JSON.stringify({ gateway: { port: 18790 } });
    const io: ServicePortsIO = {
      exists: () => true,
      readFile: async () => initial,
      writeFile: async () => {
        throw new Error('EROFS');
      },
    };

    const result = await ensureServicePorts({
      configPath: CONFIG,
      host: '127.0.0.1',
      io,
      ...stubBind([18790]),
    });

    expect(result.gatewayPort).toBe(18791);
    expect(result.warning).toContain('EROFS');
  });

  it('配置里的 port 不是合法整数 → 回落到默认值', async () => {
    const { io } = stubIO(JSON.stringify({ gateway: { port: 'abc' }, channels: {} }));

    const result = await ensureServicePorts({ configPath: CONFIG, host: '127.0.0.1', io, ...stubBind([]) });

    expect(result.gatewayPort).toBe(DEFAULT_GATEWAY_HEALTH_PORT);
    expect(result.webuiPort).toBe(DEFAULT_GATEWAY_WEBUI_PORT);
  });
});
