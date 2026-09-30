/**
 * 文件产物（工具真正写到磁盘的文件）的纯计算层。
 *
 * ## 与 `artifactExtractor` 的分工
 *
 * | 模块 | 产物来源 | 身份 |
 * |---|---|---|
 * | `ai/runtime/nanobotHttp/artifactExtractor.ts` | 回复文本里的围栏代码块 | 内容 |
 * | 本模块 | 工具调用（`write_file` / `edit` / `apply_patch`） | **路径** |
 *
 * 两者都产出 `Artifact`，但文件产物的身份是路径：同一个文件被写两次应当是
 * **同一产物的两个版本**，而不是两条记录。故本模块提供稳定的 `fileArtifactId(path)`，
 * 让 `artifactsStore.recordArtifact` 的同 id 演进逻辑天然承担「变更」语义。
 *
 * ## 为什么独立成模块
 *
 * 不 import store、不 import platform、不 import React：工具入参 → 领域产物的推导、
 * 路径身份、字节/语言/角标元信息、会话汇总全是纯计算，这样才能单测穷举
 * （与 `lib/artifactIndex.ts` 同一条纪律）。
 */

import { contentHash } from '@/lib/contentHash';
import type { Artifact, ArtifactIndexEntry } from '@/types';

/**
 * 会被认定为「文件产物」的工具（对齐 `nanobot/agent/tools/` 的写类工具注册名）。
 *
 * - `write_file`：正文可得（未走 `append` 分块时）→ 内容快照进产物，可预览、可同步；
 * - `edit_file` / `apply_patch`：只有改动片段，**拿不到改写后的全文** → 只记路径与
 *   变更，预览时按需回读磁盘（见 `lib/localFilePreview.ts`）。
 *
 * `delete_file` 刻意不在内：删除不是产出。
 * `edit` 作为 `edit_file` 的历史别名一并认（早期事件流里可能出现过）。
 */
export const FILE_WRITE_TOOLS = ['write_file', 'edit_file', 'edit', 'apply_patch'] as const;

/** 由一次工具调用推导出的文件产物草稿（尚未定 id / createdAt / change） */
export interface FileArtifactDraft {
  /** 归一化后的路径（分隔符统一为 `/`，去掉尾部 `/`） */
  path: string;
  /** 文件名（路径最后一段），作为产物标题 */
  name: string;
  /** 正文快照；改写类工具拿不到全文时为 `''` */
  content: string;
  /** 字节数；仅 `write_file`（正文可得）时给出 */
  size?: number;
  /** 由扩展名推断的高亮语言 */
  language?: string;
  /** 工具语义：write=写入（可能是新建）/ edit=改写既有文件 */
  op: 'write' | 'edit';
  /** 事件级指纹（改写类工具必带，见 `Artifact.fingerprint`） */
  fingerprint?: string;
}

/** 文件角标的色调分组（组件层据此选颜色，见 `components/artifacts/FileIcon.tsx`） */
export type FileTone =
  | 'ts'
  | 'js'
  | 'doc'
  | 'data'
  | 'markup'
  | 'style'
  | 'python'
  | 'image'
  | 'other';

/** 扩展名 → 高亮语言（SyntaxHighlighter 的语言名；未收录则退回纯文本） */
const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  sql: 'sql',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  vue: 'markup',
  svelte: 'markup',
  lua: 'lua',
  r: 'r',
  csv: 'text',
  tsv: 'text',
  txt: 'text',
  log: 'text',
};

/** 扩展名 → 角标色调 */
const EXT_TONE: Record<string, FileTone> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'data',
  jsonc: 'data',
  yml: 'data',
  yaml: 'data',
  toml: 'data',
  ini: 'data',
  conf: 'data',
  csv: 'data',
  tsv: 'data',
  md: 'doc',
  markdown: 'doc',
  txt: 'doc',
  log: 'doc',
  pdf: 'doc',
  doc: 'doc',
  docx: 'doc',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  css: 'style',
  scss: 'style',
  less: 'style',
  py: 'python',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
};

/**
 * 归一化文件路径。
 *
 * 只做三件**无歧义**的事：统一分隔符（Windows 引擎可能回 `\`）、去掉开头的
 * `./`（同一个文件的两种等价写法，不归一就会多出一条产物）、去掉尾部斜杠。
 *
 * **刻意不做大小写折叠**：Windows 上折叠能合并 `D:\a.txt` 与 `d:\a.txt`，但
 * Linux 上会把两个真实不同的文件并成一个——合并错文件比多出一条卡片更难查。
 * `../` 也不动（它会改变指向的文件）。
 */
export function normalizeFilePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const withoutDotSlash = trimmed.replace(/^(?:\.\/)+/, '');
  return withoutDotSlash.length > 1 ? withoutDotSlash.replace(/\/+$/, '') : withoutDotSlash;
}

/** 取路径最后一段作为文件名（无分隔符时就是它自己） */
export function fileBaseName(path: string): string {
  const normalized = normalizeFilePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** 取文件扩展名（小写、不含点）；无扩展名返回空串 */
export function fileExtension(name: string): string {
  const base = fileBaseName(name);
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

/**
 * 文件产物的**稳定 id**：由「会话 + 归一化路径」派生。
 *
 * 同会话内同路径 → 同 id → `recordArtifact` 走「同 id 演进」分支（内容变则升版），
 * 这正是「产物 / 变更」两个统计口径的数据基础。
 *
 * **为什么把会话也算进身份**：产物索引是**跨会话**的一张表（`index[id]` 全局唯一），
 * 若 id 只由路径决定，A 会话写过的文件在 B 会话再写时会命中 A 的条目，被
 * `bumpVersion` 就近并入 A（`sessionId` 仍是 A），B 会话的产物列表将**一条都拿不到**。
 * 会话内身份 + 索引里的 `sessionId` 才是与既有内容产物一致的口径（同内容出现在
 * 两个会话时同样各记一条，由产物库按内容折叠展示）。
 */
export function fileArtifactId(sessionId: string, path: string): string {
  // `contentHash` 返回 `sha256:<64hex>`，截前 16 位十六进制已远超实际会话规模
  return `file-${contentHash(`${sessionId}\u0000${normalizeFilePath(path)}`).slice(7, 23)}`;
}

/** 扩展名 → 高亮语言；未收录返回 undefined（渲染层退回纯文本） */
export function languageForFileName(name: string): string | undefined {
  return EXT_LANGUAGE[fileExtension(name)];
}

/** 扩展名 → 角标色组；未收录归入 `other` */
export function toneForFileName(name: string): FileTone {
  return EXT_TONE[fileExtension(name)] ?? 'other';
}

/** 角标文字：优先扩展名大写（TS / MD / JSON），无扩展名时用「·」占位 */
export function badgeForFileName(name: string): string {
  const ext = fileExtension(name);
  if (ext === '') return '·';
  return ext.length <= 4 ? ext.toUpperCase() : ext.slice(0, 3).toUpperCase();
}

/** 人类可读的体积；未知（undefined）返回空串，由调用方决定兜底文案 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** 按优先键取第一个非空字符串参数 */
function strArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** 组装草稿（统一在这里算文件名 / 语言 / 体积，避免各处重复） */
function buildDraft(
  rawPath: string,
  content: string,
  op: 'write' | 'edit',
  fingerprint?: string,
): FileArtifactDraft {
  const path = normalizeFilePath(rawPath);
  const name = fileBaseName(path);
  const draft: FileArtifactDraft = { path, name, content, op };
  // 只有拿到全文的写入才给体积：改写类工具的体积未知，不能拿片段长度冒充
  if (op === 'write') draft.size = new TextEncoder().encode(content).length;
  const language = languageForFileName(name);
  if (language) draft.language = language;
  if (fingerprint) draft.fingerprint = fingerprint;
  return draft;
}

/** `apply_patch` 的一条编辑指令（引擎入参 `edits[]` 的形状） */
interface PatchEdit {
  path?: unknown;
  action?: unknown;
}

/**
 * `apply_patch` → 逐个目标文件。
 *
 * 引擎的 `apply_patch` **不是** unified diff 文本，而是 `edits: [{path, action}]`
 * （action ∈ replace / add，一次最多 20 条）——所以一次调用可能产出**多个**文件产物。
 *
 * - `dry_run: true` 只校验不落盘 → 不产出（否则「预览了一次补丁」会凭空多出产物）；
 * - `add` 是**追加**文本（文件不存在则创建），拿不到全文 → 与 replace 同样只记路径；
 * - 同一文件被同一调用连续改两次 → 合并成一条（按路径去重，新增优先）。
 */
function derivePatchArtifacts(
  args: Record<string, unknown>,
  eventId: string,
): FileArtifactDraft[] {
  if (args.dry_run === true) return [];
  const edits = args.edits;
  if (!Array.isArray(edits)) return [];

  /** 归一化路径 → 工具语义（同一路径出现多种 action 时「新增」优先） */
  const byPath = new Map<string, 'write' | 'edit'>();
  for (const raw of edits as PatchEdit[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const path = strArg(raw as Record<string, unknown>, ['path', 'file_path']);
    if (path === undefined) continue;
    const op: 'write' | 'edit' = raw.action === 'add' ? 'write' : 'edit';
    const key = normalizeFilePath(path);
    byPath.set(key, byPath.get(key) === 'write' ? 'write' : op);
  }
  return [...byPath.entries()].map(([path, op]) => buildDraft(path, '', op, eventId));
}

/**
 * 一次工具调用 → 文件产物草稿（可能 0 个，`apply_patch` 也可能是多个）。
 *
 * 返回空数组表示「这次调用不产出文件产物」（只读工具、参数残缺、删除、dry-run）。
 * **只认成功落地的事件**：调用方必须只在工具执行成功（`phase === 'end'`）时调用，
 * 否则失败的工具也会凭空造出一张卡片。
 *
 * @param tool 工具名（引擎注册名，大小写不敏感）
 * @param args 工具入参
 * @param eventId 工具事件 id（作为改写类产物的内容指纹）
 */
export function deriveFileArtifacts(
  tool: string,
  args: Record<string, unknown>,
  eventId: string,
): FileArtifactDraft[] {
  const name = tool.trim().toLowerCase();
  // 白名单前置：只读 / 删除 / MCP / 未来新增的工具**默认不产出产物**
  // （否则每次引擎加个新工具，就可能莫名其妙多出一张产物卡片）
  if (!(FILE_WRITE_TOOLS as readonly string[]).includes(name)) return [];

  if (name === 'write_file') {
    const path = strArg(args, ['path', 'file_path']);
    if (path === undefined) return [];
    // `append=true` 是「大文件分块续写」：入参里的 content 只是**这一块**，
    // 当作全文会得到偏小的体积与残缺的预览，故按改写记录、正文留给磁盘回读。
    if (args.append === true) return [buildDraft(path, '', 'edit', eventId)];
    if (typeof args.content !== 'string') return [];
    return [buildDraft(path, args.content, 'write')];
  }

  if (name === 'edit_file' || name === 'edit') {
    const path = strArg(args, ['path', 'file_path']);
    return path === undefined ? [] : [buildDraft(path, '', 'edit', eventId)];
  }

  if (name === 'apply_patch') return derivePatchArtifacts(args, eventId);

  return [];
}

/** 是否为文件产物 */
export function isFileArtifact(artifact: Artifact): boolean {
  return artifact.type === 'file';
}

/** 在产物列表里按路径找文件产物（用于判定「新建 vs 改写既有文件」） */
/**
 * 能不能当**页面**渲染：围栏 `html` 产物，或扩展名是 html 的文件产物。
 *
 * 两类产物的正文来源不同（一个在事件里、一个要回读磁盘），但「看效果 / 看源码」
 * 这件事完全一样 —— 判据收在这里，免得渲染器与面板各写一套扩展名判断。
 */
export function isHtmlArtifact(artifact: Artifact): boolean {
  return artifact.type === 'html' || (artifact.type === 'file' && artifact.language === 'html');
}

export function findFileArtifact(
  artifacts: readonly Artifact[],
  path: string,
): Artifact | undefined {
  const target = normalizeFilePath(path);
  return artifacts.find((a) => isFileArtifact(a) && normalizeFilePath(a.path ?? '') === target);
}

/**
 * **删除类**工具（对齐 `nanobot/agent/tools/` 的删除工具注册名）。
 *
 * 与 `FILE_WRITE_TOOLS` 分列两张白名单，是因为两者在调用点的处理**方向相反**：
 * 写工具产出产物（`recordArtifact`），删除工具收回产物（`removeArtifacts`）。
 * 合成一张表的话，「删除」会被当成一次零产出的写调用被静默吞掉——于是文件已经
 * 不在了，产物面板还留着一张卡片，点「在资源管理器打开」只会报「路径不存在」
 * （2026-09-30 踩到：模型写完临时脚本、跑完自己 `delete_file` 清理）。
 */
export const DELETE_FILE_TOOLS = ['delete_file', 'remove_file'] as const;

/**
 * 一次工具调用要删掉的文件路径；不是删除工具 / 参数残缺时返回 `undefined`。
 *
 * 调用方拿到非空值就该把对应产物从消息引用与索引切片里一并摘掉（见
 * `artifactsStore.removeArtifacts`）。
 */
export function deletedFilePathFrom(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  const name = tool.trim().toLowerCase();
  if (!(DELETE_FILE_TOOLS as readonly string[]).includes(name)) return undefined;
  return strArg(args, ['path', 'file_path']);
}

/**
 * 索引条目 → 变更次数（= 版本数 - 1）。
 *
 * 优先用 `versions` 长度而非 `version` 数值：回退（`rollbackToVersion`）也会推进
 * 版本号，但真实历史条数才是「被改过几次」。索引缺失（旧数据）按 0。
 */
export function changeCountOf(entry: ArtifactIndexEntry | undefined): number {
  if (!entry) return 0;
  if (Array.isArray(entry.versions)) return Math.max(entry.versions.length - 1, 0);
  return Math.max((entry.version ?? 1) - 1, 0);
}

/** 会话内一个文件产物的视图（引用 + 版本元数据） */
export interface FileArtifactView {
  artifact: Artifact;
  /** 当前版本号（索引缺失的旧数据按 1） */
  version: number;
  /** 被再次写入 / 编辑的次数（= 版本数 - 1） */
  changes: number;
  /** 首次落库时是本会话新建（而非改写既有文件） */
  createdBySession: boolean;
}

/**
 * 会话级文件产物汇总。
 *
 * 两个口径都**按文件数**（而不是事件数）计：这样「查看所有变更 (M)」里的 M 与
 * 面板切到「变更」后列出的条数一致——数字与它指向的列表必须对得上，否则用户会
 * 以为是漏了东西。
 */
export interface FileSummary {
  /** 产物（文件）数 */
  fileCount: number;
  /** 被再次写入 / 编辑过的文件数 */
  changedFileCount: number;
}

/**
 * 会话产物 → 文件产物视图列表（按入库顺序，即产生顺序）。
 *
 * 版本元数据来自**索引切片**（`createdAt` / `versions` 是索引的权威字段），
 * `bySession` 只提供渲染所需的引用与展示字段。
 */
export function toFileViews(
  artifacts: readonly Artifact[],
  index: Record<string, ArtifactIndexEntry>,
): FileArtifactView[] {
  return artifacts.filter(isFileArtifact).map((artifact) => {
    const entry = index[artifact.id];
    return {
      artifact,
      version: entry?.version ?? 1,
      changes: changeCountOf(entry),
      createdBySession: artifact.change !== 'modified',
    };
  });
}

/** 文件产物汇总：产物数 / 被再次编辑过的文件数 */
export function summarizeFiles(views: readonly FileArtifactView[]): FileSummary {
  let changedFileCount = 0;
  for (const view of views) {
    if (view.changes > 0) changedFileCount += 1;
  }
  return { fileCount: views.length, changedFileCount };
}