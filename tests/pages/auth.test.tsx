/**
 * 登录 / 注册页 + 设置「账户」分区（批次 4，FR-10）。
 *
 * 用**假的 account**（注入 `getSyncRuntime`）驱动：
 * - 登录成功 → 真的调了 `account.login(email, pwd)` 且导航到聊天页；
 * - 未登录的账户分区 → 渲染「登录 / 注册」入口；
 * - 批次 6 的数据主权占位（「导出全部数据」/「彻底删除账户」）存在且 disabled。
 *
 * `@/sync` 被整体替换为「真 hook + 假 runtime」：`useSyncStatus` / `SyncAuthError`
 * 保留真实实现（`importOriginal`），只把 `getSyncRuntime` / `initSyncRuntime` 换成桩，
 * 避免测试真起一份订阅 8 个 store 的 runtime。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => {
  type Session = { userId: string; email: string; access: string; refresh: string };
  const box: { session: Session | null } = { session: null };
  const account = {
    getSession: () => box.session,
    isAuthenticated: () => box.session !== null,
    getAccessToken: () => box.session?.access ?? null,
    load: async () => undefined,
    setSession: async (next: Session) => {
      box.session = next;
    },
    clearSession: async () => {
      box.session = null;
    },
    login: async (email: string, _password: string) => {
      box.session = { userId: 'u1', email, access: 'a', refresh: 'r' };
      return box.session;
    },
    register: async (email: string, _password: string) => {
      box.session = { userId: 'u2', email, access: 'a', refresh: 'r' };
      return box.session;
    },
    refresh: async () => false,
    logout: async () => {
      box.session = null;
    },
    deleteAccount: async () => undefined,
    subscribe: () => () => undefined,
  };
  return { box, account, runtime: { account } as unknown };
});

vi.mock('@/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync')>();
  return {
    ...actual,
    getSyncRuntime: () => mocks.runtime,
    initSyncRuntime: async () => mocks.runtime,
  };
});

import { AuthPage } from '@/pages/auth/AuthPage';
import { AccountSection } from '@/components/settings/sections/AccountSection';
import { ROUTES } from '@/lib/constants';
import { buttonByText, click, dialogRoot, flush, mount, setInputValue, unmount } from '../helpers/reactMount';

/** 登录页挂在 Router 下（用 `useNavigate`）；`/chat` 用探针路由断言导航发生。 */
function renderAuth(): HTMLDivElement {
  return mount(
    <MemoryRouter initialEntries={[ROUTES.auth]}>
      <Routes>
        <Route path={ROUTES.auth} element={<AuthPage />} />
        <Route path={ROUTES.chat} element={<div>CHAT_SCREEN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderAccount(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <AccountSection />
    </MemoryRouter>,
  );
}

/** 触发受控表单提交（jsdom 的按钮点击 → submit 链条不稳，直接派发 submit 更可靠）。 */
function submitForm(host: HTMLElement): void {
  const form = host.querySelector('form');
  expect(form, '未渲染出登录表单').toBeTruthy();
  act(() => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  unmount();
  mocks.box.session = null;
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('AuthPage', () => {
  it('登录成功 → 调用 account.login 且导航到聊天页', async () => {
    const loginSpy = vi.spyOn(mocks.account, 'login');
    const host = renderAuth();

    const email = host.querySelector('input[type="email"]') as HTMLInputElement | null;
    const password = host.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(email, '邮箱输入框未渲染').toBeTruthy();
    expect(password, '密码输入框未渲染').toBeTruthy();

    setInputValue(email, 'a@b.com');
    setInputValue(password, 'secret');

    submitForm(host);
    await flush();

    expect(loginSpy).toHaveBeenCalledWith('a@b.com', 'secret');
    expect(host.textContent, '登录成功后未导航到聊天页').toContain('CHAT_SCREEN');
  });

  it('默认是登录模式（登录 Tab 选中）', () => {
    const host = renderAuth();
    const selected = host.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe('登录');
  });
});

describe('AccountSection', () => {
  it('未登录时显示「登录 / 注册」入口', () => {
    const host = renderAccount();
    expect(buttonByText(host, '登录 / 注册')).toBeTruthy();
  });

  it('J-F1：登录后「导出全部数据」与「彻底删除账户」均可点', () => {
    mocks.box.session = { userId: 'u1', email: 'a@b.com', access: 'a', refresh: 'r' };
    const host = renderAccount();
    const exportBtn = buttonByText(host, '导出全部数据');
    const deleteBtn = buttonByText(host, '彻底删除账户');
    expect(exportBtn, '「导出全部数据」按钮缺失').toBeTruthy();
    expect(deleteBtn, '「彻底删除账户」按钮缺失').toBeTruthy();
    expect(exportBtn!.disabled).toBe(false);
    expect(deleteBtn!.disabled).toBe(false);
  });

  it('J-F2：未登录时「导出全部数据」可点、「彻底删除账户」禁用', () => {
    const host = renderAccount();
    const exportBtn = buttonByText(host, '导出全部数据');
    const deleteBtn = buttonByText(host, '彻底删除账户');
    expect(exportBtn, '「导出全部数据」按钮缺失').toBeTruthy();
    expect(deleteBtn, '「彻底删除账户」按钮缺失').toBeTruthy();
    expect(exportBtn!.disabled).toBe(false);
    expect(deleteBtn!.disabled).toBe(true);
  });

  it('J-F3：彻底删除账户必须经过二次确认', async () => {
    mocks.box.session = { userId: 'u1', email: 'a@b.com', access: 'a', refresh: 'r' };
    const delSpy = vi.spyOn(mocks.account, 'deleteAccount');
    const host = renderAccount();

    const deleteBtn = buttonByText(host, '彻底删除账户');
    expect(deleteBtn, '「彻底删除账户」按钮缺失').toBeTruthy();

    // 点「彻底删除账户」只应弹出确认框，不能直接删
    click(deleteBtn);
    await flush();
    expect(delSpy, '未二次确认就调用了删除').not.toHaveBeenCalled();
    const confirmBtn = buttonByText(dialogRoot(), '确认删除');
    expect(confirmBtn, '二次确认对话框未出现').toBeTruthy();

    // 点「确认删除」才真正调用一次
    click(confirmBtn);
    await flush();
    expect(delSpy).toHaveBeenCalledTimes(1);
  });
});
