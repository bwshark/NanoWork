import { contentHash } from './contentHash';
import { platform } from '@/platform';
import {
  fileKeyOf,
  useFileBackupStore,
  type BackupEntry,
  type BackupOp,
} from '@/stores/fileBackupStore';

/**
 * 文件级回滚的客户端封装（FR-7.3）。
 *
 * 把「内容寻址备份」（`platform.fileBackup`）与「时间线元数据」（`useFileBackupStore`）
 * 两件事合成一处，供 `MemoryService` 写路径挂 prebackup、记忆页做回滚 UI。
 *
 * 为什么放 `lib` 而不是 `stores`：它要被 `lib/memory.ts`（MemoryService）调用，
 * 若反过来让 memory 进 store 会形成循环依赖。本模块只依赖 store 的**对象**
 * （调用 `getState()`），不依赖其初始化顺序。
 */

/**
 * 写前快照：覆盖/删除**之前**对旧内容做内容寻址备份，并记一条时间线。
 *
 * - `oldContent === null`（文件原本不存在）→ 不快照，无物可回滚；
 * - 最佳努力：`platform.fileBackup.put` 抛错吞掉，**绝不影响真实写入**（调用方已在外层 try）。
 *
 * @param fileKey 时间线 key（见 `fileKeyOf`）
 * @param oldContent 写入前的旧正文；`null` 表示文件不存在
 * @param op 触发这次快照的操作类型（仅展示用）
 */
export async function snapshotBeforeWrite(
  fileKey: string,
  oldContent: string | null,
  op: BackupOp,
): Promise<void> {
  // 文件不存在（null）或已为空（''）→ 无物可回滚，跳过
  if (oldContent === null || oldContent === '') return;
  const hash = contentHash(oldContent);
  try {
    await platform.fileBackup.put(hash, oldContent);
    useFileBackupStore.getState().record(fileKey, hash, op);
  } catch {
    /* 备份失败不阻断真实写入 */
  }
}

/** 读回某份内容寻址备份的正文；不支持（Web 端）或不存在返回 null */
export function getBackupContent(hash: string): Promise<string | null> {
  return platform.fileBackup.get(hash);
}

/** 列出某文件的回滚时间线（按 at 倒序，最新在前） */
export function listSnapshots(fileKey: string): BackupEntry[] {
  return useFileBackupStore.getState().list(fileKey);
}

export { fileKeyOf };
export type { BackupEntry, BackupOp };
