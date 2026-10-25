import { create } from 'zustand';
import { platform } from '@/platform';
import { getRuntime } from '@/ai/runtime';
import {
  derivePluginViews,
  pluginMarketplaceFromEntry,
  pluginNameFromEntry,
  referencedCopyPaths,
  withPluginIntent,
} from '@/lib/agent/pluginIntent';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionsStore } from '@/stores/sessionsStore';
import { referencedCopyPathsForSessions } from '@/lib/agent/sessionPluginRefs';
import { recordAppAudit } from '@/lib/audit/appAudit';
import type {
  MarketIndex,
  MarketInstallResult,
  MarketplaceEntry,
  MarketSyncOutcome,
  PluginEngineIndex,
  PluginInstallResult,
  PluginView,
} from '@/types/plugin';

/**
 * 插件状态（FR-3.4）。
 *
 * ## 为什么**不持久化**
 *
 * 这个 store 里全是**事实**（磁盘上有哪些包、引擎激活了哪些），没有一个
 * 「用户的决定」。事实每次从权威重新读一遍就行，落盘反而制造了第二份可能
 * 过期的真相——重启后拿旧的 `installed` 渲染一屏已经不存在的插件，
 * 比空列表难排查得多。用户意图单独存在 `settings.enabledPlugins`，
 * 那里才是需要持久化的东西。
 *
 * ## 为什么会话恢复时不刷新
 *
 * 刷新要在**进插件页时**触发（`refresh()`），不在应用启动时自动拉：
 * 扫描要读磁盘、查引擎要发 HTTP，而绝大多数会话根本不看插件页。
 */

/** 空引擎索引：网关没起 / 非 Electron 时的初值 */
const EMPTY_ENGINE: PluginEngineIndex = { available: false, entries: [] };

interface PluginsState {
  /** 磁盘事实：已安装的包 */
  installed: PluginView[];
  /** 解析失败被跳过的目录名（坏包） */
  skipped: string[];
  /** 插件根绝对路径（便于界面显示「目录在哪」） */
  pluginsRoot: string;
  /** 引擎侧索引（激活状态的唯一权威） */
  engine: PluginEngineIndex;
  /** 是否完成过首次扫描 */
  loaded: boolean;
  /** 正在刷新（界面据此禁用重复点击） */
  refreshing: boolean;
  /**
   * 最近一次失败原因（null = 无失败）。
   *
   * 刻意做成**可见状态**而不是 console.warn：插件启停失败时界面若照旧显示
   * 「已启用」，用户会以为生效了。同一教训见技能三态覆盖的 `syncError`。
   */
  error: string | null;
  /** 最近一次成功操作的提示（安装/卸载后的一次性反馈） */
  notice: string | null;
  /** 当前应用版本（判 `engines.nanowork`；null = 未知，不报不兼容） */
  appVersion: string | null;
  /**
   * 重新扫描磁盘 + 问一次引擎。
   *
   * 两件事**互不阻断**：网关没起不该让「装了哪些包」也看不到，
   * 所以磁盘扫描的失败（理论上不会）与引擎不可达分开处理，
   * 后者只体现在 `engine.available=false`。
   */
  refresh: () => Promise<void>;
  /**
   * 启用 / 停用插件。**引擎先行，意图后写**。
   *
   * 顺序不能反：引擎的激活标记才是事实，意图只是「我想」。若先写意图、
   * 引擎拒绝了，界面就会显示「已启用」而模型照旧不能用——这是最难自查的
   * 一类不一致。失败时**两处都不动**，并把原因摆到 `error` 上。
   */
  setEnabled: (name: string, enabled: boolean) => Promise<boolean>;
  /** 安装插件包（复制到插件根），成功后自动刷新 */
  install: (sourceDir: string, overwrite?: boolean) => Promise<PluginInstallResult>;
  /** 卸载插件包（删除目录）；成功后清理意图条目并刷新 */
  uninstall: (name: string) => Promise<boolean>;
  /** 清掉一次性提示 / 错误 */
  clearFeedback: () => void;

  /** 注册表里的市场（由 `loadMarkets` 填充，与磁盘上的 `registry.json` 同源） */
  markets: MarketplaceEntry[];
  /** 各市场的包索引（`marketplaces/<id>/` 里归档了哪些包哪一版） */
  marketIndexes: Record<string, MarketIndex>;
  /** 是否正在读注册表 */
  loadingMarkets: boolean;
  /** 各市场索引的读取中标记 */
  loadingIndexes: Record<string, boolean>;
  /** 正在同步的市场 id（界面据此只禁用那一张卡） */
  syncingMarket: string | null;
  /** 正在安装的市场包，形如 `market:name` */
  installingKey: string | null;
  /** 市场读写 / 同步 / 安装的最近一次失败原因 */
  marketError: string | null;

  // —— 市场注册表（FR-3.7）——
  /** 读注册表（进入市场区时调用；失败时 `marketError` 有原因） */
  loadMarkets: () => Promise<void>;
  /** 新增 / 改写一个市场；`id` 为空表示新增 */
  addMarket: (input: Omit<MarketplaceEntry, 'lastSyncAt' | 'lastError'>) => Promise<boolean>;
  /** 删除市场（内置市场拒绝删除） */
  removeMarket: (id: string) => Promise<boolean>;
  /** 同步一个市场（目录型扫目录归档；远程型当前如实失败） */
  syncMarket: (id: string) => Promise<MarketSyncOutcome | null>;
  /** 读某个市场的包索引（同步后才有内容） */
  loadMarketPackages: (id: string) => Promise<MarketIndex | null>;
  /**
   * 从市场安装 / 切到某一版（materialize 副本 + 拨 `current` 指针）。
   *
   * 成功后**不会自动启用**：切版本只是让这一版生效，「是否启用」仍是独立的一步
   * （引擎激活标记与包内容指纹绑定，改版本会让旧标记失效）。自动启用会把两件事
   * 合成一件，届时「装了没生效」永远查不出原因。
   */
  installFromMarket: (market: string, name: string, version: string) => Promise<boolean>;
  /** 回收无引用旧副本（keepDays=0 表示只看引用集） */
  collectCache: (keepDays?: number) => Promise<{ removed: string[]; kept: string[] }>;
}

/** 组装派生视图：把三份输入（磁盘 / 引擎 / 意图）合成界面可用的形状 */
function buildViews(
  installed: Awaited<ReturnType<typeof platform.scanPlugins>>['plugins'],
  engine: PluginEngineIndex,
  appVersion: string | null,
): PluginView[] {
  const { enabledPlugins } = useSettingsStore.getState().settings;
  return derivePluginViews(installed, engine, enabledPlugins, { appVersion });
}

/** 引擎侧启停：runtime 未实现该能力（Web 端）时如实报不可用，不假装成功 */
async function toggleInEngine(name: string, enabled: boolean): Promise<string | null> {
  const runtime = getRuntime();
  if (typeof runtime.setPluginEnabled !== 'function') {
    return '当前运行环境不支持启停插件（请使用桌面端）';
  }
  try {
    const result = await runtime.setPluginEnabled(name, enabled);
    return result.ok ? null : (result.error ?? '切换插件状态失败');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 读引擎插件索引；runtime 未实现或不支持时返回「问不到」而不是抛错 */
async function readEngine(): Promise<PluginEngineIndex> {
  const runtime = getRuntime();
  if (typeof runtime.listPlugins !== 'function') {
    return { available: false, entries: [], error: '当前运行环境不支持读取插件清单' };
  }
  try {
    return await runtime.listPlugins();
  } catch (err) {
    return {
      available: false,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 市场相关状态的骨架。
 *
 * 与 store 里其它「事实」同理不落盘：注册表本身就是磁盘上的 `registry.json`。
 * 唯一的区别是这里多了 `loadingIndexes`，因为市场索引要**按需**读（读一次盘），
 * 不存在于注册表里。
 */
const EMPTY_MARKET_STATE = {
  markets: [] as MarketplaceEntry[],
  marketIndexes: {} as Record<string, MarketIndex>,
  loadingMarkets: false,
  loadingIndexes: {} as Record<string, boolean>,
  /** 正在同步的市场 id（界面据此只禁用那一张卡） */
  syncingMarket: null as string | null,
  /** 正在安装的市场包 `market:name` */
  installingKey: null as string | null,
  /** 市场列表 / 同步 / 安装的最近一次失败原因 */
  marketError: null as string | null,
};

export const usePluginsStore = create<PluginsState>((set, get) => ({
  ...EMPTY_MARKET_STATE,
  installed: [],
  skipped: [],
  pluginsRoot: '',
  engine: EMPTY_ENGINE,
  loaded: false,
  refreshing: false,
  error: null,
  notice: null,
  appVersion: null,

  refresh: async () => {
    set({ refreshing: true });
    try {
      // 应用版本只取一次（它不会变），拿到后缓存在 state 里
      let appVersion = get().appVersion;
      if (appVersion === null) {
        const info = await platform.appInfo();
        appVersion = info?.version ?? '';
      }

      const scan = await platform.scanPlugins();
      const engine = await readEngine();
      set({
        pluginsRoot: scan.pluginsRoot,
        skipped: scan.skipped,
        engine,
        appVersion,
        installed: buildViews(scan.plugins, engine, appVersion || null),
        loaded: true,
        refreshing: false,
        // 引擎不可达**不算操作失败**：它是常态（用户可能没开网关），
        // 由卡片上的 `unknown` 偏差提示表达，不占用 error 位。
        error: null,
      });
    } catch (err) {
      set({
        refreshing: false,
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setEnabled: async (name, enabled) => {
    const failure = await toggleInEngine(name, enabled);
    if (failure !== null) {
      // 引擎拒绝了：**意图一个字都不写**，否则界面会显示一个不成立的「已启用」
      set({ error: failure });
      // 「被引擎拒绝」恰恰是审计里最该有的一类：用户确实点了、也确实没生效
      recordAppAudit({
        action: enabled ? 'plugin.enable' : 'plugin.disable',
        targetId: name,
        outcome: 'failed',
        reason: failure,
      });
      return false;
    }

    const { enabledPlugins } = useSettingsStore.getState().settings;
    // 保留既有的市场后缀：`withPluginIntent` 会替换同名的所有条目，
    // 不把后缀带回去就等于「重新启用一次，来源信息丢了」。
    const previous = (enabledPlugins ?? []).find(
      (entry) => pluginNameFromEntry(entry) === name,
    );
    useSettingsStore.getState().setSettings({
      enabledPlugins: withPluginIntent(
        enabledPlugins,
        name,
        enabled,
        previous ? (pluginMarketplaceFromEntry(previous) ?? undefined) : undefined,
      ),
    });

    // 本地乐观更新引擎视图：刚才是引擎亲自确认过的，不必再多一次往返
    const engine: PluginEngineIndex = {
      ...get().engine,
      entries:
        get().engine.entries.some((entry) => entry.name === name)
          ? get().engine.entries.map((entry) =>
              entry.name === name ? { ...entry, enabled } : entry,
            )
          : get().engine.entries,
    };
    const scan = {
      plugins: get().installed.map((v) => v.plugin),
      skipped: get().skipped,
      pluginsRoot: get().pluginsRoot,
    };
    set({
      engine,
      error: null,
      notice: enabled ? `已启用「${name}」` : `已停用「${name}」`,
      installed: buildViews(scan.plugins, engine, get().appVersion || null),
    });
    recordAppAudit({
      action: enabled ? 'plugin.enable' : 'plugin.disable',
      targetId: name,
    });
    return true;
  },

  install: async (sourceDir, overwrite) => {
    const result = await platform.installPlugin(sourceDir, overwrite);
    if (!result.ok) {
      set({ error: result.error ?? '安装插件失败' });
      recordAppAudit({
        action: 'plugin.install',
        targetId: result.manifest?.name,
        targetLabel: result.manifest?.displayName,
        outcome: 'failed',
        detail: { sourceDir },
        reason: result.error ?? '安装插件失败',
      });
      return result;
    }
    set({ error: null, notice: `已安装「${result.manifest?.displayName ?? ''}」` });
    recordAppAudit({
      action: 'plugin.install',
      targetId: result.manifest?.name,
      targetLabel: result.manifest?.displayName,
      detail: { sourceDir },
    });
    await get().refresh();
    return result;
  },

  uninstall: async (name) => {
    const result = await platform.uninstallPlugin(name);
    if (!result.ok) {
      set({ error: result.error ?? '卸载插件失败' });
      recordAppAudit({
        action: 'plugin.uninstall',
        targetId: name,
        outcome: 'failed',
        reason: result.error ?? '卸载插件失败',
      });
      return false;
    }
    // 包已经不在磁盘上了，意图条目必须一并清掉——留着它会在
    // `enabledPlugins` 里积一个永远指不到东西的幽灵（且下次重装时会
    // 「莫名其妙已经被启用」）。
    const { enabledPlugins } = useSettingsStore.getState().settings;
    useSettingsStore.getState().setSettings({
      enabledPlugins: withPluginIntent(enabledPlugins, name, false),
    });
    set({ error: null, notice: `已卸载「${name}」` });
    recordAppAudit({ action: 'plugin.uninstall', targetId: name });
    await get().refresh();
    return true;
  },

  clearFeedback: () => set({ error: null, notice: null }),

  // —— 市场 ——
  loadMarkets: async () => {
    set({ loadingMarkets: true });
    try {
      const registry = await platform.pluginsMarkets();
      set({
        markets: Array.isArray(registry.markets) ? registry.markets : [],
        loadingMarkets: false,
        marketError: registry.error ?? null,
      });
    } catch (err) {
      set({
        loadingMarkets: false,
        marketError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  addMarket: async (input) => {
    const result = await platform.pluginsMarketsUpsert(input);
    if (!result.ok) {
      set({ marketError: result.error ?? '写入市场失败' });
      return false;
    }
    set({ marketError: null });
    await get().loadMarkets();
    return true;
  },

  removeMarket: async (id) => {
    const result = await platform.pluginsMarketsRemove(id);
    if (!result.ok) {
      set({ marketError: result.error ?? '删除市场失败' });
      return false;
    }
    set({ marketError: null });
    await get().loadMarkets();
    return true;
  },

  syncMarket: async (id) => {
    // 先上锁再发请求：同步要摸盘，双击「同步」会并行跑两遍归档
    set({ syncingMarket: id, marketError: null });
    const outcome = await platform.pluginsMarketsSync(id);
    // 用**回写后的条目**替掉旧条目：`recordMarketSync` 已经把 `lastSyncAt` /
    // `lastError` 写进注册表了，界面若显示旧值会显得「点了同步但没反应」。
    set({
      syncingMarket: null,
      marketError: outcome.error ?? null,
      markets: [...get().markets.filter((item) => item.id !== outcome.entry.id), outcome.entry],
    });
    return outcome;
  },

  loadMarketPackages: async (id) => {
    set({ loadingIndexes: { ...get().loadingIndexes, [id]: true } });
    try {
      const index = await platform.pluginsMarketPackages(id);
      set({ marketIndexes: { ...get().marketIndexes, [id]: index } });
      return index;
    } catch (err) {
      set({ marketError: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      set({ loadingIndexes: { ...get().loadingIndexes, [id]: false } });
    }
  },

  installFromMarket: async (market, name, version) => {
    set({ installingKey: `${market}:${name}` });
    try {
      const result: MarketInstallResult = await platform.pluginsMarketInstall(
        market,
        name,
        version,
      );
      if (!result.ok) {
        set({ marketError: result.error ?? '从市场安装失败' });
        recordAppAudit({
          action: 'plugin.install',
          targetId: name,
          outcome: 'failed',
          detail: { market, version },
          reason: result.error ?? '从市场安装失败',
        });
        return false;
      }
      // FR-3.13：市场索引声明依赖时，主进程会把依赖一并装好。**必须说出来**——
      // 否则用户会在插件列表里看到几个自己没点过安装的插件（「我没装过 miora」），
      // 而唯一能解释这件事的信息只存在于主进程的返回值里。
      const dependencies = (result.installed ?? []).filter(
        (entry) => entry !== `${name}@${version}`,
      );
      set({
        marketError: null,
        notice:
          dependencies.length > 0
            ? `已切换到「${name}」v${version}，并安装 ${dependencies.length} 个依赖（${dependencies.join('、')}）；仍需启用才生效`
            : `已切换到「${name}」v${version}（仍需启用才生效）`,
      });
      // 装完要重新扫：副本是新目录，磁盘事实变了
      await get().refresh();
      recordAppAudit({
        action: 'plugin.install',
        targetId: name,
        detail: { market, version, dependencies },
      });
      return true;
    } catch (err) {
      set({ marketError: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      set({ installingKey: null });
    }
  },

  collectCache: async (keepDays) => {
    try {
      // 引用集必须由调用方给：主进程不知道哪些副本还在生效（「生效」的唯一证据是
      // 磁盘扫描出来的包根），硬塞进主进程只会误删。
      // 引用集 = 本机生效副本 ∪ **会话版本引用集**（FR-3.9 ①）。
      // 后者回答「别的设备上的会话要哪一版」：只按本机生效判，会把同步来的会话
      // 仍在用的旧版本当垃圾删掉，那台设备换回来就读不到当初的插件了。
      // ⚠️ 与 `sessionsStore` 互相 import（它要读本 store 的扫描视图做快照）。
      // 这条环是**安全**的：两边都只在函数体里取对方，模块求值期不触碰。
      const referenced = [
        ...referencedCopyPaths(get().installed),
        ...referencedCopyPathsForSessions(
          get().installed,
          useSessionsStore.getState().sessions.map((s) => s.pluginVersions),
        ),
      ];
      return await platform.pluginsMarketGc(referenced, keepDays ?? 30);
    } catch (err) {
      set({ marketError: err instanceof Error ? err.message : String(err) });
      return { removed: [], kept: [] };
    }
  },
}));
