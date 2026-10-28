"""转换后端的**纯逻辑**判据（不需要 Office，也不需要 LibreOffice）。

为什么单独一组：`test_office2pdf.py` 要真 Office 才能跑，于是在 Linux 容器里整组
跳过 —— 「容器镜像里到底能不能转」就没人守着了。这一组把它们共用的那部分
（能力声明、探测、选路）钉住，任何平台都能跑。

真正「LibreOffice 转得出 PDF 吗」由 `docker/verify.py` 在容器里用真文件验
（真转一次，不 mock）—— 那才是最终判据，和这里的层次不同。
"""

from __future__ import annotations

import pytest

from app.kb import office2pdf, render


def test_supported_suffixes_cover_all_office_kinds() -> None:
    """六种 Office 后缀都要在能力声明里。

    `.pdf` 刻意不在：它自己就是预览，`render_pdf` 会直接返回，不该走转换器。
    """
    assert office2pdf.SUPPORTED_SUFFIXES == {
        ".pptx",
        ".ppt",
        ".docx",
        ".doc",
        ".xlsx",
        ".xls",
    }
    assert office2pdf.PDF_SUFFIX not in office2pdf.SUPPORTED_SUFFIXES


def test_every_supported_suffix_has_a_libreoffice_filter() -> None:
    """声明了的格式必须同时有 LibreOffice 导出 filter。

    这是最容易漏的一步：有人往 `SUPPORTED_SUFFIXES` 加了 `.odt`，忘了往
    `_LO_FILTERS` 加，于是 Windows 上能转、Linux 容器里这一种格式**永远**报
    「不支持转 PDF」。两个集合必须同进同出。
    """
    assert set(office2pdf._LO_FILTERS) == set(office2pdf.SUPPORTED_SUFFIXES)


def test_backend_is_one_of_the_known_values() -> None:
    """探测结果只能是三选一，不能是别的字符串（否则上层 `== "com"` 的判断全落空）。"""
    assert office2pdf.backend() in {"", "com", "libreoffice"}


def test_convert_without_any_backend_fails_loudly(tmp_path, monkeypatch) -> None:
    """两种后端都没有时，报错要说清「是没有转换器」，不能假装成功。"""
    monkeypatch.setattr(office2pdf, "backend", lambda: "")
    source = tmp_path / "a.docx"
    source.write_bytes(b"x")

    with pytest.raises(office2pdf.ConvertError, match="既没有 Office"):
        office2pdf.convert(source, tmp_path / "out.pdf")


def test_convert_rejects_unsupported_suffix_before_touching_backend(tmp_path, monkeypatch) -> None:
    """不支持的格式要在**选路之前**就拒掉（否则 Windows 上会去查 COM 表而 KeyError）。"""
    monkeypatch.setattr(office2pdf, "backend", lambda: "com")
    source = tmp_path / "a.xyz"
    source.write_bytes(b"x")

    with pytest.raises(office2pdf.ConvertError, match="不支持转 PDF"):
        office2pdf.convert(source, tmp_path / "out.pdf")


def test_is_convertible_says_yes_to_pdf_and_no_to_unknown() -> None:
    """`is_convertible` 是路由判「要不要显示原文标签」的依据，两边都不能错。"""
    assert render.is_convertible(".pdf") is True
    assert render.is_convertible(".PDF") is True  # 大小写在路由里统一过 lower()
    assert render.is_convertible(".docx") is True
    assert render.is_convertible(".xyz") is False
    assert render.is_convertible("") is False


def test_render_availability_follows_backend(monkeypatch) -> None:
    """`render.is_available` 必须跟着探测走（两处各写一份判断必然漂移）。"""
    monkeypatch.setattr(render, "backend", lambda: "libreoffice")
    assert render.is_available() is True
    monkeypatch.setattr(render, "backend", lambda: "")
    assert render.is_available() is False


def test_pdf_passes_through_without_conversion(monkeypatch, tmp_path) -> None:
    """PDF 直通：不该因为「没有转换器」而拒绝自己。

    这条容易在重构里丢掉 —— 判据是「有没有转换器」，而 PDF 根本不需要转换器。
    """
    monkeypatch.setattr(render, "backend", lambda: "")
    data = b"%PDF-1.4 minimal"

    assert render.render_pdf(data, ".pdf") == (data, 0)


def test_render_refuses_when_no_backend(monkeypatch) -> None:
    """没有转换器时抛 `RenderUnavailable`（不是 `RenderFailed`）。

    两者在界面上是**不同**的处理：`Unavailable` 连「原文」标签都不出现，
    `Failed` 会留在原文视图给重试。混成一个，用户就会一直点重试。
    """
    monkeypatch.setattr(render, "backend", lambda: "")

    with pytest.raises(render.RenderUnavailable, match="没有可用的文档转换器"):
        render.render_pdf(b"x", ".docx")


# —— `.doc → .docx`（上传解析用）——


def test_docx_target_only_accepts_legacy_doc() -> None:
    """`docx` 目标只收 `.doc`。

    `.docx` / `.txt` 本来就自己解析：让它们绕一趟办公套件，快的变慢、全的变缺，
    而且把「本地能力」变成了「部署环境必须装 Office」——这是纯倒退。
    """
    assert office2pdf._TARGET_SOURCES[office2pdf.TARGET_DOCX] == {".doc"}
    assert office2pdf._TARGET_SOURCES[office2pdf.TARGET_PDF] == office2pdf.SUPPORTED_SUFFIXES


def test_libreoffice_convert_to_matches_the_target() -> None:
    """`--convert-to` 的取值随目标变：PDF 出 PDF、`.doc` 出 docx，其它一律空串（= 不支持）。"""
    assert office2pdf._lo_convert_to(".doc", office2pdf.TARGET_PDF).startswith(
        "pdf:writer_pdf_Export"
    )
    assert office2pdf._lo_convert_to(".doc", office2pdf.TARGET_DOCX).startswith("docx:")
    assert office2pdf._lo_convert_to(".docx", office2pdf.TARGET_DOCX) == ""
    assert office2pdf._lo_convert_to(".md", office2pdf.TARGET_PDF) == ""


def test_writer_pdf_filter_asks_for_bookmarks() -> None:
    """Word 类文件的 PDF 必须显式打开 `ExportBookmarks`。

    LibreOffice 默认**不导出**书签：漏了这段 JSON，容器里转出来的 PDF 一个书签都没有，
    前端大纲面板在所有 Linux 部署上都是空的（Windows 上却正常 —— 最难查的那种差异）。
    """
    for suffix in (".doc", ".docx"):
        value = office2pdf._lo_convert_to(suffix, office2pdf.TARGET_PDF)
        assert "ExportBookmarks" in value, suffix
    # 表格/幻灯片没有"标题书签"这回事，别给它们的 filter 加别的结构
    assert "ExportBookmarks" not in office2pdf._lo_convert_to(".pptx", office2pdf.TARGET_PDF)
    assert "ExportBookmarks" not in office2pdf._lo_convert_to(".xlsx", office2pdf.TARGET_PDF)


def test_docx_conversion_refuses_without_backend(monkeypatch) -> None:
    """`.doc` 的可用性与预览共用同一个探测：没有转换器就说清楚，不让解析器去猜。"""
    monkeypatch.setattr(render, "backend", lambda: "")

    with pytest.raises(render.RenderUnavailable):
        render.convert_to_docx(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")


def test_unknown_target_is_rejected(tmp_path, monkeypatch) -> None:
    """目标写错（例如将来有人传 `txt`）要报「不认识的转换目标」，而不是静默产出 PDF。"""
    monkeypatch.setattr(office2pdf, "backend", lambda: "com")
    source = tmp_path / "a.doc"
    source.write_bytes(b"x")

    with pytest.raises(office2pdf.ConvertError, match="不认识的转换目标"):
        office2pdf.convert(source, tmp_path / "out.txt", "txt")
