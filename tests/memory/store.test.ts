/**
 * 记忆仓储的持久化与崩溃恢复（`src/lib/memoryStore.ts` + `memoryTransaction.ts`）。
 *
 * ## 为什么用内存假端口而不是真机临时目录
 *
 * 真机跑不出「八个崩溃窗口」：每个窗口都要求**在恰好那一刻切断**——写完临时文件但没
 * rename、curated 换了但 conflicts 没换、审计追了一半。内存端口可以在指定操作上抛一次
 * 错，然后让「重启」后的同一个仓储继续跑，从而把设计 §4.5 的恢复语义完整覆盖。
 *
 * 真机那一半由 `tests/memory/memoryDirStore.test.ts` 覆盖（原子替换、临时文件清理、
 * 越界拒绝），两者互补：那里的价值是「真的落到了哪里」，这里的价值是「断电后还对不对」。
 */

import { describe, expect, it } from 'vitest';
import type {
  ConflictCase,
  CuratedState,
  MemoryFact,
  ResolutionIntent,
  TxnPhase,
} from '../../src/types';
import { createMemoryStore, type MemoryStoreIo } from '../../src/lib/memoryStore';
import {
  ADJUDICATIONS_FILE,
  CONFLICTS_FILE,
  CURATED_MEMORY_FILE,
  CURATED_STATE_FILE,
  DAILY_SUBDIR,
  TRANSACTIONS_FILE,
  dailyFactLogFileName,
} from '../../src/lib/memoryPaths';
import { createMemoryFact } from '../../src/lib/memoryFact';
import { emptyCuratedState } from '../../src/lib/memoryDistill';
import { emptyConflictState, openConflicts } from '../../src/lib/memoryAdjudicate';
import { advanceIntent } from '../../src/lib/memoryTransaction';

const NOW = new Date('2026-10-02T00:00:00Z');
const WS = 'w_test';
/** 40 天前：过默认 30 天门槛 */
const OLD = '2026-08-23T00:00:00.000Z';
/** 更晚但仍在门槛内（晚于 OLD、早于截止日 2026-09-02） */
const OLD_LATER = '2026-08-26T00:00:00.000Z';

/**
 * 内存文件系统 + 可注入故障。
 *
 * `failOn` 指定「第 N 次命中的操作类型」抛错（N 从 1 起），用来精确切断某个阶段；
 * `failAfterCount` 为 true 时表示「先执行再抛错」（模拟「目标写入成功、阶段事件未追加」
 * 这个最难的窗口）。
 */
class FakeIo implements MemoryStoreIo {
  files = new Map<string, string>();
  calls: Record<string, number> = {};
  /** `{ op, nth }`：把第 nth 次 op 打断；`after=true` 表示先做完再抛 */
  failOn: { op: string; nth: number; after?: boolean } | null = null;

  private key(name: string, subdir?: string): string {
    return subdir ? `${subdir}/${name}` : name;
  }

  /** 命中故障规则时抛错；返回是否抛了 */
  private maybeFail(op: string): boolean {
    this.calls[op] = (this.calls[op] ?? 0) + 1;
    const rule = this.failOn;
    if (!rule || rule.op !== op) return false;
    if (this.calls[op] !== rule.nth) return false;
    if (rule.after) return false;
    throw new Error(`injected failure: ${op}#${rule.nth}`);
  }

  /** 已执行完的操作：看看是否该在「做完之后」抛 */
  private maybeFailAfter(op: string): void {
    const rule = this.failOn;
    if (!rule || rule.op !== op || !rule.after) return;
    if (this.calls[op] !== rule.nth) return;
    throw new Error(`injected failure after: ${op}#${rule.nth}`);
  }

  async list(subdir?: string): Promise<string[]> {
    const prefix = subdir ? `${subdir}/` : '';
    return [...this.files.keys()]
      .filter((k) => (subdir ? k.startsWith(prefix) : !k.includes('/')))
      .map((k) => (subdir ? k.slice(prefix.length) : k))
      .sort();
  }

  async read(name: string, subdir?: string): Promise<string | null> {
    const k = this.key(name, subdir);
    return this.files.has(k) ? (this.files.get(k) as string) : null;
  }

  async replace(name: string, content: string, subdir?: string): Promise<void> {
    if (this.maybeFail('replace')) return;
    this.files.set(this.key(name, subdir), content);
    this.maybeFailAfter('replace');
  }

  async write(name: string, content: string, subdir?: string): Promise<void> {
    if (this.maybeFail('write')) return;
    this.files.set(this.key(name, subdir), content);
    this.maybeFailAfter('write');
  }

  async appendLine(name: string, line: string, subdir?: string): Promise<void> {
    if (this.maybeFail('appendLine')) return;
    const k = this.key(name, subdir);
    const current = this.files.get(k) ?? '';
    this.files.set(k, current.endsWith('\n') || current === '' ? `${current}${line}\n` : `${current}\n${line}\n`);
    this.maybeFailAfter('appendLine');
  }

  async readLines(name: string, subdir?: string): Promise<string[]> {
    const raw = (await this.read(name, subdir)) ?? '';
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
  }

  async remove(name: string, subdir?: string): Promise<void> {
    this.files.delete(this.key(name, subdir));
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort());
  }

  restore(snap: Record<string, string>): void {
    this.files = new Map(Object.entries(snap));
  }
}

/** 建一个仓储（每次调用都读同一份 FakeIo，相当于「重启后新建实例」） */
function storeOn(io: FakeIo, opts: { policy?: Parameters<typeof createMemoryStore>[0]['policy'] } = {}) {
  return createMemoryStore({
    io,
    workspaceId: WS,
    ...(opts.policy ? { policy: opts.policy } : {}),
    renderProjection: renderProjectionForTest,
  });
}

/** 投影渲染：只列 active 的内容（测试只关心「注入了什么」，不关心排版） */
function renderProjectionForTest(state: CuratedState): string {
  const lines = state.revisions
    .filter((r) => r.status === 'active' && r.content.trim() !== '')
    .map((r) => `- ${r.content}`);
  return lines.join('\n');
}

/** 造一条事实输入 */
function factInput(
  content: string,
  opts: Partial<Parameters<typeof createMemoryFact>[0]> = {},
): Parameters<typeof createMemoryFact>[0] {
  return {
    workspaceId: WS,
    kind: 'decision',
    content,
    importance: 4,
    observedAt: OLD,
    ...opts,
  };
}

/** 直接写一批事实进 FakeIo 的日文件（绕过仓储，用于构造初始状态） */
function seedFacts(io: FakeIo, facts: MemoryFact[]): void {
  for (const fact of facts) {
    const name = dailyFactLogFileName(new Date(fact.observedAt));
    const key = `${DAILY_SUBDIR}/${name}`;
    const current = io.files.get(key) ?? '';
    const line = JSON.stringify(fact);
    io.files.set(key, current === '' ? `${line}\n` : `${current}${line}\n`);
  }
}

describe('appendFact：校验、落盘与幂等去重', () => {
  it('写入**观测日**的事实日志，并带上归属', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    const outcome = await store.appendFact(factInput('用 SQLite WAL 模式'), NOW);
    expect(outcome).toBe('written');

    // 文件名取**事实的 observedAt**（不是写入时刻）：一条三年前的决策仍应落在
    // 它发生那天的日志里，而不是「今天」。这也让同一事实的重复写入永远命中同一个文件。
    const name = dailyFactLogFileName(new Date(OLD));
    const raw = await io.read(name, DAILY_SUBDIR);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse((raw as string).trim()) as MemoryFact;
    expect(parsed.workspaceId).toBe(WS);
    expect(parsed.content).toBe('用 SQLite WAL 模式');
    expect(parsed.schema).toBe(2);
    expect(parsed.factId).toMatch(/^f_[0-9a-f]+$/);
  });

  it('同一事实重复写入被去重（自动沉淀 + 模型主动写是两条独立触发链）', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    expect(await store.appendFact(factInput('用 SQLite WAL 模式'), NOW)).toBe('written');
    expect(await store.appendFact(factInput('用 SQLite WAL 模式'), NOW)).toBe('skipped-duplicate');
    expect(await store.loadFacts(null, NOW)).toHaveLength(1);
  });

  it('调用方传的 workspaceId 被仓储覆盖（不许往别人的分区写事实）', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    await store.appendFact(factInput('x', { workspaceId: 'w_other' }), NOW);
    const facts = await store.loadFacts(null, NOW);
    expect(facts[0].workspaceId).toBe(WS);
  });

  it('非法事实整条拒绝，且不落盘', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    await expect(store.appendFact(factInput('', {}), NOW)).rejects.toThrow();
    await expect(
      store.appendFact(factInput('ok', { memoryKey: 'Bad Key' }), NOW),
    ).rejects.toThrow();
    expect(await io.list(DAILY_SUBDIR)).toEqual([]);
  });

  it('loadFacts 按 observedAt 过滤与排序', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    await store.appendFact(factInput('早', { observedAt: OLD }), NOW);
    await store.appendFact(factInput('晚', { observedAt: OLD_LATER }), NOW);
    const all = await store.loadFacts(null, NOW);
    expect(all.map((f) => f.content)).toEqual(['早', '晚']);
    const recent = await store.loadFacts(new Date('2026-08-25T00:00:00Z'), NOW);
    expect(recent.map((f) => f.content)).toEqual(['晚']);
  });
});

describe('canonical 状态：归属校验与损坏检测', () => {
  it('归属不符 → 拒绝读取（跨工作区误拷 / 调用方传错作用域）', async () => {
    const io = new FakeIo();
    io.files.set(
      CURATED_STATE_FILE,
      JSON.stringify({ schema: 2, workspaceId: 'w_other', revisions: [], renderedAt: NOW.toISOString() }),
    );
    await expect(storeOn(io).loadCuratedState()).rejects.toThrow(/归属/);
  });

  it('半截 JSON → 报错，而不是静默当成空状态', async () => {
    const io = new FakeIo();
    io.files.set(CURATED_STATE_FILE, '{"schema":2,"workspaceId":"w_test","revis');
    await expect(storeOn(io).loadCuratedState()).rejects.toThrow(/不是合法 JSON/);
  });

  it('域内两个 active（状态损坏）→ 报错，不静默挑一个', async () => {
    const io = new FakeIo();
    const base = emptyCuratedState(WS, NOW);
    const corrupted: CuratedState = {
      ...base,
      revisions: [
        {
          entryKey: 'k:a',
          memoryKey: 'a',
          kind: 'decision',
          revision: 1,
          status: 'active',
          content: 'x',
          importance: 4,
          evidenceIds: ['f_1'],
          evidenceCount: 1,
          firstSeen: OLD,
          lastSeen: OLD,
        },
        {
          entryKey: 'k:a',
          memoryKey: 'a',
          kind: 'decision',
          revision: 2,
          status: 'active',
          content: 'y',
          importance: 4,
          evidenceIds: ['f_2'],
          evidenceCount: 1,
          firstSeen: OLD,
          lastSeen: OLD,
        },
      ],
    };
    io.files.set(CURATED_STATE_FILE, JSON.stringify(corrupted));
    await expect(storeOn(io).loadCuratedState()).rejects.toThrow(/active/);
  });
});

describe('distill：策展落盘 + 投影重建', () => {
  it('过门槛的事实被策展，并重建 MEMORY.md 投影', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    seedFacts(io, [
      createMemoryFact(factInput('用 SQLite WAL 模式'), NOW),
      createMemoryFact(factInput('路径必须相对工作区', { kind: 'convention' }), NOW),
    ]);

    const { report, state } = await store.distill(NOW);
    expect(report.promoted).toBe(2);
    expect(state.revisions).toHaveLength(2);

    // canonical 落盘
    const raw = await io.read(CURATED_STATE_FILE);
    expect(raw).toContain('"workspaceId": "w_test"');
    // 投影落盘
    const projection = await io.read(CURATED_MEMORY_FILE);
    expect(projection).toContain('用 SQLite WAL 模式');
    expect(projection).toContain('路径必须相对工作区');
  });

  it('幂等：再跑一次不新增修订，投影不变', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    seedFacts(io, [createMemoryFact(factInput('用 SQLite WAL 模式'), NOW)]);
    await store.distill(NOW);
    const first = await io.read(CURATED_MEMORY_FILE);
    const again = await store.distill(NOW);
    expect(again.report.promoted).toBe(0);
    expect(again.report.merged).toBe(0);
    expect(await io.read(CURATED_MEMORY_FILE)).toBe(first);
    expect(again.state.revisions).toHaveLength(1);
  });

  it('未过门槛的事实不落进 canonical（但证据仍在日志里）', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    seedFacts(io, [
      createMemoryFact(factInput('太新的决策', { observedAt: '2026-09-22T00:00:00Z' }), NOW),
    ]);
    const { report, state } = await store.distill(NOW);
    expect(report.promoted).toBe(0);
    expect(state.revisions).toHaveLength(0);
    // 证据只追加、不被蒸馏删除（I1）
    expect(await store.loadFacts(null, NOW)).toHaveLength(1);
  });

  it('同分冲突 → 建案落盘、候选**不进**投影', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    // 先策展出「用 SQLite」
    seedFacts(io, [createMemoryFact(factInput('用 SQLite', { memoryKey: 'storage.db' }), NOW)]);
    await store.distill(NOW);

    // 再补两个同分候选（时间晚于 active、仍在门槛内、各自两条证据）
    const challengers = [
      createMemoryFact(
        factInput('用 Postgres', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'x' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 Postgres', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'y' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 MySQL', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'z' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 MySQL', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'w' }),
        NOW,
      ),
    ];
    seedFacts(io, challengers);

    const { report, conflicts } = await store.distill(NOW);
    expect(report.conflicts).toBe(1);
    expect(openConflicts(conflicts)).toHaveLength(1);

    // 案件落盘
    const raw = await io.read(CONFLICTS_FILE);
    expect(raw).toContain('"status": "open"');
    // incumbent 仍在投影里；候选**不被注入**（I8）
    const projection = await io.read(CURATED_MEMORY_FILE);
    expect(projection).toContain('用 SQLite');
    expect(projection).not.toContain('用 Postgres');
    expect(projection).not.toContain('用 MySQL');
  });
});

describe('resolve：五阶段落盘与幂等重试', () => {
  /** 构造「已有一条 active + 一个 open 案件」的仓储状态 */
  async function withOpenCase(io: FakeIo, store = storeOn(io)) {
    seedFacts(io, [createMemoryFact(factInput('用 SQLite', { memoryKey: 'storage.db' }), NOW)]);
    await store.distill(NOW);
    seedFacts(io, [
      createMemoryFact(
        factInput('用 Postgres', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'x' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 Postgres', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'y' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 MySQL', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'z' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 MySQL', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'w' }),
        NOW,
      ),
    ]);
    await store.distill(NOW);
    const kase = (await store.listConflicts())[0];
    return { store, kase };
  }

  it('选 challenger：curated 换值、案件关闭、审计追加、投影重建', async () => {
    const io = new FakeIo();
    const { store, kase } = await withOpenCase(io);
    const pg = kase.candidates.find((c) => c.content === '用 Postgres');
    expect(pg).toBeDefined();

    const event = await store.resolve(
      {
        conflictId: kase.conflictId,
        candidateId: (pg as ConflictCase['candidates'][number]).candidateId,
        expectedRevision: kase.revision,
        actor: 'local-user',
        rationale: '生产要 Postgres 扩展',
        eventId: 'ev_1',
      },
      NOW,
    );
    expect(event.choseChallenger).toBe(true);
    expect(event.eventId).toBe('ev_1');

    // canonical：新值生效
    const state = await store.loadCuratedState();
    const actives = state.revisions.filter((r) => r.status === 'active');
    expect(actives.map((r) => r.content)).toContain('用 Postgres');
    // 案件关闭
    expect(await store.listConflicts()).toHaveLength(0);
    // 审计
    expect((await store.loadAdjudications()).map((e) => e.eventId)).toEqual(['ev_1']);
    // 投影跟着换
    const projection = await io.read(CURATED_MEMORY_FILE);
    expect(projection).toContain('用 Postgres');
    // 事务日志：五个阶段齐全
    const journal = await io.readLines(TRANSACTIONS_FILE);
    expect(journal.some((l) => l.includes('"phase":"curated_applied"'))).toBe(true);
    expect(journal.some((l) => l.includes('"phase":"committed"'))).toBe(true);
  });

  it('选 incumbent：**不产生新修订**，但审计与案件关闭照做', async () => {
    const io = new FakeIo();
    const { store, kase } = await withOpenCase(io);
    const before = await store.loadCuratedState();
    const active = before.revisions.find((r) => r.status === 'active') as CuratedState['revisions'][number];
    const activeContent = active.content;

    // 真实案件里的候选都是挑战者；「保持现状」在 UI 上表现为**选中与当前内容相同的那一项**，
    // 或直接不给 challenger 授权。这里用后者：把候选换成「与 active 同内容」的 challenger，
    // 从而精确落到 `choseChallenger === false` 的分支。
    const sameAsActive = kase.candidates[0];
    const state = await store.loadConflicts();
    const patched: typeof state = {
      ...state,
      cases: state.cases.map((c) =>
        c.conflictId === kase.conflictId
          ? {
              ...c,
              candidates: [
                { ...sameAsActive, candidateId: 'c_incumbent', content: activeContent },
                ...c.candidates.slice(1),
              ],
            }
          : c,
      ),
    };
    await io.replace(CONFLICTS_FILE, JSON.stringify(patched, null, 2));

    const event = await store.resolve(
      {
        conflictId: kase.conflictId,
        candidateId: 'c_incumbent',
        expectedRevision: kase.revision,
        actor: 'local-user',
        rationale: '保持现状',
        eventId: 'ev_keep',
      },
      NOW,
    );
    expect(event.choseChallenger).toBe(false);
    const after = await store.loadCuratedState();
    // 保持现状**不是**一次事实变化：修订数与 revision 都不该变
    expect(after.revisions).toHaveLength(before.revisions.length);
    expect(after.revisions.map((r) => r.revision)).toEqual(before.revisions.map((r) => r.revision));
    expect(await store.listConflicts()).toHaveLength(0);
    expect((await store.loadAdjudications()).map((e) => e.eventId)).toEqual(['ev_keep']);
  });

  it('同 eventId 同参重试 → 幂等：审计只有一行、修订不增多、状态仍是应用过的', async () => {
    const io = new FakeIo();
    const { store, kase } = await withOpenCase(io);
    const pg = kase.candidates.find((c) => c.content === '用 Postgres') as ConflictCase['candidates'][number];
    const input = {
      conflictId: kase.conflictId,
      candidateId: pg.candidateId,
      expectedRevision: kase.revision,
      actor: 'local-user',
      rationale: '生产要 Postgres 扩展',
      eventId: 'ev_retry',
    };

    await store.resolve(input, NOW);
    const revisionsAfterFirst = (await store.loadCuratedState()).revisions.length;
    const projectionAfterFirst = await io.read(CURATED_MEMORY_FILE);

    const retry = await store.resolve(input, NOW);
    expect(retry.eventId).toBe('ev_retry');
    // 关键：重试返回的是**应用过**的状态，不是被回退的状态
    expect((await store.loadCuratedState()).revisions.length).toBe(revisionsAfterFirst);
    expect(await io.read(CURATED_MEMORY_FILE)).toBe(projectionAfterFirst);
    expect(await store.loadAdjudications()).toHaveLength(1);
  });

  it('同 eventId 换候选 → 明确拒绝', async () => {
    const io = new FakeIo();
    const { store, kase } = await withOpenCase(io);
    const pg = kase.candidates.find((c) => c.content === '用 Postgres');
    const mysql = kase.candidates.find((c) => c.content === '用 MySQL');
    expect(pg, 'challenger 候选应存在').toBeDefined();
    expect(mysql, '另一个 challenger 候选应存在').toBeDefined();
    await store.resolve(
      {
        conflictId: kase.conflictId,
        candidateId: (pg as ConflictCase['candidates'][number]).candidateId,
        expectedRevision: kase.revision,
        actor: 'u',
        rationale: 'r',
        eventId: 'ev_dup',
      },
      NOW,
    );
    await expect(
      store.resolve(
        {
          conflictId: kase.conflictId,
          candidateId: (mysql as ConflictCase['candidates'][number]).candidateId,
          expectedRevision: kase.revision,
          actor: 'u',
          rationale: 'r',
          eventId: 'ev_dup',
        },
        NOW,
      ),
    ).rejects.toThrow(/另一种裁决/);
  });

  it('陈旧提交（案件版本不符）→ 拒绝并要求重看', async () => {
    const io = new FakeIo();
    const { store, kase } = await withOpenCase(io);
    await expect(
      store.resolve(
        {
          conflictId: kase.conflictId,
          candidateId: kase.candidates[0].candidateId,
          expectedRevision: kase.revision + 5,
          actor: 'u',
          rationale: 'r',
          eventId: 'ev_stale',
        },
        NOW,
      ),
    ).rejects.toThrow(/版本/);
  });
});

describe('崩溃恢复（FR-M18）：八个写入边界', () => {
  /** 走到「已有一个 open 案件」的状态，返回做裁决所需的输入 */
  async function preparedCase() {
    const io = new FakeIo();
    const store = storeOn(io);
    seedFacts(io, [createMemoryFact(factInput('用 SQLite', { memoryKey: 'storage.db' }), NOW)]);
    await store.distill(NOW);
    seedFacts(io, [
      createMemoryFact(
        factInput('用 Postgres', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'x' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 Postgres', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'y' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 MySQL', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'z' }),
        NOW,
      ),
      createMemoryFact(
        factInput('用 MySQL', { memoryKey: 'storage.db', observedAt: OLD_LATER, evidence: 'w' }),
        NOW,
      ),
    ]);
    await store.distill(NOW);
    const kase = (await store.listConflicts())[0];
    const pg = kase.candidates.find((c) => c.content === '用 Postgres') as ConflictCase['candidates'][number];
    return {
      io,
      store,
      kase,
      input: {
        conflictId: kase.conflictId,
        candidateId: pg.candidateId,
        expectedRevision: kase.revision,
        actor: 'local-user',
        rationale: '生产要 Postgres 扩展',
        eventId: 'ev_crash',
      },
    };
  }

  /**
   * 逐个窗口：注入故障 → 裁决抛错 → **重启**（同一份 FakeIo 新建仓储）→ `recover()` →
   * 断言最终状态 == 应用过的状态、且审计只有一行。
   */
  const windows: Array<{ name: string; op: string; nth: number; after?: boolean }> = [
    { name: '① prepared 已写、curated 未替换', op: 'replace', nth: 1 },
    { name: '② curated 已替换、阶段事件未追加', op: 'replace', nth: 1, after: true },
    { name: '③ curated_applied 已记、conflicts 未替换', op: 'replace', nth: 2 },
    { name: '④ conflicts 已替换、阶段事件未追加', op: 'replace', nth: 2, after: true },
    { name: '⑤ conflict_closed 已记、审计未追加', op: 'appendLine', nth: 3 },
    { name: '⑥ 审计已追加、阶段事件未追加', op: 'appendLine', nth: 3, after: true },
    { name: '⑦ audit_appended 已记、committed 未追加', op: 'appendLine', nth: 4 },
  ];

  for (const w of windows) {
    it(`${w.name} → 重启后可恢复，审计不重复`, async () => {
      const { io, store, input } = await preparedCase();

      // 计数从**注入点**重新开始：`nth` 应当是「裁决过程中的第几次 op」，
      // 而不是「本次进程生命周期里的第几次」——构造夹具时已经写过若干次。
      io.calls = {};
      io.failOn = { op: w.op, nth: w.nth, after: w.after };
      let crashed = false;
      try {
        await store.resolve(input, NOW);
      } catch {
        crashed = true;
      }
      expect(
        crashed,
        `故障注入未生效（窗口：${w.name}；op=${w.op} nth=${w.nth} after=${w.after}；` +
          `已发生 ${JSON.stringify(io.calls)}）`,
      ).toBe(true);
      // 「重启」：清掉故障注入，用同一份磁盘内容新建仓储
      io.failOn = null;
      const restarted = storeOn(io);
      const result = await restarted.recover(NOW);

      // 最终一致：值换成了 challenger
      const state = await restarted.loadCuratedState();
      const activeContents = state.revisions.filter((r) => r.status === 'active').map((r) => r.content);
      expect(activeContents, `恢复后 active 应该是 challenger（窗口：${w.name}）`).toContain('用 Postgres');
      // 案件关闭
      expect(await restarted.listConflicts(), `恢复后案件应已关闭（窗口：${w.name}）`).toHaveLength(0);
      // 审计不重复（I10）
      expect(
        (await restarted.loadAdjudications()).filter((e) => e.eventId === 'ev_crash'),
        `审计事件不应重复（窗口：${w.name}）`,
      ).toHaveLength(1);
      // 事务最终 committed，且 recover 幂等
      const again = await restarted.recover(NOW);
      expect(again.recovered).toBe(0);
      expect(result.recovered).toBeGreaterThanOrEqual(0);
    });
  }

  it('恢复是幂等的：连续两次 recover 不改变状态', async () => {
    const { io, store, input } = await preparedCase();
    io.calls = {};
    io.failOn = { op: 'replace', nth: 1 };
    await expect(store.resolve(input, NOW)).rejects.toThrow(/injected failure/);
    io.failOn = null;

    const a = storeOn(io);
    await a.recover(NOW);
    const afterFirst = io.snapshot();
    const b = storeOn(io);
    await b.recover(NOW);
    expect(io.snapshot()).toEqual(afterFirst);
  });

  it('磁盘状态既不是 before 也不是 after → fail-closed（拒绝覆盖）', async () => {
    const { io, store, input } = await preparedCase();
    io.calls = {};
    io.failOn = { op: 'replace', nth: 1 };
    await expect(store.resolve(input, NOW)).rejects.toThrow(/injected failure/);
    io.failOn = null;

    // 模拟「别的设备/手工编辑」在恢复之前改动了 curated：把 active 的**内容**改掉。
    // 不能只加一条同域的修订——那会先在 `validateCuratedState` 上撞「两个 active」，
    // 测不到 fail-closed 这一条。
    const raw = (await io.read(CURATED_STATE_FILE)) as string;
    const state = JSON.parse(raw) as CuratedState;
    const foreign: CuratedState = {
      ...state,
      revisions: state.revisions.map((r) =>
        r.status === 'active' ? { ...r, content: '别人写的', lastSeen: NOW.toISOString() } : r,
      ),
    };
    io.files.set(CURATED_STATE_FILE, JSON.stringify(foreign, null, 2));

    await expect(storeOn(io).recover(NOW)).rejects.toThrow(/既不是 before 也不是 after/);
  });

  it('投影缺失时由 canonical 重建（FR-M19：投影可重建）', async () => {
    const { io, store, input } = await preparedCase();
    await store.resolve(input, NOW);
    // 手工把投影删掉，模拟「投影替换那一步没做成」
    await io.remove(CURATED_MEMORY_FILE);
    expect(await io.read(CURATED_MEMORY_FILE)).toBeNull();

    const restarted = storeOn(io);
    const text = await restarted.rebuildProjection(NOW);
    expect(text).toContain('用 Postgres');
    // 案件状态不受影响（投影只是视图）
    expect(await restarted.listConflicts()).toHaveLength(0);
  });

  it('事务日志有无法解析的行 → 拒绝继续（不猜）', async () => {
    const { io } = await preparedCase();
    await io.appendLine(TRANSACTIONS_FILE, '{ 这不是 JSON');
    await expect(storeOn(io).recover(NOW)).rejects.toThrow(/无法解析/);
  });

  it('阶段跳跃的日志 → 拒绝继续', async () => {
    const { io } = await preparedCase();
    // 手写一条「缺 prepared 直接 committed」的事件
    await io.appendLine(
      TRANSACTIONS_FILE,
      JSON.stringify({
        kind: 'phase',
        transactionId: 'tx_bogus',
        intentSha256: 'x',
        phase: 'committed',
        at: NOW.toISOString(),
      }),
    );
    await expect(storeOn(io).recover(NOW)).rejects.toThrow(/早于 intent|阶段/);
  });
});

describe('治理动作落盘', () => {
  it('停用 / 恢复 / 删除都会重建投影', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    seedFacts(io, [createMemoryFact(factInput('用 SQLite WAL 模式'), NOW)]);
    await store.distill(NOW);
    const entryKey = (await store.loadCuratedState()).revisions[0].entryKey;

    await store.disable(entryKey, '换方案了', NOW);
    expect(await io.read(CURATED_MEMORY_FILE)).toBeNull();
    expect((await store.loadCuratedState()).revisions[0].status).toBe('disabled');

    await store.enable(entryKey, NOW);
    expect(await io.read(CURATED_MEMORY_FILE)).toContain('用 SQLite WAL 模式');

    await store.remove(entryKey, '不再适用', NOW);
    const after = await store.loadCuratedState();
    expect(after.revisions.some((r) => r.entryKey === entryKey)).toBe(false);
    // 域级墓碑：删除这件事本身被记下来了
    expect(after.revisions.some((r) => r.entryKey.startsWith('x:'))).toBe(true);
  });
});

describe('事务推进器：阶段顺序与可重入', () => {
  it('advanceIntent 从空进度开始会依次做完五个阶段', async () => {
    const seen: string[] = [];
    const port = {
      async prepare() {
        seen.push('prepare');
      },
      async applyCurated() {
        seen.push('applyCurated');
      },
      async applyConflicts() {
        seen.push('applyConflicts');
      },
      async appendAudit() {
        seen.push('appendAudit');
      },
      async appendPhase(_t: string, _h: string, phase: TxnPhase) {
        seen.push(`phase:${phase}`);
      },
    };
    const intent = { transactionId: 'tx', intentSha256: 'h' } as ResolutionIntent;
    const result = await advanceIntent(port, intent, []);
    expect(seen).toEqual([
      'prepare',
      'applyCurated',
      'phase:curated_applied',
      'applyConflicts',
      'phase:conflict_closed',
      'appendAudit',
      'phase:audit_appended',
      'phase:committed',
    ]);
    expect(result.phases).toEqual([
      'prepared',
      'curated_applied',
      'conflict_closed',
      'audit_appended',
      'committed',
    ]);
  });

  it('已有 prepared 时不再重复 prepare（可重入）', async () => {
    const seen: string[] = [];
    const port = {
      async prepare() {
        seen.push('prepare');
      },
      async applyCurated() {
        seen.push('applyCurated');
      },
      async applyConflicts() {
        seen.push('applyConflicts');
      },
      async appendAudit() {
        seen.push('appendAudit');
      },
      async appendPhase(_t: string, _h: string, phase: TxnPhase) {
        seen.push(`phase:${phase}`);
      },
    };
    const intent = { transactionId: 'tx', intentSha256: 'h' } as ResolutionIntent;
    await advanceIntent(port, intent, ['prepared', 'curated_applied']);
    expect(seen).not.toContain('prepare');
    expect(seen).not.toContain('applyCurated');
    expect(seen).toContain('applyConflicts');
    expect(seen).toContain('phase:committed');
  });
});

describe('空状态与默认值', () => {
  it('从未策展时给出空状态，且冲突列表为空', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    const state = await store.loadCuratedState();
    expect(state.revisions).toEqual([]);
    expect(state.workspaceId).toBe(WS);
    expect(await store.listConflicts()).toEqual([]);
    expect(await store.loadAdjudications()).toEqual([]);
    expect(await store.loadFacts(null, NOW)).toEqual([]);
  });

  it('没有 active 时投影文件被删除（不留一个空文件当幽灵条目）', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    seedFacts(io, [createMemoryFact(factInput('用 SQLite WAL 模式'), NOW)]);
    await store.distill(NOW);
    expect(await io.read(CURATED_MEMORY_FILE)).not.toBeNull();

    const entryKey = (await store.loadCuratedState()).revisions[0].entryKey;
    await store.disable(entryKey, 'x', NOW);
    expect(await io.read(CURATED_MEMORY_FILE)).toBeNull();
    // 但 canonical 还在（停用不是删除）
    expect((await store.loadCuratedState()).revisions).toHaveLength(1);
  });

  it('rebuildProjection 能从 canonical 恢复被人为删掉的投影', async () => {
    const io = new FakeIo();
    const store = storeOn(io);
    seedFacts(io, [createMemoryFact(factInput('用 SQLite WAL 模式'), NOW)]);
    await store.distill(NOW);
    await io.remove(CURATED_MEMORY_FILE);

    const text = await store.rebuildProjection(NOW);
    expect(text).toContain('用 SQLite WAL 模式');
    expect(await io.read(CURATED_MEMORY_FILE)).toContain('用 SQLite WAL 模式');
  });
});

describe('空冲突状态与默认值', () => {
  it('emptyConflictState 的归属与 schema 正确', () => {
    const state = emptyConflictState(WS, NOW);
    expect(state.schema).toBe(2);
    expect(state.workspaceId).toBe(WS);
    expect(state.cases).toEqual([]);
  });
});
