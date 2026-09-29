"""墓碑 GC 的**纯函数**部分：只回答「哪些墓碑过期了」，不碰任何 IO。

判据是 `row.deleted_at`（删除方写入的 `deletedAt`），**不是** `row.updated_at`
（规格 D9 与 m6 §六 #10）：`updated_at` 是**服务端接收时间**，`push` 里每次重收都
会归一重置（`sync/routes.py` 的 `entity["updatedAt"] = iso_z(now)` + 全量 push）——
按它 GC 则「每轮同步都刷新时钟」，墓碑**永远 GC 不掉**。
`deleted_at` 才是与**客户端 30 天上行窗**同源同钟的那一列：两侧在同一个时刻边界切换。

放在独立模块（而非塞进 `routes.py`）是刻意的：纯逻辑不依赖 FastAPI / DB，
可被单测直接喂构造出来的行对象，不需要起服务。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 只为类型标注；运行时不引入 sqlmodel，保持模块轻量
    from collections.abc import Iterable

    from app.sync.models import SyncItem

# 与客户端上行窗保持一致：删除满 30 天后，近似「所有设备都学到了该墓碑」
TOMBSTONE_TTL_DAYS = 30


def expired_tombstone_ids(
    rows: Iterable[SyncItem], *, now: datetime, ttl_days: int = TOMBSTONE_TTL_DAYS
) -> list[str]:
    """从墓碑行里挑出**已超期**的，返回其 `entity_id`。

    判据：`deleted_at` 非空，且 `deleted_at <= now - ttl_days 天`（闭区间——恰好
    满 30 天即视为过期，与客户端上行窗「满 30 天不再上行」对齐）。

    `now` 由调用方注入（而非在函数内取当前时间）——这既是纯函数的必要条件，
    也让用例能精确控制时间边界而无需 monkeypatch 时钟。
    """
    cutoff = now - timedelta(days=ttl_days)
    return [
        row.entity_id for row in rows if row.deleted_at is not None and row.deleted_at <= cutoff
    ]
