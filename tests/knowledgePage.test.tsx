/**
 * 知识库页（M7 客户端）：三条「不给假象」的判据。
 *
 * 1. 没有登录 / 没有网关 → 明说要去登录，**不是**显示一个空列表（空列表会被读成
 *    「组织里没资料」）；
 * 2. 服务端说没权限（403）→ 原样把那句话说给用户，**不在客户端悄悄筛掉**
 *    （筛掉就把服务端的 bug 藏了）；
 * 3. 检索结果按服务端返回原样渲染（含分数），不二次过滤。
 */

import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePage } from '@/pages/knowledge/KnowledgePage';
import type { KbGateway } from '@/lib/kbClient';
import { buttonByText, click, flush, mount, setInputValue, unmount } from './helpers/reactMount';

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
  documentCount: 1,
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

function makeGateway(overrides: Partial<KbGateway> = {}): KbGateway {
  return {
    listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [ORG] }),
    createOrg: vi.fn().mockResolvedValue({ ok: true, data: ORG }),
    listKbs: vi.fn().mockResolvedValue({ ok: true, data: [KB] }),
    createKb: vi.fn().mockResolvedValue({ ok: true, data: KB }),
    listDocuments: vi.fn().mockResolvedValue({ ok: true, data: [DOC] }),
    uploadDocument: vi.fn().mockResolvedValue({ ok: true, data: DOC }),
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

afterEach(async () => {
  // 先让在途的加载 promise 落定再卸载：否则卸载后的 setState 会触发
  // 「update ... not wrapped in act」噪声，掩盖真正的失败
  await flush();
  unmount();
  vi.restoreAllMocks();
});

describe('未登录 / 空组织', () => {
  it('没有可用网关时说「需要登录」，而不是显示空列表', async () => {
    const host = render(undefined);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('需要先登录账户');
    expect(buttonByText(host, '去登录')).toBeTruthy();
  });

  it('没有任何组织时给出创建入口（不假装在加载）', async () => {
    const gateway = makeGateway({ listOrgs: vi.fn().mockResolvedValue({ ok: true, data: [] }) });
    const host = render(gateway);
    await flush();

    expect(host.textContent).toContain('还没有加入任何组织');
    expect(host.querySelector('[data-testid="new-org-name"]')).toBeTruthy();
  });
});

describe('组织 → 知识库 → 文档', () => {
  it('三级数据都渲染出来，且角色与可见范围可读', async () => {
    const host = render(makeGateway());
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('Acme');
    expect(text).toContain('制度库');
    expect(text).toContain('差旅制度');
    // 可见范围用人话展示（否则用户不知道同事为什么看不到）
    expect(text).toContain('成员 / 管理员 / 所有者可见');
  });

  it('检索把服务端返回的命中原样显示（含分数与片段）', async () => {
    const gateway = makeGateway();
    const host = render(gateway);
    await flush();

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
  it('上传成功后刷新文档列表（用户能立刻看到刚传的那篇）', async () => {
    const listDocuments = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValue({ ok: true, data: [DOC] });
    const uploadDocument = vi.fn().mockResolvedValue({ ok: true, data: DOC });
    const host = render(makeGateway({ listDocuments, uploadDocument }));
    await flush();

    setInputValue(host.querySelector('[data-testid="doc-title"]') as HTMLInputElement, '差旅制度');
    setInputValue(
      host.querySelector('[data-testid="doc-content"]') as HTMLTextAreaElement,
      '报销流程：走财务邮箱。',
    );
    await act(async () => {
      click(buttonByText(host, '入库'));
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
