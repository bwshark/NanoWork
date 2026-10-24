"""检索打分：纯函数，**只对已过滤的候选块打分**。

## 为什么是词法而不是向量（本期的边界，写在这里也写进 FR 行）

PRD 的 FR-4.7 写的是「解析 → 向量检索」。本期先做**词法检索**，理由有两条：

1. 向量检索需要 embedding 模型与向量库（或带向量扩展的库）。当前部署形态是
   SQLite + 单进程 FastAPI，引入这两者会把「M7 第一块」变成一次基础设施改造。
2. 更关键的是：**权限预过滤与排序是两件事**。PRD 反复强调「检索前过滤而非检索后」，
   这条不变量与「用什么打分」无关——先把过滤做对、用最简单的打分验证语义，
   之后再换 embedder 只是替换 `score_chunk`，过滤那层不动。

`rank_chunks` 的对外形状刻意只依赖 `(text, payload)`，将来换成向量打分时
接口不变（调用方不需要知道自己拿的是词法分还是余弦分）。
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

#: 拉丁词/数字：连续字母数字算一个词；长度 < 2 的丢弃（"a"、"的" 之外全是噪声）
_LATIN_TOKEN = re.compile(r"[a-z0-9_]+")
#: CJK 连续段：中文没有空格，按**相邻双字**切（bigram）是无需分词器的折中
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")

_CJK_BIGRAM_MIN = 2


def tokenize(text: str) -> list[str]:
    """把文本切成检索词：拉丁词 + 中文双字。"""
    lowered = text.lower()
    tokens: list[str] = [token for token in _LATIN_TOKEN.findall(lowered) if len(token) >= 2]
    for run in _CJK_RUN.findall(lowered):
        if len(run) <= _CJK_BIGRAM_MIN:
            tokens.append(run)
            continue
        tokens.extend(run[index : index + 2] for index in range(len(run) - 1))
    return tokens


@dataclass(frozen=True)
class ScoredChunk:
    """一条候选块的打分结果（`payload` 原样带回给调用方）。"""

    index: int
    score: float


def score_chunk(query_tokens: list[str], text: str) -> float:
    """词频打分 + 长度归一。

    长度归一是必要的：不除长度的话，最长的块几乎总能命中最多的词，检索退化成
    「返回最长的三段」。用 `sqrt(len)` 而不是 `len`，是因为长块里命中多次确实更有信息量，
    只是不该线性放大。
    """
    if not query_tokens:
        return 0.0
    lowered = text.lower()
    hits = 0
    for token in set(query_tokens):
        hits += lowered.count(token)
    if hits == 0:
        return 0.0
    return hits / (len(lowered) ** 0.5 or 1.0)


def rank_chunks(
    chunks: list[str],
    query: str,
    *,
    top_k: int = 8,
) -> list[ScoredChunk]:
    """对候选块排序（分数降序，同分按原始顺序，保证结果稳定）。"""
    query_tokens = tokenize(query)
    scored = [
        ScoredChunk(index=index, score=score_chunk(query_tokens, text))
        for index, text in enumerate(chunks)
    ]
    hits = [item for item in scored if item.score > 0]
    # `-score` 与 `index` 一起排：Python 的 sort 是稳定的，但显式带上 index
    # 才不会依赖「输入顺序恰好就是这样」。
    hits.sort(key=lambda item: (-item.score, item.index))
    return hits[: max(0, top_k)]


# —— 向量检索（FR-4.7，2026-10-24）——
#
# 与上面的词法`rank_chunks` 并列，**不替换**它：词法始终是兜底（没有 embedder、
# 向量还没建、或云端向量服务挂了，检索必须还能用）。两者的输出形状刻意一致
# （`ScoredChunk.index` 都是「候选列表里的下标」），所以调用方只在一处决定用哪个。


def rank_by_vectors(
    query_vector: Sequence[float],
    chunk_ids: list[str],
    vectors: dict[str, list[float]],
    *,
    top_k: int = 8,
) -> list[ScoredChunk]:
    """余弦排序。**没有向量的块不参与**（不是按 0 分参与）。

    这个区别很实际：新入库但还没建索引的块、换了 embedder 之后没重建的块，
    如果按 0 分参与排序，它们会在「所有分数都很低」的查询里挤掉真正的命中
    ——用户看到的是「刚传的文档搜不到旧文档也变差了」。
    """
    # 函数内导入：`embedding` 反过来 import 本模块的 `tokenize`，模块级导入会成环
    from app.kb.embedding import cosine

    scored: list[ScoredChunk] = []
    for index, chunk_id in enumerate(chunk_ids):
        vector = vectors.get(chunk_id)
        if not vector:
            continue
        score = cosine(query_vector, vector)
        if score > 0:
            scored.append(ScoredChunk(index=index, score=score))
    scored.sort(key=lambda item: (-item.score, item.index))
    return scored[: max(0, top_k)]


def hybrid_rank(
    lexical: list[ScoredChunk],
    semantic: list[ScoredChunk],
    *,
    top_k: int = 8,
    rrf_k: int = 60,
) -> list[ScoredChunk]:
    """RRF（Reciprocal Rank Fusion）合并两路结果。

    为什么用 RRF 而不是「加权求和」：两份分数**不同量纲**（词法是「词频/√长度」，
    余弦是 [-1,1]），加权需要按语料调参，调出来的权重换个库就不成立。RRF 只用
    名次（`1/(k+rank)`），没有可调量，也不会被某一路的离群高分带偏。

    `rrf_k=60` 是原论文的经验值：它把「第 1 名与第 2 名」的差距压得比原始分小，
    因此**两路都排前面的**结果稳定胜出，而不是一路的第一名通吃。

    只在一路出现的块仍然保留（这正是混合检索的价值：词法抓精确词、向量抓近似表达），
    只是分数天然低一档。
    """
    scores: dict[int, float] = {}
    for ranked in (lexical, semantic):
        for rank, item in enumerate(ranked, start=1):
            scores[item.index] = scores.get(item.index, 0.0) + 1.0 / (rrf_k + rank)
    merged = [ScoredChunk(index=index, score=score) for index, score in scores.items()]
    merged.sort(key=lambda item: (-item.score, item.index))
    return merged[: max(0, top_k)]
