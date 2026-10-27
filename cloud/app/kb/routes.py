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

import gzip
import hashlib
import logging
import time
from datetime import timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth.deps import current_user
from app.auth.models import User
from app.auth.security import new_user_id
from app.db import get_session
from app.kb.assets import (
    collect_asset_ids,
    replace_pending_refs,
    sniff_mime,
    strip_asset_refs,
)
from app.kb.chunking import chunk_text, join_chunks, retrieval_text
from app.kb.digest import digest_of
from app.kb.embedding import resolve_embedder
from app.kb.files import document_mime, sha256_hex, suffix_of
from app.kb.models import (
    DEFAULT_ALLOWED_ROLES,
    KbAsset,
    KbChunk,
    KbDocument,
    KbFile,
    KbGridPreview,
    KnowledgeBase,
    KnowledgeBaseDepartment,
    roles_from_json,
    roles_to_json,
)
from app.kb.office2pdf import PDF_SUFFIX
from app.kb.parsing import (
    ParsedImage,
    ParseError,
    decode_base64,
    default_title,
    parse_document,
)
from app.kb.render import (
    RenderFailed,
    RenderUnavailable,
    is_available,
    is_convertible,
    render_pdf,
)
from app.kb.retrieval import ScoredChunk, hybrid_rank, rank_by_vectors, rank_chunks
from app.kb.vectors import (
    count_vectors_by_doc,
    delete_vectors_for_doc,
    load_vectors,
    save_vectors,
    vector_coverage,
)
from app.kb.visibility import kb_department_ids, member_can_read_kb, visible_kb_ids
from app.kb.workbook import PARSER_VERSION, XLSX_SUFFIX, dumps_workbook, parse_workbook
from app.orgs.department_access import managed_department_ids
from app.orgs.models import Department, OrgMember
from app.orgs.roles import ROLE_ADMIN, role_at_least
from app.timeutil import iso_z, utc_now

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["knowledge-base"])

#: 重建索引时每批处理多少块。分批是为了**部分成功也算数**：一次 300 块的 KB 打云端
#: 会中途限流，整批回滚等于什么都没做；分批写则前几批留着，重跑只补剩下的。
REINDEX_BATCH = 64

#: 回收站保留天数。超过就惰性清理（下一次任何列表/检索请求顺手清），
#: 不做定时任务：没有调度器时「靠 cron 清理」等于「永远不会清理」。
TRASH_RETENTION_DAYS = 30


def _trash_cutoff() -> str:
    """早于这个时间进回收站的文档该被真正删掉（ISO 字符串，与 `deleted_at` 同形状）。"""
    return iso_z(utc_now() - timedelta(days=TRASH_RETENTION_DAYS))


def _purge_document(session: Session, doc: KbDocument) -> None:
    """**真正**删掉一篇文档：三张表依次清空，顺序见 `delete_document` 的 docstring。

    单独抽出来是因为有两个入口（手动彻底删除、超过保留期惰性清理），
    而它们的顺序要求完全一样 —— 抄第二份就会有一份写错顺序。
    """
    delete_vectors_for_doc(session, doc_id=doc.id)
    for chunk in session.exec(select(KbChunk).where(KbChunk.doc_id == doc.id)).all():
        session.delete(chunk)
    # 图片跟着文档一起清（软删进回收站时**不清** —— 恢复后图片还得能用）
    for asset in session.exec(select(KbAsset).where(KbAsset.doc_id == doc.id)).all():
        session.delete(asset)
    # 原文件与预览 PDF 同理：它们只对活着的文档有意义
    original = session.get(KbFile, doc.id)
    if original is not None:
        session.delete(original)
    grid = session.get(KbGridPreview, doc.id)
    if grid is not None:
        session.delete(grid)
    session.delete(doc)


def _purge_expired(session: Session, kb_id: str) -> int:
    """清掉这个库里过了保留期的回收站文档，返回删了几篇。"""
    cutoff = _trash_cutoff()
    expired = session.exec(
        select(KbDocument).where(
            KbDocument.kb_id == kb_id,
            KbDocument.deleted_at != "",
            KbDocument.deleted_at < cutoff,
        )
    ).all()
    if not expired:
        return 0
    for doc in expired:
        _purge_document(session, doc)
    session.commit()
    return len(expired)


#: 单文档上限（字符）。没有上限的话，一次上传就能把 SQLite 撑到几百 MB，
#: 而解析是同步的——请求会先超时再留下半截数据。
MAX_DOCUMENT_CHARS = 200_000


class CreateKbRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    allowedRoles: list[str] | None = None
    #: 部门范围（**收窄**）：非空时只有属于这些部门（含子部门）的成员能看
    allowedDepartments: list[str] | None = None


class UpdateKbVisibilityRequest(BaseModel):
    """改可见范围 / 改名（PATCH /visibility）。

    ⚠️ **不能复用 `CreateKbRequest`**：那里的 `name` 是必填的，而客户端改可见范围时
    只发 `allowedRoles` / `allowedDepartments` —— 复用的结果是每次保存都 422
    `Field required`，而它只在真机上才暴露（客户端用例 mock 了网关，看不到请求体校验）。
    这里三个字段全部可选，语义是「传了才改」。
    """

    name: str | None = Field(default=None, min_length=1, max_length=64)
    allowedRoles: list[str] | None = None
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


class UploadAssetRequest(BaseModel):
    """上传一张图片（base64）。粘贴截图、选文件走的是同一个接口。"""

    filename: str = Field(default="", max_length=255)
    contentBase64: str = Field(min_length=1)


class AssetView(BaseModel):
    """一张已入库的图片。

    `alt` 是图注 —— **它唯一的检索信号**（图片本体不进切块、不进向量），
    所以服务端给一个默认值（文件名去扩展名），用户之后可以改。
    """

    id: str
    mime: str
    bytesLen: int = 0
    alt: str = ""


class UpdateDocumentRequest(BaseModel):
    """改标题 / 改正文。**两个字段都可选：传了才改。**

    标题上限 200 与服务端截断一致（超了不报错而是截断——标题不是数据）。
    正文没有长度上限检查：`chunk_text` 会把空正文挡成 422，超长正文按块切，
    真正的上限是前端编辑器的体验（几十万字的东西不该在浏览器里编辑）。
    """

    title: str | None = Field(default=None, min_length=1, max_length=255)
    content: str | None = None


class DocumentView(BaseModel):
    id: str
    kbId: str
    title: str
    chars: int
    chunkCount: int
    createdAt: str
    #: 最后一次改动的时间（改名 / 恢复）。老行没有这一列 → 服务端退回 `createdAt`，
    #: 所以客户端拿到的永远是**可显示的时间**，不必自己判空。
    updatedAt: str = ""
    #: 本次实际写入的向量条数（0 = 没建索引：embedder 关着，或云端向量化失败）。
    #: 单列一个字段是为了让「入库成功但没索引」这件事**看得见**——否则用户只会觉得
    #: 「新传的文档搜不到」，而界面一切正常。
    embedded: int = 0
    #: 来源格式：text（粘贴/纯文本）/ docx / pdf
    kind: str = "text"
    #: 解析过程中的降级说明（"PDF 有 2 页没有文本层"之类）。**必须回给用户**：
    #: 静默丢内容会变成"我明明传了那份资料，它就是搜不到"。
    warnings: list[str] = []
    #: 进回收站的时间；空串 = 正常文档。列表里要能看出"哪些是删过的"。
    deletedAt: str = ""


class DocumentFileView(BaseModel):
    """原文件与预览的状态（「原文」标签靠它决定能不能点）。

    刻意**不并进 `DocumentView`**：文档列表里每行都查一次 `kb_files` 是 N+1，
    而只有「打开抽屉」这一件事需要它 —— 一次额外的轻请求比列表变慢划算。

    ## 两条预览管线，各有一套状态

    `previewKind` 说**默认该进哪个视图**：
    - `grid`：.xlsx 的表格视图（可选中单元格、拖动行列、看公式栏与 sheet 标签）；
    - `pdf`：docx/pptx/pdf 的原格式预览（pdf.js 画出来）；
    - `none`：没有原文件（早期文档）或格式不支持。

    `previewState` 描述 **PDF/打印版式**这条线，四个值各对应一种界面：
    - `ready`：能直接看（PDF 直通，或已转好并落库）；
    - `pending`：还没转（服务端有能力，等用户点开时同步转）；
    - `failed`：转失败了（`previewError` 里有 Office 原话）；
    - `unavailable`：这台机器转不了（没有 Office / 早期文档没留原文件 / 格式不支持）。

    `gridState` 描述**表格视图**这条线（只有 .xlsx 有意义）：
    `pending`（还没解析）、`ready`、`failed`。
    """

    fileName: str = ""
    bytesLen: int = 0
    suffix: str = ""
    previewState: str = ""
    previewError: str = ""
    #: 本次/上次转换耗时（毫秒）。0 = 没转过（直通或读缓存）
    renderMs: int = 0
    #: 默认视图：`grid` / `pdf` / `none`（见类注释）
    previewKind: str = ""
    #: 表格视图状态：`pending` / `ready` / `failed`（非 .xlsx 恒为空）
    gridState: str = ""
    gridError: str = ""
    gridMs: int = 0
    #: 解析出的工作表数 / 内容单元格数（状态栏与提示用；不必解压 blob）
    gridSheets: int = 0
    gridCells: int = 0


class DocumentDetailView(DocumentView):
    """单篇详情 = 列表项 + 正文。

    `content` 是**把块按 `ordinal` 拼回来**的（见 `chunking.join_chunks`），
    不是原文件：切块会吃掉原始排版（表格摊成一行、图片直接不在里面）。界面必须
    把这件事说出来 —— 否则用户会以为「打开文档」看到的就是他上传的那份 PDF。
    """

    content: str = ""


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
    # 投影后再向量化：表格块要变成「列名: 值」才能把表头词带进向量。
    # ⚠️ 必须与 `_rank_candidates` 里的词法投影用**同一个** `retrieval_text`，
    # 否则索引时算的和查询时算的不是一回事，混合排序会把同一个块排出两个位置。
    texts = [retrieval_text(chunk.text) for chunk in chunks]
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
    if role_at_least(member.role, ROLE_ADMIN):
        return kb, member

    # 第二条通路：**该库允许部门的负责人**。
    # 只对"有部门范围"的库成立 —— 没有部门范围的库没有"这条线归谁管"的概念，
    # 那种库只能由组织管理员维护（否则任何 member 都能凭某个部门的负责人身份
    # 去改一个全组织可见的库，那就把写权限放得比读权限还宽了）。
    allowed = set(kb_department_ids(session, kb.id))
    if allowed:
        managed = managed_department_ids(session, kb.org_id, user.id)
        if managed & allowed:
            return kb, member

    raise HTTPException(status_code=403, detail="只有管理员或该部门的负责人可以修改知识库内容")


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


def _asset_alt(filename: str) -> str:
    """图片的默认图注 = 文件名去扩展名。

    图注是这张图**唯一的检索信号**，空的就等于这张图在检索里隐形。
    文件名至少常常带点信息（「架构图」「截图」）。
    """
    name = filename.strip().replace("\\", "/").rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return (name[:dot] if dot > 0 else name).strip()[:200]


def _store_assets(
    session: Session, kb_id: str, doc_id: str, images: list[ParsedImage]
) -> list[str]:
    """把图片存进 `kb_assets`，返回与 `images` **同序**的资产 id。

    ## 去重只在同一篇文档内

    同一篇里重复出现的图只存一份（引用指向同一个 id）。**不跨文档去重** ——
    跨文档共享会让「删掉 A 文档」连带带走 B 文档还在用的图，留下一堆坏图引用。
    一个知识库几百篇文档、图片总共也就几 MB，不值得为省这点空间换来悬空引用。
    """
    ids: list[str] = []
    for image in images:
        digest = hashlib.sha256(image.data).hexdigest()
        existing = session.exec(
            select(KbAsset).where(
                KbAsset.kb_id == kb_id,
                KbAsset.doc_id == doc_id,
                KbAsset.sha256 == digest,
            )
        ).first()
        if existing is not None:
            ids.append(existing.id)
            continue
        asset = KbAsset(
            id=new_user_id(),
            kb_id=kb_id,
            doc_id=doc_id,
            sha256=digest,
            mime=image.mime,
            bytes_len=len(image.data),
            alt=image.alt,
            blob=image.data,
        )
        session.add(asset)
        ids.append(asset.id)
    return ids


def _insert_document(
    session: Session,
    kb: KnowledgeBase,
    user: User,
    *,
    title: str,
    content: str,
    kind: str,
    images: list[ParsedImage] | None = None,
) -> tuple[KbDocument, int]:
    """文本入库的唯一实现（粘贴正文与上传文件两条入口共用）。

    返回 `(文档行, 实际写入的向量条数)`。**切块 → 判重 → 落库 → 建索引**的顺序不能换：
    判重必须在落库前（否则先写进去再删，等于自己制造了一次写放大），
    建索引必须在落库后（向量行以 `chunk_id` 为外键）。

    ## 图片怎么进来

    解析器给出的是 `![图注](asset-index:<下标>)`（图片的 id 要入库时才有）。
    这里先把图存进 `kb_assets` 拿到真 id，把占位换成 `![图注](asset:<id>)`，
    **然后才切块** —— 切块与判重看到的都是最终形态。

    ## 判重为什么按「剥离图片引用后的文本」算

    同一份文档重传时，图片会拿到**新的 id**（每次入库都生成新的）。带着 id 算摘要，
    「同一份资料只入一次库」这条约定就永远失效了。所以摘要只看文字与图注。

    ## 判重为什么是 409 而不是「静默跳过」

    静默跳过会让「这篇到底进没进去」变成需要去文档列表里数的事。409 把
    「已经在库里，那篇叫《X》，要替换请先删掉它」一次说清。作用域是**本库**
    （跨库同内容是正常的，见 `kb/digest.py`）。
    """
    images = images or []

    chunks = chunk_text(content)
    if not chunks:
        raise HTTPException(status_code=422, detail="文档内容为空")

    # 摘要只看文字与图注：图片 id 每次入库都变，带着它算就永远判不出重复
    digest = digest_of([strip_asset_refs(chunk) for chunk in chunks])
    _backfill_hashes(session, kb.id)
    if digest:
        duplicate = session.exec(
            select(KbDocument).where(KbDocument.kb_id == kb.id, KbDocument.content_hash == digest)
        ).first()
        if duplicate is not None:
            # 回收站里的同内容要单独说：此时的正确动作是「恢复」，不是「再删一次」也不是
            # 让用户以为必须先彻底删除才能重传（那会白丢一次索引重建）。
            if duplicate.deleted_at:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"这篇内容和回收站里的《{duplicate.title}》一样，恢复它就行（不必重新上传）"
                    ),
                )
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
    session.flush()

    # 存图 → 把占位换成真 id → **重新切块**（替换后长度变了，块边界会变）
    asset_ids = _store_assets(session, kb.id, doc.id, images)
    content = replace_pending_refs(content, asset_ids)
    # 正文里可能还引用了「先上传、后引用」的图（粘贴通道）→ 绑到这篇上
    _bind_assets(session, kb.id, doc.id, content)
    chunks = chunk_text(content)
    if not chunks:
        raise HTTPException(status_code=422, detail="文档内容为空")
    doc.chars = len(content)
    doc.chunk_count = len(chunks)

    chunk_rows: list[KbChunk] = []
    for ordinal, text in enumerate(chunks):
        row = KbChunk(id=new_user_id(), kb_id=kb.id, doc_id=doc.id, ordinal=ordinal, text=text)
        session.add(row)
        chunk_rows.append(row)
    session.commit()
    session.refresh(doc)

    # 建索引放在最后：向量行以 chunk_id 为外键，块必须先落库
    resolution = resolve_embedder()
    embedded = 0
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
        updatedAt=doc.updated_at or iso_z(doc.created_at),
        embedded=embedded,
        kind=doc.kind,
        warnings=list(warnings or []),
        deletedAt=doc.deleted_at,
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
        session,
        kb,
        user,
        title=title,
        content=parsed.text,
        kind=parsed.kind,
        images=parsed.images,
    )
    _store_original(session, kb, doc, payload.filename, data)
    return _document_view(doc, embedded=embedded, warnings=parsed.warnings)


def _store_original(
    session: Session,
    kb: KnowledgeBase,
    doc: KbDocument,
    filename: str,
    data: bytes,
) -> None:
    """把原文件留下来（「按原格式打开」的唯一前提）。

    为什么必须在**入库时**存：正文在那一刻就被切成块了，排版信息（位置、字号、
    颜色、层级）在块里**不存在** —— 事后无论怎么拼都拼不回原文件。

    存的时候顺手算 sha256：下载接口拿它当 ETag，将来也能用它判断「页面上的预览
    是不是这份文件的」。
    """
    session.add(
        KbFile(
            doc_id=doc.id,
            kb_id=kb.id,
            filename=filename.strip()[:200] or "document",
            mime=document_mime(filename),
            bytes_len=len(data),
            sha256=sha256_hex(data),
            blob=data,
        )
    )
    session.commit()


def _disposition(filename: str, *, inline: bool) -> str:
    """`Content-Disposition`：ASCII 兜底 + RFC 5987 的中文文件名。

    HTTP 头只能是 latin-1，中文文件名直接写进去会让整个响应 500（Starlette 会在
    编码时抛错）—— 所以必须走 `filename*=UTF-8''…`，同时给一个 ASCII 兜底名。
    """
    kind = "inline" if inline else "attachment"
    fallback = "".join(
        char if 32 <= ord(char) < 127 and char not in '"\\' else "_" for char in filename
    )
    return f"{kind}; filename=\"{(fallback or 'file')[:120]}\"; filename*=UTF-8''{quote(filename)}"


def _load_grid(session: Session, row: KbFile) -> KbGridPreview | None:
    grid = session.get(KbGridPreview, row.doc_id)
    if grid is None or grid.kb_id != row.kb_id:
        return None
    return grid


def _grid_view(grid: KbGridPreview | None, row: KbFile) -> dict[str, object]:
    """表格视图的状态。缓存是否还算数由**原文件 sha + 解析器版本**共同决定。

    过期的行不删也不覆盖（下次 POST 会重写）：这里只回答「现在能不能直接读」。
    """
    fresh = (
        grid is not None
        and grid.source_sha256 == row.sha256
        and grid.parser_version == PARSER_VERSION
    )
    if not fresh:
        return {"gridState": "pending"}
    if grid.state == "done" and grid.blob:
        return {
            "gridState": "ready",
            "gridMs": grid.ms,
            "gridSheets": grid.sheets,
            "gridCells": grid.cells,
        }
    if grid.state == "failed":
        return {"gridState": "failed", "gridError": grid.error or "表格解析失败"}
    return {"gridState": "pending"}


def _file_view(row: KbFile | None, grid: KbGridPreview | None = None) -> DocumentFileView:
    """原文件行 → 前端要的状态。四种值各对应一种**不同**的界面（见模型注释）。"""
    if row is None:
        return DocumentFileView(
            previewKind="none",
            previewState="unavailable",
            previewError="这篇是早期入库的，没有留原文件（那时只存正文）；重新上传一次即可按原格式查看",
        )

    suffix = suffix_of(row.filename)
    base: dict[str, object] = {
        "fileName": row.filename,
        "bytesLen": row.bytes_len,
        "suffix": suffix,
    }
    if suffix == XLSX_SUFFIX:
        # .xlsx 默认进表格视图；PDF 那条线只服务「打印版式」标签
        base.update(_grid_view(grid, row))
        preview_kind = "grid"
    elif is_convertible(suffix):
        preview_kind = "pdf"
    else:
        preview_kind = "none"
    base["previewKind"] = preview_kind

    # PDF 自己就是预览：不需要 Office，也不需要转
    if suffix == PDF_SUFFIX:
        return DocumentFileView(**base, previewState="ready", renderMs=row.render_ms)
    if row.render_state == "done" and row.pdf:
        return DocumentFileView(**base, previewState="ready", renderMs=row.render_ms)
    if row.render_state == "failed":
        return DocumentFileView(
            **base,
            previewState="failed",
            previewError=row.render_error or "预览生成失败",
            renderMs=row.render_ms,
        )
    if not is_convertible(suffix):
        return DocumentFileView(
            **base,
            previewState="unavailable",
            previewError=f"{suffix or '这种格式'}不支持原格式预览，看「正文」即可",
        )
    if not is_available():
        return DocumentFileView(
            **base,
            previewState="unavailable",
            previewError=(
                "服务端没有可用的文档转换器（Office 或 LibreOffice），"
                "生成不了原格式预览。看「正文」标签即可 —— 检索与阅读都不受影响"
            ),
        )
    return DocumentFileView(**base, previewState="pending")


@router.get("/kbs/{kb_id}/documents/{doc_id}/file")
def get_document_file(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Response:
    """下载**原文件**（当初上传的那份字节，一个 bit 都没动）。

    权限与读文档完全同一套（`_kb_or_404`）：库不可见就 403，文件不存在或不属于这个库
    就 404。不给签名 URL、不给免鉴权直链 —— 那等于开一个「拿到链接就能看」的洞。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    row = session.get(KbFile, doc_id)
    if row is None or row.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="这篇文档没有留原文件")
    return Response(
        content=row.blob,
        media_type=row.mime,
        headers={
            "Cache-Control": "private, max-age=3600",
            "ETag": f'"{row.sha256}"',
            # 原文件按扩展名给了白名单类型，但仍然禁掉嗅探：万一将来白名单放宽，
            # 也不至于出现「上传一个 .html 被当成页面执行」
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": _disposition(row.filename, inline=False),
        },
    )


@router.get("/kbs/{kb_id}/documents/{doc_id}/preview", response_model=DocumentFileView)
def get_preview_info(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentFileView:
    """只读预览状态（不触发转换）。前端打开抽屉时先问这一句。"""
    kb, _member = _kb_or_404(session, kb_id, user)
    row = session.get(KbFile, doc_id)
    if row is not None and row.kb_id != kb.id:
        row = None
    return _file_view(row, _load_grid(session, row) if row is not None else None)


@router.post("/kbs/{kb_id}/documents/{doc_id}/preview", response_model=DocumentFileView)
def build_preview(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentFileView:
    """**生成**预览 PDF（同步、幂等）。

    ## 为什么同步而不是后台任务

    转换只值 3–10 秒（40 页课件实测 10 秒），而后台任务要付：队列、状态机、重试、
    进程退出时的半成品清理。用户点开文档时等 10 秒、看着转圈，比「稍后自己好」
    更符合直觉。

    ## 为什么失败也回 200 + 状态

    前端要的是「现在能不能看原文、不能的话为什么」。用 5xx 表示失败，前端还得
    区分是网络错误还是转换错误，反而多一层猜测。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    row = session.get(KbFile, doc_id)
    if row is None or row.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="这篇文档没有留原文件")

    current = _file_view(row, _load_grid(session, row))
    if current.previewState in ("ready", "unavailable"):
        return current

    try:
        pdf, elapsed = render_pdf(row.blob, suffix_of(row.filename))
    except RenderUnavailable as error:
        # 能力缺失：把原因留在行上（换台有 Office 的机器还能再转），状态仍是"没转"
        row.render_error = str(error)
        session.add(row)
        session.commit()
        return DocumentFileView(
            fileName=row.filename,
            bytesLen=row.bytes_len,
            suffix=suffix_of(row.filename),
            previewState="unavailable",
            previewError=str(error),
        )
    except RenderFailed as error:
        row.render_state = "failed"
        row.render_error = str(error)
        row.render_ms = 0
        session.add(row)
        session.commit()
        return DocumentFileView(
            fileName=row.filename,
            bytesLen=row.bytes_len,
            suffix=suffix_of(row.filename),
            previewState="failed",
            previewError=str(error),
        )

    row.pdf = pdf
    row.pdf_bytes_len = len(pdf)
    row.render_state = "done"
    row.render_error = ""
    row.render_ms = elapsed
    session.add(row)
    session.commit()
    return _file_view(row, _load_grid(session, row))


@router.get("/kbs/{kb_id}/documents/{doc_id}/preview.pdf")
def get_preview_pdf(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Response:
    """取转好的 PDF（前端 pdf.js 把它画到 canvas 上）。"""
    kb, _member = _kb_or_404(session, kb_id, user)
    row = session.get(KbFile, doc_id)
    if row is None or row.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="这篇文档没有留原文件")
    # PDF 上传的预览**就是原文件**（不复制一份，那只会让库变大一倍）
    preview = row.pdf or (row.blob if suffix_of(row.filename) == PDF_SUFFIX else b"")
    if not preview:
        raise HTTPException(status_code=409, detail="预览还没生成，先请求生成预览")
    return Response(
        content=preview,
        media_type="application/pdf",
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": f'"{sha256_hex(preview)}"',
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": _disposition("preview.pdf", inline=True),
        },
    )


@router.get("/kbs/{kb_id}/documents/{doc_id}/preview.workbook")
def get_preview_workbook(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Response:
    """取表格视图的**工作簿 JSON**（.xlsx 专用）。

    ## 为什么是 gzip

    这团 JSON 通常 1–10 MB，压缩后常剩 1/5。**落库的就是压缩后的那份**：
    POST 压一次，之后每次打开都只是原样返回，不再付 CPU。用
    `gzip.compress(..., mtime=0)` 保证同一份输入产出同一份字节（ETag 才稳定）。

    `Content-Encoding: gzip` 交给浏览器自己解 —— 前端 `response.json()` 拿到的是
    解压后的 JSON，不必在业务代码里再写一遍解压。

    ## 状态码

    没原文件 404；不是 .xlsx / 还没解析 / 解析失败都是 409 + 一句人话 —— 前端
    据此决定是「先请求生成」还是「把失败原因摆出来」。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    row = session.get(KbFile, doc_id)
    if row is None or row.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="这篇文档没有留原文件")
    if suffix_of(row.filename) != XLSX_SUFFIX:
        raise HTTPException(status_code=409, detail="只有 .xlsx 支持表格视图")
    grid = _load_grid(session, row)
    if grid is None or grid.source_sha256 != row.sha256 or grid.parser_version != PARSER_VERSION:
        raise HTTPException(status_code=409, detail="表格视图还没生成，先请求生成表格视图")
    # 失败要先于「没有 blob」判断：失败行的 blob 本来就是空的，
    # 先看 blob 会把「文件坏了」说成「还没生成」，用户会一直点重试而不知道原因。
    if grid.state == "failed":
        raise HTTPException(status_code=409, detail=grid.error or "表格解析失败")
    if not grid.blob:
        raise HTTPException(status_code=409, detail="表格视图还没生成，先请求生成表格视图")
    return Response(
        content=grid.blob,
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Encoding": "gzip",
            "Cache-Control": "private, max-age=600",
            "ETag": f'"{row.sha256}-g{grid.parser_version}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/kbs/{kb_id}/documents/{doc_id}/preview.workbook", response_model=DocumentFileView)
def build_workbook(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentFileView:
    """**解析并落库**表格视图（同步、幂等）。

    ## 为什么同步

    解析是纯 CPU 的 zip + XML 读取，实测毫秒级到两秒（取决于表格大小），
    不需要 Office、不会弹窗、不会挂住 —— 与 PDF 渲染（3–10 秒、可能卡死）
    完全不是一回事，所以这里连队列都不该有。

    ## 为什么失败也回 200 + 状态

    与 `build_preview` 同一条理由：前端要的是「现在能不能看、不能的话为什么」。
    失败原因落库，下次打开直接说同一句话，而不是每次重新解析再失败一次。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    row = session.get(KbFile, doc_id)
    if row is None or row.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="这篇文档没有留原文件")
    if suffix_of(row.filename) != XLSX_SUFFIX:
        raise HTTPException(status_code=409, detail="只有 .xlsx 支持表格视图")

    grid = _load_grid(session, row)
    fresh = (
        grid is not None
        and grid.source_sha256 == row.sha256
        and grid.parser_version == PARSER_VERSION
        and grid.state == "done"
        and bool(grid.blob)
    )
    if fresh:
        return _file_view(row, grid)
    if grid is None:
        grid = KbGridPreview(doc_id=row.doc_id, kb_id=row.kb_id)
        session.add(grid)

    started = time.monotonic()
    try:
        payload = parse_workbook(row.blob)
    except ParseError as error:
        # 已解析成功过的旧结果也清掉：它对应的是另一份文件/另一版解析器
        grid.blob = b""
        grid.bytes_len = 0
        grid.state = "failed"
        grid.error = str(error)
        grid.ms = int((time.monotonic() - started) * 1000)
        grid.source_sha256 = row.sha256
        grid.parser_version = PARSER_VERSION
        session.add(grid)
        session.commit()
        return _file_view(row, grid)

    blob = gzip.compress(dumps_workbook(payload), compresslevel=6, mtime=0)
    grid.blob = blob
    grid.bytes_len = len(blob)
    grid.state = "done"
    grid.error = ""
    grid.ms = int((time.monotonic() - started) * 1000)
    grid.source_sha256 = row.sha256
    grid.parser_version = PARSER_VERSION
    grid.sheets = len(payload["sheets"])
    grid.cells = int(payload["totalCells"])
    session.add(grid)
    session.commit()
    return _file_view(row, grid)


@router.get("/kbs/{kb_id}/assets/{asset_id}")
def get_asset(
    kb_id: str,
    asset_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Response:
    """取一张图片。

    ## 权限与读文档**完全同一套**

    走 `_kb_or_404`：库不可见就是 403，图不存在（或不属于这个库）就是 404。
    图片的可见性就是所属库的可见性，**没有任何旁路** —— 不给签名 URL、
    不给免鉴权的直链，因为那等于开一个「拿到链接就能看」的洞。

    ## 为什么 `nosniff`

    `mime` 是入库时按扩展名白名单定的（`kb/assets.py`），不是用户随便填的；
    但 `nosniff` 仍然要加：它保证浏览器不猜类型。这样即使将来白名单放宽了，
    也不会出现「上传一个 .html 被当成页面执行」。

    ETag 用图片内容的 sha256：内容不变就不重传（`Cache-Control: private`，
    不进公共缓存 —— 知识库内容是私有的）。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    asset = session.get(KbAsset, asset_id)
    if asset is None or asset.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="图片不存在")
    return Response(
        content=asset.blob,
        media_type=asset.mime,
        headers={
            "Cache-Control": "private, max-age=3600",
            "ETag": f'"{asset.sha256}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


#: 单张图片上限（字节）。4MB 足够一张截图 / 一张架构图，
#: 又不至于让一张图把 SQLite 撑大（图片最终都进库）。
MAX_ASSET_BYTES = 4 * 1024 * 1024

#: 孤儿图片的保留期：上传后超过这么久还没被任何文档引用，就清掉。
#:
#: 为什么要清：图片是「先入库、正文后引用」（粘贴时要立刻看到图，不能等保存），
#: 所以用户上传后不保存文档就会留下一张没人引用的图。
ORPHAN_ASSET_TTL = timedelta(hours=1)


def _purge_orphan_assets(session: Session, kb_id: str) -> int:
    """清掉这个库里「上传了但没被任何文档引用」且已过期的图片。"""
    orphans = session.exec(
        select(KbAsset).where(
            KbAsset.kb_id == kb_id,
            KbAsset.doc_id == "",
            KbAsset.created_at < utc_now() - ORPHAN_ASSET_TTL,
        )
    ).all()
    for asset in orphans:
        session.delete(asset)
    if orphans:
        session.commit()
    return len(orphans)


def _bind_assets(session: Session, kb_id: str, doc_id: str, content: str) -> int:
    """把正文里引用的图片**绑定**到这篇文档上。

    图片上传时还没有文档（`doc_id` 为空），等文档保存时才知道它属于哪一篇。
    只绑定「属于本库且尚未绑定」的 —— 别人的图、已经绑过的图都不动。

    绑定之后它才跟着文档一起被彻底删除清掉（见 `_purge_document`），
    也才不会被当成孤儿清走。
    """
    bound = 0
    for asset_id in collect_asset_ids(content):
        asset = session.get(KbAsset, asset_id)
        if asset is None or asset.kb_id != kb_id or asset.doc_id != "":
            continue
        asset.doc_id = doc_id
        session.add(asset)
        bound += 1
    return bound


@router.post("/kbs/{kb_id}/assets", response_model=AssetView, status_code=201)
def upload_asset(
    kb_id: str,
    payload: UploadAssetRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> AssetView:
    """上传一张图片（粘贴截图 / 选文件）。

    ## 为什么要单独的接口

    图片是「**先入库、正文后引用**」：用户粘贴一张截图后要**立刻**看到它，
    而那要等文档保存就太迟了（用户可能还没想好放哪、也可能直接关掉）。
    代价是可能留下孤儿图 → 由 `_purge_orphan_assets` 惰性清理。

    ## 类型按**内容**判定

    扩展名是用户能改的（把 `.html` 改名成 `.png` 就能骗过扩展名检查），
    魔数骗不过，而且我们给出的 mime 正是浏览器真正会用的那个。

    ## 权限

    要写权限：图片最终要插进某篇文档里，没写权限就改不了文档 → 图也用不上。
    """
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    try:
        data = decode_base64(payload.contentBase64)
    except ParseError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    if len(data) > MAX_ASSET_BYTES:
        raise HTTPException(
            status_code=422,
            detail=f"图片超过 {MAX_ASSET_BYTES // (1024 * 1024)}MB 上限",
        )
    mime = sniff_mime(data)
    if mime is None:
        raise HTTPException(
            status_code=422,
            detail="只支持 PNG / JPEG / GIF / WebP / BMP 图片（按文件内容判定，不看扩展名）",
        )

    asset = KbAsset(
        id=new_user_id(),
        kb_id=kb.id,
        doc_id="",
        sha256=hashlib.sha256(data).hexdigest(),
        mime=mime,
        bytes_len=len(data),
        alt=_asset_alt(payload.filename),
        blob=data,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)

    # 顺带清一次孤儿图（低频操作，不放在列表这种热路径上）
    _purge_orphan_assets(session, kb.id)

    return AssetView(id=asset.id, mime=asset.mime, bytesLen=asset.bytes_len, alt=asset.alt)


@router.get("/kbs/{kb_id}/documents", response_model=list[DocumentView])
def list_documents(
    kb_id: str,
    includeDeleted: bool = False,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[DocumentView]:
    """文档列表。默认只看活文档；`includeDeleted=true` 看**回收站**（只看删过的）。

    两个口径而不是一个「全都要 + 前端筛」：回收站是个独立视图，
    混在同一个列表里最容易出的错是「以为删了、其实还混在正常列表里」。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    # 惰性清理：进来一次就顺手把过期清掉，不依赖外部调度
    _purge_expired(session, kb.id)
    query = select(KbDocument).where(KbDocument.kb_id == kb.id)
    query = (
        query.where(KbDocument.deleted_at != "")
        if includeDeleted
        else query.where(KbDocument.deleted_at == "")
    )
    rows = session.exec(query).all()
    # 「这篇有没有建索引」是列表最该回答的问题之一：一篇没索引的文档搜不到，
    # 而界面上它和正常文档长得一模一样 —— 那是「我明明传了，它就是搜不到」的根。
    # 一次 GROUP BY 拿到全部文档的向量条数，不逐篇查（见 vectors.count_vectors_by_doc）。
    resolution = resolve_embedder()
    by_doc = (
        count_vectors_by_doc(session, kb_id=kb.id, model=resolution.model)
        if resolution.embedder is not None
        else {}
    )
    # 回收站里的文档向量还留着（恢复后不必重建），但列表里显示"已建索引"会让人
    # 以为它还能被搜到 —— 统一显示 0，配合 `deletedAt` 一起看。
    if includeDeleted:
        by_doc = {}
    return [
        _document_view(doc, embedded=by_doc.get(doc.id, 0))
        for doc in sorted(rows, key=lambda item: (item.created_at, item.id))
    ]


@router.get("/kbs/{kb_id}/documents/{doc_id}", response_model=DocumentDetailView)
def get_document(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentDetailView:
    """读单篇：元数据 + 正文（块按 `ordinal` 拼回）。

    三件事按顺序说清：
    1. **读权限就是可见性**：走 `_kb_or_404`（`visibility.allows` 的唯一实现），
       越权与不存在一律 404 —— 不在客户端做任何过滤。
    2. **回收站里的不给读**：它已经「不在资料里」了，能读会让「删了还看得到」变成
       第二个真相。提示里直接说「恢复后才能查看」，省一次猜。
    3. **正文是拼回来的**：`join_chunks` 会去掉硬切的重叠，但原始排版（表格、图片）
       在切块那一步就没了 —— 界面必须如实标注。
    """
    kb, _member = _kb_or_404(session, kb_id, user)
    doc = _kb_document_or_404(session, kb, doc_id)
    if doc.deleted_at != "":
        raise HTTPException(status_code=404, detail="文档在回收站里，恢复后才能查看")

    chunks = session.exec(
        select(KbChunk).where(KbChunk.doc_id == doc.id).order_by(KbChunk.ordinal)
    ).all()
    resolution = resolve_embedder()
    embedded = (
        count_vectors_by_doc(session, kb_id=kb.id, model=resolution.model).get(doc.id, 0)
        if resolution.embedder is not None
        else 0
    )
    view = _document_view(doc, embedded=embedded)
    return DocumentDetailView(
        **view.model_dump(), content=join_chunks([chunk.text for chunk in chunks])
    )


@router.patch("/kbs/{kb_id}/documents/{doc_id}", response_model=DocumentView)
def update_document(
    kb_id: str,
    doc_id: str,
    payload: UpdateDocumentRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentView:
    """改标题 / 改正文。要 admin —— 与入库同一个门槛。

    ## 三个决定

    1. **正文以 Markdown 为唯一存储格式**：检索吃的是纯文本，编辑器产出的富文本
       必须在写入前落成 Markdown（不是 HTML）。存 HTML 等于让检索去啃标签。
    2. **改正文 = 重新入库**：切块 → 判重 → 换块 → 重建向量，一步都不能省。
       只改 `chars` 而不换块，会让「正文变了但搜到的还是旧句子」——那比不能编辑更糟。
    3. **判重要排除自己**：`content_hash != 本行` 才算重复，否则「改一个字再存」
       会被自己拦下。作用域仍是本库（跨库同内容正常）。

    换块的顺序与彻底删除一致（向量 → 块），否则会留下指向已删块的向量行。
    """
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    doc = _kb_document_or_404(session, kb, doc_id)
    touched = False

    if payload.title is not None:
        title = payload.title.strip()
        if title == "":
            raise HTTPException(status_code=422, detail="标题不能为空")
        doc.title = title[:200]
        touched = True

    chunk_rows: list[KbChunk] = []
    if payload.content is not None:
        content = payload.content
        chunks = chunk_text(content)
        if not chunks:
            raise HTTPException(status_code=422, detail="正文不能为空")

        # 与入库同一口径：摘要只看文字与图注（图片 id 每次入库都变）
        digest = digest_of([strip_asset_refs(chunk) for chunk in chunks])
        _backfill_hashes(session, kb.id)
        if digest:
            duplicate = session.exec(
                select(KbDocument).where(
                    KbDocument.kb_id == kb.id,
                    KbDocument.content_hash == digest,
                    KbDocument.id != doc.id,
                )
            ).first()
            if duplicate is not None:
                if duplicate.deleted_at:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"这段内容和回收站里的《{duplicate.title}》一样，恢复它就行"
                            "（不必把两篇改成一样）"
                        ),
                    )
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"这段内容和库里的《{duplicate.title}》完全一样，没有保存。"
                        "同一份资料在库里只需要一篇"
                    ),
                )

        # 顺序：向量 → 块。反过来会留下指向已删块的向量（彻底删除那边同理）
        delete_vectors_for_doc(session, doc_id=doc.id)
        for chunk in session.exec(select(KbChunk).where(KbChunk.doc_id == doc.id)).all():
            session.delete(chunk)
        session.flush()
        for ordinal, text in enumerate(chunks):
            row = KbChunk(id=new_user_id(), kb_id=kb.id, doc_id=doc.id, ordinal=ordinal, text=text)
            session.add(row)
            chunk_rows.append(row)

        doc.chars = len(content)
        doc.chunk_count = len(chunks)
        doc.content_hash = digest
        # 正文里新引用的图（粘贴通道上传的）→ 绑到这篇上，
        # 之后它才会跟着文档一起被彻底删除清掉
        _bind_assets(session, kb.id, doc.id, content)
        touched = True

    if not touched:
        raise HTTPException(status_code=422, detail="没有要改的字段")

    # 更新时间戳：列表上的「更新时间」如果一直等于创建时间，用户改完会以为没生效
    doc.updated_at = iso_z(utc_now())
    session.add(doc)
    session.commit()
    session.refresh(doc)

    embedded = 0
    resolution = resolve_embedder()
    if resolution.embedder is not None:
        if chunk_rows:
            embedded, _error = _embed_chunks(session, resolution.embedder, chunk_rows)
        else:
            embedded = count_vectors_by_doc(session, kb_id=kb.id, model=resolution.model).get(
                doc.id, 0
            )
    return _document_view(doc, embedded=embedded)


def _kb_document_or_404(session: Session, kb: KnowledgeBase, doc_id: str) -> KbDocument:
    """按 **库 + 文档** 取一篇，跨库一律 404。

    `doc.kb_id != kb.id` 这条不能省：否则可以拿 A 库的 kb_id 去删 B 库的文档。
    """
    doc = session.get(KbDocument, doc_id)
    if doc is None or doc.kb_id != kb.id:
        raise HTTPException(status_code=404, detail="文档不存在")
    return doc


@router.delete("/kbs/{kb_id}/documents/{doc_id}", status_code=204)
def delete_document(
    kb_id: str,
    doc_id: str,
    purge: bool = False,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    """删一篇文档：**默认进回收站**（软删），`purge=true` 才是彻底删除。

    ## 为什么默认软删

    硬删是不可逆的，而这个动作的触发场景恰恰最需要后悔药：一份资料传错了库、
    被别人误删、"删完才发现那是唯一一份"。软删的代价只是块与向量多占一份空间
    （30 天后惰性清理），换来的是「点错了还能恢复」。

    ## 软删只需要动一行，但**必须同时把它从检索里摘掉**

    块和向量都留着（恢复时才不用重建索引），所以"删了之后搜不到"不能靠数据消失
    来实现，只能靠查询条件（`KbDocument.deleted_at == ""` 的 join）。这条条件
    写在 `search_org_kbs` / `reindex_kb` / `list_documents` 三处，少一处就是
    「删掉了还能被搜到」。

    ## 彻底删除要动三张表，顺序也有意义

    `kb_vectors` → `kb_chunks` → `kb_documents`。SQLite 默认不强制外键，
    顺序不是「不这样就报错」，而是「不这样会留下孤儿行」：孤儿块带着 kb_id，
    照样被检索命中，于是列表里找不到的文档出现在结果里。
    """
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    doc = _kb_document_or_404(session, kb, doc_id)

    if purge:
        _purge_document(session, doc)
        session.commit()
        return
    if doc.deleted_at:
        # 幂等：已经在回收站里再删一次不算错，但也不该把进站时间刷新成"刚刚"
        # （否则重复点删除会把保留期无限延后）
        return
    doc.deleted_at = iso_z(utc_now())
    session.add(doc)
    session.commit()


@router.post("/kbs/{kb_id}/documents/{doc_id}/restore", response_model=DocumentView)
def restore_document(
    kb_id: str,
    doc_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> DocumentView:
    """从回收站恢复。块与向量都在（软删没动它们），所以恢复是**立刻可检索**的。"""
    kb, _member = _writable_kb_or_404(session, kb_id, user)
    doc = _kb_document_or_404(session, kb, doc_id)
    doc.deleted_at = ""
    # 恢复也算一次改动：否则「刚从回收站捞回来」的文档会显示成几个月前的创建时间
    doc.updated_at = iso_z(utc_now())
    session.add(doc)
    session.commit()
    session.refresh(doc)
    resolution = resolve_embedder()
    embedded = 0
    if resolution.embedder is not None:
        embedded = count_vectors_by_doc(session, kb_id=kb.id, model=resolution.model).get(doc.id, 0)
    return _document_view(doc, embedded=embedded)


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
    # 词法也在投影上打分：`| 张三 | 30 |` 这行不含「年龄」，不投影就永远搜不到。
    # 命中后返回给用户的仍是 `chunk.text`（原文表格），所以展示不受影响。
    lexical = rank_chunks(
        [retrieval_text(chunk.text) for chunk in candidates], query, top_k=len(candidates)
    )
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

    # 这一步就是「检索前过滤」：过滤条件在 SQL 里，候选集天生不含越权内容。
    # 回收站里的文档也要在这里排掉 —— 慢一步（比如在打分之后筛）就等于
    # 「删掉的东西还能被搜到」，而且会挤掉真正命中的名额。
    candidates = session.exec(
        select(KbChunk)
        .join(KbDocument, KbChunk.doc_id == KbDocument.id)
        .where(KbChunk.kb_id.in_(scope_ids), KbDocument.deleted_at == "")
    ).all()
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
    payload: UpdateKbVisibilityRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> KbView:
    """改可见范围 / 改名：**必须 admin**。

    这是本模块唯一「收紧之后别人就看不见」的操作，也是权限设计里最该有门槛的一步：
    普通成员能改，就等于任何人都能把管理员库对全员开放（或反过来把同事锁在门外）。
    """
    kb, member = _kb_or_404(session, kb_id, user)
    if not role_at_least(member.role, ROLE_ADMIN):
        raise HTTPException(status_code=403, detail="权限不足")
    if payload.name is not None:
        kb.name = payload.name.strip()[:64]
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
        query = (
            select(KbChunk)
            .join(KbDocument, KbChunk.doc_id == KbDocument.id)
            .where(KbDocument.deleted_at == "")
        )
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

    # 只重建活文档：给回收站里的块算向量既浪费额度，又会让覆盖率算不平
    chunks = session.exec(
        select(KbChunk)
        .join(KbDocument, KbChunk.doc_id == KbDocument.id)
        .where(KbChunk.kb_id == kb.id, KbDocument.deleted_at == "")
    ).all()
    indexed = 0
    error = ""
    for start in range(0, len(chunks), REINDEX_BATCH):
        batch = chunks[start : start + REINDEX_BATCH]
        written, error = _embed_chunks(session, resolution.embedder, batch)
        indexed += written
        if error:
            break
    return ReindexView(indexed=indexed, total=len(chunks), model=resolution.model, error=error)
