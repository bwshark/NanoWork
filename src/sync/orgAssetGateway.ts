/**
 * 从同步运行时装配组织资产网关（**唯一装配处**，与 `projectGateway.ts` 同构）。
 *
 * 为什么不把 `getSyncRuntime()` 塞进 `lib/orgAsset/orgAssetClient`：`runtime.ts` 已经
 * 依赖 `lib/`，反过来 `lib/` import `sync/` 会成环。装配层留在 sync 侧，方向只剩一条。
 *
 * 没有登录态时返回 `null` —— 那是「确实没有可用的票」，不是「加载中」。页面据此显示
 * 「需要先登录账户」，而不是一个空列表（空列表会被读成「这个组织还没发过东西」）。
 */

import { createOrgAssetGateway } from '@/lib/orgAsset/orgAssetClient';
import type { OrgAssetGateway } from '@/lib/orgAsset/orgAssetClient';
import { resolveSyncBaseUrl } from './baseUrl';
import { getSyncRuntime } from './runtime';

export function createRuntimeOrgAssetGateway(): OrgAssetGateway | null {
  const runtime = getSyncRuntime();
  if (!runtime) return null;
  if (runtime.account.getAccessToken() === null) return null;
  return createOrgAssetGateway({
    baseUrl: resolveSyncBaseUrl(),
    // 初始快照只为「配置里必填 token」这条契约；实际取票一律走 getToken
    token: runtime.account.getAccessToken(),
    getToken: () => runtime.account.getAccessToken(),
    refreshToken: () => runtime.account.refresh(),
  });
}
