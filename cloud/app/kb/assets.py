"""文档图片：引用格式、去重、替换。纯函数，不碰数据库。

## 引用格式：`![图注](asset:<id>)`

为什么是**内部 scheme**而不是真实 URL：

- 不能是 `data:`（base64）—— 一个 200KB 的图会把整块文本撑到几十万字，切块与
  检索当场失效。
- 不能是本地路径或某个 CDN 地址——云端与客户端分离，将来迁对象存储地址还会变。
- 真实 URL **在渲染那一刻才拼**（见前端 `src/lib/kb/assetRef.ts`），正文里存的
  永远是 `asset:<id>`。文档与图片的绑定因此不依赖任何可变的地址。

## 两种引用，别混

| 形态 | 出现在 | 何时变成另一种 |
| --- | --- | --- |
| `asset-index:<n>` | 解析阶段（还没入库，图片还没有 id） | 入库时替换成 `asset:<id>` |
| `asset:<id>` | 入库之后的一切（正文、块、库里） | 永远不变 |

解析器只能给出「第几张图」，因为图片的 id 是入库时才生成的。
"""

from __future__ import annotations

import re

#: 入库之后正文里用的内部 scheme。
ASSET_SCHEME = "asset:"

#: 解析阶段的占位（第几张图）。
PENDING_SCHEME = "asset-index:"

#: `![图注](asset:<id>)`
_ASSET_REF = re.compile(r"!\[([^\]]*)\]\(asset:([A-Za-z0-9_-]+)\)")

#: `![图注](asset-index:<n>)`
_PENDING_REF = re.compile(r"!\[([^\]]*)\]\(asset-index:(\d+)\)")

#: 两种形态都要剥：`asset:<id>`（入库后）与 `asset-index:<n>`（入库前）。
#:
#: 判重要在**存图之前**算（那时正文里还是 `asset-index:`），而检索投影要在
#: **入库之后**算（那时是 `asset:`）—— 一个函数同时认两种，调用点才不会写错。
_ASSET_REF_ANY = re.compile(r"!\[([^\]]*)\]\((?:asset|asset-index):[A-Za-z0-9_-]+\)")

#: 可返回给浏览器的图片类型。**白名单里没有 SVG**。
#:
#: SVG 能内嵌 `<script>`：以 `image/svg+xml` 从**同源**返回就能执行脚本，也就是
#: 一个 XSS 入口。宁可不支持 SVG（docx 里存的是 png/jpeg，本来也很少有 svg）。
#:
#: EMF/WMF 也不在白名单里：浏览器不认，而且体积通常比 PNG 还大。
ALLOWED_MIME: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}


def mime_for_suffix(suffix: str) -> str | None:
    """按扩展名判断 MIME；不在白名单里返回 `None`（调用方跳过并告知用户）。"""
    return ALLOWED_MIME.get(suffix.lower())


def collect_asset_ids(text: str) -> list[str]:
    """正文里引用的全部资产 id（按出现顺序，去重）。"""
    seen: list[str] = []
    for _match in _ASSET_REF.finditer(text):
        asset_id = _match.group(2)
        if asset_id not in seen:
            seen.append(asset_id)
    return seen


#: 图片魔数 → MIME。**按内容判定，不看扩展名**。
#:
#: 扩展名是用户能改的：把 `evil.html` 改名成 `a.png` 就能骗过扩展名检查。
#: 魔数骗不过，而且我们按魔数给出的 mime 正是浏览器真正会用的那个。
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
)


def sniff_mime(data: bytes) -> str | None:
    """按**内容**判定图片类型；认不出来返回 `None`（调用方据此拒收）。

    SVG 不在白名单里：它能内嵌 `<script>`，同源返回就能执行脚本（XSS）。
    """
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def strip_asset_refs(text: str) -> str:
    """`![图注](asset:<id>)` → `图注`。

    两处必须用它：

    1. **判重**：同一份文档重传时图片会拿到**新的 id**（每次入库都生成新的），
       带着 id 算摘要就永远判不出重复 —— 「同一份资料只入一次库」这条约定会失效。
    2. **检索投影**：图片本体不进向量，`asset:xxxx` 里的噪声更不该进。
       剩下的图注文字才是这张图在检索里的全部内容。
    """
    return _ASSET_REF_ANY.sub(lambda match: match.group(1), text)


def replace_pending_refs(text: str, asset_ids: list[str]) -> str:
    """`![图注](asset-index:0)` → `![图注](asset:<真实 id>)`。

    下标越界时**保留原样**而不是丢掉整张图：宁可让这一处显示成坏图，
    也别让正文里静悄悄地少一张图（用户不会知道少了一张）。
    """

    def replace(match: re.Match[str]) -> str:
        index = int(match.group(2))
        if index >= len(asset_ids):
            return match.group(0)
        return f"![{match.group(1)}]({ASSET_SCHEME}{asset_ids[index]})"

    return _PENDING_REF.sub(replace, text)
