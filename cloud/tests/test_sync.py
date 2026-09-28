"""push / pull 往返与三条服务端不变量。

这里最有价值的是 `test_update_after_first_pull_is_visible`：它守的是
「游标必须用 server_seq 而不是行 id」。用 id 当游标时，第一次同步能成功、
此后所有更新都拉不到——症状出现得很晚，但成因就在那一行。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.timeutil import utc_now
from tests.conftest import auth_headers, register


def push(client: TestClient, token: str, collection: str, entity: dict) -> dict:
    resp = client.post(
        "/api/sync/push",
        json={"changes": [{"collection": collection, "entity": entity}]},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def pull(client: TestClient, token: str, since: int = 0) -> dict:
    resp = client.get(f"/api/sync/pull?since={since}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def iso_z(dt: datetime) -> str:
    """序列化成 JS `toISOString()` 的形状（`...Z`）。

    不能对 aware datetime 直接 `isoformat() + "Z"`——它本身已带 `+00:00`，
    拼出来是 `...+00:00Z`，服务端解析失败后会把时间静默退化成 EPOCH，
    症状是「LWW 全部按零值裁决」，看起来像裁决逻辑坏了。
    """
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def entity(
    eid: str = "e1",
    rev: int = 1,
    updated_at: datetime | None = None,
    **extra: object,
) -> dict:
    base: dict[str, object] = {
        "id": eid,
        "rev": rev,
        "updatedAt": iso_z(updated_at or datetime.now(UTC)),
    }
    base.update(extra)
    return base


def test_push_then_pull_returns_entity(client: TestClient) -> None:
    token = register(client, "sync1@example.com")["access"]

    result = push(client, token, "agents", entity("a1", name="助手"))
    assert result["accepted"] == ["a1"]
    assert result["conflicts"] == []

    changes = pull(client, token)["changes"]
    assert len(changes) == 1
    assert changes[0]["collection"] == "agents"
    assert changes[0]["entity"]["id"] == "a1"
    assert changes[0]["entity"]["name"] == "助手"


def test_cursor_is_monotonic_and_empties_after_consume(client: TestClient) -> None:
    token = register(client, "sync2@example.com")["access"]

    first = push(client, token, "agents", entity("a1"))
    cursor = first["cursor"]
    assert cursor > 0

    consumed = pull(client, token, since=0)
    assert consumed["cursor"] == cursor
    # 带着新游标再拉：不应重复
    assert pull(client, token, since=cursor)["changes"] == []


def test_update_after_first_pull_is_visible(client: TestClient) -> None:
    """关键守卫：第一次 pull 之后再 push 的**更新**，对端必须还能拉到。"""
    token = register(client, "sync3@example.com")["access"]

    push(client, token, "agents", entity("a1", rev=1, name="旧名"))
    cursor = pull(client, token, since=0)["cursor"]

    push(client, token, "agents", entity("a1", rev=2, name="新名"))
    changes = pull(client, token, since=cursor)["changes"]

    assert len(changes) == 1, "更新后的行必须产生新的游标位置，否则对端永远拉不到"
    assert changes[0]["entity"]["name"] == "新名"


def test_stale_push_reports_conflict_with_server_copy(client: TestClient) -> None:
    token = register(client, "sync4@example.com")["access"]

    now = datetime.now(UTC)
    push(client, token, "agents", entity("a1", rev=5, updated_at=now, name="服务端新"))
    stale = push(
        client,
        token,
        "agents",
        entity("a1", rev=3, updated_at=now - timedelta(hours=1), name="客户端旧"),
    )

    assert stale["accepted"] == []
    assert len(stale["conflicts"]) == 1
    assert stale["conflicts"][0]["id"] == "a1"
    # 服务端把自家版本回给客户端，供其按 merge 语义落地（§六 #9）
    assert stale["conflicts"][0]["server"]["name"] == "服务端新"


def test_client_clock_skew_cannot_hijack_lww(client: TestClient) -> None:
    """§5.3：客户端上报「未来时间」也不能永久赢。

    裁决用的是**服务端接收时间**，所以后到的写入一定赢，与它自称的时间无关。
    """
    token = register(client, "sync5@example.com")["access"]

    future = datetime.now(UTC) + timedelta(days=365)
    push(client, token, "agents", entity("a1", rev=1, updated_at=future, name="未来"))
    later = push(
        client, token, "agents", entity("a1", rev=1, updated_at=datetime.now(UTC), name="现在")
    )

    assert later["accepted"] == ["a1"], "后到的写入必须赢，否则时钟快的设备永久劫持 LWW"

    changes = pull(client, token, since=0)["changes"]
    assert changes[-1]["entity"]["name"] == "现在"


def test_payload_is_isolated_per_user(client: TestClient) -> None:
    a = register(client, "ua@example.com")["access"]
    b = register(client, "ub@example.com")["access"]

    push(client, a, "agents", entity("shared", name="A 的数据"))
    assert pull(client, b)["changes"] == []


def test_sync_requires_auth(client: TestClient) -> None:
    assert client.post("/api/sync/push", json={"changes": []}).status_code in (401, 403)
    assert client.get("/api/sync/pull").status_code in (401, 403)


def test_entity_without_id_is_skipped_not_fatal(client: TestClient) -> None:
    """缺 id 的实体跳过，但不能让同一批里的合法实体一起失败。"""
    token = register(client, "sync6@example.com")["access"]

    resp = client.post(
        "/api/sync/push",
        json={
            "changes": [
                {"collection": "agents", "entity": {"name": "没有 id"}},
                {"collection": "agents", "entity": entity("a1", name="有 id")},
            ]
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["accepted"] == ["a1"]


def _parse_iso(value: str) -> datetime:
    """把服务端 / 客户端上报的 `...Z` 串解析成 aware UTC（解析失败会抛错，便于定位）。"""
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    return datetime.fromisoformat(text)


def test_push_normalizes_updated_at_to_server_receive_time(client: TestClient) -> None:
    """C2 之一：落库前把 payload 的 `updatedAt` 归一为服务端接收时刻。

    客户端上报一个「明显偏旧」的时间（`now - 1 day`），push 接受后 pull 回来的
    `updatedAt` **不应等于**客户端上报值，而应接近服务端当前时刻——否则 §5.3
    说的「pull 下发的也是归一后的值」只是半句空话。
    """
    token = register(client, "sync-norm@example.com")["access"]

    client_supplied = datetime.now(UTC) - timedelta(days=1)
    result = push(client, token, "agents", entity("a1", updated_at=client_supplied, name="归一"))
    assert result["accepted"] == ["a1"]

    pulled = pull(client, token)["changes"]
    assert len(pulled) == 1
    pulled_at = _parse_iso(pulled[0]["entity"]["updatedAt"])

    # 不等于客户端上报值
    assert pulled_at != client_supplied.astimezone(UTC)
    # 而是接近服务端当前时刻（两个时钟不再混比）
    assert pulled_at > client_supplied.astimezone(UTC)
    assert abs((pulled_at - utc_now()).total_seconds()) < 5


def test_identical_push_is_idempotent_and_does_not_advance_seq(client: TestClient) -> None:
    """C2 之二：完全同版的 push 幂等跳过（不写库、不推进 server_seq、不进 accepted）。

    模拟客户端真实行为：`SyncEngine` 在 `accepted` 非空后会**再 pull 一次**取回服务端
    归一后的 `updatedAt`，下一轮全量 push 送上来的就是这份归一后的 payload。用「回拉到的
    payload」再 push 一次，必须被幂等跳过——否则空闲同步会无限「写库 + seq+1 + 回拉」。
    """
    token = register(client, "sync-idem@example.com")["access"]

    first = push(client, token, "agents", entity("a1", name="稳定"))
    assert first["accepted"] == ["a1"]

    # 客户端回拉：拿到服务端归一后的实体（updatedAt 已被改成服务端接收时刻）
    pulled_before = pull(client, token, since=0)["changes"]
    assert len(pulled_before) == 1
    normalized = pulled_before[0]["entity"]
    cursor_before = pull(client, token, since=0)["cursor"]

    # 用**归一后的 payload** 再 push（与已存内容完全同版）
    second = push(client, token, "agents", normalized)

    # 幂等跳到：既不是 accepted，也不是 conflict（真·空转）
    assert second["accepted"] == []
    assert second["conflicts"] == []
    # server_seq 未推进（用 pull 的 cursor 观察，而不是 push 返回的那个「下一号」）
    assert pull(client, token, since=0)["cursor"] == cursor_before
    # 内容与第一次一致
    assert pull(client, token, since=0)["changes"] == pulled_before
