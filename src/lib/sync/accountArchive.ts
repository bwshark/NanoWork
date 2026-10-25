/**
 * 账户归档（数据主权 FR-10.6，批次 6a）的纯函数 + IO 注入。
 *
 * 与 `sync/syncMeta.ts` / `channel/channelSecrets.ts` 同一条纪律：**纯逻辑不碰 IO**，因而可真单测
 * ——`buildArchive` / `parseArchive` / `applyArchive` / `archiveFileName` 都不 import
 * `platform`，落盘由调用方把 `write` 注入进来。
 *
 * ## 归档是自描述且无损的（D7）
 *
 * `buildArchive()` → `JSON.stringify` → `parseArchive()` → `applyArchive(writer)` 往返后，
 * 每个本地 key 的字符串与原始值**逐字节相同**。这条能成立的关键是：
 * **`local` 段逐 key 存原始字符串**（`platform.storage.get<string>(key)` 拿到的就是它），
 * **绝不解析再序列化**——那会改变字节（键顺序、空白、数字格式），往返就不再无损，
 * 「可重新导入」的承诺随之落空。
 *
 * ## 导入 UI（D7 已补齐，批次 6a）
 *
 * 归档既能**程序化**导入（`applyArchive`），也提供了 UI 入口：`platform.pickFile()`
 * 是新增的「选择文件」平台能力（Web 走 `<input type=file>` + `file.text()`、Electron 走
 * `dialog.showOpenDialog` openFile + `fs.readFileSync` 读 UTF-8），返回 `{ name, content }`
 * （Web 端无路径，只给内容）。`AccountSection` 的「导入归档」按钮调 `pickFile` → `parseArchive`
 * → `applyArchive(arch, (k,v) => platform.storage.set(k,v))`，只写回 `local` 段。
 * 原 spec §6 的「已知偏差」已闭合（见 `docs/architecture-m6-sync.md` §七 6a 行）。
 */

import {
  IDENTITY_STORAGE_KEYS,
  PROMPT_KEY_PREFIX,
  STORAGE_KEYS,
  USER_MEMORY_KEY,
} from '@/lib/core/constants';
import { PROMPT_SLOTS } from '@/lib/prompt/promptCatalog';
import type { CloudExport } from '@/sync/types';
import type { SessionEvent, SessionMeta } from '@/types/event';

/** 归档格式标识（`format` 字段的值）。 */
export const ARCHIVE_FORMAT = 'nanowork-archive';

/** 本端支持的归档版本；读到更高的 `formatVersion` 一律拒绝（J-C3）。 */
export const ARCHIVE_FORMAT_VERSION = 2;

/**
 * `local` 段覆盖的 storage key 全集。
 *
 * 规则（spec D3）：`STORAGE_KEYS` 全表**除** `activeSession` / `legacySessions`
 * 之外的全部 + `IDENTITY_STORAGE_KEYS` 四个 + `USER_MEMORY_KEY`。
 *
 * - 去掉 `activeSession`：它是纯 UI 状态（「光标在哪」），不是用户数据；
 * - 去掉 `legacySessions`：已废弃的历史会话整块快照，既不再读也不再写；
 * - **不含** `nanowork.sync.*` 运行时键（账户 token / 事件水位 / 冲突快照）：
 *   那是本机运行态，不是用户数据（D4）。
 *
 * 集中在常量表推导而不是手抄一份，避免「新增一个 store 却忘了进导出」。
 */
export const ARCHIVE_LOCAL_KEYS: readonly string[] = [
  ...Object.values(STORAGE_KEYS).filter(
    (key) => key !== STORAGE_KEYS.activeSession && key !== STORAGE_KEYS.legacySessions,
  ),
  ...Object.values(IDENTITY_STORAGE_KEYS),
  USER_MEMORY_KEY,
  // 提示词外置覆盖（批次 6b，6a 的 D4 已知偏差 #2）：按 `PROMPT_SLOTS` 静态表展开。
  // `StorageAdapter` 没有 `keys()`，动态 key 无法枚举——而 UI 只认表内的槽位，
  // 故枚举这张表就是「全部合法覆盖」。
  ...PROMPT_SLOTS.map((slot) => `${PROMPT_KEY_PREFIX}${slot.kind}.${slot.key}`),
];

/** 归档里的账户元信息（未登录为 null）。 */
export interface ArchiveAccount {
  userId: string;
  email: string;
}

/** 归档的会话段：全部 meta + 逐会话事件流。 */
export interface ArchiveSessions {
  meta: SessionMeta[];
  events: Record<string, SessionEvent[]>;
}

/**
 * 归档的工作区记忆段（批次 6b，6a 的 D4 已知偏差 #2）。
 *
 * **只进归档、不进跨端同步**（`docs/batch-6b-file-assets-spec.md` D0-2）：工作区由
 * **路径**标识，而路径每台机器不同，没有跨端身份；且它落在**用户的项目目录**里
 * （可能已纳入版本控制），跨端同步等于跨设备改写用户仓库。
 *
 * 归档是**本机备份**语义，因此导入时**忽略 `workdir`**，一律写进接收方自己当前的
 * `.nanowork/memory/`（与批次 5「拉来的事件流落接收方自己的分片」同一条结论）。
 */
export interface ArchiveWorkspaceMemory {
  /** 导出时的工作目录；`null` = 无工作目录（产品目录兜底那份） */
  workdir: string | null;
  /** 文件名（`MEMORY.md` / `YYYY-MM-DD.md`）→ 正文 */
  files: Record<string, string>;
}

/**
 * `buildArchive` 的只读输入快照（由调用方注入）。
 *
 * `local` 的值是**原始字符串**（未解析），键集合见 `ARCHIVE_LOCAL_KEYS`。
 */
export interface ArchiveSources {
  local: Record<string, string>;
  sessionsMeta: SessionMeta[];
  sessionEvents: Record<string, SessionEvent[]>;
  /** 云端副本（`GET /api/account/export`）；未登录 / 未取为 `null`。 */
  cloud: CloudExport | null;
  /** 当前工作区的记忆文件全集；无工作区时为 `null`。 */
  workspaceMemory: ArchiveWorkspaceMemory | null;
}

/** 归档的头部元信息（与数据段分开注入，便于调用方只关心「这次导出是谁、何时」。 */
export interface ArchiveMeta {
  /** 导出时刻（ISO 8601） */
  exportedAt: string;
  /** 本机设备 ID；Web 端拿不到时为 `null` */
  deviceId: string | null;
  /** 导出账户；未登录为 `null` */
  account: ArchiveAccount | null;
}

/** 归档文件的完整结构（自描述：`format` + `formatVersion`）。 */
export interface NanoworkArchive {
  format: string;
  formatVersion: number;
  exportedAt: string;
  deviceId: string | null;
  account: ArchiveAccount | null;
  /** 本地持久化键值快照：storageKey → 原始字符串 */
  local: Record<string, string>;
  sessions: ArchiveSessions;
  cloud: CloudExport | null;
  /** 工作区记忆；v1 归档没有这一段，解析为 `null`（向后兼容）。 */
  workspaceMemory: ArchiveWorkspaceMemory | null;
}

/** 归档解析失败。**不返回半个归档**——导入写坏一半存储比直接报错糟糕得多。 */
export class ArchiveParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveParseError';
  }
}

/** `applyArchive` 的写入端口（纯逻辑不碰 IO，由调用方注入）。 */
export type ArchiveWriter = (key: string, value: string) => Promise<void>;

/** `applyArchive` 的结果。 */
export interface ApplyReport {
  /** 实际写入的 key 数 */
  written: number;
  /** 实际写入的 key 列表 */
  keys: string[];
}

/** 组装归档（纯函数，不碰 IO）。 */
export function buildArchive(sources: ArchiveSources, meta: ArchiveMeta): NanoworkArchive {
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: meta.exportedAt,
    deviceId: meta.deviceId,
    account: meta.account,
    // 原样搬原始字符串，不解析再序列化（见文件头「无损」）
    local: { ...sources.local },
    sessions: {
      meta: sources.sessionsMeta,
      events: sources.sessionEvents,
    },
    cloud: sources.cloud,
    workspaceMemory: sources.workspaceMemory,
  };
}

/** 收窄归档里的 account 段：非法即 `null`（不抛错——它是可选信息，不该拦下载入）。 */
function readAccount(value: unknown): ArchiveAccount | null {
  if (typeof value !== 'object' || value === null) return null;
  const account = value as Record<string, unknown>;
  if (typeof account.userId !== 'string' || typeof account.email !== 'string') return null;
  return { userId: account.userId, email: account.email };
}

/**
 * 解析归档文本；任何非法输入都抛 `ArchiveParseError`。
 *
 * 校验顺序即「格式 → 版本 → 数据段」：先把「这不是我们的归档」与「这是更新版本的
 * 归档」分开，再把结构性问题暴露出来。**任何一步失败都不返回部分结果**。
 */
export function parseArchive(text: string): NanoworkArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArchiveParseError('归档不是合法 JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArchiveParseError('归档根节点不是对象');
  }
  const root = parsed as Record<string, unknown>;

  if (root.format !== ARCHIVE_FORMAT) {
    throw new ArchiveParseError(`归档 format 不是 ${ARCHIVE_FORMAT}`);
  }
  if (typeof root.formatVersion !== 'number' || !Number.isFinite(root.formatVersion)) {
    throw new ArchiveParseError('归档 formatVersion 缺失或非法');
  }
  // J-C3：老客户端导入新归档必须明确报错，而不是静默丢字段
  if (root.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveParseError(
      `归档 formatVersion ${root.formatVersion} 高于本端支持的 ${ARCHIVE_FORMAT_VERSION}`,
    );
  }

  const localRaw = root.local;
  if (typeof localRaw !== 'object' || localRaw === null || Array.isArray(localRaw)) {
    throw new ArchiveParseError('归档 local 段缺失或非法');
  }
  const local = localRaw as Record<string, unknown>;
  for (const [key, value] of Object.entries(local)) {
    if (typeof value !== 'string') {
      throw new ArchiveParseError(`归档 local["${key}"] 不是字符串`);
    }
  }

  const sessionsRaw = root.sessions;
  if (typeof sessionsRaw !== 'object' || sessionsRaw === null || Array.isArray(sessionsRaw)) {
    throw new ArchiveParseError('归档 sessions 段缺失或非法');
  }
  const sessions = sessionsRaw as Record<string, unknown>;
  if (!Array.isArray(sessions.meta)) {
    throw new ArchiveParseError('归档 sessions.meta 不是数组');
  }
  const eventsRaw = sessions.events;
  if (typeof eventsRaw !== 'object' || eventsRaw === null || Array.isArray(eventsRaw)) {
    throw new ArchiveParseError('归档 sessions.events 不是对象');
  }

  // cloud 可缺省 / 为 null（J-C4：离线导出仍可解析）
  const cloudRaw = root.cloud;
  if (
    cloudRaw !== null &&
    cloudRaw !== undefined &&
    (typeof cloudRaw !== 'object' || Array.isArray(cloudRaw))
  ) {
    throw new ArchiveParseError('归档 cloud 段非法');
  }

  // workspaceMemory 可缺省：**v1 归档没有这一段**（批次 6b 才加）→ 解析为 null。
  // 与 `cloud` 同款容错，保证老归档仍可导入。
  const wsRaw = root.workspaceMemory;
  let workspaceMemory: ArchiveWorkspaceMemory | null = null;
  if (wsRaw !== null && wsRaw !== undefined) {
    if (typeof wsRaw !== 'object' || Array.isArray(wsRaw)) {
      throw new ArchiveParseError('归档 workspaceMemory 段非法');
    }
    const ws = wsRaw as Record<string, unknown>;
    const filesRaw = ws.files;
    if (typeof filesRaw !== 'object' || filesRaw === null || Array.isArray(filesRaw)) {
      throw new ArchiveParseError('归档 workspaceMemory.files 缺失或非法');
    }
    for (const [name, value] of Object.entries(filesRaw as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new ArchiveParseError(`归档 workspaceMemory.files["${name}"] 不是字符串`);
      }
    }
    workspaceMemory = {
      workdir: typeof ws.workdir === 'string' && ws.workdir !== '' ? ws.workdir : null,
      files: { ...(filesRaw as Record<string, string>) },
    };
  }

  return {
    format: ARCHIVE_FORMAT,
    formatVersion: root.formatVersion,
    exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : '',
    deviceId: typeof root.deviceId === 'string' ? root.deviceId : null,
    account: readAccount(root.account),
    local: { ...(local as Record<string, string>) },
    sessions: {
      meta: sessions.meta as SessionMeta[],
      events: eventsRaw as Record<string, SessionEvent[]>,
    },
    cloud: (cloudRaw ?? null) as CloudExport | null,
    workspaceMemory,
  };
}

/**
 * 把归档写回本地（**只写 `local` 段**）。
 *
 * `sessions` / `cloud` 段本期不回写：
 * - `sessions`：会话事件流的落地要走 `EventStore` 的写队列与分片解析，本模块是纯逻辑、
 *   不碰 IO；硬写会绕过去重与索引，落出孤儿文件；
 * - `cloud`：它是**云端副本**，回写本机等于把服务端数据当本机权威。
 * - `workspaceMemory`：需要**文件系统 IO**（`platform.memoryFiles`），而本模块是纯逻辑；
 *   且它必须落**接收方自己当前的工作区**（归档里的 `workdir` 在另一台机器上不存在），
 *   这个「落到哪」的判断属于调用方。
 *
 * `write` 由调用方注入（通常是 `(k, v) => platform.storage.set(k, v)`），故往返用例
 * 不需要真存储。
 */
export async function applyArchive(
  arch: NanoworkArchive,
  write: ArchiveWriter,
): Promise<ApplyReport> {
  const keys = Object.keys(arch.local);
  for (const key of keys) {
    await write(key, arch.local[key]);
  }
  return { written: keys.length, keys };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 归档文件名：`nanowork-export-YYYYMMDD-HHmmss.json`。
 *
 * 用**本地时间**（用户点导出时看到的时刻），`Date` 的分量取法保证用例可注入固定时刻。
 */
export function archiveFileName(now: Date): string {
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `nanowork-export-${stamp}.json`;
}
