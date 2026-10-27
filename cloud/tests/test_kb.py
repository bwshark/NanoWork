"""知识库（FR-4.7 MVP）：**检索前过滤**是这一组用例的主角。

如果只测「搜得到」，那么「先取全部再筛」的实现也会全绿——而这正是 PRD 明确反对的写法：
在向量库/索引分页的真实形态下，被过滤掉的内容会先占满 topK 名额，
用户看到的是「明明有资料却搜不到」，而且没有任何报错。

所以核心用例是 `test_member_never_sees_admin_only_kb`：两份文档含**完全相同的关键词**，
member 只能拿到自己可见的那一份；`topK` 拉到 50 也一样。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.kb.chunking import chunk_text
from app.kb.retrieval import rank_chunks, tokenize
from tests.conftest import auth_headers, register

KEYWORD = "报销流程"


def _org_with_members(client: TestClient) -> tuple[str, str, dict]:
    """返回 (owner token, member token, org)。"""
    owner = register(client, "boss@corp.example")
    member = register(client, "staff@corp.example")
    org = client.post(
        "/api/orgs", json={"name": "Corp"}, headers=auth_headers(owner["access"])
    ).json()
    resp = client.post(
        f"/api/orgs/{org['id']}/members",
        json={"email": "staff@corp.example", "role": "member"},
        headers=auth_headers(owner["access"]),
    )
    assert resp.status_code == 201, resp.text
    return owner["access"], member["access"], org


def _create_kb(client: TestClient, token: str, org_id: str, name: str, roles=None) -> dict:
    body: dict = {"name": name}
    if roles is not None:
        body["allowedRoles"] = roles
    resp = client.post(f"/api/orgs/{org_id}/kbs", json=body, headers=auth_headers(token))
    assert resp.status_code == 201, resp.text
    return resp.json()


def _add_doc(client: TestClient, token: str, kb_id: str, title: str, content: str) -> dict:
    resp = client.post(
        f"/api/kbs/{kb_id}/documents",
        json={"title": title, "content": content},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _search(client: TestClient, token: str, org_id: str, query: str, **extra) -> dict:
    return client.post(
        f"/api/orgs/{org_id}/search",
        json={"query": query, **extra},
        headers=auth_headers(token),
    )


def test_default_visibility_is_everyone(client: TestClient) -> None:
    owner_token, member_token, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "制度")
    assert kb["allowedRoles"] == ["member", "admin", "owner"]

    listed = client.get(f"/api/orgs/{org['id']}/kbs", headers=auth_headers(member_token)).json()
    assert [item["id"] for item in listed] == [kb["id"]]


def test_document_is_chunked_and_listed(client: TestClient) -> None:
    owner_token, _, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "制度")
    doc = _add_doc(
        client,
        owner_token,
        kb["id"],
        "差旅制度",
        "第一段：出差前需要在系统里提交申请。\n\n第二段：报销流程走财务邮箱。",
    )
    assert doc["chunkCount"] >= 1
    assert doc["chars"] > 0

    docs = client.get(f"/api/kbs/{kb['id']}/documents", headers=auth_headers(owner_token)).json()
    assert [item["title"] for item in docs] == ["差旅制度"]


def test_member_never_sees_admin_only_kb(client: TestClient) -> None:
    """核心判据：同样的关键词，越权的那份**绝不出现**（不是排在后面）。"""
    owner_token, member_token, org = _org_with_members(client)

    public_kb = _create_kb(client, owner_token, org["id"], "公开制度")
    secret_kb = _create_kb(client, owner_token, org["id"], "管理层制度", roles=["admin", "owner"])
    _add_doc(client, owner_token, public_kb["id"], "员工版", f"{KEYWORD}：走财务邮箱。")
    # 管理员版**故意写得更"相关"**（关键词重复多次 → 打分更高）。
    # 这样「先按 topK 取再过滤」的实现会把它排到第一、然后被过滤掉 → 结果为空；
    # 而正确的「先过滤再打分」会拿到员工版。这条差异就是本用例的鉴别力。
    _add_doc(
        client,
        owner_token,
        secret_kb["id"],
        "管理层版",
        f"{KEYWORD} {KEYWORD} {KEYWORD}：走总经理特批。",
    )

    member_hits = _search(client, member_token, org["id"], KEYWORD, topK=1).json()
    assert member_hits, "member 应该能搜到公开库里的资料（不是「被过滤成空」）"
    assert [hit["docTitle"] for hit in member_hits] == ["员工版"]

    member_all = _search(client, member_token, org["id"], KEYWORD, topK=50).json()
    assert "管理层版" not in {hit["docTitle"] for hit in member_all}

    owner_hits = _search(client, owner_token, org["id"], KEYWORD, topK=50).json()
    assert {hit["docTitle"] for hit in owner_hits} == {"员工版", "管理层版"}


def test_member_cannot_target_admin_kb_by_id(client: TestClient) -> None:
    """指定 kbId 不能成为绕过可见性的侧门。"""
    owner_token, member_token, org = _org_with_members(client)
    secret_kb = _create_kb(client, owner_token, org["id"], "管理层", roles=["admin", "owner"])
    _add_doc(client, owner_token, secret_kb["id"], "密件", f"{KEYWORD}：特批。")

    resp = _search(client, member_token, org["id"], KEYWORD, kbId=secret_kb["id"])
    assert resp.status_code == 403


def test_non_member_gets_404(client: TestClient) -> None:
    owner_token, _, org = _org_with_members(client)
    outsider = register(client, "outsider@corp.example")
    kb = _create_kb(client, owner_token, org["id"], "制度")

    outsider_headers = auth_headers(outsider["access"])
    assert client.get(f"/api/orgs/{org['id']}/kbs", headers=outsider_headers).status_code == 404
    assert (
        client.get(f"/api/kbs/{kb['id']}/documents", headers=auth_headers(outsider["access"]))
    ).status_code == 404
    assert _search(client, outsider["access"], org["id"], KEYWORD).status_code == 404


def test_member_cannot_change_visibility(client: TestClient) -> None:
    """改可见范围必须 admin：否则任何人都能把管理员库对全员开放。"""
    owner_token, member_token, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "管理层", roles=["owner"])

    denied = client.patch(
        f"/api/kbs/{kb['id']}/visibility",
        json={"name": "管理层", "allowedRoles": ["member", "admin", "owner"]},
        headers=auth_headers(member_token),
    )
    assert denied.status_code == 403

    allowed = client.patch(
        f"/api/kbs/{kb['id']}/visibility",
        json={"name": "管理层", "allowedRoles": ["member", "admin", "owner"]},
        headers=auth_headers(owner_token),
    )
    assert allowed.status_code == 200
    assert allowed.json()["allowedRoles"] == ["member", "admin", "owner"]


def test_empty_visibility_is_rejected(client: TestClient) -> None:
    """空数组 = 谁都看不到，那是误操作而不是意图；直接 422。"""
    owner_token, _, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "制度")
    resp = client.patch(
        f"/api/kbs/{kb['id']}/visibility",
        json={"name": "制度", "allowedRoles": []},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 422


def test_empty_document_rejected(client: TestClient) -> None:
    owner_token, _, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "制度")
    resp = client.post(
        f"/api/kbs/{kb['id']}/documents",
        json={"title": "空", "content": "   \n\n  "},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 422


def test_search_returns_nothing_for_unrelated_query(client: TestClient) -> None:
    owner_token, _, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "制度")
    _add_doc(client, owner_token, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")

    assert _search(client, owner_token, org["id"], "量子纠缠退相干").json() == []


# —— 多库绑定（`kbIds`）：专家/会话把检索范围收窄到「绑定过的这几本」——


def test_binding_scopes_search_to_listed_kbs(client: TestClient) -> None:
    """绑了两本只搜一本：另一本的资料**不出现**（不是排在后面）。

    关键点是这条收窄必须发生在 SQL 里（`kb_id IN (…)`）。若实现成「取全组织再
    筛 kbId」，越权/未绑定的块会先占掉 topK 名额，表现为「绑定的库里明明有，却搜不到」。
    """
    owner_token, _, org = _org_with_members(client)
    bound = _create_kb(client, owner_token, org["id"], "产品手册")
    other = _create_kb(client, owner_token, org["id"], "行政通知")
    _add_doc(client, owner_token, bound["id"], "手册正文", f"{KEYWORD}：走产品线。")
    # 未绑定的这本**写得更相关**（同一不变量：先取再筛的实现会返回它或返回空）
    _add_doc(
        client,
        owner_token,
        other["id"],
        "通知正文",
        f"{KEYWORD} {KEYWORD} {KEYWORD}：走行政线。",
    )

    hits = _search(client, owner_token, org["id"], KEYWORD, kbIds=[bound["id"]], topK=1).json()
    assert [hit["docTitle"] for hit in hits] == ["手册正文"]

    both = _search(
        client, owner_token, org["id"], KEYWORD, kbIds=[bound["id"], other["id"]], topK=50
    ).json()
    assert {hit["docTitle"] for hit in both} == {"手册正文", "通知正文"}


def test_binding_to_invisible_kb_is_forbidden(client: TestClient) -> None:
    """绑到了自己看不见的库 → **403**，不是「悄悄跳过这一本」。

    悄悄跳过看起来更"友好"，实际是把「专家过期绑定 / 角色被降级」伪装成
    「绑定的库里没资料」——用户会去补资料，而真正该做的是重新绑定。
    """
    owner_token, member_token, org = _org_with_members(client)
    public_kb = _create_kb(client, owner_token, org["id"], "公开")
    secret_kb = _create_kb(client, owner_token, org["id"], "管理层", roles=["admin", "owner"])
    _add_doc(client, owner_token, public_kb["id"], "员工版", f"{KEYWORD}：走财务邮箱。")

    resp = _search(
        client, member_token, org["id"], KEYWORD, kbIds=[public_kb["id"], secret_kb["id"]]
    )
    assert resp.status_code == 403


def test_empty_kb_ids_is_rejected(client: TestClient) -> None:
    """空数组 ≠ 不限定范围。

    `[]` 最可能的来源是「绑定的库全被删了」或调用方漏填；把它当「整组织可见库」
    会让一次本该无结果的检索返回无关资料，而没人会察觉范围被放宽了。
    """
    owner_token, _, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "制度")
    _add_doc(client, owner_token, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")

    assert _search(client, owner_token, org["id"], KEYWORD, kbIds=[]).status_code == 422


def test_binding_duplicate_ids_do_not_duplicate_hits(client: TestClient) -> None:
    """同一个 id 传两次：块只算一份（否则打分时同一段被计两次、结果里出现两遍）。"""
    owner_token, _, org = _org_with_members(client)
    kb = _create_kb(client, owner_token, org["id"], "制度")
    _add_doc(client, owner_token, kb["id"], "差旅", f"{KEYWORD}：走财务邮箱。")

    hits = _search(client, owner_token, org["id"], KEYWORD, kbIds=[kb["id"], kb["id"]]).json()
    assert [hit["docTitle"] for hit in hits] == ["差旅"]


# —— 纯函数：切块与打分（不经过 HTTP，失败时定位更快）——


def test_chunking_packs_short_paragraphs_and_caps_length() -> None:
    """**装箱**而不是「一段一块」：三段 245 字会被装成两块（前两段合一块）。"""
    paragraphs = [f"第{i}段：" + "内容" * 120 for i in range(3)]
    chunks = chunk_text("\n\n".join(paragraphs), max_chars=500, overlap=50)
    assert len(chunks) == 2
    assert all(len(chunk) <= 500 for chunk in chunks)
    # 段落边界不能被吞掉：合并后仍以空行分隔
    assert "\n\n" in chunks[0]


def test_chunking_hard_splits_each_oversized_paragraph() -> None:
    paragraphs = [f"第{i}段：" + "内容" * 300 for i in range(3)]
    chunks = chunk_text("\n\n".join(paragraphs), max_chars=500, overlap=50)
    # 每段都超过 500 → 各自硬切；总量必然 ≥ 3
    assert len(chunks) >= 3
    assert all(0 < len(chunk) <= 500 for chunk in chunks)


def test_chunking_hard_splits_long_paragraph_with_overlap() -> None:
    long_paragraph = "甲" * 1200
    chunks = chunk_text(long_paragraph, max_chars=500, overlap=50)
    assert len(chunks) >= 3
    # 相邻块必须重叠：答案跨切口时不至于两边都只命中半句
    assert chunks[0][-50:] == chunks[1][:50]


def test_chunking_rejects_degenerate_window() -> None:
    import pytest

    with pytest.raises(ValueError):
        chunk_text("内容", max_chars=50, overlap=50)


def test_tokenize_handles_cjk_and_latin() -> None:
    tokens = tokenize("报销流程 Reimburse 2026")
    assert "报销" in tokens and "销流" in tokens
    assert "reimburse" in tokens
    assert "2026" in tokens


def test_rank_orders_by_relevance_and_is_stable() -> None:
    chunks = [
        "今天天气不错",
        "报销流程：走财务邮箱",
        "报销流程 报销流程 报销流程",
    ]
    ranked = rank_chunks(chunks, "报销流程", top_k=2)
    assert [item.index for item in ranked] == [2, 1]
    # 无关块不进入结果（score 0 的不是「弱相关」，是没命中）
    assert all(item.score > 0 for item in ranked)
