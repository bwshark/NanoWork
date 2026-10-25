/**
 * 记忆存储的**目录与文件名策略**（纯逻辑，无 platform / node / electron 依赖）。
 *
 * ## 为什么独立成模块
 *
 * 记忆 v2 把落点从「一个工作目录一个目录」扩成**两类存储根**（工作区级 / 用户级），
 * 且一个根里有**子目录**（`daily/`、`archive/`）。于是「这次操作针对哪个根」「这个名字
 * 合法吗、能不能写」「哪些名字算记忆」这三件事同时被**三方**需要：
 *
 * - 渲染层（`src/lib/memory/*` 的读取与展示、记忆页的文件列表）；
 * - 主进程（真正的 fs 读写，必须自己再校验一次——渲染层的校验是一致性，不是安全边界）；
 * - 测试（真机临时目录）。
 *
 * 各写一遍必然漂移，症状是「界面上列得出这个文件、磁盘上却读不到」。故集中在这里，
 * 并**禁止** import 任何渲染层模块或 electron 模块。
 *
 * 与 `src/lib/memory/workspaceMemory.ts` 的分工：那个模块是**记忆 v1** 的目录约定
 * （`MEMORY.md` + `YYYY-MM-DD.md`，只有一层、没有子目录），仍被既有代码与测试使用，
 * **保持不动**；本模块是 v2 的约定（两类根 + 子目录 + canonical JSON / JSONL），
 * 并**包含** v1 的名字（v1 文件继续可读、可注入——见设计 §4.6）。
 */

import { DEFAULT_WORKSPACE_KEY, hashContent, workspaceKeyFor } from '../workspace/workspaceKey';

/** 工作区内承载产品数据的目录名（与 `electron/storageRoutes.ts` 的 `PRODUCT_DIR_NAME` 同值） */
export const WORKSPACE_MEMORY_DIR = '.nanowork';

/** 上述目录下放记忆的子目录名 */
export const WORKSPACE_MEMORY_SUBDIR = 'memory';

/**
 * 用户级记忆的目录名（`~/.nanowork/user-memory/`）。
 *
 * 与工作区级**刻意分开**：工作区记忆跟着工作目录走，用户记忆跟着用户走。
 * v1 的用户级是单文件 `~/.nanowork/MEMORY.md`（storage key `nanowork.userMemory`），
 * **原地保留为 legacy 只读源**——它是跨端同步资产，改名会造成跨设备删除
 * （设计 §9 / NFR-M11）。
 */
export const USER_MEMORY_DIR = 'user-memory';

// —— 文件名 ——

/** 精炼记忆（v1 的编辑目标，v2 里是人读 + 注入投影） */
export const CURATED_MEMORY_FILE = 'MEMORY.md';

/** 用户画像投影（人读） */
export const USER_PROFILE_PROJECTION_FILE = 'user.md';

/** 结构化用户资料（canonical） */
export const PROFILE_FILE = 'profile.json';

/** keyed 偏好全集（canonical，含已过期记录） */
export const PREFERENCES_FILE = 'preferences.json';

/** 策展状态（canonical：修订链） */
export const CURATED_STATE_FILE = 'curated.json';

/** 冲突案件快照（canonical） */
export const CONFLICTS_FILE = 'conflicts.json';

/** 人工裁决审计流（append-only） */
export const ADJUDICATIONS_FILE = 'conflict-adjudications.jsonl';

/** 多文件裁决的事务阶段事件（append-only） */
export const TRANSACTIONS_FILE = 'conflict-resolution-transactions.jsonl';

/** 事实日志的子目录（`daily/YYYY-MM-DD.jsonl`） */
export const DAILY_SUBDIR = 'daily';

/** 归档子目录（`archive/YYYY-MM-DD.jsonl`） */
export const ARCHIVE_SUBDIR = 'archive';

/**
 * 应用**自己会写**的根级文件名（白名单）。
 *
 * 这是**能力边界**而不是提示：写入侧只接受这些名字，别的一律抛错。
 * 读取侧比它宽（见 `isMemoryFileName`）——用户手写的笔记不该被静默忽略。
 */
export const WRITABLE_ROOT_FILES: readonly string[] = [
  CURATED_MEMORY_FILE,
  USER_PROFILE_PROJECTION_FILE,
  PROFILE_FILE,
  PREFERENCES_FILE,
  CURATED_STATE_FILE,
  CONFLICTS_FILE,
  ADJUDICATIONS_FILE,
  TRANSACTIONS_FILE,
];

/** 允许写入的子目录（白名单） */
export const WRITABLE_SUBDIRS: readonly string[] = [DAILY_SUBDIR];

/** 允许读取的子目录（比写入宽：归档只读，但要能列能读） */
export const READABLE_SUBDIRS: readonly string[] = [DAILY_SUBDIR, ARCHIVE_SUBDIR];

/** v1 兼容的日期文件名（`2026-09-19.md`） */
const LEGACY_DAILY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** v2 事实日志文件名（`2026-09-19.jsonl`） */
const FACT_LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * 文件名的长度上限。
 *
 * 不是「防攻击」而是「防事故」：文件名会进记忆页的切换器、日志与错误信息，
 * 一个几百字符的名字会把整行撑爆。真实文件名最长也就 `2026-09-19.jsonl`。
 */
const MAX_MEMORY_FILE_NAME_LENGTH = 64;

/** 子目录名的长度上限（同上；真实值只有 `daily` / `archive`） */
const MAX_MEMORY_DIR_NAME_LENGTH = 32;

/**
 * 是不是一个合法的**单段**文件名（不含路径分隔符）。
 *
 * 逐条排除，每一条都对应一种真实故障：
 * - 含 `/` `\`：路径穿越（`../MEMORY.md` 会写到根外面去）；主进程还会用
 *   `resolve + 前缀比对`再挡一次，但这里先拦住等于把攻击面收敛成一个布尔；
 * - 首字符是 `.`：既排除 `..`，也排除 `.hidden.md` 这类会被误当记忆的隐藏文件；
 * - Windows 非法字符（`: * ? " < > |`）与控制字符：写盘会失败，且 Windows 会把
 *   `:` 解释成数据流（`C:foo`）；
 * - 首尾空白：`"MEMORY.md "` 在 Windows 上会被静默裁成 `MEMORY.md`，
 *   于是「列表里有它、读的是另一个文件」。
 */
export function isMemoryFileName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (name === '' || name.length > MAX_MEMORY_FILE_NAME_LENGTH) return false;
  if (name !== name.trim()) return false;
  if (name.startsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  return /\.(md|json|jsonl)$/i.test(name);
}

/** 是不是 v1 的日期记忆文件（`2026-09-19.md`） */
export function isLegacyDailyMemoryFileName(name: string): boolean {
  return LEGACY_DAILY_FILE_RE.test(name);
}

/** 是不是 v2 的事实日志文件（`2026-09-19.jsonl`） */
export function isFactLogFileName(name: string): boolean {
  return FACT_LOG_FILE_RE.test(name);
}

/** 是不是合法的子目录名（单段、非隐藏、无非法字符） */
export function isMemorySubdirName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (name === '' || name.length > MAX_MEMORY_DIR_NAME_LENGTH) return false;
  if (name !== name.trim()) return false;
  if (name.startsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  return true;
}

/**
 * 「这个文件算不算这份记忆的一部分」——**读取侧**的判定，比写入白名单宽。
 *
 * 刻意收下用户手写的 `notes.md` / `my.json`：静默忽略正是「我明明写了它却记不住」
 * 的经典成因。但**必须排除**同目录下的产品文件（`index.json` 是旧工作区索引、
 * `.migrated` 是留档），否则它们会被当成记忆内容注入 prompt。
 */
export function isMemoryContentFileName(name: unknown): boolean {
  if (!isMemoryFileName(name)) return false;
  const value = name as string;
  if (value === 'index.json') return false;
  if (value.endsWith('.migrated')) return false;
  return true;
}

/** 某个子目录下允许写入的文件名（目前只有 `daily/YYYY-MM-DD.jsonl`） */
export function isWritableMemoryFileNameIn(subdir: string, name: unknown): boolean {
  if (subdir === DAILY_SUBDIR) return isFactLogFileName(name as string);
  return false;
}

/**
 * 是不是一个应用**允许写入**的记忆文件（根级）。
 *
 * - v1 的 `MEMORY.md` 与 `YYYY-MM-DD.md` 继续可写：记忆页的文件编辑器、
 *   legacy 迁移都依赖它们（v2 不再**新增**日期 `.md`，但既有文件要能编辑）；
 * - v2 的 canonical JSON / JSONL 在白名单内；
 * - 其它名字（含用户手写的 `notes.md`）**不可由应用写入**——读取收下它们，
 *   写入拒绝，这条不对称是刻意的。
 */
export function isWritableMemoryFileName(name: unknown): boolean {
  if (!isMemoryFileName(name)) return false;
  const value = name as string;
  return WRITABLE_ROOT_FILES.includes(value) || isLegacyDailyMemoryFileName(value);
}

/** 某个时刻对应的日期文件名（**本地时间**） */
export function dailyMemoryFileName(at: Date | string | number = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}.md`;
}

/**
 * 某个时刻对应的事实日志文件名（**本地时间** + `.jsonl`）。
 *
 * 用本地时间而不是 UTC：这是给用户看的「今天的日志」，UTC+8 的用户在 09-20 早上 07:00
 * 写记忆，UTC 日期还是 09-19——文件名与用户心里的「今天」差一天。
 *
 * ⚠️ 因此**同一 UTC 时刻在不同时区会落到不同日文件**。读取侧不得假设
 * 「`daily/<某一天>.jsonl` 就是全部」，必须枚举日期文件后按 `observedAt` 过滤
 * （见设计 §4.3.1 的确定性契约第 6 条）。
 */
export function dailyFactLogFileName(at: Date | string | number = new Date()): string {
  return dailyMemoryFileName(at).replace(/\.md$/, '.jsonl');
}

/** 路径分隔符：按传入路径自己带的那一种推断（渲染层拿不到 `node:path`） */
function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

/** 去掉尾部的一个或多个分隔符 */
function stripTrailingSep(p: string): string {
  return (p ?? '').replace(/[\\/]+$/, '');
}

/**
 * 工作区记忆目录的**展示路径**（末尾带分隔符，一眼看出是目录）。
 *
 * 与 `memory/workspaceMemory.ts` 的同名函数同形态，差别只有一处：没有工作目录时本函数给的是
 * **产品目录下的兜底位置**（`~/.nanowork/memory/default/`）——与主进程
 * `resolveWorkspaceMemoryDir` 的兜底保持一致。
 *
 * 只用于界面展示与错误信息；真实路径一律由主进程用 `node:path` 拼。
 */
export function memoryDirDisplayPath(dirRef: {
  kind: 'workspace' | 'user';
  workdir?: string | null;
  userScope?: string;
}): string {
  const sep = '/';
  if (dirRef.kind === 'user') {
    const scope = scopeIdFor(dirRef.userScope ?? '');
    return `~/${WORKSPACE_MEMORY_DIR}/${USER_MEMORY_DIR}/${scope}${sep}`;
  }
  const raw = (dirRef.workdir ?? '').trim();
  if (raw === '') {
    return `~/${WORKSPACE_MEMORY_DIR}/${WORKSPACE_MEMORY_SUBDIR}/${DEFAULT_WORKSPACE_KEY}${sep}`;
  }
  const base = stripTrailingSep(raw.replace(/\\/g, '/'));
  return `${base}/${WORKSPACE_MEMORY_DIR}/${WORKSPACE_MEMORY_SUBDIR}${sep}`;
}

/**
 * 同一个记忆目录在 Web 端 localStorage 里的 key。
 *
 * ## 为什么 v2 另起前缀（`nanowork.mem2.`）而不是复用 v1 的 `nanowork.wsmem.`
 *
 * v1 那个 key 的值是**平铺的 `{ 文件名: 正文 }`**；v2 需要**子目录**，最自然的表示是
 * `{ 文件名: 正文, 'daily/2026-09-19.jsonl': 正文 }`（`/` 作名字的一部分）。两者可以
 * 共存于一个 key，但会带来两个麻烦：① v1 的 `readMemoryDir` 用 `isMemoryFileName`
 * 过滤，带 `/` 的名字会被**静默丢掉**——于是 v2 的事实日志在 Web 端永远读不到；
 * ② 要改 v1 的过滤规则就得动它的既有测试。
 *
 * 分开前缀之后，两个存储面各自完整、互不干扰：v1 面继续管 `MEMORY.md` 与日期 `.md`
 * （legacy 只读源），v2 面管 canonical JSON / JSONL 与子目录。读取时两侧都会看，
 * 这与 Electron 端「同一个目录里既有 legacy `.md` 又有新 JSON」是一致的。
 */
export function webMemoryDirKey(dirRef: {
  kind: 'workspace' | 'user';
  workdir?: string | null;
  userScope?: string;
}): string {
  if (dirRef.kind === 'user') return `nanowork.mem2.user.${scopeIdFor(dirRef.userScope ?? '')}`;
  // 与 v1 一样用 `workspaceKeyFor`（可读 + 带 hash）：迁移到 v2 后同一个工作区在
  // 两个前缀下的后缀一致，人肉核对时不容易搞错。
  return `nanowork.mem2.ws.${webWorkspaceSuffix(dirRef.workdir ?? null)}`;
}

/** Web 端工作区后缀（与 v1 的 `memoryDirKey` 用同一个 key 函数，保持可对照） */
function webWorkspaceSuffix(workdir: string | null): string {
  const raw = (workdir ?? '').trim();
  if (raw === '') return DEFAULT_WORKSPACE_KEY;
  return workspaceKeyFor(raw);
}

/**
 * 把「根 + 可选子目录 + 文件名」拼成一个**带相对子目录的名字**。
 *
 * 供 Web 端的目录映射与主进程的路径拼接共用同一套拼接规则，避免两端各自拼出
 * 一个不同形态（`daily\a.jsonl` vs `daily/a.jsonl`）。
 */
export function memoryEntryName(name: string, subdir?: string): string {
  const sub = (subdir ?? '').trim();
  return sub === '' ? name : `${sub}/${name}`;
}

/** `memoryEntryName` 的逆运算：拆出「子目录 + 文件名」；无子目录时 `subdir` 为 `''` */
export function splitMemoryEntryName(entry: string): { subdir: string; name: string } {
  const idx = (entry ?? '').lastIndexOf('/');
  if (idx <= 0) return { subdir: '', name: entry ?? '' };
  return { subdir: entry.slice(0, idx), name: entry.slice(idx + 1) };
}

/** 这个「带子目录的名字」是否合法（子目录在白名单内、文件名合法） */
export function isMemoryEntryName(entry: unknown): boolean {
  if (typeof entry !== 'string' || entry === '') return false;
  const { subdir, name } = splitMemoryEntryName(entry);
  if (subdir === '') return isMemoryContentFileName(name);
  if (!isMemorySubdirName(subdir)) return false;
  if (!READABLE_SUBDIRS.includes(subdir)) return false;
  return isMemoryFileName(name);
}

/** 这个「带子目录的名字」是否**允许应用写入** */
export function isWritableMemoryEntryName(entry: unknown): boolean {
  if (typeof entry !== 'string' || entry === '') return false;
  const { subdir, name } = splitMemoryEntryName(entry);
  if (subdir === '') return isWritableMemoryFileName(name);
  if (!isMemorySubdirName(subdir)) return false;
  if (!WRITABLE_SUBDIRS.includes(subdir)) return false;
  return isWritableMemoryFileNameIn(subdir, name);
}

/** `sepOf` 的对外暴露（主进程拼真实路径时要与传入路径同风格） */
export { sepOf as memoryPathSeparator };

/**
 * 把一段 JSONL 正文拆成非空行。
 *
 * 两端共用同一套拆分规则（去空行、去行尾 `\r`），否则「同一份日志在 Electron 端有 3 条、
 * 在 Web 端有 4 条」这类差异会在最不该出错的地方出现。**不解析 JSON**——解析失败是调用方
 * 的事，本函数只管行边界。
 */
export function splitJsonlLines(raw: string): string[] {
  const src = (raw ?? '').replace(/\r\n/g, '\n');
  if (src.trim() === '') return [];
  return src
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 把一行追加进一段 JSONL 正文（保证只多一行、且以换行为界） */
export function appendJsonlLine(raw: string, line: string): string {
  const current = raw ?? '';
  const body = line.replace(/[\r\n]+$/, '');
  if (current === '') return `${body}\n`;
  return current.endsWith('\n') ? `${current}${body}\n` : `${current}\n${body}\n`;
}

/**
 * 工作区归属标识：事实日志里带它，读取时校验。
 *
 * 与 `workspaceKeyFor()` **刻意不同**：那个名字是给人看的（`nanowork-1a2b3c4d`，
 * 用于 Web 端 localStorage key 与旧文件定位），本函数是**给程序做归属校验**的，
 * 可读性无用而长度有害，故取 8 位十六进制。
 *
 * 无工作目录 → `'default'`（与 `DEFAULT_WORKSPACE_KEY` 同值，保持两类标识在
 * 「没有工作目录」这一情形下可互相推断）。
 */
export function workspaceIdFor(workdir: string | null | undefined): string {
  const raw = (workdir ?? '').trim();
  if (raw === '') return DEFAULT_WORKSPACE_ID;
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (normalized === '') return DEFAULT_WORKSPACE_ID;
  return `w_${hashContent(normalized)}`;
}

/** 没有工作目录时的工作区归属标识（与 `DEFAULT_WORKSPACE_KEY` 同值） */
export const DEFAULT_WORKSPACE_ID = 'default';

/**
 * 用户作用域目录名：`u_<hash8>`。
 *
 * 为什么不直接用 `userScope` 本身当目录名：它可能来自任意账号标识（含 `/`、空格、
 * 邮箱），直接进路径既会越界也会让目录名不可读。canonical JSON 里另外保存同一个
 * `userScope`，读取时不匹配即拒绝——路径负责正常路由，marker 负责发现错误复制。
 */
export function scopeIdFor(userScope: string): string {
  return `u_${hashContent((userScope ?? '').trim())}`;
}
