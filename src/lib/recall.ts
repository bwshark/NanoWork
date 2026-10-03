/**
 * 跨会话召回的**五阶段主路径**：`normalize → candidate → score → stableRank → render`。
 *
 * 需求：`docs/prd-memory-v2.md` FR-M25 – FR-M30；设计：`docs/architecture-memory-v2.md` §4.8。
 *
 * ## 为什么拆成五个阶段
 *
 * 「检索」这件事经常被写成一个不可解释的最终分数：分数低了不知道为什么，排名变了不知道
 * 为什么。拆开之后每一阶段都有结构化产物，任一阶段失败都能定位到**输入 / 候选 / 评分 /
 * 排序 / 渲染**的哪一环：
 *
 * | 阶段 | 产物 | 典型失败 |
 * |---|---|---|
 * | normalize | `RecallQuery` | query 是空的、或只有标点 |
 * | candidate | `RecallCandidate[]` | 语料为空 vs 没有词项重合（两者都要能区分） |
 * | score | `RecallScoreBreakdown` | 分数算错，但拆解能看出是哪一项 |
 * | stableRank | `rank` | 并列时的顺序随存放顺序漂移 |
 * | render | `<recalled_context>` | 空结果也注入一个空 wrapper，白吃预算 |
 *
 * ## 三条硬约束
 *
 * 1. **只读**：召回不写任何 durable store（不变量 I7）。
 * 2. **确定性**：同输入同输出，字符串比较用 `<`，并列用显式 tie-breaker（NFR-M12）。
 * 3. **无模型**：本模块不依赖任何模型配置，可离线验证（NFR-M1）。
 */

import type {
  MemorySource,
  RecallCandidate,
  RecallHit,
  RecallOptions,
  RecallQuery,
  RecallResult,
  RecallScoreBreakdown,
  StoredMemory,
} from '@/types';
import { compareStrings } from '@/lib/memoryNormalize';
import { hashContent } from '@/lib/workspaceKey';

/** 默认召回参数 */
export const DEFAULT_RECALL_OPTIONS: RecallOptions = {
  // 半年：更老的会话记录新鲜度归零，但**仍可命中**（覆盖率高就能排上来）
  recencyWindowDays: 180,
  weights: { lexical: 0.85, recency: 0.15 },
};

/** `limit` 的合法区间（越界即拒绝，不退化成「用默认值」） */
export const RECALL_LIMIT_MIN = 1;
export const RECALL_LIMIT_MAX = 10;

/** 召回参数非法 */
export class RecallQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallQueryError';
  }
}

/**
 * 归一化检索文本。
 *
 * 三件事：折叠空白 → NFKC（把全角/半角、兼容字符收敛）→ casefold（统一小写）。
 * 顺序不能反：先折叠空白能让 NFKC 面对更干净的分隔符。
 */
export function normalizeRecallText(raw: string): string {
  return (raw ?? '')
    .replace(/\s+/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
}

/**
 * 切词：英文按单词、**连续中文补二元字符**。
 *
 * 中文没有空格可切，单字切分会让「分层记忆」与「记忆分层」得到同一组词项（都是
 * 分层/记忆），而二元字符（分层/层记/记忆）保留了语序信息——这正是 s12 的做法，
 * 也是「换一个词序就该是不同的检索」这条直觉的最小实现。
 */
export function tokenizeRecall(normalized: string): string[] {
  const text = normalized ?? '';
  if (text === '') return [];
  const terms = new Set<string>();

  // 英文 / 数字：按连续字母数字切词
  for (const m of text.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 2) terms.add(m[0]);
  }

  // 中文：连续汉字串，逐个取二元字符（单个汉字也保留，否则单字查询会命中不了）
  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2));
  }

  return [...terms].sort(compareStrings);
}

/**
 * 构造一个自包含的检索请求。
 *
 * ## 为什么「继续上次」这类 query 会自然失败
 *
 * query 取自**用户这一轮说的话**，不依赖当前对话上下文。所以「继续上次」归一化后只有
 * 「继续」「续上」这类无信息词项，在语料里几乎不可能命中——它返回空结果是**正确行为**，
 * 不需要靠提示词去约束模型「要写自包含的 query」（设计 §4.8 的触发与注入边界）。
 */
export function normalizeRecallQuery(
  raw: string,
  opts: { userScope: string; limit: number; now: Date; queryId?: string },
): RecallQuery {
  const text = (raw ?? '').trim();
  if (text === '') throw new RecallQueryError('检索文本不能为空');

  const limit = opts.limit;
  if (!Number.isInteger(limit) || limit < RECALL_LIMIT_MIN || limit > RECALL_LIMIT_MAX) {
    throw new RecallQueryError(
      `limit 必须是 ${RECALL_LIMIT_MIN}–${RECALL_LIMIT_MAX} 之间的整数，收到 ${String(limit)}`,
    );
  }

  const normalizedText = normalizeRecallText(text);
  const terms = tokenizeRecall(normalizedText);
  if (terms.length === 0) {
    // 只有标点 / 只有单字以外的不可检索内容：**明确拒绝**，不退化成全量召回
    throw new RecallQueryError('检索文本没有任何可检索的词项（只有标点或空白？）');
  }

  return {
    queryId: opts.queryId ?? `q_${hashContent(`${normalizedText}\u0000${opts.now.getTime()}`)}`,
    text,
    normalizedText,
    terms,
    userScope: opts.userScope,
    limit,
    issuedAt: opts.now.toISOString(),
  };
}

/** 一条记录的可检索词项（与 query 用同一套切词，否则重合判据不成立） */
function searchableTermsOf(record: StoredMemory): string[] {
  const haystack = `${record.content}\n${record.summary}\n${record.source.title}`;
  return tokenizeRecall(normalizeRecallText(haystack));
}

/**
 * 构造候选：**只保留存在词项重合**的记录。
 *
 * 两件事刻意分开统计：`searchedRecords`（检查了多少条）与 `candidateRecords`
 * （其中多少条进入评分）。分开之后，「没有结果」才诊断得出是**语料为空**、
 * **没有词项重合**，还是**后续 top-k 截断**——合成一个数字就全糊在一起了。
 *
 * 逐条重新校验 `userScope`：路径隔离负责正常路由，这一层负责发现「记录被放错了分区」。
 * 跨用户的记忆泄漏比「搜不到」严重得多。
 */
export function buildRecallCandidates(
  records: readonly StoredMemory[],
  query: RecallQuery,
): { candidates: RecallCandidate[]; searchedRecords: number } {
  const queryTerms = new Set(query.terms);
  const candidates: RecallCandidate[] = [];
  let searched = 0;

  for (const record of records ?? []) {
    if (!record || record.kind !== 'conversation') continue;
    if (record.userScope !== query.userScope) continue;
    searched += 1;

    const searchable = searchableTermsOf(record);
    const matched = searchable.filter((t) => queryTerms.has(t));
    if (matched.length === 0) continue;

    candidates.push({
      queryId: query.queryId,
      record,
      searchableTerms: searchable,
      matchedTerms: matched.sort(compareStrings),
      capturedAt: parseInstant(record.source.capturedAt),
    });
  }

  return { candidates, searchedRecords: searched };
}

/** 解析时刻；不可解析时返回 epoch（排序时最旧，不会因为坏数据把某条顶上来） */
function parseInstant(value: string): Date {
  const ms = Date.parse(value ?? '');
  return new Date(Number.isFinite(ms) ? ms : 0);
}

/**
 * 评分：`total = lexical 权重 × 覆盖率 + recency 权重 × 新鲜度`。
 *
 * 这个公式不是对生产检索的描述，而是**一个透明的离线基线**：读者能直接解释一条记录
 * 为什么命中、为什么排在另一条之前。将来换成 embedding / reranker 时，只要仍返回
 * 同一个 `RecallScoreBreakdown`，上层（工具结果、Prompt 装配）不需要改。
 */
export function scoreRecallCandidate(
  candidate: RecallCandidate,
  query: RecallQuery,
  now: Date,
  options: RecallOptions = DEFAULT_RECALL_OPTIONS,
): RecallScoreBreakdown {
  const queryTermCount = query.terms.length;
  const lexicalCoverage =
    queryTermCount === 0 ? 0 : candidate.matchedTerms.length / queryTermCount;

  const ageDays = Math.max(0, (now.getTime() - candidate.capturedAt.getTime()) / 86_400_000);
  const window = Math.max(1, options.recencyWindowDays);
  const recency = Math.max(0, 1 - ageDays / window);

  const lexicalContribution = options.weights.lexical * lexicalCoverage;
  const recencyContribution = options.weights.recency * recency;

  return {
    matchedTerms: [...candidate.matchedTerms],
    queryTermCount,
    lexicalCoverage,
    recency,
    weights: { ...options.weights },
    contributions: { lexical: lexicalContribution, recency: recencyContribution },
    total: lexicalContribution + recencyContribution,
  };
}

/**
 * 稳定排序。
 *
 * 排序键显式固定为 `total DESC → lexicalCoverage DESC → capturedAt DESC → memoryId ASC`。
 * 最后那个 **memoryId 是必须的**：没有它，两条分数完全相同的记录的先后会取决于它们在
 * 数组里的位置，也就是取决于**存储的插入顺序**——同一份数据换台机器就可能换个排名。
 */
export function stableRankRecallCandidates(
  candidates: readonly RecallCandidate[],
  query: RecallQuery,
  now: Date,
  options: RecallOptions = DEFAULT_RECALL_OPTIONS,
): Array<{ candidate: RecallCandidate; breakdown: RecallScoreBreakdown }> {
  const scored = candidates.map((candidate) => ({
    candidate,
    breakdown: scoreRecallCandidate(candidate, query, now, options),
  }));

  scored.sort((a, b) => {
    const dt = b.breakdown.total - a.breakdown.total;
    if (dt !== 0) return dt;
    const dc = b.breakdown.lexicalCoverage - a.breakdown.lexicalCoverage;
    if (dc !== 0) return dc;
    const dtime = b.candidate.capturedAt.getTime() - a.candidate.capturedAt.getTime();
    if (dtime !== 0) return dtime;
    return compareStrings(a.candidate.record.memoryId, b.candidate.record.memoryId);
  });

  return scored;
}

/** 摘要片段：把换行压平并限长（注入块是 XML，片段里不能有裸换行） */
export function snippetOf(record: StoredMemory, maxChars = 160): string {
  const text = `${record.summary || record.content}`.replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * 完整召回：五阶段串起来，返回**只读**结果。
 *
 * 无结果时返回带 `emptyReason` 的空结果，而不是抛错——「没找到」是一次正常的检索结论，
 * 调用方据此不注入任何东西（FR-M29：不为空 wrapper 消耗预算）。
 */
export function recall(
  rawQuery: string,
  records: readonly StoredMemory[],
  opts: { userScope: string; limit?: number; now: Date; options?: RecallOptions },
): RecallResult {
  const query = normalizeRecallQuery(rawQuery, {
    userScope: opts.userScope,
    limit: opts.limit ?? 5,
    now: opts.now,
  });
  const options = opts.options ?? DEFAULT_RECALL_OPTIONS;

  const { candidates, searchedRecords } = buildRecallCandidates(records, query);
  if (searchedRecords === 0) {
    return {
      query,
      hits: [],
      searchedRecords: 0,
      candidateRecords: 0,
      emptyReason: 'no_records',
    };
  }
  if (candidates.length === 0) {
    return {
      query,
      hits: [],
      searchedRecords,
      candidateRecords: 0,
      emptyReason: 'no_matching_terms',
    };
  }

  const ranked = stableRankRecallCandidates(candidates, query, opts.now, options);
  const hits: RecallHit[] = ranked.slice(0, query.limit).map((item, index) => ({
    queryId: query.queryId,
    memoryId: item.candidate.record.memoryId,
    rank: index + 1,
    snippet: snippetOf(item.candidate.record),
    scope: {
      userScope: item.candidate.record.userScope,
      memoryKind: item.candidate.record.kind,
    },
    provenance: item.candidate.record.source,
    scoreBreakdown: item.breakdown,
  }));

  return {
    query,
    hits,
    searchedRecords,
    candidateRecords: candidates.length,
    emptyReason: null,
  };
}

/**
 * 渲染成 `<recalled_context>` 块。
 *
 * 即使进了 prompt，每个 hit 仍保留 query / scope / provenance / score breakdown：
 * 模型看到的是「本轮召回候选」，而不是一段没有来源的事实。**无匹配时返回空串**。
 */
export function renderRecalledContext(result: RecallResult): string {
  if (!result || result.hits.length === 0) return '';
  const lines: string[] = [
    `<recalled_context query_id="${escapeAttr(result.query.queryId)}" ` +
      `normalized_query="${escapeAttr(result.query.normalizedText)}" ` +
      `user_scope="${escapeAttr(result.query.userScope)}">`,
  ];
  for (const hit of result.hits) {
    const b = hit.scoreBreakdown;
    lines.push(
      `  <hit rank="${hit.rank}" memory_id="${escapeAttr(hit.memoryId)}" ` +
        `memory_kind="${hit.scope.memoryKind}" ` +
        `source_id="${escapeAttr(hit.provenance.sourceId)}" ` +
        `source_type="${escapeAttr(hit.provenance.sourceType)}" ` +
        `title="${escapeAttr(hit.provenance.title)}" ` +
        `captured_at="${escapeAttr(hit.provenance.capturedAt)}">`,
    );
    lines.push(
      `    <score total="${b.total.toFixed(6)}" lexical_coverage="${b.lexicalCoverage.toFixed(6)}" ` +
        `recency="${b.recency.toFixed(6)}" lexical_contribution="${b.contributions.lexical.toFixed(6)}" ` +
        `recency_contribution="${b.contributions.recency.toFixed(6)}"/>`,
    );
    lines.push(`    <snippet>${escapeText(hit.snippet)}</snippet>`);
    lines.push('  </hit>');
  }
  lines.push('</recalled_context>');
  return lines.join('\n');
}

/** XML 属性转义（内容来自会话，可能含引号与尖括号） */
function escapeAttr(value: string): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** XML 文本转义 */
function escapeText(value: string): string {
  return (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export type { MemorySource };
