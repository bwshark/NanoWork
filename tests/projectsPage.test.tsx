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
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectsPage } from '@/pages/projects/ProjectsPage';
import { useSessionsStore } from '@/stores/sessionsStore';
import { useTasksStore } from '@/stores/tasksStore';
import type {
  ProjectDetail,
  ProjectGateway,
  ProjectMemory,
  ProjectSummary,
} from '@/lib/project/projectClient';
import { PROJECT_LOGIN_REQUIRED } from '@/lib/project/projectClient';
import type { KbGateway, KbOrg, KbOrgMember } from '@/lib/kb/kbClient';
import type { Session, TaskConfig } from '@/types';
import {
  buttonByText,
  byAria,
  click,
  dialogRoot,
  fieldByLabel,
  flush,
  mount,
  setInputValue,
  unmount,
  waitForSettled,
} from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

/**
 * 每条用例前把三个 store 清空。
 *
 * ⚠️ 这不是洁癖：上一版没有这个钩子，某条用例留下的任务（`projectId: 'p1'`）会渲染出
 * 自己的「移出」按钮，下一条用例 `buttonByText('移出')` 点到的是**任务那个**，
 * 于是「会话移出」看起来没生效 —— 单跑绿、连跑红，且报错指向的断言完全无辜。
 */
beforeEach(() => {
  useSessionsStore.setState({ sessions: [], activeId: null, sessionTombstones: {} });
  useTasksStore.setState({ tasks: [], tombstones: {}, runs: [] });
});

const ORG: KbOrg = { id: 'o1', name: 'Acme', role: 'member', memberCount: 3, createdAt: 'x' };

/** 会话基线：`rev = 1`（新建态），`projectId` 由用例自己决定 */
function baseSession(id: string, title: string): Session {
  return {
    id,
    agentId: '',
    title,
    messages: [],
    permissionLog: [],
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    rev: 1,
    updatedBy: '',
  };
}

function baseTask(id: string, name: string): TaskConfig {
  return {
    id,
    name,
    schedule: { kind: 'interval', minutes: 60 },
    prompt: 'p',
    agentId: '',
    status: 'enabled',
    createdAt: '2026-10-31T00:00:00Z',
  };
}

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
  options: {
    list?: ProjectSummary[];
    detail?: ProjectDetail;
    /** 共享记忆（FR-12.7 ③）；缺省是「项目还没写过」 */
    memory?: Partial<ProjectMemory>;
  } = {},
): { gateway: ProjectGateway; listCalls: { orgId: string; includeArchived: boolean }[] } {
  const listCalls: { orgId: string; includeArchived: boolean }[] = [];
  const memoryOf = (): ProjectMemory => ({
    text: '',
    rev: 0,
    updatedAt: '',
    updatedBy: '',
    canEdit: true,
    maxChars: 20000,
    ...options.memory,
  });
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
    getMemory: async () => ({ ok: true, data: memoryOf() }),
    putMemory: async (_projectId, input) => ({
      ok: true,
      data: { ...memoryOf(), text: input.text, rev: input.rev + 1 },
    }),
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

  it('任务与会话来自本机归属（projectId），不是服务端', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });

    useSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          agentId: '',
          title: '项目里的会话',
          projectId: 'p1',
          messages: [],
          permissionLog: [],
          createdAt: '2026-10-31T00:00:00Z',
          updatedAt: '2026-10-31T00:00:00Z',
        },
        {
          id: 's2',
          agentId: '',
          title: '不属于项目的会话',
          messages: [],
          permissionLog: [],
          createdAt: '2026-10-31T00:00:00Z',
          updatedAt: '2026-10-31T00:00:00Z',
        },
      ],
      activeId: null,
      sessionTombstones: {},
    });
    useTasksStore.setState({
      tasks: [
        {
          id: 't1',
          name: '项目里的任务',
          projectId: 'p1',
          schedule: { kind: 'interval', minutes: 60 },
          prompt: 'p',
          agentId: '',
          status: 'enabled',
          createdAt: '2026-10-31T00:00:00Z',
        },
        {
          id: 't2',
          name: '别的任务',
          schedule: { kind: 'interval', minutes: 60 },
          prompt: 'p',
          agentId: '',
          status: 'enabled',
          createdAt: '2026-10-31T00:00:00Z',
        },
      ],
      tombstones: {},
      runs: [],
    });

    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('任务（1）'));

    const text = document.body.textContent ?? '';
    // 只有归属这个项目的条目出现（另一条必须不出现）
    expect(text).toContain('项目里的会话');
    expect(text).not.toContain('不属于项目的会话');
    expect(text).toContain('项目里的任务');
    expect(text).not.toContain('别的任务');
    // 不再是「尚未接入」：功能已经接上了
    expect(text).not.toContain('尚未接入');
    unmount();
  });

  it('「新建会话」真的把 projectId 写进会话（不是只跳页）', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });
    useSessionsStore.setState({ sessions: [], activeId: null, sessionTombstones: {} });

    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));

    const btn = buttonByText(document, '新建会话');
    expect(btn, '项目成员应当能看到「新建会话」').not.toBeNull();
    click(btn);
    await flush();

    const created = useSessionsStore.getState().sessions[0];
    expect(created, '应当真的建了一个会话').toBeTruthy();
    expect(created.projectId, '会话必须归属这个项目').toBe('p1');
    // 建完切过去：createSession 会把新会话设为 active
    expect(useSessionsStore.getState().activeId).toBe(created.id);
    unmount();
  });

  it('「新建任务」提交后真的把 projectId 落到任务上（单一来源，不靠表单兜底）', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });
    useTasksStore.setState({ tasks: [], tombstones: {}, runs: [] });

    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));

    click(buttonByText(document, '新建任务'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('新建任务（归属本项目）'));

    // 真的填一个名字并提交：只验标题的话，「提交时把 projectId 丢了」这类回归抓不住
    // `fieldByLabel` 返回 HTMLElement（它能查到 label 包裹的任意控件），
    // 而 `setInputValue` 只接受 input / textarea：这里按后者收窄，收窄失败即说明表单换了控件
    const nameInput = fieldByLabel('名称', dialogRoot()) as HTMLInputElement | null;
    expect(nameInput, '表单里应有「名称」输入框').toBeTruthy();
    setInputValue(nameInput, '项目里的新任务');

    click(buttonByText(dialogRoot(), '创建任务'));
    await flush();

    const created = useTasksStore.getState().tasks[0];
    expect(created, '应当真的建了一个任务').toBeTruthy();
    expect(created.name).toBe('项目里的新任务');
    expect(created.projectId, '任务必须归属这个项目').toBe('p1');
    unmount();
  });

  it('没加入项目的人看不到「新建会话 / 新建任务」（别提供做不了的动作）', async () => {
    const readonlyProject = project({ myRole: '', canManage: false });
    const { gateway } = fakeProjectGateway({
      list: [readonlyProject],
      detail: detailOf(readonlyProject),
    });
    // `fakeKbGateway` 的入参是**成员列表**（不是组织）；组织由它内部固定返回 ORG。
    // 这里传空成员即可 —— 本用例关心的是「没加入项目」而不是「组织里有哪些人」
    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));

    expect(buttonByText(document, '新建会话')).toBeNull();
    expect(buttonByText(document, '新建任务')).toBeNull();
    unmount();
  });

  it('「把已有会话移进来」只列未归属任何项目的会话，选中后真的写进 projectId', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });
    useSessionsStore.setState({
      sessions: [
        { ...baseSession('s-free', '未归属的会话') },
        // 已属于别的项目：不该出现在候选里（跨项目搬移是另一件事）
        { ...baseSession('s-other', '属于别的项目'), projectId: 'p2' },
      ],
      activeId: null,
      sessionTombstones: {},
    });

    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));

    click(buttonByText(document, '把已有会话移进来'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('未归属的会话'));

    const dialogText = dialogRoot().textContent ?? '';
    expect(dialogText, '已属于别的项目的会话不该出现在候选里').not.toContain('属于别的项目');

    click(listItemByText('未归属的会话'));
    await flush();

    const moved = useSessionsStore.getState().sessions.find((s) => s.id === 's-free');
    expect(moved?.projectId, '移入后必须归属本项目').toBe('p1');
    // `updateSession` 会自动涨 rev（不要手写）—— 这里顺带钉住「移入是一次真改动」
    expect(moved?.rev, '移入必须涨 rev，否则同步不过去').toBeGreaterThan(1);
    unmount();
  });

  it('「移出」把 projectId 清成 undefined（不是空串）', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });
    useSessionsStore.setState({
      sessions: [{ ...baseSession('s1', '项目里的会话'), projectId: 'p1' }],
      activeId: null,
      sessionTombstones: {},
    });

    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('项目里的会话'));

    click(byAria('把会话「项目里的会话」移出项目'));
    await flush();

    const moved = useSessionsStore.getState().sessions.find((s) => s.id === 's1');
    // `undefined` 才是「不属于任何项目」；空串会造出一个没有意义的中间态
    expect(moved?.projectId).toBeUndefined();
    // 移出后它从项目看板里消失
    expect(document.body.textContent).not.toContain('项目里的会话');
    unmount();
  });

  it('任务也能移入 / 移出项目', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });
    useTasksStore.setState({
      tasks: [
        { ...baseTask('t-free', '未归属的任务') },
        { ...baseTask('t-other', '属于别的项目的任务'), projectId: 'p2' },
      ],
      tombstones: {},
      runs: [],
    });

    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));

    click(buttonByText(document, '把已有任务移进来'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('未归属的任务'));
    expect(dialogRoot().textContent ?? '').not.toContain('属于别的项目的任务');

    click(listItemByText('未归属的任务'));
    await flush();

    const moved = useTasksStore.getState().tasks.find((t) => t.id === 't-free');
    expect(moved?.projectId).toBe('p1');
    unmount();
  });
});

describe('项目空间页 · 共享记忆（FR-12.7 ③）', () => {
  /**
   * 三条口径：空白要有话、正文按原文展示、编辑入口只认服务端的 `canEdit`。
   *
   * 「只认 canEdit」这条是本组的重点：前端自己算「我是不是 lead」就是第二套权限规则，
   * 服务端一改必漏（项目页其余入口已经踩过同一条纪律）。
   */
  const openProject = async (gateway: ProjectGateway) => {
    render(gateway, fakeKbGateway());
    await waitForSettled(() => (document.body.textContent ?? '').includes('登月计划'));
    click(listItemByText('登月计划'));
    await waitForSettled(() => (document.body.textContent ?? '').includes('成员（2）'));
  };

  it('项目还没写共享记忆时给一句人话，而不是一块空白', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({ list: [p], detail: detailOf(p) });
    await openProject(gateway);

    const text = document.body.textContent ?? '';
    expect(text).toContain('共享记忆');
    // 空白区会被读成「加载失败」，所以必须有一句话说明这是「还没写」
    expect(text).toContain('还没写共享记忆');
    unmount();
  });

  it('有正文时按原文展示，并摆出「谁什么时候改的」', async () => {
    const p = project();
    const { gateway } = fakeProjectGateway({
      list: [p],
      detail: detailOf(p),
      memory: {
        text: '本项目一律用 pnpm。',
        rev: 2,
        updatedAt: '2026-11-17T10:00:00Z',
        updatedBy: 'boss@corp.example',
        canEdit: true,
      },
    });
    await openProject(gateway);
    // 记忆是**另一次请求**（详情先到、记忆后到），所以等到正文自己出现再断言
    await waitForSettled(() => (document.body.textContent ?? '').includes('pnpm'));

    const text = document.body.textContent ?? '';
    expect(text).toContain('本项目一律用 pnpm。');
    expect(text).toContain('boss@corp.example');
    unmount();
  });

  it('canEdit=false 时不给「编辑」入口（成员只读，且不自己算权限）', async () => {
    const p = project({ myRole: '', canManage: false });
    const { gateway } = fakeProjectGateway({
      list: [p],
      detail: detailOf(p),
      memory: { text: '只读正文', canEdit: false },
    });
    await openProject(gateway);
    await waitForSettled(() => (document.body.textContent ?? '').includes('只读正文'));

    // 正文读得到（读权限不收窄到项目成员），但没有写入口
    expect(buttonByText(document, '编辑')).toBeNull();
    unmount();
  });
});
