/**
 * 扩展包格式与扫描（Electron 主进程）。
 *
 * 对齐 WorkBuddy `resources/extensions/<id>/extension.json` 的声明面，但**只保留
 * 本项目真的会执行的那几个字段**（见 `src/types/extension.ts` 的差异说明）。
 *
 * ## 为什么解析要写成纯函数
 *
 * 清单来自用户目录，是**不可信输入**：`id` 可能带 `../`、`url` 可能写 `javascript:`、
 * `service.entry` 可能指向包外。这些判断一旦藏进"扫描时顺手做"，就只能靠真机
 * 撞出来。所以 `parseExtensionManifest` 只吃字符串、只吐结论，测试可以逐条打。
 *
 * ## 三条硬规则
 *
 * 1. **`id` 必须等于目录名**。它同时是协议 URL 的 host 与 `~/.nanowork/extensions`
 *    下的目录名；两者不一致时，"清单说自己是 A、实际是 B"会让缓存与菜单互相打架。
 * 2. **所有包内路径都要过包含性检查**（`resolveInside`）。这一层是遍历防护，
 *    别指望调用方传进来的名字是干净的（同 `pluginPackage.ts` 的既有纪律）。
 * 3. **URL 只认"包内相对路径"与 `http(s)`**。`file:` 会绕过协议的目录约束，
 *    `javascript:` / `data:` 直接在扩展的源里执行脚本。
 */
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type {
  ExtensionManifest,
  ExtensionInstallResult,
  ExtensionScanResult,
  ExtensionSource,
  ExtensionUiEntry,
  InstalledExtension,
} from '../src/types/extension';
import { EXTENSION_ID_RE } from '../src/types/extension';
import { isExtensionHttpUrl, toExtensionUrl, EXTENSION_SCHEME } from '../src/lib/extension/extensionUrl';

export type {
  ExtensionInstallResult,
  ExtensionManifest,
  ExtensionScanResult,
  InstalledExtension,
} from '../src/types/extension';

// 地址换算与渲染层共用同一份实现（放在 `src/lib` 是因为 `src/` 不能 import `electron/`）
export { toExtensionUrl };

/** 清单文件名（固定；不做多前缀兼容——扩展是本项目自有格式） */
export const EXTENSION_MANIFEST_FILE = 'extension.json';

/** 单个清单的大小上限：扩展清单是配置，不是数据 */
const MAX_MANIFEST_BYTES = 256 * 1024;

/** 相对路径必须以 .html 结尾（入口）或 .svg/.png 等（图标），这里只校验入口 */
function isHttpUrl(value: string): boolean {
  return isExtensionHttpUrl(value);
}

/**
 * 判断 `target` 是否在 `root` 之内。
 *
 * 用 `relative` 而不是字符串前缀：`/a/bc` 以 `/a/b` 开头但不在其内，
 * 前缀比较会把这种路径判成"安全"。
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 把包内相对路径解析成绝对路径；越界或非法时返回 `null`。
 *
 * 三层判断，顺序不能换：
 *
 * 1. **绝对路径直接拒**；
 * 2. **含 `:` 的一律拒**。Windows 上 `C:../evil.cjs` 的 `isAbsolute` 是 **false**
 *    （它是"盘符相对路径"），`normalize` 后也不以 `../` 开头，但 `resolve` 会把它
 *    解到 `C:\ext\evil.cjs` —— 也就是说前两层判断都会放行。实测值：
 *    `normalize('C:../evil.cjs') === 'C:..\\evil.cjs'`、`resolve(root, …) === 'C:\\ext\\evil.cjs'`。
 *    这条规则同时挡掉 NTFS 的备用数据流语法（`file.txt:stream`）。
 * 3. **规范化后以 `..` 开头的拒**（快速路径），最后再用 `isInside` 兜一次。
 *
 * ⚠️ `isInside` 这一层在**已知输入**下不会单独触发（前两层已经拦干净），保留它是因为
 * 符号链接与未来的平台差异会让 `resolve` 的结果偏离字符串推断。不要因为它"没有被
 * 单测直接证伪"就删掉 —— 那是把纵深防御当成死代码。
 */
export function resolveInside(root: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.trim() === '') return null;
  const raw = relPath.trim();
  if (isAbsolute(raw)) return null;
  // 见上：Windows 的盘符相对路径与 NTFS ADS 都长这样
  if (raw.includes(':')) return null;
  const normalized = normalize(raw).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized === '..') return null;
  const target = resolve(root, normalized);
  if (!isInside(root, target)) return null;
  return target;
}

/** 校验 UI 入口：包内相对路径（.html）或 http(s) */
function parseUiEntry(raw: unknown, issues: string[]): ExtensionUiEntry | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const title = typeof src.title === 'string' ? src.title.trim() : '';
  const url = typeof src.url === 'string' ? src.url.trim() : '';
  if (!url) {
    issues.push('ui.entry 缺少 url');
    return undefined;
  }
  if (!isHttpUrl(url) && !/\.html?$/i.test(url)) {
    issues.push(`ui.entry.url 必须是 .html 相对路径或 http(s) 地址：「${url}」`);
    return undefined;
  }
  const icon = typeof src.icon === 'string' ? src.icon.trim() : undefined;
  return {
    title: title || '扩展',
    ...(icon ? { icon } : {}),
    url,
    keepAlive: src.keepAlive === true,
  };
}

/**
 * 解析清单。
 *
 * `dirName` 必须传：`id` 要与它一致，否则这份包会被判为无效（返回 `null`）。
 */
export function parseExtensionManifest(
  rawText: string,
  options: { dirName: string; source: ExtensionSource },
): { manifest: ExtensionManifest | null; issues: string[] } {
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { manifest: null, issues: ['extension.json 不是合法 JSON'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { manifest: null, issues: ['extension.json 必须是一个对象'] };
  }
  const src = parsed as Record<string, unknown>;

  const id = typeof src.id === 'string' ? src.id.trim() : '';
  if (!EXTENSION_ID_RE.test(id)) {
    return { manifest: null, issues: [`id 不合规（要求小写字母数字与连字符）：「${id}」`] };
  }
  if (id !== options.dirName) {
    return {
      manifest: null,
      issues: [`id「${id}」与目录名「${options.dirName}」不一致（id 同时是协议 host，必须一致）`],
    };
  }

  const uiRaw = src.ui && typeof src.ui === 'object' ? (src.ui as Record<string, unknown>) : null;
  const entry = uiRaw ? parseUiEntry(uiRaw.entry, issues) : undefined;

  const previewsRaw = Array.isArray(uiRaw?.artifactPreviews) ? uiRaw?.artifactPreviews : [];
  const artifactPreviews = previewsRaw
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const p = item as Record<string, unknown>;
      const pid = typeof p.id === 'string' ? p.id.trim() : '';
      const label = typeof p.label === 'string' ? p.label.trim() : pid;
      const url = typeof p.url === 'string' ? p.url.trim() : '';
      const match = p.match && typeof p.match === 'object' ? (p.match as Record<string, unknown>) : null;
      const bizType = match && typeof match.bizType === 'string' ? match.bizType.trim() : '';
      if (!pid || !url || !bizType) {
        issues.push(`artifactPreviews 条目缺少 id/url/match.bizType，已跳过`);
        return null;
      }
      if (!isHttpUrl(url) && !/\.html?$/i.test(url)) {
        issues.push(`artifactPreviews「${pid}」的 url 不合法，已跳过`);
        return null;
      }
      return { id: pid, label: label || pid, match: { bizType }, url };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const settingsRaw = Array.isArray(uiRaw?.settings) ? uiRaw?.settings : [];
  const settings = settingsRaw
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const s = item as Record<string, unknown>;
      const sid = typeof s.id === 'string' ? s.id.trim() : '';
      const target = typeof s.target === 'string' ? s.target.trim() : '';
      if (!sid || !target) return null;
      return {
        id: sid,
        label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : sid,
        target,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  let service: ExtensionManifest['service'];
  if (src.service !== undefined) {
    const s = src.service as Record<string, unknown> | null;
    const entryPath = s && typeof s.entry === 'string' ? s.entry.trim() : '';
    if (!s || !entryPath) {
      issues.push('service 缺少 entry，已忽略该服务声明');
    } else if (s.process !== 'fork') {
      // 其它进程模型（spawn / worker）本轮不做：fork 才能与宿主共享 node 版本，
      // 也才有"同一个 runtime 里的 IPC"这条后续可能用得上的路。
      issues.push(`service.process 只支持 "fork"，收到「${String(s.process)}」，已忽略`);
    } else if (!/\.(c|m)?js$/i.test(entryPath)) {
      issues.push(`service.entry 必须是 .js/.cjs/.mjs：「${entryPath}」，已忽略`);
    } else {
      const args = Array.isArray(s.args)
        ? s.args.filter((a): a is string => typeof a === 'string')
        : [];
      service = { entry: entryPath, process: 'fork', ...(args.length ? { args } : {}) };
    }
  }

  const manifest: ExtensionManifest = {
    id,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim() : id,
    version: typeof src.version === 'string' && src.version.trim() ? src.version.trim() : '0.0.0',
    description: typeof src.description === 'string' ? src.description.trim() : '',
    source: options.source,
    ...(entry || artifactPreviews.length || settings.length
      ? {
          ui: {
            ...(entry ? { entry } : {}),
            ...(artifactPreviews.length ? { artifactPreviews } : {}),
            ...(settings.length ? { settings } : {}),
          },
        }
      : {}),
    ...(service ? { service } : {}),
    permissions: Array.isArray(src.permissions)
      ? src.permissions.filter((p): p is string => typeof p === 'string')
      : [],
  };

  return { manifest, issues };
}

/**
 * 把清单里的 url 变成 iframe 真正能用的 src。
 *
 * 实现已抽到 `src/lib/extension/extensionUrl.ts`（渲染层也要用同一份，而
 * `src/` 不能 import `electron/`）。这里保留同名导出，避免调用点写法分裂。
 */

/** 读一个扩展目录；清单缺失或坏掉时返回 `{ extension: null, issues }` */
export async function readExtension(
  extensionsRoot: string,
  dirName: string,
  source: ExtensionSource,
): Promise<{ extension: InstalledExtension | null; issues: string[] }> {
  const root = join(extensionsRoot, dirName);
  const manifestPath = join(root, EXTENSION_MANIFEST_FILE);
  try {
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile()) {
      return { extension: null, issues: [`${dirName} 下没有 ${EXTENSION_MANIFEST_FILE}`] };
    }
    if (stat.size > MAX_MANIFEST_BYTES) {
      return { extension: null, issues: [`${dirName} 的清单超过 ${MAX_MANIFEST_BYTES} 字节`] };
    }
    const text = await fs.readFile(manifestPath, 'utf8');
    const { manifest, issues } = parseExtensionManifest(text, { dirName, source });
    if (!manifest) return { extension: null, issues };
    return { extension: { manifest, root, issues }, issues };
  } catch {
    return { extension: null, issues: [`${dirName} 读取失败`] };
  }
}

/**
 * 扫描扩展根目录。
 *
 * 一个坏包不影响其余（进 `skipped` 并带上原因）——否则"某个扩展写坏了清单"
 * 会表现成"所有扩展都不见了"，用户会去删对的目录。
 */
export async function scanExtensions(extensionsRoot: string): Promise<ExtensionScanResult> {
  const skipped: string[] = [];
  const extensions: InstalledExtension[] = [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return {
      extensions: [],
      skipped: [],
      extensionsRoot,
      error: `扩展目录不存在或不可读：${extensionsRoot}`,
    };
  }

  /**
   * 误装诊断：`extension.json` 直接躺在根目录。
   *
   * 这是**最常见的一种装错**——复制时用了 `cp -r pkg/* dest/` 而不是
   * `cp -r pkg dest/`。扫描器只遍历子目录，于是"一个扩展都看不见"，
   * 而目录里明明有文件。不说清楚的话，用户只会以为功能没做。
   */
  const strayManifest = entries.some((e) => e.isFile() && e.name === EXTENSION_MANIFEST_FILE);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const { extension } = await readExtension(extensionsRoot, entry.name, 'user');
    if (extension) extensions.push(extension);
    else skipped.push(entry.name);
  }

  extensions.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return {
    extensions,
    skipped: skipped.sort((a, b) => a.localeCompare(b)),
    extensionsRoot,
    ...(strayManifest
      ? {
          hint:
            `扩展目录根部有一份 ${EXTENSION_MANIFEST_FILE}，但扩展必须是**子目录**：` +
            `正确结构是 extensions/hello-world/${EXTENSION_MANIFEST_FILE}。` +
            '看起来是把包内容直接解到了根目录（应复制整个目录，而不是目录里的文件）。',
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 安装（把来源目录整体复制成 extensions/<id>）
// ---------------------------------------------------------------------------

/**
 * 从一个目录安装扩展。
 *
 * 顺序刻意是"**先全部校验、再落盘**"（同 `installPluginPackage`）：清单非法或
 * id 与目录名不一致时，磁盘上不该留下半个包。中途失败的残留比直接失败更难排查。
 *
 * ⚠️ `id` 取**清单里的值**而不是来源目录名：两者不一致时按清单为准，
 * 落点目录名 = id（协议 host 必须与目录名同一份事实）。目录名与 id 不一致的包
 * 在这里**不拒绝**——安装是我们自己做的复制，改名是安全的；而扫描侧仍要求一致，
 * 因为那时无法判断"谁对"。
 */
export async function installExtensionPackage(options: {
  sourceDir: string;
  extensionsRoot: string;
  overwrite?: boolean;
}): Promise<ExtensionInstallResult> {
  const { sourceDir, extensionsRoot, overwrite = false } = options;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(sourceDir);
  } catch {
    return { ok: false, error: `来源目录不存在：${sourceDir}`, errorKind: 'source-missing' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `来源不是目录：${sourceDir}`, errorKind: 'source-missing' };
  }

  // 来源在扩展根之内 = 把自己复制到自己里面（无限递归）或原地覆盖
  if (isInside(extensionsRoot, sourceDir)) {
    return {
      ok: false,
      error: '来源目录已在扩展目录内，无需再次安装（直接点「重新扫描」即可）',
      errorKind: 'escape',
    };
  }

  const manifestPath = join(sourceDir, EXTENSION_MANIFEST_FILE);
  let manifestText: string;
  try {
    manifestText = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return {
      ok: false,
      error: `来源目录里没有 ${EXTENSION_MANIFEST_FILE}（选中包含清单的那一层目录）`,
      errorKind: 'manifest-invalid',
    };
  }

  // 用清单里的 id 做落点目录名；表单上允许与来源目录名不同
  const parsed = JSON.parse(manifestText) as Record<string, unknown>;
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  const { manifest, issues } = parseExtensionManifest(manifestText, {
    dirName: id,
    source: 'user',
  });
  if (!manifest) {
    return {
      ok: false,
      error: issues[0] ?? '清单不符合规范',
      errorKind: 'manifest-invalid',
    };
  }

  const targetRoot = join(extensionsRoot, manifest.id);
  if (await pathExists(targetRoot)) {
    if (!overwrite) {
      return {
        ok: false,
        error: `扩展「${manifest.id}」已安装（勾选覆盖后重试）`,
        errorKind: 'already-installed',
      };
    }
    try {
      await fs.rm(targetRoot, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        error: `无法覆盖旧版本：${err instanceof Error ? err.message : String(err)}`,
        errorKind: 'io',
      };
    }
  }

  try {
    await fs.mkdir(extensionsRoot, { recursive: true });
    // `cp` 而不是手写递归：符号链接、权限位、空目录这些边界不用自己维护
    await fs.cp(sourceDir, targetRoot, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `复制失败：${err instanceof Error ? err.message : String(err)}`,
      errorKind: 'io',
    };
  }

  return { ok: true, id: manifest.id, root: targetRoot };
}

/** 路径是否存在（不抛错） */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 iframe 请求的 URI 到包内文件。
 *
 * `nanowork-ext://<id>/<path>` 里：
 * - host = 扩展 id（**必须先在扫描结果里存在**，不按目录名猜）；
 * - pathname = 包内相对路径。
 *
 * 返回 `null` 表示越界 / 不存在扩展 / 非法路径 —— 调用方一律 404，不回显原因
 * （回显会把"这台机器上装了哪些扩展"暴露给任意页面）。
 */
export function resolveExtensionRequest(
  uri: string,
  knownRoots: Map<string, string>,
): { filePath: string; extId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${EXTENSION_SCHEME}:`) return null;
  const extId = parsed.hostname;
  const root = knownRoots.get(extId);
  if (!root) return null;
  const relPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (!relPath) return null;
  const target = resolveInside(root, relPath);
  if (!target) return null;
  return { filePath: target, extId };
}

/** 扩展目录名（= id）从路径反推（安装/卸载时用） */
export function extensionDirName(root: string): string {
  return basename(root).replace(new RegExp(`${sep}$`), '');
}
