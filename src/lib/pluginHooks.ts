/**
 * 插件生命周期钩子的界面文案（FR-3.6）。
 *
 * ## 为什么单独一个模块
 *
 * 「有几个钩子文件」与「有几个钩子真的生效」是两件事，而界面必须把差别说清：
 * 前者是磁盘事实（`InstalledPlugin.resources` 的 `hooks` 分组），后者是引擎事实
 * （`PluginHookStats`）。这两个数在插件页同时出现，所以文案不能散落在 JSX 里
 * ——散着写就一定会出现「卡片上写 1 个钩子，详情里写 0 个生效」这种自相矛盾。
 *
 * ## 这里只做纯映射
 *
 * 不读 store、不碰平台层：`PluginHookStats` 原样进、要渲染的字符串出。这样
 * 「写错事件名时该说什么」「被丢弃时该说什么」可以直接用用例钉住，而不是靠人肉
 * 点开插件页确认。
 */

import type { PluginHookStats } from '@/types/plugin';

/** 事件 → 中文短标签。未知事件原样返回（引擎将来加事件时界面不至于变成空白）。 */
export const PLUGIN_HOOK_EVENT_LABELS: Record<string, string> = {
  session_start: '会话开始',
  before_tool: '工具调用前',
  after_tool: '工具调用后',
  session_end: '会话结束',
};

export function pluginHookEventLabel(event: string): string {
  return PLUGIN_HOOK_EVENT_LABELS[event] ?? event;
}

/** 按事件摊平成人读的一行一项，如 `工具调用前 ×2`。顺序按下表固定，不随对象键序漂移。 */
export function describePluginHookEvents(stats: PluginHookStats): string[] {
  const order = Object.keys(PLUGIN_HOOK_EVENT_LABELS);
  const known = order.filter((event) => (stats.events[event] ?? 0) > 0);
  const unknown = Object.keys(stats.events)
    .filter((event) => !order.includes(event) && stats.events[event] > 0)
    .sort();
  return [...known, ...unknown].map(
    (event) => `${pluginHookEventLabel(event)} ×${stats.events[event]}`,
  );
}

/**
 * 卡片上那一个芯片。
 *
 * - `dropped > 0` 时**优先**报丢弃：作者写了却没生效，是比「生效了几条」更急的信息；
 * - `active > 0` 报生效条数；
 * - 两者皆 0 返回 `null`（没声明 / 没启用，卡片上不该多一个「0 个钩子」的噪声）。
 */
export function pluginHookChip(
  stats: PluginHookStats,
): { label: string; tone: 'ok' | 'warn' } | null {
  if (stats.dropped > 0) {
    return { label: `${stats.dropped} 条钩子声明被忽略`, tone: 'warn' };
  }
  if (stats.active > 0) {
    return { label: `${stats.active} 个钩子生效`, tone: 'ok' };
  }
  return null;
}

/**
 * 芯片的 Tooltip 正文（多行，已按行拆开）。
 *
 * 刻意**不承诺**「被忽略的具体原因」：原因在引擎日志里（`GET /v1/plugins` 只报条数）。
 * 这里说清「去哪看」比编一句模糊的原因有用。
 */
export function describePluginHookTooltip(stats: PluginHookStats): string[] {
  const lines: string[] = [];
  if (stats.active > 0) {
    lines.push(`引擎已挂载 ${stats.active} 个生命周期钩子：`);
    for (const line of describePluginHookEvents(stats)) lines.push(`· ${line}`);
  }
  if (stats.dropped > 0) {
    lines.push(
      `${stats.dropped} 条声明被引擎忽略（事件名写错 / JSON 不合法 / 注入超预算），详见引擎日志。`,
    );
  }
  lines.push('钩子由插件声明，只收窄能力：不会让插件绕过审批门或 Agent 工具白名单。');
  return lines;
}
