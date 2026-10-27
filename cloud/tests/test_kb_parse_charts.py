"""图表数值抽取（2026-10-26）：`pptx` / `xlsx` 里 `<c:v>` 的缓存序列 → 表格。

## 这一组守的是什么

图表里那堆数字**只在缓存里**（`c:numCache` / `c:strCache`），没有别的地方可读。
所以用例必须钉住三件事：

1. **抽得出来**：系列名、类别名、数值都要落到 GFM 表格里（表头 + 数据行）；
2. **能被检索**：投影之后 `收入: 300` 这种「列名 + 值」的组合必须出现
   —— 否则表格只是「看着有」，搜的时候一个字都命中不了；
3. **抽不出来时要说人话**：没有缓存的图表回一条可操作的提示，而不是塞一张空表。

夹具是自建的最小 OOXML（与 `test_kb_parse_office.py` 同一套理由）：失败时能一眼
看出是解析器错了还是夹具错了。
"""

from __future__ import annotations

import base64
import io
import zipfile

from fastapi.testclient import TestClient

from app.kb.charts import MAX_CHART_POINTS, parse_chart
from app.kb.chunking import chunk_text, retrieval_text
from app.kb.parsing import parse_document
from app.kb.tables import is_table_block
from tests.conftest import auth_headers
from tests.test_kb_documents import _kb, _org

_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_C = "http://schemas.openxmlformats.org/drawingml/2006/chart"

#: 图表关系的 Type。**按 Type 过滤**是这段代码的关键（Target 里未必带 charts）。
_CHART_REL = f"{_R}/chart"
_DRAWING_REL = f"{_R}/drawing"


def _zip(members: dict[str, bytes | str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def _series(name: str, categories: list[str], values: list[str], literal_name: bool = False) -> str:
    """一个 `<c:ser>`：类别是字符串缓存，数值是数字缓存（与 Office 实际写法一致）。"""
    cats = "".join(
        f'<c:pt idx="{index}"><c:v>{text}</c:v></c:pt>' for index, text in enumerate(categories)
    )
    nums = "".join(
        f'<c:pt idx="{index}"><c:v>{text}</c:v></c:pt>' for index, text in enumerate(values)
    )
    if literal_name:
        name_node = f"<c:tx><c:v>{name}</c:v></c:tx>"
    else:
        name_node = (
            "<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache>"
            f'<c:ptCount val="1"/><c:pt idx="0"><c:v>{name}</c:v></c:pt>'
            "</c:strCache></c:strRef></c:tx>"
        )
    return (
        f'<c:ser><c:idx val="0"/><c:order val="0"/>{name_node}'
        f"<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache>"
        f'<c:ptCount val="{len(categories)}"/>{cats}</c:strCache></c:strRef></c:cat>'
        f"<c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache>"
        f'<c:formatCode>General</c:formatCode><c:ptCount val="{len(values)}"/>{nums}'
        "</c:numCache></c:numRef></c:val></c:ser>"
    )


def _chart(
    title: str,
    series: list[str],
    *,
    chart_type: str = "barChart",
    axis_title: str = "",
) -> str:
    """一份最小 `chartN.xml`。

    `axis_title` 专门用来验「别把坐标轴标题当成图表标题」—— 两者都用 `<c:title>`。
    """
    title_node = (
        f"<c:title><c:tx><c:rich><a:p><a:r><a:t>{title}</a:t></a:r></a:p></c:rich></c:tx>"
        '<c:overlay val="0"/></c:title>'
        if title
        else ""
    )
    axis = (
        f"<c:catAx><c:title><c:tx><c:rich><a:p><a:r><a:t>{axis_title}</a:t></a:r></a:p>"
        "</c:rich></c:tx></c:title></c:catAx>"
        if axis_title
        else ""
    )
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<c:chartSpace xmlns:c="{_C}" xmlns:a="{_A}"><c:chart>{title_node}'
        f"<c:plotArea><c:{chart_type}>{''.join(series)}</c:{chart_type}>{axis}</c:plotArea>"
        "</c:chart></c:chartSpace>"
    )


def _pptx_with_chart(chart_xml: str, *, text: list[str] | None = None) -> bytes:
    body = "".join(f"<a:p><a:r><a:t>{line}</a:t></a:r></a:p>" for line in (text or ["季度回顾"]))
    slide = (
        f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}" xmlns:r="{_R}">'
        f"<p:cSld><p:spTree><p:sp><p:txBody>{body}</p:txBody></p:sp>"
        '<p:graphicFrame><a:graphic><a:graphicData><c:chart xmlns:c="'
        f'{_C}" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>'
        "</p:spTree></p:cSld></p:sld>"
    )
    rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId9" Type="{_CHART_REL}" Target="../charts/chart1.xml"/>'
        "</Relationships>"
    )
    return _zip(
        {
            "ppt/slides/slide1.xml": slide,
            "ppt/slides/_rels/slide1.xml.rels": rels,
            "ppt/charts/chart1.xml": chart_xml,
        }
    )


# —— 纯函数：chart XML → 表 ——


def test_chart_series_categories_and_values() -> None:
    data = _chart(
        "季度销售",
        [_series("收入", ["Q1", "Q2", "Q3"], ["100", "150", "300"])],
    ).encode()

    chart = parse_chart(data)

    assert chart is not None
    assert chart.title == "季度销售"
    assert chart.table() == [
        ["类别", "收入"],
        ["Q1", "100"],
        ["Q2", "150"],
        ["Q3", "300"],
    ]
    # 摘要里带系列名与数值范围：「这个图讲什么」比「300 是哪个数」更常被搜
    summary = chart.summary()
    assert "1 个系列（收入）" in summary
    assert "收入 100–300" in summary


def test_chart_axis_title_is_not_mistaken_for_chart_title() -> None:
    """坐标轴标题也叫 `<c:title>`：用 `.//` 找标题会拿到「月份」。"""
    data = _chart(
        "",
        [_series("收入", ["Q1"], ["100"])],
        axis_title="月份",
    ).encode()

    chart = parse_chart(data)

    assert chart is not None
    assert chart.title == ""


def test_chart_without_cached_values_is_none() -> None:
    """只有 `<c:ser>`、没有 `<c:pt>` 的图表（从没在 Office 里渲染过）→ 抽不出来。"""
    empty = (
        f'<?xml version="1.0"?><c:chartSpace xmlns:c="{_C}" xmlns:a="{_A}">'
        "<c:chart><c:plotArea><c:barChart>"
        '<c:ser><c:idx val="0"/><c:tx><c:v>收入</c:v></c:tx></c:ser>'
        "</c:barChart></c:plotArea></c:chart></c:chartSpace>"
    ).encode()

    assert parse_chart(empty) is None


def test_chart_literal_series_name_and_missing_points() -> None:
    """系列名可以是字面量（`<c:tx><c:v>`）；空格子在 XML 里直接缺失 → 补空串不补 0。"""
    xml = (
        f'<?xml version="1.0"?><c:chartSpace xmlns:c="{_C}" xmlns:a="{_A}"><c:chart>'
        "<c:plotArea><c:lineChart>"
        '<c:ser><c:idx val="0"/><c:tx><c:v>毛利</c:v></c:tx>'
        "<c:cat><c:strRef><c:strCache>"
        '<c:pt idx="0"><c:v>一月</c:v></c:pt><c:pt idx="1"><c:v>二月</c:v></c:pt>'
        "</c:strCache></c:strRef></c:cat>"
        "<c:val><c:numRef><c:numCache>"
        '<c:pt idx="0"><c:v>12.5</c:v></c:pt>'
        "</c:numCache></c:numRef></c:val></c:ser>"
        "</c:lineChart></c:plotArea></c:chart></c:chartSpace>"
    ).encode()

    chart = parse_chart(xml)

    assert chart is not None
    assert chart.table() == [["类别", "毛利"], ["一月", "12.5"], ["二月", ""]]


def test_chart_points_are_capped() -> None:
    """几万个点的监控表不该整张进库（切块会超限，检索也只剩噪声）。"""
    many = [str(index) for index in range(MAX_CHART_POINTS + 20)]
    data = _chart("日粒度", [_series("请求数", many, many)]).encode()

    chart = parse_chart(data)

    assert chart is not None
    assert len(chart.indexes) == MAX_CHART_POINTS
    assert chart.truncated
    assert "数据点过多" in chart.summary()


# —— 端到端：pptx ——


def test_pptx_chart_becomes_table_and_summary() -> None:
    data = _pptx_with_chart(
        _chart(
            "季度销售",
            [
                _series("收入", ["Q1", "Q2"], ["100", "300"]),
                _series("成本", ["Q1", "Q2"], ["60", "180"]),
            ],
        )
    )

    parsed = parse_document("汇报.pptx", data)

    assert parsed.kind == "pptx"
    # 标题 + 摘要单独成段（表格的第一行必须是表头，标题插不进去）
    assert "【第 1 页 · 图表：季度销售】" in parsed.text
    assert "2 个系列（收入、成本）" in parsed.text
    # 表格必须是**自己一段**，否则 `is_table_block` 认不出来
    table_blocks = [part for part in parsed.text.split("\n\n") if is_table_block(part)]
    assert len(table_blocks) == 1
    assert "| 类别 | 收入 | 成本 |" in table_blocks[0]
    assert "| Q1 | 100 | 60 |" in table_blocks[0]
    assert any("图表" in item for item in parsed.warnings)


def test_pptx_chart_values_are_searchable() -> None:
    """「列名 + 值」必须在检索投影里出现 —— 否则表格只是看着有。"""
    data = _pptx_with_chart(_chart("季度销售", [_series("收入", ["Q1"], ["300"])]))

    parsed = parse_document("汇报.pptx", data)
    projected = [retrieval_text(chunk) for chunk in chunk_text(parsed.text) if "收入" in chunk]

    assert any("收入: 300" in text for text in projected), projected


def test_pptx_chart_without_cache_is_reported() -> None:
    empty = (
        f'<?xml version="1.0"?><c:chartSpace xmlns:c="{_C}" xmlns:a="{_A}">'
        "<c:chart><c:plotArea><c:barChart>"
        '<c:ser><c:idx val="0"/><c:tx><c:v>收入</c:v></c:tx></c:ser>'
        "</c:barChart></c:plotArea></c:chart></c:chartSpace>"
    )
    data = _pptx_with_chart(empty)

    parsed = parse_document("汇报.pptx", data)

    assert "图表" not in parsed.text
    assert any("没有可提取的数值" in item for item in parsed.warnings)


# —— 端到端：xlsx（工作表 → 绘图 → 图表 两跳）——


def _xlsx_with_chart(chart_xml: str) -> bytes:
    sheet = (
        f'<?xml version="1.0"?><worksheet xmlns="{_S}"><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>季度</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>收入</t></is></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"><v>300</v></c></row>'
        "</sheetData></worksheet>"
    )
    workbook = (
        f'<?xml version="1.0"?><workbook xmlns="{_S}" xmlns:r="{_R}">'
        '<sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    workbook_rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId1" Type="{_R}/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    # 工作表 → 绘图：Office 写的是绝对路径（`/xl/drawings/drawing1.xml`）
    sheet_rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId1" Type="{_DRAWING_REL}" Target="../drawings/drawing1.xml"/>'
        "</Relationships>"
    )
    drawing = (
        '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/'
        'drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor/></xdr:wsDr>'
    )
    drawing_rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId2" Type="{_CHART_REL}" Target="../charts/chart1.xml"/>'
        "</Relationships>"
    )
    return _zip(
        {
            "xl/workbook.xml": workbook,
            "xl/_rels/workbook.xml.rels": workbook_rels,
            "xl/worksheets/sheet1.xml": sheet,
            "xl/worksheets/_rels/sheet1.xml.rels": sheet_rels,
            "xl/drawings/drawing1.xml": drawing,
            "xl/drawings/_rels/drawing1.xml.rels": drawing_rels,
            "xl/charts/chart1.xml": chart_xml,
        }
    )


def test_xlsx_chart_is_found_through_drawing_relationship() -> None:
    data = _xlsx_with_chart(_chart("月度收入", [_series("收入", ["Q1", "Q2"], ["300", "400"])]))

    parsed = parse_document("台账.xlsx", data)

    assert "【工作表「销售」图表：月度收入】" in parsed.text
    assert "| Q1 | 300 |" in parsed.text
    assert "| Q2 | 400 |" in parsed.text


def test_xlsx_keeps_sheet_table_when_chart_is_present() -> None:
    """图表块不该顶掉工作表本身的表格（两块要并存）。"""
    data = _xlsx_with_chart(_chart("月度收入", [_series("收入", ["Q1"], ["300"])]))

    parsed = parse_document("台账.xlsx", data)

    assert "图表" in parsed.text
    assert any("第一行当作表头" in item for item in parsed.warnings)


# —— 判重：图表照抄单元格时不要入两遍 ——


def test_is_covered_by_needs_every_value_and_the_series_name() -> None:
    """判据是「系列名 + 每个数值都出现过」；缺一个就不算重复（那份表就是唯一来源）。"""
    chart = parse_chart(
        _chart("季度销售", [_series("收入", ["Q1", "Q2"], ["100", "300"])]).encode()
    )

    assert chart is not None
    assert chart.is_covered_by({"收入", "100", "300"}) is True
    assert chart.is_covered_by({"收入", "100", "300", "别的单元格"}) is True
    assert chart.is_covered_by({"收入", "100"}) is False  # 少一个数
    assert chart.is_covered_by({"100", "300"}) is False  # 系列名不在
    assert chart.is_covered_by(set()) is False  # 没有可比的东西 → 宁可重复


def test_xlsx_chart_that_copies_cells_keeps_only_summary() -> None:
    """`.xlsx` 的图表没有自己的数据源，数值必然也在单元格里 → 只留标题与摘要。

    入两遍的后果不是「多占点空间」，而是检索结果里出现两条几乎一样的片段
    （用户以为库里有两份资料），而且 top-k 名额被自己挤掉。
    """
    # 夹具里单元格有「收入」和「300」，图表的点也是这两样
    data = _xlsx_with_chart(_chart("月度收入", [_series("收入", ["Q1"], ["300"])]))

    parsed = parse_document("台账.xlsx", data)

    # 摘要留着（标题与系列名是单元格里没有的检索信号）
    assert "【工作表「销售」图表：月度收入】" in parsed.text
    # 但数值表格不再来一遍
    assert "| 类别 | 收入 |" not in parsed.text
    assert any("与单元格内容重复" in item for item in parsed.warnings)


def test_xlsx_chart_with_values_missing_from_cells_keeps_its_table() -> None:
    """源数据被删掉（只剩图表缓存）时，那张表就是**唯一**能读到这些数的地方。"""
    data = _xlsx_with_chart(_chart("月度收入", [_series("收入", ["Q1"], ["300", "999"])]))

    parsed = parse_document("台账.xlsx", data)

    assert "| 类别 | 收入 |" in parsed.text
    assert not any("与单元格内容重复" in item for item in parsed.warnings)


def test_pptx_chart_never_deduped() -> None:
    """幻灯片的图表缓存是**唯一的**数据来源（幻灯片里没有单元格）→ 永远出表格。"""
    data = _pptx_with_chart(_chart("季度销售", [_series("收入", ["Q1"], ["300"])]), text=["300"])

    parsed = parse_document("汇报.pptx", data)

    assert "| 类别 | 收入 |" in parsed.text
    assert not any("与单元格内容重复" in item for item in parsed.warnings)


# —— 端到端：上传后能被检索到（这才是「检索文本」的判据）——


def test_uploaded_pptx_chart_is_searchable(client: TestClient) -> None:
    owner, _member, org_id = _org(client)
    kb = _kb(client, owner, org_id)
    data = _pptx_with_chart(
        _chart("季度销售", [_series("华东区回款", ["Q1", "Q2"], ["100", "300"])])
    )
    payload = base64.b64encode(data).decode()

    resp = client.post(
        f"/api/kbs/{kb['id']}/documents/file",
        json={"filename": "季度汇报.pptx", "contentBase64": payload},
        headers=auth_headers(owner),
    )

    assert resp.status_code == 201, resp.text
    # 搜「回款」：它只出现在**系列名**里（幻灯片正文里没有这两个字）
    hits = client.post(
        f"/api/orgs/{org_id}/search",
        json={"query": "回款"},
        headers=auth_headers(owner),
    ).json()
    assert [hit["docTitle"] for hit in hits] == ["季度汇报"]
    # 命中的片段要能看出「哪个类别、多少钱」（snippet 是块原文，所以是表格形态）
    assert any(
        "华东区回款" in hit["snippet"] and "| Q2 | 300 |" in hit["snippet"] for hit in hits
    ), hits
