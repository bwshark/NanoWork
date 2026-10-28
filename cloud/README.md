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

> **Linux / 服务器部署走 Docker**：见 [DOCKER.md](DOCKER.md)。
> 镜像里自带 LibreOffice，「原文」视图不需要 Windows 也不依赖 Office：
> `docker compose up -d --build`（端口与数据卷、备份、排错都在那份文档里）。
>
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

## 知识库文档解析（可选，FR-4.7）

上传文件时服务端**先解析成纯文本再切块**，解析失败不会留下半篇文档。

| 格式 | 实现 | 依赖 |
|---|---|---|
| `.txt` / `.md` / `.csv` | UTF-8 → GB18030 依次尝试 | 标准库 |
| `.docx` | 读 zip 里的 `word/document.xml` 抽段落（表格按段落展开） | 标准库 |
| `.xlsx` | 读 `sharedStrings.xml` + 各 sheet 的 `<row>`，**一行一段**（`单元格 | 单元格`） | 标准库 |
| `.pptx` | 各 `slideN.xml` 里的 `<a:t>`，按**页号数字**排序（`slide10` 不能排到 `slide2` 前） | 标准库 |
| `.pdf` | 抽文本层 | **可选**：`pip install -i https://pypi.org/simple pypdf` |
| `.doc`（Word 97-2003） | 先用 Word / LibreOffice **转成 `.docx`**，再走 `.docx` 那条（表格行列因此保得住） | **需要 Office 或 LibreOffice** |
| 旧版 `.xls/.ppt` | 422，提示另存为 `.xlsx / .pptx / .pdf` | —— |
| 图片（png/jpg/…） | 422，**给出三条 OCR 路径**（OCR 导出 txt / 另存带文本层的 PDF / 直接粘贴正文） | —— |
| 扫描件 PDF | 422，提示先 OCR（空文本层不入库） | —— |

`.xlsx` / `.pptx` 的三条口径：**行列结构不保留**（表格按行摊成文本）必须写进
`warnings`；公式取**缓存值**（`<v>`）而不是公式文本；单表超过 2 万格截断并告警
（整本台账当知识库既超字数上限又毫无检索价值）。

**OCR 明确不做**：它需要模型/引擎，识别质量直接决定检索质量。能做的只有
"把该怎么办说清楚"，这一点落在 422 的文案里。

⚠️ `.doc` 是**唯一**依赖办公套件的解析路径（其余格式全是标准库 / 可选 pypdf）。
没有 Office / LibreOffice 的部署会在 422 里说「另存为 .docx 再传」——那是能力缺失，
不是失败。判据：`tests/test_kb_parsing.py` 的 `.doc` 五例（转换失败 / 无转换器 /
伪装成 .doc 的 docx / 文件头不对 / 端到端可检索且原文件原样保留）+
`tests/test_office2pdf.py::test_doc_converts_to_docx_and_parses`（真 Word 转真文件）。

```bash
# 装可选依赖（国内镜像可能没有这个包，加 -i 走官方源）
.venv/Scripts/python.exe -m pip install -e ".[parse]" -i https://pypi.org/simple
```

接口（base64 JSON，不引入 `python-multipart`）：

```http
POST /api/kbs/{kbId}/documents/file
{ "filename": "差旅制度.docx", "contentBase64": "...", "title": "可选" }
```

三条口径：

1. **上限**：单文件 8MB（`parsing.MAX_UPLOAD_BYTES`）、单篇正文 20 万字（超过要求拆分，**不截断**
   ——静默截断等于丢资料）。前端也会预检一次，避免传完 11MB 才看到 422。
2. **降级必须说出来**：PDF 有页面没文本层、docx 里的表格被摊平，都会进响应的 `warnings`，
   客户端逐条弹出。**不弹**的后果是"我明明传了那份资料，它就是搜不到"。
3. **扫描件不假装成功**：没有文本层的 PDF 直接 422 并提示先 OCR，不入库空文档
   （空文档会占块数、永不出现在结果里）。

**未做**：`.xlsx` / `.pptx`、OCR、图片内文字、`.doc`（二进制格式）；PDF 只取文本层，
不保留版面与表格结构。

## 部门与「按部门收窄」的知识库（FR-12.2 / FR-4.7）

部门树用来把知识库的可见范围收窄到「某几条线的人」。规则只有一条，写在
`app/kb/visibility.py::allows()`：

```
admin / owner  → 一律可见（管理豁免）
member         → 角色 ∈ allowed_roles  AND  ( 不按部门收窄 OR 我直属的部门 ∈ 允许集合的子树 )
```

四条容易搞反的地方：

1. **部门是收窄，不是放行**。反过来（部门作为一条放行通道）会让「只给人事部看」失效：
   任何 member 都能靠角色那一路进来。
2. **子树方向只有一个**：把「允许的部门」往下展开，再和「我直属的部门」求交。反着算
   （把我的部门往下展开）会漏掉「人在子部门、库共享给父部门」——那是共享语义的一半。
3. **管理豁免**：admin/owner 始终可见可改。少了它会出现死锁——一个只给「人事部」看的库，
   管理员不在人事部时既看不到也改不了范围，而改范围只有管理员能做。
4. **两个入口同一条规则**：列表、直连（`_kb_or_404`）、检索预过滤都走 `allows()`。
   分开写就会长出「列表看不到、按 id 却读得到」这种组合漏洞。

接口：

```http
GET    /api/orgs/{orgId}/departments            # 父在子前的扁平列表（客户端按 parentId 缩进）
POST   /api/orgs/{orgId}/departments            # {name, parentId?}  admin
PATCH  /api/departments/{id}                    # {name?, parentId?} admin（改名 / 换父节点）
DELETE /api/departments/{id}                    # admin；有子部门/成员/被库引用 → 409
GET    /api/departments/{id}/members
POST   /api/departments/{id}/members            # {email}  要求已是组织成员
PATCH  /api/departments/{id}/members/{userId}   # {role}   member | manager
DELETE /api/departments/{id}/members/{userId}
```

### 移动（换父节点）

`PATCH` 的 `parentId` 三档语义：**不传 = 不动结构**；`""` = 移到根；具体 id = 挂到它下面。
`""` 这一档不能省——否则表达不了「把子部门提成根部门」。

四条校验（缺一条都会把树写坏）：不能挂自己、**不能挂到自己的子孙里**（环）、
层级上限按**整棵子树的高度**算（不是只看新父深度）、新父下不能同名。

### 部门负责人（部门内角色）

`PATCH .../members/{userId}` 只有两档：`member` / `manager`。与**组织角色**是两个维度：

| | 决定什么 |
|---|---|
| 组织角色（owner/admin/member） | 能不能**看**（配合部门范围） |
| 部门角色（member/manager） | 这条线的资料能不能**维护** |

写权限判定在 `kb/routes._writable_kb_or_404`：**组织 admin/owner** 或
**该库某个允许部门的 manager**。边界很要紧：**只对有部门范围的库成立**——
没有部门范围的库没有"这条线归谁管"，只能由组织管理员维护，否则部门负责人
就能改一个全组织可见的库，写权限比读权限还宽。

建库时带 `allowedDepartments: ["<deptId>"]` 即收窄；`[]` = 不按部门收窄。

**未做**：换父节点（移动部门）、部门级角色（现在部门只有归属）、界面上改库范围的入口。

## 向量检索的规模边界（为什么还没有 ANN）

当前实现是**精确检索**：把候选块的向量全取进内存，在 Python 里逐个算余弦，
复杂度 `O(候选数 × 维度)`。单库几百到几千块、维度 256 时毫秒级，够用；
十万级块时内存与耗时都会失控，那时正确的做法是 **pgvector**（或 HNSW）。

**现在不写 pgvector 代码，是刻意的**：本机没有 Postgres 实例，
一条没跑过的 SQL 路径就是"看起来支持 pgvector"——真上线时才会发现驱动、
方言、`vector` 类型的写入方式都不一样。**未验证的代码路径不写**，
这是本仓反复强调的"不要假绿"。

真正要做时，接入点只有两处（其余不动）：

| 现在 | 换成 pgvector |
|---|---|
| `vectors.load_vectors()` 把候选向量全取回 Python | 改成一条 `ORDER BY vector <=> $1 LIMIT k`（走 ivfflat/hnsw 索引） |
| `retrieval.rank_by_vectors()` 在 Python 里算余弦 | 不再需要（距离由索引算好） |

配套要做的：① `kb_vectors` 换成 `vector(dim)` 列（维度必须与 embedder 一致，
不一致的行直接跳过 —— 错位点积是**看似有分**的噪声）；② 建 ivfflat / hnsw 索引；
③ 按 `NANOWORK_KB_VECTOR_BACKEND` 选择实现；④ **用同一批用例跑**
（`tests/test_kb_vector.py` 里的可见性不变量必须原样通过 —— 换检索实现时，
最容易顺手把「过滤」挪到打分之后）。

一个**中间档**是现在就能做的：候选数超过阈值时先用词法粗筛再算向量（两级检索）。
它不解决内存问题（向量还是要取），但能把余弦计算量压到候选集的一小部分。

## 文档生命周期：判重 / 删除 / 改名 / 写入权限

```http
GET    /api/kbs/{kbId}/documents                     # 列表：kind + 每篇已建向量条数
GET    /api/kbs/{kbId}/documents?includeDeleted=true # 回收站（只看删过的）
POST   /api/kbs/{kbId}/documents                     # 粘贴入库（判重 → 重复返回 409）
POST   /api/kbs/{kbId}/documents/file                # 文件入库（解析后同样判重）
PATCH  /api/kbs/{kbId}/documents/{docId}             # 改名（内容不动）
DELETE /api/kbs/{kbId}/documents/{docId}             # 删除 → **进回收站**（可恢复）
DELETE /api/kbs/{kbId}/documents/{docId}?purge=true  # 彻底删除（不可撤销）
POST   /api/kbs/{kbId}/documents/{docId}/restore     # 从回收站恢复
```

四条口径：

1. **读写分权**：`allowed_roles` 只控制**读**；入库 / 上传 / 改名 / 删除要求 **admin**。
   否则「全员可见的制度库」上任何成员都能删别人的资料。这是写侧加门槛、读侧不动。
2. **判重按内容、作用域是本库**：摘要按**切好的块**算（`app/kb/digest.py`），所以换行/缩进
   差异骗不过去；跨库同内容是正常用法，不拦。重复返回 **409** 并点名「已在库里的是《X》」。
3. **删除默认是软删（回收站）**：`deleted_at` 打时间戳，块与向量**留着**（恢复时才不用
   重建索引）。所以"删了搜不到"靠的是查询条件（`KbDocument.deleted_at == ''` 的 join）——
   它写在 `search_org_kbs` / `reindex_kb` / `list_documents` / `vector_coverage` 四处，
   **少一处就是"删掉了还能被搜到"**。
4. **彻底删除才动三张表**：`kb_vectors` → `kb_chunks` → `kb_documents`。只删文档行会留下
   **孤儿块**（带着 kb_id，照样被检索命中）。
5. **回收站保留 30 天**，过期由**惰性清理**（下一次列表请求顺手清）兜底，不依赖外部调度：
   没有调度器的部署里「靠 cron 清理」等于「永远不会清理」。
6. **判重认得回收站**：回收站里已有同内容时回 409 并说「恢复它就行」，而不是让用户重传
   （重传会被判重拦下，用户会以为必须彻底删除——那白丢一次索引重建）。

成员/只读身份调写接口一律 403；跨库拿别人的 `kbId` 删文档一律 404（`doc.kb_id != kb.id`）。

## 加字段：先改模型，再登记迁移

`create_all()` **不会**给已存在的表加列。所以新增字段要动两处：

1. `app/kb/models.py`（或对应模块）里加字段；
2. `app/migrations.py` 的 `ADDED_COLUMNS` 登记一行 `(表, 列, DDL)`，**必须带 `DEFAULT`**
   （已有行要能立刻取到值）；需要索引的再往 `ADDED_INDEXES` 加一行。

启动时 `create_db_and_tables()` 会先 `create_all`（建缺失的表）再 `ensure_columns`
（给老库补列/索引），幂等，改动会打 warning 日志。

三条限制是刻意的：**只加、不改、不删**。`DROP COLUMN` 在旧 SQLite 上不支持，而「悄悄
删列」在存档型数据上不会报错、只会让用户的数据静默消失。要改语义就加新列 + 回填。

判据：`tests/test_migrations.py`（老形状表 → 跑迁移 → 列出现 / 老行拿到默认值 / 第二次是空操作）。

## 两条服务端不变量（改这块前必读）

1. **`updated_at` 取服务端接收时间**（§5.3）：客户端上报的时间只存进
   `client_updated_at` 供审计，裁决与落库一律用 `utc_now()`。否则一台系统时间
   调快的设备会永久赢下所有 LWW。
2. **游标用 `server_seq`，不是行 id**：push 是 UPDATE，行 id 不变。若拿 id 当
   cursor，对端游标一旦越过该行，此后该实体的**任何更新都拉不到**——症状是
   「第一次同步成功、之后再也不动」。`tests/test_sync.py` 有一条专门守它。
