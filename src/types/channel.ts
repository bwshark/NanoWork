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
// **wire 形状（`session_id` / `qr_url` …）不住在这里**：那是与 `/v1/chat/completions`
// 并列的另一条引擎协议，字段名与起始参数只允许出现在 `src/ai/runtime/nanobotHttp/`
// （ADR-020）。编码 / 解码与 camelCase 领域类型见 `nanobotHttp/channelConnect.ts`。

