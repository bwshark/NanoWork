/**
 * 云端组织资产 API 客户端（FR-2.6）。
 *
 * 与 `lib/project/projectClient.ts` 同一套约定：不读全局状态、不抛异常、错误码保留
 * 业务语义；请求实现走共用的 `lib/net/authedRequest.ts`（401 换票重放只有那一份）。
 *
 * 三条与界面直接相关的语义：
 * 1. **403 = 角色不够**（发布 / 撤回要组织 admin）。普通成员点发布必须看到「权限不足」，
 *    而不是「组织不存在」。
 * 2. **404 = 不是本组织成员**（服务端刻意不区分「组织不存在」与「你不是成员」，
 *    也包含「这条资产不属于这个组织」）。
 * 3. **发布/修改会把服务端的校验文案原样带回来**（`payload` 缺字段、带了 `path`
 *    之类）。界面要显示 `message`，不要再翻译成一句笼统的「发布失败」——那句文案
 *    是唯一能告诉用户「到底哪一项不合格」的东西。
 */

import type { ApiResult, AuthedRequestConfig } from '@/lib/net/authedRequest';
import { authedRequest } from '@/lib/net/authedRequest';
import type { OrgAsset, OrgAssetKind } from '@/types/orgAsset';

/** 未登录（与知识库 / 项目分开：三个页面可能一个能用一个不能用，话要说清是哪个）。 */
export const ORG_ASSET_LOGIN_REQUIRED = '组织资产在云端，需要先登录账户';

/** 「票过期且换票失败」：与「未登录」是相反的事实，不能共用一句话。 */
export const ORG_ASSET_SESSION_EXPIRED = '登录状态已过期，需要重新登录';

export interface PublishAssetInput {
  kind: OrgAssetKind;
  name: string;
  description?: string;
  payload: Record<string, unknown>;
}

export interface UpdateAssetInput {
  name?: string;
  description?: string;
  payload?: Record<string, unknown>;
}

export interface OrgAssetGateway {
  listAssets(orgId: string, input?: { kind?: OrgAssetKind }): Promise<ApiResult<OrgAsset[]>>;
  publishAsset(orgId: string, input: PublishAssetInput): Promise<ApiResult<OrgAsset>>;
  updateAsset(
    orgId: string,
    assetId: string,
    input: UpdateAssetInput,
  ): Promise<ApiResult<OrgAsset>>;
  withdrawAsset(orgId: string, assetId: string): Promise<ApiResult<undefined>>;
}

export function createOrgAssetGateway(config: AuthedRequestConfig): OrgAssetGateway {
  const call = <T>(path: string, init?: { method?: string; body?: unknown }) =>
    authedRequest<T>(config, path, init);
  const enc = encodeURIComponent;

  return {
    listAssets: (orgId, input) => {
      const query = input?.kind ? `?kind=${enc(input.kind)}` : '';
      return call<OrgAsset[]>(`/api/orgs/${enc(orgId)}/assets${query}`);
    },
    publishAsset: (orgId, input) =>
      call<OrgAsset>(`/api/orgs/${enc(orgId)}/assets`, { method: 'POST', body: input }),
    updateAsset: (orgId, assetId, input) =>
      call<OrgAsset>(`/api/orgs/${enc(orgId)}/assets/${enc(assetId)}`, {
        method: 'PATCH',
        body: input,
      }),
    withdrawAsset: (orgId, assetId) =>
      call<undefined>(`/api/orgs/${enc(orgId)}/assets/${enc(assetId)}`, {
        method: 'DELETE',
      }),
  };
}
