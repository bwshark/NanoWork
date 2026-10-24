/**
 * 专家表单里的知识库绑定（FR-2.3 第四条 / FR-4.7）。
 *
 * 这里守的是「不要用空列表冒充状态」：未登录、加载失败、还没绑，三种情形在界面上
 * 必须是三句不同的话。历史上本项目在插件钩子与市场同步上都吃过「装了/配了但界面
 * 看起来一切正常、其实什么都没接上」的亏，所以这些用例都断言**具体文案**。
 *
 * 另一半是语义：`kbIds: []` 表示"整个组织可见范围"，"只搜选中的库"必须落成具体 id
 * 列表——两者方向相反，界面上必须能区分。
 */

import { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentKnowledgePicker } from '@/components/agents/AgentKnowledgePicker';
import type { KbGateway } from '@/lib/kbClient';
import type { AgentKnowledgeBinding } from '@/types';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = { id: 'o1', name: 'Acme', role: 'owner', memberCount: 2, createdAt: 'x' };
const ORG2 = { id: 'o2', name: 'Beta', role: 'member', memberCount: 1, createdAt: 'x' };
const KB1 = {
  id: 'k1',
  orgId: 'o1',
  name: '制度库',
  description: '',
  allowedRoles: ['member', 'admin', 'owner'],
  documentCount: 3,
  createdAt: 'x',
};
const KB2 = { ...KB1, id: 'k2', name: '产品手册', documentCount: 1 };

function makeGateway(overrides: Partial<KbGateway> = {}): KbGateway {
  return {
    listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [ORG, ORG2] }),
    createOrg: vi.fn(),
    listKbs: vi.fn().mockResolvedValue({ ok: true, data: [KB1, KB2] }),
    createKb: vi.fn(),
    listDocuments: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    uploadDocument: vi.fn(),
    search: vi.fn(),
    // 选择器本身不用这两个（它们是知识库页的能力），但网关类型要求齐全
    retrievalInfo: vi.fn(),
    reindex: vi.fn(),
    ...overrides,
  };
}

/** 受控包装：组件是纯受控字段，交互必须回写 value 才能看到下一步 */
function Harness({
  gateway,
  initial,
  onChange,
}: {
  gateway: KbGateway | null;
  initial?: AgentKnowledgeBinding;
  onChange: (next: AgentKnowledgeBinding | undefined) => void;
}) {
  const [value, setValue] = useState<AgentKnowledgeBinding | undefined>(initial);
  return (
    <AgentKnowledgePicker
      gateway={gateway}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

function render(node: React.ReactElement) {
  return mount(node);
}

function radio(host: ParentNode, testId: string): HTMLInputElement {
  const el = host.querySelector(`[data-testid="${testId}"] input`) as HTMLInputElement | null;
  expect(el).toBeTruthy();
  return el!;
}

afterEach(async () => {
  await flush();
  unmount();
  vi.restoreAllMocks();
});

describe('未登录 / 无组织', () => {
  it('没有登录态时说「需要先登录账户」，不是显示一个空列表', async () => {
    const host = render(
      <Harness gateway={null} onChange={vi.fn()} />,
    );
    await flush();

    expect(host.querySelector('[data-testid="knowledge-need-login"]')).toBeTruthy();
    expect(host.textContent).toContain('需要先登录账户');
    // 不能同时给出「绑定」入口：没账户时点了也只能绑个空组织
    expect(host.querySelector('[data-testid="knowledge-bind"]')).toBeNull();
  });

  it('登录了但没加入组织：说清要去哪建，而不是让「绑定」按钮可点却无效', async () => {
    const gateway = makeGateway({ listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [] }) });
    const host = render(<Harness gateway={gateway} onChange={vi.fn()} />);
    await flush();

    expect(host.textContent).toContain('还没有加入任何组织');
    expect(
      (host.querySelector('[data-testid="knowledge-bind"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('绑定与范围', () => {
  it('点「绑定知识库」默认落「整个组织」（不替用户收窄）', async () => {
    const onChange = vi.fn();
    const host = render(<Harness gateway={makeGateway()} onChange={onChange} />);
    await flush();

    click(host.querySelector('[data-testid="knowledge-bind"]'));
    await flush();

    expect(onChange).toHaveBeenCalledWith({ orgId: 'o1', kbIds: [] });
    expect(host.textContent).toContain('Acme');
  });

  it('已绑定时展示组织与库列表，并标注每本库的篇数', async () => {
    const gateway = makeGateway();
    const host = render(
      <Harness gateway={gateway} initial={{ orgId: 'o1', kbIds: [] }} onChange={vi.fn()} />,
    );
    await flush();

    expect(gateway.listKbs).toHaveBeenCalledWith('o1');
    // 默认档位是「整个组织」
    expect(radio(host, 'knowledge-scope-all').checked).toBe(true);
    expect(host.textContent).toContain('整个组织（我可见的全部库）');
  });

  it('切到「只搜选中的库」先全选，再取消一本 → 落库的是具体 id', async () => {
    const onChange = vi.fn();
    const host = render(
      <Harness gateway={makeGateway()} initial={{ orgId: 'o1', kbIds: [] }} onChange={onChange} />,
    );
    await flush();

    click(radio(host, 'knowledge-scope-picked'));
    await flush();
    // 全选：否则空数组会回到「整个组织」，用户会以为点击没生效
    expect(onChange).toHaveBeenLastCalledWith({ orgId: 'o1', kbIds: ['k1', 'k2'] });

    click(radio(host, 'knowledge-kb-k1'));
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({ orgId: 'o1', kbIds: ['k2'] });
  });

  it('切组织时把检索范围重置为「整个组织」（上一个组织的库 id 不能带过去）', async () => {
    const onChange = vi.fn();
    const host = render(
      <Harness
        gateway={makeGateway()}
        initial={{ orgId: 'o1', kbIds: ['k1'] }}
        onChange={onChange}
      />,
    );
    await flush();

    click(radio(host, 'knowledge-org-o2'));
    await flush();

    expect(onChange).toHaveBeenLastCalledWith({ orgId: 'o2', kbIds: [] });
  });

  it('解绑后回到「绑定知识库」，值是 undefined（而不是空绑定）', async () => {
    const onChange = vi.fn();
    const host = render(
      <Harness gateway={makeGateway()} initial={{ orgId: 'o1', kbIds: ['k1'] }} onChange={onChange} />,
    );
    await flush();

    click(host.querySelector('[data-testid="knowledge-unbind"]'));
    await flush();

    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(host.querySelector('[data-testid="knowledge-bind"]')).toBeTruthy();
  });
});

describe('异常态', () => {
  it('绑定的组织已不在列表里：明确提示要重选，而不是显示一个孤儿 id', async () => {
    const host = render(
      <Harness
        gateway={makeGateway()}
        initial={{ orgId: 'o-gone', kbIds: [] }}
        onChange={vi.fn()}
      />,
    );
    await flush();

    expect(host.textContent).toContain('已不在你的组织列表里');
    // 提示之外必须仍然可以重新选组织
    expect(radio(host, 'knowledge-org-o1')).toBeTruthy();
  });

  it('连不上云端（status=0）：报出地址并给出启动命令（不是让用户去猜）', async () => {
    const listOrgs = vi.fn().mockResolvedValue({
      ok: false,
      status: 0,
      message: '无法连接云端服务（http://127.0.0.1:8910）',
      unauthorized: false,
    });
    const host = render(<Harness gateway={makeGateway({ listOrgs })} onChange={vi.fn()} />);
    await flush();

    expect(host.textContent).toContain('无法连接云端服务（http://127.0.0.1:8910）');
    expect(host.textContent).toContain('uvicorn app.main:app --port 8910');
  });

  it('组织列表 403：原样报服务端那句，并给出重试入口', async () => {
    const listOrgs = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        message: '当前角色无权访问该知识库',
        unauthorized: false,
      })
      .mockResolvedValue({ ok: true, data: [ORG] });
    const host = render(<Harness gateway={makeGateway({ listOrgs })} onChange={vi.fn()} />);
    await flush();

    expect(host.querySelector('[data-testid="knowledge-error"]')?.textContent).toBe(
      '当前角色无权访问该知识库',
    );

    await act(async () => {
      buttonByText(host, '重试')?.click();
      await flush();
    });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    // 重试成功后「绑定」才可用（未绑定时组织名不渲染，能选的证据就是按钮可点）
    expect(
      (host.querySelector('[data-testid="knowledge-bind"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
