"""`current_user` 依赖：Bearer → User。

刻意**不**顺带查 refresh token：access token 短命（30 分钟），它的有效性只看签名
与 exp。若在这里额外查库，等于给每个业务请求都加一次 DB 往返，而收益为零
（吊销 refresh 并不能让已签发的 access 提前失效，这是 JWT 的固有代价）。
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import Session, select

from app.auth.models import User
from app.auth.security import decode_token
from app.db import get_session

bearer_scheme = HTTPBearer(auto_error=True)


def current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    session: Session = Depends(get_session),
) -> User:
    try:
        payload = decode_token(credentials.credentials, "access")
    except Exception:  # noqa: BLE001 —— jwt 的异常类型多，统一转 401，别把细节泄漏给客户端
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="access token 无效或已过期"
        ) from None

    user_id = payload.get("sub")
    user = session.get(User, user_id) if user_id else None
    if user is None:
        # 用户被删了但 token 还没过期（删账户场景）→ 必须拒绝，否则能继续读写云端数据
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")
    return user


def user_by_email(session: Session, email: str) -> User | None:
    return session.exec(select(User).where(User.email == email)).first()
