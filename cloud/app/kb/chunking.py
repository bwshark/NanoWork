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

from app.kb import tables
from app.kb.assets import strip_asset_refs

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
            # 先把攒着的吐出去，再切这一大段（顺序不能反，否则块序会乱）
            if buffer:
                chunks.append(buffer)
                buffer = ""
            if tables.is_table_block(paragraph):
                # 表格不能按字符硬切：切口会落在某一行中间，切出来的两块既不是
                # 合法 Markdown，也读不出那一格属于哪个字段。改成按行分组 + 复制表头。
                chunks.extend(tables.split_table_block(paragraph, max_chars))
                continue
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


def join_chunks(chunks: list[str], *, min_overlap: int = 40) -> str:
    """把块按序拼回正文（详情页用），并**去掉硬切留下的重叠**。

    为什么不能直接 `"\\n\\n".join(chunks)`：超长段落走 `_hard_split`（固定重叠
    `OVERLAP_CHARS` 字），直接拼会在切口处重复一段 —— 详情页是给人读的，重复比
    丢字更刺眼（也更容易被当成"数据坏了"）。

    只处理「前块尾巴 == 后块开头」且长度 ≥ `min_overlap` 的情况：作者自己写的重复
    （比如两句一样的口号）通常短于 40 字，不会被误伤。宁可少修一点，也不要把
    正常正文吃掉。

    ⚠️ 拼回来的**不是原文件**：切块本身就会吃掉原始排版（表格变行、图片丢失）。
    这条限制写在接口的 docstring 与界面提示里，不能装作它等于原文档。
    """
    if not chunks:
        return ""

    out = chunks[0]
    for chunk in chunks[1:]:
        merged = _merge_table_continuation(out, chunk)
        if merged is not None:
            out = merged
            continue

        overlap = 0
        for size in range(min(len(out), len(chunk)), min_overlap - 1, -1):
            if out.endswith(chunk[:size]):
                overlap = size
                break
        tail = chunk[overlap:]
        if tail == "":
            # 整块都是上一块的重叠：跳过，别留一对多余的空行
            continue
        # 有重叠 = 同**一段**被硬切开了：直接接上，不能插空行（插了就等于凭空
        # 多出一个段落边界，而原文那里并没有分段）
        out = f"{out}{tail}" if overlap else f"{out}\n\n{tail}"
    return out


def _merge_table_continuation(previous: str, chunk: str) -> str | None:
    """相邻两块是**同一张表**的续块时，拼回一个表；否则返回 `None`。

    `split_table_block` 给每一块都复制了表头。拼回去必须**去掉后一块的表头**、
    用单个换行接上 —— 直接 `\n\n` 拼的话，详情页会把一个长表格显示成 N 张表，
    每张都带一遍表头（用户会以为原文就是好几个小表）。

    判据：后一块是表格，且前一块末尾那段连续表格行的**前两行**与后一块的表头逐字相同。
    也就是「这份表头是我们复制出来的」，不是作者自己写了两张一样的表。
    """
    if not tables.is_table_block(chunk):
        return None

    chunk_lines = [line for line in chunk.split("\n") if line.strip()]
    if len(chunk_lines) < 3:
        # 只有表头没有数据行：不是续块
        return None

    previous_lines = [line for line in previous.split("\n") if line.strip()]
    # 从后往前找到前一块里最后一个表格段的起点
    start = len(previous_lines)
    while start > 0 and previous_lines[start - 1].lstrip().startswith("|"):
        start -= 1
    if start == len(previous_lines):
        return None
    if previous_lines[start : start + 2] != chunk_lines[:2]:
        return None

    return f"{previous}\n" + "\n".join(chunk_lines[2:])


def retrieval_text(chunk: str) -> str:
    """块的**检索投影**：落库的规范表示（GFM 表格）→ 检索/向量化用的纯文本。

    ⚠️ **embedding 与词法排序都必须走这里。** 只改一处的话，两路打分看的不是同一份
    文本，混合排序会把同一个块排出两个位置（也会让「建索引时算的」和「查询时算的」
    不是一回事）。

    投影刻意**不落库**：`KbChunk.text` 同时是详情页拼回正文的来源，
    存投影会让表格显示成一堆 `姓名: 张三`。纯函数、开销可忽略，用的那一刻算。

    ## 为什么按 `\n\n` 逐段投影，而不是「整块是表格才投影」

    这是**真机上才会暴露**的一个坑：短文档的标题、段落、表格一共才几百字，
    装箱时会全部装进**同一个块**，于是「整块是表格」永远不成立 —— 投影在最常见的
    情况下一次都没生效过，界面上却看不出任何异常。

    表格块内部只有单 `\n`（GFM 的表格行），所以 `split("\n\n")` 不会切开表格；
    非表格部分原样返回，`"\n\n".join(split("\n\n"))` 恒等于原文。

    ## 图片为什么也要剥

    `![图注](asset:<id>)` 里唯一有检索价值的是**图注**；`asset:<id>` 是纯噪声
    （一串随机 hex，还会稀释长度归一化）。图片本体**根本不该进向量** ——
    几十 KB 的二进制进文本会让整个块的语义彻底失真。
    """
    parts = chunk.split("\n\n")
    projected = [
        tables.table_to_records(part) if tables.is_table_block(part) else strip_asset_refs(part)
        for part in parts
    ]
    return "\n\n".join(projected)
