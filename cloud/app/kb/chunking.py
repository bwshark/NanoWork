"""切块：纯函数，不碰数据库。

## 为什么按「空行分段 → 装箱」而不是定长滑窗

定长滑窗（每 800 字切一刀）会把一句话切成两半，检索命中时返回的片段从词中间开始，
读起来像乱码；而知识库的片段是**要被人看的**，不只是喂给模型。

按空行/换行分段再装箱有两个好处：
1. 每条块的边界都落在作者自己写的分段上；
2. 超长段落（比如一整段表格）才退化到定长硬切，并且**强制重叠**，
   避免「答案正好跨在切口上」时两边都只命中半句。
"""

from __future__ import annotations

#: 单块上限（字符）。800 是「一段话 + 少量上下文」的量级；
#: 太小会让一段话碎成三块、检索时三块都排在前面互相挤占名额。
MAX_CHUNK_CHARS = 800

#: 超长段落的硬切重叠：切口的上下文不至于两边都缺。
OVERLAP_CHARS = 80


def _hard_split(paragraph: str, max_chars: int, overlap: int) -> list[str]:
    if max_chars <= overlap:
        raise ValueError("max_chars 必须大于 overlap")
    out: list[str] = []
    start = 0
    step = max_chars - overlap
    while start < len(paragraph):
        out.append(paragraph[start : start + max_chars])
        if start + max_chars >= len(paragraph):
            break
        start += step
    return out


def chunk_text(
    content: str,
    *,
    max_chars: int = MAX_CHUNK_CHARS,
    overlap: int = OVERLAP_CHARS,
) -> list[str]:
    """把正文切成若干块。空内容返回空列表（调用方据此拒绝入库）。"""
    if max_chars <= overlap:
        raise ValueError("max_chars 必须大于 overlap")

    # 统一换行：来自 Windows 的文本是 \r\n，按 \n\n 分段时 \r 会留在块尾
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []

    paragraphs = [line.strip() for line in normalized.split("\n\n")]

    chunks: list[str] = []
    buffer = ""
    for paragraph in paragraphs:
        if not paragraph:
            continue
        if len(paragraph) > max_chars:
            # 先把攒着的吐出去，再硬切这一大段（顺序不能反，否则块序会乱）
            if buffer:
                chunks.append(buffer)
                buffer = ""
            chunks.extend(_hard_split(paragraph, max_chars, overlap))
            continue
        if not buffer:
            buffer = paragraph
            continue
        if len(buffer) + 2 + len(paragraph) <= max_chars:
            buffer = f"{buffer}\n\n{paragraph}"
        else:
            chunks.append(buffer)
            buffer = paragraph
    if buffer:
        chunks.append(buffer)

    # 保底再过滤一次：硬切可能产出只含空白的尾巴
    return [chunk.strip() for chunk in chunks if chunk.strip()]
