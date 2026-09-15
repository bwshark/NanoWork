import { isAbsolute, join, resolve, sep } from 'node:path';
import { MEMORY_KEY_PREFIX, STORAGE_KEYS } from '../src/lib/constants';

/**
 * 渲染层持久化 key → 磁盘落点 的路由表（Electron 主进程专用）。
 *
 * ## 为什么需要它
 *
 * 早期实现把全部持久化状态挤在 `<userData>/nanowork-store.json` 单文件里
 * （一个 `{ key: JSON 字符串 }` 的字典），带来三个问题：
 *
 * 1. **归属错误**：用户资产落在 Electron 的 userData（②），而那是安装/卸载细节，
 *    卸载即可能被清；用户资产应当落在产品自有目录（①）。
 * 2. **无法按实体同步**：单文件 blob 与 V1.5 的实体级同步天然冲突——同步要按
 *    `(collection, entity_id)` 读写，blob 只能整体搬运。
 * 3. **写放大**：任一 key 变更都要重写整个文件（实测 sessions 单项即 113 KB）。
 *
 * 因此按 `docs/nanowork-prd-design-v2.md` 第 18.1 节的目标态把落点拆开，
 * 并落在两个职责不同的根上（边界定义见第 18.2 节 / ADR-018）：
 *
 * - **① 产品自有目录** `~/.nanowork/`：跨工作区、跨端的用户资产。人工可读可改，
 *   故 json 一律缩进美化（对齐 WorkBuddy 的 `settings.json` 形态）。
 * - **② Electron 运行时数据** `<userData>/`：渲染层状态与会话数据，随安装变化，
 *   紧凑写。这些是过渡落点，D2 落地后 sessions 会拆为 `projects/<slug>/*.jsonl`
 *   + `index/sessions.db`。
 *
 * ## 编解码约定
 *
 * 桥接层按**文本**传递（`ElectronStorageAdapter` 不做二次编码），所以：
 *
 * - **写**：json 路由把文本解析成结构后落盘（文件可读可改），text 路由原样落；
 * - **读**：文件原文即调用方写盘前的那份文本，**原样返回**。
 *
 * 旧单文件 blob 里的值多一层字符串编码（旧链路里适配器会对已序列化的值再
 * stringify 一次），由 `unwrapLegacyValue` 在迁移时一次性剥掉。
 *
 * 本模块**不 import electron**，只做「key → 绝对路径 + 落盘编码」的纯映射，
 * 因而可被单测直接覆盖。
 */

/** 磁盘落盘格式：json = 结构化（可缩进）；text = 原样文本（如 Markdown） */
export type StorageValueFormat = 'json' | 'text';

/** 落点归属：user = ① 用户资产；runtime = ② Electron 运行时数据 */
export type StorageScope = 'user' | 'runtime';

/** 单个 key 的落点描述 */
export interface StorageRoute {
  /** 绝对落盘路径 */
  filePath: string;
  /** 文件格式 */
  format: StorageValueFormat;
  /** json 格式下是否缩进美化（仅用户资产为 true） */
  pretty: boolean;
  /** 归属根 */
  scope: StorageScope;
}

/** 两个根的位置来源（由主进程注入，便于单测构造） */
export interface StorageRoots {
  /** 用户主目录；① = `<home>/.nanowork/` */
  home: string;
  /** Electron `app.getPath('userData')`；② 的根 */
  electronUserData: string;
}

/** 产品自有目录名（①）：与 `USER_SKILLS_DIR` 等共用，避免各处散落硬编码 */
export const PRODUCT_DIR_NAME = '.nanowork';

/** 设备 ID 的存储 key（主进程自持，渲染层不写） */
export const DEVICE_ID_STORAGE_KEY = 'nanowork.deviceId';

/** 记忆工作区索引的存储 key（完整 key = MEMORY_KEY_PREFIX + 'index'） */
const MEMORY_INDEX_KEY = `${MEMORY_KEY_PREFIX}index`;

interface FileEntry {
  /** 相对所属根的路径 */
  rel: string;
  format: StorageValueFormat;
}

/**
 * ① 用户资产：跨工作区、跨端，落在 `~/.nanowork/`。
 *
 * key 必须与 `src/lib/constants.ts` 的 `STORAGE_KEYS` 保持一致——这里直接引用
 * 该常量表，就是为了让「加了一个 store 却忘了改主进程」在编译期就暴露。
 *
 * 注：`STORAGE_KEYS.skills` 是技能**索引与启用态**（skillsStore 的持久化），
 * 真正的技能包是 `skills/<name>/SKILL.md`（目录形式，见 18.1）。
 */
const USER_FILES: Record<string, FileEntry> = {
  [STORAGE_KEYS.settings]: { rel: 'settings.json', format: 'json' },
  [STORAGE_KEYS.mcp]: { rel: 'mcp.json', format: 'json' },
  [STORAGE_KEYS.channels]: { rel: 'channels.json', format: 'json' },
  [STORAGE_KEYS.agents]: { rel: 'experts/agents.json', format: 'json' },
  [STORAGE_KEYS.expertGroups]: { rel: 'experts/groups.json', format: 'json' },
  [STORAGE_KEYS.skills]: { rel: 'skills/index.json', format: 'json' },
};

/**
 * ② Electron 运行时数据：落在 `<userData>/`，紧凑写。
 *
 * sessions / tasks / artifacts 都是「随会话产生」的数据，不是用户手写的资产，
 * 因此不占 ① 的位置。
 */
const RUNTIME_FILES: Record<string, FileEntry> = {
  [STORAGE_KEYS.sessions]: { rel: 'sessions.json', format: 'json' },
  [STORAGE_KEYS.tasks]: { rel: 'tasks.json', format: 'json' },
  [STORAGE_KEYS.artifacts]: { rel: 'artifacts.json', format: 'json' },
  [DEVICE_ID_STORAGE_KEY]: { rel: 'device-id.txt', format: 'text' },
};

/** ① 产品自有目录 `~/.nanowork/` */
export function productDir(roots: StorageRoots): string {
  return join(roots.home, PRODUCT_DIR_NAME);
}

/** 记忆目录 `~/.nanowork/memory/`（工作区级记忆文件按 workspaceKey 命名） */
export function memoryDir(roots: StorageRoots): string {
  return join(productDir(roots), 'memory');
}

/** 未登记 key 的兜底目录 `<userData>/misc/`（见 resolveRoute 第 3 级） */
export function miscDir(roots: StorageRoots): string {
  return join(roots.electronUserData, 'misc');
}

/** Windows 保留设备名：作为文件名会导致写入失败 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把任意字符串收敛为安全的单层文件名片段。
 *
 * 用途：memory 的工作区 key 可能来自路径哈希或用户输入，直接拼进路径会越界
 * （`../`）或产生非法文件名（Windows 禁止 `\ / : * ? " < > |`）。
 * 规则刻意保守：白名单字符 + 去首部点号（防 `..` 与隐藏文件）+ 长度截断。
 */
export function sanitizeSegment(raw: string): string {
  const trimmed = (raw ?? '').trim();
  // 仅保留可安全用于文件名的字符，其余折叠为下划线
  const replaced = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_');
  // 去首部点号：既避免 `..`，也避免生成隐藏文件
  const stripped = replaced.replace(/^[._]+/, '').slice(0, 120);
  if (!stripped) return 'unnamed';
  return WINDOWS_RESERVED.test(stripped) ? `_${stripped}` : stripped;
}

/**
 * 解析某个持久化 key 的落点。
 *
 * 解析顺序：
 * 1. ① / ② 的静态表；
 * 2. 记忆：`nanowork.memory.index` → `memory/index.json`，
 *    其余 `nanowork.memory.<ws>` → `memory/<ws>.md`（**原样 Markdown**，
 *    用户可直接打开阅读/编辑）；
 * 3. 兜底：落入 ② 的 `misc/<key>.json`——这样渲染层新增一个 store 时
 *    无需同步改主进程，也保证数据不会因「未登记」而丢失。
 */
export function resolveRoute(key: string, roots: StorageRoots): StorageRoute {
  const userEntry = USER_FILES[key];
  if (userEntry) {
    return {
      filePath: join(productDir(roots), userEntry.rel),
      format: userEntry.format,
      pretty: userEntry.format === 'json',
      scope: 'user',
    };
  }

  const runtimeEntry = RUNTIME_FILES[key];
  if (runtimeEntry) {
    return {
      filePath: join(roots.electronUserData, runtimeEntry.rel),
      format: runtimeEntry.format,
      pretty: false,
      scope: 'runtime',
    };
  }

  if (key === MEMORY_INDEX_KEY) {
    return {
      filePath: join(memoryDir(roots), 'index.json'),
      format: 'json',
      pretty: true,
      scope: 'user',
    };
  }

  if (key.startsWith(MEMORY_KEY_PREFIX)) {
    const workspaceKey = sanitizeSegment(key.slice(MEMORY_KEY_PREFIX.length));
    return {
      filePath: join(memoryDir(roots), `${workspaceKey}.md`),
      format: 'text',
      pretty: false,
      scope: 'user',
    };
  }

  return {
    filePath: join(miscDir(roots), `${sanitizeSegment(key)}.json`),
    format: 'json',
    pretty: false,
    scope: 'runtime',
  };
}

/**
 * 内存态 → 文件文本。
 *
 * - `json`：解析成结构再落盘，目的是让文件**可读可改**（对齐 WorkBuddy 的
 *   `settings.json` 形态），而不是一个被转义的字符串；
 * - `text`：原样落盘（记忆文件应当就是纯 Markdown）。
 */
export function serializeRouteValue(value: string, route: StorageRoute): string {
  if (route.format === 'text') return value;
  return JSON.stringify(JSON.parse(value), null, route.pretty ? 2 : undefined);
}

/**
 * 剥掉旧单文件 blob 值上的多余一层编码。
 *
 * 旧链路里 `StorageAdapter.set` 会对**已序列化**的值再 `JSON.stringify` 一次
 * （zustand persist 已序列化过），所以旧值比新契约多一层：`"{\"state\":...}"`。
 * 迁移时剥掉这一层即可对齐新契约。
 *
 * 主进程自持的裸文本（如 deviceId，绕过了适配器直接写入）本就没有这一层，
 * 解析失败即原样返回，不做猜测。
 */
export function unwrapLegacyValue(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * 列出所有**静态登记**的落点文件（记忆与兜底目录另按目录清理）。
 *
 * `storage:clear` 用它做精确删除，避免误伤 ① 下的用户目录
 * （`skills/`、`plugins/`、`connectors/` 等属用户资产，不属于「可清空的存储」）。
 */
export function knownRouteFiles(roots: StorageRoots): string[] {
  return [
    ...Object.values(USER_FILES).map((entry) => join(productDir(roots), entry.rel)),
    ...Object.values(RUNTIME_FILES).map((entry) =>
      join(roots.electronUserData, entry.rel),
    ),
    join(memoryDir(roots), 'index.json'),
  ];
}

/**
 * 把 `fs:writeTextFile` 收到的路径规整为绝对路径并做安全校验。
 *
 * - **绝对路径**：仅允许落在用户主目录 / userData / ① 产品自有目录内；
 * - **相对路径**：解析到 ① `~/.nanowork/`。相对路径的语义是「导出用户可见的
 *   文件」（如 `MEMORY.md`），落进 Electron 内部目录（②）对用户没有意义。
 *
 * 返回 `null` 表示越界（调用方应拒绝）。校验前先 `resolve` 归一化（消掉 `..`），
 * 且要求命中的 root 以分隔符结尾，避免 `/home/u` 命中 `/home/u-evil`。
 */
export function resolveWriteTarget(filePath: string, roots: StorageRoots): string | null {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return null;

  const userDir = productDir(roots);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(userDir, filePath);

  const safeRoots = [roots.home, roots.electronUserData, userDir];
  const isSafe = safeRoots.some(
    (root) => target === resolve(root) || target.startsWith(resolve(root) + sep),
  );
  return isSafe ? target : null;
}
