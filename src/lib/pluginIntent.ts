/**
 * 插件意图（`settings.enabledPlugins`）与派生视图（FR-3.4，纯函数）。
 *
 * ## 三个事实，刻意不合并
 *
 * | 事实 | 存在哪 | 谁说了算 |
 * |---|---|---|
 * | **装了哪些包** | 磁盘 `~/.nanowork/plugins/<name>/` | 主进程扫描 |
 * | **引擎激活没有** | 引擎的指纹绑定标记 | `GET /v1/plugins` |
 * | **用户想启用吗** | `settings.enabledPlugins` | 用户 |
 *
 * 合成一个布尔值就无法表达最常见的中间态「装了、也想启用、但引擎没激活」
 * （包内容一变指纹就失效，引擎会拒绝沿用旧标记）。所以这里保留三份输入，
 * 把不一致显式算成 `PluginDrift` 交给界面提示，**不静默对齐**——
 * 静默对齐会让「明明启用了却没生效」变成一次无痕的自我治愈，问题从此查不出来。
 */

import { satisfiesRange } from './semverRange';
import type {
  InstalledPlugin,
  PluginActivation,
  PluginDrift,
  PluginEngineIndex,
  PluginView,
} from '@/types/plugin';

/** 市场后缀分隔符（PRD §12.2 的 `<name>@<marketplace>`） */
const ENTRY_SEPARATOR = '@';

/**
 * 从 `enabledPlugins` 条目里取插件名。
 *
 * 本地安装的包没有市场后缀，条目就是裸 `<name>`——因此这不能写成
 * 「按 `@` 拆两段」，要从**最后一个**分隔符切（市场名里可能还有 `@`）。
 */
export function pluginNameFromEntry(entry: string): string {
  const trimmed = entry.trim();
  const index = trimmed.lastIndexOf(ENTRY_SEPARATOR);
  return index <= 0 ? trimmed : trimmed.slice(0, index);
}

/** 从条目里取市场名；没有后缀返回 `null`（= 本地安装） */
export function pluginMarketplaceFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  const index = trimmed.lastIndexOf(ENTRY_SEPARATOR);
  return index <= 0 ? null : trimmed.slice(index + 1);
}

/** 意图表里是否有该插件 */
export function isPluginIntended(
  enabledPlugins: string[] | undefined,
  name: string,
): boolean {
  if (!Array.isArray(enabledPlugins) || name === '') return false;
  return enabledPlugins.some((entry) => pluginNameFromEntry(entry) === name);
}

/**
 * 写入 / 移除意图条目。
 *
 * 写入时用 `<name>@<marketplace>`；已有同名的其他来源条目会被**替换**
 * （同一插件名只能有一个启用意图，否则「到底从哪个市场装的」无法回答）。
 * 移除时按名字匹配，把该名字的**所有**条目清掉。
 * 返回新数组（不改原数组，便于 store 做幂等比较）。
 */
export function withPluginIntent(
  enabledPlugins: string[] | undefined,
  name: string,
  enabled: boolean,
  marketplace?: string,
): string[] {
  const list = Array.isArray(enabledPlugins) ? [...enabledPlugins] : [];
  const rest = list.filter((entry) => pluginNameFromEntry(entry) !== name);
  if (!enabled) return rest;
  const suffix = marketplace && marketplace.trim() !== '' ? `${ENTRY_SEPARATOR}${marketplace}` : '';
  return [...rest, `${name}${suffix}`];
}

/** 意图与激活状态的偏差（`unknown` 只在问不到引擎时出现） */
export function derivePluginDrift(
  intended: boolean,
  activation: PluginActivation,
): PluginDrift {
  if (activation === 'unknown') return 'unknown';
  if (intended) return activation === 'active' ? 'in-sync' : 'intent-only';
  return activation === 'active' ? 'engine-only' : 'both-off';
}

/** 偏差的中文说明（界面直接展示；`null` = 一致，无需提示） */
export const PLUGIN_DRIFT_NOTICE: Record<PluginDrift, string | null> = {
  'in-sync': null,
  'both-off': null,
  'intent-only': '已启用但引擎未激活：插件包内容可能被改动过，重新启用即可生效',
  'engine-only': '引擎已激活，但本地启用记录里没有它（可能在网页端启用过）',
  unknown: '暂时问不到引擎状态（网关未启动？）',
};

/** 派生选项 */
export interface DerivePluginViewsOptions {
  /**
   * 当前客户端版本，用来判 `engines.nanowork` 区间。
   *
   * 传 `null` / 空串 = **版本未知**，此时一律判为兼容。理由是不对称成本：
   * 误报「不兼容」会劝退一个本来能用的包，而漏报只是少一条提示。
   */
  appVersion?: string | null;
}

/**
 * 生成界面用的合并视图。
 *
 * 只列**磁盘上真实存在**的包：意图里有、磁盘上没有的条目不算插件——
 * 那种条目会在界面留下一个点不动的幽灵卡片（应该由卸载流程清掉）。
 */
export function derivePluginViews(
  installed: InstalledPlugin[],
  engine: PluginEngineIndex,
  enabledPlugins: string[] | undefined,
  options: DerivePluginViewsOptions = {},
): PluginView[] {
  const appVersion = (options.appVersion ?? '').trim();
  const engineByName = new Map(engine.entries.map((entry) => [entry.name, entry]));

  return installed.map((plugin) => {
    const name = plugin.manifest.name;
    const engineEntry = engineByName.get(name);
    const activation: PluginActivation = engine.available
      ? engineEntry?.enabled === true
        ? 'active'
        : 'inactive'
      : 'unknown';
    const intended = isPluginIntended(enabledPlugins, name);
    const range = plugin.manifest.engineRange;
    const engineIncompatible =
      appVersion !== '' && range.trim() !== '' && !satisfiesRange(appVersion, range);

    return {
      plugin,
      activation,
      intended,
      drift: derivePluginDrift(intended, activation),
      engineIncompatible,
    };
  });
}
