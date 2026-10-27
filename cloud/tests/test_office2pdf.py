"""Office → PDF：用**真的 Office** 转**真的文件**。

这一组是「预览能不能用」的最终判据：前面 `test_kb_files.py` 把 `render_pdf` 换掉了，
只证明状态机对；真正会不会转，只有让 Office 自己走一遍才算数。

三条现实约束（都体现成 skip）：

1. 这一组**只覆盖 Windows COM 后端**：需要 Windows + 装了 Office + 装了 pywin32，
   否则跳过。Linux/LibreOffice 那条路由 `test_render_backend.py`（纯逻辑）与
   `docker/verify.py`（容器内真转真文件）兜住；
2. 夹具用 Office 自己生成（`Word.Application` 写 docx、`Excel.Application` 写 xlsx）：
   **手写的最小 OOXML 转不了** —— Word 会报「文件可能已经损坏」，那是夹具的锅，
   不是代码的锅。这一点踩过，所以夹具宁可慢也要真；
3. 慢：Office 三件套各启动一次 + 四次转换，整组约 **90 秒**。这笔钱值得花
   —— 它是「预览真能用」的唯一判据；但要清楚它拖慢的是整个 cloud 套件。

⚠️ 不要把这组用例塞进「每次提交都跑」的快速回路：它需要一个有桌面会话的 Windows。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

from app.kb.office2pdf import SUPPORTED_SUFFIXES, ConvertError, backend, convert
from app.kb.render import (
    RenderFailed,
    RenderUnavailable,
    is_available,
    is_convertible,
    render_pdf,
)

pytestmark = pytest.mark.skipif(
    backend() != "com", reason="这组只验 Windows COM 后端（需要 Office + pywin32）"
)

win32 = pytest.importorskip("win32com.client", reason="需要 pywin32")
pythoncom = pytest.importorskip("pythoncom", reason="需要 pywin32")


def _com(build):
    """在 COM 已初始化的环境里跑一段代码（`convert()` 自己也会初始化，这里给夹具用）。

    ⚠️ 刻意**不**在这里 `CoUninitialize()`：`build()` 里的 Dispatch 对象未必已被回收，
    带着活着的 COM 引用反初始化会抛 `RPC_S_CALL_FAILED`（0x800706be）—— 那是一次
    Windows 致命异常，会把 pytest 输出冲成一屏栈帧（用例其实还是过的，但没人愿意看）。
    泄漏一个 apartment 对 pytest 进程没有影响。
    """
    pythoncom.CoInitialize()
    return build()


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory: pytest.TempPathFactory) -> dict[str, bytes]:
    """用 Office 生成一份真实的 pptx / docx / xlsx。"""
    base: Path = tmp_path_factory.mktemp("office")

    def build() -> dict[str, bytes]:
        word = win32.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        document = word.Documents.Add()
        document.Content.Text = "差旅制度\n\n第一条 报销流程走财务邮箱。"
        document.SaveAs2(str(base / "a.docx"), FileFormat=16)
        document.Close(SaveChanges=False)
        word.Quit()

        excel = win32.DispatchEx("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        book = excel.Workbooks.Add()
        sheet = book.Worksheets(1)
        sheet.Cells(1, 1).Value = "姓名"
        sheet.Cells(1, 2).Value = "年龄"
        sheet.Cells(2, 1).Value = "张三"
        sheet.Cells(2, 2).Value = 30
        book.SaveAs(str(base / "a.xlsx"), FileFormat=51)
        book.Close(SaveChanges=False)
        excel.Quit()

        powerpoint = win32.DispatchEx("PowerPoint.Application")
        deck = powerpoint.Presentations.Add()
        slide = deck.Slides.Add(1, 12)  # ppLayoutBlank
        slide.Shapes.AddTextbox(1, 40, 40, 600, 120).TextFrame.TextRange.Text = "季度的重点"
        deck.SaveAs(str(base / "a.pptx"), 24)  # ppSaveAsOpenXMLPresentation
        deck.Close()
        powerpoint.Quit()

        return {
            ".docx": (base / "a.docx").read_bytes(),
            ".xlsx": (base / "a.xlsx").read_bytes(),
            ".pptx": (base / "a.pptx").read_bytes(),
        }

    return _com(build)


def test_every_office_type_converts(fixtures: dict[str, bytes]) -> None:
    """三类都要能转出**结构合法**的 PDF（不是空文件、也不是 0 页）。"""
    pypdf = pytest.importorskip("pypdf", reason="校验页数要用 pypdf")

    import io

    for suffix in (".docx", ".xlsx", ".pptx"):
        pdf, elapsed = render_pdf(fixtures[suffix], suffix)

        assert pdf.startswith(b"%PDF"), suffix
        assert len(pdf) > 800, suffix
        assert elapsed >= 0, suffix
        pages = len(pypdf.PdfReader(io.BytesIO(pdf)).pages)
        assert pages >= 1, suffix


def test_pdf_is_its_own_preview(tmp_path: Path) -> None:
    """PDF 直通：不拉 Office、不重编码（否则每次打开都要等几秒）。"""
    source = b"%PDF-1.4\n% already a pdf\n"

    pdf, elapsed = render_pdf(source, ".pdf")

    assert pdf == source
    assert elapsed == 0


def test_unsupported_suffix_is_not_an_error(tmp_path: Path) -> None:
    """纯文本不需要预览：这是「不支持」，不是「失败」（前端退回正文即可）。"""
    assert is_convertible(".md") is False
    with pytest.raises(RenderUnavailable):
        render_pdf(b"hello", ".md")


def test_corrupt_office_file_fails_loudly(tmp_path: Path) -> None:
    """坏文件必须**报错**，不能回一个空 PDF（那会让前端画出一片白）。"""
    with pytest.raises((RenderFailed, ConvertError)):
        render_pdf(b"not a real pptx at all", ".pptx")


def test_convert_rejects_unknown_suffix(tmp_path: Path) -> None:
    source = tmp_path / "a.xyz"
    source.write_bytes(b"x")
    with pytest.raises(ConvertError):
        convert(source, tmp_path / "out.pdf")


def test_converters_cover_legacy_office() -> None:
    """旧版 `.doc/.xls/.ppt` 也在能力声明里（解析入口会拒收，但预览这一层能转）。"""
    assert SUPPORTED_SUFFIXES >= {".pptx", ".docx", ".xlsx", ".doc", ".xls", ".ppt"}


def test_availability_matches_the_detected_backend() -> None:
    """能力判定跟着 `backend()` 走，**不绑平台**。

    这条以前写的是「非 Windows 上必须 False」。容器化之后它不成立了：
    Linux + LibreOffice 是正常部署形态，那时的正确答案是 True。真正的判据是
    「`is_available()` 与探测结果一致」—— 绑定平台反而会掩盖探测写错的情况。
    """
    assert is_available() is (backend() != "")
    if sys.platform != "win32" and shutil.which("soffice") is None:
        assert is_available() is False
