/**
 * 从同步运行时装配内置模型目录的取数器（**唯一装配处**）。
 *
 * ## 为什么不能用 `getSyncRuntime()` 自己取
 *
 * 单例在启动过程里有一段时间还没就位（`initSyncRuntime()` 是个异步块）。`App.tsx`
 * 拿到 runtime 的那一刻正好该注入它——传入实例，装配结果就**天然不依赖**「此刻单例
 * 建好了没有」，也不必再写一层「等单例出现再重试」的等待逻辑。
 *
 * ## 为什么这里注入、而不是 store 直接 import
 *
 * `modelsStore` 被大量 UI 依赖；让它 import `sync/runtime` 会形成
 * `runtime → (若干 store) → modelsStore → runtime` 的环。依赖方向只能是
 * 「装配处（App）→ 两边」，与知识库检索的 `setKnowledgeSearchProvider` 同一手法。
 */

import { fetchBuiltinModels, type BuiltinModelsResult } from '@/lib/model/builtinModelsClient';
import { resolveSyncBaseUrl } from './baseUrl';
import type { SyncRuntime } from './runtime';

/**
 * 取一次内置模型目录。
 *
 * `getToken` / `refreshToken` 都接到 account 上：票会轮换，而配置只建一次。
 * `refresh()` 自带单飞（服务端是轮换 + 重用检测，同一张旧 refresh 用两次会吊销
 * 整条链），所以这里并发调用是安全的。
 */
export function createBuiltinModelsFetcher(
  runtime: SyncRuntime,
): () => Promise<BuiltinModelsResult> {
  const baseUrl = resolveSyncBaseUrl();
  return () =>
    fetchBuiltinModels({
      baseUrl,
      token: runtime.account.getAccessToken(),
      getToken: () => runtime.account.getAccessToken(),
      refreshToken: () => runtime.account.refresh(),
    });
}
