"""`/api/sync/push` 与 `/api/sync/pull`。

两条服务端不变量（m6 §3.1），这里各对应一处实现选择：

1. **`updated_at` 取服务端接收时间**——不是「校验后取客户端的值」，而是**根本不信任**：
   客户端上报的时间原样存进 `client_updated_at` 供审计，裁决与落库一律用
   `utc_now()`。否则一台系统时间调快的设备会永久赢下所有 LWW。
   ⚠️ 落库前还会把 **payload 里的 `updatedAt` 也归一**成服务端接收时刻再序列化
   （见下面 `push`）：这样「pull 下发的也是归一后的值」才真正成立（m6 §5.3）。
2. **`server_seq` 每次写入都推进**——包括「客户端推了个一模一样的版本」这种情况。
   不推进的话，对端游标已越过该行 → 这次变更它永远拉不到。
   ⚠️ **例外**见 `push` 里的「完全同版幂等跳过」：当 payload 与已存内容除 `updatedAt`
   外完全相同时整条跳过（连 `seq` 都不推进）。否则客户端**全量 push** + 归一 `updatedAt`
   会让每一轮空闲同步形成「`cmp==0` → 接受 → 写库 → `seq+1` → 回拉全量 → 本地
   `updatedAt` 前移」的 30s 一次无限写入 + 无限回拉。跳过之后空闲态才是真·空转。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlmodel import Session, func, select

from app.auth.deps import current_user
from app.auth.models import User
from app.db import get_session
from app.sync.merger import VersionStamp, compare_versions, resolve
from app.sync.models import SyncItem
from app.timeutil import coerce_utc, iso_z, utc_now

router = APIRouter(prefix="/api/sync", tags=["sync"])

# 缺 `updatedAt` 的老实体按「零值版本」参与裁决（见 `_stamp_of`）
EPOCH = datetime.min.replace(tzinfo=UTC)


class SyncChange(BaseModel):
    collection: str
    entity: dict


class PushRequest(BaseModel):
    changes: list[SyncChange] = []


class Conflict(BaseModel):
    collection: str
    id: str
    server: dict
    resolution: str


class PushResponse(BaseModel):
    accepted: list[str]
    conflicts: list[Conflict]
    cursor: int


class PullResponse(BaseModel):
    cursor: int
    changes: list[SyncChange]


def _stamp_of(entity: dict) -> VersionStamp:
    """客户端实体 → 裁决所需的四个字段。

    `updatedAt` / `deletedAt` 缺失或非法时**不抛错**（`coerce_utc` 返回 None）：
    老数据（`SyncMeta` 落地之前的实体）本就没有这些字段，一律按「零值版本」处理，
    让它们能被服务端版本正常覆盖，而不是让整批 push 失败。
    """
    return VersionStamp(
        entity_id=str(entity.get("id", "")),
        rev=int(entity.get("rev") or 0),
        updated_at=coerce_utc(entity.get("updatedAt")) or EPOCH,
        deleted_at=coerce_utc(entity.get("deletedAt")),
    )


def _payload_matches_ignoring_updated_at(row: SyncItem, entity: dict) -> bool:
    """除 `updatedAt` 外，incoming 与已存 `row.payload` 是否逐字段相同。

    为什么要**剔除 `updatedAt` 再比**、且比 **dict 而不是 JSON 字符串**：

    - 落库前我们把 incoming 的 `updatedAt` 归一为服务端接收时刻，它与已存 payload
      里的值必然不同（除非同一毫秒）。但那只是「同一次写入的两种表示」，不是内容
      变化——不剔除就会永远判成「有改动」，幂等跳过失效。
    - `json.dumps` 的字符串形式不稳定（键序、空白、`ensure_ascii`），归一后两侧
      字符串可能互不相等却内容一致，直接比字符串会漏判。
    """
    try:
        stored = json.loads(row.payload)
    except (TypeError, ValueError):
        return False
    if not isinstance(stored, dict):
        return False
    stored_without = {k: v for k, v in stored.items() if k != "updatedAt"}
    incoming_without = {k: v for k, v in entity.items() if k != "updatedAt"}
    return stored_without == incoming_without


def _next_seq(session: Session, user_id: str) -> int:
    current = session.exec(
        select(func.max(SyncItem.server_seq)).where(SyncItem.user_id == user_id)
    ).one()
    return int(current or 0) + 1


def _find(session: Session, user_id: str, collection: str, entity_id: str) -> SyncItem | None:
    return session.exec(
        select(SyncItem).where(
            SyncItem.user_id == user_id,
            SyncItem.collection == collection,
            SyncItem.entity_id == entity_id,
        )
    ).first()


@router.post("/push", response_model=PushResponse)
def push(
    body: PushRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> PushResponse:
    accepted: list[str] = []
    conflicts: list[Conflict] = []
    seq = _next_seq(session, user.id)

    for change in body.changes:
        entity = change.entity
        entity_id = str(entity.get("id", ""))
        if not entity_id or not change.collection:
            # 缺主键的实体无法参与 LWW（没有可比对的身份），跳过而不是让整批失败
            continue

        incoming = _stamp_of(entity)
        row = _find(session, user.id, change.collection, entity_id)
        current = (
            VersionStamp(
                entity_id=row.entity_id,
                rev=row.rev,
                updated_at=row.updated_at,
                deleted_at=row.deleted_at,
            )
            if row is not None
            else None
        )

        # 「完全同版」幂等跳过（见文件头第 2 点）：客户端 `collectChanges()` 是**全量 push**，
        # 归一 `updatedAt` 之后每一轮空闲同步都会「cmp==0 → 接受 → 写库 → seq+1 → 客户端
        # 回拉全量 → 本地 updatedAt 前移」，形成 30s 一次的无限写入与回拉。若这条 incoming
        # 与已存 payload **除 `updatedAt` 外完全一致**，则什么都不做——不写库、不推进
        # `server_seq`、也不进 accepted。跳过之后空闲态才是真·空转。
        if (
            row is not None
            and compare_versions(incoming, current) == 0
            and _payload_matches_ignoring_updated_at(row, entity)
        ):
            continue

        verdict = resolve(current, incoming)
        if not verdict.accepted:
            # 服务端版本更新：把服务端这份回给客户端，让它按 merge 语义落地（§六 #9）
            assert row is not None
            conflicts.append(
                Conflict(
                    collection=change.collection,
                    id=entity_id,
                    server=json.loads(row.payload),
                    resolution=verdict.reason,
                )
            )
            continue

        now = utc_now()
        # 落库前把 payload 的 `updatedAt` **归一为服务端接收时刻**再序列化（m6 §5.3）：
        # 使「pull 下发的也是归一后的值」真正成立。客户端回拉后本地 `updatedAt` 前移到
        # 服务端时刻，下一轮全量 push 就是 `cmp==0`（再由上面的幂等跳过兜住）；
        # 而「行的服务端时间 vs payload 的客户端时间」两个时钟混比的隐患也随之消失。
        # 客户端上报值仍存进 `row.client_updated_at` 供审计。
        entity["updatedAt"] = iso_z(now)
        payload = json.dumps(entity, ensure_ascii=False)
        if row is None:
            row = SyncItem(
                user_id=user.id,
                collection=change.collection,
                entity_id=entity_id,
                updated_at=now,
            )
        row.rev = incoming.rev
        row.updated_at = now
        row.client_updated_at = incoming.updated_at
        row.deleted_at = incoming.deleted_at
        row.updated_by = str(entity.get("updatedBy")) if entity.get("updatedBy") else None
        row.payload = payload
        row.server_seq = seq
        session.add(row)
        accepted.append(entity_id)

    session.commit()
    return PushResponse(accepted=accepted, conflicts=conflicts, cursor=seq)


@router.get("/pull", response_model=PullResponse)
def pull(
    since: int = Query(default=0, ge=0),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> PullResponse:
    """取 `server_seq > since` 的全部变更。

    游标是**服务端的变更流序号**，与实体的 `rev` / `updatedAt` 无关（§3.1）。
    混用会导致漏数据：实体版本可能不推进（比如只改了被裁剪掉的字段），
    而它依然需要被对端拉走。
    """
    rows = session.exec(
        select(SyncItem)
        .where(SyncItem.user_id == user.id, SyncItem.server_seq > since)
        .order_by(SyncItem.server_seq)  # type: ignore[arg-type]
    ).all()

    changes = [
        SyncChange(collection=row.collection, entity=json.loads(row.payload)) for row in rows
    ]
    cursor = max((row.server_seq for row in rows), default=since)
    return PullResponse(cursor=cursor, changes=changes)


@router.delete("/reset", status_code=status.HTTP_204_NO_CONTENT)
def reset(user: User = Depends(current_user), session: Session = Depends(get_session)) -> None:
    """清空本账户的同步数据（供测试与「删账户」复用；MVP 不做公开端点）。"""
    rows = session.exec(select(SyncItem).where(SyncItem.user_id == user.id)).all()
    for row in rows:
        session.delete(row)
    session.commit()
