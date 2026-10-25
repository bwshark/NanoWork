/**
 * 工作目录 → 工作区标识的纯逻辑。
 *
 * ## 为什么单独一个模块
 *
 * 这个函数本来住在 `src/lib/memory/memory.ts` 里，而 `memory/memory.ts` import 了 `@/platform`
 * ——渲染层专有。但主进程做**旧记忆懒迁移**时也要算同一个 key（旧文件是按
 * `~/.nanowork/memory/<key>.md` 命名的，不重算就找不回它）。主进程 import
 * 渲染层的 platform 会直接崩，所以把这段无依赖的纯函数挪出来：
 * `memory/memory.ts`（渲染层）与 `electron/workspaceMemoryStore.ts`（主进程）共用一份。
 *
 * 本模块**不得** import 任何渲染层或 electron 的东西，否则又会把两边绑死。
 */

/**
 * 兜底工作区标识：没有工作目录的会话（IM 会话、存储设置之前建的旧会话）用它。
 *
 * 落点是 `<产品目录>/memory/default/`（新目录形态）或
 * `<产品目录>/memory/default.md`（旧单文件形态，仅剩迁移读取）。
 */
export const DEFAULT_WORKSPACE_KEY = 'default';

/**
 * 轻量内容哈希（djb2），用于工作区标识与记忆块去重。
 * 纯函数实现，故渲染层与主进程都能用（无 node:crypto 依赖）。
 */
export function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  // 转无符号 32 位十六进制
  return (h >>> 0).toString(16);
}

/**
 * 工作目录 → 工作区标识。
 *
 * 形态 `<basename>-<hash8>`：`D:\Workspace\study\foo` → `foo-1a2b3c4d`。
 *
 * ## 它现在还负责什么（用途已经变了，别按老注释理解）
 *
 * 工作区记忆**不再以它命名文件**——新落点是 `<workdir>/.nanowork/memory/`，
 * 由目录本身表达隔离，与这个标识无关。它现在只剩三个职责：
 *
 * 1. **Web 端身份**：浏览器没有文件系统，localStorage 里的记忆目录要有个 id，
 *    这是那个 id；
 * 2. **旧数据定位**：`~/.nanowork/memory/<key>.md` 的懒迁移要靠它反查；
 * 3. **无工作目录的兜底**：`default`。
 *
 * 保留形如 `<basename>-<hash8>` 的形态是为了让 (1)(2) 与历史数据逐字节对齐——
 * 改算法就等于让所有 Web 端记忆与待迁移的旧文件失联。
 *
 * - **带 basename**：文件名要能被用户一眼认出来（纯哈希会让「去哪个文件找记忆」
 *   变成猜谜）。
 * - **带 hash**：同名目录（两个项目都有 `src`）不能互相覆盖记忆。
 * - **归一化只做三件事**（反斜杠→斜杠、去尾斜杠、转小写）：Windows 路径大小写
 *   不敏感，`D:\Work` 与 `d:/work/` 必须落同一个 key，否则同一个工作区的记忆会被
 *   劈成两半——这是最难排查的一类「记忆时有时无」。
 * - **无 workdir → `default`**：与历史记忆保持连续，升级不会让老记忆失联。
 * - **字符集收敛到 `[a-z0-9._-]`**：主进程 `sanitizeSegment` 会再做一次白名单清洗，
 *   这里先收敛是为了让**渲染层看到的 key 与落盘文件名一致**（否则「导出」的
 *   默认文件名会与磁盘上的真实文件对不上）。
 */
export function workspaceKeyFor(workdir: string | undefined | null): string {
  const raw = (workdir ?? '').trim();
  if (raw === '') return DEFAULT_WORKSPACE_KEY;

  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (normalized === '') return DEFAULT_WORKSPACE_KEY;

  const parts = normalized.split('/').filter((p) => p !== '');
  const base = (parts[parts.length - 1] ?? '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '')
    .slice(0, 24);

  const hash = hashContent(normalized).padStart(8, '0');
  return base === '' ? hash : `${base}-${hash}`;
}
