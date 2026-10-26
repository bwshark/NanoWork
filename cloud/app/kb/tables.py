"""GFM 表格：识别 / 按行切分 / 检索投影。纯函数，不碰数据库。

三个函数服务三个**不同**的问题，刻意不合并：

1. `is_table_block`：切块器要知道「这一段是表格，不能按字符硬切」。
2. `split_table_block`：长表格超过 `MAX_CHUNK_CHARS` 时按**行**切，并且每块复制表头。
   不复制表头的话，第二块起就没有列名 —— 检索命中了也读不懂那一行是什么。
3. `table_to_records`：**检索投影**。`| 张三 | 30 |` 这一行不含「年龄」两个字，
   搜「年龄」时词法检索完全命中不了。把表头拼进每一行，命中率是数量级的差别。

## 为什么要求「每行都以 `|` 开头」

手写的 GFM 允许省略首尾管道（`a | b` / `--- | ---`），但**进库的表格一定带**：
前端的 `richText.htmlToMarkdown` 从 `<table>` 序列化时总会补上首尾管道。
所以这条判据在本系统的数据流里恒成立，而它让「一行恰好含竖线的普通文字」
（`甲 | 乙 是两种写法`）不会被误判成表格。

外部格式（docx 的 `w:tbl`、xlsx 的行）转成 GFM 是 `parsing.py` 的事：那一层有 IO、
有容错、有降级，不该混进这里的纯函数。
"""

from __future__ import annotations

import re

from app.kb.assets import strip_asset_refs

#: 转义后的管道。用常量而不是到处写 `"\\|"`，少一处写错就是少一格。
ESCAPED_PIPE = "\\|"

#: 分隔行的一格：`---` / `:---` / `:---:` / `---:`。
_SEPARATOR_CELL = re.compile(r"^:?-+:?$")


def split_row(line: str) -> list[str]:
    """切一行表格：去掉首尾管道，按**未转义**的 `|` 分格，`\\|` 还原成 `|`。

    必须手写扫描而不是 `split("|")`：单元格里合法地可以出现 `|`（转义成 `\\|`），
    用 split 会把一格拆成两格 —— 症状是「表格存回去多了一列」。
    """
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    # 行尾的 `\|` 是被转义的内容，不是行边界
    if text.endswith("|") and not text.endswith(ESCAPED_PIPE):
        text = text[:-1]

    cells: list[str] = []
    buffer: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text) and text[index + 1] == "|":
            buffer.append("|")
            index += 2
            continue
        if char == "|":
            cells.append("".join(buffer).strip())
            buffer = []
            index += 1
            continue
        buffer.append(char)
        index += 1
    cells.append("".join(buffer).strip())
    return cells


def is_separator_row(line: str) -> bool:
    """分隔行（`| --- | :---: |`）：区分「表格」与「一行带竖线的普通文字」的唯一判据。"""
    if "|" not in line:
        return False
    cells = split_row(line)
    return bool(cells) and all(_SEPARATOR_CELL.match(cell) for cell in cells)


def is_table_block(text: str) -> bool:
    """整段是否是 GFM 表格：每行以 `|` 开头，且第 2 行是分隔行。

    要求**整段**都是表格（而不是「段里含表格」）：切块与投影都按段落工作，
    混排的段落退回普通处理 —— 宁可少一次优化，也不要在半表格上切出错位的东西。
    """
    lines = [line for line in text.split("\n") if line.strip()]
    if len(lines) < 2:
        return False
    if not all(line.lstrip().startswith("|") for line in lines):
        return False
    return is_separator_row(lines[1])


def split_table_block(text: str, max_chars: int) -> list[str]:
    """超长表格 → 多个**都带表头**的表格块（按数据行分组）。

    两个刻意的取舍：

    - **只按行切，绝不在行内硬切**：切开的一行既不是合法 Markdown，也读不出
      这一格属于哪个字段。宁可某块超限，也不把一行拆成两半。
    - **每块复制表头**（两行：列名 + 分隔行）：没有表头的数据行在检索结果里
      是一串光秃秃的值，比不返回更让人困惑。
    """
    lines = [line for line in text.split("\n") if line.strip()]
    if len(lines) < 3:
        return [text]

    header = "\n".join(lines[:2])
    chunks: list[str] = []
    buffer: list[str] = []

    for row in lines[2:]:
        # 候选块长度 = 表头 + 已有行（各带一个换行）+ 这一行
        candidate = len(header) + sum(len(item) + 1 for item in buffer) + len(row) + 1
        if buffer and candidate > max_chars:
            chunks.append("\n".join([header, *buffer]))
            buffer = [row]
            continue
        buffer.append(row)

    if buffer:
        chunks.append("\n".join([header, *buffer]))
    return chunks or [text]


def table_to_records(text: str) -> str:
    """表格 → 检索投影：每行拼成 `列名: 值; 列名: 值`。

    ## 为什么必须投影

    `| 张三 | 30 |` 这一行**不含**「年龄」两个字。用户搜「年龄」，词法检索一个词都
    命中不了；向量检索也只能靠邻块的上下文去猜。把表头拼进每一行之后，这一行自己
    就带全了列名 —— 这是表格能被检索到的**唯一**办法。

    ## 为什么不落库

    `KbChunk.text` 同时是「详情页拼回正文」的来源。存投影会让详情页把表格显示成
    一堆 `姓名: 张三`。投影是纯函数、800 字的开销可忽略，在用的那一刻算就好 ——
    也就不需要迁移、不会有第二份数据、不会两份不同步。

    没有数据行（只有表头）时返回原文：那时表头本身就是全部可检索内容。

    ## 格子里可能是图片

    表格单元格里放图片是真实写法（台账截图、示意图），占位形如
    `![图注](asset:<id>)`。投影时必须走 `strip_asset_refs`：`asset:<id>` 是纯噪声
    （一串随机 hex，还会稀释长度归一化），而**图注**是这张图唯一的检索内容。
    不剥的话，同一张图在「正文一处 + 表格里一处」会以两种完全不同的文本进向量。
    """
    lines = [line for line in text.split("\n") if line.strip()]
    if len(lines) < 3:
        return text

    header = split_row(lines[0])
    records: list[str] = []
    for line in lines[2:]:
        pairs: list[str] = []
        for index, raw in enumerate(split_row(line)):
            value = strip_asset_refs(raw).strip()
            if value == "":
                continue
            name = header[index] if index < len(header) else ""
            pairs.append(f"{name}: {value}" if name else value)
        if pairs:
            records.append("; ".join(pairs))
    return "\n".join(records) if records else text
