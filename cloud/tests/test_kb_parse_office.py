"""Office 表格 / 幻灯片解析（2026-10-25）：`.xlsx` 与 `.pptx`。

## 为什么用自建的最小 OOXML

夹具不该是二进制黑盒：坏了没人知道它"应该"长什么样。这里每个 XML 都只包含
被测代码真正会读的那几个元素，所以用例失败时能一眼看出是解析器错了还是夹具错了。

## 四条被钉住的行为

1. **按行摊平**：`单元格 | 单元格`，一行一段 —— 表格的语义就是"一条记录一行"；
2. **工作表名要跟着内容走**（靠 rels 而不是猜 `sheet1.xml` 的位置）；
3. **幻灯片按页号数字排序**（`slide10` 不能排到 `slide2` 前面）；
4. **图片走 OCR 提示**，不是一句"不支持"。
"""

from __future__ import annotations

import base64
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.kb.parsing import ParseError, parse_document
from tests.conftest import auth_headers, register

KEYWORD = "报销流程"

_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"


def _zip(members: dict[str, bytes | str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def _xlsx(sheets: dict[str, list[list[str]]]) -> bytes:
    """造一个最小工作簿：`sheets` 的 key 是工作表名，value 是每行的**共享字符串**内容。

    空格子用 `""` 表示（会被跳过）—— Excel 里空单元格本来就不写 `<c>`。
    数字格与内联字符串在 `test_xlsx_numeric_and_inline_cells` 里单独造，
    因为那是"另一种单元格类型"，混在通用构造器里会让它越来越难读。
    """
    shared: list[str] = []
    sheet_xml: list[str] = []

    for rows in sheets.values():
        row_nodes: list[str] = []
        for row_index, row in enumerate(rows, start=1):
            cells: list[str] = []
            for col_index, value in enumerate(row):
                ref = f"{chr(ord('A') + col_index)}{row_index}"
                if value == "":
                    continue
                shared.append(value)
                cells.append(f'<c r="{ref}" t="s"><v>{len(shared) - 1}</v></c>')
            row_nodes.append(f'<row r="{row_index}">{"".join(cells)}</row>')
        sheet_xml.append(
            f'<?xml version="1.0"?><worksheet xmlns="{_S}">'
            f"<sheetData>{''.join(row_nodes)}</sheetData></worksheet>"
        )

    workbook_sheets = "".join(
        f'<sheet name="{name}" sheetId="{index}" r:id="rId{index}"/>'
        for index, name in enumerate(sheets, start=1)
    )
    rels = "".join(
        f'<Relationship Id="rId{index}" Type="{_R}/worksheet" '
        f'Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, len(sheets) + 1)
    )
    shared_xml = (
        f'<?xml version="1.0"?><sst xmlns="{_S}">'
        + "".join(f"<si><t>{value}</t></si>" for value in shared)
        + "</sst>"
    )

    members: dict[str, bytes | str] = {
        "xl/workbook.xml": (
            f'<?xml version="1.0"?><workbook xmlns="{_S}" xmlns:r="{_R}">'
            f"<sheets>{workbook_sheets}</sheets></workbook>"
        ),
        "xl/_rels/workbook.xml.rels": (
            f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">{rels}</Relationships>'
        ),
        "xl/sharedStrings.xml": shared_xml,
    }
    for index, xml in enumerate(sheet_xml, start=1):
        members[f"xl/worksheets/sheet{index}.xml"] = xml
    return _zip(members)


def _pptx(slides: list[list[str]], *, filenames: list[str] | None = None) -> bytes:
    """造一份最小演示文稿。`filenames` 可覆盖 `slideN.xml` 的编号，用来验排序。"""
    members: dict[str, bytes | str] = {}
    for index, paragraphs in enumerate(slides):
        name = (filenames or [])[index] if filenames else f"slide{index + 1}.xml"
        body = "".join(f"<a:p><a:r><a:t>{text}</a:t></a:r></a:p>" for text in paragraphs)
        members[f"ppt/slides/{name}"] = (
            f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}">'
            f"<p:cSld><p:spTree><p:sp><p:txBody>{body}</p:txBody></p:sp>"
            f"</p:spTree></p:cSld></p:sld>"
        )
    return _zip(members)


# —— .xlsx ——


def test_xlsx_rows_and_sheet_names() -> None:
    data = _xlsx({"制度": [["差旅制度", "报销流程：走财务邮箱"], ["第二条", "补充说明"]]})

    parsed = parse_document("制度.xlsx", data)

    assert parsed.kind == "xlsx"
    assert "【工作表：制度】" in parsed.text
    # 一行一段、单元格用「 | 」分隔
    assert "差旅制度 | 报销流程：走财务邮箱" in parsed.text
    assert "第二条 | 补充说明" in parsed.text
    # 丢结构是真丢信息，必须说出来
    assert any("行列结构不保留" in item for item in parsed.warnings)


def test_xlsx_second_sheet_is_included_with_its_own_name() -> None:
    data = _xlsx({"制度": [["甲"]], "第二页": [["乙"]]})

    parsed = parse_document("a.xlsx", data)

    assert "【工作表：制度】" in parsed.text
    assert "【工作表：第二页】" in parsed.text


def test_xlsx_numeric_and_inline_cells() -> None:
    """非字符串格（数字 / 内联字符串）也要读得到：很多模板只有表头和编号是文本。"""
    xml = (
        f'<?xml version="1.0"?><worksheet xmlns="{_S}"><sheetData>'
        '<row r="1"><c r="A1"><v>42</v></c>'
        '<c r="B1" t="inlineStr"><is><t>内联文本</t></is></c></row>'
        "</sheetData></worksheet>"
    )
    workbook = (
        f'<?xml version="1.0"?><workbook xmlns="{_S}" xmlns:r="{_R}">'
        '<sheets><sheet name="表" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId1" Type="{_R}/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    data = _zip(
        {
            "xl/workbook.xml": workbook,
            "xl/_rels/workbook.xml.rels": rels,
            "xl/worksheets/sheet1.xml": xml,
        }
    )

    parsed = parse_document("a.xlsx", data)

    assert "42 | 内联文本" in parsed.text


def test_xlsx_empty_sheet_is_rejected() -> None:
    data = _xlsx({"空表": [[""]]})

    with pytest.raises(ParseError, match="没有可提取的内容"):
        parse_document("a.xlsx", data)


def test_xlsx_corrupt_zip_reports_format() -> None:
    with pytest.raises(ParseError, match=r"\.xlsx"):
        parse_document("a.xlsx", b"not a zip")


# —— .pptx ——


def test_pptx_slides_extracted_with_page_numbers() -> None:
    data = _pptx([["季度目标", "增长 20%"], ["预算", f"{KEYWORD}：走财务邮箱"]])

    parsed = parse_document("汇报.pptx", data)

    assert parsed.kind == "pptx"
    assert "【第 1 页】" in parsed.text and "增长 20%" in parsed.text
    assert "【第 2 页】" in parsed.text and KEYWORD in parsed.text
    assert any("备注" in item for item in parsed.warnings)


def test_pptx_slides_sorted_by_number_not_lexicographically() -> None:
    """`slide10` 字典序会排在 `slide2` 前面 —— 症状是"第 10 页内容跑到第 2 页"。"""
    data = _pptx(
        [["第一页"], ["第二页"], ["第十页"]],
        filenames=["slide1.xml", "slide2.xml", "slide10.xml"],
    )

    parsed = parse_document("a.pptx", data)

    assert parsed.text.index("【第 2 页】") < parsed.text.index("【第 3 页】")
    # 第三块必须是 slide10 的内容
    assert parsed.text.index("【第 3 页】") < parsed.text.index("第十页")


def test_pptx_without_text_is_rejected_with_hint() -> None:
    data = _pptx([[]])

    with pytest.raises(ParseError, match="没有可提取的文字"):
        parse_document("a.pptx", data)


# —— OCR / 旧版 ——


def test_image_is_rejected_with_ocr_guidance() -> None:
    """只说"不支持"等于让用户猜。要把三条可行路径写出来。"""
    with pytest.raises(ParseError) as error:
        parse_document("扫描件.png", b"\x89PNG\r\n\x1a\n")

    message = str(error.value)
    assert "OCR" in message
    assert "粘贴" in message


def test_legacy_xls_points_at_xlsx() -> None:
    with pytest.raises(ParseError) as error:
        parse_document("台账.xls", b"\xd0\xcf\x11\xe0")

    assert ".xlsx" in str(error.value)


# —— 端到端 ——


def test_upload_xlsx_is_searchable(client: TestClient) -> None:
    owner = register(client, "owner@office.example")
    org = client.post(
        "/api/orgs", json={"name": "Office Corp"}, headers=auth_headers(owner["access"])
    ).json()
    kb = client.post(
        f"/api/orgs/{org['id']}/kbs", json={"name": "制度"}, headers=auth_headers(owner["access"])
    ).json()
    payload = base64.b64encode(_xlsx({"制度": [["差旅", f"{KEYWORD}：走财务邮箱"]]})).decode()

    resp = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "制度台账.xlsx", "contentBase64": payload},
        headers=auth_headers(owner["access"]),
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "xlsx"
    assert body["title"] == "制度台账"
    assert any("行列结构" in item for item in body["warnings"])

    hits = client.post(
        f"/api/orgs/{org['id']}/search",
        json={"query": KEYWORD},
        headers=auth_headers(owner["access"]),
    ).json()
    assert [hit["docTitle"] for hit in hits] == ["制度台账"]
