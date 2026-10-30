"""个人知识库（2026-10-30）：**「仅自己可见」必须由服务端兑现**。

这一组用例都在钉同一件事：个人库的隐私来自「私有组织里只有我一个人」，
而不是界面上的一句话。所以每条可能的越权路径各占一例：

1. 别人读我的个人库 → 404（不是 403：不泄露它存在）；
2. 别人在我的私有组织里检索 → 拿不到我的文档（哪怕关键词完全一样）；
3. 别人被拉进我的私有组织 → 403（这条路不堵，「仅自己可见」就是假的）；
4. 私有组织出现在团队列表里 → 不允许（它会被当成一家只有一个员工的公司）。

另外两条是「取或建」的语义：重复访问必须返回**同一本**库，而不是每点一次多一本。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register

KEYWORD = "报销流程"


def personal(client: TestClient, token: str) -> dict:
    resp = client.get("/api/kb/personal", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def add_doc(client: TestClient, token: str, kb_id: str, title: str, content: str) -> dict:
    resp = client.post(
        f"/api/kbs/{kb_id}/documents",
        json={"title": title, "content": content},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def search(client: TestClient, token: str, org_id: str, query: str) -> dict:
    return client.post(
        f"/api/orgs/{org_id}/search",
        json={"query": query, "topK": 50},
        headers=auth_headers(token),
    )


def test_personal_kb_is_created_once_and_owned_by_me(client: TestClient) -> None:
    """取或建：两次访问是同一本库，且我是 owner（否则我自己也写不进去）。"""
    token = register(client, "solo@example.com")["access"]
    first = personal(client, token)
    second = personal(client, token)

    assert first["kb"]["id"] == second["kb"]["id"]
    assert first["orgId"] == second["orgId"]
    assert first["kb"]["name"] == "我的个人知识库"
    assert first["kb"]["documentCount"] == 0


def test_personal_space_is_not_listed_as_team(client: TestClient) -> None:
    """私有组织不进团队列表：它不是团队。"""
    token = register(client, "solo@example.com")["access"]
    org_id = personal(client, token)["orgId"]

    listed = client.get("/api/orgs", headers=auth_headers(token)).json()
    assert [item["id"] for item in listed] == []
    # 但它自己仍然是「我加入的组织」，按 id 直连成员表也看得到自己
    members = client.get(f"/api/orgs/{org_id}/members", headers=auth_headers(token))
    assert members.status_code == 200
    assert [item["email"] for item in members.json()] == ["solo@example.com"]


def test_other_user_cannot_read_my_personal_kb(client: TestClient) -> None:
    """别人按 id 直连：404（不确认它存在）。"""
    mine = register(client, "me@example.com")["access"]
    other = register(client, "other@example.com")["access"]
    kb_id = personal(client, mine)["kb"]["id"]

    resp = client.get(f"/api/kbs/{kb_id}/documents", headers=auth_headers(other))
    assert resp.status_code == 404, resp.text

    # 写入同样不行（写路径的守卫排在读之后，但错误码不泄露库的存在性）
    resp = client.post(
        f"/api/kbs/{kb_id}/documents",
        json={"title": "偷偷塞一篇", "content": KEYWORD},
        headers=auth_headers(other),
    )
    assert resp.status_code == 404, resp.text


def test_other_user_sees_no_hits_from_my_personal_kb(client: TestClient) -> None:
    """跨用户检索拿不到我的资料（关键词完全相同也拿不到）。"""
    mine = register(client, "me@example.com")["access"]
    other = register(client, "other@example.com")["access"]
    info = personal(client, mine)
    add_doc(client, mine, info["kb"]["id"], "差旅制度", f"{KEYWORD}：走财务邮箱。")

    # 我搜得到
    mine_hits = search(client, mine, info["orgId"], KEYWORD)
    assert mine_hits.status_code == 200, mine_hits.text
    assert len(mine_hits.json()) >= 1

    # 他在自己的个人库里搜同一句：没有命中（各自的私有组织互相看不到）
    other_info = personal(client, other)
    other_hits = search(client, other, other_info["orgId"], KEYWORD)
    assert other_hits.status_code == 200, other_hits.text
    assert other_hits.json() == []

    # 他直接指定我的 kbId：403（越权必须报错，不能返回空结果冒充「库里没资料」）
    denied = client.post(
        f"/api/orgs/{other_info['orgId']}/search",
        json={"query": KEYWORD, "kbId": info["kb"]["id"]},
        headers=auth_headers(other),
    )
    assert denied.status_code == 403, denied.text


def test_personal_space_rejects_new_members(client: TestClient) -> None:
    """把我自己的私有组织加人 → 403：这条不堵，隐私就只是一句话。"""
    mine = register(client, "me@example.com")["access"]
    register(client, "other@example.com")
    org_id = personal(client, mine)["orgId"]

    resp = client.post(
        f"/api/orgs/{org_id}/members",
        json={"email": "other@example.com", "role": "member"},
        headers=auth_headers(mine),
    )
    assert resp.status_code == 403, resp.text
    assert "个人空间" in resp.json()["detail"]


def test_personal_kb_supports_documents_and_trash(client: TestClient) -> None:
    """个人库不是"只读橱窗"：入库 / 列表 / 回收站 / 恢复都走同一套接口。"""
    token = register(client, "solo@example.com")["access"]
    kb_id = personal(client, token)["kb"]["id"]

    doc = add_doc(client, token, kb_id, "测试文档", f"{KEYWORD}：先填单子。")
    listed = client.get(f"/api/kbs/{kb_id}/documents", headers=auth_headers(token)).json()
    assert [item["id"] for item in listed] == [doc["id"]]

    client.delete(f"/api/kbs/{kb_id}/documents/{doc['id']}", headers=auth_headers(token))
    assert client.get(f"/api/kbs/{kb_id}/documents", headers=auth_headers(token)).json() == []
    trashed = client.get(
        f"/api/kbs/{kb_id}/documents?includeDeleted=true", headers=auth_headers(token)
    ).json()
    assert [item["id"] for item in trashed] == [doc["id"]]

    restored = client.post(
        f"/api/kbs/{kb_id}/documents/{doc['id']}/restore", headers=auth_headers(token)
    )
    assert restored.status_code == 200, restored.text
