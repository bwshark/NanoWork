"""Office → PDF：只服务一件事 —— 让知识库里的文档能**按原格式打开**。

## 为什么是「转 PDF」而不是自己渲染

pptx / docx / xlsx 是**排版描述**，不是内容：一页幻灯片的价值有一半在位置、字号、
颜色、层级上。把这类文件重新排版成 HTML（自研渲染器）永远只能做到"大致像"，
而真正做排版的软件（Office / LibreOffice）转出来的 PDF 就是它自己的排版。

于是链路很短：**原文件 →（办公套件）→ PDF →（前端 pdf.js）→ 画布**。
四类文件（pptx/docx/xlsx/pdf）在前端收敛成同一种东西。

## 两种后端：Windows 的 COM 与 Linux 的 LibreOffice

同一件事有两个实现，`backend()` 按运行时能力选：

| 后端 | 运行环境 | 怎么调 |
| --- | --- | --- |
| `com` | Windows + 装了 Office + pywin32 | `DispatchEx` 起 Office，`SaveAs` 出 PDF |
| `libreoffice` | Linux（容器里就是它） | `soffice --headless --convert-to pdf` |

**Linux 上没有 COM，也不需要**：容器镜像装 `libreoffice-impress/-writer/-calc`，
命令行转换完全等价于「用它自己的排版引擎排版」。两条路的产出都是 PDF，所以
上游（`render.py`）与下游（前端 pdf.js）完全不需要知道是哪一种。

⚠️ 保真度有个真实的先后：PowerPoint 自己转的最准；LibreOffice 对复杂版式
（艺术字、部分 SmartArt、特殊动画效果）会有偏移，但**文字、位置、配色、分页
都在**。对"看排版"这个目的够用；对像素级复刻不够。

## 为什么跑在**子进程**里

办公套件有三个毛病：可能弹窗、可能挂住、`Quit()` 之后进程还可能残留
（LibreOffice 同样是 —— 它会留一个 `soffice.bin`）。放在服务进程里调，一次挂住
就是整个知识库不可用。所以真正碰套件的代码只在这个模块的 `__main__` 里跑，
由 `render.py` 用 `subprocess` 带超时拉起来 —— 超时直接杀进程，服务进程不受影响。

## 为什么用 late binding（`DispatchEx`）而不是 `gencache.EnsureDispatch`

早绑定第一次会生成类型库缓存（`gen_py/`），Office 升级或换机器后缓存不匹配就会
报「找不到成员」。这里的调用面很小（Open / SaveAs / Quit），late binding 够用，
而且少一个会在 deploy 时咬人的状态。

## 为什么是 `DispatchEx` 而不是 `Dispatch`

`Dispatch` 会**接管已经在运行的那个实例**：用户正开着 PowerPoint 改稿，我们一转 PDF、
一 `Quit()`，他的窗口就没了（还可能丢未保存的改动）。`DispatchEx` 每次起**新进程**，
转完就退，不碰用户手上的东西。

## 一个坑：PowerPoint 的 `WithWindow`

`Presentations.Open(..., WithWindow=False)` 在某些版本上会报错
（`0x80004005`），因为 PowerPoint 不允许完全无窗口打开演示文稿。
所以这里传 `WithWindow=True`，但**不设置 `Visible`** —— 它在服务会话里不会
真弹出一个窗口给用户，只是让 COM 走它默认的路径。
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

#: 转好的文件后缀（前端按 pdf 处理，不看源格式）
PDF_SUFFIX = ".pdf"

#: 能生成预览的源后缀。**与后端无关** —— 声明能力的地方，不是实现的地方。
#: `.pdf` 不在里面：它自己就是预览，不需要转（见 `render.render_pdf`）。
SUPPORTED_SUFFIXES = frozenset({".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls"})

#: LibreOffice 的导出 filter。**显式给**而不是裸 `pdf`：裸 `pdf` 让 LibreOffice
#: 自己挑 filter，同一个文件在不同版本上可能挑到 `draw_pdf_Export`（纯图形导出，
#: 文字层级会丢）。显式点名之后，「这一种后缀用哪个引擎导」是可预测的。
_LO_FILTERS: dict[str, str] = {
    ".pptx": "impress_pdf_Export",
    ".ppt": "impress_pdf_Export",
    ".docx": "writer_pdf_Export",
    ".doc": "writer_pdf_Export",
    ".xlsx": "calc_pdf_Export",
    ".xls": "calc_pdf_Export",
}

#: PowerPoint 的 `SaveAs` 格式常量（`ppSaveAsPDF`）
_PP_SAVE_AS_PDF = 32
#: Word 的 `wdFormatPDF`
_WD_FORMAT_PDF = 17
#: Excel 的 `xlTypePDF`
_XL_TYPE_PDF = 0


def backend() -> str:
    """这台机器能用哪种后端：`com` / `libreoffice` / 空串（都没有）。

    探测顺序**不能反**：Windows 上如果同时装了 Office 与 LibreOffice，应当优先用
    Office（保真度更高，且用户装它就是为了排版）。反过来先找 `soffice` 会让
    「装了正版 Office 的机器反而用 LibreOffice 转」，排版差异会莫名出现在几页上。

    每次调用都探测而不做模块级缓存：`PATH` 里出现 `soffice` 是部署时才发生的事，
    缓存住"没有"会让「装完不重启服务就一直说没有」。
    """
    if sys.platform == "win32":
        if importlib.util.find_spec("win32com") is not None:
            return "com"
    if shutil.which("soffice") or shutil.which("libreoffice"):
        return "libreoffice"
    return ""



class ConvertError(RuntimeError):
    """转换失败。消息会**原样**回给前端（用户要知道是哪一步坏了）。"""


def _powerpoint(src: Path, out: Path) -> None:
    import win32com.client  # 只在子进程里 import

    app = win32com.client.DispatchEx("PowerPoint.Application")
    presentation = None
    try:
        presentation = app.Presentations.Open(
            str(src), ReadOnly=True, Untitled=False, WithWindow=True
        )
        presentation.SaveAs(str(out), _PP_SAVE_AS_PDF)
    finally:
        if presentation is not None:
            try:
                presentation.Close()
            except Exception:  # noqa: BLE001 —— 关不上也不能盖住原始错误
                pass
        _quit(app)


def _word(src: Path, out: Path) -> None:
    import win32com.client

    app = win32com.client.DispatchEx("Word.Application")
    app.Visible = False
    app.DisplayAlerts = 0
    document = None
    try:
        document = app.Documents.Open(
            str(src),
            ConfirmConversions=False,
            ReadOnly=True,
            AddToRecentFiles=False,
        )
        # `SaveAs2` 是 Word 2010+ 的写法；老版本只有 `SaveAs`
        save_as = getattr(document, "SaveAs2", None) or document.SaveAs
        save_as(str(out), FileFormat=_WD_FORMAT_PDF)
    finally:
        if document is not None:
            try:
                document.Close(SaveChanges=False)
            except Exception:  # noqa: BLE001
                pass
        _quit(app)


def _excel(src: Path, out: Path) -> None:
    import win32com.client

    app = win32com.client.DispatchEx("Excel.Application")
    app.Visible = False
    app.DisplayAlerts = False
    workbook = None
    try:
        # `UpdateLinks=0`：不更新外部链接，否则 Excel 会弹「是否更新链接」并卡住
        workbook = app.Workbooks.Open(str(src), ReadOnly=True, UpdateLinks=0)
        workbook.ExportAsFixedFormat(_XL_TYPE_PDF, str(out))
    finally:
        if workbook is not None:
            try:
                workbook.Close(SaveChanges=False)
            except Exception:  # noqa: BLE001
                pass
        _quit(app)


def _quit(app: object) -> None:
    """退出 Office 应用。**必须尽力而为**：不退的话下次 Dispatch 会复用这个僵尸实例。"""
    try:
        app.Quit()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


#: Windows COM：源后缀 → 转换器。私有 —— 对外的能力声明看 `SUPPORTED_SUFFIXES`
#: （公开它会让人以为这就是全部转换入口，而 Linux 上它一条都用不到）。
_COM_CONVERTERS: dict[str, Callable[[Path, Path], None]] = {
    ".pptx": _powerpoint,
    ".ppt": _powerpoint,
    ".docx": _word,
    ".doc": _word,
    ".xlsx": _excel,
    ".xls": _excel,
}

#: LibreOffice 转换超时（秒）。比外层 `render.RENDER_TIMEOUT_SECONDS` 小 30 秒 ——
#: 这样超时能由这里给出「LibreOffice 挂住了」这句清楚的话，而不是被外层杀掉之后
#: 只剩一句笼统的「转换超时」。
_LO_TIMEOUT_SECONDS = 150


def _libreoffice(src: Path, out: Path) -> None:
    """用 LibreOffice 命令行转 PDF（Linux / 容器部署的唯一路径）。

    三个必须处理的细节，每个都对应一次真实的失败：

    1. **独立 user profile**（`-env:UserInstallation=`）：LibreOffice 是单实例模型
       —— 如果已有 soffice 在跑，新命令会把请求**转发给那个实例然后立刻返回**，
       于是我们检查输出文件时它还没生成，看起来像「转换失败」。独立 profile
       强制它起一个全新进程，转换与检查之间才有确定的先后。
    2. **`HOME` 必须可写**：容器里以非 root 用户跑。没有可写 HOME 时 LibreOffice
       在启动阶段就退出，而 stderr 只有一句 `javaldx` 之类的无关告警，
       很容易被误判成「文件坏了」。
    3. **退出码不可信**：LibreOffice 转换失败时经常仍然返回 0。所以判据只能是
       「输出文件存在且非空」—— 下面不看 returncode 而看文件。
    """
    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        raise ConvertError("找不到 LibreOffice（soffice / libreoffice 都不在 PATH 里）")
    suffix = src.suffix.lower()
    filter_name = _LO_FILTERS.get(suffix)
    if filter_name is None:
        raise ConvertError(f"这种格式不支持转 PDF：{src.suffix}")

    with tempfile.TemporaryDirectory(prefix="nanowork-lo-") as workdir:
        root = Path(workdir)
        profile = root / "profile"
        profile.mkdir()
        outdir = root / "out"
        outdir.mkdir()
        command = [
            binary,
            # 无界面 + 不恢复上次会话 + 不加载默认模板：容器里没有显示器，
            # 任何一步想开窗口都会让它卡到超时。
            "--headless",
            "--norestore",
            "--invisible",
            "--nodefault",
            "--nologo",
            "--nolockcheck",
            f"-env:UserInstallation={profile.as_uri()}",
            "--convert-to",
            f"pdf:{filter_name}",
            "--outdir",
            str(outdir),
            str(src),
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                timeout=_LO_TIMEOUT_SECONDS,
                # 子进程的 HOME 指向临时目录：主进程可能是只读 HOME 的 nobody 用户
                env={**os.environ, "HOME": str(root)},
            )
        except subprocess.TimeoutExpired as error:
            raise ConvertError(
                f"LibreOffice 转换超时（超过 {_LO_TIMEOUT_SECONDS} 秒），文件可能过大或版式有问题"
            ) from error

        produced = outdir / f"{src.stem}{PDF_SUFFIX}"
        if not produced.exists() or produced.stat().st_size == 0:
            detail = (completed.stderr or b"").decode("utf-8", "replace").strip()
            lines = [line for line in detail.splitlines() if line.strip()]
            raise ConvertError(lines[-1][:300] if lines else "LibreOffice 没有产出 PDF")
        out.write_bytes(produced.read_bytes())


def convert(src: Path, out: Path) -> None:
    """把 `src` 转成 PDF 写到 `out`。失败抛 `ConvertError`。

    两条完全独立的实施路径（见文件头）：Windows 走 COM，其余走 LibreOffice 命令行。
    这里只负责**选路**，不掺任何格式判断 —— 后缀能力统一由 `SUPPORTED_SUFFIXES` 声明。
    """
    suffix = src.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise ConvertError(f"这种格式不支持转 PDF：{src.suffix}")

    chosen = backend()
    if chosen == "com":
        converter = _COM_CONVERTERS[suffix]
        import pythoncom  # pywin32 的一部分

        pythoncom.CoInitialize()
        try:
            converter(src, out)
        except ConvertError:
            raise
        except Exception as error:  # noqa: BLE001 —— COM 抛的异常类型五花八门
            raise ConvertError(f"{type(error).__name__}: {error}") from error
        finally:
            pythoncom.CoUninitialize()
    elif chosen == "libreoffice":
        try:
            _libreoffice(src, out)
        except ConvertError:
            raise
        except Exception as error:  # noqa: BLE001 —— 命令行/编码问题的手脚要兜住
            raise ConvertError(f"{type(error).__name__}: {error}") from error
    else:
        raise ConvertError("这台机器既没有 Office（COM）也没有 LibreOffice，转不了 PDF")

    if not out.exists() or out.stat().st_size == 0:
        raise ConvertError("转换没有产出 PDF（办公套件可能被弹窗拦住）")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("用法: python -m app.kb.office2pdf <源文件> <输出.pdf>", file=sys.stderr)
        return 2
    try:
        convert(Path(argv[1]), Path(argv[2]))
    except ConvertError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
