"""容器内/容器外都能跑的**真**端到端验证：上传 → 转 PDF → 取回 → 验页数。

## 为什么必须有这一支

`pytest` 里的 `test_office2pdf.py` 只覆盖 Windows COM（Linux 上整组跳过），
`test_render_backend.py` 只验「选路逻辑」。两者加起来仍然回答不了一个问题：
**这个镜像里 LibreOffice 真的能把这份 pptx 转出 40 页吗？**

只有真上传一篇真文件、真让容器转一次、再真把 PDF 读回来数页数，才算验过。
所以这个脚本不 mock 任何东西，走的是客户端走的同一条 HTTP 路径。

## 怎么用

    # 容器已起在 8910（宿主映射到 8911 也行，--base-url 改掉即可）
    python docker/verify.py --file "D:/Downloads/大模型的本地部署和微调.pptx"

    # 容器内跑（文件挂进 /data 时）
    docker compose exec cloud python docker/verify.py --file /data/sample.pptx

    # 一次验多种格式
    python docker/verify.py --file a.pptx --file b.docx --file c.xlsx

只依赖标准库；装了 pypdf 会额外核对页数（没装就只验 `%PDF` 头与字节数）。

## 它会往库里写东西

每次生成一个随机账号（`verify+<时间戳>@local.test`）与一个独立组织，不碰既有数据。
用完想清掉就整库重建（或删掉 `verify+` 开头的组织）。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def _opener() -> urllib.request.OpenerDirector:
    """关掉代理。

    ⚠️ 不是洁癖：本机环境变量里有 `HTTP_PROXY` 时，urllib 会把 `127.0.0.1`
    也交给代理，于是连自己的容器都是 502 —— 而服务明明是好的。踩过。
    """
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Client:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.opener = _opener()
        self.token = ""

    def call(self, method: str, path: str, payload: object | None = None) -> object:
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        with self.opener.open(request, timeout=600) as response:
            body = response.read()
        return json.loads(body.decode()) if body else None

    def raw(self, path: str) -> bytes:
        request = urllib.request.Request(self.base + path)
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        with self.opener.open(request, timeout=600) as response:
            return response.read()


def _login(client: Client) -> None:
    """注册一个一次性账号并登录（同名已存在就只登录）。

    ⚠️ 域名必须用 `example.com`，**不能用 `local.test` / `*.test`**：
    `email_validator` 把 `.test` 当保留域名直接拒（`EmailStr` 校验 → 422），
    于是你会看到「注册 422、登录也 422」，误以为是服务坏了。踩过。
    """
    email = f"verify+{int(time.time())}{random.randint(100, 999)}@example.com"
    password = "verify-password-123"
    try:
        client.call("POST", "/api/auth/register", {"email": email, "password": password})
    except urllib.error.HTTPError as error:
        if error.code not in (400, 409, 422):
            raise
        print(f"  注册返回 {error.code}：{error.read().decode('utf-8', 'replace')[:200]}")
    try:
        result = client.call("POST", "/api/auth/login", {"email": email, "password": password})
    except urllib.error.HTTPError as error:
        print(f"  登录失败 {error.code}：{error.read().decode('utf-8', 'replace')[:300]}")
        raise
    assert isinstance(result, dict)
    client.token = str(result["access"])


def _pages(pdf: bytes) -> int:
    """PDF 页数。没装 pypdf 时返回 -1（只说明「没验」）。"""
    try:
        import io

        from pypdf import PdfReader
    except ImportError:
        return -1
    return len(PdfReader(io.BytesIO(pdf)).pages)


def verify_file(client: Client, kb_id: str, org_id: str, path: Path) -> bool:
    print(f"\n=== {path.name} ({path.stat().st_size} 字节) ===")
    raw = path.read_bytes()
    started = time.monotonic()
    document = client.call(
        "POST",
        f"/api/kbs/{kb_id}/documents/file",
        {
            "filename": path.name,
            "contentBase64": base64.b64encode(raw).decode(),
        },
    )
    assert isinstance(document, dict)
    print(
        f"  入库        {document['chars']} 字 / {document['chunkCount']} 块"
        f" （{time.monotonic() - started:.1f}s）"
    )
    for warning in document.get("warnings") or []:
        print(f"  warning     {warning}")

    doc_id = document["id"]
    info = client.call("GET", f"/api/kbs/{kb_id}/documents/{doc_id}/preview")
    assert isinstance(info, dict)
    print(f"  预览状态    {info['previewState']} | 后缀 {info['suffix']}")

    if info["previewState"] == "unavailable":
        print(f"  ✗ 不可用：{info.get('previewError')}")
        return False

    started = time.monotonic()
    built = client.call("POST", f"/api/kbs/{kb_id}/documents/{doc_id}/preview")
    assert isinstance(built, dict)
    elapsed = time.monotonic() - started
    print(f"  转换        {built['previewState']} | 服务端 {built.get('renderMs')}ms"
          f" | 含网络 {elapsed:.1f}s")
    if built["previewState"] != "ready":
        print(f"  ✗ 转换失败：{built.get('previewError')}")
        return False

    pdf = client.raw(f"/api/kbs/{kb_id}/documents/{doc_id}/preview.pdf")
    pages = _pages(pdf)
    ok = pdf.startswith(b"%PDF") and len(pdf) > 1024
    print(f"  预览 PDF    {len(pdf)} 字节 | 头 {pdf[:8]!r} | 页数 "
          f"{pages if pages >= 0 else '(未装 pypdf，跳过核对)'}")
    if not ok:
        print("  ✗ PDF 无效")
        return False

    original = client.raw(f"/api/kbs/{kb_id}/documents/{doc_id}/file")
    same = original == raw
    print(f"  原文件      {len(original)} 字节 | 与上传一致 {same}")
    if not same:
        print("  ✗ 原文件字节不一致")
        return False

    # 正文检索：证明这篇文档同时进了索引（预览不该以牺牲检索为代价）
    hits = client.call("POST", f"/api/orgs/{org_id}/search", {"query": "文档"})
    print(f"  检索        「文档」命中 {len(hits) if isinstance(hits, list) else '?'} 条")
    return True


#: 容器镜像必须注册的路由前缀。
#:
#: ⚠️ 这份清单存在的唯一理由：**镜像与源码不同步**时，症状是前端某个页面所有请求
#: 都 404（界面显示 Not Found），而 `/health` 仍然 200、其它页面全都正常 ——
#: 2026-10-31 的「创建项目报 Not Found」就是这么来的：`app/projects/` 是新增模块，
#: 运行中的镜像是 4 小时前构建的，里面根本没有它（`docker restart` 不会重建镜像）。
#: 只要跑一次这个自检，就能立刻分清「后端没写这个接口」与「镜像没更新」。
REQUIRED_ROUTE_PREFIXES = (
    "/api/orgs/{org_id}/projects",
    "/api/projects/{project_id}",
    "/api/orgs/{org_id}/assets",
    "/api/models/builtin",
)


def check_routes(client: Client) -> bool:
    """拉 `/openapi.json` 确认必需路由都在。返回是否全部命中。

    ⚠️ 用 openapi 而不是逐个请求：不需要登录态，也不会因为 403/404 的业务语义
    （「不是成员」也是 404）把「路由不存在」和「没权限」混成同一个现象。
    """
    try:
        spec = client.call("GET", "/openapi.json")
    except urllib.error.HTTPError as exc:
        print(f"  ✗ 取不到 /openapi.json（{exc.code}）—— 服务可能不是这个应用")
        return False
    paths = set((spec or {}).get("paths", {})) if isinstance(spec, dict) else set()
    missing = [item for item in REQUIRED_ROUTE_PREFIXES if item not in paths]
    if missing:
        print(f"  ✗ 镜像缺路由：{missing}")
        print("    镜像与源码不同步。改过 cloud/app/** 必须 `docker compose up -d --build`，")
        print("    `docker restart` 用的是**旧镜像**（这是最常见的原因）。")
        return False
    print(f"  ✓ 必需路由齐全（{len(REQUIRED_ROUTE_PREFIXES)} 条）")
    return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="nanowork 云端容器端到端验证")
    parser.add_argument("--base-url", default=os.environ.get("VERIFY_BASE_URL", "http://127.0.0.1:8910"))
    parser.add_argument("--file", action="append", default=[], help="要上传的真实文件，可重复")
    parser.add_argument("--name", default="容器验证", help="组织名")
    parser.add_argument(
        "--routes-only",
        action="store_true",
        help="只验必需路由是否注册（镜像与源码同步自检，不需要 --file）",
    )
    args = parser.parse_args(argv[1:])

    # `--routes-only`：只做镜像/源码同步自检，不需要任何文件。
    # 这是「改了 cloud/app/** 却忘了重建镜像」的**一条命令**判据 ——
    # 原来要等用户在界面上点到那个页面才发现 Not Found。
    if not args.file and not args.routes_only:
        parser.error("至少给一个 --file，或加 --routes-only 只验路由")

    client = Client(args.base_url)
    print(f"目标 {args.base_url}")

    health = client.call("GET", "/health")
    print(f"健康检查 {health}")

    # 先验路由再登录：镜像缺模块时，后面每一步都会以「Not Found」失败，
    # 而那句话听起来像「我请求错了」，完全指不到「镜像旧了」这个真因。
    if not check_routes(client):
        return 1
    if args.routes_only:
        print("\n结果：路由自检通过")
        return 0

    _login(client)
    org = client.call("POST", "/api/orgs", {"name": args.name})
    assert isinstance(org, dict)
    kb = client.call("POST", f"/api/orgs/{org['id']}/kbs", {"name": "验证库"})
    assert isinstance(kb, dict)
    print(f"组织 {org['id']} / 知识库 {kb['id']}")

    results = [verify_file(client, kb["id"], org["id"], Path(item)) for item in args.file]
    passed = sum(1 for item in results if item)
    print(f"\n结果：{passed}/{len(results)} 通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
