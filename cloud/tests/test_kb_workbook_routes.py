"""表格视图的接口契约（2026-10-27）：状态、gzip、过期、失败与权限。

这一组**不测解析细节**（那些在 `test_kb_workbook.py`），只钉接口行为：

1. `.xlsx` 的默认视图是 `grid`，不是 PDF；
2. 先 GET 后 POST 的顺序（GET 不偷偷触发解析）；
3. 落库的是 gzip，且 `Content-Encoding` 明确；
4. 原文件换了 / 解析器升级了 → 缓存自动作废，而不是继续显示旧表；
5. 解析失败要留下原因，并且还能重试；
6. 权限与原文件同一套，没有旁路；
7. 彻底删除要连带清掉表格视图（否则库只增不减）。
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.db import engine
from app.kb.models import KbFile, KbGridPreview
from tests.conftest import auth_headers
from tests.test_kb_documents import _kb, _org
from tests.test_kb_files import _upload
from tests.test_kb_parsing import make_docx
from tests.test_kb_workbook import _book


def _xlsx() -> bytes:
    inner = (
        '<sheetData><row r="1">'
        '<c r="A1" t="s"><v>0</v></c><c r="B1"><v>128</v></c>'
        "</row></sheetData>"
    )
    return _book([("销售台账", inner, "visible")], shared=["产品"])


def _upload_xlsx(client: TestClient, token: str, kb_id: str) -> dict:
    resp = _upload(client, token, kb_id, "销售台账.xlsx", _xlsx())
    assert resp.status_code == 201, resp.text
    return resp.json()


def _info(client: TestClient, token: str, kb_id: str, doc_id: str) -> dict:
    resp = client.get(f"/api/kbs/{kb_id}/documents/{doc_id}/preview", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _build(client: TestClient, token: str, kb_id: str, doc_id: str):
    return client.post(
        f"/api/kbs/{kb_id}/documents/{doc_id}/preview.workbook",
        headers=auth_headers(token),
    )


def _workbook(client: TestClient, token: str, kb_id: str, doc_id: str):
    return client.get(
        f"/api/kbs/{kb_id}/documents/{doc_id}/preview.workbook",
        headers=auth_headers(token),
    )


def test_xlsx_defaults_to_grid_and_starts_pending(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload_xlsx(client, owner, kb["id"])

    info = _info(client, owner, kb["id"], doc["id"])

    assert info["previewKind"] == "grid"
    assert info["suffix"] == ".xlsx"
    assert info["gridState"] == "pending"


def test_build_is_idempotent_and_serves_gzip(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload_xlsx(client, owner, kb["id"])

    # GET 不触发解析：还没生成就是 409，前端据此决定去 POST
    before = _workbook(client, owner, kb["id"], doc["id"])
    assert before.status_code == 409

    built = _build(client, owner, kb["id"], doc["id"])
    assert built.status_code == 200, built.text
    body = built.json()
    assert body["gridState"] == "ready"
    assert body["gridSheets"] == 1
    assert body["gridCells"] == 2
    assert body["gridMs"] >= 0

    got = _workbook(client, owner, kb["id"], doc["id"])
    assert got.status_code == 200
    assert got.headers["content-encoding"] == "gzip"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert got.headers["etag"].startswith('"')
    payload = got.json()
    assert payload["sheets"][0]["name"] == "销售台账"
    assert payload["sheets"][0]["celldata"][1]["v"]["v"] == 128

    # 再 POST 一次不重新解析，状态仍是 ready（幂等）
    again = _build(client, owner, kb["id"], doc["id"])
    assert again.json()["gridState"] == "ready"


def test_stale_parser_version_forces_a_rebuild(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload_xlsx(client, owner, kb["id"])
    _build(client, owner, kb["id"], doc["id"])

    with Session(engine) as session:
        grid = session.get(KbGridPreview, doc["id"])
        assert grid is not None
        grid.parser_version = 0
        session.add(grid)
        session.commit()

    assert _info(client, owner, kb["id"], doc["id"])["gridState"] == "pending"
    assert _workbook(client, owner, kb["id"], doc["id"]).status_code == 409
    assert _build(client, owner, kb["id"], doc["id"]).json()["gridState"] == "ready"


def test_failed_parse_is_reported_and_retryable(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload_xlsx(client, owner, kb["id"])

    with Session(engine) as session:
        row = session.get(KbFile, doc["id"])
        assert row is not None
        row.blob = b"not a zip at all"
        session.add(row)
        session.commit()

    built = _build(client, owner, kb["id"], doc["id"])
    assert built.status_code == 200
    assert built.json()["gridState"] == "failed"
    assert "zip 结构损坏" in built.json()["gridError"]

    rejected = _workbook(client, owner, kb["id"], doc["id"])
    assert rejected.status_code == 409
    assert "zip 结构损坏" in rejected.json()["detail"]

    # 文件修好后，明确要求重建 —— 失败不是终态
    with Session(engine) as session:
        row = session.get(KbFile, doc["id"])
        assert row is not None
        row.blob = _xlsx()
        session.add(row)
        session.commit()

    assert _build(client, owner, kb["id"], doc["id"]).json()["gridState"] == "ready"


def test_workbook_is_only_for_xlsx(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()

    assert _info(client, owner, kb["id"], doc["id"])["previewKind"] == "pdf"
    assert _workbook(client, owner, kb["id"], doc["id"]).status_code == 409
    assert _build(client, owner, kb["id"], doc["id"]).status_code == 409


def test_workbook_has_no_permission_bypass(client: TestClient) -> None:
    """.xlsx 的表格视图与原文件同一套权限：库不可见就是 403，跨库就是 404。"""
    owner, member, org_id = _org(client)
    kb = _kb(client, owner, org_id)

    internal = client.post(
        f"/api/orgs/{org_id}/kbs",
        json={"name": "管理层", "allowedRoles": ["admin", "owner"]},
        headers=auth_headers(owner),
    ).json()
    secret = _upload_xlsx(client, owner, internal["id"])

    assert _workbook(client, member, internal["id"], secret["id"]).status_code == 403
    assert _build(client, member, internal["id"], secret["id"]).status_code == 403
    assert _workbook(client, owner, kb["id"], secret["id"]).status_code == 404


def test_purge_removes_workbook(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload_xlsx(client, owner, kb["id"])
    _build(client, owner, kb["id"], doc["id"])

    with Session(engine) as session:
        assert session.get(KbGridPreview, doc["id"]) is not None

    deleted = client.delete(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}?purge=true",
        headers=auth_headers(owner),
    )
    assert deleted.status_code in (200, 204), deleted.text

    with Session(engine) as session:
        assert session.get(KbGridPreview, doc["id"]) is None


def test_early_documents_without_file_have_no_grid(client: TestClient) -> None:
    """早期文档没有原文件：连 grid 都不是，界面只能看正文。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = client.post(
        f"/api/kbs/{kb['id']}/documents",
        json={"title": "粘贴的笔记", "content": "只有正文"},
        headers=auth_headers(owner),
    ).json()

    info = _info(client, owner, kb["id"], doc["id"])

    assert info["previewKind"] == "none"
    assert info["gridState"] == ""
    assert _workbook(client, owner, kb["id"], doc["id"]).status_code == 404
