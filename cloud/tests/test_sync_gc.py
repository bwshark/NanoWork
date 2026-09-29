"""批次 6a 服务端：墓碑 GC 30 天 + 已删会话事件级联清理（规格 §2.3，判据 J-B1~J-B5）。

两条最关键的不变式：

- **GC 判据是 `deleted_at`，不是 `updated_at`**（D9 / m6 §六 #10）。`updated_at` 是
  服务端接收时间、每次重收都重置 → 按它 GC 永远 GC 不掉。用例因此刻意把
  `deleted_at` 与 `updated_at` 设成**不同**的值：判据错成 `updated_at` 时 B1/B2 必红。
- **级联**：超期的 `sessionMeta` 墓碑（`entity_id == sessionId`）要带走该会话的
  **全部** `sync_events`，且不许误伤别的会话（D11 / 批次 5 遗留）。

墓碑行直接写库（而非走 push）是为了精确控制 `deleted_at`——真实时钟无法「等 30 天」。
"""

from __future__ import annotations

import json
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.db import engine
from app.sync.models import SyncEvent, SyncItem
from app.timeutil import iso_z, utc_now
from tests.conftest import auth_headers, register


def push(
    client: TestClient,
    token: str,
    changes: list[dict] | None = None,
    events: list[dict] | None = None,
) -> dict:
    resp = client.post(
        "/api/sync/push",
        json={"changes": changes or [], "events": events or []},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def pull(client: TestClient, token: str, since: int = 0) -> dict:
    resp = client.get(f"/api/sync/pull?since={since}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def entity(eid: str, rev: int = 1, **extra: object) -> dict:
    base: dict[str, object] = {"id": eid, "rev": rev, "updatedAt": iso_z(utc_now())}
    base.update(extra)
    return base


def seed_tombstone(
    user_id: str,
    *,
    collection: str,
    entity_id: str,
    deleted_at,
    updated_at,
    server_seq: int = 1,
) -> None:
    """直接写一行墓碑。`deleted_at` 与 `updated_at` 分别可控——这是判据的核心。"""
    payload = json.dumps(
        {
            "id": entity_id,
            "rev": 2,
            "updatedAt": iso_z(updated_at),
            "deletedAt": iso_z(deleted_at),
        }
    )
    with Session(engine) as s:
        s.add(
            SyncItem(
                user_id=user_id,
                collection=collection,
                entity_id=entity_id,
                rev=2,
                updated_at=updated_at,
                deleted_at=deleted_at,
                payload=payload,
                server_seq=server_seq,
            )
        )
        s.commit()


def seed_event(user_id: str, session_id: str, event_id: str, *, seq: int = 1) -> None:
    payload = json.dumps({"id": event_id, "sessionId": session_id, "seq": seq, "type": "message"})
    with Session(engine) as s:
        s.add(
            SyncEvent(
                user_id=user_id,
                session_id=session_id,
                event_id=event_id,
                seq=seq,
                payload=payload,
                server_seq=1,
            )
        )
        s.commit()


def item_ids(user_id: str) -> list[str]:
    with Session(engine) as s:
        rows = s.exec(select(SyncItem).where(SyncItem.user_id == user_id)).all()
        return sorted(row.entity_id for row in rows)


def event_ids(user_id: str) -> list[str]:
    with Session(engine) as s:
        rows = s.exec(select(SyncEvent).where(SyncEvent.user_id == user_id)).all()
        return sorted(row.event_id for row in rows)


def backdate_tombstone(user_id: str, collection: str, entity_id: str, deleted_at) -> None:
    """把已落库墓碑的 `deleted_at` 回拨，模拟「时间推进 > 30 天」。"""
    with Session(engine) as s:
        row = s.exec(
            select(SyncItem).where(
                SyncItem.user_id == user_id,
                SyncItem.collection == collection,
                SyncItem.entity_id == entity_id,
            )
        ).first()
        assert row is not None
        row.deleted_at = deleted_at
        s.add(row)
        s.commit()


# ─────────────────────────── J-B1 ───────────────────────────


def test_expired_tombstone_is_collected(client: TestClient) -> None:
    tok = register(client, "gc-b1@example.com")
    uid = tok["user"]["id"]
    now = utc_now()
    # `updated_at` 是「刚刚」（服务端每次重收都会重置它）→ 判据若误用 updated_at
    # 则这行永远不算超期、GC 收不掉 → 本用例红。
    seed_tombstone(
        uid,
        collection="agents",
        entity_id="gone",
        deleted_at=now - timedelta(days=31),
        updated_at=now,
    )
    assert item_ids(uid) == ["gone"]

    push(client, tok["access"])  # 空 push，只为触发入口 GC

    assert item_ids(uid) == []


# ─────────────────────────── J-B2 ───────────────────────────


def test_fresh_tombstone_survives(client: TestClient) -> None:
    tok = register(client, "gc-b2@example.com")
    uid = tok["user"]["id"]
    now = utc_now()
    # `updated_at` 是 60 天前 → 判据若误用 updated_at，这行会被误判超期 → 本用例红。
    seed_tombstone(
        uid,
        collection="agents",
        entity_id="fresh",
        deleted_at=now - timedelta(days=29),
        updated_at=now - timedelta(days=60),
    )

    push(client, tok["access"])

    assert item_ids(uid) == ["fresh"], "未满 30 天的墓碑必须保留（TTL 写成 0 天 → 红）"
    # 且 pull 仍能取回它（对端还能学到这次删除）
    changes = pull(client, tok["access"], since=0)["changes"]
    assert [c["entity"]["id"] for c in changes] == ["fresh"]
    assert changes[0]["entity"]["deletedAt"] is not None


# ─────────────────────────── J-B3 ───────────────────────────


def test_gc_cascades_session_events(client: TestClient) -> None:
    tok = register(client, "gc-b3@example.com")
    uid = tok["user"]["id"]
    now = utc_now()
    seed_tombstone(
        uid,
        collection="sessionMeta",
        entity_id="s-old",
        deleted_at=now - timedelta(days=31),
        updated_at=now,
    )
    seed_event(uid, "s-old", "e-old-1", seq=1)
    seed_event(uid, "s-old", "e-old-2", seq=2)
    seed_event(uid, "s-new", "e-new-1", seq=1)

    push(client, tok["access"])

    assert item_ids(uid) == []
    assert event_ids(uid) == ["e-new-1"], "只级联删超期会话的事件，另一会话的必须还在"


# ─────────────────────────── J-B4 ───────────────────────────


def test_gc_does_not_touch_other_users(client: TestClient) -> None:
    a = register(client, "gc-b4-a@example.com")
    b = register(client, "gc-b4-b@example.com")
    now = utc_now()
    seed_tombstone(
        a["user"]["id"],
        collection="agents",
        entity_id="a-gone",
        deleted_at=now - timedelta(days=31),
        updated_at=now,
    )
    seed_tombstone(
        b["user"]["id"],
        collection="agents",
        entity_id="b-gone",
        deleted_at=now - timedelta(days=31),
        updated_at=now,
    )

    push(client, a["access"])

    assert item_ids(a["user"]["id"]) == []
    assert item_ids(b["user"]["id"]) == ["b-gone"], "GC 只清本账户，不得碰其他用户"


# ─────────────────────────── J-B5 ───────────────────────────


def test_pull_after_gc_does_not_resurrect(client: TestClient) -> None:
    """m6 §七 完成判据：GC 后 pull 不复活已删条目。

    A / B 是**同一账户的两台设备**（共享同一份 `server_seq` 流）；服务端不区分设备，
    故用同一个 token，靠「各自维护的 pull 游标」模拟两台设备。若误写成两个独立账户，
    B 永远拉不到 A 的数据 → 本用例毫无意义（且会红）。
    """
    tok = register(client, "gc-b5@example.com")
    uid = tok["user"]["id"]
    now = utc_now()

    # 设备 A：先推存活条目，再推它的墓碑（= 删除）
    push(client, tok["access"], changes=[{"collection": "agents", "entity": entity("e1", rev=1)}])
    push(
        client,
        tok["access"],
        changes=[
            {
                "collection": "agents",
                "entity": entity("e1", rev=2, deletedAt=iso_z(now)),
            }
        ],
    )

    # 设备 B 拉到墓碑、落地删除（服务端侧能验证的是：B 的游标已越过该墓碑）
    landed = pull(client, tok["access"], since=0)
    assert [c["entity"]["id"] for c in landed["changes"]] == ["e1"]
    assert landed["changes"][0]["entity"]["deletedAt"] is not None
    cursor_b = landed["cursor"]

    # 时间推进 > 30 天（把墓碑回拨到 31 天前）
    backdate_tombstone(uid, "agents", "e1", now - timedelta(days=31))

    # 设备 A 空 push 触发 GC → 墓碑行被删
    push(client, tok["access"])
    assert item_ids(uid) == []

    # 设备 B 从自己的水位再 pull：拿不到任何「存活」版本 → 本地保持删除态
    delta = pull(client, tok["access"], since=cursor_b)
    assert [c for c in delta["changes"] if c["entity"]["id"] == "e1"] == []

    # 设备 B 再 push 自己的墓碑：服务端把它当新建墓碑写回，**不得**变回存活
    push(
        client,
        tok["access"],
        changes=[
            {
                "collection": "agents",
                "entity": entity("e1", rev=2, deletedAt=iso_z(now - timedelta(days=31))),
            }
        ],
    )

    after = pull(client, tok["access"], since=0)
    e1 = [c for c in after["changes"] if c["entity"]["id"] == "e1"]
    assert len(e1) == 1
    assert e1[0]["entity"]["deletedAt"] is not None, "GC 后重推墓碑不得让条目复活成存活"
