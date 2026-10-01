/**
 * 同步运行时单例的 React 订阅入口。
 *
 * ## 为什么单独成文件
 *
 * 1. `runtime.ts` 是**装配层**——它 import 9 个 store 并持有定时器，不该再背上 React；
 * 2. `useSyncStatus.ts` 与 `runtime.ts` 互相 import 会成环（后者要用前者的
 *    `resetSyncStatus`），所以「订阅单例」这件事只能落在第三个模块里。
 *
 * ## 为什么必须订阅而不是读一次
 *
 * `initSyncRuntime()` 在 App 启动块里被 `await`（要等设备号与会话列表就位），而侧栏
 * 账户入口这类常驻 UI 的首次渲染一定早于它。直接 `getSyncRuntime()` 并在渲染期取用
 * 会永远停在 `null`——已登录的用户重启后看到「登录」，且不会自己变回来。
 *
 * 快照必须是稳定引用：`getSyncRuntime()` 返回的正是那个单例对象（或 `null`），
 * 所以 `useSyncExternalStore` 只在单例出现 / 释放时才重渲染。
 */

import { useSyncExternalStore } from 'react';
import { getSyncRuntime, subscribeSyncRuntime } from './runtime';
import type { SyncRuntime } from './runtime';

/** 订阅同步运行时单例；未初始化时返回 `null`。 */
export function useSyncRuntime(): SyncRuntime | null {
  return useSyncExternalStore(subscribeSyncRuntime, getSyncRuntime, getSyncRuntime);
}
