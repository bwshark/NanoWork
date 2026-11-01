import { describe, expect, it } from 'vitest';
import {
  derivePluginDrift,
  derivePluginViews,
  describePluginSource,
  isPluginIntended,
  marketVersionState,
  PLUGIN_DRIFT_NOTICE,
  pluginMarketplaceFromEntry,
  pluginNameFromEntry,
  referencedCopyPaths,
  sourceFromPath,
  withPluginIntent,
} from '@/lib/agent/pluginIntent';
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
    expertPackages: [],
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
      hooks: { active: 0, events: {}, dropped: 0 },
      // 默认「说不上来源」：单测要显式指定从哪个市场装的，不该在这里猜
      market: null,
      version: null,
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

  it('来源：引擎上报了市场和版本 → 原样采纳（不按路径猜）', () => {
    const views = derivePluginViews(
      [installed()],
      {
        available: true,
        entries: [
          {
            name: 'demo-plugin',
            displayName: '演示插件',
            description: '',
            category: '',
            enabled: false,
            mcpServers: [],
            hooks: { active: 0, events: {}, dropped: 0 },
            market: 'official',
            version: '2.0.0',
          },
        ],
      },
      [],
    );

    expect(views[0]?.source).toEqual({ market: 'official', version: '2.0.0' });
  });

  it('来源：引擎只报了版本没报市场 → 也原样采纳（宁可缺市场，也不猜一个）', () => {
    const views = derivePluginViews(
      [installed()],
      {
        available: true,
        entries: [
          {
            name: 'demo-plugin',
            displayName: '演示插件',
            description: '',
            category: '',
            enabled: false,
            mcpServers: [],
            hooks: { active: 0, events: {}, dropped: 0 },
            market: null,
            version: '0.9.0',
          },
        ],
      },
      [],
    );

    expect(views[0]?.source).toEqual({ market: null, version: '0.9.0' });
  });

  it('来源兜底：引擎不可达 → 按路径反推市场副本，认不出就是本地安装', () => {
    const [cached, flat] = derivePluginViews(
      [
        { ...installed(), root: 'C:/Users/u/.nanowork/plugins/cache/official/demo-plugin/2.0.0' },
        { ...installed({ name: 'flat' }), root: 'C:/Users/u/.nanowork/plugins/flat' },
      ],
      { available: false, entries: [] },
      [],
    );

    expect(cached?.source).toEqual({ market: 'official', version: '2.0.0' });
    // 认不出路径时退回本地安装，**不编一个市场名出来**
    expect(flat?.source).toEqual({ market: null, version: '1.2.3' });
  });

  it('来源终极兜底：连市场路径都不是 → 用包自己声明的版本（未声明则不显示版本）', () => {
    const views = derivePluginViews(
      [installed({ version: '3.1.4', versionDeclared: true }), installed({ versionDeclared: false })],
      { available: false, entries: [] },
      [],
    );

    expect(views[0]?.source).toEqual({ market: null, version: '3.1.4' });
    expect(views[1]?.source).toEqual({ market: null, version: null });
  });
});

// ---------------------------------------------------------------------------
// 来源与版本（FR-3.8）
// ---------------------------------------------------------------------------

describe('sourceFromPath', () => {
  it('认得 cache/<market>/<plugin>/<version> 四段', () => {
    expect(sourceFromPath('/home/u/.nanowork/plugins/cache/official/demo-plugin/2.0.0')).toEqual({
      market: 'official',
      version: '2.0.0',
    });
  });

  it('Windows 反斜杠路径也一样认（路径分隔符不能写死成 "/"）', () => {
    expect(sourceFromPath('C:\\Users\\u\\.nanowork\\plugins\\cache\\official\\demo-plugin\\2.0.0')).toEqual(
      { market: 'official', version: '2.0.0' },
    );
  });

  it('认不出 / 段数不够 → null（调用方据此退回本地安装）', () => {
    expect(sourceFromPath('/home/u/.nanowork/plugins/demo-plugin')).toBeNull();
    expect(sourceFromPath('/home/u/.nanowork/plugins')).toBeNull();
  });

  it('插件名里带点号也不误判（段数够就信）', () => {
    expect(sourceFromPath('/p/cache/m/my.tool/1.2.3')).toEqual({
      market: 'm',
      version: '1.2.3',
    });
  });
});

describe('describePluginSource', () => {
  it('市场来源显示「市场 v版本」（界面一眼分清是哪个市场的哪一版）', () => {
    expect(describePluginSource({ market: 'official', version: '2.0.0' })).toBe('official v2.0.0');
  });

  it('本地安装即使有版本也不带市场名（那个版本不是市场里的版本号）', () => {
    expect(describePluginSource({ market: null, version: '1.2.3' })).toBe('本地安装 v1.2.3');
  });

  it('本地安装且说不出版本 → 只说「本地安装」', () => {
    expect(describePluginSource({ market: null, version: null })).toBe('本地安装');
  });
});

describe('marketVersionState', () => {
  it('市场里有这一版 → 生效中', () => {
    expect(marketVersionState('2.0.0', '2.0.0')).toBe('current');
  });

  it('比当前生效版本新 → 可更新；旧 → 更旧（旧的那档界面不标红劝升级）', () => {
    expect(marketVersionState('2.1.0', '2.0.0')).toBe('update');
    expect(marketVersionState('1.9.0', '2.0.0')).toBe('older');
  });

  it('说不上当前版本（引擎没报）→ 一律按「可更新」，不误报「更旧」', () => {
    expect(marketVersionState('2.0.0', null)).toBe('update');
  });

  it('解析不了的版本号 → 判「更旧」而不是「可更新」（说不清就不劝升级）', () => {
    expect(marketVersionState('latest', '2.0.0')).toBe('older');
  });
});

describe('referencedCopyPaths', () => {
  it('只收市场来源的包根（本地平铺安装不进 GC 的引用集）', () => {
    const views = derivePluginViews(
      [{ ...installed(), root: '/p/cache/official/demo-plugin/2.0.0' }, installed({ name: 'flat' })],
      { available: false, entries: [] },
      [],
    );

    expect(referencedCopyPaths(views)).toEqual(['/p/cache/official/demo-plugin/2.0.0']);
  });

  it('空列表 → 空引用集（GC 仍按 keepDays 保护，不会把新副本全删了）', () => {
    expect(referencedCopyPaths([])).toEqual([]);
  });
});
