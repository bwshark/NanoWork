/**
 * 项目空间页（FR-12.7 客户端）：四条判据，都是「不给假象」。
 *
 * 1. 没有登录 → 明说去登录，**不是**一个空项目列表（空列表 = 「团队里没有项目」）；
 * 2. `canManage=false` → **不渲染**「加人 / 加库」（不是置灰 —— 置灰等于暗示点得动）；
 * 3. `canManage=true` → 两个入口都在，且「加人」候选只来自**本组织成员**、
 *    已加入的人不重复出现；
 * 4. 「含归档」是显式开关：默认请求不带 `includeArchived`，点开才带。
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ProjectsPage } from '@/pages/projects/ProjectsPage';
import type {
  ProjectDetail,
  ProjectGateway,
  ProjectSummary,
} from '@/lib/project/projectClient';
import { PROJECT_LOGIN_REQUIRED } from '@/lib/project/projectClient';
import type { KbGateway, KbOrg, KbOrgMember } from '@/lib/kb/kbClient';
import { buttonByText, click, flush, mount, unmount, waitForSettled } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const ORG: KbOrg = { id: 'o1', name: 'Acme', role: 'member', memberCount: 3, createdAt: 'x' };

function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p1',
    orgId: 'o1',
    name: '登月计划',
    description: '一号项目',
    createdBy: 'u1',
    createdAt: '2026-10-31T00:00:00Z',
    archivedAt: '',
    memberCount: 2,
    kbCount: 0,
    myRole: 'lead',
    canManage: true,
    ...over,
  };
}

function detailOf(p: ProjectSummary, over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    project: p,
    members: [
      { userId: 'u1', email: 'boss@corp.example', role: 'lead', joinedAt: 'x' },
      { userId: 'u2', email: 'staff@corp.example', role: 'member', joinedAt: 'x' },
    ],
    kbs: [],
    ...over,
  };
}

function fakeProjectGateway(
  options: { list?: ProjectSummary[]; detail?: ProjectDetail } = {},
): { gateway: ProjectGateway; listCalls: { orgId: string; includeArchived: boolean }[] } {
  const listCalls: { orgId: string; includeArchived: boolean }[] = [];
  const gateway: ProjectGateway = {
    listProjects: async (orgId, input) => {
      listCalls.push({ orgId, includeArchived: input?.includeArchived === true });
      return { ok: true, data: options.list ?? [] };
    },
    createProject: async () => ({ ok: true, data: project() }),
    getProject: async () => ({
      ok: true,
      data: options.detail ?? detailOf(project()),
    }),
    updateProject: async () => ({ ok: true, data: project() }),
    deleteProject: async () => ({ ok: true, data: undefined }),
    addMember: async () => ({
      ok: true,
      data: { userId: 'u3', email: 'x@y.z', role: 'member', joinedAt: 'x' },
    }),
    removeMember: async () => ({ ok: true, data: undefined }),
    addKb: async () => ({ ok: true, data: { id: 'k1', name: '库', documentCount: 0 } }),
    removeKb: async () => ({ ok: true, data: undefined }),
  };
  return { gateway, listCalls };
}

function fakeKbGateway(members: KbOrgMember[] = []): KbGateway {
  return {
    listOrgs: async () => ({ ok: true, data: [ORG] }),
    listMembers: async () => ({ ok: true, data: members }),
    listKbs: async () => ({ ok: true, data: [] }),
  } as unknown as KbGateway;
}

/** MUI 的 ListItemButton 渲染成 div[role=button]，文字在内部 span 里 */
function listItemByText(text: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]'));
  return nodes.find((el) => (el.textContent ?? "").includes(text)) ?? null;
}

function render(gateway: ProjectGateway | null, kbGateway: KbGateway | null) {
  mount(
    <MemoryRouter>
      <ProjectsPage gateway={gateway} kbGateway={kbGateway} />
    </MemoryRouter>,
  );
}

describe('项目空间页', () => {
  it('没有登录态时明说去登录，而不是给一个空列表', async () => {
    render(null, null);
    await flush();
    const text = document.body.textContent ?? '';
    expect(text).toContain(PROJECT_LOGIN_REQUIRED);
    // 空列表会被读成「这个团队没有项目」
    expect(text).not.toContain('这个团队还没有项目');
    unmount();
  });

  it('canManage=false 时不渲染「加人 / 加库」（不是置灰）', async () => {
    // 列表与详情都要传同一个只读项目：只改 list 不改 detail，详情里仍是 canManage=true
    // （页面以详情的 canManage 为准），用例会假红
    const readonlyProject = project({ myRole: '', canManage: false });
    const { gateway } = fakeProjectGateway({
      list: [readonlyProject],
      detail: detailOf(readonlyProject),
    });
    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));

    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));

    expect(buttonByText(document, '加人')).toBeNull();
    expect(buttonByText(document, '加库')).toBeNull();
    // 只读成员仍然看得到成员与库列表（项目不是权限边界）
    expect(document.body.textContent).toContain('boss@corp.example');
    unmount();
  });

  it('canManage=true 时两个入口都在，加人候选只来自组织成员且排除已加入的', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });
    const members: KbOrgMember[] = [
      { userId: 'u1', email: 'boss@corp.example', role: 'owner', joinedAt: 'x' },
      { userId: 'u2', email: 'staff@corp.example', role: 'member', joinedAt: 'x' },
      { userId: 'u3', email: 'newbie@corp.example', role: 'member', joinedAt: 'x' },
    ];
    render(gateway, fakeKbGateway(members));
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));

    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));

    const addMember = buttonByText(document, '加人');
    expect(addMember).not.toBeNull();
    expect(buttonByText(document, '加库')).not.toBeNull();

    click(addMember);
    await waitForSettled(() => (document.body.textContent ?? '').includes('newbie@corp.example'));

    const dialogText = document.body.textContent ?? '';
    // 候选里出现 newbie，已加入的 boss / staff 不再出现第二遍
    const occurrences = (needle: string) => dialogText.split(needle).length - 1;
    expect(occurrences('newbie@corp.example')).toBeGreaterThan(0);
    expect(occurrences('boss@corp.example')).toBe(1);
    unmount();
  });

  it('「含归档」是显式开关：默认不带，点开才带', async () => {
    const { gateway, listCalls } = fakeProjectGateway();
    render(gateway, fakeKbGateway());
    await waitForSettled(() => listCalls.length > 0);
    expect(listCalls[0].includeArchived).toBe(false);

    click(listItemByText('含归档'));
    await waitForSettled(() => listCalls.some((c) => c.includeArchived));
    expect(listCalls.some((c) => c.includeArchived)).toBe(true);
    unmount();
  });
});
