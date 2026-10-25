/**
 * 工作区记忆的**目录约定**（纯逻辑，无 platform / node 依赖）。
 *
 * ## 为什么要独立成模块
 *
 * 工作区记忆的落点从「`~/.nanowork/memory/<工作区key>.md` 单文件」改成
 * 「`<工作目录>/.nanowork/memory/` 目录 + 日期文件」后，「目录名是什么、文件名
 * 合法吗、按什么顺序注入、几份文件怎么合并」这四件事同时被**三方**需要：
 *
 * - 渲染层（`MemoryService` 的读取与展示、记忆页的文件列表）；
 * - 主进程（真正的 fs 读写，必须自己再校验一次文件名——渲染层的校验是 UI 一致性，
 *   不是安全边界）；
 * - 测试（真机临时目录）。
 *
 * 各写一遍必然漂移，症状是「界面上列得出这个文件、磁盘上却读不到」。
 * 故集中在这里，并**禁止** import 任何渲染层或 electron 的东西。
 *
 * ## 文件形态
 *
 * | 文件 | 写入方 | 语义 |
 * |---|---|---|
 * | `MEMORY.md` | 记忆页手动编辑 | 精炼后的长期记忆，与被注入的顺序无关地排在最前 |
 * | `YYYY-MM-DD.md` | 自动沉淀 / 「记住这条」/ `<memory-save>` | 那一天的追加日志（append-only） |
 *
 * 这是 WorkBuddy `.workbuddy/memory/` 的同构形态：日志按天分片、精炼记忆单独一份。
 * 分片的好处是「今天的沉淀写坏了」不会波及历史，代价是读取要合并（见
 * `mergeMemoryFiles`）。
 */

import { isSameWorkspacePath } from '../workspace/workspaceLabel';

/** 工作区内承载产品数据的目录名（与 `electron/storageRoutes.ts` 的 `PRODUCT_DIR_NAME` 同值） */
export const WORKSPACE_MEMORY_DIR = '.nanowork';

/** 上述目录下放记忆的子目录名 */
export const WORKSPACE_MEMORY_SUBDIR = 'memory';

/** 精炼记忆的文件名（记忆页主编辑目标） */
export const CURATED_MEMORY_FILE = 'MEMORY.md';

/** 日期文件（追加日志）的文件名形态 */
const DAILY_MEMORY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * 记忆文件的长度上限。
 *
 * 不是「防攻击」而是「防事故」：文件名会进 URL 之外的每一个展示面（记忆页的
 * 切换器、日志、错误信息），一个几百字符的名字会把整行撑爆。真实文件名最长
 * 也就 `2026-09-19.md`。
 */
const MAX_MEMORY_FILE_NAME_LENGTH = 64;

/**
 * 是不是一个合法的记忆文件名（**单段**、`.md` 结尾）。
 *
 * 逐条排除，每一条都对应一种真实故障：
 * - 含 `/` `\`：路径穿越（`../MEMORY.md` 会写到工作区外面去）；主进程还会用
 *   `resolve + 前缀比对` 再挡一次，但这里先拦住等于把攻击面收敛成一个布尔；
 * - 首字符是 `.`：既排除 `..`，也排除 `.hidden.md` 这类会被用户误当记忆的隐藏文件；
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
  return /\.md$/i.test(name);
}

/** 是不是日期文件（`2026-09-19.md`） */
export function isDailyMemoryFileName(name: string): boolean {
  return DAILY_MEMORY_FILE_RE.test(name);
}

/**
 * 应用**自己会写**的文件名：只有 `MEMORY.md` 与日期文件。
 *
 * 比 `isMemoryFileName` 严一档，且这一档是**能力边界**而不是提示：读取收下目录里
 * 所有 `.md`（用户手写的 `notes.md` 应当被读出来，静默忽略正是「我明明写了它却
 * 记不住」的成因），但应用不发明别的名字。白名单越小，`memoryWriteFile` 这条
 * IPC 就越不可能被当成「往工作区任意位置写文件」的跳板。
 *
 * 放在这里而不是主进程里，是因为**两端必须用同一份**：Web 端同样有这条边界，
 * 而 Web 端 import 不到主进程（那是 `node:path` 世界）。
 */
export function isWritableMemoryFileName(name: unknown): boolean {
  if (!isMemoryFileName(name)) return false;
  const value = name as string;
  return value === CURATED_MEMORY_FILE || isDailyMemoryFileName(value);
}

/**
 * 某个时刻对应的日期文件名。
 *
 * 用**本地时间**而不是 `toISOString()`（UTC）：这是给用户看的「今天的日志」，
 * UTC+8 的用户在 09-20 早上 07:00 写记忆，UTC 日期还是 09-19——文件名与用户
 * 心里的「今天」差一天，是最容易被当成 bug 报告的那种不一致。
 */
export function dailyMemoryFileName(at: Date | string | number = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return dailyMemoryFileName(new Date());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}.md`;
}

/**
 * 注入顺序：`MEMORY.md` → 日期文件（升序，即时间顺序）→ 其它 `.md`（升序）。
 *
 * 三点理由：
 * 1. **精炼记忆排最前**。它是「稳定事实」，日期日志是「过程记录」；注入块的末尾
 *    在模型眼里更"新"，把稳定的放前面能让过程记录自然成为后写的补充。
 * 2. **日期升序 = 时间升序**。ISO 日期的字典序与时间序一致，不需要解析日期。
 * 3. **认领用户手写的文件**。用户往这个目录里丢一份 `notes.md` 是极自然的行为，
 *    读的时候把它排在最后（它是"额外补充"），总比静默忽略强——静默忽略正是
 *    「我明明写了它却记不住」的经典成因。
 */
export function sortMemoryFileNames(names: string[]): string[] {
  const rank = (name: string): number => {
    if (name === CURATED_MEMORY_FILE) return 0;
    if (isDailyMemoryFileName(name)) return 1;
    return 2;
  };
  return [...names].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    // 同一档内按名称升序；用 `<` 而不是 localeCompare，避免中文环境下
    // 「按读音排序」把 ISO 日期的字典序也一起改掉。
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

/**
 * 把若干记忆文件合并成**一份**注入正文。
 *
 * 刻意**不加**文件名标题：记忆正文里每个自动沉淀块已经带 `> [ISO] 来自「…」`，
 * 出处信息不缺；而凭空插 `## 2026-09-19.md` 这类二级标题会被 `countEntries`
 * 当成条目计数（它优先按 `## ` 计数），于是记忆页上的「约 N 条」会凭空多出
 * 与文件数相同的条数。
 *
 * 空文件与只含空白的文件直接跳过——否则合并结果里会多出连续空行，
 * 而 `parseEntryBodies` 按空行切段，连续空行虽不影响切分，却会污染用户
 * 在记忆页里看到的正文。
 */
export function mergeMemoryFiles(
  files: ReadonlyArray<{ name: string; content: string }>,
): string {
  const byName = new Map<string, string>();
  for (const file of files) {
    if (!isMemoryFileName(file.name)) continue;
    byName.set(file.name, file.content);
  }
  const bodies: string[] = [];
  for (const name of sortMemoryFileNames([...byName.keys()])) {
    const body = (byName.get(name) ?? '').trim();
    if (body !== '') bodies.push(body);
  }
  return bodies.join('\n\n');
}

/**
 * 工作区记忆目录的**展示路径**（末尾带分隔符，一眼看出是目录）。
 *
 * 只用于界面展示与错误信息，真实路径一律由主进程用 `node:path` 拼。
 * 之所以这里敢自己拼：渲染层拿不到 `path` 模块，而 `<home>/NanoWork` 这类
 * 主进程拼出来的路径在 Windows 用 `\`、macOS/Linux 用 `/`——照抄一个固定
 * 分隔符必然在某个平台上显示成 `D:\test/.nanowork/memory`。
 * 分隔符按**传入路径自己带的那一种**推断，是本模块能给出的最接近的答案。
 *
 * 没有工作目录时给的是兜底落点（产品目录下的 `memory/default`），
 * 与 `electron/memoryRoutes.ts` 的 `resolveWorkspaceMemoryDir` 保持一致。
 */
export function workspaceMemoryDirPath(workdir: string | null | undefined): string {
  const raw = (workdir ?? '').trim();
  if (raw === '') return `~/${WORKSPACE_MEMORY_DIR}/${WORKSPACE_MEMORY_SUBDIR}/default/`;
  const sep = raw.includes('\\') ? '\\' : '/';
  const base = raw.replace(/[\\/]+$/, '');
  return `${base}${sep}${WORKSPACE_MEMORY_DIR}${sep}${WORKSPACE_MEMORY_SUBDIR}${sep}`;
}

/**
 * 「这两次记录的工作目录还是同一个吗」——记忆快照过期判定用。
 *
 * 与 `isSameWorkspacePath` 的差别只有一处：**两侧都为空视为相同**。
 * 那个函数的契约是「任一侧为空一律 false」（`undefined` = 未指定，不是一个空路径），
 * 对侧边栏分组是对的；但快照判定里「之前没有工作目录、现在还是没有」必须算
 * 「同一份快照仍然有效」——否则每一轮发送都会判定过期、重读一次盘。
 */
export function isSameMemoryWorkspace(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ea = (a ?? '').trim();
  const eb = (b ?? '').trim();
  if (ea === '' || eb === '') return ea === eb;
  return isSameWorkspacePath(ea, eb);
}
