"""向量检索（FR-4.7，2026-10-24）。

这一组的重点是**三条不变量**，而不是「能搜到」：

1. **可见性不因向量化而放宽**：候选集仍然先按角色/绑定收窄，向量只决定顺序。
   历史教训是「换个打分方式顺手把过滤挪到后面」，那在单机上看起来全对。
2. **默认关 = 排序一点没变**：`NANOWORK_KB_EMBEDDER` 不设时，检索结果必须与
   纯词法逐条一致（升级不该悄悄改变用户看到的东西）。
3. **索引缺失不是错误**：没建索引的块按「不参与向量排序」处理，而不是按 0 分参与
   ——后者会让新文档挤掉真命中；同时状态接口必须能说出「还有多少块没索引」。
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.db import engine
from app.kb.embedding import (
    EmbeddingError,
    HashingEmbedder,
    OpenAICompatEmbedder,
    cosine,
    resolve_embedder,
)
from app.kb.models import KbVector
from app.kb.retrieval import ScoredChunk, hybrid_rank, rank_by_vectors, rank_chunks
from app.kb.vectors import pack, save_vectors, unpack, vector_coverage
from tests.conftest import auth_headers, register

KEYWORD = "报销流程"


# —— 夹具（与 test_kb.py 同形，但不跨模块 import，避免两组用例互相牵连）——


def _org(client: TestClient) -> tuple[str, str, str]:
    """返回 (owner token, member token, org_id)。"""
    owner = register(client, "owner@vec.example")
    member = register(client, "staff@vec.example")
    org = client.post(
        "/api/orgs", json={"name": "Vec Corp"}, headers=auth_headers(owner["access"])
    ).json()
    client.post(
        f"/api/orgs/{org['id']}/members",
        json={"email": "staff@vec.example", "role": "member"},
        headers=auth_headers(owner["access"]),
    )
    return owner["access"], member["access"], org["id"]


def _kb(client: TestClient, token: str, org_id: str, name: str, roles=None) -> dict:
    body: dict = {"name": name}
    if roles is not None:
        body["allowedRoles"] = roles
    resp = client.post(f"/api/orgs/{org_id}/kbs", json=body, headers=auth_headers(token))
    assert resp.status_code == 201, resp.text
    return resp.json()


def _doc(client: TestClient, token: str, kb_id: str, title: str, content: str) -> dict:
    resp = client.post(
        f"/api/kbs/{kb_id}/documents",
        json={"title": title, "content": content},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _search(client: TestClient, token: str, org_id: str, query: str, **extra):
    return client.post(
        f"/api/orgs/{org_id}/search", json={"query": query, **extra}, headers=auth_headers(token)
    )


def _status(client: TestClient, token: str, kb_id: str | None = None) -> dict:
    url = "/api/kb/retrieval" + (f"?kbId={kb_id}" if kb_id else "")
    resp = client.get(url, headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


class FakeEmbedder:
    """把小词表映射到二维向量：让「语义命中」这件事可以被断言。

    `报销` / `费用核销` 落在同一个方向、字面完全不重合 —— 这正是词法检索做不到、
    而向量检索该做到的场景。用它来证明 `mode == 'vector'` 那条分支真的被执行过。
    """

    name = "stub:2"
    dim = 2

    def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for text in texts:
            if any(word in text for word in ("报销", "核销", "费用", "发票")):
                out.append([1.0, 0.0])
            elif "旅行" in text:
                out.append([0.0, 1.0])
            else:
                out.append([0.0, 0.0])
        return out


# —— 纯函数：embedding ——


def test_hashing_embedder_is_deterministic_and_normalized() -> None:
    embedder = HashingEmbedder(dim=64)
    first = embedder.embed(["报销流程：走财务邮箱"])[0]
    second = embedder.embed(["报销流程：走财务邮箱"])[0]

    # 确定性是这条链路的地基：不稳定就意味着「重启后旧向量全部失效，
    # 而检索不会报错，只会悄悄变差」
    assert first == second
    assert len(first) == 64
    norm = sum(value * value for value in first) ** 0.5
    assert abs(norm - 1.0) < 1e-6


def test_hashing_embedder_separates_related_and_unrelated_text() -> None:
    embedder = HashingEmbedder(dim=256)
    query, related, unrelated = embedder.embed(
        ["报销流程", "报销流程：走财务邮箱", "牧场牛只的饲喂记录"]
    )
    assert cosine(query, related) > cosine(query, unrelated)
    assert embedder.name == "hash:256"


def test_cosine_handles_degenerate_inputs() -> None:
    assert cosine([1.0, 0.0], [1.0, 0.0]) == 1.0
    assert cosine([1.0, 0.0], [0.0, 1.0]) == 0.0
    # 空文本会得到零向量：返回 0 而不是除零
    assert cosine([0.0, 0.0], [1.0, 0.0]) == 0.0
    # 维度不一致：宁可判 0，也不要错位点积那种「看似有分」的噪声
    assert cosine([1.0, 0.0], [1.0, 0.0, 0.0]) == 0.0


def test_resolve_embedder_reads_env(monkeypatch) -> None:
    monkeypatch.delenv("NANOWORK_KB_EMBEDDER", raising=False)
    assert resolve_embedder().embedder is None  # 默认 off：不偷偷改排序

    monkeypatch.setenv("NANOWORK_KB_EMBEDDER", "hash")
    monkeypatch.setenv("NANOWORK_KB_EMBED_DIM", "32")
    hash_resolution = resolve_embedder()
    assert hash_resolution.kind == "hash"
    assert hash_resolution.embedder is not None
    assert hash_resolution.embedder.dim == 32

    monkeypatch.setenv("NANOWORK_KB_EMBED_DIM", "abc")
    assert resolve_embedder().embedder is None
    assert "维度" in resolve_embedder().error

    # 选了 openai 却没给地址：**降级为词法并在状态里报错**，而不是让整站 500
    monkeypatch.setenv("NANOWORK_KB_EMBEDDER", "openai")
    monkeypatch.delenv("NANOWORK_KB_EMBED_BASE_URL", raising=False)
    monkeypatch.delenv("NANOWORK_KB_EMBED_MODEL", raising=False)
    broken = resolve_embedder()
    assert broken.embedder is None
    assert "NANOWORK_KB_EMBED_BASE_URL" in broken.error

    monkeypatch.setenv("NANOWORK_KB_EMBEDDER", "no-such-thing")
    assert resolve_embedder().embedder is None


def test_openai_embedder_sorts_by_index_and_batches() -> None:
    calls: list[tuple[str, dict, dict]] = []

    def transport(url: str, payload: dict, headers: dict) -> dict:
        calls.append((url, payload, headers))
        # 故意**逆序**返回：真实兼容实现不保证顺序，错位会让「A 的正文配 B 的向量」
        return {
            "data": [
                {"index": 1, "embedding": [0.0, 2.0]},
                {"index": 0, "embedding": [3.0, 0.0]},
            ]
        }

    embedder = OpenAICompatEmbedder(
        base_url="https://example.com/v1/",
        model="text-embedding-x",
        api_key="k",
        batch_size=2,
        transport=transport,
    )
    vectors = embedder.embed(["甲", "乙"])

    assert calls[0][0] == "https://example.com/v1/embeddings"
    assert calls[0][1] == {"model": "text-embedding-x", "input": ["甲", "乙"]}
    assert calls[0][2] == {"Authorization": "Bearer k"}
    # 按 index 归位 + 归一化
    assert vectors[0] == [1.0, 0.0]
    assert vectors[1] == [0.0, 1.0]
    assert embedder.name == "openai:text-embedding-x"


def test_openai_embedder_rejects_bad_shape() -> None:
    def short_transport(url: str, payload: dict, headers: dict) -> dict:
        return {"data": [{"index": 0, "embedding": [1.0, 0.0]}]}

    embedder = OpenAICompatEmbedder(
        base_url="https://example.com/v1", model="m", batch_size=4, transport=short_transport
    )
    try:
        embedder.embed(["甲", "乙"])
    except EmbeddingError as error:
        assert "条数不符" in str(error)
    else:  # pragma: no cover - 失败时才有意义
        raise AssertionError("条数不符必须报错，否则正文与向量会错位")


# —— 纯函数：排序 ——


def test_rank_by_vectors_skips_chunks_without_vectors() -> None:
    ranked = rank_by_vectors(
        [1.0, 0.0],
        ["c1", "c2", "c3"],
        {"c1": [0.0, 1.0], "c2": [1.0, 0.0]},  # c3 没有向量
        top_k=5,
    )
    # c2 与查询同向 → 1.0 排第一；c1 正交（余弦 0）与词法一样不进入结果；
    # c3 没有向量，**不参与**（按 0 分参与会在低分查询里挤掉真命中）
    assert [item.index for item in ranked] == [1]


def test_hybrid_rank_prefers_items_good_in_both_lists() -> None:
    lexical = [ScoredChunk(index=0, score=9.0), ScoredChunk(index=1, score=8.0)]
    semantic = [ScoredChunk(index=1, score=0.99), ScoredChunk(index=2, score=0.5)]

    merged = hybrid_rank(lexical, semantic, top_k=3)
    # 两路都排在前面的 index=1 胜过「词法第一但向量没命中」的 index=0
    assert [item.index for item in merged] == [1, 0, 2]
    # RRF 分数与原始分数量纲无关：单路贡献 ≤ 1/(k+1)，两路都命中最多翻倍
    assert all(0 < item.score <= 2 / 61 for item in merged)


def test_hybrid_rank_truncates_to_top_k() -> None:
    lexical = [ScoredChunk(index=i, score=float(10 - i)) for i in range(5)]
    semantic = [ScoredChunk(index=i, score=1.0 - i / 10) for i in range(5)]
    assert len(hybrid_rank(lexical, semantic, top_k=2)) == 2


# —— 存储 ——


def test_vector_pack_roundtrip_and_bad_length() -> None:
    vector = [0.5, -0.25, 1.0]
    blob = pack(vector)
    assert unpack(blob, 3)[:3] == vector
    # 长度与声明维度不符 → 空列表（按「没有向量」处理），不抛
    assert unpack(blob, 4) == []
    assert unpack(b"", 3) == []


def test_save_vectors_is_upsert_not_append() -> None:
    with Session(engine) as session:
        session.exec(select(KbVector))  # 触发建表/连接
        # 直接造一条最小前提（chunk 行不存在也行：这里只验向量表自身的 upsert 语义）
        rows = [("chunk-x", "kb-x", "doc-x", [1.0, 0.0])]
        save_vectors(session, model="m:2", rows=rows)
        save_vectors(session, model="m:2", rows=[("chunk-x", "kb-x", "doc-x", [0.0, 1.0])])
        session.commit()

        stored = session.exec(select(KbVector).where(KbVector.chunk_id == "chunk-x")).all()
        assert len(stored) == 1, "重复写同一块必须覆盖，而不是堆多行"
        assert unpack(stored[0].vector, 2) == [0.0, 1.0]


# —— 路由：默认关 ——


def test_embedder_off_keeps_lexical_behaviour(client: TestClient, monkeypatch) -> None:
    monkeypatch.delenv("NANOWORK_KB_EMBEDDER", raising=False)
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id, "制度")
    doc = _doc(client, owner, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")

    assert doc["embedded"] == 0
    status = _status(client, owner, kb["id"])
    assert status["mode"] == "lexical"
    assert status["embedder"] == "off"
    assert status["indexed"] == 0
    assert status["chunks"] == doc["chunkCount"]

    hits = _search(client, owner, org_id, KEYWORD).json()
    assert [hit["docTitle"] for hit in hits] == ["差旅"]


# —— 路由：打开 hash embedder ——


def test_ingest_builds_index_and_status_reports_it(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("NANOWORK_KB_EMBEDDER", "hash")
    monkeypatch.setenv("NANOWORK_KB_EMBED_DIM", "64")
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id, "制度")
    doc = _doc(client, owner, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")

    assert doc["embedded"] == doc["chunkCount"]
    status = _status(client, owner, kb["id"])
    assert status["mode"] == "hybrid"
    assert status["embedder"] == "hash"
    assert status["model"] == "hash:64"
    assert status["indexed"] == status["chunks"]
    assert status["stale"] is False

    hits = _search(client, owner, org_id, KEYWORD).json()
    assert [hit["docTitle"] for hit in hits] == ["差旅"]


def test_vectors_never_widen_visibility(client: TestClient, monkeypatch) -> None:
    """换打分方式不得动过滤：越权的库连候选都不该进（向量开着也一样）。"""
    monkeypatch.setenv("NANOWORK_KB_EMBEDDER", "hash")
    owner, member, org_id = _org(client)
    public_kb = _kb(client, owner, org_id, "公开")
    secret_kb = _kb(client, owner, org_id, "管理层", roles=["admin", "owner"])
    _doc(client, owner, public_kb["id"], "员工版", f"{KEYWORD}：走财务邮箱。")
    # 管理员版故意更"相关"（同一关键词重复多次），topK=1 才具鉴别力
    _doc(client, owner, secret_kb["id"], "管理层版", f"{KEYWORD} {KEYWORD} {KEYWORD}：特批。")

    hits = _search(client, member, org_id, KEYWORD, topK=1).json()
    assert [hit["docTitle"] for hit in hits] == ["员工版"]

    all_hits = _search(client, member, org_id, KEYWORD, topK=50).json()
    assert "管理层版" not in {hit["docTitle"] for hit in all_hits}


def test_reindex_backfills_docs_ingested_while_off(client: TestClient, monkeypatch) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id, "制度")
    monkeypatch.delenv("NANOWORK_KB_EMBEDDER", raising=False)
    doc = _doc(client, owner, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")
    assert doc["embedded"] == 0

    # 打开向量检索：老文档没索引 → 状态必须说「还有没建索引的」
    monkeypatch.setenv("NANOWORK_KB_EMBEDDER", "hash")
    status = _status(client, owner, kb["id"])
    assert status["indexed"] == 0
    assert status["stale"] is True

    resp = client.post(f"/api/kbs/{kb['id']}/reindex", headers=auth_headers(owner))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["indexed"] == body["total"] == doc["chunkCount"]
    assert body["error"] == ""

    assert _status(client, owner, kb["id"])["stale"] is False


def test_ingest_survives_embedding_failure(client: TestClient, monkeypatch) -> None:
    """向量服务挂了也必须能入库。

    文档存不进去 = 这个功能等于没有；索引失败只是「这篇暂时只能被词法搜到」。
    所以 `embedded` 要如实报 0，而不是让整个上传 500。
    """
    from app.kb import routes as kb_routes
    from app.kb.embedding import EmbedderResolution, EmbeddingError

    class BrokenEmbedder:
        name = "broken:1"
        dim = 1

        def embed(self, texts):
            raise EmbeddingError("云端向量服务 503")

    monkeypatch.setattr(
        kb_routes,
        "resolve_embedder",
        lambda: EmbedderResolution(kind="openai", embedder=BrokenEmbedder()),
    )
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id, "制度")
    doc = _doc(client, owner, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")

    assert doc["chunkCount"] >= 1
    assert doc["embedded"] == 0
    # 词法照常可搜：降级不是「这篇从此消失」
    hits = _search(client, owner, org_id, KEYWORD).json()
    assert [hit["docTitle"] for hit in hits] == ["差旅"]


def test_reindex_rejected_when_embedder_off(client: TestClient, monkeypatch) -> None:
    monkeypatch.delenv("NANOWORK_KB_EMBEDDER", raising=False)
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id, "制度")
    resp = client.post(f"/api/kbs/{kb['id']}/reindex", headers=auth_headers(owner))
    # 静默成功会让用户以为「点了就建好了」
    assert resp.status_code == 422


def test_semantic_hit_without_lexical_overlap(client: TestClient, monkeypatch) -> None:
    """词法零命中、向量命中 → 这条分支（`mode='vector'`）必须真的能走到。

    哈希 embedder 只认字面，构造不出「同义不同词」的例子；用桩 embedder 把小词表
    映射到二维空间，才能证明「向量那一路在词法为空时仍然生效」。
    """
    from app.kb import routes as kb_routes
    from app.kb.embedding import EmbedderResolution

    monkeypatch.setattr(
        kb_routes,
        "resolve_embedder",
        lambda: EmbedderResolution(kind="stub", embedder=FakeEmbedder()),
    )
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id, "制度")
    _doc(client, owner, kb["id"], "费用核销办法", "费用核销：走进项发票流程。")

    # 先用纯词法确认「报销」在这篇里确实零命中（否则用例没有鉴别力）
    assert rank_chunks(["费用核销：走进项发票流程。"], "报销") == []

    hits = _search(client, owner, org_id, "报销").json()
    assert [hit["docTitle"] for hit in hits] == ["费用核销办法"]
    assert hits[0]["score"] > 0


def test_status_requires_login(client: TestClient) -> None:
    # 状态里带部署信息（模型名），不给匿名调用者
    assert client.get("/api/kb/retrieval").status_code == 401


def test_vector_coverage_counts_only_current_model(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("NANOWORK_KB_EMBEDDER", "hash")
    monkeypatch.setenv("NANOWORK_KB_EMBED_DIM", "32")
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id, "制度")
    _doc(client, owner, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")

    with Session(engine) as session:
        indexed, total = vector_coverage(session, model="hash:32", kb_id=kb["id"])
        assert indexed == total > 0
        # 换个模型名 → 覆盖率归零（旧模型的向量不会被当成新模型的）
        assert vector_coverage(session, model="hash:999", kb_id=kb["id"]) == (0, total)
