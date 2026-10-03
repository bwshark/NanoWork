/**
 * 渠道展示名：**唯一实现**。
 *
 * 三个消费方共用：侧边栏的机器人分组标题、任务结果推送的目标选择器、任务卡片上的推送摘要。
 * 此前侧边栏自己写了一份同义映射（`SidebarNav` 的 `channelDisplayName`）——同一份事实两张表，
 * 引擎新增一个渠道后必然一处显示中文、另一处显示原始英文名。收在这里之后只有一处要改。
 *
 * 未登记的渠道**原样显示**（取 owner 限定名的首段），所以加新渠道不必先改这张表才能用。
 */

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  wecom: '企业微信',
  weixin: '微信',
  feishu: '飞书',
  lark: '飞书（Lark）',
  dingtalk: '钉钉',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  websocket: '本应用（WebUI）',
};

/**
 * 渠道名 → 展示名。
 *
 * ⚠️ 引擎侧的渠道名可能是 **owner 限定形态**（多实例渠道形如 `feishu.feishu`，
 * 见 nanobot 渠道运行时的 `owner.name` 命名），所以先取首段再查表。
 */
export function channelLabel(channel: string): string {
  const base = channel.split('.')[0] ?? channel;
  return CHANNEL_LABELS[base] ?? base;
}
