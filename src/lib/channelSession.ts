import { channelLabel } from './channelLabel';
import type { ChannelKind } from '@/types';

/**
 * IM 频道会话的**来源判定与文案**：唯一实现（FR-6.4）。
 *
 * 消费方四处，此前各写各的：
 * - `channelSessionsStore` 里那个 `CHANNEL_SESSION_ID_PREFIX` 常量（现在从这里取）；
 * - 会话列表的过滤（`!s.channel` 排除 IM 会话）；
 * - 侧边栏频道列表的分组；
 * - 会话头部的外部来源标记（本批新增）。
 *
 * 判据是 `session.channel` 有值而不是 id 前缀 —— 前者是**语义**（这条会话属于外部
 * 渠道，本地只是只读镜像），后者是**本地约定**。两个判据同时成立时才动手：
 * `channelSessionsStore` 构造会话时两者都设，但历史数据（旧版落盘）可能只有其一。
 */

/** 频道会话在本地 sessionsStore 中的 id 前缀（`nb:` + nanobot session key） */
export const CHANNEL_SESSION_ID_PREFIX = 'nb:';

/**
 * 会话是否来自 IM 渠道（外部来源）。
 *
 * `channel` 可能是空串（解析失败 / 半截数据），故按 trim 后判空 —— 与
 * `CronDeliveryTarget.from_store_dict` 的「半填目标一律丢弃」同一条原则：
 * 空渠道的会话既推不出去也不该被标记成外部来源。
 */
export function isExternalSession(
  session: { channel?: string } | null | undefined,
): boolean {
  return !!session?.channel?.trim();
}

/** 频道会话 id → nanobot session key；非频道会话返回 null */
export function channelSessionKey(sessionId: string): string | null {
  return sessionId.startsWith(CHANNEL_SESSION_ID_PREFIX)
    ? sessionId.slice(CHANNEL_SESSION_ID_PREFIX.length)
    : null;
}

/**
 * 渠道**分组键**：owner 限定形态取首段。
 *
 * ⚠️ 分组键刻意用**原始首段字符串**而不是 `ChannelKind`：后者只有 5 个成员，
 * 未知渠道（telegram / discord / slack…）会被回退规则悄悄并进钉钉组，用户看到
 * 的是「钉钉」组里躺着一条 Telegram 会话。原始首段让未知渠道自成一组，
 * 展示名再由 `channelLabel` 兜底（未登记的渠道原样显示）。
 */
export function channelGroupKey(channel?: string): string {
  return (channel ?? '').trim().split('.')[0] || 'unknown';
}

/** 有专属图标的渠道（`ChannelIcon` 只画得出这 5 种，顺序即筛选器里的展示顺序） */
export const CHANNEL_ICON_KINDS: readonly ChannelKind[] = [
  'dingtalk',
  'feishu',
  'lark',
  'weixin',
  'wecom',
];

/**
 * 渠道名 → 图标类型。
 *
 * ⚠️ 未知渠道回退 `dingtalk` —— 所以**分组键绝不能用它**，否则 Telegram / Slack 这类
 * 引擎支持但客户端没有图形的渠道会并进「钉钉」组。分组用 `channelGroupKey`（原始首段），
 * 图标只负责画一个近似符号。此前 `SidebarNav` 与 `ChatPage` 各写了一份同义映射。
 */
export function channelIconKind(channel?: string): ChannelKind {
  const head = channelGroupKey(channel);
  return CHANNEL_ICON_KINDS.includes(head as ChannelKind)
    ? (head as ChannelKind)
    : 'dingtalk';
}

/** 外部来源标记文案：「来自 微信」 */
export function externalSourceLabel(channel?: string): string {
  return `来自 ${channelLabel(channelGroupKey(channel))}`;
}

/**
 * 来源说明（标记的 Tooltip 用）。
 *
 * 写清**两个方向**才完整：历史消息是只读镜像（用户看不到那条 IM 会话里没有的东西），
 * 而在这里发出的消息会真的投递回该渠道 —— 少写后半句，用户会以为只是本地留言。
 */
export function externalSourceHint(channel?: string): string {
  const label = channelLabel(channelGroupKey(channel));
  return `该会话来自 ${label}，由 IM 用户发起，历史消息只读；在此发送的消息会投递回${label}。`;
}
