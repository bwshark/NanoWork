"""组织内的两个守卫（组织路由与部门路由共用）。

抽出来的直接原因是部门路由也要做同一件事——「先确认是成员，再谈角色」。
复制一份到第二个文件里，等于让「404 还是 403」这条语义有第二个实现，
而它恰好是本模块最需要一致的地方（403 等于确认组织存在）。
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlmodel import Session

from app.auth.models import User
from app.orgs.models import OrgMember
from app.orgs.roles import role_at_least


def membership_or_404(session: Session, org_id: str, user: User) -> OrgMember:
    """取调用者在该组织里的成员记录；不是成员一律 404（不回 403）。"""
    member = session.get(OrgMember, (org_id, user.id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="组织不存在")
    return member


def require_role(member: OrgMember, minimum: str) -> None:
    """角色不够就 403（与上面的 404 分开：能确认存在性的人才配得到 403）。"""
    if not role_at_least(member.role, minimum):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="权限不足")
