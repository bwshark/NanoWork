/**
 * 跨会话召回（`src/lib/recall.ts`）。需求 FR-M25 – FR-M30。
 *
 * 按**五阶段契约**组织用例，每一阶段都能独立定位失败：
 *
 * 1. **normalize**：空白折叠 / NFKC / casefold，以及「只有标点就明确拒绝」；
 * 2. **candidate**：只造有词项重合的候选，并把「检查了多少条」与「多少条进评分」分开；
 * 3. **score**：`total` 必须带完整拆解（可解释），不是孤立数字；
 * 4. **stableRank**：并列时用显式 tie-breaker，**不依赖数组顺序**；
 * 5. **render**：保留 query / scope / provenance / 分数；无匹配返回空串。
 *
 * 另外三条边界：召回**只读**（不写任何东西）、**跨 userScope 拒绝**、
 * query 为空或只有标点一律拒绝（不退化成全量召回）。
 */

import { describe, expect, it } from 'vitest';
import type { StoredMemory } from '../src/types';
import {
  DEFAULT_RECALL_OPTIONS,
  RecallQueryError,
  buildRecallCandidates,
  normalizeRecallQuery,
  normalizeRecallText,
  recall,
  renderRecalledContext,
  scoreRecallCandidate,
  stableRankRecallCandidates,
  tokenizeRecall,
} from '../src/lib/recall';

const NOW = new Date('2026-10-02T00:00:00Z');
const SCOPE = 'u_test';

function record(over: Partial<StoredMemory> = {}): StoredMemory {
  return {
    memoryId: 'ev:s1:m1',
    userScope: SCOPE,
    kind: 'conversation',
    content: '我们把分层记忆拆成了 normalize / candidate / score 三个阶段',
    summary: '分层记忆的阶段拆分',
    source: {
      sourceId: 's1',
      sourceType: 'session_transcript',
      title: '分层记忆设计',
      capturedAt: '2026-09-01T00:00:00.000Z',
    },
    storedAt: '2026-09-02T00:00:00.000Z',
    ...over,
  };
}

describe('normalize：归一化与切词', () => {
  it('折叠空白 + NFKC + 小写', () => {
    expect(normalizeRecallText('  LAYERED   Memory  ')).toBe('layered memory');
    // 全角字符被 NFKC 收敛成半角
    expect(normalizeRecallText('ＡＢＣ１２３')).toBe('abc123');
  });

  it('英文按词切分（单字母丢弃，避免噪声词项）', () => {
    expect(tokenizeRecall('a layered memory design')).toEqual([
      'design',
      'layered',
      'memory',
    ]);
  });

  it('连续中文补**二元字符**（保留语序信息）', () => {
    const terms = tokenizeRecall('分层记忆');
    expect(terms).toContain('分层');
    expect(terms).toContain('层记');
    expect(terms).toContain('记忆');
  });

  it('单个汉字也保留（否则单字查询命中不了）', () => {
    expect(tokenizeRecall('猫')).toEqual(['猫']);
  });

  it('词项稳定排序（同一段文本两次切词结果一致）', () => {
    const a = tokenizeRecall('记忆 分层 layered');
    const b = tokenizeRecall('记忆 分层 layered');
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it('空白 query → 拒绝', () => {
    expect(() => normalizeRecallQuery('   ', { userScope: SCOPE, limit: 5, now: NOW })).toThrow(
      RecallQueryError,
    );
  });

  it('只有标点的 query → **明确拒绝**，不退化成全量召回', () => {
    expect(() =>
      normalizeRecallQuery('？！……', { userScope: SCOPE, limit: 5, now: NOW }),
    ).toThrow(/没有任何可检索的词项/);
  });

  it('limit 越界 → 拒绝（不静默用默认值）', () => {
    for (const limit of [0, 11, 1.5, -3]) {
      expect(() => normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit, now: NOW })).toThrow(
        /limit/,
      );
    }
  });

  it('合法的 query 带上可读原文、归一化文本、词项与作用域', () => {
    const q = normalizeRecallQuery('  分层 记忆  ', { userScope: SCOPE, limit: 3, now: NOW });
    expect(q.text).toBe('分层 记忆');
    expect(q.normalizedText).toBe('分层 记忆');
    expect(q.terms.length).toBeGreaterThan(0);
    expect(q.userScope).toBe(SCOPE);
    expect(q.limit).toBe(3);
    expect(q.issuedAt).toBe(NOW.toISOString());
    expect(q.queryId).toMatch(/^q_/);
  });
});

describe('candidate：只造有词项重合的候选', () => {
  it('只保留有重合的记录，并把「检查数」与「候选数」分开', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates, searchedRecords } = buildRecallCandidates(
      [
        record({ memoryId: 'a', content: '分层记忆的阶段拆分' }),
        // 这条的 content / summary / title 三处都与 query 无关。可检索词项**包含摘要与标题**，
        // 所以夹具必须把三处都设成无关，否则「无关」的记录会靠摘要命中
        // （那是真实行为：会话讲的是别的事，标题点题时也该被召回）。
        record({
          memoryId: 'b',
          content: '完全无关的一条：晚餐吃什么',
          summary: '晚餐安排',
          source: { ...record().source, title: '晚饭讨论' },
        }),
      ],
      q,
    );
    expect(searchedRecords).toBe(2);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].record.memoryId).toBe('a');
    expect(candidates[0].matchedTerms.length).toBeGreaterThan(0);
  });

  it('可检索词项包含**摘要与标题**（标题点题时也能被召回）', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates } = buildRecallCandidates(
      [record({ memoryId: 'byTitle', content: '三段式拆分', summary: '三段式拆分' })],
      q,
    );
    // 该记录的 title 是「分层记忆设计」，因此命中
    expect(candidates.map((c) => c.record.memoryId)).toEqual(['byTitle']);
  });

  it('非 conversation 记录不参与召回（profile 快照另有加载路径）', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates } = buildRecallCandidates(
      [record({ kind: 'profile_snapshot', content: '分层记忆' })],
      q,
    );
    expect(candidates).toHaveLength(0);
  });

  it('**跨 userScope 的记录被拒绝**（记忆泄漏比搜不到严重得多）', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates, searchedRecords } = buildRecallCandidates(
      [record({ userScope: 'u_other', content: '分层记忆' })],
      q,
    );
    expect(candidates).toHaveLength(0);
    // 被拒绝的记录不计入「检查过的条数」：它根本不属于这个作用域
    expect(searchedRecords).toBe(0);
  });

  it('候选阶段不产生 score / rank（保持阶段边界清晰）', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates } = buildRecallCandidates([record()], q);
    expect(candidates[0]).not.toHaveProperty('total');
    expect(candidates[0]).not.toHaveProperty('rank');
  });
});

describe('score：可解释的分数拆解', () => {
  it('total 不是孤立数字，而是两项贡献之和', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates } = buildRecallCandidates([record()], q);
    const b = scoreRecallCandidate(candidates[0], q, NOW);
    expect(b.total).toBeCloseTo(b.contributions.lexical + b.contributions.recency, 10);
    expect(b.weights.lexical + b.weights.recency).toBeCloseTo(1, 10);
    expect(b.matchedTerms.length).toBeGreaterThan(0);
    expect(b.queryTermCount).toBe(q.terms.length);
  });

  it('覆盖率 = 命中词项 / query 词项', () => {
    const q = normalizeRecallQuery('分层记忆 完全无关的词', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates } = buildRecallCandidates([record()], q);
    const b = scoreRecallCandidate(candidates[0], q, NOW);
    expect(b.lexicalCoverage).toBeCloseTo(b.matchedTerms.length / q.terms.length, 10);
    expect(b.lexicalCoverage).toBeLessThan(1);
  });

  it('新鲜度随时间线性衰减到 0，且不出现负值', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const fresh = buildRecallCandidates(
      [record({ source: { ...record().source, capturedAt: NOW.toISOString() } })],
      q,
    ).candidates;
    expect(scoreRecallCandidate(fresh[0], q, NOW).recency).toBeCloseTo(1, 6);

    const ancient = buildRecallCandidates(
      [record({ source: { ...record().source, capturedAt: '2000-01-01T00:00:00.000Z' } })],
      q,
    ).candidates;
    expect(scoreRecallCandidate(ancient[0], q, NOW).recency).toBe(0);
  });

  it('时间戳坏了按最旧算（不会因为坏数据把某条顶到最前）', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const { candidates } = buildRecallCandidates(
      [record({ source: { ...record().source, capturedAt: 'not-a-date' } })],
      q,
    );
    expect(candidates[0].capturedAt.getTime()).toBe(0);
    expect(scoreRecallCandidate(candidates[0], q, NOW).recency).toBe(0);
  });
});

describe('stableRank：并列时的顺序不依赖数组位置', () => {
  it('覆盖率高的排前面', () => {
    const q = normalizeRecallQuery('分层记忆 阶段', { userScope: SCOPE, limit: 5, now: NOW });
    const full = record({ memoryId: 'full', content: '分层记忆 阶段' });
    const partial = record({ memoryId: 'partial', content: '分层记忆' });
    const { candidates } = buildRecallCandidates([partial, full], q);
    const ranked = stableRankRecallCandidates(candidates, q, NOW);
    expect(ranked[0].candidate.record.memoryId).toBe('full');
  });

  it('**完全并列时按 memoryId 升序**：交换输入顺序结果不变', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const a = record({ memoryId: 'aaa', content: '分层记忆', source: { ...record().source, capturedAt: '2026-09-01T00:00:00.000Z' } });
    const b = record({ memoryId: 'bbb', content: '分层记忆', source: { ...record().source, capturedAt: '2026-09-01T00:00:00.000Z' } });

    const forward = stableRankRecallCandidates(
      buildRecallCandidates([a, b], q).candidates,
      q,
      NOW,
    );
    const reversed = stableRankRecallCandidates(
      buildRecallCandidates([b, a], q).candidates,
      q,
      NOW,
    );
    expect(forward.map((r) => r.candidate.record.memoryId)).toEqual(['aaa', 'bbb']);
    expect(reversed.map((r) => r.candidate.record.memoryId)).toEqual(['aaa', 'bbb']);
  });

  it('同分同覆盖率时时间新的排前面', () => {
    const q = normalizeRecallQuery('分层记忆', { userScope: SCOPE, limit: 5, now: NOW });
    const old = record({ memoryId: 'old', content: '分层记忆', source: { ...record().source, capturedAt: '2026-01-01T00:00:00.000Z' } });
    const recent = record({ memoryId: 'new', content: '分层记忆', source: { ...record().source, capturedAt: '2026-09-30T00:00:00.000Z' } });
    const ranked = stableRankRecallCandidates(
      buildRecallCandidates([old, recent], q).candidates,
      q,
      NOW,
    );
    expect(ranked[0].candidate.record.memoryId).toBe('new');
  });
});

describe('recall：五阶段整体与边界', () => {
  it('返回结构化结果，hit 带 scope / provenance / 拆解', () => {
    const result = recall('分层记忆', [record()], { userScope: SCOPE, limit: 5, now: NOW });
    expect(result.emptyReason).toBeNull();
    expect(result.searchedRecords).toBe(1);
    expect(result.candidateRecords).toBe(1);
    expect(result.hits).toHaveLength(1);

    const hit = result.hits[0];
    expect(hit.rank).toBe(1);
    expect(hit.queryId).toBe(result.query.queryId);
    expect(hit.scope).toEqual({ userScope: SCOPE, memoryKind: 'conversation' });
    expect(hit.provenance.sourceId).toBe('s1');
    expect(hit.provenance.capturedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(hit.scoreBreakdown.total).toBeGreaterThan(0);
  });

  it('limit 生效（返回条数不超过 limit）', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      record({ memoryId: `m${i}`, content: '分层记忆' }),
    );
    const result = recall('分层记忆', records, { userScope: SCOPE, limit: 2, now: NOW });
    expect(result.hits).toHaveLength(2);
    expect(result.candidateRecords).toBe(5);
  });

  it('语料为空 → emptyReason=no_records', () => {
    const result = recall('分层记忆', [], { userScope: SCOPE, limit: 5, now: NOW });
    expect(result.hits).toEqual([]);
    expect(result.emptyReason).toBe('no_records');
  });

  it('有语料但没有词项重合 → emptyReason=no_matching_terms（与「语料为空」区分开）', () => {
    const result = recall('量子纠缠', [record({ content: '晚餐吃什么' })], {
      userScope: SCOPE,
      limit: 5,
      now: NOW,
    });
    expect(result.hits).toEqual([]);
    expect(result.searchedRecords).toBe(1);
    expect(result.candidateRecords).toBe(0);
    expect(result.emptyReason).toBe('no_matching_terms');
  });

  it('「继续上次」这类依赖上下文的表述**自然搜不到**（不需要靠提示词约束）', () => {
    const result = recall('继续上次那个', [record()], { userScope: SCOPE, limit: 5, now: NOW });
    expect(result.hits).toEqual([]);
    expect(result.emptyReason).toBe('no_matching_terms');
  });

  it('召回是**只读**的：语料数组与记录对象都不被改动', () => {
    const input = [record()];
    const snapshot = JSON.stringify(input);
    recall('分层记忆', input, { userScope: SCOPE, limit: 5, now: NOW });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('同一份输入两次召回结果完全一致（确定性）', () => {
    const input = [record({ memoryId: 'a' }), record({ memoryId: 'b' })];
    const a = recall('分层记忆', input, { userScope: SCOPE, limit: 5, now: NOW });
    const b = recall('分层记忆', input, { userScope: SCOPE, limit: 5, now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('render：注入块保留来源与分数', () => {
  it('渲染出 query / scope / provenance / 拆解，并包含片段', () => {
    const result = recall('分层记忆', [record()], { userScope: SCOPE, limit: 5, now: NOW });
    const xml = renderRecalledContext(result);
    expect(xml).toContain('<recalled_context');
    expect(xml).toContain(`query_id="${result.query.queryId}"`);
    expect(xml).toContain('normalized_query="分层记忆"');
    expect(xml).toContain('memory_kind="conversation"');
    expect(xml).toContain('source_id="s1"');
    expect(xml).toContain('<score total=');
    expect(xml).toContain('<snippet>');
    expect(xml).toContain('</recalled_context>');
  });

  it('无匹配时返回**空串**（不为空 wrapper 消耗 prompt 预算）', () => {
    const result = recall('量子纠缠', [record({ content: '晚餐' })], {
      userScope: SCOPE,
      limit: 5,
      now: NOW,
    });
    expect(renderRecalledContext(result)).toBe('');
  });

  it('片段与标题里的尖引号被转义（不能让会话内容破坏 XML）', () => {
    const nasty = record({
      content: '含 <tag> 与 "引号"',
      summary: '含 <tag>',
      source: { ...record().source, title: '标题"带引号"' },
    });
    const xml = renderRecalledContext(
      recall('含', [nasty], { userScope: SCOPE, limit: 5, now: NOW }),
    );
    expect(xml).not.toContain('<tag>');
    expect(xml).toContain('&lt;tag&gt;');
    expect(xml).toContain('&quot;');
  });
});

describe('默认参数', () => {
  it('权重合计为 1，新鲜度窗口为正', () => {
    expect(DEFAULT_RECALL_OPTIONS.weights.lexical + DEFAULT_RECALL_OPTIONS.weights.recency).toBeCloseTo(1, 10);
    expect(DEFAULT_RECALL_OPTIONS.recencyWindowDays).toBeGreaterThan(0);
  });
});

describe('命中数不超过 limit 与候选数的较小者', () => {
  it('候选少于 limit 时不补空', () => {
    const result = recall('分层记忆', [record()], { userScope: SCOPE, limit: 10, now: NOW });
    expect(result.hits).toHaveLength(1);
  });
});
