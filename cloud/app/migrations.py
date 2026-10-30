"""声明式列迁移：`create_all` 只建**缺失的表**，不会给已存在的表加列。

## 为什么需要它

这个约束已经逼着本项目绕了三次路（`kb_vectors` / `kb_departments` 之类独立建表）。
那些旁表各自的建模理由都仍然成立，但「不能加列」**本身不该是设计约束**：
它的代价是每一次字段演进都要多付一张表 + 一次 join + 一套额外语义，
而 Root cause 只是 `create_all` 不做 ALTER。第四次再绕，schema 就会被旁表拖走形。

这里补一个**只做一件事**的迁移器：按声明清单 `ALTER TABLE … ADD COLUMN`。
不引 Alembic 的判断没变（见 `db.py` 模块注释）：没有版本链需求时，它带来的是
一套迁移脚本目录 + 一个 CLI + 「测试要先 migrate」的成本。但「加一列」这个最高频
的操作必须有解。

## 三条硬约束

1. **幂等**：先 `inspect` 现有列，缺了才加。启动跑一百次也只加一次。
2. **只加，不改不删**：`DROP COLUMN` 在旧 SQLite 上不支持；而「悄悄删列」在
   存档型数据上是最危险的操作（用户的数据不会报错，只会静默消失）。改名同理。
   需要改名时：加新列 → 写回填 → 代码切到新列（旧列留着，不影响任何人）。
3. **新列必须可空或有默认值**：已有行需要立刻得到一个值，所以清单里每项都带
   完整 DDL 片段（含 `DEFAULT`），不接受裸类型名。
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

#: (表名, 列名, 列 DDL)。**只能追加**——已经加过的行不要删，否则下一次部署
#: 会以为「这列本来就有」而跳过，然后在老库上炸。
ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    # 2026-10-24 文档生命周期：内容摘要用于「同一篇重复入库」判重。
    # 空串 = 本行产生于这个字段存在之前（读的时候要按「没有摘要」处理，见 routes）。
    ("kb_documents", "content_hash", "TEXT NOT NULL DEFAULT ''"),
    # 来源格式（text / docx / pdf / xlsx / pptx），列表里要显示。
    ("kb_documents", "kind", "TEXT NOT NULL DEFAULT 'text'"),
    # 2026-10-25 回收站：软删时间（ISO 字符串，空串 = 未删）。
    ("kb_documents", "deleted_at", "TEXT NOT NULL DEFAULT ''"),
    # 2026-10-25 部门负责人：部门内角色（member / manager）。
    # 老行按 member 处理：把历史成员默认成负责人等于凭空扩权，方向必须 fail-closed。
    ("department_members", "role", "TEXT NOT NULL DEFAULT 'member'"),
    # 2026-10-25 列表「更新时间」：改名 / 恢复要能反映出来。
    # 空串 = 本行产生于该字段之前 → 读的时候退回 `created_at`（见 routes._document_view）。
    ("kb_documents", "updated_at", "TEXT NOT NULL DEFAULT ''"),
    # 2026-10-28 预览 PDF 的"渲染器版本"：这一版开始导出标题书签（大纲视图要用）。
    # 默认 0 = 本行产生于该字段之前 → 当作"没转"，下次打开重转一次，否则老 PDF 永远没大纲。
    ("kb_files", "render_version", "INTEGER NOT NULL DEFAULT 0"),
    # 2026-10-30 个人知识库：组织种类（team / personal）。
    # 默认 'team' = 老行都是真实团队。反过来（默认 personal）会让历史团队从团队列表里消失。
    ("organizations", "kind", "TEXT NOT NULL DEFAULT 'team'"),
)

#: (索引名, 表名, 列清单)。`CREATE INDEX IF NOT EXISTS` 在 SQLite 与 PostgreSQL
#: 都支持，所以这里不必先 inspect 索引。索引名必须与 `create_all` 的自动命名一致
#: （`ix_<表>_<列>`），否则新库会同时存在两个同义索引。
ADDED_INDEXES: tuple[tuple[str, str, str], ...] = (
    ("ix_kb_documents_content_hash", "kb_documents", "content_hash"),
    # 回收站过滤走 `deleted_at == ''`，它出现在每一次检索的 WHERE 里
    ("ix_kb_documents_deleted_at", "kb_documents", "deleted_at"),
)


def ensure_columns(engine: Engine) -> list[str]:
    """把缺失的列/索引补上，返回实际执行的语句（空列表 = 无需迁移）。

    返回语句而不是 `None`：启动日志里打出来，运维才知道「这次部署动了 schema」。
    静默迁移是另一类事故来源——出问题时没人知道库被改过。
    """
    applied: list[str] = []
    tables = set(inspect(engine).get_table_names())

    for table, column, ddl in ADDED_COLUMNS:
        if table not in tables:
            # 表还不存在 → `create_all` 会按最新 schema 建出来，不需要迁移
            continue
        # 每轮重新 inspect：Inspector 会按表缓存反射结果，拿着旧对象查会看到
        # 上一次的列清单（在「同一次启动里加了两列」时正好漏掉第二列）
        existing = {item["name"] for item in inspect(engine).get_columns(table)}
        if column in existing:
            continue
        statement = f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"
        with engine.begin() as connection:
            connection.execute(text(statement))
        applied.append(statement)
        logger.warning("schema 迁移：%s 新增列 %s", table, column)

    for index, table, columns in ADDED_INDEXES:
        if table not in tables:
            continue
        known = {item["name"] for item in inspect(engine).get_indexes(table)}
        if index in known:
            continue
        statement = f"CREATE INDEX IF NOT EXISTS {index} ON {table} ({columns})"
        with engine.begin() as connection:
            connection.execute(text(statement))
        applied.append(statement)
        logger.warning("schema 迁移：%s 新增索引 %s", table, index)

    return applied
