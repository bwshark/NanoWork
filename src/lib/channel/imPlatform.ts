import type { IMPlatform } from '@/types';

/**
 * IM 平台 → 中文名。
 *
 * 此前在 `AgentsPage` 与 `MyAgentsPage` 各写了一份（逐字相同），而「专家卡片上的
 * `IM·xxx` 徽标」与「编辑表单里的平台下拉」都读它 —— 两处定义意味着新增一个平台时
 * 可能只改一处，症状是**同一个渠道在两个页面显示成两个名字**。
 */
export const PLATFORM_LABEL: Record<IMPlatform, string> = {
  wecom: '企业微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  slack: 'Slack',
  telegram: 'Telegram',
  other: '其他',
};
