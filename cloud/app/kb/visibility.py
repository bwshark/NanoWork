"""知识库可见性：**唯一实现**（角色 ∧ 部门）。

## 为什么收成一个模块

「谁能看到哪本库」原先散在两处：`list_kbs` 里算一遍集合、`_kb_or_404` 里再判一遍角色。
加部门维度后如果继续各写一份，必然出现「列表里看不到、直接按 id 却读得到」这种
组合漏洞——而它正是最难在手工测试里发现的一类（正常的界面路径根本走不到）。

所以：**任何「这个人能不能看这本库」的判断都只走这里**。

## 语义：角色 ∧ 部门（部门是收窄，不是放行）

```
admin / owner        → 一律可见（管理豁免，见下）
member               → role ∈ allowed_roles  AND  ( allowed_departments 为空
                                                    OR 我直属的部门 ∈ 允许集合的子树 )
```

- `allowed_departments` 为空 = **不按部门收窄**（存量库的行为完全不变）。
- 非空时是「还必须属于这些部门」。反过来（部门作为放行）会让「只给人事部看」失效：
  任何 member 都能靠角色那一路进来。
- 部门按**子树**匹配，且是「允许集合往下展开」：共享给「技术部」= 整个技术线可见；
  共享给子部门时，父部门直属的人看不到（见 `orgs/department_access.py`）。
- **管理豁免**：admin / owner 始终可见可改。少了这条会出现「建完就看不见」的死锁——
  一个只给「人事部」看的库，如果管理员不在人事部，他既看不到也改不了范围，
  而这本库只有管理员能改范围。豁免的代价是「管理员能看到所有资料」，这与大多数
  系统的口径一致，也写进了 FR-4.7 的边界；真正要防的是**普通成员越权**。

## 一个刻意 fail-closed 的角落

部门被删空后（路由层已拦住「被引用不允许删」），这里会算出空集 → 谁都看不到。
宁可"暂时看不到"，也不要"因为查不到就放行"。
"""

from __future__ import annotations

from sqlmodel import Session, select

from app.kb.models import KnowledgeBase, KnowledgeBaseDepartment, roles_from_json
from app.orgs.department_access import department_ids_for_user, subtree_of_departments
from app.orgs.models import OrgMember
from app.orgs.roles import ROLE_ADMIN, role_at_least


def kb_department_ids(session: Session, kb_id: str) -> list[str]:
    """这本库的部门范围（空列表 = 不按部门收窄）。"""
    rows = session.exec(
        select(KnowledgeBaseDepartment).where(KnowledgeBaseDepartment.kb_id == kb_id)
    ).all()
    return [row.department_id for row in rows]


def _department_map(session: Session, org_id: str) -> dict[str, set[str]]:
    """一次取出本组织所有库的部门范围，避免在列表接口里逐库查询。"""
    kb_ids = {
        kb.id for kb in session.exec(select(KnowledgeBase).where(KnowledgeBase.org_id == org_id))
    }
    if not kb_ids:
        return {}
    rows = session.exec(
        select(KnowledgeBaseDepartment).where(KnowledgeBaseDepartment.kb_id.in_(kb_ids))
    ).all()
    out: dict[str, set[str]] = {}
    for row in rows:
        out.setdefault(row.kb_id, set()).add(row.department_id)
    return out


def allows(
    *,
    role: str,
    kb_roles: set[str],
    allowed_departments: set[str],
    allowed_subtree: set[str],
    my_departments: set[str],
) -> bool:
    """**唯一的那条规则**（纯函数，单本与列表共用）。

    参数都是已经算好的集合，因此调用方可以自己决定是逐库查还是批量算——
    但规则本身只有这一份。写两遍的后果在变异验证里很明显：只改一处，
    另一半仍然绿，于是「列表看不到、直连能读」这种漏洞会活过测试。
    """
    if role_at_least(role, ROLE_ADMIN):
        return True
    if role not in kb_roles:
        return False
    if not allowed_departments:
        return True
    if not my_departments:
        return False
    return bool(allowed_subtree & my_departments)


def member_can_read_kb(session: Session, kb: KnowledgeBase, member: OrgMember) -> bool:
    """单本库的判定（`_kb_or_404` 用）。"""
    allowed = set(kb_department_ids(session, kb.id))
    allowed_subtree = subtree_of_departments(session, kb.org_id, sorted(allowed))
    return allows(
        role=member.role,
        kb_roles=set(roles_from_json(kb.allowed_roles)),
        allowed_departments=allowed,
        allowed_subtree=allowed_subtree,
        my_departments=department_ids_for_user(session, kb.org_id, member.user_id),
    )


def visible_kb_ids(session: Session, org_id: str, member: OrgMember) -> list[str]:
    """该成员在组织里能看到的库 id（保持库的创建顺序由调用方决定）。

    ⚠️ 调用方必须拿这份集合去做 `WHERE kb_id IN (…)` 的**预过滤**，
    而不是"先取全部再筛"——后者在分页/索引下会让越权内容先占掉 topK 名额。
    """
    rows = session.exec(select(KnowledgeBase).where(KnowledgeBase.org_id == org_id)).all()
    if role_at_least(member.role, ROLE_ADMIN):
        return [kb.id for kb in rows]

    scope = _department_map(session, org_id)
    mine = department_ids_for_user(session, org_id, member.user_id)
    # 同一个允许集合可能被多本库引用：子树只展开一次
    subtrees: dict[str, set[str]] = {}

    visible: list[str] = []
    for kb in rows:
        allowed = scope.get(kb.id, set())
        key = ",".join(sorted(allowed))
        if key and key not in subtrees:
            subtrees[key] = subtree_of_departments(session, org_id, sorted(allowed))
        if allows(
            role=member.role,
            kb_roles=set(roles_from_json(kb.allowed_roles)),
            allowed_departments=allowed,
            allowed_subtree=subtrees.get(key, set()),
            my_departments=mine,
        ):
            visible.append(kb.id)
    return visible
