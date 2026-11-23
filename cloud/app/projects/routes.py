"""/api/projects/*：项目空间的容器、成员与共享知识库（FR-12.7）。

## 权限口径（三层，逐条都有用例钉住）

| 动作 | 谁可以 |
|---|---|
| 看到项目列表 / 详情 | **本组织成员**（非成员一律 404，不泄露项目存在性） |
| 建项目 | 本组织成员（项目不授予任何额外权限，自组织无风险） |
| 改名 / 归档 / 加人 / 加库 / 移库 | 项目 `lead` **或** 组织 `admin`/`owner` |
| 删项目 | 组织 `admin`/`owner`（破坏性，不给 lead） |

`lead` 不能加非组织成员、不能把「自己都看不到的库」加进项目：前者是邀请旁路，
后者是确认 id 存在性的信息泄露（详情里的库列表还会按可见性过滤一层，两道闸都不能少）。

## 为什么详情里的库要过滤两次

`project_kbs` 只是关联表。成员在项目页看到的库必须**同时**满足「被关联」与
「我看得到」（`visible_kb_ids`）——否则同一本库在团队视图里看不见、在项目视图里却
露出标题与文档数，正是个人知识库那一轮踩过的组合漏洞。
"""

from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth.deps import current_user, user_by_email
from app.auth.models import User
from app.auth.security import new_user_id
from app.db import get_session
from app.kb.models import KbDocument, KnowledgeBase
from app.kb.visibility import member_can_read_kb, visible_kb_ids
from app.orgs.guards import membership_or_404 as _membership_or_404
from app.orgs.guards import require_role as _require_role
from app.orgs.models import OrgMember
from app.orgs.roles import ROLE_ADMIN, role_at_least
from app.projects.models import (
    PROJECT_ROLE_LEAD,
    Project,
    ProjectKb,
    ProjectMember,
)
from app.timeutil import iso_z, utc_now

router = APIRouter(tags=["projects"])


class CreateProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)


class UpdateProjectRequest(BaseModel):
    #: 三档语义：不传 = 不动 / 传空串 = 清空（`description` 专用）
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=500)
    archived: bool | None = None


class AddMemberRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class AddKbRequest(BaseModel):
    kbId: str = Field(min_length=1, max_length=64)


class ProjectMemberView(BaseModel):
    userId: str
    email: str
    role: str
    joinedAt: str


class ProjectKbView(BaseModel):
    id: str
    name: str
    documentCount: int


class ProjectView(BaseModel):
    id: str
    orgId: str
    name: str
    description: str
    createdBy: str
    createdAt: str
    archivedAt: str
    memberCount: int
    kbCount: int
    #: 我在这个项目里的角色；空串 = 我是组织成员但没加入这个项目
    myRole: str
    canManage: bool


class ProjectDetailView(BaseModel):
    project: ProjectView
    members: list[ProjectMemberView]
    kbs: list[ProjectKbView]


#: 共享记忆正文上限。与知识库文档的「超限报错而不是截断」同一条纪律：
#: 截断是**静默丢内容**，用户看见的是「保存成功」，下次打开发现少了一段。
PROJECT_MEMORY_MAX_CHARS = 20000


class ProjectMemoryView(BaseModel):
    text: str
    rev: int
    updatedAt: str
    #: 最后写入者的邮箱（解析不出来时回空串，不拿 id 冒充）
    updatedBy: str
    #: 我能不能改。**由服务端算好**，前端不要重算「我是不是 lead」——那是第二套规则
    canEdit: bool
    maxChars: int


class UpdateProjectMemoryRequest(BaseModel):
    text: str = Field(default="")
    #: 我读到的版本号。与服务端不一致即 409（乐观锁），不静默覆盖
    rev: int = Field(ge=0)


def _project_or_404(session: Session, project_id: str, user: User) -> tuple[Project, OrgMember]:
    """取项目 + 调用者的组织成员记录。

    非组织成员回 **404 而不是 403**：403 等于承认「这个项目存在，只是你没权限」，
    而项目 id 是可枚举的形状。与 `_kb_or_404` 同一条纪律。
    """
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    member = session.get(OrgMember, (project.org_id, user.id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project, member


def _project_role(session: Session, project_id: str, user_id: str) -> str:
    row = session.get(ProjectMember, (project_id, user_id))
    return row.role if row is not None else ""


def _can_manage(project_role: str, org_role: str) -> bool:
    return project_role == PROJECT_ROLE_LEAD or role_at_least(org_role, ROLE_ADMIN)


def _require_manage(session: Session, project: Project, user: User) -> None:
    org_member = session.get(OrgMember, (project.org_id, user.id))
    org_role = org_member.role if org_member is not None else ""
    if not _can_manage(_project_role(session, project.id, user.id), org_role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要项目负责人或组织管理员",
        )


def _view(
    project: Project,
    *,
    member_count: int,
    kb_count: int,
    my_role: str,
    org_role: str,
) -> ProjectView:
    return ProjectView(
        id=project.id,
        orgId=project.org_id,
        name=project.name,
        description=project.description,
        createdBy=project.created_by,
        createdAt=iso_z(project.created_at),
        archivedAt=project.archived_at,
        memberCount=member_count,
        kbCount=kb_count,
        myRole=my_role,
        canManage=_can_manage(my_role, org_role),
    )


def _doc_count(session: Session, kb_id: str) -> int:
    """在用文档数（回收站里的不算 —— 与知识库列表同口径，否则会显示「有 3 篇」但一篇都搜不到）。"""
    rows = session.exec(
        select(KbDocument).where(KbDocument.kb_id == kb_id, KbDocument.deleted_at == "")
    ).all()
    return len(rows)


@router.get("/api/orgs/{org_id}/projects", response_model=list[ProjectView])
def list_projects(
    org_id: str,
    includeArchived: bool = False,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[ProjectView]:
    """本组织可见的项目（非成员 404）。归档项目默认不出现。"""
    member = _membership_or_404(session, org_id, user)
    rows = session.exec(select(Project).where(Project.org_id == org_id)).all()
    if not includeArchived:
        rows = [p for p in rows if p.archived_at == ""]
    rows = sorted(rows, key=lambda p: p.created_at, reverse=True)
    if not rows:
        return []

    ids = [p.id for p in rows]
    member_rows = session.exec(
        select(ProjectMember).where(ProjectMember.project_id.in_(ids))
    ).all()
    kb_rows = session.exec(select(ProjectKb).where(ProjectKb.project_id.in_(ids))).all()
    member_counts = Counter(row.project_id for row in member_rows)
    kb_counts = Counter(row.project_id for row in kb_rows)
    my_roles = {
        row.project_id: row.role for row in member_rows if row.user_id == member.user_id
    }
    return [
        _view(
            project,
            member_count=member_counts.get(project.id, 0),
            kb_count=kb_counts.get(project.id, 0),
            my_role=my_roles.get(project.id, ""),
            org_role=member.role,
        )
        for project in rows
    ]


@router.post(
    "/api/orgs/{org_id}/projects",
    response_model=ProjectView,
    status_code=status.HTTP_201_CREATED,
)
def create_project(
    org_id: str,
    payload: CreateProjectRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ProjectView:
    """建项目：创建者自动成为 `lead`（没有「无主项目」这个状态）。"""
    member = _membership_or_404(session, org_id, user)
    project = Project(
        id=new_user_id(),
        org_id=org_id,
        name=payload.name.strip(),
        description=payload.description.strip(),
        created_by=user.id,
    )
    session.add(project)
    session.add(
        ProjectMember(
            project_id=project.id,
            user_id=user.id,
            org_id=org_id,
            role=PROJECT_ROLE_LEAD,
        )
    )
    session.commit()
    session.refresh(project)
    return _view(
        project, member_count=1, kb_count=0, my_role=PROJECT_ROLE_LEAD, org_role=member.role
    )


def _memory_view(session: Session, project: Project, user: User, org_role: str) -> ProjectMemoryView:
    writer = session.get(User, project.memory_updated_by) if project.memory_updated_by else None
    return ProjectMemoryView(
        text=project.memory_doc,
        rev=project.memory_rev,
        updatedAt=project.memory_updated_at,
        updatedBy=writer.email if writer is not None else "",
        canEdit=_can_manage(_project_role(session, project.id, user.id), org_role),
        maxChars=PROJECT_MEMORY_MAX_CHARS,
    )


@router.get("/api/projects/{project_id}/memory", response_model=ProjectMemoryView)
def get_project_memory(
    project_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ProjectMemoryView:
    """读项目共享记忆（项目所在组织的成员都可读）。

    读权限**不再收窄到项目成员**：组织成员本来就能看到项目列表与详情，把记忆藏起来
    只会让人以为「这项目没有记忆」，而它其实在别处被注入了提示词。
    """
    project, member = _project_or_404(session, project_id, user)
    return _memory_view(session, project, user, member.role)


@router.put("/api/projects/{project_id}/memory", response_model=ProjectMemoryView)
def update_project_memory(
    project_id: str,
    payload: UpdateProjectMemoryRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ProjectMemoryView:
    """写项目共享记忆（项目 `lead` 或组织 `admin`/`owner`，与改名同一条权限线）。

    ## 为什么带 `rev` 做乐观锁，而不是「最后写的赢」

    共享记忆是**多写者**场景，且每个人补的都是不同事实。LWW 在这里的表现是
    「B 保存后 A 补的两段凭空消失」——没有报错、没有痕迹，只有某天发现内容少了。
    409 把选择权交回写入方：重新拉一遍、看清别人改了什么、再合并。
    """
    project, member = _project_or_404(session, project_id, user)
    _require_manage(session, project, user)

    if len(payload.text) > PROJECT_MEMORY_MAX_CHARS:
        # 400 而不是静默截断：见 PROJECT_MEMORY_MAX_CHARS 的注释
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"共享记忆不能超过 {PROJECT_MEMORY_MAX_CHARS} 字符",
        )
    if payload.rev != project.memory_rev:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="共享记忆已被他人修改，请刷新后重新编辑",
        )

    project.memory_doc = payload.text
    project.memory_rev += 1
    project.memory_updated_at = iso_z(utc_now())
    project.memory_updated_by = user.id
    session.add(project)
    session.commit()
    session.refresh(project)
    return _memory_view(session, project, user, member.role)


@router.get("/api/projects/{project_id}", response_model=ProjectDetailView)
def get_project(
    project_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ProjectDetailView:
    project, member = _project_or_404(session, project_id, user)
    member_rows = session.exec(
        select(ProjectMember).where(ProjectMember.project_id == project.id)
    ).all()
    members: list[ProjectMemberView] = []
    for row in member_rows:
        target = session.get(User, row.user_id)
        members.append(
            ProjectMemberView(
                userId=row.user_id,
                email=target.email if target is not None else "",
                role=row.role,
                joinedAt=iso_z(row.joined_at),
            )
        )

    # 两道闸：既要在 project_kbs 里，又要是「我看得到」的库（见模块注释）
    visible = set(visible_kb_ids(session, project.org_id, member))
    linked = session.exec(select(ProjectKb).where(ProjectKb.project_id == project.id)).all()
    kbs: list[ProjectKbView] = []
    for link in linked:
        if link.kb_id not in visible:
            continue
        kb = session.get(KnowledgeBase, link.kb_id)
        if kb is None:
            continue
        kbs.append(
            ProjectKbView(
                id=kb.id,
                name=kb.name,
                documentCount=_doc_count(session, kb.id),
            )
        )

    my_role = next((row.role for row in member_rows if row.user_id == user.id), "")
    view = _view(
        project,
        member_count=len(members),
        kb_count=len(kbs),
        my_role=my_role,
        org_role=member.role,
    )
    return ProjectDetailView(project=view, members=members, kbs=kbs)


@router.patch("/api/projects/{project_id}", response_model=ProjectView)
def update_project(
    project_id: str,
    payload: UpdateProjectRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ProjectView:
    project, member = _project_or_404(session, project_id, user)
    _require_manage(session, project, user)
    if payload.name is not None:
        project.name = payload.name.strip()
    if payload.description is not None:
        project.description = payload.description.strip()
    if payload.archived is not None:
        project.archived_at = "" if not payload.archived else iso_z(utc_now())
    session.add(project)
    session.commit()
    session.refresh(project)

    member_count = len(
        session.exec(select(ProjectMember).where(ProjectMember.project_id == project.id)).all()
    )
    kb_count = len(
        session.exec(select(ProjectKb).where(ProjectKb.project_id == project.id)).all()
    )
    return _view(
        project,
        member_count=member_count,
        kb_count=kb_count,
        my_role=_project_role(session, project.id, user.id),
        org_role=member.role,
    )


@router.delete("/api/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    """删项目（组织管理员）。成员与库关联一起清 —— 只删项目行会留下孤儿关联。"""
    project, member = _project_or_404(session, project_id, user)
    _require_role(member, ROLE_ADMIN)
    for row in session.exec(
        select(ProjectMember).where(ProjectMember.project_id == project.id)
    ).all():
        session.delete(row)
    for row in session.exec(select(ProjectKb).where(ProjectKb.project_id == project.id)).all():
        session.delete(row)
    session.delete(project)
    session.commit()


@router.post(
    "/api/projects/{project_id}/members",
    response_model=ProjectMemberView,
    status_code=status.HTTP_201_CREATED,
)
def add_member(
    project_id: str,
    payload: AddMemberRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ProjectMemberView:
    project, _ = _project_or_404(session, project_id, user)
    _require_manage(session, project, user)
    target = user_by_email(session, payload.email.strip())
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    if session.get(OrgMember, (project.org_id, target.id)) is None:
        # 项目不能成为往组织里拉人的后门（见模块注释）
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="该用户不是本组织成员"
        )
    existing = session.get(ProjectMember, (project.id, target.id))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="该用户已在项目中"
        )
    row = ProjectMember(project_id=project.id, user_id=target.id, org_id=project.org_id)
    session.add(row)
    session.commit()
    session.refresh(row)
    return ProjectMemberView(
        userId=row.user_id, email=target.email, role=row.role, joinedAt=iso_z(row.joined_at)
    )


@router.delete(
    "/api/projects/{project_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_member(
    project_id: str,
    user_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    project, _ = _project_or_404(session, project_id, user)
    _require_manage(session, project, user)
    row = session.get(ProjectMember, (project.id, user_id))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="成员不存在")
    session.delete(row)
    session.commit()


@router.post(
    "/api/projects/{project_id}/kbs",
    response_model=ProjectKbView,
    status_code=status.HTTP_201_CREATED,
)
def add_kb(
    project_id: str,
    payload: AddKbRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ProjectKbView:
    project, member = _project_or_404(session, project_id, user)
    _require_manage(session, project, user)
    kb = session.get(KnowledgeBase, payload.kbId)
    if kb is None or kb.org_id != project.org_id:
        # 跨组织的库按「不存在」处理：确认它存在本身就是信息泄露
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="知识库不存在")
    if not member_can_read_kb(session, kb, member):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="你无权访问该知识库，不能加进项目",
        )
    if session.get(ProjectKb, (project.id, kb.id)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该知识库已在项目中")
    session.add(ProjectKb(project_id=project.id, kb_id=kb.id, org_id=project.org_id))
    session.commit()
    return ProjectKbView(id=kb.id, name=kb.name, documentCount=_doc_count(session, kb.id))


@router.delete(
    "/api/projects/{project_id}/kbs/{kb_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_kb(
    project_id: str,
    kb_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    project, _ = _project_or_404(session, project_id, user)
    _require_manage(session, project, user)
    row = session.get(ProjectKb, (project.id, kb_id))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="关联不存在")
    session.delete(row)
    session.commit()
