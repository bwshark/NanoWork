import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { OrgAssetsPage } from '@/pages/orgAssets/OrgAssetsPage';
import type { KbGateway } from '@/lib/kb/kbClient';
import {
  ORG_ASSET_LOGIN_REQUIRED,
  type OrgAssetGateway,
} from '@/lib/orgAsset/orgAssetClient';
import type { OrgAsset } from '@/types/orgAsset';
import { useAgentsStore } from '@/stores/agentsStore';
import {
  buttonByText,
  click,
  dialogRoot,
  fieldByLabel,
  flush,
  mount,
  setInputValue,
  unmount,
  waitForSettled,
} from './helpers/reactMount';

/**
 * 组织资产页的接线用例。
 *
 * 这一组只盯**接线**，不重测载荷规则（那在 `tests/lib/orgAsset/orgAssetPayload.test.ts`）。
 * 本仓反复踩过「函数对、但没人调用」：`publishDraft` 再正确，页面没把它的结果送出去
 * 也是白写。所以这里断言的是「点了按钮之后，网关/store 真的被调用了一次」。
 */

const AGENT_ASSET: OrgAsset = {
  id: 'asset-1',
  orgId: 'o1',
  kind: 'agent',
  name: '审稿人',
  description: '你是严格的审稿人。',
  payload: { systemPrompt: '你是严格的审稿人。', skillIds: [] },
  publishedBy: 'u1',
  publishedByEmail: 'boss@corp.example',
  publishedAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
};

/** 组织接口的桩：只实现页面用到的那一个方法（其余方法本页不调用）。 */
function kbStub(role: string): KbGateway {
  return {
    listOrgs: async () => ({
      ok: true as const,
      data: [
        { id: 'o1', name: 'Corp', role, memberCount: 2, createdAt: '2026-01-01T00:00:00Z' },
      ],
    }),
  } as unknown as KbGateway;
}

function gatewayStub(assets: OrgAsset[] = [AGENT_ASSET]) {
  const listAssets = vi.fn(async () => ({ ok: true as const, data: assets }));
  const withdrawAsset = vi.fn(async () => ({ ok: true as const, data: undefined }));
  const publishAsset = vi.fn(async () => ({ ok: true as const, data: AGENT_ASSET }));
  // 显式标注签名：不标的话返回类型被推断成「恒 { ok: true }」，
  // 想用 mockResolvedValueOnce 造一个失败会直接被类型系统挡住
  const updateAsset = vi.fn<OrgAssetGateway['updateAsset']>(async () => ({
    ok: true as const,
    data: AGENT_ASSET,
  }));
  const gateway: OrgAssetGateway = {
    listAssets,
    publishAsset,
    updateAsset,
    withdrawAsset,
  };
  return { gateway, listAssets, withdrawAsset, publishAsset, updateAsset };
}

beforeEach(() => {
  // 每个用例从「只有内置专家」的状态开始，导入断言才有确定的基线
  useAgentsStore.setState({ agents: useAgentsStore.getState().agents.filter(() => false) });
});

afterEach(() => {
  unmount();
});

describe('OrgAssetsPage', () => {
  it('未登录（没有网关）时明确说是「需要登录」，而不是显示空列表', async () => {
    const host = mount(<OrgAssetsPage gateway={null} kbGateway={null} />);
    await waitForSettled(() => (host.textContent ?? '').includes(ORG_ASSET_LOGIN_REQUIRED));
    expect(host.textContent).toContain(ORG_ASSET_LOGIN_REQUIRED);
  });

  it('列表显示名称、发布人与种类', async () => {
    const { gateway, listAssets } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('owner')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));

    expect(listAssets).toHaveBeenCalledWith('o1');
    expect(host.textContent).toContain('boss@corp.example');
    expect(host.textContent).toContain('专家');
    expect(host.textContent).toContain('添加到我的');
  });

  it('组织管理员能看到「发布资产」与「撤回」', async () => {
    const { gateway } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('admin')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));
    expect(buttonByText(host, '发布资产')).toBeTruthy();
    expect(buttonByText(host, '撤回')).toBeTruthy();
    expect(buttonByText(host, '编辑')).toBeTruthy();
  });

  it('普通成员看不到发布 / 撤回入口（发布是管理员动作，服务端也会 403）', async () => {
    const { gateway } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('member')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));
    expect(buttonByText(host, '发布资产')).toBeNull();
    expect(buttonByText(host, '撤回')).toBeNull();
    expect(buttonByText(host, '编辑')).toBeNull();
    // 但「添加到我的」对全员开放 —— 这正是 FR-2.6 的「全员可见」
    expect(buttonByText(host, '添加到我的')).toBeTruthy();
  });

  it('编辑弹窗用列表现值回填，且保存只送真正改过的那一项', async () => {
    const { gateway, updateAsset } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('admin')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));

    click(buttonByText(host, '编辑'));
    await waitForSettled(() => document.querySelector('[role="dialog"]') !== null);
    const nameField = fieldByLabel('名称', dialogRoot()) as HTMLInputElement;
    expect(nameField.value).toBe('审稿人');

    setInputValue(nameField, '审稿官');
    click(buttonByText(dialogRoot(), '保存'));
    await flush();

    expect(updateAsset).toHaveBeenCalledTimes(1);
    const [orgId, assetId, patch] = updateAsset.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(orgId).toBe('o1');
    expect(assetId).toBe('asset-1');
    // ⛔ 说明没动就不该送：整表单回传会把它当成「改过」，审计里就会出现假变更
    expect(patch).toEqual({ name: '审稿官' });
  });

  it('⛔ 什么都没改就点保存：不发请求（否则审计里全是空变更）', async () => {
    const { gateway, updateAsset } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('admin')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));

    click(buttonByText(host, '编辑'));
    await waitForSettled(() => document.querySelector('[role="dialog"]') !== null);
    click(buttonByText(dialogRoot(), '保存'));
    await flush();

    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('编辑失败时显示服务端原话，弹窗不关（改一半不至于丢输入）', async () => {
    const { gateway, updateAsset } = gatewayStub();
    updateAsset.mockResolvedValueOnce({
      ok: false as const,
      status: 400,
      message: '名称已被占用',
      unauthorized: false,
    });
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('admin')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));

    click(buttonByText(host, '编辑'));
    await waitForSettled(() => document.querySelector('[role="dialog"]') !== null);
    setInputValue(fieldByLabel('名称', dialogRoot()) as HTMLInputElement, '撞名');
    click(buttonByText(dialogRoot(), '保存'));
    await waitForSettled(() => (dialogRoot().textContent ?? '').includes('名称已被占用'));

    expect(dialogRoot().textContent).toContain('名称已被占用');
    // 弹窗还在，用户能接着改
    expect(fieldByLabel('名称', dialogRoot())).toBeTruthy();
  });

  it('「添加到我的」真的往专家库里加了一条', async () => {
    const { gateway } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('member')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));

    const before = useAgentsStore.getState().agents.length;
    click(buttonByText(host, '添加到我的'));
    await flush();

    const after = useAgentsStore.getState().agents;
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].name).toBe('审稿人');
    expect(after[after.length - 1].systemPrompt).toBe('你是严格的审稿人。');
  });

  it('撤回要先确认，确认后按 (orgId, assetId) 调一次网关', async () => {
    const { gateway, withdrawAsset } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('owner')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));

    click(buttonByText(host, '撤回'));
    await waitForSettled(() => document.querySelector('[role="dialog"]') !== null);
    // 确认弹窗里那句「已导入到别人本机的那一份不受影响」是这条语义的唯一说明
    expect(dialogRoot().textContent).toContain('不受影响');

    click(buttonByText(dialogRoot(), '撤回'));
    await flush();

    expect(withdrawAsset).toHaveBeenCalledTimes(1);
    expect(withdrawAsset).toHaveBeenCalledWith('o1', 'asset-1');
  });

  it('取消撤回时不发请求', async () => {
    const { gateway, withdrawAsset } = gatewayStub();
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('owner')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('审稿人'));

    click(buttonByText(host, '撤回'));
    await waitForSettled(() => document.querySelector('[role="dialog"]') !== null);
    click(buttonByText(dialogRoot(), '取消'));
    await flush();

    expect(withdrawAsset).not.toHaveBeenCalled();
  });

  it('网关报错时把服务端的原话显示出来（而不是笼统的「加载失败」）', async () => {
    const gateway: OrgAssetGateway = {
      listAssets: async () => ({
        ok: false as const,
        status: 403,
        message: '权限不足',
        unauthorized: false,
      }),
      publishAsset: vi.fn(),
      updateAsset: vi.fn(),
      withdrawAsset: vi.fn(),
    } as unknown as OrgAssetGateway;
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('member')} />);
    await waitForSettled(() => (host.textContent ?? '').includes('权限不足'));
    expect(host.textContent).toContain('权限不足');
  });

  it('发布：选内容 → 名称自动带出 → 送出的是剥干净的载荷', async () => {
    // 发布是这一页的核心动作：「纯函数再对，页面没把结果送出去」正是本仓反复踩的坑
    useAgentsStore.setState({
      agents: [
        {
          id: 'a1',
          name: '审稿人',
          systemPrompt: '你是严格的审稿人。',
          skillIds: [],
          toolAllow: [],
          imBinding: { platform: 'wecom', account: 'bot-1', status: 'online' },
          enabled: true,
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    });
    const { gateway, publishAsset } = gatewayStub([]);
    const host = mount(<OrgAssetsPage gateway={gateway} kbGateway={kbStub('owner')} />);
    await waitForSettled(() =>
      (host.textContent ?? '').includes('这个组织还没有发布任何资产'),
    );

    click(buttonByText(host, '发布资产'));
    await waitForSettled(() => document.querySelector('[role="dialog"]') !== null);

    // MUI 的 Select 在 mousedown 时才展开菜单，菜单走 Portal 渲染到 body
    const combo = dialogRoot().querySelector('[role="combobox"]');
    expect(combo).toBeTruthy();
    act(() => {
      combo!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(
      (el) => (el.textContent ?? '').includes('审稿人'),
    );
    click(option);
    await flush();

    click(buttonByText(dialogRoot(), '发布'));
    await flush();

    expect(publishAsset).toHaveBeenCalledTimes(1);
    const [, input] = publishAsset.mock.calls[0] as unknown as [
      string,
      { kind: string; name: string; payload: Record<string, unknown> },
    ];
    expect(input.kind).toBe('agent');
    expect(input.name).toBe('审稿人');
    // ⛔ 载荷是白名单构造：机器人绑定与空工具面不能混进去（后者要原样保留）
    expect(input.payload).not.toHaveProperty('imBinding');
    expect(input.payload.toolAllow).toEqual([]);
  });
});
