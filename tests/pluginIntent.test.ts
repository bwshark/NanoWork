import { describe, expect, it } from 'vitest';
import {
  derivePluginDrift,
  derivePluginViews,
  isPluginIntended,
  PLUGIN_DRIFT_NOTICE,
  pluginMarketplaceFromEntry,
  pluginNameFromEntry,
  withPluginIntent,
} from '@/lib/pluginIntent';
import type { InstalledPlugin, PluginEngineIndex, PluginManifest } from '@/types/plugin';

/**
 * 插件意图与派生视图测试（FR-3.4，纯函数）。
 *
 * 这里钉住的是「三份事实不合并」这条设计：
 * - 磁盘（装了什么）、引擎（激活没有）、意图（想不想启用）各自独立；
 * - 不一致显式算成 `PluginDrift` 交给界面提示，**不静默对齐**。
 *
 * 静默对齐会让「明明启用了却没生效」变成一次无痕的自我治愈，问题从此查不出来
 * —— 与技能三态覆盖的 `syncError` 是同一个教训。
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
    root: `C:/Users/u/.nanowork/plugins/${patch.name ?? 'demo-plugin'}`,
    resources: [],
  };
}

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

// ---------------------------------------------------------------------------
// 条目解析（`<name>@<marketplace>`）
// ---------------------------------------------------------------------------

describe('enabledPlugins 条目解析', () => {
  it('裸名字（本地安装）→ 名字就是它本身、没有市场', () => {
    expect(pluginNameFromEntry('demo-plugin')).toBe('demo-plugin');
    expect(pluginMarketplaceFromEntry('demo-plugin')).toBeNull();
  });

  it('带市场后缀 → 拆出名字与市场', () => {
    expect(pluginNameFromEntry('demo-plugin@official')).toBe('demo-plugin');
    expect(pluginMarketplaceFromEntry('demo-plugin@official')).toBe('official');
  });

  it('从**最后一个** @ 切：市场名里可能还有 @', () => {
    expect(pluginNameFromEntry('demo-plugin@corp@mirror')).toBe('demo-plugin@corp');
    expect(pluginMarketplaceFromEntry('demo-plugin@corp@mirror')).toBe('mirror');
  });

  it('以 @ 开头（没有名字）视作整串就是名字，不产生空名字', () => {
    expect(pluginNameFromEntry('@official')).toBe('@official');
  });
});

describe('isPluginIntended', () => {
  it('undefined / 空表 → 一律 false（老数据里没有这个字段）', () => {
    expect(isPluginIntended(undefined, 'demo-plugin')).toBe(false);
    expect(isPluginIntended([], 'demo-plugin')).toBe(false);
  });

  it('按名字匹配，忽略市场后缀差异', () => {
    expect(isPluginIntended(['demo-plugin@official'], 'demo-plugin')).toBe(true);
    expect(isPluginIntended(['other@official'], 'demo-plugin')).toBe(false);
  });

  it('空名字恒 false（不让空名匹配到任何东西）', () => {
    expect(isPluginIntended(['demo-plugin'], '')).toBe(false);
  });
});

describe('withPluginIntent', () => {
  it('启用时追加，带市场后缀', () => {
    expect(withPluginIntent([], 'demo-plugin', true, 'official')).toEqual([
      'demo-plugin@official',
    ]);
  });

  it('启用但没市场 → 裸名字（本地安装的包）', () => {
    expect(withPluginIntent([], 'demo-plugin', true)).toEqual(['demo-plugin']);
  });

  it('停用时把该名字的**所有**条目清掉（含其他来源的）', () => {
    expect(
      withPluginIntent(['demo-plugin@official', 'demo-plugin@mirror', 'other'], 'demo-plugin', false),
    ).toEqual(['other']);
  });

  it('重新启用会替换旧条目而不是叠加（否则「从哪个市场装的」无法回答）', () => {
    expect(withPluginIntent(['demo-plugin@mirror'], 'demo-plugin', true, 'official')).toEqual([
      'demo-plugin@official',
    ]);
  });

  it('不改原数组', () => {
    const original = ['demo-plugin@official'];
    withPluginIntent(original, 'demo-plugin', false);
    expect(original).toEqual(['demo-plugin@official']);
  });
});

// ---------------------------------------------------------------------------
// 偏差判定
// ---------------------------------------------------------------------------

describe('derivePluginDrift', () => {
  it.each([
    [true, 'active', 'in-sync'],
    [true, 'inactive', 'intent-only'],
    [false, 'active', 'engine-only'],
    [false, 'inactive', 'both-off'],
    [true, 'unknown', 'unknown'],
    [false, 'unknown', 'unknown'],
  ] as const)('意图=%s 激活=%s → %s', (intended, activation, expected) => {
    expect(derivePluginDrift(intended, activation)).toBe(expected);
  });

  it('一致的两档没有提示文案，不一致的两档都有（界面靠这个决定要不要显示说明）', () => {
    expect(PLUGIN_DRIFT_NOTICE['in-sync']).toBeNull();
    expect(PLUGIN_DRIFT_NOTICE['both-off']).toBeNull();
    expect(PLUGIN_DRIFT_NOTICE['intent-only']).toBeTruthy();
    expect(PLUGIN_DRIFT_NOTICE['engine-only']).toBeTruthy();
    expect(PLUGIN_DRIFT_NOTICE.unknown).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 派生视图
// ---------------------------------------------------------------------------

describe('derivePluginViews', () => {
  it('只列磁盘上真实存在的包（意图里的幽灵条目不算插件）', () => {
    const views = derivePluginViews(
      [installed()],
      engineIndex(),
      ['demo-plugin@official', 'ghost-plugin@official'],
    );

    expect(views.map((v) => v.plugin.manifest.name)).toEqual(['demo-plugin']);
  });

  it('引擎可达：命中 → 按 enabled 判激活，未上报 → 未激活', () => {
    const views = derivePluginViews(
      [installed({ name: 'a' }), installed({ name: 'b' })],
      engineIndex(['a', true]),
      [],
    );

    expect(views.map((v) => v.activation)).toEqual(['active', 'inactive']);
  });

  it('引擎不可达（网关没起）→ 全部「未知」，但包照常列出来', () => {
    const views = derivePluginViews(
      [installed()],
      { available: false, entries: [], error: 'ECONNREFUSED' },
      [],
    );

    expect(views).toHaveLength(1);
    expect(views[0]?.activation).toBe('unknown');
    expect(views[0]?.drift).toBe('unknown');
  });

  it('装了 + 想启用 + 引擎没激活 → intent-only（最常见的不一致）', () => {
    const views = derivePluginViews([installed()], engineIndex(), ['demo-plugin@official']);

    expect(views[0]?.intended).toBe(true);
    expect(views[0]?.drift).toBe('intent-only');
  });

  it('引擎激活但本地没意图 → engine-only（在网页端启用过）', () => {
    const views = derivePluginViews([installed()], engineIndex(['demo-plugin', true]), []);

    expect(views[0]?.intended).toBe(false);
    expect(views[0]?.drift).toBe('engine-only');
  });

  it('engineRange 满足 → 不报不兼容；不满足 → 报', () => {
    const views = derivePluginViews(
      [
        installed({ name: 'ok', engineRange: '>=1.0.0' }),
        installed({ name: 'bad', engineRange: '>=99.0.0' }),
      ],
      engineIndex(),
      [],
      { appVersion: '1.5.0' },
    );

    expect(views[0]?.engineIncompatible).toBe(false);
    expect(views[1]?.engineIncompatible).toBe(true);
  });

  it('版本未知（Web 端）→ 一律不报不兼容（误报会劝退本来能用的包）', () => {
    const views = derivePluginViews(
      [installed({ engineRange: '>=99.0.0' })],
      engineIndex(),
      [],
      { appVersion: null },
    );

    expect(views[0]?.engineIncompatible).toBe(false);
  });

  it('清单没声明 engineRange → 不报不兼容（未声明 = 无约束）', () => {
    const views = derivePluginViews(
      [installed({ engineRange: '' })],
      engineIndex(),
      [],
      { appVersion: '1.0.0' },
    );

    expect(views[0]?.engineIncompatible).toBe(false);
  });
});
