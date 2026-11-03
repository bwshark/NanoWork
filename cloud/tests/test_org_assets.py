"""组织资产（FR-2.6）。

这一组用例真正盯的不是「能不能发布」，而是三条**不该被绕过**的边界：

1. `test_member_cannot_publish` —— 发布是管理员动作。成员能发的话，「谁发的」就不再
   是一种背书，组织资产会退化成第二个公共网盘。
2. `test_reject_machine_specific_keys` —— `path` / `imBinding` 不能上云。客户端发布前
   会剥掉它们，服务端这一层是**兜底**：漏剥的客户端必须报错，而不是静默把别人的
   本机路径写进组织库。
3. `test_cross_org_asset_is_404` —— 拿 A 组织的资产 id 去 B 组织的路径下操作必须 404。
   只在「你是某组织管理员」这一层校验的话，多组织管理员就能跨组织改别人资产。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register

AGENT_PAYLOAD = {
    "name": "资深审稿人",
    "systemPrompt": "你是一位严格的学术审稿人，只指出问题、不写客套话。",
    "skillIds": ["builtin:review"],
    "toolAllow": ["read_file"],
}


def _org_with_members(client: TestClient) -> tuple[str, str, str]:
    """返回 (owner token, member token, org_id)。"""
    owner = register(client, "boss@corp.example")
    staff = register(client, "staff@corp.example")
    org = client.post(
        "/api/orgs", json={"name": "Corp"}, headers=auth_headers(owner["access"])
    ).json()
    resp = client.post(
        f"/api/orgs/{org['id']}/members",
        json={"email": "staff@corp.example", "role": "member"},
        headers=auth_headers(owner["access"]),
    )
    assert resp.status_code == 201, resp.text
    return owner["access"], staff["access"], org["id"]


def _publish(
    client: TestClient,
    token: str,
    org_id: str,
    *,
    kind: str = "agent",
    name: str = "审稿人",
    payload: dict | None = None,
    description: str = "",
) -> dict:
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={
            "kind": kind,
            "name": name,
            "description": description,
            "payload": AGENT_PAYLOAD if payload is None else payload,
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_member_sees_published_asset(client: TestClient) -> None:
    owner_token, staff_token, org_id = _org_with_members(client)
    asset = _publish(client, owner_token, org_id)

    listed = client.get(
        f"/api/orgs/{org_id}/assets", headers=auth_headers(staff_token)
    ).json()
    assert [row["id"] for row in listed] == [asset["id"]]
    # 全员可见包括「谁发的」——只给 id 的话界面还得再查一次
    assert listed[0]["publishedByEmail"] == "boss@corp.example"
    assert listed[0]["payload"]["systemPrompt"] == AGENT_PAYLOAD["systemPrompt"]


def test_kind_filter(client: TestClient) -> None:
    owner_token, _, org_id = _org_with_members(client)
    _publish(client, owner_token, org_id, kind="agent", name="专家")
    _publish(
        client,
        owner_token,
        org_id,
        kind="skill",
        name="技能",
        payload={"name": "技能", "prompt": "先读文件再回答"},
    )

    only_skill = client.get(
        f"/api/orgs/{org_id}/assets?kind=skill", headers=auth_headers(owner_token)
    ).json()
    assert [row["kind"] for row in only_skill] == ["skill"]

    # 未知 kind 按 400 处理，而不是「忽略参数返回全部」——后者会让筛选器静默失效
    bad = client.get(
        f"/api/orgs/{org_id}/assets?kind=nope", headers=auth_headers(owner_token)
    )
    assert bad.status_code == 400, bad.text


def test_member_cannot_publish(client: TestClient) -> None:
    _, staff_token, org_id = _org_with_members(client)
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={"kind": "agent", "name": "偷发的", "payload": AGENT_PAYLOAD},
        headers=auth_headers(staff_token),
    )
    # 403 而不是 404：他确实是成员，只是角色不够。两者必须能分清
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "权限不足"


def test_non_member_gets_404(client: TestClient) -> None:
    owner_token, _, org_id = _org_with_members(client)
    asset = _publish(client, owner_token, org_id)

    outsider = register(client, "outsider@other.example")
    headers = auth_headers(outsider["access"])
    assert client.get(f"/api/orgs/{org_id}/assets", headers=headers).status_code == 404
    assert (
        client.delete(
            f"/api/orgs/{org_id}/assets/{asset['id']}", headers=headers
        ).status_code
        == 404
    )


def test_reject_machine_specific_keys(client: TestClient) -> None:
    owner_token, _, org_id = _org_with_members(client)

    # 顶层 path：技能扫描结果天然带它，客户端漏剥就会走到这里
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={
            "kind": "skill",
            "name": "带路径的技能",
            "payload": {"prompt": "x", "path": "C:/Users/boss/.nanowork/skills/x"},
        },
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 400, resp.text
    assert "path" in resp.json()["detail"]

    # 嵌套 imBinding：专家的机器人绑定是账号专属
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={
            "kind": "agent",
            "name": "带机器人绑定的专家",
            "payload": {
                "systemPrompt": "x",
                "imBinding": {"platform": "wecom", "account": "bot-1"},
            },
        },
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 400, resp.text
    assert "imBinding" in resp.json()["detail"]


def test_reject_wrong_shape(client: TestClient) -> None:
    owner_token, _, org_id = _org_with_members(client)

    # 技能缺 prompt：发出去就是「点开一片空白」的坏数据
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={"kind": "skill", "name": "空技能", "payload": {"name": "空技能"}},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 400, resp.text
    assert "prompt" in resp.json()["detail"]

    # 提示词槽位种类只能是 mode / domain / style
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={
            "kind": "prompt",
            "name": "坏槽位",
            "payload": {"kind": "whatever", "key": "ask", "text": "x"},
        },
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 400, resp.text
    assert "mode / domain / style" in resp.json()["detail"]


def test_reject_oversize_payload(client: TestClient) -> None:
    owner_token, _, org_id = _org_with_members(client)
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={
            "kind": "prompt",
            "name": "巨长的提示词",
            "payload": {"kind": "mode", "key": "ask", "text": "x" * (65 * 1024)},
        },
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 400, resp.text
    assert "载荷过大" in resp.json()["detail"]


def test_update_asset(client: TestClient) -> None:
    owner_token, _, org_id = _org_with_members(client)
    asset = _publish(client, owner_token, org_id)

    resp = client.patch(
        f"/api/orgs/{org_id}/assets/{asset['id']}",
        json={"name": "改过名的审稿人", "payload": {"systemPrompt": "新正文"}},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "改过名的审稿人"
    assert body["payload"] == {"systemPrompt": "新正文"}
    # 改了一次之后 updatedAt 应当不低于 publishedAt
    assert body["updatedAt"] >= body["publishedAt"]


def test_update_revalidates_payload(client: TestClient) -> None:
    """PATCH 也要过校验：否则可以先发布一个合法技能，再改成没有 prompt 的空壳。"""
    owner_token, _, org_id = _org_with_members(client)
    asset = _publish(
        client, owner_token, org_id, kind="skill", payload={"prompt": "先读再答"}
    )
    resp = client.patch(
        f"/api/orgs/{org_id}/assets/{asset['id']}",
        json={"payload": {"anything": 1}},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 400, resp.text


def test_withdraw_removes_from_list(client: TestClient) -> None:
    owner_token, staff_token, org_id = _org_with_members(client)
    asset = _publish(client, owner_token, org_id)

    resp = client.delete(
        f"/api/orgs/{org_id}/assets/{asset['id']}", headers=auth_headers(owner_token)
    )
    assert resp.status_code == 204, resp.text
    listed = client.get(
        f"/api/orgs/{org_id}/assets", headers=auth_headers(staff_token)
    ).json()
    assert listed == []


def test_member_cannot_withdraw(client: TestClient) -> None:
    owner_token, staff_token, org_id = _org_with_members(client)
    asset = _publish(client, owner_token, org_id)
    resp = client.delete(
        f"/api/orgs/{org_id}/assets/{asset['id']}", headers=auth_headers(staff_token)
    )
    assert resp.status_code == 403, resp.text


def test_cross_org_asset_is_404(client: TestClient) -> None:
    """同一个人是两个组织的 owner：拿 A 的资产 id 去 B 的路径下操作必须 404。"""
    owner = register(client, "multi@corp.example")
    headers = auth_headers(owner["access"])
    org_a = client.post("/api/orgs", json={"name": "A"}, headers=headers).json()
    org_b = client.post("/api/orgs", json={"name": "B"}, headers=headers).json()
    asset = _publish(client, owner["access"], org_a["id"])

    assert (
        client.delete(
            f"/api/orgs/{org_b['id']}/assets/{asset['id']}", headers=headers
        ).status_code
        == 404
    )
    assert (
        client.patch(
            f"/api/orgs/{org_b['id']}/assets/{asset['id']}",
            json={"name": "越权改名"},
            headers=headers,
        ).status_code
        == 404
    )
    # A 组织里那份必须还在
    listed = client.get(f"/api/orgs/{org_a['id']}/assets", headers=headers).json()
    assert [row["name"] for row in listed] == ["审稿人"]


def test_unknown_kind_is_422(client: TestClient) -> None:
    """kind 不在闭集里：pydantic 直接 422（类型层面拦下，不进业务分支）。"""
    owner_token, _, org_id = _org_with_members(client)
    resp = client.post(
        f"/api/orgs/{org_id}/assets",
        json={"kind": "workflow", "name": "x", "payload": {}},
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 422, resp.text
