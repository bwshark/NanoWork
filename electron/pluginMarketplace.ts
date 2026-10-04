/**
 * 市场注册表与版本化缓存（Electron 主进程，FR-3.7 / FR-3.8）。
 *
 * ## 为什么要有「源」和「生效副本」两份目录
 *
 * ```
 * ~/.nanowork/plugins/
 *   marketplaces/<market>/<plugin>/<version>/   源：市场同步下来的内容，**可覆盖**
 *   cache/<market>/<plugin>/<version>/          生效副本：**只增不改**（按需 GC）
 *   cache/<market>/<plugin>/current             指针：当前生效版本（文件内容 = 版本号）
 *   registry.json                               市场注册表
 * ```
 *
 * 分开的唯一理由：**市场刷新不得破坏正在跑的会话**。刷新只往这两处**追加**
 * 新版本、从不就地替换，也不动 `current` 指针；于是「一个长会话跨过若干次市场
 * 刷新」不会半路换掉它依赖的插件定义（环境漂移）。升级 = 显式改写指针，
 * 引擎侧按指针解析（见 `nanobot/agent/plugins.py` 的 `_resolve_cache_copy`）。
 *
 * ## 四个字段为什么必须第一天就在（PRD §12.5.2）
 *
 * `type` / `isBuiltIn` / `autoUpdate` / `lastSyncAt` 是**「能否离线」与「失败怎么办」
 * 的唯一判据**：
 * - `type='directory'` —— 目录型市场**永不联网**（本地一个目录就是全部内容）；
 * - `type='remote'` —— 远程型要联网拉 zip，失败时必须有明确降级（保留上次索引 +
 *   记 `lastError`），不能把「拉不到」显示成「市场是空的」；
 * - `autoUpdate` —— 决定是「启动时顺带刷一次」还是「用户点了才刷」；
 * - `lastSyncAt` —— 「这份索引有多旧」是用户判断要不要手动刷新的唯一依据。
 *
 * ## 本轮不做的事
 *
 * 远程型的**下载通道**未接入（本项目还没有可用的市场服务端）。数据模型、
 * `autoUpdate` 判定与失败降级都在这里，接到真实服务端时只需补 `downloadMarketZip`。
 * 目录型是完整的、可端到端使用的。
 *
 * ## 为什么依赖注入根目录
 *
 * 对齐同目录的其他模块：不 import `electron`，根目录由调用方传入，便于 vitest 覆盖。
 */
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  MarketGcResult,
  MarketIndex,
  MarketInstallResult,
  MarketPackage,
  MarketRegistry,
  MarketSyncResult,
  MarketplaceEntry,
  MarketplaceType,
} from '../src/types/plugin';

// 领域类型声明在 `src/types/plugin.ts`（渲染层与主进程共用一份），这里不重复声明。
// 只用**类型导入**：esbuild 会整段擦除，渲染层代码不会被打进 `main.cjs`。
export type {
  MarketGcResult,
  MarketIndex,
  MarketInstallResult,
  MarketPackage,
  MarketRegistry,
  MarketSyncResult,
  MarketplaceEntry,
  MarketplaceType,
};

/** 注册表文件版本；将来改形状时按它迁移（读不懂就当空注册表，不猜） */
export const MARKET_REGISTRY_VERSION = 1;

/** 目录名（市场 id / 插件名 / 版本号）的合法字符集——**遍历防护**的第一道闸 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MARKETPLACES_DIR = 'marketplaces';
export const CACHE_DIR = 'cache';
export const CURRENT_POINTER = 'current';

/** 空注册表：注册表文件不存在 / 坏了时的起点（**不猜**出厂市场） */
export function emptyMarketRegistry(): MarketRegistry {
  return { version: MARKET_REGISTRY_VERSION, markets: [] };
}

function registryPath(pluginsRoot: string): string {
  return join(pluginsRoot, 'registry.json');
}

/** 目录名是否安全（不含分隔符、不以 `.` 开头）；空串与超长一律拒绝 */
function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && SAFE_SEGMENT.test(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 把一段未知形状收敛成市场条目。
 *
 * 返回 null = 这条不可用（缺 id / 类型不认 / 目录型没给绝对路径）。**坏条目被丢弃
 * 而不是抛错**：一个市场写坏了不该让「其它市场」也读不出来——那会让用户以为
 * 自己什么都没装过。
 */
export function normalizeMarketEntry(raw: unknown): MarketplaceEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const id = asString(entry.id).trim();
  if (!isSafeSegment(id)) return null;
  const type = entry.type === 'remote' ? 'remote' : entry.type === 'directory' ? 'directory' : null;
  if (type === null) return null;
  const location = asString(entry.location).trim();
  // 目录型必须给**绝对路径**：相对路径会随进程 cwd 漂移，而 cwd 在 Electron 里
  // 不保证是同一个目录
  if (type === 'directory' && (!isAbsolute(location) || location === '')) return null;
  if (type === 'remote' && !/^https?:\/\//i.test(location)) return null;
  const lastSyncAt = asString(entry.lastSyncAt).trim();
  const lastError = asString(entry.lastError).trim();
  return {
    id,
    name: asString(entry.name).trim() || id,
    type,
    location,
    isBuiltIn: entry.isBuiltIn === true,
    autoUpdate: entry.autoUpdate === true,
    lastSyncAt: lastSyncAt === '' ? null : lastSyncAt,
    lastError: lastError === '' ? null : lastError,
  };
}

/** 读注册表。文件不存在 / 损坏 → 空注册表（并把原因交给调用方提示） */
export async function readMarketRegistry(
  pluginsRoot: string,
): Promise<{ registry: MarketRegistry; error: string | null }> {
  try {
    const raw = await fs.readFile(registryPath(pluginsRoot), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const markets =
      typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).markets)
        ? ((parsed as Record<string, unknown>).markets as unknown[])
            .map(normalizeMarketEntry)
            .filter((entry): entry is MarketplaceEntry => entry !== null)
        : [];
    return { registry: { version: MARKET_REGISTRY_VERSION, markets }, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { registry: emptyMarketRegistry(), error: null };
    return { registry: emptyMarketRegistry(), error: `市场注册表读取失败：${(err as Error).message}` };
  }
}

/** 写注册表（先建目录；整体覆盖写，条目已在内存里校验过） */
export async function writeMarketRegistry(
  pluginsRoot: string,
  registry: MarketRegistry,
): Promise<void> {
  await fs.mkdir(pluginsRoot, { recursive: true });
  await fs.writeFile(
    registryPath(pluginsRoot),
    JSON.stringify({ version: MARKET_REGISTRY_VERSION, markets: registry.markets }, null, 2),
    'utf8',
  );
}

/**
 * 新增 / 更新一个市场条目（按 id 幂等覆盖）。
 *
 * 内置市场（`isBuiltIn`）**不可改写来源**：那是随应用分发的，改它的 location
 * 等于把「永不联网」的保证悄悄换成「会联网」。
 */
export async function upsertMarket(
  pluginsRoot: string,
  entry: MarketplaceEntry,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeMarketEntry(entry);
  if (normalized === null) {
    return { ok: false, error: '市场条目不合法（缺少 id / 类型不认 / 路径不是绝对路径）' };
  }
  const { registry } = await readMarketRegistry(pluginsRoot);
  const existing = registry.markets.find((item) => item.id === normalized.id);
  if (existing?.isBuiltIn && existing.location !== normalized.location) {
    return { ok: false, error: `内置市场「${existing.id}」的来源不可修改` };
  }
  const merged: MarketplaceEntry = existing?.isBuiltIn
    ? { ...normalized, isBuiltIn: true, location: existing.location }
    : normalized;
  await writeMarketRegistry(pluginsRoot, {
    version: MARKET_REGISTRY_VERSION,
    markets: [...registry.markets.filter((item) => item.id !== merged.id), merged].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  });
  return { ok: true };
}

/** 删除一个市场（内置市场拒绝删除） */
export async function removeMarket(
  pluginsRoot: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const { registry } = await readMarketRegistry(pluginsRoot);
  const target = registry.markets.find((item) => item.id === id);
  if (!target) return { ok: false, error: `市场「${id}」不存在` };
  if (target.isBuiltIn) return { ok: false, error: `内置市场「${id}」不可删除` };
  await writeMarketRegistry(pluginsRoot, {
    version: MARKET_REGISTRY_VERSION,
    markets: registry.markets.filter((item) => item.id !== id),
  });
  return { ok: true };
}

/** 递归复制目录（目标已存在时**不覆盖**——「只增不改」的另一半） */
async function copyTree(source: string, target: string, overwrite: boolean): Promise<boolean> {
  try {
    await fs.access(target);
    if (!overwrite) return false; // 已存在：原样保留（内容不同也不动，见「只增不改」）
  } catch {
    // 不存在 → 复制
  }
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, overwrite);
    else if (entry.isFile()) await fs.copyFile(from, to);
    // 符号链接等其它类型跳过：包里出现它们本身就是异常
  }
  return true;
}

/** 读一个包根的清单（兼容 PRD 的 `.nanowork-plugin/plugin.json` 回退） */
async function readManifest(root: string): Promise<{ name: string; version: string; displayName: string; description: string } | null> {
  for (const rel of ['plugin.json', '.nanowork-plugin/plugin.json']) {
    try {
      const raw = await fs.readFile(join(root, rel), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const name = asString(record.name).trim();
      if (!isSafeSegment(name)) return null;
      const ext = record.extensions;
      const nanobot =
        typeof ext === 'object' && ext !== null
          ? ((ext as Record<string, unknown>)['dev.nanobot'] as Record<string, unknown> | undefined)
          : undefined;
      const version = asString(record.version).trim() || '0.0.0';
      return {
        name,
        version,
        displayName: (nanobot && asString(nanobot.displayName).trim()) || name,
        description: asString(record.description).trim(),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return null;
}

/** `marketplaces/<market>/` 下已归档的包（源侧索引） */
export async function listMarketPackages(
  pluginsRoot: string,
  market: string,
): Promise<MarketIndex> {
  const result: MarketIndex = { market, packages: [], skipped: [] };
  if (!isSafeSegment(market)) return result;
  const marketRoot = join(pluginsRoot, MARKETPLACES_DIR, market);
  let pluginDirs: string[];
  try {
    pluginDirs = await fs.readdir(marketRoot);
  } catch {
    return result;
  }
  for (const pluginDir of pluginDirs) {
    if (!isSafeSegment(pluginDir)) continue;
    const pluginRoot = join(marketRoot, pluginDir);
    let versions: string[];
    try {
      versions = await fs.readdir(pluginRoot);
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!isSafeSegment(version)) continue;
      const manifest = await readManifest(join(pluginRoot, version));
      if (manifest === null) {
        result.skipped.push(`${pluginDir}/${version}`);
        continue;
      }
      result.packages.push({
        name: manifest.name,
        displayName: manifest.displayName,
        version,
        description: manifest.description,
      });
    }
  }
  result.packages.sort(
    (a, b) => a.name.localeCompare(b.name) || b.version.localeCompare(a.version),
  );
  return result;
}

/**
 * 同步一个市场。
 *
 * 目录型：扫 `location` 下的子目录，把每个包**按版本归档**到
 * `marketplaces/<market>/<name>/<version>/`（已存在则跳过——源侧也只增不改）。
 *
 * 远程型：本轮不联网（还没接入下载通道），**如实失败**并记 `lastError`；
 * 索引保持上次的样子，绝不因为拉不到就把索引清空。
 */
export async function syncMarket(
  pluginsRoot: string,
  market: MarketplaceEntry,
): Promise<MarketSyncResult> {
  if (!isSafeSegment(market.id)) {
    return { ok: false, market: market.id, synced: 0, skipped: [], error: '市场 id 不合法' };
  }
  if (market.type === 'remote') {
    return {
      ok: false,
      market: market.id,
      synced: 0,
      skipped: [],
      error: '远程市场的下载通道尚未接入（当前只支持目录型市场）',
    };
  }
  const skipped: string[] = [];
  let synced = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(market.location);
  } catch (err) {
    return {
      ok: false,
      market: market.id,
      synced: 0,
      skipped,
      error: `市场目录不可读：${(err as Error).message}`,
    };
  }
  for (const entry of entries) {
    if (!isSafeSegment(entry)) continue;
    const source = join(market.location, entry);
    const manifest = await readManifest(source);
    if (manifest === null) {
      skipped.push(entry);
      continue;
    }
    if (!isSafeSegment(manifest.version)) {
      skipped.push(entry);
      continue;
    }
    const target = join(pluginsRoot, MARKETPLACES_DIR, market.id, manifest.name, manifest.version);
    // 源侧也「只增不改」：同一个版本在磁盘上已经存在就原样留着，
    // 否则「改了包内容却沿用旧副本」会变成一个查不出来的不一致
    await copyTree(source, target, false);
    synced += 1;
  }
  return { ok: true, market: market.id, synced, skipped };
}

/** 同步后回写 `lastSyncAt` / `lastError`（成功清错、失败清时间） */
export async function recordMarketSync(
  pluginsRoot: string,
  market: MarketplaceEntry,
  result: MarketSyncResult,
): Promise<MarketplaceEntry> {
  const updated: MarketplaceEntry = result.ok
    ? { ...market, lastSyncAt: new Date().toISOString(), lastError: null }
    : { ...market, lastError: result.error ?? '同步失败' };
  const { registry } = await readMarketRegistry(pluginsRoot);
  await writeMarketRegistry(pluginsRoot, {
    version: MARKET_REGISTRY_VERSION,
    markets: [...registry.markets.filter((item) => item.id !== updated.id), updated].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  });
  return updated;
}

/**
 * 从市场安装（= 把一个版本 materialize 成生效副本并拨指针）。
 *
 * ⚠️ 指针**只在安装/切换版本时改写**，市场同步不会动它——这条是
 * 「刷新不破坏活跃现场」的另一半。
 */
export async function installFromMarket(
  pluginsRoot: string,
  market: string,
  name: string,
  version: string,
): Promise<MarketInstallResult> {
  const failure = (error: string): MarketInstallResult => ({
    ok: false,
    market,
    name,
    version: '',
    path: '',
    error,
  });
  if (!isSafeSegment(market) || !isSafeSegment(name) || !isSafeSegment(version)) {
    return failure('市场 / 插件名 / 版本号不合法');
  }
  const source = join(pluginsRoot, MARKETPLACES_DIR, market, name, version);
  try {
    await fs.access(source);
  } catch {
    return failure(`市场「${market}」里没有 ${name}@${version}（先同步市场）`);
  }
  const target = join(pluginsRoot, CACHE_DIR, market, name, version);
  await copyTree(source, target, false);
  // 指针写**版本字符串**（不是符号链接）：Windows 上建目录符号链接要么需要
  // 管理员、要么需要开发者模式，写文件在任何机器上都是同一条路径。
  await fs.mkdir(join(pluginsRoot, CACHE_DIR, market, name), { recursive: true });
  await fs.writeFile(join(pluginsRoot, CACHE_DIR, market, name, CURRENT_POINTER), version, 'utf8');
  return { ok: true, market, name, version, path: target };
}

/**
 * 一份副本该不该被回收（**纯判定**，不做 IO）。
 *
 * 抽出来的理由不只是「好测」：回收规则是**会让人丢东西**的那类逻辑，
 * 判定与删除分开，才能在不建真实目录的前提下把规则说清楚（见对应单测）。
 */
export function shouldCollectCopy(input: {
  mtimeMs: number;
  referenced: boolean;
  deadlineMs: number;
}): boolean {
  // 被引用的一律保留：引用集是「有会话正在用它」的唯一证据
  if (input.referenced) return false;
  // 还新的保留：刚同步下来的副本很可能马上要用，回收它只会让人重装一遍
  return input.mtimeMs <= input.deadlineMs;
}

/**
 * 回收无引用的旧副本。
 *
 * `referenced` 由调用方给出（活跃会话的版本引用集 + 当前指针指向的版本）：
 * 主进程不知道哪些会话在跑，把这份知识硬塞进来反而是错的。
 */
export async function collectMarketCache(
  pluginsRoot: string,
  options: { referenced: readonly string[]; keepDays?: number },
): Promise<{ removed: string[]; kept: string[] }> {
  const referenced = new Set(options.referenced.map((item) => resolve(item)));
  const keepDays = Math.max(0, options.keepDays ?? 30);
  const deadline = Date.now() - keepDays * 86_400_000;
  const removed: string[] = [];
  const kept: string[] = [];
  const cacheRoot = join(pluginsRoot, CACHE_DIR);
  let markets: string[];
  try {
    markets = await fs.readdir(cacheRoot);
  } catch {
    return { removed, kept };
  }
  for (const market of markets) {
    if (!isSafeSegment(market)) continue;
    let plugins: string[];
    try {
      plugins = await fs.readdir(join(cacheRoot, market));
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (!isSafeSegment(plugin)) continue;
      const pluginRoot = join(cacheRoot, market, plugin);
      let versions: string[];
      try {
        versions = await fs.readdir(pluginRoot);
      } catch {
        continue;
      }
      for (const version of versions) {
        if (!isSafeSegment(version)) continue;
        // ⚠️ `current` 指针就躺在版本目录的**同一层**：不过滤掉它，GC 会把指针
        // 当成一个「版本」删掉，于是这个插件在界面上凭空消失（副本还在，
        // 但引擎找不到指针 → 未安装）。同理只认目录。
        if (version === CURRENT_POINTER) continue;
        const copy = join(pluginRoot, version);
        const abs = resolve(copy);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        if (!shouldCollectCopy({ mtimeMs: stat.mtimeMs, referenced: referenced.has(abs), deadlineMs: deadline })) {
          kept.push(copy);
          continue;
        }
        await fs.rm(abs, { recursive: true, force: true });
        removed.push(copy);
      }
    }
  }
  return { removed, kept };
}

/** 一个市场是否属于「可以离线使用」的那一类（供界面展示徽标） */
export function isOfflineCapable(market: MarketplaceEntry): boolean {
  return market.type === 'directory' || market.isBuiltIn;
}

/** 给界面用的市场状态文案（离线可用 / 需联网 / 上次同步） */
export function describeMarketSync(market: MarketplaceEntry): string {
  if (market.lastError) return `上次同步失败：${market.lastError}`;
  if (market.lastSyncAt === null) return '尚未同步';
  return `已同步 ${market.lastSyncAt.slice(0, 16).replace('T', ' ')}`;
}

/** 包目录名（用于界面提示「装在哪」） */
export function marketSegment(value: string): string {
  return basename(value.replace(/[\\/]+$/, '')).split(sep)[0];
}
