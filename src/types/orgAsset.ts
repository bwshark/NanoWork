/**
 * 组织级资产（FR-2.6）：管理员把本机的专家 / 技能 / 提示词模板发布成全组织可见。
 *
 * ## 为什么要「载荷」这一层，而不是直接传实体
 *
 * 三种资产在客户端是三种完全不同的东西：专家是 `Agent`（localStorage 里的可变实体，
 * 带同步元数据）、技能是磁盘扫描产物（带 `path`）、提示词模板是「槽位 + 覆盖正文」。
 * 直接把它们序列化上云会踩两件事：
 *
 * 1. **机器 / 账号专属字段跟着上云**（`path` 是别人机器上的路径，`imBinding` 是别人
 *    账号的机器人绑定）；服务端会**拒绝**这类载荷，见 `cloud/app/orgassets/routes.py`。
 * 2. **实体的可变性被误认为共享**：`Agent.updatedAt` / `deviceId` 那套是同步层用来
 *    做 LWW 的，跨用户毫无意义，传上去只会让「谁改的」变得不可读。
 *
 * 所以载荷是**白名单构造**的对象（`lib/orgAsset/orgAssetPayload.ts`），不是实体的
 * 浅拷贝。少写一个字段只是少一份信息，多写一个字段就是泄露。
 *
 * ## 导入出来的本地 id 一律 `org:<资产 id>`
 *
 * 稳定且可判重：同一条资产导入两次是同一个 id（第二次是覆盖），列表里也能一眼看出
 * 「这个专家是组织给的」。反过来若每次导入都 genId()，用户点两下就会得到两个同名专家。
 */

import type { PromptSlotKind } from './prompt';

export type OrgAssetKind = 'agent' | 'skill' | 'prompt';

export const ORG_ASSET_KINDS: readonly OrgAssetKind[] = ['agent', 'skill', 'prompt'];

/** 界面上的种类标签（列表筛选与发布选择共用，避免两处文案漂移）。 */
export const ORG_ASSET_KIND_LABEL: Record<OrgAssetKind, string> = {
  agent: '专家',
  skill: '技能',
  prompt: '提示词模板',
};

/** 一句话说明（发布弹窗里告诉用户「这一项发出去会变成什么」）。 */
export const ORG_ASSET_KIND_DESC: Record<OrgAssetKind, string> = {
  agent: '人格、工具面与模型绑定的快照；导入后是一个新的专家',
  skill: '技能正文（前置提示词）与允许的工具；导入后出现在「技能」列表',
  prompt: '覆盖某个提示词槽位的正文；导入后直接生效，可随时恢复默认',
};

/** 导入产物的 id 前缀。**不要**与内置专家的 `builtin:` 混用：两者语义相反。 */
export const ORG_ASSET_ID_PREFIX = 'org:' as const;

/** 由云端资产 id 生成稳定的本地 id */
export function orgAssetLocalId(assetId: string): string {
  return `${ORG_ASSET_ID_PREFIX}${assetId}`;
}

/** 这个本地 id 是不是「从组织资产导入的」 */
export function isOrgAssetLocalId(id: string): boolean {
  return id.startsWith(ORG_ASSET_ID_PREFIX);
}

/** 云端资产（`GET /api/orgs/{org_id}/assets` 的返回项）。 */
export interface OrgAsset {
  id: string;
  orgId: string;
  kind: OrgAssetKind;
  name: string;
  description: string;
  /**
   * 载荷：形状随 `kind` 不同（见下面三个接口）。
   *
   * 类型是宽泛的 `Record`：服务端存的是自由 JSON，客户端**必须**按 kind 收窄后再用
   * （`lib/orgAsset/orgAssetPayload.ts` 的 `*FromOrgAsset` 就是那道收窄）。
   * 假装它是精确类型只会把「脏数据」变成「运行时崩溃」。
   */
  payload: Record<string, unknown>;
  publishedBy: string;
  /** 发布人邮箱（列表里显示「谁发的」） */
  publishedByEmail: string;
  publishedAt: string;
  updatedAt: string;
}

/** 专家载荷（`kind: 'agent'`）。可选字段的**存在性**有意义，见各字段注释。 */
export interface OrgAgentPayload {
  name?: string;
  systemPrompt: string;
  /** 引用的本机技能 id：导入端按「本地没有就忽略」处理，不是硬依赖 */
  skillIds?: string[];
  /** 省略 = 不限制；空数组 = 一个工具都不许（与 `Agent.toolAllow` 同口径） */
  toolAllow?: string[];
  toolDeny?: string[];
  promptDomain?: string;
  promptStyle?: string;
  /** 模型预设名。导入端要校验预设还在，否则每轮都会发不出去 */
  model?: string;
  /** emoji 或图片 URL。data: URL 不上云（会把载荷撑爆） */
  avatar?: string;
}

/** 技能载荷（`kind: 'skill'`）。**不含** `path` / `installedAt` —— 机器专属。 */
export interface OrgSkillPayload {
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  prompt: string;
  allowedTools?: string[];
  version?: string;
  userInvocable?: boolean;
}

/** 提示词模板载荷（`kind: 'prompt'`）：一个槽位的覆盖正文。 */
export interface OrgPromptPayload {
  kind: PromptSlotKind;
  key: string;
  text: string;
}
