"""LWW 三级 tie-break 逐条验证（m6 §七 批次 1 的完成判据）。

第三级只能通过 `compare_versions()` 直接测：`resolve()` 的两端 `entity_id` 必然相同，
字典序那条分支永远平局，在 `resolve()` 里测不出来。
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.sync.merger import VersionStamp, compare_versions, resolve

T0 = datetime(2026, 9, 28, 12, 0, 0, tzinfo=UTC)
T1 = datetime(2026, 9, 28, 12, 0, 1, tzinfo=UTC)


def stamp(
    entity_id: str = "e1", rev: int = 1, updated_at: datetime = T0, deleted_at: None = None
) -> VersionStamp:
    return VersionStamp(entity_id=entity_id, rev=rev, updated_at=updated_at, deleted_at=deleted_at)


def test_level1_newer_time_wins() -> None:
    assert compare_versions(stamp(updated_at=T1), stamp(updated_at=T0)) > 0
    assert compare_versions(stamp(updated_at=T0), stamp(updated_at=T1)) < 0


def test_level2_same_time_newer_rev_wins() -> None:
    assert compare_versions(stamp(rev=5), stamp(rev=3)) > 0
    assert compare_versions(stamp(rev=3), stamp(rev=5)) < 0


def test_level3_same_time_and_rev_entity_id_lexicographic() -> None:
    assert compare_versions(stamp(entity_id="b"), stamp(entity_id="a")) > 0
    assert compare_versions(stamp(entity_id="a"), stamp(entity_id="b")) < 0


def test_identical_version_is_zero() -> None:
    assert compare_versions(stamp(), stamp()) == 0


def test_create_when_no_current() -> None:
    verdict = resolve(None, stamp())
    assert verdict.accepted is True
    assert verdict.reason == "created"


def test_incoming_newer_is_accepted() -> None:
    verdict = resolve(stamp(updated_at=T0, rev=1), stamp(updated_at=T1, rev=1))
    assert verdict.accepted is True
    assert verdict.reason == "incoming_newer_time"


def test_same_time_incoming_higher_rev_is_accepted() -> None:
    verdict = resolve(stamp(rev=2), stamp(rev=7))
    assert verdict.accepted is True
    assert verdict.reason == "incoming_newer_rev"


def test_server_newer_is_rejected_and_returns_server_stamp() -> None:
    server = stamp(updated_at=T1, rev=1)
    verdict = resolve(server, stamp(updated_at=T0, rev=9))
    assert verdict.accepted is False
    assert verdict.reason == "server_newer_time"
    assert verdict.winner is server


def test_identical_push_is_idempotent() -> None:
    """同版本重复推送：接受，且不算冲突——幂等是同步能重入的前提。"""
    verdict = resolve(stamp(), stamp())
    assert verdict.accepted is True
    assert verdict.reason == "identical"


def test_deleted_at_does_not_participate_in_tie_break() -> None:
    """墓碑与存活版本在同一时刻只按前三级裁决：`deletedAt` 不参与比较。

    否则会出现「同一时刻、删除反而赢不了」的随机结果——删除的传播必须也靠时间戳，
    不能靠「是不是墓碑」这个身份。
    """
    live = stamp(updated_at=T0, rev=1)
    tomb = VersionStamp(entity_id="e1", rev=1, updated_at=T0, deleted_at=T0)
    assert compare_versions(tomb, live) == 0
