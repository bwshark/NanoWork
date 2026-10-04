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

import { compareVersions, satisfiesRange } from './semverRange';
import type {
  InstalledPlugin,
  PluginActivation,
  PluginDrift,
  PluginEngineIndex,
  PluginSource,
  PluginView,
} from '@/types/plugin';

/**
 * 生效副本路径里那段缓存目录名。
 *
 * 与 `electron/pluginMarketplace.ts` 的 `CACHE_DIR` 同名——**两处必须一致**，
 * 但这一侧在渲染进程，不能 import 主进程模块，所以各写一份常量并在此注明。
 * 改_layout时两处都要动，否则「按路径兜底」会静默认不出市场副本。
 */
const CACHE_DIR = 'cache';

/**
 * 从生效副本路径反推来源（**纯函数**，只在引擎不可达时兜底用）。
 *
 * 认得的形式：`…/cache/<market>/<plugin>/<version>`。
 * 认不出就返回 `null`，由调用方退回到「本地安装」——路径解析失败绝不猜。
 */
export function sourceFromPath(root: string): PluginSource | null {
  const parts = root.split(/[\\/]+/).filter((part) => part !== '');
  const index = parts.lastIndexOf(CACHE_DIR);
  if (index < 0 || index + 3 >= parts.length) return null;
  const market = parts[index + 1];
  const version = parts[index + 3];
  const plugin = parts[index + 2];
  if (!market || !plugin || !version) return null;
  return { market, version };
}

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
      source: derivePluginSource(engineEntry?.market ?? null, engineEntry?.version ?? null, plugin),
    };
  });
}

/**
 * 来源的中文短标签（界面 chip 直接渲染）。
 *
 * `market` 为空时一律叫「本地安装」——即使有版本也不带市场名：
 * 「本地安装 v1.2」里那个 v1.2 容易被读成市场里的版本号，而这个副本根本
 * 不归市场管，返回目录名才能一眼分清。
 */
export function describePluginSource(source: PluginSource): string {
  if (!source.market) {
    return source.version ? `本地安装 v${source.version}` : '本地安装';
  }
  return source.version ? `${source.market} v${source.version}` : source.market;
}

/** 市场里某一版相对「当前生效版本」的关系 */
export type MarketVersionState = 'current' | 'update' | 'older';

/**
 * 市场索引里一版与该插件当前生效版本的关系。
 *
 * 解析不了（不是 semver）时判成 `older`：宁可在界面上不标「可更新」，
 * 也不要把一个说不清的版本号标红劝用户「升级」——升完没变化比不升更糟。
 */
export function marketVersionState(
  version: string,
  currentVersion: string | null,
): MarketVersionState {
  if (version === currentVersion) return 'current';
  if (!currentVersion) return 'update';
  return compareVersions(version, currentVersion) > 0 ? 'update' : 'older';
}

/**
 * 回收缓存之前要交给主进程的「被引用副本」清单。
 *
 * 只有**从市场装的**（`source.market` 非空）副本才在 `cache/` 下、才可能被回收；
 * 本地平铺装的那一摊根本不归 GC 管。这份清单是 GC 的唯一保护伞——它一旦漏掉，
 * 正在跑的那份副本会被删掉，界面表现为「插件凭空消失」。
 */
export function referencedCopyPaths(views: PluginView[]): string[] {
  return views
    .filter((view) => view.source.market !== null)
    .map((view) => view.plugin.root)
    .filter((root) => root !== '');
}

/**
 * 合并来源：引擎上报 → 路径反推（只在问不到引擎时）→ 包自己声明的版本。
 *
 * 顺序不能倒。引擎是「真正跑起来那份」的权威；网关没起时才允许按路径猜，
 * 且不猜出市场就退回本地安装，最终连版本都没有时显示包声明的版本。
 */
function derivePluginSource(
  market: string | null,
  version: string | null,
  plugin: InstalledPlugin,
): PluginSource {
  if (market !== null || version !== null) return { market, version };
  const fromPath = sourceFromPath(plugin.root);
  if (fromPath !== null) return fromPath;
  return {
    market: null,
    version: plugin.manifest.versionDeclared ? plugin.manifest.version : null,
  };
}
