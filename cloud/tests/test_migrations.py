"""列迁移器的用例。

这组用例**必须自建 engine**：`conftest.py` 每个用例都 `drop_all` + `create_all`，
新库的列永远是齐的，迁移分支在那里一次也不会被执行到 —— 那正是「迁移代码从未
在真实形状上跑过」的经典假绿。所以这里手工造一张**老形状**的表。
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine

from app.migrations import ADDED_COLUMNS, ensure_columns


def _build_legacy(tmp_path) -> Engine:
    """一个只有旧列（没有 content_hash / kind）的库，并且**已经有一条数据**。"""
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE kb_documents ("
                "id TEXT PRIMARY KEY, kb_id TEXT, org_owner TEXT, title TEXT)"
            )
        )
        connection.execute(
            text("INSERT INTO kb_documents (id, kb_id, title) VALUES ('d1', 'k1', '差旅制度')")
        )
    return engine


@pytest.fixture
def legacy_engine(tmp_path):
    """用完必须 dispose：SQLite 句柄不释放时 tmp 目录删不掉（Windows 上是硬失败）。"""
    engine = _build_legacy(tmp_path)
    try:
        yield engine
    finally:
        engine.dispose()


def test_ensure_columns_upgrades_legacy_table(legacy_engine: Engine) -> None:
    applied = ensure_columns(legacy_engine)

    columns = {item["name"] for item in inspect(legacy_engine).get_columns("kb_documents")}
    expected = {column for table, column, _ddl in ADDED_COLUMNS if table == "kb_documents"}
    assert expected <= columns
    assert any("content_hash" in statement for statement in applied)


def test_ensure_columns_is_idempotent(legacy_engine: Engine) -> None:
    ensure_columns(legacy_engine)

    # 第二次必须是空操作：否则每次启动都会 ALTER 一次，日志里天天「迁移了 2 条」
    assert ensure_columns(legacy_engine) == []


def test_new_columns_get_defaults_for_existing_rows(legacy_engine: Engine) -> None:
    """老行不会因为加了 NOT NULL 列而变 NULL —— 没默认值的 ADD COLUMN 直接失败。

    这条盯的是清单里那两处 `DEFAULT`：删掉任何一个，已有行就无从取值。
    """
    ensure_columns(legacy_engine)

    with legacy_engine.begin() as connection:
        row = connection.execute(
            text("SELECT title, content_hash, kind FROM kb_documents WHERE id = 'd1'")
        ).one()

    assert row[0] == "差旅制度"
    assert row[1] == ""
    assert row[2] == "text"


def test_added_index_is_created_for_legacy_table(legacy_engine: Engine) -> None:
    ensure_columns(legacy_engine)

    indexes = {item["name"] for item in inspect(legacy_engine).get_indexes("kb_documents")}
    assert "ix_kb_documents_content_hash" in indexes


def test_missing_table_is_skipped(tmp_path) -> None:
    """表还不存在时不能炸：`create_all` 会按最新 schema 建，轮不到迁移。"""
    engine = create_engine(f"sqlite:///{tmp_path / 'empty.db'}")
    try:
        assert ensure_columns(engine) == []
    finally:
        engine.dispose()
