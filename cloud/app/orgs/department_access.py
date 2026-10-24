"""「某个人属于哪些部门」的数据库侧查询（供知识库可见性使用）。

放在独立模块而不是 `department_routes.py`：路由模块是 HTTP 层（请求/响应模型、
依赖注入），被别的业务模块 import 会把 FastAPI 的依赖顺带拖进来，也让
「路由文件当工具库用」这种坏习惯扩散——改一个响应字段就担心影响鉴权。

## 方向只有一个

可见性从父往下继承（共享给「技术部」= 整个技术线都能看），**绝不往上**。
所以本模块提供的是「把**允许范围**往下展开」，而不是「把我的部门往下展开」——
后者会漏掉「人在子部门、库共享给父部门」这一整类场景。
"""

from __future__ import annotations

from sqlmodel import Session, select

from app.orgs.departments import subtree_ids
from app.orgs.models import Department, DepartmentMember


def department_ids_for_user(session: Session, org_id: str, user_id: str) -> set[str]:
    """某人**直属**部门的 id 集合。"""
    rows = session.exec(
        select(DepartmentMember).where(
            DepartmentMember.org_id == org_id, DepartmentMember.user_id == user_id
        )
    ).all()
    return {row.department_id for row in rows}


def subtree_of_departments(session: Session, org_id: str, roots: list[str]) -> set[str]:
    """这些部门**及其后代**的 id 集合。

    ⚠️ 方向只有一个：从「允许的部门」往下展开，再和「我直属的部门」求交。
    反过来（把我的部门往下展开去套允许集合）会得到一个**看起来对、其实反了**的结果：
        共享给「技术部」、我挂在「前端」→ 正确应可见，反着算却看不到。
    这条正是 `test_department_scope_inherits_downwards_only` 钉住的东西。
    """
    if not roots:
        return set()
    departments = session.exec(select(Department).where(Department.org_id == org_id)).all()
    return subtree_ids(departments, roots)
