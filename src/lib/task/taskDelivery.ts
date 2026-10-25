/**
 * 任务结果推送（FR-5.6）：渠道会话 ⇄ 推送目标 的纯映射与文案。
 *
 * 收在这里的唯一理由：**只有这一处**知道「引擎的会话 key 怎么拆成投递目标」。
 * 引擎侧 `session_key_for_channel(channel, chat_id) = f"{channel}:{chat_id}"`
 * （`nanobot/session/keys.py`），而投递恰恰按 `(channel, chat_id)` 路由 ——
 * 所以 key 的**第一个冒号**就是分界，冒号后的整段都属于 chatId
 * （Discord 的线程键形如 `discord:456:thread:777`，不能按冒号全拆）。
 */

import { channelLabel } from '@/lib/channel/channelLabel';
import type { NanobotChannelSessionSummary } from '@/platform/types';
import type { TaskDelivery, TaskDeliveryOn, TaskDeliveryTarget } from '@/types';

/**
 * 统一会话模式下所有渠道共用 `unified:default` 这一个键
 * （`nanobot/session/keys.py` 的 `UNIFIED_SESSION_KEY`），它的前缀不是渠道名，
 * 真正可投递的路由这时只存在于会话元数据的 `last_channel` 里、不暴露给渲染层。
 * 所以这种会话**给不出投递目标**，只能不列为选项。
 */
const UNROUTABLE_KEY_PREFIXES: ReadonlySet<string> = new Set(['unified']);

/** 推送目标 → 稳定的比较键（去重、judge「是否已在列表里」用） */
export function deliveryTargetKey(target: TaskDeliveryTarget): string {
  return `${target.channel}:${target.chatId}`;
}

export function hasDeliveryTarget(
  targets: readonly TaskDeliveryTarget[],
  candidate: TaskDeliveryTarget,
): boolean {
  const key = deliveryTargetKey(candidate);
  return targets.some((t) => deliveryTargetKey(t) === key);
}

/**
 * 渠道会话 → 推送目标。key 不是 `<渠道>:<会话>` 形态（统一会话、键损坏）时返回 null。
 *
 * ⚠️ 用 **key 前缀**而不是 `summary.channel` 当渠道：key 才是引擎的路由身份
 * （出站按 `msg.channel` 在渠道表里查实例），两者按构造相等，但只有 key 能证明这一点。
 */
export function deliveryTargetFromSession(
  summary: Pick<NanobotChannelSessionSummary, 'key'>,
): TaskDeliveryTarget | null {
  const idx = summary.key.indexOf(':');
  if (idx <= 0) return null;
  const channel = summary.key.slice(0, idx);
  const chatId = summary.key.slice(idx + 1);
  if (!chatId || UNROUTABLE_KEY_PREFIXES.has(channel)) return null;
  return { channel, chatId };
}

/** 下拉选项文案：`企业微信 · 群名`；没有标题时退到会话 id */
export function deliveryOptionLabel(
  summary: Pick<NanobotChannelSessionSummary, 'key' | 'title' | 'preview'>,
): string {
  const target = deliveryTargetFromSession(summary);
  const name = `${summary.title || summary.preview || ''}`.trim().replace(/\s+/g, ' ');
  const short = name.length > 24 ? `${name.slice(0, 24)}…` : name;
  return `${channelLabel(target?.channel ?? summary.key)} · ${short || target?.chatId || summary.key}`;
}

/**
 * 推送时机 → 摘要文案。
 *
 * 写成映射表而不是嵌套三元：档位再增一个时，漏写会**编译报错**（缺键），
 * 而嵌套三元漏写只会静默落到最后一个分支——用户看到的是「每次执行后」，
 * 与他实际选的档位不符。
 */
const DELIVERY_WHEN_LABEL: Record<TaskDeliveryOn, string> = {
  complete: '每次执行后',
  error: '仅失败时',
  // 「开始 + 结果」：不能简写成「开始时」，那会读成「只推开始、不推结果」
  start: '开始与结束时',
};

/**
 * 任务卡片上的推送摘要；没有配置时返回 null（调用方据此整行不渲染）。
 *
 * 只按**渠道**归并显示，不逐条列会话：卡片那一行是给人扫一眼的，
 * 三个企业微信会话写三遍「企业微信」只会把行撑长。
 */
export function describeDelivery(delivery?: TaskDelivery): string | null {
  if (!delivery || delivery.targets.length === 0) return null;
  const channels = [...new Set(delivery.targets.map((t) => channelLabel(t.channel)))];
  return `推送：${channels.join('、')}（${delivery.targets.length} 个会话）· ${DELIVERY_WHEN_LABEL[delivery.on]}`;
}
