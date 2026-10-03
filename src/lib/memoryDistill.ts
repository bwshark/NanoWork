/**
 * 蒸馏：把 append-only 的**证据**（事实）变成有损的**结论**（策展修订）。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M5 … FR-M12；设计：`docs/architecture-memory-v2.md` §4.3。
 *
 * ## 这个模块的立场
 *
 * **不让 LLM 决定「什么值得永远记住」。** 生产系统可以在候选提取阶段用模型，但
 * 「什么能晋升、作用域是什么、证据关系如何」必须由 harness 的显式策略控制——模型会被
 * 提示注入污染，也会猜测。所以本模块是纯函数，**不调用任何模型**（s10 的核心增量）。
 *
 * ## 纯函数契约（NFR-M1 / NFR-M12）
 *
 * 不读时钟（时间来自 `now` 与 `evidence.observedAt`）、不读随机数、不读 locale、
 * 不依赖 Map 迭代顺序；返回前所有集合排序。校验标准：**打乱 `facts` 输入顺序，
 * 输出的 canonical JSON 逐字节相同**。
 *
 * ## 六个容易写错的地方（设计 §4.3.1）
 *
 * 1. `renderedAt` 取 `now`（不读系统时钟）；
 * 2. `evidenceIds` **排序后存储**；
 * 3. `firstSeen` / `lastSeen` 由 evidence 派生（**不是** `now`——用 `now` 会让幂等破产，
 *    且替代门槛会随时间自己变严，同一条事实今天不能替代、明天就能）；
 * 4. `observedAt` 的「缺省当前时间」只存在于调用侧（`createMemoryFact` 显式收 `now`）；
 * 5. 跨时区的日文件归属由调用方处理（本模块只认 `observedAt`）；
 * 6. 一切字符串比较用 `<`（`compareStrings`），禁用 `localeCompare`。
 */

import type {
  ConflictCandidate,
  ConflictCase,
  CuratedEntry,
  CuratedState,
  DistillPolicy,
  DistillReport,
  EntryKey,
  FactKind,
  MemoryFact,
} from '@/types';
import { compareStrings, normalizeForDedup, sortedUnique } from '@/lib/memoryNormalize';
import { displayKeyOf, entryKeyForFact } from '@/lib/memoryFact';
import { hashContent } from '@/lib/workspaceKey';

/** 默认蒸馏策略（与 s10 的口径一致；用户可在设置页放宽） */
export const DEFAULT_DISTILL_POLICY: DistillPolicy = {
  retentionDays: 30,
  minImportance: 4,
  repeatThreshold: 2,
  supersessionRepeatThreshold: 2,
  promotableKinds: ['decision', 'convention', 'pitfall'],
};

/** 策展状态损坏（域内多个 active、修订链断裂等）——**显式报错，不静默选一个答案** */
export class CorruptCuratedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptCuratedStateError';
  }
}

/** 空策展状态（首次使用时） */
export function emptyCuratedState(workspaceId: string, now: Date): CuratedState {
  return { schema: 2, workspaceId, revisions: [], renderedAt: now.toISOString() };
}

// —— 修订的构造与校验 ——

/** 某个域的全部修订（按 revision 升序） */
export function revisionsOf(state: CuratedState, entryKey: EntryKey): CuratedEntry[] {
  return (state?.revisions ?? [])
    .filter((r) => r.entryKey === entryKey)
    .sort((a, b) => a.revision - b.revision);
}

/** 某个域的 active 修订；没有则 null（域被停用 / 删除 / 尚未策展） */
export function activeOf(state: CuratedState, entryKey: EntryKey): CuratedEntry | null {
  return (state?.revisions ?? []).find((r) => r.entryKey === entryKey && r.status === 'active') ?? null;
}

/**
 * 某个域是否已被用户显式终结（停用或删除）——域终态不得被后续蒸馏自动复活。
 *
 * ## 两种终态是两套表示，必须都认（实施时踩到的真实 bug）
 *
 * | 动作 | canonical 里的表示 | 判据 |
 * |---|---|---|
 * | 停用（FR-M34） | `entryKey` 域内出现 `status === 'disabled'` | 该域没有 active **且** 有 disabled |
 * | 删除（FR-M31） | **另起**一个 `x:<entryKey>` 域承载墓碑 | `x:<entryKey>` 域存在 |
 *
 * 删除刻意**不复用**原域：原域的所有修订都被移除了，得有个地方记「这个域被删掉了」。
 * 只检查原域会漏掉删除，于是下一次蒸馏看到事实又把结论写回来——用户删掉的东西自己
 * 长回来是最难解释的一类 bug。
 */
export function isDomainClosed(state: CuratedState, entryKey: EntryKey): boolean {
  // 删除：墓碑域存在即视为该域已终结
  const tombstoneKey = `x:${entryKey}` as EntryKey;
  if ((state?.revisions ?? []).some((r) => r.entryKey === tombstoneKey)) return true;

  const revs = revisionsOf(state, entryKey);
  if (revs.length === 0) return false;
  if (revs.some((r) => r.status === 'active')) return false;
  // 没有 active：要么全部被替代（异常）、要么域被停用（终态）
  return revs.some((r) => r.status === 'disabled');
}

/**
 * 校验策展状态的不变量（设计 §8 的 I2 / I3）。
 *
 * - **至多一个** `active`（不是「恰好一个」）：停用与删除都必须能让一个域合法地没有
 *   active，否则用户点一次「停用」就会让整份记忆被判损坏；
 * - `revision` 连续（同一域内 1..N，无洞）；
 * - `supersedes` / `supersededBy` 互相指向且指向存在的修订；
 * - `evidenceIds` 已去重排序。
 *
 * 任一不满足即抛 `CorruptCuratedStateError`——**不静默挑一个值**：策展状态是长期资产，
 * 猜错了用户永远不会发现。
 */
export function validateCuratedState(state: CuratedState): void {
  if (!state || state.schema !== 2) {
    throw new CorruptCuratedStateError('策展状态 schema 不是 2');
  }
  if (typeof state.workspaceId !== 'string' || state.workspaceId === '') {
    throw new CorruptCuratedStateError('策展状态缺少 workspaceId');
  }

  const byKey = new Map<EntryKey, CuratedEntry[]>();
  for (const rev of state.revisions ?? []) {
    const list = byKey.get(rev.entryKey) ?? [];
    list.push(rev);
    byKey.set(rev.entryKey, list);
  }

  for (const [entryKey, revs] of byKey) {
    const sorted = [...revs].sort((a, b) => a.revision - b.revision);

    const actives = sorted.filter((r) => r.status === 'active');
    if (actives.length > 1) {
      throw new CorruptCuratedStateError(`冲突域 ${entryKey} 有 ${actives.length} 个 active 修订`);
    }

    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].revision !== i + 1) {
        throw new CorruptCuratedStateError(
          `冲突域 ${entryKey} 的 revision 不连续：期望 ${i + 1}，实际 ${sorted[i].revision}`,
        );
      }
    }

    const byRevision = new Map<number, CuratedEntry>();
    for (const rev of sorted) byRevision.set(rev.revision, rev);

    for (const rev of sorted) {
      if (rev.supersedes !== undefined) {
        const prev = byRevision.get(rev.supersedes);
        if (!prev) {
          throw new CorruptCuratedStateError(
            `冲突域 ${entryKey} 的修订 ${rev.revision} 指向不存在的 supersedes=${rev.supersedes}`,
          );
        }
        if (prev.supersededBy !== rev.revision) {
          throw new CorruptCuratedStateError(
            `冲突域 ${entryKey} 的 supersedes 链接不成对：${rev.supersedes} → ${rev.revision}`,
          );
        }
      }
      if (rev.supersededBy !== undefined) {
        const next = byRevision.get(rev.supersededBy);
        if (!next) {
          throw new CorruptCuratedStateError(
            `冲突域 ${entryKey} 的修订 ${rev.revision} 指向不存在的 supersededBy=${rev.supersededBy}`,
          );
        }
        if (next.supersedes !== rev.revision) {
          throw new CorruptCuratedStateError(
            `冲突域 ${entryKey} 的 supersededBy 链接不成对：${rev.revision} → ${rev.supersededBy}`,
          );
        }
      }
    }
  }
}

// —— 分组与门槛 ——

/** 一个冲突域的事实集合（已排序） */
interface FactGroup {
  entryKey: EntryKey;
  facts: MemoryFact[];
}

/** 按 `entryKey` 分组（顺序稳定：按 entryKey 字典序） */
export function groupFactsByDomain(facts: readonly MemoryFact[]): FactGroup[] {
  const byKey = new Map<EntryKey, MemoryFact[]>();
  for (const fact of facts ?? []) {
    const key = entryKeyForFact(fact);
    const list = byKey.get(key) ?? [];
    list.push(fact);
    byKey.set(key, list);
  }
  return [...byKey.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([entryKey, list]) => ({
      entryKey,
      facts: [...list].sort((a, b) => {
        const d = Date.parse(a.observedAt) - Date.parse(b.observedAt);
        return d !== 0 ? d : compareStrings(a.factId, b.factId);
      }),
    }));
}

/**
 * 一条事实是否**豁免年龄门槛**。
 *
 * 唯一的豁免是 `origin === 'manual'`——用户记忆页里手打的一句话。
 *
 * 为什么手编不算「这一轮的临时结论」：`retentionDays` 拦的是**模型自动沉淀**的噪声
 * （刚写下的决策当天就升格，等于把过程记录当成项目约定）。而手编是用户**显式输入**，
 * 语义上已经过了「用户确认要记住」这道门。把它也拦下会撞上设计
 * `architecture-memory-v2.md` §12 问题 1 的目标（手编内容**不被重建吃掉**）：
 * 表现为「点保存 → 内容当场从文件里消失，30 天后才回来」，且 toast 还在说「已登记」。
 *
 * 抽成一个判据而不是在两处各写一遍条件：年龄门槛在 `passesPromotionGate` 与
 * `distillFacts` 里各判一次，两处漂移会让「门槛过了但候选为空」这类症状极难查。
 */
function isAgeExempt(fact: MemoryFact): boolean {
  return fact.origin === 'manual';
}

/**
 * 门槛判定（FR-M5）：**并且**满足三类才可晋升。
 *
 * ```
 * (observedAt ≤ now - retentionDays 或 origin === 'manual')
 * AND kind ∈ promotableKinds
 * AND (importance ≥ minImportance OR 同一归一化内容出现次数 ≥ repeatThreshold)
 * ```
 *
 * 第一条件的用意不是「旧的才好」：刚写下的一条决策当天就进长期记忆，等于把「这一轮的
 * 临时结论」直接升格为项目约定。等它活过 30 天还没被推翻，才是值得留的。手编例外
 * 见 `isAgeExempt`。
 */
export function passesPromotionGate(
  facts: readonly MemoryFact[],
  policy: DistillPolicy,
  now: Date,
): boolean {
  const cutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;
  const eligible = (facts ?? []).filter(
    (f) =>
      policy.promotableKinds.includes(f.kind) &&
      Number.isFinite(Date.parse(f.observedAt)) &&
      (isAgeExempt(f) || Date.parse(f.observedAt) <= cutoff),
  );
  if (eligible.length === 0) return false;

  const maxImportance = eligible.reduce((m, f) => (f.importance > m ? f.importance : m), 0);
  if (maxImportance >= policy.minImportance) return true;

  // 同一归一化内容出现 ≥ repeatThreshold 次也算过（「重复出现即重要」）
  const counts = new Map<string, number>();
  for (const f of eligible) {
    const key = `${f.kind}\u0000${normalizeForDedup(f.content)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n >= policy.repeatThreshold);
}

// —— 候选排序 ——

/** 一个候选（同域内一组「归一化后内容相同」的事实） */
interface CandidateGroup {
  content: string;
  kind: FactKind;
  evidenceIds: string[];
  evidenceCount: number;
  importance: number;
  firstSeen: string;
  lastSeen: string;
  normalized: string;
}

/** 把一个域的事实按「归一化内容」聚成候选，并按排序键排好（确定性） */
function buildCandidates(facts: readonly MemoryFact[]): CandidateGroup[] {
  const byContent = new Map<string, MemoryFact[]>();
  for (const fact of facts) {
    const key = normalizeForDedup(fact.content);
    const list = byContent.get(key) ?? [];
    list.push(fact);
    byContent.set(key, list);
  }

  const groups: CandidateGroup[] = [];
  for (const list of byContent.values()) {
    const sorted = [...list].sort((a, b) => {
      const d = Date.parse(a.observedAt) - Date.parse(b.observedAt);
      return d !== 0 ? d : compareStrings(a.factId, b.factId);
    });
    // 内容取**最新那条的原文**（同一归一化键下措辞可能略有差异，取最近的表达）
    const newest = sorted[sorted.length - 1];
    const evidenceIds = sortedUnique(sorted.map((f) => f.factId));
    const times = sorted.map((f) => new Date(Date.parse(f.observedAt)).toISOString());
    groups.push({
      content: newest.content,
      kind: newest.kind,
      evidenceIds,
      evidenceCount: evidenceIds.length,
      importance: sorted.reduce((m, f) => (f.importance > m ? f.importance : m), 0),
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
      normalized: newest.content,
    });
  }

  // 排序键：importance DESC → evidenceCount DESC → lastSeen DESC → 内容 ASC（决定性）
  return groups.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    if (b.evidenceCount !== a.evidenceCount) return b.evidenceCount - a.evidenceCount;
    const dt = Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
    if (dt !== 0) return dt;
    return compareStrings(a.normalized, b.normalized);
  });
}

/** 两个候选是否「同分」（importance、独立证据数、最新时间全相同）→ fail-closed */
function isTie(a: CandidateGroup, b: CandidateGroup): boolean {
  return (
    a.importance === b.importance &&
    a.evidenceCount === b.evidenceCount &&
    Date.parse(a.lastSeen) === Date.parse(b.lastSeen)
  );
}

// —— 主流程 ——

/** `distillFacts` 的返回 */
export interface DistillOutcome {
  next: CuratedState;
  newCases: ConflictCase[];
  report: DistillReport;
}

/**
 * 蒸馏主流程。**幂等**：同 `(facts, prev, policy, now)` 必得同一结果。
 *
 * 逐条对应 s10 的规则（设计 §4.3 的算法框）：
 * 1. 过门槛的域才有候选；
 * 2. 无 active → 最高分候选成为修订 1；
 * 3. 有 active 且候选内容与之归一化后相同 → **只合并 evidence**（不产生新修订）；
 * 4. 内容不同 → 必须**同时**过三关（自身过门槛 / 独立证据数达标 / 时间严格更新），
 *    任缺即拒绝（`stale` 或计入 `skipped`）；
 * 5. 最高分**并列** → fail-closed：不动 active，创建 / 推进冲突案件；
 * 6. 域被用户停用或删除 → 不复活，候选进案件等人工裁决。
 */
export function distillFacts(
  facts: readonly MemoryFact[],
  prev: CuratedState,
  policy: DistillPolicy,
  now: Date,
  scopeId?: string,
): DistillOutcome {
  if (!prev || prev.schema !== 2) {
    throw new CorruptCuratedStateError('策展状态 schema 不是 2');
  }
  validateCuratedState(prev);

  const report: DistillReport = {
    promoted: 0,
    merged: 0,
    superseded: 0,
    conflicts: 0,
    queuedConflicts: 0,
    conflictCaseIds: [],
    stale: 0,
    skipped: 0,
  };

  const revisions: CuratedEntry[] = (prev.revisions ?? []).map((r) => ({
    ...r,
    evidenceIds: sortedUnique(r.evidenceIds),
  }));
  const newCases: ConflictCase[] = [];
  const cutoffMs = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;
  const seenCaseKeys = new Set<string>();

  for (const group of groupFactsByDomain(facts)) {
    // 域终态（停用 / 删除）不被自动复活：候选只能进案件等人工裁决
    if (isDomainClosed(prev, group.entryKey)) {
      const candidates = buildCandidates(group.facts);
      if (candidates.length > 0) {
        report.conflicts += 1;
        const kase = buildConflictCase(group.entryKey, candidates, group.facts, prev, now, scopeId);
        if (kase && !seenCaseKeys.has(kase.conflictId)) {
          seenCaseKeys.add(kase.conflictId);
          newCases.push(kase);
          report.queuedConflicts += 1;
          report.conflictCaseIds.push(kase.conflictId);
        }
      }
      continue;
    }

    // 只有「够老且 kind 可晋升」的事实参与（未过门槛的连候选都不算）。
    //
    // `origin === 'legacy'` 的**明确排除**：它们是 v1 Markdown 段落的只读投影，
    // 已经在长期记忆里了，再晋升一次只会把「过程记录」误当「稳定结论」——
    // 而且它们的 `observedAt` 多半落成 epoch，会永远满足「够老」这一条。
    //
    // `origin === 'manual'` 豁免年龄门槛（见 `isAgeExempt`）：用户手写的内容必须
    // 当场出现在投影里，否则「保存 = 内容消失」。
    const eligibleFacts = group.facts.filter(
      (f) =>
        f.origin !== 'legacy' &&
        policy.promotableKinds.includes(f.kind) &&
        Number.isFinite(Date.parse(f.observedAt)) &&
        (isAgeExempt(f) || Date.parse(f.observedAt) <= cutoffMs),
    );
    if (!passesPromotionGate(group.facts, policy, now)) {
      report.skipped += 1;
      continue;
    }

    const candidates = buildCandidates(eligibleFacts);
    if (candidates.length === 0) {
      report.skipped += 1;
      continue;
    }

    const active = activeOf(prev, group.entryKey);

    // ① 首次策展
    if (!active) {
      const best = candidates[0];
      revisions.push(entryFromCandidate(group.entryKey, 1, best, active));
      report.promoted += 1;
      continue;
    }

    // ② 候选与 active 归一化后相同 → 只合并 evidence
    const activeNorm = normalizeForDedup(active.content);
    const sameAsActive = candidates.filter((c) => normalizeForDedup(c.content) === activeNorm);
    if (candidates.length === sameAsActive.length) {
      const mergedIds = sortedUnique([
        ...active.evidenceIds,
        ...sameAsActive.flatMap((c) => c.evidenceIds),
      ]);
      const lastSeen = maxIso([active.lastSeen, ...sameAsActive.map((c) => c.lastSeen)]);
      if (mergedIds.length !== active.evidenceIds.length || lastSeen !== active.lastSeen) {
        replaceEntry(revisions, {
          ...active,
          evidenceIds: mergedIds,
          evidenceCount: mergedIds.length,
          lastSeen,
        });
        report.merged += 1;
      }
      continue;
    }

    // ③ 有不同内容 → 三关
    const challengers = candidates.filter((c) => normalizeForDedup(c.content) !== activeNorm);
    const top = challengers[0];
    const tied = challengers.filter((c) => isTie(c, top));

    if (tied.length > 1) {
      // 同分 → fail-closed：保留 incumbent，建案
      report.conflicts += 1;
      const kase = buildConflictCase(group.entryKey, tied.slice(0, 2), group.facts, prev, now, scopeId);
      if (kase && !seenCaseKeys.has(kase.conflictId)) {
        seenCaseKeys.add(kase.conflictId);
        newCases.push(kase);
        report.queuedConflicts += 1;
        report.conflictCaseIds.push(kase.conflictId);
      }
      continue;
    }

    // 门槛①：候选自身过门槛（它的重要度或重复次数达标）
    const selfGate = passesPromotionGate(
      eligibleFacts.filter((f) => normalizeForDedup(f.content) === normalizeForDedup(top.content)),
      policy,
      now,
    );
    // 门槛②：独立事实数达标
    const enoughEvidence = top.evidenceCount >= policy.supersessionRepeatThreshold;
    // 门槛③：候选最新时间**严格晚于** active 的 lastSeen（时间不新不能回滚当前值）
    const newerThanActive = Date.parse(top.lastSeen) > Date.parse(active.lastSeen);

    if (!selfGate || !enoughEvidence) {
      report.skipped += 1;
      continue;
    }
    if (!newerThanActive) {
      report.stale += 1;
      continue;
    }

    const nextRevision = active.revision + 1;
    replaceEntry(revisions, {
      ...active,
      status: 'superseded',
      supersededBy: nextRevision,
    });
    revisions.push(entryFromCandidate(group.entryKey, nextRevision, top, active));
    report.superseded += 1;
  }

  const next: CuratedState = {
    schema: 2,
    workspaceId: prev.workspaceId,
    revisions: sortRevisions(revisions),
    renderedAt: now.toISOString(),
  };
  validateCuratedState(next);
  return { next, newCases, report };
}

// —— 内部工具 ——

/** 由候选构造一条修订 */
function entryFromCandidate(
  entryKey: EntryKey,
  revision: number,
  candidate: CandidateGroup,
  previous: CuratedEntry | null,
): CuratedEntry {
  return {
    entryKey,
    memoryKey: displayKeyOf(entryKey),
    kind: candidate.kind,
    revision,
    status: 'active',
    content: candidate.content,
    importance: candidate.importance,
    evidenceIds: sortedUnique(candidate.evidenceIds),
    evidenceCount: candidate.evidenceCount,
    firstSeen: candidate.firstSeen,
    lastSeen: candidate.lastSeen,
    ...(previous ? { supersedes: previous.revision } : {}),
  };
}

/** 就地替换同 (entryKey, revision) 的修订 */
function replaceEntry(revisions: CuratedEntry[], next: CuratedEntry): void {
  const idx = revisions.findIndex(
    (r) => r.entryKey === next.entryKey && r.revision === next.revision,
  );
  if (idx === -1) revisions.push(next);
  else revisions[idx] = next;
}

/** 全部修订的稳定排序（entryKey ASC → revision ASC） */
function sortRevisions(revisions: readonly CuratedEntry[]): CuratedEntry[] {
  return [...revisions].sort((a, b) => {
    const k = compareStrings(a.entryKey, b.entryKey);
    return k !== 0 ? k : a.revision - b.revision;
  });
}

/** 取时间上最新的 ISO 字符串 */
function maxIso(values: readonly string[]): string {
  let best = '';
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = new Date(ms).toISOString();
    }
  }
  return best === '' ? new Date(0).toISOString() : best;
}

/** 由候选构造冲突案件（确定性 id：同证据同 id，重启不重复建案） */
export function buildConflictCase(
  entryKey: EntryKey,
  candidates: readonly CandidateGroup[],
  observedFacts: readonly MemoryFact[],
  prev: CuratedState,
  now: Date,
  scopeId?: string,
): ConflictCase | null {
  if (candidates.length === 0) return null;
  const active = activeOf(prev, entryKey);
  const observedFactIds = sortedUnique(observedFacts.map((f) => f.factId));
  const fingerprint = hashContent(observedFactIds.join('\u0000'));
  const scope = scopeId ?? prev.workspaceId;
  const conflictId = `cf_${hashContent(`${scope}\u0000${entryKey}\u0000${fingerprint}`)}`;

  const conflictCandidates: ConflictCandidate[] = candidates.map((c) => ({
    candidateId: candidateIdFor(entryKey, c),
    entryKey,
    content: c.content,
    revision: (active?.revision ?? 0) + 1,
    evidenceIds: sortedUnique(c.evidenceIds),
    importance: c.importance,
    lastSeen: c.lastSeen,
  }));

  // **incumbent 必须也是一个可选项**。
  //
  // 否则「保持现状」在 UI 上无从表达：用户只能从两个挑战者里挑一个，或者不裁决。
  // 而 FR-M14 明确要求「选 incumbent → 只记审计、不产生新修订」——那条分支的存在
  // 前提就是 incumbent 在候选集合里。实施时漏掉过这一条，页面上根本无法表达「维持原样」。
  if (active && !conflictCandidates.some((c) => c.content === active.content)) {
    conflictCandidates.push({
      candidateId: candidateIdFor(entryKey, { content: active.content }),
      entryKey,
      content: active.content,
      revision: active.revision,
      evidenceIds: sortedUnique(active.evidenceIds),
      importance: active.importance,
      lastSeen: active.lastSeen,
    });
  }

  return {
    conflictId,
    revision: 1,
    status: 'open',
    scopeId: scope,
    memoryKey: displayKeyOf(entryKey),
    entryKey,
    candidates: conflictCandidates,
    observedFactIds,
    activeEntryKey: active ? active.entryKey : null,
    activeRevision: active ? active.revision : null,
    evidenceFingerprint: fingerprint,
    detectedAt: now.toISOString(),
  };
}

/** 候选 id（确定性） */
export function candidateIdFor(entryKey: EntryKey, candidate: { content: string; revision?: number }): string {
  return `c_${hashContent(`${entryKey}\u0000${normalizeForDedup(candidate.content)}`)}`;
}
