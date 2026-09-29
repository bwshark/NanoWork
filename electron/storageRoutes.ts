import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  IDENTITY_FILENAMES,
  IDENTITY_STORAGE_KEYS,
  MEMORY_KEY_PREFIX,
  PROMPT_KEY_PREFIX,
  STORAGE_KEYS,
  USER_MEMORY_KEY,
} from '../src/lib/constants';
import { CONFLICT_SNAPSHOT_STORAGE_KEY, FILE_ASSETS_STORAGE_KEY } from '../src/sync/types';

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
  // 技能覆盖表（用户意图）：与 `skills/index.json` 并列，但**职责不同**——
  // 前者是事实缓存，这张才是可同步的用户意图（见 types/skill.ts 的说明）。
  // 分开落盘的意义在于 V1.5 的同步层可以直接把这一份当集合读，不必再过滤事实字段。
  [STORAGE_KEYS.skillOverrides]: { rel: 'skills/overrides.json', format: 'json' },
  // 用户级长期记忆（L2）：与工作区记忆（`memory/<ws>.md`）分属两层，落在 ① 根目录
  [USER_MEMORY_KEY]: { rel: 'MEMORY.md', format: 'text' },
  // 身份文件（L4）：文件名即用户可见的名字，落 ① 根目录（§18.1 布局）
  [IDENTITY_STORAGE_KEYS.soul]: { rel: IDENTITY_FILENAMES.soul, format: 'text' },
  [IDENTITY_STORAGE_KEYS.identity]: { rel: IDENTITY_FILENAMES.identity, format: 'text' },
  [IDENTITY_STORAGE_KEYS.user]: { rel: IDENTITY_FILENAMES.user, format: 'text' },
  [IDENTITY_STORAGE_KEYS.bootstrap]: { rel: IDENTITY_FILENAMES.bootstrap, format: 'text' },
};

/**
 * ② Electron 运行时数据：落在 `<userData>/`，紧凑写。
 *
 * tasks / artifacts 都是「随会话产生」的数据，不是用户手写的资产，因此不占 ① 的位置。
 *
 * `legacySessions`（`sessions.json`）是 D2 Phase E 之前的旧版会话整块快照，
 * 已无任何读写方；保留这条路由只为让渲染层能把它**一次性清掉**（见
 * `sessionsStore.loadSessions`），否则会留下一个永远读不到的孤儿文件。
 *
 * ⚠️ 登记纪律：`format` 必须与**值的真实形态**一致——json 路由会无条件
 * `JSON.parse` 后落盘（见 `serializeRouteValue`），裸文本（id、token、纯字符串）
 * 一旦落到 json 路由，写入必然失败。新增 key 时先问一句「值是 JSON 文本吗」。
 */
const RUNTIME_FILES: Record<string, FileEntry> = {
  [STORAGE_KEYS.legacySessions]: { rel: 'sessions.json', format: 'json' },
  [STORAGE_KEYS.tasks]: { rel: 'tasks.json', format: 'json' },
  [STORAGE_KEYS.artifacts]: { rel: 'artifacts.json', format: 'json' },
  // 「上次打开的会话」的值是**裸 session id**（渲染层读回来直接与 id 比对，
  // 从不 JSON.parse），必须按 text 落。若不登记，它会掉进 misc 兜底的 json
  // 路由，`JSON.parse('<uuid>')` 必然抛错——写盘整条失败（表现为渲染层未捕获
  // 拒绝 + 主进程 handler 报错），而失败是静默的，只是「重启后记不住上次会话」。
  [STORAGE_KEYS.activeSession]: { rel: 'active-session.txt', format: 'text' },
  [DEVICE_ID_STORAGE_KEY]: { rel: 'device-id.txt', format: 'text' },
  // 冲突被覆盖方快照（批次 6a）：值是**字符串 JSON**（`Record<userId, PushConflict[]>`），
  // 故 json 路由是对的（参看上面 `activeSession` 的教训：裸文本落到 json 路由会写盘失败）。
  // 登记的意义：它会进 `knownRouteFiles()` → 「清空数据」能带走它；未登记则会掉进
  // `misc/` 兜底，清空数据时留下一个过期的冲突快照文件。
  [CONFLICT_SNAPSHOT_STORAGE_KEY]: { rel: 'sync-conflicts.json', format: 'json' },
  // C 类文件型资产的同步元数据（批次 6b）：值同样是**字符串 JSON**
  // （`Record<userId, Record<assetKey, {hash, rev, updatedAt, updatedBy}>>`），理由同上。
  // 登记的意义：清空数据时会一并带走——不登记则元数据残留，而资产本体已被清掉，
  // 下一轮 hydrate 会拿「旧 hash + 空内容」误判为「本机刚改过」。
  [FILE_ASSETS_STORAGE_KEY]: { rel: 'file-assets-sync.json', format: 'json' },
  // 文件级回滚时间线元数据（FR-7.3）：纯渲染层运行时状态（`Record<fileKey, BackupEntry[]>`），
  // 值是字符串 JSON，故 json 路由。真正的备份正文由 IPC `file-backup:put` 落
  // `<userData>/file-history/<hash>.bak`，与这份时间线元数据是两件事（见 fileBackup.ts）。
  // 登记意义：进 `knownRouteFiles()` → 「清空数据」能一并带走；未登记则掉进 misc 兜底，
  // 且违反「STORAGE_KEYS 全部显式登记」的不变量（storageRoutes 单测会直接红）。
  [STORAGE_KEYS.fileBackups]: { rel: 'file-backups.json', format: 'json' },
};

/** ① 产品自有目录 `~/.nanowork/` */
export function productDir(roots: StorageRoots): string {
  return join(roots.home, PRODUCT_DIR_NAME);
}

/** 记忆目录 `~/.nanowork/memory/`（工作区级记忆文件按 workspaceKey 命名） */
export function memoryDir(roots: StorageRoots): string {
  return join(productDir(roots), 'memory');
}

/**
 * 提示词模板目录 `~/.nanowork/prompts/`（§13.4 外置模板资产）。
 * 与引擎侧 `<engine workspace>/prompts/` 是**两套**：这边是产品级
 * （mode × domain × style 矩阵），那边是引擎自身的系统提示词。
 */
export function promptsDir(roots: StorageRoots): string {
  return join(productDir(roots), 'prompts');
}

/**
 * `storage:clear` 的**豁免**名单：这些 key 的落点属于「用户手写资产」，
 * 与 ① 下的 `skills/`、`plugins/`、`connectors/` 同类，不参与一键清空——
 * 清掉 `SOUL.md` 是「重置应用」不该有的副作用。用户要重置身份文件，
 * 走身份页的「恢复默认」（删文件即回到内置默认）。
 *
 * 用户级 `MEMORY.md` **不在**豁免内：它和工作区 `memory/*.md` 同类，
 * 「清空数据」把记忆清掉是既有语义。
 */
const CLEAR_EXEMPT_KEYS = new Set<string>([
  IDENTITY_STORAGE_KEYS.soul,
  IDENTITY_STORAGE_KEYS.identity,
  IDENTITY_STORAGE_KEYS.user,
  IDENTITY_STORAGE_KEYS.bootstrap,
]);

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

  // 提示词模板：`nanowork.prompt.<kind>.<key>` → `prompts/<kind>/<key>.md`。
  // 形状必须是**恰好两段**——多一段少一段都不猜，直接落到兜底目录，
  // 否则 `nanowork.prompt.mode.a.b` 会产生意外深度（甚至越界）的路径。
  if (key.startsWith(PROMPT_KEY_PREFIX)) {
    const segments = key.slice(PROMPT_KEY_PREFIX.length).split('.');
    if (segments.length === 2 && segments.every((segment) => segment.trim() !== '')) {
      return {
        filePath: join(
          promptsDir(roots),
          sanitizeSegment(segments[0]),
          `${sanitizeSegment(segments[1])}.md`,
        ),
        format: 'text',
        pretty: false,
        scope: 'user',
      };
    }
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
 * （`skills/`、`plugins/`、`connectors/` 等属用户资产，不属于「可清空的存储」）；
 * `CLEAR_EXEMPT_KEYS` 里的身份文件同理被排除。
 */
export function knownRouteFiles(roots: StorageRoots): string[] {
  return [
    ...Object.entries(USER_FILES)
      .filter(([key]) => !CLEAR_EXEMPT_KEYS.has(key))
      .map(([, entry]) => join(productDir(roots), entry.rel)),
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
