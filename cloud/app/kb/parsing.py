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
from dataclasses import dataclass, field

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


class ParseError(ValueError):
    """解析失败（**给用户看**的原因，会原样进 422 的 detail）。"""


@dataclass(frozen=True)
class ParsedDocument:
    text: str
    kind: str
    warnings: list[str] = field(default_factory=list)


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
        text, warnings = _parse_docx(data)
        return ParsedDocument(text=text, kind="docx", warnings=warnings)
    if suffix == ".pdf":
        text, warnings = _parse_pdf(data)
        return ParsedDocument(text=text, kind="pdf", warnings=warnings)
    if suffix == ".xlsx":
        text, warnings = _parse_xlsx(data)
        return ParsedDocument(text=text, kind="xlsx", warnings=warnings)
    if suffix == ".pptx":
        text, warnings = _parse_pptx(data)
        return ParsedDocument(text=text, kind="pptx", warnings=warnings)
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


def _parse_docx(data: bytes) -> tuple[str, list[str]]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ParseError("不是有效的 .docx（zip 结构损坏）") from error

    with zf:
        xml = _read_zip_member(zf, "word/document.xml")

    try:
        root = ET.fromstring(xml)
    except ET.ParseError as error:
        raise ParseError("docx 正文 XML 解析失败（文件可能已损坏）") from error

    paragraphs: list[str] = []
    tables = 0
    for node in root.iter():
        if node.tag == _W + "tbl":
            tables += 1
    for paragraph in root.iter(_W + "p"):
        text = _run_text(paragraph)
        if text != "":
            paragraphs.append(text)

    if not paragraphs:
        raise ParseError("docx 里没有可提取的段落（可能只有图片或文本框）")

    warnings: list[str] = []
    if tables:
        warnings.append(f"文档含 {tables} 个表格，已按段落展开（单元格之间不保留行列结构）")
    return _normalize("\n\n".join(paragraphs)), warnings


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
    """把工作簿按「一行一段」摊成文本。

    刻意**不保留行列结构**：知识库的检索单位是文本段，`A1|B1|C1` 这种表格形态
    对人和模型都不好读；而"每行拼一句"恰好是表格最常见的语义（一条记录一行）。
    这一点必须写进 warnings —— 丢掉结构是真的丢了信息，不能装作没丢。

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
            lines: list[str] = []
            for row in root.iter(_S + "row"):
                values = [_cell_text(cell, shared) for cell in row.iter(_S + "c")]
                values = [item for item in values if item]
                cells_read += len(values)
                if cells_read > MAX_TABLE_CELLS:
                    truncated = True
                    break
                if values:
                    # 「 | 」而不是制表符：制表符在纯文本里与空格无法区分，
                    # 分隔符必须让人眼也能看出"这是两个格子"
                    lines.append(" | ".join(values))
            if lines:
                blocks.append(f"【工作表：{name}】\n" + "\n".join(lines))
            if truncated:
                break

    if not blocks:
        raise ParseError("表格里没有可提取的内容（可能是空表或只有图表）")

    warnings = ["表格已按行展开为文本，行列结构不保留"]
    if truncated:
        warnings.append(f"表格过大，只读了前 {MAX_TABLE_CELLS} 个单元格")
    return _normalize("\n\n".join(blocks)), warnings


def _parse_pptx(data: bytes) -> tuple[str, list[str]]:
    """按页提取幻灯片正文。

    排序按**文件名里的数字**，不按字典序：`slide10.xml` 字典序会排在 `slide2.xml`
    之前，症状是"第 10 页的内容跑到第 2 页前面"——检索照样能用，但引用顺序是乱的。
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
            if paragraphs:
                blocks.append(f"【第 {index} 页】\n" + "\n".join(paragraphs))

    if not blocks:
        raise ParseError(
            "幻灯片里没有可提取的文字（可能整份都是图片）。"
            "图文类幻灯片建议先导出为文本，或把要点粘贴到「正文」框里"
        )
    return _normalize("\n\n".join(blocks)), ["已提取幻灯片正文；备注、图片与图表里的文字未提取"]
