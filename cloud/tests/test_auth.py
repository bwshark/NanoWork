"""auth 全生命周期往返：register → me → refresh → 轮换 → logout。

轮换那条是重点：旧 refresh **用过一次之后**再用必须失败，否则「令牌泄露」无法收敛。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register


def test_register_returns_pair(client: TestClient) -> None:
    body = register(client, "a@example.com")
    assert body["access"]
    assert body["refresh"]
    assert body["user"]["email"] == "a@example.com"


def test_register_duplicate_email_is_409(client: TestClient) -> None:
    register(client, "dup@example.com")
    resp = client.post(
        "/api/auth/register", json={"email": "dup@example.com", "password": "password123"}
    )
    assert resp.status_code == 409


def test_login_wrong_password_is_401(client: TestClient) -> None:
    register(client, "b@example.com")
    resp = client.post(
        "/api/auth/login", json={"email": "b@example.com", "password": "wrong-password"}
    )
    assert resp.status_code == 401


def test_me_needs_valid_access(client: TestClient) -> None:
    pair = register(client, "c@example.com")
    ok = client.get("/api/auth/me", headers=auth_headers(pair["access"]))
    assert ok.status_code == 200
    assert ok.json()["email"] == "c@example.com"

    bad = client.get("/api/auth/me", headers=auth_headers("not-a-token"))
    assert bad.status_code == 401


def test_refresh_rotates_and_old_token_is_rejected(client: TestClient) -> None:
    pair = register(client, "d@example.com")
    old_refresh = pair["refresh"]

    refreshed = client.post("/api/auth/refresh", json={"refresh": old_refresh})
    assert refreshed.status_code == 200
    assert refreshed.json()["access"]

    # 旧票已用过 → 再刷必须拒绝（重用检测）
    replay = client.post("/api/auth/refresh", json={"refresh": old_refresh})
    assert replay.status_code == 401

    # 重放不仅拒绝这一次：整条轮换链都要吊销，包括刚刚签发的那张新票。
    # 只吊销旧票的话，攻击者手里的票依然能一路换下去——所以这里必须是 401。
    new_refresh = refreshed.json()["refresh"]
    assert client.post("/api/auth/refresh", json={"refresh": new_refresh}).status_code == 401


def test_access_token_cannot_be_used_as_refresh(client: TestClient) -> None:
    """类型隔离：短票不能拿去换新票（security.py 的 `typ` claim 就是为此）。"""
    pair = register(client, "e@example.com")
    resp = client.post("/api/auth/refresh", json={"refresh": pair["access"]})
    assert resp.status_code == 401


def test_logout_revokes_refresh(client: TestClient) -> None:
    pair = register(client, "f@example.com")

    out = client.post(
        "/api/auth/logout",
        json={"refresh": pair["refresh"]},
        headers=auth_headers(pair["access"]),
    )
    assert out.status_code == 204

    after = client.post("/api/auth/refresh", json={"refresh": pair["refresh"]})
    assert after.status_code == 401


def test_logout_without_refresh_revokes_all(client: TestClient) -> None:
    """只带 access 登出 → 该用户全部 refresh 失效（「在所有设备登出」）。"""
    pair = register(client, "g@example.com")
    second = client.post(
        "/api/auth/login", json={"email": "g@example.com", "password": "password123"}
    ).json()

    client.post("/api/auth/logout", json={}, headers=auth_headers(pair["access"]))
    assert client.post("/api/auth/refresh", json={"refresh": pair["refresh"]}).status_code == 401
    assert client.post("/api/auth/refresh", json={"refresh": second["refresh"]}).status_code == 401
