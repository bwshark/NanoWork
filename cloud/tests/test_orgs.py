"""组织与角色（FR-12.2 MVP）：六条反直觉的语义各有一例。

这一组用例的价值不在「接口能通」，而在三条**一旦写错就静默放权**的判定：
1. 非成员看到的是 404（不是 403）——403 等于确认组织存在；
2. 不能授予高于自己的角色——否则每次「多邀一个 admin」都可能是权限提升的台阶；
3. 最后一个 owner 不能降级/移除——否则组织变成没人能任命 owner 的孤儿。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register


def create_org(client: TestClient, token: str, name: str = "Acme") -> dict:
    resp = client.post("/api/orgs", json={"name": name}, headers=auth_headers(token))
    assert resp.status_code == 201, resp.text
    return resp.json()


def add_member(client: TestClient, token: str, org_id: str, email: str, role: str) -> dict:
    resp = client.post(
        f"/api/orgs/{org_id}/members",
        json={"email": email, "role": role},
        headers=auth_headers(token),
    )
    return {"status": resp.status_code, "body": resp.json() if resp.content else None}


def two_users(client: TestClient) -> tuple[str, str, dict, dict]:
    owner = register(client, "owner@example.com")
    other = register(client, "other@example.com")
    return (
        owner["access"],
        other["access"],
        owner["user"],
        other["user"],
    )


def test_creator_becomes_owner_and_org_shows_up(client: TestClient) -> None:
    token = register(client, "solo@example.com")["access"]
    org = create_org(client, token)

    assert org["role"] == "owner"
    assert org["memberCount"] == 1

    listed = client.get("/api/orgs", headers=auth_headers(token)).json()
    assert [item["id"] for item in listed] == [org["id"]]
    assert listed[0]["role"] == "owner"


def test_non_member_gets_404_not_403(client: TestClient) -> None:
    """非成员：404（不泄露组织存在性）。这是本文件最重要的一条。"""
    owner_token, _, _, _ = two_users(client)
    outsider_token = register(client, "outsider@example.com")["access"]
    org = create_org(client, owner_token)

    resp = client.get(f"/api/orgs/{org['id']}/members", headers=auth_headers(outsider_token))
    assert resp.status_code == 404
    # 与「组织 id 根本不存在」返回同一种错误，才叫不泄露
    missing = client.get("/api/orgs/no-such-org/members", headers=auth_headers(outsider_token))
    assert missing.status_code == 404
    assert missing.json()["detail"] == resp.json()["detail"]


def test_member_cannot_manage_members(client: TestClient) -> None:
    owner_token, member_token, _, member_user = two_users(client)
    org = create_org(client, owner_token)
    added = add_member(client, owner_token, org["id"], "other@example.com", "member")
    assert added["status"] == 201

    # member 可以看成员列表
    assert (
        client.get(f"/api/orgs/{org['id']}/members", headers=auth_headers(member_token)).status_code
        == 200
    )
    # 但不能拉人、不能改角色
    denied_add = add_member(client, member_token, org["id"], "outsider2@example.com", "member")
    assert denied_add["status"] == 403
    denied_patch = client.patch(
        f"/api/orgs/{org['id']}/members/{member_user['id']}",
        json={"role": "admin"},
        headers=auth_headers(member_token),
    )
    assert denied_patch.status_code == 403


def test_admin_cannot_grant_owner(client: TestClient) -> None:
    """admin 能升 admin，但**不能**升 owner（不能授予高于自己的角色）。"""
    owner_token, admin_token, _, _ = two_users(client)
    org = create_org(client, owner_token)
    assert add_member(client, owner_token, org["id"], "other@example.com", "admin")["status"] == 201

    third = register(client, "third@example.com")
    assert (
        add_member(client, admin_token, org["id"], "third@example.com", "member")["status"] == 201
    )
    resp = client.patch(
        f"/api/orgs/{org['id']}/members/{third['user']['id']}",
        json={"role": "owner"},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "不能授予高于自己的角色"


def test_last_owner_cannot_be_demoted_or_removed(client: TestClient) -> None:
    me = register(client, "lonely@example.com")
    token = me["access"]
    org = create_org(client, token)
    user_id = me["user"]["id"]

    demote = client.patch(
        f"/api/orgs/{org['id']}/members/{user_id}",
        json={"role": "member"},
        headers=auth_headers(token),
    )
    assert demote.status_code == 409
    assert "owner" in demote.json()["detail"]

    leave = client.delete(f"/api/orgs/{org['id']}/members/{user_id}", headers=auth_headers(token))
    assert leave.status_code == 409


def test_second_owner_allows_demoting_first(client: TestClient) -> None:
    """有两个 owner 时，降级其中一个必须成功——否则「最后一个 owner」判定写成了「不能降级」。"""
    owner_token, _, _, other_user = two_users(client)
    org = create_org(client, owner_token)
    add_member(client, owner_token, org["id"], "other@example.com", "owner")

    resp = client.patch(
        f"/api/orgs/{org['id']}/members/{other_user['id']}",
        json={"role": "admin"},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 200
    assert resp.json()["role"] == "admin"


def test_member_can_leave_but_not_kick_others(client: TestClient) -> None:
    owner_token, member_token, _, member_user = two_users(client)
    org = create_org(client, owner_token)
    add_member(client, owner_token, org["id"], "other@example.com", "member")
    third = register(client, "third2@example.com")
    add_member(client, owner_token, org["id"], "third2@example.com", "member")

    # 踢别人 → 403
    kicked = client.delete(
        f"/api/orgs/{org['id']}/members/{third['user']['id']}", headers=auth_headers(member_token)
    )
    assert kicked.status_code == 403
    # 退出自己 → 204（不需要管理员权限）
    left = client.delete(
        f"/api/orgs/{org['id']}/members/{member_user['id']}", headers=auth_headers(member_token)
    )
    assert left.status_code == 204
    assert client.get("/api/orgs", headers=auth_headers(member_token)).json() == []


def test_add_unknown_email_reports_clearly(client: TestClient) -> None:
    token = register(client, "boss@example.com")["access"]
    org = create_org(client, token)
    result = add_member(client, token, org["id"], "ghost@example.com", "member")
    assert result["status"] == 404
    assert "还没有账户" in result["body"]["detail"]


def test_duplicate_member_is_409(client: TestClient) -> None:
    token = register(client, "boss2@example.com")["access"]
    org = create_org(client, token)
    register(client, "dup@example.com")
    assert add_member(client, token, org["id"], "dup@example.com", "member")["status"] == 201
    again = add_member(client, token, org["id"], "dup@example.com", "admin")
    assert again["status"] == 409


def test_invalid_role_is_422(client: TestClient) -> None:
    token = register(client, "boss3@example.com")["access"]
    org = create_org(client, token)
    register(client, "x@example.com")
    assert add_member(client, token, org["id"], "x@example.com", "superuser")["status"] == 422
