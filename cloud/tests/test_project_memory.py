"""项目共享记忆（FR-12.7 ③）。

三条主角都不是「能不能存一段文字」：

1. `test_member_reads_but_cannot_write` —— 成员**只读**，而且**读得到**。
   把读权限也收窄到项目成员只会让普通成员以为「这个项目没有共享记忆」，
   而它其实每轮都被注入了提示词 —— 看不见的注入是最难查的一类不一致。
2. `test_stale_rev_is_conflict` —— 并发保存必须 409。共享记忆是**多写者**场景，
   每人补的是不同事实，LWW 的表现正是「B 保存后 A 补的两段凭空消失」：
   没有报错、没有痕迹，只有某天发现内容少了。
3. `test_non_org_member_gets_404` —— 跨组织一律 404（不是 403）。
   与项目详情同一条纪律：403 等于承认「这个项目存在，只是你没权限」。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.projects.routes import PROJECT_MEMORY_MAX_CHARS
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


def test_empty_memory_reads_as_blank(client: TestClient) -> None:
    owner, _, org = _org_with_members(client)
    project = _create_project(client, owner, org["id"])

    body = client.get(
        f"/api/projects/{project['id']}/memory", headers=auth_headers(owner)
    ).json()
    # 空串 + rev 0 = 「还没人写过」，不是「写过又清空了」——两者界面文案不同
    assert body["text"] == ""
    assert body["rev"] == 0
    assert body["updatedAt"] == ""
    assert body["updatedBy"] == ""
    # 创建者自动是 lead，因此能改
    assert body["canEdit"] is True
    assert body["maxChars"] == PROJECT_MEMORY_MAX_CHARS


def test_lead_writes_and_rev_advances(client: TestClient) -> None:
    owner, _, org = _org_with_members(client)
    project = _create_project(client, owner, org["id"])

    first = client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "## 约定\n\n- 每周一同步", "rev": 0},
        headers=auth_headers(owner),
    )
    assert first.status_code == 200, first.text
    assert first.json()["rev"] == 1
    assert first.json()["text"].startswith("## 约定")
    assert first.json()["updatedAt"] != ""
    assert first.json()["updatedBy"] == "boss@corp.example"

    second = client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "改过的正文", "rev": 1},
        headers=auth_headers(owner),
    )
    assert second.status_code == 200, second.text
    assert second.json()["rev"] == 2

    # 再读一次：落库的确实是最新那版（不是只回了响应体）
    read = client.get(
        f"/api/projects/{project['id']}/memory", headers=auth_headers(owner)
    ).json()
    assert read["text"] == "改过的正文"
    assert read["rev"] == 2


def test_member_reads_but_cannot_write(client: TestClient) -> None:
    owner, member, org = _org_with_members(client)
    project = _create_project(client, owner, org["id"])
    client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "lead 写的", "rev": 0},
        headers=auth_headers(owner),
    )

    read = client.get(
        f"/api/projects/{project['id']}/memory", headers=auth_headers(member)
    )
    assert read.status_code == 200, read.text
    assert read.json()["text"] == "lead 写的"
    # 读得到，但界面不该显示编辑入口 —— canEdit 由服务端算
    assert read.json()["canEdit"] is False

    write = client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "member 想改", "rev": 1},
        headers=auth_headers(member),
    )
    assert write.status_code == 403, write.text


def test_org_admin_can_write_without_being_member(client: TestClient) -> None:
    """组织管理员有管理豁免（与改名/加人同一条权限线，不是新开一条）。"""
    owner, member, org = _org_with_members(client)
    project = _create_project(client, member, org["id"])

    resp = client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "管理员补的", "rev": 0},
        headers=auth_headers(owner),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["canEdit"] is True


def test_stale_rev_is_conflict(client: TestClient) -> None:
    owner, member, org = _org_with_members(client)
    project = _create_project(client, owner, org["id"])

    # 两人都读到 rev=0
    client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "A 补的一段", "rev": 0},
        headers=auth_headers(owner),
    )
    # B 拿着过期的 rev 保存 —— 必须报错，不能把 A 那段悄悄覆盖掉
    resp = client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "B 写的另一版", "rev": 0},
        headers=auth_headers(owner),
    )
    assert resp.status_code == 409, resp.text

    read = client.get(
        f"/api/projects/{project['id']}/memory", headers=auth_headers(owner)
    ).json()
    assert read["text"] == "A 补的一段"
    assert read["rev"] == 1


def test_over_limit_is_rejected_not_truncated(client: TestClient) -> None:
    owner, _, org = _org_with_members(client)
    project = _create_project(client, owner, org["id"])

    resp = client.put(
        f"/api/projects/{project['id']}/memory",
        json={"text": "字" * (PROJECT_MEMORY_MAX_CHARS + 1), "rev": 0},
        headers=auth_headers(owner),
    )
    # 400 而不是截断：截断是静默丢内容，用户看到的是「保存成功」
    assert resp.status_code == 400, resp.text
    read = client.get(
        f"/api/projects/{project['id']}/memory", headers=auth_headers(owner)
    ).json()
    assert read["text"] == ""
    assert read["rev"] == 0


def test_non_org_member_gets_404(client: TestClient) -> None:
    owner, _, org = _org_with_members(client)
    project = _create_project(client, owner, org["id"])
    outsider = register(client, "outsider@other.example")

    headers = auth_headers(outsider["access"])
    assert client.get(f"/api/projects/{project['id']}/memory", headers=headers).status_code == 404
    assert (
        client.put(
            f"/api/projects/{project['id']}/memory",
            json={"text": "越权", "rev": 0},
            headers=headers,
        ).status_code
        == 404
    )
