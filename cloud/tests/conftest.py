"""测试夹具。

`NANOWORK_CLOUD_DB_URL` 必须在 **import app 之前**设好：`app/db.py` 在模块加载时
就创建 engine（`database_url()` 只在那一刻读一次环境变量）。所以这里用 import 顺序
控制，而不是 pytest fixture——fixture 跑得太晚，engine 已经绑到默认路径了。
"""

from __future__ import annotations

import os
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

# cloud/ 根目录进 sys.path：`app` 包才能被导入（与 `pythonpath = ["."]` 二选一即可）
CLOUD_ROOT = Path(__file__).resolve().parent.parent
if str(CLOUD_ROOT) not in sys.path:
    sys.path.insert(0, str(CLOUD_ROOT))

_DB_DIR = tempfile.mkdtemp(prefix="nanowork-cloud-test-")
os.environ["NANOWORK_CLOUD_DB_URL"] = f"sqlite:///{Path(_DB_DIR) / 'test.db'}"

from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _clean_tables() -> Iterator[None]:
    """每个用例前重建全部表：用例之间完全隔离，不依赖删除顺序。"""
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    yield


def register(
    client: TestClient, email: str = "a@example.com", password: str = "password123"
) -> dict:
    resp = client.post("/api/auth/register", json={"email": email, "password": password})
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
