/**
 * 路径规则编辑器（FR-8.13，设置「安全」分区）。
 *
 * 钉的是四件**做错了也不报错**的事：
 *
 * 1. **三个动作各自显示**（读 / 写 / 删）——合成一个「允许 / 拒绝」就把这条需求的
 *    全部意义抹掉了（真实诉求是「别让改、但要能读」）；
 * 2. **未声明的动作显示成「不表态」而不是「允许」** —— 反过来会让「加了一条只想管
 *    写的规则」意外把读和删都放开；
 * 3. **草稿语义**：没保存前磁盘不动；保存失败时草稿**不能丢**（丢掉用户的选择是
 *    最坏的结果）；
 * 4. **保存走 `op: 'setPathRules'` 整表替换**，且保存后以盘为准回读。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { platform } from '@/platform';
import { toast } from '@/components/Toast';
import { useToolsPolicyStore } from '@/stores/toolsPolicyStore';
import { PathRulesEditor } from '@/components/settings/sections/PathRulesEditor';
import type { NanobotFileToolsPolicy, NanobotToolsSnapshot, ToolsSyncResult } from '@/platform/types';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';

/**
 * 打开 MUI `Select` 必须派发 **mousedown**（不是 click）—— 与
 * `tests/agentModelPicker.test.tsx` 同一条理由：开合挂在 `onMouseDown` 上，
 * 只点 click 时菜单根本不挂载，随后查 `[role="option"]` 只会拿到空数组，
 * 症状看起来像「选项没渲染」，实际是「菜单没打开」。
 */
function openSelect(el: Element | null | undefined): void {
  expect(el).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

const getTools = vi.fn<() => Promise<NanobotToolsSnapshot | null>>();
const syncTools = vi.fn<(json: string) => Promise<ToolsSyncResult>>();

function policy(patch: Partial<NanobotFileToolsPolicy> = {}): NanobotFileToolsPolicy {
  return { defaultDenyWrite: true, supported: true, pathRules: [], ...patch };
}

function seed(p: NanobotFileToolsPolicy): void {
  useToolsPolicyStore.setState({ policy: p, policyAvailable: true, policyLoading: false });
}

/** 三个动作的 chip 文案（顺序固定：读 / 写 / 删） */
function chipsOf(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.MuiChip-label')).map((el) => el.textContent ?? '');
}

beforeEach(() => {
  vi.restoreAllMocks();
  getTools.mockReset();
  syncTools.mockReset();
  vi.spyOn(toast, 'error').mockImplementation(() => undefined);
  vi.spyOn(toast, 'success').mockImplementation(() => undefined);
  vi.spyOn(platform, 'getNanobotTools').mockImplementation(() => getTools());
  vi.spyOn(platform, 'syncNanobotTools').mockImplementation((json: string) => syncTools(json));
  seed(policy());
});

afterEach(() => {
  unmount();
  useToolsPolicyStore.setState({ policy: null, policyAvailable: false });
});

describe('PathRulesEditor', () => {
  it('没有规则时说清楚「此刻由开关与边界决定」', () => {
    const host = mount(<PathRulesEditor />);
    expect(host.textContent).toContain('还没有规则');
    expect(host.textContent).toContain('默认拒绝写入');
  });

  it('三种动作各自渲染，未声明的是「不表态」', () => {
    seed(
      policy({
        pathRules: [{ path: '/ws/vendor', action: { read: 'allow', write: 'deny' } }],
      }),
    );
    const host = mount(<PathRulesEditor />);

    expect(host.textContent).toContain('/ws/vendor');
    // 读=允许、写=拒绝、删=不表态 —— 顺序固定
    expect(chipsOf(host)).toEqual(['允许', '拒绝', '不表态']);
  });

  it('三个动作都没表态的规则给警告（它对引擎不生效）', () => {
    // 这种形状来自手改过的 config.json：界面必须说清它不生效，而不是默默显示一行
    seed(policy({ pathRules: [{ path: '/ws/x', action: {} }] }));
    const host = mount(<PathRulesEditor />);
    expect(host.textContent).toContain('它对引擎不生效');
  });

  it('Web / 读不到配置时说「无法管理」，不给编辑器', () => {
    seed(policy());
    useToolsPolicyStore.setState({ policyAvailable: false });
    const host = mount(<PathRulesEditor />);
    expect(host.textContent).toContain('无法管理路径规则');
    expect(buttonByText(host, '加入列表')).toBeNull();
  });

  it('加一条规则：进列表、出现未保存标记、保存按钮可用', async () => {
    const host = mount(<PathRulesEditor />);
    const save = buttonByText(host, '保存');
    expect(save?.disabled).toBe(true); // 没有改动时不给点

    const path = host.querySelector<HTMLInputElement>('[data-testid="rule-path"]');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(path, '/ws/src');
    path?.dispatchEvent(new Event('input', { bubbles: true }));

    // 「写」选成拒绝。⚠️ 要开的是 `.MuiSelect-select` 那个 div：`data-testid`
    // 落在隐藏 input 上，对它派发 mousedown 菜单不会挂载（与 agentModelPicker
    // 同一条理由）。三个 select 的顺序固定为 读 / 写 / 删（ACTION_LABELS）。
    const selects = host.querySelectorAll('.MuiSelect-select');
    expect(selects).toHaveLength(3);
    openSelect(selects[1]);
    await flush();
    const deny = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent === '拒绝',
    );
    click(deny);
    await flush();

    click(buttonByText(host, '加入列表'));
    await flush();

    expect(host.textContent).toContain('/ws/src');
    expect(host.textContent).toContain('有未保存的改动');
    expect(buttonByText(host, '保存')?.disabled).toBe(false);
  });

  it('保存 → 走 setPathRules 整表替换，成功后草稿清空', async () => {
    seed(policy({ pathRules: [{ path: '/ws/a', action: { write: 'deny' } }] }));
    syncTools.mockResolvedValue({ ok: true, message: 'ok' });
    getTools.mockResolvedValue({ file: policy({ pathRules: [] }) });

    const host = mount(<PathRulesEditor />);
    // IconButton 只有图标，textContent 是空的 —— 只能按 aria-label 找
    click(host.querySelector('[aria-label="删除规则 /ws/a"]'));
    await flush();
    click(buttonByText(host, '保存'));
    await flush();

    expect(syncTools).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(syncTools.mock.calls[0][0] as string);
    expect(payload.op).toBe('setPathRules');
    expect(payload.pathRules).toEqual([]); // 整表替换：删掉那条就是空表
    expect(host.textContent).not.toContain('有未保存的改动');
  });

  it('保存失败 → 草稿保留（丢掉用户的选择是最坏的结果）', async () => {
    seed(policy({ pathRules: [{ path: '/ws/a', action: { write: 'deny' } }] }));
    syncTools.mockResolvedValue({ ok: false, message: '写盘失败' });

    const host = mount(<PathRulesEditor />);
    click(host.querySelector('[aria-label="删除规则 /ws/a"]'));
    await flush();
    click(buttonByText(host, '保存'));
    await flush();

    expect(toast.error).toHaveBeenCalled();
    // ⚠️ 这里断言的不是「那条规则还在列表里」—— 用户的编辑本来就是「删掉它」，
    // 草稿内容理应是空表。要钉住的是**草稿没被复位**：仍然显示未保存标记、
    // 保存按钮仍可点，于是用户能直接再试一次，而不是被踢回旧状态重做一遍。
    expect(host.textContent).toContain('有未保存的改动');
    expect(buttonByText(host, '保存')?.disabled).toBe(false);
  });

  it('「放弃修改」把草稿退回磁盘上的那份', async () => {
    seed(policy({ pathRules: [{ path: '/ws/a', action: { write: 'deny' } }] }));
    const host = mount(<PathRulesEditor />);
    click(host.querySelector('[aria-label="删除规则 /ws/a"]'));
    await flush();
    expect(host.textContent).toContain('有未保存的改动');

    click(buttonByText(host, '放弃修改'));
    await flush();
    expect(host.textContent).toContain('/ws/a');
    expect(host.textContent).not.toContain('有未保存的改动');
  });
});
