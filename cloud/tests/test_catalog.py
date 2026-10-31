"""内置模型目录（`cloud/app/catalog`）的接口与种子语义。

三条被钉住的规则，每一条都对应一类「看起来对、实际会伤人」的实现：

1. **种子只补缺、不覆盖** —— 否则运维改过的地址 / 密钥每重启一次就被冲回出厂值；
2. **下架（`enabled=false`）就下发不到** —— 否则「下架一个模型」在产品上做不到；
3. **写接口在未配置令牌时是 404，不是 403** —— 403 等于向未授权者确认接口存在。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.catalog.models import BuiltinModel
from app.catalog.seed import ensure_seed, seed_entries
from app.db import engine
from tests.conftest import auth_headers, register


def seed() -> int:
    """按当前环境变量播种（每个用例的表都是新建的，必须自己补）。"""
    with Session(engine) as session:
        return ensure_seed(session)


def rows() -> list[BuiltinModel]:
    with Session(engine) as session:
        return list(session.exec(select(BuiltinModel)).all())


def test_requires_login(client: TestClient) -> None:
    seed()
    assert client.get("/api/models/builtin").status_code == 401


def test_lists_seeded_models(client: TestClient) -> None:
    seed()
    token = register(client)["access"]
    resp = client.get("/api/models/builtin", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [m["id"] for m in body["models"]] == ["agnes-3.0-flash", "agnes-2.5-flash"]
    first = body["models"][0]
    # 客户端要按这个形状直接构造 upsert，键名必须是 camelCase
    assert first["provider"] == "agnes"
    assert first["providerLabel"] == "Agnes"
    assert first["apiBase"] == "https://apihub.agnes-ai.com/v1"
    assert first["supportsTools"] is True
    assert first["contextWindowTokens"] == 200_000


def test_seed_is_idempotent(client: TestClient) -> None:
    assert seed() == 2
    # 第二次什么都不做：重启不会重复插入
    assert seed() == 0
    assert len(rows()) == 2


def test_seed_does_not_overwrite_existing_rows(client: TestClient) -> None:
    seed()
    with Session(engine) as session:
        row = session.get(BuiltinModel, "agnes-3.0-flash")
        assert row is not None
        row.api_key = "sk-custom"
        row.api_base = "https://proxy.internal/v1"
        session.add(row)
        session.commit()

    assert seed() == 0
    with Session(engine) as session:
        row = session.get(BuiltinModel, "agnes-3.0-flash")
        assert row is not None
        # 运维改过的值必须留着
        assert row.api_key == "sk-custom"
        assert row.api_base == "https://proxy.internal/v1"


def test_seed_reads_api_key_from_env(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NANOWORK_BUILTIN_AGNES_API_KEY", "sk-from-env")
    entries = seed_entries()
    assert all(item["api_key"] == "sk-from-env" for item in entries)


def test_seed_env_override_replaces_list(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        "NANOWORK_BUILTIN_MODELS",
        '[{"id": "custom-1", "model": "custom-1", "provider": "my-gw"}]',
    )
    assert seed() == 1
    assert [row.id for row in rows()] == ["custom-1"]


def test_disabled_models_are_not_delivered(client: TestClient) -> None:
    seed()
    with Session(engine) as session:
        row = session.get(BuiltinModel, "agnes-2.5-flash")
        assert row is not None
        row.enabled = False
        session.add(row)
        session.commit()

    token = register(client)["access"]
    body = client.get("/api/models/builtin", headers=auth_headers(token)).json()
    assert [m["id"] for m in body["models"]] == ["agnes-3.0-flash"]


def test_write_endpoint_is_hidden_without_admin_token(client: TestClient) -> None:
    token = register(client)["access"]
    resp = client.put(
        "/api/models/builtin/x", json={"model": "x"}, headers=auth_headers(token)
    )
    # 未配置管理员令牌 = 接口不存在，而不是「你没权限」
    assert resp.status_code == 404


def test_write_endpoint_rejects_wrong_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NANOWORK_BUILTIN_ADMIN_TOKEN", "secret")
    token = register(client)["access"]
    resp = client.put(
        "/api/models/builtin/x",
        json={"model": "x"},
        headers={**auth_headers(token), "X-Builtin-Admin-Token": "wrong"},
    )
    assert resp.status_code == 403


def test_write_endpoint_upserts_partial_fields(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NANOWORK_BUILTIN_ADMIN_TOKEN", "secret")
    seed()
    token = register(client)["access"]
    headers = {**auth_headers(token), "X-Builtin-Admin-Token": "secret"}

    # 只换密钥：其余字段（能力声明、地址）必须原样保留
    resp = client.put(
        "/api/models/builtin/agnes-3.0-flash",
        json={"apiKey": "sk-new"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    got = resp.json()
    assert got["apiKey"] == "sk-new"
    assert got["apiBase"] == "https://apihub.agnes-ai.com/v1"
    assert got["supportsTools"] is True

    # 新增一条
    resp = client.put(
        "/api/models/builtin/brand-new",
        json={"model": "brand-new", "provider": "gw", "providerLabel": "GW"},
        headers=headers,
    )
    assert resp.status_code == 200
    listed = client.get("/api/models/builtin", headers=auth_headers(token)).json()["models"]
    assert {"agnes-3.0-flash", "agnes-2.5-flash", "brand-new"} <= {m["id"] for m in listed}
