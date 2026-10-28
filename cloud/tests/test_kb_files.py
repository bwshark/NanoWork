"""原文件与预览 PDF（2026-10-26）：让文档能**按原格式打开**。

这一组守四件事：

1. **原文件一个 bit 都不能变** —— 它是「按原格式打开」的唯一依据，不是正文的缓存；
2. **预览失败要说人话** —— 没有 Office / 文件坏了 / 早期文档没留原文件，是三种
   完全不同的处境，用户该做的事也不同；
3. **权限没有旁路** —— 原文件与预览都走 `_kb_or_404`（与读正文同一套）；
4. **彻底删除连带清掉** —— 否则库变大、备份变重，且「删了但还占着空间」很难被发现。

Office 转换本身在 `test_office2pdf.py` 里用真文件验（需要本机装有 Office）；
这里把 `render_pdf` 换掉，只为钉住**状态机与接口契约**。
"""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from app.kb.models import KbFile
from app.kb.parsing import parse_document
from app.kb.render import RenderFailed
from tests.conftest import auth_headers
from tests.test_kb_documents import _kb, _org
from tests.test_kb_parsing import make_docx

FAKE_PDF = b"%PDF-1.4\n% fake preview\n"


def _upload(client: TestClient, token: str, kb_id: str, filename: str, data: bytes):
    return client.post(
        f"/api/kbs/{kb_id}/documents/file",
        json={"filename": filename, "contentBase64": base64.b64encode(data).decode()},
        headers=auth_headers(token),
    )


def _fake_render(pdf: bytes = FAKE_PDF):
    """替换 `routes.render_pdf`：不让用例真的去拉 Office。"""

    def _render(data: bytes, suffix: str) -> tuple[bytes, int]:
        return pdf, 123

    return _render


# —— 原文件 ——


def test_upload_keeps_original_bytes(client: TestClient) -> None:
    """上传的原文件要原样留在库里（含中文文件名）。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    data = make_docx(["差旅制度"])

    resp = _upload(client, owner, kb["id"], "差旅制度.docx", data)
    assert resp.status_code == 201, resp.text
    doc_id = resp.json()["id"]

    got = client.get(f"/api/kbs/{kb['id']}/documents/{doc_id}/file", headers=auth_headers(owner))

    assert got.status_code == 200
    assert got.content == data
    assert got.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.wordprocessingml"
    )
    # 中文文件名必须走 RFC 5987：直接写进头里会因为 latin-1 编码失败
    assert (
        "filename*=UTF-8''%E5%B7%AE%E6%97%85%E5%88%B6%E5%BA%A6.docx"
        in got.headers["content-disposition"]
    )
    assert got.headers["x-content-type-options"] == "nosniff"
    assert got.headers["etag"].startswith('"')


def test_original_file_is_scoped_to_its_kb(client: TestClient) -> None:
    """拿 A 库的凭证取 B 库的原文件 → 404（和图片一样，不留旁路）。"""
    owner, _member, org_id = _org(client)
    kb_a = _kb(client, owner, org_id, name="A库")
    kb_b = _kb(client, owner, org_id, name="B库")
    doc = _upload(client, owner, kb_b["id"], "b.docx", make_docx(["B 的文档"])).json()

    got = client.get(
        f"/api/kbs/{kb_a['id']}/documents/{doc['id']}/file", headers=auth_headers(owner)
    )

    assert got.status_code == 404


# —— 预览状态机 ——


def test_pdf_upload_is_its_own_preview(client: TestClient) -> None:
    """PDF 不需要转换：它自己就是预览（这台机器没 Office 也能看）。"""
    pytest.importorskip("pypdf", reason="PDF 解析是可选依赖")
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    data = _tiny_pdf("travel policy")
    doc = _upload(client, owner, kb["id"], "制度.pdf", data).json()

    info = client.get(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview", headers=auth_headers(owner)
    ).json()

    assert info["previewState"] == "ready"
    assert info["suffix"] == ".pdf"

    got = client.get(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview.pdf", headers=auth_headers(owner)
    )
    assert got.status_code == 200
    assert got.content == data


def test_preview_pending_then_done(client: TestClient, monkeypatch) -> None:
    """Office 文档：先 pending，转完变 done，并能取到 PDF。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()

    monkeypatch.setattr("app.kb.routes.render_pdf", _fake_render())

    before = client.get(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview", headers=auth_headers(owner)
    ).json()
    assert before["previewState"] in ("pending", "unavailable")  # 取决于本机有没有 Office

    built = client.post(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview", headers=auth_headers(owner)
    ).json()
    # 对外状态是「能不能看」（ready），不是内部渲染状态（done）
    assert built["previewState"] == "ready", built
    assert built["renderMs"] == 123

    pdf = client.get(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview.pdf", headers=auth_headers(owner)
    )
    assert pdf.status_code == 200
    assert pdf.content == FAKE_PDF


def test_preview_is_idempotent(client: TestClient, monkeypatch) -> None:
    """第二次请求直接用落库的 PDF，不再拉 Office（转换是贵操作）。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()
    calls: list[int] = []

    def _counted(data: bytes, suffix: str) -> tuple[bytes, int]:
        calls.append(1)
        return FAKE_PDF, 5

    monkeypatch.setattr("app.kb.routes.render_pdf", _counted)

    for _ in range(2):
        resp = client.post(
            f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview", headers=auth_headers(owner)
        )
        assert resp.json()["previewState"] == "ready"

    assert len(calls) == 1


def test_stale_render_version_triggers_one_refresh(client: TestClient, monkeypatch) -> None:
    """渲染器升级后（`RENDER_VERSION` 涨了），旧 PDF 要**重转一次**。

    为什么必须重转：这一版开始在 PDF 里写标题书签，前端大纲视图只认书签。不重转的话
    历史文档的大纲永远是空的，用户只会觉得"功能没做"。
    为什么只转一次：转换是几秒的贵操作，每次打开都转就等于白缓存。
    """
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()
    calls: list[int] = []

    def _counted(data: bytes, suffix: str) -> tuple[bytes, int]:
        calls.append(1)
        return FAKE_PDF, 5

    monkeypatch.setattr("app.kb.routes.render_pdf", _counted)

    url = f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview"
    assert client.post(url, headers=auth_headers(owner)).json()["previewState"] == "ready"
    assert len(calls) == 1

    # 模拟"这张 PDF 是上一版渲染器产的"：把当前版本调高一位，行上存的还是旧值
    from app.kb.render import RENDER_VERSION

    monkeypatch.setattr("app.kb.routes.RENDER_VERSION", RENDER_VERSION + 1)

    # 状态接口先说 pending（前端据此再 POST 一次）
    assert client.get(url, headers=auth_headers(owner)).json()["previewState"] == "pending"
    assert client.post(url, headers=auth_headers(owner)).json()["previewState"] == "ready"
    assert len(calls) == 2

    # 重转之后又稳定了，不会每次打开都转
    client.post(url, headers=auth_headers(owner))
    assert len(calls) == 2


def test_stale_pdf_is_still_served_when_this_machine_cannot_rerender(
    client: TestClient, monkeypatch
) -> None:
    """不能重转时，老 PDF 照发 —— 别为了"新功能没数据"把已有能力关掉。

    这台机器没 Office/LibreOffice 时，版本落后导致的 pending 是个死循环：
    前端 POST → 转换器不可用 → unavailable → 用户本来能看的原文变成了"看不了"。
    """
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()

    monkeypatch.setattr("app.kb.routes.render_pdf", _fake_render())

    url = f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview"
    assert client.post(url, headers=auth_headers(owner)).json()["previewState"] == "ready"

    from app.kb.render import RENDER_VERSION

    monkeypatch.setattr("app.kb.routes.RENDER_VERSION", RENDER_VERSION + 1)
    monkeypatch.setattr("app.kb.routes.is_available", lambda: False)

    assert client.get(url, headers=auth_headers(owner)).json()["previewState"] == "ready"


def test_render_failure_is_reported_not_hidden(client: TestClient, monkeypatch) -> None:
    """转换失败：状态是 failed + Office 的原话，不能装作"还在转"。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()

    def _boom(data: bytes, suffix: str) -> tuple[bytes, int]:
        raise RenderFailed("com_error: 文件可能已经损坏")

    monkeypatch.setattr("app.kb.routes.render_pdf", _boom)

    built = client.post(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview", headers=auth_headers(owner)
    ).json()

    assert built["previewState"] == "failed"
    assert "损坏" in built["previewError"]


def test_missing_office_is_unavailable_not_failed(client: TestClient, monkeypatch) -> None:
    """没有 Office 是**能力缺失**，不是错误：前端据此退回正文，而不是让用户以为文件坏了。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()

    monkeypatch.setattr("app.kb.routes.is_available", lambda: False)

    def _never(data: bytes, suffix: str) -> tuple[bytes, int]:
        raise AssertionError("没有 Office 时不该真的去转")

    monkeypatch.setattr("app.kb.routes.render_pdf", _never)

    built = client.post(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview", headers=auth_headers(owner)
    ).json()

    assert built["previewState"] == "unavailable"
    assert "Office" in built["previewError"]


def test_legacy_document_without_original(client: TestClient) -> None:
    """早期入库的文档没有原文件 —— 明确说出来，并告诉用户怎么补救。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    # 粘贴正文这条路不经过文件上传，也就没有原文件
    doc = client.post(
        f"/api/kbs/{kb['id']}/documents",
        json={"title": "粘贴的正文", "content": "第一段\n\n第二段"},
        headers=auth_headers(owner),
    ).json()

    info = client.get(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview", headers=auth_headers(owner)
    ).json()

    assert info["previewState"] == "unavailable"
    assert "重新上传" in info["previewError"]
    assert (
        client.get(
            f"/api/kbs/{kb['id']}/documents/{doc['id']}/file", headers=auth_headers(owner)
        ).status_code
        == 404
    )


def test_preview_pdf_before_render_is_409(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()

    got = client.get(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}/preview.pdf", headers=auth_headers(owner)
    )

    assert got.status_code == 409


# —— 删除 ——


def test_purge_removes_original(client: TestClient) -> None:
    """彻底删除要把原文件一起清掉，否则「删了但还占着空间」。"""
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    doc = _upload(client, owner, kb["id"], "制度.docx", make_docx(["差旅制度"])).json()

    from sqlmodel import Session

    from app.db import engine

    with Session(engine) as session:
        assert session.get(KbFile, doc["id"]) is not None

    deleted = client.delete(
        f"/api/kbs/{kb['id']}/documents/{doc['id']}?purge=true", headers=auth_headers(owner)
    )
    assert deleted.status_code in (200, 204), deleted.text

    with Session(engine) as session:
        assert session.get(KbFile, doc["id"]) is None


def _tiny_pdf(text: str) -> bytes:
    """造一个 pypdf 能读出文本的最小 PDF（与 `test_kb_parsing.make_pdf` 同源思路）。"""
    content = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode("latin-1")
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 5 0 R"
        b"/Resources<</Font<</F1 4 0 R>>>>>>",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        b"<</Length " + str(len(content)).encode() + b">>stream\n" + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    )
    return bytes(out)


def test_parse_document_still_rejects_garbage() -> None:
    """顺带钉一下：原文件入库不影响解析入口的拒收行为。"""
    from app.kb.parsing import ParseError

    with pytest.raises(ParseError):
        parse_document("x.docx", b"not a zip")
