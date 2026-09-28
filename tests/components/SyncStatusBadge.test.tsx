/**
 * 同步状态徽章：五态渲染 + 冲突 toast 的「过渡沿去重」。
 *
 * 锁的是两件易错事：
 * 1. **五态文案/图标映射**：漏一态或两态共用文案（用户分不清「同步中」与「已同步」）；
 * 2. **冲突只弹一次**：若直接对 `status === 'conflict'` 弹 toast，每一轮空闲同步
 *    （默认 30s）都会重复置位 → 变成骚扰。用「非 conflict → conflict」的过渡沿去重，
 *    连续两次相同状态不得重复弹。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SyncStatusBadge } from '@/components/SyncStatusBadge';
import { toast } from '@/components/Toast';
import { resetSyncStatus, setSyncStatus } from '@/sync';
import type { SyncStatus } from '@/sync';
import { mount, unmount } from '../helpers/reactMount';

// 徽章内部用 `useNavigate`：包一层 Router 提供上下文
function renderBadge(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <SyncStatusBadge />
    </MemoryRouter>,
  );
}

afterEach(() => {
  unmount();
  resetSyncStatus();
  vi.restoreAllMocks();
});

describe('SyncStatusBadge', () => {
  it('五态各自渲染出对应文案', () => {
    const host = renderBadge();
    const cases: Array<[SyncStatus, string]> = [
      ['local', '未同步'],
      ['syncing', '同步中'],
      ['synced', '已同步'],
      ['conflict', '同步冲突'],
      ['offline', '离线'],
    ];
    for (const [status, label] of cases) {
      act(() => {
        setSyncStatus({ status });
      });
      expect(host.textContent, `${status} 态文案缺失`).toContain(label);
    }
  });

  it('进入 conflict 过渡沿弹一次 toast', () => {
    const spy = vi.spyOn(toast, 'warning').mockImplementation(() => undefined);
    renderBadge();

    act(() => {
      setSyncStatus({ status: 'conflict' });
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('连续两次相同 conflict 状态不重复弹', () => {
    const spy = vi.spyOn(toast, 'warning').mockImplementation(() => undefined);
    renderBadge();

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
