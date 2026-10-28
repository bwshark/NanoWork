"""原文件 → 预览 PDF（以及旧版 `.doc` → `.docx`）的服务端编排（**不碰办公套件**，
那是 `office2pdf` 的事）。

## 两个用途，同一套机制

| 用途 | 目标 | 谁调用 | 为什么 |
| --- | --- | --- | --- |
| 「按原格式打开」 | PDF | `routes` 的预览接口 | 前端 pdf.js 只认 PDF |
| 旧版 `.doc` 入库 | DOCX | `parsing._parse_doc` | 转成 `.docx` 后复用**唯一**的 docx 解析器 |

两者都**必须**走子进程 + 超时 + 串行，所以只实现一次（`_convert`）；差别只有超时时间。

## 为什么必须隔一层子进程

`office2pdf` 会拉起 PowerPoint/Word/Excel（Windows）或 LibreOffice（Linux）。它们
可能弹窗、可能挂住、退出之后进程还可能残留 —— 这些东西一旦发生在**服务进程内**，
一次卡住就是整个知识库不可用。所以这里用 `subprocess` 带超时拉起，超时直接杀掉
子进程：失败只影响这一篇文档。

## 为什么串行（`_LOCK`）

Office 不适合并发调用：两个 PowerPoint 实例同时转 PDF，轻则慢一倍，重则互相抢
文件锁而报「文件被占用」。排队是这里唯一正确的选择 —— 转换是**一次性**的
（转完就落库，下次直接读），排队只发生在"恰好在同一秒打开了多篇"这种极少见的情况。

## 能力缺失 ≠ 失败

一台机器上既没有 Office 也没有 LibreOffice，这不是 bug，是这台机器的能力
（容器镜像里装的是 LibreOffice，所以正常部署不会走到这条路）。所以分两个异常：
`RenderUnavailable`（转不了，前端退回正文）/ `RenderFailed`（转的时候真出错了）。
把它们混成一个，用户就分不清「要不要找管理员」。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from app.kb.office2pdf import (
    PDF_SUFFIX,
    SUPPORTED_SUFFIXES,
    TARGET_DOCX,
    TARGET_PDF,
    backend,
)

#: 转换超时（秒）。40 页课件实测约 10 秒；180 秒留足富余，
#: 但必须有个上限 —— 否则一个挂住的 Office 会把这个请求挂到天荒地老。
RENDER_TIMEOUT_SECONDS = 180

#: `.doc → .docx` 的超时。比预览那条**短一半**：这条路上用户在界面上等上传结果，
#: 180 秒等下去人会以为卡死；而 `.doc` 转 `.docx` 实测 3–8 秒，90 秒已很宽松。
PARSE_TIMEOUT_SECONDS = 90

#: 渲染产物版本。**只要"PDF 里装什么"变了就必须 +1**。
#:
#: 当前 = 2：Word 类文件转出的 PDF 带**标题书签**（大纲视图的数据源）。
#: 为什么必须有这个数字：`kb_files.pdf` 是缓存，一张老 PDF 会被一直复用 —— 加了书签
#: 却不涨版本，所有历史文档的大纲永远是空的，用户看到的结论是"功能没做"，而不是
#: "这篇还没转"。`routes._file_view` 拿它跟行上的 `render_version` 比，落后就按"没转"
#: 处理，下次打开自动重转一次（幂等，用户只多等一次几秒）。
RENDER_VERSION = 2

#: Office 并发不安全，串行执行（见文件头）。
_LOCK = threading.Lock()

#: `python -m app.kb.office2pdf` 的工作目录（= 仓库里的 cloud/）。
_PACKAGE_ROOT = Path(__file__).resolve().parents[2]


class RenderUnavailable(RuntimeError):
    """这台机器没有可用的 Office，或这种格式不支持转 PDF。"""


class RenderFailed(RuntimeError):
    """转换真的失败了（文件损坏 / Office 弹窗 / 超时）。"""


def is_available() -> bool:
    """能不能转 PDF。**只判能力，不判权限**（权限在路由里做）。

    两种后端由 `office2pdf.backend()` 判定：Windows 的 COM，或 Linux 的 LibreOffice。
    这里刻意不写 `sys.platform` 判断 —— 能力探测只应该有一处实现，写两遍必然漂移
    （症状是「容器里明明装了 LibreOffice，界面还是说没有转换器」）。
    """
    return backend() != ""


def is_convertible(suffix: str) -> bool:
    """这种后缀能不能生成预览（PDF 自己就是预览，不需要转）。"""
    suffix = suffix.lower()
    return suffix == PDF_SUFFIX or suffix in SUPPORTED_SUFFIXES


def _convert(data: bytes, suffix: str, target: str, timeout: int) -> bytes:
    """写临时文件 → 子进程转换 → 读回产物。两个用途共用这一段。

    `target` 只传 `office2pdf` 认得的两个值（`pdf` / `docx`），产物后缀由它决定；
    这里用 `out.{target}` 只是给临时文件起名，真正的后缀判断不在这一层。
    """
    with tempfile.TemporaryDirectory(prefix="nanowork-render-") as tmp:
        source = Path(tmp) / f"source{suffix}"
        output = Path(tmp) / f"out.{target}"
        source.write_bytes(data)
        with _LOCK:
            try:
                completed = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "app.kb.office2pdf",
                        str(source),
                        str(output),
                        "--to",
                        target,
                    ],
                    capture_output=True,
                    timeout=timeout,
                    cwd=str(_PACKAGE_ROOT),
                )
            except subprocess.TimeoutExpired as error:
                raise RenderFailed(
                    f"转换超时（超过 {timeout} 秒）：转换器可能弹出了对话框没关"
                ) from error
        if completed.returncode != 0 or not output.exists():
            # stderr 最后一行是人能读的那句（`com_error: ...`），别把整个 traceback 塞给用户
            lines = (completed.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise RenderFailed(lines[-1][:300] if lines else "转换失败（转换器没有产出文件）")
        return output.read_bytes()


def render_pdf(data: bytes, suffix: str) -> tuple[bytes, int]:
    """原文件字节 → `(PDF 字节, 耗时毫秒)`。

    PDF 直通：不重复处理（它就是预览本身）。
    """
    suffix = suffix.lower()
    if suffix == PDF_SUFFIX:
        return data, 0
    if not is_convertible(suffix):
        raise RenderUnavailable(f"{suffix or '这种格式'} 不支持生成预览")
    if not is_available():
        raise RenderUnavailable(
            "服务端没有可用的文档转换器（Office 或 LibreOffice），生成不了原格式预览。"
            "看「正文」标签即可 —— 检索与阅读都不受影响"
        )

    started = time.monotonic()
    pdf = _convert(data, suffix, TARGET_PDF, RENDER_TIMEOUT_SECONDS)
    return pdf, int((time.monotonic() - started) * 1000)


def convert_to_docx(data: bytes) -> bytes:
    """旧版 `.doc` → `.docx` 字节（**给解析用**，不是预览）。

    为什么借这条链路、而不是让 `parsing` 自己调办公套件：COM 必须待在子进程里
    （见文件头），而「子进程 + 超时 + 串行」这套实现在这里已经有一份，抄一遍必然
    漏掉其中一条。`parsing` 只负责把结果交给 `_parse_docx`。
    """
    if not is_available():
        raise RenderUnavailable("服务端没有可用的文档转换器（Office 或 LibreOffice）")
    return _convert(data, ".doc", TARGET_DOCX, PARSE_TIMEOUT_SECONDS)
