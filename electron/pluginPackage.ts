/**
 * Plugin 包格式与生命周期（Electron 主进程）。
 *
 * ## 它负责什么，不负责什么
 *
 * 负责：**清单解析、资源盘点、安装 / 卸载、版本比较**——也就是"磁盘上这个包
 * 长什么样、能不能装、装完有什么"。
 *
 * 不负责：**启用状态**。那是引擎的权威（指纹绑定的激活标记 + `/v1/plugins`
 * 接口），本模块刻意不去算哈希、也不存一份自己的真相。客户端在 settings.json
 * 里存的是**用户意图**（`enabledPlugins`），与引擎的"实际激活"不是一回事，
 * 两者不一致时由上层显式提示，不在这里悄悄对齐。
 *
 * ## 一份清单，两个读者（为什么不再造一套 schema）
 *
 * PRD §12.2 写的是 `.nanowork-plugin/plugin.json`，而引擎已有一套
 * agent-plugins.org 规范的包（包根 `plugin.json`）。再造一套独立 schema
 * 会让同一个包出现两份互相矛盾的清单。
 *
 * 所以这里是"**一份清单、两个读者**"：包根 `plugin.json` 同时满足两边——
 * 引擎读它认得的子集（`$schema` / `name` / `description` /
 * `extensions.dev.nanobot.*`），本模块读扩展字段（`version` / `category` /
 * `main` / `permissions` / `engines`）。位置仍然兼容 PRD 写的
 * `.nanowork-plugin/plugin.json` 作为回退（顺序即优先级，与引擎侧
 * `_PLUGIN_MANIFEST_RELPATHS` 完全一致）。
 *
 * ## 为什么依赖注入根目录
 *
 * 对齐 `electron/credentialVault.ts` / `electron/storageRoutes.ts`：不 import
 * `electron`，根目录由调用方传入，于是可以被 vitest 直接覆盖。
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeDelete } from './safeDelete';
import type {
  InstalledPlugin,
  PluginInstallResult,
  PluginManifest,
  PluginResourceGroup,
  PluginResourceId,
} from '../src/types/plugin';

// 领域类型声明在 `src/types/plugin.ts`（渲染层与主进程共用一份），这里不重复声明。
// 只用**类型导入**：esbuild 会整段擦除，渲染层代码不会被打进 `main.cjs`。
export type {
  InstalledPlugin,
  PluginInstallResult,
  PluginManifest,
  PluginResourceGroup,
  PluginResourceId,
};

/** 包根清单候选（顺序即优先级，与引擎 `_PLUGIN_MANIFEST_RELPATHS` 一致） */
export const PLUGIN_MANIFEST_RELPATHS = ['plugin.json', '.nanowork-plugin/plugin.json'] as const;

/** MCP 组件候选（与引擎 `_PLUGIN_MCP_RELPATHS` 一致） */
export const PLUGIN_MCP_RELPATHS = ['mcp.json', 'mcp/mcp.json'] as const;

/** agent-plugins.org 清单 schema（引擎只认这一个） */
export const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/**
 * 插件名规则（与引擎 `_PLUGIN_NAME` 逐字一致）。
 *
 * 特别禁止 `--` 与 `..`：引擎用 `--` 拼多 server 命名空间
 * （`<plugin>--<server>`），放行 `--` 会让命名空间不可解析。
 */
const PLUGIN_NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MAX_PLUGIN_NAME_LENGTH = 64;
/** 与引擎 `_MAX_LOGO_BYTES` 一致 */
const MAX_LOGO_BYTES = 256 * 1024;
/** 单个资源目录/分组的条目上限：只为展示，没必要为病态包耗内存 */
const MAX_INVENTORY_ENTRIES = 500;

/**
 * 安装来源。
 *
 * 对应 `settings.enabledPlugins` 里 `<name>@<marketplace>` 的语义：
 * 安装动作由主进程完成（要写文件系统），引擎只管启停。
 */
export interface InstallPluginOptions {
  /** 解压/复制源目录 */
  sourceDir: string;
  /** 插件根目录（`~/.nanowork/plugins`） */
  pluginsRoot: string;
  /** 已安装时是否覆盖（升级场景） */
  overwrite?: boolean;
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 把 `candidate` 规约到 `root` 之内；越界返回 `null`。
 *
 * 用 `realpath` 而不是纯字符串前缀比较，是为了挡住**符号链接**：
 * 包内一个指向外部的 symlink 能让"看起来在包内"的路径实际写到别处。
 * 目标不存在时退回 `resolve`（安装前源目录校验需要这条）。
 */
async function containPath(candidate: string, root: string): Promise<string | null> {
  const realRoot = await realpathOrResolve(root);
  const realCandidate = await realpathOrResolve(candidate);
  if (realCandidate === realRoot) return realCandidate;
  const rel = relative(realRoot, realCandidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return realCandidate;
}

async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return resolve(target);
  }
}

// ---------------------------------------------------------------------------
// 清单解析
// ---------------------------------------------------------------------------

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 读取第一个**存在**的清单文件（顺序即优先级）。
 *
 * 语义与引擎 `_read_first_object` 逐字对齐：**先判存在再解析**——
 * 高优先级位置存在但内容坏，表现为**明确的失败**（返回 `null`），
 * 而不是悄悄回退到低优先级位置；回退会让一份坏清单被另一份好清单掩盖。
 * 只有"文件不存在"才继续看下一个候选。
 */
async function readManifestPayload(
  root: string,
): Promise<{ payload: Record<string, unknown>; relPath: string } | null> {
  for (const relPath of PLUGIN_MANIFEST_RELPATHS) {
    const candidate = join(root, relPath);
    const contained = await containPath(candidate, root);
    if (contained === null || !(await isFile(contained))) continue;
    try {
      const payload = asRecord(JSON.parse(await fs.readFile(contained, 'utf8')));
      return Object.keys(payload).length > 0 ? { payload, relPath } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 解析并校验图标：只认 `./` 相对路径、限大小、查魔数。 */
async function resolveLogo(root: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value.startsWith('./')) return undefined;
  const target = await containPath(join(root, value.slice(2)), root);
  if (target === null) return undefined;
  try {
    const data = await fs.readFile(target);
    if (data.byteLength > MAX_LOGO_BYTES) return undefined;
    const suffix = target.slice(target.lastIndexOf('.')).toLowerCase();
    const isPng = suffix === '.png' && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = ['.jpg', '.jpeg'].includes(suffix) && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const isWebp =
      suffix === '.webp' &&
      data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isPng && !isJpeg && !isWebp) return undefined;
    const mime = isPng ? 'png' : isWebp ? 'webp' : 'jpeg';
    return `data:image/${mime};base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/**
 * 读取包根清单。返回 `null` = 不是合法的插件包（调用方据此决定是否拒绝安装）。
 *
 * 校验强度对齐引擎：`$schema` 必须命中、`name` 必须过同一套正则。
 * 引擎拒收的包，客户端也不该接受——否则会出现"装上了但引擎看不见"。
 */
export async function readPluginManifest(root: string): Promise<PluginManifest | null> {
  const found = await readManifestPayload(root);
  if (found === null) return null;
  const { payload, relPath } = found;

  const schema = asTrimmedString(payload.$schema);
  if (schema !== AGENT_PLUGIN_SCHEMA) return null;

  const name = asTrimmedString(payload.name);
  if (!name || name.length > MAX_PLUGIN_NAME_LENGTH || !PLUGIN_NAME_RE.test(name)) return null;

  const extensions = asRecord(payload.extensions);
  const nanobot = asRecord(extensions['dev.nanobot']);
  const rawPermissions = asRecord(payload.permissions ?? nanobot.permissions);
  const engines = asRecord(payload.engines ?? nanobot.engines);

  const declaredVersion = asTrimmedString(payload.version ?? nanobot.version);
  const accentColor = asTrimmedString(nanobot.accentColor);
  const logo = await resolveLogo(root, nanobot.logo);

  return {
    name,
    displayName: asTrimmedString(nanobot.displayName) || name,
    version: declaredVersion || '0.0.0',
    versionDeclared: Boolean(declaredVersion),
    description: asTrimmedString(payload.description),
    repository: asTrimmedString(payload.repository),
    category: asTrimmedString(nanobot.category) || 'Plugin',
    main: asTrimmedString(payload.main ?? nanobot.main) || 'SKILL.md',
    permissions: {
      tools: asStringArray(rawPermissions.tools),
      network: asStringArray(rawPermissions.network),
    },
    engineRange: asTrimmedString(engines.nanowork),
    ...(accentColor && /^#[0-9a-fA-F]{6}$/.test(accentColor) ? { accentColor } : {}),
    ...(logo ? { logo } : {}),
    schema,
    manifestRelPath: relPath,
  };
}

// ---------------------------------------------------------------------------
// 资源盘点（PRD §12.2 的目录清单）
// ---------------------------------------------------------------------------

async function listEntries(target: string): Promise<string[]> {
  try {
    return await fs.readdir(target);
  } catch {
    return [];
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

function withLimit(names: string[]): { names: string[]; truncated: boolean } {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= MAX_INVENTORY_ENTRIES) return { names: sorted, truncated: false };
  return { names: sorted.slice(0, MAX_INVENTORY_ENTRIES), truncated: true };
}

/** 目录下的 `*.md` 文件名（去扩展名） */
async function markdownNames(dir: string): Promise<string[]> {
  const entries = await listEntries(dir);
  return entries.filter((name) => name.toLowerCase().endsWith('.md')).map((name) => name.slice(0, -3));
}

/** 目录下"含 SKILL.md 的子目录"名 */
async function skillDirNames(dir: string): Promise<string[]> {
  const entries = await listEntries(dir);
  const result: string[] = [];
  for (const name of entries) {
    if (await isFile(join(dir, name, 'SKILL.md'))) result.push(name);
  }
  return result;
}

/**
 * 盘点包内资源。缺失的分组也会返回（`count: 0`），
 * 这样界面能稳定地展示"这个包有哪些能力类别"，不会因缺项而跳动。
 */
export async function inventoryPluginResources(root: string): Promise<PluginResourceGroup[]> {
  const groups: Array<{ id: PluginResourceId; label: string; scan: () => Promise<string[]> }> = [
    { id: 'skill', label: '入口技能', scan: async () => ((await isFile(join(root, 'SKILL.md'))) ? ['SKILL.md'] : []) },
    { id: 'agents', label: '子代理', scan: () => markdownNames(join(root, 'agents')) },
    { id: 'experts', label: '专家包', scan: async () => {
      const dir = join(root, 'experts');
      const entries = await listEntries(dir);
      const result: string[] = [];
      for (const name of entries) {
        if (await isDirectory(join(dir, name))) result.push(name);
      }
      return result;
    } },
    { id: 'skills', label: '子技能', scan: () => skillDirNames(join(root, 'skills')) },
    { id: 'commands', label: '斜杠命令', scan: () => markdownNames(join(root, 'commands')) },
    { id: 'hooks', label: '生命周期钩子', scan: () => firstExistingFileName(root, ['hooks/hooks.json', 'hooks.json']) },
    { id: 'mcp', label: 'MCP 配置', scan: () => firstExistingFileName(root, [...PLUGIN_MCP_RELPATHS]) },
    { id: 'prompt', label: '提示词片段', scan: () => markdownNames(join(root, 'prompt')) },
    { id: 'scripts', label: '脚本', scan: () => fileNames(join(root, 'scripts')) },
    { id: 'assets', label: '资源文件', scan: () => fileNames(join(root, 'assets')) },
  ];

  const result: PluginResourceGroup[] = [];
  for (const group of groups) {
    const { names, truncated } = withLimit(await group.scan());
    result.push({ id: group.id, label: group.label, count: names.length, names, truncated });
  }
  return result;
}

async function firstExistingFileName(root: string, relPaths: string[]): Promise<string[]> {
  for (const relPath of relPaths) {
    if (await isFile(join(root, relPath))) return [relPath];
  }
  return [];
}

async function fileNames(dir: string): Promise<string[]> {
  const entries = await listEntries(dir);
  const result: string[] = [];
  for (const name of entries) {
    if (await isFile(join(dir, name))) result.push(name);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 扫描已安装
// ---------------------------------------------------------------------------

/**
 * 扫描插件根下的所有已装包。
 *
 * 单个包坏掉不影响其他包：解析失败的目录被跳过并记进 `skipped`，
 * 而不是把整个列表变成空的——否则一个坏包会让界面看起来"什么都没装"。
 */
export async function readInstalledPlugins(
  pluginsRoot: string,
): Promise<{ plugins: InstalledPlugin[]; skipped: string[] }> {
  const plugins: InstalledPlugin[] = [];
  const skipped: string[] = [];
  const entries = await listEntries(pluginsRoot);
  for (const entry of entries) {
    const root = join(pluginsRoot, entry);
    if (!(await isDirectory(root))) continue;
    const manifest = await readPluginManifest(root);
    if (manifest === null) {
      skipped.push(entry);
      continue;
    }
    const plugin: InstalledPlugin = {
      manifest,
      root,
      resources: await inventoryPluginResources(root),
    };
    try {
      plugin.installedAt = (await fs.stat(root)).mtime.toISOString();
    } catch {
      // 拿不到 mtime 不影响展示
    }
    plugins.push(plugin);
  }
  plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return { plugins, skipped: skipped.sort((a, b) => a.localeCompare(b)) };
}

// ---------------------------------------------------------------------------
// 安装 / 卸载
// ---------------------------------------------------------------------------

/**
 * 安装（复制）一个插件包到 `pluginsRoot/<name>`。
 *
 * 顺序刻意是"**先全部校验、再落盘**"：清单非法或名字不合规时，
 * 目录里不该留下半个包。中途失败的残留比直接失败更难排查。
 */
export async function installPluginPackage(
  options: InstallPluginOptions,
): Promise<PluginInstallResult> {
  const { sourceDir, pluginsRoot, overwrite = false } = options;

  if (!(await isDirectory(sourceDir))) {
    return { ok: false, error: '来源目录不存在或不是目录', errorKind: 'source-missing' };
  }

  const manifest = await readPluginManifest(sourceDir);
  if (manifest === null) {
    return {
      ok: false,
      error: `不是合法的插件包：缺少或不合规的清单（${PLUGIN_MANIFEST_RELPATHS.join(' 或 ')}）`,
      errorKind: 'manifest-invalid',
    };
  }

  // 来源目录不得位于插件根之内（含根自身）。**这条必须排在"已安装"判断之前**：
  // 覆盖安装是"先 rm 再 cp"，若来源在目标之内，rm 会把来源一起删掉，
  // 随后 cp 无源可读——旧版本没了、新版本也没装上。守卫先行才能挡住这条数据丢失路径。
  const containedSource = await containPath(sourceDir, pluginsRoot);
  if (containedSource !== null) {
    return { ok: false, error: '来源目录位于插件目录之内，拒绝自拷贝', errorKind: 'escape' };
  }

  // 目标目录名取权威来源（清单里的 name），而不是来源目录名——
  // 来源可能是 `my-plugin-1.2.0/`，装进去必须叫 `my-plugin`。
  const target = join(pluginsRoot, manifest.name);
  const containedTarget = await containPath(target, pluginsRoot);
  if (containedTarget === null) {
    return { ok: false, error: '目标路径越出插件目录', errorKind: 'escape' };
  }

  if ((await isDirectory(containedTarget)) && !overwrite) {
    return {
      ok: false,
      error: `已安装插件「${manifest.name}」，如需覆盖请先卸载或选择升级`,
      errorKind: 'already-installed',
    };
  }

  try {
    await fs.mkdir(pluginsRoot, { recursive: true });
    // 覆盖安装前先清旧目录。"整目录替换语义"：先删再加比 cp 覆盖更干净，
    // 旧版本文件不会被新版本"继承"。旧版本是用户资产 → 走回收站（FR-8.11）。
    await safeDelete(containedTarget);
    await fs.cp(sourceDir, containedTarget, {
      recursive: true,
      force: true,
      errorOnExist: false,
      // 不解引用符号链接：包内 symlink 若指向外部，解引用会把外部内容复制进来。
      dereference: false,
    });
  } catch (err) {
    return { ok: false, error: `复制插件包失败：${String(err)}`, errorKind: 'io' };
  }

  // 复制后重读：以落盘结果为准（也顺带验证复制没有破坏清单）。
  const installed = await readPluginManifest(containedTarget);
  if (installed === null) {
    return {
      ok: false,
      error: '复制后的包清单无法解析，安装未完成',
      errorKind: 'manifest-invalid',
    };
  }
  return { ok: true, root: containedTarget, manifest: installed };
}

/** 卸载（删除包目录）。返回包目录是否**原本存在**。 */
export async function uninstallPluginPackage(pluginsRoot: string, name: string): Promise<boolean> {
  if (!PLUGIN_NAME_RE.test(name) || name.length > MAX_PLUGIN_NAME_LENGTH) {
    // 名字不合规直接拒：`name` 会被拼进路径，放行等于给了路径逃逸面。
    return false;
  }
  const target = await containPath(join(pluginsRoot, name), pluginsRoot);
  if (target === null) return false;
  try {
    await fs.stat(target);
  } catch {
    return false;
  }
  // 卸载是明确的用户删除：插件是用户资产，走回收站（FR-8.11），误卸可在回收站找回。
  await safeDelete(target);
  return true;
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

// 版本解析与区间判定**实现在渲染层的纯模块** `src/lib/semverRange.ts`：
// 同一套规则还要被插件卡片（界面侧「这个包能不能用」）用到，写两份必然漂移，
// 症状是「装的时候说可以，界面上说不兼容」。这里只做再导出。
export { compareVersions, parseVersion, satisfiesRange } from '../src/lib/semverRange';

/** 当前 `pluginsRoot` 下某个包名对应的目录是否已被占用 */
export async function isPluginInstalled(pluginsRoot: string, name: string): Promise<boolean> {
  if (!PLUGIN_NAME_RE.test(name)) return false;
  return isDirectory(join(pluginsRoot, name));
}

/** 用于界面展示：包根目录名（与清单 `name` 不一致时便于发现） */
export function packageFolderName(root: string): string {
  return basename(root) || basename(dirname(root));
}

/** 相对路径工具（界面里展示"命中哪个清单"用），统一成 `/` 分隔 */
export function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}
