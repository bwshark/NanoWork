/**
 * 一次裁决的**五阶段落盘协议**（设计 §4.5）——只认契约、不认存储实现。
 *
 * ## 为什么必须单独一个模块
 *
 * 「三个文件各自原子」≠「三个文件之间一致」。一次裁决要更新
 * `curated.json` + `conflicts.json` + 追一条审计，只完成其中一部分就会让**记忆**与
 * **待审队列**互相矛盾：用户看到案件还在（`conflicts.json` 说 open），但记忆里已经换了值
 * （`curated.json` 已应用）。所以先写一份可重放的意图，再逐阶段推进；
 * 任何一刀切断电都能在重启后前滚。
 *
 * 本模块把「推进」与「重放」做成对同一个 `MemoryTxnPort` 的操作，于是八个崩溃窗口
 * 可以用一个假 port 完整覆盖，不需要真机反复杀进程。
 *
 * ## 阶段顺序是硬约束
 *
 * ```
 * prepared → curated_applied → conflict_closed → audit_appended → committed
 * ```
 *
 * 每阶段**先完成目标写入、再追加阶段事件**。反过来就是「事件说做了、实际没做」，
 * 恢复时无法判定该重做还是该继续。
 */

import type { AdjudicationEvent, ResolutionIntent, TxnPhase } from '@/types';
import { TXN_PHASES } from '@/lib/memory/memoryAdjudicate';

/** 裁决事务要碰的三个存储目标的抽象 */
export interface MemoryTxnPort {
  /** 写入意图（含 before/after 全量快照）并追加 `prepared` 阶段事件 */
  prepare(intent: ResolutionIntent): Promise<void>;
  /** 原子替换 `curated.json` */
  applyCurated(intent: ResolutionIntent): Promise<void>;
  /** 原子替换 `conflicts.json`（关闭案件） */
  applyConflicts(intent: ResolutionIntent): Promise<void>;
  /** 追加审计事件 */
  appendAudit(intent: ResolutionIntent): Promise<void>;
  /** 追加阶段事件 */
  appendPhase(transactionId: string, intentSha256: string, phase: TxnPhase): Promise<void>;
}

/** 推进结果：本次真的走了哪几个阶段（可观察，便于测试断言「没重复做事」） */
export interface AdvanceResult {
  phases: TxnPhase[];
}

/**
 * 从某个阶段之后继续推进到 `committed`。
 *
 * `already` 是**磁盘上已经记录过的阶段**（由 journal 解析得出）。本函数对每个尚未记录的
 * 阶段执行「目标写入 + 阶段事件」，因此可重入：把同一个 intent 再跑一遍不会重复建修订，
 * 因为目标写入是**幂等替换**（写入的都是同一份 after 快照）。
 */
export async function advanceIntent(
  port: MemoryTxnPort,
  intent: ResolutionIntent,
  already: readonly TxnPhase[] = [],
): Promise<AdvanceResult> {
  const done = new Set<TxnPhase>(already);
  const did: TxnPhase[] = [];

  if (!done.has('prepared')) {
    await port.prepare(intent);
    did.push('prepared');
    done.add('prepared');
  }
  if (!done.has('curated_applied')) {
    await port.applyCurated(intent);
    await port.appendPhase(intent.transactionId, intent.intentSha256, 'curated_applied');
    did.push('curated_applied');
    done.add('curated_applied');
  }
  if (!done.has('conflict_closed')) {
    await port.applyConflicts(intent);
    await port.appendPhase(intent.transactionId, intent.intentSha256, 'conflict_closed');
    did.push('conflict_closed');
    done.add('conflict_closed');
  }
  if (!done.has('audit_appended')) {
    await port.appendAudit(intent);
    await port.appendPhase(intent.transactionId, intent.intentSha256, 'audit_appended');
    did.push('audit_appended');
    done.add('audit_appended');
  }
  if (!done.has('committed')) {
    await port.appendPhase(intent.transactionId, intent.intentSha256, 'committed');
    did.push('committed');
  }

  return { phases: did };
}

/** 阶段推进到哪一步（供恢复判定用；`committed` = 不需要再动它） */
export function isCommitted(phases: readonly TxnPhase[]): boolean {
  return phases.includes('committed');
}

/** 从一组阶段事件里取「下一个应该做的阶段」；全部完成返回 null */
export function nextPhaseOf(phases: readonly TxnPhase[]): TxnPhase | null {
  for (const phase of TXN_PHASES) {
    if (!phases.includes(phase)) return phase;
  }
  return null;
}

/**
 * 审计事件的**幂等判据**：同 `eventId` 已存在时不再追加。
 *
 * 恢复会重放 `audit_appended` 之后可能已存在的追加，所以这一层必须按 `eventId` 去重；
 * 否则一次重启就会在审计流里留下两行同一件事。
 */
export function hasAuditEvent(events: readonly AdjudicationEvent[], eventId: string): boolean {
  return (events ?? []).some((e) => e.eventId === eventId);
}
