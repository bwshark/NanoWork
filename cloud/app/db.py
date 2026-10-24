"""数据库引擎与建表。

开发用 SQLite、生产用 PostgreSQL，同一份 SQLModel schema（m6 §六 待确认 #4）。
切换只靠环境变量 `NANOWORK_CLOUD_DB_URL`，代码里不出现任何方言分支。

为什么不用 Alembic：MVP 只有三张表、字段随批次演进，`create_all()` 足够；
等 schema 稳定（服务端开始长期存用户数据）再引入迁移工具。
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine

DEFAULT_SQLITE_PATH = Path(__file__).resolve().parent.parent / "cloud.db"


def database_url() -> str:
    """返回数据库 URL。

    SQLite 需要 `check_same_thread=False`：FastAPI 的请求可能在任意线程里
    拿到同一个 connection（开发期单线程 uvicorn 看不出来，一旦开 --workers 就炸）。
    """
    url = os.environ.get("NANOWORK_CLOUD_DB_URL")
    if url:
        return url
    return f"sqlite:///{DEFAULT_SQLITE_PATH}"


def _engine_kwargs(url: str) -> dict[str, object]:
    if url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}}
    return {}


engine = create_engine(database_url(), **_engine_kwargs(database_url()))  # type: ignore[arg-type]


def create_db_and_tables() -> None:
    # 模型必须在建表前被 import，否则 SQLModel.metadata 里没有它们。
    # 这里显式 import：main.py 即便只 import db 也不会漏掉表。
    from app.auth import models as _auth_models  # noqa: F401
    from app.kb import models as _kb_models  # noqa: F401
    from app.orgs import models as _org_models  # noqa: F401
    from app.sync import models as _sync_models  # noqa: F401

    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
