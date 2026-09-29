"""批次 6a 服务端：账户导出 / 彻底删除账户（规格 §2.1 / §2.2，判据 J-A1~J-A4）。"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register


def push(
    client: TestClient,
    token: str,
    changes: list[dict] | None = None,
    events: list[dict] | None = None,
) -> dict:
    resp = client.post(
        "/api/sync/push",
        json={"changes": changes or [], "events": events or []},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def fetch_export(client: TestClient, token: str) -> dict:
    resp = client.get("/api/account/export", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def entity(eid: str, rev: int = 1, **extra: object) -> dict:
    base: dict[str, object] = {"id": eid, "rev": rev, "updatedAt": "2026-01-01T00:00:00.000Z"}
    base.update(extra)
    return base


def event(event_id: str, session_id: str = "s1", seq: int = 1, **extra: object) -> dict:
    base: dict[str, object] = {
        "id": event_id,
        "sessionId": session_id,
        "seq": seq,
        "type": "message",
        "timestamp": 1000 + seq,
    }
    base.update(extra)
    return base


# ─────────────────────────── J-A1 ───────────────────────────


def test_export_returns_all_items_and_events(client: TestClient) -> None:
    token = register(client, "exp-all@example.com")["access"]

    push(
        client,
        token,
        changes=[
            {"collection": "agents", "entity": entity("a1", name="A")},
            {"collection": "expertGroups", "entity": entity("g1", name="G")},
        ],
        events=[event("e-1", seq=1), event("e-2", seq=2)],
    )

    payload = fetch_export(client, token)

    assert payload["format"] == "nanowork-cloud-export"
    assert payload["formatVersion"] == 1
    assert payload["exportedAt"].endswith("Z")
    assert payload["user"]["email"] == "exp-all@example.com"
    assert payload["user"]["id"]
    assert payload["user"]["createdAt"].endswith("Z")

    assert {(i["collection"], i["entity"]["id"]) for i in payload["items"]} == {
        ("agents", "a1"),
        ("expertGroups", "g1"),
    }
    assert sorted(e["id"] for e in payload["events"]) == ["e-1", "e-2"]


# ─────────────────────────── J-A2 ───────────────────────────


def test_export_is_scoped_to_current_user(client: TestClient) -> None:
    a = register(client, "exp-scope-a@example.com")["access"]
    b = register(client, "exp-scope-b@example.com")["access"]

    push(
        client,
        a,
        changes=[{"collection": "agents", "entity": entity("a-1")}],
        events=[event("e-a1", session_id="sa")],
    )
    push(
        client,
        b,
        changes=[{"collection": "agents", "entity": entity("b-1")}],
        events=[event("e-b1", session_id="sb")],
    )

    # 双向正面断言：只断言「b 看不到 a」是平凡通过（导出被整体禁用时也成立）。
    pa = fetch_export(client, a)
    assert [i["entity"]["id"] for i in pa["items"]] == ["a-1"]
    assert [e["id"] for e in pa["events"]] == ["e-a1"]

    pb = fetch_export(client, b)
    assert [i["entity"]["id"] for i in pb["items"]] == ["b-1"]
    assert [e["id"] for e in pb["events"]] == ["e-b1"]


# ─────────────────────────── J-A3 ───────────────────────────


def test_export_is_deterministic(client: TestClient, monkeypatch) -> None:
    """ordering 必须稳定：两次导出（中间无写入）逐字节相同。

    `exportedAt` 是每次调用的实时时间戳、天然会变——所以这里把 `utc_now` 冻结，
    让「逐字节相同」这句话真正可比。**并且**逆序插入：排序结果与 SQLite 的插入
    (rowid) 序不同，若漏写 `ORDER BY`，下面的显式有序断言会红（真实变异验证点）。
    """
    token = register(client, "exp-det@example.com")["access"]
    push(
        client,
        token,
        changes=[
            {"collection": "settings", "entity": entity("z1")},
            {"collection": "agents", "entity": entity("b2")},
            {"collection": "agents", "entity": entity("a1")},
        ],
        events=[event("e-2", session_id="s2", seq=2), event("e-1", session_id="s1", seq=1)],
    )

    frozen = datetime(2026, 9, 28, 12, 0, 0, tzinfo=UTC)
    monkeypatch.setattr("app.account.routes.utc_now", lambda: frozen)

    first = client.get("/api/account/export", headers=auth_headers(token))
    second = client.get("/api/account/export", headers=auth_headers(token))
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    # ① 逐字节相同
    assert first.content == second.content

    # ② 显式有序（缺 ORDER BY → 逆序插入时这里会红）
    payload = first.json()
    assert [(i["collection"], i["entity"]["id"]) for i in payload["items"]] == [
        ("agents", "a1"),
        ("agents", "b2"),
        ("settings", "z1"),
    ]
    assert [(e["sessionId"], e["seq"], e["id"]) for e in payload["events"]] == [
        ("s1", 1, "e-1"),
        ("s2", 2, "e-2"),
    ]


# ─────────────────────────── J-A4 ───────────────────────────


def test_delete_account_wipes_everything(client: TestClient) -> None:
    email = "wipe@example.com"
    pair = register(client, email)
    token = pair["access"]
    refresh = pair["refresh"]

    push(
        client,
        token,
        changes=[{"collection": "agents", "entity": entity("a1")}],
        events=[event("e-1", session_id="s1", seq=1)],
    )

    resp = client.delete("/api/account", headers=auth_headers(token))
    assert resp.status_code == 204

    # ① 旧 access token 立即失效（users 行没了 → current_user 拒绝）
    assert client.get("/api/auth/me", headers=auth_headers(token)).status_code == 401
    # refresh token 也被清掉（删账户列表里的一员）
    assert client.post("/api/auth/refresh", json={"refresh": refresh}).status_code == 401

    # ② 同邮箱重新注册**成功**（打的是「只删数据行、users 行还在」的半吊子实现）
    again = register(client, email)

    # ③ 新账户云端导出为空
    payload = fetch_export(client, again["access"])
    assert payload["items"] == []
    assert payload["events"] == []
