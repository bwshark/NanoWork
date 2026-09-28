"""批次 5：`sessionEvents` 服务端往返 / 幂等 / 共享游标 / 隔离 / reset。

事件是 **append-only 的不可变事实**，与 LWW 实体的关键差异都在这里被钉死：

- **不做 `updatedAt` 归一**（事件的 `timestamp` / `seq` 是权威事实，服务端不重写）；
- **幂等由唯一键 `(user_id, session_id, event_id)` 把关**：重复推**不写库、不推进
  `server_seq`**（对齐批次 4 实体的「完全同版幂等跳过」纪律）；
- **`server_seq` 与 `sync_items` 共享**同一条每用户游标：`pull(since)` 一次取全。

判据命名对齐规格 §2.2 的 **J2-a..J2-f**（QA 变异测试按用例名定位）。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers, register


def push(
    client: TestClient,
    token: str,
    events: list[dict] | None = None,
    changes: list[dict] | None = None,
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


def event(event_id: str, session_id: str = "s1", seq: int = 1, **extra: object) -> dict:
    """一条自描述事件（`sessionId` 在事件体内，与客户端 `SessionEvent` 同形）。"""
    base: dict[str, object] = {
        "id": event_id,
        "sessionId": session_id,
        "parentId": None,
        "seq": seq,
        "type": "message",
        "timestamp": 1000 + seq,
    }
    base.update(extra)
    return base


def entity(eid: str = "e1", rev: int = 1, **extra: object) -> dict:
    base: dict[str, object] = {
        "id": eid,
        "rev": rev,
        "updatedAt": "2026-01-01T00:00:00.000Z",
    }
    base.update(extra)
    return base


# ─────────────────────────── J2-a ───────────────────────────


def test_push_events_then_pull_returns_them(client: TestClient) -> None:
    token = register(client, "ev-a@example.com")["access"]

    result = push(
        client,
        token,
        events=[event("e-1", seq=1), event("e-2", seq=2), event("e-3", seq=3)],
    )
    assert result["accepted_events"] == 3

    pulled = pull(client, token, since=0)
    assert [e["id"] for e in pulled["events"]] == ["e-1", "e-2", "e-3"]
    assert [e["seq"] for e in pulled["events"]] == [1, 2, 3], "应按 server_seq / seq 有序"
    assert pulled["cursor"] == result["cursor"], "游标应前进到本批序号"


# ─────────────────────────── J2-b ───────────────────────────


def test_repush_same_events_is_idempotent(client: TestClient) -> None:
    token = register(client, "ev-b@example.com")["access"]
    batch = [event("e-1", seq=1), event("e-2", seq=2)]

    first = push(client, token, events=batch)
    assert first["accepted_events"] == 2
    cursor = pull(client, token, since=0)["cursor"]

    # 删掉幂等跳过 → 这里会得到 2（写库 + 推进 seq）
    second = push(client, token, events=batch)
    assert second["accepted_events"] == 0

    # seq 未推进：游标不变
    assert pull(client, token, since=0)["cursor"] == cursor
    # 带新游标再拉：空
    assert pull(client, token, since=cursor)["events"] == []


# ─────────────────────────── J2-c ───────────────────────────


def test_events_and_entities_share_cursor(client: TestClient) -> None:
    token = register(client, "ev-c@example.com")["access"]

    # 同一 push 内：1 实体 + 1 事件，共用同一个 server_seq
    first = push(
        client,
        token,
        changes=[{"collection": "agents", "entity": entity("a1", name="A")}],
        events=[event("e-1", seq=1)],
    )
    assert first["accepted"] == ["a1"]
    assert first["accepted_events"] == 1

    pulled = pull(client, token, since=0)
    assert [c["entity"]["id"] for c in pulled["changes"]] == ["a1"]
    assert [e["id"] for e in pulled["events"]] == ["e-1"]
    cursor = pulled["cursor"]

    # 再推一条新事件 → 从旧游标只拉到新事件（实体不重复）
    push(client, token, events=[event("e-2", seq=2)])
    delta = pull(client, token, since=cursor)
    assert [e["id"] for e in delta["events"]] == ["e-2"]
    assert delta["changes"] == []


# ─────────────────────────── J2-d ───────────────────────────


def test_event_payload_is_not_normalized(client: TestClient) -> None:
    token = register(client, "ev-d@example.com")["access"]

    push(client, token, events=[event("e-1", seq=7, timestamp=123456)])

    pulled = pull(client, token, since=0)["events"]
    assert len(pulled) == 1
    # 把事件塞进实体归一分支 → timestamp / seq 被改写、多出 updatedAt → 红
    assert pulled[0]["seq"] == 7
    assert pulled[0]["timestamp"] == 123456
    assert "updatedAt" not in pulled[0], "事件不做 updatedAt 归一"


# ─────────────────────────── J2-e ───────────────────────────


def test_events_isolated_per_user(client: TestClient) -> None:
    a = register(client, "ev-ua@example.com")["access"]
    b = register(client, "ev-ub@example.com")["access"]

    push(client, a, events=[event("e-1", session_id="s1")])

    # 正面断言：**a 必须能拉到自己刚推的事件**。仅断言「b 拉到 []」是平凡通过——
    # 把 pull 的事件通道整体禁用（M② 变异）后，b 侧仍是 []，用例照样绿。
    # 补上 a 侧正面断言后，事件通道被禁用 → 这里变红，判据才真正成立。
    assert [e["id"] for e in pull(client, a, since=0)["events"]] == ["e-1"]
    # 反向断言：b 看不到 a 的事件
    assert pull(client, b, since=0)["events"] == []

    # 再补双向正面：b 推自己的事件后，b 能拉到自己的、a 拉不到 b 的（隔离双向成立）。
    push(client, b, events=[event("e-2", session_id="s1")])
    assert [e["id"] for e in pull(client, b, since=0)["events"]] == ["e-2"]
    assert [e["id"] for e in pull(client, a, since=0)["events"]] == ["e-1"]


# ─────────────────────────── J2-f ───────────────────────────


def test_reset_clears_events(client: TestClient) -> None:
    token = register(client, "ev-reset@example.com")["access"]

    push(client, token, events=[event("e-1", seq=1)])
    assert len(pull(client, token, since=0)["events"]) == 1

    resp = client.delete("/api/sync/reset", headers=auth_headers(token))
    assert resp.status_code == 204

    # reset 不清事件 → 这里仍能拉到 → 红
    assert pull(client, token, since=0)["events"] == []


# ─────────────────────────── J2-g ───────────────────────────


def test_pure_event_batches_advance_shared_cursor(client: TestClient) -> None:
    """纯事件（不含实体）连续两批：第二批必须能被 `since=第一批游标` 拉到。

    守「事件与实体**共享** `server_seq` 命名空间」（规格 Q2 / §7 单一游标）：
    若 `_next_seq` 只取 `sync_items` 最大值（忽略 `sync_events`），两批**纯事件**
    会拿到**同一个** `server_seq`；`pull` 用 `> since` 严格过滤，第二批就永远拉不到
    → 本用例变红。J2-a..f 都混入了实体或单批事件，无一能证伪这一点，故单列此条。
    """
    token = register(client, "ev-cursor@example.com")["access"]

    # —— 第一批纯事件（changes 为空）——
    first = push(client, token, events=[event("e-1", seq=1)])
    assert first["accepted"] == []
    assert first["accepted_events"] == 1
    assert first["cursor"] == 1, "空库首批应从序号 1 起步"

    c1 = pull(client, token, since=0)["cursor"]
    assert c1 == first["cursor"]
    assert [e["id"] for e in pull(client, token, since=0)["events"]] == ["e-1"]

    # —— 第二批纯事件 ——
    second = push(client, token, events=[event("e-2", seq=2)])
    assert second["accepted_events"] == 1
    assert second["cursor"] > first["cursor"], (
        "事件写入必须推进共享游标（只取 sync_items 最大值 → 这里会相等 → 红）"
    )

    # 关键：从 C1 增量拉取必须拿到第二批（撞号则漏拉 → 红）
    delta = pull(client, token, since=c1)
    assert [e["id"] for e in delta["events"]] == ["e-2"], (
        "事件与实体撞号 → 第二批 server_seq 未越过 C1 → 漏拉 → 红"
    )
    assert delta["changes"] == []
