/**
 * IM 频道领域模型（FR-010）。
 *
 * 渠道清单与配置字段对齐 nanobot 引擎 `nanobot/channels/*\/manifest.py`：
 * - dingtalk：clientId / clientSecret（必填）+ allowFrom；
 * - feishu / lark：appId / appSecret（必填）+ groupPolicy / allowFrom / topicIsolation，
 *   二者共用 nanobot `feishu` channel，经 `domain` 字段区分（feishu | lark），
 *   多实例经 `instances` 数组并存；
 * - weixin：token（必填）+ allowFrom；
 * - wecom：botId / secret（必填）+ allowFrom。
 *
 * 配置仅本地持久化（Zustand persist），同步时生成可合并进 nanobot
 * config.json 的 `channels` 片段（见 ai/runtime/nanobotHttp/channels.ts）。
 */

import type { SyncMetaFields } from './sync';

/** 支持的 IM 渠道（与 nanobot channel name 对齐；lark 为 feishu 的 domain 变体） */
export type ChannelKind = 'dingtalk' | 'feishu' | 'lark' | 'weixin' | 'wecom';

/** 频道同步状态 */
export type ChannelSyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

/** 群聊响应策略（对齐 nanobot feishu groupPolicy：open | mention） */
export type GroupPolicy = 'open' | 'mention';

/** IM 频道配置（一条配置 = nanobot 一个 channel 实例） */
export interface ChannelConfig extends SyncMetaFields {
  id: string;
  kind: ChannelKind;
  /** 是否启用（同步到 nanobot 时映射为 enabled） */
  enabled: boolean;
  /** 创建时间 ISO 8601 UTC（老数据缺失） */
  createdAt?: string;

  // —— 钉钉 / 企业微信 / 飞书(Lark) 凭证 ——
  /** 钉钉 Client ID */
  clientId?: string;
  /** 钉钉 Client Secret */
  clientSecret?: string;
  /** 飞书 / Lark App ID */
  appId?: string;
  /** 飞书 / Lark App Secret */
  appSecret?: string;
  /** 企业微信 Bot ID */
  botId?: string;
  /** 企业微信 Secret */
  botSecret?: string;
  /** 微信 iLink Token */
  token?: string;

  // —— 通用策略 ——
  /** 允许接入的用户白名单（空 = 不限制） */
  allowFrom: string[];
  /** 群聊响应策略（仅 feishu / lark 生效） */
  groupPolicy?: GroupPolicy;
  /** 群内按话题隔离会话（仅 feishu / lark 生效） */
  topicIsolation?: boolean;

  /** 最近一次同步时间（ISO 8601 UTC） */
  lastSyncAt?: string;
  /** 同步状态 */
  syncStatus: ChannelSyncStatus;
}

// ———— 扫码接入（settings.channel.connect.*，经网关认证 WebSocket 桥）————
// 契约对齐 nanobot 网关 webui_response 帧的 result 载荷（引擎侧已核验）。

/** 扫码接入轮询结果载荷（网关 settings.channel.connect.* 响应 result） */
export interface ChannelConnectPayload {
  /** 连接会话 id（后续 poll / cancel 需携带） */
  session_id?: string;
  /** 连接状态机 */
  status: 'pending' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
  /** 二维码内容（可扫的 URL，前端自行渲染二维码） */
  qr_url?: string;
  /** 建议轮询间隔（毫秒） */
  interval_ms?: number;
  /** 会话过期时间戳（毫秒） */
  expires_at_ms?: number;
  /** 附加提示信息 */
  message?: string;
  /** 额外验证挑战（如 'verify_code'） */
  challenge?: string;
  /** 验证码校验是否失败（challenge=verify_code 场景） */
  verification_failed?: boolean;
  /** 目标实例 id（飞书 / Lark） */
  instance_id?: string;
  /** 目标域（feishu | lark） */
  domain?: string;
  /** 扫码创建的应用 App ID */
  app_id?: string;
  /** 微信登录账号标识 */
  account?: string;
  /** 成功后是否需要重启网关才能生效 */
  requires_restart?: boolean;
}

/** 扫码接入统一返回（主进程 / platform 层：不抛异常，错误走 ok=false） */
export type ChannelConnectResponse =
  | { ok: true; result: ChannelConnectPayload }
  | { ok: false; error: string };
