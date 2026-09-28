/**
 * `useSyncStatus`：vanilla store 的读写 / 订阅 + React hook 的订阅渲染。
 *
 * 分两层验证：
 * - vanilla 层（引擎直接用的）：快照合并、订阅通知、取消订阅、重置；
 * - hook 层（UI 用的）：`useSyncExternalStore` 在状态变化时驱动重渲染。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { mount, unmount } from '../helpers/reactMount';
import {
  getSyncStatus,
  resetSyncStatus,
  setSyncStatus,
  subscribeSyncStatus,
  useSyncStatus,
} from '@/sync/useSyncStatus';

// 告知 React「当前是 act 环境」，消除 `act(...)` 未配置的告警
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INITIAL = {
  status: 'local',
  lastSyncedAt: null,
  pendingCount: 0,
  conflictCount: 0,
  lastError: null,
} as const;

afterEach(() => {
  unmount();
  resetSyncStatus();
  vi.restoreAllMocks();
});

describe('vanilla store', () => {
  it('初始态是 local 且计数为 0', () => {
    expect(getSyncStatus()).toEqual(INITIAL);
  });

  it('setSyncStatus 合并补丁并通知订阅者', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeSyncStatus(cb);

    setSyncStatus({ status: 'syncing' });
    expect(getSyncStatus().status).toBe('syncing');
    expect(cb).toHaveBeenCalledTimes(1);

    setSyncStatus({ pendingCount: 3, lastError: 'boom' });
    expect(getSyncStatus()).toMatchObject({ status: 'syncing', pendingCount: 3, lastError: 'boom' });
    expect(cb).toHaveBeenCalledTimes(2);

    unsubscribe();
    setSyncStatus({ status: 'synced' });
    expect(cb).toHaveBeenCalledTimes(2); // 取消后不再通知
  });

  it('setSyncStatus 产出新引用（useSyncExternalStore 据此重渲染）', () => {
    const before = getSyncStatus();
    setSyncStatus({ status: 'synced' });
    expect(getSyncStatus()).not.toBe(before);
  });

  it('resetSyncStatus 回到初始态', () => {
    setSyncStatus({ status: 'conflict', conflictCount: 2, lastError: 'x' });
    resetSyncStatus();
    expect(getSyncStatus()).toEqual(INITIAL);
  });
});

describe('useSyncStatus（React hook）', () => {
  function Probe(): ReactElement {
    const status = useSyncStatus();
    return createElement('span', null, `${status.status}:${status.pendingCount}:${status.conflictCount}`);
  }

  it('订阅外部 store：状态变化驱动重渲染', () => {
    const host = mount(createElement(Probe));
    expect(host.textContent).toBe('local:0:0');

    act(() => {
      setSyncStatus({ status: 'synced', pendingCount: 1, conflictCount: 2 });
    });
    expect(host.textContent).toBe('synced:1:2');
  });
});
