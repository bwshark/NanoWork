"""文档生命周期（2026-10-24）：判重、删除、改名、写权限。

## 这一组在守什么

在加这一轮之前，知识库**只能增不能删**：传错一份资料就永久留在库里、永久参与检索；
同一篇重复上传则会产生完全重复的块，让 top-5 结果全是同一篇的不同副本。
所以这里的用例重点不是「接口返回 200」，而是**三件容易被绕过的事**：

1. **判重作用域**：同一个库内同内容拦下，跨库同内容放行（那是正常用法）。
2. **删除要删干净**：块、向量、文档行三处都清，且**检索立刻搜不到**。
   只删文档行会留下孤儿块 —— 它们带着 kb_id，照样会被检索命中，
   于是用户看到一份列表里不存在的文档出现在结果里。
3. **写权限与读权限分开**：只读成员不能往权威资料库里塞/删内容。
"""

from __future__ import annotations

import base64
import io
import zipfile

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.db import engine
from app.kb.chunking import chunk_text, join_chunks
from app.kb.embedding import EmbedderResolution, HashingEmbedder
from app.kb.models import KbChunk, KbDocument, KbVector
from tests.conftest import auth_headers, register

KEYWORD = "报销流程"


# —— 夹具 ——


def _org(client: TestClient) -> tuple[str, str, str]:
    """返回 (owner token, member token, org_id)。"""
    owner = register(client, "owner@docs.example")
    member = register(client, "staff@docs.example")
    org = client.post(
        "/api/orgs", json={"name": "Docs Corp"}, headers=auth_headers(owner["access"])
    ).json()
    client.post(
        f"/api/orgs/{org['id']}/members",
        json={"email": "staff@docs.example", "role": "member"},
        headers=auth_headers(owner["access"]),
    )
    return owner["access"], member["access"], org["id"]


def _kb(client: TestClient, token: str, org_id: str, name: str = "制度") -> dict:
    resp = client.post(f"/api/orgs/{org_id}/kbs", json={"name": name}, headers=auth_headers(token))
    assert resp.status_code == 201, resp.text
    return resp.json()


def _add(client: TestClient, token: str, kb_id: str, title: str, content: str):
    return client.post(
        f"/api/kbs/{kb_id}/documents",
        json={"title": title, "content": content},
        headers=auth_headers(token),
    )


def _docs(client: TestClient, token: str, kb_id: str) -> list[dict]:
    resp = client.get(f"/api/kbs/{kb_id}/documents", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _hits(client: TestClient, token: str, org_id: str, query: str) -> list[dict]:
    resp = client.post(
        f"/api/orgs/{org_id}/search", json={"query": query, "topK": 50}, headers=auth_headers(token)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _use_hash_embedder(monkeypatch) -> None:
    """把 embedder 换成哈希档（无需网络），让「向量是否被删掉」可断言。"""
    from app.kb import routes as kb_routes

    resolution = EmbedderResolution(kind="hash", embedder=HashingEmbedder(dim=64))
    monkeypatch.setattr(kb_routes, "resolve_embedder", lambda: resolution)


def _make_docx(paragraphs: list[str]) -> bytes:
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in paragraphs)
    xml = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<w:document xmlns:w="{ns}"><w:body>{body}</w:body></w:document>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", xml)
    return buffer.getvalue()


# —— 判重 ——


def test_same_content_in_one_kb_is_rejected(client: TestClient) -> None:
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    first = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")
    assert first.status_code == 201, first.text

    again = _add(client, owner, kb["id"], "差旅制度（重传）", f"{KEYWORD}：走财务邮箱。")

    assert again.status_code == 409
    # 报错必须点出「已存在哪一篇」：只说「重复」的话，用户不知道该删哪个
    assert "差旅制度" in again.json()["detail"]
    # 只留一份：判重发生在落库前，不能先写进去再删
    assert [doc["title"] for doc in _docs(client, owner, kb["id"])] == ["差旅制度"]


def test_duplicate_check_is_scoped_to_one_kb(client: TestClient) -> None:
    """跨库同内容是正常用法（同一段制度既在手册也在差旅制度里），不能拦。"""
    owner, _, org = _org(client)
    first_kb = _kb(client, owner, org, "员工手册")
    second_kb = _kb(client, owner, org, "差旅制度")
    content = f"{KEYWORD}：走财务邮箱。"

    assert _add(client, owner, first_kb["id"], "总则", content).status_code == 201
    assert _add(client, owner, second_kb["id"], "总则", content).status_code == 201


def test_different_formatting_still_counts_as_duplicate(client: TestClient) -> None:
    """摘要按**块**算：多一个空行不该骗过判重（否则「复制一遍再传」永远拦不住）。"""
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    assert _add(client, owner, kb["id"], "制度", f"{KEYWORD}：走财务邮箱。").status_code == 201

    again = _add(client, owner, kb["id"], "制度", f"\n\n{KEYWORD}：走财务邮箱。\n\n")

    assert again.status_code == 409


def test_legacy_document_without_hash_is_backfilled(client: TestClient) -> None:
    """摘要字段存在之前入库的文档（content_hash 为空串）也要能判重。

    这一条盯的是 `_backfill_hashes`：它从**块**重算摘要（正文不入库，块一直在）。
    少了它，老库上「同一篇重复上传」永远不会被拦。
    """
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "老文档", f"{KEYWORD}：走财务邮箱。").json()

    # 手工把摘要抹掉，模拟「这一行产生于字段存在之前」
    with Session(engine) as session:
        doc = session.get(KbDocument, created["id"])
        assert doc is not None
        doc.content_hash = ""
        session.add(doc)
        session.commit()

    again = _add(client, owner, kb["id"], "老文档（重传）", f"{KEYWORD}：走财务邮箱。")

    assert again.status_code == 409
    assert "老文档" in again.json()["detail"]
    with Session(engine) as session:
        # 回填是持久的：不是只在这次请求里临时算过
        assert session.get(KbDocument, created["id"]).content_hash != ""  # type: ignore[union-attr]


# —— 写权限 ——


def test_member_cannot_write(client: TestClient) -> None:
    """只读成员能看（默认全员可见），但不能写：知识库是权威资料，不是论坛。"""
    owner, member, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "制度", f"{KEYWORD}：走财务邮箱。").json()

    # 先确认「能读」——否则下面的 403 可能只是被读守卫拦住的，测不出写守卫
    assert [doc["title"] for doc in _docs(client, member, kb["id"])] == ["制度"]

    assert _add(client, member, kb["id"], "成员塞的", "另一份内容").status_code == 403
    assert (
        client.patch(
            f"/api/kbs/{kb['id']}/documents/{created['id']}",
            json={"title": "改名"},
            headers=auth_headers(member),
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(member)
        ).status_code
        == 403
    )
    # 什么都没变
    assert [doc["title"] for doc in _docs(client, owner, kb["id"])] == ["制度"]


# —— 删除 ——


def test_delete_takes_document_out_of_search_but_keeps_it_restorable(
    client: TestClient, monkeypatch
) -> None:
    """默认删除 = 进回收站：**从检索里摘掉，但块与向量留着**。

    这条用例盯的是「摘掉」这件事的实现方式：块没被物理删掉，所以搜不到必须靠
    查询条件（`deleted_at == ''` 的 join）。少了那个条件，删掉的资料照样被搜出来 ——
    而列表里已经没有它，用户完全无法解释搜索结果。
    """
    _use_hash_embedder(monkeypatch)
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。").json()
    assert created["embedded"] >= 1, "hash embedder 打开时入库应当建索引"
    assert _hits(client, owner, org, KEYWORD), "删之前应该搜得到"

    resp = client.delete(
        f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner)
    )

    assert resp.status_code == 204
    assert _docs(client, owner, kb["id"]) == []
    # 检索是另一条路径（kb_chunks IN scope_ids），必须同样看不见
    assert _hits(client, owner, org, KEYWORD) == []
    with Session(engine) as session:
        # 块与向量都还在 —— 恢复时才不用重建索引
        assert session.exec(select(KbChunk).where(KbChunk.doc_id == created["id"])).all() != []
        assert session.exec(select(KbVector).where(KbVector.doc_id == created["id"])).all() != []


def test_delete_document_from_another_kb_is_404(client: TestClient) -> None:
    """拿 A 库的 kb_id 去删 B 库的文档必须 404，否则「可见」就成了「可删」。"""
    owner, _, org = _org(client)
    first = _kb(client, owner, org, "制度")
    second = _kb(client, owner, org, "手册")
    foreign = _add(client, owner, second["id"], "手册正文", "手册内容，与制度无关。").json()

    resp = client.delete(
        f"/api/kbs/{first['id']}/documents/{foreign['id']}", headers=auth_headers(owner)
    )

    assert resp.status_code == 404
    assert [doc["id"] for doc in _docs(client, owner, second["id"])] == [foreign["id"]]


def test_purged_content_can_be_reingested(client: TestClient) -> None:
    """**彻底删除**之后同内容必须能重新入库 —— 否则判重会把人锁在门外。

    ⚠️ 注意是「彻底删除」：只进回收站时同内容仍然是重复的（这时正确动作是恢复，
    见 `test_kb_trash.py`），两种情况要分开断言，否则测试会让人以为「软删等于删了」。
    """
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    content = f"{KEYWORD}：走财务邮箱。"
    created = _add(client, owner, kb["id"], "制度", content).json()
    client.delete(
        f"/api/kbs/{kb['id']}/documents/{created['id']}?purge=true", headers=auth_headers(owner)
    )

    assert _add(client, owner, kb["id"], "制度（修订）", content).status_code == 201


# —— 改名与列表 ——


def test_rename_changes_title_only(client: TestClient) -> None:
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "差旅制度v1", f"{KEYWORD}：走财务邮箱。").json()

    resp = client.patch(
        f"/api/kbs/{kb['id']}/documents/{created['id']}",
        json={"title": "差旅制度（2026 版）"},
        headers=auth_headers(owner),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "差旅制度（2026 版）"
    # 内容不动：块数、字数、创建时间都不变
    assert body["chunkCount"] == created["chunkCount"]
    assert body["chars"] == created["chars"]
    assert body["createdAt"] == created["createdAt"]
    # 刚入库的文档「更新时间」等于创建时间（老库没有这一列时服务端也这样兜底），
    # 改完名必须真的往前走 —— 否则列表上那一列永远是创建时间，用户会以为改名没生效
    assert created["updatedAt"] == created["createdAt"]
    assert body["updatedAt"] > created["updatedAt"]
    assert _hits(client, owner, org, KEYWORD), "改名不该影响检索"


def test_rename_rejects_blank_title(client: TestClient) -> None:
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "制度", f"{KEYWORD}：走财务邮箱。").json()

    resp = client.patch(
        f"/api/kbs/{kb['id']}/documents/{created['id']}",
        json={"title": "   "},
        headers=auth_headers(owner),
    )

    assert resp.status_code == 422


def test_list_reports_kind_and_indexed_count(client: TestClient, monkeypatch) -> None:
    """列表必须说清「这篇是什么格式、建了几条向量」。

    之前列表接口没传 `kind`（构造函数里缺字段），于是所有文档都显示成 `text`、
    索引条数恒为 0 —— 那是「我明明传了 pdf」和「我明明建了索引」两句话的共同来源。
    """
    _use_hash_embedder(monkeypatch)
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    payload = base64.b64encode(_make_docx([f"{KEYWORD}：走财务邮箱。"])).decode()

    upload = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "差旅制度.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    )
    assert upload.status_code == 201, upload.text

    listed = _docs(client, owner, kb["id"])

    assert [doc["kind"] for doc in listed] == ["docx"]
    assert listed[0]["embedded"] == listed[0]["chunkCount"] >= 1


# —— 单篇详情（抽屉里「打开文档」读的就是它）——


def test_get_document_returns_joined_content(client: TestClient) -> None:
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    content = f"{KEYWORD}：走财务邮箱。\n\n住宿按城市分级。"
    created = _add(client, owner, kb["id"], "差旅制度", content).json()

    resp = client.get(f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner))

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "差旅制度"
    # 正文是把块拼回来的：分段（空行）必须还原，否则详情页会读成一整坨
    assert "走财务邮箱" in body["content"]
    assert "\n\n" in body["content"]
    assert body["content"].startswith(KEYWORD)


def test_get_document_hides_trashed(client: TestClient) -> None:
    """回收站里的不给读：能读会让「删了还看得到」变成第二个真相。"""
    owner, _, org = _org(client)
    kb = _kb(client, owner, org)
    created = _add(client, owner, kb["id"], "制度", f"{KEYWORD}：走财务邮箱。").json()
    client.delete(f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner))

    resp = client.get(f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner))

    assert resp.status_code == 404
    assert "回收站" in resp.json()["detail"]


def test_get_document_is_scoped_to_visible_kb(client: TestClient) -> None:
    """读不到这个库就是 403（`_kb_or_404` 的口径：库里存在、角色不够）。

    客户端必须原样转达这句，不能悄悄改成 404 或空正文 —— 那会让「权限配错了」
    看起来像「这篇文档内容为空」。
    """
    owner, member, org = _org(client)
    secret = _kb(client, owner, org, "管理层制度")
    client.patch(
        f"/api/kbs/{secret['id']}/visibility",
        json={"allowedRoles": ["admin", "owner"]},
        headers=auth_headers(owner),
    )
    created = _add(client, owner, secret["id"], "机密", f"{KEYWORD}：走财务邮箱。").json()

    resp = client.get(
        f"/api/kbs/{secret['id']}/documents/{created['id']}", headers=auth_headers(member)
    )

    assert resp.status_code == 403
    assert "无权访问" in resp.json()["detail"]


def test_join_chunks_trims_hard_split_overlap() -> None:
    """硬切会留 80 字重叠：拼回去必须去掉，否则详情页在切口处读起来像重复了一整句。"""
    # 每个字都不同：这样「最长的前后缀匹配」必然是硬切留下的那 80 字，
    # 不用一个重复字符的长串去测（那会让匹配长度不可判定，测出来的东西没意义）
    paragraph = "".join(chr(0x4E00 + index) for index in range(1400))
    chunks = chunk_text(paragraph)
    assert len(chunks) > 1

    joined = join_chunks(chunks)

    # 拼回来应当与原文逐字相同（重叠被削掉），而不是多出几十个字
    assert joined == paragraph


def test_visibility_patch_does_not_require_name(client: TestClient) -> None:
    """改可见范围的请求体里**没有** `name`（客户端就是这么发的）。

    这条守的是一个真出现过的 422：PATCH /visibility 曾复用 `CreateKbRequest`，而那里
    `name` 是必填 —— 于是「保存可见范围」在真机上永远失败，客户端用例却全绿，
    因为它们 mock 了网关，看不到请求体校验。
    """
    owner, member, org = _org(client)
    kb = _kb(client, owner, org, "制度")

    resp = client.patch(
        f"/api/kbs/{kb['id']}/visibility",
        json={"allowedRoles": ["admin", "owner"]},
        headers=auth_headers(owner),
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["allowedRoles"] == ["admin", "owner"]
    # 收紧了就要真的看不见（不然这条只是"接口没报错"）
    visible = client.get(f"/api/orgs/{org}/kbs", headers=auth_headers(member)).json()
    assert visible == []
