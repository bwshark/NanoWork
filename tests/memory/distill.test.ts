/**
 * 蒸馏引擎（`src/lib/memoryDistill.ts`）。
 *
 * 这是整个记忆 v2 的**核心增量**，也是「与 WorkBuddy 一样」的主体。测试按**契约**组织：
 *
 * 1. **门槛**（FR-M5）：30 天年龄、kind 白名单、重要度或重复次数——三者是「并且」；
 *    `outcome` 永不自动晋升。
 * 2. **幂等**（FR-M6）：同输入重复跑不新增修订、不重复合并 evidence。
 * 3. **替代门槛**（FR-M8）：三重条件缺一不可——单条高重要度事实**不能**推翻既有决策。
 * 4. **fail-closed**（FR-M11）：同分时不动现状，建案等人工裁决。
 * 5. **域终态**（I2）：停用 / 删除过的域**不会被后续蒸馏自动复活**——否则用户删掉的
 *    东西会被下一次蒸馏写回来。
 * 6. **确定性**（NFR-M12）：打乱输入顺序，canonical JSON 逐字节相同。
 * 7. **损坏检测**（FR-M9）：域内多个 active / revision 不连续 / 链接不成对一律显式报错，
 *    不静默挑一个答案。
 */

import { describe, expect, it } from 'vitest';
import type { CuratedEntry, CuratedState, MemoryFact } from '../../src/types';
import {
  CorruptCuratedStateError,
  DEFAULT_DISTILL_POLICY,
  activeOf,
  distillFacts,
  emptyCuratedState,
  passesPromotionGate,
  revisionsOf,
  validateCuratedState,
} from '../../src/lib/memoryDistill';
import { createMemoryFact } from '../../src/lib/memoryFact';

const NOW = new Date('2026-10-02T00:00:00Z');
const NOW_ISO = NOW.toISOString();
/** 40 天前——超过默认 30 天门槛 */
const OLD = '2026-08-23T00:00:00.000Z';
/** 门槛内的一个「较新」时刻：晚于 08-23、又早于截止日 2026-09-02 */
const OLD_LATER = '2026-08-25T00:00:00.000Z';
/** 10 天前——未过门槛 */
const FRESH = '2026-09-22T00:00:00Z';
const WS = 'w_test';

function fact(
  content: string,
  opts: Partial<Parameters<typeof createMemoryFact>[0]> = {},
): MemoryFact {
  return createMemoryFact(
    {
      workspaceId: WS,
      kind: 'decision',
      content,
      importance: 4,
      observedAt: OLD,
      ...opts,
    },
    NOW,
  );
}

function empty(): CuratedState {
  return emptyCuratedState(WS, NOW);
}

describe('门槛（FR-M5）：三类条件「并且」', () => {
  it('太新的事实不过门槛', () => {
    const f = [fact('用 SQLite WAL 模式', { observedAt: FRESH })];
    expect(passesPromotionGate(f, DEFAULT_DISTILL_POLICY, NOW)).toBe(false);
  });

  it('过老但 kind 不可晋升（outcome）不过门槛', () => {
    const f = [fact('本次测试通过', { kind: 'outcome', observedAt: OLD })];
    expect(passesPromotionGate(f, DEFAULT_DISTILL_POLICY, NOW)).toBe(false);
  });

  it('重要度达标即可（不必重复出现）', () => {
    const f = [fact('用 SQLite WAL 模式', { importance: 4 })];
    expect(passesPromotionGate(f, DEFAULT_DISTILL_POLICY, NOW)).toBe(true);
  });

  it('重要度不足但**重复出现**达标也算过', () => {
    const f = [
      fact('路径必须相对工作区', { kind: 'convention', importance: 3 }),
      fact('路径必须相对工作区', { kind: 'convention', importance: 3 }),
    ];
    expect(passesPromotionGate(f, DEFAULT_DISTILL_POLICY, NOW)).toBe(true);
  });

  it('重要度不足且只出现一次 → 不过', () => {
    const f = [fact('路径必须相对工作区', { kind: 'convention', importance: 3 })];
    expect(passesPromotionGate(f, DEFAULT_DISTILL_POLICY, NOW)).toBe(false);
  });
});

describe('首次策展：新建修订 1', () => {
  it('过门槛的事实成为 active 修订', () => {
    const { next, report } = distillFacts([fact('用 SQLite WAL 模式')], empty(), DEFAULT_DISTILL_POLICY, NOW);
    expect(report.promoted).toBe(1);
    expect(next.revisions).toHaveLength(1);
    expect(next.revisions[0].revision).toBe(1);
    expect(next.revisions[0].status).toBe('active');
    expect(next.revisions[0].content).toBe('用 SQLite WAL 模式');
    expect(next.revisions[0].evidenceIds).toHaveLength(1);
    expect(next.revisions[0].firstSeen).toBe(OLD);
    // 无显式 key → 派生域（`d:<kind>:<hash>`），而**不是** `k:`
    expect(next.revisions[0].entryKey.startsWith('d:decision:')).toBe(true);
  });

  it('未过门槛的域被记入 skipped（原因可观察）', () => {
    const { next, report } = distillFacts([fact('太新的决策', { observedAt: FRESH })], empty(), DEFAULT_DISTILL_POLICY, NOW);
    expect(next.revisions).toHaveLength(0);
    expect(report.skipped).toBe(1);
    expect(report.promoted).toBe(0);
  });

  it('显式 memory_key 建 keyed 域，且 memoryKey 反映 key 本身', () => {
    const { next } = distillFacts(
      [fact('Python 3.11', { memoryKey: 'runtime.python-version' })],
      empty(),
      DEFAULT_DISTILL_POLICY,
      NOW,
    );
    expect(next.revisions[0].entryKey).toBe('k:runtime.python-version');
    expect(next.revisions[0].memoryKey).toBe('runtime.python-version');
  });
});

describe('幂等（FR-M6）：重复跑不产生新修订', () => {
  it('同输入跑两次，第二次没有 promoted / merged', () => {
    const facts = [fact('用 SQLite WAL 模式')];
    const first = distillFacts(facts, empty(), DEFAULT_DISTILL_POLICY, NOW);
    const second = distillFacts(facts, first.next, DEFAULT_DISTILL_POLICY, NOW);

    expect(second.report.promoted).toBe(0);
    expect(second.report.merged).toBe(0);
    expect(second.report.superseded).toBe(0);
    expect(second.next.revisions).toHaveLength(1);
    expect(second.next.revisions[0].evidenceIds).toEqual(first.next.revisions[0].evidenceIds);
  });

  it('内容相同的新证据只合并 evidence，不产生新修订', () => {
    const base = [fact('用 SQLite WAL 模式')];
    const first = distillFacts(base, empty(), DEFAULT_DISTILL_POLICY, NOW);
    // 同一句话在另一时刻又被确认了一次（措辞完全相同）
    const again = [fact('用 SQLite WAL 模式', { observedAt: '2026-08-25T00:00:00Z' })];
    const second = distillFacts(again, first.next, DEFAULT_DISTILL_POLICY, NOW);

    expect(second.next.revisions).toHaveLength(1);
    expect(second.report.merged).toBe(1);
    expect(second.next.revisions[0].evidenceIds).toHaveLength(2);
    // lastSeen 由 evidence 派生（取最大 observedAt），**不是 now**
    expect(second.next.revisions[0].lastSeen).toBe('2026-08-25T00:00:00.000Z');
    expect(second.next.revisions[0].lastSeen).not.toBe(NOW_ISO);
  });
});

describe('替代门槛（FR-M8）：三重条件缺一不可', () => {
  /** 先策展出「Python 3.11」这个约定（2 条独立证据 + 时间 OLD） */
  function with3_11(): CuratedState {
    const first = distillFacts(
      [
        fact('用 Python 3.11', { memoryKey: 'runtime.python-version', evidence: 'a' }),
        fact('用 Python 3.11', {
          memoryKey: 'runtime.python-version',
          evidence: 'b',
          observedAt: '2026-08-24T00:00:00Z',
        }),
      ],
      empty(),
      DEFAULT_DISTILL_POLICY,
      NOW,
    );
    return first.next;
  }

  it('单条高重要度事实**不能**推翻既有决策（门槛②：需要独立证据数）', () => {
    const prev = with3_11();
    const challenger = [
      fact('用 Python 3.12', {
        memoryKey: 'runtime.python-version',
        importance: 5,
        observedAt: '2026-08-28T00:00:00Z',
      }),
    ];
    const { next, report } = distillFacts(challenger, prev, DEFAULT_DISTILL_POLICY, NOW);

    expect(report.superseded).toBe(0);
    expect(report.skipped).toBe(1);
    expect(activeOf(next, 'k:runtime.python-version' as never)?.content).toBe('用 Python 3.11');
  });

  it('两条独立事实确认 + 时间更新 → 替代，且双向链接成对', () => {
    const prev = with3_11();
    const challenger = [
      fact('用 Python 3.12', {
        memoryKey: 'runtime.python-version',
        observedAt: '2026-08-28T00:00:00Z',
        evidence: 'c',
      }),
      fact('用 Python 3.12', {
        memoryKey: 'runtime.python-version',
        observedAt: '2026-08-29T00:00:00Z',
        evidence: 'd',
      }),
    ];
    const { next, report } = distillFacts(challenger, prev, DEFAULT_DISTILL_POLICY, NOW);

    expect(report.superseded).toBe(1);
    const revs = next.revisions.filter((r) => r.entryKey === 'k:runtime.python-version');
    expect(revs).toHaveLength(2);
    const [v1, v2] = revs;
    expect(v1.status).toBe('superseded');
    expect(v1.supersededBy).toBe(2);
    expect(v2.status).toBe('active');
    expect(v2.supersedes).toBe(1);
    expect(v2.content).toBe('用 Python 3.12');
    expect(activeOf(next, 'k:runtime.python-version' as never)?.revision).toBe(2);
    // 链接成对是 I3，校验器也必须认
    expect(() => validateCuratedState(next)).not.toThrow();
  });

  it('门槛③：候选时间**不比** active 新 → 拒绝（过期证据不能回滚当前值）', () => {
    const prev = with3_11();
    // 时间早于 active.lastSeen（2026-08-24）
    const stale = [
      fact('用 Python 3.10', {
        memoryKey: 'runtime.python-version',
        observedAt: '2026-08-20T00:00:00Z',
      }),
      fact('用 Python 3.10', {
        memoryKey: 'runtime.python-version',
        observedAt: '2026-08-21T00:00:00Z',
      }),
    ];
    const { next, report } = distillFacts(stale, prev, DEFAULT_DISTILL_POLICY, NOW);

    expect(report.superseded).toBe(0);
    expect(report.stale).toBe(1);
    expect(activeOf(next, 'k:runtime.python-version' as never)?.content).toBe('用 Python 3.11');
  });

  it('无 memory_key 时按「kind + 归一化内容」分域，不同内容**不互相替代**', () => {
    const first = distillFacts([fact('用 SQLite WAL 模式')], empty(), DEFAULT_DISTILL_POLICY, NOW);
    const other = distillFacts(
      [fact('用 PostgreSQL 做主库')],
      first.next,
      DEFAULT_DISTILL_POLICY,
      NOW,
    );
    // 两条各自成域，都活着（把「补充新信息」误当「更新」正是要避免的事）
    expect(other.next.revisions).toHaveLength(2);
    expect(other.next.revisions.every((r) => r.status === 'active')).toBe(true);
    expect(other.report.superseded).toBe(0);
  });
});

describe('fail-closed（FR-M11）：同分不动现状、建案', () => {
  it('两个候选重要度、独立证据数、最新时间全相同 → 保留 incumbent 并建案', () => {
    const prev = withRevision('k:storage.db', '用 SQLite', '2026-08-10T00:00:00Z');
    const facts = [
      fact('用 Postgres', {
        memoryKey: 'storage.db',
        observedAt: '2026-08-27T00:00:00Z',
        evidence: 'x',
      }),
      fact('用 Postgres', {
        memoryKey: 'storage.db',
        observedAt: '2026-08-27T00:00:00Z',
        evidence: 'y',
      }),
      fact('用 MySQL', {
        memoryKey: 'storage.db',
        observedAt: '2026-08-27T00:00:00Z',
        evidence: 'z',
      }),
      fact('用 MySQL', {
        memoryKey: 'storage.db',
        observedAt: '2026-08-27T00:00:00Z',
        evidence: 'w',
      }),
    ];
    const { next, newCases, report } = distillFacts(facts, prev, DEFAULT_DISTILL_POLICY, NOW, WS);

    expect(report.conflicts).toBe(1);
    expect(report.queuedConflicts).toBe(1);
    expect(newCases).toHaveLength(1);
    // incumbent 没被动过
    expect(activeOf(next, 'k:storage.db' as never)?.content).toBe('用 SQLite');
    expect(next.revisions.filter((r) => r.entryKey === 'k:storage.db')).toHaveLength(1);

    const kase = newCases[0];
    expect(kase.status).toBe('open');
    expect(kase.entryKey).toBe('k:storage.db');
    // 三个候选：两个同分挑战者 + **incumbent**（否则「保持现状」在 UI 上无从表达）
    expect(kase.candidates).toHaveLength(3);
    expect(kase.candidates.map((c) => c.content)).toContain('用 SQLite');
    expect(kase.activeEntryKey).toBe('k:storage.db');
    expect(kase.evidenceFingerprint).not.toBe('');
    // 案件 id 确定性：同证据同 id（重启不重复建案）
    const again = distillFacts(facts, prev, DEFAULT_DISTILL_POLICY, NOW, WS);
    expect(again.newCases[0].conflictId).toBe(kase.conflictId);
  });
});

describe('域终态（I2）：停用 / 删除过的域不被自动复活', () => {
  it('域内没有 active（已停用）时，新事实只能进案件', () => {
    const prev: CuratedState = {
      schema: 2,
      workspaceId: WS,
      renderedAt: NOW_ISO,
      revisions: [
        {
          entryKey: 'k:storage.db',
          memoryKey: 'storage.db',
          kind: 'decision',
          revision: 1,
          status: 'disabled',
          content: '用 SQLite',
          importance: 4,
          evidenceIds: ['f_old'],
          evidenceCount: 1,
          firstSeen: '2026-08-10T00:00:00.000Z',
          lastSeen: '2026-08-10T00:00:00.000Z',
          disabledReason: '换方案了',
        },
      ],
    };
    const facts = [
      fact('改用 Postgres', { memoryKey: 'storage.db', observedAt: '2026-08-26T00:00:00Z' }),
      fact('改用 Postgres', {
        memoryKey: 'storage.db',
        observedAt: '2026-08-27T00:00:00Z',
        evidence: 'two',
      }),
    ];
    const { next, newCases, report } = distillFacts(facts, prev, DEFAULT_DISTILL_POLICY, NOW, WS);

    // 没有复活成 active
    expect(activeOf(next, 'k:storage.db' as never)).toBeNull();
    expect(next.revisions).toHaveLength(1);
    // 候选进了案件
    expect(report.conflicts).toBe(1);
    expect(newCases).toHaveLength(1);
  });
});

describe('确定性（NFR-M12）：打乱输入顺序，结果逐字节相同', () => {
  it('同一批事实两种顺序 → canonical JSON 相同', () => {
    const facts = [
      fact('用 SQLite WAL 模式', { evidence: 'a' }),
      fact('路径必须相对工作区', { kind: 'convention', evidence: 'b' }),
      fact('Python 3.11', { memoryKey: 'runtime.python-version', evidence: 'c' }),
      fact('不要往记忆里写 token', { kind: 'pitfall', evidence: 'd' }),
      fact('用 SQLite WAL 模式', { observedAt: '2026-08-25T00:00:00Z', evidence: 'e' }),
    ];
    const a = distillFacts(facts, empty(), DEFAULT_DISTILL_POLICY, NOW).next;
    const b = distillFacts([...facts].reverse(), empty(), DEFAULT_DISTILL_POLICY, NOW).next;
    const c = distillFacts(
      [facts[2], facts[0], facts[4], facts[3], facts[1]],
      empty(),
      DEFAULT_DISTILL_POLICY,
      NOW,
    ).next;

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it('evidenceIds 排序后存储（否则跨设备逐字节对不上）', () => {
    const facts = [
      fact('用 SQLite WAL 模式', { observedAt: '2026-08-23T00:00:00Z' }),
      fact('用 SQLite WAL 模式', { observedAt: '2026-08-24T00:00:00Z' }),
      fact('用 SQLite WAL 模式', { observedAt: '2026-08-25T00:00:00Z' }),
    ];
    const { next } = distillFacts(facts, empty(), DEFAULT_DISTILL_POLICY, NOW);
    const ids = next.revisions[0].evidenceIds;
    expect(ids).toEqual([...ids].sort());
  });

  it('renderedAt 取 now（不读系统时钟）', () => {
    const another = new Date('2026-11-11T11:11:11Z');
    const { next } = distillFacts([fact('用 SQLite WAL 模式')], empty(), DEFAULT_DISTILL_POLICY, another);
    expect(next.renderedAt).toBe(another.toISOString());
  });
});

describe('损坏检测（FR-M9）：显式报错，不静默选一个', () => {
  it('域内两个 active → 抛错', () => {
    const state: CuratedState = {
      schema: 2,
      workspaceId: WS,
      renderedAt: NOW_ISO,
      revisions: [entry(1, 'active', 'a'), entry(2, 'active', 'b')],
    };
    expect(() => validateCuratedState(state)).toThrow(CorruptCuratedStateError);
  });

  it('revision 不连续 → 抛错', () => {
    const state: CuratedState = {
      schema: 2,
      workspaceId: WS,
      renderedAt: NOW_ISO,
      revisions: [entry(1, 'superseded', 'a'), entry(3, 'active', 'b')],
    };
    expect(() => validateCuratedState(state)).toThrow(/revision 不连续/);
  });

  it('supersedes 链接不成对 → 抛错', () => {
    const state: CuratedState = {
      schema: 2,
      workspaceId: WS,
      renderedAt: NOW_ISO,
      revisions: [
        { ...entry(1, 'superseded', 'a'), supersededBy: 2 },
        // 修订 2 忘了写 supersedes
        entry(2, 'active', 'b'),
      ],
    };
    expect(() => validateCuratedState(state)).toThrow(/不成对|supersedes/);
  });

  it('域内零 active 且域被停用 → 合法（至多一个 active，不是恰好一个）', () => {
    const state: CuratedState = {
      schema: 2,
      workspaceId: WS,
      renderedAt: NOW_ISO,
      revisions: [
        { ...entry(1, 'superseded', 'a'), supersededBy: 2 },
        { ...entry(2, 'disabled', 'b'), supersedes: 1, disabledReason: '用户停用' },
      ],
    };
    // 这条不变量存在的理由：停用与删除必须能让一个域合法地没有 active，
    // 否则用户点一次「停用」就会让整份记忆被判损坏。
    expect(() => validateCuratedState(state)).not.toThrow();
  });

  it('schema 不是 2 → 抛错', () => {
    expect(() =>
      validateCuratedState({ schema: 1 as never, workspaceId: WS, revisions: [], renderedAt: NOW_ISO }),
    ).toThrow(CorruptCuratedStateError);
  });
});

// —— 测试夹具 ——

/** 造一条修订（默认域 `k:storage.db`） */
function entry(revision: number, status: CuratedEntry['status'], content: string): CuratedEntry {
  return {
    entryKey: 'k:storage.db',
    memoryKey: 'storage.db',
    kind: 'decision',
    revision,
    status,
    content,
    importance: 4,
    evidenceIds: [`f_${revision}`],
    evidenceCount: 1,
    firstSeen: '2026-08-10T00:00:00.000Z',
    lastSeen: '2026-08-10T00:00:00.000Z',
  };
}

/** 造一个「已经有一条 active 修订」的状态（用于替代门槛与同分冲突的用例） */
function withRevision(entryKey: string, content: string, lastSeen: string): CuratedState {
  return {
    schema: 2,
    workspaceId: WS,
    renderedAt: NOW_ISO,
    revisions: [
      {
        entryKey: entryKey as CuratedEntry['entryKey'],
        memoryKey: entryKey.slice(2),
        kind: 'decision',
        revision: 1,
        status: 'active',
        content,
        importance: 4,
        evidenceIds: ['f_base_a', 'f_base_b'],
        evidenceCount: 2,
        firstSeen: lastSeen,
        lastSeen,
      },
    ],
  };
}
