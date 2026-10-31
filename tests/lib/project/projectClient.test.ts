import { describe, expect, it } from 'vitest';

import { createProjectGateway } from '@/lib/project/projectClient';

/**
 * 项目空间客户端：重点不是「能发请求」，而是 **404 / 403 的语义** 与
 * **共用件里的 401 换票重放确实也作用在项目这一侧**。
 *
 * 最后一条是这次重构的验收点：如果项目客户端另写了一份请求实现，
 * 「401 → 换票 → 重放一次」就不会生效，而本用例会红。
 */

type Call = { url: string; init: RequestInit };

function stubFetch(
  responder: (call: Call, index: number) => { status: number; body?: unknown },
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { status, body } = responder({ url: String(url), init }, calls.length - 1);
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
  it('列表路径带编码，默认不带 includeArchived', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: [] }));
    const gateway = createProjectGateway({ baseUrl: BASE, token: 'tk', fetchImpl });
    await gateway.listProjects('org/1');
    expect(calls[0].url).toBe('https://cloud.example.com/api/orgs/org%2F1/projects');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tk');
  });

  it('includeArchived 走查询串', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: [] }));
    const gateway = createProjectGateway({ baseUrl: BASE, token: 'tk', fetchImpl });
    await gateway.listProjects('o1', { includeArchived: true });
    expect(calls[0].url).toBe('https://cloud.example.com/api/orgs/o1/projects?includeArchived=true');
  });

  it('加库请求体只有 kbId', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: { id: 'k1' } }));
    const gateway = createProjectGateway({ baseUrl: BASE, token: 'tk', fetchImpl });
    await gateway.addKb('p1', 'k1');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ kbId: 'k1' });
  });
});

describe('错误语义', () => {
  it('404 原样透传（服务端用它表示「不是本组织成员」）', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, body: { detail: '项目不存在' } }));
    const gateway = createProjectGateway({ baseUrl: BASE, token: 'tk', fetchImpl });
    const result = await gateway.getProject('p1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).toBe('项目不存在');
    }
  });

  it('409 的业务文案要透传（比如「该用户不是本组织成员」）', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 409,
      body: { detail: '该用户不是本组织成员' },
    }));
    const gateway = createProjectGateway({ baseUrl: BASE, token: 'tk', fetchImpl });
    const result = await gateway.addMember('p1', 'x@y.z');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('该用户不是本组织成员');
  });

  it('204 删除不解析响应体', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 204 }));
    const gateway = createProjectGateway({ baseUrl: BASE, token: 'tk', fetchImpl });
    const result = await gateway.deleteProject('p1');
    expect(result).toEqual({ ok: true, data: undefined });
  });
});

describe('401 换票重放（共用件）', () => {
  it('刷新成功后用新票重放一次', async () => {
    let token = 'old';
    const { fetchImpl, calls } = stubFetch((_, index) =>
      index === 0 ? { status: 401, body: { detail: 'expired' } } : { status: 200, body: [] },
    );
    const gateway = createProjectGateway({
      baseUrl: BASE,
      token,
      getToken: () => token,
      refreshToken: async () => {
        token = 'new';
        return true;
      },
      fetchImpl,
    });

    const result = await gateway.listProjects('o1');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer new');
  });

  it('刷新失败就只请求一次，并标 unauthorized', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 401, body: { detail: 'expired' } }));
    const gateway = createProjectGateway({
      baseUrl: BASE,
      token: 'tk',
      refreshToken: async () => false,
      fetchImpl,
    });
    const result = await gateway.listProjects('o1');
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unauthorized).toBe(true);
  });
});

describe('canManage 由服务端决定', () => {
  it('原样透传，不在客户端重算角色', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: {
        project: {
          id: 'p1',
          orgId: 'o1',
          name: '项目',
          description: '',
          createdBy: 'u1',
          createdAt: '2026-10-31T00:00:00Z',
          archivedAt: '',
          memberCount: 2,
          kbCount: 0,
          myRole: 'member',
          canManage: true,
        },
        members: [],
        kbs: [],
      },
    }));
    const gateway = createProjectGateway({ baseUrl: BASE, token: 'tk', fetchImpl });
    const result = await gateway.getProject('p1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 角色是 member 但服务端说能管（他是组织管理员）——客户端不许「纠正」成 false
      expect(result.data.project.myRole).toBe('member');
      expect(result.data.project.canManage).toBe(true);
    }
  });
});
