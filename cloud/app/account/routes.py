"""/api/account/*：数据主权两个端点（FR-10.6）。

- `GET /api/account/export` —— 把**云端**存的本账户数据一次性导出（D1/D2）。
- `DELETE /api/account` —— 彻底删除本账户的云端全部数据与账户行本身（D8）。

三条纪律：

1. **只碰本账户**：所有查询/删除都带 `user_id == user.id` 过滤——不触碰其他
   用户的任何行（判据 J-A2 / J-A4）。
2. **导出必须确定**：`items` 按 `(collection, entity_id)`、`events` 按
   `(session_id, seq, id)` 显式 `ORDER BY`。**不能**依赖 SQLite 凑巧的插入序：
   否则「同一份数据导两次得到不同文件」，往来比对失效（判据 J-A3）。
3. **导出形状是用户可见契约**：带 `format` / `formatVersion`，与 `pull` 的响应
   形状解耦（D2）——`pull` 会随同步协议演进，导出归档不能跟着变形。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth.deps import current_user
from app.auth.models import RefreshToken, User
from app.db import get_session
from app.sync.models import SyncEvent, SyncItem
from app.timeutil import iso_z, utc_now

router = APIRouter(prefix="/api/account", tags=["account"])

EXPORT_FORMAT = "nanowork-cloud-export"
EXPORT_FORMAT_VERSION = 1


class ExportUser(BaseModel):
    id: str
    email: str
    createdAt: str


class ExportItem(BaseModel):
    collection: str
    entity: dict


class ExportPayload(BaseModel):
    format: str
    formatVersion: int
    exportedAt: str
    user: ExportUser
    items: list[ExportItem]
    events: list[dict]


@router.get("/export", response_model=ExportPayload)
def export_account(
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ExportPayload:
    """本账户云端数据的完整快照（实体 + 会话事件）。"""
    item_rows = session.exec(
        select(SyncItem)
        .where(SyncItem.user_id == user.id)
        # 确定性排序（J-A3）：不写 ORDER BY 时 SQLite 常凑巧按插入序返回，
        # 「先删一条再补一条」的数据就会出现两种导出顺序。
        .order_by(SyncItem.collection, SyncItem.entity_id)  # type: ignore[arg-type]
    ).all()
    event_rows = session.exec(
        select(SyncEvent)
        .where(SyncEvent.user_id == user.id)
        .order_by(SyncEvent.session_id, SyncEvent.seq, SyncEvent.id)  # type: ignore[arg-type]
    ).all()

    return ExportPayload(
        format=EXPORT_FORMAT,
        formatVersion=EXPORT_FORMAT_VERSION,
        exportedAt=iso_z(utc_now()),
        user=ExportUser(id=user.id, email=user.email, createdAt=iso_z(user.created_at)),
        items=[
            ExportItem(collection=row.collection, entity=json.loads(row.payload))
            for row in item_rows
        ],
        events=[json.loads(row.payload) for row in event_rows],
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    """彻底删除本账户的云端数据（不可恢复）。

    删除顺序（同一事务）：`sync_items` → `sync_events` → `refresh_tokens` →
    `users` 行本身。**删 `users` 行是关键**：只删数据行的话，同邮箱重新注册会
    因唯一约束 409（判据 J-A4 判据②专打这条半吊子实现）。删完 `users` 后，已
    签发但未过期的 access token 会被 `current_user`（用户不存在）挡成 401。
    """
    item_rows = session.exec(select(SyncItem).where(SyncItem.user_id == user.id)).all()
    for row in item_rows:
        session.delete(row)

    event_rows = session.exec(select(SyncEvent).where(SyncEvent.user_id == user.id)).all()
    for event_row in event_rows:
        session.delete(event_row)

    token_rows = session.exec(select(RefreshToken).where(RefreshToken.user_id == user.id)).all()
    for token_row in token_rows:
        session.delete(token_row)

    db_user = session.get(User, user.id)
    if db_user is not None:
        session.delete(db_user)

    session.commit()
