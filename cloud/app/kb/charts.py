"""图表数值抽取：PowerPoint / Excel 内嵌图表的 `<c:v>` 缓存 → 表格。

## 为什么图表能抽出数来，而不是「图表里的文字未提取」

Office 的图表（DrawingML Chart）**自己不带数据源**，但每次保存时会把算好的结果
写进 `c:numCache` / `c:strCache` —— 也就是「系列名、类别名、每个点的数值」都在
XML 里躺着。它只是**缓存**（不是公式），所以：

- 能读到的就是文件打开时的样子，改数据后必须重新保存一次才会更新；
- 从没在 Office 里渲染过的图表**没有缓存**（有 `<c:ser>` 没有 `<c:pt>`），
  这时我们只能说「这个图表没有数值」，不能假装读到 0。

## 为什么转成表格而不是一段话说

和 `.xlsx` 同一条理由（见 `parsing.py` 的 `_parse_xlsx`）：`| Q1 | 300 |` 这一行
不含「收入」两个字，搜「收入」一个词都命中不了。转成 GFM 表格后，切块器把整表放
在一块、检索投影（`tables.table_to_records`）把表头拼进每一行，这一行才算「带全了
列名」—— 是「能不能搜到」的差别，不是排版差别。

摘要在表格**前面单独一段**：图表的标题（「Q3 销售趋势」）和系列名往往比数字本身
更常被搜，而 GFM 表格的表头必须是第一行，插不进去。

## 为什么不画图

图表的本体是一堆 `<c:ser>` + 样式属性，没有可渲染的文字；把它画成图片需要先做
排版/光栅化（客户端侧的能力），而知识库要的是**可检索的文本**。所以这里只取数值。
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

_C = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

#: 单个图表最多取多少个数据点。防的是「拿一份日粒度监控表当知识库」——
#: 几万个点切块后既超字数上限，对检索也只剩噪声。
MAX_CHART_POINTS = 120

#: 单个图表最多取多少个系列（列）。超过的列会让表格宽到读不出哪列是哪列。
MAX_CHART_SERIES = 12

#: 标题上限。图表标题常是整句话，长到 300 字就没法当标题用了。
_TITLE_MAX = 120

#: 类别列的列名。`类别` 是 Excel 自己的叫法（坐标轴上的「分类」），
#: 也正好是检索时最可能被写的词。
CATEGORY_HEADER = "类别"


@dataclass(frozen=True)
class ChartSeries:
    """一个数据系列（表格里的一列）。`values` 是 `点下标 → 显示值`。"""

    name: str
    values: dict[int, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ChartData:
    title: str
    #: 真正进表的点下标（已按 MAX_CHART_POINTS 截断，顺序与原文一致）
    indexes: list[int]
    categories: dict[int, str]
    series: list[ChartSeries]
    #: 有截断（点数或系列数）→ 调用方要如实告知用户
    truncated: bool = False

    def table(self) -> list[list[str]]:
        """图表 → 行列表（第一行是表头，交给 `parsing._gfm_table`）。"""
        header = [CATEGORY_HEADER, *[item.name for item in self.series]]
        rows = [header]
        for index in self.indexes:
            # 没有类别名时用「第几个点」：空着会让整列看起来是坏的
            label = self.categories.get(index) or str(index + 1)
            rows.append([label, *[item.values.get(index, "") for item in self.series]])
        return rows

    def is_covered_by(self, texts: set[str]) -> bool:
        """这份图表的数值是否**已经**在别处（单元格）出现过。

        `.xlsx` 的图表没有自己的数据源，只能引用工作簿里的单元格 —— 也就是说
        「图表表格 + 工作表表格」两份内容进库 = **同一批数字被索引两遍**。
        后果不是多占一点空间，而是检索结果里出现两条几乎一样的片段（用户会以为
        库里有两份资料），而且 top-k 名额被自己挤掉。

        判据刻意只认「系列名 + 每个数值都出现过」：只要有一个数在单元格里找不到
        （源数据被删、图表引用外部工作簿、只有缓存），就老老实实把表格留下 ——
        那份表格就是**唯一**能读到这些数的地方。

        `texts` 为空（没有可比较的单元格）时返回 `False`：宁可重复，不可丢数。
        """
        if not texts:
            return False
        if any(item.name not in texts for item in self.series):
            # 系列名是从单元格取的；取不到说明这不是「图表照抄单元格」的情况
            return False
        return all(value in texts for item in self.series for value in item.values.values())

    def summary(self) -> str:
        """一句话摘要（表格前的那一段）。

        刻意把**系列名**写全：它是这个图表在检索里最可靠的关键词，
        而表格的表头虽然也有，但块被切到第二块时表头是复制出来的、权重不一样。
        """
        names = "、".join(item.name for item in self.series)
        parts = [f"{len(self.series)} 个系列（{names}）", f"{len(self.indexes)} 个数据点"]
        ranges = [text for text in (_value_range(item) for item in self.series) if text]
        if ranges:
            parts.append("；".join(ranges))
        if self.truncated:
            parts.append(f"数据点过多，只取前 {MAX_CHART_POINTS} 个")
        return "，".join(parts)


def _value_range(series: ChartSeries) -> str:
    """`收入 100–300`。非数值的点（合计行、空串）不参与范围。"""
    numbers: list[float] = []
    for raw in series.values.values():
        try:
            numbers.append(float(raw.replace(",", "")))
        except ValueError:
            continue
    if not numbers:
        return ""
    low, high = min(numbers), max(numbers)
    if low == high:
        return f"{series.name} {_number(low)}"
    return f"{series.name} {_number(low)}–{_number(high)}"


def _number(value: float) -> str:
    """`300.0` → `300`：摘要里带一堆 `.0` 读起来像精度丢了。"""
    return str(int(value)) if value == int(value) else f"{value:g}"


def _as_int(raw: str | None, fallback: int) -> int:
    try:
        return int(raw or "")
    except ValueError:
        return fallback


def _title(chart: ET.Element) -> str:
    """图表标题。

    只找 `c:chart` 的**直接**子节点：坐标轴标题（`c:catAx/c:title`）也在
    `c:title` 这个标签名下，用 `.//` 会把「月份」当成图表标题。
    """
    node = chart.find(_C + "title")
    if node is None:
        return ""
    text = "".join(item.text or "" for item in node.iter(_A + "t"))
    return " ".join(text.split())[:_TITLE_MAX]


def _cache_points(holder: ET.Element) -> dict[int, str]:
    """`c:numRef` / `c:strRef` / `c:multiLvlStrRef` 里的缓存点。

    三种缓存都要认（同一张图里可能混着）：数值轴是 `numCache`，文本类别是
    `strCache`，多级分类（「2024 / Q1」两层表头）是 `multiLvlStrCache`。
    多级时**只取最细那一层**（点最多的 `c:lvl`）—— 取汇总层会让整列变成
    「2024」「2024」「2024」，看不出是哪个季度。
    """
    for tag in ("numCache", "strCache", "multiLvlStrCache"):
        cache = holder.find(f".//{_C}{tag}")
        if cache is None:
            continue
        levels = cache.findall(_C + "lvl")
        points = (levels[-1].findall(_C + "pt") if levels else None) or cache.findall(_C + "pt")
        out: dict[int, str] = {}
        for position, point in enumerate(points):
            value = (point.findtext(_C + "v") or "").strip()
            if value == "":
                # 空单元格在图表里是 `<c:pt idx="3"><c:v></c:v>` 或缺整个 pt：
                # 保留空格子会把「这一格没有数」显示成 0
                continue
            out[_as_int(point.get("idx"), position)] = value
        if out:
            return out
    return {}


def _series_name(node: ET.Element) -> str:
    """系列名：`c:tx/c:strRef/…/c:v`（引用单元格）或 `c:tx/c:v`（字面量）。"""
    holder = node.find(_C + "tx")
    if holder is None:
        return ""
    literal = holder.find(_C + "v")
    if literal is not None and (literal.text or "").strip():
        return " ".join((literal.text or "").split())[:_TITLE_MAX]
    cached = _cache_points(holder)
    return " ".join(next(iter(cached.values()), "").split())[:_TITLE_MAX]


def _series_points(node: ET.Element, keys: tuple[str, ...]) -> dict[int, str]:
    """按候选路径取一列数据：柱/饼/线是 `c:cat` + `c:val`，散点是 `c:xVal` + `c:yVal`。"""
    for key in keys:
        holder = node.find(_C + key)
        if holder is None:
            continue
        points = _cache_points(holder)
        if points:
            return points
    return {}


def parse_chart(xml: bytes) -> ChartData | None:
    """一份 `chartN.xml` → `ChartData`；没有可用数值时返回 `None`。

    返回 `None` 而不是空表：调用方据此给出「这个图表没有缓存数值」的提示，
    而不是往正文里塞一张只有表头的空表（那张表看着像数据丢了）。
    """
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None

    # 正常是 `c:chartSpace/c:chart`；有些生成器只写 `c:chartSpace`，
    # 这时退回根节点 —— 下面的 `iter` / `find` 都是相对搜索，两种都能命中
    chart = root.find(_C + "chart")
    if chart is None:
        chart = root
    series: list[ChartSeries] = []
    categories: dict[int, str] = {}
    truncated = False

    nodes = list(chart.iter(_C + "ser"))
    if len(nodes) > MAX_CHART_SERIES:
        truncated = True
        nodes = nodes[:MAX_CHART_SERIES]

    for index, node in enumerate(nodes):
        values = _series_points(node, ("val", "yVal"))
        if not values:
            continue
        if not categories:
            categories = _series_points(node, ("cat", "xVal"))
        series.append(ChartSeries(name=_series_name(node) or f"系列 {index + 1}", values=values))

    if not series:
        return None

    indexes = sorted({*categories, *(key for item in series for key in item.values)})
    if len(indexes) > MAX_CHART_POINTS:
        indexes = indexes[:MAX_CHART_POINTS]
        truncated = True

    return ChartData(
        title=_title(chart),
        indexes=indexes,
        categories=categories,
        series=series,
        truncated=truncated,
    )
