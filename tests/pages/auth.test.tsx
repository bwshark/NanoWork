/**
 * 登录 / 注册页 + 设置「账户」分区（批次 4，FR-10；2026-10-01 补全屏页相关用例）。
 *
 * 用**假的 account**（注入 `getSyncRuntime`）驱动：
 * - 登录成功 → 真的调了 `account.login(email, pwd)` 且导航到聊天页；
 * - **注册密码本地先卡 8 位**：不足时**一次网络都不发**（服务端那条规则失败是 422，
 *   用户只会看到「服务不可用」式的模糊提示）；
 * - **连不上服务端**（`fetch` 抛 `TypeError`）→ 提示里必须**带出地址**，
 *   否则「网络连接失败」区分不了「本机服务没起」和「真的断网」；
 * - 全屏页**自带返回**：没有侧栏可点，返回箭头是唯一出口；
 * - 未登录的账户分区 → 渲染「登录 / 注册」入口；批次 6 的数据主权占位可点性。
 *
 * `@/sync` 被整体替换为「真 hook + 假 runtime」：`useSyncStatus` / `SyncAuthError` /
 * `resolveSyncBaseUrl` 保留真实实现（`importOriginal`），只把 `getSyncRuntime` /
 * `initSyncRuntime` / `useSyncRuntime` 换成桩，避免测试真起一份订阅 8 个 store 的 runtime。
 *
 * ⚠️ `useSyncRuntime` 必须一起换：它是**真实实现**（`useSyncExternalStore` + 真单例），
 * 走的是 `./runtime` 而非桶文件，桶上的 `getSyncRuntime` 桩拦不住它——不换的话账户分区
 * 拿到的永远是 `null`，用例会以「未登录」出错，而根因看着像业务逻辑坏了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { resolveSyncBaseUrl } from '@/sync/baseUrl';

const mocks = vi.hoisted(() => {
  type Session = { userId: string; email: string; access: string; refresh: string };
  /** `fail` 非空时 login / register 直接抛出它（模拟断网 / 服务端错误码） */
  const box: { session: Session | null; fail: unknown } = { session: null, fail: null };
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
      if (box.fail) throw box.fail;
      box.session = { userId: 'u1', email, access: 'a', refresh: 'r' };
      return box.session;
    },
    register: async (email: string, _password: string) => {
      if (box.fail) throw box.fail;
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
    useSyncRuntime: () => mocks.runtime,
  };
});

import { AuthPage } from '@/pages/auth/AuthPage';
import { AccountSection } from '@/components/settings/sections/AccountSection';
import { ROUTES } from '@/lib/core/constants';
import { SyncAuthError } from '@/sync';
import { buttonByText, byAria, click, dialogRoot, flush, mount, setInputValue, unmount } from '../helpers/reactMount';

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

/** 填表并提交（字段定位按 type，不按 DOM 顺序——字段增删不会静默指错控件） */
async function submitCredentials(
  host: HTMLElement,
  email: string,
  password: string,
): Promise<void> {
  setInputValue(host.querySelector('input[type="email"]') as HTMLInputElement, email);
  setInputValue(host.querySelector('input[type="password"]') as HTMLInputElement, password);
  submitForm(host);
  await flush();
}

/** 切到「注册」Tab（MUI Tabs 的按钮是 role=tab） */
function switchToRegister(host: HTMLElement): void {
  const tab = Array.from(host.querySelectorAll('[role="tab"]')).find(
    (n) => (n.textContent ?? '').trim() === '注册',
  );
  expect(tab, '未找到「注册」Tab').toBeTruthy();
  click(tab);
}

beforeEach(() => {
  unmount();
  mocks.box.session = null;
  mocks.box.fail = null;
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('AuthPage', () => {
  it('登录成功 → 调用 account.login 且导航到聊天页', async () => {
    const loginSpy = vi.spyOn(mocks.account, 'login');
    const host = renderAuth();

    await submitCredentials(host, 'a@b.com', 'secret');

    expect(loginSpy).toHaveBeenCalledWith('a@b.com', 'secret');
    expect(host.textContent, '登录成功后未导航到聊天页').toContain('CHAT_SCREEN');
  });

  it('默认是登录模式（登录 Tab 选中）', () => {
    const host = renderAuth();
    const selected = host.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe('登录');
  });

  it('注册成功 → 调用 account.register 且导航到聊天页', async () => {
    const registerSpy = vi.spyOn(mocks.account, 'register');
    const host = renderAuth();
    switchToRegister(host);

    await submitCredentials(host, 'new@b.com', 'secret123');

    expect(registerSpy).toHaveBeenCalledWith('new@b.com', 'secret123');
    expect(host.textContent).toContain('CHAT_SCREEN');
  });

  it('注册密码不足 8 位 → 本地拦下，一次网络都不发', async () => {
    const registerSpy = vi.spyOn(mocks.account, 'register');
    const host = renderAuth();
    switchToRegister(host);

    await submitCredentials(host, 'new@b.com', '123456');

    expect(host.textContent, '未提示密码长度').toContain('密码至少 8 位');
    expect(registerSpy, '本地已判定不合法，却仍发了注册请求').not.toHaveBeenCalled();
    expect(host.textContent, '不该导航走').not.toContain('CHAT_SCREEN');
  });

  it('连不上同步服务 → 提示里带出地址（而不是笼统的「网络连接失败」）', async () => {
    // fetch 连不上时抛的就是 TypeError（各浏览器文案不同，实现里不按文案匹配）
    mocks.box.fail = new TypeError('Failed to fetch');
    const host = renderAuth();

    await submitCredentials(host, 'a@b.com', 'secret');

    expect(host.textContent).toContain('无法连接同步服务');
    // 断言期望值取自**同一个**地址解析口：出厂地址会随部署改（现在是局域网 IP），
    // 硬编码任一个地址都会在下次换地址时假红；而「提示里到底有没有地址」仍然被抓得住
    const hostPort = new URL(resolveSyncBaseUrl()).host;
    expect(host.textContent, '提示里没有地址，用户无从判断是哪台服务').toContain(hostPort);
  });

  it('服务端 422 → 提示说出规则，而不是甩一个错误码', async () => {
    mocks.box.fail = new SyncAuthError(422, '注册信息不合法');
    const host = renderAuth();
    switchToRegister(host);

    await submitCredentials(host, 'new@b.com', 'secret123');

    expect(host.textContent).toContain('密码至少 8 位');
    expect(host.textContent).not.toContain('422');
  });

  it('全屏页自带返回：点返回箭头回到聊天页', () => {
    const host = renderAuth();
    const back = byAria('返回工作台', host);
    expect(back, '全屏页没有返回入口（会变成死胡同）').toBeTruthy();

    click(back);
    expect(host.textContent).toContain('CHAT_SCREEN');
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
