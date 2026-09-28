"""时间工具：全场统一 **aware UTC**。

为什么不是 naive UTC：sqlmodel 0.0.47 的 `datetime` 字段强制要求时区信息
（写入 naive 值会抛 `ValueError: Datetime values must have timezone information`）。
已实测 SQLite 对 aware datetime 的往返是保真的（读回仍带 `tzinfo=UTC`），
所以直接用 aware 不会引入方言差异。

为什么不用 `datetime.utcnow()`：它在 3.12 起被弃用，且返回 naive——
这两条恰好都会把人引向错误的写法。
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_z(dt: datetime) -> str:
    """序列化成 JS `toISOString()` 的形状（`...Z`）。

    客户端与测试都用这个形状上报 / 解析时间，服务端**落库前归一 `updatedAt`**
    （`sync/routes.py`）也必须用它，否则两侧字符串形式不一致。

    不能对 aware datetime 直接 `isoformat() + "Z"`——它本身已带 `+00:00`，
    拼出来是 `...+00:00Z`，`fromisoformat` 解析失败后会把时间静默退化成 EPOCH，
    症状是「LWW 全部按零值裁决」，看起来像裁决逻辑坏了。
    """
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def coerce_utc(raw: object) -> datetime | None:
    """把客户端上报的时间归一成 aware UTC；无法解析时返回 `None`（不抛错）。

    不抛错是刻意的：老数据（`SyncMeta` 落地之前的实体）本就没有这些字段，
    它们应当按「零值版本」参与 LWW，被服务端版本正常覆盖，而不是让整批 push 失败。
    """
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    if isinstance(raw, str) and raw:
        # JS `toISOString()` 的 `...Z` 后缀：`fromisoformat` 在 3.11 之前不认 Z
        text = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None
