"""组织、成员与部门树（FR-12.2；部门于 2026-10-24 补上）。

为什么先做这一层：M7 知识库的核心验收标准是「按部门/角色设访问范围；**检索前过滤而非
检索后过滤**」——没有「组织 + 成员 + 角色」就没有可过滤的维度。先上知识库再补组织，
等于把过滤条件写成占位符，之后每个接口都要返工一次。

角色阶梯刻意只有三级（owner / admin / member），与 PRD 的四级差在「平台运营」：
那是**跨租户**的运维角色（FR-12.1 多租户 / FR-12.8 多形态部署），没有租户概念之前
引入它只会在每个判断里多一个永远为假的分支。

无软删除：组织成员是「当下的关系」，删了就是删了；审计侧由 Cloud 的
应用日志承担（FR-12.4 尚未做，见文档）。

## 部门的两个设计点

1. **`parent_id` 用空串表示「根」，不用 NULL**：SQLite / PostgreSQL 的唯一索引都把
   NULL 视作互不相等，用 NULL 做根的话「同一个组织下不能有两个同名根部门」这条
   约束会静默失效，症状是列表里出现两条一模一样的部门。
2. **成员关系单独一张表**（`department_members`），不给 `OrgMember` 加 `department_id` 列：
   `create_all` **不会 ALTER 已存在的表**——本机 `cloud.db` 里 `org_members` 早就有了，
   加列在启动时静默不生效，随后任何 `SELECT department_id` 都会在真机炸，而测试库
   每次重建，永远看不出来。另一个好处是一个人可以在多个部门（矩阵组织）里。
"""

from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.timeutil import utc_now


#: 组织种类。`team` = 用户建的真实团队（出现在团队列表里）；
#: `personal` = 每个用户一个的**私有空间**，只用来装个人知识库。
#:
#: 为什么个人知识库要伪装成一个组织，而不是给 `knowledge_bases` 加 `owner_user_id`：
#: 知识库的每一条路由都建立在「库属于某个组织 + 我是该组织成员」之上
#: （`_kb_or_404` / `_writable_kb_or_404` / 检索的 `visible_kb_ids`）。
#: 换一套「个人库」的判定分支，就等于把「谁能看到哪本库」写成两份实现——
#: 而那份代码的注释里已经写明，两份实现必然出现「列表看不到、直连能读」的组合漏洞。
#: 复用一个只有自己一人的组织，隔离性由**现有成员表**保证，判定仍然只有一处。
ORG_KIND_TEAM = "team"
ORG_KIND_PERSONAL = "personal"


class Organization(SQLModel, table=True):
    __tablename__ = "organizations"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    name: str = Field(index=True)
    #: 见上：`team` / `personal`。老行按 `team`（迁移的 DEFAULT 就是它）——
    #: 默认成 personal 会让历史团队从列表里凭空消失。
    kind: str = Field(default=ORG_KIND_TEAM, index=True)
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


class Department(SQLModel, table=True):
    """部门（组织内的树）。`parent_id` 为空串 = 根，见模块注释第 1 条。"""

    __tablename__ = "departments"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    org_id: str = Field(index=True, foreign_key="organizations.id")
    #: 父部门 id；空串 = 根
    parent_id: str = Field(default="", index=True)
    name: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)


class DepartmentMember(SQLModel, table=True):
    """(department_id, user_id) 复合主键：同一人在同一部门只能有一条。

    `org_id` 冗余存一份：按组织统计/清理时不必回表 join，而它的值只可能来自
    部门的 `org_id`（写入时校验），因此没有"两处不一致"的风险。
    """

    __tablename__ = "department_members"  # type: ignore[assignment]

    department_id: str = Field(primary_key=True, foreign_key="departments.id")
    user_id: str = Field(primary_key=True, index=True)
    org_id: str = Field(index=True)
    #: 部门内角色：`member`（普通）/ `manager`（负责人）。
    #:
    #: 与**组织角色**是两件事，刻意不合并：组织角色决定"能不能看"，
    #: 部门负责人决定"这条线范围内的资料能不能维护"。合并成一个字段就没法表达
    #: 「某人是普通成员，但他是人事部负责人」——那正是部门存在的意义。
    role: str = Field(default="member")
    joined_at: datetime = Field(default_factory=utc_now)
