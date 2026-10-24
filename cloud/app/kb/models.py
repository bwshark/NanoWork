"""知识库表（FR-4.7 的 V1.5 服务端 MVP）。

三张表：库 → 文档 → 分块。分块单独成表而不是塞进文档的 JSON 字段，是为了让
「检索前过滤」能落在 SQL 的 WHERE 上（见 `routes.search_kb`）：过滤条件必须是
**查询的一部分**，否则就成了「先全量取出来再在内存里筛」，也就是 PRD 明确反对的
「检索后过滤」。

`allowed_roles` 存 JSON 文本（`["member","admin"]`）而不是建关联表：
它是**一个库的三个枚举值**，不是可扩展的权限矩阵；建表会让「加一个角色」
变成一次迁移。代价是 SQL 里不能直接按角色过滤——所以过滤写成
`kb_id IN (…)`（先用纯函数算出可见库 id 集合），见 `roles_from_json` / `kb_visible_to_role`。
"""

from __future__ import annotations

import json
from datetime import datetime

from sqlmodel import Field, SQLModel

from app.timeutil import utc_now

#: 默认可见范围：组织内所有成员。建库时不传就按这个来（不用「仅管理员」当默认，
#: 那会让新建的库对大多数人凭空消失）。
DEFAULT_ALLOWED_ROLES: tuple[str, ...] = ("member", "admin", "owner")


def roles_to_json(roles: list[str] | tuple[str, ...]) -> str:
    """规范化角色列表：去重、按固定顺序、只保留合法值。"""
    from app.orgs.roles import VALID_ROLES

    seen = {role for role in roles if role in VALID_ROLES}
    ordered = [role for role in VALID_ROLES if role in seen]
    return json.dumps(ordered)


def roles_from_json(raw: str) -> list[str]:
    """读回角色列表；坏数据一律按「谁都看不到」处理（fail-closed）。"""
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


class KnowledgeBase(SQLModel, table=True):
    __tablename__ = "knowledge_bases"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    org_id: str = Field(index=True, foreign_key="organizations.id")
    name: str = Field(index=True)
    description: str = ""
    #: 可见角色（JSON 数组文本），见模块注释
    allowed_roles: str = Field(default_factory=lambda: roles_to_json(DEFAULT_ALLOWED_ROLES))
    created_by: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)


class KbDocument(SQLModel, table=True):
    __tablename__ = "kb_documents"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    kb_id: str = Field(index=True, foreign_key="knowledge_bases.id")
    title: str
    #: 正文字符数（只用于列表展示）。
    #: 正文**只存一份**——切块后的文本在 `KbChunk.text` 里，文档行不另存全文：
    #: 两处都存就必然出现「改了一处忘了另一处」，而检索只认块。
    chars: int = 0
    chunk_count: int = 0
    created_by: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)


class KbChunk(SQLModel, table=True):
    __tablename__ = "kb_chunks"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    kb_id: str = Field(index=True, foreign_key="knowledge_bases.id")
    doc_id: str = Field(index=True, foreign_key="kb_documents.id")
    ordinal: int = 0
    text: str = ""
