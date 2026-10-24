"""/api/orgs/{org_id}/kbs/* 与 /api/kbs/*：知识库（FR-4.7 MVP）。

## 这个文件唯一需要看懂的地方：过滤发生在取候选之前

`search_org_kbs` 的顺序是
1. 用**成员角色**算出可见库 id 集合（纯函数 `visible_kb_ids`）；
2. `WHERE kb_id IN (…)` 取候选块；
3. 才对候选块打分。

反过来写（先取全部块再筛）在单机上「结果看起来一样」，但它是**错的**：
向量库/全文索引一旦分页，被过滤掉的内容就已经占掉了 topK 名额，
用户看到的是「明明有资料却搜不到」。这条不变量用测试钉住
（`test_kb.py::test_member_cannot_see_admin_only_kb_even_when_matching`）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth.deps import current_user
from app.auth.models import User
from app.auth.security import new_user_id
from app.db import get_session
from app.kb.chunking import chunk_text
from app.kb.models import (
    DEFAULT_ALLOWED_ROLES,
    KbChunk,
    KbDocument,
    KnowledgeBase,
    roles_from_json,
    roles_to_json,
)
from app.kb.retrieval import rank_chunks
from app.orgs.models import OrgMember
from app.orgs.roles import ROLE_ADMIN, role_at_least
from app.timeutil import iso_z

router = APIRouter(prefix="/api", tags=["knowledge-base"])

#: 单文档上限（字符）。没有上限的话，一次上传就能把 SQLite 撑到几百 MB，
#: 而解析是同步的——请求会先超时再留下半截数据。
MAX_DOCUMENT_CHARS = 200_000


class CreateKbRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    allowedRoles: list[str] | None = None


class KbView(BaseModel):
    id: str
    orgId: str
    name: str
    description: str
    allowedRoles: list[str]
    documentCount: int
    createdAt: str


class CreateDocumentRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=MAX_DOCUMENT_CHARS)


class DocumentView(BaseModel):
    id: str
    kbId: str
    title: str
    chars: int
    chunkCount: int
    createdAt: str


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    kbId: str | None = None
    #: 一次检索多个库（专家 / 会话的知识库绑定走这条）。
    #:
    #: 为什么不复用 `kbId` 多次请求：绑定是「这几本库」，客户端连发 N 次再自行合并，
    #: 等于让 **topK 变成「每库各 N 条」**，而且合并顺序由客户端的响应时序决定。
    #: 更关键的是范围收窄必须留在 SQL 里 —— 客户端筛 = 越权块先占名额，见文件头。
    kbIds: list[str] | None = None
    topK: int = Field(default=8, ge=1, le=50)


class SearchHit(BaseModel):
    chunkId: str
    docId: str
    docTitle: str
    kbId: str
    score: float
    snippet: str


def _require_org_member(session: Session, org_id: str, user: User) -> OrgMember:
    member = session.get(OrgMember, (org_id, user.id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="组织不存在")
    return member


def visible_kb_ids(session: Session, org_id: str, role: str) -> list[str]:
    """**预过滤的唯一实现**：按角色算出该组织里我能看到的库 id。

    只认 `allowed_roles`，不看 `created_by`：创建者若被降级，也不该继续看管理员库
    （否则「降级」就只是个显示变化）。
    """
    rows = session.exec(select(KnowledgeBase).where(KnowledgeBase.org_id == org_id)).all()
    return [kb.id for kb in rows if role in roles_from_json(kb.allowed_roles)]


def _kb_or_404(session: Session, kb_id: str, user: User) -> tuple[KnowledgeBase, OrgMember]:
    kb = session.get(KnowledgeBase, kb_id)
    if kb is None:
        raise HTTPException(status_code=404, detail="知识库不存在")
    member = session.get(OrgMember, (kb.org_id, user.id))
    if member is None:
        # 不是组织成员 → 404（不泄露库/组织是否存在）
        raise HTTPException(status_code=404, detail="知识库不存在")
    if member.role not in roles_from_json(kb.allowed_roles):
        raise HTTPException(status_code=403, detail="当前角色无权访问该知识库")
    return kb, member


def _kb_view(session: Session, kb: KnowledgeBase) -> KbView:
    docs = session.exec(select(KbDocument).where(KbDocument.kb_id == kb.id)).all()
    return KbView(
        id=kb.id,
        orgId=kb.org_id,
        name=kb.name,
        description=kb.description,
        allowedRoles=roles_from_json(kb.allowed_roles),
        documentCount=len(docs),
        createdAt=iso_z(kb.created_at),
    )


@router.post(
    "/orgs/{org_id}/kbs", response_model=KbView, status_code=status.HTTP_201_CREATED
)
def create_kb(
    org_id: str,
    payload: CreateKbRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> KbView:
    """建库：普通成员也能建（知识库不是管理员专属资源），但**改可见范围要 admin**。"""
    _require_org_member(session, org_id, user)
    roles = payload.allowedRoles or list(DEFAULT_ALLOWED_ROLES)
    kb = KnowledgeBase(
        id=new_user_id(),
        org_id=org_id,
        name=payload.name.strip(),
        description=payload.description.strip(),
        allowed_roles=roles_to_json(roles),
        created_by=user.id,
    )
    session.add(kb)
    session.commit()
    session.refresh(kb)
    return _kb_view(session, kb)


@router.get("/orgs/{org_id}/kbs", response_model=list[KbView])
def list_kbs(
    org_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[KbView]:
    """只返回**我能看到的**库（与检索用的是同一个纯函数，不另写一套判断）。"""
    member = _require_org_member(session, org_id, user)
    ids = set(visible_kb_ids(session, org_id, member.role))
    rows = session.exec(select(KnowledgeBase).where(KnowledgeBase.org_id == org_id)).all()
    return [_kb_view(session, kb) for kb in rows if kb.id in ids]


@router.post("/kbs/{kb_id}/documents", response_model=DocumentView, status_code=201)
def create_document(
    kb_id: str,
    payload: CreateDocumentRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentView:
    """入库：切块后**只有块进库**（文档行只存元数据），见 `models.py` 的说明。"""
    kb, _member = _kb_or_404(session, kb_id, user)
    chunks = chunk_text(payload.content)
    if not chunks:
        raise HTTPException(status_code=422, detail="文档内容为空")

    doc = KbDocument(
        id=new_user_id(),
        kb_id=kb.id,
        title=payload.title.strip(),
        chars=len(payload.content),
        chunk_count=len(chunks),
        created_by=user.id,
    )
    session.add(doc)
    for ordinal, text in enumerate(chunks):
        session.add(
            KbChunk(id=new_user_id(), kb_id=kb.id, doc_id=doc.id, ordinal=ordinal, text=text)
        )
    session.commit()
    session.refresh(doc)
    return DocumentView(
        id=doc.id,
        kbId=doc.kb_id,
        title=doc.title,
        chars=doc.chars,
        chunkCount=doc.chunk_count,
        createdAt=iso_z(doc.created_at),
    )


@router.get("/kbs/{kb_id}/documents", response_model=list[DocumentView])
def list_documents(
    kb_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[DocumentView]:
    kb, _member = _kb_or_404(session, kb_id, user)
    rows = session.exec(select(KbDocument).where(KbDocument.kb_id == kb.id)).all()
    return [
        DocumentView(
            id=doc.id,
            kbId=doc.kb_id,
            title=doc.title,
            chars=doc.chars,
            chunkCount=doc.chunk_count,
            createdAt=iso_z(doc.created_at),
        )
        for doc in sorted(rows, key=lambda item: (item.created_at, item.id))
    ]


@router.post("/orgs/{org_id}/search", response_model=list[SearchHit])
def search_org_kbs(
    org_id: str,
    payload: SearchRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[SearchHit]:
    """跨库检索：**先按角色取可见库集合，再取候选块，最后才打分**。

    传了 `kbId` / `kbIds` 时仍走同一条预过滤（不可见的库直接 403），
    免得「指定范围检索」成为绕过可见性的侧门。
    """
    member = _require_org_member(session, org_id, user)
    allowed = visible_kb_ids(session, org_id, member.role)

    # ⚠️ 越权判定必须排在「没有可见库就返回空」**之前**：否则一个只有管理员库的
    # 组织里，member 指定 kbId 搜那个库会拿到 200 + 空结果——看起来像「库里没资料」，
    # 而真实原因是「你无权访问」。这类「拿错原因当答案」比直接报错更难排查。
    if payload.kbIds is not None:
        # 空数组不该被当成「不限定范围」：它更可能是「绑定的库全没了」或调用方漏填。
        # 静默放宽成全组织可见库，会让一次本该「没有资料」的检索返回一堆无关内容。
        if not payload.kbIds:
            raise HTTPException(status_code=422, detail="kbIds 不能为空")
        denied = [kb_id for kb_id in payload.kbIds if kb_id not in allowed]
        if denied:
            raise HTTPException(status_code=403, detail="当前角色无权访问该知识库")
        # 去重但保序：重复 id 会让同一个块在 `IN (…)` 里出现两次（打分时算两份）
        scope_ids = allowed
    elif payload.kbId:
        if payload.kbId not in allowed:
            raise HTTPException(status_code=403, detail="当前角色无权访问该知识库")
        scope_ids = [payload.kbId]
    else:
        scope_ids = allowed
    if not scope_ids:
        return []

    # 这一步就是「检索前过滤」：过滤条件在 SQL 里，候选集天生不含越权内容
    candidates = session.exec(select(KbChunk).where(KbChunk.kb_id.in_(scope_ids))).all()
    if not candidates:
        return []

    ranked = rank_chunks([chunk.text for chunk in candidates], payload.query, top_k=payload.topK)
    doc_cache: dict[str, KbDocument | None] = {}
    hits: list[SearchHit] = []
    for scored in ranked:
        chunk = candidates[scored.index]
        if chunk.doc_id not in doc_cache:
            doc_cache[chunk.doc_id] = session.get(KbDocument, chunk.doc_id)
        doc = doc_cache[chunk.doc_id]
        hits.append(
            SearchHit(
                chunkId=chunk.id,
                docId=chunk.doc_id,
                docTitle=doc.title if doc else "",
                kbId=chunk.kb_id,
                score=round(scored.score, 6),
                snippet=chunk.text[:200],
            )
        )
    return hits


@router.patch("/kbs/{kb_id}/visibility", response_model=KbView)
def update_kb_visibility(
    kb_id: str,
    payload: CreateKbRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> KbView:
    """改可见范围：**必须 admin**。

    这是本模块唯一「收紧之后别人就看不见」的操作，也是权限设计里最该有门槛的一步：
    普通成员能改，就等于任何人都能把管理员库对全员开放（或反过来把同事锁在门外）。
    """
    kb, member = _kb_or_404(session, kb_id, user)
    if not role_at_least(member.role, ROLE_ADMIN):
        raise HTTPException(status_code=403, detail="权限不足")
    if payload.allowedRoles is not None:
        if not payload.allowedRoles:
            raise HTTPException(status_code=422, detail="可见范围不能为空")
        kb.allowed_roles = roles_to_json(payload.allowedRoles)
    session.add(kb)
    session.commit()
    session.refresh(kb)
    return _kb_view(session, kb)
