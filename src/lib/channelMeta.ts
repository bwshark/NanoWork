/**
 * IM 渠道展示元数据与表单字段定义（UI 层单一事实来源）。
 *
 * 渠道清单、必填项与字段类型对齐 nanobot 引擎各 channel manifest
 * （nanobot/channels/<name>/manifest.py 的 SETUP_SPEC），保证配置弹窗
 * 收集的字段可被 nanobot 运行时直接消费。
 */
import type { ChannelKind } from '@/types';

/** 表单字段类型（对齐 manifest field kind） */
export type ChannelFieldKind = 'string' | 'secret' | 'list' | 'enum' | 'bool';

/** 单个配置字段描述 */
export interface ChannelFieldMeta {
  /** 字段 key（与 ChannelConfig 属性名一致） */
  key: string;
  /** 表单标签 */
  label: string;
  /** 字段类型 */
  kind: ChannelFieldKind;
  /** 占位提示 */
  placeholder?: string;
  /** 辅助说明 */
  hint?: string;
  /** enum 选项 */
  choices?: Array<{ value: string; label: string }>;
  /** bool 默认值 */
  defaultBool?: boolean;
}

/** 扫码接入元数据（仅引擎提供 connector 的渠道填充） */
export interface ChannelScanConnectMeta {
  /** 引擎侧渠道名（settings.channel.connect.{action} 的 channel 参数；lark 复用 feishu） */
  engineChannel: string;
  /** 扫码引导文案 */
  scanHint?: string;
}

/** 渠道展示与表单元数据 */
export interface ChannelMeta {
  kind: ChannelKind;
  /** 展示名 */
  name: string;
  /** 卡片描述 */
  description: string;
  /** nanobot 官方配置入口 */
  officialUrl: string;
  /** 平台侧开通要点（机器人能力 / 事件订阅 / 连接方式等前置条件） */
  setupHint?: string;
  /** 配置表单字段（必填项在前） */
  fields: ChannelFieldMeta[];
  /** 必填字段 key 集合 */
  requiredKeys: string[];
  /** 扫码接入能力（缺省 = 仅手动参数配置，如钉钉 / 企微） */
  scanConnect?: ChannelScanConnectMeta;
}

/** 渠道元数据清单（页面卡片顺序即此数组顺序） */
export const CHANNEL_METAS: ChannelMeta[] = [
  {
    kind: 'dingtalk',
    name: '钉钉',
    description: '通过钉钉机器人接收并回复用户消息',
    officialUrl: 'https://open.dingtalk.com/',
    setupHint:
      '在钉钉开放平台创建企业内部应用并启用「机器人」能力，开启 Stream 模式（无需公网回调地址），将应用的 Client ID / Client Secret 填入下方。',
    requiredKeys: ['clientId', 'clientSecret'],
    fields: [
      { key: 'clientId', label: 'Client ID', kind: 'string', placeholder: '钉钉应用 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', kind: 'secret', placeholder: '钉钉应用 Client Secret' },
      { key: 'allowFrom', kind: 'list', label: '允许的用户 ID', placeholder: '留空表示不限制', hint: '每行一个用户 ID（StaffId）' },
    ],
  },
  {
    kind: 'feishu',
    name: '飞书',
    description: '通过飞书机器人接收并回复用户消息',
    officialUrl: 'https://open.feishu.cn/app',
    setupHint:
      '在飞书开放平台创建应用：① 添加「机器人」能力；② 事件订阅选择「长连接」模式并订阅接收消息事件（im.message.receive_v1）；③ 开通 im:message 相关权限并发布版本。无需公网回调地址。',
    requiredKeys: ['appId', 'appSecret'],
    scanConnect: {
      engineChannel: 'feishu',
      scanHint: '使用飞书扫描下方二维码，自动创建并配置机器人',
    },
    fields: [
      { key: 'appId', label: 'App ID', kind: 'string', placeholder: '飞书应用 App ID' },
      { key: 'appSecret', label: 'App Secret', kind: 'secret', placeholder: '飞书应用 App Secret' },
      {
        key: 'groupPolicy',
        label: '群聊响应策略',
        kind: 'enum',
        choices: [
          { value: 'mention', label: '仅 @机器人 时响应' },
          { value: 'open', label: '群内所有消息都响应' },
        ],
      },
      { key: 'allowFrom', kind: 'list', label: '允许的用户 ID', placeholder: '留空表示不限制', hint: '每行一个 open_id' },
      { key: 'topicIsolation', label: '群内按话题隔离会话', kind: 'bool', defaultBool: true },
    ],
  },
  {
    kind: 'lark',
    name: 'Lark',
    description: '通过 Lark 机器人接收并回复用户消息',
    officialUrl: 'https://open.larksuite.com/app',
    setupHint:
      '在 Lark 开发者后台创建应用：① 添加「机器人」能力；② 事件订阅选择「长连接」模式并订阅接收消息事件；③ 开通 im:message 相关权限并发布版本。无需公网回调地址。',
    requiredKeys: ['appId', 'appSecret'],
    scanConnect: {
      engineChannel: 'feishu',
      scanHint: '使用 Lark 扫描下方二维码，自动创建并配置机器人',
    },
    fields: [
      { key: 'appId', label: 'App ID', kind: 'string', placeholder: 'Lark 应用 App ID' },
      { key: 'appSecret', label: 'App Secret', kind: 'secret', placeholder: 'Lark 应用 App Secret' },
      {
        key: 'groupPolicy',
        label: '群聊响应策略',
        kind: 'enum',
        choices: [
          { value: 'mention', label: '仅 @机器人 时响应' },
          { value: 'open', label: '群内所有消息都响应' },
        ],
      },
      { key: 'allowFrom', kind: 'list', label: '允许的用户 ID', placeholder: '留空表示不限制', hint: '每行一个 open_id' },
      { key: 'topicIsolation', label: '群内按话题隔离会话', kind: 'bool', defaultBool: true },
    ],
  },
  {
    kind: 'weixin',
    name: '微信',
    description: '通过微信机器人接收并回复用户消息',
    officialUrl: 'https://weixin.qq.com/',
    setupHint:
      '微信渠道基于 iLink 机器人接入：在微信智能对话开放平台创建机器人并获取 Token，填入下方即可（首次连接可能需要扫码授权）。',
    requiredKeys: ['token'],
    scanConnect: {
      engineChannel: 'weixin',
      scanHint: '请使用微信扫描下方二维码完成连接',
    },
    fields: [
      { key: 'token', label: 'iLink Token', kind: 'secret', placeholder: '微信 iLink 机器人 Token' },
      { key: 'allowFrom', kind: 'list', label: '允许的用户 ID', placeholder: '留空表示不限制', hint: '每行一个微信用户 ID' },
    ],
  },
  {
    kind: 'wecom',
    name: '企业微信',
    description: '通过企业微信机器人接收并回复用户消息',
    officialUrl: 'https://developer.work.weixin.qq.com/',
    setupHint:
      '在企业微信管理后台创建「智能机器人」，获取 Bot ID 与 Secret 填入下方；机器人通过 WebSocket 长连接接收消息，无需公网回调地址。',
    requiredKeys: ['botId', 'botSecret'],
    fields: [
      { key: 'botId', label: 'Bot ID', kind: 'string', placeholder: '企业微信智能机器人 Bot ID' },
      { key: 'botSecret', label: 'Secret', kind: 'secret', placeholder: '企业微信智能机器人 Secret' },
      { key: 'allowFrom', kind: 'list', label: '允许的用户 ID', placeholder: '留空表示不限制', hint: '每行一个企业微信用户 ID' },
    ],
  },
];

/** 按 kind 取元数据；未知 kind 回退 dingtalk 占位（理论上不会发生） */
export function getChannelMeta(kind: ChannelKind): ChannelMeta {
  return CHANNEL_METAS.find((m) => m.kind === kind) ?? CHANNEL_METAS[0];
}
