/**
 * 市场注册表与版本化缓存（FR-3.7 / FR-3.8，主进程侧）。
 *
 * 钉住的是「源 / 生效副本 / 指针」这三层**不能互相串味**：
 *
 * 1. **市场同步不碰指针**——否则活跃会话会被半路换掉插件定义（这是整套设计的
 *    唯一理由，必须有一条断言专门盯它）；
 * 2. **只增不改**——已存在的版本目录不被后来的同步覆盖；
 * 3. **坏条目不传染**——一个市场写坏了，其它市场照常可读；
 * 4. **远程型不联网**——本轮没接下载通道，必须**如实失败**，不能把「拉不到」
 *    表现成「这个市场是空的」。
 */

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_DIR,
  CURRENT_POINTER,
  MARKETPLACES_DIR,
  MARKET_INDEX_FILENAME,
  collectMarketCache,
  describeMarketSync,
  installFromMarket,
  isOfflineCapable,
  listMarketPackages,
  normalizeMarketEntry,
  normalizeMarketplaceIndex,
  pickNewestVersion,
  readMarketRegistry,
  readMarketplaceIndex,
  recordMarketSync,
  removeMarket,
  resolveInstallOrder,
  shouldCollectCopy,
  syncMarket,
  upsertMarket,
  type MarketplaceEntry,
} from '@/../electron/pluginMarketplace';

/**
 * ⚠️ 临时目录**整文件共用一份**（每用例只建一个子目录），不要每用例 `mkdtemp` +
 * 递归 `rm`：Windows 上这两步各要几百毫秒到数秒，26 个用例叠起来会把
 * `tests/electron` 那一组（同批还有 pluginPackage / workspaceMemoryStore 的
 * 磁盘用例）一起拖到**超时**——实测它们会随机变红，而单独跑全是绿的。
 */
let root: string;
let caseDir: string;
let marketDir: string;
let caseSeq = 0;

function market(patch: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    id: 'demo-market',
    name: '演示市场',
    type: 'directory',
    location: marketDir,
    isBuiltIn: false,
    autoUpdate: false,
    lastSyncAt: null,
    lastError: null,
    ...patch,
  };
}

/**
 * 在市场源里放一个包。
 *
 * `dir` 与 `name` 分开：同一插件的**多个版本**在源里必须落在**不同目录**
 * （`alpha-1.0.0` / `alpha-2.0.0`），而清单里的 `name` 都叫 `alpha`——
 * 这正是市场里「多版本并存」的真实形态。
 */
async function putPackage(
  base: string,
  dir: string,
  name: string,
  version: string,
): Promise<void> {
  const target = join(base, dir);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version,
      description: `${name} ${version}`,
      extensions: { 'dev.nanobot': { displayName: `${name} 展示名` } },
    }),
    'utf8',
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nanowork-market-'));
});

/**
 * 清理**不等待**：本机有安全删除钩子接管递归 `rm`（偶发 30–60s），
 * 阻塞式清理会让整个文件白等一分钟；临时目录留在 %TEMP% 无害。
 */
afterAll(() => {
  void rm(root, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  caseSeq += 1;
  caseDir = join(root, `case-${caseSeq}`);
  marketDir = join(caseDir, 'market-source');
  await mkdir(marketDir, { recursive: true });
});

describe('市场注册表读写', () => {
  it('文件不存在 → 空注册表，且不算错误（第一次用就是这种）', async () => {
    const { registry, error } = await readMarketRegistry(join(caseDir, 'plugins'));
    expect(registry.markets).toEqual([]);
    expect(error).toBeNull();
  });

  it('文件坏了 → 空注册表 + 原因（不猜出厂市场）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(join(pluginsRoot, 'registry.json'), '{ not json', 'utf8');

    const { registry, error } = await readMarketRegistry(pluginsRoot);
    expect(registry.markets).toEqual([]);
    expect(error).toContain('读取失败');
  });

  it('坏条目被丢掉，其它条目照常可读（一个市场写坏不传染）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, 'registry.json'),
      JSON.stringify({
        version: 1,
        markets: [
          { id: 'good', type: 'directory', location: marketDir },
          { id: '../escape', type: 'directory', location: marketDir },
          { id: 'relative', type: 'directory', location: 'somewhere' },
          { type: 'directory', location: marketDir },
        ],
      }),
      'utf8',
    );

    const { registry } = await readMarketRegistry(pluginsRoot);
    expect(registry.markets.map((item) => item.id)).toEqual(['good']);
  });
});

describe('normalizeMarketEntry', () => {
  it('目录型必须是绝对路径（相对路径会随 cwd 漂移）', () => {
    expect(normalizeMarketEntry({ id: 'm', type: 'directory', location: 'plugins/x' })).toBeNull();
    expect(normalizeMarketEntry({ id: 'm', type: 'directory', location: marketDir })?.location).toBe(
      marketDir,
    );
  });

  it('远程型必须是 http(s) 地址', () => {
    expect(normalizeMarketEntry({ id: 'm', type: 'remote', location: marketDir })).toBeNull();
    expect(normalizeMarketEntry({ id: 'm', type: 'remote', location: 'https://x.test/a.zip' })?.type).toBe(
      'remote',
    );
  });

  it('未知类型与非法 id 一律拒绝', () => {
    expect(normalizeMarketEntry({ id: 'm', type: 'git', location: marketDir })).toBeNull();
    expect(normalizeMarketEntry({ id: '', type: 'directory', location: marketDir })).toBeNull();
    expect(normalizeMarketEntry(null)).toBeNull();
  });

  it('缺省字段收敛成安全值（name 回落 id，时间 null）', () => {
    const entry = normalizeMarketEntry({ id: 'm', type: 'directory', location: marketDir });
    expect(entry).toMatchObject({ name: 'm', isBuiltIn: false, autoUpdate: false, lastSyncAt: null });
  });
});

describe('市场条目的增删', () => {
  it('按 id 幂等覆盖，且按 id 排序落盘', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await upsertMarket(pluginsRoot, market({ id: 'b', name: 'B' }));
    await upsertMarket(pluginsRoot, market({ id: 'a', name: 'A' }));
    await upsertMarket(pluginsRoot, market({ id: 'b', name: 'B2' }));

    const { registry } = await readMarketRegistry(pluginsRoot);
    expect(registry.markets.map((item) => item.id)).toEqual(['a', 'b']);
    expect(registry.markets.find((item) => item.id === 'b')?.name).toBe('B2');
  });

  it('内置市场的来源不可改写（改了等于把「永不联网」换成「会联网」）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await upsertMarket(pluginsRoot, market({ id: 'builtin', isBuiltIn: true }));
    const result = await upsertMarket(
      pluginsRoot,
      market({ id: 'builtin', isBuiltIn: true, location: 'https://evil.test/x.zip', type: 'remote' }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('不可修改');
  });

  it('内置市场不可删除', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await upsertMarket(pluginsRoot, market({ id: 'builtin', isBuiltIn: true }));
    const result = await removeMarket(pluginsRoot, 'builtin');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不可删除');
  });
});

describe('目录型市场同步', () => {
  it('把包按版本归档到 marketplaces/<market>/<name>/<version>/', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.2.0');
    await putPackage(marketDir, 'beta', 'beta', '0.1.0');

    const result = await syncMarket(pluginsRoot, market());
    expect(result.ok).toBe(true);
    expect(result.synced).toBe(2);

    const archived = join(pluginsRoot, MARKETPLACES_DIR, 'demo-market', 'alpha', '1.2.0');
    await expect(stat(join(archived, 'plugin.json'))).resolves.toBeTruthy();
  });

  it('坏包进 skipped，不中断同步', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await mkdir(join(marketDir, 'broken'), { recursive: true });
    await writeFile(join(marketDir, 'broken', 'plugin.json'), '{ bad', 'utf8');

    const result = await syncMarket(pluginsRoot, market());
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(['broken']);
    expect(result.synced).toBe(1);
  });

  it('⭐ 只增不改：已存在的版本不被后来的同步覆盖', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await syncMarket(pluginsRoot, market());
    const archived = join(pluginsRoot, MARKETPLACES_DIR, 'demo-market', 'alpha', '1.0.0', 'plugin.json');
    await writeFile(archived, '{"name":"tampered"}', 'utf8');

    await syncMarket(pluginsRoot, market());
    expect(await readFile(archived, 'utf8')).toBe('{"name":"tampered"}');
  });

  it('⭐ 同步不碰 current 指针（活跃会话不会被换版本）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await syncMarket(pluginsRoot, market());
    await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '1.0.0');

    // 市场刷新：出了 2.0.0
    await putPackage(marketDir, 'alpha-2.0.0', 'alpha', '2.0.0');
    await syncMarket(pluginsRoot, market());

    const pointer = join(pluginsRoot, CACHE_DIR, 'demo-market', 'alpha', CURRENT_POINTER);
    expect(await readFile(pointer, 'utf8')).toBe('1.0.0');
  });

  it('远程型不联网：如实失败，索引保持原样（不表现成「市场是空的」）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    const entry = market({ type: 'remote', location: 'https://x.test/m.zip' });
    const result = await syncMarket(pluginsRoot, entry);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('下载通道');

    const updated = await recordMarketSync(pluginsRoot, entry, result);
    expect(updated.lastError).toContain('下载通道');
    expect(updated.lastSyncAt).toBeNull();
  });

  it('同步成功写 lastSyncAt 并清掉旧错误', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    const entry = market({ lastError: '上次挂了' });
    const result = await syncMarket(pluginsRoot, entry);

    const updated = await recordMarketSync(pluginsRoot, entry, result);
    expect(updated.lastError).toBeNull();
    expect(updated.lastSyncAt).not.toBeNull();
    expect(describeMarketSync(updated)).toContain('已同步');
  });

  it('市场目录读不到 → 明确原因', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    const result = await syncMarket(pluginsRoot, market({ location: join(root, 'nope') }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不可读');
  });
});

describe('从市场安装（materialize + 指针）', () => {
  it('复制成生效副本并写指针', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await syncMarket(pluginsRoot, market());

    const result = await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '1.0.0');
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.0.0');

    const copy = join(pluginsRoot, CACHE_DIR, 'demo-market', 'alpha', '1.0.0');
    await expect(stat(join(copy, 'plugin.json'))).resolves.toBeTruthy();
    expect(await readFile(join(pluginsRoot, CACHE_DIR, 'demo-market', 'alpha', CURRENT_POINTER), 'utf8')).toBe(
      '1.0.0',
    );
  });

  it('切版本只改指针，副本仍在（可回滚）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha-1.0.0', 'alpha', '1.0.0');
    await putPackage(marketDir, 'alpha-2.0.0', 'alpha', '2.0.0');
    await syncMarket(pluginsRoot, market());
    await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '1.0.0');
    await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '2.0.0');

    const versions = await readdir(join(pluginsRoot, CACHE_DIR, 'demo-market', 'alpha'));
    expect(versions.sort()).toEqual(['1.0.0', '2.0.0', CURRENT_POINTER].sort());
    expect(
      await readFile(join(pluginsRoot, CACHE_DIR, 'demo-market', 'alpha', CURRENT_POINTER), 'utf8'),
    ).toBe('2.0.0');
  });

  it('源里没有的版本 → 明确失败并提示先同步', async () => {
    const result = await installFromMarket(join(caseDir, 'plugins'), 'demo-market', 'alpha', '9.9.9');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('先同步市场');
  });

  it('非法名字直接拒绝（防遍历）', async () => {
    const result = await installFromMarket(join(caseDir, 'plugins'), 'demo-market', '../evil', '1.0.0');
    expect(result.ok).toBe(false);
  });
});

describe('缓存回收', () => {
  /**
   * 判定是**纯函数**（不碰磁盘），所以规则能在这里说完。
   *
   * 为什么不测「真的删掉」：本机（以及 CI 上常见的）安全删除钩子会把递归
   * `rm` 接管到回收站流程，单次随机卡 30–60s——为一条断言把整个测试文件的
   * 耗时从秒级抬到分钟级不划算，而且会连累同批的其它磁盘用例超时。
   */
  const deadline = Date.now() - 30 * 86_400_000;

  it('被引用的一律保留（有会话正在用）', () => {
    expect(shouldCollectCopy({ mtimeMs: deadline - 1000, referenced: true, deadlineMs: deadline })).toBe(
      false,
    );
  });

  it('无引用但还新的保留（刚同步下来的很可能马上要用）', () => {
    expect(
      shouldCollectCopy({ mtimeMs: deadline + 1000, referenced: false, deadlineMs: deadline }),
    ).toBe(false);
  });

  it('无引用且过期的才回收', () => {
    expect(shouldCollectCopy({ mtimeMs: deadline - 1, referenced: false, deadlineMs: deadline })).toBe(
      true,
    );
  });

  it('非破坏性集成：两份副本都被引用时一份都不删', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha-1.0.0', 'alpha', '1.0.0');
    await putPackage(marketDir, 'alpha-2.0.0', 'alpha', '2.0.0');
    await syncMarket(pluginsRoot, market());
    await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '1.0.0');
    await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '2.0.0');

    const base = join(pluginsRoot, CACHE_DIR, 'demo-market', 'alpha');
    const { removed, kept } = await collectMarketCache(pluginsRoot, {
      referenced: [join(base, '1.0.0'), join(base, '2.0.0')],
      keepDays: 0,
    });
    expect(removed).toEqual([]);
    expect(kept).toHaveLength(2);
  });

  it('没有 cache 目录时不是错误', async () => {
    const { removed, kept } = await collectMarketCache(join(caseDir, 'plugins'), { referenced: [] });
    expect(removed).toEqual([]);
    expect(kept).toEqual([]);
  });
});

describe('市场索引与展示', () => {
  it('listMarketPackages 读源侧归档（含版本与展示名）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await syncMarket(pluginsRoot, market());

    const index = await listMarketPackages(pluginsRoot, 'demo-market');
    expect(index.packages).toHaveLength(1);
    expect(index.packages[0]).toMatchObject({ name: 'alpha', version: '1.0.0', displayName: 'alpha 展示名' });
  });

  it('目录型离线可用；远程型不是', () => {
    expect(isOfflineCapable(market())).toBe(true);
    expect(isOfflineCapable(market({ type: 'remote', location: 'https://x.test/a.zip' }))).toBe(false);
  });

  it('未同步过的市场显示「尚未同步」', () => {
    expect(describeMarketSync(market())).toBe('尚未同步');
  });
});

/**
 * 可选市场索引与依赖解析（FR-3.13）。
 *
 * 三条判据各自对应一种**会把事情做错的方式**：
 *
 * 1. **无索引 → 与现状逐字相同**（回归）。索引是可选元数据，引入它不该让任何
 *    已存在的市场改行为；
 * 2. **有依赖 → 按拓扑序装**（依赖在前）。顺序错了的后果是「装完了但跑不起来」，
 *    而那种故障在运行期才暴露；
 * 3. **循环依赖 → 明确拒绝 + 打印环**。只说「存在循环」等于让用户自己去翻索引找环。
 */
describe('市场索引解析（纯函数）', () => {
  it('解析 name / source / category / dependencies', () => {
    const index = normalizeMarketplaceIndex({
      name: '官方市场',
      plugins: [
        {
          name: 'welcomemode-design',
          source: 'welcomemode-design-1.0.0',
          category: '主题',
          dependencies: ['mcp-miora', 'ardot'],
        },
      ],
    });
    expect(index).not.toBeNull();
    expect(index?.name).toBe('官方市场');
    expect(index?.plugins[0]).toMatchObject({
      name: 'welcomemode-design',
      source: 'welcomemode-design-1.0.0',
      category: '主题',
      dependencies: ['mcp-miora', 'ardot'],
    });
  });

  it('坏条目被丢掉，其余照常可读（一行笔误不该让整份索引失效）', () => {
    const index = normalizeMarketplaceIndex({
      plugins: [
        { name: 'good' },
        { name: '' },
        { name: '../evil' },
        { source: 'no-name' },
        'not-an-object',
      ],
    });
    expect(index?.plugins.map((entry) => entry.name)).toEqual(['good']);
  });

  it('依赖去重、并滤掉非法项（否则会在排序时变成假的「找不到依赖」）', () => {
    const index = normalizeMarketplaceIndex({
      plugins: [{ name: 'a', dependencies: ['b', 'b', '', 7, '../x', 'c'] }],
    });
    expect(index?.plugins[0].dependencies).toEqual(['b', 'c']);
  });

  it('整体形状不认识才返回 null（plugins 不是数组）', () => {
    expect(normalizeMarketplaceIndex(null)).toBeNull();
    expect(normalizeMarketplaceIndex({ plugins: {} })).toBeNull();
    expect(normalizeMarketplaceIndex({ plugins: [] })).toEqual({ name: null, plugins: [] });
  });
});

describe('pickNewestVersion', () => {
  it('按语义化顺序挑最新，不做字符串比较', () => {
    // 字符串序 `'0.1.9' > '0.1.10'` —— 会用错版本，且没有任何报错
    expect(pickNewestVersion(['0.1.9', '0.1.10'])).toBe('0.1.10');
    expect(pickNewestVersion(['1.0.0', '2.0.0', '1.9.9'])).toBe('2.0.0');
  });

  it('非法 / 不安全的名字跳过；全都不合法时返回 null', () => {
    expect(pickNewestVersion(['../evil', '1.0.0'])).toBe('1.0.0');
    expect(pickNewestVersion(['../evil'])).toBeNull();
    expect(pickNewestVersion([])).toBeNull();
  });
});

describe('resolveInstallOrder（纯函数）', () => {
  const pkg = (name: string, dependencies?: string[]) => ({
    name,
    displayName: name,
    version: '1.0.0',
    description: '',
    ...(dependencies ? { dependencies } : {}),
  });

  it('没有依赖 → 只有目标自己', () => {
    const result = resolveInstallOrder([pkg('a')], 'a');
    expect(result).toEqual({ ok: true, order: ['a'] });
  });

  it('链式依赖 → 依赖在前、目标在后', () => {
    const result = resolveInstallOrder([pkg('a', ['b']), pkg('b', ['c']), pkg('c')], 'a');
    expect(result).toEqual({ ok: true, order: ['c', 'b', 'a'] });
  });

  it('共享依赖只出现一次，且排在使用者之前', () => {
    const result = resolveInstallOrder(
      [pkg('a', ['b', 'c']), pkg('b', ['d']), pkg('c', ['d']), pkg('d')],
      'a',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.filter((name) => name === 'd')).toHaveLength(1);
    expect(result.order.indexOf('d')).toBeLessThan(result.order.indexOf('b'));
    expect(result.order.indexOf('d')).toBeLessThan(result.order.indexOf('c'));
    expect(result.order[result.order.length - 1]).toBe('a');
  });

  it('索引里没有目标 → 按单包装（索引是元数据，不是白名单）', () => {
    // 一份没写全的索引不该让市场里别的包装不上
    const result = resolveInstallOrder([pkg('other')], 'a');
    expect(result).toEqual({ ok: true, order: ['a'] });
  });

  it('依赖在市场里找不到 → 拒绝，并说清是哪个依赖', () => {
    const result = resolveInstallOrder([pkg('a', ['ghost'])], 'a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ghost');
    expect(result.error).toContain('市场');
  });

  it('循环依赖 → 拒绝，并**把环打印出来**', () => {
    const result = resolveInstallOrder([pkg('a', ['b']), pkg('b', ['a'])], 'a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('循环');
    expect(result.error).toContain('a → b → a');
  });

  it('自环也算循环', () => {
    const result = resolveInstallOrder([pkg('a', ['a'])], 'a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('a → a');
  });
});

describe('市场索引：归档与读取', () => {
  it('源里的 marketplace.json 被归档，listMarketPackages 据此补上分类与依赖', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'welcomemode-design-1.0.0', 'welcomemode-design', '1.0.0');
    await putPackage(marketDir, 'mcp-miora-1.0.0', 'mcp-miora', '1.0.0');
    await writeFile(
      join(marketDir, MARKET_INDEX_FILENAME),
      JSON.stringify({
        name: '演示市场',
        plugins: [
          { name: 'welcomemode-design', category: '主题', dependencies: ['mcp-miora'] },
          { name: 'mcp-miora', category: 'MCP' },
        ],
      }),
      'utf8',
    );

    await syncMarket(pluginsRoot, market());

    const { index, error } = await readMarketplaceIndex(pluginsRoot, 'demo-market');
    expect(error).toBeNull();
    expect(index?.name).toBe('演示市场');

    const listed = await listMarketPackages(pluginsRoot, 'demo-market');
    const design = listed.packages.find((entry) => entry.name === 'welcomemode-design');
    expect(design?.category).toBe('主题');
    expect(design?.dependencies).toEqual(['mcp-miora']);
    // 索引文件自己**不是**一个包，也不该进 skipped
    expect(listed.packages.map((entry) => entry.name)).not.toContain(MARKET_INDEX_FILENAME);
    expect(listed.skipped).toEqual([]);
  });

  it('没有索引文件 → 不是错误，包照常可读且元数据为空（回归）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await syncMarket(pluginsRoot, market());

    const { index, error } = await readMarketplaceIndex(pluginsRoot, 'demo-market');
    expect(index).toBeNull();
    expect(error).toBeNull();

    const listed = await listMarketPackages(pluginsRoot, 'demo-market');
    expect(listed.packages).toHaveLength(1);
    expect(listed.packages[0].category).toBeUndefined();
    expect(listed.packages[0].dependencies).toBeUndefined();
  });

  it('索引坏了 → 明确报原因，但**仍然回退目录扫描**（不是装不了）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await writeFile(join(marketDir, MARKET_INDEX_FILENAME), '{ 这不是 JSON', 'utf8');
    await syncMarket(pluginsRoot, market());

    const { index, error } = await readMarketplaceIndex(pluginsRoot, 'demo-market');
    expect(index).toBeNull();
    expect(error).toContain('JSON');

    const listed = await listMarketPackages(pluginsRoot, 'demo-market');
    expect(listed.packages.map((entry) => entry.name)).toEqual(['alpha']);
  });
});

describe('依赖感知的安装', () => {
  async function seedMarket(pluginsRoot: string): Promise<void> {
    await putPackage(marketDir, 'design-1.0.0', 'design', '1.0.0');
    await putPackage(marketDir, 'miora-1.0.0', 'miora', '1.0.0');
    await putPackage(marketDir, 'miora-1.0.1', 'miora', '1.0.1');
    await writeFile(
      join(marketDir, MARKET_INDEX_FILENAME),
      JSON.stringify({
        plugins: [
          { name: 'design', dependencies: ['miora'] },
          { name: 'miora', category: 'MCP' },
        ],
      }),
      'utf8',
    );
    await syncMarket(pluginsRoot, market());
  }

  it('依赖先装、目标后装，两边的 current 指针都拨好', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await seedMarket(pluginsRoot);

    const result = await installFromMarket(pluginsRoot, 'demo-market', 'design', '1.0.0');

    expect(result.ok).toBe(true);
    // 依赖挑的是**最新可用版**（1.0.1），且顺序在目标之前
    expect(result.installed).toEqual(['miora@1.0.1', 'design@1.0.0']);
    expect(await readFile(join(pluginsRoot, CACHE_DIR, 'demo-market', 'miora', CURRENT_POINTER), 'utf8')).toBe('1.0.1');
    expect(await readFile(join(pluginsRoot, CACHE_DIR, 'demo-market', 'design', CURRENT_POINTER), 'utf8')).toBe('1.0.0');
    expect(result.path).toBe(join(pluginsRoot, CACHE_DIR, 'demo-market', 'design', '1.0.0'));
  });

  it('依赖装不上时**目标一个字节都不装**（不留半装现场）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'design-1.0.0', 'design', '1.0.0');
    await writeFile(
      join(marketDir, MARKET_INDEX_FILENAME),
      JSON.stringify({ plugins: [{ name: 'design', dependencies: ['ghost'] }] }),
      'utf8',
    );
    await syncMarket(pluginsRoot, market());

    const result = await installFromMarket(pluginsRoot, 'demo-market', 'design', '1.0.0');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ghost');
    await expect(readdir(join(pluginsRoot, CACHE_DIR, 'demo-market'))).rejects.toThrow();
  });

  it('循环依赖 → 安装被拒，原因里带着环', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'a-1.0.0', 'a', '1.0.0');
    await putPackage(marketDir, 'b-1.0.0', 'b', '1.0.0');
    await writeFile(
      join(marketDir, MARKET_INDEX_FILENAME),
      JSON.stringify({
        plugins: [
          { name: 'a', dependencies: ['b'] },
          { name: 'b', dependencies: ['a'] },
        ],
      }),
      'utf8',
    );
    await syncMarket(pluginsRoot, market());

    const result = await installFromMarket(pluginsRoot, 'demo-market', 'a', '1.0.0');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('循环');
    expect(result.error).toContain('a → b → a');
  });

  it('没有索引市场时行为与现状一致（单包装，installed 只有一项）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await syncMarket(pluginsRoot, market());

    const result = await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '1.0.0');

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual(['alpha@1.0.0']);
  });

  it('索引没提到这个包时也按单包装（索引不全不该变成装不动）', async () => {
    const pluginsRoot = join(caseDir, 'plugins');
    await putPackage(marketDir, 'alpha', 'alpha', '1.0.0');
    await writeFile(
      join(marketDir, MARKET_INDEX_FILENAME),
      JSON.stringify({ plugins: [{ name: 'unrelated' }] }),
      'utf8',
    );
    await syncMarket(pluginsRoot, market());

    const result = await installFromMarket(pluginsRoot, 'demo-market', 'alpha', '1.0.0');

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual(['alpha@1.0.0']);
  });
});
