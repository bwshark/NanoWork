"""FastAPI 入口。

CORS 这一段是 m6 §六 待确认 #14 的落点，两个值都不能随手改：

- **`allow_credentials=True` 必须配显式 origins，不能配 `*`**：浏览器会直接拒绝
  带凭据的跨站请求（`* ` 与 credentials 互斥）。所以 origins 走环境变量，
  默认只放行本地 dev server。
- **`SameSite` / `Secure` 在 Web 端是跨站场景**（`vite:5173` ↔ `uvicorn:8910` 不同源）。
  MVP 用 Bearer header 而非 cookie，因此服务端不设 cookie——这条留给批次 4
  的 Web token 落地时再处理，别在这里提前引入半套 cookie 逻辑。
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session

from app.account import routes as account_routes
from app.auth import routes as auth_routes
from app.catalog import routes as catalog_routes
from app.catalog.seed import ensure_seed
from app.db import create_db_and_tables, engine
from app.kb import routes as kb_routes
from app.orgs import department_routes
from app.orgs import routes as org_routes
from app.orgassets import routes as org_asset_routes
from app.projects import routes as project_routes
from app.sync import routes as sync_routes


def _default_origins() -> list[str]:
    raw = os.environ.get("NANOWORK_CLOUD_ORIGINS")
    if raw:
        return [item.strip() for item in raw.split(",") if item.strip()]
    return [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # `vite.config.ts` 的 dev server 实际端口是 5176（不是 5173）。
        # 少放行它，Web 端带 `Authorization` + `application/json` 的 preflight
        # 会被 CORS 拦下——登录链路直接走不通。
        "http://localhost:5176",
        "http://127.0.0.1:5176",
        "http://localhost:5199",
        "http://127.0.0.1:5199",
    ]


@asynccontextmanager
async def lifespan(_: FastAPI):  # type: ignore[misc]
    # `on_event("startup")` 已被 FastAPI 标记废弃，改用 lifespan
    create_db_and_tables()
    # 内置模型种子：只补缺失的 id，绝不覆盖库里已有的行（运维改过的地址 / 密钥
    # 不能被一次重启冲回出厂值）。见 `catalog/seed.py` 文件头。
    with Session(engine) as session:
        ensure_seed(session)
    yield


app = FastAPI(title="nanowork cloud", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_default_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_routes.router)
app.include_router(sync_routes.router)
app.include_router(catalog_routes.router)
app.include_router(org_routes.router)
app.include_router(department_routes.router)
app.include_router(kb_routes.router)
app.include_router(project_routes.router)
app.include_router(org_asset_routes.router)
app.include_router(account_routes.router)


@app.get("/health")
def health() -> dict[str, str]:
    # 免鉴权根路径：客户端心跳优先打它（记忆 §7.13.6）
    return {"status": "ok"}
