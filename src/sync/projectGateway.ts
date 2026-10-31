/**
 * 从同步运行时装配项目空间网关（**唯一装配处**，与 `kbGateway.ts` 同构）。
 *
 * 为什么不把 `getSyncRuntime()` 塞进 `lib/project/projectClient`：`runtime.ts` 已经
 * 依赖 `lib/`，反过来 `lib/` import `sync/` 会成环（`runtime → store → … → runtime`）。
 * 装配层留在 sync 侧，方向就只剩一条。
 *
 * 没有登录态时返回 `null` —— 那是「确实没有可用的票」，不是「加载中」。页面据此显示
 * 「需要先登录账户」，而不是一个空项目列表（空列表会被读成「这个团队没有项目」）。
 */

import { createProjectGateway } from '@/lib/project/projectClient';
import type { ProjectGateway } from '@/lib/project/projectClient';
import { resolveSyncBaseUrl } from './baseUrl';
import { getSyncRuntime } from './runtime';

export function createRuntimeProjectGateway(): ProjectGateway | null {
  const runtime = getSyncRuntime();
  if (!runtime) return null;
  if (runtime.account.getAccessToken() === null) return null;
  return createProjectGateway({
    baseUrl: resolveSyncBaseUrl(),
    // 初始快照只为「配置里必填 token」这条契约；实际取票一律走 getToken
    token: runtime.account.getAccessToken(),
    getToken: () => runtime.account.getAccessToken(),
    // 交给 account：它才知道 refresh token 在哪、轮换后要写回哪里（且自带单飞）
    refreshToken: () => runtime.account.refresh(),
  });
}
