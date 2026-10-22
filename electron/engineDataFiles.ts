/**
 * 引擎数据目录里的文件体量快照（V1.7 B5-02）。
 *
 * ## 要回答的问题
 *
 * 「引擎的用量库 / 会话库涨到多大了？」——这是工单里反复出现的一类问题
 * （「是不是我跑崩了，日志把盘写满了？」），此前**没有任何地方能看到答案**：
 * 用户只能自己去翻 `~/.nanobot/`，而这个目录名还随配置位置变。
 *
 * ## 为什么只报尺寸、不做别的
 *
 * `llm_usage.sqlite3` 是 **SQLite WAL** 模式。B5-02 讨论过要不要做跨进程
 * checkpoint，结论是**不做**：引擎（`llm_usage/store.py`）只设 `journal_mode=WAL`、
 * **没有关** autocheckpoint；PASSIVE checkpoint 会把内容写回主库但**不截断文件**，
 * 停在高水位是正常行为。做 checkpoint worker 等于给不存在的问题加复杂度，
 * 还会与真正的写入者（Python 引擎）争锁。
 *
 * 所以这里**只 stat 尺寸**：只读、不争锁、不写、不开数据库连接。
 *
 * ## 契约
 *
 * - **只报已知文件**：不扫目录（引擎目录里可能有巨大的 `sessions/`，全扫会拖慢导出）。
 * - **取不到就写「未知」，不写 0**：0 会被读成「文件是空的」，那是假信息。
 * - **`wal` / `shm` 单独列**：只看主库文件会低估真实占用（WAL 常常比主库还大）。
 *
 * @see docs/plan-v1.7-closure-and-delivery.md B5-02
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** 引擎数据目录里值得报体量的文件（相对 `<data_dir>`）。 */
export const ENGINE_DATA_FILES = [
  /** 用量库（SQLite 主文件） */
  'llm_usage.sqlite3',
  /** SQLite WAL 旁文件——常常比主库还大，只看主库会低估 */
  'llm_usage.sqlite3-wal',
] as const;

export type EngineDataFileName = (typeof ENGINE_DATA_FILES)[number];

/** 单个文件的体量事实。 */
export interface EngineDataFileStat {
  /** 相对 `<data_dir>` 的文件名 */
  file: EngineDataFileName;
  /** 字节数；`null` = 文件不存在或读不到（**不是 0**） */
  bytes: number | null;
  /** 最后修改时间（ISO）；读不到时为 null */
  modifiedAt: string | null;
}

/** 引擎数据目录的体量快照。 */
export interface EngineDataSnapshot {
  /**
   * 数据目录绝对路径；`null` = 不知道引擎配置在哪（取不到就不报，别猜）。
   *
   * ⚠️ 这条路径**含用户名**，进诊断包前必须脱敏（见 `secretRedaction` 的
   * 「绝对路径用户名」规则）。诊断包是要发出去的。
   */
  dataDir: string | null;
  /** 逐个文件的体量 */
  files: EngineDataFileStat[];
}

/**
 * 统计引擎数据目录里那几个已知文件的体量。
 *
 * 只读：只做 `stat`，不打开数据库、不加锁、不写任何东西。
 * 单个文件读不到只影响它自己（`bytes: null`），不影响其它文件。
 */
export async function collectEngineDataStats(
  dataDir: string | null | undefined,
  files: readonly EngineDataFileName[] = ENGINE_DATA_FILES,
): Promise<EngineDataSnapshot> {
  if (!dataDir) return { dataDir: null, files: [] };
  const rows: EngineDataFileStat[] = [];
  for (const file of files) {
    let bytes: number | null = null;
    let modifiedAt: string | null = null;
    try {
      const st = await fs.stat(join(dataDir, file));
      // 目录同名的情况不是文件（bytes 无意义）→ 当作读不到。
      if (st.isFile()) {
        bytes = st.size;
        modifiedAt = st.mtime.toISOString();
      }
    } catch {
      // 文件不存在 / 无权限 → null（未知），**不写 0**。
    }
    rows.push({ file, bytes, modifiedAt });
  }
  return { dataDir, files: rows };
}

/** 快照里所有读到了尺寸的文件的总字节数（读不到的按 0 计入总和，但计数单独给）。 */
export function totalKnownBytes(snapshot: EngineDataSnapshot): {
  bytes: number;
  knownFiles: number;
  unknownFiles: number;
} {
  let bytes = 0;
  let knownFiles = 0;
  let unknownFiles = 0;
  for (const f of snapshot.files) {
    if (f.bytes === null) {
      unknownFiles += 1;
      continue;
    }
    bytes += f.bytes;
    knownFiles += 1;
  }
  return { bytes, knownFiles, unknownFiles };
}
