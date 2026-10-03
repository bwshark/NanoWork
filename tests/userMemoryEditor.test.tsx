/**
 * 用户级「画像与偏好」编辑器（`src/pages/memory/UserMemoryEditor.tsx`）。需求 FR-M20 / FR-M21 / FR-M23。
 *
 * 这组用例守的是**「用户是唯一入口」这条设计约束**：本项目没有客户端工具注册通道，
 * 模型不能自己写用户画像（FR-M13a），所以界面上这个编辑器是 `updateProfile` /
 * `setPreference` 的**唯一调用方**。它坏掉的表现是「那两条需求静默失效」——
 * 代码在、单测绿、但用户永远触发不到。
 *
 * 断言一律落在**磁盘上的 canonical**（`profile.json` / `preferences.json`），
 * 而不是界面上的回显：回显对了但没落盘，是最容易骗过测试的一种假成功。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { UserMemoryEditor } from '@/pages/memory/UserMemoryEditor';
import { ensureLocalMemoryScope, platformMemoryIo, userMemoryRef } from '@/lib/memoryPlatformIo';
import { createUserMemoryStore } from '@/lib/memoryUserStore';
import { PREFERENCES_FILE, PROFILE_FILE } from '@/lib/memoryPaths';
import type { PreferenceState, ProfileState } from '@/types';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';

async function store() {
  const scope = await ensureLocalMemoryScope();
  return createUserMemoryStore({ io: platformMemoryIo(userMemoryRef(scope)), userScope: scope });
}

async function readProfile(): Promise<ProfileState | null> {
  const scope = await ensureLocalMemoryScope();
  const raw = await platformMemoryIo(userMemoryRef(scope)).read(PROFILE_FILE);
  return raw === null ? null : (JSON.parse(raw) as ProfileState);
}

async function readPreferences(): Promise<PreferenceState | null> {
  const scope = await ensureLocalMemoryScope();
  const raw = await platformMemoryIo(userMemoryRef(scope)).read(PREFERENCES_FILE);
  return raw === null ? null : (JSON.parse(raw) as PreferenceState);
}

/** 往受控 input 写值并触发 React 的 onChange */
function typeInto(el: HTMLInputElement | null, value: string): void {
  expect(el).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el?.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 按 `data-field` 找画像字段的输入框 */
function fieldInput(host: HTMLElement, field: string): HTMLInputElement | null {
  return host.querySelector(`input[data-field="${field}"]`) as HTMLInputElement | null;
}

/** 按 label 找输入框（MUI 用 `<label for>` 关联） */
function inputByLabel(host: HTMLElement, label: string): HTMLInputElement | null {
  const labels = Array.from(host.querySelectorAll('label'));
  const found = labels.find((l) => (l.textContent ?? '').trim().startsWith(label));
  const id = found?.getAttribute('for');
  return id ? (host.querySelector(`[id="${id}"]`) as HTMLInputElement | null) : null;
}

beforeEach(async () => {
  unmount();
  const scope = await ensureLocalMemoryScope();
  const io = platformMemoryIo(userMemoryRef(scope));
  for (const name of [PROFILE_FILE, PREFERENCES_FILE, 'MEMORY.md', 'user.md']) {
    await io.remove(name).catch(() => undefined);
  }
});

describe('画像：字段级编辑', () => {
  it('填写并保存 → 落进 profile.json，且只含填写的字段', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();

    typeInto(fieldInput(host, 'name'), '老王');
    typeInto(fieldInput(host, 'timezone'), 'UTC+8');
    await flush();

    click(buttonByText(host, '保存画像'));
    await flush();
    await flush();

    const state = await readProfile();
    expect(state?.profile).toEqual({ name: '老王', timezone: 'UTC+8' });
    expect(state?.userScope).toBe(await ensureLocalMemoryScope());
  });

  it('保存后草稿清空、输入框回到磁盘值（界面上不留「看似已改」的残影）', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    typeInto(fieldInput(host, 'name'), '老王');
    await flush();
    click(buttonByText(host, '保存画像'));
    await flush();
    await flush();

    expect(fieldInput(host, 'name')?.value).toBe('老王');
    // 没有未保存改动 → 保存按钮回到禁用
    expect((buttonByText(host, '保存画像') as HTMLButtonElement).disabled).toBe(true);
  });

  it('「清」按钮删除该字段（null 语义，不是存空串）', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    typeInto(fieldInput(host, 'city'), '北京');
    await flush();
    click(buttonByText(host, '保存画像'));
    await flush();
    await flush();
    expect((await readProfile())?.profile.city).toBe('北京');

    click(host.querySelector('[aria-label="删除 常驻城市"]') as Element);
    await flush();
    await flush();
    expect((await readProfile())?.profile.city).toBeUndefined();
  });

  it('没有改动时不提交（按钮禁用，避免空 patch 报错）', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    expect((buttonByText(host, '保存画像') as HTMLButtonElement).disabled).toBe(true);
  });

  it('只列白名单字段（九个固定输入框，不给「模型发明字段」留口子）', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    const fields = Array.from(host.querySelectorAll('input[data-field]')).map((el) =>
      el.getAttribute('data-field'),
    );
    expect(fields.sort()).toEqual(
      ['callThem', 'city', 'language', 'name', 'occupation', 'organization', 'responseStyle', 'role', 'timezone'].sort(),
    );
  });
});

describe('偏好：添加 / 删除 / 有效期', () => {
  it('填写键与值并添加 → 落进 preferences.json', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();

    typeInto(inputByLabel(host, '键'), 'response.language');
    typeInto(inputByLabel(host, '值'), 'Chinese');
    await flush();

    click(buttonByText(host, '添加'));
    await flush();
    await flush();

    const state = await readPreferences();
    expect(state?.records).toHaveLength(1);
    expect(state?.records[0].key).toBe('response.language');
    expect(state?.records[0].value).toBe('Chinese');
    expect(state?.records[0].source).toBe('user');
  });

  it('添加后清空表单（避免重复提交同一条）', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    typeInto(inputByLabel(host, '键'), 'editor.indent');
    typeInto(inputByLabel(host, '值'), 'tabs');
    await flush();
    click(buttonByText(host, '添加'));
    await flush();
    await flush();

    expect(inputByLabel(host, '键')?.value).toBe('');
    expect(inputByLabel(host, '值')?.value).toBe('');
  });

  it('键或值为空 → 不写盘，并给出失败提示', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    typeInto(inputByLabel(host, '值'), 'Chinese');
    await flush();
    click(buttonByText(host, '添加'));
    await flush();
    await flush();
    expect(await readPreferences()).toBeNull();
  });

  it('键形态非法 → 拒绝（仓库层的校验向上冒泡成失败提示）', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    typeInto(inputByLabel(host, '键'), 'Response Language');
    typeInto(inputByLabel(host, '值'), 'Chinese');
    await flush();
    click(buttonByText(host, '添加'));
    await flush();
    await flush();
    expect(await readPreferences()).toBeNull();
  });

  it('填了有效期 → 记录带上 expiresAt（临时的偏好会自己失效）', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    typeInto(inputByLabel(host, '键'), 'response.detail');
    typeInto(inputByLabel(host, '值'), 'verbose');
    typeInto(inputByLabel(host, '到某天失效'), '2026-11-01');
    await flush();
    click(buttonByText(host, '添加'));
    await flush();
    await flush();

    const record = (await readPreferences())?.records[0];
    expect(record?.expiresAt).toBeTruthy();
    // 补成当天结束的**本地**时刻，而不是零点：用户写「到 11-01」意思是那天还有效
    expect(new Date(record!.expiresAt as string).getDate()).toBe(1);
  });

  it('删除一条偏好 → 从 canonical 里去掉', async () => {
    const host = mount(<UserMemoryEditor />);
    await flush();
    typeInto(inputByLabel(host, '键'), 'a.one');
    typeInto(inputByLabel(host, '值'), '1');
    await flush();
    click(buttonByText(host, '添加'));
    await flush();
    await flush();
    expect((await readPreferences())?.records).toHaveLength(1);

    click(buttonByText(host, '删除'));
    await flush();
    await flush();
    expect((await readPreferences())?.records).toHaveLength(0);
  });

  it('已过期的偏好单列出来（过期只是不注入，记录留着解释「曾经为何生效」）', async () => {
    // 直接经仓储写一条已过期的偏好（模拟「上个月设置过」）
    const s = await store();
    await s.setPreference(
      'response.detail',
      'verbose',
      { source: 'user', expiresAt: new Date(Date.now() - 86_400_000).toISOString() },
      new Date(),
    );

    const host = mount(<UserMemoryEditor />);
    await flush();
    expect(host.textContent).toContain('已过期（1）');
    expect(host.textContent).toContain('response.detail');
  });

  it('当前生效的偏好列在「跨项目偏好」下', async () => {
    const s = await store();
    await s.setPreference('response.language', 'Chinese', { source: 'user' }, new Date());

    const host = mount(<UserMemoryEditor />);
    await flush();
    expect(host.textContent).toContain('跨项目偏好（1）');
    expect(host.textContent).toContain('response.language');
  });
});
