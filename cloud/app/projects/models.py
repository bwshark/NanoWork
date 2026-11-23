"""项目空间（FR-12.7，M7 收口的最后一块容器）。

## 项目刻意不是「第二个组织」

组织是**权限边界**：谁能读到哪本库，只由 `kb/visibility.py::allows()` 一条规则决定
（组织角色 ∧ 部门范围）。项目是**协作容器**：把「同一件事的人 + 资料 + 看板 + 产物」
收在一起，但它**不参与任何可见性判定**。

这条边界决定了一件必须写进代码的事：**往项目里加一本库，不会让看不到它的人看到它**。
项目详情里的库列表必须先过 `visible_kb_ids()` —— 否则 `project_kbs` 就成了绕过
`allows()` 的第二条通路。个人知识库那一轮已经踩过「两份可见性实现 ⇒ 列表看不到、
直连能读」，不能在这里重犯。

同理，项目成员也不构成「邀请旁路」：加人时目标必须是**本组织成员**，
否则项目会变成往组织里拉人的后门。

## 三张表，没有软删除（项目本身除外）

- `projects.archived_at` 用**空串**表示活着，与 `kb_documents.deleted_at` 同口径：
  用 NULL 的话 `== ""` 与 `IS NULL` 是两回事，SQLite 与 PostgreSQL 上都得写两遍判断。
- 成员用 `(project_id, user_id)` 复合主键，不加代理键 —— 唯一性就是这一对。
- `project_kbs` 同样复合主键，并**冗余存 `org_id`**：按组织清理不必回表 join，
  而它的值只可能来自项目的 `org_id`（写入时校验），没有两处不一致的风险。
"""

from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.timeutil import utc_now

#: 项目内角色。只有两级：`lead` 能改项目（加人 / 加库 / 改名 / 归档），`member` 只能看。
#:
#: 刻意与组织三级（owner / admin / member）分开：组织角色管「能否看到资料」，
#: 项目角色管「这条线谁维护」。合并会让「普通成员但当某个项目的负责人」无法表达。
PROJECT_ROLE_LEAD = "lead"
PROJECT_ROLE_MEMBER = "member"

PROJECT_ROLES = (PROJECT_ROLE_LEAD, PROJECT_ROLE_MEMBER)


class Project(SQLModel, table=True):
    __tablename__ = "projects"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    org_id: str = Field(index=True, foreign_key="organizations.id")
    name: str = Field(index=True)
    description: str = Field(default="")
    created_by: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)
    #: ISO 字符串，空串 = 活着（与知识库回收站同口径）。归档是「收起来」不是「删掉」：
    #: 任务与产物的归属还在，恢复后应当原样回来。
    archived_at: str = Field(default="", index=True)

    #: 项目共享记忆（FR-12.7 ③），Markdown 正文。
    #:
    #: **存储只有这一份**：客户端不复制、不进 `syncRegistry`。本地再存一份就是两份
    #: 可能不一致的真相，而共享记忆的全部价值恰恰是「所有人看到的是同一份」。
    memory_doc: str = Field(default="")
    #: 乐观锁版本号。共享记忆是**多写者**场景，静默让后写覆盖先写等于「有人补的
    #: 事实凭空消失」且没有任何报错 —— 所以并发保存必须 409，让写入方自己决定。
    memory_rev: int = Field(default=0)
    #: ISO 字符串，空串 = 从未写过（与 `archived_at` 同口径，避开 NULL 与 "" 两种判断）
    memory_updated_at: str = Field(default="")
    #: 最后写入者。存 user id 而不是邮箱：邮箱可变，id 是稳定键（展示时再解析）。
    memory_updated_by: str = Field(default="")


class ProjectMember(SQLModel, table=True):
    """(project_id, user_id) 复合主键：一人在一个项目里只有一条成员记录。"""

    __tablename__ = "project_members"  # type: ignore[assignment]

    project_id: str = Field(primary_key=True, foreign_key="projects.id")
    user_id: str = Field(primary_key=True, index=True)
    #: 冗余的组织 id：成员校验要它，按组织清理也要它（值来自项目的 org_id）
    org_id: str = Field(index=True)
    role: str = Field(default=PROJECT_ROLE_MEMBER)
    joined_at: datetime = Field(default_factory=utc_now)


class ProjectKb(SQLModel, table=True):
    """项目关联的知识库。**只是入口，不是授权**（见模块注释）。"""

    __tablename__ = "project_kbs"  # type: ignore[assignment]

    project_id: str = Field(primary_key=True, foreign_key="projects.id")
    kb_id: str = Field(primary_key=True, index=True, foreign_key="knowledge_bases.id")
    org_id: str = Field(index=True)
    added_at: datetime = Field(default_factory=utc_now)
