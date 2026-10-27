"""原文件的元信息：MIME 兜底 + 内容摘要。纯函数。

## 为什么 MIME 要自己定

原文件是**下载/内联**返回给浏览器的，`Content-Type` 决定浏览器会怎么处理它。
按扩展名给一个**白名单**（而不是 `mimetypes.guess_type`）的理由和 `kb/assets.py`
一样：猜出来的类型可能把文件送进「当页面执行」的分支。这里只认我们自己接受上传的
那几种后缀，其余一律 `application/octet-stream`（浏览器只会下载，不会渲染）。
"""

from __future__ import annotations

import hashlib

#: 后缀 → MIME。**只在服务端用**（前端按 `kind` 决定用哪个查看器）。
DOCUMENT_MIME: dict[str, str] = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

#: 兜底类型：不认识的（或旧版 .doc/.xls/.ppt）一律按二进制下载，不让浏览器猜。
FALLBACK_MIME = "application/octet-stream"


def suffix_of(filename: str) -> str:
    """取小写后缀（含点）；没有后缀返回空串。"""
    name = filename.strip().replace("\\", "/").rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return "" if dot <= 0 else name[dot:].lower()


def document_mime(filename: str) -> str:
    return DOCUMENT_MIME.get(suffix_of(filename), FALLBACK_MIME)


def sha256_hex(data: bytes) -> str:
    """内容摘要。既是 ETag，也是「这份原文件有没有变」的判据。"""
    return hashlib.sha256(data).hexdigest()
