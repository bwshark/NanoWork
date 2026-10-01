/**
 * 同步服务端地址的**运行时取值口**。
 *
 * ## 为什么不直接读 `types.ts` 的 `DEFAULT_SYNC_BASE_URL`
 *
 * 那个常量是**出厂缺省值**（本地开发的 `http://127.0.0.1:8910`），而实际要连哪台服务
 * 是**部署参数**：联调 / 预发 / 正式各不一样，为此改源码再重新打包显然不对。这里给它
 * 加一个 `VITE_SYNC_BASE_URL` 覆盖口：
 *
 * ```bash
 * # 临时联调（vite dev）
 * VITE_SYNC_BASE_URL=https://sync.example.com npm run dev
 * # 或写进 .env.local（vite 约定，不进 git）
 * ```
 *
 * ⚠️ **刻意不放进设置 UI**：它是「这台客户端连哪台服务」，不是用户偏好。放进设置会让人
 * 以为换个地址就能换账号空间，而账号体系是服务端定的。
 *
 * ## 为什么单独一个文件，而不是把 `import.meta.env` 写进 `types.ts`
 *
 * `electron/storageRoutes.ts` import 了 `../src/sync/types`（只取两个 storage key 常量），
 * 而主进程产物是 **esbuild `--format=cjs`**——`import.meta` 在 CJS 里没有合法形态，
 * 一旦 `types.ts` 里出现它，`main.cjs` 就构建不出来，且报错点离真正的改动很远。
 * 所以 env 读取单独成文件，让 `types.ts` 保持「纯常量、可被主进程打包」。
 */

import { DEFAULT_SYNC_BASE_URL } from './types';

/**
 * 当前生效的同步服务端地址（无尾斜杠）。
 *
 * `import.meta.env` 用可选链读：`types.ts` 之外仍有非 vite 环境（Node 直跑脚本、
 * 部分单测）拿不到它，此时应退化成缺省值而不是抛错。
 */
export function resolveSyncBaseUrl(): string {
  const fromEnv = (import.meta.env?.VITE_SYNC_BASE_URL ?? '').trim();
  return (fromEnv || DEFAULT_SYNC_BASE_URL).replace(/\/+$/, '');
}
