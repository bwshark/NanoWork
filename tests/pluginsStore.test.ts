import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { __setRuntimeForTest } from '@/ai/runtime';
import { usePluginsStore } from '@/stores/pluginsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentRuntime } from '@/ai/runtime/types';
import type {
  InstalledPlugin,
  MarketplaceEntry,
  PluginEngineIndex,
  PluginManifest,
} from '@/types/plugin';

/**
 * pluginsStore 测试（FR-3.4）。
 *
 * ## 三条必须钉住的语义
 *
 * 1. **引擎先行、意图后写**：引擎拒绝时 `settings.enabledPlugins` 一个字都不能动，
 *    否则界面会显示一个不成立的「已启用」——引擎才是事实，意图只是「我想」。
 * 2. **引擎问不到不算操作失败**：网关没起是常态，「装了哪些包」照常显示。
 * 3. **不持久化**：store 里全是事实，没有一条是需要落盘的用户决定
 *    （意图在 `settings.enabledPlugins`）。
 */

function manifest(patch: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'demo-plugin',
    displayName: '演示插件',
    version: '1.2.3',
    versionDeclared: true,
    description: '',
    repository: '',
    category: 'Plugin',
    main: 'SKILL.md',
    permissions: { tools: [], network: [] },
    engineRange: '',
    schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    manifestRelPath: 'plugin.json',
    ...patch,
  };
}

function installed(patch: Partial<PluginManifest> = {}): InstalledPlugin {
  return {
    manifest: manifest(patch),
    root: `${PLUGINS_ROOT}/${patch.name ?? 'demo-plugin'}`,
    resources: [],
  };
}

const PLUGINS_ROOT = '/home/u/.nanowork/plugins';

function engineIndex(...names: Array<[string, boolean]>): PluginEngineIndex {
  return {
    available: true,
    entries: names.map(([name, enabled]) => ({
      name,
      displayName: name,
      description: '',
      category: '',
      enabled,
      mcpServers: [],
      market: null,
      version: null,
    })),
  };
}

/**
 * 替身 runtime：只实现插件两个方法。
 * 用 `listPlugins` 是否存在于对象上来决定 store 走哪条分支，
 * 因此「不支持」场景配 `undefined` 即可（对齐 `transcribe?` 的契约语义）。
 */
function makeRuntime(overrides: Partial<AgentRuntime>): AgentRuntime {
  return overrides as AgentRuntime;
}

const listPlugins = vi.fn();
const setPluginEnabled = vi.fn();

function stubPlatform(scan: {
  plugins: InstalledPlugin[];
  skipped: string[];
}): void {
  vi.spyOn(platform, 'scanPlugins').mockResolvedValue({
    ...scan,
    pluginsRoot: PLUGINS_ROOT,
  });
  vi.spyOn(platform, 'appInfo').mockResolvedValue(null);
}

beforeEach(() => {
  vi.restoreAllMocks();
  listPlugins.mockReset();
  setPluginEnabled.mockReset();
  __setRuntimeForTest(
    makeRuntime({ listPlugins, setPluginEnabled } as unknown as Partial<AgentRuntime>),
  );
  usePluginsStore.setState({
    installed: [],
    skipped: [],
    pluginsRoot: '',
    engine: { available: false, entries: [] },
    loaded: false,
    refreshing: false,
    error: null,
    notice: null,
    appVersion: null,
  });
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, enabledPlugins: [] } }));
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe('pluginsStore.refresh', () => {
  it('组合磁盘扫描 + 引擎索引，生成合并视图', async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex(['demo-plugin', true]));

    await usePluginsStore.getState().refresh();

    const state = usePluginsStore.getState();
    expect(state.pluginsRoot).toBe(PLUGINS_ROOT);
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0]?.activation).toBe('active');
    expect(state.loaded).toBe(true);
    expect(state.error).toBeNull();
  });

  it('引擎不可达 → 包照常列出、状态标未知，且**不占 error 位**（网关没起是常态）', async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue({
      available: false,
      entries: [],
      error: 'ECONNREFUSED',
    });

    await usePluginsStore.getState().refresh();

    const state = usePluginsStore.getState();
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0]?.activation).toBe('unknown');
    expect(state.error).toBeNull();
    expect(state.engine.error).toBe('ECONNREFUSED');
  });

  it('runtime 未实现 listPlugins（Web 端）→ 不抛异常，标为问不到', async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    __setRuntimeForTest(makeRuntime({}));

    await usePluginsStore.getState().refresh();

    expect(usePluginsStore.getState().engine.available).toBe(false);
    expect(usePluginsStore.getState().error).toBeNull();
  });

  it('坏包进 skipped 并带入视图状态（供界面提示）', async () => {
    stubPlatform({ plugins: [installed()], skipped: ['broken'] });
    listPlugins.mockResolvedValue(engineIndex());

    await usePluginsStore.getState().refresh();

    expect(usePluginsStore.getState().skipped).toEqual(['broken']);
  });
});

// ---------------------------------------------------------------------------
// setEnabled：引擎先行、意图后写
// ---------------------------------------------------------------------------

describe('pluginsStore.setEnabled', () => {
  beforeEach(async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex(['demo-plugin', false]));
    await usePluginsStore.getState().refresh();
  });

  it('引擎成功 → 才写意图，并本地更新激活状态', async () => {
    setPluginEnabled.mockResolvedValue({ ok: true });

    const ok = await usePluginsStore.getState().setEnabled('demo-plugin', true);

    expect(ok).toBe(true);
    expect(setPluginEnabled).toHaveBeenCalledWith('demo-plugin', true);
    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual(['demo-plugin']);
    expect(usePluginsStore.getState().installed[0]?.activation).toBe('active');
    expect(usePluginsStore.getState().installed[0]?.drift).toBe('in-sync');
  });

  it('引擎拒绝 → **意图一个字都不写**，并把原因摆到 error 上', async () => {
    setPluginEnabled.mockResolvedValue({ ok: false, error: '插件包内容已变更，请重新扫描后再启用' });

    const ok = await usePluginsStore.getState().setEnabled('demo-plugin', true);

    expect(ok).toBe(false);
    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual([]);
    expect(usePluginsStore.getState().error).toContain('内容已变更');
  });

  it('引擎抛异常 → 同样不写意图（异常不能绕成「已启用」）', async () => {
    setPluginEnabled.mockRejectedValue(new Error('boom'));

    const ok = await usePluginsStore.getState().setEnabled('demo-plugin', true);

    expect(ok).toBe(false);
    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual([]);
    expect(usePluginsStore.getState().error).toBe('boom');
  });

  it('runtime 不支持启停（Web 端）→ 不写意图，提示改用桌面端', async () => {
    __setRuntimeForTest(makeRuntime({}));

    const ok = await usePluginsStore.getState().setEnabled('demo-plugin', true);

    expect(ok).toBe(false);
    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual([]);
    expect(usePluginsStore.getState().error).toContain('桌面端');
  });

  it('停用 → 意图条目被清掉（不是写一个 false）', async () => {
    setPluginEnabled.mockResolvedValue({ ok: true });
    await usePluginsStore.getState().setEnabled('demo-plugin', true);

    await usePluginsStore.getState().setEnabled('demo-plugin', false);

    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual([]);
    expect(usePluginsStore.getState().installed[0]?.activation).toBe('inactive');
  });

  it('已启用的条目被再次启用时保留市场后缀（来源信息不丢）', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, enabledPlugins: ['demo-plugin@official'] },
    }));
    setPluginEnabled.mockResolvedValue({ ok: true });

    await usePluginsStore.getState().setEnabled('demo-plugin', true);

    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual(['demo-plugin@official']);
  });

  it('停用后再启用 → 裸名字（后缀随条目一起被删，市场流程需在安装时记录来源）', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, enabledPlugins: ['demo-plugin@official'] },
    }));
    setPluginEnabled.mockResolvedValue({ ok: true });

    await usePluginsStore.getState().setEnabled('demo-plugin', false);
    await usePluginsStore.getState().setEnabled('demo-plugin', true);

    // 这是**已知**的信息损失，不是 bug：意图表是市场后缀的唯一存放处，
    // 停用即清条目。等 FR-3.8 的市场流程落地时，来源应该记在**包**上
    // （`InstalledPlugin`）而不是意图表里——那时这条用例要改。
    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual(['demo-plugin']);
  });
});

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

describe('pluginsStore.install', () => {
  it('失败 → error 有原因，且不刷新', async () => {
    const scanSpy = vi.spyOn(platform, 'scanPlugins');
    vi.spyOn(platform, 'installPlugin').mockResolvedValue({
      ok: false,
      error: '不是合法的插件包',
      errorKind: 'manifest-invalid',
    });

    const result = await usePluginsStore.getState().install('/tmp/pkg');

    expect(result.ok).toBe(false);
    expect(usePluginsStore.getState().error).toBe('不是合法的插件包');
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('成功 → 记一次 notice 并重新扫描', async () => {
    vi.spyOn(platform, 'installPlugin').mockResolvedValue({
      ok: true,
      root: `${PLUGINS_ROOT}/demo-plugin`,
      manifest: manifest(),
    });
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex());

    const result = await usePluginsStore.getState().install('/tmp/pkg');

    expect(result.ok).toBe(true);
    expect(usePluginsStore.getState().notice).toContain('已安装');
    expect(usePluginsStore.getState().installed).toHaveLength(1);
  });
});

describe('pluginsStore.uninstall', () => {
  it('成功后清掉意图条目（否则会留下一个指不到东西的幽灵）', async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex(['demo-plugin', true]));
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, enabledPlugins: ['demo-plugin@official'] },
    }));
    vi.spyOn(platform, 'uninstallPlugin').mockResolvedValue({ ok: true });

    const ok = await usePluginsStore.getState().uninstall('demo-plugin');

    expect(ok).toBe(true);
    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual([]);
  });

  it('失败 → 保留意图（包还在磁盘上，用户可能只是想重试）', async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex());
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, enabledPlugins: ['demo-plugin'] },
    }));
    vi.spyOn(platform, 'uninstallPlugin').mockResolvedValue({
      ok: false,
      error: '插件不存在',
    });

    const ok = await usePluginsStore.getState().uninstall('demo-plugin');

    expect(ok).toBe(false);
    expect(useSettingsStore.getState().settings.enabledPlugins).toEqual(['demo-plugin']);
    expect(usePluginsStore.getState().error).toBe('插件不存在');
  });
});

// ---------------------------------------------------------------------------
// 市场注册表与版本切换（FR-3.7 / FR-3.8）
// ---------------------------------------------------------------------------

/**
 * 市场相关状态骨架（与 store 的 `EMPTY_MARKET_STATE` 对齐）。
 *
 * 每个用例前重置而不是靠顺序：这些字段一旦粘住，上一个用例的「同步中」就会
 * 让下一个用例的按钮显示成禁用，那种失败读起来完全指向错误的方向。
 */
function resetMarketState(): void {
  usePluginsStore.setState({
    markets: [],
    marketIndexes: {},
    loadingMarkets: false,
    loadingIndexes: {},
    syncingMarket: null,
    installingKey: null,
    marketError: null,
  });
}

function marketEntry(patch: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    id: 'official',
    name: '官方市场',
    type: 'directory',
    location: '/srv/plugins',
    isBuiltIn: false,
    autoUpdate: false,
    lastSyncAt: null,
    lastError: null,
    ...patch,
  };
}

describe('pluginsStore.loadMarkets', () => {
  beforeEach(resetMarketState);

  it('读注册表 → 市场列表原样进来', async () => {
    vi.spyOn(platform, 'pluginsMarkets').mockResolvedValue({
      version: 1,
      markets: [marketEntry()],
      error: null,
    });

    await usePluginsStore.getState().loadMarkets();

    expect(usePluginsStore.getState().markets).toHaveLength(1);
    expect(usePluginsStore.getState().marketError).toBeNull();
    expect(usePluginsStore.getState().loadingMarkets).toBe(false);
  });

  it('平台层报不可用原因 → 落到 marketError，不伪装成「没有市场」', async () => {
    vi.spyOn(platform, 'pluginsMarkets').mockResolvedValue({
      version: 1,
      markets: [],
      error: 'Web 端不支持市场功能，请使用桌面端',
    });

    await usePluginsStore.getState().loadMarkets();

    expect(usePluginsStore.getState().markets).toEqual([]);
    expect(usePluginsStore.getState().marketError).toContain('桌面端');
  });

  it('注册表里 markets 字段缺失/不是数组 → 退化为空列表而不是渲染出 undefined 卡', async () => {
    // @ts-expect-error 故意喂畸形注册表：主进程始终写这个字段，这里防的是将来改 schema 漏更
    vi.spyOn(platform, 'pluginsMarkets').mockResolvedValue({ version: 1, error: null });

    await usePluginsStore.getState().loadMarkets();

    expect(usePluginsStore.getState().markets).toEqual([]);
  });
});

describe('pluginsStore.syncMarket', () => {
  beforeEach(resetMarketState);

  it('同步成功 → 用**回写后**的条目替掉旧条目（否则 lastSyncAt 永远停在同步前）', async () => {
    usePluginsStore.setState({ markets: [marketEntry()] });
    vi.spyOn(platform, 'pluginsMarketsSync').mockResolvedValue({
      ok: true,
      result: { ok: true, market: 'official', synced: 3, skipped: [] },
      entry: marketEntry({ lastSyncAt: '2026-10-04T05:00:00.000Z' }),
      error: undefined,
    });

    const outcome = await usePluginsStore.getState().syncMarket('official');

    expect(outcome?.ok).toBe(true);
    expect(usePluginsStore.getState().markets).toHaveLength(1);
    expect(usePluginsStore.getState().markets[0]?.lastSyncAt).toBe('2026-10-04T05:00:00.000Z');
    expect(usePluginsStore.getState().syncingMarket).toBeNull();
  });

  it('平台层报找不到市场 → 如实返回失败，**不装作同步成功**（同步是唯一事实来源）', async () => {
    usePluginsStore.setState({ markets: [marketEntry()] });
    vi.spyOn(platform, 'pluginsMarketsSync').mockResolvedValue({
      ok: false,
      result: { ok: false, market: 'ghost', synced: 0, skipped: [], error: '市场不存在' },
      entry: marketEntry({ id: 'ghost', lastError: '市场不存在' }),
      error: '市场不存在',
    });

    const outcome = await usePluginsStore.getState().syncMarket('ghost');

    expect(outcome?.ok).toBe(false);
    expect(outcome?.error).toBe('市场不存在');
    expect(usePluginsStore.getState().marketError).toBe('市场不存在');
    // 回写后的条目（带 lastError）是唯一权威：主进程已经把它落进注册表，
    // 界面若留着同步前的旧值，就会显示一个「没同步过也没失败过」的市场。
    expect(usePluginsStore.getState().markets.map((m) => m.id)).toEqual(['official', 'ghost']);
    expect(usePluginsStore.getState().markets[1]?.lastError).toBe('市场不存在');
  });
});

describe('pluginsStore.installFromMarket', () => {
  beforeEach(resetMarketState);

  it('成功 → notice 明确「仍需启用」，并重新扫描磁盘（副本是新目录）', async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex());
    vi.spyOn(platform, 'pluginsMarketInstall').mockResolvedValue({
      ok: true,
      market: 'official',
      name: 'demo-plugin',
      version: '2.0.0',
      path: `${PLUGINS_ROOT}/cache/official/demo-plugin/2.0.0`,
    });

    const ok = await usePluginsStore.getState().installFromMarket('official', 'demo-plugin', '2.0.0');

    expect(ok).toBe(true);
    expect(usePluginsStore.getState().notice).toContain('仍需启用');
    expect(usePluginsStore.getState().installingKey).toBeNull();
  });

  it('失败 → marketError 有原因，且**不自动启用**（引擎激活标记与内容指纹绑定）', async () => {
    stubPlatform({ plugins: [installed()], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex(['demo-plugin', false]));
    vi.spyOn(platform, 'pluginsMarketInstall').mockResolvedValue({
      ok: false,
      market: 'official',
      name: 'demo-plugin',
      version: '2.0.0',
      path: '',
      error: '副本写入失败',
    });
    await usePluginsStore.getState().refresh();

    const ok = await usePluginsStore.getState().installFromMarket('official', 'demo-plugin', '2.0.0');

    expect(ok).toBe(false);
    expect(usePluginsStore.getState().marketError).toBe('副本写入失败');
    expect(usePluginsStore.getState().engine.entries[0]?.enabled).toBe(false);
    expect(usePluginsStore.getState().installingKey).toBeNull();
  });
});

describe('pluginsStore.collectCache', () => {
  beforeEach(resetMarketState);

  it('传给主进程的引用集**只含市场来源的包根**（本地安装的那一摊不归 GC 管）', async () => {
    stubPlatform({ plugins: [], skipped: [] });
    listPlugins.mockResolvedValue(engineIndex());
    // 一个市场副本（生效中）+ 一个本地平铺安装（不该出现在引用集里）
    const cacheCopy: InstalledPlugin = {
      ...installed(),
      root: `${PLUGINS_ROOT}/cache/official/demo-plugin/2.0.0`,
    };
    vi.spyOn(platform, 'scanPlugins').mockResolvedValue({
      plugins: [cacheCopy, installed({ name: 'local-one' })],
      skipped: [],
      pluginsRoot: PLUGINS_ROOT,
    });
    const gcSpy = vi
      .spyOn(platform, 'pluginsMarketGc')
      .mockResolvedValue({ removed: [], kept: [] });

    await usePluginsStore.getState().refresh();
    await usePluginsStore.getState().collectCache(30);

    const [referenced, keepDays] = gcSpy.mock.calls[0] ?? [];
    expect(referenced).toEqual([`${PLUGINS_ROOT}/cache/official/demo-plugin/2.0.0`]);
    expect(keepDays).toBe(30);
  });

  it('主进程失败 → 不抛出去，返回空回收结果（界面只提示，不该崩整页）', async () => {
    vi.spyOn(platform, 'pluginsMarketGc').mockRejectedValue(new Error('目录被占用'));

    const result = await usePluginsStore.getState().collectCache();

    expect(result).toEqual({ removed: [], kept: [] });
    expect(usePluginsStore.getState().marketError).toBe('目录被占用');
  });
});
