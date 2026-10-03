/**
 * 同步状态的展示层：五态映射 + 冲突 toast 的「过渡沿去重」。
 *
 * 侧栏那枚可点击徽章已被**账户入口**取代（`AccountEntry`），提示逻辑随之从组件里
 * 提到 hook（`useSyncConflictToast`），因此这里的测法也换了：映射是纯函数就直测纯函数，
 * toast 用探针组件挂 hook。原先靠挂徽章 + 查 `textContent` 的两条断言本质上测的是
 * 「五态文案有没有映射漏」和「冲突会不会重复弹」，与徽章这层壳无关。
 *
 * 锁的是两件易错事：
 * 1. **五态文案/图标映射**：漏一态或两态共用文案（用户分不清「同步中」与「已同步」）；
 * 2. **冲突只弹一次**：若直接对 `status === 'conflict'` 弹 toast，每一轮空闲同步
 *    （默认 30s）都会重复置位 → 变成骚扰。用「非 conflict → conflict」的过渡沿去重，
 *    连续两次相同状态不得重复弹。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { useSyncConflictToast, syncStatusView } from '@/components/SyncStatus';
import { toast } from '@/components/Toast';
import { resetSyncStatus, setSyncStatus } from '@/sync';
import type { SyncStatus } from '@/sync';
import { mount, unmount } from '../helpers/reactMount';

/** 只挂 hook 的探针：toast 是副作用，不需要任何 UI 承接 */
function Probe() {
  useSyncConflictToast();
  return null;
}

afterEach(() => {
  unmount();
  resetSyncStatus();
  vi.restoreAllMocks();
});

describe('syncStatusView', () => {
  it('五态各自映射出对应文案', () => {
    const cases: Array<[SyncStatus, string]> = [
      ['local', '未同步'],
      ['syncing', '同步中'],
      ['synced', '已同步'],
      ['conflict', '同步冲突'],
      ['offline', '离线'],
    ];
    for (const [status, label] of cases) {
      expect(syncStatusView(status).label, `${status} 态文案缺失`).toBe(label);
    }
  });
});

describe('useSyncConflictToast', () => {
  it('进入 conflict 过渡沿弹一次 toast', () => {
    const spy = vi.spyOn(toast, 'warning').mockImplementation(() => undefined);
    mount(<Probe />);

    act(() => {
      setSyncStatus({ status: 'conflict' });
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('连续两次相同 conflict 状态不重复弹', () => {
    const spy = vi.spyOn(toast, 'warning').mockImplementation(() => undefined);
    mount(<Probe />);

    act(() => {
      setSyncStatus({ status: 'conflict' });
    });
    act(() => {
      setSyncStatus({ status: 'conflict' });
    });
    expect(spy).toHaveBeenCalledTimes(1);

    // 离开 conflict 再回来，才是新的过渡沿 → 再弹一次
    act(() => {
      setSyncStatus({ status: 'synced' });
    });
    act(() => {
      setSyncStatus({ status: 'conflict' });
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
