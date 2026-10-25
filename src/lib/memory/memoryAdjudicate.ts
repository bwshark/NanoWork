/**
 * 人工裁决：把「拿不准」交给有能力做决定的那一层（人）。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M11 … FR-M19；设计：`docs/architecture-memory-v2.md` §4.4 / §4.5。
 *
 * ## 为什么裁决必须是人，且必须带 revision
 *
 * 候选内容不能给自己授予裁决权——模型能看到候选（通过记忆页之外的任何路径都不该看到），
 * 但**不能调用本模块**。同时裁决必须提交「刚刚看到的案件版本」：用户可能在页面上停留了
 * 十分钟，期间新证据到达、fingerprint 变了，此时按旧页面提交会**用过期判断覆盖新证据**。
 * 所以本模块的每个入口都在执行前重新核对五件事（见 `resolveConflict`）。
 *
 * ## 纯逻辑 + 事务恢复
 *
 * 本文件**不碰磁盘**：`resolveConflict` 返回「新的 canonical 状态 + 审计事件」，
 * 由 store 层按五阶段事务落盘；`reconcileTransaction` 在重启时根据磁盘现状决定
 * 「重做 / 继续 / fail-closed」。两者都是纯函数，因此可以离线测八个崩溃窗口。
 */

import type {
  AdjudicationEvent,
  ConflictCase,
  ConflictState,
  CuratedEntry,
  CuratedState,
  EntryKey,
  ResolveConflictInput,
  ResolveConflictResult,
  ResolutionIntent,
  TxnPhase,
  TxnPhaseEvent,
} from '@/types';
import { compareStrings, normalizeForDedup, sortedUnique } from '@/lib/memory/memoryNormalize';
import { activeOf, validateCuratedState } from '@/lib/memory/memoryDistill';
import { hashContent } from '@/lib/workspace/workspaceKey';

/** 案件已陈旧（证据或版本变了）：要求调用方重看，不是换一个幂等键 */
export class StaleConflictResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleConflictResolutionError';
  }
}

/** 同一个 `eventId` 被用于另一种裁决：要求换一个幂等键 */
export class ConflictEventReuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictEventReuseError';
  }
}

/** 找不到案件 */
export class ConflictNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictNotFoundError';
  }
}

/** 事务 journal 损坏 / 被篡改 / 阶段跳跃 */
export class CorruptTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptTransactionError';
  }
}

/** 恢复时磁盘状态既不是 before 也不是 after：**fail-closed**，不猜 */
export class UnrecoverableTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableTransactionError';
  }
}

/** 五阶段的**固定顺序**（跳过任何一阶段都是损坏） */
export const TXN_PHASES: readonly TxnPhase[] = [
  'prepared',
  'curated_applied',
  'conflict_closed',
  'audit_appended',
  'committed',
];

/** 空冲突状态 */
export function emptyConflictState(workspaceId: string, now: Date): ConflictState {
  return { schema: 2, workspaceId, cases: [], renderedAt: now.toISOString() };
}

/** 列出一个案件的全新（open）视图；已解决 / 被取代的不返回 */
export function openConflicts(state: ConflictState): ConflictCase[] {
  return (state?.cases ?? [])
    .filter((c) => c.status === 'open')
    .sort((a, b) => compareStrings(a.conflictId, b.conflictId));
}

/** 按 id 找案件 */
export function findConflict(state: ConflictState, conflictId: string): ConflictCase | null {
  return (state?.cases ?? []).find((c) => c.conflictId === conflictId) ?? null;
}

/** 合并新案件进状态：同 id 已存在时不重复加入（`distill` 可能反复产出同一个案件） */
export function mergeNewCases(state: ConflictState, cases: readonly ConflictCase[], now: Date): ConflictState {
  const byId = new Map<string, ConflictCase>();
  for (const c of state?.cases ?? []) byId.set(c.conflictId, c);

  for (const incoming of cases ?? []) {
    const existing = byId.get(incoming.conflictId);
    if (!existing) {
      byId.set(incoming.conflictId, incoming);
      continue;
    }
    // 已解决的同 id 案件不因重新检测而复活（用户已经裁决过了）
    if (existing.status !== 'open') continue;
    // 仍是 open：保留原 detectedAt / revision，只刷新候选与证据快照
    byId.set(incoming.conflictId, {
      ...incoming,
      detectedAt: existing.detectedAt,
      revision: existing.revision,
    });
  }

  return {
    schema: 2,
    workspaceId: state.workspaceId,
    cases: [...byId.values()].sort((a, b) => compareStrings(a.conflictId, b.conflictId)),
    renderedAt: now.toISOString(),
  };
}

/**
 * 把「同分但仍 unresolved」的旧 open 案件标为 `superseded`。
 *
 * 触发条件：同一 `entryKey` 出现了**新的 fingerprint**（证据变了），旧案件的观察快照
 * 已经不能代表现状——留着它会让用户对着过期候选做决定。
 */
export function supersedeStaleCases(
  state: ConflictState,
  liveCases: readonly ConflictCase[],
  now: Date,
): ConflictState {
  const liveKeys = new Map<EntryKey, string>();
  for (const c of liveCases ?? []) liveKeys.set(c.entryKey, c.evidenceFingerprint);

  const cases = (state?.cases ?? []).map((c) => {
    if (c.status !== 'open') return c;
    const live = liveKeys.get(c.entryKey);
    if (live === undefined || live === c.evidenceFingerprint) return c;
    return { ...c, status: 'superseded' as const, resolvedAt: now.toISOString() };
  });

  return { ...state, cases, renderedAt: now.toISOString() };
}

/** 归一化后的裁决身份：同参重试判等用（不比较 actor 之外的自由文本顺序） */
function resolutionSignature(input: ResolveConflictInput): string {
  return [input.conflictId, input.candidateId, input.expectedRevision, input.actor, input.rationale].join(
    '\u0000',
  );
}

/**
 * 执行一次人工裁决——**只做校验与状态推演，不碰磁盘**。
 *
 * 执行前核对的五件事（设计 §4.4 的表）：
 *
 * | # | 校验 | 不满足 |
 * |---|---|---|
 * | 1 | case 仍 open 且 `revision === expectedRevision` | `StaleConflictResolutionError` |
 * | 2 | 当前 active entry 仍是检测时的版本 | 同上 |
 * | 3 | 当前事实集合的 fingerprint 与快照一致 | 同上 |
 * | 4 | `candidateId` 属于该 case | 同上 |
 * | 5 | `eventId` 未被用于**另一种**裁决；同参重试返回原事件 | `ConflictEventReuseError` / 幂等返回 |
 *
 * 分支语义（FR-M14）：选 challenger → 创建下一版 active 并把 incumbent 标 superseded；
 * 选 incumbent → **只记审计，不产生新修订**（保持现状不是一次事实变化）。
 */
export function resolveConflict(
  input: ResolveConflictInput,
  curated: CuratedState,
  conflicts: ConflictState,
  knownEvents: readonly AdjudicationEvent[],
  now: Date,
  currentFactIds?: readonly string[],
): ResolveConflictResult {
  if (!input.rationale || input.rationale.trim() === '') {
    throw new StaleConflictResolutionError('裁决必须给出理由');
  }

  // ⑤a 幂等：同 eventId 且同参 → **重演出同一个终态**并返回原事件。
  // 注意不能直接返回入参的 curated/conflicts：那是「还没有应用这次裁决」的状态，
  // 调用方拿它去落盘会把刚做出的裁决擦掉（一次重试就丢一条记忆，且完全静默）。
  const sameEvent = (knownEvents ?? []).filter((e) => e.eventId === input.eventId);
  if (sameEvent.length > 0) {
    const prev = sameEvent[0];
    const prevSignature = [
      prev.conflictId,
      prev.candidateId,
      prev.caseRevision,
      prev.actor,
      prev.rationale,
    ].join('\u0000');
    if (prevSignature !== resolutionSignature(input)) {
      // ⑤b 同 id 换参数：要求换一个幂等键（**不是**刷新页面就能解决的）
      throw new ConflictEventReuseError(
        `eventId 已被用于另一种裁决：${input.eventId}`,
      );
    }
    const replayed = replayAdjudication(prev, curated, conflicts, now);
    return {
      applied: false,
      resultEntryKey: prev.resultEntryKey,
      nextConflicts: replayed.conflicts,
      nextCurated: replayed.curated,
      adjudication: prev,
    };
  }

  const kase = findConflict(conflicts, input.conflictId);
  if (!kase) throw new ConflictNotFoundError(`找不到冲突案件：${input.conflictId}`);

  // ① 版本一致
  if (kase.status !== 'open') {
    throw new StaleConflictResolutionError(`案件已不是待裁决状态：${kase.status}`);
  }
  if (kase.revision !== input.expectedRevision) {
    throw new StaleConflictResolutionError(
      `案件版本已变（期望 ${input.expectedRevision}，实际 ${kase.revision}），请重看`,
    );
  }

  // ② 当前 active 仍是检测时的版本。
  // 只比 entryKey 不够：**同一个问题可以自己演进**（该域在用户裁决之前又发生了一次
  // 正常替代）。此时键没变、revision 变了，案件里的候选已对不上现状——这种陈旧必须拦住。
  const active = activeOf(curated, kase.entryKey);
  const activeKey = active ? active.entryKey : null;
  if (activeKey !== kase.activeEntryKey) {
    throw new StaleConflictResolutionError('该域的当前生效版本已变化，请重看');
  }
  if (kase.activeRevision !== null && active && active.revision !== kase.activeRevision) {
    throw new StaleConflictResolutionError(
      `该域的生效版本已从 r${kase.activeRevision} 演进到 r${active.revision}，请重看`,
    );
  }

  // ③ 事实集合与快照一致（调用方给得出才好核对；给不出就跳过这一条并在注释里承认）
  if (currentFactIds) {
    const fingerprint = hashContent(sortedUnique(currentFactIds).join('\u0000'));
    if (fingerprint !== kase.evidenceFingerprint) {
      throw new StaleConflictResolutionError('证据已变化，请重看候选');
    }
  }

  // ④ 候选属于该案件
  const chosen = kase.candidates.find((c) => c.candidateId === input.candidateId);
  if (!chosen) {
    throw new StaleConflictResolutionError(`候选不属于该案件：${input.candidateId}`);
  }

  const choseChallenger = !active || normalizeForDedup(chosen.content) !== normalizeForDedup(active.content);

  const revisions: CuratedEntry[] = (curated.revisions ?? []).map((r) => ({ ...r }));
  let resultEntryKey: EntryKey | null = kase.entryKey;

  if (choseChallenger) {
    if (active) {
      const idx = revisions.findIndex(
        (r) => r.entryKey === active.entryKey && r.revision === active.revision,
      );
      if (idx === -1) throw new StaleConflictResolutionError('当前生效版本在状态里找不到，请重看');
      revisions[idx] = {
        ...revisions[idx],
        status: 'superseded',
        supersededBy: active.revision + 1,
      };
    }
    const nextRevision = (active?.revision ?? 0) + 1;
    revisions.push({
      entryKey: kase.entryKey,
      memoryKey: kase.memoryKey,
      kind: active?.kind ?? 'decision',
      revision: nextRevision,
      status: 'active',
      content: chosen.content,
      importance: chosen.importance,
      evidenceIds: sortedUnique(chosen.evidenceIds),
      evidenceCount: sortedUnique(chosen.evidenceIds).length,
      firstSeen: active?.firstSeen ?? chosen.lastSeen,
      lastSeen: chosen.lastSeen,
      ...(active ? { supersedes: active.revision } : {}),
    });
  }
  // 选 incumbent：不改 revisions（保持现状**不制造虚假修订**）

  const event: AdjudicationEvent = {
    eventId: input.eventId,
    conflictId: kase.conflictId,
    caseRevision: kase.revision,
    candidateId: chosen.candidateId,
    actor: input.actor,
    rationale: input.rationale.trim(),
    evidenceIds: sortedUnique(chosen.evidenceIds),
    previousEntryKey: activeKey,
    resultEntryKey: choseChallenger ? kase.entryKey : activeKey,
    choseChallenger,
    at: now.toISOString(),
  };

  const resolvedCase: ConflictCase = {
    ...kase,
    status: 'resolved',
    resolvedAt: event.at,
    resolution: {
      candidateId: chosen.candidateId,
      actor: input.actor,
      eventId: input.eventId,
      rationale: event.rationale,
      resultEntryKey: event.resultEntryKey,
    },
  };

  const nextCurated: CuratedState = {
    schema: 2,
    workspaceId: curated.workspaceId,
    revisions: revisions.sort((a, b) => {
      const k = compareStrings(a.entryKey, b.entryKey);
      return k !== 0 ? k : a.revision - b.revision;
    }),
    renderedAt: now.toISOString(),
  };
  validateCuratedState(nextCurated);

  const nextConflicts: ConflictState = {
    ...conflicts,
    cases: conflicts.cases.map((c) => (c.conflictId === kase.conflictId ? resolvedCase : c)),
    renderedAt: now.toISOString(),
  };

  return { applied: true, resultEntryKey, nextConflicts, nextCurated, adjudication: event };
}

/**
 * 由一条**已记录的**审计事件重演出裁决后的 canonical 状态。
 *
 * 存在的理由：同一 `eventId` 的重试必须返回「应用过这次裁决」的状态，而不是入参的
 * 原始状态（否则一次重试就把刚做出的裁决擦掉了）。重演而不是「存一份 next 状态」的
 * 好处是它只依赖审计事件 + 当前状态，**不引入第三份真相**——审计流本来就要求是可重放的。
 */
export function replayAdjudication(
  event: AdjudicationEvent,
  curated: CuratedState,
  conflicts: ConflictState,
  now: Date,
): { curated: CuratedState; conflicts: ConflictState } {
  const kase = findConflict(conflicts, event.conflictId);
  const revisions: CuratedEntry[] = (curated.revisions ?? []).map((r) => ({ ...r }));

  if (event.choseChallenger && kase) {
    // 判据必须是**候选也匹配**，不能只比 entryKey：同一域的 incumbent 与 challenger
    // 共享 entryKey，只比键会把 incumbent 误当成「已经应用过」，于是重放变成空操作
    // （一次重试就把刚做出的裁决丢掉，而且完全静默——这是实施时踩到的真实 bug）。
    const chosen = kase.candidates.find((c) => c.candidateId === event.candidateId);
    const alreadyApplied = revisions.some(
      (r) =>
        r.entryKey === kase.entryKey &&
        r.status === 'active' &&
        chosen !== undefined &&
        r.content === chosen.content,
    );
    if (!alreadyApplied && chosen) {
      const currentActive = activeOf(curated, kase.entryKey);
      if (currentActive) {
        const idx = revisions.findIndex(
          (r) => r.entryKey === currentActive.entryKey && r.revision === currentActive.revision,
        );
        if (idx !== -1) {
          revisions[idx] = {
            ...revisions[idx],
            status: 'superseded',
            supersededBy: currentActive.revision + 1,
          };
        }
      }
      const nextRevision = (currentActive?.revision ?? 0) + 1;
      revisions.push({
        entryKey: kase.entryKey,
        memoryKey: kase.memoryKey,
        kind: currentActive?.kind ?? 'decision',
        revision: nextRevision,
        status: 'active',
        content: chosen.content,
        importance: chosen.importance,
        evidenceIds: sortedUnique(chosen.evidenceIds),
        evidenceCount: sortedUnique(chosen.evidenceIds).length,
        firstSeen: currentActive?.firstSeen ?? chosen.lastSeen,
        lastSeen: chosen.lastSeen,
        ...(currentActive ? { supersedes: currentActive.revision } : {}),
      });
    }
  }

  const nextCurated: CuratedState = {
    schema: 2,
    workspaceId: curated.workspaceId,
    revisions: revisions.sort((a, b) => {
      const k = compareStrings(a.entryKey, b.entryKey);
      return k !== 0 ? k : a.revision - b.revision;
    }),
    renderedAt: now.toISOString(),
  };
  validateCuratedState(nextCurated);

  const nextConflicts: ConflictState = kase
    ? {
        ...conflicts,
        cases: conflicts.cases.map((c) =>
          c.conflictId === event.conflictId
            ? {
                ...c,
                status: 'resolved' as const,
                resolvedAt: event.at,
                resolution: {
                  candidateId: event.candidateId,
                  actor: event.actor,
                  eventId: event.eventId,
                  rationale: event.rationale,
                  resultEntryKey: event.resultEntryKey,
                },
              }
            : c,
        ),
        renderedAt: now.toISOString(),
      }
    : conflicts;

  return { curated: nextCurated, conflicts: nextConflicts };
}

// —— 单条修订的治理动作（FR-M31 / FR-M34） ——
/**
 * 停用一条修订（FR-M34「关闭」）。
 *
 * 语义边界：`disabled` ≠ 删除 ≠ 被替代。
 * - 停用：保留在 canonical、可恢复、立即停止注入；
 * - 删除：真删（合规要求），但留下**域级墓碑**让「这个域被用户删掉了」可表达；
 * - 被替代：由新的 active 取代，历史仍可读。
 */
export function disableEntry(
  curated: CuratedState,
  entryKey: EntryKey,
  reason: string,
  now: Date,
): CuratedState {
  const active = activeOf(curated, entryKey);
  if (!active) throw new StaleConflictResolutionError('该域没有生效中的修订');
  const next: CuratedState = {
    ...curated,
    revisions: curated.revisions.map((r) =>
      r.entryKey === entryKey && r.revision === active.revision
        ? { ...r, status: 'disabled' as const, disabledReason: reason }
        : r,
    ),
    renderedAt: now.toISOString(),
  };
  validateCuratedState(next);
  return next;
}

/** 恢复一条被停用的修订（回到 active） */
export function enableEntry(curated: CuratedState, entryKey: EntryKey, now: Date): CuratedState {
  const revs = curated.revisions.filter((r) => r.entryKey === entryKey);
  if (revs.some((r) => r.status === 'active')) return curated;
  const candidate = [...revs].reverse().find((r) => r.status === 'disabled');
  if (!candidate) throw new StaleConflictResolutionError('该域没有可恢复的停用修订');
  const next: CuratedState = {
    ...curated,
    revisions: curated.revisions.map((r) =>
      r.entryKey === entryKey && r.revision === candidate.revision
        ? { ...r, status: 'active' as const, disabledReason: undefined }
        : r,
    ),
    renderedAt: now.toISOString(),
  };
  validateCuratedState(next);
  return next;
}

/**
 * 删除一条修订（FR-M31）。
 *
 * **不是简单地把行删掉**：那样「这个域被用户删掉了」就无从表达，而 `distill` 下次看到
 * 事实又会把它策展回来——用户删掉的东西自己长回来是最难解释的一类 bug（`memoryMerge`
 * 的段级墓碑解决的正是同一类问题）。故留下一条 `x:` 域级墓碑：内容为空、状态 disabled、
 * 带删除时刻与理由；`isDomainClosed` 见到它就不再自动复活该域。
 */
export function deleteEntry(
  curated: CuratedState,
  entryKey: EntryKey,
  reason: string,
  now: Date,
): CuratedState {
  const revs = curated.revisions.filter((r) => r.entryKey === entryKey);
  if (revs.length === 0) throw new StaleConflictResolutionError('该域不存在');
  const tombstoneKey = `x:${entryKey}` as EntryKey;
  if (curated.revisions.some((r) => r.entryKey === tombstoneKey)) return curated;

  const tombstone: CuratedEntry = {
    entryKey: tombstoneKey,
    memoryKey: entryKey,
    kind: 'convention',
    revision: 1,
    status: 'disabled',
    content: '',
    importance: 1,
    evidenceIds: [],
    evidenceCount: 0,
    firstSeen: now.toISOString(),
    lastSeen: now.toISOString(),
    disabledReason: reason,
    deletedAt: now.toISOString(),
  };

  const next: CuratedState = {
    ...curated,
    revisions: [
      ...curated.revisions.filter((r) => r.entryKey !== entryKey),
      tombstone,
    ].sort((a, b) => {
      const k = compareStrings(a.entryKey, b.entryKey);
      return k !== 0 ? k : a.revision - b.revision;
    }),
    renderedAt: now.toISOString(),
  };
  validateCuratedState(next);
  return next;
}

// —— 事务：意图构造与重启恢复（设计 §4.5） ——

/** 由一次裁决结果构造可重放的事务意图 */
export function buildResolutionIntent(
  input: ResolveConflictInput,
  before: { curated: CuratedState; conflicts: ConflictState },
  result: ResolveConflictResult,
  now: Date,
): ResolutionIntent {
  const body = {
    workspaceId: before.curated.workspaceId,
    conflictId: input.conflictId,
    candidateId: input.candidateId,
    eventId: input.eventId,
    actor: input.actor,
    rationale: input.rationale,
    before,
    after: { curated: result.nextCurated, conflicts: result.nextConflicts },
  };
  const transactionId = `tx_${hashContent(
    `${body.workspaceId}\u0000${input.eventId}\u0000${now.getTime()}`,
  )}`;
  return {
    transactionId,
    intentSha256: hashContent(JSON.stringify(body)),
    workspaceId: body.workspaceId,
    conflictId: body.conflictId,
    candidateId: body.candidateId,
    eventId: body.eventId,
    actor: body.actor,
    rationale: body.rationale,
    before,
    after: body.after,
    preparedAt: now.toISOString(),
  };
}

/** 一个事务在磁盘上已经推进到哪一阶段（由阶段事件流推出） */
export interface TxnProgress {
  transactionId: string;
  intent: ResolutionIntent;
  /** 已追加的阶段事件（按顺序）——**不包含**由 `reconcileTransaction` 推断的阶段 */
  phases: TxnPhase[];
  committed: boolean;
}

/**
 * 解析事务 journal 的**阶段事件流**。
 *
 * 严格校验：intent 必须出现在任何阶段事件之前；阶段必须按 `TXN_PHASES` 顺序推进
 * （允许重复追加同一阶段吗？不允许——重复说明有并发写，宁可报错也不要猜）；
 * `intentSha256` 必须与意图体一致（防篡改）。
 */
export function parseTransactionJournal(events: readonly TxnPhaseEvent[]): TxnProgress[] {
  const byTxn = new Map<string, { intent?: ResolutionIntent; phases: TxnPhase[] }>();
  const order: string[] = [];

  for (const ev of events ?? []) {
    if (!ev || typeof ev.transactionId !== 'string' || ev.transactionId === '') {
      throw new CorruptTransactionError('事务事件缺少 transactionId');
    }
    let slot = byTxn.get(ev.transactionId);
    if (!slot) {
      slot = { phases: [] };
      byTxn.set(ev.transactionId, slot);
      order.push(ev.transactionId);
    }

    if (ev.kind === 'intent') {
      if (slot.intent) throw new CorruptTransactionError(`事务 ${ev.transactionId} 重复写入 intent`);
      if (!ev.intent) throw new CorruptTransactionError(`事务 ${ev.transactionId} 的 intent 缺失`);
      if (slot.phases.length > 0) {
        throw new CorruptTransactionError(`事务 ${ev.transactionId} 的阶段事件早于 intent`);
      }
      const expected = hashContent(
        JSON.stringify({
          workspaceId: ev.intent.workspaceId,
          conflictId: ev.intent.conflictId,
          candidateId: ev.intent.candidateId,
          eventId: ev.intent.eventId,
          actor: ev.intent.actor,
          rationale: ev.intent.rationale,
          before: ev.intent.before,
          after: ev.intent.after,
        }),
      );
      if (expected !== ev.intent.intentSha256 || expected !== ev.intentSha256) {
        throw new CorruptTransactionError(`事务 ${ev.transactionId} 的 intent 与哈希不符（疑似篡改）`);
      }
      slot.intent = ev.intent;
      continue;
    }

    if (ev.kind !== 'phase' || !ev.phase) {
      throw new CorruptTransactionError(`事务 ${ev.transactionId} 的事件类型非法`);
    }
    if (!slot.intent) throw new CorruptTransactionError(`事务 ${ev.transactionId} 的阶段事件早于 intent`);
    if (ev.intentSha256 !== slot.intent.intentSha256) {
      throw new CorruptTransactionError(`事务 ${ev.transactionId} 的阶段事件哈希与 intent 不符`);
    }
    const expectedNext = TXN_PHASES[slot.phases.length];
    if (ev.phase !== expectedNext) {
      throw new CorruptTransactionError(
        `事务 ${ev.transactionId} 阶段跳跃：期望 ${expectedNext}，实际 ${ev.phase}`,
      );
    }
    slot.phases.push(ev.phase);
  }

  return order.map((id) => {
    const slot = byTxn.get(id) as { intent: ResolutionIntent; phases: TxnPhase[] };
    return {
      transactionId: id,
      intent: slot.intent,
      phases: slot.phases,
      committed: slot.phases.includes('committed'),
    };
  });
}

/** 恢复动作：重做整条 / 从某个阶段继续 / 什么都不做 */
export type ReconcileAction = 'redo' | 'continue' | 'noop';

/** 由磁盘现状推出的目标阶段与动作 */
export interface ReconcilePlan {
  action: ReconcileAction;
  /** 磁盘上的 canonical 状态已经推进到了哪一步 */
  observed: 'before' | 'after_curated' | 'after_both';
  /** 是否已写过审计（决定要不要跳过 audit_appended） */
  auditPresent: boolean;
}

/** 比较两个 canonical 状态是否逐字节等价（用规范化 JSON） */
function sameCanonical(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** 稳定序列化（对象键排序），用于「是不是同一份」的比较 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort((a, b) => compareStrings(a[0], b[0]));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * 根据**磁盘现状**决定一个未完成事务该怎么走（FR-M18）。
 *
 * ```
 * curated == before  → redo（整条重做）
 * curated == after   → continue（跳过已完成的阶段）
 * 两者都不是          → fail-closed（抛 UnrecoverableTransactionError）
 * ```
 *
 * 为什么「既不是 before 也不是 after」必须 fail-closed 而不是回滚：那种状态说明
 * **有别人写过**（另一台设备的落地、用户手工编辑、或更晚的一次蒸馏）。按 before 回滚
 * 会用旧状态覆盖更新的证据；按 after 覆盖则会抹掉别人的写入。两种都错，所以只能停下来。
 */
export function planRecovery(
  progress: TxnProgress,
  onDisk: { curated: CuratedState; conflicts: ConflictState },
  progressFromDisk: TxnProgress,
  auditPresent: boolean,
): ReconcilePlan {
  const curatedIsBefore = sameCanonical(onDisk.curated, progress.intent.before.curated);
  const curatedIsAfter = sameCanonical(onDisk.curated, progress.intent.after.curated);
  const conflictsIsBefore = sameCanonical(onDisk.conflicts, progress.intent.before.conflicts);
  const conflictsIsAfter = sameCanonical(onDisk.conflicts, progress.intent.after.conflicts);

  if (!curatedIsBefore && !curatedIsAfter) {
    throw new UnrecoverableTransactionError(
      `事务 ${progress.transactionId}：curated.json 既不是 before 也不是 after，` +
        '可能已有更新的写入；拒绝覆盖，请人工检查',
    );
  }
  if (!conflictsIsBefore && !conflictsIsAfter) {
    throw new UnrecoverableTransactionError(
      `事务 ${progress.transactionId}：conflicts.json 既不是 before 也不是 after，` +
        '可能已有更新的写入；拒绝覆盖，请人工检查',
    );
  }

  const observed: ReconcilePlan['observed'] =
    curatedIsAfter && conflictsIsAfter
      ? 'after_both'
      : curatedIsAfter
        ? 'after_curated'
        : 'before';

  if (observed === 'before') {
    void progressFromDisk;
    return { action: 'redo', observed, auditPresent };
  }
  if (observed === 'after_both' && progressFromDisk.committed) {
    return { action: 'noop', observed, auditPresent };
  }
  return { action: 'continue', observed, auditPresent };
}
