import { describe, expect, it } from 'vitest';
import {
  KB_ROLE_LABELS,
  createKbGateway,
  createOrg,
  listKbs,
  listMyOrgs,
  reindexKb,
  retrievalInfo,
  searchOrgKbs,
  uploadDocument,
} from '@/lib/kbClient';

/**
 * 云端知识库客户端：**错误语义**是这组用例的重点。
 *
 * 云端是可选能力，网络/权限失败都不该把页面打成崩溃；而 403（没权限）与 404
 * （不存在 / 不是成员）对用户是两句不同的话——压成「请求失败」等于让用户
 * 去猜「是我没权限，还是资料本来就没有」。
 */

type Call = { url: string; init: RequestInit };

function stubFetch(
  responder: (call: Call) => { status: number; body?: unknown },
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const { status, body } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = 'https://cloud.example.com/';

describe('请求形状', () => {
  it('带 Bearer、去尾部斜杠、路径拼接正确', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: [] }));
    await listMyOrgs({ baseUrl: BASE, token: 'tk', fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://cloud.example.com/api/orgs');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tk');
  });

  it('id 会被 URL 编码（避免拼出一个别的路径）', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: [] }));
    await listKbs({ baseUrl: BASE, token: 'tk', fetchImpl }, 'a/b c');
    expect(calls[0].url).toBe('https://cloud.example.com/api/orgs/a%2Fb%20c/kbs');
  });

  it('POST 带 JSON body 与 Content-Type', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: { id: 'o1', name: 'X' } }));
    await createOrg({ baseUrl: BASE, token: 'tk', fetchImpl }, 'Acme');

    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(calls[0].init.body).toBe(JSON.stringify({ name: 'Acme' }));
  });

  it('未登录（token=null）时不带 Authorization 头', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 401, body: { detail: '未登录' } }));
    await listMyOrgs({ baseUrl: BASE, token: null, fetchImpl });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('错误语义', () => {
  it('403 保留服务端 detail，且不算「未登录」', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 403, body: { detail: '当前角色无权访问该知识库' } }));
    const result = await searchOrgKbs(
      { baseUrl: BASE, token: 'tk', fetchImpl },
      'o1',
      { query: '报销' },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      message: '当前角色无权访问该知识库',
      unauthorized: false,
    });
  });

  it('401 标记 unauthorized（页面据此引导去登录）', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: { detail: 'token 过期' } }));
    const result = await listMyOrgs({ baseUrl: BASE, token: 'stale', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unauthorized).toBe(true);
      expect(result.status).toBe(401);
    }
  });

  it('网络失败给 status=0，且文案带出**实际请求的地址**（不然只能猜是哪台没起）', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await listMyOrgs({ baseUrl: BASE, token: 'tk', fetchImpl });
    expect(result).toEqual({
      ok: false,
      status: 0,
      // BASE 带尾斜杠，文案里是归一后的地址（`normalizeBaseUrl` 去尾斜杠）
      message: '无法连接云端服务（https://cloud.example.com）',
      unauthorized: false,
    });
  });

  it('错误体不是 JSON 时退回状态码文案（不抛）', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    const result = await listMyOrgs({ baseUrl: BASE, token: 'tk', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('502');
  });
});

describe('成功路径', () => {
  it('上传文档返回块数', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 201,
      body: { id: 'd1', kbId: 'k1', title: '制度', chars: 10, chunkCount: 1, createdAt: 'x' },
    }));
    const result = await uploadDocument(
      { baseUrl: BASE, token: 'tk', fetchImpl },
      'k1',
      { title: '制度', content: '正文' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.chunkCount).toBe(1);
  });

  it('204 视为成功（删除类接口）', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 204 }));
    const result = await listKbs({ baseUrl: BASE, token: 'tk', fetchImpl }, 'o1');
    expect(result).toEqual({ ok: true, data: undefined });
  });
});

describe('网关装配', () => {
  it('每个方法都转发到对应端点', async () => {
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.url.endsWith('/api/orgs')) return { status: 200, body: [] };
      return { status: 200, body: [] };
    });
    const gateway = createKbGateway({ baseUrl: BASE, token: 'tk', fetchImpl });

    await gateway.listOrgs();
    await gateway.listKbs('o1');
    await gateway.search('o1', { query: 'q' });

    expect(calls.map((call) => call.url)).toEqual([
      'https://cloud.example.com/api/orgs',
      'https://cloud.example.com/api/orgs/o1/kbs',
      'https://cloud.example.com/api/orgs/o1/search',
    ]);
  });

  it('角色标签覆盖服务端三种角色（缺一种界面上就是裸英文）', () => {
    expect(Object.keys(KB_ROLE_LABELS).sort()).toEqual(['admin', 'member', 'owner']);
  });
});

describe('向量检索的两个端点', () => {
  it('retrievalInfo 不带 kbId 时走全站口径，带 kbId 时做 URL 编码', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: {} }));
    await retrievalInfo({ baseUrl: BASE, token: 'tk', fetchImpl });
    await retrievalInfo({ baseUrl: BASE, token: 'tk', fetchImpl }, 'kb/1 2');

    expect(calls[0].url).toBe('https://cloud.example.com/api/kb/retrieval');
    expect(calls[1].url).toBe('https://cloud.example.com/api/kb/retrieval?kbId=kb%2F1%202');
  });

  it('reindex 用 POST 打库级端点（GET 会 405，而 405 很容易被当成「没实现」）', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: { indexed: 3, total: 3, model: 'hash:64', error: '' },
    }));
    const result = await reindexKb({ baseUrl: BASE, token: 'tk', fetchImpl }, 'k1');

    expect(calls[0].url).toBe('https://cloud.example.com/api/kbs/k1/reindex');
    expect(calls[0].init.method).toBe('POST');
    expect(result.ok && result.data.indexed).toBe(3);
  });
});
