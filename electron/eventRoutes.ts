import { join, resolve, sep } from 'node:path';
import { SESSION_INDEX_VERSION } from '../src/events/indexFile';
import { sanitizeSegment, type StorageRoots } from './storageRoutes';

/**
 * 事件流落点路由表（Electron 主进程专用，D2 第 9.3 节的落地）。
 *
 * ## 目录布局
 *
 * ```
 * <userData>/projects/<slug>/<sessionId>.jsonl          # 事件正文（逐行一个 JSON）
 * <userData>/projects/<slug>/<sessionId>.meta.json      # 会话元数据
 * <userData>/index/sessions.json                        # 会话索引（列表查询用）
 * <userData>/file-history/<hash>.bak                    # 内容寻址的文件备份
 * ```
 *
 * ## 归属：为什么全部落在 ② `<userData>`
 *
 * 事件流与索引都是「随会话产生」的运行时数据，不是用户手写可编辑的资产，
 * 因此与 `storageRoutes` 中 `sessions`/`tasks`/`artifacts` 同属 ②，不占 ①
 * `~/.nanowork/`。用户可见可改的资产（settings / mcp / experts / memory）才落 ①。
 *
 * ## 两个「sessions.json」不要混淆
 *
 * - `<userData>/sessions.json` —— **旧**的整块持久化 blob（zustand persist），
 *   D2 的迁移输入，由 `storageRoutes` 的 `RUNTIME_FILES` 管理；
 * - `<userData>/index/sessions.json` —— **新**的会话索引（本模块）。
 *
 * 同名的原因是设计文档把索引层写作 `index/sessions.db`（SQLite）；本项目 V1
 * 改用 JSON 文件（见 `SessionIndexFile` 的注释），保留同名路径形态以便未来替换。
 *
 * ## 本模块保持纯函数
 *
 * 只做「参数 → 绝对路径」的映射与安全校验，**不 import electron、不碰 fs**，
 * 因而可被单测直接覆盖（与 `storageRoutes` 同一约定）。
 */

/** 项目（工作空间）目录名 */
export const PROJECTS_DIR_NAME = 'projects';
/** 索引目录名 */
export const EVENT_INDEX_DIR_NAME = 'index';
/** 文件备份目录名 */
export const FILE_HISTORY_DIR_NAME = 'file-history';
/** 会话索引文件名 */
export const SESSION_INDEX_FILE_NAME = 'sessions.json';
/** 未指定工作空间的会话归入的 slug */
export const DEFAULT_PROJECT_SLUG = 'default';
/** 事件正文扩展名 */
export const JSONL_EXT = '.jsonl';
/** 会话元数据扩展名 */
export const META_EXT = '.meta.json';

/**
 * 会话索引的 schema 版本（与 `SessionIndexFile.version` 对齐）。
 * 定义在 `src/events/indexFile.ts`（渲染层与主进程共用），此处再导出。
 */
export { SESSION_INDEX_VERSION };

/** 事件数据根：② Electron userData */
export function eventsRoot(roots: StorageRoots): string {
  return roots.electronUserData;
}

/** `<userData>/projects/` */
export function projectsDir(roots: StorageRoots): string {
  return join(eventsRoot(roots), PROJECTS_DIR_NAME);
}

/** `<userData>/index/` */
export function eventIndexDir(roots: StorageRoots): string {
  return join(eventsRoot(roots), EVENT_INDEX_DIR_NAME);
}

/** `<userData>/file-history/` */
export function fileHistoryDir(roots: StorageRoots): string {
  return join(eventsRoot(roots), FILE_HISTORY_DIR_NAME);
}

/**
 * 把工作空间路径编码为**单层**目录名，形如 `-Users-foo-bar`
 * （对齐 WorkBuddy 的 `<cwd-slug>` 形态；未指定工作空间则为 `default`）。
 *
 * 设计取舍：
 * - **可读性优先**：让用户直接浏览 `projects/` 就能认出是哪个目录；
 * - **允许碰撞**：不同路径理论上可能编出同名 slug（如 `/a-b/c` 与 `/a/b-c`），
 *   但目录内的文件名一律以 `sessionId` 命名，碰撞只会让两个工作空间共享一个
 *   目录，**不会丢数据也不会串会话**，故不引入哈希后缀换取简洁。
 * - 先 `sanitizeSegment` 逐段收敛，天然消除 `..`、Windows 保留名与非法字符。
 */
export function cwdSlug(workdir?: string | null): string {
  const raw = (workdir ?? '').trim();
  if (!raw) return DEFAULT_PROJECT_SLUG;
  const normalized = raw
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .replace(/\/+$/, '');
  const segments = normalized
    .split('/')
    .map((segment) => sanitizeSegment(segment))
    .filter((segment) => segment && segment !== 'unnamed');
  if (segments.length === 0) return DEFAULT_PROJECT_SLUG;
  const slug = `-${segments.join('-')}`;
  return slug.length > 120 ? slug.slice(0, 120) : slug;
}

/** 某个工作空间对应的事件目录 `<userData>/projects/<slug>/` */
export function projectDir(roots: StorageRoots, workdir?: string | null): string {
  return join(projectsDir(roots), cwdSlug(workdir));
}

/** 单层路径片段的安全校验：首字符必须是字母或数字（挡掉 `.`/`..`/隐藏文件） */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** 判断一个片段能否安全地作为单层文件名使用 */
export function isSafeSegment(segment: string): boolean {
  return typeof segment === 'string' && SAFE_SEGMENT.test(segment);
}

/**
 * 校验并返回安全片段；不合法时抛错。
 *
 * 越界（`../`）或非法字符来自「会话 id / 备份 hash」这类由上层传入的值：
 * 它们是路径的最后一段，一旦带分隔符就会写出目录树之外。此处**拒绝**而非
 * 静默清洗——静默清洗会把「上层传了脏值」这个 bug 藏起来。
 */
export function assertSafeSegment(segment: string, what: string): string {
  if (!isSafeSegment(segment)) {
    throw new Error(`[events] 非法的${what}: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/** 事件正文路径 `<userData>/projects/<slug>/<sessionId>.jsonl` */
export function sessionJsonlPath(
  roots: StorageRoots,
  sessionId: string,
  workdir?: string | null,
): string {
  assertSafeSegment(sessionId, '会话 id');
  return join(projectDir(roots, workdir), `${sessionId}${JSONL_EXT}`);
}

/** 会话元数据路径 `<userData>/projects/<slug>/<sessionId>.meta.json` */
export function sessionMetaPath(
  roots: StorageRoots,
  sessionId: string,
  workdir?: string | null,
): string {
  assertSafeSegment(sessionId, '会话 id');
  return join(projectDir(roots, workdir), `${sessionId}${META_EXT}`);
}

/** 会话索引路径 `<userData>/index/sessions.json` */
export function sessionIndexPath(roots: StorageRoots): string {
  return join(eventIndexDir(roots), SESSION_INDEX_FILE_NAME);
}

/** 文件备份路径 `<userData>/file-history/<hash>.bak` */
export function fileBackupPath(roots: StorageRoots, hash: string): string {
  assertSafeSegment(hash, '备份 hash');
  return join(fileHistoryDir(roots), `${hash}.bak`);
}

/** 旧整块持久化 blob 路径 `<userData>/sessions.json`（D2 迁移输入） */
export function legacySessionsBlobPath(roots: StorageRoots): string {
  return join(eventsRoot(roots), 'sessions.json');
}

/**
 * 把事件数据的读取目标规整为绝对路径并做安全校验。
 *
 * 允许的根只有三个（projects/ index/ file-history/），且要求命中的根以分隔符
 * 结尾，避免 `/u/data` 命中 `/u/data-evil`。返回 `null` 表示越界，调用方应拒绝。
 *
 * 读取侧不需要允许「用户主目录 / ~/.nanowork」——事件数据不落那里，放宽只会
 * 扩大越界面。
 */
export function resolveEventReadTarget(
  filePath: string,
  roots: StorageRoots,
): string | null {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return null;
  const target = resolve(filePath);
  const safeRoots = [projectsDir(roots), eventIndexDir(roots), fileHistoryDir(roots)];
  const isSafe = safeRoots.some(
    (root) => target === resolve(root) || target.startsWith(resolve(root) + sep),
  );
  return isSafe ? target : null;
}
