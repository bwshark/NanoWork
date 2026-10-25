"""向量存储：打包 / 读写 / 覆盖率统计（薄 SQL + 纯函数）。

## 本期边界（写在这里，免得被当成「已经能上规模」）

检索时是**把候选块的向量全取进内存再算余弦**：`O(候选数 × 维度)`，且没有 ANN 索引。
以知识库的规模（单库几百到几千块、维度 256）这样最省事也够快；到了需要十万级
块的量级，正确的做法是换 pgvector / HNSW，而不是在这里手写索引——
**这一步明确不做**，等有真实规模再谈。

过滤仍然发生在取候选之前（`kb_id IN (…)`），所以向量化不会放宽可见性：
向量只影响「怎么排序」，不影响「能不能看见」。
"""

from __future__ import annotations

from array import array

from sqlalchemy import func
from sqlmodel import Session, select

from app.kb.models import KbChunk, KbDocument, KbVector


def pack(vector: list[float]) -> bytes:
    """float32 小端打包。用 float32 而不是 float64：余弦对精度不敏感，
    体积减半（维度 1536 时 12KB → 6KB / 块）。"""
    return array("f", vector).tobytes()


def unpack(blob: bytes, dim: int) -> list[float]:
    """解包；长度与声明的维度不符时返回空列表（调用方按「没有向量」处理）。

    不抛异常：库里可能躺着上一版打包方式写下的行，为一个坏行把整次检索打挂
    不划算——少一条向量只是少一条候选，而 500 是整个知识库用不了。
    """
    if not blob or dim <= 0:
        return []
    values = array("f")
    try:
        values.frombytes(blob)
    except ValueError:
        return []
    if len(values) != dim:
        return []
    return list(values)


def save_vectors(
    session: Session,
    *,
    model: str,
    rows: list[tuple[str, str, str, list[float]]],
) -> int:
    """写入 / 覆盖一批向量，返回实际写入条数。

    `rows` 的每个元素是 `(chunk_id, kb_id, doc_id, vector)`。按 `(chunk_id, model)`
    做 upsert：重复入库同一文档时不会堆出多份。
    """
    written = 0
    for chunk_id, kb_id, doc_id, vector in rows:
        if not vector:
            continue
        existing = session.get(KbVector, (chunk_id, model))
        packed = pack(vector)
        if existing is None:
            session.add(
                KbVector(
                    chunk_id=chunk_id,
                    model=model,
                    kb_id=kb_id,
                    doc_id=doc_id,
                    dim=len(vector),
                    vector=packed,
                )
            )
        else:
            existing.kb_id = kb_id
            existing.doc_id = doc_id
            existing.dim = len(vector)
            existing.vector = packed
            session.add(existing)
        written += 1
    return written


def load_vectors(
    session: Session,
    *,
    kb_ids: list[str],
    model: str,
    dim: int,
) -> dict[str, list[float]]:
    """取这些**库**里全部块的向量（只取当前模型的）。

    为什么按 `kb_id` 而不是按 `chunk_id` 列表取：候选块可能成千上万，
    `chunk_id IN (…)` 会撞 SQLite 的变量数上限（老版本 999），并把一条 SQL 撑到
    几十 KB；而库的数量是个位数。候选集本来就等于「可见库里的全部块」，
    按库取不会多取任何东西。

    `dim` 不匹配的行直接跳过：模型换了维度（或上一版代码写了别的长度）时，
    混着算余弦会得到「长度不符 → 0 分」之外更糟的结果——错位的点积是**看似有分**的噪声。
    """
    if not kb_ids:
        return {}
    rows = session.exec(
        select(KbVector).where(KbVector.model == model, KbVector.kb_id.in_(kb_ids))
    ).all()
    out: dict[str, list[float]] = {}
    for row in rows:
        if row.dim != dim:
            continue
        vector = unpack(row.vector, row.dim)
        if vector:
            out[row.chunk_id] = vector
    return out


def delete_vectors_for_doc(session: Session, *, doc_id: str) -> int:
    """删掉一篇文档的全部向量（**所有模型**）。

    不按模型删：文档没了，它在任何模型下的向量都是垃圾。留着只会在
    「换过 embedder」的库里悄悄占空间，并让覆盖率统计看起来比真实的多。
    """
    rows = session.exec(select(KbVector).where(KbVector.doc_id == doc_id)).all()
    for row in rows:
        session.delete(row)
    return len(rows)


def count_vectors_by_doc(session: Session, *, kb_id: str, model: str) -> dict[str, int]:
    """每个文档已建好向量的块数（`doc_id → 条数`）。

    一次 `GROUP BY` 而不是逐篇查：文档列表一次就是几十上百篇，
    每篇一次往返会让「打开知识库」变成几十个串行请求。
    """
    if not model:
        return {}
    rows = session.exec(
        select(KbVector.doc_id, func.count())
        .where(KbVector.kb_id == kb_id, KbVector.model == model)
        .group_by(KbVector.doc_id)
    ).all()
    return {doc_id: int(count) for doc_id, count in rows}


def vector_coverage(session: Session, *, model: str, kb_id: str | None = None) -> tuple[int, int]:
    """返回 `(已建索引的块数, 总块数)`。`kb_id` 为空则是全库口径。

    两个数都从同一侧算：总块数取 `kb_chunks`，已索引取 `model` 匹配的 `kb_vectors`。
    差值是「有新文档没建索引」或「换了 embedder 但没重建」——两种情况都该提示重建，
    所以状态接口把它们合并成一个 `stale` 上报，不在这里猜原因。
    """
    # 两边都 join 文档并排除回收站：只排除一侧会让 `indexed > total`（回收站里的
    # 向量还在、块却没算进总数），那种覆盖率界面无法解释。
    chunk_query = (
        select(KbChunk)
        .join(KbDocument, KbChunk.doc_id == KbDocument.id)
        .where(KbDocument.deleted_at == "")
    )
    vector_query = (
        select(KbVector)
        .join(KbDocument, KbVector.doc_id == KbDocument.id)
        .where(KbVector.model == model, KbDocument.deleted_at == "")
    )
    if kb_id:
        chunk_query = chunk_query.where(KbChunk.kb_id == kb_id)
        vector_query = vector_query.where(KbVector.kb_id == kb_id)
    total = len(session.exec(chunk_query).all())
    indexed = len(session.exec(vector_query).all())
    return indexed, total
