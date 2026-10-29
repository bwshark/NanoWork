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
  waitForSettled,
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
    fetchAsset: vi.fn(),
    uploadAsset: vi.fn(),
    // 「按原格式打开」的三个调用：默认桩拿不到原文件 → 抽屉退回正文（老用例行为不变）
    getFilePreview: vi.fn(),
    buildFilePreview: vi.fn(),
    getPreviewPdf: vi.fn(),
    getWorkbook: vi.fn(),
    buildWorkbook: vi.fn(),
    getDocument: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { ...DOC, content: '报销流程：走财务邮箱。' } }),
    uploadDocument: vi.fn().mockResolvedValue({ ok: true, data: DOC }),
    uploadFile: vi.fn().mockResolvedValue({ ok: true, data: { ...DOC, kind: 'docx' } }),
    renameDocument: vi.fn(),
    updateDocument: vi.fn(),
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

  it('同一篇文档的多条命中收成一张卡，并点得开（不再是一块一卡、点不动）', async () => {
    const HIT2 = { ...HIT, chunkId: 'c2', score: 0.31, snippet: '住宿标准：一线城市 500 元。' };
    const gateway = makeGateway({
      search: vi.fn().mockResolvedValue({ ok: true, data: [HIT, HIT2] }),
    });
    const host = render(gateway);
    await flush();
    await enterKb(host);

    setInputValue(host.querySelector('[data-testid="kb-query"]') as HTMLInputElement, '报销');
    await act(async () => {
      click(buttonByText(host, '检索'));
      await flush();
    });

    // 两条命中 → 一张卡（同一篇文档），标题只出现一次
    expect(host.querySelectorAll('[data-testid="kb-hit-doc-d1"]').length).toBe(1);
    expect(host.querySelector('[data-testid="kb-hits-count"]')!.textContent).toContain(
      '2 条命中 · 1 篇文档',
    );

    await act(async () => {
      click(host.querySelector('[data-testid="kb-hit-doc-d1"]'));
      await flush();
    });

    // 点命中 = 按 id 拉正文（不是「点不动」也不是「只换了下选中态」）
    expect(gateway.getDocument).toHaveBeenCalledWith('k1', 'd1');
    // 抽屉在 Portal 里，只能从 document 找
    await waitForSettled(() => document.querySelector('[data-testid="kb-doc-view-title"]') !== null);
    expect(document.querySelector('[data-testid="kb-doc-view-title"]')!.textContent).toContain(
      '差旅制度',
    );
  });

  it('命中片段里的查询词被标出来（否则要自己逐字比对）', async () => {
    const host = render(makeGateway());
    await flush();
    await enterKb(host);

    setInputValue(host.querySelector('[data-testid="kb-query"]') as HTMLInputElement, '报销');
    await act(async () => {
      click(buttonByText(host, '检索'));
      await flush();
    });

    const marks = [...host.querySelectorAll('[data-testid="kb-hits"] mark')].map(
      (node) => node.textContent,
    );
    expect(marks).toContain('报销');
  });

  it('「清空」收起结果面板（输入框留着，改词再搜是常态）', async () => {
    const host = render(makeGateway());
    await flush();
    await enterKb(host);

    setInputValue(host.querySelector('[data-testid="kb-query"]') as HTMLInputElement, '报销');
    await act(async () => {
      click(buttonByText(host, '检索'));
      await flush();
    });

    await act(async () => {
      click(host.querySelector('[data-testid="kb-hits-clear"]'));
      await flush();
    });

    expect(host.querySelector('[data-testid="kb-hits"]')).toBeNull();
    expect((host.querySelector('[data-testid="kb-query"]') as HTMLInputElement).value).toBe('报销');
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

  /**
   * 抽屉的三条「不丢内容」判据。
   *
   * 写正文是一个会停很久的动作，所以这里的失败代价不是「多一次点击」而是「几百字
   * 没了」。三条都要成立：留空标题有兜底、关掉能留住草稿、失败不清稿。
   */
  it('标题留空时用正文首行兜底（先想标题是反的）', async () => {
    const uploadDocument = vi.fn().mockResolvedValue({ ok: true, data: DOC });
    const host = render(makeGateway({ uploadDocument }));
    await flush();
    await enterKb(host);
    await pickMenu(host, 'kb-add-menu', 'new-doc');

    setInputValue(
      dialogRoot().querySelector('[data-testid="doc-content"]') as HTMLTextAreaElement,
      '\n# 差旅报销制度（2026 版）\n\n报销流程：走财务邮箱。',
    );
    await act(async () => {
      await flush();
    });
    // 提交按钮只看正文：标题不是必填项
    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="doc-submit"]'));
      await flush();
    });

    expect(uploadDocument).toHaveBeenCalledWith(
      'k1',
      expect.objectContaining({ title: '差旅报销制度（2026 版）' }),
    );
  });

  it('「保留草稿并关闭」之后重开抽屉，内容还在', async () => {
    const host = render(makeGateway());
    await flush();
    await enterKb(host);
    await pickMenu(host, 'kb-add-menu', 'new-doc');

    setInputValue(
      dialogRoot().querySelector('[data-testid="doc-content"]') as HTMLTextAreaElement,
      '报销流程：走财务邮箱。',
    );
    await act(async () => {
      await flush();
    });
    await act(async () => {
      click(document.querySelector('[data-testid="doc-drawer-close"]'));
      await flush();
    });
    // 有内容时先问一句（不问就等于关一次丢一次）。确认框也是 Portal，只能从 document 找
    await act(async () => {
      click(document.querySelector('[data-testid="doc-keep-confirm"]'));
      await flush();
    });
    // 抽屉是滑出动画：等它真的卸载再重开，否则会同时挂两个 [role=dialog]
    await waitForSettled(() => document.querySelector('[data-testid="doc-content"]') === null);

    await pickMenu(host, 'kb-add-menu', 'new-doc');
    const body = dialogRoot().querySelector('[data-testid="doc-content"]') as HTMLTextAreaElement;
    expect(body.value).toBe('报销流程：走财务邮箱。');
  });

  it('「丢弃并关闭」把草稿清干净（不留下上次的残稿）', async () => {
    const host = render(makeGateway());
    await flush();
    await enterKb(host);
    await pickMenu(host, 'kb-add-menu', 'new-doc');

    setInputValue(
      dialogRoot().querySelector('[data-testid="doc-content"]') as HTMLTextAreaElement,
      '临时写两句',
    );
    await act(async () => {
      await flush();
    });
    await act(async () => {
      click(document.querySelector('[data-testid="doc-drawer-close"]'));
      await flush();
    });
    await act(async () => {
      click(document.querySelector('[data-testid="doc-discard-confirm"]'));
      await flush();
    });
    await waitForSettled(() => document.querySelector('[data-testid="doc-content"]') === null);

    await pickMenu(host, 'kb-add-menu', 'new-doc');
    const body = dialogRoot().querySelector('[data-testid="doc-content"]') as HTMLTextAreaElement;
    expect(body.value).toBe('');
  });
});

/**
 * 阅读抽屉（点列表里的一行）。
 *
 * 这一组守的是「点开之后到底看到了什么」：正文是**另取**的一份数据（列表只有元数据），
 * 所以四件事必须分别成立 —— 取对了、术语不串、失败说实话、删了要跟着关。
 */
/** 组织角色换成所有者（写权限 = admin/owner） */
function ownerGateway(overrides: Partial<KbGateway> = {}): KbGateway {
  return makeGateway({
    listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [{ ...ORG, role: 'owner' }] }),
    ...overrides,
  });
}

describe('阅读抽屉', () => {
  it('点一行就打开抽屉，并按 id 另取正文', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      ok: true,
      data: { ...DOC, content: '报销流程：走财务邮箱。\n\n住宿按城市分级。' },
    });
    const host = render(makeGateway({ getDocument }));
    await flush();
    await enterKb(host);

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
      await flush();
    });

    expect(getDocument).toHaveBeenCalledWith('k1', 'd1');
    // 标题来自列表（先画出来），正文来自详情
    expect(dialogRoot().textContent).toContain('差旅制度');
    const body = dialogRoot().querySelector('[data-testid="kb-doc-view-body"]');
    expect(body?.textContent).toContain('住宿按城市分级');
  });

  it('点行内的改名按钮不会顺带把阅读抽屉也打开', async () => {
    const getDocument = vi.fn();
    const host = render(makeGateway({ getDocument }));
    await flush();
    await enterKb(host);

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-rename-d1"]'));
      await flush();
    });

    // 命名冲突：行是"打开"，按钮是"改名"，两者不能串
    expect(getDocument).not.toHaveBeenCalled();
    expect(dialogRoot().textContent).toContain('重命名文档');
  });

  it('正文读不到时原样报出服务端那句，标题照旧显示（不然不知道点开了哪篇）', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      message: '当前角色无权访问该知识库',
      unauthorized: false,
    });
    const host = render(makeGateway({ getDocument }));
    await flush();
    await enterKb(host);

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
      await flush();
    });

    expect(dialogRoot().querySelector('[data-testid="kb-doc-view-error"]')?.textContent).toBe(
      '当前角色无权访问该知识库',
    );
    expect(dialogRoot().textContent).toContain('差旅制度');
    // 不能同时又渲染一个空正文的结论
    expect(dialogRoot().querySelector('[data-testid="kb-doc-view-body"]')).toBeNull();
  });

  it('删掉正在读的那一篇，抽屉跟着关（否则它挂着一个不存在的正文）', async () => {
    const deleteDocument = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const listDocuments = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [DOC] })
      .mockResolvedValue({ ok: true, data: [] });
    const host = render(makeGateway({ deleteDocument, listDocuments }));
    await flush();
    await enterKb(host);

    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
      await flush();
    });
    expect(dialogRoot().textContent).toContain('差旅制度');

    // 抽屉里的「⋯ → 删除（进回收站）」走的是同一个确认弹窗
    await act(async () => {
      click(document.querySelector('[data-testid="kb-doc-view-menu"]'));
      await flush();
    });
    await act(async () => {
      click(document.querySelector('[data-testid="kb-doc-delete-from-view"]'));
      await flush();
    });
    await act(async () => {
      click(document.querySelector('[data-testid="kb-delete-confirm"]'));
      await flush();
    });

    await waitForSettled(
      () => document.querySelector('[data-testid="kb-doc-view-title"]') === null,
    );
    expect(document.querySelector('[data-testid="kb-doc-view-title"]')).toBeNull();
  });

  /**
   * 文档里的图片。
   *
   * 关键约束：`<img src>` **不会**带 `Authorization` 头，而图片接口要 Bearer 票。
   * 所以图片只能由 JS 带票取回字节、再换成 `blob:` 地址 —— 界面里看到的
   * `blob:http://...` 就是这么来的。
   */
  /** jsdom 不实现 blob 地址，这里造一个假的（用完还原）。 */
  function withBlobUrl() {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    let counter = 0;
    URL.createObjectURL = () => `blob:http://localhost/${++counter}`;
    URL.revokeObjectURL = () => undefined;
    return () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    };
  }

  /** 含一张图的文档。 */
  function imageDocument() {
    return vi.fn().mockResolvedValue({
      ok: true,
      data: { ...DOC, content: '架构如下：\n\n![系统架构图](asset:aaa111)' },
    });
  }

  it('文档里的图片渲染成 <img>（地址由带票取回的字节换出来）', async () => {
    const restore = withBlobUrl();
    try {
      const fetchAsset = vi.fn().mockResolvedValue({ ok: true, data: new Blob(['img']) });
      const host = render(
        makeGateway({
          getDocument: imageDocument(),
          fetchAsset,
          // 所有者 → 有写权限 → 走编辑器路径
          listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [{ ...ORG, role: 'owner' }] }),
        }),
      );
      await flush();
      await enterKb(host);
      await act(async () => {
        click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
        await flush();
      });
      await waitForSettled(() => document.querySelector('[data-testid="kb-editor"] img') !== null);

      // 票是 JS 带上的（`<img>` 自己不会带 Authorization 头）
      expect(fetchAsset).toHaveBeenCalledWith('k1', 'aaa111');
      const image = document.querySelector('[data-testid="kb-editor"] img') as HTMLImageElement;
      expect(image.getAttribute('src')).toBe('blob:http://localhost/1');
      expect(image.getAttribute('alt')).toBe('系统架构图');
    } finally {
      restore();
    }
  });

  it('只读路径（普通成员）也渲染出图 —— 两条路径共用同一份替换结果', async () => {
    const restore = withBlobUrl();
    try {
      const fetchAsset = vi.fn().mockResolvedValue({ ok: true, data: new Blob(['img']) });
      const host = render(makeGateway({ getDocument: imageDocument(), fetchAsset }));
      await flush();
      await enterKb(host);
      await act(async () => {
        click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
        await flush();
      });
      await waitForSettled(
        () => document.querySelector('[data-testid="kb-doc-view-body"] img') !== null,
      );

      const image = document.querySelector(
        '[data-testid="kb-doc-view-body"] img',
      ) as HTMLImageElement;
      expect(image.getAttribute('src')).toBe('blob:http://localhost/1');
    } finally {
      restore();
    }
  });

  it('保存时把 blob 地址换回 asset:<id>（否则换个环境打开全是坏图）', async () => {
    const restore = withBlobUrl();
    try {
      const fetchAsset = vi.fn().mockResolvedValue({ ok: true, data: new Blob(['img']) });
      const updateDocument = vi.fn().mockResolvedValue({ ok: true, data: { ...DOC, chunkCount: 1 } });
      const host = render(
        makeGateway({
          getDocument: imageDocument(),
          fetchAsset,
          updateDocument,
          listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [{ ...ORG, role: 'owner' }] }),
        }),
      );
      await flush();
      await enterKb(host);
      await act(async () => {
        click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
        await flush();
      });
      await waitForSettled(() => document.querySelector('[data-testid="kb-editor"] img') !== null);

      const editor = dialogRoot().querySelector('[data-testid="kb-editor"]') as HTMLElement;
      // **追加**而不是替换整个 innerHTML：替换会把那张图一起删掉，
      // 那就测不到「图片引用在保存后还在不在」了
      editor.insertAdjacentHTML('beforeend', '<div>改过的正文</div>');
      await act(async () => {
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
      });
      await act(async () => {
        click(dialogRoot().querySelector('[data-testid="kb-doc-view-save"]'));
        await flush();
      });

      const sent = (updateDocument.mock.calls[0] as unknown as [string, string, { content: string }])[2]
        .content;
      expect(sent).toContain('asset:aaa111');
      expect(sent).not.toContain('blob:');
    } finally {
      restore();
    }
  });


/**
 * 粘贴 / 选文件插图。
 *
 * 图片是「**先入库、正文后引用**」：粘贴时要立刻看到图，不能等文档保存。
 * 这一组守的是：图片走上传、文本不走；插进去的是**可加载地址**（不是 base64），
 * 而存回去的是 `asset:<id>`。
 */
describe('插入图片', () => {
  /** jsdom 不实现 blob 地址与 execCommand，这里造假的。 */
  function withBrowserStubs() {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalExec = document.execCommand;
    let counter = 0;
    URL.createObjectURL = () => `blob:http://localhost/${++counter}`;
    URL.revokeObjectURL = () => undefined;
    const execCommand = vi.fn();
    (document as unknown as { execCommand: unknown }).execCommand = execCommand;
    return {
      execCommand,
      restore: () => {
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
        (document as unknown as { execCommand: unknown }).execCommand = originalExec;
      },
    };
  }

  /** 造一个带图片的 paste 事件。 */
  function pasteImage(file: File, text = ''): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        getData: () => text,
      },
    });
    return event;
  }

  it('粘贴截图：先上传拿到 id，再在光标处插图', async () => {
    const stubs = withBrowserStubs();
    try {
      const uploadAsset = vi.fn().mockResolvedValue({
        ok: true,
        data: { id: 'img-1', mime: 'image/png', bytesLen: 3, alt: '截图' },
      });
      const host = render(ownerGateway({ uploadAsset }));
      await flush();
      await enterKb(host);
      await act(async () => {
        click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
        await flush();
      });
      await waitForSettled(() => document.querySelector('[data-testid="kb-editor"]') !== null);

      const editor = document.querySelector('[data-testid="kb-editor"]') as HTMLElement;
      const file = new File([new Uint8Array([1, 2, 3])], '截图.png', { type: 'image/png' });
      await act(async () => {
        editor.dispatchEvent(pasteImage(file));
        await flush();
      });
      await waitForSettled(() => uploadAsset.mock.calls.length > 0);

      // 上传的是 base64（不带 data URL 前缀），文件名用来说明图注
      expect(uploadAsset).toHaveBeenCalledWith(
        'k1',
        expect.objectContaining({ filename: '截图.png', contentBase64: expect.any(String) }),
      );
      // 插进去的是**可加载地址**（blob），不是 base64 —— base64 会把整块文本撑爆
      await waitForSettled(() => stubs.execCommand.mock.calls.length > 0);
      const html = String(stubs.execCommand.mock.calls[0][2] ?? '');
      expect(html).toContain('blob:http://localhost/');
      expect(html).toContain('alt="截图"');
    } finally {
      stubs.restore();
    }
  });

  it('粘贴文字**不**触发上传（还是只取纯文本）', async () => {
    const stubs = withBrowserStubs();
    try {
      const uploadAsset = vi.fn();
      const host = render(ownerGateway({ uploadAsset }));
      await flush();
      await enterKb(host);
      await act(async () => {
        click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
        await flush();
      });
      await waitForSettled(() => document.querySelector('[data-testid="kb-editor"]') !== null);

      const editor = document.querySelector('[data-testid="kb-editor"]') as HTMLElement;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { items: [], getData: () => '纯文字内容' },
      });
      await act(async () => {
        editor.dispatchEvent(event);
        await flush();
      });

      expect(uploadAsset).not.toHaveBeenCalled();
      expect(stubs.execCommand).toHaveBeenCalledWith('insertText', false, '纯文字内容');
    } finally {
      stubs.restore();
    }
  });

  it('选文件上传：走同一个上传接口，然后插进编辑器', async () => {
    const stubs = withBrowserStubs();
    try {
      const uploadAsset = vi.fn().mockResolvedValue({
        ok: true,
        data: { id: 'img-2', mime: 'image/png', bytesLen: 3, alt: '架构图' },
      });
      const host = render(ownerGateway({ uploadAsset }));
      await flush();
      await enterKb(host);
      await act(async () => {
        click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
        await flush();
      });
      await waitForSettled(() => document.querySelector('[data-testid="kb-editor"]') !== null);

      const input = document.querySelector(
        '[data-testid="kb-doc-image-input"]',
      ) as HTMLInputElement;
      expect(input).toBeTruthy();
      const file = new File([new Uint8Array([1, 2, 3])], '架构图.png', { type: 'image/png' });
      await act(async () => {
        Object.defineProperty(input, 'files', { value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await flush();
      });
      await waitForSettled(() => uploadAsset.mock.calls.length > 0);

      expect(uploadAsset).toHaveBeenCalledWith(
        'k1',
        expect.objectContaining({ filename: '架构图.png' }),
      );
      await waitForSettled(() => stubs.execCommand.mock.calls.length > 0);
      expect(String(stubs.execCommand.mock.calls[0][2] ?? '')).toContain('alt="架构图"');
    } finally {
      stubs.restore();
    }
  });

  it('上传失败时如实报错，不插图（不假装成功）', async () => {
    const stubs = withBrowserStubs();
    try {
      const uploadAsset = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        message: '只支持 PNG / JPEG / GIF / WebP / BMP 图片',
        unauthorized: false,
      });
      const host = render(ownerGateway({ uploadAsset }));
      await flush();
      await enterKb(host);
      await act(async () => {
        click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
        await flush();
      });
      await waitForSettled(() => document.querySelector('[data-testid="kb-editor"]') !== null);

      const editor = document.querySelector('[data-testid="kb-editor"]') as HTMLElement;
      const file = new File([new Uint8Array([1])], 'x.exe', { type: 'image/png' });
      await act(async () => {
        editor.dispatchEvent(pasteImage(file));
        await flush();
      });
      await waitForSettled(() => uploadAsset.mock.calls.length > 0);
      await waitForSettled(() => (toast.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('只支持 PNG'),
      );
      expect(stubs.execCommand).not.toHaveBeenCalled();
    } finally {
      stubs.restore();
    }
  });
});

});

/**
 * 正文编辑（抽屉里改完存回知识库）。
 *
 * 这一组守的是「保存这条链路是否真的把改动落进库」以及**失败时不许假装成功**：
 * 脏标记被错误清掉的后果是用户以为存上了，然后关闭抽屉丢掉整段修改。
 */
describe('编辑正文', () => {
  /** 模拟在 contentEditable 里改内容（React 的 onInput 走事件委托） */
  async function typeInEditor(bodyHtml: string) {
    const editor = dialogRoot().querySelector('[data-testid="kb-editor"]') as HTMLElement;
    expect(editor).toBeTruthy();
    editor.innerHTML = bodyHtml;
    await act(async () => {
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
  }

  it('改完点保存：正文以 Markdown 发给服务端，块数来自服务端返回', async () => {
    const updateDocument = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { ...DOC, chunkCount: 3, chars: 12 } });
    const host = render(ownerGateway({ updateDocument }));
    await flush();
    await enterKb(host);
    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
      await flush();
    });

    // 编辑区里是富文本 DOM（加粗 + 两段），存回去必须是 Markdown
    await typeInEditor('<div><strong>改过的</strong>正文</div><div>第二段</div>');
    expect(dialogRoot().querySelector('[data-testid="kb-doc-view-status"]')?.textContent).toBe(
      '未保存',
    );

    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="kb-doc-view-save"]'));
      await flush();
    });

    expect(updateDocument).toHaveBeenCalledWith('k1', 'd1', {
      content: '**改过的**正文\n\n第二段',
    });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('已保存'));
  });

  it('保存失败（409 与另一篇重复）时脏标记还在——不能假装存上了', async () => {
    const updateDocument = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      message: '这段内容和库里的《差旅制度》完全一样，没有保存。',
      unauthorized: false,
    });
    const host = render(ownerGateway({ updateDocument }));
    await flush();
    await enterKb(host);
    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
      await flush();
    });
    await typeInEditor('<div>和别的一样的内容</div>');

    await act(async () => {
      click(dialogRoot().querySelector('[data-testid="kb-doc-view-save"]'));
      await flush();
    });

    // 判重是提示不是报错，但**必须留着脏标记**（否则用户以为存上了）
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('完全一样'));
    expect(dialogRoot().querySelector('[data-testid="kb-doc-view-status"]')?.textContent).toBe(
      '未保存',
    );
  });

  it('有未保存改动时关抽屉要先确认，选「放弃修改」才真的关', async () => {
    const host = render(ownerGateway());
    await flush();
    await enterKb(host);
    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
      await flush();
    });
    await typeInEditor('<div>临时改两句</div>');

    await act(async () => {
      click(document.querySelector('[data-testid="kb-doc-view-close"]'));
      await flush();
    });
    expect(document.body.textContent).toContain('还有未保存的修改');

    await act(async () => {
      click(document.querySelector('[data-testid="kb-doc-discard-edits"]'));
      await flush();
    });
    await waitForSettled(
      () => document.querySelector('[data-testid="kb-doc-view-title"]') === null,
    );
    expect(document.querySelector('[data-testid="kb-doc-view-title"]')).toBeNull();
  });

  it('没有写权限（普通成员）时不给编辑器，只读渲染正文', async () => {
    const host = render(makeGateway());
    await flush();
    await enterKb(host);
    await act(async () => {
      click(host.querySelector('[data-testid="kb-doc-row-d1"]'));
      await flush();
    });

    expect(dialogRoot().querySelector('[data-testid="kb-editor"]')).toBeNull();
    expect(dialogRoot().querySelector('[data-testid="kb-doc-view-save"]')).toBeNull();
    expect(dialogRoot().querySelector('[data-testid="kb-doc-view-body"]')?.textContent).toContain(
      '报销流程',
    );
  });
});
