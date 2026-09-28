"""认证相关表：用户与 refresh token。

refresh token 为什么要落库：JWT 是无状态的，但**轮换**（rotation）必须能识别
「同一个 refresh token 被用了第二次」——那意味着令牌泄露，此时要把整条轮换链
一次性吊销。只靠 JWT 自身签名是做不到的（旧 token 在过期前依然合法）。
"""

from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.timeutil import utc_now


class User(SQLModel, table=True):
    __tablename__ = "users"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    email: str = Field(unique=True, index=True)
    password_hash: str
    created_at: datetime = Field(default_factory=utc_now)


class RefreshToken(SQLModel, table=True):
    __tablename__ = "refresh_tokens"  # type: ignore[assignment]

    # jti 即主键：JWT 里带的就是它，查库无需二次索引
    jti: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    expires_at: datetime
    revoked_at: datetime | None = None
    # 轮换链：本次刷新签发的新 jti。吊销时沿链向下传播
    replaced_by: str | None = None
