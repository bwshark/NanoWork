"""/api/orgs/{id}/departments 与 /api/departments/*：部门树（FR-12.2 / FR-4.7）。

## 为什么部门是「知识库可见范围」的一半

FR-4.7 的验收标准是「**按部门/角色**设访问范围」。只有角色时，能表达的只有
「成员 / 管理员 / 所有者」——而真实组织的需求是「这份薪酬制度只给人事部看」，
人事部的成员很多都是普通 member。部门维度补的就是这一格。

## 四条规则（每条都有用例）

1. **改结构要 admin**：建 / 改名 / 删 / 加人减人。普通成员能改结构，等于任何人都能
   把自己塞进「管理层」部门。
2. **同名同级拒绝（409）**：同级两个「技术部」会让部门选择器出现两个看起来一样的选项，
   而用户无从分辨该选哪个。
3. **删之前要清空**：还有子部门 / 还有成员 / 还被知识库引用时一律 409，并把原因说清。
   静默级联删除的后果是「知识库突然对所有人不可见」（部门没了 = 子树为空 = fail-closed）。
4. **加人要求已经是组织成员**：部门不是邀请入口。绕过组织成员直接进部门，会让
   「先加组织再加部门」这条审计链断掉，也不符合成员关系的唯一入口。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth.deps import current_user, user_by_email
from app.auth.models import User
from app.auth.security import new_user_id
from app.db import get_session
from app.kb.models import KnowledgeBase, KnowledgeBaseDepartment
from app.orgs.departments import (
    MAX_DEPTH,
    child_depth,
    ordered_for_display,
    subtree_height,
    subtree_ids,
)
from app.orgs.guards import membership_or_404, require_role
from app.orgs.models import Department, DepartmentMember, OrgMember
from app.orgs.roles import ROLE_ADMIN
from app.timeutil import iso_z

router = APIRouter(prefix="/api", tags=["departments"])


class CreateDepartmentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    #: 父部门 id；不传或空串 = 根
    parentId: str | None = None


class UpdateDepartmentRequest(BaseModel):
    """改名 / 移动。**两者都可省略** = 什么都不改。

    `parentId` 的三种取值刻意都保留：
    - 不传（`None`）= 不动结构；
    - `""` = 移到根；
    - 具体 id = 挂到那个部门下。
    少了 `""` 这一档就表达不了「把子部门提成根部门」，那是个常用操作。
    """

    name: str | None = Field(default=None, max_length=64)
    parentId: str | None = None


class DepartmentMemberRoleRequest(BaseModel):
    """部门内角色。只有两档：普通成员 / 负责人。"""

    role: str = Field(min_length=1, max_length=16)


class DepartmentView(BaseModel):
    id: str
    orgId: str
    #: 空串 = 根（与存储一致，见 `models.py` 的说明）
    parentId: str
    name: str
    memberCount: int
    createdAt: str


class DepartmentMemberView(BaseModel):
    userId: str
    email: str
    #: 该用户在**组织**里的角色（owner / admin / member）
    role: str
    #: **部门内**角色：member / manager。
    #: 与上面那个字段并存，因为它们是两个维度：「某人是普通成员，但他是人事部负责人」
    #: 这种组合必须能表达 —— 那正是部门存在的意义。
    departmentRole: str = "member"
    joinedAt: str


class AddDepartmentMemberRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


def _departments_of(session: Session, org_id: str) -> list[Department]:
    return session.exec(select(Department).where(Department.org_id == org_id)).all()


def _department_or_404(
    session: Session, department_id: str, user: User
) -> tuple[Department, OrgMember]:
    """取部门与调用者的成员记录；部门不存在 / 不是该组织成员都是 404。"""
    department = session.get(Department, department_id)
    if department is None:
        raise HTTPException(status_code=404, detail="部门不存在")
    member = membership_or_404(session, department.org_id, user)
    return department, member


def _member_count(session: Session, department_id: str) -> int:
    rows = session.exec(
        select(DepartmentMember).where(DepartmentMember.department_id == department_id)
    ).all()
    return len(rows)


def _view(session: Session, department: Department) -> DepartmentView:
    return DepartmentView(
        id=department.id,
        orgId=department.org_id,
        parentId=department.parent_id,
        name=department.name,
        memberCount=_member_count(session, department.id),
        createdAt=iso_z(department.created_at),
    )


def _assert_unique_name(
    departments: list[Department], *, parent_id: str, name: str, exclude_id: str = ""
) -> None:
    for existing in departments:
        if existing.id == exclude_id:
            continue
        if existing.parent_id == parent_id and existing.name == name:
            raise HTTPException(status_code=409, detail=f"同一层级下已有同名部门「{name}」")


@router.get("/orgs/{org_id}/departments", response_model=list[DepartmentView])
def list_departments(
    org_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[DepartmentView]:
    """**父在子前**的扁平顺序（客户端按缩进渲染，不必自己搭树）。"""
    membership_or_404(session, org_id, user)
    return [_view(session, item) for item in ordered_for_display(_departments_of(session, org_id))]


@router.post(
    "/orgs/{org_id}/departments",
    response_model=DepartmentView,
    status_code=status.HTTP_201_CREATED,
)
def create_department(
    org_id: str,
    payload: CreateDepartmentRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DepartmentView:
    member = membership_or_404(session, org_id, user)
    require_role(member, ROLE_ADMIN)

    name = payload.name.strip()
    if name == "":
        raise HTTPException(status_code=422, detail="部门名不能为空")
    parent_id = (payload.parentId or "").strip()
    departments = _departments_of(session, org_id)

    if parent_id:
        parent = next((item for item in departments if item.id == parent_id), None)
        # 父部门必须属于同一个组织：否则可以把别的组织的部门当父，造出跨组织引用
        if parent is None:
            raise HTTPException(status_code=422, detail="父部门不存在")

    depth = child_depth(departments, parent_id)
    if depth == 0:
        raise HTTPException(status_code=422, detail="父部门不存在")
    if depth > MAX_DEPTH:
        raise HTTPException(status_code=422, detail=f"部门层级不能超过 {MAX_DEPTH} 层")

    _assert_unique_name(departments, parent_id=parent_id, name=name)

    department = Department(id=new_user_id(), org_id=org_id, parent_id=parent_id, name=name)
    session.add(department)
    session.commit()
    session.refresh(department)
    return _view(session, department)


@router.patch("/departments/{department_id}", response_model=DepartmentView)
def update_department(
    department_id: str,
    payload: UpdateDepartmentRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DepartmentView:
    """改名 / **换父节点**（同一棵树内移动）。

    ## 移动的四条校验，缺一条都能把树写坏

    1. **不能挂到自己身上** —— 自环。
    2. **不能挂到自己的子孙里** —— 那会切出一个环，之后 `ordered_for_display`
       会把它当成孤儿丢掉，而 `subtree_ids` 会一路查下去。这类脏数据一旦写进库，
       只能靠人工改数据库救。
    3. **层级上限按子树高度算**：移动的是整棵子树，只算「新父深度」会把
       「3 层高的子树挂到第 7 层下」放过去（最深变 10 层）。
    4. **新父下不能同名** —— 与建部门同一条规则，否则同级会出现两个「技术部」。
    """
    department, member = _department_or_404(session, department_id, user)
    require_role(member, ROLE_ADMIN)

    departments = _departments_of(session, department.org_id)
    new_parent = department.parent_id
    if payload.parentId is not None:
        new_parent = payload.parentId.strip()
        if new_parent and all(item.id != new_parent for item in departments):
            # 父部门必须属于同一组织：否则能把别的组织的部门当父，造出跨组织引用
            raise HTTPException(status_code=422, detail="父部门不存在")
        if new_parent == department.id:
            raise HTTPException(status_code=422, detail="不能把部门挂到它自己下面")
        if new_parent and new_parent in subtree_ids(departments, [department.id]):
            raise HTTPException(
                status_code=422, detail="不能把部门移到它自己的子部门下面（会形成环）"
            )
        depth = child_depth(departments, new_parent)
        if depth == 0:
            raise HTTPException(status_code=422, detail="父部门不存在")
        height = subtree_height(departments, department.id)
        if depth + height - 1 > MAX_DEPTH:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"移过去最深会有 {depth + height - 1} 层，超过 {MAX_DEPTH} 层上限"
                    f"（该部门下还有 {height - 1} 层子部门）"
                ),
            )

    name = department.name
    if payload.name is not None:
        name = payload.name.strip()
        if name == "":
            raise HTTPException(status_code=422, detail="部门名不能为空")

    _assert_unique_name(departments, parent_id=new_parent, name=name, exclude_id=department.id)

    department.name = name
    department.parent_id = new_parent
    session.add(department)
    session.commit()
    session.refresh(department)
    return _view(session, department)


@router.delete("/departments/{department_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_department(
    department_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    """删部门要先清空：子部门、成员、被知识库引用，三种情况分别说清。"""
    department, member = _department_or_404(session, department_id, user)
    require_role(member, ROLE_ADMIN)

    departments = _departments_of(session, department.org_id)
    children = [item for item in departments if item.parent_id == department.id]
    if children:
        raise HTTPException(
            status_code=409,
            detail=f"该部门下还有 {len(children)} 个子部门，请先删除或移走",
        )

    members = _member_count(session, department.id)
    if members:
        raise HTTPException(status_code=409, detail=f"该部门还有 {members} 名成员，请先移除")

    # 被知识库引用：删掉会让那本库的可见范围变成空集（fail-closed 到"谁都看不到"），
    # 而这种"突然谁都看不到"极难排查——所以直接拦住，并点名是哪几本库
    linked = session.exec(
        select(KnowledgeBaseDepartment).where(
            KnowledgeBaseDepartment.department_id == department.id
        )
    ).all()
    if linked:
        titles: list[str] = []
        for row in linked[:3]:
            kb = session.get(KnowledgeBase, row.kb_id)
            titles.append(kb.name if kb else row.kb_id)
        more = "" if len(linked) <= 3 else f" 等 {len(linked)} 本"
        raise HTTPException(
            status_code=409,
            detail=f"该部门仍是知识库「{'、'.join(titles)}」{more}的可见范围，请先改范围",
        )

    session.delete(department)
    session.commit()


@router.get("/departments/{department_id}/members", response_model=list[DepartmentMemberView])
def list_department_members(
    department_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[DepartmentMemberView]:
    department, _member = _department_or_404(session, department_id, user)
    rows = session.exec(
        select(DepartmentMember).where(DepartmentMember.department_id == department.id)
    ).all()

    out: list[DepartmentMemberView] = []
    for row in rows:
        person = session.get(User, row.user_id)
        org_member = session.get(OrgMember, (department.org_id, row.user_id))
        out.append(
            DepartmentMemberView(
                userId=row.user_id,
                email=person.email if person else "",
                role=org_member.role if org_member else "",
                departmentRole=row.role,
                joinedAt=iso_z(row.joined_at),
            )
        )
    out.sort(key=lambda item: item.email)
    return out


@router.post(
    "/departments/{department_id}/members",
    response_model=DepartmentMemberView,
    status_code=201,
)
def add_department_member(
    department_id: str,
    payload: AddDepartmentMemberRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DepartmentMemberView:
    department, member = _department_or_404(session, department_id, user)
    require_role(member, ROLE_ADMIN)

    target = user_by_email(session, payload.email.strip())
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    org_member = session.get(OrgMember, (department.org_id, target.id))
    if org_member is None:
        # 部门不是邀请入口：先把人加进组织，再分配到部门
        raise HTTPException(status_code=422, detail="该用户还不是组织成员，请先加入组织")

    existing = session.get(DepartmentMember, (department.id, target.id))
    if existing is not None:
        # 幂等：重复添加不报错，也不产生第二行（复合主键本来也不会）
        return DepartmentMemberView(
            userId=target.id,
            email=target.email,
            role=org_member.role,
            joinedAt=iso_z(existing.joined_at),
        )

    row = DepartmentMember(department_id=department.id, user_id=target.id, org_id=department.org_id)
    session.add(row)
    session.commit()
    session.refresh(row)
    return DepartmentMemberView(
        userId=target.id,
        email=target.email,
        role=org_member.role,
        joinedAt=iso_z(row.joined_at),
    )


@router.delete(
    "/departments/{department_id}/members/{member_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_department_member(
    department_id: str,
    member_user_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    department, member = _department_or_404(session, department_id, user)
    require_role(member, ROLE_ADMIN)

    row = session.get(DepartmentMember, (department.id, member_user_id))
    if row is None:
        # 幂等删除：目标本来就不在这个部门里
        return
    session.delete(row)
    session.commit()


#: 部门内只有两档。刻意不引进第三档（"只读"）：部门维度管的是"这条线的资料谁维护"，
#: 读权限已经由组织角色 + 部门归属决定了，再加只读档只会让两套规则打架。
DEPARTMENT_ROLES = ("member", "manager")


@router.patch(
    "/departments/{department_id}/members/{member_user_id}", response_model=DepartmentMemberView
)
def set_department_member_role(
    department_id: str,
    member_user_id: str,
    payload: DepartmentMemberRoleRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DepartmentMemberView:
    """设置部门内角色（`manager` = 该部门负责人）。

    负责人的实际作用是**写权限**：一个「仅限人事部」的知识库，人事部负责人可以往里
    加/删资料，而不必先被提成组织管理员。这条规则写在 `kb/routes._writable_kb_or_404`，
    不在这里 —— 本接口只管"谁是谁的负责人"，权限判断只有一处。
    """
    department, member = _department_or_404(session, department_id, user)
    require_role(member, ROLE_ADMIN)

    role = payload.role.strip().lower()
    if role not in DEPARTMENT_ROLES:
        raise HTTPException(
            status_code=422, detail=f"部门内角色只能是 {' / '.join(DEPARTMENT_ROLES)}"
        )

    row = session.get(DepartmentMember, (department.id, member_user_id))
    if row is None:
        raise HTTPException(status_code=404, detail="该成员不在这个部门里")
    row.role = role
    session.add(row)
    session.commit()
    session.refresh(row)

    person = session.get(User, row.user_id)
    org_member = session.get(OrgMember, (department.org_id, row.user_id))
    return DepartmentMemberView(
        userId=row.user_id,
        email=person.email if person else "",
        role=org_member.role if org_member else "",
        departmentRole=row.role,
        joinedAt=iso_z(row.joined_at),
    )
