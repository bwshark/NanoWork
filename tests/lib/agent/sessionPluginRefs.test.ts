/**
 * 会话版本引用集（FR-3.9 ①）——纯函数层。
 *
 * 这里锁三件事：
 * 1. 快照只收「本地意图启用 + 有市场来源 + 版本可读」的插件；
 * 2. 解析用**本机副本**回答「这个会话要的那一版在不在」，缺失要说成 `missing`
 *    而不是静默当成「没有引用」；
 * 3. GC 保护取的是**引用集要求的路径**（跨设备会话的声明），而不是「本机生效副本」。
 */

import { describe, expect, it } from 'vitest';
import {
  collectMissingSessionPluginRefs,
  referencedCopyPathsForSessions,
  resolveSessionPluginRefs,
  snapshotSessionPluginVersions,
} from '@/lib/agent/sessionPluginRefs';
import type { PluginView } from '@/types/plugin';

function view(overrides: {
  name?: string;
  version?: string | null;
  market?: string | null;
  intended?: boolean;
  root?: string;
}): PluginView {
  const name = overrides.name ?? 'demo';
  const result: PluginView = {
    plugin: {
      manifest: {
        name,
        displayName: name,
        version: overrides.version ?? '0.0.0',
        versionDeclared: overrides.version !== undefined,
        description: '',
        repository: '',
        category: '',
        main: 'SKILL.md',
        permissions: { tools: [], network: [] },
        engineRange: '',
        schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.json',
        manifestRelPath: 'plugin.json',
      },
      root: overrides.root ?? `/plugins/${name}`,
      resources: [],
      expertPackages: [],
    },
    activation: 'inactive',
    intended: overrides.intended ?? true,
    drift: 'both-off',
    engineIncompatible: false,
    hooks: { active: 0, events: {}, dropped: 0 },
    source: {
      market: overrides.market === undefined ? 'local-market' : overrides.market,
      version: overrides.version === undefined ? '1.0.0' : overrides.version,
    },
  };
  return result;
}

describe('snapshotSessionPluginVersions：建会话时的声明快照', () => {
  it('只收启用 + 市场来源 + 有版本的插件', () => {
    const snapshot = snapshotSessionPluginVersions([
      view({ name: 'a', version: '0.1.9' }),
      // 未启用：不算「这个会话在用的」
      view({ name: 'b', version: '1.0.0', intended: false }),
      // 本地直装（无市场来源）：不会被 cache/<market>/ 的 GC 碰到，不需要声明
      view({ name: 'c', version: '2.0.0', market: null }),
      // 引擎离线时 `source.version` 读不到 → 退包自己声明的版本。
      // 「版本不可知」时宁可记下装着的这一版，也别让这个插件从声明里消失
      // （消失 = 它在 GC 眼里没有任何会话引用它）。
      view({ name: 'd', version: null }),
    ]);
    expect(snapshot).toEqual({ a: '0.1.9', d: '0.0.0' });
  });

  it('全空时返回 undefined 而不是空对象（少一种形态）', () => {
    expect(snapshotSessionPluginVersions([])).toBeUndefined();
    expect(snapshotSessionPluginVersions([view({ intended: false })])).toBeUndefined();
  });

  it('同一份输入两次快照得到内容相等的对象（声明要可比较）', () => {
    const views = [view({ name: 'a', version: '0.1.9' })];
    expect(snapshotSessionPluginVersions(views)).toEqual(snapshotSessionPluginVersions(views));
  });
});

describe('resolveSessionPluginRefs：本机装的是不是会话要的那一版', () => {
  it('版本一致 → matched，并给出本机副本路径', () => {
    const rows = resolveSessionPluginRefs({ demo: '0.1.9' }, [
      view({ name: 'demo', version: '0.1.9', root: '/cache/m/demo/0.1.9' }),
    ]);
    expect(rows).toEqual([
      { name: 'demo', version: '0.1.9', path: '/cache/m/demo/0.1.9', state: 'matched' },
    ]);
  });

  it('本机只有别的版本 → missing（这正是界面要如实说出来的差异）', () => {
    const rows = resolveSessionPluginRefs({ demo: '0.1.9' }, [
      view({ name: 'demo', version: '0.1.10', root: '/cache/m/demo/0.1.10' }),
    ]);
    expect(rows[0].state).toBe('missing');
    expect(rows[0].path).toBeNull();
  });

  it('没有引用集 → 空数组（不是「全部 missing」）', () => {
    expect(resolveSessionPluginRefs(undefined, [view({})])).toEqual([]);
  });

  it('按插件名排序，结果稳定', () => {
    const rows = resolveSessionPluginRefs({ zeta: '1.0.0', alpha: '1.0.0' }, []);
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('referencedCopyPathsForSessions：GC 要保护哪些副本', () => {
  it('命中的版本路径被保护，未命中的不保护', () => {
    const views = [
      view({ name: 'demo', version: '0.1.9', root: '/cache/m/demo/0.1.9' }),
      view({ name: 'demo', version: '0.1.10', root: '/cache/m/demo/0.1.10' }),
      view({ name: 'other', version: '3.0.0', root: '/cache/m/other/3.0.0' }),
    ];
    // 只有会话 a 引用 demo@0.1.9；demo@0.1.10 与 other 都不该被保护
    const paths = referencedCopyPathsForSessions(views, [{ demo: '0.1.9' }, undefined]);
    expect(paths).toEqual(['/cache/m/demo/0.1.9']);
  });

  it('多个会话的引用集取并集', () => {
    const views = [
      view({ name: 'demo', version: '0.1.9', root: '/cache/m/demo/0.1.9' }),
      view({ name: 'demo', version: '0.1.10', root: '/cache/m/demo/0.1.10' }),
    ];
    const paths = referencedCopyPathsForSessions(views, [
      { demo: '0.1.9' },
      { demo: '0.1.10' },
    ]);
    expect(paths).toEqual(['/cache/m/demo/0.1.10', '/cache/m/demo/0.1.9']);
  });

  it('没有任何引用集 → 空（不影响既有 GC 行为）', () => {
    expect(referencedCopyPathsForSessions([view({})], [])).toEqual([]);
    expect(referencedCopyPathsForSessions([view({})], [undefined])).toEqual([]);
  });

  it('本地直装的副本不进保护集（它不在市场缓存目录里）', () => {
    const views = [view({ name: 'demo', version: '0.1.9', market: null, root: '/plugins/demo' })];
    expect(referencedCopyPathsForSessions(views, [{ demo: '0.1.9' }])).toEqual([]);
  });
});

function session(id: string, title: string, refs?: Record<string, string> | null) {
  return { id, title, pluginVersions: refs ?? undefined };
}

describe('collectMissingSessionPluginRefs：界面上要提示的缺失项', () => {
  const views = [view({ name: 'demo', version: '0.1.10', root: '/cache/m/demo/0.1.10' })];

  it('会话要的那一版本机没有 → 出现在结果里', () => {
    const rows = collectMissingSessionPluginRefs(
      [session('s1', '在别台机器上建的会话', { demo: '0.1.9' })],
      views,
    );
    expect(rows).toEqual([
      {
        sessionId: 's1',
        sessionTitle: '在别台机器上建的会话',
        plugin: 'demo',
        version: '0.1.9',
      },
    ]);
  });

  it('版本对得上 → 不提示（`resolveSessionPluginRefs` 的 missing 才有意义）', () => {
    const rows = collectMissingSessionPluginRefs(
      [session('s1', '本机建的', { demo: '0.1.10' })],
      views,
    );
    expect(rows).toEqual([]);
  });

  it('没有引用集的会话一律不参与（缺声明 ≠ 缺版本）', () => {
    const rows = collectMissingSessionPluginRefs([session('s1', '旧会话'), session('s2', 'x', null)], views);
    expect(rows).toEqual([]);
  });

  it('多个会话的缺失合并，并按会话标题稳定排序', () => {
    const rows = collectMissingSessionPluginRefs(
      [
        session('s2', 'zeta 会话', { demo: '0.1.9' }),
        session('s1', 'alpha 会话', { demo: '0.1.9' }),
      ],
      views,
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });

  it('同一会话缺多个插件时按插件名排序', () => {
    const rows = collectMissingSessionPluginRefs(
      [session('s1', '多插件会话', { zeta: '2.0.0', alpha: '1.0.0' })],
      [],
    );
    expect(rows.map((r) => r.plugin)).toEqual(['alpha', 'zeta']);
  });

  it('没有会话 / 没有插件视图时不炸', () => {
    expect(collectMissingSessionPluginRefs([], views)).toEqual([]);
    expect(collectMissingSessionPluginRefs([session('s1', '孤儿会话', { demo: '1' })], [])).toEqual([
      {
        sessionId: 's1',
        sessionTitle: '孤儿会话',
        plugin: 'demo',
        version: '1',
      },
    ]);
  });
});
