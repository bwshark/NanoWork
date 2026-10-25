/**
 * 知识库页（M7 客户端）：三条「不给假象」的判据。
 *
 * 1. 没有登录 / 没有网关 → 明说要去登录，**不是**显示一个空列表（空列表会被读成
 *    「团队里没资料」）；
 * 2. 服务端说没权限（403）→ 原样把那句话说给用户，**不在客户端悄悄筛掉**
 *    （筛掉就把服务端的 bug 藏了）；
 * 3. 检索结果按服务端返回原样渲染（含分数），不二次过滤。
 *
 * ## 2026-10-26 重排版之后的两处交互变化（判据没变）
 *
 * - 进页面先看到**团队视图**（知识库卡片），点卡片才进文件列表 —— 所以下面
 *   大量用例第一步是 `enterKb()`。这不是测试的权宜：不给「默认进第一个库」是
 *   产品决定（否则「这个团队一共有什么」永远要翻好几层）。
 * - 建库 / 新建文档 / 成员与权限都收进了弹窗或「+」菜单，取值要走 `dialogRoot()`
 *   或 `document`（MUI 的 Portal 不在挂载容器里）。
 */

import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePage } from '@/pages/knowledge/KnowledgePage';
import { toast } from '@/components/Toast';
import type { KbApiResult, KbDocument, KbGateway, KbSummary } from '@/lib/kb/kbClient';
import {
  buttonByText,
  click,
  dialogRoot,
  flush,
  mount,
  setInputValue,
  unmount,
} from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// toast 自带自动消失定时器：用例结束后它才 setState，会刷一屏
// 「not wrapped in act」噪声。这里只关心页面的数据流，弹提示本身另有覆盖。
vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const ORG = { id: 'o1', name: 'Acme', role: 'member', memberCount: 3, createdAt: 'x' };
const KB = {
  id: 'k1',
  orgId: 'o1',
  name: '制度库',
  description: '',
  allowedRoles: ['member', 'admin', 'owner'],
  allowedDepartments: [],
  documentCount: 1,
  createdAt: 'x',
};

const DEPT = {
  id: 'd1',
  orgId: 'o1',
  parentId: '',
  name: '技术部',
  memberCount: 2,
  createdAt: 'x',
};
const DOC = { id: 'd1', kbId: 'k1', title: '差旅制度', chars: 42, chunkCount: 2, createdAt: 'x' };
const HIT = {
  chunkId: 'c1',
  docId: 'd1',
  docTitle: '差旅制度',
  kbId: 'k1',
  score: 0.42,
  snippet: '报销流程：走财务邮箱。',
};

const RETRIEVAL_OFF = {
  mode: 'lexical' as const,
  embedder: 'off',
  model: '',
  dim: 0,
  chunks: 0,
  indexed: 0,
  stale: false,
  error: '',
};

function makeGateway(overrides: Partial<KbGateway> = {}): KbGateway {
  return {
    listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [ORG] }),
    retrievalInfo: vi.fn().mockResolvedValue({ ok: true, data: RETRIEVAL_OFF }),
    reindex: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { indexed: 2, total: 2, model: 'hash:64', error: '' } }),
    listDepartments: vi.fn().mockResolvedValue({ ok: true, data: [DEPT] }),
    createDepartment: vi.fn(),
    updateDepartment: vi.fn(),
    setDepartmentMemberRole: vi.fn(),
    updateKbVisibility: vi.fn(),
    restoreDocument: vi.fn(),
    deleteDepartment: vi.fn(),
    listDepartmentMembers: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    addDepartmentMember: vi.fn(),
    removeDepartmentMember: vi.fn(),
    listMembers: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    addMember: vi.fn(),
    updateMemberRole: vi.fn(),
    removeMember: vi.fn(),
    createOrg: vi.fn().mockResolvedValue({ ok: true, data: ORG }),
    listKbs: vi.fn().mockResolvedValue({ ok: true, data: [KB] }),
    createKb: vi.fn().mockResolvedValue({ ok: true, data: KB }),
    listDocuments: vi.fn().mockResolvedValue({ ok: true, data: [DOC] }),
    uploadDocument: vi.fn().mockResolvedValue({ ok: true, data: DOC }),
    uploadFile: vi.fn().mockResolvedValue({ ok: true, data: { ...DOC, kind: 'docx' } }),
    renameDocument: vi.fn(),
    deleteDocument: vi.fn(),
    search: vi.fn().mockResolvedValue({ ok: true, data: [HIT] }),
    ...overrides,
  };
}

function render(gateway?: KbGateway) {
  return mount(
    <MemoryRouter>
      <KnowledgePage gateway={gateway} />
    </MemoryRouter>,
  );
}

/** 从团队视图点进知识库（重排版后的必经一步） */
async function enterKb(host: ParentNode) {
  await act(async () => {
    click(host.querySelector('[data-testid="kb-card-k1"]'));
    await flush();
  });
}

/** 打开顶栏的「+」或「⋯」菜单并点其中一项（菜单在 Portal 里，只能从 document 找） */
async function pickMenu(
  host: ParentNode,
  which: 'kb-add-menu' | 'kb-more-menu',
  item: string,
) {
  await act(async () => {
    click(host.querySelector(`[data-testid="${which}"]`));
    await flush();
  });
  await act(async () => {
    click(document.querySelector(`[data-testid="kb-menu-${item}"]`));
    await flush();
  });
}

/** 打开新建知识库弹窗（团队视图里的卡片入口） */
async function openCreateKbDialog(host: ParentNode) {
  await act(async () => {
    click(host.querySelector('[data-testid="kb-card-create"]'));
    await flush();
  });
}

afterEach(async () => {
  // 先让在途的加载 promise 落定再卸载：否则卸载后的 setState 会触发
  // 「update ... not wrapped in act」噪声，掩盖真正的失败
  await flush();
  unmount();
  vi.restoreAllMocks();
});

describe('未登录 / 空团队', () => {
  it('没有可用网关时说「需要登录」，而不是显示空列表', async () => {
    const host = render(undefined);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('需要先登录账户');
    expect(buttonByText(host, '去登录')).toBeTruthy();
  });

  it('没有任何团队时给出创建入口（不假装在加载）', async () => {
    const gateway = makeGateway({ listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [] }) });
    const host = render(gateway);
    await flush();

    expect(host.textContent).toContain('还没有加入任何团队');
    expect(host.querySelector('[data-testid="new-org-name"]')).toBeTruthy();
  });
});

/**
 * 「未登录」与「登录已过期」是**相反的两句话**，不能混成一句。
 *
 * access token 只有 30 分钟寿命，过期是常态：此时侧边栏仍显示登录邮箱（本地会话
 * 还在），页面却说「需要先登录账户」——用户看到的就是自相矛盾。过期该说的是
 * 「这张票不能用了」并给重试。
 */
describe('登录态：未登录 vs 已过期', () => {
  it('401（换票也失败）说「登录状态已过期」，并给重试', async () => {
    const gateway = makeGateway({
      listOrgs: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        message: 'access token 无效或已过期',
        unauthorized: true,
      }),
    });
    const host = render(gateway);
    await flush();

    expect(host.textContent).toContain('登录状态已过期');
    // 不能同时说「需要先登录账户」——那是另一个事实
    expect(host.textContent).not.toContain('需要先登录账户');
    expect(host.querySelector('[data-testid="kb-auth-retry"]')).toBeTruthy();
  });

  it('过期后重试成功就正常渲染（不必真的去重新登录）', async () => {
    const listOrgs = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        message: 'access token 无效或已过期',
        unauthorized: true,
      })
      .mockResolvedValue({ ok: true, data: [ORG] });
    const host = render(makeGateway({ listOrgs }));
    await flush();

    await act(async () => {
      click(buttonByText(host, '重试'));
      await flush();
    });

    expect(host.textContent).toContain('Acme');
    expect(host.textContent).not.toContain('登录状态已过期');
  });
});

describe('团队视图 → 知识库视图', () => {
  it('先给团队的知识库卡片，点进去才是文件列表（不默认进第一个库）', async () => {
    const listDocuments = vi.fn().mockResolvedValue({ ok: true, data: [DOC] });
    const host = render(makeGateway({ listDocuments }));
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('Acme');
    expect(text).toContain('制度库');
    // 团队视图里不该已经有文件列表：那是「进库之后」才有的东西
    expect(host.querySelector('[data-testid="kb-doc-row-d1"]')).toBeNull();
    expect(listDocuments).not.toHaveBeenCalled();

    await enterKb(host);

    expect(host.textContent).toContain('差旅制度');
    expect(listDocuments).toHaveBeenCalledWith('k1', { trashed: false });
    // 可见范围用人话展示（否则用户不知道同事为什么看不到）
    expect(host.textContent).toContain('成员 / 管理员 / 所有者可见');
  });

  it('侧栏的两级树同时显示多个团队及各自的库', async () => {
    const ORG2 = { ...ORG, id: 'o2', name: '第二个团队' };
    const KB2 = { ...KB, id: 'k2', orgId: 'o2', name: '另一本库' };
    const listKbs = vi.fn((orgId: string) =>
      Promise.resolve<KbApiResult<KbSummary[]>>({ ok: true, data: orgId === 'o2' ? [KB2] : [KB] }),
    );
    const host = render(makeGateway({ listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [ORG, ORG2] }), listKbs }));
    await flush();

    // 两个团队的库都在树上：否则「同事说他有个库」得先猜是哪个团队
    expect(host.querySelector('[data-testid="kb-tree-k1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="kb-tree-k2"]')).toBeTruthy();
    expect(listKbs).toHaveBeenCalledWith('o2');
  });

  it('点侧栏的库与点卡片等价，都会切换右侧内容', async () => {
    const host = render(makeGateway());
    await flush();

    await act(async () => {
      click(host.querySelector('[data-testid="kb-tree-k1"]'));
      await flush();
    });

    expect(host.textContent).toContain('差旅制度');
  });

  it('团队还没库时给「新建知识库」入口，而不是一片空白', async () => {
    const host = render(makeGateway({ listKbs: vi.fn().mockResolvedValue({ ok: true, data: [] }) }));
    await flush();

    expect(host.textContent).toContain('还没有知识库'); // 侧栏
    expect(host.querySelector('[data-testid="kb-card-create"]')).toBeTruthy();
  });
});

describe('检索', () => {
  it('检索把服务端返回的命中原样显示（含分数与片段）', async () => {
    const gateway = makeGateway();
    const host = render(gateway);
    await flush();
    await enterKb(host);

    setInputValue(host.querySelector('[data-testid="kb-query"]') as HTMLInputElement, '报销');
    await act(async () => {
      click(buttonByText(host, '检索'));
      await flush();
    });

    expect(gateway.search).toHaveBeenCalledWith('o1', expect.objectContaining({ query: '报销' }));
    const hits = host.querySelector('[data-testid="kb-hits"]');
    expect(hits).toBeTruthy();
    expect(hits!.textContent).toContain('差旅制度');
    expect(hits!.textContent).toContain('0.420');
    expect(hits!.textContent).toContain('走财务邮箱');
  });

  it('服务端 403 原样报出来（不静默变成空结果）', async () => {
    const gateway = makeGateway({
      search: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        message: '当前角色无权访问该知识库',
        unauthorized: false,
      }),
    });
    const host = render(gateway);
    await flush();
    await enterKb(host);

    setInputValue(host.querySelector('[data-testid="kb-query"]') as HTMLInputElement, '特批');
    await act(async () => {
      click(buttonByText(host, '检索'));
      await flush();
    });

    expect(host.textContent).toContain('当前角色无权访问该知识库');
    // 不能同时又渲染一个「没有命中」——那是另一种结论
    expect(host.textContent).not.toContain('没有命中');
  });
});

describe('上传文件（FR-4.7 解析）', () => {
  /** 触发一次「选文件」：jsdom 没有 DataTransfer，直接给 input.files 塞值 */
  async function selectFile(host: ParentNode, file: File) {
    const input = host.querySelector('[data-testid="kb-file-input"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
  }

  it('选中的文件以 base64 上传，并把解析警告逐条提示出来', async () => {
    const uploadFile = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        ...DOC,
        kind: 'pdf',
        chunkCount: 3,
        warnings: ['2 页没有文本层（可能是图片页），这部分内容不会被检索到'],
      },
    });
    const host = render(makeGateway({ uploadFile }));
    await flush();
    await enterKb(host);

    await selectFile(host, new File([new Uint8Array([0x25, 0x50])], '制度.pdf'));

    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [kbId, payload] = uploadFile.mock.calls[0];
    expect(kbId).toBe('k1');
    expect(payload.filename).toBe('制度.pdf');
    // 必须是不带 data: 前缀的 base64（带了服务端会说「不是合法 base64」）
    expect(payload.contentBase64).toBe(btoa('\x25\x50'));
    // 警告必须弹给用户：不弹就变成「我传了这份资料，它怎么搜不到」
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('没有文本层'));
  });

  it('不支持的后缀在本地就拦掉，不发请求', async () => {
    const uploadFile = vi.fn();
    const host = render(makeGateway({ uploadFile }));
    await flush();
    await enterKb(host);

    await selectFile(host, new File([new Uint8Array([0x89, 0x50])], '截图.png'));

    expect(uploadFile).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('.png'));
  });

  it('服务端解析失败的原因原样提示，不压成「上传失败」', async () => {
    const uploadFile = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      message: '不是有效的 .docx（zip 结构损坏）',
      unauthorized: false,
    });
    const host = render(makeGateway({ uploadFile }));
    await flush();
    await enterKb(host);

    // 后缀能过前端预检、内容被服务端判定损坏 —— 这正是「只有服务端知道」的那类失败
    await selectFile(host, new File([new Uint8Array([1])], '坏.docx'));

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('zip'));
  });
});

describe('部门范围（FR-4.7「按部门/角色」）', () => {
  it('卡片把部门范围说成人话（而不是只显示角色）', async () => {
    const listKbs = vi
      .fn()
      .mockResolvedValue({ ok: true, data: [{ ...KB, allowedDepartments: ['d1'] }] });
    const host = render(makeGateway({ listKbs }));
    await flush();

    expect(host.textContent).toContain('仅 技术部');
  });

  it('组织有部门时才出现「仅限部门」（没部门时不留一个空控件）', async () => {
    const withDept = render(makeGateway());
    await flush();
    await openCreateKbDialog(withDept);
    expect(dialogRoot().querySelector('[data-testid="new-kb-dept-d1"]')).toBeTruthy();

    await flush();
    unmount();

    const noDept = render(
      makeGateway({ listDepartments: vi.fn().mockResolvedValue({ ok: true, data: [] }) }),
    );
    await flush();
    await openCreateKbDialog(noDept);
    expect(dialogRoot().querySelector('[data-testid="new-kb-dept-d1"]')).toBeNull();
    expect(dialogRoot().textContent).not.toContain('仅限部门');
  });

  it('点选部门后建库会把它随请求下发；不点则完全不下发该字段', async () => {
    const createKb = vi.fn().mockResolvedValue({ ok: true, data: KB });
    const host = render(makeGateway({ createKb }));
    await flush();
    await openCreateKbDialog(host);

    setInputValue(dialogRoot().querySelector('[data-testid="new-kb-name"]') as HTMLInputElement, '研发制度');
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="new-kb-dept-d1"]'));
      await flush();
    });
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="new-kb-confirm"]'));
      await flush();
    });

    expect(createKb).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ name: '研发制度', allowedDepartments: ['d1'] }),
    );
  });

  it('不选部门时请求里不出现 allowedDepartments（「没选」不等于「刻意收窄」）', async () => {
    const createKb = vi.fn().mockResolvedValue({ ok: true, data: KB });
    const host = render(makeGateway({ createKb }));
    await flush();
    await openCreateKbDialog(host);

    setInputValue(dialogRoot().querySelector('[data-testid="new-kb-name"]') as HTMLInputElement, '公开制度');
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="new-kb-confirm"]'));
      await flush();
    });

    const [, payload] = createKb.mock.calls[0];
    expect('allowedDepartments' in payload).toBe(false);
  });

  it('建完直接进入新库（刚建它就是为了往里放东西）', async () => {
    const createKb = vi.fn().mockResolvedValue({ ok: true, data: { ...KB, id: 'k9', name: '新库' } });
    const listKbs = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValue({ ok: true, data: [{ ...KB, id: 'k9', name: '新库' }] });
    const host = render(makeGateway({ createKb, listKbs }));
    await flush();
    await openCreateKbDialog(host);

    setInputValue(dialogRoot().querySelector('[data-testid="new-kb-name"]') as HTMLInputElement, '新库');
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="new-kb-confirm"]'));
      await flush();
    });

    expect(host.textContent).toContain('所有知识');
  });
});

describe('检索能力说明（FR-4.7 向量检索）', () => {
  it('默认（词法）：明说未启用向量检索，且不给「重建索引」按钮', async () => {
    const host = render(makeGateway());
    await flush();
    await enterKb(host);

    const caption = host.querySelector('[data-testid="kb-caption"]')?.textContent ?? '';
    expect(caption).toContain('当前词法检索，向量检索未启用');
    expect(host.querySelector('[data-testid="kb-reindex"]')).toBeNull();
  });

  it('哈希向量 + 有块没索引：说明里写清「非语义」与待建块数，并给重建入口', async () => {
    const retrievalInfo = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        mode: 'hybrid',
        embedder: 'hash',
        model: 'hash:64',
        dim: 64,
        chunks: 5,
        indexed: 3,
        stale: true,
        error: '',
      },
    });
    const reindex = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { indexed: 5, total: 5, model: 'hash:64', error: '' } });
    const host = render(makeGateway({ retrievalInfo, reindex }));
    await flush();
    await enterKb(host);

    const caption = host.querySelector('[data-testid="kb-caption"]')?.textContent ?? '';
    // 「非语义」必须写出来：哈希向量只认字面重合，不写会被当成语义检索用
    expect(caption).toContain('本地哈希向量（非语义');
    expect(caption).toContain('有 2 块待建索引');

    await act(async () => {
      click(host.querySelector('[data-testid="kb-reindex"]'));
      await flush();
    });
    expect(reindex).toHaveBeenCalledWith('k1');
    // 重建后重读了状态（否则按钮会一直挂着「待建索引」）
    expect(retrievalInfo.mock.calls.length).toBeGreaterThan(1);
  });

  it('配置有误：说明改成警示句，并且不显示重建按钮（点了也建不成）', async () => {
    const retrievalInfo = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        mode: 'lexical',
        embedder: 'openai',
        model: '',
        dim: 0,
        chunks: 4,
        indexed: 0,
        stale: false,
        error: 'NANOWORK_KB_EMBED_BASE_URL / NANOWORK_KB_EMBED_MODEL 至少要给一个',
      },
    });
    const host = render(makeGateway({ retrievalInfo }));
    await flush();
    await enterKb(host);

    const caption = host.querySelector('[data-testid="kb-caption"]')?.textContent ?? '';
    expect(caption).toContain('检索配置有误');
    expect(caption).toContain('退回词法检索');
    expect(host.querySelector('[data-testid="kb-reindex"]')).toBeNull();
  });
});

describe('文档生命周期（删除 / 改名 / 判重）', () => {
  it('列表说清格式，并在缺索引时挂一个警示（没索引 = 搜不到，界面上却长得一样）', async () => {
    const retrievalInfo = vi.fn().mockResolvedValue({
      ok: true,
      data: { ...RETRIEVAL_OFF, mode: 'hybrid', embedder: 'hash', model: 'hash:64', dim: 64 },
    });
    const listDocuments = vi
      .fn()
      .mockResolvedValue({ ok: true, data: [{ ...DOC, kind: 'pdf', embedded: 0 }] });
    const host = render(makeGateway({ retrievalInfo, listDocuments }));
    await flush();
    await enterKb(host);

    expect(host.textContent).toContain('PDF · 42 字 · 2 块');
    expect(host.querySelector('[data-testid="kb-doc-index-d1"]')?.textContent).toBe('未建索引');
  });

  it('embedder 关着时不挂索引提示（那时「没索引」是正常状态，提示只会误导）', async () => {
    const listDocuments = vi
      .fn()
      .mockResolvedValue({ ok: true, data: [{ ...DOC, kind: 'text', embedded: 0 }] });
    const host = render(makeGateway({ listDocuments }));
    await flush();
    await enterKb(host);

    expect(host.textContent).toContain('纯文本 · 42 字 · 2 块');
    expect(host.querySelector('[data-testid="kb-doc-index-d1"]')).toBeNull();
  });

  it('删除必须二次确认：弹窗里写清会连块一起删，确认后才发请求', async () => {
    const deleteDocument = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const listDocuments = vi.fn().mockResolvedValue({ ok: true, data: [DOC] });
    const host = render(makeGateway({ deleteDocument, listDocuments }));
    await flush();
    await enterKb(host);
    const before = listDocuments.mock.calls.length;

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-delete-d1"]'));
      await flush();
    });
    // 文案要说清后果（进回收站 / 保留 30 天），而不是只问「确定吗」
    expect(dialogRoot().textContent).toContain('2 个分块');
    expect(dialogRoot().textContent).toContain('回收站');
    expect(deleteDocument).not.toHaveBeenCalled();

    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="kb-delete-confirm"]'));
      await flush();
    });

    expect(deleteDocument).toHaveBeenCalledWith('k1', 'd1');
    // 删完必须重新拉列表：本地摘掉一行看起来一样，但服务端可能删了别的
    expect(listDocuments.mock.calls.length).toBeGreaterThan(before);
  });

  it('取消删除不发请求（销毁性操作不能靠「点错了再传一遍」兜底）', async () => {
    const deleteDocument = vi.fn();
    const host = render(makeGateway({ deleteDocument }));
    await flush();
    await enterKb(host);

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-delete-d1"]'));
      await flush();
    });
    await act(async () => {
      click(buttonByText(dialogRoot(), '取消'));
      await flush();
    });

    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('重命名把新标题发出去，标题没改就不发请求', async () => {
    const renameDocument = vi.fn().mockResolvedValue({ ok: true, data: DOC });
    const host = render(makeGateway({ renameDocument }));
    await flush();
    await enterKb(host);

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-rename-d1"]'));
      await flush();
    });
    const input = dialogRoot().querySelector('[data-testid="kb-rename-input"]') as HTMLInputElement;
    // 打开时预填当前标题：让人在原文上改，而不是从空白开始重打
    expect(input.value).toBe('差旅制度');

    await act(async () => {
      setInputValue(input, '差旅制度（2026 版）');
      await flush();
    });
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="kb-rename-confirm"]'));
      await flush();
    });

    expect(renameDocument).toHaveBeenCalledWith('k1', 'd1', '差旅制度（2026 版）');
  });

  it('重复上传（409）走提示而不是报错：「已经在库里了」不是失败', async () => {
    const uploadFile = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      message: '这篇内容已经在库里了（《差旅制度》），没有重复入库。要替换请先删掉那一篇',
      unauthorized: false,
    });
    const host = render(makeGateway({ uploadFile }));
    await flush();
    await enterKb(host);

    const input = host.querySelector('[data-testid="kb-file-input"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([1])], '差旅制度.docx')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });

    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('已经在库里了'));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('已经在库里了'));
  });
});

describe('回收站（软删 / 恢复 / 彻底删除）', () => {
  const TRASHED = { ...DOC, deletedAt: '2026-10-25T02:00:00Z' };

  /** 回收站与正常列表由同一个接口的两个口径返回，用参数区分 */
  function twoViews(normal: KbDocument[], trashed: KbDocument[]) {
    return vi.fn((_kbId: string, input?: { trashed?: boolean }) =>
      Promise.resolve<KbApiResult<KbDocument[]>>({
        ok: true,
        data: input?.trashed ? trashed : normal,
      }),
    );
  }

  it('切到回收站会换一个口径请求，并把行操作换成「恢复 / 彻底删除」', async () => {
    const listDocuments = twoViews([DOC], [TRASHED]);
    const host = render(makeGateway({ listDocuments }));
    await flush();
    await enterKb(host);
    expect(host.querySelector('[data-testid="kb-doc-rename-d1"]')).toBeTruthy();

    await act(async () => {
      click(host.querySelector('[data-testid="kb-trash-toggle"]'));
      await flush();
    });

    // 服务端有两个口径，前端就必须真的去要第二个（本地筛等于把两件事混成一件）
    expect(listDocuments).toHaveBeenCalledWith('k1', { trashed: true });
    expect(host.querySelector('[data-testid="kb-doc-restore-d1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="kb-doc-purge-d1"]')).toBeTruthy();
    // 回收站里的文档不该还能「改名」（它不是正常资料了）
    expect(host.querySelector('[data-testid="kb-doc-rename-d1"]')).toBeNull();
  });

  it('回收站为空时的文案要说「空的」，不能复用「这个知识库还没有文档」', async () => {
    const host = render(makeGateway({ listDocuments: twoViews([DOC], []) }));
    await flush();
    await enterKb(host);

    await act(async () => {
      click(host.querySelector('[data-testid="kb-trash-toggle"]'));
      await flush();
    });

    expect(host.textContent).toContain('回收站是空的');
    expect(host.textContent).not.toContain('这个知识库还没有文档');
  });

  it('恢复直接调接口并重读回收站列表（不本地插一行）', async () => {
    const restoreDocument = vi.fn().mockResolvedValue({ ok: true, data: DOC });
    const listDocuments = twoViews([], [TRASHED]);
    const host = render(makeGateway({ restoreDocument, listDocuments }));
    await flush();
    await enterKb(host);
    await act(async () => {
      click(host.querySelector('[data-testid="kb-trash-toggle"]'));
      await flush();
    });
    const before = listDocuments.mock.calls.length;

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-restore-d1"]'));
      await flush();
    });

    expect(restoreDocument).toHaveBeenCalledWith('k1', 'd1');
    expect(listDocuments.mock.calls.length).toBeGreaterThan(before);
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('已恢复'));
  });

  it('彻底删除要自己的确认弹窗，并带上 purge=true（和「删除」不是一回事）', async () => {
    const deleteDocument = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const listDocuments = twoViews([], [TRASHED]);
    const host = render(makeGateway({ deleteDocument, listDocuments }));
    await flush();
    await enterKb(host);
    await act(async () => {
      click(host.querySelector('[data-testid="kb-trash-toggle"]'));
      await flush();
    });

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-purge-d1"]'));
      await flush();
    });
    expect(dialogRoot().textContent).toContain('无法恢复');
    expect(deleteDocument).not.toHaveBeenCalled();

    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="kb-purge-confirm"]'));
      await flush();
    });

    expect(deleteDocument).toHaveBeenCalledWith('k1', 'd1', { purge: true });
  });
});

describe('改可见范围（库级设置）', () => {
  it('打开时回填当前范围，点掉「成员」后保存把角色与部门一起下发', async () => {
    const listKbs = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ ...KB, allowedRoles: ['member', 'admin', 'owner'], allowedDepartments: ['d1'] }],
    });
    const updateKbVisibility = vi.fn().mockResolvedValue({
      ok: true,
      data: { ...KB, allowedDepartments: ['d1'] },
    });
    const host = render(makeGateway({ listKbs, updateKbVisibility }));
    await flush();
    await enterKb(host);
    await pickMenu(host, 'kb-more-menu', 'members');

    // 当前值必须看得见，否则用户不知道这次是收紧还是放开
    expect(dialogRoot().textContent).toContain('技术部');

    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="kb-scope-role-member"]'));
      await flush();
    });
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="kb-scope-save"]'));
      await flush();
    });

    expect(updateKbVisibility).toHaveBeenCalledWith('k1', {
      allowedRoles: ['admin', 'owner'],
      allowedDepartments: ['d1'],
    });
  });

  /**
   * 管理员 / 所有者**不可关闭**：`visibility.py::allows()` 对它们是无条件放行
   * （管理豁免，少了它会出现「建完看不见、也改不了」的死锁）。
   *
   * 以前这里画的是可点的 chip —— 点得动但不改变任何结果，用户会以为「我把管理员
   * 关了」，然后发现同事照样看得见，进而怀疑整个权限系统。
   */
  it('管理员与所有者是固定开着的，点不动', async () => {
    const updateKbVisibility = vi.fn();
    const host = render(makeGateway({ updateKbVisibility }));
    await flush();
    await enterKb(host);
    await pickMenu(host, 'kb-more-menu', 'members');

    for (const role of ['admin', 'owner']) {
      const chip = dialogRoot().querySelector(`[data-testid="kb-scope-role-${role}"]`);
      expect(chip).toBeTruthy();
      expect(chip!.className).toContain('Mui-disabled');
    }
  });
});

describe('团队级成员（与库级可见范围是两层）', () => {
  it('团队视图的「成员与权限」列出组织成员与角色，改角色走组织接口', async () => {
    const listMembers = vi.fn().mockResolvedValue({
      ok: true,
      data: [{ userId: 'u1', email: 'one@corp.example', role: 'member', joinedAt: 'x' }],
    });
    const updateMemberRole = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { userId: 'u1', email: 'one@corp.example', role: 'admin', joinedAt: 'x' } });
    const host = render(makeGateway({ listMembers, updateMemberRole }));
    await flush();

    // 团队视图（没选库）：「⋯」的第一个入口是团队的人，不是某本库的可见范围
    await pickMenu(host, 'kb-more-menu', 'members');
    expect(dialogRoot().textContent).toContain('one@corp.example');
    expect(listMembers).toHaveBeenCalledWith('o1');

    const select = dialogRoot().querySelector(
      '[data-testid="team-member-role-u1"]',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    await act(async () => {
      select.value = 'admin';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });

    expect(updateMemberRole).toHaveBeenCalledWith('o1', 'u1', 'admin');
  });
});

describe('连不上云端（status=0）', () => {
  it('报出地址，并补一句「怎么把它拉起来」——只报「连不上」等于把排查成本丢给用户', async () => {
    const gateway = makeGateway({
      listOrgs: vi.fn().mockResolvedValue({
        ok: false,
        status: 0,
        message: '无法连接云端服务（http://127.0.0.1:8910）',
        unauthorized: false,
      }),
    });
    const host = render(gateway);
    await flush();

    expect(host.textContent).toContain('无法连接云端服务（http://127.0.0.1:8910）');
    expect(host.textContent).toContain('uvicorn app.main:app --port 8910');
  });

  it('403 是业务语义，**不能**贴「请启动服务」', async () => {
    const gateway = makeGateway({
      listOrgs: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        message: '当前角色无权访问该知识库',
        unauthorized: false,
      }),
    });
    const host = render(gateway);
    await flush();

    expect(host.textContent).toContain('当前角色无权访问该知识库');
    expect(host.textContent).not.toContain('uvicorn');
  });
});

describe('写操作', () => {
  it('新建文档（粘贴正文）成功后刷新文档列表（用户能立刻看到刚写的那篇）', async () => {
    const listDocuments = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValue({ ok: true, data: [DOC] });
    const uploadDocument = vi.fn().mockResolvedValue({ ok: true, data: DOC });
    const host = render(makeGateway({ listDocuments, uploadDocument }));
    await flush();
    await enterKb(host);
    await pickMenu(host, 'kb-add-menu', 'new-doc');

    setInputValue(dialogRoot().querySelector('[data-testid="doc-title"]') as HTMLInputElement, '差旅制度');
    setInputValue(
      dialogRoot().querySelector('[data-testid="doc-content"]') as HTMLTextAreaElement,
      '报销流程：走财务邮箱。',
    );
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="doc-submit"]'));
      await flush();
    });

    expect(uploadDocument).toHaveBeenCalledWith('k1', {
      title: '差旅制度',
      content: '报销流程：走财务邮箱。',
    });
    // 上传后重拉了一次文档列表
    expect(listDocuments).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('差旅制度');
  });
});
