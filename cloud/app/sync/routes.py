"""`/api/sync/push` 与 `/api/sync/pull`。

两条服务端不变量（m6 §3.1），这里各对应一处实现选择：

1. **`updated_at` 取服务端接收时间**——不是「校验后取客户端的值」，而是**根本不信任**：
   客户端上报的时间原样存进 `client_updated_at`，落库一律用 `utc_now()`。
   否则一台系统时间调快的设备会永久赢下所有 LWW。
   ⚠️ 落库前还会把 **payload 里的 `updatedAt` 也归一**成服务端接收时刻再序列化
   （见下面 `push`）：这样「pull 下发的也是归一后的值」才真正成立（m6 §5.3）。
   ⚠️ **第二级 tie-break（时间比较）目前与落库同用服务端钟**，这与 incoming 的
   客户端上报时刻**不同源** → 同 `rev` 的真并发会判反（后 push 的一方时间反而更小，
   本机容器快约 1.1 秒），后改的修改被丢弃（`integration.twoDevice` 门禁② 稳定红）。
   同源化要**连 payload 归一一起改**（推翻 §5.3），属架构级改动，见
   `docs/fr-sync-lww-tiebreak.md`。
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
from app.sync.models import SyncEvent, SyncItem
from app.sync.retention import expired_tombstone_ids
from app.timeutil import coerce_utc, iso_z, utc_now

router = APIRouter(prefix="/api/sync", tags=["sync"])

# 缺 `updatedAt` 的老实体按「零值版本」参与裁决（见 `_stamp_of`）
EPOCH = datetime.min.replace(tzinfo=UTC)


class SyncChange(BaseModel):
    collection: str
    entity: dict


class PushRequest(BaseModel):
    changes: list[SyncChange] = []
    # 会话事件流（批次 5）：每条事件**自描述**（`sessionId` 在事件体内），与实体
    # 走同一批 `server_seq`。缺省 `[]` 保证老客户端（只推实体）照旧可用。
    events: list[dict] = []


class Conflict(BaseModel):
    collection: str
    id: str
    server: dict
    resolution: str


class PushResponse(BaseModel):
    accepted: list[str]
    conflicts: list[Conflict]
    cursor: int
    # 本次 push **新增**的事件数（幂等跳过的不计）
    accepted_events: int


class PullResponse(BaseModel):
    cursor: int
    changes: list[SyncChange]
    # 事件行按 `server_seq` 排序；与 `changes` 同属一条游标
    events: list[dict]


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
    """下一次写入用的 `server_seq`：**跨 `sync_items` + `sync_events` 共享游标**。

    取两表 `server_seq` 最大值 + 1。两者共用同一条命名空间后，`pull?since=` 一次
    即可取回「实体 + 事件」，客户端只需维护一个游标（规格 Q2 / §7「单一游标」）。
    只取实体表会让事件行拿到与实体行相同的序号而排序歧义；只取事件表则反之。
    """
    item_max = session.exec(
        select(func.max(SyncItem.server_seq)).where(SyncItem.user_id == user_id)
    ).one()
    event_max = session.exec(
        select(func.max(SyncEvent.server_seq)).where(SyncEvent.user_id == user_id)
    ).one()
    return max(int(item_max or 0), int(event_max or 0)) + 1


def _find(session: Session, user_id: str, collection: str, entity_id: str) -> SyncItem | None:
    return session.exec(
        select(SyncItem).where(
            SyncItem.user_id == user_id,
            SyncItem.collection == collection,
            SyncItem.entity_id == entity_id,
        )
    ).first()


def _find_event(session: Session, user_id: str, session_id: str, event_id: str) -> SyncEvent | None:
    """按唯一键 `(user_id, session_id, event_id)` 找已落库事件（幂等跳过的判据）。"""
    return session.exec(
        select(SyncEvent).where(
            SyncEvent.user_id == user_id,
            SyncEvent.session_id == session_id,
            SyncEvent.event_id == event_id,
        )
    ).first()


def _gc_tombstones(session: Session, user_id: str, now: datetime) -> None:
    """本账户超期墓碑的顺路清理（D10：挂在 push 入口，**不新增端点**）。

    两点值得说明：

    1. **按 `deleted_at` 判超期、不按 `updated_at`**（规格 D9 / m6 §六 #10）——
       详见 `retention.py` 的文件头。
    2. **级联**：超期的 `collection == 'sessionMeta'` 墓碑，其 `entity_id` 就是
       `sessionId` → 一并删该会话的**全部** `sync_events`（D11，批次 5 遗留的
       「已删会话事件永不清理」）。未超期的已删会话事件最多残留 30 天，对端拉到
       会被「未知 / 已墓碑会话跳过」挡掉（批次 5 已落），无害。

    只删本账户的行（`user_id` 过滤），**不触碰其他用户**（判据 J-B4）。这里**不
    commit**：由 `push` 末尾统一提交，使「清理 + 本次写入」落在同一事务里。
    """
    rows = session.exec(
        select(SyncItem).where(
            SyncItem.user_id == user_id,
            SyncItem.deleted_at.is_not(None),  # type: ignore[union-attr]
        )
    ).all()
    expired_ids = set(expired_tombstone_ids(rows, now=now))
    if not expired_ids:
        return

    for row in rows:
        if row.entity_id not in expired_ids:
            continue
        if row.collection == "sessionMeta":
            # `entity_id` 即 `sessionId`：级联清掉该会话的全部事件
            event_rows = session.exec(
                select(SyncEvent).where(
                    SyncEvent.user_id == user_id,
                    SyncEvent.session_id == row.entity_id,
                )
            ).all()
            for event_row in event_rows:
                session.delete(event_row)
        session.delete(row)


@router.post("/push", response_model=PushResponse)
def push(
    body: PushRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> PushResponse:
    accepted: list[str] = []
    conflicts: list[Conflict] = []
    accepted_events = 0
    seq = _next_seq(session, user.id)

    # 顺路 GC（D10）：在**实体循环之前**清理本账户的超期墓碑（幂等）。
    # 必须在 `_next_seq` **之后**调用：`_next_seq` 取的是本轮写入前的最大 seq，
    # 若先删了那条 seq 最大的墓碑行，本轮的新写入会拿到更小的号 → 对端游标可能漏拉。
    _gc_tombstones(session, user.id, utc_now())

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
                # ⚠️ 第二级 tie-break（时间比较）**必须同源**才有意义。
                # 这里用的是**服务端落库时刻**（`updated_at`），而 incoming 的时间是
                # **客户端上报值** —— 两者来自不同的钟（本机容器快约 1.1 秒），
                # 于是同 `rev` 的真并发会被判反：后 push 的一方时间反而更小 → 后改的修改被丢弃
                # （`integration.twoDevice` 门禁② 实测 2026-10-31，稳定红）。
                # ⚠️ 2026-10-31 试过改成 `row.client_updated_at or row.updated_at`：
                # **门禁①反而变红** —— 客户端侧拿到的 `updatedAt` 是服务端归一后的值
                # （payload 落库时被归一，见文件头第 1 点）；服务端改用客户端钟、客户端仍用
                # 服务端钟，两端不再同源，把「B 改 → A 换回拿到 B 改动」这条路打断了。
                # 真正的同源化要**连 payload 归一一起去改**（下发值也用客户端钟），
                # 那会推翻 m6 §5.3 的既定决策 —— 属架构级改动，单独立项：
                # 见 `docs/fr-sync-lww-tiebreak.md`。
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

    # ── 事件循环（批次 5）：在**既有实体循环之后**，与实体共用本批 `seq` ──
    # 顺序不变式：同一 push 内实体先于事件 —— 保证「会话 meta 先于其事件」被对端
    # 看到（Q2 / §7）。缺身份的事件**跳过而不整批失败**（对齐实体缺 id 的处理）。
    for ev in body.events:
        event_id = str(ev.get("id", ""))
        session_id = str(ev.get("sessionId", ""))
        if not event_id or not session_id:
            continue
        # 幂等跳过：事件 id 已存在 → 不写库、不推进 seq、不计入 accepted_events
        # （与批次 4 实体「完全同版幂等跳过」同一纪律，见 §3.4）。
        if _find_event(session, user.id, session_id, event_id) is not None:
            continue
        session.add(
            SyncEvent(
                user_id=user.id,
                session_id=session_id,
                event_id=event_id,
                seq=int(ev.get("seq") or 0),
                # 原样序列化：**不归一** `updatedAt` / 不注入服务端时间（事件是事实）
                payload=json.dumps(ev, ensure_ascii=False),
                server_seq=seq,
            )
        )
        accepted_events += 1

    session.commit()
    return PushResponse(
        accepted=accepted, conflicts=conflicts, cursor=seq, accepted_events=accepted_events
    )


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

    # 事件行属于同一条 `server_seq` 命名空间，`since` 过滤天然覆盖两者
    event_rows = session.exec(
        select(SyncEvent)
        .where(SyncEvent.user_id == user.id, SyncEvent.server_seq > since)
        .order_by(SyncEvent.server_seq)  # type: ignore[arg-type]
    ).all()

    changes = [
        SyncChange(collection=row.collection, entity=json.loads(row.payload)) for row in rows
    ]
    events = [json.loads(row.payload) for row in event_rows]
    # 游标取**两表**最大值：否则只推事件的批会算不出新游标、对端下次重复拉
    cursor = max(
        [row.server_seq for row in rows] + [row.server_seq for row in event_rows],
        default=since,
    )
    return PullResponse(cursor=cursor, changes=changes, events=events)


@router.delete("/reset", status_code=status.HTTP_204_NO_CONTENT)
def reset(user: User = Depends(current_user), session: Session = Depends(get_session)) -> None:
    """清空本账户的同步数据（供测试与「删账户」复用；MVP 不做公开端点）。

    实体与事件一并清理——否则「删账户」后事件残留（对齐既有 `reset` 语义）。
    """
    rows = session.exec(select(SyncItem).where(SyncItem.user_id == user.id)).all()
    for row in rows:
        session.delete(row)
    event_rows = session.exec(select(SyncEvent).where(SyncEvent.user_id == user.id)).all()
    for event_row in event_rows:
        session.delete(event_row)
    session.commit()
