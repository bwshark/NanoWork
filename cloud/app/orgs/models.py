"""组织与成员（FR-12.2 的最小骨架：部门树先不做，角色先做四级里的三级）。

为什么先做这一层：M7 知识库的核心验收标准是「按部门/角色设访问范围；**检索前过滤而非
检索后过滤**」——没有「组织 + 成员 + 角色」就没有可过滤的维度。先上知识库再补组织，
等于把过滤条件写成占位符，之后每个接口都要返工一次。

角色阶梯刻意只有三级（owner / admin / member），与 PRD 的四级差在「平台运营」：
那是**跨租户**的运维角色（FR-12.1 多租户 / FR-12.8 多形态部署），没有租户概念之前
引入它只会在每个判断里多一个永远为假的分支。

两张表、无软删除：组织成员是「当下的关系」，删了就是删了；审计侧由 Cloud 的
应用日志承担（FR-12.4 尚未做，见文档）。
"""

from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.timeutil import utc_now


class Organization(SQLModel, table=True):
    __tablename__ = "organizations"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    name: str = Field(index=True)
    created_by: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)


class OrgMember(SQLModel, table=True):
    """(org_id, user_id) 复合主键：同一个用户在一个组织里只能有一条成员记录。

    刻意**不用**自增 id 做主键：成员关系的唯一性就是这一对，加一个代理键之后
    「重复邀请」得靠额外唯一索引兜，而唯一索引在 SQLite 与 PostgreSQL 上的
    报错形状不同，反而多一处要处理的方言差异。
    """

    __tablename__ = "org_members"  # type: ignore[assignment]

    org_id: str = Field(primary_key=True, foreign_key="organizations.id")
    user_id: str = Field(primary_key=True, index=True)
    role: str = Field(index=True)
    joined_at: datetime = Field(default_factory=utc_now)
