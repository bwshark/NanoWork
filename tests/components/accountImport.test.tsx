/**
 * 「导入归档」按钮（批次 6a 补齐 D7 已知偏差）。
 *
 * 用**假的 platform** + **假的 account runtime** 驱动，断言点击「导入归档」后的接线：
 * - 成功：调 `platform.pickFile()` → `parseArchive` → `applyArchive(arch, (k,v) =>
 *   platform.storage.set(k,v))`，`local` 段每个 key 都被写回存储；
 * - 取消：`pickFile` 返 null → 不调 `storage.set`（静默返回）；
 * - 非法归档：`pickFile` 返回非归档文本 → `parseArchive` 抛 `ArchiveParseError`，
 *   不写存储、不崩页。
 *
 * `@/sync` 整体替换为「真 hook + 假 runtime」（`getSyncRuntime` 返回带 account 的桩），
 * 避免真起一份订阅 8 个 store 的 runtime（同 auth.test.tsx）。
 * `@/platform` 整体替换为桩：只关心 `pickFile` 与 `storage.set`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const platformMocks = vi.hoisted(() => ({
  pickFile: vi.fn(),
  storageSet: vi.fn(),
}));

const syncMocks = vi.hoisted(() => {
  type Session = { userId: string; email: string; access: string; refresh: string };
  const box: { session: Session | null } = { session: null };
  const account = {
    getSession: () => box.session,
    isAuthenticated: () => box.session !== null,
    subscribe: () => () => undefined,
    logout: async () => undefined,
    deleteAccount: async () => undefined,
  };
  return { box, account, runtime: { account, client: null } as unknown };
});

// 只替换 `pickFile` 与 `storage.set`，其余导出（`zustandStore` 等 store 持久化要用的
// `zustandStorage`）必须保留——整体替换会让 `agentsStore` / `syncRegistry` 的 import 直接红。
vi.mock('@/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      pickFile: platformMocks.pickFile,
      storage: {
        ...actual.platform.storage,
        get: async () => null,
        set: platformMocks.storageSet,
      },
    },
  };
});

vi.mock('@/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync')>();
  return {
    ...actual,
    getSyncRuntime: () => syncMocks.runtime,
    initSyncRuntime: async () => syncMocks.runtime,
  };
});

import { AccountSection } from '@/components/settings/sections/AccountSection';
import { buildArchive } from '@/lib/accountArchive';
import { buttonByText, click, flush, mount, unmount } from '../helpers/reactMount';

/** 构造一个合法归档（带两个 local 段 key，模拟真实可导入数据）。 */
function sampleArchiveText(): string {
  const archive = buildArchive(
    {
      local: {
        'nanowork.settings': JSON.stringify({ theme: 'dark' }),
        'nanowork.identity.soul': '第一行\n第二行',
      },
      sessionsMeta: [],
      sessionEvents: {},
      cloud: null,
    },
    { exportedAt: new Date().toISOString(), deviceId: null, account: null },
  );
  return JSON.stringify(archive);
}

function renderAccount(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <AccountSection />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  unmount();
  syncMocks.box.session = null;
  platformMocks.pickFile.mockReset();
  platformMocks.storageSet.mockReset();
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('导入归档（批次 6a 补齐 D7）', () => {
  it('J-D7-1：合法归档 → 每个 local 段 key 都被写回 storage', async () => {
    platformMocks.pickFile.mockResolvedValue({ name: 'a.json', content: sampleArchiveText() });
    const host = renderAccount();
    const importBtn = buttonByText(host, '导入归档');
    expect(importBtn, '「导入归档」按钮缺失').toBeTruthy();

    click(importBtn);
    await flush();

    expect(platformMocks.storageSet).toHaveBeenCalledTimes(2);
    expect(platformMocks.storageSet).toHaveBeenCalledWith(
      'nanowork.settings',
      JSON.stringify({ theme: 'dark' }),
    );
    expect(platformMocks.storageSet).toHaveBeenCalledWith('nanowork.identity.soul', '第一行\n第二行');
  });

  it('J-D7-2：用户取消（pickFile 返 null）→ 不写存储', async () => {
    platformMocks.pickFile.mockResolvedValue(null);
    const host = renderAccount();
    const importBtn = buttonByText(host, '导入归档');
    expect(importBtn, '「导入归档」按钮缺失').toBeTruthy();

    click(importBtn);
    await flush();

    expect(platformMocks.storageSet).not.toHaveBeenCalled();
  });

  it('J-D7-3：非法归档文本 → 抛 ArchiveParseError、不写存储、不崩页', async () => {
    platformMocks.pickFile.mockResolvedValue({ name: 'bad.json', content: 'not json at all' });
    const host = renderAccount();
    const importBtn = buttonByText(host, '导入归档');
    expect(importBtn, '「导入归档」按钮缺失').toBeTruthy();

    // 不应抛到测试顶层；importData 内部 catch 后静默提示
    expect(() => {
      click(importBtn);
    }).not.toThrow();

    await flush();

    expect(platformMocks.storageSet).not.toHaveBeenCalled();
  });

  it('J-D7-4：未登录时「导入归档」也可用（只写本机 local 段）', () => {
    const host = renderAccount();
    const importBtn = buttonByText(host, '导入归档');
    expect(importBtn, '未登录也应显示「导入归档」').toBeTruthy();
    expect(importBtn!.disabled).toBe(false);
  });
});
