/**
 * 云端项目空间 API 客户端（FR-12.7 客户端第一块）。
 *
 * 与 `lib/kb/kbClient.ts` 同一套约定：**不读全局状态、不抛异常、错误码保留业务语义**。
 * 请求实现走共用的 `lib/net/authedRequest.ts` —— 401 换票重放只有那一份实现。
 *
 * 三条与界面直接相关的语义：
 * 1. **404 = 不是本组织成员**（服务端刻意不区分「项目不存在」与「你不是成员」）。
 *    界面不能把它翻译成「项目已被删除」。
 * 2. **403 = 权限不足**（不是 lead 也不是组织管理员）：与 404 是两句不同的话。
 * 3. `canManage` 由服务端算好，**前端不要重算**「我是不是 lead」—— 那就是第二套规则。
 */

import type { ApiResult, AuthedRequestConfig } from '@/lib/net/authedRequest';
import { authedRequest } from '@/lib/net/authedRequest';

export interface ProjectSummary {
  id: string;
  orgId: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  /** ISO 字符串，空串 = 未归档 */
  archivedAt: string;
  memberCount: number;
  kbCount: number;
  /** 我在项目里的角色（lead / member）；空串 = 我是组织成员但没加入 */
  myRole: string;
  /** 能不能改这个项目（lead 或组织管理员）。**以它为准，不要在前端重算** */
  canManage: boolean;
}

export interface ProjectMember {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

export interface ProjectKb {
  id: string;
  name: string;
  /** 在用文档数（回收站里的不算） */
  documentCount: number;
}

export interface ProjectDetail {
  project: ProjectSummary;
  members: ProjectMember[];
  /** 已按**我的**可见性过滤：看不到的库不会出现在这里（服务端两道闸） */
  kbs: ProjectKb[];
}

/** 未登录时的文案（与知识库分开：两个页面可能一个能用一个不能用，话要说清是哪个）。 */
export const PROJECT_LOGIN_REQUIRED = '项目空间在云端，需要先登录账户';

/** 「票过期且换票失败」：与「未登录」是相反的事实，不能共用一句话。 */
export const PROJECT_SESSION_EXPIRED = '登录状态已过期，需要重新登录';

export interface ProjectGateway {
  listProjects(
    orgId: string,
    input?: { includeArchived?: boolean },
  ): Promise<ApiResult<ProjectSummary[]>>;
  createProject(
    orgId: string,
    input: { name: string; description?: string },
  ): Promise<ApiResult<ProjectSummary>>;
  getProject(projectId: string): Promise<ApiResult<ProjectDetail>>;
  updateProject(
    projectId: string,
    input: { name?: string; description?: string; archived?: boolean },
  ): Promise<ApiResult<ProjectSummary>>;
  deleteProject(projectId: string): Promise<ApiResult<undefined>>;
  addMember(projectId: string, email: string): Promise<ApiResult<ProjectMember>>;
  removeMember(projectId: string, userId: string): Promise<ApiResult<undefined>>;
  /** 加库：服务端会先校验「你能不能读这本库」，403 表示你没权限，不是库不存在 */
  addKb(projectId: string, kbId: string): Promise<ApiResult<ProjectKb>>;
  removeKb(projectId: string, kbId: string): Promise<ApiResult<undefined>>;
}

export function createProjectGateway(config: AuthedRequestConfig): ProjectGateway {
  const call = <T>(path: string, init?: { method?: string; body?: unknown }) =>
    authedRequest<T>(config, path, init);
  // id 一律编码：项目 / 组织 id 是服务端生成的十六进制，但**用户可控的输入**（比如以后
  // 允许自定义 slug）不能靠「现在看起来安全」来兜底，拼出一个别的路径是静默越权。
  const enc = encodeURIComponent;

  return {
    listProjects: (orgId, input) => {
      const query = input?.includeArchived ? '?includeArchived=true' : '';
      return call<ProjectSummary[]>(`/api/orgs/${enc(orgId)}/projects${query}`);
    },
    createProject: (orgId, input) =>
      call<ProjectSummary>(`/api/orgs/${enc(orgId)}/projects`, {
        method: 'POST',
        body: input,
      }),
    getProject: (projectId) => call<ProjectDetail>(`/api/projects/${enc(projectId)}`),
    updateProject: (projectId, input) =>
      call<ProjectSummary>(`/api/projects/${enc(projectId)}`, { method: 'PATCH', body: input }),
    deleteProject: (projectId) =>
      call<undefined>(`/api/projects/${enc(projectId)}`, { method: 'DELETE' }),
    addMember: (projectId, email) =>
      call<ProjectMember>(`/api/projects/${enc(projectId)}/members`, {
        method: 'POST',
        body: { email },
      }),
    removeMember: (projectId, userId) =>
      call<undefined>(`/api/projects/${enc(projectId)}/members/${enc(userId)}`, {
        method: 'DELETE',
      }),
    addKb: (projectId, kbId) =>
      call<ProjectKb>(`/api/projects/${enc(projectId)}/kbs`, {
        method: 'POST',
        body: { kbId },
      }),
    removeKb: (projectId, kbId) =>
      call<undefined>(`/api/projects/${enc(projectId)}/kbs/${enc(kbId)}`, {
        method: 'DELETE',
      }),
  };
}
