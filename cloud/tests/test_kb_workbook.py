"""`.xlsx` → 工作簿模型（表格视图的服务端一半，2026-10-27）。

## 这里守的是什么

PDF 是打印抽象，单元格选不中、列宽拖不动、公式栏和 sheet 标签都不存在。
要让前端还原这些，服务端必须交出**工作簿模型**，而它的正确性全是细节：
稀疏坐标、样式索引、行高列宽、合并、冻结、公式缓存值、日期与数字格式。
错一处不会报错，只会安静地显示成另一张表 —— 所以每条都单独钉。

## 为什么自己造 OOXML 夹具

和 `test_kb_parse_office.py` 同一条理由：二进制黑盒坏了没人知道它"应该"长什么样。
这里每份 XML 只包含被测代码真正会读的元素，失败时能一眼分清是解析器错了还是夹具错了。

## 为什么直接测 `_format_date` / `_format_numeric`

格式串是纯函数，一条用例一个字符串，失败时能直接看出是哪条规则。
走完整解析只能看到「一个格子显示不对」，定位成本高一个量级。
"""

from __future__ import annotations

import io
import zipfile

import pytest

from app.kb import workbook
from app.kb.parsing import ParseError
from app.kb.workbook import dumps_workbook, parse_workbook

_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

_STYLES = (
    f'<?xml version="1.0"?><styleSheet xmlns="{_S}">'
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    '<fills count="2"><fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    "</styleSheet>"
)


def _zip(members: dict[str, str | bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def _sst(values: list[str]) -> str:
    items = "".join(f"<si><t>{value}</t></si>" for value in values)
    return f'<?xml version="1.0"?><sst xmlns="{_S}">{items}</sst>'


def _sheet(inner: str) -> str:
    return f'<?xml version="1.0"?><worksheet xmlns="{_S}" xmlns:r="{_R}">{inner}</worksheet>'


def _book(
    sheets: list[tuple[str, str, str]],
    *,
    styles: str = _STYLES,
    shared: list[str] | None = None,
    workbook_pr: str = "",
    extra: dict[str, str | bytes] | None = None,
) -> bytes:
    """`sheets` = `[(表名, 工作表内部 XML, 可见性)]`。"""
    sheet_nodes = "".join(
        f'<sheet name="{name}" sheetId="{index}" state="{state}" r:id="rId{index}"/>'
        for index, (name, _inner, state) in enumerate(sheets, start=1)
    )
    workbook_xml = (
        f'<?xml version="1.0"?><workbook xmlns="{_S}" xmlns:r="{_R}">'
        f"{workbook_pr}<sheets>{sheet_nodes}</sheets></workbook>"
    )
    rels = "".join(
        f'<Relationship Id="rId{index}" Type="{_R}/worksheet" '
        f'Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, len(sheets) + 1)
    )
    members: dict[str, str | bytes] = {
        "xl/workbook.xml": workbook_xml,
        "xl/_rels/workbook.xml.rels": (
            f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">{rels}</Relationships>'
        ),
        "xl/styles.xml": styles,
        "xl/sharedStrings.xml": _sst(shared or []),
    }
    for index, (_name, inner, _state) in enumerate(sheets, start=1):
        members[f"xl/worksheets/sheet{index}.xml"] = _sheet(inner)
    members.update(extra or {})
    return _zip(members)


def _cells(payload: dict) -> dict[tuple[int, int], dict]:
    return {(cell["r"], cell["c"]): cell["v"] for cell in payload["sheets"][0]["celldata"]}


# —— 单元格 ——


def test_sparse_cells_are_zero_based_and_typed() -> None:
    """坐标从 0 开始；空格子不占位；共享串 / 内联串 / 数字 / 布尔 / 错误各走各的。"""
    inner = (
        '<sheetData><row r="2">'
        '<c r="B2" t="s"><v>0</v></c>'
        '<c r="D2" t="inlineStr"><is><t>内联</t></is></c>'
        '<c r="E2"><v>42</v></c>'
        '<c r="F2" t="b"><v>1</v></c>'
        '<c r="G2" t="e"><v>#DIV/0!</v></c>'
        "</row></sheetData>"
    )
    payload = parse_workbook(_book([("表", inner, "visible")], shared=["共享串"]))
    cells = _cells(payload)

    assert cells[(1, 1)]["v"] == "共享串"
    assert cells[(1, 3)]["v"] == "内联"
    assert cells[(1, 4)]["v"] == 42
    assert cells[(1, 5)]["v"] is True
    assert cells[(1, 6)]["v"] == "#DIV/0!"
    # 错误值要能一眼认出来（红字），而不是和普通文本混在一起
    assert cells[(1, 6)]["fc"] == "#d32f2f"
    assert (1, 0) not in cells
    assert (1, 2) not in cells


def test_styles_map_fonts_fills_borders_and_alignment() -> None:
    """`s` 指向 `cellXfs`；`cellStyleXfs`（命名样式基底）**不能**算进索引。

    这条守卫的是一个真实 bug：`root.iter("xf")` 会把两种 xf 一起读进来，
    于是每个 `s=` 整体错位一格 —— 日期列显示成百分比、加粗变成默认字体，
    而且不报任何错。
    """
    styles = (
        f'<?xml version="1.0"?><styleSheet xmlns="{_S}">'
        '<numFmts count="1">'
        f'<numFmt numFmtId="164" formatCode=\'yyyy"年"m"月"d"日"\'/>'
        "</numFmts>"
        '<fonts count="2">'
        '<font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><i/><u/><strike/><sz val="14"/><color rgb="FFFF0000"/>'
        '<name val="微软雅黑"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/>'
        "</patternFill></fill></fills>"
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
        '<border><left style="thin"><color rgb="FF0000FF"/></left>'
        '<right style="medium"><color rgb="FF00FF00"/></right>'
        '<bottom style="double"/><diagonal/></border></borders>'
        # 两个 cellStyleXfs：偏移 bug 存在时，cellXfs 的索引会从 2 开始
        '<cellStyleXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0">'
        '<alignment horizontal="center" vertical="top" wrapText="1"/></xf>'
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        "</cellXfs></styleSheet>"
    )
    inner = (
        '<sheetData><row r="1">'
        '<c r="A1" s="1"><v>45292</v></c>'
        '<c r="B1" s="2"><v>45292</v></c>'
        '<c r="C1"><v>1</v></c>'
        "</row></sheetData>"
    )
    payload = parse_workbook(_book([("表", inner, "visible")], styles=styles))
    cells = _cells(payload)
    styled = cells[(0, 0)]

    assert styled["m"] == "2024年1月1日"
    assert styled["bg"] == "#FFFF00"
    assert styled["fc"] == "#FF0000"
    assert styled["bl"] == styled["it"] == styled["un"] == styled["cl"] == 1
    # Excel 的 14pt 是画布上的 18.7px（96 DPI）
    assert styled["fs"] == 18.7
    assert styled["ff"] == "微软雅黑"
    assert styled["ht"] == 0  # 居中
    assert styled["vt"] == 1  # 顶对齐
    assert styled["tb"] == "2"  # 自动换行

    # 不受 cellStyleXfs 影响的证明：B1 用内置日期格式，C1 保持默认
    assert cells[(0, 1)]["m"] == "1/1/2024"
    assert cells[(0, 1)]["ct"]["t"] == "d"
    assert "bg" not in cells[(0, 2)]
    assert "bl" not in cells[(0, 2)]
    assert "fc" not in cells[(0, 2)]

    borders = payload["sheets"][0]["config"]["borderInfo"]
    sides = borders[0]["value"]
    assert sides["l"] == {"style": "1", "color": "#0000FF"}
    assert sides["r"] == {"style": "8", "color": "#00FF00"}
    assert sides["b"] == {"style": "7", "color": "#000000"}


def test_style_only_cells_are_kept() -> None:
    """整列底色是「空格子 + 填充」，丢掉它整块表就看起来没样式了。"""
    styles = (
        f'<?xml version="1.0"?><styleSheet xmlns="{_S}">'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFE3F2FD"/>'
        "</patternFill></fill></fills>"
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="0" fillId="1" borderId="0" xfId="0"/></cellXfs>'
        "</styleSheet>"
    )
    inner = '<sheetData><row r="1"><c r="A1" s="1"/></row></sheetData>'
    payload = parse_workbook(_book([("表", inner, "visible")], styles=styles))

    cell = _cells(payload)[(0, 0)]
    assert cell == {"bg": "#E3F2FD"}
    # 只有样式、没有内容的格子不计入内容单元格数
    assert payload["totalCells"] == 0


# —— 行高列宽 / 视图 ——


def test_row_column_sizes_hidden_and_full_width_default() -> None:
    """行高按 pt→px；隐藏行列记 0；「整表 16384 列」写进默认列宽而不是一万个键。"""
    inner = (
        '<sheetFormatPr defaultRowHeight="15" defaultColWidth="8.43"/>'
        "<cols>"
        '<col min="2" max="2" width="24" customWidth="1"/>'
        '<col min="4" max="4" width="10" hidden="1" customWidth="1"/>'
        '<col min="6" max="16384" width="12" customWidth="1"/>'
        "</cols>"
        '<sheetData><row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row>'
        '<row r="2" hidden="1"><c r="B2"><v>2</v></c></row></sheetData>'
    )
    sheet = parse_workbook(_book([("表", inner, "visible")]))["sheets"][0]
    config = sheet["config"]

    assert config["rowlen"][0] == 40
    assert config["rowhidden"][1] == 0
    assert config["columnlen"][1] == 173
    assert config["colhidden"][3] == 0
    assert 5 not in config["columnlen"]
    assert sheet["defaultColWidth"] == 89
    assert sheet["defaultRowHeight"] == 20


def test_frozen_panes_gridlines_and_zoom() -> None:
    """冻结的是「前两行 + 第一列」，字段是最后一个被冻结的行/列索引。"""
    inner = (
        "<sheetData/>"
        '<sheetViews><sheetView showGridLines="0" zoomScale="80">'
        '<pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/>'
        "</sheetView></sheetViews>"
    )
    sheet = parse_workbook(_book([("表", inner, "visible")]))["sheets"][0]

    assert sheet["frozen"] == {
        "type": "both",
        "range": {"row_focus": 1, "column_focus": 0},
    }
    assert sheet["showGridLines"] is False
    assert sheet["zoomRatio"] == 0.8


# —— 合并 / 公式 ——


def test_merges_add_mc_and_warn_when_covered_values_are_dropped() -> None:
    inner = (
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>被盖住</t></is></c></row></sheetData>'
        '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>'
    )
    payload = parse_workbook(_book([("表", inner, "visible")]))

    assert payload["sheets"][0]["config"]["merge"] == {"0_0": {"r": 0, "c": 0, "rs": 1, "cs": 2}}
    assert _cells(payload)[(0, 0)]["mc"]["cs"] == 2
    assert any("合并单元格" in warning for warning in payload["warnings"])


def test_formula_uses_cached_value_and_never_evaluates() -> None:
    """公式**只显示 Excel 存盘的缓存值**：自己算等于用「看起来对的错误」换正确。"""
    inner = (
        '<sheetData><row r="1">'
        '<c r="A1"><f>SUM(B1:B2)</f><v>3</v></c>'
        '<c r="B1"><f>A1*2</f></c>'
        '<c r="C1" t="str"><f>CONCAT("a","b")</f><v>ab</v></c>'
        "</row></sheetData>"
    )
    payload = parse_workbook(_book([("表", inner, "visible")]))
    cells = _cells(payload)

    assert cells[(0, 0)]["v"] == 3
    assert cells[(0, 0)]["m"] == "3"
    assert cells[(0, 0)]["f"] == "=SUM(B1:B2)"
    # 没有缓存值：原样显示公式，并明确告诉用户「未计算」
    assert cells[(0, 1)]["v"] == "=A1*2"
    assert cells[(0, 1)]["m"] == "=A1*2"
    assert cells[(0, 2)]["v"] == "ab"
    assert any("没有缓存值" in warning for warning in payload["warnings"])


# —— 工作表 ——


def test_hidden_sheets_are_skipped_with_warning() -> None:
    payload = parse_workbook(
        _book(
            [
                (
                    "可见",
                    '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>',
                    "visible",
                ),
                ("隐藏", "<sheetData/>", "hidden"),
            ]
        )
    )

    assert [sheet["name"] for sheet in payload["sheets"]] == ["可见"]
    assert any("隐藏工作表" in warning for warning in payload["warnings"])


def test_sheet_order_follows_workbook_rels_not_file_names() -> None:
    """表名与 XML 的对应关系只在 rels 里；按 `sheet1.xml` 猜顺序会把表名配错。"""
    workbook_xml = (
        f'<?xml version="1.0"?><workbook xmlns="{_S}" xmlns:r="{_R}"><sheets>'
        '<sheet name="甲" sheetId="1" r:id="rId1"/>'
        '<sheet name="乙" sheetId="2" r:id="rId2"/>'
        "</sheets></workbook>"
    )
    rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId1" Type="{_R}/worksheet" Target="worksheets/sheet2.xml"/>'
        f'<Relationship Id="rId2" Type="{_R}/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    data = _zip(
        {
            "xl/workbook.xml": workbook_xml,
            "xl/_rels/workbook.xml.rels": rels,
            "xl/styles.xml": _STYLES,
            "xl/worksheets/sheet1.xml": _sheet(
                '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>乙的内容</t></is></c>'
                "</row></sheetData>"
            ),
            "xl/worksheets/sheet2.xml": _sheet(
                '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>甲的内容</t></is></c>'
                "</row></sheetData>"
            ),
        }
    )
    payload = parse_workbook(data)

    assert [sheet["name"] for sheet in payload["sheets"]] == ["甲", "乙"]
    assert payload["sheets"][0]["celldata"][0]["v"]["v"] == "甲的内容"


# —— 超限与警告 ——


def test_cell_limit_truncates_and_says_so(monkeypatch) -> None:
    monkeypatch.setattr(workbook, "MAX_CELLS", 2)
    inner = (
        '<sheetData><row r="1">'
        '<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c>'
        "</row></sheetData>"
    )
    payload = parse_workbook(_book([("表", inner, "visible")]))

    assert len(payload["sheets"][0]["celldata"]) == 2
    assert payload["truncated"] is True
    assert any("超过 2 个单元格" in warning for warning in payload["warnings"])


def test_long_text_and_too_wide_cells_are_reported(monkeypatch) -> None:
    monkeypatch.setattr(workbook, "MAX_CELL_CHARS", 3)
    monkeypatch.setattr(workbook, "MAX_COLUMNS", 2)
    inner = (
        '<sheetData><row r="1">'
        '<c r="A1" t="inlineStr"><is><t>abcdef</t></is></c>'
        '<c r="C1"><v>9</v></c>'
        "</row></sheetData>"
    )
    payload = parse_workbook(_book([("表", inner, "visible")]))
    cells = _cells(payload)

    assert cells[(0, 0)]["m"] == "abc"
    assert (0, 2) not in cells
    warnings = " ".join(payload["warnings"])
    assert "已截断显示" in warnings
    assert "超出列上限" in warnings


def test_drawings_and_conditional_formats_say_what_is_missing() -> None:
    """图表/图片/条件格式不在表格视图里 —— 少一句话，用户会以为资料缺了一块。"""
    inner = (
        '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'
        '<conditionalFormatting sqref="A1">'
        '<cfRule type="cellIs" priority="1"/></conditionalFormatting>'
        '<drawing r:id="rId9"/>'
    )
    rels = (
        f'<?xml version="1.0"?><Relationships xmlns="{_PKG}">'
        f'<Relationship Id="rId9" Type="{_R}/drawing" Target="../drawings/drawing1.xml"/>'
        "</Relationships>"
    )
    payload = parse_workbook(
        _book(
            [("表", inner, "visible")],
            extra={"xl/worksheets/_rels/sheet1.xml.rels": rels},
        )
    )

    warnings = " ".join(payload["warnings"])
    assert "图表或图片" in warnings
    assert "条件格式" in warnings


# —— 坏文件与安全 ——


def test_dtd_and_entities_are_rejected() -> None:
    """OOXML 不需要 DTD；实体展开是 XML 侧最经典的放大攻击。"""
    data = _book([("表", "<sheetData/>", "visible")])
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    members["xl/workbook.xml"] = (
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]>'
        f'<workbook xmlns="{_S}"><sheets/></workbook>'
    )
    with pytest.raises(ParseError, match="实体"):
        parse_workbook(_zip(members))


def test_broken_zip_and_missing_parts_are_parse_errors() -> None:
    with pytest.raises(ParseError, match="zip 结构损坏"):
        parse_workbook(b"definitely not a zip")
    with pytest.raises(ParseError, match="workbook.xml"):
        parse_workbook(_zip({"xl/worksheets/sheet1.xml": _sheet("<sheetData/>")}))


def test_empty_workbook_has_nothing_to_show() -> None:
    workbook_xml = f'<?xml version="1.0"?><workbook xmlns="{_S}"><sheets/></workbook>'
    data = _zip(
        {
            "xl/workbook.xml": workbook_xml,
            "xl/styles.xml": _STYLES,
        }
    )
    with pytest.raises(ParseError, match="没有工作表"):
        parse_workbook(data)


# —— 格式串（纯函数） ——


@pytest.mark.parametrize(
    ("value", "code", "expected"),
    [
        (1234.5, "#,##0", "1,235"),
        (1234.5, "#,##0.00", "1,234.50"),
        (0.125, "0.00%", "12.50%"),
        (-1234.5, "#,##0;(#,##0)", "(1,235)"),
        (45292, "$#,##0_);($#,##0)", "$45,292 "),
        (1234.5, "[$¥-409]#,##0.00", "¥1,234.50"),
        (0.00012, "0.00E+00", "1.2000E-04"),
        (1234.5, '#,##0 "days"', "1,235 days"),
        (0, '0.00;(0.00);"-"', "-"),
    ],
)
def test_number_formats(value: float, code: str, expected: str) -> None:
    assert workbook._format_numeric(value, code) == expected


@pytest.mark.parametrize(
    ("serial", "code", "date1904", "expected"),
    [
        (45292, "yyyy/m/d", False, "2024/1/1"),
        (45292, 'yyyy"年"m"月"d"日"', False, "2024年1月1日"),
        # `yyyy/m/d h:mm:ss`：第一个 m 是月，第二个是分钟
        (45292.999999, "yyyy/m/d h:mm:ss", False, "2024/1/1 23:59:59"),
        (1 / 1440, "mm:ss", False, "01:00"),
        (0.75, "h:mm AM/PM", False, "6:00 PM"),
        # [h] 是累计小时（可超过 24），与「一天内第几小时」不是一回事
        (1.5, "[h]:mm:ss", False, "36:00:00"),
        # 1900 闰年 bug：序列 60 之后按 1899-12-30 起算才与 Excel 对齐
        (61, "yyyy/m/d", False, "1900/3/1"),
        (0, "yyyy/m/d", True, "1904/1/1"),
    ],
)
def test_date_formats(serial: float, code: str, date1904: bool, expected: str) -> None:
    assert workbook._format_date(serial, code, date1904) == expected


def test_dumps_is_stable_and_keeps_chinese() -> None:
    payload = parse_workbook(
        _book(
            [
                (
                    "表",
                    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>中文</t></is></c>'
                    "</row></sheetData>",
                    "visible",
                )
            ]
        )
    )
    raw = dumps_workbook(payload)

    assert "中文".encode() in raw
    assert raw == dumps_workbook(payload)
