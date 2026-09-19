import { promises as fs, existsSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  fileBackupPath,
  projectsDir,
  sessionIndexPath,
  sessionJsonlPath,
  sessionMetaPath,
} from './eventRoutes';
import {
  applyAppend,
  countEvents,
  deriveMetaFromEvents,
  emptySessionIndex,
  parseSessionIndex,
  parseSessionMeta,
  rebuildSessionIndex as buildIndexFromMetas,
  removeSessionEntry,
  serializeSessionIndex,
} from './eventIndex';
import type { StorageRoots } from './storageRoutes';
import type { EventAppendParams, EventAppendResult } from '../src/platform/types';
import type { SessionCounters } from '../src/events/indexFile';
import type {
  SessionEvent,
  SessionIndexFile,
  SessionMeta,
} from '../src/types/event';

/**
 * 事件流存储的 IO 层（D2 第 9.3 节的落地）。
 *
 * ## 三层分工
 *
 * | 层 | 文件 | 职责 | 有无副作用 |
 * |---|---|---|---|
 * | 路由 | `eventRoutes.ts` | 参数 → 绝对路径 + 安全校验 | 无（纯函数） |
 * | 索引 | `eventIndex.ts` | 索引投影 / 重建 / 排序 | 无（纯函数） |
 * | IO | **本文件** | 读 / 追加 / 删文件，串起上面两层 | 有（fs） |
 *
 * 把 IO 独立成「只依赖 node:fs」的模块（**不 import electron**），是为了让它能被
 * 普通单测覆盖：传入临时目录即可跑完整的「追加 → 索引 → 重建」链路，不必启动
 * Electron。`main.ts` 只做一件事——把本模块的方法挂到 IPC 上。
 *
 * ## 格式归主进程所有
 *
 * 磁盘格式（JSONL 逐行编码、`meta.json` / `sessions.json` 的结构）是本模块的
 * 内部细节：对外的入参与出参都是**领域对象**（`SessionEvent` / `SessionMeta` /
 * `SessionIndexFile`）。渲染层因此完全不需要知道「事件怎么落盘」，也就无法
 * 绕过契约直接拼磁盘格式。解析失败一律降级（索引 → 空索引、事件 → 跳过坏行），
 * 因为权威数据仍在 JSONL 原文里，随时可重建。
 *
 * ## append-only
 *
 * 事件流的写入只有「追加」一种：不读全文再重写，也不修改既有行。这既保证并发
 * 追加安全（同文件由内部写队列串行化），也让 `seq` 能作为稳定的续写游标。
 */
export interface EventStore {
  /** 追加事件并同步维护索引；返回最新计数 */
  append(params: EventAppendParams): Promise<EventAppendResult>;
  /** 读取会话的全部事件（坏行跳过） */
  readEvents(sessionId: string, workdir?: string | null): Promise<SessionEvent[]>;
  /** 删除会话的事件流与元数据，并移除索引条目（幂等） */
  remove(sessionId: string, workdir?: string | null): Promise<void>;
  /** 读取会话元数据；不存在返回 null */
  readMeta(sessionId: string, workdir?: string | null): Promise<SessionMeta | null>;
  /** 覆盖写入会话元数据（会话 id / 工作空间取自 meta 自身） */
  writeMeta(meta: SessionMeta): Promise<void>;
  /** 扫描各工作空间目录里的全部会话元数据（磁盘发现 / 索引重建） */
  listMetas(): Promise<SessionMeta[]>;
  /** 读取会话索引；不存在或损坏返回空索引 */
  readIndex(): Promise<SessionIndexFile>;
  /** 全量重建索引并落盘；返回重建后的索引 */
  rebuildIndex(): Promise<SessionIndexFile>;
  /** 内容寻址备份：写入 `<hash>.bak`（已存在则跳过） */
  putBackup(hash: string, content: string): Promise<void>;
  /** 内容寻址备份：读取 `<hash>.bak`；不存在返回 null */
  getBackup(hash: string): Promise<string | null>;
}

/** 读取任意文件原文；不存在返回 null，其余错误照抛（不吞 EACCES 等问题） */
async function readTextFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 解析 JSONL 原文为事件数组。
 *
 * **逐行容错**：单行损坏只跳过该行，不因一行坏数据丢掉整段历史——事件流原文
 * 始终留在磁盘上，索引与视图可以据此降级重建。
 */
export function parseEventJsonl(raw: string | null): SessionEvent[] {
  if (!raw) return [];
  const events: SessionEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as SessionEvent);
    } catch {
      // 跳过损坏行
    }
  }
  return events;
}

/**
 * 构造绑定到某组存储根的事件流存储。
 *
 * 写队列按**实例**持有：主进程只有一个实例，因而同一文件的读改写天然串行
 * （避免两次并发追加各自读到旧索引、后写者覆盖先写者）。
 */
export function createEventStore(roots: StorageRoots): EventStore {
  /** 逐文件串行写队列：避免同文件的 read-modify-write 交叉导致丢失更新 */
  const writeQueues = new Map<string, Promise<void>>();

  function enqueueWrite(filePath: string, task: () => Promise<void>): Promise<void> {
    const previous = writeQueues.get(filePath) ?? Promise.resolve();
    // 前一任务失败不应阻断后续写入，故成功/失败分支都续接
    const next = previous.then(task, task);
    writeQueues.set(
      filePath,
      next.catch(() => undefined),
    );
    return next;
  }

  async function readMeta(
    sessionId: string,
    workdir?: string | null,
  ): Promise<SessionMeta | null> {
    return parseSessionMeta(
      await readTextFileOrNull(sessionMetaPath(roots, sessionId, workdir)),
    );
  }

  /** 扫描各工作空间目录里的全部会话元数据（单目录/单文件失败只跳过） */
  async function listMetas(): Promise<SessionMeta[]> {
    const root = projectsDir(roots);
    let dirs: Dirent[];
    try {
      dirs = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = join(root, dir.name);
      let files: Dirent[];
      try {
        files = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.meta.json')) continue;
        const meta = parseSessionMeta(await readTextFileOrNull(join(dirPath, file.name)));
        if (meta) metas.push(meta);
      }
    }
    return metas;
  }

  /**
   * 把一次追加投影进索引文件。
   *
   * 索引是**可再生派生物**（权威在 JSONL 与 meta），故此处的失败不影响事件正文；
   * 索引损坏时 `parseSessionIndex` 返回空索引，随后被本次投影 + 后续追加补齐。
   */
  async function projectAppendIntoIndex(
    sessionId: string,
    workdir: string | null | undefined,
    appended: readonly SessionEvent[],
  ): Promise<EventAppendResult> {
    const indexPath = sessionIndexPath(roots);
    let result: EventAppendResult = { lastSeq: 0, eventCount: 0 };
    await enqueueWrite(indexPath, async () => {
      const index = parseSessionIndex(await readTextFileOrNull(indexPath));
      let meta = await readMeta(sessionId, workdir);
      if (!meta) {
        // meta 缺失（异常或旧数据）：从事件流就地推导一份最小可用元数据。
        // 否则 applyAppend 在「无 meta 且无既有条目」时无处可依，会话会在列表里消失。
        const all = parseEventJsonl(
          await readTextFileOrNull(sessionJsonlPath(roots, sessionId, workdir)),
        );
        if (all.length > 0) meta = deriveMetaFromEvents(sessionId, all);
      }
      const next = applyAppend(index, meta, appended, sessionId);
      // 无 meta 且无追加（且此前也无条目）时索引不变，无需落盘
      if (next !== index) {
        await fs.mkdir(dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, serializeSessionIndex(next), 'utf-8');
      }
      const entry = next.entries[sessionId];
      result = { lastSeq: entry?.lastSeq ?? 0, eventCount: entry?.eventCount ?? 0 };
    });
    return result;
  }

  return {
    async append({ sessionId, workdir, events }): Promise<EventAppendResult> {
      if (events.length > 0) {
        // 编码归本模块所有：JSONL = 每行一个 JSON 事件
        const payload = events.map((ev) => `${JSON.stringify(ev)}\n`).join('');
        const jsonlPath = sessionJsonlPath(roots, sessionId, workdir);
        await enqueueWrite(jsonlPath, async () => {
          await fs.mkdir(dirname(jsonlPath), { recursive: true });
          await fs.appendFile(jsonlPath, payload, 'utf-8');
        });
      }
      return projectAppendIntoIndex(sessionId, workdir, events);
    },

    async readEvents(sessionId, workdir) {
      return parseEventJsonl(
        await readTextFileOrNull(sessionJsonlPath(roots, sessionId, workdir)),
      );
    },

    async remove(sessionId, workdir) {
      await fs.rm(sessionJsonlPath(roots, sessionId, workdir), { force: true });
      await fs.rm(sessionMetaPath(roots, sessionId, workdir), { force: true });
      const indexPath = sessionIndexPath(roots);
      await enqueueWrite(indexPath, async () => {
        const index = parseSessionIndex(await readTextFileOrNull(indexPath));
        const next = removeSessionEntry(index, sessionId);
        if (next !== index) {
          await fs.mkdir(dirname(indexPath), { recursive: true });
          await fs.writeFile(indexPath, serializeSessionIndex(next), 'utf-8');
        }
      });
    },

    readMeta,

    async writeMeta(meta) {
      const metaPath = sessionMetaPath(roots, meta.id, meta.workdir);
      const json = JSON.stringify(meta);
      await enqueueWrite(metaPath, async () => {
        await fs.mkdir(dirname(metaPath), { recursive: true });
        await fs.writeFile(metaPath, json, 'utf-8');
      });
    },

    listMetas,

    async readIndex() {
      const raw = await readTextFileOrNull(sessionIndexPath(roots));
      return raw === null ? emptySessionIndex() : parseSessionIndex(raw);
    },

    async rebuildIndex() {
      const metas = await listMetas();
      // 计数一律从 JSONL 现算（含 messageCount）：索引丢弃重建时它是唯一来源，
      // 算漏了就会把有对话记录的任务显示成空会话（见 SessionIndexEntry.messageCount）
      const counters: Record<string, SessionCounters> = {};
      for (const meta of metas) {
        const events = parseEventJsonl(
          await readTextFileOrNull(sessionJsonlPath(roots, meta.id, meta.workdir)),
        );
        counters[meta.id] = countEvents(events);
      }
      const index = buildIndexFromMetas(metas, counters);
      const indexPath = sessionIndexPath(roots);
      await enqueueWrite(indexPath, async () => {
        await fs.mkdir(dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, serializeSessionIndex(index), 'utf-8');
      });
      return index;
    },

    async putBackup(hash, content) {
      const target = fileBackupPath(roots, hash);
      // 内容寻址天然幂等：同 hash 即同内容，已存在直接跳过
      if (existsSync(target)) return;
      await enqueueWrite(target, async () => {
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
      });
    },

    async getBackup(hash) {
      return readTextFileOrNull(fileBackupPath(roots, hash));
    },
  };
}
