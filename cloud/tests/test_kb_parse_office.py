"""Office 表格 / 幻灯片解析（2026-10-25）：`.xlsx` 与 `.pptx`。

## 为什么用自建的最小 OOXML

夹具不该是二进制黑盒：坏了没人知道它"应该"长什么样。这里每个 XML 都只包含
被测代码真正会读的那几个元素，所以用例失败时能一眼看出是解析器错了还是夹具错了。

## 四条被钉住的行为

1. **按行摊平**：`单元格 | 单元格`，一行一段 —— 表格的语义就是"一条记录一行"；
2. **工作表名要跟着内容走**（靠 rels 而不是猜 `sheet1.xml` 的位置）；
3. **幻灯片按页号数字排序**（`slide10` 不能排到 `slide2` 前面）；
4. **图片走 OCR 提示**，不是一句"不支持"。

2026-10-26 追加两条（都是「文字藏在独立部件里」）：
5. **演讲者备注与 SmartArt 的文字要取到** —— 页上只有一个壳，只遍历 `a:p` 永远读不到；
6. **幻灯片里的表格拍平了要说出来** —— 文字读到了、行列关系丢了，这种「读到了但读不懂」
   最容易被当成「读对了」。
"""

from __future__ import annotations

import base64
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.kb.chunking import chunk_text
from app.kb.parsing import ParseError, parse_document
from app.kb.tables import is_table_block
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
    # 行列结构**保住**了：第一行当表头，其余是数据行（GFM 表格必须要有表头）
    assert "| 差旅制度 | 报销流程：走财务邮箱 |" in parsed.text
    assert "| --- | --- |" in parsed.text
    assert "| 第二条 | 补充说明 |" in parsed.text
    # 「第一行当表头」是一个**假设**（台账的第一行未必是列名），必须说出来
    assert any("第一行当作表头" in item for item in parsed.warnings)


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


def test_large_xlsx_sheet_is_split_by_row_and_keeps_header() -> None:
    """超长工作表必须**按行**切、每块都带表头。

    `【工作表：X】` 和表格挤在同一个段落里时 `is_table_block` 不成立 → 切块器退化成
    按字符硬切：切口落在某一行中间，切出来的两块既不是合法 Markdown，第二块起也
    没有列名（「65 是什么」再也读不出来）。
    """
    rows = [["姓名", "年龄", "在职"]] + [[f"员工{index}", str(20 + index), "是"] for index in range(120)]
    data = _xlsx({"台账": rows})

    parsed = parse_document("台账.xlsx", data)

    table_blocks = [part for part in parsed.text.split("\n\n") if is_table_block(part)]
    assert len(table_blocks) == 1
    data_chunks = [chunk for chunk in chunk_text(parsed.text) if "员工" in chunk]
    # 确实被切开了（否则这条用例证明不了什么）
    assert len(data_chunks) > 1
    for chunk in data_chunks:
        assert "姓名" in chunk


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
    # 备注现在会被提取（见下面的备注用例），所以这份「纯文字」的稿子没有任何降级
    assert parsed.warnings == []


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


# —— pptx：哪些图该进正文（真机课件的教训）——

_EMU = 914400


def _pic_xml(
    *,
    cx: float,
    cy: float,
    descr: str | None = None,
    name: str = "picture 1",
    embed: str = "rId2",
) -> str:
    """一张图的 XML。`cx/cy` 是**页面上的显示尺寸**（英寸）—— 判背景/装饰就看它。"""
    attrs = f'name="{name}"'
    if descr is not None:
        attrs += f' descr="{descr}"'
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="2" {attrs}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="{embed}"/></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="0" y="0"/>'
        f'<a:ext cx="{int(cx * _EMU)}" cy="{int(cy * _EMU)}"/></a:xfrm></p:spPr></p:pic>'
    )


def _pptx_with_picture(*pictures: str) -> bytes:
    """一页 + 若干张图。页面按 13.33×7.5 英寸（16:9）声明，判面积要用。"""
    slide = (
        f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        "<p:cSld><p:spTree>"
        "<p:sp><p:txBody><a:p><a:r><a:t>图页</a:t></a:r></a:p></p:txBody></p:sp>"
        f"{''.join(pictures)}</p:spTree></p:cSld></p:sld>"
    )
    presentation = (
        f'<?xml version="1.0"?><p:presentation xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>'
    )
    return _zip(
        {
            "ppt/presentation.xml": presentation,
            "ppt/slides/slide1.xml": slide,
            "ppt/slides/_rels/slide1.xml.rels": _rels(
                ("rId2", f"{_R}/image", "../media/image1.png")
            ),
            "ppt/media/image1.png": b"\x89PNG\r\n\x1a\n0000",
        }
    )


def test_pptx_background_image_is_skipped() -> None:
    """铺满整页的图是**背景**，不是内容。

    真机样本：40 页培训稿里 40 张渐变背景（每页一张，13.3×7.5），逐张插进正文 =
    用户说的「上传进知识库排版都乱了」。
    """
    parsed = parse_document("汇报.pptx", _pptx_with_picture(_pic_xml(cx=13.3, cy=7.5)))

    assert parsed.images == []
    assert any("版式图片" in warning for warning in parsed.warnings)
    assert "asset-index" not in parsed.text


def test_pptx_small_decoration_is_skipped() -> None:
    """面积不足页面 15% 的点缀图形 / 分隔线 / 小图标，同样不是内容。"""
    parsed = parse_document(
        "汇报.pptx",
        _pptx_with_picture(
            _pic_xml(cx=3.6, cy=2.5),  # 约 9%
            _pic_xml(cx=5.6, cy=0.05),  # 发丝线：面积小，短边更小
        ),
    )

    assert parsed.images == []


def test_pptx_content_image_is_kept() -> None:
    """占页面 15%–80% 的是正常插图（截图、示意图），要留下。"""
    parsed = parse_document("汇报.pptx", _pptx_with_picture(_pic_xml(cx=6.0, cy=3.5)))

    assert len(parsed.images) == 1
    assert "asset-index:0" in parsed.text
    assert not any("版式图片" in warning for warning in parsed.warnings)


def test_pptx_captioned_image_is_kept_even_if_small() -> None:
    """作者**专门写了替代文字**的图不受尺寸限制：那说明他确实把这图当内容。"""
    parsed = parse_document(
        "汇报.pptx",
        _pptx_with_picture(_pic_xml(cx=3.6, cy=2.5, descr="三层架构示意图")),
    )

    assert len(parsed.images) == 1
    assert parsed.images[0].alt == "三层架构示意图"


def test_pptx_auto_picture_name_is_not_a_caption() -> None:
    """`picture 7` 是 PowerPoint 自动编号，不是图注。

    当成图注的后果：每张大图下面都显示一行「picture 7」，还进检索 —— 真机 40 页稿子
    冒出 162 行。作者手写的 `name` 仍然认。
    """
    auto = parse_document("汇报.pptx", _pptx_with_picture(_pic_xml(cx=6.0, cy=3.5)))
    assert auto.images[0].alt == ""

    named = parse_document(
        "汇报.pptx", _pptx_with_picture(_pic_xml(cx=6.0, cy=3.5, name="架构总览"))
    )
    assert named.images[0].alt == "架构总览"


def test_pptx_wingdings_bullet_is_not_text() -> None:
    """`Wingdings` 的 `l` 是 ● 这个项目符号，读成文字就是「l目前大模型存在的问题」。"""
    paragraph = (
        '<a:p><a:r><a:rPr><a:latin typeface="Wingdings"/></a:rPr><a:t>l</a:t></a:r>'
        "<a:r><a:t>目前存在的问题</a:t></a:r></a:p>"
    )
    slide = (
        f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        f"<p:cSld><p:spTree><p:sp><p:txBody>{paragraph}</p:txBody></p:sp>"
        "</p:spTree></p:cSld></p:sld>"
    )

    parsed = parse_document("汇报.pptx", _zip({"ppt/slides/slide1.xml": slide}))

    assert "目前存在的问题" in parsed.text
    assert "l目前" not in parsed.text


def test_pptx_soft_break_and_manual_spaces_between_cjk_are_dropped() -> None:
    """中文之间的换行/空格要删：作者拿它当手动换行，留着会把「称为」拆成两个词。"""
    paragraph = (
        "<a:p><a:r><a:t>这种现象被称</a:t></a:r>"
        "<a:r><a:t>  </a:t></a:r>"  # 整段都是空格的小 run
        "<a:r><a:t>为“幻觉”</a:t></a:r>"
        "<a:br/>"
        "<a:r><a:t>这很常见</a:t></a:r></a:p>"
    )
    slide = (
        f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        f"<p:cSld><p:spTree><p:sp><p:txBody>{paragraph}</p:txBody></p:sp>"
        "</p:spTree></p:cSld></p:sld>"
    )

    parsed = parse_document("汇报.pptx", _zip({"ppt/slides/slide1.xml": slide}))

    assert "这种现象被称为“幻觉”这很常见" in parsed.text


def test_pptx_image_with_parent_segment_is_resolved() -> None:
    """幻灯片图片的来源永远是 `Target="../media/image1.png"`（相对 `ppt/slides/`）。

    把 `../` 三个字符剪掉会得到 `media/image1.png`，而 zip 里的真实路径是
    `ppt/media/image1.png` —— 于是每张幻灯片图片都「在压缩包里找不到」而被静默跳过：
    正文里有占位、库里却没有这张图，而**没有任何报错**。
    """
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    slide = (
        f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        "<p:cSld><p:spTree><p:pic>"
        '<p:nvPicPr><p:cNvPr id="2" name="图 1" descr="流程图"/></p:nvPicPr>'
        '<p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/>'
        "</p:pic></p:spTree></p:cSld></p:sld>"
    )
    rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId2" Type="{_R}/image" Target="../media/image1.png"/>'
        "</Relationships>"
    )
    data = _zip(
        {
            "ppt/slides/slide1.xml": slide,
            "ppt/slides/_rels/slide1.xml.rels": rels,
            "ppt/media/image1.png": png,
        }
    )

    parsed = parse_document("汇报.pptx", data)

    assert len(parsed.images) == 1
    assert parsed.images[0].alt == "流程图"
    assert parsed.images[0].data == png
    assert "asset-index:0" in parsed.text


#: 备注 / SmartArt 的关系类型。「文字藏在独立部件里」的两条路，都靠 Type 找。
_NOTES_REL = f"{_R}/notesSlide"
_DIAGRAM_REL = f"{_R}/diagramData"


def _rels(*items: tuple[str, str, str]) -> str:
    """`(Id, Type, Target)` → `.rels` 内容。"""
    body = "".join(
        f'<Relationship Id="{rel_id}" Type="{rel_type}" Target="{target}"/>'
        for rel_id, rel_type, target in items
    )
    return f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">{body}</Relationships>'


def _slide_xml(texts: list[str], extra: str = "") -> str:
    body = "".join(f"<a:p><a:r><a:t>{text}</a:t></a:r></a:p>" for text in texts)
    return (
        f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        f"<p:cSld><p:spTree><p:sp><p:txBody>{body}</p:txBody></p:sp>{extra}"
        "</p:spTree></p:cSld></p:sld>"
    )


def _notes_xml(texts: list[str], *, number: str = "7") -> str:
    """备注页：正文占位 + 缩略图占位 + 页码占位（后两个**不该**被读进来）。"""
    body = "".join(f"<a:p><a:r><a:t>{text}</a:t></a:r></a:p>" for text in texts)
    return (
        f'<?xml version="1.0"?><p:notes xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        "<p:cSld><p:spTree>"
        '<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr></p:sp>'
        '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
        f"<p:txBody>{body}</p:txBody></p:sp>"
        '<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="3"/></p:nvPr></p:nvSpPr>'
        f'<p:txBody><a:p><a:fld id="{{X}}" type="slidenum"><a:t>{number}</a:t></a:fld></a:p>'
        "</p:txBody></p:sp>"
        "</p:spTree></p:cSld></p:notes>"
    )


def _diagram_xml(labels: list[str]) -> str:
    """SmartArt 的数据模型（`ppt/diagrams/dataN.xml`）。"""
    points = "".join(
        f'<dgm:pt modelId="{index}"><dgm:t><a:p><a:r><a:t>{label}</a:t></a:r></a:p></dgm:t>'
        "</dgm:pt>"
        for index, label in enumerate(labels)
    )
    return (
        f'<?xml version="1.0"?>'
        f'<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" '
        f'xmlns:a="{_A}"><dgm:ptLst>{points}</dgm:ptLst></dgm:dataModel>'
    )


def test_pptx_notes_are_extracted() -> None:
    """演讲者备注是**独立部件**：页上没有任何文字引用它，只遍历 `a:p` 永远读不到。

    而它常常是整页最完整的说明（讲稿），对知识库的价值比幻灯片上那几个短句高。
    """
    data = _zip(
        {
            "ppt/slides/slide1.xml": _slide_xml(["季度目标"]),
            "ppt/slides/_rels/slide1.xml.rels": _rels(
                ("rId5", _NOTES_REL, "../notesSlides/notesSlide1.xml")
            ),
            "ppt/notesSlides/notesSlide1.xml": _notes_xml(
                ["这一页的重点是回款口径", "Q3 再核对一次"]
            ),
        }
    )

    parsed = parse_document("汇报.pptx", data)

    assert "【第 1 页 · 演讲者备注】" in parsed.text
    assert "这一页的重点是回款口径" in parsed.text
    assert "Q3 再核对一次" in parsed.text
    # 页码占位符（是 `<a:fld>` 拼出来的）不能混进备注里
    assert not any(line.strip() == "7" for line in parsed.text.splitlines())
    # 备注是**正常内容**，不是降级：不该出现 warning
    assert parsed.warnings == []


def test_pptx_notes_duplicating_slide_text_are_dropped() -> None:
    """讲稿常常就是正文的复制：同一句入两遍，同一页会在检索里出现两条几乎一样的片段。"""
    data = _zip(
        {
            "ppt/slides/slide1.xml": _slide_xml(["季度目标", "增长 20%"]),
            "ppt/slides/_rels/slide1.xml.rels": _rels(
                ("rId5", _NOTES_REL, "../notesSlides/notesSlide1.xml")
            ),
            "ppt/notesSlides/notesSlide1.xml": _notes_xml(["季度目标", "这里补充一下口径"]),
        }
    )

    parsed = parse_document("汇报.pptx", data)

    notes = parsed.text.split("【第 1 页 · 演讲者备注】")[1]
    assert "这里补充一下口径" in notes
    # 与正文重复的那一行不重复入库
    assert "季度目标" not in notes


def test_pptx_smartart_text_is_extracted_and_deduped() -> None:
    """SmartArt 的文字在 `dataN.xml`；同一标签在数据模型里会出现多次，连续重复只留一次。"""
    data = _zip(
        {
            "ppt/slides/slide1.xml": _slide_xml(["上线流程"], extra="<p:graphicFrame/>"),
            "ppt/slides/_rels/slide1.xml.rels": _rels(
                ("rId6", _DIAGRAM_REL, "../diagrams/data1.xml")
            ),
            "ppt/diagrams/data1.xml": _diagram_xml(["立项", "立项", "评审", "上线"]),
        }
    )

    parsed = parse_document("流程.pptx", data)

    assert "【第 1 页 · 图示文字】" in parsed.text
    labels = parsed.text.split("【第 1 页 · 图示文字】")[1]
    assert labels.count("立项") == 1
    assert "评审" in labels


def test_pptx_table_becomes_gfm_table() -> None:
    """幻灯片里的表格要保留行列关系，而不是拍平成一行一段的字。

    `| 季度 | 收入 |` 拍平之后，「收入」这一列对应哪个季度就彻底丢了 ——
    和 `.docx` 的表格是同一件事。
    """
    table = (
        "<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>"
        "<a:tc><a:txBody><a:p><a:r><a:t>季度</a:t></a:r></a:p></a:txBody></a:tc>"
        "<a:tc><a:txBody><a:p><a:r><a:t>收入</a:t></a:r></a:p></a:txBody></a:tc>"
        "</a:tr><a:tr>"
        "<a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc>"
        "<a:tc><a:txBody><a:p><a:r><a:t>300</a:t></a:r></a:p></a:txBody></a:tc>"
        "</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>"
    )
    data = _zip({"ppt/slides/slide1.xml": _slide_xml(["经营数据"], extra=table)})

    parsed = parse_document("汇报.pptx", data)

    table_block = next(part for part in parsed.text.split("\n\n") if "| 季度 |" in part)
    # 标题**单独一段**：和表格挤在同一段落里，`is_table_block` 就不成立了
    assert "【第 1 页 · 表格】" in parsed.text
    assert is_table_block(table_block)
    assert "| --- | --- |" in table_block
    assert "| Q1 | 300 |" in table_block
    # 单元格的字不能同时留在「拍平的正文」里（否则同一批字入两遍）
    body = parsed.text.split("【第 1 页】")[1].split("【第 1 页 · 表格】")[0]
    assert "Q1" not in body
    # 转成真表格之后就不再是「读到了但读不懂」
    assert not any("拍平" in item for item in parsed.warnings)


def test_pptx_merged_cells_keep_grid_and_are_reported() -> None:
    """合并单元格：内容在左上角那一格，被合并掉的格留空位（不然后面的列左移）。"""
    table = (
        "<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>"
        '<a:tc gridSpan="2"><a:txBody><a:p><a:r><a:t>合计</a:t></a:r></a:p></a:txBody></a:tc>'
        '<a:tc hMerge="1"><a:txBody><a:p/></a:txBody></a:tc>'
        "</a:tr><a:tr>"
        "<a:tc><a:txBody><a:p><a:r><a:t>甲</a:t></a:r></a:p></a:txBody></a:tc>"
        "<a:tc><a:txBody><a:p><a:r><a:t>乙</a:t></a:r></a:p></a:txBody></a:tc>"
        "</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>"
    )
    data = _zip({"ppt/slides/slide1.xml": _slide_xml(["合并示例"], extra=table)})

    parsed = parse_document("汇报.pptx", data)

    table_block = next(part for part in parsed.text.split("\n\n") if "| 合计 |" in part)
    # 被合并掉的格留空位 → 两行都是 2 列
    assert "| 合计 |  |" in table_block
    assert "| 甲 | 乙 |" in table_block
    assert any("合并单元格" in item for item in parsed.warnings)


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
    assert any("第一行当作表头" in item for item in body["warnings"])

    hits = client.post(
        f"/api/orgs/{org['id']}/search",
        json={"query": KEYWORD},
        headers=auth_headers(owner["access"]),
    ).json()
    assert [hit["docTitle"] for hit in hits] == ["制度台账"]


def test_upload_pptx_notes_are_searchable(client: TestClient) -> None:
    """端到端：一句话只写在**备注**里，也要能从知识库搜到。

    这是「备注真的入库了」的判据 —— 解析层断言「字符串里有」只能证明读到了，
    搜得到才证明它经过了切块、投影与索引。
    """
    owner = register(client, "owner@notes.example")
    org = client.post(
        "/api/orgs", json={"name": "Notes Corp"}, headers=auth_headers(owner["access"])
    ).json()
    kb = client.post(
        f"/api/orgs/{org['id']}/kbs", json={"name": "汇报"}, headers=auth_headers(owner["access"])
    ).json()
    data = _zip(
        {
            "ppt/slides/slide1.xml": _slide_xml(["季度回顾"]),
            "ppt/slides/_rels/slide1.xml.rels": _rels(
                ("rId5", _NOTES_REL, "../notesSlides/notesSlide1.xml")
            ),
            "ppt/notesSlides/notesSlide1.xml": _notes_xml(["回款口径在附件里，问财务要表"]),
        }
    )
    payload = base64.b64encode(data).decode()

    resp = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "季度汇报.pptx", "contentBase64": payload},
        headers=auth_headers(owner["access"]),
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["warnings"] == []

    hits = client.post(
        f"/api/orgs/{org['id']}/search",
        json={"query": "回款口径"},
        headers=auth_headers(owner["access"]),
    ).json()
    assert [hit["docTitle"] for hit in hits] == ["季度汇报"]
