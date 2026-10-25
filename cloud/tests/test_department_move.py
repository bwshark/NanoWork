"""部门移动（换父节点）与部门负责人（写权限）—— 2026-10-25。

## 为什么要单独一组

**移动**是唯一一个「一次写操作能同时改坏整棵树」的接口：自环、环、
超出层级上限（而且要把整棵子树的高度算进去）、新父下同名。四条里任何一条放过，
写进库的都是需要人工改数据库才能救的脏数据 —— 列表缩进会变得没有意义，
`subtree_ids` 会一路查下去。

**部门负责人**是权限模型的一次扩张，所以用例的重点不是「负责人能写」，
而是「扩张的边界在哪」：只对**有部门范围**的库生效。否则一个部门负责人
就能改全组织可见的库，写权限比读权限还宽。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register

KEYWORD = "报销流程"


def _setup(client: TestClient, *, member_email: str = "staff@move.example") -> dict:
    owner = register(client, "owner@move.example")
    member = register(client, member_email)
    org = client.post(
        "/api/orgs", json={"name": "Move Corp"}, headers=auth_headers(owner["access"])
    ).json()
    client.post(
        f"/api/orgs/{org['id']}/members",
        json={"email": member_email, "role": "member"},
        headers=auth_headers(owner["access"]),
    )
    return {
        "owner": owner["access"],
        "member": member["access"],
        "org": org["id"],
        "member_email": member_email,
    }


def _dept(client: TestClient, token: str, org: str, name: str, parent: str = "") -> dict:
    resp = client.post(
        f"/api/orgs/{org}/departments",
        json={"name": name, "parentId": parent or None},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _move(client: TestClient, token: str, department_id: str, parent_id: str):
    return client.patch(
        f"/api/departments/{department_id}",
        json={"parentId": parent_id},
        headers=auth_headers(token),
    )


def _tree(client: TestClient, token: str, org: str) -> list[dict]:
    resp = client.get(f"/api/orgs/{org}/departments", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


# —— 移动 ——


def test_move_to_another_parent(client: TestClient) -> None:
    ctx = _setup(client)
    a = _dept(client, ctx["owner"], ctx["org"], "技术部")
    b = _dept(client, ctx["owner"], ctx["org"], "平台组")

    resp = _move(client, ctx["owner"], b["id"], a["id"])

    assert resp.status_code == 200, resp.text
    assert resp.json()["parentId"] == a["id"]
    # 列表是「父在子前」的扁平顺序：移动后平台组要排在技术部之后
    order = [item["id"] for item in _tree(client, ctx["owner"], ctx["org"])]
    assert order.index(b["id"]) > order.index(a["id"])


def test_move_to_root_with_empty_string(client: TestClient) -> None:
    """`""` = 移到根。少了这一档就表达不了「把子部门提成根部门」。"""
    ctx = _setup(client)
    a = _dept(client, ctx["owner"], ctx["org"], "技术部")
    b = _dept(client, ctx["owner"], ctx["org"], "平台组", a["id"])

    resp = _move(client, ctx["owner"], b["id"], "")

    assert resp.status_code == 200, resp.text
    assert resp.json()["parentId"] == ""


def test_cannot_move_into_itself(client: TestClient) -> None:
    ctx = _setup(client)
    a = _dept(client, ctx["owner"], ctx["org"], "技术部")

    assert _move(client, ctx["owner"], a["id"], a["id"]).status_code == 422


def test_cannot_move_into_own_descendant(client: TestClient) -> None:
    """把父挂到子孙下面 = 环。这类脏数据只能靠手工改库救，必须在入口拦住。"""
    ctx = _setup(client)
    a = _dept(client, ctx["owner"], ctx["org"], "技术部")
    b = _dept(client, ctx["owner"], ctx["org"], "平台组", a["id"])
    c = _dept(client, ctx["owner"], ctx["org"], "前端组", b["id"])

    resp = _move(client, ctx["owner"], a["id"], c["id"])

    assert resp.status_code == 422
    assert "环" in resp.json()["detail"]
    # 没写进去
    tree = {item["id"]: item for item in _tree(client, ctx["owner"], ctx["org"])}
    assert tree[a["id"]]["parentId"] == ""


def test_depth_limit_counts_whole_subtree(client: TestClient) -> None:
    """层级上限按**子树高度**算：移动的是整棵子树，不是单个节点。

    只算「新父深度」的实现会把这条放过去（8 层父 + 2 层子树 = 9 层）。
    """
    ctx = _setup(client)
    chain = _dept(client, ctx["owner"], ctx["org"], "L1")
    for level in range(2, 8):  # L1..L7 → 最深的 L7 在第 7 层
        chain = _dept(client, ctx["owner"], ctx["org"], f"L{level}", chain["id"])
    top = _dept(client, ctx["owner"], ctx["org"], "待移动")
    _dept(client, ctx["owner"], ctx["org"], "待移动的子", top["id"])  # 高度 2

    resp = _move(client, ctx["owner"], top["id"], chain["id"])  # 第 7 层下 → 8 + 2 - 1 = 9

    assert resp.status_code == 422
    assert "9 层" in resp.json()["detail"]
    assert "1 层子部门" in resp.json()["detail"]


def test_move_rejects_duplicate_name_under_new_parent(client: TestClient) -> None:
    ctx = _setup(client)
    a = _dept(client, ctx["owner"], ctx["org"], "技术部")
    _dept(client, ctx["owner"], ctx["org"], "平台组", a["id"])
    loose = _dept(client, ctx["owner"], ctx["org"], "平台组")  # 根下的同名

    resp = _move(client, ctx["owner"], loose["id"], a["id"])

    assert resp.status_code == 409


def test_move_and_rename_in_one_request(client: TestClient) -> None:
    ctx = _setup(client)
    a = _dept(client, ctx["owner"], ctx["org"], "技术部")
    b = _dept(client, ctx["owner"], ctx["org"], "平台组")

    resp = client.patch(
        f"/api/departments/{b['id']}",
        json={"name": "平台组（新）", "parentId": a["id"]},
        headers=auth_headers(ctx["owner"]),
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "平台组（新）"
    assert resp.json()["parentId"] == a["id"]


def test_move_requires_admin(client: TestClient) -> None:
    ctx = _setup(client)
    a = _dept(client, ctx["owner"], ctx["org"], "技术部")
    b = _dept(client, ctx["owner"], ctx["org"], "平台组")

    assert _move(client, ctx["member"], b["id"], a["id"]).status_code == 403


# —— 部门负责人 ——


def _member_id(client: TestClient, token: str, org: str, email: str) -> str:
    rows = client.get(f"/api/orgs/{org}/members", headers=auth_headers(token)).json()
    return next(item["userId"] for item in rows if item["email"] == email)


def _set_role(client: TestClient, token: str, dept_id: str, user_id: str, role: str):
    return client.patch(
        f"/api/departments/{dept_id}/members/{user_id}",
        json={"role": role},
        headers=auth_headers(token),
    )


def test_manager_can_write_department_scoped_kb(client: TestClient) -> None:
    """普通成员 + 部门负责人 → 能维护「仅限本部门」的库。这是部门角色的实际用途。"""
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "人事部")
    client.post(
        f"/api/departments/{dept['id']}/members",
        json={"email": ctx["member_email"]},
        headers=auth_headers(ctx["owner"]),
    )
    kb = client.post(
        f"/api/orgs/{ctx['org']}/kbs",
        json={"name": "薪酬制度", "allowedDepartments": [dept["id"]]},
        headers=auth_headers(ctx["owner"]),
    ).json()

    # 先是普通成员：能读不能写
    assert (
        client.post(
            f"/api/kbs/{kb['id']}/documents",
            json={"title": "薪酬表", "content": KEYWORD},
            headers=auth_headers(ctx["member"]),
        ).status_code
        == 403
    )

    user_id = _member_id(client, ctx["owner"], ctx["org"], ctx["member_email"])
    assert _set_role(client, ctx["owner"], dept["id"], user_id, "manager").status_code == 200

    created = client.post(
        f"/api/kbs/{kb['id']}/documents",
        json={"title": "薪酬表", "content": f"{KEYWORD}：按职级发放。"},
        headers=auth_headers(ctx["member"]),
    )
    assert created.status_code == 201, created.text
    # 负责人的写权限包含删除（否则「只管加不管错」等于没有维护能力）
    assert (
        client.delete(
            f"/api/kbs/{kb['id']}/documents/{created.json()['id']}",
            headers=auth_headers(ctx["member"]),
        ).status_code
        == 204
    )


def test_manager_cannot_write_kb_without_department_scope(client: TestClient) -> None:
    """边界：**没有部门范围**的库，负责人也只有读权限。

    否则「某个部门的负责人」就能改一个全组织可见的库，写权限比读权限还宽。
    """
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "人事部")
    client.post(
        f"/api/departments/{dept['id']}/members",
        json={"email": ctx["member_email"]},
        headers=auth_headers(ctx["owner"]),
    )
    user_id = _member_id(client, ctx["owner"], ctx["org"], ctx["member_email"])
    _set_role(client, ctx["owner"], dept["id"], user_id, "manager")
    public = client.post(
        f"/api/orgs/{ctx['org']}/kbs", json={"name": "公开制度"}, headers=auth_headers(ctx["owner"])
    ).json()

    resp = client.post(
        f"/api/kbs/{public['id']}/documents",
        json={"title": "x", "content": f"{KEYWORD}：随便写。"},
        headers=auth_headers(ctx["member"]),
    )

    assert resp.status_code == 403


def test_manager_of_other_department_cannot_write(client: TestClient) -> None:
    """负责人只管自己那条线：技术部负责人碰不到「仅限人事部」的库。"""
    ctx = _setup(client)
    hr = _dept(client, ctx["owner"], ctx["org"], "人事部")
    tech = _dept(client, ctx["owner"], ctx["org"], "技术部")
    client.post(
        f"/api/departments/{tech['id']}/members",
        json={"email": ctx["member_email"]},
        headers=auth_headers(ctx["owner"]),
    )
    user_id = _member_id(client, ctx["owner"], ctx["org"], ctx["member_email"])
    _set_role(client, ctx["owner"], tech["id"], user_id, "manager")
    kb = client.post(
        f"/api/orgs/{ctx['org']}/kbs",
        json={"name": "薪酬制度", "allowedDepartments": [hr["id"]]},
        headers=auth_headers(ctx["owner"]),
    ).json()

    # 连读都读不到（不在人事部），写自然更不行
    assert (
        client.post(
            f"/api/kbs/{kb['id']}/documents",
            json={"title": "x", "content": KEYWORD},
            headers=auth_headers(ctx["member"]),
        ).status_code
        == 403
    )


def test_set_role_validation(client: TestClient) -> None:
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "人事部")
    user_id = _member_id(client, ctx["owner"], ctx["org"], ctx["member_email"])

    # 不在部门里的人不能直接给角色（先加人，再加角色）
    assert _set_role(client, ctx["owner"], dept["id"], user_id, "manager").status_code == 404

    client.post(
        f"/api/departments/{dept['id']}/members",
        json={"email": ctx["member_email"]},
        headers=auth_headers(ctx["owner"]),
    )
    assert _set_role(client, ctx["owner"], dept["id"], user_id, "owner").status_code == 422
    # 普通成员改不了别人的部门角色
    assert _set_role(client, ctx["member"], dept["id"], user_id, "manager").status_code == 403


def test_member_view_exposes_department_role(client: TestClient) -> None:
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "人事部")
    client.post(
        f"/api/departments/{dept['id']}/members",
        json={"email": ctx["member_email"]},
        headers=auth_headers(ctx["owner"]),
    )
    user_id = _member_id(client, ctx["owner"], ctx["org"], ctx["member_email"])
    _set_role(client, ctx["owner"], dept["id"], user_id, "manager")

    rows = client.get(
        f"/api/departments/{dept['id']}/members", headers=auth_headers(ctx["owner"])
    ).json()

    assert rows[0]["departmentRole"] == "manager"
    # 组织角色与部门角色是两个字段，不能混（这个是普通成员）
    assert rows[0]["role"] == "member"
