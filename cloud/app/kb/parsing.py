"""文档解析：把上传的文件变成纯文本（FR-4.7 的「解析」这一步）。

## 支持矩阵与「为什么这个能、那个不能」

| 后缀 | 实现 | 依赖 |
| --- | --- | --- |
| `.txt` / `.md` / `.csv` | 解码（UTF-8 → GB18030） | 标准库 |
| `.docx` | zip 里读 `word/document.xml` 再抽段落 | 标准库 |
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

## 两个安全上限

- `MAX_UPLOAD_BYTES`：客户端传 base64，解码前先按长度估算，避免把内存打爆。
- `MAX_UNCOMPRESSED_BYTES`：zip 解压炸弹（几 KB 的 docx 解出几 GB 的 XML）。
"""

from __future__ import annotations

import base64
import binascii
import io
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field

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
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
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
                rows = _docx_table_rows(payload)
                if rows:
                    blocks.append("\n".join(_gfm_table(rows)))
                continue
            # 图片占位：单独成段，前后各留空行（它是一个独立的块）
            blocks.append(str(payload))

    if not blocks:
        raise ParseError("docx 里没有可提取的段落（可能只有图片或文本框）")

    warnings: list[str] = []
    if tables:
        warnings.append(
            f"文档含 {tables} 个表格，已转成 Markdown 表格"
            "（合并单元格在 Markdown 里没有语法，内容只保留在左上角那一格）"
        )
    if images:
        warnings.append(f"文档含 {len(images)} 张图片，已随文入库（图片只按图注参与检索）")
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


def _docx_table_rows(table: ET.Element) -> list[list[str]]:
    """`w:tbl` → 行列表。

    `w:gridSpan` 是横向合并：GFM 没有合并语法，内容留在第一格，其余补空占位 ——
    不补的话后面的格子会整体左移，「这一行只有 3 格」变成假的。
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
            text = " ".join(part for part in (_run_text(p) for p in cell.findall(_W + "p")) if part)
            cells.append(text)
            cells.extend([""] * (span - 1))
        if any(cell for cell in cells):
            rows.append(cells)
    return rows


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


def _run_text(paragraph: ET.Element) -> str:
    """取一个段落里的文字：`w:t` 是文本，`w:br` 是换行，`w:tab` 是制表符。

    按文档顺序遍历子节点（而不是 `''.join(p.iter('w:t'))`）：后者会把
    「第一行 + 第二行」粘成一行，段内的软换行（Shift+Enter）因此消失。
    """
    parts: list[str] = []
    for node in paragraph.iter():
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

        blocks: list[str] = []
        cells_read = 0
        truncated = False
        for name, path in _sheet_targets(zf):
            try:
                root = ET.fromstring(_read_zip_member(zf, path))
            except ET.ParseError:
                blocks.append(f"【工作表：{name}】\n（这张表解析失败，已跳过）")
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
            if rows:
                blocks.append(f"【工作表：{name}】\n" + "\n".join(_gfm_table(rows)))
            if truncated:
                break

    if not blocks:
        raise ParseError("表格里没有可提取的内容（可能是空表或只有图表）")

    warnings = ["表格已转成 Markdown 表格，每张工作表的第一行当作表头"]
    if truncated:
        warnings.append(f"表格过大，只读了前 {MAX_TABLE_CELLS} 个单元格")
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
    """按页提取幻灯片正文，**并把页里的图一起抽出来**。

    排序按**文件名里的数字**，不按字典序：`slide10.xml` 字典序会排在 `slide2.xml`
    之前，症状是"第 10 页的内容跑到第 2 页前面"——检索照样能用，但引用顺序是乱的。

    图片是**页级**的：`p:pic` 不在 `a:p` 里，所以上面遍历段落的那个循环拿不到它，
    要单独按 `p:pic → a:blip r:embed` 走一遍。
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
        for index, name in enumerate(names, start=1):
            try:
                root = ET.fromstring(_read_zip_member(zf, name))
            except ET.ParseError:
                continue
            paragraphs: list[str] = []
            for paragraph in root.iter(_A + "p"):
                text = "".join(node.text or "" for node in paragraph.iter(_A + "t")).strip()
                if text:
                    paragraphs.append(text)
            rels = _read_rels(zf, f"ppt/slides/_rels/{name.rsplit('/', 1)[-1]}.rels")
            for image in _slide_images(root, zf, rels):
                images.append(image)
                paragraphs.append(_image_placeholder(image, len(images) - 1))
            if paragraphs:
                blocks.append(f"【第 {index} 页】\n" + "\n".join(paragraphs))

    if not blocks:
        raise ParseError(
            "幻灯片里没有可提取的文字（可能整份都是图片）。"
            "图文类幻灯片建议先导出为文本，或把要点粘贴到「正文」框里"
        )
    warnings = ["已提取幻灯片正文；备注与图表里的文字未提取"]
    if images:
        warnings.append(f"幻灯片含 {len(images)} 张图片，已随文入库（图片只按图注参与检索）")
    return _normalize("\n\n".join(blocks)), warnings, images


def _read_rels(zf: zipfile.ZipFile, path: str) -> dict[str, str]:
    """读 `*.rels`：`Id` → `Target`。

    关系文件不存在（有的生成器不写）不是错误：返回空表，图片就都取不到，
    但**文字照常入库** —— 不能因为没有图片关系就整篇拒收。
    """
    if path not in zf.namelist():
        return {}
    try:
        root = ET.fromstring(_read_zip_member(zf, path))
    except ET.ParseError:
        return {}
    out: dict[str, str] = {}
    for node in root.iter():
        if not node.tag.endswith("Relationship"):
            continue
        rel_id = node.get("Id", "")
        target = node.get("Target", "")
        if rel_id and target:
            out[rel_id] = target
    return out


def _resolve_target(base: str, target: str) -> str:
    """rels 里的 Target → zip 内路径。

    Target 有三种写法：相对（`media/image1.png`）、绝对（`/word/media/image1.png`）、
    上跳（`../media/x.png`）。都见过，按顺序处理。
    """
    if target.startswith("/"):
        return target.lstrip("/")
    if target.startswith("../"):
        return target[3:]
    return f"{base}{target}" if base else target


def _drawing_alt(node: ET.Element) -> str:
    """图的替代文字：DrawingML 是 `wp:docPr@descr`，PowerPoint 是 `p:cNvPr@descr`。

    没有就返回空串（图仍然入库，只是检索不到 —— 图注缺失是原件的问题，
    不是我们能补出来的）。
    """
    for tag in (_WP + "docPr", _P + "cNvPr"):
        for element in node.iter(tag):
            for key in ("descr", "name"):
                value = (element.get(key) or "").strip()
                if value:
                    return value[:200]
    return ""


def _escape_alt(text: str) -> str:
    """图注转义：`]` 会提前结束 Markdown 的 alt 段。

    图注里的 `]` 不常见但合法（文件名里就有），不转义的话正文会被截断成
    `![图注` —— 后面整篇都变成图片语法。
    """
    return text.replace("\\", "\\\\").replace("]", "\\]").replace("[", "\\[").strip()


def _image_placeholder(image: ParsedImage, index: int) -> str:
    """图片在正文里的占位：`![图注](asset-index:<下标>)`。"""
    return f"![{_escape_alt(image.alt)}]({PENDING_SCHEME}{index})"


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
    for node in paragraph.iter():
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


def _slide_images(root: ET.Element, zf: zipfile.ZipFile, rels: dict[str, str]) -> list[ParsedImage]:
    """一页里的图片（`p:pic` → `a:blip r:embed`）。"""
    out: list[ParsedImage] = []
    for picture in root.iter(_P + "pic"):
        alt = _drawing_alt(picture)
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
