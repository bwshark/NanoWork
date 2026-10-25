/**
 * 部门管理弹窗（FR-12.2 / FR-4.7）。
 *
 * 断言重点不是"能建"，而是**三句必须在界面上说清的话**：
 * 1. 未选中时按钮文案是「新建根部门」，选中后是「在「X」下新建」——
 *    否则用户不知道自己建的部门挂在哪一层；
 * 2. 删除失败时把服务端的原因（还有成员 / 被知识库引用）原样报出来；
 * 3. 加人失败时说「先加入组织」（部门不是邀请入口）。
 */

import { useState } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DepartmentDialog, departmentDepth } from '@/components/knowledge/DepartmentDialog';
import { toast } from '@/components/Toast';
import type { KbDepartment, KbGateway } from '@/lib/kb/kbClient';
import { buttonByText, click, flush, mount, setInputValue, unmount } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const ROOT: KbDepartment = {
  id: 'd1',
  orgId: 'o1',
  parentId: '',
  name: '技术部',
  memberCount: 2,
  createdAt: 'x',
};
const CHILD: KbDepartment = {
  id: 'd2',
  orgId: 'o1',
  parentId: 'd1',
  name: '前端',
  memberCount: 0,
  createdAt: 'x',
};

function makeGateway(overrides: Partial<KbGateway> = {}): KbGateway {
  return {
    listOrgs: vi.fn(),
    createOrg: vi.fn(),
    listKbs: vi.fn(),
    createKb: vi.fn(),
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    uploadFile: vi.fn(),
    renameDocument: vi.fn(),
    deleteDocument: vi.fn(),
    search: vi.fn(),
    retrievalInfo: vi.fn(),
    reindex: vi.fn(),
    listDepartments: vi.fn().mockResolvedValue({ ok: true, data: [ROOT, CHILD] }),
    createDepartment: vi.fn().mockResolvedValue({ ok: true, data: ROOT }),
    updateDepartment: vi.fn().mockResolvedValue({ ok: true, data: ROOT }),
    setDepartmentMemberRole: vi.fn(),
    updateKbVisibility: vi.fn(),
    restoreDocument: vi.fn(),
    deleteDepartment: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    listDepartmentMembers: vi.fn().mockResolvedValue({
      ok: true,
      data: [{ userId: 'u1', email: 'one@corp.example', role: 'member', joinedAt: 'x' }],
    }),
    addDepartmentMember: vi.fn().mockResolvedValue({
      ok: true,
      data: { userId: 'u2', email: 'two@corp.example', role: 'member', joinedAt: 'x' },
    }),
    removeDepartmentMember: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    ...overrides,
  };
}

function Harness({ gateway }: { gateway: KbGateway }) {
  const [open, setOpen] = useState(true);
  return (
    <DepartmentDialog
      open={open}
      orgId="o1"
      gateway={gateway}
      onClose={() => setOpen(false)}
      onChanged={vi.fn()}
    />
  );
}

afterEach(async () => {
  await flush();
  unmount();
  vi.restoreAllMocks();
});

describe('departmentDepth', () => {
  it('按 parentId 链算缩进层数；孤儿当根', () => {
    expect(departmentDepth([ROOT, CHILD], 'd1')).toBe(0);
    expect(departmentDepth([ROOT, CHILD], 'd2')).toBe(1);
    expect(
      departmentDepth([{ ...CHILD, id: 'x', parentId: 'gone' }], 'x'),
    ).toBe(1);
  });

  it('数据有环时不死循环', () => {
    const a: KbDepartment = { ...ROOT, id: 'a', parentId: 'b' };
    const b: KbDepartment = { ...ROOT, id: 'b', parentId: 'a' };
    expect(departmentDepth([a, b], 'a')).toBeLessThanOrEqual(2);
  });
});

describe('新建与选中', () => {
  it('未选中时建的是根部门（不带 parentId）', async () => {
    const gateway = makeGateway();
    const host = mount(<Harness gateway={gateway} />);
    await flush();

    // 弹窗内容在 Portal 里，但字面查询用 document 就够（只有一个弹窗）
    expect(document.body.textContent).toContain('新建根部门');

    setInputValue(
      document.body.querySelector('[data-testid="dept-name-input"]') as HTMLInputElement,
      '市场部',
    );
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-create"]'));
      await flush();
    });

    expect(gateway.createDepartment).toHaveBeenCalledWith('o1', { name: '市场部' });
    expect(host.ownerDocument.body.textContent).toContain('技术部');
  });

  it('选中某部门后按钮变成「在「X」下新建」，且带上 parentId', async () => {
    const gateway = makeGateway();
    mount(<Harness gateway={gateway} />);
    await flush();

    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d1"]'));
      await flush();
    });
    expect(document.body.textContent).toContain('在「技术部」下新建');

    setInputValue(
      document.body.querySelector('[data-testid="dept-name-input"]') as HTMLInputElement,
      '后端',
    );
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-create"]'));
      await flush();
    });
    expect(gateway.createDepartment).toHaveBeenCalledWith('o1', {
      name: '后端',
      parentId: 'd1',
    });
  });
});

describe('删除与成员', () => {
  it('删除被拦住时把服务端原因原样弹出来', async () => {
    const gateway = makeGateway({
      deleteDepartment: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        message: '该部门还有 2 名成员，请先移除',
        unauthorized: false,
      }),
    });
    mount(<Harness gateway={gateway} />);
    await flush();

    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d1"]'));
      await flush();
    });
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-delete"]'));
      await flush();
    });

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('还有 2 名成员'));
  });

  it('选中部门后列出成员，并能加人 / 移除', async () => {
    const gateway = makeGateway();
    mount(<Harness gateway={gateway} />);
    await flush();

    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d1"]'));
      await flush();
    });
    expect(gateway.listDepartmentMembers).toHaveBeenCalledWith('d1');
    expect(document.body.textContent).toContain('one@corp.example');

    setInputValue(
      document.body.querySelector('[data-testid="dept-member-email"]') as HTMLInputElement,
      'two@corp.example',
    );
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-add-member"]'));
      await flush();
    });
    expect(gateway.addDepartmentMember).toHaveBeenCalledWith('d1', 'two@corp.example');

    await act(async () => {
      click(buttonByText(document.body, '移除'));
      await flush();
    });
    expect(gateway.removeDepartmentMember).toHaveBeenCalledWith('d1', 'u1');
  });

  it('加人失败时原样报「先加入组织」', async () => {
    const gateway = makeGateway({
      addDepartmentMember: vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        message: '该用户还不是组织成员，请先加入组织',
        unauthorized: false,
      }),
    });
    mount(<Harness gateway={gateway} />);
    await flush();

    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d1"]'));
      await flush();
    });
    setInputValue(
      document.body.querySelector('[data-testid="dept-member-email"]') as HTMLInputElement,
      'stranger@corp.example',
    );
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-add-member"]'));
      await flush();
    });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('先加入组织'));
  });

  it('部门列表加载失败时显示原因（而不是一个空列表）', async () => {
    const gateway = makeGateway({
      listDepartments: vi.fn().mockResolvedValue({
        ok: false,
        status: 0,
        message: '无法连接云端服务（http://127.0.0.1:8910）',
        unauthorized: false,
      }),
    });
    mount(<Harness gateway={gateway} />);
    await flush();

    expect(
      document.body.querySelector('[data-testid="dept-error"]')?.textContent,
    ).toContain('无法连接云端服务');
  });
});

/**
 * 移动与部门负责人（2026-10-25）。
 *
 * 移动的两条客户端职责：**下拉里不出现非法目标**（自己和自己的子孙），
 * 以及把 `parentId` 原样发出去（"移到根"必须是空串，不能是省略 ——
 * 省略表示"不动"，那会让"提成根部门"这个操作静默失效）。
 */
describe('移动部门', () => {
  it('下拉里排掉自己和自己的子孙（选完才报错体验很差）', async () => {
    mount(<Harness gateway={makeGateway()} />);
    await flush();
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d1"]'));
      await flush();
    });
    await act(async () => {
      // MUI 的 Select 靠 mousedown 打开（click 不够）—— 与页面里那个部门下拉同一个坑
      // 要点在可见的 combobox 容器上：`data-testid` 落的是隐藏的原生 input，
      // 在它上面派发 mousedown 不会打开菜单
      (document.body.querySelector('[role="combobox"]') as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
      await flush();
    });

    const options = Array.from(document.querySelectorAll('[role="option"]')).map(
      (item) => item.textContent ?? '',
    );
    expect(options).toContain('根（最外层）');
    // d1 是根，d2 是它的子：两个都不能作为 d1 的新父
    expect(options.join('|')).not.toContain('技术部');
    expect(options.join('|')).not.toContain('前端');
  });

  it('移到根发的是空串（省略 = 不动，两者语义不同）', async () => {
    const gateway = makeGateway({
      updateDepartment: vi.fn().mockResolvedValue({ ok: true, data: CHILD }),
    });
    mount(<Harness gateway={gateway} />);
    await flush();
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d2"]'));
      await flush();
    });

    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-move"]'));
      await flush();
    });

    expect(gateway.updateDepartment).toHaveBeenCalledWith('d2', { parentId: '' });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('已移动到根'));
  });

  it('环 / 层级超限的报错原样弹出来（服务端解释了为什么不行）', async () => {
    const gateway = makeGateway({
      updateDepartment: vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        message: '不能把部门移到它自己的子部门下面（会形成环）',
        unauthorized: false,
      }),
    });
    mount(<Harness gateway={gateway} />);
    await flush();
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d2"]'));
      await flush();
    });
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-move"]'));
      await flush();
    });

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('会形成环'));
  });
});

describe('部门负责人', () => {
  it('成员行显示部门角色，并能切换成负责人', async () => {
    const gateway = makeGateway({
      setDepartmentMemberRole: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          userId: 'u1',
          email: 'one@corp.example',
          role: 'member',
          departmentRole: 'manager',
          joinedAt: 'x',
        },
      }),
    });
    mount(<Harness gateway={gateway} />);
    await flush();
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d1"]'));
      await flush();
    });

    // 默认是「成员」——不能因为"在部门里"就默认成负责人（那是凭空扩权）
    expect(
      document.body.querySelector('[data-testid="dept-member-role-u1"]')?.textContent,
    ).toBe('成员');

    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-toggle-manager-u1"]'));
      await flush();
    });

    expect(gateway.setDepartmentMemberRole).toHaveBeenCalledWith('d1', 'u1', 'manager');
    // 改完要重读成员列表，否则界面还显示「成员」
    expect(gateway.listDepartmentMembers).toHaveBeenCalledTimes(2);
  });

  it('已经是负责人的可以取消（回来的是 member）', async () => {
    const gateway = makeGateway({
      listDepartmentMembers: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            userId: 'u1',
            email: 'one@corp.example',
            role: 'member',
            departmentRole: 'manager',
            joinedAt: 'x',
          },
        ],
      }),
      setDepartmentMemberRole: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    });
    mount(<Harness gateway={gateway} />);
    await flush();
    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-row-d1"]'));
      await flush();
    });

    expect(
      document.body.querySelector('[data-testid="dept-member-role-u1"]')?.textContent,
    ).toBe('负责人');

    await act(async () => {
      click(document.body.querySelector('[data-testid="dept-toggle-manager-u1"]'));
      await flush();
    });

    expect(gateway.setDepartmentMemberRole).toHaveBeenCalledWith('d1', 'u1', 'member');
  });
});
