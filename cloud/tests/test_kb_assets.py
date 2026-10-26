"""文档里的图片（P2）：解析 → 入库 → 取图 → 权限 → 检索 → 删除。

这一组守的是**图片的可见性 = 所属库的可见性**这条不变量：图片不能成为绕过
权限的旁路（拿到 URL 就能看 = 权限形同虚设），也不能因为图注参与检索就
让不可见的库里的内容被搜出来。
"""

from __future__ import annotations

import base64
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.db import engine
from app.kb.assets import collect_asset_ids, replace_pending_refs, strip_asset_refs
from app.kb.chunking import retrieval_text
from app.kb.parsing import parse_document
from tests.conftest import auth_headers
from tests.test_kb_documents import _kb, _org

#: 1×1 的 PNG。够用来验证「字节原样存取」，不用塞二进制夹具进仓库。
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

_NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
_NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def make_docx_with_image(
    caption: str = "系统架构图",
    text: str = "下面是架构图：",
    name: str = "图1",
) -> bytes:
    """造一份「一段文字 + 一张图」的 docx。

    `name` 是 Word 给图的内部名（默认自动编号「图1」），`caption` 是替代文字（`descr`）。
    """
    document = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<w:document xmlns:w="{_NS_W}" xmlns:wp="{_NS_WP}" xmlns:a="{_NS_A}" xmlns:r="{_NS_R}">'
        f"<w:body>"
        f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"
        f"<w:p><w:r><w:drawing><wp:inline>"
        f'<wp:docPr id="1" name="{name}" descr="{caption}"/>'
        f"<a:graphic><a:graphicData>"
        f'<a:blip r:embed="rId7"/>'
        f"</a:graphicData></a:graphic>"
        f"</wp:inline></w:drawing></w:r></w:p>"
        f"</w:body></w:document>"
    )
    relationships = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId7" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        'Target="media/image1.png"/>'
        "</Relationships>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document)
        archive.writestr("word/_rels/document.xml.rels", relationships)
        archive.writestr("word/media/image1.png", PNG_1X1)
    return buffer.getvalue()


# —— 解析层 ——


def test_docx_image_is_extracted_with_caption() -> None:
    parsed = parse_document("架构.docx", make_docx_with_image("系统架构图"))

    assert len(parsed.images) == 1
    assert parsed.images[0].data == PNG_1X1
    assert parsed.images[0].mime == "image/png"
    # 图注是这张图唯一的检索信号，必须取到
    assert parsed.images[0].alt == "系统架构图"
    # 正文里留占位（第几张图）
    assert "asset-index:0" in parsed.text


def test_auto_picture_name_is_not_used_as_caption() -> None:
    """没有替代文字时**不拿自动名兜底**：`图1` / `picture 7` 是软件起的编号。

    原来「总比空强」的判断是错的 —— 图注会**显示在图片下方**并进检索，
    `picture 7` 那种编号既不是说明、又是英文噪声。空图注 + 一条可操作提示更好。
    """
    parsed = parse_document("架构.docx", make_docx_with_image(caption="", text="看图"))

    assert len(parsed.images) == 1
    assert parsed.images[0].alt == ""
    # 「这张图现在搜不到，去哪补」要说出来
    assert any("没有图注" in item for item in parsed.warnings)


def test_handwritten_picture_name_is_still_used() -> None:
    """作者手写过的 `name`（不是自动编号）依然当图注 —— 它是人写的。"""
    parsed = parse_document("架构.docx", make_docx_with_image(caption="", name="系统架构总览"))

    assert parsed.images[0].alt == "系统架构总览"


def test_caption_with_bracket_survives_parse_and_replace() -> None:
    """图注里带 `]`（`图 1] 架构`）不能被截断。

    图注现在是用户手打的一行字，`[草稿]`、`图 1]` 这类写法随时会出现；
    引用一旦在 `]` 处被截断，入库时换不到真实 id —— 症状是「改完图注保存，图片坏了」。
    """
    parsed = parse_document("架构.docx", make_docx_with_image(caption="图 1] 架构"))

    # 写进正文时 `]` 被转义（Markdown 的 alt 以未转义的 `]` 结束）
    assert "图 1\\] 架构" in parsed.text
    # 整条引用仍然认得出来 → 能换成真实 id
    replaced = replace_pending_refs(parsed.text, ["abc123"])
    assert "![图 1\\] 架构](asset:abc123)" in replaced
    # 检索/判重看到的是还原后的**人话**
    assert strip_asset_refs(replaced).endswith("图 1] 架构")


def make_docx_with_table_image(caption: str = "审批流程图") -> bytes:
    """造一份 `w:tbl` 里嵌图片的 docx（台账的「图示」列就是这么写的）。"""
    cell_image = (
        '<w:drawing><wp:inline><wp:docPr id="2" name="图2" '
        f'descr="{caption}"/><a:graphic><a:graphicData>'
        '<a:blip r:embed="rId7"/></a:graphicData></a:graphic></wp:inline></w:drawing>'
    )
    document = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<w:document xmlns:w="{_NS_W}" xmlns:wp="{_NS_WP}" xmlns:a="{_NS_A}" xmlns:r="{_NS_R}">'
        "<w:body><w:tbl>"
        "<w:tr><w:tc><w:p><w:r><w:t>步骤</w:t></w:r></w:p></w:tc>"
        "<w:tc><w:p><w:r><w:t>图示</w:t></w:r></w:p></w:tc></w:tr>"
        "<w:tr><w:tc><w:p><w:r><w:t>审批</w:t></w:r></w:p></w:tc>"
        f"<w:tc><w:p><w:r>{cell_image}</w:r></w:p></w:tc></w:tr>"
        "</w:tbl></w:body></w:document>"
    )
    relationships = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId7" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        'Target="media/image1.png"/>'
        "</Relationships>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document)
        archive.writestr("word/_rels/document.xml.rels", relationships)
        archive.writestr("word/media/image1.png", PNG_1X1)
    return buffer.getvalue()


def test_image_inside_table_cell_is_extracted() -> None:
    """表格单元格里的图**不能静默消失**。

    原来只读 `w:t`，那一格里的图连占位都没有 —— 图和图注一起丢掉，界面上却看不出
    任何异常（文档照样入库、照样能搜到别的字）。现在占位落在单元格里，
    检索投影会把它剥成图注（`图示: 审批流程图`）。
    """
    parsed = parse_document("台账.docx", make_docx_with_table_image("审批流程图"))

    assert len(parsed.images) == 1
    assert parsed.images[0].alt == "审批流程图"
    table_block = next(part for part in parsed.text.split("\n\n") if "| 步骤 |" in part)
    assert "![审批流程图](asset-index:0)" in table_block
    # 投影：图注留下、asset 引用剥掉
    assert "图示: 审批流程图" in retrieval_text(table_block)
    assert "asset-index" not in retrieval_text(table_block)


# —— 入库 ——


def test_upload_docx_with_image_stores_asset(client: TestClient) -> None:
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)
    payload = base64.b64encode(make_docx_with_image()).decode()

    resp = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "架构.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    )

    assert resp.status_code == 201, resp.text
    detail = client.get(
        f"/api/kbs/{kb['id']}/documents/{resp.json()['id']}", headers=auth_headers(owner)
    ).json()
    asset_ids = collect_asset_ids(detail["content"])
    assert len(asset_ids) == 1
    assert detail["content"].startswith("下面是架构图：")


def test_same_docx_with_image_is_rejected_as_duplicate(client: TestClient) -> None:
    """**图片 id 每次入库都变**，判重不能因此失效。

    这条是整件事最容易出错的地方：摘要若把 `asset:<id>` 算进去，同一份文档
    重传就会得到新摘要 → 「同一份资料只入一次库」这条约定形同虚设。
    """
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)
    payload = base64.b64encode(make_docx_with_image()).decode()

    first = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "架构.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    )
    assert first.status_code == 201, first.text

    second = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "架构.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    )

    assert second.status_code == 409
    assert "架构" in second.json()["detail"]


def test_two_documents_with_same_image_are_both_stored(client: TestClient) -> None:
    """同一张图在两篇文档里各存一份（不跨文档去重）。

    跨文档共享会让「删掉 A 文档」连带带走 B 文档还在用的图，留下一堆坏图引用。
    """
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)

    for index in range(2):
        # 文字不同（否则两篇内容真的一样，该判重 —— 那是正确的行为）
        body = base64.b64encode(make_docx_with_image(text=f"第 {index} 份文档的架构图：")).decode()
        resp = client.post(
            f"/api/kbs/{kb['id']}/documents/file",
            json={"filename": f"架构{index}.docx", "contentBase64": body},
            headers=auth_headers(owner),
        )
        assert resp.status_code == 201, resp.text

    listed = client.get(f"/api/kbs/{kb['id']}/documents", headers=auth_headers(owner)).json()
    assert len(listed) == 2


# —— 取图与权限 ——


def test_asset_can_be_fetched_with_bytes_intact(client: TestClient) -> None:
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)
    payload = base64.b64encode(make_docx_with_image()).decode()
    created = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "架构.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    ).json()
    detail = client.get(
        f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner)
    ).json()
    asset_id = collect_asset_ids(detail["content"])[0]

    resp = client.get(f"/api/kbs/{kb['id']}/assets/{asset_id}", headers=auth_headers(owner))

    assert resp.status_code == 200, resp.text
    assert resp.content == PNG_1X1
    assert resp.headers["content-type"] == "image/png"
    # 浏览器不能猜类型
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_asset_of_invisible_kb_is_forbidden(client: TestClient) -> None:
    """图片的可见性 = 所属库的可见性。**没有任何旁路。"""
    owner, member, org = _org(client)
    kb = _kb(client, owner, org)
    payload = base64.b64encode(make_docx_with_image()).decode()
    created = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "架构.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    ).json()
    detail = client.get(
        f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner)
    ).json()
    asset_id = collect_asset_ids(detail["content"])[0]

    # 收紧可见范围：只剩管理员与所有者
    client.patch(
        f"/api/kbs/{kb['id']}/visibility",
        json={"allowedRoles": ["admin", "owner"]},
        headers=auth_headers(owner),
    )

    resp = client.get(f"/api/kbs/{kb['id']}/assets/{asset_id}", headers=auth_headers(member))

    assert resp.status_code == 403


def test_asset_of_another_kb_is_not_found(client: TestClient) -> None:
    """图属于别的库时是 404（不泄露「这张图存在」）。"""
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)
    other = _kb(client, owner, org, "别的库")
    payload = base64.b64encode(make_docx_with_image()).decode()
    created = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "架构.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    ).json()
    detail = client.get(
        f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner)
    ).json()
    asset_id = collect_asset_ids(detail["content"])[0]

    resp = client.get(f"/api/kbs/{other['id']}/assets/{asset_id}", headers=auth_headers(owner))

    assert resp.status_code == 404


# —— 检索 ——


def test_caption_is_searchable_and_asset_id_is_not() -> None:
    """图注进检索文本，`asset:<id>` 不进。

    `asset:3f2a...` 是一串随机 hex：进向量只会稀释长度归一化，
    图片本体更是根本不该变成文本。
    """
    text = "下面是架构图：\n\n![系统架构图](asset:3f2a9c8b1d4e5f60718293a4b5c6d7e8)"

    projected = retrieval_text(text)

    assert "系统架构图" in projected
    assert "asset:" not in projected
    assert "3f2a9c8b" not in projected


def test_strip_asset_refs_keeps_only_caption() -> None:
    assert strip_asset_refs("前 ![架构图](asset:abc) 后") == "前 架构图 后"


# —— 删除 ——


def test_purge_removes_the_asset(client: TestClient) -> None:
    """彻底删除文档时图片一起清（软删进回收站时不清 —— 恢复后还得能用）。"""
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)
    payload = base64.b64encode(make_docx_with_image()).decode()
    created = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "架构.docx", "contentBase64": payload},
        headers=auth_headers(owner),
    ).json()
    detail = client.get(
        f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner)
    ).json()
    asset_id = collect_asset_ids(detail["content"])[0]

    # 先进回收站（软删）：图还在
    client.delete(f"/api/kbs/{kb['id']}/documents/{created['id']}", headers=auth_headers(owner))
    fetched = client.get(f"/api/kbs/{kb['id']}/assets/{asset_id}", headers=auth_headers(owner))
    assert fetched.status_code == 200

    # 彻底删除：图跟着走（彻底删除是 DELETE 带 purge=true）
    client.delete(
        f"/api/kbs/{kb['id']}/documents/{created['id']}?purge=true",
        headers=auth_headers(owner),
    )
    fetched = client.get(f"/api/kbs/{kb['id']}/assets/{asset_id}", headers=auth_headers(owner))
    assert fetched.status_code == 404


@pytest.mark.parametrize("suffix", [".svg", ".emf", ".wmf"])
def test_unsupported_image_types_are_not_stored(suffix: str) -> None:
    """SVG 能内嵌脚本（同源返回就能执行）→ 收；EMF/WMF 浏览器不认 → 也不收。"""
    from app.kb.assets import mime_for_suffix

    assert mime_for_suffix(suffix) is None


# —— 手动上传（粘贴 / 选文件）——


def _upload(client: TestClient, token: str, kb_id: str, data: bytes, filename: str):
    return client.post(
        f"/api/kbs/{kb_id}/assets",
        json={"filename": filename, "contentBase64": base64.b64encode(data).decode()},
        headers=auth_headers(token),
    )


def test_upload_asset_stores_bytes_and_uses_filename_as_caption(client: TestClient) -> None:
    """上传一张图 → 拿到 id；图注默认取文件名（它是唯一的检索信号）。"""
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)

    resp = _upload(client, owner, kb["id"], PNG_1X1, "系统架构图.png")

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["mime"] == "image/png"
    assert body["bytesLen"] == len(PNG_1X1)
    assert body["alt"] == "系统架构图"

    fetched = client.get(f"/api/kbs/{kb['id']}/assets/{body['id']}", headers=auth_headers(owner))
    assert fetched.status_code == 200
    assert fetched.content == PNG_1X1


def test_upload_asset_rejects_non_image_content(client: TestClient) -> None:
    """**按内容判定**：把 HTML 改名成 .png 也要拒。

    扩展名是用户能改的；魔数骗不过。
    """
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)

    resp = _upload(client, owner, kb["id"], b"<html><script>alert(1)</script></html>", "a.png")

    assert resp.status_code == 422
    assert "PNG" in resp.json()["detail"]


def test_upload_asset_requires_write_role(client: TestClient) -> None:
    """图片最终要插进某篇文档里 → 没写权限就传不了。"""
    owner, member, org = _org(client)
    kb = _kb(client, owner, org)

    resp = _upload(client, member, kb["id"], PNG_1X1, "a.png")

    assert resp.status_code == 403


def test_uploaded_asset_is_bound_to_document_on_save(client: TestClient) -> None:
    """粘贴通道的图：先上传（还没文档），保存文档时**绑到这篇上**。

    绑定之后它才会跟着文档一起被彻底删除清掉，也才不会被当成孤儿清走。
    """
    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)
    created = client.post(
        f"/api/kbs/{kb['id']}/documents",
        json={"title": "说明", "content": "第一版"},
        headers=auth_headers(owner),
    ).json()

    asset = _upload(client, owner, kb["id"], PNG_1X1, "架构.png").json()

    resp = client.patch(
        f"/api/kbs/{kb['id']}/documents/{created['id']}",
        json={"content": f"看图：\n\n![架构](asset:{asset['id']})"},
        headers=auth_headers(owner),
    )
    assert resp.status_code == 200, resp.text

    # 绑定生效：再查时它的 doc_id 已经是这篇
    from sqlmodel import Session, select

    from app.kb.models import KbAsset

    with Session(engine) as session:
        row = session.exec(select(KbAsset).where(KbAsset.id == asset["id"])).first()
        assert row is not None
        assert row.doc_id == created["id"]

    # 彻底删除文档 → 图跟着走
    client.delete(
        f"/api/kbs/{kb['id']}/documents/{created['id']}?purge=true",
        headers=auth_headers(owner),
    )
    assert (
        client.get(
            f"/api/kbs/{kb['id']}/assets/{asset['id']}", headers=auth_headers(owner)
        ).status_code
        == 404
    )


def test_orphan_assets_are_purged_after_ttl(client: TestClient) -> None:
    """上传后一直没被任何文档引用的图，超过保留期就被清掉。

    图片是「先入库、正文后引用」，用户上传后不保存文档就会留下孤儿图。
    """
    from datetime import timedelta

    from sqlmodel import Session, select

    from app.kb.models import KbAsset
    from app.timeutil import utc_now

    owner, _member, org = _org(client)
    kb = _kb(client, owner, org)
    asset = _upload(client, owner, kb["id"], PNG_1X1, "孤儿.png").json()

    # 把它的时间往前拨 2 小时（超过 1 小时的保留期）
    with Session(engine) as session:
        row = session.exec(select(KbAsset).where(KbAsset.id == asset["id"])).first()
        assert row is not None
        row.created_at = utc_now() - timedelta(hours=2)
        session.add(row)
        session.commit()

    # 再上传一张 → 顺带触发孤儿清理
    _upload(client, owner, kb["id"], PNG_1X1, "新的.png")

    with Session(engine) as session:
        row = session.exec(select(KbAsset).where(KbAsset.id == asset["id"])).first()
        assert row is None, "过期孤儿图没有被清掉"
