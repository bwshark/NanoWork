"""/api/orgs/*：组织的创建、成员与角色（FR-12.2 的 MVP 落点）。

六个端点，都在一件事上守同一条纪律：**先确认调用者是这个组织的成员，再谈角色**。
两步分开写（`_membership_or_404` → `_require_role`）而不是塞进一个依赖里，是因为
两者的错误语义不同：不在组织里是 404（不泄露组织存在性），角色不够才是 403。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth.deps import current_user, user_by_email
from app.auth.models import User
from app.auth.security import new_user_id
from app.db import get_session
from app.orgs.guards import membership_or_404 as _membership_or_404
from app.orgs.guards import require_role as _require_role
from app.orgs.models import ORG_KIND_PERSONAL, Organization, OrgMember
from app.orgs.roles import (
    ROLE_ADMIN,
    ROLE_MEMBER,
    ROLE_OWNER,
    can_grant,
    is_valid_role,
)
from app.timeutil import iso_z

router = APIRouter(prefix="/api/orgs", tags=["orgs"])


class CreateOrgRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class OrgSummary(BaseModel):
    id: str
    name: str
    role: str
    memberCount: int
    createdAt: str


class MemberView(BaseModel):
    userId: str
    email: str
    role: str
    joinedAt: str


class AddMemberRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: str = ROLE_MEMBER


class UpdateRoleRequest(BaseModel):
    role: str


def _owner_count(session: Session, org_id: str) -> int:
    rows = session.exec(
        select(OrgMember).where(OrgMember.org_id == org_id, OrgMember.role == ROLE_OWNER)
    ).all()
    return len(rows)


def _assert_not_last_owner(session: Session, org_id: str, target_role: str) -> None:
    """把最后一个 owner 降级 / 移除，会让组织再也无人能任命 owner。"""
    if target_role != ROLE_OWNER:
        return
    if _owner_count(session, org_id) <= 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="组织至少要保留一个 owner",
        )


@router.post("", response_model=OrgSummary, status_code=status.HTTP_201_CREATED)
def create_org(
    payload: CreateOrgRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> OrgSummary:
    """建组织：创建者自动成为 owner（没有「无主组织」这个状态）。"""
    org = Organization(id=new_user_id(), name=payload.name.strip(), created_by=user.id)
    session.add(org)
    session.add(OrgMember(org_id=org.id, user_id=user.id, role=ROLE_OWNER))
    session.commit()
    session.refresh(org)
    return OrgSummary(
        id=org.id,
        name=org.name,
        role=ROLE_OWNER,
        memberCount=1,
        createdAt=iso_z(org.created_at),
    )


@router.get("", response_model=list[OrgSummary])
def list_orgs(
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[OrgSummary]:
    """我加入的**团队**（个人空间不算团队，见下）。

    `kind=personal` 的组织是个人知识库的私有容器（`kb/personal.py`）。把它列进团队树，
    用户会以为「我加入了一个只有我一个人的公司」，而且它和真实团队在侧栏里长得一模一样 ——
    个人库有专属入口，这条不该出现。
    """
    memberships = session.exec(select(OrgMember).where(OrgMember.user_id == user.id)).all()
    out: list[OrgSummary] = []
    for membership in memberships:
        org = session.get(Organization, membership.org_id)
        if org is None:  # 组织被删但成员行还在（脏数据）：跳过而不是 500
            continue
        if org.kind == ORG_KIND_PERSONAL:  # 私有空间不是团队
            continue
        count = len(session.exec(select(OrgMember).where(OrgMember.org_id == org.id)).all())
        out.append(
            OrgSummary(
                id=org.id,
                name=org.name,
                role=membership.role,
                memberCount=count,
                createdAt=iso_z(org.created_at),
            )
        )
    # 稳定顺序：按创建时间升序（新组织排后面），时间相同再按 id 兜底
    return sorted(out, key=lambda item: (item.createdAt, item.id))


@router.get("/{org_id}/members", response_model=list[MemberView])
def list_members(
    org_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[MemberView]:
    """成员列表：任何成员都能看（知道同事是谁不需要管理员权限）。"""
    _membership_or_404(session, org_id, user)
    rows = session.exec(select(OrgMember).where(OrgMember.org_id == org_id)).all()
    out: list[MemberView] = []
    for row in rows:
        member_user = session.get(User, row.user_id)
        if member_user is None:
            continue
        out.append(
            MemberView(
                userId=row.user_id,
                email=member_user.email,
                role=row.role,
                joinedAt=iso_z(row.joined_at),
            )
        )
    return sorted(out, key=lambda item: (item.role, item.email))


@router.post("/{org_id}/members", response_model=MemberView, status_code=201)
def add_member(
    org_id: str,
    payload: AddMemberRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> MemberView:
    """按邮箱加人（MVP 不做邀请邮件：对方必须**已有账户**）。

    **私有空间（个人知识库）不允许加人**：那里的资料写着「仅自己可见」。`kind` 只是
    元数据，不在这里挡一道，任何拿到自己 org_id 的调用方都能把同事拉进个人空间 ——
    隐私就成了界面上的一句话。
    """
    actor = _membership_or_404(session, org_id, user)
    _require_role(actor, ROLE_ADMIN)
    org = session.get(Organization, org_id)
    if org is not None and org.kind == ORG_KIND_PERSONAL:
        raise HTTPException(status_code=403, detail="个人空间不能添加成员")
    if not is_valid_role(payload.role):
        raise HTTPException(status_code=422, detail="角色不存在")
    if not can_grant(actor.role, payload.role):
        raise HTTPException(status_code=403, detail="不能授予高于自己的角色")

    target = user_by_email(session, payload.email.strip().lower())
    if target is None:
        # 这里会暴露「该邮箱是否注册」——但调用者是本组织的 admin，
        # 换来的是可用的邀请流程；不用「假装发了一封邀请邮件」来掩盖。
        raise HTTPException(status_code=404, detail="该邮箱还没有账户")
    if session.get(OrgMember, (org_id, target.id)) is not None:
        raise HTTPException(status_code=409, detail="该用户已在组织中")

    member = OrgMember(org_id=org_id, user_id=target.id, role=payload.role)
    session.add(member)
    session.commit()
    session.refresh(member)
    return MemberView(
        userId=target.id,
        email=target.email,
        role=member.role,
        joinedAt=iso_z(member.joined_at),
    )


@router.patch("/{org_id}/members/{member_user_id}", response_model=MemberView)
def update_member_role(
    org_id: str,
    member_user_id: str,
    payload: UpdateRoleRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> MemberView:
    actor = _membership_or_404(session, org_id, user)
    _require_role(actor, ROLE_ADMIN)
    if not is_valid_role(payload.role):
        raise HTTPException(status_code=422, detail="角色不存在")
    if not can_grant(actor.role, payload.role):
        raise HTTPException(status_code=403, detail="不能授予高于自己的角色")

    target = session.get(OrgMember, (org_id, member_user_id))
    if target is None:
        raise HTTPException(status_code=404, detail="该用户不是组织成员")
    # 目标当前是 owner 而自己在降级他 → 走「最后一个 owner」判定
    if target.role == ROLE_OWNER and payload.role != ROLE_OWNER:
        _assert_not_last_owner(session, org_id, ROLE_OWNER)

    target.role = payload.role
    session.add(target)
    session.commit()
    session.refresh(target)
    member_user = session.get(User, target.user_id)
    return MemberView(
        userId=target.user_id,
        email=member_user.email if member_user else "",
        role=target.role,
        joinedAt=iso_z(target.joined_at),
    )


@router.delete("/{org_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    org_id: str,
    member_user_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    """移除成员；**自己可以主动退出**（不需要管理员权限）。

    退出是自己能决定的事，把「退出组织」也要求 admin 权限会逼用户去求管理员 ——
    而他要离开往往正是因为那个管理员。
    """
    actor = _membership_or_404(session, org_id, user)
    is_self = member_user_id == user.id
    if not is_self:
        _require_role(actor, ROLE_ADMIN)

    target = session.get(OrgMember, (org_id, member_user_id))
    if target is None:
        raise HTTPException(status_code=404, detail="该用户不是组织成员")
    if target.role == ROLE_OWNER:
        _assert_not_last_owner(session, org_id, ROLE_OWNER)

    session.delete(target)
    session.commit()
