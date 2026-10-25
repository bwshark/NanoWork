/**
 * 从同步运行时装配知识库网关（**唯一装配处**）。
 *
 * ## 为什么必须收敛到这里
 *
 * 知识库页、专家的知识库绑定、每轮检索的 provider 原来各自 `getAccessToken()` 拿一份
 * 字符串塞进 `KbClientConfig`。那是**快照**：access token 只有 30 分钟寿命
 * （`cloud/app/auth/security.py` 的 `ACCESS_TTL`），快照一过期，页面就永远停在
 * 「需要先登录账户」——而侧边栏同一时刻还显示着登录邮箱，用户看到的是自相矛盾的两句话。
 *
 * 这里改成注入 `getToken`（实时取）+ `refreshToken`（401 时换票），于是：
 * - 配置只建一次也不会过期；
 * - 401 由 `kbClient` 自己刷新重放，不再把「票过期」误报成「未登录」。
 *
 * ## 为什么放在 sync/ 而不是 lib/
 *
 * `lib/kb/kbClient.ts` 是纯函数模块（不读全局状态，用例可直接注入桩）。让它反过来
 * import `sync/runtime` 会成环（`runtime.ts` 已经 import 了 `createKbGateway`）。
 * 装配层在 sync 侧，方向就只剩 sync → lib 一条。
 */

import { createKbGateway } from '@/lib/kb/kbClient';
import type { KbGateway } from '@/lib/kb/kbClient';
import { resolveSyncBaseUrl } from './baseUrl';
import { getSyncRuntime } from './runtime';

/**
 * 装配一个绑定当前登录态的知识库网关；**没有登录态时返回 `null`**。
 *
 * `null` 是「确实没有可用的票」，不是「加载中」：调用方据此显示登录提示，
 * 而不是显示一个空的组织列表（空列表会被读成「我的组织里没有库」）。
 */
export function createRuntimeKbGateway(): KbGateway | null {
  const runtime = getSyncRuntime();
  if (!runtime) return null;
  if (runtime.account.getAccessToken() === null) return null;
  return createKbGateway({
    baseUrl: resolveSyncBaseUrl(),
    // 初始快照只为「配置里必填 token」这条契约；实际取票一律走 getToken
    token: runtime.account.getAccessToken(),
    getToken: () => runtime.account.getAccessToken(),
    // 交给 account：它才知道 refresh token 在哪、轮换后要写回哪里
    refreshToken: () => runtime.account.refresh(),
  });
}
