import { isElectron } from '@/platform/env';
import { createElectronEventStore } from './electronStore';
import { createWebEventStore } from './webStore';
import type { EventStore } from './store';

/**
 * 事件存储入口（D2）。
 *
 * 与 `src/ai/runtime` 的 `getRuntime()` 同构：**惰性单例 + 平台分派**。
 * 渲染层一律从这里取存储，禁止直接 import `electronStore` / `webStore`——
 * 否则平台降级分支会被绕过（Web 上会拿到依赖 `window.electronAPI` 的实现）。
 *
 * 需要按其它维度切换实现（例如未来的 ACP 存储后端）时，收敛点就在这里：
 * 只改本文件的 `create()`，调用方不动。
 */
let instance: EventStore | null = null;

function create(): EventStore {
  return isElectron() ? createElectronEventStore() : createWebEventStore();
}

/** 取事件存储（惰性单例，按平台分派） */
export function getEventStore(): EventStore {
  if (!instance) instance = create();
  return instance;
}

/**
 * 仅供测试：替换 / 重置实现。
 * @param next 传入新实现，或 `null` 重置为默认实现
 */
export function __setEventStoreForTest(next: EventStore | null): void {
  instance = next;
}

export * from './store';
export * from './indexFile';
export * from './project';
export * from './recorder';
