/**
 * 人工裁决与事务恢复（`src/lib/memoryAdjudicate.ts`）。
 *
 * 这一层保护的是**长期资产**：一条错误的裁决会把错的结论固化下来，而一次损坏的恢复
 * 会把整份记忆变成互相矛盾的状态。测试按设计 §4.4 / §4.5 的契约组织：
 *
 * 1. **五条校验**（FR-M13）：陈旧 revision / active 变了 / fingerprint 变了 / 候选不属于
 *    案件 → 一律 `StaleConflictResolutionError`（要求重看）；同 id 换参数 →
 *    `ConflictEventReuseError`（要求换 key）——两类错误的处置动作不同。
 * 2. **幂等**（FR-M15）：同 `eventId` 同参重试返回原事件，不重复写审计、不重复建修订。
 * 3. **分支语义**（FR-M14）：选 challenger 产生新修订；选 incumbent **不产生**新修订。
 * 4. **域终态**（FR-M31/FR-M34）：停用可恢复；删除留**域级墓碑**，`distill` 不再复活。
 * 5. **事务 journal**（FR-M17）：阶段必须按序、intent 必须最先、哈希不符即报错。
 * 6. **重启判定**（FR-M18）：before → redo；after → continue；**两者都不是 → fail-closed**。
 */

import { describe, expect, it } from 'vitest';
import type {
  AdjudicationEvent,
  ConflictCase,
  ConflictState,
  CuratedState,
  ResolutionIntent,
  TxnPhase,
  TxnPhaseEvent,
} from '../../src/types';
import {
  ConflictEventReuseError,
  ConflictNotFoundError,
  CorruptTransactionError,
  StaleConflictResolutionError,
  UnrecoverableTransactionError,
  buildResolutionIntent,
  deleteEntry,
  disableEntry,
  emptyConflictState,
  enableEntry,
  mergeNewCases,
  openConflicts,
  parseTransactionJournal,
  planRecovery,
  resolveConflict,
  supersedeStaleCases,
} from '../../src/lib/memoryAdjudicate';
import { activeOf, isDomainClosed } from '../../src/lib/memoryDistill';

const NOW = new Date('2026-10-02T00:00:00Z');
const NOW_ISO = NOW.toISOString();
const WS = 'w_test';
const KEY = 'k:storage.db' as const;

/** 一个「有 active 修订 + 一个 open 案件」的起点 */
function fixture(): { curated: CuratedState; conflicts: ConflictState } {
  const curated: CuratedState = {
    schema: 2,
    workspaceId: WS,
    renderedAt: NOW_ISO,
    revisions: [
      {
        entryKey: KEY,
        memoryKey: 'storage.db',
        kind: 'decision',
        revision: 1,
        status: 'active',
        content: '用 SQLite',
        importance: 4,
        evidenceIds: ['f_a', 'f_b'],
        evidenceCount: 2,
        firstSeen: '2026-08-10T00:00:00.000Z',
        lastSeen: '2026-08-10T00:00:00.000Z',
      },
    ],
  };
  const kase: ConflictCase = {
    conflictId: 'cf_1',
    revision: 1,
    status: 'open',
    scopeId: WS,
    memoryKey: 'storage.db',
    entryKey: KEY,
    candidates: [
      {
        candidateId: 'c_sqlite',
        entryKey: KEY,
        content: '用 SQLite',
        revision: 2,
        evidenceIds: ['f_a', 'f_b'],
        importance: 4,
        lastSeen: '2026-08-10T00:00:00.000Z',
      },
      {
        candidateId: 'c_pg',
        entryKey: KEY,
        content: '用 Postgres',
        revision: 2,
        evidenceIds: ['f_c', 'f_d'],
        importance: 4,
        lastSeen: '2026-08-27T00:00:00.000Z',
      },
    ],
    observedFactIds: ['f_a', 'f_b', 'f_c', 'f_d'],
    activeEntryKey: KEY,
    activeRevision: 1,
    evidenceFingerprint: 'fp_1',
    detectedAt: NOW_ISO,
  };
  return {
    curated,
    conflicts: { schema: 2, workspaceId: WS, cases: [kase], renderedAt: NOW_ISO },
  };
}

function resolve(
  input: Partial<Parameters<typeof resolveConflict>[0]> = {},
  events: AdjudicationEvent[] = [],
  facts?: string[],
) {
  const { curated, conflicts } = fixture();
  return resolveConflict(
    {
      conflictId: 'cf_1',
      candidateId: 'c_pg',
      expectedRevision: 1,
      actor: 'local-user',
      rationale: '生产要 Postgres 扩展',
      eventId: 'ev_1',
      ...input,
    },
    curated,
    conflicts,
    events,
    NOW,
    facts,
  );
}

describe('五条校验（FR-M13）：陈旧保护', () => {
  it('预期的案件版本与现状不符 → StaleConflictResolutionError', () => {
    expect(() => resolve({ expectedRevision: 2 })).toThrow(StaleConflictResolutionError);
  });

  it('案件已不是 open → StaleConflictResolutionError', () => {
    const { curated, conflicts } = fixture();
    const closed: ConflictState = {
      ...conflicts,
      cases: [{ ...conflicts.cases[0], status: 'resolved' }],
    };
    expect(() =>
      resolveConflict(
        {
          conflictId: 'cf_1',
          candidateId: 'c_pg',
          expectedRevision: 1,
          actor: 'u',
          rationale: 'r',
          eventId: 'e',
        },
        curated,
        closed,
        [],
        NOW,
      ),
    ).toThrow(/已不是待裁决状态/);
  });

  it('当前 active 已变（revision 不是检测时那个）→ StaleConflictResolutionError', () => {
    const { curated, conflicts } = fixture();
    // 该域已经自行演进到 revision 2：案件检测时记的是 revision 1 的 active
    const moved: CuratedState = {
      ...curated,
      revisions: [
        { ...curated.revisions[0], status: 'superseded' as const, supersededBy: 2 },
        {
          ...curated.revisions[0],
          revision: 2,
          status: 'active' as const,
          content: '用 MySQL',
          supersedes: 1,
        },
      ],
    };
    expect(() =>
      resolveConflict(
        {
          conflictId: 'cf_1',
          candidateId: 'c_pg',
          expectedRevision: 1,
          actor: 'u',
          rationale: 'r',
          eventId: 'e',
        },
        moved,
        conflicts,
        [],
        NOW,
      ),
    ).toThrow(/生效版本已从|已变化/);
  });

  it('证据 fingerprint 与快照不符 → StaleConflictResolutionError（旧页面点提交）', () => {
    expect(() => resolve({}, [], ['f_a', 'f_b', 'f_c'])).toThrow(/证据已变化/);
  });

  it('候选不属于该案件 → StaleConflictResolutionError', () => {
    expect(() => resolve({ candidateId: 'c_nope' })).toThrow(/候选不属于该案件/);
  });

  it('找不到案件 → ConflictNotFoundError', () => {
    expect(() => resolve({ conflictId: 'cf_nope' })).toThrow(ConflictNotFoundError);
  });

  it('理由为空 → 拒绝（审计里必须能解释为什么）', () => {
    expect(() => resolve({ rationale: '   ' })).toThrow(StaleConflictResolutionError);
  });
});

describe('幂等（FR-M15）：同 eventId', () => {
  it('同参重试返回原事件，不重复建修订', () => {
    const first = resolve();
    expect(first.applied).toBe(true);
    const revisions = first.nextCurated.revisions.map((r) => r.revision);
    expect(revisions).toEqual([1, 2]);

    const second = resolve({}, [first.adjudication]);
    expect(second.applied).toBe(false);
    // 幂等的判据：**没有**再多出一条修订，且返回的仍是原事件
    expect(second.nextCurated.revisions.map((r) => r.revision)).toEqual(revisions);
    expect(second.nextCurated.revisions).toHaveLength(first.nextCurated.revisions.length);
    expect(second.adjudication).toEqual(first.adjudication);
  });

  it('同 eventId 换候选 → ConflictEventReuseError（要求换 key，不是刷新）', () => {
    const first = resolve();
    expect(() => resolve({ candidateId: 'c_sqlite' }, [first.adjudication])).toThrow(
      ConflictEventReuseError,
    );
  });
});

describe('分支语义（FR-M14）', () => {
  it('选 challenger：旧版 superseded、新版 active、链接成对', () => {
    const out = resolve();
    const revs = out.nextCurated.revisions.filter((r) => r.entryKey === KEY);
    expect(revs).toHaveLength(2);
    expect(revs[0].status).toBe('superseded');
    expect(revs[0].supersededBy).toBe(2);
    expect(revs[1].status).toBe('active');
    expect(revs[1].content).toBe('用 Postgres');
    expect(revs[1].supersedes).toBe(1);
    expect(out.adjudication.choseChallenger).toBe(true);
    expect(out.resultEntryKey).toBe(KEY);
  });

  it('选 incumbent：**不产生**新修订，只记审计', () => {
    const out = resolve({ candidateId: 'c_sqlite' });
    expect(out.applied).toBe(true);
    expect(out.adjudication.choseChallenger).toBe(false);
    const revs = out.nextCurated.revisions.filter((r) => r.entryKey === KEY);
    // 保持现状不是一次事实变化——伪造一次修订会让历史失真
    expect(revs).toHaveLength(1);
    expect(revs[0].revision).toBe(1);
    expect(revs[0].content).toBe('用 SQLite');
    expect(out.nextCurated.revisions).toHaveLength(1);
  });

  it('两种选择都把案件置为 resolved 并记 resultEntryKey', () => {
    const challenger = resolve();
    expect(challenger.nextConflicts.cases[0].status).toBe('resolved');
    expect(challenger.nextConflicts.cases[0].resolution?.resultEntryKey).toBe(KEY);

    const incumbent = resolve({ candidateId: 'c_sqlite' });
    expect(incumbent.nextConflicts.cases[0].status).toBe('resolved');
    expect(incumbent.nextConflicts.cases[0].resolution?.candidateId).toBe('c_sqlite');
  });

  it('审计事件带齐 actor / rationale / caseRevision / 证据', () => {
    const out = resolve();
    expect(out.adjudication).toMatchObject({
      eventId: 'ev_1',
      conflictId: 'cf_1',
      caseRevision: 1,
      candidateId: 'c_pg',
      actor: 'local-user',
      previousEntryKey: KEY,
      resultEntryKey: KEY,
      choseChallenger: true,
    });
    expect(out.adjudication.evidenceIds).toEqual(['f_c', 'f_d']);
    expect(out.adjudication.rationale).toContain('Postgres');
  });
});

describe('单条治理动作（FR-M31 / FR-M34）', () => {
  it('停用：立即停止注入、保留在 canonical、可恢复', () => {
    const { curated } = fixture();
    const off = disableEntry(curated, KEY, '换方案了', NOW);
    expect(activeOf(off, KEY)).toBeNull();
    expect(off.revisions[0].status).toBe('disabled');
    expect(off.revisions[0].disabledReason).toBe('换方案了');
    // 可恢复
    const back = enableEntry(off, KEY, NOW);
    expect(activeOf(back, KEY)?.content).toBe('用 SQLite');
    expect(back.revisions[0].status).toBe('active');
  });

  it('删除：留下域级墓碑，域被判为「已终结」（distill 不再自动复活）', () => {
    const { curated } = fixture();
    const gone = deleteEntry(curated, KEY, '不再适用', NOW);
    // 原来的修订被移除
    expect(gone.revisions.some((r) => r.entryKey === KEY)).toBe(false);
    // 墓碑在
    const tomb = gone.revisions.find((r) => r.entryKey === `x:${KEY}`);
    expect(tomb).toBeDefined();
    expect(tomb?.disabledReason).toBe('不再适用');
    expect(tomb?.deletedAt).toBe(NOW_ISO);
    // 关键：域被认作「已终结」——否则用户删掉的东西会被下一次蒸馏写回来
    expect(isDomainClosed(gone, `x:${KEY}` as never)).toBe(true);
  });

  it('删除是幂等的（重复删不叠加墓碑）', () => {
    const { curated } = fixture();
    const once = deleteEntry(curated, KEY, 'x', NOW);
    const twice = deleteEntry(once, `x:${KEY}` as never, 'x', NOW);
    expect(twice.revisions.filter((r) => r.entryKey.startsWith('x:')).length).toBe(1);
  });

  it('停用没有 active 的域 → 明确报错（而不是静默无事发生）', () => {
    const { curated } = fixture();
    const off = disableEntry(curated, KEY, 'x', NOW);
    expect(() => disableEntry(off, KEY, 'y', NOW)).toThrow(StaleConflictResolutionError);
  });
});

describe('案件状态合并', () => {
  it('同 id 的未决案件不重复加入，且保留原 detectedAt', () => {
    const { conflicts } = fixture();
    const later = new Date('2026-10-03T00:00:00Z');
    const incoming = { ...conflicts.cases[0], detectedAt: later.toISOString() };
    const merged = mergeNewCases(conflicts, [incoming], later);
    expect(merged.cases).toHaveLength(1);
    expect(merged.cases[0].detectedAt).toBe(NOW_ISO);
  });

  it('已解决的同 id 案件不因重新检测而复活', () => {
    const { conflicts } = fixture();
    const resolvedState: ConflictState = {
      ...conflicts,
      cases: [{ ...conflicts.cases[0], status: 'resolved' }],
    };
    const merged = mergeNewCases(resolvedState, [conflicts.cases[0]], NOW);
    expect(merged.cases[0].status).toBe('resolved');
  });

  it('证据变化（fingerprint 变了）时旧 open 案件被取代', () => {
    const { conflicts } = fixture();
    const live = [{ ...conflicts.cases[0], evidenceFingerprint: 'fp_2' }];
    const after = supersedeStaleCases(conflicts, live, NOW);
    expect(after.cases[0].status).toBe('superseded');
    expect(after.cases[0].resolvedAt).toBe(NOW_ISO);
  });

  it('openConflicts 只返回未决案件', () => {
    const { conflicts } = fixture();
    expect(openConflicts(conflicts)).toHaveLength(1);
    expect(openConflicts({ ...conflicts, cases: [{ ...conflicts.cases[0], status: 'resolved' }] })).toHaveLength(0);
  });
});

// —— 事务 journal 与重启恢复（FR-M17 / FR-M18） ——

function intentFixture(): ResolutionIntent {
  const { curated, conflicts } = fixture();
  const out = resolve();
  return buildResolutionIntent(
    {
      conflictId: 'cf_1',
      candidateId: 'c_pg',
      expectedRevision: 1,
      actor: 'local-user',
      rationale: 'r',
      eventId: 'ev_1',
    },
    { curated, conflicts },
    out,
    NOW,
  );
}

function journal(intent: ResolutionIntent, phases: TxnPhase[]): TxnPhaseEvent[] {
  const events: TxnPhaseEvent[] = [
    { kind: 'intent', transactionId: intent.transactionId, intentSha256: intent.intentSha256, intent, at: NOW_ISO },
  ];
  for (const phase of phases) {
    events.push({
      kind: 'phase',
      transactionId: intent.transactionId,
      intentSha256: intent.intentSha256,
      phase,
      at: NOW_ISO,
    });
  }
  return events;
}

describe('事务 journal 解析（FR-M17）', () => {
  it('按序解析出意图与阶段', () => {
    const intent = intentFixture();
    const progress = parseTransactionJournal(journal(intent, ['prepared', 'curated_applied']));
    expect(progress).toHaveLength(1);
    expect(progress[0].intent.conflictId).toBe('cf_1');
    expect(progress[0].phases).toEqual(['prepared', 'curated_applied']);
    expect(progress[0].committed).toBe(false);
  });

  it('阶段跳跃（缺 conflict_closed 直接 audit_appended）→ 报错', () => {
    const intent = intentFixture();
    expect(() =>
      parseTransactionJournal(journal(intent, ['prepared', 'curated_applied', 'audit_appended'])),
    ).toThrow(CorruptTransactionError);
  });

  it('阶段事件早于 intent → 报错', () => {
    const intent = intentFixture();
    const events = journal(intent, ['prepared']);
    expect(() => parseTransactionJournal([events[1], events[0]])).toThrow(/早于 intent/);
  });

  it('intent 哈希不符 → 报错（防篡改）', () => {
    const intent = intentFixture();
    const events = journal(intent, ['prepared']);
    const tampered: TxnPhaseEvent[] = [
      { ...events[0], intent: { ...intent, rationale: '被改过' } },
      events[1],
    ];
    expect(() => parseTransactionJournal(tampered)).toThrow(/疑似篡改/);
  });

  it('重复写入 intent → 报错', () => {
    const intent = intentFixture();
    const events = journal(intent, ['prepared']);
    expect(() => parseTransactionJournal([events[0], events[0]])).toThrow(/重复写入 intent/);
  });
});

describe('重启恢复判定（FR-M18）', () => {
  const intent = intentFixture();
  const progress = parseTransactionJournal(journal(intent, ['prepared']))[0];

  it('磁盘仍是 before → redo（整条重做）', () => {
    const plan = planRecovery(progress, intent.before, progress, false);
    expect(plan.action).toBe('redo');
    expect(plan.observed).toBe('before');
  });

  it('磁盘已是 after 且已 committed → noop', () => {
    const committed = parseTransactionJournal(
      journal(intent, ['prepared', 'curated_applied', 'conflict_closed', 'audit_appended', 'committed']),
    )[0];
    const plan = planRecovery(committed, intent.after, committed, true);
    expect(plan.action).toBe('noop');
    expect(plan.observed).toBe('after_both');
  });

  it('磁盘已是 after 但未 committed → continue（跳过已完成的阶段）', () => {
    const partial = parseTransactionJournal(journal(intent, ['prepared', 'curated_applied']))[0];
    const plan = planRecovery(partial, intent.after, partial, false);
    expect(plan.action).toBe('continue');
    expect(plan.observed).toBe('after_both');
  });

  it('curated 已应用、conflicts 还是 before → continue', () => {
    const partial = parseTransactionJournal(journal(intent, ['prepared', 'curated_applied']))[0];
    const plan = planRecovery(
      partial,
      { curated: intent.after.curated, conflicts: intent.before.conflicts },
      partial,
      false,
    );
    expect(plan.action).toBe('continue');
    expect(plan.observed).toBe('after_curated');
  });

  it('磁盘**既不是 before 也不是 after** → fail-closed（不猜、不覆盖）', () => {
    const foreign: CuratedState = {
      ...intent.after.curated,
      revisions: [...intent.after.curated.revisions, { ...intent.after.curated.revisions[0], revision: 9 }],
    };
    expect(() => planRecovery(progress, { curated: foreign, conflicts: intent.before.conflicts }, progress, false)).toThrow(
      UnrecoverableTransactionError,
    );
  });
});
