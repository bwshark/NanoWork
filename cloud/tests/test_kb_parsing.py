"""文档解析与文件上传（FR-4.7 的「解析」这一步）。

这一组守的不是「能解析」，而是**失败时必须说清原因**：

- 旧版 `.doc` / 扫描件 PDF / 没装 pypdf —— 四种失败原因对用户是四句不同的话，
  压成一句「上传失败」，用户只会反复重试同一个文件。
- 解析成功但有内容被丢掉（PDF 某几页没文本层、docx 里的表格被摊平）→ 必须回
  `warnings`。静默丢内容会变成"我明明传了那份资料，它就是搜不到"。
"""

from __future__ import annotations

import base64
import importlib.util
import io
import sys
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.kb.parsing import (
    MAX_UPLOAD_BYTES,
    ParseError,
    decode_base64,
    default_title,
    parse_document,
)
from tests.conftest import auth_headers, register

HAS_PYPDF = importlib.util.find_spec("pypdf") is not None

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


# —— 测试用的真实文件构造器（不塞二进制夹具，参数一目了然）——


def make_docx(paragraphs: list[str], *, soft_break: bool = False, table: bool = False) -> bytes:
    def run(text: str) -> str:
        if soft_break and "\n" in text:
            first, second = text.split("\n", 1)
            return f"<w:r><w:t>{first}</w:t><w:br/><w:t>{second}</w:t></w:r>"
        return f"<w:r><w:t>{text}</w:t></w:r>"

    body = "".join(f"<w:p>{run(text)}</w:p>" for text in paragraphs)
    if table:
        body += (
            "<w:tbl><w:tr>"
            "<w:tc><w:p><w:r><w:t>甲列</w:t></w:r></w:p></w:tc>"
            "<w:tc><w:p><w:r><w:t>乙列</w:t></w:r></w:p></w:tc>"
            "</w:tr></w:tbl>"
        )
    xml = (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("word/document.xml", xml)
    return buffer.getvalue()


def make_pdf(text: str) -> bytes:
    """造一个最小但**结构合法**的 PDF（带 xref），pypdf 能真的取出文本。

    手写而不是塞二进制夹具：夹具坏了没人知道该长什么样；这里每个对象的用途都写在旁边。
    `text` 为空串 = 有页面但没有文本（扫描件的形态）。
    """
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


# —— 纯文本 ——


def test_plain_text_strips_bom_and_normalizes_lines() -> None:
    parsed = parse_document("制度.txt", "\ufeff第一段\r\n\r\n\r\n第二段\r\n".encode("utf-8"))
    assert parsed.kind == "text"
    # 连续空行压成一个：空行是切块的切点，多余空行只会切出碎块
    assert parsed.text == "第一段\n\n第二段"
    assert parsed.warnings == []


def test_gbk_file_is_decoded_with_a_warning() -> None:
    parsed = parse_document("gbk.txt", "报销流程：走财务邮箱。".encode("gb18030"))
    assert parsed.text == "报销流程：走财务邮箱。"
    # 解码方式是降级手段，必须告诉用户（乱码时他自己能改存 UTF-8）
    assert parsed.warnings and "GB18030" in parsed.warnings[0]


def test_empty_and_unknown_formats_are_rejected_with_reasons() -> None:
    with pytest.raises(ParseError, match="空"):
        parse_document("a.txt", b"")
    with pytest.raises(ParseError, match="不支持旧版 Office"):
        parse_document("a.doc", b"whatever")
    # 图片走**专门的 OCR 提示**（只说不支持等于让人去猜怎么办），
    # 所以"未知格式"这条要用一个真的谁都不认识的扩展名来测
    with pytest.raises(ParseError, match="不支持的格式"):
        parse_document("a.zip", b"PK\x03\x04")
    with pytest.raises(ParseError, match="OCR"):
        parse_document("a.png", b"\x89PNG")


def test_undecodable_text_is_rejected() -> None:
    with pytest.raises(ParseError, match="编码"):
        # 0xFF 0xFE 是 UTF-16LE BOM，但不是合法 UTF-8 / GB18030 文本
        parse_document("a.txt", b"\xff\xfe\x00\xd8\xff\xff")


def test_default_title_uses_filename_stem() -> None:
    assert default_title("C:\\docs\\差旅制度.docx") == "差旅制度"
    assert default_title("无扩展名") == "无扩展名"
    assert default_title(".hidden") == ".hidden"


# —— docx ——


def test_docx_paragraphs_soft_breaks_and_table_warning() -> None:
    data = make_docx(["第一段", "第二行\n第三行", "第四段"], soft_break=True, table=True)
    parsed = parse_document("制度.docx", data)

    assert parsed.kind == "docx"
    # 段落之间用空行分隔（切块按空行分段）
    assert "第一段\n\n第二行\n第三行" in parsed.text
    # 段内软换行不能被粘成一行
    assert "第二行第三行" not in parsed.text
    # 表格必须**保留结构**：摊平成段落后，「甲列」和「乙列」的对应关系就没了，
    # 而表格的全部价值就在这个对应关系上
    assert "| 甲列 | 乙列 |" in parsed.text
    assert "| --- | --- |" in parsed.text
    # 转换带来的结构损失（合并单元格）要告知
    assert any("表格" in warning for warning in parsed.warnings)


def test_docx_without_document_xml_is_rejected() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("word/other.xml", "<x/>")
    with pytest.raises(ParseError, match="缺少 word/document.xml"):
        parse_document("a.docx", buffer.getvalue())


def test_broken_zip_is_rejected() -> None:
    with pytest.raises(ParseError, match="zip"):
        parse_document("a.docx", b"not a zip at all")


# —— pdf ——


@pytest.mark.skipif(not HAS_PYPDF, reason="未安装 pypdf（可选依赖），跳过正例")
def test_pdf_text_layer_is_extracted() -> None:
    parsed = parse_document("policy.pdf", make_pdf("Reimbursement by finance mailbox"))
    assert parsed.kind == "pdf"
    assert "Reimbursement by finance mailbox" in parsed.text
    assert parsed.warnings == []


@pytest.mark.skipif(not HAS_PYPDF, reason="未安装 pypdf")
def test_pdf_without_text_layer_is_rejected_with_ocr_hint() -> None:
    # 空内容流 = 有页面但没有文本（扫描件的典型形态）
    data = make_pdf("")
    with pytest.raises(ParseError, match="OCR"):
        parse_document("scan.pdf", data)


def test_pdf_without_pypdf_gives_install_hint(monkeypatch) -> None:
    # 模拟「没装可选依赖」：`from pypdf import ...` 在 sys.modules 里为 None 时抛 ImportError
    monkeypatch.setitem(sys.modules, "pypdf", None)
    with pytest.raises(ParseError, match="pip install"):
        parse_document("a.pdf", b"%PDF-1.4\n")


# —— 上传载荷 ——


def test_decode_base64_rejects_bad_payload_and_oversize() -> None:
    """体积上限在 `decode_base64` 里有**两道**：解码前按长度估算、解码后再核一次。

    估算那道是性能优化（避免为一个 100MB 的字符串分配内存），不是正确性边界——
    所以这条用例断言的是「超限被拒」，而不是「被哪一道拒的」。两道都删掉才会红。
    """
    assert decode_base64(base64.b64encode(b"abc").decode()) == b"abc"
    with pytest.raises(ParseError, match="base64"):
        decode_base64("这不是 base64")
    huge = base64.b64encode(b"x" * (MAX_UPLOAD_BYTES + 1)).decode()
    with pytest.raises(ParseError, match="上限"):
        decode_base64(huge)


# —— 路由：上传 ——


def _org_kb(client: TestClient) -> tuple[str, str, str]:
    """返回 (token, org_id, kb_id)。"""
    owner = register(client, "up@parse.example")
    headers = auth_headers(owner["access"])
    org = client.post("/api/orgs", json={"name": "Parse Corp"}, headers=headers).json()
    kb = client.post(f"/api/orgs/{org['id']}/kbs", json={"name": "制度"}, headers=headers).json()
    return owner["access"], org["id"], kb["id"]


def _upload(client: TestClient, token: str, kb_id: str, filename: str, data: bytes, title=None):
    payload: dict = {"filename": filename, "contentBase64": base64.b64encode(data).decode()}
    if title is not None:
        payload["title"] = title
    return client.post(
        f"/api/kbs/{kb_id}/documents/file", json=payload, headers=auth_headers(token)
    )


def test_upload_docx_is_chunked_indexed_and_searchable(client: TestClient) -> None:
    token, org_id, kb_id = _org_kb(client)
    resp = _upload(client, token, kb_id, "差旅制度.docx", make_docx(["报销流程：走财务邮箱。"]))
    assert resp.status_code == 201, resp.text
    body = resp.json()

    assert body["kind"] == "docx"
    assert body["chunkCount"] >= 1
    # 默认 embedder 关着 → 不该谎报建了索引
    assert body["embedded"] == 0

    hits = client.post(
        f"/api/orgs/{org_id}/search",
        json={"query": "报销流程"},
        headers=auth_headers(token),
    ).json()
    assert [hit["docTitle"] for hit in hits] == ["差旅制度"]


def test_upload_title_defaults_to_filename_and_can_be_overridden(client: TestClient) -> None:
    token, _org_id, kb_id = _org_kb(client)

    default = _upload(client, token, kb_id, "员工手册.docx", make_docx(["第一段"])).json()
    assert default["title"] == "员工手册"

    custom = _upload(
        client, token, kb_id, "员工手册.docx", make_docx(["第二段"]), title="手册（2026 版）"
    ).json()
    assert custom["title"] == "手册（2026 版）"


def test_upload_failures_report_the_actual_reason(client: TestClient) -> None:
    token, _org_id, kb_id = _org_kb(client)

    legacy = _upload(client, token, kb_id, "旧版.doc", b"\xd0\xcf\x11\xe0")
    assert legacy.status_code == 422
    assert "另存为" in legacy.json()["detail"]

    broken = _upload(client, token, kb_id, "坏.docx", b"not a zip")
    assert broken.status_code == 422
    assert "zip" in broken.json()["detail"]

    bad_payload = client.post(
        f"/api/kbs/{kb_id}/documents/file",
        json={"filename": "a.txt", "contentBase64": "!!!not-base64!!!"},
        headers=auth_headers(token),
    )
    assert bad_payload.status_code == 422

    # 解析失败**不留半篇文档**
    docs = client.get(f"/api/kbs/{kb_id}/documents", headers=auth_headers(token)).json()
    assert docs == []


def test_upload_rejects_text_over_document_limit(client: TestClient) -> None:
    token, _org_id, kb_id = _org_kb(client)
    resp = _upload(client, token, kb_id, "超长.txt", ("报销流程" * 60_000).encode("utf-8"))
    assert resp.status_code == 422
    # 说清上限与建议，而不是一句「上传失败」
    assert "上限" in resp.json()["detail"]
    assert "拆分" in resp.json()["detail"]
