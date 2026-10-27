"""`.xlsx` → 工作簿模型（「表格视图」的服务端一半）。

## 为什么不是再产出一份 PDF

PDF 是**打印**抽象：分页、纸张、固定排版。它能让人「看到这张表长什么样」，
但单元格选不中、列宽拖不动、公式栏和 sheet 标签都不存在 —— 而这些正是用户在
电子表格里最先要找的东西。要还原它们，前端需要的不是像素，而是**工作簿模型**：
工作表、单元格、样式、合并、行高列宽、冻结、公式与缓存值。

## 为什么用标准库自己解，不引 openpyxl

`.xlsx` 就是一个 zip + 几份 OOXML，本仓的 `parsing.py` 已经用同一套办法把表格
读成检索文本了。这里多读的是 `styles.xml` / `workbook.xml` 的属性（行高列宽、
合并、冻结），仍然是 `zipfile + ElementTree` 的范围。少一个运行时依赖，
换来的代价只是多写几百行 —— 而这个解析器的输出**必须**可控（见下面几条边界）。

## 五条边界（都是「不说清楚就会骗人」的地方）

1. **绝不计算公式**。只显示 Excel 存盘时写下的缓存值；没有缓存就原样显示公式并
   标记「未计算」。自己实现一个公式引擎，等于把「看得见的正确」换成
   「看起来像对的错误」。
2. **不支持的排版要报出来**，不能静默丢：图表、图片、条件格式、数据透视表都在
   表格视图之外（打印版式里还能看到）。少一句话，用户就会以为资料缺了一块。
3. **超限要说明**。单篇最多 `MAX_CELLS` 个单元格、单格最多 `MAX_CELL_CHARS` 字；
   超了如实告诉用户「只显示了前 N 个」，而不是悄悄截断。
4. **不接受 DTD / 实体**。OOXML 不需要它们，而实体展开是 XML 侧最经典的放大攻击。
5. **输出有体积上限**。样式正确的代价是 JSON 变大；超过 `MAX_JSON_BYTES` 时明确
   失败并建议看打印版式，而不是把一个几十 MB 的响应塞给浏览器。
"""

from __future__ import annotations

import colorsys
import io
import json
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from app.kb.parsing import ParseError, _read_zip_member

#: 解析结果版本。**改了模型或样式映射就 +1**：客户端/旧行会按「需要重建」处理。
PARSER_VERSION = 1

#: 只有这一种后缀进入表格视图（`.xls` 在入库时就被拒了，见 `parsing.py`）。
XLSX_SUFFIX = ".xlsx"

#: 单篇文档最多保留多少个单元格（含只有样式的空单元格）。
MAX_CELLS = 50_000
#: 单个单元格文本上限。超出的多半是「把一整篇文章塞进一个格子」，表格视图不是它的读者。
MAX_CELL_CHARS = 1_000
#: 单张工作表的最大行/列。Excel 自身的上限是 1048576 × 16384，但那个量级既传不动也渲染不动。
MAX_ROWS = 20_000
MAX_COLUMNS = 256
#: 最多显示多少张工作表。
MAX_SHEETS = 20
#: 带边框的单元格上限（borderInfo 是最占体积的一块）。
MAX_BORDER_CELLS = 20_000
#: 序列化后的 JSON 上限。
MAX_JSON_BYTES = 16 * 1024 * 1024

_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

#: Excel 的内置数字格式。未列出的 id 按 General 处理（读不出来也不能崩）。
_BUILTIN_FORMATS: dict[int, str] = {
    0: "General",
    1: "0",
    2: "0.00",
    3: "#,##0",
    4: "#,##0.00",
    5: "$#,##0_);($#,##0)",
    6: "$#,##0_);[Red]($#,##0)",
    7: "$#,##0.00_);($#,##0.00)",
    8: "$#,##0.00_);[Red]($#,##0.00)",
    9: "0%",
    10: "0.00%",
    11: "0.00E+00",
    12: "# ?/?",
    13: "# ??/??",
    14: "m/d/yy",
    15: "d-mmm-yy",
    16: "d-mmm",
    17: "mmm-yy",
    18: "h:mm AM/PM",
    19: "h:mm:ss AM/PM",
    20: "h:mm",
    21: "h:mm:ss",
    22: "m/d/yy h:mm",
    27: "yyyy/m/d",
    28: "yyyy/m/d",
    29: "yyyy/m/d",
    30: "m/d/yy",
    31: "yyyy/m/d",
    32: "h:mm:ss",
    33: "h:mm:ss",
    34: "yyyy/m/d",
    35: "yyyy/m/d",
    36: "yyyy/m/d",
    37: "#,##0 ;(#,##0)",
    38: "#,##0 ;[Red](#,##0)",
    39: "#,##0.00;(#,##0.00)",
    40: "#,##0.00;[Red](#,##0.00)",
    45: "mm:ss",
    46: "[h]:mm:ss",
    47: "mmss.0",
    48: "##0.0E+0",
    49: "@",
    50: "yyyy/m/d",
    51: "yyyy/m/d",
    52: "yyyy/m/d",
    53: "yyyy/m/d",
    54: "yyyy/m/d",
    55: "yyyy/m/d",
    56: "yyyy/m/d",
    57: "yyyy/m/d",
    58: "yyyy/m/d",
}

#: OOXML 边框样式 → FortuneSheet（Luckysheet 血统）的边框代码。
#: 两边编号**不是**同一套：OOXML 2 = medium，而那边 2 = hair。照着抄会得到粗细错乱的表。
_BORDER_STYLES: dict[str, str] = {
    "thin": "1",
    "hair": "2",
    "dotted": "3",
    "dashed": "4",
    "dashDot": "5",
    "dashDotDot": "6",
    "double": "7",
    "medium": "8",
    "mediumDashed": "9",
    "mediumDashDot": "10",
    "mediumDashDotDot": "11",
    "slantDashDot": "12",
    "thick": "13",
}

#: Excel 的索引色盘（前 64 个）。
_INDEXED_COLORS: tuple[str, ...] = (
    "000000",
    "FFFFFF",
    "FF0000",
    "00FF00",
    "0000FF",
    "FFFF00",
    "FF00FF",
    "00FFFF",
    "000000",
    "FFFFFF",
    "FF0000",
    "00FF00",
    "0000FF",
    "FFFF00",
    "FF00FF",
    "00FFFF",
    "800000",
    "008000",
    "000080",
    "808000",
    "800080",
    "008080",
    "C0C0C0",
    "808080",
    "9999FF",
    "993366",
    "FFFFCC",
    "CCFFFF",
    "660066",
    "FF8080",
    "0066CC",
    "CCCCFF",
    "000080",
    "FF00FF",
    "FFFF00",
    "00FFFF",
    "800080",
    "800000",
    "008080",
    "0000FF",
    "00CCFF",
    "CCFFFF",
    "CCFFCC",
    "FFFF99",
    "99CCFF",
    "FF99CC",
    "CC99FF",
    "FFCC99",
    "3366FF",
    "33CCCC",
    "99CC00",
    "FFCC00",
    "FF9900",
    "FF6600",
    "666699",
    "969696",
    "003366",
    "339966",
    "003300",
    "333300",
    "993300",
    "993366",
    "333399",
    "333333",
)

_CELL_REF = re.compile(r"^\$?([A-Za-z]+)\$?(\d+)$")


@dataclass
class _Budget:
    """整本工作簿共享的容量预算（跨工作表）。"""

    cells: int = 0
    content_cells: int = 0
    truncated: bool = False


@dataclass
class _Warnings:
    items: list[str] = field(default_factory=list)
    _seen: set[str] = field(default_factory=set)

    def add(self, text: str) -> None:
        if text and text not in self._seen:
            self._seen.add(text)
            self.items.append(text)


# —— 颜色 ——


def _apply_tint(hex_color: str, tint: float) -> str:
    """Excel 的 tint：在 HLS 的亮度上做加减，不是简单地和白色混合。"""
    if not tint or len(hex_color) != 6:
        return hex_color
    try:
        red, green, blue = (int(hex_color[index : index + 2], 16) / 255 for index in (0, 2, 4))
        hue, lightness, saturation = colorsys.rgb_to_hls(red, green, blue)
        if tint < 0:
            lightness = lightness * (1 + tint)
        else:
            lightness = lightness * (1 - tint) + tint
        red, green, blue = colorsys.hls_to_rgb(hue, max(0.0, min(1.0, lightness)), saturation)
        return f"{round(red * 255):02X}{round(green * 255):02X}{round(blue * 255):02X}"
    except (ValueError, TypeError):
        return hex_color


def _theme_colors(zf: zipfile.ZipFile, names: set[str]) -> list[str]:
    """`xl/theme/theme1.xml` → 按 Excel 主题索引排列的 RGB 列表。"""
    order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4"]
    order += ["accent5", "accent6", "hlink", "folHlink"]
    empty = [""] * len(order)
    if "xl/theme/theme1.xml" not in names:
        return empty
    try:
        root = _xml(zf, "xl/theme/theme1.xml")
    except ParseError:
        return empty
    scheme = root.find(f".//{_A}clrScheme")
    if scheme is None:
        return empty
    found: dict[str, str] = {}
    for child in scheme:
        tag = child.tag.rsplit("}", 1)[-1]
        srgb = child.find(f"{_A}srgbClr")
        sys = child.find(f"{_A}sysClr")
        if srgb is not None and srgb.get("val"):
            found[tag] = srgb.get("val", "").upper()[-6:]
        elif sys is not None and sys.get("lastClr"):
            found[tag] = sys.get("lastClr", "").upper()[-6:]
    return [found.get(name, "") for name in order]


def _color(node: ET.Element | None, theme: list[str]) -> str:
    if node is None:
        return ""
    rgb = node.get("rgb")
    if rgb:
        value = rgb.strip().upper()
        if len(value) == 8:
            value = value[2:]
        return f"#{value}" if len(value) == 6 else ""
    theme_index = node.get("theme")
    if theme_index is not None:
        try:
            index = int(theme_index)
            base = theme[index] if 0 <= index < len(theme) else ""
            return f"#{_apply_tint(base, float(node.get('tint', '0') or 0))}" if base else ""
        except (ValueError, TypeError):
            return ""
    indexed = node.get("indexed")
    if indexed is not None:
        try:
            return f"#{_INDEXED_COLORS[int(indexed)]}"
        except (ValueError, IndexError):
            return ""
    return ""


# —— 样式 ——


@dataclass(frozen=True)
class _Font:
    bold: int = 0
    italic: int = 0
    underline: int = 0
    strike: int = 0
    size: float = 0
    color: str = ""
    name: str = ""


@dataclass(frozen=True)
class _Style:
    fmt: str = "General"
    is_date: bool = False
    bg: str = ""
    fc: str = ""
    bl: int = 0
    it: int = 0
    un: int = 0
    cl: int = 0
    fs: float = 0
    ff: str = ""
    ht: int | None = None
    vt: int | None = None
    tb: str = ""
    border: tuple[tuple[str, str, str], ...] = ()


def _flag(node: ET.Element | None) -> bool:
    if node is None:
        return False
    return node.get("val", "1").lower() not in {"0", "false", "none", "off"}


def _read_fonts(root: ET.Element, theme: list[str]) -> list[_Font]:
    fonts: list[_Font] = []
    for font in root.iter(_S + "font"):
        size_node = font.find(_S + "sz")
        name_node = font.find(_S + "name")
        try:
            size = float(size_node.get("val", "0")) if size_node is not None else 0
        except ValueError:
            size = 0
        fonts.append(
            _Font(
                bold=1 if _flag(font.find(_S + "b")) else 0,
                italic=1 if _flag(font.find(_S + "i")) else 0,
                underline=1 if _flag(font.find(_S + "u")) else 0,
                strike=1 if _flag(font.find(_S + "strike")) else 0,
                size=size,
                color=_color(font.find(_S + "color"), theme),
                name=name_node.get("val", "") if name_node is not None else "",
            )
        )
    return fonts


def _read_fills(root: ET.Element, theme: list[str]) -> list[str]:
    fills: list[str] = []
    for fill in root.iter(_S + "fill"):
        pattern = fill.find(_S + "patternFill")
        if pattern is None:
            fills.append("")
            continue
        kind = pattern.get("patternType", "none")
        if kind in {"", "none", "gray125"}:
            fills.append("")
            continue
        # 非 solid 图案（条纹/网格）没有等价物：取它的前景色当底色，
        # 图案本身丢掉 —— 比「整格无填充」更接近原意。
        fills.append(
            _color(pattern.find(_S + "fgColor"), theme)
            or _color(pattern.find(_S + "bgColor"), theme)
        )
    return fills


def _read_borders(root: ET.Element, theme: list[str]) -> list[tuple[tuple[str, str, str], ...]]:
    borders: list[tuple[tuple[str, str, str], ...]] = []
    for border in root.iter(_S + "border"):
        sides: list[tuple[str, str, str]] = []
        for key in ("left", "right", "top", "bottom"):
            side = border.find(_S + key)
            if side is None:
                continue
            code = _BORDER_STYLES.get(side.get("style", ""))
            if code:
                sides.append((key[0], code, _color(side.find(_S + "color"), theme) or "#000000"))
        borders.append(tuple(sides))
    return borders


def _parse_styles(zf: zipfile.ZipFile, names: set[str], theme: list[str]) -> list[_Style]:
    if "xl/styles.xml" not in names:
        return [_Style()]
    try:
        root = _xml(zf, "xl/styles.xml")
    except ParseError:
        return [_Style()]

    formats = dict(_BUILTIN_FORMATS)
    for node in root.iter(_S + "numFmt"):
        try:
            formats[int(node.get("numFmtId", ""))] = node.get("formatCode", "General")
        except ValueError:
            continue

    fonts = _read_fonts(root, theme)
    fills = _read_fills(root, theme)
    borders = _read_borders(root, theme)

    styles: list[_Style] = []
    # ⚠️ 必须只取 `cellXfs` 里的 xf：`root.iter("xf")` 会把 `cellStyleXfs`
    # （命名样式的基底）也算进来，于是每个 `s=` 的索引整体错位一格 ——
    # 症状是「日期列显示成百分比」「加粗变成了默认字体」，而且不报任何错。
    cell_xfs = root.find(_S + "cellXfs")
    xf_nodes = list(cell_xfs.iter(_S + "xf")) if cell_xfs is not None else []
    for xf in xf_nodes:
        try:
            number_id = int(xf.get("numFmtId", "0"))
            font_id = int(xf.get("fontId", "0"))
            fill_id = int(xf.get("fillId", "0"))
            border_id = int(xf.get("borderId", "0"))
        except ValueError:
            number_id = font_id = fill_id = border_id = 0
        fmt = formats.get(number_id, "General")
        font = fonts[font_id] if 0 <= font_id < len(fonts) else _Font()
        fill = fills[fill_id] if 0 <= fill_id < len(fills) else ""
        border = borders[border_id] if 0 <= border_id < len(borders) else ()

        alignment = xf.find(_S + "alignment")
        horizontal = alignment.get("horizontal", "") if alignment is not None else ""
        vertical = alignment.get("vertical", "") if alignment is not None else ""
        wrap = alignment is not None and alignment.get("wrapText", "").lower() in {
            "1",
            "true",
            "on",
        }
        styles.append(
            _Style(
                fmt=fmt,
                is_date=_is_date_format(fmt),
                bg=fill,
                fc=font.color,
                bl=font.bold,
                it=font.italic,
                un=font.underline,
                cl=font.strike,
                # Excel 的字号是 pt，画布要 px（96 DPI 下 ×4/3），否则中文会显得偏小
                fs=round(font.size * 4 / 3, 1) if font.size else 0,
                ff=font.name,
                ht={"left": 1, "center": 0, "right": 2}.get(horizontal),
                vt={"top": 1, "center": 0, "bottom": 2}.get(vertical),
                tb="2" if wrap else "",
                border=border,
            )
        )
    return styles or [_Style()]


# —— 数字与日期格式 ——


def _is_date_format(code: str) -> bool:
    """是不是日期/时间格式。

    先去掉引号里的字面量、转义字符、`[Red]` 这类控制标签，再看有没有日期令牌。
    不这么做的话 `#,##0 "days"` 会被误判成日期格式（里面的 d 是字面量）。
    """
    if not code or code in {"General", "@"}:
        return False
    if re.search(r"\[(h+|m+|s+)\]", code, re.IGNORECASE):
        return True
    cleaned = _strip_format_noise(code)
    return bool(re.search(r"[ymdhs]", cleaned, re.IGNORECASE)) or "am/pm" in cleaned.lower()


def _strip_format_noise(code: str, *, keep_literals: bool = False) -> str:
    """去掉格式串里的控制语法。

    `keep_literals=False`（判定日期用）把引号内容和 `[Red]` 一起丢掉；
    `True`（渲染数字用）保留字面量，并把 `[$¥-409]` 里的货币符号提出来 ——
    中文表格里货币格式几乎都长这样，丢掉会让「¥1,234」变成「1,234」。
    """
    out: list[str] = []
    index = 0
    while index < len(code):
        char = code[index]
        if char == '"':
            end = code.find('"', index + 1)
            if keep_literals:
                out.append(code[index + 1 : len(code) if end < 0 else end])
            index = len(code) if end < 0 else end + 1
            continue
        if char == "\\" and index + 1 < len(code):
            if keep_literals:
                out.append(code[index + 1])
            index += 2
            continue
        if char in "_*" and index + 1 < len(code):
            if keep_literals and char == "_":
                out.append(" ")
            index += 2
            continue
        if char == "[":
            end = code.find("]", index)
            content = code[index + 1 : len(code) if end < 0 else end]
            if keep_literals and content.startswith("$"):
                out.append(content[1:].split("-", 1)[0])
            index = len(code) if end < 0 else end + 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _split_sections(code: str) -> list[str]:
    """按**不在引号/方括号内**的分号切分格式段。"""
    sections: list[str] = []
    current: list[str] = []
    quoted = False
    bracket = 0
    for char in code:
        if char == '"':
            quoted = not quoted
            current.append(char)
        elif not quoted and char == "[":
            bracket += 1
            current.append(char)
        elif not quoted and char == "]" and bracket:
            bracket -= 1
            current.append(char)
        elif char == ";" and not quoted and bracket == 0:
            sections.append("".join(current))
            current = []
        else:
            current.append(char)
    sections.append("".join(current))
    return sections


def _excel_serial_to_datetime(serial: float, date1904: bool) -> datetime:
    if date1904:
        base = datetime(1904, 1, 1)
    else:
        # Excel 的 1900 闰年 bug：它认为 1900-02-29 存在（序列 60），
        # 所以 60 之后的日期都要按 1899-12-30 起算才和 Excel 对齐。
        base = datetime(1899, 12, 31) if serial < 60 else datetime(1899, 12, 30)
    days = int(serial)
    # 微秒精度 + 上限截断：0.999999 这类值四舍五入到整秒会进位成「次日 00:00」，
    # 于是 23:59:59 被显示成 00:00:00 —— Excel 不会这样跨天。
    micros = min(round((serial - days) * 86_400 * 1_000_000), 86_399_999_999)
    return base + timedelta(days=days, microseconds=micros)


def _general_number(value: float) -> str:
    if value != value or value in (float("inf"), float("-inf")):
        return str(value)
    if float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    text = f"{value:.10g}"
    if "e" in text and 1e-4 <= abs(value) < 1e15:
        text = f"{value:.10f}".rstrip("0").rstrip(".")
    return text


def _decimal_text(value: float, min_decimals: int, max_decimals: int, grouping: bool) -> str:
    places = max(0, min(max_decimals, 15))
    try:
        quant = Decimal(1).scaleb(-places)
        rounded = Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return _general_number(value)
    text = f"{rounded:,.{places}f}" if grouping else f"{rounded:.{places}f}"
    if places > min_decimals and "." in text:
        head, tail = text.split(".", 1)
        tail = tail.rstrip("0")
        if len(tail) < min_decimals:
            tail += "0" * (min_decimals - len(tail))
        text = head + (f".{tail}" if tail else "")
    return text


_NUMERIC_PLACEHOLDERS = set("0#?")


def _format_numeric(value: float, code: str) -> str:
    sections = _split_sections(code)
    negative = value < 0
    if negative and len(sections) >= 2:
        section = sections[1]
        magnitude = abs(value)
    elif value == 0 and len(sections) >= 3:
        section = sections[2]
        magnitude = 0.0
    else:
        section = sections[0]
        magnitude = abs(value) if negative else value

    section = _strip_format_noise(section, keep_literals=True)
    percent = section.count("%")
    magnitude = magnitude * (100**percent)

    # 找出数字占位符的范围；前缀/后缀里的字面量（¥、USD、括号）保留。
    positions = [index for index, char in enumerate(section) if char in _NUMERIC_PLACEHOLDERS]
    if not positions:
        return section
    start, end = positions[0], positions[-1]
    prefix = section[:start]
    suffix = section[end + 1 :]
    pattern = section[start : end + 1]

    if re.search(r"[eE][+-]?", pattern):
        decimals = pattern.split(".", 1)[1].count("0") if "." in pattern else 0
        text = f"{magnitude:.{max(0, decimals)}E}"
        mantissa, exponent = text.split("E")
        sign = "-" if exponent.startswith("-") else "+"
        digits = exponent.lstrip("+-").rjust(2, "0")
        number = f"{mantissa}E{sign}{digits}"
    elif "?" in pattern or ("/" in pattern and "#" in pattern):
        number = _decimal_text(magnitude, 0, 0, False)
    else:
        min_decimals = 0
        max_decimals = 0
        if "." in pattern:
            after = pattern.split(".", 1)[1]
            min_decimals = after.count("0")
            max_decimals = sum(1 for char in after if char in _NUMERIC_PLACEHOLDERS)
        grouping = "," in pattern.split(".", 1)[0]
        number = _decimal_text(magnitude, min_decimals, max_decimals, grouping)
        if negative and len(sections) < 2:
            number = f"-{number}"

    if percent:
        suffix = suffix.replace("%", "") + "%" * percent
    return f"{prefix}{number}{suffix}"


def _date_tokens(code: str) -> list[str]:
    """把日期格式拆成 token。字面量用 `\\0` 前缀标记，避免被当成日期令牌。"""
    tokens: list[str] = []
    index = 0
    while index < len(code):
        char = code[index]
        if char == '"':
            end = code.find('"', index + 1)
            literal = code[index + 1 : len(code) if end < 0 else end]
            if literal:
                tokens.append("\0" + literal)
            index = len(code) if end < 0 else end + 1
            continue
        if char == "\\" and index + 1 < len(code):
            tokens.append("\0" + code[index + 1])
            index += 2
            continue
        if char == "_" and index + 1 < len(code):
            tokens.append("\0 ")
            index += 2
            continue
        if char == "*" and index + 1 < len(code):
            index += 2
            continue
        match = re.match(r"\[(h+|m+|s+)\]", code[index:], re.IGNORECASE)
        if match:
            # `\x01` 标记「累计时长」：`[h]:mm:ss` 的 h 是总小时数（可超过 24），
            # 与 `h:mm:ss` 的「一天内第几小时」完全不同，不能走进同一个分支。
            tokens.append("\x01" + match.group(1).lower())
            index += len(match.group(0))
            continue
        if char == "[":
            end = code.find("]", index)
            content = code[index + 1 : len(code) if end < 0 else end]
            if content.startswith("$"):
                symbol = content[1:].split("-", 1)[0]
                if symbol:
                    tokens.append("\0" + symbol)
            index = len(code) if end < 0 else end + 1
            continue
        match = re.match(r"(AM/PM|A/P)", code[index:], re.IGNORECASE)
        if match:
            tokens.append(match.group(1).upper())
            index += len(match.group(0))
            continue
        match = re.match(r"(y+|m+|d+|h+|s+)", code[index:], re.IGNORECASE)
        if match:
            tokens.append(match.group(1).lower())
            index += len(match.group(0))
            continue
        tokens.append(char)
        index += 1
    return tokens


_MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
_DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def _format_date(serial: float, code: str, date1904: bool) -> str:
    try:
        moment = _excel_serial_to_datetime(serial, date1904)
    except (OverflowError, ValueError):
        return _general_number(serial)

    tokens = _date_tokens(code)
    has_meridiem = any(token in {"AM/PM", "A/P"} for token in tokens)
    seen_hour = False

    def neighbour(index: int, step: int) -> str:
        """最近的日期/时间令牌首字母（跳过字面量与分隔符）。"""
        cursor = index + step
        while 0 <= cursor < len(tokens):
            item = tokens[cursor]
            if item.startswith("\0"):
                cursor += step
                continue
            if item.startswith("\x01"):
                return item[1:2]
            low = item.lower()
            if low[:1] in {"y", "m", "d", "h", "s"} or low in {"am/pm", "a/p"}:
                return low[:1]
            cursor += step
        return ""

    out: list[str] = []
    for position, token in enumerate(tokens):
        if token.startswith("\0"):
            out.append(token[1:])
            continue
        if token.startswith("\x01"):
            # `[h]` / `[mm]` / `[ss]`：累计时长，不是「当前这一天的第几小时」。
            unit = token[1:]
            if unit.startswith("h"):
                total = int(serial * 24)
                seen_hour = True
            elif unit.startswith("m"):
                total = int(serial * 1440)
            else:
                total = int(serial * 86400)
            out.append(f"{total:0{len(unit)}d}" if len(unit) >= 2 else str(total))
            continue
        lower = token.lower()
        if lower in {"am/pm", "a/p"}:
            out.append("AM" if moment.hour < 12 else "PM")
        elif lower.startswith("h"):
            seen_hour = True
            hour = moment.hour
            if has_meridiem:
                hour = hour % 12 or 12
            out.append(f"{hour:02d}" if len(lower) >= 2 else str(hour))
        elif lower.startswith("m"):
            # m 紧跟在小时之后、或紧挨在秒之前时是「分钟」，其余是「月」。
            # 判据只能看**相邻**令牌：`yyyy/m/d h:mm:ss` 里第一个 m 之后确实
            # 还有 ss，但它是日期里的月 —— 按「后面有 s 就是分钟」会得到 2024/59/1。
            is_minute = seen_hour or neighbour(position, -1) == "h" or neighbour(position, 1) == "s"
            if is_minute:
                out.append(f"{moment.minute:02d}" if len(lower) >= 2 else str(moment.minute))
            elif len(lower) >= 4:
                out.append(_MONTHS[moment.month - 1])
            elif len(lower) == 3:
                out.append(_MONTHS[moment.month - 1][:3])
            elif len(lower) == 2:
                out.append(f"{moment.month:02d}")
            else:
                out.append(str(moment.month))
        elif lower.startswith("d"):
            if len(lower) >= 4:
                out.append(_DAYS[moment.weekday()])
            elif len(lower) == 3:
                out.append(_DAYS[moment.weekday()][:3])
            elif len(lower) == 2:
                out.append(f"{moment.day:02d}")
            else:
                out.append(str(moment.day))
        elif lower.startswith("y"):
            out.append(f"{moment.year:04d}" if len(lower) >= 2 else str(moment.year))
        elif lower.startswith("s"):
            out.append(f"{moment.second:02d}" if len(lower) >= 2 else str(moment.second))
        elif token in {"\\", "_"}:
            continue
        else:
            out.append(token)

    text = "".join(out).strip()
    return text or moment.strftime("%Y-%m-%d %H:%M:%S")


def _format_value(raw: str, style: _Style, date1904: bool) -> tuple[Any, str, str]:
    """`(v, m, ct.t)`。文本/布尔/错误的 ct 不写。"""
    if style.fmt == "@":
        return raw, raw, ""
    try:
        number = float(raw)
    except (TypeError, ValueError):
        return raw, raw, ""
    if number != number or number in (float("inf"), float("-inf")):
        return raw, raw, ""

    value: Any = int(number) if number.is_integer() and abs(number) < 2**53 else number
    if style.is_date:
        return value, _format_date(number, style.fmt, date1904), "d"
    if style.fmt in {"", "General"}:
        return value, _general_number(number), "n"
    try:
        return value, _format_numeric(number, style.fmt), "n"
    except (ValueError, TypeError, InvalidOperation):
        return value, _general_number(number), "n"


# —— zip / XML ——


def _xml(zf: zipfile.ZipFile, name: str) -> ET.Element:
    raw = _read_zip_member(zf, name)
    upper = raw[:4096].upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise ParseError("文件里带有 XML 实体声明，出于安全考虑拒绝解析")
    try:
        return ET.fromstring(raw)
    except ET.ParseError as error:
        raise ParseError(f"文件结构损坏（{name} 不是合法的 XML）") from error


def _resolve_target(target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join("xl", target))


def _sheet_entries(
    zf: zipfile.ZipFile, names: set[str], warnings: _Warnings
) -> list[tuple[str, str, str]]:
    """`[(工作表名, zip 内路径, 可见性)]`，顺序与工作簿一致。"""
    workbook = _xml(zf, "xl/workbook.xml")
    rels: dict[str, str] = {}
    if "xl/_rels/workbook.xml.rels" in names:
        root = _xml(zf, "xl/_rels/workbook.xml.rels")
        rels = {
            node.get("Id", ""): node.get("Target", "")
            for node in root.iter()
            if node.tag.endswith("Relationship")
        }

    entries: list[tuple[str, str, str]] = []
    for index, sheet in enumerate(workbook.iter(_S + "sheet"), start=1):
        name = sheet.get("name", "") or f"Sheet{index}"
        state = sheet.get("state", "visible")
        target = rels.get(sheet.get(_R + "id", ""), "")
        path = _resolve_target(target) if target else f"xl/worksheets/sheet{index}.xml"
        if path not in names:
            warnings.add(f"工作表「{name}」的文件结构不完整，已跳过")
            continue
        entries.append((name, path, state))
    return entries


def _column_index(cell: ET.Element) -> int | None:
    letters = "".join(char for char in (cell.get("r") or "") if char.isalpha())
    if not letters:
        return None
    index = 0
    for char in letters.upper():
        index = index * 26 + (ord(char) - 64)
    return index - 1


def _a1(ref: str) -> tuple[int, int] | None:
    match = _CELL_REF.match(ref.strip())
    if not match:
        return None
    letters, row = match.groups()
    index = 0
    for char in letters.upper():
        index = index * 26 + (ord(char) - 64)
    return int(row) - 1, index - 1


def _shared_strings(zf: zipfile.ZipFile, names: set[str], warnings: _Warnings) -> list[str]:
    if "xl/sharedStrings.xml" not in names:
        return []
    try:
        root = _xml(zf, "xl/sharedStrings.xml")
    except ParseError:
        warnings.add("共享字符串表损坏，文本单元格可能显示为空")
        return []
    return [
        "".join(node.text or "" for node in item.iter(_S + "t")) for item in root.iter(_S + "si")
    ]


def _row_height(px: float) -> int:
    return max(10, min(1_000, round(px)))


def _column_width(chars: float) -> int:
    # Excel 的宽度单位是「默认字体下的字符数」。7px/字符 + 5px 内边距是
    # 96 DPI、Calibri 11 下的常用近似；它只影响观感，不影响数据。
    return max(20, min(1_200, round(chars * 7 + 5)))


def _text_cell(
    text: str, style: _Style, warnings: _Warnings, counter: list[int]
) -> dict[str, Any] | None:
    if text == "":
        return None
    if len(text) > MAX_CELL_CHARS:
        text = text[:MAX_CELL_CHARS]
        counter[0] += 1
    value: dict[str, Any] = {"v": text, "m": text}
    if style.tb:
        value["tb"] = style.tb
    else:
        value["tb"] = "2" if "\n" in text else "1"
    return value


# —— 工作表 ——


def _parse_sheet(
    zf: zipfile.ZipFile,
    names: set[str],
    name: str,
    path: str,
    styles: list[_Style],
    shared: list[str],
    date1904: bool,
    warnings: _Warnings,
    budget: _Budget,
    order: int,
) -> dict[str, Any] | None:
    try:
        root = _xml(zf, path)
    except ParseError:
        warnings.add(f"工作表「{name}」解析失败，已跳过")
        return None

    celldata: list[dict[str, Any]] = []
    border_cells: list[tuple[int, int, tuple[tuple[str, str, str], ...]]] = []
    rowlen: dict[int, int] = {}
    columnlen: dict[int, int] = {}
    rowhidden: dict[int, int] = {}
    colhidden: dict[int, int] = {}
    merged: dict[str, dict[str, int]] = {}
    cell_by_pos: dict[tuple[int, int], dict[str, Any]] = {}

    used_rows = 0
    used_cols = 0
    text_truncated = [0]
    formulas_without_cache = 0
    skipped_cells = 0
    default_col_override: int | None = None

    sheet_data = root.find(_S + "sheetData")
    stop = budget.cells >= MAX_CELLS
    if sheet_data is not None and not stop:
        fallback_row = 0
        for row in sheet_data.iter(_S + "row"):
            row_attr = row.get("r")
            try:
                row_index = int(row_attr) - 1 if row_attr else fallback_row
            except ValueError:
                row_index = fallback_row
            fallback_row = row_index + 1
            if row_index < 0:
                continue
            if row_index >= MAX_ROWS:
                budget.truncated = True
                warnings.add(f"工作表「{name}」超过 {MAX_ROWS} 行，后面的行没有显示")
                break
            if row.get("hidden", "").lower() in {"1", "true"}:
                rowhidden[row_index] = 0
            height = row.get("ht")
            if height:
                try:
                    rowlen[row_index] = _row_height(float(height) * 4 / 3)
                except ValueError:
                    pass

            fallback_col = 0
            for cell_el in row.iter(_S + "c"):
                column_index = _column_index(cell_el)
                if column_index is None:
                    column_index = fallback_col
                fallback_col = column_index + 1
                if column_index < 0 or column_index >= MAX_COLUMNS:
                    budget.truncated = True
                    skipped_cells += 1
                    continue
                if budget.cells >= MAX_CELLS:
                    budget.truncated = True
                    stop = True
                    break

                try:
                    style_index = int(cell_el.get("s", "0"))
                except ValueError:
                    style_index = 0
                style = styles[style_index] if 0 <= style_index < len(styles) else _Style()

                formula_node = cell_el.find(_S + "f")
                formula = (formula_node.text or "").strip() if formula_node is not None else ""
                value_node = cell_el.find(_S + "v")
                raw = (
                    value_node.text
                    if value_node is not None and value_node.text is not None
                    else ""
                )
                kind = cell_el.get("t", "n")

                cell_value: dict[str, Any] | None = None
                if kind == "inlineStr":
                    cell_value = _text_cell(
                        "".join(node.text or "" for node in cell_el.iter(_S + "t")),
                        style,
                        warnings,
                        text_truncated,
                    )
                elif kind == "s":
                    text = ""
                    try:
                        text = shared[int(raw)] if raw else ""
                    except (ValueError, IndexError):
                        text = ""
                    cell_value = _text_cell(text, style, warnings, text_truncated)
                elif kind == "str":
                    cell_value = _text_cell(raw, style, warnings, text_truncated)
                elif kind == "b":
                    flag = raw.strip() in {"1", "true", "TRUE"}
                    cell_value = {"v": flag, "m": "TRUE" if flag else "FALSE"}
                elif kind == "e":
                    cell_value = {"v": raw, "m": raw, "fc": "#d32f2f", "tb": "1"}
                elif raw:
                    value, display, cell_type = _format_value(raw, style, date1904)
                    if len(display) > MAX_CELL_CHARS:
                        display = display[:MAX_CELL_CHARS]
                        text_truncated[0] += 1
                    cell_value = {"v": value, "m": display}
                    if cell_type:
                        cell_value["ct"] = {"fa": style.fmt, "t": cell_type}
                    if "ct" not in cell_value and isinstance(value, str):
                        cell_value["tb"] = style.tb or ("2" if "\n" in value else "1")

                if formula:
                    if len(formula) > MAX_CELL_CHARS:
                        formula = formula[:MAX_CELL_CHARS]
                        text_truncated[0] += 1
                    normalized = formula if formula.startswith("=") else f"={formula}"
                    if cell_value is None:
                        formulas_without_cache += 1
                        cell_value = {"v": normalized, "m": normalized, "f": normalized, "tb": "1"}
                    else:
                        cell_value["f"] = normalized

                has_content = cell_value is not None and (
                    cell_value.get("v") not in (None, "") or "f" in cell_value
                )

                if cell_value is not None:
                    # 样式字段只在非默认时写，别让每个格子都带上十几个空键。
                    if style.bg:
                        cell_value["bg"] = style.bg
                    if style.fc and "fc" not in cell_value:
                        cell_value["fc"] = style.fc
                    if style.bl:
                        cell_value["bl"] = 1
                    if style.it:
                        cell_value["it"] = 1
                    if style.un:
                        cell_value["un"] = 1
                    if style.cl:
                        cell_value["cl"] = 1
                    if style.fs:
                        cell_value["fs"] = style.fs
                    if style.ff:
                        cell_value["ff"] = style.ff
                    if style.ht is not None:
                        cell_value["ht"] = style.ht
                    if style.vt is not None:
                        cell_value["vt"] = style.vt
                    if style.tb:
                        cell_value["tb"] = style.tb
                    cell = {"r": row_index, "c": column_index, "v": cell_value}
                    celldata.append(cell)
                    cell_by_pos[(row_index, column_index)] = cell
                    budget.cells += 1
                    if has_content:
                        budget.content_cells += 1
                        used_rows = max(used_rows, row_index + 1)
                        used_cols = max(used_cols, column_index + 1)
                elif style.bg or style.border:
                    # 只有填充/边框的空格子也要留下，否则「整列底色」会凭空消失。
                    cell_value = {}
                    if style.bg:
                        cell_value["bg"] = style.bg
                    cell = {"r": row_index, "c": column_index, "v": cell_value}
                    celldata.append(cell)
                    cell_by_pos[(row_index, column_index)] = cell
                    budget.cells += 1

                if style.border:
                    border_cells.append((row_index, column_index, style.border))
            if stop:
                warnings.add(f"工作表「{name}」超过 {MAX_CELLS} 个单元格，后面的内容没有显示")
                break

    for col in root.iter(_S + "col"):
        try:
            first = int(col.get("min", "1")) - 1
            last = int(col.get("max", str(first + 2))) - 1
        except ValueError:
            continue
        hidden = col.get("hidden", "").lower() in {"1", "true"}
        width = col.get("width")
        if last - first + 1 >= MAX_COLUMNS:
            # 「整表 16384 列」的默认宽度：写进 defaultColWidth，别生成一万多个键。
            if width:
                try:
                    default_col_override = _column_width(float(width))
                except ValueError:
                    pass
            continue
        for index in range(max(0, first), min(last + 1, MAX_COLUMNS)):
            if hidden:
                colhidden[index] = 0
            if width:
                try:
                    columnlen[index] = _column_width(float(width))
                except ValueError:
                    pass

    merge_root = root.find(_S + "mergeCells")
    if merge_root is not None:
        for merge in merge_root.iter(_S + "mergeCell"):
            ref = merge.get("ref", "")
            if ":" not in ref:
                continue
            start_ref, end_ref = ref.split(":", 1)
            start = _a1(start_ref)
            end = _a1(end_ref)
            if start is None or end is None:
                continue
            r1, c1 = start
            r2, c2 = end
            if r1 > r2:
                r1, r2 = r2, r1
            if c1 > c2:
                c1, c2 = c2, c1
            if r1 < 0 or c1 < 0 or r1 >= MAX_ROWS or c1 >= MAX_COLUMNS:
                budget.truncated = True
                continue
            r2 = min(r2, MAX_ROWS - 1)
            c2 = min(c2, MAX_COLUMNS - 1)
            key = f"{r1}_{c1}"
            merged[key] = {"r": r1, "c": c1, "rs": r2 - r1 + 1, "cs": c2 - c1 + 1}
            cell = cell_by_pos.get((r1, c1))
            if cell is None:
                cell = {"r": r1, "c": c1, "v": {}}
                celldata.append(cell)
                cell_by_pos[(r1, c1)] = cell
            cell["v"]["mc"] = merged[key]
            used_rows = max(used_rows, r2 + 1)
            used_cols = max(used_cols, c2 + 1)
            # 被合并覆盖的格子在 Excel 里本来就不显示内容；留下会在合并区里
            # 画出「还有字」的重影。真有内容时才提醒一句。
            for covered_r in range(r1, r2 + 1):
                for covered_c in range(c1, c2 + 1):
                    if covered_r == r1 and covered_c == c1:
                        continue
                    covered = cell_by_pos.get((covered_r, covered_c))
                    if covered is not None and covered["v"].get("v") not in (None, ""):
                        warnings.add("合并单元格里有被覆盖的内容，表格视图只显示左上角的值")

    frozen: dict[str, Any] | None = None
    show_grid_lines = True
    zoom_ratio = 1.0
    view = root.find(f".//{_S}sheetView")
    if view is not None:
        pane = view.find(_S + "pane")
        if pane is not None and pane.get("state", "").startswith("frozen"):
            try:
                x_split = int(float(pane.get("xSplit", "0") or 0))
                y_split = int(float(pane.get("ySplit", "0") or 0))
            except ValueError:
                x_split = y_split = 0
            if x_split and y_split:
                frozen = {
                    "type": "both",
                    "range": {
                        "row_focus": max(0, y_split - 1),
                        "column_focus": max(0, x_split - 1),
                    },
                }
            elif y_split:
                frozen = {
                    "type": "row",
                    "range": {"row_focus": max(0, y_split - 1), "column_focus": 0},
                }
            elif x_split:
                frozen = {
                    "type": "column",
                    "range": {"row_focus": 0, "column_focus": max(0, x_split - 1)},
                }
        if view.get("showGridLines", "").lower() in {"0", "false"}:
            show_grid_lines = False
        try:
            zoom = float(view.get("zoomScale", "100") or 100)
            if 10 <= zoom <= 400:
                zoom_ratio = zoom / 100
        except ValueError:
            pass

    default_row = 19
    default_col = 73
    format_pr = root.find(_S + "sheetFormatPr")
    if format_pr is not None:
        try:
            if format_pr.get("defaultRowHeight"):
                default_row = _row_height(float(format_pr.get("defaultRowHeight", "15")) * 4 / 3)
            if format_pr.get("defaultColWidth"):
                default_col = _column_width(float(format_pr.get("defaultColWidth", "8.43")))
        except ValueError:
            pass
    if default_col_override is not None:
        default_col = default_col_override

    if len(border_cells) > MAX_BORDER_CELLS:
        border_cells = border_cells[:MAX_BORDER_CELLS]
        warnings.add("带边框的单元格过多，部分边框没有显示")
    border_info: list[dict[str, Any]] = []
    for row_index, column_index, sides in border_cells:
        value: dict[str, Any] = {"row_index": row_index, "col_index": column_index}
        for side, style_code, color in sides:
            value[side] = {"style": style_code, "color": color}
        border_info.append({"rangeType": "cell", "value": value})

    if root.findall(_S + "conditionalFormatting"):
        warnings.add(f"工作表「{name}」的条件格式没有渲染（数据仍在）")

    if text_truncated[0]:
        warnings.add(f"有 {text_truncated[0]} 个单元格的文本超过 {MAX_CELL_CHARS} 字，已截断显示")
    if formulas_without_cache:
        warnings.add(
            f"有 {formulas_without_cache} 个公式没有缓存值（Excel 存盘时未计算），已原样显示公式"
        )
    if skipped_cells:
        warnings.add(f"工作表「{name}」有 {skipped_cells} 个单元格超出列上限，已跳过")

    celldata.sort(key=lambda item: (item["r"], item["c"]))
    row_count = min(MAX_ROWS, max(100, used_rows + 20))
    column_count = min(MAX_COLUMNS, max(26, used_cols + 5))

    config: dict[str, Any] = {}
    if merged:
        config["merge"] = merged
    if rowlen:
        config["rowlen"] = rowlen
    if columnlen:
        config["columnlen"] = columnlen
    if rowhidden:
        config["rowhidden"] = rowhidden
    if colhidden:
        config["colhidden"] = colhidden
    if border_info:
        config["borderInfo"] = border_info

    sheet: dict[str, Any] = {
        "id": f"sheet-{order + 1}",
        "name": name,
        "order": order,
        "row": row_count,
        "column": column_count,
        "celldata": celldata,
        "defaultRowHeight": default_row,
        "defaultColWidth": default_col,
        "showGridLines": show_grid_lines,
        "zoomRatio": zoom_ratio,
    }
    if config:
        sheet["config"] = config
    if frozen:
        sheet["frozen"] = frozen
    return sheet


def _has_drawing(zf: zipfile.ZipFile, names: set[str], sheet_path: str) -> bool:
    """这张表有没有绘图（图表/图片）。有就记一条，避免让用户以为资料丢了。"""
    rels_path = posixpath.join(
        posixpath.dirname(sheet_path), "_rels", posixpath.basename(sheet_path) + ".rels"
    )
    if rels_path not in names:
        return False
    try:
        root = _xml(zf, rels_path)
    except ParseError:
        return False
    return any(
        rel.get("Type", "").endswith(("/drawing", "/chart"))
        for rel in root.iter()
        if rel.tag.endswith("Relationship")
    )


def parse_workbook(data: bytes) -> dict[str, Any]:
    """`.xlsx` 字节 → 前端表格视图要的工作簿 JSON。

    失败抛 `ParseError`（文案是给用户看的，会原样进接口错误）。

    这里兜住 zip 层剩下的两种异常：成员 CRC 损坏（`BadZipFile`，在 `zf.read` 时才抛）
    与加密工作簿（`RuntimeError`，密码不在本系统范围内）。不兜的话它们会变成 500，
    而用户看到的应当是「这份文件读不了」这句人话。
    """
    try:
        return _parse_workbook(data)
    except zipfile.BadZipFile as error:
        raise ParseError("不是有效的 .xlsx（zip 结构损坏）") from error
    except RuntimeError as error:
        # zipfile 对加密成员抛裸 RuntimeError("File … is encrypted")
        raise ParseError("这个 .xlsx 加了密码，无法解析") from error


def _parse_workbook(data: bytes) -> dict[str, Any]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ParseError("不是有效的 .xlsx（zip 结构损坏）") from error

    warnings = _Warnings()
    with zf:
        names = set(zf.namelist())
        if "xl/workbook.xml" not in names:
            raise ParseError("不是有效的 .xlsx（缺少 workbook.xml）")
        workbook = _xml(zf, "xl/workbook.xml")
        workbook_pr = workbook.find(_S + "workbookPr")
        date1904 = workbook_pr is not None and workbook_pr.get("date1904", "") in {"1", "true"}
        theme = _theme_colors(zf, names)
        styles = _parse_styles(zf, names, theme)
        shared = _shared_strings(zf, names, warnings)
        entries = _sheet_entries(zf, names, warnings)
        if not entries:
            raise ParseError("工作簿里没有工作表")

        visible = [item for item in entries if item[2] == "visible"]
        hidden = len(entries) - len(visible)
        if hidden:
            warnings.add(f"有 {hidden} 张隐藏工作表没有显示（数据仍在原文件里）")
        chosen = visible or entries
        if len(chosen) > MAX_SHEETS:
            warnings.add(f"工作表过多，只显示了前 {MAX_SHEETS} 张")
            chosen = chosen[:MAX_SHEETS]

        budget = _Budget()
        sheets: list[dict[str, Any]] = []
        drawings = 0
        for order, (name, path, _state) in enumerate(chosen):
            if budget.cells >= MAX_CELLS:
                warnings.add(f"工作簿超过 {MAX_CELLS} 个单元格，后面的工作表没有显示")
                break
            sheet = _parse_sheet(
                zf,
                names,
                name,
                path,
                styles,
                shared,
                date1904,
                warnings,
                budget,
                order,
            )
            if sheet is not None:
                sheets.append(sheet)
            if _has_drawing(zf, names, path):
                drawings += 1

        if drawings:
            warnings.add(
                f"有 {drawings} 张工作表含图表或图片，表格视图不显示（打印版式里可以看到）"
            )
        if any(name.startswith("xl/pivotCache/") for name in names):
            warnings.add("数据透视表没有在表格视图里展开（打印版式里可以看到）")

    if not sheets:
        raise ParseError("表格里没有可显示的内容（可能是空表或只有图表）")

    payload: dict[str, Any] = {
        "version": PARSER_VERSION,
        "sheets": sheets,
        "warnings": warnings.items,
        "truncated": budget.truncated,
        "totalCells": budget.content_cells,
        "activeSheet": 0,
    }
    if len(dumps_workbook(payload)) > MAX_JSON_BYTES:
        raise ParseError(
            "表格视图的数据超过上限，无法在浏览器里流畅打开；可以看「打印版式」或「正文」"
        )
    return payload


def dumps_workbook(payload: dict[str, Any]) -> bytes:
    """工作簿 JSON 的稳定字节（存储与测试共用同一份序列化参数）。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
