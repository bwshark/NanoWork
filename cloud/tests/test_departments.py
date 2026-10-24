"""部门树与「按部门收窄」的知识库可见性（FR-12.2 / FR-4.7）。

这一组的主角是**可见性**，不是 CRUD。部门存在的唯一目的是回答「这份资料该给谁看」，
所以每条权限规则都配一条反向用例：只看「能看到」的用例，一个永远返回 True 的实现
也能全绿。

必须钉住的四条：

1. **部门是收窄，不是放行**：`allowed_departments` 非空时，角色够 + 部门不对 → 仍然看不到。
2. **子树继承，但只往下**：共享给「技术部」= 技术线全可见；反过来不成立。
3. **两个入口一致**：列表里看不到的库，直接拿 id 也不能读（这是最容易漏的一条）。
4. **检索预过滤同步生效**：部门受限的库，其资料不得出现在结果里（否则等于没限）。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.orgs.departments import (
    MAX_DEPTH,
    child_depth,
    ordered_for_display,
    subtree_ids,
)
from app.orgs.models import Department
from tests.conftest import auth_headers, register

PASSWORD = "password123"  # noqa: S105 —— 测试账号


def _setup(client: TestClient) -> dict:
    """owner + 两个普通成员（one/two），返回 token 与 org。"""
    owner = register(client, "owner@dept.example")
    one = register(client, "one@dept.example")
    two = register(client, "two@dept.example")
    headers = auth_headers(owner["access"])
    org = client.post("/api/orgs", json={"name": "Dept Corp"}, headers=headers).json()
    for email in ("one@dept.example", "two@dept.example"):
        resp = client.post(
            f"/api/orgs/{org['id']}/members",
            json={"email": email, "role": "member"},
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
    return {
        "owner": owner["access"],
        "one": one["access"],
        "two": two["access"],
        "org": org["id"],
    }


def _mkdept(client: TestClient, token: str, org_id: str, name: str, parent: str | None = None):
    body: dict = {"name": name}
    if parent:
        body["parentId"] = parent
    return client.post(f"/api/orgs/{org_id}/departments", json=body, headers=auth_headers(token))


def _dept(
    client: TestClient, token: str, org_id: str, name: str, parent: str | None = None
) -> dict:
    resp = _mkdept(client, token, org_id, name, parent)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _add_member(client: TestClient, token: str, dept_id: str, email: str):
    return client.post(
        f"/api/departments/{dept_id}/members",
        json={"email": email},
        headers=auth_headers(token),
    )


def _mkb(client: TestClient, token: str, org_id: str, name: str, **extra) -> dict:
    resp = client.post(
        f"/api/orgs/{org_id}/kbs",
        json={"name": name, **extra},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _kb_ids(client: TestClient, token: str, org_id: str) -> list[str]:
    resp = client.get(f"/api/orgs/{org_id}/kbs", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return [item["id"] for item in resp.json()]


# —— 纯函数 ——


def _dep(dept_id: str, parent_id: str = "", name: str = "x") -> Department:
    return Department(id=dept_id, org_id="o1", parent_id=parent_id, name=name)


def test_subtree_includes_descendants_only_downwards() -> None:
    tree = [_dep("root"), _dep("child", "root"), _dep("grand", "child")]
    assert subtree_ids(tree, ["root"]) == {"root", "child", "grand"}
    assert subtree_ids(tree, ["child"]) == {"child", "grand"}
    # 只往下：从 child 出发拿不到 root
    assert "root" not in subtree_ids(tree, ["child"])


def test_subtree_tolerates_cycles() -> None:
    # 数据坏了（a→b→a）也不能把请求挂死
    tree = [_dep("a", "b"), _dep("b", "a")]
    assert subtree_ids(tree, ["a"]) == {"a", "b"}


def test_ordered_for_display_is_parent_before_child_and_keeps_orphans() -> None:
    tree = [
        _dep("b", "", "B"),
        _dep("a", "", "A"),
        _dep("b1", "b", "B1"),
        _dep("orphan", "gone", "孤儿"),
    ]
    names = [item.name for item in ordered_for_display(tree)]
    # 根按名字排序，子紧随父，孤儿不能被丢掉
    assert names.index("A") < names.index("B") < names.index("B1")
    assert "孤儿" in names


def test_child_depth_counts_new_node_level() -> None:
    tree = [_dep("root"), _dep("child", "root")]
    assert child_depth(tree, "") == 1
    assert child_depth(tree, "root") == 2
    assert child_depth(tree, "child") == 3
    assert child_depth(tree, "missing") == 0


# —— 路由：结构与权限 ——


def test_admin_creates_and_member_cannot(client: TestClient) -> None:
    ctx = _setup(client)
    created = _mkdept(client, ctx["owner"], ctx["org"], "技术部")
    assert created.status_code == 201
    assert created.json()["parentId"] == ""

    denied = _mkdept(client, ctx["one"], ctx["org"], "市场部")
    assert denied.status_code == 403


def test_non_member_gets_404(client: TestClient) -> None:
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "技术部")
    outsider = register(client, "outsider@dept.example")
    assert (
        client.get(
            f"/api/orgs/{ctx['org']}/departments", headers=auth_headers(outsider["access"])
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/api/departments/{dept['id']}/members", headers=auth_headers(outsider["access"])
        ).status_code
        == 404
    )


def test_duplicate_sibling_name_conflicts_but_different_parent_is_fine(client: TestClient) -> None:
    ctx = _setup(client)
    root = _dept(client, ctx["owner"], ctx["org"], "技术部")
    assert _mkdept(client, ctx["owner"], ctx["org"], "技术部").status_code == 409
    # 不同父下同名是正常的（技术部/前端、市场部/前端）
    assert _mkdept(client, ctx["owner"], ctx["org"], "前端", root["id"]).status_code == 201


def test_parent_must_exist_and_belong_to_same_org(client: TestClient) -> None:
    ctx = _setup(client)
    assert _mkdept(client, ctx["owner"], ctx["org"], "孤儿", "no-such").status_code == 422

    # 另一个组织的部门不能当父（否则会造出跨组织引用）
    other_owner = register(client, "boss2@dept.example")
    other_org = client.post(
        "/api/orgs", json={"name": "Other"}, headers=auth_headers(other_owner["access"])
    ).json()
    foreign = _dept(client, other_owner["access"], other_org["id"], "外部")
    assert _mkdept(client, ctx["owner"], ctx["org"], "挂错", foreign["id"]).status_code == 422


def test_depth_limit(client: TestClient) -> None:
    ctx = _setup(client)
    parent = ""
    for level in range(1, MAX_DEPTH + 1):
        node = _dept(client, ctx["owner"], ctx["org"], f"L{level}", parent or None)
        parent = node["id"]
    too_deep = _mkdept(client, ctx["owner"], ctx["org"], "L9", parent)
    assert too_deep.status_code == 422
    assert "层级" in too_deep.json()["detail"]


def test_list_is_ordered_and_counts_members(client: TestClient) -> None:
    ctx = _setup(client)
    root = _dept(client, ctx["owner"], ctx["org"], "技术部")
    child = _dept(client, ctx["owner"], ctx["org"], "前端", root["id"])
    assert _add_member(client, ctx["owner"], child["id"], "one@dept.example").status_code == 201

    rows = client.get(
        f"/api/orgs/{ctx['org']}/departments", headers=auth_headers(ctx["one"])
    ).json()
    assert [row["name"] for row in rows] == ["技术部", "前端"]
    assert rows[1]["memberCount"] == 1


def test_rename_rules(client: TestClient) -> None:
    ctx = _setup(client)
    root = _dept(client, ctx["owner"], ctx["org"], "技术部")
    _dept(client, ctx["owner"], ctx["org"], "市场部")
    renamed = client.patch(
        f"/api/departments/{root['id']}",
        json={"name": "研发部"},
        headers=auth_headers(ctx["owner"]),
    )
    assert renamed.status_code == 200 and renamed.json()["name"] == "研发部"

    conflict = client.patch(
        f"/api/departments/{root['id']}",
        json={"name": "市场部"},
        headers=auth_headers(ctx["owner"]),
    )
    assert conflict.status_code == 409


def test_delete_guards(client: TestClient) -> None:
    ctx = _setup(client)
    root = _dept(client, ctx["owner"], ctx["org"], "技术部")
    child = _dept(client, ctx["owner"], ctx["org"], "前端", root["id"])

    # 1) 有子部门
    assert (
        client.delete(
            f"/api/departments/{root['id']}", headers=auth_headers(ctx["owner"])
        ).status_code
        == 409
    )

    # 2) 有成员
    _add_member(client, ctx["owner"], child["id"], "one@dept.example")
    assert (
        client.delete(
            f"/api/departments/{child['id']}", headers=auth_headers(ctx["owner"])
        ).status_code
        == 409
    )

    # 3) 被知识库引用（删了会让那本库对谁都不可见）
    client.delete(
        f"/api/departments/{child['id']}/members/"
        + str(
            client.get(
                f"/api/departments/{child['id']}/members", headers=auth_headers(ctx["owner"])
            ).json()[0]["userId"]
        ),
        headers=auth_headers(ctx["owner"]),
    )
    _mkb(client, ctx["owner"], ctx["org"], "前端手册", allowedDepartments=[child["id"]])
    linked = client.delete(f"/api/departments/{child['id']}", headers=auth_headers(ctx["owner"]))
    assert linked.status_code == 409
    assert "可见范围" in linked.json()["detail"]

    # 4) 把库的部门范围清掉之后才能删
    client.patch(
        f"/api/kbs/{_kb_ids(client, ctx['owner'], ctx['org'])[-1]}/visibility",
        json={"name": "前端手册", "allowedDepartments": []},
        headers=auth_headers(ctx["owner"]),
    )
    assert (
        client.delete(
            f"/api/departments/{child['id']}", headers=auth_headers(ctx["owner"])
        ).status_code
        == 204
    )


def test_member_membership_requires_org_membership_and_is_idempotent(client: TestClient) -> None:
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "技术部")

    outsider = register(client, "nobody@dept.example")
    resp = _add_member(client, ctx["owner"], dept["id"], "nobody@dept.example")
    assert resp.status_code == 422  # 部门不是邀请入口
    assert "先加入组织" in resp.json()["detail"]

    assert _add_member(client, ctx["owner"], dept["id"], "one@dept.example").status_code == 201
    again = _add_member(client, ctx["owner"], dept["id"], "one@dept.example")
    assert again.status_code == 201  # 幂等：不报错、不产生第二行

    members = client.get(
        f"/api/departments/{dept['id']}/members", headers=auth_headers(ctx["owner"])
    ).json()
    assert [item["email"] for item in members] == ["one@dept.example"]
    assert members[0]["role"] == "member"
    # outsider 只是注册了，没有进入组织
    assert outsider["access"]


# —— 可见性：部门是收窄 ——


def test_department_scope_narrows_visibility(client: TestClient) -> None:
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "人事部")
    _add_member(client, ctx["owner"], dept["id"], "one@dept.example")
    kb = _mkb(client, ctx["owner"], ctx["org"], "薪酬制度", allowedDepartments=[dept["id"]])
    assert kb["allowedDepartments"] == [dept["id"]]

    # 人事部的人看得到
    assert kb["id"] in _kb_ids(client, ctx["one"], ctx["org"])
    # 不在部门的成员看不到（列表 + 直接按 id + 文档列表三个入口都要一致）
    assert kb["id"] not in _kb_ids(client, ctx["two"], ctx["org"])
    assert (
        client.get(f"/api/kbs/{kb['id']}/documents", headers=auth_headers(ctx["two"])).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/kbs/{kb['id']}/documents",
            json={"title": "x", "content": "y"},
            headers=auth_headers(ctx["two"]),
        ).status_code
        == 403
    )


def test_department_scope_inherits_downwards_only(client: TestClient) -> None:
    ctx = _setup(client)
    root = _dept(client, ctx["owner"], ctx["org"], "技术部")
    child = _dept(client, ctx["owner"], ctx["org"], "前端", root["id"])
    _add_member(client, ctx["owner"], child["id"], "one@dept.example")  # one 只在前端
    _add_member(client, ctx["owner"], root["id"], "two@dept.example")  # two 只在技术部

    parent_kb = _mkb(client, ctx["owner"], ctx["org"], "技术规范", allowedDepartments=[root["id"]])
    child_kb = _mkb(client, ctx["owner"], ctx["org"], "前端规范", allowedDepartments=[child["id"]])

    # 共享给父部门 → 子部门的人也能看（往下继承）
    assert parent_kb["id"] in _kb_ids(client, ctx["one"], ctx["org"])
    # 共享给子部门 → 父部门直属的人看不到（不往上）
    assert child_kb["id"] not in _kb_ids(client, ctx["two"], ctx["org"])
    assert child_kb["id"] in _kb_ids(client, ctx["one"], ctx["org"])


def test_role_still_required_when_department_matches(client: TestClient) -> None:
    """部门对但角色不够 → 还是看不到。两条是 AND，不是 OR。"""
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "管理层")
    _add_member(client, ctx["owner"], dept["id"], "one@dept.example")  # one 是 member

    kb = _mkb(
        client,
        ctx["owner"],
        ctx["org"],
        "经营数据",
        allowedRoles=["admin", "owner"],
        allowedDepartments=[dept["id"]],
    )
    assert kb["id"] not in _kb_ids(client, ctx["one"], ctx["org"])

    # 升成 admin 后能看到 —— 但这是**管理豁免**在起作用（见 visibility 文件头），
    # 不是「部门与角色都满足」。两者要分开验，否则会误以为 AND 生效了。
    one_id = next(
        item["userId"]
        for item in client.get(
            f"/api/orgs/{ctx['org']}/members", headers=auth_headers(ctx["owner"])
        ).json()
        if item["email"] == "one@dept.example"
    )
    client.patch(
        f"/api/orgs/{ctx['org']}/members/{one_id}",
        json={"role": "admin"},
        headers=auth_headers(ctx["owner"]),
    )
    assert kb["id"] in _kb_ids(client, ctx["one"], ctx["org"])


def test_moving_department_takes_effect_immediately(client: TestClient) -> None:
    ctx = _setup(client)
    tech = _dept(client, ctx["owner"], ctx["org"], "技术部")
    market = _dept(client, ctx["owner"], ctx["org"], "市场部")
    _add_member(client, ctx["owner"], tech["id"], "one@dept.example")
    kb = _mkb(client, ctx["owner"], ctx["org"], "技术资料")

    # 先改成只给技术部看
    patched = client.patch(
        f"/api/kbs/{kb['id']}/visibility",
        json={"name": "技术资料", "allowedDepartments": [tech["id"]]},
        headers=auth_headers(ctx["owner"]),
    )
    assert patched.status_code == 200
    assert kb["id"] in _kb_ids(client, ctx["one"], ctx["org"])

    # 把人挪到市场部 → 立刻看不到（没有缓存，每次现算）
    user_id = client.get(
        f"/api/departments/{tech['id']}/members", headers=auth_headers(ctx["owner"])
    ).json()[0]["userId"]
    client.delete(
        f"/api/departments/{tech['id']}/members/{user_id}", headers=auth_headers(ctx["owner"])
    )
    _add_member(client, ctx["owner"], market["id"], "one@dept.example")
    assert kb["id"] not in _kb_ids(client, ctx["one"], ctx["org"])


def test_clearing_departments_restores_role_only_visibility(client: TestClient) -> None:
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "人事部")
    kb = _mkb(client, ctx["owner"], ctx["org"], "制度", allowedDepartments=[dept["id"]])
    assert kb["id"] not in _kb_ids(client, ctx["two"], ctx["org"])

    cleared = client.patch(
        f"/api/kbs/{kb['id']}/visibility",
        json={"name": "制度", "allowedDepartments": []},
        headers=auth_headers(ctx["owner"]),
    )
    assert cleared.status_code == 200
    assert cleared.json()["allowedDepartments"] == []
    # 清空 = 不按部门收窄（存量行为），不是"谁都看不到"
    assert kb["id"] in _kb_ids(client, ctx["two"], ctx["org"])


def test_foreign_department_id_is_rejected(client: TestClient) -> None:
    ctx = _setup(client)
    other_owner = register(client, "boss3@dept.example")
    other_org = client.post(
        "/api/orgs", json={"name": "Other2"}, headers=auth_headers(other_owner["access"])
    ).json()
    foreign = _dept(client, other_owner["access"], other_org["id"], "外部部门")

    resp = client.post(
        f"/api/orgs/{ctx['org']}/kbs",
        json={"name": "跨组织", "allowedDepartments": [foreign["id"]]},
        headers=auth_headers(ctx["owner"]),
    )
    assert resp.status_code == 422
    assert "不属于本组织" in resp.json()["detail"]


def test_search_prefilter_respects_departments(client: TestClient) -> None:
    """最要紧的一条：部门受限的库，其资料不得出现在检索结果里。

    只测「文档列表看不到」是不够的——检索是另一条路径（`kbChunks IN scope_ids`），
    漏改它等于内容照样能被搜出来。
    """
    ctx = _setup(client)
    dept = _dept(client, ctx["owner"], ctx["org"], "人事部")
    _add_member(client, ctx["owner"], dept["id"], "one@dept.example")
    secret = _mkb(client, ctx["owner"], ctx["org"], "薪酬", allowedDepartments=[dept["id"]])
    public = _mkb(client, ctx["owner"], ctx["org"], "公开")

    client.post(
        f"/api/kbs/{secret['id']}/documents",
        json={"title": "薪酬表", "content": "报销流程与薪酬发放说明"},
        headers=auth_headers(ctx["owner"]),
    )
    client.post(
        f"/api/kbs/{public['id']}/documents",
        json={"title": "公开制度", "content": "报销流程：走财务邮箱"},
        headers=auth_headers(ctx["owner"]),
    )

    # two 不在人事部：只能搜到公开库那一篇
    hits = client.post(
        f"/api/orgs/{ctx['org']}/search",
        json={"query": "报销流程", "topK": 50},
        headers=auth_headers(ctx["two"]),
    ).json()
    assert [hit["docTitle"] for hit in hits] == ["公开制度"]

    # one 在人事部：两篇都能搜到
    hits_one = client.post(
        f"/api/orgs/{ctx['org']}/search",
        json={"query": "报销流程", "topK": 50},
        headers=auth_headers(ctx["one"]),
    ).json()
    assert {hit["docTitle"] for hit in hits_one} == {"薪酬表", "公开制度"}
