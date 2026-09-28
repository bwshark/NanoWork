"""密码哈希与 JWT 签发/校验。

两个刻意的选择：

1. **直接用 `bcrypt` 原生 API，不引 passlib**：passlib 1.7.4 在 Python 3.12+ 与
   bcrypt 4.x 的组合下会抛 `(trapped) error reading bcrypt version`，已停止维护。
2. **access 与 refresh 用 `typ` claim 区分**：两者签名密钥相同，若不区分类型，
   一个 refresh token 可以直接当 access token 用（权限更长的那张票能当短的使），
   反之亦然会让「刷新」端点接受任意短票去换新票。
"""

from __future__ import annotations

import os
import secrets
import uuid
from datetime import datetime, timedelta

import bcrypt
import jwt

from app.timeutil import utc_now

ACCESS_TTL = timedelta(minutes=30)
REFRESH_TTL = timedelta(days=30)

_DEV_SECRET = "nanowork-cloud-dev-secret-not-for-production"
_SECRET: str | None = None


def secret_key() -> str:
    """返回签名密钥。

    生产环境必须显式提供 `NANOWORK_CLOUD_SECRET`——否则每次重启都会换密钥，
    所有已签发的 token 瞬间失效，而症状是「用户随机掉线」，极难定位。
    所以这里选择 fail-fast 而不是兜底一个随机值。
    """
    global _SECRET
    if _SECRET is None:
        env = os.environ.get("NANOWORK_CLOUD_SECRET")
        if env:
            _SECRET = env
        elif os.environ.get("NANOWORK_CLOUD_ENV") == "production":
            raise RuntimeError("生产环境必须设置 NANOWORK_CLOUD_SECRET")
        else:
            # 开发期固定值（而非随机）：否则重启即掉线，本地联调没法做
            _SECRET = _DEV_SECRET
    return _SECRET


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))
    except (ValueError, TypeError):
        # 库里存了非 bcrypt 格式的哈希（脏数据/迁移残留）→ 当验证失败处理，
        # 不能让它抛 500，否则一条坏数据就能打挂登录端点
        return False


def _encode(typ: str, user_id: str, ttl: timedelta, jti: str | None = None) -> tuple[str, str]:
    now = utc_now()
    claims = {
        "sub": user_id,
        "typ": typ,
        "iat": now,
        "exp": now + ttl,
        "jti": jti or uuid.uuid4().hex,
    }
    token = jwt.encode(claims, secret_key(), algorithm="HS256")
    return token, str(claims["jti"])


def create_access_token(user_id: str) -> str:
    token, _ = _encode("access", user_id, ACCESS_TTL)
    return token


def create_refresh_token(user_id: str) -> tuple[str, str, datetime]:
    """返回 `(token, jti, expires_at)`——jti 与过期时间都要落库，轮换靠它们。"""
    token, jti = _encode("refresh", user_id, REFRESH_TTL)
    return token, jti, utc_now() + REFRESH_TTL


def decode_token(token: str, expected_typ: str) -> dict:
    """校验并解码。任何不合法（过期/篡改/类型不符）一律抛 `jwt.PyJWTError`。"""
    payload = jwt.decode(token, secret_key(), algorithms=["HS256"])
    if payload.get("typ") != expected_typ:
        # 类型不符：不是「解析失败」，而是「这张票不该出现在这里」
        raise jwt.InvalidTokenError(f"期望 {expected_typ} token，实际 {payload.get('typ')}")
    return payload


def new_user_id() -> str:
    return uuid.uuid4().hex


def new_jti() -> str:
    return secrets.token_hex(16)
