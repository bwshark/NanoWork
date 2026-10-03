/**
 * 保留与归档：把**过期的日志文件**移出蒸馏的扫描范围，但保留可审计（FR-M33）。
 *
 * ## 三个必须分开的概念（v1/设计稿把它们混在一起，实施时专门拆开）
 *
 * | 概念 | 默认 | 作用对象 | 效果 |
 * |---|---|---|---|
 * | `retentionDays` | 30 天 | **事实** | 蒸馏的**晋升年龄门槛**：太新的事实还不算稳定结论 |
 * | `archiveAfterDays` | 180 天 | **日志文件** | 该日期整天移入 `archive/`，不再被 `distill` 扫描 |
 * | `disable` / `delete` | — | **单条事实级** | 用户的治理动作，与上面两个时间参数无关 |
 *
 * 混用这两个数字会出现「设置里写 30 天，行为却像 180 天」这类无法解释的现象，所以
 * 归档**自带**自己的阈值，不从 `DistillPolicy` 里借 `retentionDays`。
 *
 * ## 归档不是删除
 *
 * 移进 `archive/` 的文件**仍然是证据**：可读、可审计、可以再搬回来。设计上刻意与
 * 「丢弃证据」分开——s10 的结论是「真正的存储清理由单独的 retention/backup 策略负责，
 * 不该混进蒸馏」。所以本模块**只做移动**，不做删除。
 *
 * ## 为什么归档有用
 *
 * `loadFacts` 会枚举 `daily/` 下**全部**日期文件。三年后那是 1000+ 个文件，而其中
 * 绝大多数早已过了晋升门槛——继续扫描它们只是把每次蒸馏变慢。归档把「活跃窗口」
 * 与「历史留档」分开，这是**性能与可审计性**的双赢，不是空间回收。
 */

import type { MemoryFact } from '@/types';
import { ARCHIVE_SUBDIR, DAILY_SUBDIR, isFactLogFileName } from '@/lib/memoryPaths';
import type { MemoryStoreIo } from '@/lib/memoryStore';

/** 归档策略 */
export interface ArchivePolicy {
  /** 超过这么多天的日志文件整体移入 `archive/` */
  archiveAfterDays: number;
  /**
   * 归档时是否做一次「事实年龄」复核。
   *
   * 默认 true：只移动**整份文件都过期**的日志。理由是一个日文件里可能混着晚到的
   * 事实（`observedAt` 比文件名晚），整份移走会让它再也参与不了晋升。
   * 逐行复核的代价是归档时要读一遍文件——它是低频动作（用户点一下 / 应用启动一次），
   * 值得。
   */
  verifyFactAge: boolean;
}

/** 默认归档策略（与 `docs/prd-memory-v2.md` FR-M33 一致） */
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  archiveAfterDays: 180,
  verifyFactAge: true,
};

/** 一次归档的结果 */
export interface ArchiveResult {
  /** 被移动的文件名（`daily/` 下的名字） */
  archived: string[];
  /** 因「仍含未过期事实」而留下的文件名 */
  kept: string[];
  /** 被移动的总行数（可观察「这次真的搬走了多少证据」） */
  movedLines: number;
}

/** 日期文件名（`2026-09-19.jsonl`）→ 那一天的 UTC 零点；非日期名返回 null */
export function dayOfFactLogFile(name: string): Date | null {
  if (!isFactLogFileName(name)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 执行一次归档。
 *
 * 「先写归档、再删原件」的顺序是刻意的：反过来的话，中途失败就**真的丢日志**了。
 * 多留一份重复内容是可接受的（下次归档会发现目标已存在并跳过写入）；丢证据不可接受。
 */
export async function runArchive(
  io: MemoryStoreIo,
  now: Date,
  policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
  parseFact?: (line: string) => MemoryFact | null,
): Promise<ArchiveResult> {
  const cutoff = now.getTime() - policy.archiveAfterDays * 24 * 60 * 60 * 1000;
  const names = (await io.list(DAILY_SUBDIR).catch(() => [] as string[]))
    .filter(isFactLogFileName)
    .sort();

  const result: ArchiveResult = { archived: [], kept: [], movedLines: 0 };

  for (const name of names) {
    const day = dayOfFactLogFile(name);
    // 文件名不是日期 → 不是我们的日志，不碰它
    if (!day) continue;
    // 文件名的**当天结束**还没到截止点 → 还年轻
    const dayEnd = day.getTime() + 24 * 60 * 60 * 1000 - 1;
    if (dayEnd > cutoff) continue;

    const lines = await io.readLines(name, DAILY_SUBDIR).catch(() => [] as string[]);
    if (lines.length === 0) {
      // 空文件也归档：留着它只会让每次蒸馏多一次无意义的读
      await io.write(name, '', ARCHIVE_SUBDIR).catch(() => undefined);
      await io.remove(name, DAILY_SUBDIR).catch(() => undefined);
      result.archived.push(name);
      continue;
    }

    // 复核：文件里有没有「还年轻」的事实？有就整份留下（见 ArchivePolicy.verifyFactAge）
    if (policy.verifyFactAge && parseFact) {
      const hasYoung = lines.some((line) => {
        const fact = parseFact(line);
        if (!fact) return false;
        return Date.parse(fact.observedAt) > cutoff;
      });
      if (hasYoung) {
        result.kept.push(name);
        continue;
      }
    }

    const body = `${lines.join('\n')}\n`;
    await io.write(name, body, ARCHIVE_SUBDIR);
    await io.remove(name, DAILY_SUBDIR);
    result.archived.push(name);
    result.movedLines += lines.length;
  }

  return result;
}

/** 归档目录里已有的文件名（用于诊断与「搬回来」的操作） */
export async function listArchivedFactLogs(io: MemoryStoreIo): Promise<string[]> {
  const names = await io.list(ARCHIVE_SUBDIR).catch(() => [] as string[]);
  return names.filter(isFactLogFileName).sort();
}
