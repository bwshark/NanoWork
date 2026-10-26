"""表格全链路（P1）：识别 → 切块 → 检索投影 → 拼回。

这一层的价值**只在检索上**：`| 张三 | 30 |` 这行里没有「年龄」两个字，不投影就
永远搜不到 —— 表格保留了结构却搜不到，等于没保留。所以下面不只断言「字符串里有
某个片段」，而是尽量落到「能不能命中」与「拼回来还是不是同一张表」。
"""

from __future__ import annotations

from app.kb import tables
from app.kb.chunking import chunk_text, join_chunks, retrieval_text
from app.kb.retrieval import score_chunk, tokenize

HEADER = "| 姓名 | 年龄 | 在职 |"
SEPARATOR = "| --- | --- | --- |"


def make_table(rows: int) -> str:
    body = [f"| 员工{index} | {20 + index} | 是 |" for index in range(rows)]
    return "\n".join([HEADER, SEPARATOR, *body])


# —— 切一行 ——


def test_split_row_restores_escaped_pipe() -> None:
    """`\\|` 是一格之内的内容：当成列分隔会凭空多出一列。"""
    assert tables.split_row("| a \\| b | c |") == ["a | b", "c"]


def test_split_row_accepts_omitted_outer_pipes() -> None:
    """手写 Markdown 常省略首尾管道，也得认。"""
    assert tables.split_row("a | b") == ["a", "b"]


# —— 识别 ——


def test_is_table_block_rejects_plain_text_with_pipes() -> None:
    """`甲 | 乙 是两种写法` 这种正文里很常见，不能当表格。"""
    assert not tables.is_table_block("甲 | 乙 是两种写法\n丙 | 丁")
    assert tables.is_table_block(f"{HEADER}\n{SEPARATOR}\n| 张三 | 30 | 是 |")


def test_is_table_block_requires_separator_on_second_line() -> None:
    assert not tables.is_table_block(f"{HEADER}\n| 张三 | 30 | 是 |")


# —— 按行切 ——


def test_split_table_block_repeats_header_on_every_chunk() -> None:
    """每块都要带表头：没有列名的数据行在检索结果里是一串光秃秃的值。"""
    table = make_table(80)
    chunks = tables.split_table_block(table, 300)

    assert len(chunks) > 1
    for chunk in chunks:
        assert tables.is_table_block(chunk)
        assert chunk.split("\n")[:2] == [HEADER, SEPARATOR]

    # 数据行不重复、不丢
    rows = [line for chunk in chunks for line in chunk.split("\n")[2:]]
    assert rows == make_table(80).split("\n")[2:]


def test_split_table_block_never_cuts_inside_a_row() -> None:
    """一行本身就超上限时，宁可整行单独成块，也不把一行拆成两半。

    拆开的一行既不是合法 Markdown，也读不出这一格属于哪个字段。
    """
    long_cell = "很长的说明" * 200
    table = "\n".join([HEADER, SEPARATOR, f"| 张三 | 30 | {long_cell} |", "| 李四 | 31 | 是 |"])

    chunks = tables.split_table_block(table, 200)

    assert len(chunks) == 2
    assert long_cell in chunks[0]
    for chunk in chunks:
        # 没有被切开的半行：每块最后一行都是完整的行（以 | 收尾）
        assert chunk.rstrip("\n").endswith("|")


# —— 检索投影 ——


def test_table_to_records_carries_column_names() -> None:
    table = f"{HEADER}\n{SEPARATOR}\n| 张三 | 30 | 是 |"
    assert tables.table_to_records(table) == "姓名: 张三; 年龄: 30; 在职: 是"


def test_table_to_records_skips_empty_cells() -> None:
    """空格子不产出「年龄: 」这种空对，否则噪声会进向量。"""
    table = f"{HEADER}\n{SEPARATOR}\n| 张三 |  | 是 |"
    assert tables.table_to_records(table) == "姓名: 张三; 在职: 是"


def test_table_to_records_strips_image_refs_but_keeps_caption() -> None:
    """格子里的图片：`asset:<id>` 是随机 hex（纯噪声），图注才是可检索的内容。

    docx 的表格单元格里放截图是真实写法（台账、流程图的「图示」列）。不剥的话，
    同一张图在正文一处、表格里一处会以两种完全不同的文本进向量。
    """
    table = f"{HEADER}\n{SEPARATOR}\n| 张三 | ![审批流程图](asset:a1b2c3) | 是 |"

    projected = tables.table_to_records(table)

    assert projected == "姓名: 张三; 年龄: 审批流程图; 在职: 是"
    assert "asset:" not in projected


def test_projection_makes_column_names_searchable() -> None:
    """**整件事的理由就在这一条。**

    先把话说准（我改了三次才对）：表头**确实**在块里 —— 长表格的每一块都复制了
    表头（见 `split_table_block`），所以搜「年龄」词法上能擦到一次。真正的损失是：

    1. 一块 60 行数据里列名只出现 1 次，被长度归一化压到几乎不参与排序；
    2. 更要命的是**列名与数据不在同一行**。命中的那一行 `| 员工45 | 65 | 是 |` 里
       没有任何信息告诉读者 65 是什么 —— 交给模型时它也只能猜。
    """
    query = tokenize("年龄")
    table = make_table(60)

    # 不是零命中，是「压得太低」：差一个数量级
    assert score_chunk(query, table) > 0
    assert score_chunk(query, retrieval_text(table)) > score_chunk(query, table) * 10

    # 真正的差别：投影后那一行自己就带上了列名
    projected = retrieval_text(table)
    assert "年龄: 65" in next(line for line in projected.split("\n") if "员工45" in line)
    # 原文那一行只有值
    assert "年龄" not in next(line for line in table.split("\n") if "员工45" in line)


def test_projection_applies_to_table_inside_a_mixed_block() -> None:
    """真机暴露的问题：短文档的标题、段落、表格会装进**同一个**块。

    那时「整块是表格」不成立。投影若只认整块，最常见的情况（几百字的制度文档）
    反而一次都不生效 —— 界面上一切正常，检索却和改造前一模一样。
    """
    block = "\n\n".join(
        ["# 差旅标准", f"{HEADER}\n{SEPARATOR}\n| 张三 | 30 | 是 |", "报销走邮箱。"]
    )

    projected = retrieval_text(block)

    assert "姓名: 张三" in projected  # 表格被投影
    assert "# 差旅标准" in projected  # 非表格部分原样保留
    assert "报销走邮箱。" in projected
    assert SEPARATOR not in projected  # 分隔行不该留在检索文本里


def test_retrieval_text_passes_plain_text_through() -> None:
    assert retrieval_text("报销流程：走财务邮箱。") == "报销流程：走财务邮箱。"


# —— 切块与拼回 ——


def test_chunk_text_never_splits_a_table_row() -> None:
    table = make_table(60)
    chunks = chunk_text(table)

    assert len(chunks) > 1
    assert all(tables.is_table_block(chunk) for chunk in chunks)
    assert all(len(chunk) <= 800 for chunk in chunks)


def test_join_chunks_merges_table_continuation_into_one_table() -> None:
    """拼回来必须是**一张**表：每块都带了表头，不去重就会显示成 N 张小表。"""
    table = make_table(60)
    joined = join_chunks(chunk_text(table))

    assert joined.count(SEPARATOR) == 1
    assert joined == table


def test_chunk_text_keeps_order_with_table_between_paragraphs() -> None:
    document = "\n\n".join(["前一段", make_table(60), "后一段"])
    chunks = chunk_text(document)

    assert chunks[0].startswith("前一段")
    assert chunks[-1] == "后一段"
    assert join_chunks(chunks) == document
