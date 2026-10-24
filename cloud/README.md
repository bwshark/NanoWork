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
| `NANOWORK_KB_EMBEDDER` | `off` | 知识库向量检索：`off` / `hash` / `openai`（见下节） |
| `NANOWORK_KB_EMBED_DIM` | `256` | 仅 `hash`：哈希桶数。**调小会增加碰撞噪声**（无关文档也会得到正余弦），别低于 256 |
| `NANOWORK_KB_EMBED_BASE_URL` | —— | 仅 `openai`：如 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `NANOWORK_KB_EMBED_MODEL` | —— | 仅 `openai`：如 `text-embedding-v3` |
| `NANOWORK_KB_EMBED_API_KEY` | —— | 仅 `openai` |

## 知识库向量检索（可选，FR-4.7）

**默认 `off`：检索排序与之前逐条一致。** 打开会改变结果的先后顺序，所以不做成
默认值——升级不该悄悄改变用户看到的东西。

```bash
# 本地验证链路（无依赖、离线、确定性）
NANOWORK_KB_EMBEDDER=hash .venv/Scripts/python.exe -m uvicorn app.main:app --port 8910

# 真语义（任何 OpenAI 兼容的 /embeddings）
NANOWORK_KB_EMBEDDER=openai \
NANOWORK_KB_EMBED_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1" \
NANOWORK_KB_EMBED_MODEL="text-embedding-v3" \
NANOWORK_KB_EMBED_API_KEY="sk-..." \
  .venv/Scripts/python.exe -m uvicorn app.main:app --port 8910
```

| 档位 | 是不是语义 | 说明 |
|---|---|---|
| `hash` | **不是** | 词袋的随机投影（中文双字 + 拉丁词）。只认字面重合，同义词搜不到；用它是为了验证整条链路与索引覆盖率 |
| `openai` | 是 | 真正的 embedding；向量存 `kb_vectors`（`(chunk_id, model)` 主键，换模型不互相污染） |

三条行为约定：

1. **排序是混合的**（词法 + 余弦经 RRF 合并）。词法抓精确词/编号，向量抓近似表达；
   只有一路命中时也会出现（词法空、向量中 → 纯向量结果）。
2. **可见性不受影响**：候选仍然先按角色 + `kbIds` 收窄（SQL `IN`），向量只参与排序。
3. **索引缺失不是错误**：老文档没建索引时它们不参与向量排序（不是按 0 分参与），
   检索照常可用。补索引用 `POST /api/kbs/{kbId}/reindex`（幂等、分批、中途失败
   会回报已写入多少）；当前覆盖率看 `GET /api/kb/retrieval`，知识库页会把它显示成
   一句人话（并给出「重建索引」按钮）。

**未做（别当成已有）**：没有 ANN 索引（候选全取进内存算余弦，适合单库几百到几千块）；
没有 Office/PDF 解析（只收纯文本）；向量与正文没有版本绑定（换 embedder 必须重建）。

## 两条服务端不变量（改这块前必读）

1. **`updated_at` 取服务端接收时间**（§5.3）：客户端上报的时间只存进
   `client_updated_at` 供审计，裁决与落库一律用 `utc_now()`。否则一台系统时间
   调快的设备会永久赢下所有 LWW。
2. **游标用 `server_seq`，不是行 id**：push 是 UPDATE，行 id 不变。若拿 id 当
   cursor，对端游标一旦越过该行，此后该实体的**任何更新都拉不到**——症状是
   「第一次同步成功、之后再也不动」。`tests/test_sync.py` 有一条专门守它。
