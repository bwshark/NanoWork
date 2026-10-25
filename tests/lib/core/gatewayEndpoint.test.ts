/**
 * 本地网关地址判据。
 *
 * 这层存在的理由：网关端口是**运行时值**——主进程在首选端口不可用（被占用 / 落在
 * Windows 保留端口区间）时会自动顺延，并把真实端口经 IPC 报给渲染层。渲染层要决定
 * 「这个地址该不该被改成实际端口」，判据就是这里三个函数。
 *
 * 判错的两种代价不对称，用例按这个方向钉：
 * - 把**非本机**地址判成本机 → 用户填的内网网关地址被本地端口覆盖（改坏用户配置）；
 * - 把**本机**地址判成非本机 → 端口漂移后界面一直指向没人监听的端口（表现为「网关离线」
 *   而子进程明明活着，且日志里毫无异常）。
 * 所以「解析不出来一律判非本机」（宁可不同步，不可误同步）。
 */

import { describe, expect, it } from 'vitest';
import {
  gatewayPortOf,
  isLocalGatewayEndpoint,
  localGatewayEndpoint,
  nextGatewayEndpoint,
} from '@/lib/core/gatewayEndpoint';
import { DEFAULT_GATEWAY, DEFAULT_GATEWAY_PORT } from '@/lib/core/constants';

describe('isLocalGatewayEndpoint', () => {
  it('认得三种回环写法', () => {
    expect(isLocalGatewayEndpoint('http://127.0.0.1:18900/v1')).toBe(true);
    expect(isLocalGatewayEndpoint('http://localhost:18900/v1')).toBe(true);
    expect(isLocalGatewayEndpoint('http://[::1]:18900/v1')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isLocalGatewayEndpoint('HTTP://LocalHost:18900/v1')).toBe(true);
  });

  it('内网与公网地址判为非本机（绝不能覆盖用户的远端配置）', () => {
    expect(isLocalGatewayEndpoint('http://10.0.0.8:18900/v1')).toBe(false);
    expect(isLocalGatewayEndpoint('http://192.168.1.20:18900/v1')).toBe(false);
    expect(isLocalGatewayEndpoint('https://gw.example.com/v1')).toBe(false);
  });

  it('空串与非法地址判为非本机，且不抛错', () => {
    expect(isLocalGatewayEndpoint('')).toBe(false);
    expect(isLocalGatewayEndpoint('   ')).toBe(false);
    expect(isLocalGatewayEndpoint('不是地址')).toBe(false);
    expect(isLocalGatewayEndpoint('127.0.0.1:18900')).toBe(false);
  });
});

describe('gatewayPortOf', () => {
  it('取出显式端口', () => {
    expect(gatewayPortOf('http://127.0.0.1:18900/v1')).toBe(18900);
  });

  it('没有显式端口返回 null，而不是 0 / 80', () => {
    // 当成 80 会让「端口是否已对齐」的判定误判为已对齐，于是永远不同步
    expect(gatewayPortOf('http://127.0.0.1/v1')).toBeNull();
    expect(gatewayPortOf('http://localhost/v1')).toBeNull();
  });

  it('非法地址返回 null', () => {
    expect(gatewayPortOf('')).toBeNull();
    expect(gatewayPortOf('http://[::1')).toBeNull();
  });
});

describe('localGatewayEndpoint', () => {
  it('拼出带 /v1 前缀的标准地址', () => {
    expect(localGatewayEndpoint('127.0.0.1', 18900)).toBe('http://127.0.0.1:18900/v1');
  });

  it('与 DEFAULT_GATEWAY 同源：默认常量本身就是本机地址且端口可解析', () => {
    expect(isLocalGatewayEndpoint(DEFAULT_GATEWAY)).toBe(true);
    expect(gatewayPortOf(DEFAULT_GATEWAY)).toBe(DEFAULT_GATEWAY_PORT);
    expect(DEFAULT_GATEWAY).toBe(localGatewayEndpoint('127.0.0.1', DEFAULT_GATEWAY_PORT));
  });
});

describe('nextGatewayEndpoint', () => {
  const running = (port: number | null, host: string | null = '127.0.0.1') => ({
    running: true,
    host,
    port,
  });

  it('主进程报了别的端口就跟着改（这条是「端口漂移后界面仍能连上」的全部依据）', () => {
    // 首选 18900 不可用 → 主进程落在 18901，渲染层必须跟过去
    expect(nextGatewayEndpoint(DEFAULT_GATEWAY, running(18901))).toBe('http://127.0.0.1:18901/v1');
  });

  it('已经对齐时返回 null（避免每轮轮询都写一次 store）', () => {
    expect(nextGatewayEndpoint(DEFAULT_GATEWAY, running(DEFAULT_GATEWAY_PORT))).toBeNull();
  });

  it('复用外部网关也跟着对齐：running=false 但 port 有值（用户先手动 serve 再开桌面端）', () => {
    // 复用路径下 running=false（子进程非本应用托管），但 port 是 isPortInUse
    // 刚验证过的真实监听端口 —— 这正是最需要对齐的场景：不同步则地址停在旧默认
    // 端口上，所有 REST 请求 Failed to fetch（2026-10-18 Dream 审查页真机翻车）。
    expect(
      nextGatewayEndpoint(DEFAULT_GATEWAY, { running: false, host: '127.0.0.1', port: 8900 }),
    ).toBe('http://127.0.0.1:8900/v1');
  });

  it('端口未知时不动地址', () => {
    expect(nextGatewayEndpoint(DEFAULT_GATEWAY, running(null))).toBeNull();
    expect(nextGatewayEndpoint(DEFAULT_GATEWAY, { running: true, host: null, port: null })).toBeNull();
    // 子进程没跑且端口未知（spawn 未就绪 / 已退出清理）→ 无从对齐
    expect(nextGatewayEndpoint(DEFAULT_GATEWAY, { running: false, host: '127.0.0.1', port: null })).toBeNull();
  });

  it('用户填的远端/内网地址绝不被覆盖', () => {
    const remote = 'http://10.0.0.8:18900/v1';
    expect(nextGatewayEndpoint(remote, running(18901))).toBeNull();
    const tunnel = 'https://gw.example.com/v1';
    expect(nextGatewayEndpoint(tunnel, running(18901))).toBeNull();
  });

  it('非法地址不动（宁可不同步，不可把脏值写得更脏）', () => {
    expect(nextGatewayEndpoint('', running(18901))).toBeNull();
    expect(nextGatewayEndpoint('随便写的', running(18901))).toBeNull();
  });

  it('host 缺失时回落到 127.0.0.1', () => {
    expect(nextGatewayEndpoint(DEFAULT_GATEWAY, { running: true, host: null, port: 18901 })).toBe(
      'http://127.0.0.1:18901/v1',
    );
  });

  it('无显式端口的本机地址也会被补齐（不会因为端口一样就放过）', () => {
    // 这种地址连端口都解析不出，`gatewayPortOf` 为 null，必须靠重写地址来兜住
    expect(nextGatewayEndpoint('http://127.0.0.1/v1', running(18900))).toBe('http://127.0.0.1:18900/v1');
  });
});
