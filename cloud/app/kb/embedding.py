"""向量化（embedding）：把文本变成可比余弦的定长向量。

## 两种实现，别混着叫「语义检索」

- `hash` → `HashingEmbedder`：**不是语义检索**，无依赖、离线、确定性强。等价于
  「词袋的随机投影」——只认字面重合，同义词照样搜不到。
- `openai` → `OpenAICompatEmbedder`：真语义。任何 OpenAI 兼容的 `/embeddings` 都行
  （DashScope / OpenAI / 自建 vLLM）。

把哈希实现也叫「向量检索」是有意的：它走的是**同一条链路**（建索引 → 余弦 → 排序），
换成远程模型时只需要改环境变量、不用改任何一行检索代码与测试结构。
但报告口径里必须写清「非语义」——否则用户会拿它当语义检索用，然后奇怪为什么
「报销」搜不到「费用核销」。

## 配置（全部走环境变量，服务端没有设置表）

```bash
NANOWORK_KB_EMBEDDER=off|hash|openai   # 默认 off（保持既有词法行为，不偷偷改排序）
NANOWORK_KB_EMBED_DIM=256              # 仅 hash：桶数
NANOWORK_KB_EMBED_BASE_URL=...         # 仅 openai：如 https://dashscope.aliyuncs.com/compatible-mode/v1
NANOWORK_KB_EMBED_MODEL=...            # 仅 openai：如 text-embedding-v3
NANOWORK_KB_EMBED_API_KEY=...          # 仅 openai
```

**为什么默认 off**：打开会改变检索结果的顺序（同样的词法命中，余弦会重排）。
排序是用户能直接感知的结果，不该在升级后悄悄变；要开就显式开，并在知识库页
（`GET /api/kb/retrieval`）把当前引擎与索引覆盖率如实写出来。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from app.kb.retrieval import tokenize


class EmbeddingError(RuntimeError):
    """向量化失败（网络 / 鉴权 / 响应形状）。"""


class Embedder(Protocol):
    """一个 embedder 的两件事：叫什么（进向量表的主键）、怎么把文本变成向量。"""

    name: str
    dim: int

    def embed(self, texts: Sequence[str]) -> list[list[float]]:  # pragma: no cover - Protocol
        ...


#: 余弦相似度对零向量的处理：返回 0。空文本（切块后可能是纯空白）不该被当成
#: 「和任何东西都不相干却又参与除零」，返回 0 让它自然沉底。
def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    dot = math.fsum(a * b for a, b in zip(left, right, strict=False))
    left_norm = math.sqrt(math.fsum(a * a for a in left))
    right_norm = math.sqrt(math.fsum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)


def _l2_normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(math.fsum(value * value for value in vector))
    if norm == 0.0:
        return vector
    return [value / norm for value in vector]


def _bucket(token: str, dim: int) -> tuple[int, float]:
    """把一个词稳定地映射到 (桶, 符号)。

    ⚠️ 必须用 `hashlib` 而不是内置 `hash()`：后者对 str **按进程加盐**，
    重启后同一个词会落进另一个桶 → 旧向量全部失效，而检索不会报错，只会「突然变差」。
    符号（±1）是 signed hashing：两个词撞桶时一半概率互相抵消，而不是永远相加。
    """
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    value = int.from_bytes(digest, "big")
    return value % dim, (1.0 if (value >> 63) & 1 else -1.0)


class HashingEmbedder:
    """字面重合的向量化（**非语义**，见模块头）。

    词表来源直接复用检索那套 `tokenize`（拉丁词 + 中文双字），所以它和词法打分
    「看到的世界」是同一个；差别只在汇总方式：词法按查询词频 / √长度打分，
    这里把文档自己的词分布压成一个定长向量，余弦时对**长度不敏感**。

    ⚠️ **桶数决定了碰撞噪声**：无关文档之间也可能因为两个词撞进同一个桶而得到
    一点正余弦（实测 dim=64 时「报销流程」对「产品手册介绍核心功能的用法」有 0.16，
    dim=256 时为 0）。这类命中会真的出现在结果里（我们只丢 `score <= 0`）。
    所以默认 256，别为了省内存往下调；要「真的按意思搜」就该换 `openai` 档。
    """

    def __init__(self, dim: int = 256) -> None:
        if dim <= 0:
            raise ValueError("dim 必须为正")
        self.dim = dim
        self.name = f"hash:{dim}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for text in texts:
            vector = [0.0] * self.dim
            for token in tokenize(text):
                index, sign = _bucket(token, self.dim)
                vector[index] += sign
            out.append(_l2_normalize(vector))
        return out


#: 默认的 HTTP 传输：只发一次 POST，返回解析好的 JSON。
#: 抽成可注入参数是为了让用例**不需要**起一个真服务也能验请求形状。
Transport = Callable[[str, dict, dict], dict]


def _post_json(url: str, payload: dict, headers: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:200]
        raise EmbeddingError(f"embeddings 接口返回 {error.code}：{detail}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise EmbeddingError(f"embeddings 接口不可达：{error}") from error


class OpenAICompatEmbedder:
    """OpenAI 兼容的 `/embeddings` 客户端。

    只依赖标准库：服务端至今不引入 HTTP 客户端（`pyproject` 里没有 httpx 之外的
    网络依赖，而 httpx 只是 dev 依赖）——为一个请求形状引入运行时依赖不值得。

    `batch_size`：DashScope 的 text-embedding-v3 单请求上限是 25 条，
    这里默认 16，留出余量；**批次是顺序发**，不做并发——一次性把几百块的文档
    并发送进云端只会撞限流，重试逻辑比顺序发更复杂、更慢。
    """

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str = "",
        dim: int = 0,
        batch_size: int = 16,
        transport: Transport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.dim = dim
        self.batch_size = max(1, batch_size)
        self._transport = transport or _post_json

    @property
    def name(self) -> str:
        # 名字进向量表主键：换模型就等于换一套向量，旧模型的行不会被误用
        return f"openai:{self.model}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.batch_size):
            batch = list(texts[start : start + self.batch_size])
            vectors.extend(self._embed_batch(batch))
        return vectors

    def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        payload = {"model": self.model, "input": batch}
        data = self._transport(f"{self.base_url}/embeddings", payload, headers)

        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list) or len(rows) != len(batch):
            raise EmbeddingError(f"embeddings 响应条数不符：期望 {len(batch)} 条")

        # 云端不保证顺序（OpenAI 有 index 字段，部分兼容实现没有）：
        # 有 index 就按 index 排，没有就按原顺序——**不能**直接信数组下标，
        # 错位会让「A 块的正文配上 B 块的向量」，检索结果看起来对、引用的却是别的文档。
        if all(isinstance(row, dict) and "index" in row for row in rows):
            rows = sorted(rows, key=lambda row: row["index"])

        out: list[list[float]] = []
        for row in rows:
            embedding = row.get("embedding") if isinstance(row, dict) else None
            if not isinstance(embedding, list) or not embedding:
                raise EmbeddingError("embeddings 响应缺少 embedding 字段")
            vector = [float(value) for value in embedding]
            if self.dim == 0:
                self.dim = len(vector)
            elif len(vector) != self.dim:
                raise EmbeddingError(f"向量维度变化：期望 {self.dim}，实际 {len(vector)}")
            out.append(_l2_normalize(vector))
        return out


@dataclass(frozen=True)
class EmbedderResolution:
    """`resolve_embedder()` 的结果。

    `error` 非空表示**配置不完整**（比如选了 openai 但没给 base_url）：
    此时 `embedder` 为 None，检索降级为词法，但状态接口会把这句话原样报出来。
    不抛异常是刻意的——一个环境变量写错不该让整站 500。
    """

    kind: str
    embedder: Embedder | None
    error: str = ""

    @property
    def model(self) -> str:
        return self.embedder.name if self.embedder is not None else ""

    @property
    def dim(self) -> int:
        return self.embedder.dim if self.embedder is not None else 0


def resolve_embedder() -> EmbedderResolution:
    """按环境变量决定用哪个 embedder（每次调用都重新读，方便用例改 env）。"""
    kind = (os.environ.get("NANOWORK_KB_EMBEDDER") or "off").strip().lower()
    if kind in ("", "off", "none", "lexical"):
        return EmbedderResolution(kind="off", embedder=None)

    if kind == "hash":
        raw_dim = (os.environ.get("NANOWORK_KB_EMBED_DIM") or "256").strip()
        try:
            dim = int(raw_dim)
        except ValueError:
            return EmbedderResolution(kind=kind, embedder=None, error=f"维度不是整数：{raw_dim}")
        if dim <= 0:
            return EmbedderResolution(kind=kind, embedder=None, error=f"维度必须为正：{dim}")
        return EmbedderResolution(kind=kind, embedder=HashingEmbedder(dim=dim))

    if kind == "openai":
        base_url = (os.environ.get("NANOWORK_KB_EMBED_BASE_URL") or "").strip()
        model = (os.environ.get("NANOWORK_KB_EMBED_MODEL") or "").strip()
        if not base_url or not model:
            return EmbedderResolution(
                kind=kind,
                embedder=None,
                error="NANOWORK_KB_EMBED_BASE_URL / NANOWORK_KB_EMBED_MODEL 至少要给一个",
            )
        return EmbedderResolution(
            kind=kind,
            embedder=OpenAICompatEmbedder(
                base_url=base_url,
                model=model,
                api_key=(os.environ.get("NANOWORK_KB_EMBED_API_KEY") or "").strip(),
            ),
        )

    return EmbedderResolution(kind=kind, embedder=None, error=f"未知的 embedder：{kind}")
