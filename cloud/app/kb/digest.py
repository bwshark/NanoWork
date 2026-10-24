"""文档内容摘要：判重用的身份标识。

## 为什么摘要按**切好的块**算，不按原始正文

两个理由，第二个是决定性的：

1. **块才是被检索的东西**。两篇文档如果产出完全相同的块，它们在检索里就是同一份
   资料 —— 无论原始正文的换行、缩进差多少。按块算，「同一篇从 Word 复制一遍再
   上传」能被认出来，按原文算就认不出。
2. **老数据可以回填**。正文不入库（只存块，见 `models.KbDocument` 的注释），
   所以「按原文算」在文档入库之后**再也算不出来**；而块一直都在，
   摘要随时可以重算。这一点让「字段加上之前就已经存在的文档」也能参与判重。

## 判重的作用域是「一个库」

跨库同内容是正常的（同一段制度既在《员工手册》也在《差旅制度》），不能拦。
所以查询条件永远是 `kb_id = … AND content_hash = …`。
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

#: 块之间的分隔符。用不可见字符而不是 `\n\n`：块内部本来就可能含空行，
#: 用 `\n\n` 拼会让 ["a\n\nb", "c"] 和 ["a", "b\n\nc"] 撞成同一个摘要。
_SEPARATOR = "\u0000"


def digest_of(chunks: Sequence[str]) -> str:
    """整篇文档的摘要（sha256 十六进制）。空块列表返回空串。

    返回空串而不是算一个「空内容」的摘要：空文档本来就会被入库入口拒掉（422），
    这里再用同一个值表示「未计算」，判重查询就永远不会误命中。
    """
    usable = [chunk for chunk in chunks if chunk]
    if not usable:
        return ""
    payload = _SEPARATOR.join(usable).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
