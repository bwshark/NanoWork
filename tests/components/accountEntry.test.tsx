/**
 * 侧边栏底部账户入口（`AccountEntry`）。
 *
 * 钉住四件用户可见的事：
 * 1. **未登录** → 一行「登录」，点它去登录 / 注册页（既不是弹窗，也不是设置分区）；
 * 2. **已登录** → 头像 + **掩码**账号名（侧栏是常驻可见区域，不铺明文）；
 * 3. 点账号名弹出菜单：**设置 / 意见反馈 / 退出登录**（设置从侧栏独立一行挪进来了）；
 * 4. 菜单项真的接线：「设置」开设置弹窗、「意见反馈」开反馈页、退出登录断开并回到未登录态。
 * 5. **过期态**（换票被服务端拒绝）自己一套说法：入口写「登录已过期」，菜单首项「重新登录」，
 *    最后一项改叫「清除本机登录信息」——**不能**再出现「退出登录」，那与「已过期」互相打脸。
 *
 * 还钉住一条容易做错、错了也不报错的**时序**：同步运行时是**启动后异步**出现的
 * （App 启动块要等设备号与会话列表），而本组件在首屏就挂载了。若只在渲染期读一次单例，
 * 冷启动的已登录用户会一直停在「登录」。所以这里的假 hook 做成**可广播**的：
 * 单例晚到的那一次必须能驱动组件重读会话。
 *
 * `@/sync` 整体替换为「可广播的假 runtime」（桩法与 auth.test.tsx 一致），
 * `@/platform` 只替换 `openUrl`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const syncMocks = vi.hoisted(() => {
  type Session = { userId: string; email: string; access: string; refresh: string };

  /** 账户态：登录 / 登出的唯一广播源（与真实 `syncAccount` 的订阅语义一致） */
  const accountListeners = new Set<() => void>();
  const box: { session: Session | null; runtime: unknown; expired: boolean } = {
    session: null,
    runtime: null,
    expired: false,
  };
  const emitAccount = (): void => {
    for (const listener of Array.from(accountListeners)) listener();
  };

  const account = {
    getSession: () => box.session,
    isAuthenticated: () => box.session !== null,
    getAccessToken: () => box.session?.access ?? null,
    /** 换票被服务端拒绝的标记（真实实现见 `syncAccount.refreshOnce`） */
    isSessionExpired: () => box.expired,
    load: async () => undefined,
    setSession: async (next: Session) => {
      box.session = next;
      box.expired = false;
      emitAccount();
    },
    clearSession: async () => {
      box.session = null;
      box.expired = false;
      emitAccount();
    },
    refresh: async () => false,
    login: async () => {
      throw new Error('本用例不覆盖登录表单流程');
    },
    register: async () => {
      throw new Error('本用例不覆盖注册表单流程');
    },
    logout: async () => {
      box.session = null;
      box.expired = false;
      emitAccount();
    },
    deleteAccount: async () => undefined,
    subscribe: (cb: () => void) => {
      accountListeners.add(cb);
      return () => {
        accountListeners.delete(cb);
      };
    },
  };

  /** 单例可用性广播（真实实现见 `src/sync/runtime.ts`） */
  const runtimeListeners = new Set<() => void>();

  return {
    box,
    account,
    runtime: { account } as unknown,
    accountListeners,
    runtimeListeners,
    emitRuntime: (): void => {
      for (const listener of Array.from(runtimeListeners)) listener();
    },
    subscribeRuntime: (cb: () => void): (() => void) => {
      runtimeListeners.add(cb);
      return () => {
        runtimeListeners.delete(cb);
      };
    },
  };
});

const platformMocks = vi.hoisted(() => ({
  openUrl: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync')>();
  const { useSyncExternalStore } = await import('react');
  return {
    ...actual,
    getSyncRuntime: () => syncMocks.box.runtime,
    initSyncRuntime: async () => syncMocks.box.runtime,
    // 与真实实现同构（订阅 + 稳定快照），否则测不出「单例晚到 → 组件重读会话」这条路径
    useSyncRuntime: () =>
      useSyncExternalStore(
        syncMocks.subscribeRuntime,
        () => syncMocks.box.runtime,
        () => syncMocks.box.runtime,
      ),
  };
});

vi.mock('@/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform')>();
  return {
    ...actual,
    platform: { ...actual.platform, openUrl: platformMocks.openUrl },
  };
});

import { AccountEntry, maskAccountLabel } from '@/components/AccountEntry';
import { FEEDBACK_URL, ROUTES } from '@/lib/core/constants';
import { useSettingsUiStore } from '@/stores/settingsUiStore';
import { byAria, click, flush, mount, unmount } from '../helpers/reactMount';

const SESSION = {
  userId: 'u1',
  email: 'lifeng@nanowork.dev',
  access: 'a',
  refresh: 'r',
};

/** 挂载入口；`/auth` 用探针路由，断言「点击登录真的导航」 */
function renderEntry(): HTMLDivElement {
  return mount(
    <MemoryRouter initialEntries={[ROUTES.chat]}>
      <Routes>
        <Route path={ROUTES.chat} element={<AccountEntry />} />
        <Route path={ROUTES.auth} element={<div>AUTH_SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * 菜单项。⚠️ 不能用 `buttonByText`：MUI 的 `MenuItem` 渲染成 `<li role="menuitem">`，
 * 不是 `<button>`——用按钮查询会得到 `null`，然后断言「菜单项不存在」而误判。
 */
function menuItem(text: string): HTMLElement {
  const el = Array.from(document.querySelectorAll('[role="menuitem"]')).find((n) =>
    (n.textContent ?? '').includes(text),
  );
  expect(el, `菜单项「${text}」不存在`).toBeTruthy();
  return el as HTMLElement;
}

/** 打开账号菜单（MUI Menu 走 Portal，内容在 body 上） */
async function openMenu(host: HTMLElement): Promise<void> {
  click(byAria('账户菜单', host));
  await flush();
}

beforeEach(() => {
  unmount();
  syncMocks.box.session = null;
  syncMocks.box.expired = false;
  syncMocks.box.runtime = syncMocks.runtime;
  syncMocks.accountListeners.clear();
  syncMocks.runtimeListeners.clear();
  useSettingsUiStore.setState({ open: false });
  platformMocks.openUrl.mockClear();
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('maskAccountLabel', () => {
  it('邮箱保留前两位与域名，中间打星', () => {
    expect(maskAccountLabel('lifeng@nanowork.dev')).toBe('li****@nanowork.dev');
    // 极短用户名不该被算成「没有星号」——那等于明文显示
    expect(maskAccountLabel('a@b.com')).toBe('a***@b.com');
  });

  it('非邮箱（如手机号）保留首三位与末两位', () => {
    expect(maskAccountLabel('13200000000')).toBe('132******00');
  });
});

describe('AccountEntry', () => {
  it('未登录：渲染「登录」，点它进登录 / 注册页', () => {
    const host = renderEntry();

    const row = byAria('登录', host);
    expect(row, '未登录时未渲染「登录」入口').toBeTruthy();

    click(row);
    expect(host.textContent, '点击登录未导航到登录页').toContain('AUTH_SCREEN');
  });

  it('已登录：显示掩码账号名，明文不出现在侧栏', () => {
    syncMocks.box.session = SESSION;
    const host = renderEntry();

    expect(host.textContent, '账号名未掩码').toContain('li****@nanowork.dev');
    expect(host.textContent, '侧栏不该出现明文账号').not.toContain(SESSION.email);
    expect(byAria('登录', host), '已登录仍显示登录入口').toBeNull();
  });

  it('菜单里有设置 / 意见反馈 / 退出登录，且「设置」顶掉侧栏原来那一行', async () => {
    syncMocks.box.session = SESSION;
    const host = renderEntry();
    await openMenu(host);

    expect(menuItem('设置').textContent, '设置项缺少键位提示').toContain('Ctrl + ,');
    expect(menuItem('意见反馈')).toBeTruthy();
    expect(menuItem('退出登录')).toBeTruthy();
  });

  it('菜单里的「设置」打开设置弹窗', async () => {
    syncMocks.box.session = SESSION;
    const host = renderEntry();
    await openMenu(host);

    click(menuItem('设置'));
    await flush();

    expect(useSettingsUiStore.getState().open, '设置弹窗未打开').toBe(true);
  });

  it('菜单里的「意见反馈」打开反馈页', async () => {
    syncMocks.box.session = SESSION;
    const host = renderEntry();
    await openMenu(host);

    click(menuItem('意见反馈'));
    await flush();

    expect(platformMocks.openUrl).toHaveBeenCalledWith(FEEDBACK_URL);
  });

  it('菜单里的「退出登录」断开会话并回到未登录态', async () => {
    syncMocks.box.session = SESSION;
    const host = renderEntry();
    await openMenu(host);

    click(menuItem('退出登录'));
    await flush();

    expect(syncMocks.box.session, '未调用 account.logout()').toBeNull();
    expect(byAria('登录', host), '退出后未回到登录入口').toBeTruthy();
  });

  it('运行时晚到：单例出现后自动读回已登录状态', async () => {
    syncMocks.box.session = SESSION;
    syncMocks.box.runtime = null; // 模拟「首屏时单例还没建好」
    const host = renderEntry();

    expect(byAria('登录', host), '单例未到时就该显示登录入口').toBeTruthy();

    await act(async () => {
      syncMocks.box.runtime = syncMocks.runtime;
      syncMocks.emitRuntime();
    });

    expect(byAria('账户菜单', host), '单例出现后没有重读会话').toBeTruthy();
    expect(host.textContent).toContain('li****@nanowork.dev');
  });

  /*
   * 过期态：换票被服务端拒绝，本地会话还在、云端已经不能用。
   *
   * 这一态存在的全部理由就是「不许自相矛盾」：知识库 / 项目页的横幅写着
   * 「登录状态已过期」，侧栏就不能还端着一个正常的账号菜单。
   */
  it('凭据被拒：侧栏改说「登录已过期」，且仍看得出是哪个账号', () => {
    syncMocks.box.session = SESSION;
    syncMocks.box.expired = true;
    const host = renderEntry();

    expect(byAria('登录已过期', host), '过期态没有独立入口').toBeTruthy();
    expect(byAria('账户菜单', host), '过期后仍显示成正常已登录').toBeNull();
    expect(host.textContent).toContain('li****@nanowork.dev');
    // 依然掩码：过期不等于可以铺明文
    expect(host.textContent).not.toContain(SESSION.email);
  });

  it('过期态菜单首项是「重新登录」，点了进登录页且不先登出', async () => {
    syncMocks.box.session = SESSION;
    syncMocks.box.expired = true;
    const host = renderEntry();

    click(byAria('登录已过期', host));
    await flush();
    expect(menuItem('重新登录')).toBeTruthy();
    // 设置照旧可用：过期时更不该把人关在门外
    expect(menuItem('设置')).toBeTruthy();

    click(menuItem('重新登录'));
    await flush();

    expect(host.textContent, '点了重新登录却没进登录页').toContain('AUTH_SCREEN');
    expect(syncMocks.box.session, '跳登录页前把本地会话清了（用户得重新回忆账号）').not.toBeNull();
  });

  /*
   * 「重新登录」与「退出登录」并排出现是**自相矛盾**（用户看到「登录已过期」那一行，
   * 马上就会问「都过期了还退什么」）。过期后没有会话可退，这个动作实际只清本机残留，
   * 于是它在过期态必须改叫「清除本机登录信息」。
   */
  it('过期态不再出现「退出登录」，同一动作用「清除本机登录信息」', async () => {
    syncMocks.box.session = SESSION;
    syncMocks.box.expired = true;
    const host = renderEntry();
    click(byAria('登录已过期', host));
    await flush();

    const hasItem = (text: string): boolean =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).some((n) =>
        (n.textContent ?? '').includes(text),
      );

    expect(hasItem('退出登录'), '过期态仍写着「退出登录」（与「登录已过期」矛盾）').toBe(false);
    expect(hasItem('清除本机登录信息'), '过期态没有清除本机登录信息的入口').toBe(true);
  });

  it('凭据恢复（换票成功）后侧栏回到正常账户入口', async () => {
    syncMocks.box.session = SESSION;
    syncMocks.box.expired = true;
    const host = renderEntry();
    expect(byAria('登录已过期', host)).toBeTruthy();

    await act(async () => {
      syncMocks.box.expired = false;
      for (const cb of Array.from(syncMocks.accountListeners)) cb();
    });

    expect(byAria('账户菜单', host), '恢复后仍停在过期态').toBeTruthy();
    expect(byAria('登录已过期', host)).toBeNull();
  });
});
