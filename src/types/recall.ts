/**
 * 跨会话召回的**数据契约**（需求 FR-M25 – FR-M30；设计 §4.8）。
 *
 * ## 为什么召回要与「记忆」分成两套类型
 *
 * 一个常见错误是把「存过的所有记忆」与「本轮该进 prompt 的候选」都叫 memory。这样会
 * 掩盖三层关键边界：
 *
 * 1. **存储记录**必须长期存在，并能说明属于谁、来自哪里（`StoredMemory`）；
 * 2. **召回结果**只对某个 query 有意义——换一个 query，排名和结果都会变（`RecallHit`）；
 * 3. **检索命中 ≠ 事实正确 ≠ 必须进 prompt**。
 *
 * 所以 `StoredMemory` 与 `RecallHit` 是两件事：前者是 durable evidence，后者是针对一次
 * 检索的**投影**。召回不修改存储，也不会因为「读到了」就把某条记录写成新记忆。
 */

/** 一条被存储的记忆的来源（provenance） */
export interface MemorySource {
  /** 指向产生记录的原始对象（会话 id / 快照 id） */
  sourceId: string;
  /** 来源类型（`session_transcript` / `profile_snapshot` …） */
  sourceType: string;
  /** 人类可读的标题（会话标题） */
  title: string;
  /** **来源事件发生**的时刻（不是进入存储的时刻） */
  capturedAt: string;
}

/** 存储记录的类别：只有会话记录参与召回，profile 快照不参与 */
export type StoredMemoryKind = 'conversation' | 'profile_snapshot';

/** 远端 / 本地存储中的一条 durable 记录 */
export interface StoredMemory {
  memoryId: string;
  userScope: string;
  kind: StoredMemoryKind;
  content: string;
  summary: string;
  source: MemorySource;
  /** **进入存储**的时刻（≠ `source.capturedAt`，两者都要能回答） */
  storedAt: string;
}

/** 本轮检索请求 */
export interface RecallQuery {
  queryId: string;
  /** 可读原文 */
  text: string;
  /** 归一化文本（NFKC + casefold + 空白归一化） */
  normalizedText: string;
  /** 稳定排序的词项（英文按词、中文补二元字符） */
  terms: string[];
  userScope: string;
  limit: number;
  issuedAt: string;
}

/** 未评分候选：只表示「这条记录与 query 存在词项重合」 */
export interface RecallCandidate {
  queryId: string;
  record: StoredMemory;
  /** 该记录可检索的词项集合 */
  searchableTerms: string[];
  /** 与 query 重合的词项 */
  matchedTerms: string[];
  capturedAt: Date;
}

/** 可解释的评分拆解：`total` 不是孤立数字 */
export interface RecallScoreBreakdown {
  matchedTerms: string[];
  queryTermCount: number;
  /** 命中覆盖率 = matched / queryTermCount */
  lexicalCoverage: number;
  /** 新鲜度（0–1，越新越高） */
  recency: number;
  weights: { lexical: number; recency: number };
  contributions: { lexical: number; recency: number };
  total: number;
}

/** 召回作用域（写进 hit，让调用方能按作用域过滤 / 展示） */
export interface RecallScope {
  userScope: string;
  memoryKind: StoredMemoryKind;
}

/** 一条召回命中：**某条记录的检索投影**，不是新记忆 */
export interface RecallHit {
  queryId: string;
  memoryId: string;
  rank: number;
  snippet: string;
  scope: RecallScope;
  provenance: MemorySource;
  scoreBreakdown: RecallScoreBreakdown;
}

/** 召回只读结果 */
export interface RecallResult {
  query: RecallQuery;
  hits: RecallHit[];
  /** 检查了多少条记录 */
  searchedRecords: number;
  /** 其中多少条进入评分 */
  candidateRecords: number;
  /** 无结果的原因（有结果时为 null） */
  emptyReason: 'no_matching_terms' | 'no_records' | null;
}

/** 召回引擎的配置 */
export interface RecallOptions {
  /** 新鲜度归零的时间跨度（天）；越新越高，线性衰减 */
  recencyWindowDays: number;
  /** 词项权重与新鲜度权重（合计 1） */
  weights: { lexical: number; recency: number };
}
