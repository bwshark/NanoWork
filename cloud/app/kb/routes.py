"""/api/orgs/{org_id}/kbs/* 与 /api/kbs/*：知识库（FR-4.7 MVP）。

## 这个文件唯一需要看懂的地方：过滤发生在取候选之前

`search_org_kbs` 的顺序是
1. 用**成员角色 + 部门**算出可见库 id 集合（`visibility.visible_kb_ids`，唯一实现）；
2. `WHERE kb_id IN (…)` 取候选块；
3. 才对候选块打分。

反过来写（先取全部块再筛）在单机上「结果看起来一样」，但它是**错的**：
向量库/全文索引一旦分页，被过滤掉的内容就已经占掉了 topK 名额，
用户看到的是「明明有资料却搜不到」。这条不变量用测试钉住
（`test_kb.py::test_member_cannot_see_admin_only_kb_even_when_matching`）。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth.deps import current_user
from app.auth.models import User
from app.auth.security import new_user_id
from app.db import get_session
from app.kb.chunking import chunk_text
from app.kb.digest import digest_of
from app.kb.embedding import resolve_embedder
from app.kb.models import (
    DEFAULT_ALLOWED_ROLES,
    KbChunk,
    KbDocument,
    KnowledgeBase,
    KnowledgeBaseDepartment,
    roles_from_json,
    roles_to_json,
)
from app.kb.parsing import ParseError, decode_base64, default_title, parse_document
from app.kb.retrieval import ScoredChunk, hybrid_rank, rank_by_vectors, rank_chunks
from app.kb.vectors import (
    count_vectors_by_doc,
    delete_vectors_for_doc,
    load_vectors,
    save_vectors,
    vector_coverage,
)
from app.kb.visibility import kb_department_ids, member_can_read_kb, visible_kb_ids
from app.orgs.models import Department, OrgMember
from app.orgs.roles import ROLE_ADMIN, role_at_least
from app.timeutil import iso_z

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["knowledge-base"])

#: 重建索引时每批处理多少块。分批是为了**部分成功也算数**：一次 300 块的 KB 打云端
#: 会中途限流，整批回滚等于什么都没做；分批写则前几批留着，重跑只补剩下的。
REINDEX_BATCH = 64

#: 单文档上限（字符）。没有上限的话，一次上传就能把 SQLite 撑到几百 MB，
#: 而解析是同步的——请求会先超时再留下半截数据。
MAX_DOCUMENT_CHARS = 200_000


class CreateKbRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    allowedRoles: list[str] | None = None
    #: 部门范围（**收窄**）：非空时只有属于这些部门（含子部门）的成员能看
    allowedDepartments: list[str] | None = None


class KbView(BaseModel):
    id: str
    orgId: str
    name: str
    description: str
    allowedRoles: list[str]
    #: 部门范围；空 = 不按部门收窄（角色能看就能看）
    allowedDepartments: list[str]
    documentCount: int
    createdAt: str


class CreateDocumentRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=MAX_DOCUMENT_CHARS)


class UploadFileRequest(BaseModel):
    """上传文件（base64）。`title` 缺省用文件名去扩展名。"""

    filename: str = Field(min_length=1, max_length=255)
    contentBase64: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=200)


class RenameDocumentRequest(BaseModel):
    """改标题。上限 200 与服务端截断一致，超了不报错而是截断（标题不是数据）。"""

    title: str = Field(min_length=1, max_length=255)


class DocumentView(BaseModel):
    id: str
    kbId: str
    title: str
    chars: int
    chunkCount: int
    createdAt: str
    #: 本次实际写入的向量条数（0 = 没建索引：embedder 关着，或云端向量化失败）。
    #: 单列一个字段是为了让「入库成功但没索引」这件事**看得见**——否则用户只会觉得
    #: 「新传的文档搜不到」，而界面一切正常。
    embedded: int = 0
    #: 来源格式：text（粘贴/纯文本）/ docx / pdf
    kind: str = "text"
    #: 解析过程中的降级说明（"PDF 有 2 页没有文本层"之类）。**必须回给用户**：
    #: 静默丢内容会变成"我明明传了那份资料，它就是搜不到"。
    warnings: list[str] = []


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


def _kb_or_404(session: Session, kb_id: str, user: User) -> tuple[KnowledgeBase, OrgMember]:
    kb = session.get(KnowledgeBase, kb_id)
    if kb is None:
        raise HTTPException(status_code=404, detail="知识库不存在")
    member = session.get(OrgMember, (kb.org_id, user.id))
    if member is None:
        # 不是组织成员 → 404（不泄露库/组织是否存在）
        raise HTTPException(status_code=404, detail="知识库不存在")
    # 角色 ∧ 部门都走 `visibility.member_can_read_kb`：两处判断分开写就会出现
    # 「列表里看不到、直接按 id 却读得到」的组合漏洞
    if not member_can_read_kb(session, kb, member):
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
        allowedDepartments=kb_department_ids(session, kb.id),
        documentCount=len(docs),
        createdAt=iso_z(kb.created_at),
    )


def _embed_chunks(session: Session, embedder: object, chunks: list[KbChunk]) -> tuple[int, str]:
    """给一批块建索引；**永不抛**，返回 `(写入条数, 错误串)`。

    为什么不让向量化失败冒泡成 5xx：入库与检索是两件事。文档存不进去，用户只能把
    正文贴进聊天框（那等于这个功能没有）；而索引失败只意味着「这一篇暂时只能被词法
    搜到」，点一次「重建索引」就好。
    """
    if not chunks:
        return 0, ""
    texts = [chunk.text for chunk in chunks]
    try:
        vectors = embedder.embed(texts)  # type: ignore[attr-defined]
    except Exception as error:  # noqa: BLE001 —— 见 docstring
        logger.warning("知识库向量化失败（%s）：%s", getattr(embedder, "name", "?"), error)
        return 0, str(error)
    if len(vectors) != len(chunks):
        logger.warning("知识库向量化条数不符：期望 %d，实际 %d", len(chunks), len(vectors))
        return 0, "向量条数不符"

    written = save_vectors(
        session,
        model=embedder.name,  # type: ignore[attr-defined]
        rows=[
            (chunk.id, chunk.kb_id, chunk.doc_id, vector)
            for chunk, vector in zip(chunks, vectors, strict=True)
        ],
    )
    session.commit()
    return written, ""


def _set_departments(session: Session, kb: KnowledgeBase, department_ids: list[str] | None) -> None:
    """**覆盖式**写入部门范围（`None` = 不动；`[]` = 清空 → 不按部门收窄）。

    校验两件事，都是"不查就会留下看不懂的死数据"的那种：
    1. 部门必须属于**本组织**（跨组织 id 在这里没有意义，只会让范围看起来设置了却没人命中）；
    2. 重复 id 去重 —— 交给主键冲突报错的话，用户看到的是数据库层的话。
    """
    if department_ids is None:
        return
    unique = list(dict.fromkeys(item for item in department_ids if item))
    if unique:
        rows = session.exec(
            select(Department).where(Department.org_id == kb.org_id, Department.id.in_(unique))
        ).all()
        found = {row.id for row in rows}
        missing = [item for item in unique if item not in found]
        if missing:
            raise HTTPException(
                status_code=422, detail=f"部门不存在或不属于本组织：{'、'.join(missing[:3])}"
            )

    existing = session.exec(
        select(KnowledgeBaseDepartment).where(KnowledgeBaseDepartment.kb_id == kb.id)
    ).all()
    for row in existing:
        session.delete(row)
    for department_id in unique:
        session.add(KnowledgeBaseDepartment(kb_id=kb.id, department_id=department_id))


@router.post("/orgs/{org_id}/kbs", response_model=KbView, status_code=status.HTTP_201_CREATED)
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
    _set_departments(session, kb, payload.allowedDepartments)
    session.commit()
    return _kb_view(session, kb)


@router.get("/orgs/{org_id}/kbs", response_model=list[KbView])
def list_kbs(
    org_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[KbView]:
    """只返回**我能看到的**库（与检索用的是同一个纯函数，不另写一套判断）。"""
    member = _require_org_member(session, org_id, user)
    ids = set(visible_kb_ids(session, org_id, member))
    rows = session.exec(select(KnowledgeBase).where(KnowledgeBase.org_id == org_id)).all()
    return [_kb_view(session, kb) for kb in rows if kb.id in ids]


def _writable_kb_or_404(
    session: Session, kb_id: str, user: User
) -> tuple[KnowledgeBase, OrgMember]:
    """**写操作**（入库 / 上传 / 改名 / 删除）的守卫：在可读之上再要求 admin。

    ## 为什么读和写必须是两个判定

    `allowed_roles` 控制的是**读**。如果写沿用它，那么「对一个全员可见的制度库」，
    任何一个成员都能往里塞内容、并且（本轮加了删除之后）删掉别人的资料 ——
    而知识库在这套产品里是**权威参考资料**，不是论坛。

    只在写这边加门槛（不动读）的额外好处：不需要用户理解两套可见性，
    也不会让「只读成员」看到任何差异。
    """
    kb, member = _kb_or_404(session, kb_id, user)
    if not role_at_least(member.role, ROLE_ADMIN):
        raise HTTPException(status_code=403, detail="只有管理员可以修改知识库内容")
    return kb, member


def _backfill_hashes(session: Session, kb_id: str) -> int:
    """给「摘要字段存在之前入库」的文档补算 `content_hash`，返回补了几篇。

    为什么是懒回填而不是启动时全量扫：这段代码只需要在**判重之前**正确，
    而判重只发生在入库时。启动时扫全库会让每一次重启都变慢，换来的只是
    「大概率用不到的提前量」。

    为什么能补：正文本身不入库，但**块一直存着**，而摘要按块算
    （见 `kb/digest.py` 第 2 条理由）。
    """
    legacy = session.exec(
        select(KbDocument).where(KbDocument.kb_id == kb_id, KbDocument.content_hash == "")
    ).all()
    if not legacy:
        return 0
    for doc in legacy:
        chunks = session.exec(
            select(KbChunk).where(KbChunk.doc_id == doc.id).order_by(KbChunk.ordinal)
        ).all()
        doc.content_hash = digest_of([chunk.text for chunk in chunks])
        session.add(doc)
    session.commit()
    return len(legacy)


def _insert_document(
    session: Session, kb: KnowledgeBase, user: User, *, title: str, content: str, kind: str
) -> tuple[KbDocument, int]:
    """文本入库的唯一实现（粘贴正文与上传文件两条入口共用）。

    返回 `(文档行, 实际写入的向量条数)`。**切块 → 判重 → 落库 → 建索引**的顺序不能换：
    判重必须在落库前（否则先写进去再删，等于自己制造了一次写放大），
    建索引必须在落库后（向量行以 `chunk_id` 为外键）。

    ## 判重为什么是 409 而不是「静默跳过」

    静默跳过会让「这篇到底进没进去」变成需要去文档列表里数的事。409 把
    「已经在库里，那篇叫《X》，要替换请先删掉它」一次说清。作用域是**本库**
    （跨库同内容是正常的，见 `kb/digest.py`）。
    """
    chunks = chunk_text(content)
    if not chunks:
        raise HTTPException(status_code=422, detail="文档内容为空")

    digest = digest_of(chunks)
    _backfill_hashes(session, kb.id)
    if digest:
        duplicate = session.exec(
            select(KbDocument).where(KbDocument.kb_id == kb.id, KbDocument.content_hash == digest)
        ).first()
        if duplicate is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"这篇内容已经在库里了（《{duplicate.title}》），没有重复入库。"
                    "要替换请先删掉那一篇"
                ),
            )

    doc = KbDocument(
        id=new_user_id(),
        kb_id=kb.id,
        title=title,
        chars=len(content),
        chunk_count=len(chunks),
        content_hash=digest,
        kind=kind,
        created_by=user.id,
    )
    session.add(doc)
    chunk_rows: list[KbChunk] = []
    for ordinal, text in enumerate(chunks):
        row = KbChunk(id=new_user_id(), kb_id=kb.id, doc_id=doc.id, ordinal=ordinal, text=text)
        session.add(row)
        chunk_rows.append(row)
    session.commit()
    session.refresh(doc)

    # 建索引（FR-4.7 向量检索）：embedder 关着就跳过，失败也只是「这篇先只有词法能搜到」。
    embedded = 0
    resolution = resolve_embedder()
    if resolution.embedder is not None:
        embedded, _error = _embed_chunks(session, resolution.embedder, chunk_rows)
    return doc, embedded


def _document_view(
    doc: KbDocument, *, embedded: int, warnings: list[str] | None = None
) -> DocumentView:
    """`kind` 从行上读（入库时写进去了），所以列表与入库的响应形状天然一致。

    之前这里是「调用方传 kind」，而列表接口没传 → 列表里永远显示 `text`。
    同一份数据在两条路径上有两个来源，就是这类「只有一处会说真话」的根因。
    """
    return DocumentView(
        id=doc.id,
        kbId=doc.kb_id,
        title=doc.title,
        chars=doc.chars,
        chunkCount=doc.chunk_count,
        createdAt=iso_z(doc.created_at),
        embedded=embedded,
        kind=doc.kind,
        warnings=list(warnings or []),
    )


@router.post("/kbs/{kb_id}/documents", response_model=DocumentView, status_code=201)
def create_document(
    kb_id: str,
    payload: CreateDocumentRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentView:
    """入库：切块后**只有块进库**（文档行只存元数据），见 `models.py` 的说明。"""
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    title = payload.title.strip()
    if title == "":
        raise HTTPException(status_code=422, detail="标题不能为空")
    doc, embedded = _insert_document(
        session, kb, user, title=title, content=payload.content, kind="text"
    )
    return _document_view(doc, embedded=embedded)


@router.post("/kbs/{kb_id}/documents/file", response_model=DocumentView, status_code=201)
def upload_document(
    kb_id: str,
    payload: UploadFileRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentView:
    """上传文件入库：**先解析、再落库**（解析失败不留半篇文档）。

    走 base64 JSON 而不是 multipart：服务端不必为这一个接口引入 `python-multipart`，
    客户端也不必处理表单边界（`FileReader` 读成 dataURL 就够）。代价是体积膨胀 1/3，
    对知识库文档（通常几百 KB）无所谓。
    """
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    try:
        data = decode_base64(payload.contentBase64)
        parsed = parse_document(payload.filename, data)
    except ParseError as error:
        # 解析失败的原因（缺 pypdf / 扫描件 / 旧版 Office）**原样说给用户**，
        # 压成「上传失败」等于让人去猜该换什么格式
        raise HTTPException(status_code=422, detail=str(error)) from error

    if len(parsed.text) > MAX_DOCUMENT_CHARS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"正文 {len(parsed.text)} 字，超过单篇 {MAX_DOCUMENT_CHARS} 字上限；"
                "请拆分后分多次上传"
            ),
        )

    raw_title = (payload.title or "").strip() or default_title(payload.filename)
    title = raw_title[:200] or "未命名文档"
    doc, embedded = _insert_document(
        session, kb, user, title=title, content=parsed.text, kind=parsed.kind
    )
    return _document_view(doc, embedded=embedded, warnings=parsed.warnings)


@router.get("/kbs/{kb_id}/documents", response_model=list[DocumentView])
def list_documents(
    kb_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[DocumentView]:
    kb, _member = _kb_or_404(session, kb_id, user)
    rows = session.exec(select(KbDocument).where(KbDocument.kb_id == kb.id)).all()
    # 「这篇有没有建索引」是列表最该回答的问题之一：一篇没索引的文档搜不到，
    # 而界面上它和正常文档长得一模一样 —— 那是「我明明传了，它就是搜不到」的根。
    # 一次 GROUP BY 拿到全部文档的向量条数，不逐篇查（见 vectors.count_vectors_by_doc）。
    resolution = resolve_embedder()
    by_doc = (
        count_vectors_by_doc(session, kb_id=kb.id, model=resolution.model)
        if resolution.embedder is not None
        else {}
    )
    return [
        _document_view(doc, embedded=by_doc.get(doc.id, 0))
        for doc in sorted(rows, key=lambda item: (item.created_at, item.id))
    ]


@router.patch("/kbs/{kb_id}/documents/{doc_id}", response_model=DocumentView)
def rename_document(
    kb_id: str,
    doc_id: str,
    payload: RenameDocumentRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentView:
    """改标题（内容不动）。要 admin —— 与入库同一个门槛。

    独立于「删除 + 重传」的意义：判重会让「同内容换个标题重传」变成 409，
    所以标题必须能单独改，否则改错标题就只能删了再传（还会丢掉原来的创建时间）。
    """
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    doc = session.get(KbDocument, doc_id)
    if doc is None or doc.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="文档不存在")
    title = payload.title.strip()
    if title == "":
        raise HTTPException(status_code=422, detail="标题不能为空")
    doc.title = title[:200]
    session.add(doc)
    session.commit()
    session.refresh(doc)
    resolution = resolve_embedder()
    embedded = 0
    if resolution.embedder is not None:
        embedded = count_vectors_by_doc(session, kb_id=kb.id, model=resolution.model).get(doc.id, 0)
    return _document_view(doc, embedded=embedded)


@router.delete("/kbs/{kb_id}/documents/{doc_id}", status_code=204)
def delete_document(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    """删一篇文档：连同它的**块、向量**一起删干净。

    ## 三张表都要动，且顺序有意义

    `kb_vectors` → `kb_chunks` → `kb_documents`。SQLite 默认不强制外键，
    所以顺序不是「不这样就报错」，而是「不这样就会留下孤儿行」：孤儿块会被
    检索命中（它们还带着 kb_id），于是用户看到一份**已经删掉的**文档出现在结果里，
    而列表里找不到它 —— 那种「幽灵数据」比直接报错难排查得多。
    """
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    doc = session.get(KbDocument, doc_id)
    if doc is None or doc.kb_id != kb.id:
        # `doc.kb_id != kb.id` 这条不能省：否则可以拿 A 库的 kb_id 去删 B 库的文档
        raise HTTPException(status_code=404, detail="文档不存在")

    delete_vectors_for_doc(session, doc_id=doc.id)
    for chunk in session.exec(select(KbChunk).where(KbChunk.doc_id == doc.id)).all():
        session.delete(chunk)
    session.delete(doc)
    session.commit()


def _rank_candidates(
    session: Session, candidates: list[KbChunk], kb_ids: list[str], query: str, top_k: int
) -> tuple[list[ScoredChunk], str]:
    """返回 `(排序结果, 实际用的模式)`；**永不抛**（向量那一路出任何问题都退回词法）。

    模式口径：
    - `lexical`：只有词法。embedder 关着、还没建索引、或查询向量化失败时都是它。
    - `hybrid`：两路都有结果，经 RRF 合并（词法抓精确词/编号，向量抓近似表达）。
    - `vector`：**词法一条都没命中、但向量命中了**才出现。这正是语义检索的价值场景
      （「报销」↔「费用核销」零字面重合），所以不能因为 `lexical` 为空就提前返回。
    """
    lexical = rank_chunks([chunk.text for chunk in candidates], query, top_k=len(candidates))
    resolution = resolve_embedder()
    embedder = resolution.embedder
    if embedder is None:
        return lexical[:top_k], "lexical"

    chunk_ids = [chunk.id for chunk in candidates]
    vectors = load_vectors(session, kb_ids=kb_ids, model=embedder.name, dim=embedder.dim)
    if not vectors:
        # 不是错误：这批候选还没建索引（老文档 / 刚换 embedder），词法照常可用
        return lexical[:top_k], "lexical"

    try:
        query_vector = embedder.embed([query])[0]
    except Exception as error:  # noqa: BLE001 —— 见 docstring
        logger.warning("知识库查询向量化失败，退回词法：%s", error)
        return lexical[:top_k], "lexical"

    semantic = rank_by_vectors(query_vector, chunk_ids, vectors, top_k=len(vectors))
    if not semantic:
        return lexical[:top_k], "lexical"
    if not lexical:
        return semantic[:top_k], "vector"
    return hybrid_rank(lexical, semantic, top_k=top_k), "hybrid"


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
    allowed = visible_kb_ids(session, org_id, member)

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
        scope_ids = list(dict.fromkeys(payload.kbIds))
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

    ranked, _mode = _rank_candidates(session, candidates, scope_ids, payload.query, payload.topK)
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
    _set_departments(session, kb, payload.allowedDepartments)
    session.commit()
    session.refresh(kb)
    return _kb_view(session, kb)


# —— 向量检索的状态与重建（FR-4.7，2026-10-24）——
#
# 两个接口解决的是「界面必须说真话」：知识库页原来写死一句「当前为词法检索」，
# 一旦有人打开 embedder 它就开始撒谎。改成页面读这里的状态再渲染，
# 顺带能把「还有多少块没建索引」和「配置错了」一并显示出来。


class RetrievalView(BaseModel):
    """检索能力与索引覆盖率。

    `mode` 是**能力口径**（这台服务能不能做向量检索），不是单次查询实际走的那条路：
    单次查询里如果候选一个向量都没有，仍会退回词法。两者混成一个字段会让
    「界面说在做向量检索、其实走的是词法」变成无法解释的现象。
    """

    mode: str
    embedder: str
    model: str
    dim: int
    #: 统计范围内的块总数（给了 `kbId` 就是该库，否则全站）
    chunks: int
    #: 当前模型已建好索引的块数
    indexed: int
    #: `indexed < chunks`：有新文档没建索引，或换了 embedder 还没重建
    stale: bool
    #: 配置错误（比如选了 openai 却没给 base_url）——此时 `embedder` 会在检索时被跳过
    error: str = ""


class ReindexView(BaseModel):
    indexed: int
    total: int
    model: str
    error: str = ""


@router.get("/kb/retrieval", response_model=RetrievalView)
def retrieval_status(
    kbId: str | None = None,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> RetrievalView:
    """当前检索能力 + 索引覆盖率。要求登录：它会把部署配置（模型名）带出去。"""
    if kbId:
        _kb_or_404(session, kbId, user)
    resolution = resolve_embedder()
    model = resolution.model
    if model:
        indexed, total = vector_coverage(session, model=model, kb_id=kbId)
    else:
        # embedder 关着时仍然给出「总块数」，好让界面解释「打开后要建多少块」
        query = select(KbChunk)
        if kbId:
            query = query.where(KbChunk.kb_id == kbId)
        indexed, total = 0, len(session.exec(query).all())

    enabled = resolution.embedder is not None
    return RetrievalView(
        mode="hybrid" if enabled else "lexical",
        embedder=resolution.kind,
        model=model,
        dim=resolution.dim,
        chunks=total,
        indexed=indexed,
        stale=enabled and indexed < total,
        error=resolution.error,
    )


@router.post("/kbs/{kb_id}/reindex", response_model=ReindexView)
def reindex_kb(
    kb_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> ReindexView:
    """给一个库的全部块重建索引（换 embedder、或补老文档时用）。

    **分批**：一批失败就停下并如实回报已写入多少（`indexed`），不做整库回滚——
    云端向量服务中途限流是常态，整批回滚等于每次都要从零开始。
    幂等：按 `(chunk_id, model)` upsert，重复跑不会堆向量。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    resolution = resolve_embedder()
    if resolution.embedder is None:
        # 422 而不是静默成功：没开 embedder 却调重建，是调用方搞错了状态
        raise HTTPException(
            status_code=422,
            detail=resolution.error or "未启用向量检索（NANOWORK_KB_EMBEDDER=off）",
        )

    chunks = session.exec(select(KbChunk).where(KbChunk.kb_id == kb.id)).all()
    indexed = 0
    error = ""
    for start in range(0, len(chunks), REINDEX_BATCH):
        batch = chunks[start : start + REINDEX_BATCH]
        written, error = _embed_chunks(session, resolution.embedder, batch)
        indexed += written
        if error:
            break
    return ReindexView(indexed=indexed, total=len(chunks), model=resolution.model, error=error)
