import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/core/constants';

/** 回滚快照的操作类型（仅用于时间线展示，不影响备份本身） */
export type BackupOp = 'overwrite' | 'append' | 'delete';

/** 一条回滚快照的元数据（备份正文由 `platform.fileBackup` 按 hash 存） */
export interface BackupEntry {
  /** 内容寻址哈希（= `contentHash(旧内容)`），也是 `file-history/<hash>.bak` 的文件名 */
  hash: string;
  /** ISO 时间戳：本次写前快照发生的时刻 */
  at: string;
  /** 触发这次快照的写操作类型 */
  op: BackupOp;
  /**
   * 单文件内的单调序号（1 起）：给时间线一个**全序**。
   *
   * 为什么需要它：`at` 只到毫秒，两次连续快照（记忆文件 append 后立刻又被改写）
   * 完全可能落在同一毫秒。此时若只按 `at` 排序，顺序就退化成「数组 InsertionSort
   * 的稳定性」——看起来稳定，实际是**未定义**：同一份数据在不同引擎 / 不同批次里
   * 可能给出不同先后，「最新在前」这条契约随之失效（UI 时间线会闪）。
   *
   * 老数据没有这个字段，读作 0：它们之间靠插入序（数组顺序）决定相对先后，
   * 与真实发生顺序一致，不需要迁移。
   */
  seq?: number;
}

interface FileBackupState {
  /** 每个文件的回滚时间线；key 口径见 `fileKeyOf` */
  timeline: Record<string, BackupEntry[]>;
  /** 记一条快照（同 key 上限 `MAX_ENTRIES`，超出丢弃最旧） */
  record: (fileKey: string, hash: string, op: BackupOp) => void;
  /** 列出某文件的快照（按 at 倒序：最新在前） */
  list: (fileKey: string) => BackupEntry[];
  /** 清空某文件的时间线（删除该文件时调用） */
  clear: (fileKey: string) => void;
}

/** 单文件时间线上限：记忆文件 KB 级，50 条覆盖绝大多数回滚需求 */
const MAX_ENTRIES = 50;

/**
 * 文件级回滚时间线（FR-7.3）。
 *
 * 与 `platform.fileBackup` 分工：后者只按 hash 存正文（内容寻址、无「哪个文件/何时」），
 * 本 store 记录**时间线元数据**——回滚 UI 要回答「这份文件在被改写前长什么样、何时改的」。
 *
 * 不依赖任何引擎状态：纯渲染层状态，Web/Electron 同构（Web 端 `fileBackup` 是 no-op，
 * 故时间线恒空，UI 据此禁用）。
 */
export const useFileBackupStore = create<FileBackupState>()(
  persist(
    (set, get) => ({
      timeline: {},

      record: (fileKey, hash, op) => {
        const at = new Date().toISOString();
        set((s) => {
          const prev = s.timeline[fileKey] ?? [];
          // 序号取自当前末尾（不是时间戳）：它只回答「谁后写」，与时钟无关。
          // 上限截断只丢最旧的，末尾那条的 seq 恒为最大，因此不会回退。
          const seq = (prev[prev.length - 1]?.seq ?? 0) + 1;
          const next = [...prev, { hash, at, op, seq }];
          // 超出上限丢弃最旧（时间线按 at 升序追加，头部即最旧）
          if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
          return { timeline: { ...s.timeline, [fileKey]: next } };
        });
      },

      list: (fileKey) => {
        const entries = get().timeline[fileKey] ?? [];
        // 倒序：最新写入的快照排在最前。
        // **`at` 相同必须靠 `seq` 兜底**——同毫秒的两条快照若只比 `at`，顺序由
        // sort 的稳定性决定（等于插入序，即「最旧在前」），与契约相反。
        return [...entries].sort(
          (a, b) => b.at.localeCompare(a.at) || (b.seq ?? 0) - (a.seq ?? 0),
        );
      },

      clear: (fileKey) => {
        if (!get().timeline[fileKey]) return;
        set((s) => {
          const timeline = { ...s.timeline };
          delete timeline[fileKey];
          return { timeline };
        });
      },
    }),
    {
      name: STORAGE_KEYS.fileBackups,
      storage: zustandStorage,
      partialize: (s) => ({ timeline: s.timeline }),
    },
  ),
);

/**
 * 组装时间线 key（FR-7.3 D5）：`memory:${scope}:${workdir ?? ''}:${name}`。
 *
 * 跨作用域 / 跨工作区隔离；用户级 `workdir` 空。
 */
export function fileKeyOf(scope: 'user' | 'workspace', workdir: string | null, name: string): string {
  return `memory:${scope}:${workdir ?? ''}:${name}`;
}
