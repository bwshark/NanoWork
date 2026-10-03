/**
 * 记忆的**持久化边界**：canonical 状态、证据日志、事务 journal、恢复与投影。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M1 – FR-M19；设计：`docs/architecture-memory-v2.md` §4.2 / §4.5 / §4.6。
 *
 * ## 分层
 *
 * ```
 * 纯逻辑（已有）      memoryFact / memoryDistill / memoryAdjudicate / memoryTransaction
 *        ↑
 * 本模块（仓储）      组合它们 + 经 MemoryStoreIo 读写文件 + 崩溃恢复
 *        ↑
 * 适配器              platform.memoryDirs（渲染层）/ 主进程 IPC
 * ```
 *
 * 本模块**不 import `@/platform`**：IO 由 `MemoryStoreIo` 注入，因此可以在 jsdom 下用
 * 内存假端口跑全部崩溃窗口，也可以在真机临时目录上跑同一套用例。
 *
 * ## 三个不做的事（刻意）
 *
 * 1. **不删证据**：`daily/*.jsonl` 只追加；`distill` 不改它（清理是独立的保留策略）。
 * 2. **不猜**：恢复时磁盘状态既不是 before 也不是 after → fail-closed 抛错。
 * 3. **不把投影当权威**：`MEMORY.md` 每次由 canonical 重建，坏了重生成即可。
 */

import type {
  AdjudicationEvent,
  ConflictCase,
  ConflictState,
  CuratedState,
  CuratedEntry,
  DistillPolicy,
  DistillReport,
  EntryKey,
  MemoryFact,
  ResolveConflictInput,
  ResolutionIntent,
  TxnPhase,
  TxnPhaseEvent,
} from '@/types';
import {
  ADJUDICATIONS_FILE,
  ARCHIVE_SUBDIR,
  CONFLICTS_FILE,
  CURATED_MEMORY_FILE,
  CURATED_STATE_FILE,
  DAILY_SUBDIR,
  PREFERENCES_FILE,
  PROFILE_FILE,
  TRANSACTIONS_FILE,
  USER_PROFILE_PROJECTION_FILE,
  dailyFactLogFileName,
  isFactLogFileName,
} from '@/lib/memoryPaths';
import {
  createMemoryFact,
  dedupeFacts,
  parseMemoryFactLine,
  serializeMemoryFact,
  type CreateFactInput,
} from '@/lib/memoryFact';
import {
  CorruptCuratedStateError,
  DEFAULT_DISTILL_POLICY,
  activeOf,
  distillFacts,
  emptyCuratedState,
  validateCuratedState,
} from '@/lib/memoryDistill';
import {
  ConflictEventReuseError,
  StaleConflictResolutionError,
  disableEntry,
  deleteEntry,
  emptyConflictState,
  enableEntry,
  mergeNewCases,
  openConflicts,
  parseTransactionJournal,
  planRecovery,
  resolveConflict,
  supersedeStaleCases,
} from '@/lib/memoryAdjudicate';
import { advanceIntent, hasAuditEvent, type MemoryTxnPort } from '@/lib/memoryTransaction';
import {
  DEFAULT_ARCHIVE_POLICY,
  runArchive,
  type ArchivePolicy,
  type ArchiveResult,
} from '@/lib/memoryArchive';
import { hashContent } from '@/lib/workspaceKey';
import type { MemoryExportBundle } from '@/lib/memoryBundle';

/** 记忆目录的 IO 端口（适配器实现） */
export interface MemoryStoreIo {
  list(subdir?: string): Promise<string[]>;
  read(name: string, subdir?: string): Promise<string | null>;
  /** 原子替换（canonical 状态必须用它；派生视图可用 `write`） */
  replace(name: string, content: string, subdir?: string): Promise<void>;
  /** 覆盖写（派生视图：坏了能重建，不需要原子性代价） */
  write(name: string, content: string, subdir?: string): Promise<void>;
  appendLine(name: string, line: string, subdir?: string): Promise<void>;
  readLines(name: string, subdir?: string): Promise<string[]>;
  remove(name: string, subdir?: string): Promise<void>;
}

/** `appendFact` 的结果 */
export type AppendFactOutcome = 'written' | 'skipped-duplicate';

/** 存储实例的构造参数 */
export interface MemoryStoreOptions {
  io: MemoryStoreIo;
  /** 归属标识（工作区标识或用户作用域摘要）：写进每个 canonical 文件，读取时校验 */
  workspaceId: string;
  /** 蒸馏策略（缺省用 `DEFAULT_DISTILL_POLICY`） */
  policy?: DistillPolicy;
  /** 从 canonical 状态渲染人读投影的函数（缺省 `MEMORY.md` 的渲染见 `memoryProject`） */
  renderProjection?: (state: CuratedState) => string;
}

/** 记忆仓储 */
export interface MemoryStore {
  readonly workspaceId: string;
  /** 追加一条事实（校验 + 幂等去重）；返回是否真的写了 */
  appendFact(input: CreateFactInput, now: Date): Promise<AppendFactOutcome>;
  /** 读取 `since` 之后的事实（按 observedAt 升序、factId 去重） */
  loadFacts(since: Date | null, now: Date): Promise<MemoryFact[]>;
  /** 读取策展状态（不存在返回空状态）；归属不符或损坏则抛错 */
  loadCuratedState(): Promise<CuratedState>;
  /** 读取冲突状态（不存在返回空状态） */
  loadConflicts(): Promise<ConflictState>;
  /** 读取审计流 */
  loadAdjudications(): Promise<AdjudicationEvent[]>;
  /** 蒸馏并落盘（canonical + 可能的新案件 + 重建投影）；返回报告 */
  distill(now: Date): Promise<{ report: DistillReport; state: CuratedState; conflicts: ConflictState }>;
  /** 执行一次人工裁决（五阶段事务 + 幂等重试） */
  resolve(input: ResolveConflictInput, now: Date): Promise<AdjudicationEvent>;
  /** 列出现待裁决案件 */
  listConflicts(): Promise<ConflictCase[]>;
  /** 单条治理动作 */
  disable(entryKey: EntryKey, reason: string, now: Date): Promise<void>;
  enable(entryKey: EntryKey, now: Date): Promise<void>;
  remove(entryKey: EntryKey, reason: string, now: Date): Promise<void>;
  /** 恢复未完成的事务（构造后必须先调用；幂等） */
  recover(now: Date): Promise<{ recovered: number; alreadyCommitted: number }>;
  /** 由 canonical 状态重建 `MEMORY.md` 投影 */
  rebuildProjection(now: Date): Promise<string>;
  /**
   * 归档过期日志（FR-M33）。
   *
   * 放在仓储里而不是调用方自己拿 IO：归档要**逐行复核事实年龄**，而「怎么解析一条事实、
   * 归属怎么校验」是仓储的知识（`workspaceId`）。让调用方去拼这些只会造出第二份解析逻辑。
   */
  archive(now: Date, policy?: ArchivePolicy): Promise<ArchiveResult>;
  /**
   * 导入一份已校验的 bundle（FR-M35 / M4-03）。
   *
   * 三条语义（每条都对应一种真实的失败）：
   *
   * 1. **作用域不符直接拒绝**：把 A 项目的结论导进 B 项目是最难排查的污染——
   *    它看起来完全正常。校验在 `parseExportBundle` 与这里各做一次（后者防调用方绕过）。
   * 2. **事实标 `origin: 'import'`**：让「这条是怎么来的」可回答，也让导入的事实
   *    与本地沉淀的事实**享有同一套晋升门槛**（年龄门槛按**原始 `observedAt`** 判，
   *    不是按导入时刻——否则三年前的旧事实要再等 30 天才能生效，那没有道理）。
   * 3. **绝不覆盖既有 active 结论**：证据照进（它们参与下一次蒸馏），但
   *    `curated.json` 只有在本地还是空的时候才接受 bundle 里的结论。理由与
   *    「冲突不自动裁决」同源——**导入不是判断谁对**的场合，它是把证据搬过来。
   */
  importBundle(bundle: MemoryExportBundle, now: Date): Promise<ImportResult>;
}

/** 一次导入的结果 */
export interface ImportResult {
  /** 本次新写入的证据条数（已存在的不计） */
  factsImported: number;
  /** 因本地已有 active 结论而**未采用**的 bundle 结论数（它们变成证据，不是结果） */
  curatedSkipped: number;
  /** 本地原本为空、因此采用了 bundle 结论 */
  curatedAdopted: boolean;
  /** 是否写入了用户级画像 / 偏好 */
  profileImported: boolean;
}

/** 解析 canonical JSON；损坏时抛错而不是返回默认值 */
function parseJsonState<T>(raw: string | null, label: string): T | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CorruptCuratedStateError(`${label} 不是合法 JSON（可能被写坏，或读到半截内容）`);
  }
}

/** 归属校验：canonical 文件里的 `workspaceId` 与本次解析出的归属不一致即拒绝 */
function assertOwnership(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) {
    throw new CorruptCuratedStateError(
      `${label} 的归属是 ${String(actual)}，与当前作用域 ${expected} 不符——` +
        '可能是跨工作区误拷或调用方传错作用域，拒绝读取',
    );
  }
}

/** 稳定 JSON（canonical 文件用；对象键排序，保证同一状态逐字节相同） */
function stableStringify(value: unknown): string {
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) throw new Error('canonical 状态里出现环，拒绝序列化');
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = walk(child);
    }
    return out;
  };
  return `${JSON.stringify(walk(value), null, 2)}\n`;
}

/**
 * 创建记忆仓储。
 *
 * ## 为什么用工厂而不是 class
 *
 * 仓储的全部依赖都是注入的（IO / 归属 / 策略 / 投影渲染）；用工厂可以让调用方一眼看清
 * 「这个实例绑定了哪个作用域」，也避免有人 `new` 一个半配置的实例出来。
 */
export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const { io, workspaceId } = options;
  const policy = options.policy ?? DEFAULT_DISTILL_POLICY;
  const renderProjection = options.renderProjection;

  async function loadCuratedState(): Promise<CuratedState> {
    const raw = await io.read(CURATED_STATE_FILE);
    const parsed = parseJsonState<CuratedState>(raw, CURATED_STATE_FILE);
    if (!parsed) return emptyCuratedState(workspaceId, new Date());
    assertOwnership(parsed.workspaceId, workspaceId, CURATED_STATE_FILE);
    validateCuratedState(parsed);
    return parsed;
  }

  async function loadConflicts(): Promise<ConflictState> {
    const raw = await io.read(CONFLICTS_FILE);
    const parsed = parseJsonState<ConflictState>(raw, CONFLICTS_FILE);
    if (!parsed) return emptyConflictState(workspaceId, new Date());
    assertOwnership(parsed.workspaceId, workspaceId, CONFLICTS_FILE);
    if (!Array.isArray(parsed.cases)) {
      throw new CorruptCuratedStateError(`${CONFLICTS_FILE} 的 cases 不是数组`);
    }
    return parsed;
  }

  async function loadAdjudications(): Promise<AdjudicationEvent[]> {
    const lines = await io.readLines(ADJUDICATIONS_FILE);
    const events: AdjudicationEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as AdjudicationEvent;
        if (parsed && typeof parsed.eventId === 'string') events.push(parsed);
      } catch {
        // 单行写坏不该让整条审计流不可读；跳过并继续（审计是追加流，
        // 一行损坏通常来自断电，而其余行仍然是可用的证据）
      }
    }
    return events;
  }

  async function loadJournal(): Promise<TxnPhaseEvent[]> {
    const lines = await io.readLines(TRANSACTIONS_FILE);
    const events: TxnPhaseEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as TxnPhaseEvent;
        if (parsed && typeof parsed.transactionId === 'string') events.push(parsed);
      } catch {
        throw new CorruptCuratedStateError(
          `${TRANSACTIONS_FILE} 有无法解析的行——事务日志不可信，拒绝继续（请人工检查）`,
        );
      }
    }
    return events;
  }

  async function loadFacts(since: Date | null, now: Date): Promise<MemoryFact[]> {
    const names = await io.list(DAILY_SUBDIR);
    const dailyNames = names.filter(isFactLogFileName).sort();
    const collected: MemoryFact[] = [];
    for (const name of dailyNames) {
      const lines = await io.readLines(name, DAILY_SUBDIR);
      for (const line of lines) {
        const fact = parseMemoryFactLine(line, workspaceId);
        if (!fact) continue;
        if (since && Date.parse(fact.observedAt) < since.getTime()) continue;
        if (Date.parse(fact.observedAt) > now.getTime()) continue;
        collected.push(fact);
      }
    }
    return dedupeFacts(collected);
  }

  async function writeCurated(state: CuratedState): Promise<void> {
    validateCuratedState(state);
    await io.replace(CURATED_STATE_FILE, stableStringify(state));
  }

  async function writeConflicts(state: ConflictState): Promise<void> {
    await io.replace(CONFLICTS_FILE, stableStringify(state));
  }

  async function writeProjection(state: CuratedState): Promise<void> {
    if (!renderProjection) return;
    const text = renderProjection(state);
    if (text.trim() === '') {
      await io.remove(CURATED_MEMORY_FILE);
      return;
    }
    // 投影是派生视图：坏了能重建，故用覆盖写而不是原子替换（省一次 rename）
    await io.write(CURATED_MEMORY_FILE, text.endsWith('\n') ? text : `${text}\n`);
  }

  /**
   * 事务端口：把五个阶段映射到本作用域的三个文件 + 两个 journal。
   *
   * `prepare` 一次做完两件事：追加 intent **并**追加 `prepared` 阶段事件。两者都写进
   * 同一个 append-only 文件，`appendIntent` 不会中途抛错把它们拆开；而
   * `advanceIntent` 在 `already` 里含 `prepared` 时不会再调它——所以「prepared 阶段
   * 事件被写两次、journal 解析报阶段跳跃」这条曾经的真实故障不会复现。
   */
  async function appendIntent(intent: ResolutionIntent): Promise<void> {
    await io.appendLine(
      TRANSACTIONS_FILE,
      JSON.stringify({
        kind: 'intent',
        transactionId: intent.transactionId,
        intentSha256: intent.intentSha256,
        intent,
        at: intent.preparedAt,
      } satisfies TxnPhaseEvent),
    );
    await io.appendLine(
      TRANSACTIONS_FILE,
      JSON.stringify({
        kind: 'phase',
        transactionId: intent.transactionId,
        intentSha256: intent.intentSha256,
        phase: 'prepared',
        at: intent.preparedAt,
      } satisfies TxnPhaseEvent),
    );
  }

  function portFor(): MemoryTxnPort {
    return {
      prepare: appendIntent,
      async applyCurated(intent: ResolutionIntent): Promise<void> {
        await writeCurated(intent.after.curated);
      },
      async applyConflicts(intent: ResolutionIntent): Promise<void> {
        await writeConflicts(intent.after.conflicts);
      },
      async appendAudit(intent: ResolutionIntent): Promise<void> {
        const existing = await loadAdjudications();
        if (hasAuditEvent(existing, intent.eventId)) return;
        await io.appendLine(ADJUDICATIONS_FILE, JSON.stringify(intentAudit(intent)));
      },
      async appendPhase(
        transactionId: string,
        intentSha256: string,
        phase: TxnPhase,
      ): Promise<void> {
        await io.appendLine(
          TRANSACTIONS_FILE,
          JSON.stringify({
            kind: 'phase',
            transactionId,
            intentSha256,
            phase,
            at: new Date().toISOString(),
          } satisfies TxnPhaseEvent),
        );
      },
    };
  }

  /** 由意图推出审计事件（恢复时需要重演同一份，故必须是纯推演） */
  function intentAudit(intent: ResolutionIntent): AdjudicationEvent {
    const beforeKase = (intent.before.conflicts.cases ?? []).find(
      (c) => c.conflictId === intent.conflictId,
    );
    const afterKase = (intent.after.conflicts.cases ?? []).find(
      (c) => c.conflictId === intent.conflictId,
    );
    const beforeActive = beforeKase ? activeOf(intent.before.curated, beforeKase.entryKey) : null;
    const chosen = beforeKase?.candidates.find((c) => c.candidateId === intent.candidateId);
    // challenger 的定义：选中的候选**不是**检测时 active 的内容
    const choseChallenger =
      chosen !== undefined &&
      (beforeActive === null || chosen.content !== beforeActive.content);
    return {
      eventId: intent.eventId,
      conflictId: intent.conflictId,
      caseRevision: beforeKase?.revision ?? 1,
      candidateId: intent.candidateId,
      actor: intent.actor,
      rationale: intent.rationale,
      evidenceIds: chosen?.evidenceIds ?? [],
      previousEntryKey: beforeActive ? beforeActive.entryKey : null,
      resultEntryKey: (afterKase?.resolution?.resultEntryKey ?? null) as EntryKey | null,
      choseChallenger,
      at: intent.preparedAt,
    };
  }

  async function recover(now: Date): Promise<{ recovered: number; alreadyCommitted: number }> {
    const events = await loadJournal();
    if (events.length === 0) return { recovered: 0, alreadyCommitted: 0 };

    const progress = parseTransactionJournal(events);
    const port = portFor();
    let recovered = 0;
    let alreadyCommitted = 0;

    for (const item of progress) {
      if (item.committed) {
        alreadyCommitted += 1;
        continue;
      }
      // 先看磁盘现状，再决定重做还是继续；既不是 before 也不是 after 会抛错（fail-closed）
      const onDisk = {
        curated: await loadCuratedState(),
        conflicts: await loadConflicts(),
      };
      const plan = planRecovery(item, onDisk, item, false);
      if (plan.action === 'noop') {
        alreadyCommitted += 1;
        continue;
      }
      if (plan.action === 'redo') {
        // intent 已经在 journal 里（否则解不出 progress），故从 curated_applied 继续，
        // 不能重写 prepared——那会让阶段事件重复、下次解析直接报跳跃。
        await advanceIntent(port, item.intent, ['prepared']);
      } else {
        await advanceIntent(port, item.intent, item.phases);
      }
      recovered += 1;
    }
    void now;
    return { recovered, alreadyCommitted };
  }

  /**
   * 一次蒸馏（提取成函数而不是内联在对象字面量里）。
   *
   * `importBundle` 也要用它：导入之后必须按**本地**策略重新晋升一次，而不是照抄
   * bundle 里的结论。两个调用点共享同一段逻辑，才不会出现「导入路径少做一步」。
   */
  async function distillOnce(now: Date): Promise<{
    report: ReturnType<typeof distillFacts>['report'];
    state: CuratedState;
    conflicts: ConflictState;
  }> {
    const facts = await loadFacts(null, now);
    const prev = await loadCuratedState();
    const prevConflicts = await loadConflicts();

    const { next, newCases, report } = distillFacts(facts, prev, policy, now, workspaceId);

    // 案件：新案并入 + 证据变化但未决的旧案标 superseded（否则用户会对着过期候选决定）
    let merged = mergeNewCases(prevConflicts, newCases, now);
    merged = supersedeStaleCases(merged, newCases, now);

    const casesChanged = newCases.length > 0;
    const curatedChanged = stableStringify(next) !== stableStringify(prev);

    if (casesChanged) {
      // 多文件变更 → 一次写完两处。**刻意不走五阶段事务**：蒸馏是**幂等重算**
      // （给定同一批事实必然得到同一份 canonical），所以「写了一半」下次蒸馏就修好了；
      // 而事务的判据是「磁盘等于 before → 重做」，在重算场景下 before 永远不匹配，
      // 只会让恢复逻辑空转。裁决不同——它承载**人的决定**，丢了不可复现，所以走事务。
      await writeCurated(next);
      await writeConflicts(merged);
    } else if (curatedChanged) {
      await writeCurated(next);
    }

    await writeProjection(next);
    return { report, state: next, conflicts: merged };
  }

  return {
    workspaceId,
    appendFact: async (input, now) => {
      // 归属由仓储决定，调用方传什么都覆盖掉——避免「往别的分区写事实」这类串味
      const fact = createMemoryFact({ ...input, workspaceId }, now);

      // 事实落进**它自己那个观测日**的日文件（`dailyFactLogFileName(observedAt)`）。
      //
      // 去重因此只查那一个文件，而**不能**按「最近 N 天」扫：事实的 `observedAt` 可以很老
      // （一条三年前的决策仍是有效证据），用 `now - N 天` 做窗口会把老事实整个漏出扫描范围，
      // 于是「同一事实重复写入」永远判不出来——曾经的真实 bug。
      //
      // 同一 factId 必然落在同一个日文件（`observedAt` 相同才可能 id 相同），所以查一个
      // 文件既充分又便宜。文件内的重复行由 `loadFacts` 的 `dedupeFacts` 兜底。
      const name = dailyFactLogFileName(new Date(fact.observedAt));
      const lines = await io.readLines(name, DAILY_SUBDIR);
      if (lines.some((line) => parseMemoryFactLine(line, workspaceId)?.factId === fact.factId)) {
        return 'skipped-duplicate';
      }

      await io.appendLine(name, serializeMemoryFact(fact), DAILY_SUBDIR);
      return 'written';
    },

    loadFacts,

    loadCuratedState,
    loadConflicts,
    loadAdjudications,

    distill: (now) => distillOnce(now),

    resolve: async (input, now) => {
      const curated = await loadCuratedState();
      const conflicts = await loadConflicts();
      // 空 journal 时先跑一次恢复：未完成的裁决不该在「用户正在裁决」时还被留着
      await recover(now);
      const fresh = await loadConflicts();
      const events = await loadAdjudications();
      const facts = await loadFacts(null, now);
      const factIds = facts.map((f) => f.factId);

      const result = resolveConflict(input, curated, fresh, events, now, factIds);

      if (!result.applied) {
        // 同 eventId 同参重试：**状态已经应用过**，不重复落盘。
        // 注意不能在这里「补写审计」——`loadAdjudications` 已经能看到那条事件了。
        return result.adjudication;
      }

      if (result.adjudication.choseChallenger) {
        // 挑战者胜出：canonical 与 conflicts 都要改 → 走五阶段事务，保证不会只落一半
        const intent = buildIntent(
          input,
          { curated, conflicts },
          result.nextCurated,
          result.nextConflicts,
          now,
        );
        await portFor().prepare(intent);
        await advanceIntent(portFor(), intent, ['prepared']);
        await writeProjection(result.nextCurated);
        return result.adjudication;
      }

      // ── 选 incumbent（保持现状）────────────────────────────────────────────
      //
      // **不能走事务**：`after.curated === before.curated`，而事务的恢复判据是
      // 「磁盘状态等于 before → 重做、等于 after → 继续」。两者相等时它永远判成
      // 「还没做」，于是每次恢复都重写一遍 conflicts、追一遍阶段事件；更糟的是
      // **一次被拒绝的提交**也会把 intent 留在 journal 里，下一次提交同 id 时被
      // 幂等路径重演成「什么都没发生」——用户看到的是「点了提交却毫无反应」。
      // （这两件事都是实施时踩到的，`tests/memoryPageFactsView.test.tsx` 有一条
      // 陈旧提交的用例守着。）
      //
      // 保持现状只需要两件事：关掉案件 + 记一条审计。
      await writeConflicts(result.nextConflicts);
      await io.appendLine(ADJUDICATIONS_FILE, JSON.stringify(result.adjudication));
      return result.adjudication;
    },

    listConflicts: async () => openConflicts(await loadConflicts()),

    disable: async (entryKey, reason, now) => {
      const curated = await loadCuratedState();
      const next = disableEntry(curated, entryKey, reason, now);
      await writeCurated(next);
      await writeProjection(next);
    },

    enable: async (entryKey, now) => {
      const curated = await loadCuratedState();
      const next = enableEntry(curated, entryKey, now);
      await writeCurated(next);
      await writeProjection(next);
    },

    remove: async (entryKey, reason, now) => {
      const curated = await loadCuratedState();
      const next = deleteEntry(curated, entryKey, reason, now);
      await writeCurated(next);
      await writeProjection(next);
    },

    recover,

    rebuildProjection: async (now) => {
      const state = await loadCuratedState();
      await writeProjection(state);
      void now;
      return renderProjection ? renderProjection(state) : '';
    },

    archive: async (now, policy) =>
      runArchive(
        io,
        now,
        policy ?? DEFAULT_ARCHIVE_POLICY,
        // 用仓储自己的归属做校验：归属不符的行**不算有效事实**，
        // 于是带错归属的日文件会被正常归档，而不会因为「解析不出事实」被一直留下。
        (line) => parseMemoryFactLine(line, workspaceId),
      ),

    importBundle: async (bundle, now) => {
      // ① 作用域二次校验（调用方可能绕过 `parseExportBundle`）
      if (bundle.workspaceId !== workspaceId) {
        throw new CorruptCuratedStateError(
          `bundle 属于工作区 ${bundle.workspaceId}，与当前工作区 ${workspaceId} 不符——拒绝导入`,
        );
      }
      // 当前工作区仓储只有一个归属维度，`userScope` 的校验由 `parseExportBundle`
      // 与用户级仓储各自负责；这里不做一次恒真的自比较（那只会让人以为校验过了）。

      // ② 证据照进：**保留原始 observedAt**（年龄门槛按原始时间判，见接口注释）
      const existing = new Set((await loadFacts(null, now)).map((f) => f.factId));
      let factsImported = 0;
      for (const raw of bundle.facts ?? []) {
        const fact = { ...raw, workspaceId, origin: 'import' as const };
        if (existing.has(fact.factId)) continue;
        try {
          const outcome = await io.appendLine(
            dailyFactLogFileName(new Date(fact.observedAt)),
            serializeMemoryFact(fact),
            DAILY_SUBDIR,
          );
          void outcome;
          existing.add(fact.factId);
          factsImported += 1;
        } catch {
          // 单条坏数据不该让整次导入失败
        }
      }

      // ③ 结论：本地为空才采用（导入不是判断谁对的场合）
      const local = await loadCuratedState();
      const localActive = (local.revisions ?? []).filter(
        (r: CuratedEntry) => r.status === 'active',
      );
      let curatedSkipped = 0;
      let curatedAdopted = false;
      if (localActive.length === 0) {
        const incoming = (bundle.curated?.revisions ?? []).filter(
          (r: CuratedEntry) => r.status === 'active',
        );
        if (incoming.length > 0) {
          await writeCurated({ ...bundle.curated, workspaceId });
          curatedAdopted = true;
        }
      } else {
        curatedSkipped = (bundle.curated?.revisions ?? []).filter(
          (r: CuratedEntry) => r.status === 'active',
        ).length;
      }

      // ④ 待裁决案件：本地为空时一并带入（否则它们会变成「凭空出现的候选」）
      if ((await loadConflicts()).cases.length === 0 && (bundle.conflicts?.cases.length ?? 0) > 0) {
        await writeConflicts({ ...bundle.conflicts, workspaceId });
      }

      // ⑤ 蒸馏一次：把带进来的证据按**本地**策略晋升（而不是照抄 bundle 的结论）
      await distillOnce(now);

      return {
        factsImported,
        curatedSkipped,
        curatedAdopted,
        profileImported: false,
      };
    },
  };
}

/** 由裁决结果构造事务意图（哈希与 id 都在这里定死，便于测试比对） */
function buildIntent(
  input: ResolveConflictInput,
  before: { curated: CuratedState; conflicts: ConflictState },
  afterCurated: CuratedState,
  afterConflicts: ConflictState,
  now: Date,
): ResolutionIntent {
  const body = {
    workspaceId: before.curated.workspaceId,
    conflictId: input.conflictId,
    candidateId: input.candidateId,
    eventId: input.eventId,
    actor: input.actor,
    rationale: input.rationale.trim(),
    before,
    after: { curated: afterCurated, conflicts: afterConflicts },
  };
  const intentSha256 = hashContent(JSON.stringify(body));
  return {
    transactionId: `tx_${hashContent(`${body.workspaceId}\u0000${input.eventId}\u0000${now.getTime()}`)}`,
    intentSha256,
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

export {
  ConflictEventReuseError,
  StaleConflictResolutionError,
  ARCHIVE_SUBDIR,
  PREFERENCES_FILE,
  PROFILE_FILE,
  USER_PROFILE_PROJECTION_FILE,
};
