"""文档解析：把上传的文件变成纯文本（FR-4.7 的「解析」这一步）。

## 支持矩阵与「为什么这个能、那个不能」

| 后缀 | 实现 | 依赖 |
| --- | --- | --- |
| `.txt` / `.md` / `.csv` | 解码（UTF-8 → GB18030） | 标准库 |
| `.docx` | zip 里读 `word/document.xml`：段落 + 表格 + 图片 + 图表 | 标准库 |
| `.xlsx` | 每张工作表 → GFM 表格；图表缓存另算 | 标准库 |
| `.pptx` | 按页取正文 + 表格 + 备注 + SmartArt + 图片 + 图表 | 标准库 |
| `.pdf` | `pypdf` 抽文本层 | **可选依赖**（`pip install pypdf`） |
| `.doc` / `.pdf`（扫描件）/ 图片 | 明确报错，不猜 | —— |

三条判断：

1. **`.docx` 不引 `python-docx`**：docx 就是一个 zip + 一份 OOXML，标准库 `zipfile` +
   `ElementTree` 足够把段落取出来。多一个运行时依赖，换来的只是更省 40 行代码。
2. **`.pdf` 做成可选依赖**：PDF 文本层提取（字体编码、CID、对象流）不是几十行能写对的。
   自己写个"看起来能跑"的抽取器，会把 Word 导出的中文 PDF 抽成乱码——**比不支持更糟**，
   因为用户会以为资料进去了。没装 `pypdf` 时明确回 422 并给出安装命令。
3. **扫描件不假装成功**：没有文本层的 PDF 直接报错（提示先 OCR），而不是入库一篇空文档。
   空文档会静默占用块数，搜索结果里永远不出现，用户只会觉得「传了但搜不到」。

## 文字「藏在别处」的几种情况（都踩过）

Office 文件里正文之外的文字比想象的多：备注页、SmartArt、图表缓存、表格单元格里的图。
它们的共同特征是**幻灯片/段落上只有一个空壳**，内容在独立的 zip 成员里 —— 只遍历
`a:p` / `w:p` 会**静默**少掉一大块，而界面上看不出任何异常（文档照样入库、照样能搜到
别的字）。所以每加一种，同时要有一条「取不到时说出来」的 warning。

## 两个安全上限

- `MAX_UPLOAD_BYTES`：客户端传 base64，解码前先按长度估算，避免把内存打爆。
- `MAX_UNCOMPRESSED_BYTES`：zip 解压炸弹（几 KB 的 docx 解出几 GB 的 XML）。
"""

from __future__ import annotations

import base64
import binascii
import io
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field

from app.kb import charts
from app.kb.assets import PENDING_SCHEME, mime_for_suffix

#: 单个上传文件的上限（原始字节）。
MAX_UPLOAD_BYTES = 8 * 1024 * 1024

#: zip 解压后的上限（防解压炸弹）。
MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024

#: 页面能否上传由这个集合决定；别在别处再抄一份。
SUPPORTED_EXTENSIONS: tuple[str, ...] = (
    ".txt",
    ".md",
    ".csv",
    ".docx",
    ".pdf",
    ".xlsx",
    ".pptx",
)

#: 需要 OCR 才能读的格式。**明确拒绝而不是"不支持"**：用户手里的扫描件、截图
#: 是真实存在的资料，只说"不支持"等于让人去猜该怎么办。
IMAGE_SUFFIXES: tuple[str, ...] = (
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".gif",
    ".webp",
    ".tif",
    ".tiff",
    ".heic",
)

#: 单个表格最多读多少个单元格。防的是"整本台账当知识库"——
#: 那种文件动辄几十万格，读进来既超字数上限又毫无检索价值。
MAX_TABLE_CELLS = 20_000

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
#: 图片在页面里占多大算「内容图」/「背景」。
#:
#: 这套判据来自一份真实课件（40 页培训稿）：162 张图里 **40 张铺满整页**（渐变背景）、
#: **122 张面积 < 15%**（虚线装饰、1.5×0.2 英寸的分隔线、97 字节的发丝线），
#: 中间区间的**一张都没有**。把它们当正文插图逐张插进去，40 页稿子就变成
#: 「文字 + 160 张大图」—— 用户的原话是「上传进知识库排版都乱了」。
#:
#: 阈值取 0.8 / 0.15：一张正常的小示意图约占页面 20%–40%，不会被误伤。
BACKGROUND_AREA_RATIO = 0.8
CONTENT_AREA_RATIO = 0.15

#: 短边小于 0.3 英寸（274320 EMU）一律算装饰：分隔线、下划线、发丝线。
#: 面积判据单独用不够 —— 5.6×0.01 英寸的线面积很小，但 13.3×0.01 的线面积能到 10%。
DECORATIVE_SIDE_EMU = 274_320

#: 读不到 `p:sldSz` 时的页面尺寸（16:9，13.33×7.5 英寸）。只影响背景/装饰的判定，
#: 不影响内容，所以不必报错。
_DEFAULT_SLIDE_AREA = (12_192_000, 6_858_000)

#: 自动命名的图片名（`picture 7` / `图片 1` / `组合 3`）。它们被当成图注时会**显示在
#: 图片下方**并进检索，纯噪声 —— 作者真正写过的「替代文字」（`descr`）才是有用的。
_AUTO_IMAGE_NAME = re.compile(
    r"^(?:picture|image|photo|graphic|object|group|shape|rectangle|oval|chart"
    r"|图表|图片|图像|照片|图形|形状|组合|矩形|椭圆|对象|文本框|图|形状)\s*\d*$",
    re.IGNORECASE,
)

_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
#: 兼容性标记：`mc:Choice` 与 `mc:Fallback` 是**同一份内容**的两种写法（见 `_walk_visible`）
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"

#: 图片的两种画法都要认：DrawingML（现代 Word/WPS）与 VML（老版 Word 存的 docx）
_P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
_WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
_V = "{urn:schemas-microsoft-com:vml}"


class ParseError(ValueError):
    """解析失败（**给用户看**的原因，会原样进 422 的 detail）。"""


@dataclass(frozen=True)
class ParsedImage:
    """文档里的一张图。

    `alt` 是它**唯一的检索信号**（图片本体不进切块、不进向量），所以要尽量取到：
    Word 里图的「替代文字」在 `wp:docPr@descr`，PowerPoint 在 `p:cNvPr@descr`。
    """

    data: bytes
    mime: str
    alt: str = ""


@dataclass(frozen=True)
class ParsedDocument:
    text: str
    kind: str
    warnings: list[str] = field(default_factory=list)
    #: 文档里的图片。正文里对应位置是 `![图注](asset-index:<下标>)`，
    #: 入库时换成真正的 `asset:<id>`（见 `kb/assets.py`）。
    images: list[ParsedImage] = field(default_factory=list)


def decode_base64(payload: str) -> bytes:
    """解 base64 并做体积检查。

    `validate=True`：base64 里混进换行 / 空格时直接报错，而不是悄悄跳过——
    悄悄跳过意味着「前端传坏了」会表现为「文件内容少了一截」，更难查。
    """
    # 先按长度估算：base64 是 4/3 膨胀，超限就不必真的解码
    if len(payload) * 3 // 4 > MAX_UPLOAD_BYTES:
        raise ParseError(f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 上限")
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ParseError(f"文件内容不是合法的 base64：{error}") from error
    if len(data) > MAX_UPLOAD_BYTES:
        raise ParseError(f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 上限")
    return data


def parse_document(filename: str, data: bytes) -> ParsedDocument:
    """按后缀分派；不认识的后缀直接报错（不猜内容格式）。"""
    if not data:
        raise ParseError("文件是空的")
    suffix = _suffix(filename)
    if suffix in (".txt", ".md", ".csv"):
        text, warnings = _decode_text(data)
        return ParsedDocument(text=text, kind="text", warnings=warnings)
    if suffix == ".docx":
        text, warnings, images = _parse_docx(data)
        return ParsedDocument(text=text, kind="docx", warnings=warnings, images=images)
    if suffix == ".pdf":
        text, warnings = _parse_pdf(data)
        return ParsedDocument(text=text, kind="pdf", warnings=warnings)
    if suffix == ".xlsx":
        text, warnings = _parse_xlsx(data)
        return ParsedDocument(text=text, kind="xlsx", warnings=warnings)
    if suffix == ".pptx":
        text, warnings, images = _parse_pptx(data)
        return ParsedDocument(text=text, kind="pptx", warnings=warnings, images=images)
    if suffix in (".doc", ".xls", ".ppt"):
        raise ParseError(
            f"不支持旧版 Office 格式（{suffix}），请另存为 .docx / .xlsx / .pptx / .pdf 再上传"
        )
    if suffix in IMAGE_SUFFIXES:
        # 图片里的文字必须过 OCR 才能变成可检索的文本。我们不做 OCR（需要模型/引擎，
        # 而且识别质量直接决定检索质量），但要把"该怎么办"说清楚。
        raise ParseError(
            f"图片（{suffix}）里的文字需要先 OCR 成文本："
            "① 用系统/在线 OCR 导出 .txt 再上传；② 或在原程序里另存为带文本层的 PDF；"
            "③ 也可以直接把文字粘贴到「正文」框里入库"
        )
    raise ParseError(
        f"不支持的格式：{suffix or '（无后缀）'}；目前支持 {'、'.join(SUPPORTED_EXTENSIONS)}"
    )


def default_title(filename: str) -> str:
    """没给标题时用文件名（去目录、去扩展名）。"""
    name = filename.strip().replace("\\", "/").rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return (name[:dot] if dot > 0 else name).strip()


def _suffix(filename: str) -> str:
    name = filename.strip().replace("\\", "/").rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return "" if dot < 0 else name[dot:].lower()


def _normalize(text: str) -> str:
    """统一换行 + 去掉首尾空白 + 压缩超过两个的连续空行。

    空行是切块的切点（`chunk_text` 按空行分段），多余空行只会切出更多碎块。
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in normalized.split("\n")]
    out: list[str] = []
    for line in lines:
        if line == "" and out and out[-1] == "":
            continue
        out.append(line)
    return "\n".join(out).strip()


def _decode_text(data: bytes) -> tuple[str, list[str]]:
    """UTF-8 → GB18030 依次尝试。

    为什么留 GB18030 兜底：国内 Windows 记事本存出来的 `.txt` 十有八九是 GBK，
    只认 UTF-8 的话，用户看到的是「文件是空的」或者一整篇乱码入的库。
    """
    if data.startswith(b"\xef\xbb\xbf"):
        return _normalize(data.decode("utf-8-sig")), []
    for encoding, warning in (
        ("utf-8", ""),
        ("gb18030", "文件不是 UTF-8，已按 GB18030 解码；若正文有乱码，请另存为 UTF-8 后重传"),
    ):
        try:
            text = _normalize(data.decode(encoding))
        except UnicodeDecodeError:
            continue
        if text == "":
            raise ParseError("文件里没有可用的文本")
        return text, ([warning] if warning else [])
    raise ParseError("无法识别文件编码（试过 UTF-8 / GB18030），请另存为 UTF-8 后重传")


def _read_zip_member(zf: zipfile.ZipFile, name: str) -> bytes:
    """读一个 zip 成员，并对解压体积设上限（解压炸弹）。"""
    try:
        info = zf.getinfo(name)
    except KeyError as error:
        raise ParseError(f"文件结构不对：缺少 {name}") from error
    if info.file_size > MAX_UNCOMPRESSED_BYTES:
        raise ParseError("文件解压后过大（疑似异常压缩包），拒绝解析")
    return zf.read(name)


def _parse_docx(data: bytes) -> tuple[str, list[str], list[ParsedImage]]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ParseError("不是有效的 .docx（zip 结构损坏）") from error

    with zf:
        xml = _read_zip_member(zf, "word/document.xml")
        rels = _read_rels(zf, "word/_rels/document.xml.rels")
        try:
            root = ET.fromstring(xml)
        except ET.ParseError as error:
            raise ParseError("docx 正文 XML 解析失败（文件可能已损坏）") from error

        body = root.find(_W + "body")
        if body is None:
            raise ParseError("docx 正文里没有 body 节点（文件结构不对）")

        images: list[ParsedImage] = []
        blocks: list[str] = []
        tables = 0
        for kind, payload in _walk_body(body, zf, rels, "word/", images):
            if kind == "p":
                if payload:
                    blocks.append(str(payload))
                continue
            if kind == "tbl":
                tables += 1
                rows = _docx_table_rows(payload, zf, rels, "word/", images)
                if rows:
                    blocks.append("\n".join(_gfm_table(rows)))
                continue
            # 图片占位：单独成段，前后各留空行（它是一个独立的块）
            blocks.append(str(payload))

        # 图表在 Word 里也是独立部件（`word/charts/chartN.xml`，由 document.xml 的关系
        # 引用）：正文里只有一个 `w:drawing` 壳子，数值全在图表自己身上。
        # ⚠️ 必须在 `with zf` 里做 —— zip 关掉之后再读成员会抛 ValueError。
        chart_stats = _ChartStats()
        blocks.extend(_chart_blocks(zf, _chart_parts(zf, "word/document.xml"), "", chart_stats))

        # 嵌在单元格里的表格不算在 `tables`（`_walk_body` 只产出顶层表格）：
        # 它们已经被压成一行文字，得单独说一声，否则「压扁了」这件事没人知道。
        nested_tables = sum(1 for _ in body.iter(_W + "tbl")) - tables

    if not blocks:
        raise ParseError("docx 里没有可提取的段落（可能只有图片或文本框）")

    warnings: list[str] = []
    if tables:
        warnings.append(
            f"文档含 {tables} 个表格，已转成 Markdown 表格"
            "（合并单元格在 Markdown 里没有语法，内容只保留在左上角那一格）"
        )
    if nested_tables:
        warnings.append(
            f"{nested_tables} 个表格嵌在单元格里，已压成一行文字"
            "（格与格用「 | 」、行与行用「；」隔开 —— Markdown 不支持嵌套表格）"
        )
    if images:
        warnings.append(f"文档含 {len(images)} 张图片，已随文入库（图片只按图注参与检索）")
        warnings.extend(_caption_warnings(images))
    warnings.extend(_chart_warnings(chart_stats))
    return _normalize("\n\n".join(blocks)), warnings, images


def _walk_body(
    node: ET.Element,
    zf: zipfile.ZipFile,
    rels: dict[str, str],
    base: str,
    images: list[ParsedImage],
) -> Iterator[tuple[str, object]]:
    """按**文档顺序**产出 `("p", 文本)`、`("tbl", 表格节点)`、`("img", 占位)`。

    不能再用 `root.iter(w:p)`：表格单元格里也是 `w:p`，那样遍历会把表格拍平成一串
    段落 —— `| 张三 | 30 |` 的行列关系彻底消失，表格变成「张三」「30」两个独立段落，
    检索时「年龄」和「30」再也对不上。

    未知的包装层（`w:sdt` 内容控件、`w:sdtContent`）必须递归穿透，
    否则被控件包住的整段正文读不到。
    """
    for child in node:
        # `mc:Fallback` 是同一份内容的备份写法，读它等于把每个文本框都读两遍
        if child.tag == _MC + "Fallback":
            continue
        if child.tag == _W + "p":
            yield ("p", _run_text(child))
            # 段落里的图排在这一段**之后**：图注是它唯一的检索信号，
            # 紧跟着它所在的段落，模型才分得清「这张图说的是哪一段」
            for image in _paragraph_images(child, zf, rels, base):
                images.append(image)
                yield ("img", _image_placeholder(image, len(images) - 1))
        elif child.tag == _W + "tbl":
            yield ("tbl", child)
        elif len(child):
            yield from _walk_body(child, zf, rels, base, images)


def _docx_table_rows(
    table: ET.Element,
    zf: zipfile.ZipFile,
    rels: dict[str, str],
    base: str,
    images: list[ParsedImage],
) -> list[list[str]]:
    """`w:tbl` → 行列表。

    `w:gridSpan` 是横向合并：GFM 没有合并语法，内容留在第一格，其余补空占位 ——
    不补的话后面的格子会整体左移，「这一行只有 3 格」变成假的。

    **单元格里的图片也要取**：台账类文档常把截图/示意图直接放进表格。原来只读
    `w:t`，那些图连占位都没有 —— 图和图注一起静默消失，而界面上看不出任何异常。
    占位写在单元格文本里（`| ![图注](asset-index:0) |`），GFM 允许格内是行内 Markdown。
    """
    rows: list[list[str]] = []
    for row in table.findall(_W + "tr"):
        cells: list[str] = []
        for cell in row.findall(_W + "tc"):
            span = 1
            properties = cell.find(_W + "tcPr")
            if properties is not None:
                grid = properties.find(_W + "gridSpan")
                if grid is not None:
                    try:
                        span = max(1, int(grid.get(_W + "val") or "1"))
                    except ValueError:
                        span = 1
            cells.append(_docx_cell_text(cell, zf, rels, base, images))
            cells.extend([""] * (span - 1))
        if any(cell for cell in cells):
            rows.append(cells)
    return rows


def _docx_cell_text(
    cell: ET.Element,
    zf: zipfile.ZipFile,
    rels: dict[str, str],
    base: str,
    images: list[ParsedImage],
) -> str:
    """一格的内容：段落文字 + 这一格里的图片占位 + 嵌套表格（**按文档顺序**）。

    `w:tc` 的子节点是段落和（可能有的）嵌套表格混排，所以要按 child 顺序走，
    不能只 `findall(w:p)` —— 那样嵌套在格子里的整张表会**整体消失**（连占位都没有，
    比图片更隐蔽：图片至少还有图注可循）。
    """
    parts: list[str] = []
    for child in _cell_blocks(cell):
        if child.tag == _W + "p":
            text = _run_text(child)
            if text:
                parts.append(text)
            for image in _paragraph_images(child, zf, rels, base):
                images.append(image)
                parts.append(_image_placeholder(image, len(images) - 1))
        elif child.tag == _W + "tbl":
            nested = _nested_table_text(child, zf, rels, base, images)
            if nested:
                parts.append(nested)
    return " ".join(parts)


def _cell_blocks(cell: ET.Element) -> Iterator[ET.Element]:
    """单元格里的块级子节点（段落 / 嵌套表格），穿透 `mc:Choice`、跳过 `mc:Fallback`。"""
    for child in cell:
        if child.tag == _MC + "Fallback":
            continue
        if child.tag in (_W + "p", _W + "tbl"):
            yield child
        elif len(child):
            yield from _cell_blocks(child)


def _nested_table_text(
    table: ET.Element,
    zf: zipfile.ZipFile,
    rels: dict[str, str],
    base: str,
    images: list[ParsedImage],
) -> str:
    """单元格里的嵌套表格 → 一行文字：格与格用 ` | `，行与行用 `；`。

    GFM **没有嵌套表格**：硬塞进外层单元格会破坏整张表的结构，直接跳过则内容全丢。
    压成一行是折中 —— 两个边界都还在（看得出来「这属于哪一格」「换行了」），
    代价是样式和层级没了。这一点由 `_parse_docx` 的 warning 明说。
    """
    rows: list[str] = []
    for row in table.findall(_W + "tr"):
        cells = [_docx_cell_text(cell, zf, rels, base, images) for cell in row.findall(_W + "tc")]
        if any(cells):
            rows.append(" | ".join(cells))
    return "；".join(rows)


def _gfm_cell(text: str) -> str:
    """单元格文本：换行压成空格（GFM 一格不能有真换行），`|` 转义（否则凭空多一列）。"""
    return " ".join(text.split()).replace("|", "\\|")


def _gfm_table(rows: list[list[str]]) -> list[str]:
    """行列表 → GFM 表格的行。**第一行当表头**（GFM 表格必须有表头）。

    宽度取所有行的**最大值**并给短行补空：按第一行定宽会把右侧的列截掉，
    而「表格右边几列不见了」是最难被发现的丢数据（读者不会知道自己少看了两列）。
    """
    if not rows:
        return []
    width = max(1, max(len(row) for row in rows))

    def line(cells: list[str]) -> str:
        filled = list(cells[:width]) + [""] * (width - len(cells))
        return "| " + " | ".join(_gfm_cell(cell) for cell in filled) + " |"

    return [
        line(rows[0]),
        "| " + " | ".join(["---"] * width) + " |",
        *[line(row) for row in rows[1:]],
    ]


def _walk_visible(node: ET.Element) -> Iterator[ET.Element]:
    """按文档顺序遍历**真正会被渲染**的节点：跳过 `mc:Fallback` 子树。

    Word 给文本框 / 形状写**两份内容** —— `mc:Choice`（现代写法）和 `mc:Fallback`
    （给老版本看的 VML 备份），两份文字一模一样。`iter()` 会把它们都读一遍，
    于是正文里出现「标注文字标注文字」，同一张图也被抽两遍（两个占位、库里两张图）。
    这类重复最难被发现：内容一点没少，只是每处都多了一遍。
    """
    for child in node:
        if child.tag == _MC + "Fallback":
            continue
        yield child
        yield from _walk_visible(child)


def _run_text(paragraph: ET.Element) -> str:
    """取一个段落里的文字：`w:t` 是文本，`w:br` 是换行，`w:tab` 是制表符。

    按文档顺序遍历子节点（而不是 `''.join(p.iter('w:t'))`）：后者会把
    「第一行 + 第二行」粘成一行，段内的软换行（Shift+Enter）因此消失。
    走 `_walk_visible` 而不是 `iter()`：文本框的 `mc:Fallback` 备份不能再读一遍。
    """
    parts: list[str] = []
    for node in _walk_visible(paragraph):
        if node.tag == _W + "t":
            parts.append(node.text or "")
        elif node.tag == _W + "br":
            parts.append("\n")
        elif node.tag == _W + "tab":
            parts.append(" ")
    return "".join(parts).strip()


def _parse_pdf(data: bytes) -> tuple[str, list[str]]:
    try:
        from pypdf import PdfReader  # 可选依赖
    except ImportError as error:
        raise ParseError(
            "服务端未安装 PDF 解析依赖：请执行 "
            "`pip install -i https://pypi.org/simple pypdf` 后重启服务，"
            "或把 PDF 另存为 .docx / .txt 再上传"
        ) from error

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as error:  # noqa: BLE001 —— pypdf 的异常类型不统一
        raise ParseError(f"PDF 无法打开：{error}") from error

    if reader.is_encrypted:
        # 空密码试试：有些 PDF 只是"限制编辑"，读取无需密码
        try:
            reader.decrypt("")
        except Exception as error:  # noqa: BLE001
            raise ParseError("PDF 有打开密码，无法解析；请上传未加密的版本") from error

    pages_text: list[str] = []
    empty_pages = 0
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 —— 单页坏不该毁掉整篇
            text = ""
        if text.strip() == "":
            empty_pages += 1
        pages_text.append(text)

    text = _normalize("\n\n".join(pages_text))
    if text == "":
        raise ParseError(
            "PDF 里没有可提取的文本（多半是扫描件 / 图片页）。请先 OCR，或上传原始文档"
        )

    warnings: list[str] = []
    if empty_pages:
        warnings.append(f"{empty_pages} 页没有文本层（可能是图片页），这部分内容不会被检索到")
    return text, warnings


def _sheet_targets(zf: zipfile.ZipFile) -> list[tuple[str, str]]:
    """返回 `[(工作表名, zip 内路径)]`，顺序与工作簿里一致。

    为什么必须读 rels 而不是猜 `xl/worksheets/sheet1.xml`：sheet 的**序号**
    与它在工作簿里的**位置**不成正比（删除/重排之后 common 是 sheet3 排在第一位）。
    猜路径的结果是"表格读出来了，但内容对应错了工作表名"——比读不出来更难发现。
    """
    workbook = ET.fromstring(_read_zip_member(zf, "xl/workbook.xml"))
    rels = ET.fromstring(_read_zip_member(zf, "xl/_rels/workbook.xml.rels"))
    by_id = {
        node.get("Id", ""): node.get("Target", "")
        for node in rels.iter()
        if node.tag.endswith("Relationship")
    }

    out: list[tuple[str, str]] = []
    for sheet in workbook.iter(_S + "sheet"):
        name = sheet.get("name", "") or "工作表"
        rel_id = sheet.get(_REL + "id", "")
        target = by_id.get(rel_id, "")
        if not target:
            continue
        # rels 里的 Target 相对 `xl/`，也可能写成绝对路径（开头带 /）
        path = target.lstrip("/") if target.startswith("/") else f"xl/{target}"
        out.append((name, path.replace("/./", "/")))
    return out


def _cell_text(cell: ET.Element, shared: list[str]) -> str:
    kind = cell.get("t", "")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(_S + "t")).strip()
    value = cell.find(_S + "v")
    raw = (value.text or "") if value is not None else ""
    if kind == "s":
        # 共享字符串：`<v>` 里是下标
        try:
            return shared[int(raw)].strip()
        except (ValueError, IndexError):
            return ""
    return raw.strip()


def _parse_xlsx(data: bytes) -> tuple[str, list[str]]:
    """把每张工作表转成一个 **Markdown 表格**。

    为什么不摊成「一行一段」：那样 `张三 | 30 | 是` 里没有「年龄」「在职」这两个词，
    用户搜「年龄」一个词都命中不了（表头在第一行，离得太远）。转成 GFM 表格之后，
    切块器会把整表放在一块、检索投影会把表头拼进每一行 —— 是「能不能搜到」的差别，
    不是排版差别。

    两个必须处理的细节：

    - **按 `r` 定位列号**：Excel 里空单元格在 XML 里**直接缺失**，按出现顺序取值
      会让后面的列整体左移（「这一行只有 3 个值」其实是 5 列里有 2 列空着）。
    - **第一行当表头**：GFM 表格必须有表头。绝大多数台账的第一行确实是列名，
      少数不是的时候语义也还读得通；这一点写进 warnings。

    公式取的是**缓存值**（`<v>`），不是公式本身：公式文本对检索毫无意义，
    而 Excel 存盘时都会带上最后一次计算的结果。

    图表另算：它的数值几乎总是**照抄单元格**（`.xlsx` 的图表没有自己的数据源），
    所以拼块时先收齐全工作簿的单元格文本，数值全在的图表只留标题与摘要 ——
    否则同一批数字被索引两遍，检索里会出现两条几乎一样的片段。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ParseError("不是有效的 .xlsx（zip 结构损坏）") from error

    with zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            try:
                root = ET.fromstring(_read_zip_member(zf, "xl/sharedStrings.xml"))
                shared = [
                    "".join(node.text or "" for node in item.iter(_S + "t"))
                    for item in root.iter(_S + "si")
                ]
            except ET.ParseError:
                # 共享字符串坏了不该毁掉整篇：降到"只读得到数字列"也比失败强
                shared = []

        # 先把所有工作表读完再拼块：图表要不要出表格，取决于「这些数是不是已经
        # 在**别的工作表**的单元格里了」，所以必须先有全工作簿的单元格文本集合。
        sheets: list[tuple[str, str, list[list[str]] | None]] = []
        cell_texts: set[str] = set()
        cells_read = 0
        truncated = False
        for name, path in _sheet_targets(zf):
            try:
                root = ET.fromstring(_read_zip_member(zf, path))
            except ET.ParseError:
                sheets.append((name, path, None))
                continue
            rows: list[list[str]] = []
            for row in root.iter(_S + "row"):
                cells = list(row.iter(_S + "c"))
                if not cells:
                    continue
                values = _row_values(cells, shared)
                cells_read += sum(1 for value in values if value)
                if cells_read > MAX_TABLE_CELLS:
                    truncated = True
                    break
                if any(value for value in values):
                    rows.append(values)
            cell_texts.update(value for values in rows for value in values if value)
            sheets.append((name, path, rows))
            if truncated:
                break

        blocks: list[str] = []
        chart_stats = _ChartStats()
        for name, path, rows in sheets:
            if rows is None:
                blocks.append(f"【工作表：{name}】\n（这张表解析失败，已跳过）")
                continue
            if rows:
                # 工作表名**单独成段**，不要和表格挤在同一个段落里：
                # 1. `is_table_block` 要求整段都是表格，带前缀行就不成立 → 检索投影
                #    （列名拼进每一行）整个失效；
                # 2. 超长表会因此走进 `_hard_split`（按字符切），切口落在某一行中间，
                #    切出来的两块既不是合法 Markdown、表头也丢了；
                # 3. Markdown 表格前面必须有空行，否则阅读端把它渲染成「一行带竖线的文字」。
                blocks.append(f"【工作表：{name}】")
                blocks.append("\n".join(_gfm_table(rows)))
            # 图表走 工作表 → 绘图 → 图表 两跳关系（图表文件与 sheet 序号无关）。
            # `cell_texts` 用来判重：图表照抄单元格时只留摘要。
            blocks.extend(
                _chart_blocks(
                    zf, _chart_parts(zf, path), f"工作表「{name}」", chart_stats, cell_texts
                )
            )

    if not blocks:
        raise ParseError("表格里没有可提取的内容（可能是空表或只有图表）")

    warnings = ["表格已转成 Markdown 表格，每张工作表的第一行当作表头"]
    if truncated:
        warnings.append(f"表格过大，只读了前 {MAX_TABLE_CELLS} 个单元格")
    warnings.extend(_chart_warnings(chart_stats))
    return _normalize("\n\n".join(blocks)), warnings


def _column_index(cell: ET.Element) -> int | None:
    """`r="C5"` → 2（列下标）。`A`→0、`Z`→25、`AA`→26。"""
    letters = "".join(char for char in (cell.get("r") or "") if char.isalpha())
    if not letters:
        return None
    index = 0
    for char in letters.upper():
        index = index * 26 + (ord(char) - 64)
    return index - 1


def _row_values(cells: list[ET.Element], shared: list[str]) -> list[str]:
    """一行 → 按**列号**对齐的值列表（缺的格子补空串）。

    Excel 里没有内容的单元格在 XML 里根本不出现，所以「第 3 个 `<c>`」不等于
    「第 3 列」。按 `r` 属性定位才不会让整行左移。
    """
    positions = [_column_index(cell) for cell in cells]
    known = [position for position in positions if position is not None]
    width = (max(known) if known else len(cells) - 1) + 1
    values = [""] * width
    for cell, position in zip(cells, positions, strict=True):
        if position is None or position >= len(values):
            continue
        values[position] = _cell_text(cell, shared)
    return values


def _parse_pptx(data: bytes) -> tuple[str, list[str], list[ParsedImage]]:
    """按页提取幻灯片正文，**并把页里的图、备注、SmartArt 一起抽出来**。

    排序按**文件名里的数字**，不按字典序：`slide10.xml` 字典序会排在 `slide2.xml`
    之前，症状是"第 10 页的内容跑到第 2 页前面"——检索照样能用，但引用顺序是乱的。

    三样东西都不在 `a:p` 里，要各自走一遍：
    - 图片：`p:pic → a:blip r:embed`（页级，不在段落里）；
    - 演讲者备注：`ppt/notesSlides/notesSlideN.xml`（经页的关系找到）；
    - SmartArt：`ppt/diagrams/dataN.xml`（页上只有一个 `p:graphicFrame` 壳）。

    幻灯片里的**表格**（`a:tbl`）单独转成 GFM 表格：它的单元格段落虽然也在 `a:p`
    里，但拍平之后行列关系就没了 —— 所以那些段落要从正文里**排除**掉，否则同一批
    字会进正文一遍、进表格一遍。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ParseError("不是有效的 .pptx（zip 结构损坏）") from error

    with zf:
        names = [
            item
            for item in zf.namelist()
            if item.startswith("ppt/slides/slide") and item.endswith(".xml")
        ]
        names.sort(key=lambda item: int("".join(ch for ch in item if ch.isdigit()) or 0))
        if not names:
            raise ParseError("这份 .pptx 里没有幻灯片")

        blocks: list[str] = []
        images: list[ParsedImage] = []
        chart_stats = _ChartStats()
        slide_stats = _SlideStats()
        area = _slide_area(zf)
        for index, name in enumerate(names, start=1):
            try:
                root = ET.fromstring(_read_zip_member(zf, name))
            except ET.ParseError:
                continue
            paragraphs: list[str] = []
            tables = list(root.iter(_A + "tbl"))
            # 表格单元格里的段落要**排除**在正文之外：否则同一批字会被读两遍
            # （一遍拍平进正文、一遍进 GFM 表格）—— 那正是「表格既想保留结构、
            # 又漏了原路径」时最容易出现的重复。
            in_table = {id(paragraph) for table in tables for paragraph in table.iter(_A + "p")}
            for paragraph in root.iter(_A + "p"):
                if id(paragraph) in in_table:
                    continue
                text = _paragraph_text(paragraph)
                if text:
                    paragraphs.append(text)
            rels = _read_rels(zf, _rels_path(name))
            for image in _slide_images(root, zf, rels, area, slide_stats):
                images.append(image)
                paragraphs.append(_image_placeholder(image, len(images) - 1))
            if paragraphs:
                blocks.append(f"【第 {index} 页】\n" + "\n".join(paragraphs))
            # 表格保留行列结构（`a:tc` 在合并处也照样占位，所以列不会错位）
            table_blocks, merged = _slide_tables(tables, f"第 {index} 页 · ")
            blocks.extend(table_blocks)
            slide_stats.tables += len(table_blocks)
            slide_stats.merged_tables += merged
            # 备注与 SmartArt 各自成块：它们讲的是同一页，但不能和正文粘成一行。
            # 备注里与**本页正文重复**的行直接丢掉：讲稿常是正文的复制，入两遍会让
            # 同一页在检索结果里出现两条几乎一样的片段（同 `.xlsx` 图表与单元格的判重）。
            known = set(paragraphs)
            notes = [line for line in _slide_notes(zf, name) if line not in known]
            if notes:
                slide_stats.notes += 1
                blocks.append(f"【第 {index} 页 · 演讲者备注】\n" + "\n".join(notes))
            diagram = _slide_diagram_text(zf, name)
            if diagram:
                slide_stats.diagrams += 1
                blocks.append(f"【第 {index} 页 · 图示文字】\n" + "\n".join(diagram))
            # 图表单独成块（表格必须是自己的段落，否则 `is_table_block` 认不出来）
            blocks.extend(
                _chart_blocks(zf, _chart_parts(zf, name), f"第 {index} 页 · ", chart_stats)
            )

    if not blocks:
        raise ParseError(
            "幻灯片里没有可提取的文字（可能整份都是图片）。"
            "图文类幻灯片建议先导出为文本，或把要点粘贴到「正文」框里"
        )
    warnings: list[str] = []
    if images:
        warnings.append(f"幻灯片含 {len(images)} 张图片，已随文入库（图片只按图注参与检索）")
        warnings.extend(_caption_warnings(images))
    if slide_stats.decorative_images:
        warnings.append(
            f"已跳过 {slide_stats.decorative_images} 张版式图片"
            "（铺满整页的背景、分隔线、小图标）—— 它们插进正文只会把版面打散；"
            "确实要入库的图，请在 PowerPoint 里右键图片→「编辑替代文字」写一句说明后重传"
        )
    if slide_stats.tables:
        warnings.append(f"幻灯片含 {slide_stats.tables} 个表格，已转成 Markdown 表格")
    if slide_stats.merged_tables:
        warnings.append(
            f"{slide_stats.merged_tables} 个表格含合并单元格，内容只保留在左上角那一格"
            "（Markdown 没有合并语法）"
        )
    warnings.extend(_chart_warnings(chart_stats))
    return _normalize("\n\n".join(blocks)), warnings, images


@dataclass
class _SlideStats:
    """幻灯片里「正文之外」的文字统计，只用来拼 warnings。"""

    notes: int = 0
    diagrams: int = 0
    tables: int = 0
    merged_tables: int = 0
    #: 按背景/装饰跳过、没有进正文的图片数
    decorative_images: int = 0


#: 备注页里**不是**备注文字的占位：幻灯片缩略图、页码、页眉页脚与日期。
#: ⚠️ 一律小写：比较时会把 `p:ph@type` 转小写，而 Office 写的是驼峰（`sldNum`）。
_NOTE_SKIP_PLACEHOLDERS = frozenset({"sldnum", "sldimg", "hdr", "ftr", "dt"})


def _shape_paragraphs(root: ET.Element, *, skip: frozenset[str]) -> list[str]:
    """按形状取段落文字，跳过指定类型的占位符。

    为什么不直接 `root.iter(a:p)`：备注页里还有「幻灯片缩略图」和「页码」占位符，
    后者的文字是 `<a:fld>` 拼出来的页码 —— 一起读进来，每页备注末尾都会多出一个
    `3`，而它看起来就像备注的最后一句。
    """
    lines: list[str] = []
    for shape in root.iter(_P + "sp"):
        placeholder = shape.find(f"{_P}nvSpPr/{_P}nvPr/{_P}ph")
        if placeholder is not None and (placeholder.get("type") or "").lower() in skip:
            continue
        for paragraph in shape.iter(_A + "p"):
            text = _paragraph_text(paragraph)
            if text:
                lines.append(text)
    return lines


def _slide_notes(zf: zipfile.ZipFile, slide_part: str) -> list[str]:
    """一页的演讲者备注。

    备注是**独立部件**（`ppt/notesSlides/notesSlideN.xml`），页上没有任何引用它的
    文字 —— 只遍历 `a:p` 永远读不到。而它常常是整页最完整的说明（讲稿），
    对知识库的价值比幻灯片上那几个短句高得多。
    """
    lines: list[str] = []
    for path in _related_parts(zf, slide_part, "/notesSlide"):
        try:
            root = ET.fromstring(_read_zip_member(zf, path))
        except (ParseError, ET.ParseError):
            continue
        lines.extend(_shape_paragraphs(root, skip=_NOTE_SKIP_PLACEHOLDERS))
    return lines


def _slide_diagram_text(zf: zipfile.ZipFile, slide_part: str) -> list[str]:
    """一页里 SmartArt 的文字（`ppt/diagrams/dataN.xml`）。

    页上只有一个 `p:graphicFrame` 壳，文字全在 data 部件里。同一个标签在 data 里
    会出现多次（文本模型与展示模型各一份），连续重复的只留一次 —— 不去重的话
    一个四节点的图会读成八行，整个块里全是重复词，长度归一化把它压得搜不着。
    """
    lines: list[str] = []
    for path in _related_parts(zf, slide_part, "/diagramData"):
        try:
            root = ET.fromstring(_read_zip_member(zf, path))
        except (ParseError, ET.ParseError):
            continue
        for paragraph in root.iter(_A + "p"):
            text = _paragraph_text(paragraph)
            if text and (not lines or lines[-1] != text):
                lines.append(text)
    return lines


def _slide_tables(tables: list[ET.Element], scope: str) -> tuple[list[str], int]:
    """幻灯片里的表格（`a:tbl`）→ GFM 表格块。返回（块, 含合并单元格的表数）。

    为什么不沿用「拍平进正文」：`| 季度 | 收入 |` 拍平之后是两行独立的字，
    「收入」这一列到底对应哪个季度彻底丢了 —— 和 `.docx` 的表格是同一件事
    （`_docx_table_rows` 的注释里写了为什么不摊成一行一段）。

    一页可能有多个表格，此时标题带上序号：`【第 3 页 · 表格 2】`，
    否则读的人分不清那是同一张表的续页还是另一张表。
    """
    blocks: list[str] = []
    merged = 0
    for position, table in enumerate(tables, start=1):
        rows = _pptx_table_rows(table)
        if not rows:
            continue
        if _has_merged_cells(table):
            merged += 1
        suffix = f" {position}" if len(tables) > 1 else ""
        # 标题单独成段：表格必须是自己的段落，否则 `is_table_block` 认不出来
        # （认不出来 = 不投影 = 列名与值对不上号，见 `_parse_xlsx` 同一处注释）
        blocks.append(f"【{scope}表格{suffix}】")
        blocks.append("\n".join(_gfm_table(rows)))
    return blocks, merged


def _pptx_table_rows(table: ET.Element) -> list[list[str]]:
    """`a:tbl` → 行列表。

    比 `.docx` 省事：合并掉的单元格在 XML 里**照样存在**（`hMerge`/`vMerge` 标记，
    文字空），所以逐 `<a:tc>` 取值天然对齐网格 —— 不需要像 `w:gridSpan` 那样补空位。
    反过来，如果「跳过合并格」，后面的列会整体左移。
    """
    rows: list[list[str]] = []
    for row in table.findall(_A + "tr"):
        cells = [
            " ".join(
                part
                for part in (_paragraph_text(paragraph) for paragraph in cell.iter(_A + "p"))
                if part
            )
            for cell in row.findall(_A + "tc")
        ]
        if any(cells):
            rows.append(cells)
    return rows


def _has_merged_cells(table: ET.Element) -> bool:
    """有没有合并（横向 `gridSpan`/`hMerge`、纵向 `rowSpan`/`vMerge`）。

    只在**真有合并**时才提示：没合并的表格转成 Markdown 是无损的，不该跟着报警。
    """
    for cell in table.iter(_A + "tc"):
        span = cell.get("gridSpan") or ""
        if span.isdigit() and int(span) > 1:
            return True
        if (cell.get("rowSpan") or "").isdigit() and int(cell.get("rowSpan") or "1") > 1:
            return True
        if (cell.get("hMerge") or "") == "1" or (cell.get("vMerge") or "") == "1":
            return True
    return False


def _rel_entries(zf: zipfile.ZipFile, path: str) -> list[tuple[str, str, str]]:
    """读 `*.rels` → `[(Id, Type, Target)]`。

    关系文件不存在（有的生成器不写）不是错误：返回空列表，图片/图表就都取不到，
    但**文字照常入库** —— 不能因为没有关系文件就整篇拒收。
    """
    if path not in zf.namelist():
        return []
    try:
        root = ET.fromstring(_read_zip_member(zf, path))
    except ET.ParseError:
        return []
    return [
        (node.get("Id", ""), node.get("Type", ""), node.get("Target", ""))
        for node in root.iter()
        if node.tag.endswith("Relationship")
    ]


def _read_rels(zf: zipfile.ZipFile, path: str) -> dict[str, str]:
    """`Id` → `Target`（图片引用只关心这两样）。"""
    return {rel_id: target for rel_id, _type, target in _rel_entries(zf, path) if rel_id and target}


def _rel_targets_of_type(zf: zipfile.ZipFile, path: str, suffix: str) -> list[str]:
    """按关系**类型**挑目标（`/image`、`/chart`、`/drawing`）。

    必须按 Type 过滤而不是「Target 里含 charts」：同一个 rels 里 worksheet /
    styles / theme 混在一起，猜路径等于把「读错了文件」伪装成「解析成功」。
    """
    return [
        target
        for _rel_id, rel_type, target in _rel_entries(zf, path)
        if rel_type.endswith(suffix) and target
    ]


def _related_parts(zf: zipfile.ZipFile, part: str, suffix: str) -> list[str]:
    """某个部件（sheet / slide / drawing）→ 它引用的、Type 以 `suffix` 结尾的部件路径。"""
    base = posixpath.dirname(part)
    out: list[str] = []
    for target in _rel_targets_of_type(zf, _rels_path(part), suffix):
        resolved = _resolve_target(f"{base}/" if base else "", target)
        if resolved in zf.namelist() and resolved not in out:
            out.append(resolved)
    return out


def _chart_parts(zf: zipfile.ZipFile, part: str) -> list[str]:
    """一个部件引用到的图表：`chart` 关系是**直接**的（幻灯片）或经 `drawing` 一跳（工作表）。"""
    out = _related_parts(zf, part, "/chart")
    for drawing in _related_parts(zf, part, "/drawing"):
        for path in _related_parts(zf, drawing, "/chart"):
            if path not in out:
                out.append(path)
    return out


@dataclass
class _ChartStats:
    """图表抽取的统计，只用来拼 warnings（**不要**用来判断解析成败）。"""

    with_data: int = 0
    empty: int = 0
    truncated: bool = False
    #: 数值已存在于单元格、因此只保留摘要的图表数
    duplicated: int = 0


def _chart_blocks(
    zf: zipfile.ZipFile,
    parts: list[str],
    scope: str,
    stats: _ChartStats,
    known_texts: set[str] | None = None,
) -> list[str]:
    """图表 → 正文块：**摘要一段 + GFM 表格一块**（两块之间留空行）。

    为什么标题与摘要单独一段、不塞进表格：GFM 表格的第一行必须是表头，标题插不进去；
    而「这个图叫什么」往往比数字更常被搜（用户搜的是「Q3 销售趋势」，不是「300」）。

    `known_texts` 传入「文档里别处已有的文本」（`.xlsx` 的单元格值）时，数值齐全的
    图表**只留摘要** —— 见 `charts.ChartData.is_covered_by` 的理由。
    """
    blocks: list[str] = []
    for path in parts:
        try:
            raw = _read_zip_member(zf, path)
        except ParseError:
            continue
        chart = charts.parse_chart(raw)
        if chart is None:
            stats.empty += 1
            continue
        stats.with_data += 1
        stats.truncated = stats.truncated or chart.truncated
        blocks.append(f"【{scope}图表：{chart.title or '未命名'}】\n{chart.summary()}")
        rows = chart.table()
        if len(rows) <= 1:
            continue
        if known_texts is not None and chart.is_covered_by(known_texts):
            stats.duplicated += 1
            continue
        blocks.append("\n".join(_gfm_table(rows)))
    return blocks


def _chart_warnings(stats: _ChartStats) -> list[str]:
    """图表的降级提示。三条都要说，因为三种情况的处理方式完全不同。"""
    warnings: list[str] = []
    if stats.with_data:
        warnings.append(
            f"已从 {stats.with_data} 个图表里提取数值（图表只有上次保存时的缓存值，"
            "改完数据要重新保存才会更新）"
        )
    if stats.duplicated:
        warnings.append(
            f"{stats.duplicated} 个图表的数值与单元格内容重复，只保留了标题与摘要"
            "（同一批数字不重复入库，否则检索结果会出现两条几乎一样的片段）"
        )
    if stats.empty:
        warnings.append(
            f"{stats.empty} 个图表没有可提取的数值（缓存里是空的，"
            "在 Office 里打开并保存一次就能读到）"
        )
    if stats.truncated:
        warnings.append(f"图表数据量过大，每个图表最多取 {charts.MAX_CHART_POINTS} 个点")
    return warnings


def _resolve_target(base: str, target: str) -> str:
    """rels 里的 Target → zip 内路径。

    Target 有三种写法：相对（`media/image1.png`）、绝对（`/word/media/image1.png`）、
    上跳（`../media/image1.png`）。都见过，按顺序处理。

    上跳必须**真正按目录抵消**（`posixpath.normpath`），不能只把 `../` 三个字符
    剪掉：PowerPoint 的幻灯片关系永远是 `Target="../media/image1.png"`（相对
    `ppt/slides/`），剪掉前缀得到的是 `media/image1.png`，而 zip 里的真实路径是
    `ppt/media/image1.png` —— 于是每张幻灯片图片都「找不到」而被静默跳过。
    """
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(base, target))


def _rels_path(part: str) -> str:
    """`xl/worksheets/sheet1.xml` → `xl/worksheets/_rels/sheet1.xml.rels`。"""
    directory, _, name = part.rpartition("/")
    return f"{directory}/_rels/{name}.rels" if directory else f"_rels/{name}.rels"


def _drawing_alt(node: ET.Element) -> str:
    """图的替代文字：DrawingML 是 `wp:docPr@descr`，PowerPoint 是 `p:cNvPr@descr`。

    取不到时**不拿自动名兜底**：PowerPoint 给没命名的图起 `picture 7`、Word 起
    `图片 1`，那是软件生成的编号，不是作者写的说明。把它当图注的结果是 —— 每张装饰图
    下方都显示一行「picture 7」，还进检索（真机上一份 40 页课件冒出 162 行）。
    作者手写的 `name`（比如「架构总览」）仍然认。
    """
    elements = [element for tag in (_WP + "docPr", _P + "cNvPr") for element in node.iter(tag)]
    for element in elements:
        value = (element.get("descr") or "").strip()
        if value:
            return value[:200]
    for element in elements:
        name = (element.get("name") or "").strip()
        if name and not _AUTO_IMAGE_NAME.match(name):
            return name[:200]
    return ""


#: 纯图标字体：里面的字符是图形（●、■、箭头），不是文字。
#:
#: `Symbol` 刻意**不在**这个名单里 —— 它常用来排希腊字母（π、α），那是有意义的文字。
_ORNAMENT_FONTS: tuple[str, ...] = ("wingdings", "webdings", "marlett")


def _is_ornament_run(run: ET.Element, text: str) -> bool:
    """这个 run 是不是「拿图标字体当项目符号」——中文课件里极常见的写法。

    真机样本（40 页培训稿）里每个要点前都有一个 `Wingdings` 的 `l`，屏幕上显示成 ●，
    读进正文就是「l目前大模型存在的问题」。只认**短 run**（≤3 字符）：图标字体的
    长文本虽然罕见，但宁可留着也不要把整句吃掉。
    """
    if len(text) > 3:
        return False
    latin = run.find(f"{_A}rPr/{_A}latin")
    face = (latin.get("typeface") or "").strip().lower() if latin is not None else ""
    return any(face.startswith(name) for name in _ORNAMENT_FONTS)


#: 中文字符区间：汉字 + CJK 标点（`\u3001-\u303f`，含「」、。，）+ 全角形式 + 弯引号。
#: **不含 U+3000 全角空格** —— 那是作者主动打的缩进，该留着。
_CJK = r"\u3400-\u9fff\uf900-\ufaff\u3001-\u303f\uff01-\uff60\u2018\u2019\u201c\u201d\u2014\u2026"


def _tidy_spacing(text: str) -> str:
    """段内空白规整：中文之间**删掉**，其余位置压成一个空格。

    两类空白都要处理，理由都是检索：

    1. `<a:br/>`（段内硬换行）—— 作者在 PowerPoint 里的换行位置只是窗口宽度；
    2. 整段都是空格的小 run —— 真机课件里有人靠按空格来「手动换行」，
       文本里就留下 `被称` + `"  "` + `为`。

    中文不用空格断词，而这类空白会把「称为」这个双字词从检索里拆掉
    （`retrieval.tokenize` 走的是双字切分）。西文则相反：`hello⏎world`
    必须留一个空格，否则两个单词粘成一个。
    """
    text = re.sub(rf"(?<=[{_CJK}])[ \t\n]+(?=[{_CJK}])", "", text)
    return re.sub(r"[ \t\n]+", " ", text)


def _paragraph_text(paragraph: ET.Element) -> str:
    """DrawingML 段落 `a:p` → 文本。

    两个必须处理的细节：

    - `<a:br/>` 是**段内硬换行**，位置要留下（后面由 `_tidy_spacing` 决定删还是补空格）：
      直接忽略会把「第一行」和「第二行」粘成一个词；
    - 图标字体（Wingdings 等）的单字符是项目符号，不是文字，见 `_is_ornament_run`。

    按 `a:p` 的**直接子节点**顺序走（`a:r` / `a:br` / `a:fld`）：`iter(a:t)` 拿不到
    换行的位置，也分不清哪个 run 用了什么字体。
    """
    parts: list[str] = []
    for child in paragraph:
        if child.tag == _A + "br":
            parts.append("\n")
            continue
        if child.tag not in (_A + "r", _A + "fld"):
            continue
        text = "".join(node.text or "" for node in child.iter(_A + "t"))
        if not text:
            continue
        if child.tag == _A + "r" and _is_ornament_run(child, text):
            continue
        parts.append(text)
    return _tidy_spacing("".join(parts)).strip()


def _escape_alt(text: str) -> str:
    """图注转义：`]` 会提前结束 Markdown 的 alt 段。

    图注里的 `]` 不常见但合法（文件名里就有），不转义的话正文会被截断成
    `![图注` —— 后面整篇都变成图片语法。
    """
    return text.replace("\\", "\\\\").replace("]", "\\]").replace("[", "\\[").strip()


def _image_placeholder(image: ParsedImage, index: int) -> str:
    """图片在正文里的占位：`![图注](asset-index:<下标>)`。"""
    return f"![{_escape_alt(image.alt)}]({PENDING_SCHEME}{index})"


def _caption_warnings(images: list[ParsedImage]) -> list[str]:
    """没有图注的图片要单独说一句 —— 这是**可操作**的提示，不是抱怨。

    图注是图片唯一的检索信号（图片本体不进切块、不进向量）。原件里没有替代文字
    时我们不去猜（「第 1 张图」这种凭空生成的图注只会给检索加噪声），
    但要让用户知道「这部分内容现在搜不到，以及去哪补」。
    """
    missing = sum(1 for image in images if image.alt.strip() == "")
    if missing == 0:
        return []
    return [
        f"{missing} 张图片没有图注，这部分内容搜不到；"
        "打开正文在图片下方补一句说明，保存后就会参与检索"
    ]


def _paragraph_images(
    paragraph: ET.Element, zf: zipfile.ZipFile, rels: dict[str, str], base: str
) -> list[ParsedImage]:
    """段落里的图片。

    两种画法都要认：`<w:drawing><a:blip r:embed>`（DrawingML，现代 Word/WPS）与
    `<w:pict><v:imagedata r:id>`（VML，老版 Word 存出来的 docx 走这条）。

    类型不在白名单（emf / wmf / svg）时**跳过**而不是硬塞：浏览器不认这些格式，
    硬塞进去只会得到一个坏图；SVG 更是 XSS 载体（同源返回就能执行脚本）。
    """
    out: list[ParsedImage] = []
    alt = _drawing_alt(paragraph)
    # `_walk_visible` 跳过 `mc:Fallback`：否则同一张图会被抽两遍（Choice 的 `a:blip`
    # 与 Fallback 的 `v:imagedata` 指向同一个关系 id）
    for node in _walk_visible(paragraph):
        embed = ""
        if node.tag == _A + "blip":
            embed = node.get(_REL + "embed") or ""
        elif node.tag == _V + "imagedata":
            embed = node.get(_REL + "id") or ""
        if not embed:
            continue
        target = rels.get(embed)
        if not target:
            continue
        path = _resolve_target(base, target)
        if path not in zf.namelist():
            continue
        mime = mime_for_suffix(_suffix(path))
        if mime is None:
            continue
        try:
            blob = _read_zip_member(zf, path)
        except ParseError:
            continue
        out.append(ParsedImage(data=blob, mime=mime, alt=alt))
    return out


def _slide_area(zf: zipfile.ZipFile) -> tuple[int, int]:
    """页面尺寸（EMU），来自 `ppt/presentation.xml` 的 `p:sldSz`。

    判「背景 / 内容」要按**面积占比**，所以必须有页面尺寸；读不到就用 16:9 默认值
    （只影响这条判定，不影响取文字，所以不值得整篇报错）。
    """
    try:
        root = ET.fromstring(_read_zip_member(zf, "ppt/presentation.xml"))
    except (ParseError, ET.ParseError):
        return _DEFAULT_SLIDE_AREA
    node = next(root.iter(_P + "sldSz"), None)
    if node is None:
        return _DEFAULT_SLIDE_AREA
    width, height = node.get("cx") or "0", node.get("cy") or "0"
    if not (width.isdigit() and height.isdigit()):
        return _DEFAULT_SLIDE_AREA
    if int(width) <= 0 or int(height) <= 0:
        return _DEFAULT_SLIDE_AREA
    return int(width), int(height)


def _slide_pictures(root: ET.Element) -> Iterator[tuple[ET.Element, bool]]:
    """一页里的所有图片，并标出是否在**顶层**（只有顶层图的尺寸可信）。

    组合（`p:grpSp`）内的图用的是组合内部的子坐标系，可能被整体缩放 —— 直接拿它的
    `a:ext` 判尺寸会判错。这类图一律按「可能是内容」留下：宁可多留几张，
    也不要把用户真想要的图悄悄丢掉。
    """
    tree = root.find(f"{_P}cSld/{_P}spTree")
    if tree is None:
        for picture in root.iter(_P + "pic"):
            yield picture, False
        return
    for child in tree:
        if child.tag == _P + "pic":
            yield child, True
        elif child.tag == _P + "grpSp":
            for picture in child.iter(_P + "pic"):
                yield picture, False


def _picture_ext(picture: ET.Element) -> tuple[int, int] | None:
    """图片在页面上的显示尺寸（EMU）。读不到返回 `None`（判不了尺寸）。"""
    node = picture.find(f"{_P}spPr/{_A}xfrm/{_A}ext")
    if node is None:
        return None
    width, height = node.get("cx") or "", node.get("cy") or ""
    if not (width.isdigit() and height.isdigit()):
        return None
    return int(width), int(height)


def _decoration_reason(ext: tuple[int, int] | None, area: tuple[int, int]) -> str:
    """`''` = 内容图；`'decorative'` = 装饰；`'background'` = 背景。

    三条判据按顺序（尺寸读不到就当内容 —— 判不了不替用户做主）：
    1. 短边 < 0.3 英寸 → 分隔线 / 发丝线 / 小图标；
    2. 面积 ≥ 80% 页面 → 渐变背景、整页底图；
    3. 面积 < 15% 页面 → 点缀图形。
    """
    if ext is None:
        return ""
    width, height = ext
    page = area[0] * area[1]
    if width <= 0 or height <= 0 or page <= 0:
        return ""
    if min(width, height) < DECORATIVE_SIDE_EMU:
        return "decorative"
    ratio = width * height / page
    if ratio >= BACKGROUND_AREA_RATIO:
        return "background"
    if ratio < CONTENT_AREA_RATIO:
        return "decorative"
    return ""


def _slide_images(
    root: ET.Element,
    zf: zipfile.ZipFile,
    rels: dict[str, str],
    area: tuple[int, int],
    stats: _SlideStats,
) -> list[ParsedImage]:
    """一页里的**内容图**（`p:pic` → `a:blip r:embed`）。

    背景与装饰不进正文：真机上一份 40 页课件有 162 张图，其中 40 张铺满整页、122 张
    面积不足 15%（见 `BACKGROUND_AREA_RATIO` 的注释）—— 全插进正文就是「排版都乱了」。
    作者**写过替代文字**的图不受尺寸限制：那说明他确实把这图当内容。
    """
    out: list[ParsedImage] = []
    for picture, top_level in _slide_pictures(root):
        alt = _drawing_alt(picture)
        if top_level and alt == "" and _decoration_reason(_picture_ext(picture), area):
            stats.decorative_images += 1
            continue
        for node in picture.iter(_A + "blip"):
            embed = node.get(_REL + "embed") or ""
            if not embed:
                continue
            target = rels.get(embed)
            if not target:
                continue
            path = _resolve_target("ppt/slides/", target)
            if path not in zf.namelist():
                continue
            mime = mime_for_suffix(_suffix(path))
            if mime is None:
                continue
            try:
                blob = _read_zip_member(zf, path)
            except ParseError:
                continue
            out.append(ParsedImage(data=blob, mime=mime, alt=alt))
    return out
