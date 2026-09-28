"""/api/auth/* 五个端点：register / login / refresh / logout / me。

refresh 轮换里的**重用检测**是这个文件唯一不直观的地方，值得说明：

轮换后旧 refresh token 被标记 revoked 并指向新 jti。若端点收到一个「已 revoked
但 replaced_by 非空」的 token，说明有人在用它换新票——而合法客户端早就换过了，
所以这只能是**重放**：令牌泄露。此时不能只拒绝这一次，要把整条轮换链全部吊销
（用户必须重新登录）。只吊销当前这一张的话，攻击者手里的旧票依然能一路换下去。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlmodel import Session, select

from app.auth.deps import current_user, user_by_email
from app.auth.models import RefreshToken, User
from app.auth.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    new_user_id,
    verify_password,
)
from app.db import get_session
from app.timeutil import utc_now

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 轮换链理论上不应成环；一旦因 bug 成环，吊销遍历必须有上限而不是死循环
MAX_REVOKE_DEPTH = 100


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh: str


class LogoutRequest(BaseModel):
    # 可选：只带 access 也能登出（吊销该用户全部 refresh），
    # 客户端 token 丢了不至于永远退不掉
    refresh: str | None = None


class UserOut(BaseModel):
    id: str
    email: str


class TokenPair(BaseModel):
    access: str
    refresh: str
    user: UserOut


class AccessOut(BaseModel):
    access: str


def _issue_pair(session: Session, user: User) -> TokenPair:
    """签发一对令牌并把 refresh 的 jti 落库（`_revoke_chain` 要靠它走链）。"""
    access = create_access_token(user.id)
    refresh, jti, expires_at = create_refresh_token(user.id)
    session.add(RefreshToken(jti=jti, user_id=user.id, expires_at=expires_at))
    return TokenPair(access=access, refresh=refresh, user=UserOut(id=user.id, email=user.email))


def _revoke_chain(session: Session, jti: str) -> None:
    """沿 `replaced_by` 一路吊销到链尾。"""
    seen: set[str] = set()
    cursor: str | None = jti
    for _ in range(MAX_REVOKE_DEPTH):
        if cursor is None or cursor in seen:
            return
        seen.add(cursor)
        token = session.get(RefreshToken, cursor)
        if token is None:
            return
        token.revoked_at = utc_now()
        session.add(token)
        cursor = token.replaced_by


@router.post("/register", response_model=TokenPair, status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, session: Session = Depends(get_session)) -> TokenPair:
    if user_by_email(session, body.email) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="邮箱已注册")

    user = User(id=new_user_id(), email=body.email, password_hash=hash_password(body.password))
    session.add(user)
    session.commit()
    session.refresh(user)

    pair = _issue_pair(session, user)
    session.commit()
    return pair


@router.post("/login", response_model=TokenPair)
def login(body: LoginRequest, session: Session = Depends(get_session)) -> TokenPair:
    user = user_by_email(session, body.email)
    # 用户不存在与密码错误返回**同一条**消息：否则可拿来判断某邮箱是否注册过
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")

    pair = _issue_pair(session, user)
    session.commit()
    return pair


@router.post("/refresh", response_model=TokenPair)
def refresh(body: RefreshRequest, session: Session = Depends(get_session)) -> TokenPair:
    try:
        payload = decode_token(body.refresh, "refresh")
    except Exception:  # noqa: BLE001 —— jwt 异常类型多，统一转 401 且不泄漏细节
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token 无效或已过期"
        ) from None

    jti = str(payload.get("jti", ""))
    record = session.get(RefreshToken, jti)
    if record is None:
        # 签名合法但库里没有：可能是密钥换了，也可能是伪造。一律拒绝
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token 未登记")

    if record.revoked_at is not None:
        # 重放：整条链吊销，用户必须重新登录
        _revoke_chain(session, jti)
        session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token 已被使用过"
        )

    if record.expires_at < utc_now():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token 已过期")

    user = session.get(User, record.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")

    pair = _issue_pair(session, user)
    # 轮换：旧票失效并指向新票
    record.revoked_at = utc_now()
    record.replaced_by = str(decode_token(pair.refresh, "refresh")["jti"])
    session.add(record)
    session.commit()
    return pair


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    body: LogoutRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    if body.refresh:
        try:
            payload = decode_token(body.refresh, "refresh")
        except Exception:  # noqa: BLE001 —— 票已无效时也算登出成功（幂等）
            payload = None
        if payload:
            _revoke_chain(session, str(payload["jti"]))
    else:
        # 没带 refresh：吊销该用户名下全部未失效的票（「在所有设备登出」语义）
        rows = session.exec(
            select(RefreshToken).where(
                RefreshToken.user_id == user.id,
                RefreshToken.revoked_at.is_(None),  # type: ignore[union-attr]
            )
        ).all()
        for row in rows:
            row.revoked_at = utc_now()
            session.add(row)
    session.commit()


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)) -> UserOut:
    return UserOut(id=user.id, email=user.email)
