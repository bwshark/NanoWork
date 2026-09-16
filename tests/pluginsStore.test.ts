import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { __setRuntimeForTest } from '@/ai/runtime';
import { usePluginsStore } from '@/stores/pluginsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentRuntime } from '@/ai/runtime/types';
import type { InstalledPlugin, PluginEngineIndex, PluginManifest } from '@/types/plugin';

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
