import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { usePluginsStore } from '@/stores/pluginsStore';
import { PluginMarketSection } from '@/pages/plugins/PluginMarketSection';
import { buttonByText, click, flush, mount } from '../helpers/reactMount';
import type {
  InstalledPlugin,
  MarketInstallResult,
  MarketIndex,
  MarketPackage,
  MarketSyncOutcome,
  MarketplaceEntry,
  PluginManifest,
} from '@/types/plugin';

/**
 * 插件市场区 UI（FR-3.7 / FR-3.8）。
 *
 * 钉的是「界面有没有把两件不同的事说成一件」：
 *
 * 1. **同步 ≠ 安装**：目录型市场点「同步」后还得自己点「浏览包」才看到包，
 *    因为「源侧有什么」和「归档了什么」不是一回事，ynth 成一步会让用户以为
 *    同步已经把插件装上了。
 * 2. **远程市场不能偷偷联网**：本轮服务端不支持拉 zip，同步按钮是**禁用**的，
 *    不是点了才报错。禁用但 UI 上仍能看见它在这儿，用户知道「以后可能会能」。
 * 3. **当前生效版本必须标出来且不可再点**：同一包摆出三个版本按钮却不指明哪版在跑，
 *    用户只能靠猜，猜错就是「切了版本没生效」。
 */

const PLUGINS_ROOT = '/home/u/.nanowork/plugins';

const pluginsMarkets = vi.fn();
const pluginsMarketsUpsert = vi.fn();
const pluginsMarketsRemove = vi.fn();
const pluginsMarketsSync = vi.fn();
const pluginsMarketPackages = vi.fn();
const pluginsMarketInstall = vi.fn();
const pluginsMarketGc = vi.fn();
const scanPlugins = vi.fn();

function manifest(patch: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'demo-plugin',
    displayName: '演示插件',
    version: '2.0.0',
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

function installedPlugin(name: string, root: string): InstalledPlugin {
  return { manifest: manifest({ name }), root, resources: [] };
}

/** 一条注册表条目 */
function market(patch: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    id: 'official',
    name: '官方市场',
    type: 'directory',
    location: '/plugins/official',
    isBuiltIn: false,
    autoUpdate: false,
    lastSyncAt: '2026-10-01T09:30:00.000Z',
    lastError: null,
    ...patch,
  };
}

function pkg(name: string, version: string): MarketPackage {
  return { name, displayName: name, version, description: '' };
}

function indexOf(packages: MarketPackage[], skipped: string[] = []): MarketIndex {
  return { market: 'official', packages, skipped };
}

function marketSyncOutcome(patch: Partial<MarketSyncOutcome> = {}): MarketSyncOutcome {
    return {
      ok: true,
      entry: market(),
      result: { ok: true, market: 'official', synced: 2, skipped: [] },
      ...patch,
    };
}

function installOk(): MarketInstallResult {
  return {
    ok: true,
    market: 'official',
    name: 'demo-plugin',
    version: '1.9.0',
    path: `${PLUGINS_ROOT}/cache/official/demo-plugin/1.9.0`,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // 组件按 `platform.env` 决定市场写操作要不要禁用；jsdom 里默认跑 web 分支，
  // 不撑成 electron 就会集体测到「Web 端不支持」那条降级路径。
  Object.defineProperty(platform, 'env', { value: 'electron', configurable: true });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  Object.assign(platform, {
    pluginsMarkets,
    pluginsMarketsUpsert,
    pluginsMarketsRemove,
    pluginsMarketsSync,
    pluginsMarketPackages,
    pluginsMarketInstall,
    pluginsMarketGc,
    scanPlugins,
  });
  vi.spyOn(platform, 'appInfo').mockResolvedValue(null);

  pluginsMarkets.mockReset();
  pluginsMarketsUpsert.mockReset();
  pluginsMarketsRemove.mockReset();
  pluginsMarketsSync.mockReset();
  pluginsMarketPackages.mockReset();
  pluginsMarketInstall.mockReset();
  pluginsMarketGc.mockReset();
  scanPlugins.mockReset();

  pluginsMarkets.mockResolvedValue({ markets: [], error: null });
  pluginsMarketsUpsert.mockResolvedValue({ ok: true });
  pluginsMarketsRemove.mockResolvedValue({ ok: true });
  pluginsMarketsSync.mockResolvedValue(marketSyncOutcome());
  pluginsMarketInstall.mockResolvedValue(installOk());
  pluginsMarketGc.mockResolvedValue({ removed: [], kept: [] });
  scanPlugins.mockResolvedValue({
    plugins: [],
    skipped: [],
    pluginsRoot: PLUGINS_ROOT,
  });

  usePluginsStore.setState({
    installed: [],
    skipped: [],
    pluginsRoot: PLUGINS_ROOT,
    engine: { available: false, entries: [] },
    loaded: false,
    refreshing: false,
    error: null,
    notice: null,
    appVersion: null,
    markets: [],
    loadingMarkets: false,
    marketError: null,
    syncingMarket: null,
    installingKey: null,
    marketIndexes: {},
    loadingIndexes: {},
  });
});

/** 跑完挂载后那些 (async) 副作用链 */
async function renderSection() {
  const host = mount(<PluginMarketSection />);
  await flush();
  return host;
}

describe('PluginMarketSection 市场形状', () => {
  it('目录型市场：显示「目录型」+ 上次同步时刻，同步按钮可点', async () => {
    pluginsMarkets.mockResolvedValue({ markets: [market()], error: null });

    const host = await renderSection();

    expect(host.textContent).toContain('官方市场');
    expect(host.textContent).toContain('目录型');
    expect(host.textContent).toContain('上次同步 2026-10-01 09:30');
    expect(buttonByText(host, '同步')?.disabled).toBe(false);
  });

  it('远程市场的同步按钮是禁用的（本轮不联网，点了才报错比禁用更糟）', async () => {
    pluginsMarkets.mockResolvedValue({
      markets: [market({ id: 'remote-1', name: '远程市场', type: 'remote', location: 'https://x/y.zip' })],
      error: null,
    });

    const host = await renderSection();

    expect(host.textContent).toContain('远程');
    const sync = buttonByText(host, '同步');
    expect(sync).toBeTruthy();
    expect((sync as HTMLButtonElement).disabled).toBe(true);
  });

  it('同步失败要显示在卡片上（「点了没反应」和「失败了」不能是同一种显示）', async () => {
    pluginsMarkets.mockResolvedValue({ markets: [market()], error: null });
    pluginsMarketsSync.mockResolvedValue(
      marketSyncOutcome({ ok: false, entry: market({ lastError: '目录不存在' }) }),
    );

    const host = await renderSection();
    click(buttonByText(host, '同步'));
    await flush();

    expect(host.textContent).toContain('上次同步失败：目录不存在');
  });

  it('内置市场不可删除（删除按钮禁用，不给「点完被拒绝」的体验）', async () => {
    pluginsMarkets.mockResolvedValue({
      markets: [market({ id: 'builtin', name: '内置市场', isBuiltIn: true })],
      error: null,
    });

    const host = await renderSection();

    expect(host.textContent).toContain('内置');
    const del = host.querySelector('[aria-label="删除市场 内置市场"]');
    expect(del).toBeTruthy();
    expect((del as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PluginMarketSection 包列表与切版本', () => {
  it('展开才拉索引：没展开不读盘，「浏览包」是显式的一步', async () => {
    pluginsMarkets.mockResolvedValue({ markets: [market()], error: null });

    await renderSection();

    expect(pluginsMarketPackages).not.toHaveBeenCalled();

    click(buttonByText(document.body, '浏览包'));
    await flush();

    expect(pluginsMarketPackages).toHaveBeenCalledWith('official');
  });

  it('当前生效版本标高亮+禁用，别的版本可点（不指明哪版在跑，切了版本就等于没切）', async () => {
    pluginsMarkets.mockResolvedValue({ markets: [market()], error: null });
    pluginsMarketPackages.mockResolvedValue(
      indexOf([pkg('demo-plugin', '2.0.0'), pkg('demo-plugin', '1.9.0')]),
    );
    usePluginsStore.setState({
      installed: [
        {
          plugin: installedPlugin('demo-plugin', `${PLUGINS_ROOT}/cache/official/demo-plugin/2.0.0`),
          activation: 'unknown',
          intended: false,
          drift: 'unknown',
          engineIncompatible: false,
          hooks: { active: 0, events: {}, dropped: 0 },
          source: { market: 'official', version: '2.0.0' },
        },
      ],
    });

    const host = await renderSection();
    click(buttonByText(host, '浏览包'));
    await flush();

    expect(host.textContent).toContain('v2.0.0（生效中）');
    const current = buttonByText(host, 'v2.0.0（生效中）');
    expect((current as HTMLButtonElement).disabled).toBe(true);

    const older = buttonByText(host, 'v1.9.0');
    expect((older as HTMLButtonElement).disabled).toBe(false);
    click(older);
    await flush();

    // 切版本走的是「安装 + 拨指针」，不是复制粘贴一个目录
    expect(pluginsMarketInstall).toHaveBeenCalledWith('official', 'demo-plugin', '1.9.0');
    // 装完重新扫盘：副本是新目录，磁盘事实变了
    expect(scanPlugins).toHaveBeenCalled();
  });

  it('比生效版本还旧的版本标「更旧」而不是「更新」（不劝用户降级）', async () => {
    pluginsMarkets.mockResolvedValue({ markets: [market()], error: null });
    pluginsMarketPackages.mockResolvedValue(
      indexOf([pkg('demo-plugin', '2.0.0'), pkg('demo-plugin', '1.8.0')]),
    );
    usePluginsStore.setState({
      installed: [
        {
          plugin: installedPlugin('demo-plugin', `${PLUGINS_ROOT}/cache/official/demo-plugin/2.0.0`),
          activation: 'unknown',
          intended: false,
          drift: 'unknown',
          engineIncompatible: false,
          hooks: { active: 0, events: {}, dropped: 0 },
          source: { market: 'official', version: '2.0.0' },
        },
      ],
    });

    const host = await renderSection();
    click(buttonByText(host, '浏览包'));
    await flush();

    expect(host.textContent).toContain('v1.8.0');
    expect(host.textContent).not.toContain('v1.8.0 更新');
  });

  it('同步后索引为空时说清楚要做什么（不留白「没包」二字了事）', async () => {
    pluginsMarkets.mockResolvedValue({ markets: [market()], error: null });
    pluginsMarketPackages.mockResolvedValue(indexOf([], ['broken-dir']));

    const host = await renderSection();
    click(buttonByText(host, '浏览包'));
    await flush();

    expect(host.textContent).toContain('这个市场里还没有归档任何包');
    expect(host.textContent).toContain('已跳过 1 个不合规目录：broken-dir');
  });
});
