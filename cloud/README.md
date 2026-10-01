# cloud/ —— V1.5 跨端同步服务端

与 `nanobot/` 并列的仓库根子目录，**不新增第二个嵌套 git**（m6 §六 待确认 #1）。
承载认证与同步，单一 FastAPI 进程；不引入 Node、不依赖 nanowork 既有后端（当前不存在）。

落点与设计依据见 [`docs/architecture-m6-sync.md`](../docs/architecture-m6-sync.md) §3.1。

## 目录

```
cloud/
├── app/
│   ├── main.py            # FastAPI 入口（CORS + /health）
│   ├── db.py              # SQLModel engine：开发 SQLite / 生产 PostgreSQL
│   ├── timeutil.py        # 全场统一 aware UTC
│   ├── auth/              # register / login / refresh / logout / me
│   └── sync/              # sync_items 表 + LWW merger + push / pull
├── tests/                 # pytest：auth 生命周期 + LWW 三级 + push/pull 往返
└── pyproject.toml
```

## 环境

```bash
cd cloud
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"     # Windows
# source .venv/bin/activate && pip install -e ".[dev]"  # macOS / Linux
```

> **本机已知坑**：全局 pip 指向清华镜像且当前不可达，`pip install -e` 会去拉
> build backend（setuptools）而失败，报
> `Could not find a version that satisfies the requirement setuptools>=68`。
> 两种解法：① 显式 `-i https://pypi.org/simple`；② 直装同名依赖
> （`pip install fastapi uvicorn sqlmodel pyjwt bcrypt pytest httpx ruff email-validator`）。
> 依赖的**唯一事实源始终是 `pyproject.toml`**，直装只是绕过镜像的权宜之计。

## 门禁

```bash
.venv/Scripts/python.exe -m ruff check app tests
.venv/Scripts/python.exe -m ruff format --check app tests
.venv/Scripts/python.exe -m pytest
```

CI 见 `.github/workflows/ci.yml` 的 `cloud-gate` 作业——这是本项目**第一次出现
Python 侧门禁**，与 `nanobot/` 分开（那里是只读参考，不得为它加测试依赖）。

## 启动

> 报错 `net::ERR_CONNECTION_REFUSED` 到 `http://127.0.0.1:8910` 的根因就是**服务没起**。
> 按下面任一方式拉起即可，并保持该终端开启（Ctrl+C 停止）。

**Windows（PowerShell / Git Bash，推荐，单条命令）：**

```bash
cd cloud
$env:NANOWORK_CLOUD_DB_URL="sqlite:///./cloud.db"
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8910
```

**Windows（cmd）：**

```bat
cd cloud
set NANOWORK_CLOUD_DB_URL=sqlite:///./cloud.db
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8910
```

**macOS / Linux：**

```bash
cd cloud
NANOWORK_CLOUD_DB_URL="sqlite:///./cloud.db" \
  .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8910
```

启动成功后会看到 `Uvicorn running on http://127.0.0.1:8910` 日志。

**验证是否真的起来了（另开一个终端）：**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8910/health
# 期望输出 200；401 也说明已连通（只是账号密码不对）
```

端口 **8910** 的全仓唯一出处是设计文档 §16.6（未写进代码常量，改动前先核对）。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NANOWORK_CLOUD_DB_URL` | `sqlite:///<cloud>/cloud.db` | 生产换成 PostgreSQL URL，schema 不变 |
| `NANOWORK_CLOUD_SECRET` | 开发用固定值 | **生产必须设置**：否则重启即换密钥，所有 token 失效（表现为「用户随机掉线」） |
| `NANOWORK_CLOUD_ENV` | —— | 设为 `production` 时，缺 `NANOWORK_CLOUD_SECRET` 直接启动失败（fail-fast） |
| `NANOWORK_CLOUD_ORIGINS` | 本地 dev server 列表 | CORS origins；带凭据时**不能用 `*`** |

## 两条服务端不变量（改这块前必读）

1. **`updated_at` 取服务端接收时间**（§5.3）：客户端上报的时间只存进
   `client_updated_at` 供审计，裁决与落库一律用 `utc_now()`。否则一台系统时间
   调快的设备会永久赢下所有 LWW。
2. **游标用 `server_seq`，不是行 id**：push 是 UPDATE，行 id 不变。若拿 id 当
   cursor，对端游标一旦越过该行，此后该实体的**任何更新都拉不到**——症状是
   「第一次同步成功、之后再也不动」。`tests/test_sync.py` 有一条专门守它。
