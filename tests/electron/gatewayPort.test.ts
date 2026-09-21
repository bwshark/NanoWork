/**
 * 网关端口可用性判定与自动顺延。
 *
 * 这里起**真的 socket**（不 mock `node:net`）：被测的行为就是「能不能绑上」，mock 掉传输
 * 只能证明「函数被调用了」，证明不了判定对不对——与本仓库 mcpProbe 的测试纪律一致。
 *
 * ⚠️ 用例一律用**运行时取到的空闲端口**，不写死 18900 / 8900：开发机上网关很可能正跑在首选
 * 端口上，写死会让用例随本机状态时红时绿。
 *
 * 真机证据（2026-09-21，本机）：`8900` 落在 Windows 保留区间 8807–8906 内，`canBindPort` 在
 * 该端口上返回 false（绑定报 WSAEACCES 10013），而 `isPortInUse` 的 connect 探测返回 false
 * （误判为空闲，且连接会一直挂在 SYN_SENT）。这条区间由 Hyper-V / WSL 的 winnat 动态保留，
 * 无法在单测里稳定复现，故此处只钉「被占用 → 顺延」这条可复现的路径。
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { canBindPort, PORT_FALLBACK_SCAN, requestEphemeralPort, resolveGatewayPort } from '../../electron/gatewayPort';

const HOST = '127.0.0.1';

/** 起一个占位服务器占据端口，返回端口与其关闭函数 */
function occupy(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * 占据 `count` 个**连续**端口，返回起始端口。
 * 顺延逻辑要求「下一个端口也不可用」才能验证它真的往后走，因此必须拿到连续的几个。
 */
async function occupyConsecutive(count: number): Promise<{ base: number; close: () => Promise<void> }> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const held: Array<{ port: number; close: () => Promise<void> }> = [];
    try {
      const first = await occupy();
      held.push(first);
      for (let offset = 1; offset < count; offset++) {
        // 端口 0 分配不到相邻端口，故这里显式指定目标端口
        const next = await new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(first.port + offset, HOST, () =>
            resolve({
              port: first.port + offset,
              close: () =>
                new Promise<void>((done) => {
                  server.close(() => done());
                }),
            }),
          );
        });
        held.push(next);
      }
      return {
        base: first.port,
        close: async () => {
          for (const item of held) await item.close();
        },
      };
    } catch {
      // 相邻端口被别的东西占了 → 关掉已持有的重试，换一个起始端口
      for (const item of held) await item.close();
    }
  }
  throw new Error('无法连续占满所需端口，环境过于拥挤');
}

describe('canBindPort', () => {
  it('被占用的端口返回 false，释放后返回 true', async () => {
    const holder = await occupy();
    expect(await canBindPort(HOST, holder.port)).toBe(false);
    await holder.close();
    expect(await canBindPort(HOST, holder.port)).toBe(true);
  });
});

describe('resolveGatewayPort', () => {
  it('首选端口可用时原样返回，不做任何漂移', async () => {
    const holder = await occupy();
    const free = holder.port;
    await holder.close();
    expect(await resolveGatewayPort(HOST, free)).toBe(free);
  });

  it('首选端口与后续候选都被占用时顺延到下一个可用端口', async () => {
    const held = await occupyConsecutive(3);
    try {
      // base、base+1、base+2 全被占 → 应落到 base+3（scan 允许范围内）
      const port = await resolveGatewayPort(HOST, held.base);
      expect(port).toBe(held.base + 3);
      expect(await canBindPort(HOST, port)).toBe(true);
    } finally {
      await held.close();
    }
  });

  it('顺延结果一定落在扫描窗口内，不会跳到任意端口', async () => {
    const held = await occupyConsecutive(2);
    try {
      const port = await resolveGatewayPort(HOST, held.base);
      expect(port).toBeGreaterThan(held.base);
      expect(port).toBeLessThanOrEqual(held.base + PORT_FALLBACK_SCAN);
    } finally {
      await held.close();
    }
  });

  it('扫描窗口内全不可用时回落到系统分配（不抛错、仍可绑定）', async () => {
    const held = await occupyConsecutive(2);
    try {
      // scan = 0 → 只看首选端口，被占即进入系统分配兜底
      const port = await resolveGatewayPort(HOST, held.base, 0);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(held.base);
      expect(await canBindPort(HOST, port)).toBe(true);
    } finally {
      await held.close();
    }
  });
});

describe('requestEphemeralPort', () => {
  it('返回一个当下可绑定的端口', async () => {
    const port = await requestEphemeralPort(HOST);
    expect(port).toBeGreaterThan(0);
    expect(await canBindPort(HOST, port)).toBe(true);
  });
});
