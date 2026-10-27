"""知识库表（FR-4.7 的 V1.5 服务端 MVP）。

四张表：库 → 文档 → 分块 → 分块向量（`KbVector`，见文件末尾）。
分块单独成表而不是塞进文档的 JSON 字段，是为了让
「检索前过滤」能落在 SQL 的 WHERE 上（见 `routes.search_kb`）：过滤条件必须是
**查询的一部分**，否则就成了「先全量取出来再在内存里筛」，也就是 PRD 明确反对的
「检索后过滤」。

⚠️ 给本模块的表加字段时：`create_all` 不会 ALTER 已存在的表，所以**必须同时**在
`app/migrations.py` 的 `ADDED_COLUMNS` 里登记一行（带 `DEFAULT`），否则老库上这一列
永远不存在，而测试库每次重建、看不出来。有了 `ensure_columns` 之后，
「为了加一个字段去建旁表」就不再必要 —— 旁表只应因为建模需要而存在。

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
    #: 内容摘要（按**切好的块**算，见 `kb/digest.py`）。用于「同一篇重复入库」判重。
    #: 空串 = 这一行产生于该字段存在之前（`migrations.ADDED_COLUMNS` 的默认值），
    #: 读的时候要按「没有摘要」处理，写入时由 `routes._backfill_hashes` 懒回填。
    content_hash: str = Field(default="", index=True)
    #: 来源格式：text（粘贴 / 纯文本）/ docx / pdf / xlsx / pptx。列表要显示，用户才知道那篇是什么。
    kind: str = "text"
    #: 进回收站的时间（ISO 字符串，空串 = **没删**）。
    #:
    #: 为什么是字符串而不是 `datetime | None`：这一列要经 `migrations.ensure_columns` 用
    #: 裸 DDL 加到**已存在的表**上，而 SQLite / PostgreSQL 对 datetime 的存储类型不同
    #: （DATETIME 字符串 vs TIMESTAMP）。用 ISO 字符串则两边都是文本，比较大小仍然等于
    #: 比较时间（字典序 = 时序），也不必担心方言。空串表示"未删除"也与本仓
    #: `departments.parent_id`（空串 = 根）的既有约定一致。
    deleted_at: str = Field(default="", index=True)
    #: 最后一次改动的时间（ISO 字符串，空串 = 本行产生于该字段之前 → 读的时候用 `created_at`）。
    #:
    #: 为什么与 `deleted_at` 一样用字符串：它要经 `migrations.ensure_columns` 用裸 DDL
    #: 加到已存在的表上，而 SQLite / PostgreSQL 对 datetime 的存储类型不同。空串而不是
    #: NULL，是为了让「按时间排序」在两边都只是字典序比较。
    updated_at: str = ""
    created_by: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)

    @property
    def trashed(self) -> bool:
        return self.deleted_at != ""


class KbChunk(SQLModel, table=True):
    __tablename__ = "kb_chunks"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    kb_id: str = Field(index=True, foreign_key="knowledge_bases.id")
    doc_id: str = Field(index=True, foreign_key="kb_documents.id")
    ordinal: int = 0
    text: str = ""


class KbVector(SQLModel, table=True):
    """分块向量（FR-4.7 的向量检索，2026-10-24）。

    ## 为什么单独一张表，而不是给 `KbChunk` 加一列

    两个理由，都是「不加就会真出事」的那种：

    1. **`create_all` 不会 ALTER 已存在的表**。`cloud.db` 里已经有 `kb_chunks` 了，
       给它新增列在启动时**静默不生效**（`create_all` 只建缺失的表），随后任何
       `SELECT vector` 都会在真机上炸，而测试库每次重建，永远看不出来。
       新表则一定被建出来。
    2. **同一块可能有多份向量**：换了 embedder（本地哈希 ↔ 远程模型）之后，旧向量
       仍然有效可回滚。以 `(chunk_id, model)` 为键就能让两套并存，检索时按
       「当前模型」取，不必先删库。

    向量存 BLOB（`array('f')` 的字节）而不是 JSON：维度 256 时 JSON 约 3KB / 块，
    BLOB 是 1KB。真正的规模化（HNSW / pgvector）不在这里做，见 `vectors.py` 的边界说明。
    """

    __tablename__ = "kb_vectors"  # type: ignore[assignment]

    #: 复合主键的一半由 `model` 承担 → 主键写成 `chunk_id` + `model` 的组合
    chunk_id: str = Field(primary_key=True, foreign_key="kb_chunks.id")
    #: 同一个块可能被多个模型各算一份
    model: str = Field(primary_key=True)
    kb_id: str = Field(index=True, foreign_key="knowledge_bases.id")
    doc_id: str = Field(index=True, foreign_key="kb_documents.id")
    dim: int = 0
    #: `array('f')` 打包后的小端 float32 字节
    vector: bytes = b""
    created_at: datetime = Field(default_factory=utc_now)


class KnowledgeBaseDepartment(SQLModel, table=True):
    """知识库的「部门可见范围」（2026-10-24）。

    ## 为什么是独立表，而不是给 `knowledge_bases` 加一列 JSON

    同 `KbVector` 的理由：`create_all` 不会 ALTER 已存在的表。本机 `cloud.db` 里
    `knowledge_bases` 早就有了，加列在启动时**静默不生效**，随后查询直接炸；
    而测试库每次重建，永远看不出来。独立表则一定被建出来。

    附带好处：`department_id` 上有索引，「某部门能看到哪些库」可以走 SQL，
    不必把整张知识库表拉到内存里解析 JSON。

    ⚠️ 语义是**收窄**不是放行：`allowed_roles` 说「哪些角色能看」，
    这张表说「还必须属于这些部门」。表里没有行 = 不按部门收窄（向后兼容）。
    """

    __tablename__ = "kb_departments"  # type: ignore[assignment]

    kb_id: str = Field(primary_key=True, foreign_key="knowledge_bases.id")
    department_id: str = Field(primary_key=True, index=True, foreign_key="departments.id")


class KbAsset(SQLModel, table=True):
    """文档里的图片二进制（2026-10-26）。

    ## 为什么独立表

    同 `KbVector` / `KnowledgeBaseDepartment`：`create_all` 不会 ALTER 已存在的表，
    给 `kb_documents` 加列在真机上**静默不生效**。新表一定被建出来。

    ## 二进制为什么进数据库而不是文件系统

    1. **权限跟着库走**：图片的可见性就是所属库的可见性。放文件系统就要另做一套
       「这个文件属于哪个库、谁能看」的目录与权限结构 —— 而库里已经有
       `kb/visibility.py::allows()` 这一个判定实现，复制一份必然走偏。
    2. **备份与事务一致**：一次备份带走库与它的图片；不会出现「文档删了、图还在」
       这种文件系统孤儿（数据库里删文档时能连带清掉资产）。

    代价是 SQLite 会被图片撑大。缓解：单图字节上限 + **按内容 sha256 去重**
    （同一张 logo 用十次只存一份）。

    ## 检索里没有它

    图片本体**不进切块、不进向量**。它唯一的检索信号是图注（alt），
    而图注在 Markdown 正文里（`![图注](asset:<id>)`）—— 那才是模型读的东西。
    """

    __tablename__ = "kb_assets"

    id: str = Field(primary_key=True)
    kb_id: str = Field(index=True, foreign_key="knowledge_bases.id")
    #: 所属文档。空串 = 还没绑定（入库时先建资产、后绑文档）
    doc_id: str = Field(default="", index=True)
    #: 图片字节的 sha256：①按内容去重 ②当 ETag（内容变了 URL 就变）
    sha256: str = Field(index=True)
    mime: str = "application/octet-stream"
    bytes_len: int = 0
    #: 图注。**它是这张图唯一的检索信号**，所以单独存一份（正文里那份可能被用户改）
    alt: str = ""
    blob: bytes = b""
    created_at: datetime = Field(default_factory=utc_now)


class KbGridPreview(SQLModel, table=True):
    """`.xlsx` 的**表格视图**模型（2026-10-27）。

    ## 为什么与 `KbFile.pdf` 分两张表、两条管线

    PDF 是打印抽象：它能让人「看到这张表长什么样」，但单元格选不中、列宽拖不动、
    formula 栏和 sheet 标签都不存在。要还原这些，前端需要的是工作簿模型
    （单元格、样式、合并、行高列宽、冻结、公式缓存值），而它的形状、体积、
    生成方式与 PDF 完全不同 —— 塞进同一列只会让两边都难读。

    两条管线也解开了一个耦合：**.xlsx 打开时不必再拉 Office**。表格视图是
    stdlib 解析（毫秒级），只有用户主动点「打印版式」时才需要转 PDF。

    ## 为什么要存 `source_sha256` + `parser_version`

    解析结果是**派生数据**，原文件一换就该重来。两者的组合就是「这份缓存还算不算数」
    的唯一判据：sha 变了 = 文件换了；版本变了 = 解析器改了（新增了样式映射之类）。
    任一不符就重新解析，而不是显示一份过期的表。

    ## 为什么 blob 是 gzip

    工作簿 JSON 里大量是重复的键名与样式片段，gzip 通常能压到 1/5–1/10。
    `gzip.compress(..., mtime=0)` 保证同一份输入产出同一份字节（ETag 才稳定）。
    """

    __tablename__ = "kb_grid_previews"

    #: 与文档同主键：一篇文档只有一份原文件、一份表格视图
    doc_id: str = Field(primary_key=True, foreign_key="kb_documents.id")
    kb_id: str = Field(index=True, foreign_key="knowledge_bases.id")
    #: 生成这份结果时原文件的 sha256（与 `KbFile.sha256` 不符即过期）
    source_sha256: str = Field(default="", index=True)
    #: 生成它的解析器版本（见 `workbook.PARSER_VERSION`）
    parser_version: int = 0
    #: 空串 = 还没解析；`done` / `failed`
    state: str = ""
    #: 失败原因（原样给用户看：文件坏了、还是数据量超了）
    error: str = ""
    ms: int = 0
    bytes_len: int = 0
    #: gzip 后的工作簿 JSON
    blob: bytes = b""
    #: 工作表数 / 内容单元格数（列表与状态栏要显示，不必解压 blob）
    sheets: int = 0
    cells: int = 0
    created_at: datetime = Field(default_factory=utc_now)


class KbFile(SQLModel, table=True):
    """文档的**原文件**与它的预览 PDF（2026-10-26）。

    ## 为什么必须存原文件

    入库时正文被切成块、原文件就丢了 —— 于是「按原格式打开」根本无从谈起
    （前端只能拿到拼回来的纯文本）。要像在线文档那样看排版，就必须把原始字节留住。

    ## 为什么 PDF 和原文件同一张表

    生命周期完全一致（文档被彻底删除时一起清），拆两张表只会多一条 join、
    多一处可能忘掉的清理。渲染是**派生**的：原文件在，PDF 随时可以重新生成，
    所以"PDF 列"可以随时清空重来，不会丢信息。

    ## 为什么二进制进数据库（与 `kb_assets` 同一条理由）

    权限跟着库走（`kb/visibility.py` 是唯一判定实现，不复制第二份）；
    备份与事务一致（删文档时连带清掉，不会出现文件系统孤儿）。
    单个文件上限 8MB（上传入口 `MAX_UPLOAD_BYTES`），几十上百篇的量级 SQLite 扛得住。

    ## 为什么没有 "pending" 状态

    转换不是后台任务：**打开时才同步转**（`routes.build_preview`）。
    所以 `render_state` 只有三种值 —— 空（还没转）、`done`、`failed`。
    有后台任务就要有队列、重试与进度，而这里的转换只值 3–10 秒。
    """

    __tablename__ = "kb_files"

    #: 与文档同主键：一篇文档只有一份原文件（多版历史不在本期范围）
    doc_id: str = Field(primary_key=True, foreign_key="kb_documents.id")
    kb_id: str = Field(index=True, foreign_key="knowledge_bases.id")
    #: 用户上传时的文件名（下载时还给用户）
    filename: str = ""
    mime: str = "application/octet-stream"
    bytes_len: int = 0
    #: 原文件内容的 sha256：当 ETag 用（内容变了 URL 就变）
    sha256: str = Field(default="", index=True)
    blob: bytes = b""
    #: 预览 PDF（Office 转出来的）。空 = 还没转或转换失败
    pdf: bytes = b""
    pdf_bytes_len: int = 0
    #: 空串 = 还没转；`done` / `failed`（见类注释：刻意没有 pending）
    render_state: str = ""
    #: 转换失败的原因（原样给用户看：是文件坏了、还是 Office 弹窗挡住了）
    render_error: str = ""
    #: 转换耗时（毫秒）。慢的时候要能看出是"这台机器慢"还是"文件太大"
    render_ms: int = 0
    created_at: datetime = Field(default_factory=utc_now)
