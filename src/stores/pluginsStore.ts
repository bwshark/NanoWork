import { create } from 'zustand';
import { platform } from '@/platform';
import { getRuntime } from '@/ai/runtime';
import {
  derivePluginViews,
  pluginMarketplaceFromEntry,
  pluginNameFromEntry,
  withPluginIntent,
} from '@/lib/pluginIntent';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
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

export const usePluginsStore = create<PluginsState>((set, get) => ({
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
    return true;
  },

  install: async (sourceDir, overwrite) => {
    const result = await platform.installPlugin(sourceDir, overwrite);
    if (!result.ok) {
      set({ error: result.error ?? '安装插件失败' });
      return result;
    }
    set({ error: null, notice: `已安装「${result.manifest?.displayName ?? ''}」` });
    await get().refresh();
    return result;
  },

  uninstall: async (name) => {
    const result = await platform.uninstallPlugin(name);
    if (!result.ok) {
      set({ error: result.error ?? '卸载插件失败' });
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
    await get().refresh();
    return true;
  },

  clearFeedback: () => set({ error: null, notice: null }),
}));
