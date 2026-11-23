/**
 * 登录态的**唯一结论**（`none` / `anonymous` / `expired`），侧边栏与各页面共用。
 *
 * ## 为什么必须收敛成一个 hook
 *
 * 原来每个页面各自记一个布尔 `sessionExpired`：只在「本页 401 且换票失败」时置真。
 * 侧边栏却只看 `account.getSession()`（会话还在就算已登录）。于是同一次凭据被吊销，
 * 侧边栏说「xx***@163.com，退出登录」，页面横幅说「登录状态已过期，需要重新登录」——
 * 两句都来自真实数据，却互相打脸。用户只想知道一件事：我到底还算不算登录着。
 *
 * 现在账户自己记住「换票被服务端拒绝」（`SyncAccount.isSessionExpired()`，网络错误
 * 不算），页面与侧边栏订阅同一份事实；页面自己的 401 证据（注入网关的用例、没有
 * `refreshToken` 的网关）以 `rejected` 补进来。
 *
 * ## 三种结论分别是什么意思
 *
 * - `anonymous`：本机没有可用票据（或刚登出）。该说「需要先登录账户」。
 * - `expired`：有会话，但票被服务端拒绝。该说「登录已过期，需要重新登录」，并且
 *   **不能说**「需要先登录账户」——那是另一个事实（用户会以为自己的账号没了）。
 * - `none`：可用。
 */

import { useEffect, useState } from 'react';
import { useSyncRuntime } from './useSyncRuntime';
import type { SyncAccount } from './syncAccount';

export type AuthIssue = 'none' | 'anonymous' | 'expired';

/** 账户此刻的结论（登录态 + 凭据是否已被拒）。 */
function issueOf(account: SyncAccount): AuthIssue {
  if (!account.isAuthenticated()) return 'anonymous';
  // 用例里的假账户可能没实现这个方法：缺它就当「未过期」，而不是让整页崩掉
  return account.isSessionExpired?.() ? 'expired' : 'none';
}

export interface AuthIssueInput {
  /** 是否已拿到可用网关（各页面的 `client !== null`）。`false` = 确实没有票 */
  gatewayReady: boolean;
  /** 本页自己撞到的 401（`kbClient` / `projectClient` 已经先试过换票） */
  rejected?: boolean;
}

export function useAuthIssue({ gatewayReady, rejected = false }: AuthIssueInput): AuthIssue {
  const runtime = useSyncRuntime();
  const [fromAccount, setFromAccount] = useState<AuthIssue>(() =>
    runtime ? issueOf(runtime.account) : 'anonymous',
  );

  useEffect(() => {
    if (!runtime) {
      setFromAccount('anonymous');
      return;
    }
    const read = (): void => setFromAccount(issueOf(runtime.account));
    // 订阅前先补读一次：登录 / 过期都可能发生在订阅建立之前（运行时是启动后异步到的）
    read();
    return runtime.account.subscribe(read);
  }, [runtime]);

  if (!gatewayReady) return 'anonymous';
  /*
   * 账户说「没登录」而网关还在 = 登出后的残留（`client` 的 memo 只依赖 runtime 单例，
   * 不会因登出重建）。此时必须说「需要先登录」，而不是继续用旧网关的数据 / 旧结论。
   * 没有运行时（用例注入网关）时登录态未知，以网关是否存在为准。
   */
  if (runtime !== null && fromAccount === 'anonymous') return 'anonymous';
  if (rejected || fromAccount === 'expired') return 'expired';
  return 'none';
}
