/**
 * 网关端口的可用性判定与自动顺延。
 *
 * 单独成模块（而不是留在 `main.ts` 里）的原因与本仓库其他纯模块一致：`main.ts` 顶层依赖
 * Electron app ready 与一堆副作用，**无法被 import**，逻辑放在那里就永远测不到。抽出来之后
 * 这里只依赖 `node:net`，可以直接起真 socket 断言。
 *
 * ## 为什么要 bind 而不能只 connect
 *
 * 端口「不可用」有两种成因，而 `isPortInUse` 那种 connect 探测只能认出前者：
 *
 * | 成因 | 报错 | connect 探测的表现 |
 * |---|---|---|
 * | 已被别的进程占用 | `EADDRINUSE` / winerror 10048 | 连得上 → 判为「在用」✓ |
 * | 落在系统保留区间 | `EACCES` / winerror 10013 | **连不上也收不到拒绝**（SYN 被丢弃）→ 误判为「空闲」✗ |
 *
 * 第二种就是 Windows 上「明明没有任何进程占用、serve 却启动即崩」的原因：Hyper-V / WSL 的
 * winnat 会动态保留成段端口（`netsh interface ipv4 show excludedportrange protocol=tcp` 可查），
 * 落在其中的端口**任何进程都绑不上**。只有真的 bind 一次才能确定端口可用。
 */

import { createServer } from 'node:net';

/**
 * 探测 host:port 是否**能被绑定**（本机是否真的能在这里起服务）。
 * @param host 目标主机
 * @param port 目标端口
 * @returns 是否可以绑定
 */
export function canBindPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ host, port, exclusive: true });
  });
}

/** 首选端口不可用时，向后顺延探测的候选个数 */
export const PORT_FALLBACK_SCAN = 20;

/**
 * 让操作系统分配一个空闲端口（listen 0 后立即释放）。
 * 系统分配时会跳过保留区间，因此这是「所有候选都不可用」时唯一稳妥的兜底。
 * @param host 目标主机
 * @returns 系统分配到的端口
 */
export function requestEphemeralPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 解析实际可用的网关端口。
 *
 * 首选端口可用则原样返回；否则从 `preferred + 1` 起顺延探测 `PORT_FALLBACK_SCAN` 个候选；
 * 仍全部不可用则回落到让系统分配一个空闲端口。
 *
 * 为什么保留最后的兜底而不是直接报错：端口只是一个本地约定，主进程与渲染层之间靠
 * `nanobot:gatewayInfo` 协商对齐。宁可端口漂移（界面自动跟随），也不要让整机对话能力因为
 * 一个端口号整体瘫痪——这才是「自动找一个闲置端口」的完整语义。
 * @param host 目标主机
 * @param preferred 首选端口（配置值）
 * @param scan 顺延探测的候选个数
 * @returns 可用于监听的端口
 */
export async function resolveGatewayPort(
  host: string,
  preferred: number,
  scan: number = PORT_FALLBACK_SCAN,
): Promise<number> {
  if (await canBindPort(host, preferred)) return preferred;
  for (let port = preferred + 1; port <= preferred + scan; port++) {
    if (await canBindPort(host, port)) return port;
  }
  return await requestEphemeralPort(host);
}
