"""项目空间（FR-12.7）。

这一组用例的两个主角都不是「能不能建项目」，而是**两条不许被项目绕过的边界**：

1. `test_project_kb_list_hides_invisible_kb` —— 项目里关联了一本我看不到的库时，
   项目详情**不能露出它的标题与文档数**。否则 `project_kbs` 就成了绕过
   `visibility.allows()` 的第二条通路，症状正是个人知识库那轮见过的
   「团队列表里看不到、换个页面却看得到」。
2. `test_lead_cannot_add_kb_they_cannot_read` —— 把看不到的库加进项目这个动作本身
   就是确认了「这个 id 存在」。所以加库时要先过读权限，而不是等列表再过滤。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register


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


def _create_project(client: TestClient, token: str, org_id: str, name: str = "登月计划") -> dict:
    resp = client.post(
        f"/api/orgs/{org_id}/projects",
        json={"name": name, "description": "一号项目"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_kb(
    client: TestClient, token: str, org_id: str, name: str, roles: list[str] | None = None
) -> dict:
    body: dict = {"name": name}
    if roles is not None:
        body["allowedRoles"] = roles
    resp = client.post(f"/api/orgs/{org_id}/kbs", json=body, headers=auth_headers(token))
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_project_makes_creator_lead(client: TestClient) -> None:
    owner_token, member_token, org = _org_with_members(client)
    project = _create_project(client, member_token, org["id"])
    assert project["myRole"] == "lead"
    assert project["canManage"] is True
    assert project["memberCount"] == 1
    assert project["archivedAt"] == ""

    listed = client.get(
        f"/api/orgs/{org['id']}/projects", headers=auth_headers(owner_token)
    ).json()
    assert [p["id"] for p in listed] == [project["id"]]
    # 组织管理员即便不是项目成员也应当能管（管理豁免，与知识库同口径）
    assert listed[0]["myRole"] == ""
    assert listed[0]["canManage"] is True


def test_non_org_member_gets_404(client: TestClient) -> None:
    owner_token, _, org = _org_with_members(client)
    project = _create_project(client, owner_token, org["id"])
    outsider = register(client, "outsider@other.example")
    headers = auth_headers(outsider["access"])

    assert client.get(f"/api/orgs/{org['id']}/projects", headers=headers).status_code == 404
    assert client.get(f"/api/projects/{project['id']}", headers=headers).status_code == 404
    # 404 而不是 403：403 等于承认「项目存在，只是你没权限」
    assert (
        client.patch(
            f"/api/projects/{project['id']}", json={"name": "x"}, headers=headers
        ).status_code
        == 404
    )


def test_member_can_view_but_not_manage(client: TestClient) -> None:
    owner_token, member_token, org = _org_with_members(client)
    project = _create_project(client, owner_token, org["id"])

    detail = client.get(f"/api/projects/{project['id']}", headers=auth_headers(member_token))
    assert detail.status_code == 200
    assert detail.json()["project"]["myRole"] == ""
    assert detail.json()["project"]["canManage"] is False

    resp = client.patch(
        f"/api/projects/{project['id']}",
        json={"name": "改名"},
        headers=auth_headers(member_token),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "需要项目负责人或组织管理员"


def test_add_member_requires_org_membership(client: TestClient) -> None:
    owner_token, member_token, org = _org_with_members(client)
    project = _create_project(client, owner_token, org["id"])
    register(client, "stranger@other.example")

    resp = client.post(
        f"/api/projects/{project['id']}/members",
        json={"email": "stranger@other.example"},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "该用户不是本组织成员"

    ok = client.post(
        f"/api/projects/{project['id']}/members",
        json={"email": "staff@corp.example"},
        headers=auth_headers(owner_token),
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["role"] == "member"

    # 重复加入是 409，不静默幂等（否则界面会显示两条相同成员）
    dup = client.post(
        f"/api/projects/{project['id']}/members",
        json={"email": "staff@corp.example"},
        headers=auth_headers(owner_token),
    )
    assert dup.status_code == 409

    removed = client.delete(
        f"/api/projects/{project['id']}/members/{ok.json()['userId']}",
        headers=auth_headers(owner_token),
    )
    assert removed.status_code == 204
    assert (
        client.delete(
            f"/api/projects/{project['id']}/members/{ok.json()['userId']}",
            headers=auth_headers(owner_token),
        ).status_code
        == 404
    )


def test_add_kb_rejects_foreign_org_kb(client: TestClient) -> None:
    owner_token, _, org = _org_with_members(client)
    project = _create_project(client, owner_token, org["id"])

    other = register(client, "boss2@other.example")
    other_org = client.post(
        "/api/orgs", json={"name": "Other"}, headers=auth_headers(other["access"])
    ).json()
    foreign_kb = _create_kb(client, other["access"], other_org["id"], "别人的库")

    resp = client.post(
        f"/api/projects/{project['id']}/kbs",
        json={"kbId": foreign_kb["id"]},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "知识库不存在"


def test_project_kb_list_hides_invisible_kb(client: TestClient) -> None:
    """项目关联了 member 看不到的库 → 详情里不能出现（否则等于绕过可见性）。"""
    owner_token, member_token, org = _org_with_members(client)
    project = _create_project(client, owner_token, org["id"])
    admin_only = _create_kb(client, owner_token, org["id"], "只给管理员", ["admin", "owner"])

    added = client.post(
        f"/api/projects/{project['id']}/kbs",
        json={"kbId": admin_only["id"]},
        headers=auth_headers(owner_token),
    )
    assert added.status_code == 201, added.text

    owner_view = client.get(
        f"/api/projects/{project['id']}", headers=auth_headers(owner_token)
    ).json()
    assert [kb["id"] for kb in owner_view["kbs"]] == [admin_only["id"]]
    assert owner_view["project"]["kbCount"] == 1

    member_view = client.get(
        f"/api/projects/{project['id']}", headers=auth_headers(member_token)
    ).json()
    assert member_view["kbs"] == []
    assert member_view["project"]["kbCount"] == 0


def test_lead_cannot_add_kb_they_cannot_read(client: TestClient) -> None:
    owner_token, member_token, org = _org_with_members(client)
    # member 在组织里也是普通成员，且不是管理员 → 自己是 lead，但不能读管理员专用库
    project = _create_project(client, member_token, org["id"])
    admin_only = _create_kb(client, owner_token, org["id"], "只给管理员", ["admin", "owner"])

    resp = client.post(
        f"/api/projects/{project['id']}/kbs",
        json={"kbId": admin_only["id"]},
        headers=auth_headers(member_token),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "你无权访问该知识库，不能加进项目"


def test_archive_hides_from_default_list(client: TestClient) -> None:
    owner_token, _, org = _org_with_members(client)
    project = _create_project(client, owner_token, org["id"])

    archived = client.patch(
        f"/api/projects/{project['id']}",
        json={"archived": True},
        headers=auth_headers(owner_token),
    )
    assert archived.status_code == 200
    assert archived.json()["archivedAt"] != ""

    assert client.get(f"/api/orgs/{org['id']}/projects", headers=auth_headers(owner_token)).json() == []
    listed = client.get(
        f"/api/orgs/{org['id']}/projects?includeArchived=true",
        headers=auth_headers(owner_token),
    ).json()
    assert [p["id"] for p in listed] == [project["id"]]

    restored = client.patch(
        f"/api/projects/{project['id']}",
        json={"archived": False},
        headers=auth_headers(owner_token),
    )
    assert restored.json()["archivedAt"] == ""


def test_delete_project_clears_links(client: TestClient) -> None:
    owner_token, member_token, org = _org_with_members(client)
    project = _create_project(client, owner_token, org["id"])
    kb = _create_kb(client, owner_token, org["id"], "制度")
    client.post(
        f"/api/projects/{project['id']}/kbs",
        json={"kbId": kb["id"]},
        headers=auth_headers(owner_token),
    )
    client.post(
        f"/api/projects/{project['id']}/members",
        json={"email": "staff@corp.example"},
        headers=auth_headers(owner_token),
    )

    # lead（这里是 owner，同时也是项目 lead）不能删项目，只有组织管理员能删
    created_by_member = _create_project(client, member_token, org["id"], "member 的项目")
    resp = client.delete(
        f"/api/projects/{created_by_member['id']}", headers=auth_headers(member_token)
    )
    assert resp.status_code == 403

    assert (
        client.delete(
            f"/api/projects/{project['id']}", headers=auth_headers(owner_token)
        ).status_code
        == 204
    )
    assert client.get(f"/api/projects/{project['id']}", headers=auth_headers(owner_token)).status_code == 404

    # 关联表跟着清干净：不该留下孤儿行（新项目复用同一个 id 时才看得出来，
    # 所以这里直接按库 id 反查项目列表）
    listed = client.get(f"/api/orgs/{org['id']}/projects", headers=auth_headers(owner_token)).json()
    assert [p["id"] for p in listed] == [created_by_member["id"]]
