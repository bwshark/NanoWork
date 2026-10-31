"""数据库引擎与建表。

开发用 SQLite、生产用 PostgreSQL，同一份 SQLModel schema（m6 §六 待确认 #4）。
切换只靠环境变量 `NANOWORK_CLOUD_DB_URL`，代码里不出现任何方言分支。

为什么不用 Alembic：MVP 只有三张表、字段随批次演进，`create_all()` 足够；
等 schema 稳定（服务端开始长期存用户数据）再引入迁移工具。

⚠️ 但 `create_all()` **不会给已存在的表加列** —— 这条限制已经逼着本项目绕了三次路
（为加一个字段去建旁表）。所以这里补了一步 `migrations.ensure_columns()`：
声明式 `ALTER TABLE … ADD COLUMN`，只加不改不删、幂等。仍然不是 Alembic
（没有版本链 / 回滚 / 迁移脚本目录），但「加一列」不再需要设计一个替代方案。
"""

from __future__ import annotations

import logging
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
    from app.catalog import models as _catalog_models  # noqa: F401
    from app.kb import models as _kb_models  # noqa: F401
    from app.migrations import ensure_columns
    from app.orgs import models as _org_models  # noqa: F401
    from app.sync import models as _sync_models  # noqa: F401

    SQLModel.metadata.create_all(engine)
    # 顺序不能反：create_all 先把缺失的表建出来，ensure_columns 只处理
    # 「表已存在但列不全」的老库（新建库在这里是空操作）。
    applied = ensure_columns(engine)
    if applied:
        # 打个日志而不是静默：出问题时运维要能知道「这次启动动过 schema」
        logging.getLogger(__name__).warning("schema 迁移已执行 %d 条", len(applied))


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
