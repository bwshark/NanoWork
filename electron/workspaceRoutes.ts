/**
 * 右侧边栏「查看工作空间 / 查看变更」两个标签页的数据来源（主进程）。
 *
 * 这里的边界很窄，只有四件事：**列目录、读文本、查改动、取 diff**。之所以都放
 * 主进程而不是渲染层：
 *
 * - 浏览器里没有文件系统（Web 端整块功能如实降级，见 `src/platform/index.ts`）；
 * - `git` 是子进程，渲染层起不了；
 * - 读盘与执行命令的路径校验只有在主进程做才有意义（渲染层给的路径不可信）。
 *
 * ## 为什么用 `execFile` 而不是拼 shell 命令
 *
 * diff 的 pathspec 来自文件树，可能含空格、`&`、引号甚至 `;`。走 `execFile('git', [...])`
 * 参数不过 shell，注入面为零；Windows 上也少了 cmd 的一层转义规则。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ipcMain } from 'electron';
import type {
  GitDiffResult,
  GitFileChange,
  GitFileStatus,
  GitStatusResult,
  WorkspaceEntry,
  WorkspaceListResult,
  WorkspaceReadResult,
} from '../src/types/workspace';

/** 一次列目录最多返回多少项：`node_modules` 那种目录会瞬间产出上万条 */
const MAX_ENTRIES = 800;
/** 文本预览上限：再大就不是「看一眼」而是「打开编辑器」了 */
const MAX_TEXT_BYTES = 512 * 1024;
/** 二进制嗅探窗口（前若干字节出现 NUL 即判定为二进制） */
const BINARY_SNIFF_BYTES = 8192;
/** 未跟踪文件合成 patch 的行数上限（避免整份大文件塞进界面） */
const MAX_SYNTH_LINES = 3000;
/** git 输出上限：大仓库的完整 diff 可能几十 MB，超出就是用法问题，不该把主进程拖死 */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      // `core.quotepath=false`：否则中文文件名会被转成 `\346\226\207` 这种八进制转义，
      // 既显示不成样子，也匹配不上 diff --numstat 的路径
      ['-c', 'core.quotepath=false', '-C', cwd, ...args],
      { maxBuffer: GIT_MAX_BUFFER, windowsHide: true, timeout: 20_000 },
      (err, stdout, stderr) => {
        resolvePromise({
          ok: err === null,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        });
      },
    );
  });
}

/** 目录列举：目录优先、同类按名字排序（与资源管理器一致） */
export async function listDirectory(dir: string): Promise<WorkspaceListResult> {
  const target = typeof dir === 'string' ? dir.trim() : '';
  if (target === '') return { ok: false, entries: [], error: '未指定目录' };
  try {
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries: WorkspaceEntry[] = [];
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) break;
      const isDir = dirent.isDirectory();
      let size: number | undefined;
      if (!isDir) {
        // 大小只对文件有意义，且 stat 失败（权限 / 竞态）不该让整个目录列不出来
        size = await fs
          .stat(join(target, dirent.name))
          .then((s) => s.size)
          .catch(() => undefined);
      }
      entries.push({ name: dirent.name, dir: isDir, size });
    }
    entries.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return { ok: true, entries, ...(dirents.length > entries.length ? { truncated: true } : {}) };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 只读读取文本文件（超限截断、二进制识别） */
export async function readTextFile(filePath: string): Promise<WorkspaceReadResult> {
  const target = typeof filePath === 'string' ? filePath.trim() : '';
  if (target === '') return { ok: false, error: '未指定文件' };
  let handle: FileHandle | undefined;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return { ok: false, error: '不是一个文件' };
    handle = await fs.open(target, 'r');
    const size = Math.min(stat.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { ok: true, binary: true, size: stat.size };
    }
    return {
      ok: true,
      content: chunk.toString('utf8'),
      size: stat.size,
      ...(stat.size > MAX_TEXT_BYTES ? { truncated: true } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** porcelain 的两字母状态 → 界面用的单一状态 */
export function mapStatus(x: string, y: string): GitFileStatus {
  if (x === '?' || y === '?') return 'untracked';
  // 冲突态：两边都改（UU / AA / DD）或任一边是 U（未合并）
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflicted';
  }
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

/**
 * `--numstat` 里的路径归一。
 *
 * 重命名会写成 `old => new`，公共前缀相同则是 `dir/{a => b}/f` —— 两种都要还原成
 * **新路径**，否则和 porcelain 的路径对不上，行数统计会静默变成 0。
 */
export function numstatPath(raw: string): string {
  if (!raw.includes('=>')) return raw.trim();
  if (raw.includes('{') && raw.includes('}')) {
    return raw
      .replace(/\{([^{}]*) => ([^{}]*)\}/g, (_m, _a, b: string) => b)
      .replace(/\/{2,}/g, '/')
      .trim();
  }
  const parts = raw.split(' => ');
  return parts[parts.length - 1].trim();
}

/** 数一个未跟踪文件的行数（git 不管它，界面又要有 +N） */
async function countLines(filePath: string): Promise<{ added: number; removed: number }> {
  const text = await readTextFile(filePath);
  if (!text.ok || text.binary || text.content === undefined) return { added: 0, removed: 0 };
  const lines = text.content.split('\n').length - (text.content.endsWith('\n') ? 1 : 0);
  return { added: Math.max(0, lines), removed: 0 };
}

export async function gitStatus(dir: string): Promise<GitStatusResult> {
  const cwd = typeof dir === 'string' ? dir.trim() : '';
  const empty: GitStatusResult = { ok: false, isRepo: false, files: [], added: 0, removed: 0 };
  if (cwd === '') return { ...empty, error: '未指定工作空间' };

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return {
      ...empty,
      // git 不存在（ENOENT）与「这里不是仓库」要分开说：前者要用户装 git，后者只需换个目录
      error: inside.ok
        ? '这个目录不是 git 仓库'
        : inside.stderr.includes('not found') || inside.stderr.includes('ENOENT')
          ? '未找到 git 命令'
          : '无法读取 git 状态',
    };
  }

  const porcelain = await runGit(cwd, ['status', '--porcelain=v1', '-uall']);
  if (!porcelain.ok) return { ...empty, isRepo: true, error: porcelain.stderr.trim() || '读取改动失败' };

  // 行数：优先与 HEAD 比（暂存 + 未暂存一起看）。全新仓库还没有 HEAD，退一步只看暂存区
  let numstat = await runGit(cwd, ['diff', 'HEAD', '--numstat']);
  if (!numstat.ok) numstat = await runGit(cwd, ['diff', '--cached', '--numstat']);

  const lineMap = new Map<string, { added: number; removed: number }>();
  for (const line of numstat.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [addedRaw, removedRaw, ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    // 二进制文件的增删是 `-`，按 0 计（界面上不显示 +0 -0）
    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw, 10) || 0;
    const removed = removedRaw === '-' ? 0 : Number.parseInt(removedRaw, 10) || 0;
    lineMap.set(numstatPath(rest.join('\t')), { added, removed });
  }

  const files: GitFileChange[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const line of porcelain.stdout.split('\n')) {
    if (line.length < 4) continue;
    const status = mapStatus(line[0], line[1]);
    let filePath = line.slice(3);
    if (status === 'renamed') {
      filePath = filePath.split(' -> ').pop() ?? filePath;
    }
    let counts = lineMap.get(filePath);
    if (!counts && status === 'untracked') {
      counts = await countLines(join(cwd, filePath));
    }
    const added = counts?.added ?? 0;
    const removed = counts?.removed ?? 0;
    totalAdded += added;
    totalRemoved += removed;
    files.push({ path: filePath, status, added, removed });
  }

  return { ok: true, isRepo: true, files, added: totalAdded, removed: totalRemoved };
}

/** 把整个文件合成为「全新增」的 patch（未跟踪文件没有 diff 可看） */
async function synthesizeNewFilePatch(cwd: string, relPath: string): Promise<string> {
  const read = await readTextFile(join(cwd, relPath));
  if (!read.ok) return '';
  if (read.binary) return `diff --git a/${relPath} b/${relPath}\n新文件（二进制，无法按文本对比）\n`;
  const lines = (read.content ?? '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, MAX_SYNTH_LINES);
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${shown.length} @@`,
  ];
  const body = shown.map((line) => `+${line}`);
  if (lines.length > shown.length) body.push(`… 还有 ${lines.length - shown.length} 行未显示`);
  return [...header, ...body].join('\n');
}

export async function gitDiff(dir: string, relPath: string): Promise<GitDiffResult> {
  const cwd = typeof dir === 'string' ? dir.trim() : '';
  const rel = typeof relPath === 'string' ? relPath.trim() : '';
  if (cwd === '' || rel === '') return { ok: false, patch: '', error: '参数不完整' };

  // 路径必须落在工作目录内：`git diff -- ../../etc/passwd` 只是在读仓库外文件，
  // 但那不是界面能做的事，也没有理由让它成为一条通路
  const absolute = resolve(cwd, rel);
  if (!absolute.startsWith(resolve(cwd))) {
    return { ok: false, patch: '', error: '路径越界' };
  }

  let patch = await runGit(cwd, ['diff', 'HEAD', '--', rel]);
  if (!patch.ok) patch = await runGit(cwd, ['diff', '--cached', '--', rel]);
  if (!patch.ok) return { ok: false, patch: '', error: patch.stderr.trim() || '读取 diff 失败' };

  let text = patch.stdout;
  // 未跟踪文件在 diff 里完全不存在（git 不管它）→ 按「全新增」合成一份，
  // 否则用户点开一个刚创建的文件只会看到空白，以为界面坏了
  if (text.trim() === '') {
    const exists = await fs
      .stat(absolute)
      .then((s) => s.isFile())
      .catch(() => false);
    if (exists) text = await synthesizeNewFilePatch(cwd, rel);
  }
  return { ok: true, patch: text };
}

/** 注册工作空间相关 IPC（`main.ts` 调用一次） */
export function registerWorkspaceRoutes(): void {
  ipcMain.handle('workspace:listDir', (_e, dir: unknown) =>
    listDirectory(typeof dir === 'string' ? dir : ''),
  );
  ipcMain.handle('workspace:readText', (_e, filePath: unknown) =>
    readTextFile(typeof filePath === 'string' ? filePath : ''),
  );
  ipcMain.handle('git:status', (_e, dir: unknown) => gitStatus(typeof dir === 'string' ? dir : ''));
  ipcMain.handle('git:diff', (_e, dir: unknown, relPath: unknown) =>
    gitDiff(typeof dir === 'string' ? dir : '', typeof relPath === 'string' ? relPath : ''),
  );
}

