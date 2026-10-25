"""回收站（2026-10-25）：软删 / 恢复 / 彻底删除 / 惰性清理。

## 为什么单独一组

软删把「删了」拆成了两件事：**看不见**（检索、列表）与**还在**（块与向量）。
这两件事必须同时成立才有意义，而它们各自都能单独写错：

- 只做「还在」不做「看不见」→ 删掉的资料照样被检索命中，而列表里没有它，
  用户完全无法解释搜索结果（也叫幽灵数据）；
- 只做「看不见」不做「还在」→ 恢复等于重新解析一遍，索引还得重建，那就不叫回收站。

另外两条容易被忽略：**判重会遇到回收站里的同内容**（正确动作是恢复，不是重传），
以及**覆盖率统计不能把回收站算进去**（否则 `indexed > total`，界面无法解释）。
"""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.db import engine
from app.kb.embedding import EmbedderResolution, HashingEmbedder
from app.kb.models import KbChunk, KbDocument, KbVector
from app.timeutil import iso_z, utc_now
from tests.conftest import auth_headers, register

KEYWORD = "报销流程"


def _org(client: TestClient) -> tuple[str, str, str]:
    owner = register(client, "owner@trash.example")
    member = register(client, "staff@trash.example")
    org = client.post(
        "/api/orgs", json={"name": "Trash Corp"}, headers=auth_headers(owner["access"])
    ).json()
    client.post(
        f"/api/orgs/{org['id']}/members",
        json={"email": "staff@trash.example", "role": "member"},
        headers=auth_headers(owner["access"]),
    )
    return owner["access"], member["access"], org["id"]


def _kb(client: TestClient, token: str, org_id: str) -> dict:
    resp = client.post(
        f"/api/orgs/{org_id}/kbs", json={"name": "制度"}, headers=auth_headers(token)
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _add(client: TestClient, token: str, kb_id: str, title: str, content: str) -> dict:
    resp = client.post(
        f"/api/kbs/{kb_id}/documents",
        json={"title": title, "content": content},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _list(client: TestClient, token: str, kb_id: str, trashed: bool = False) -> list[dict]:
    suffix = "?includeDeleted=true" if trashed else ""
    resp = client.get(f"/api/kbs/{kb_id}/documents{suffix}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _hits(client: TestClient, token: str, org_id: str, query: str) -> list[dict]:
    resp = client.post(
        f"/api/orgs/{org_id}/search", json={"query": query, "topK": 50}, headers=auth_headers(token)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _trash(client: TestClient, token: str, kb_id: str, doc_id: str, purge: bool = False):
    suffix = "?purge=true" if purge else ""
    return client.delete(
        f"/api/kbs/{kb_id}/documents/{doc_id}{suffix}", headers=auth_headers(token)
    )


def _use_hash_embedder(monkeypatch) -> None:
    from app.kb import routes as kb_routes

    resolution = EmbedderResolution(kind="hash", embedder=HashingEmbedder(dim=64))
    monkeypatch.setattr(kb_routes, "resolve_embedder", lambda: resolution)


def _status(client: TestClient, token: str, kb_id: str) -> dict:
    resp = client.get(f"/api/kb/retrieval?kbId={kb_id}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_soft_delete_moves_document_to_trash(client: TestClient) -> None:
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")

    assert _trash(client, owner, kb["id"], created["id"]).status_code == 204

    assert _list(client, owner, kb["id"]) == []
    trash = _list(client, owner, kb["id"], trashed=True)
    assert [item["id"] for item in trash] == [created["id"]]
    # 进站时间要回给界面（回收站里得让人看到「什么时候删的」）
    assert trash[0]["deletedAt"] != ""


def test_trash_is_not_searchable(client: TestClient) -> None:
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")
    assert _hits(client, owner, org, KEYWORD), "删之前要能搜到"

    _trash(client, owner, kb["id"], created["id"])

    # 块还在库里（软删不动物理数据），所以这条断言只能靠查询条件成立
    assert _hits(client, owner, org, KEYWORD) == []


def test_restore_brings_it_back_with_index_intact(client: TestClient, monkeypatch) -> None:
    """恢复必须是**立刻可检索**的：块与向量都没动，所以不该要求重建索引。"""
    _use_hash_embedder(monkeypatch)
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")
    _trash(client, owner, kb["id"], created["id"])

    resp = client.post(
        f"/api/kbs/{kb['id']}/documents/{created['id']}/restore", headers=auth_headers(owner)
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["deletedAt"] == ""
    assert [item["id"] for item in _list(client, owner, kb["id"])] == [created["id"]]
    assert _hits(client, owner, org, KEYWORD), "恢复之后要能立刻搜到"
    # 索引条数没变：如果恢复靠重建，这里会先是 0
    assert resp.json()["embedded"] == created["chunkCount"]


def test_purge_removes_rows_from_all_three_tables(client: TestClient, monkeypatch) -> None:
    _use_hash_embedder(monkeypatch)
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")

    assert _trash(client, owner, kb["id"], created["id"], purge=True).status_code == 204

    assert _list(client, owner, kb["id"]) == []
    assert _list(client, owner, kb["id"], trashed=True) == []
    with Session(engine) as session:
        assert session.get(KbDocument, created["id"]) is None
        assert session.exec(select(KbChunk).where(KbChunk.doc_id == created["id"])).all() == []
        assert session.exec(select(KbVector).where(KbVector.doc_id == created["id"])).all() == []


def test_reupload_while_trashed_points_at_restore(client: TestClient) -> None:
    """回收站里的同内容：正确动作是恢复，不是重传，也不是先彻底删除。

    这条文案很要紧 —— 只回「已在库里」，用户会去正常列表里找，那里没有它。
    """
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    content = f"{KEYWORD}：走财务邮箱。"
    created = _add(client, owner, kb["id"], "差旅制度", content)
    _trash(client, owner, kb["id"], created["id"])

    again = client.post(
        f"/api/kbs/{kb['id']}/documents",
        json={"title": "差旅制度（重传）", "content": content},
        headers=auth_headers(owner),
    )

    assert again.status_code == 409
    assert "回收站" in again.json()["detail"]
    assert "恢复" in again.json()["detail"]


def test_expired_trash_is_purged_lazily(client: TestClient) -> None:
    """超过保留期：下一次打开列表就顺手清掉，不需要外部调度。

    直接把 `deleted_at` 改到 40 天前模拟时间流逝（不 mock 时钟：mock 掉 `utc_now`
    会同时影响入库时间戳，让用例测的东西变模糊）。
    """
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")
    _trash(client, owner, kb["id"], created["id"])

    with Session(engine) as session:
        doc = session.get(KbDocument, created["id"])
        assert doc is not None
        doc.deleted_at = iso_z(utc_now() - timedelta(days=40))
        session.add(doc)
        session.commit()

    # 任何一次列表都会触发清理（这里用活文档列表）
    assert _list(client, owner, kb["id"]) == []
    assert _list(client, owner, kb["id"], trashed=True) == []


def test_coverage_ignores_trashed_chunks(client: TestClient, monkeypatch) -> None:
    """覆盖率必须把回收站排除，否则会出现 `indexed > total` 这种无法解释的状态。"""
    _use_hash_embedder(monkeypatch)
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")
    assert _status(client, owner, kb["id"])["chunks"] == created["chunkCount"]

    _trash(client, owner, kb["id"], created["id"])

    after = _status(client, owner, kb["id"])
    assert after["chunks"] == 0
    assert after["indexed"] == 0
    assert after["stale"] is False


def test_trash_operations_require_write_role(client: TestClient) -> None:
    owner, member, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")

    assert _trash(client, member, kb["id"], created["id"]).status_code == 403
    assert (
        client.post(
            f"/api/kbs/{kb['id']}/documents/{created['id']}/restore", headers=auth_headers(member)
        ).status_code
        == 403
    )
    # 三次写操作全被拦下，所以回收站里什么也没有（读回收站本身是读操作，允许）
    assert _list(client, member, kb["id"], trashed=True) == []
