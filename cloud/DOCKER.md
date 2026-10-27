# 用 Docker 跑云端服务（Linux）

一份镜像装齐：FastAPI 后端 + LibreOffice（把 pptx/docx/xlsx 转成 PDF 供「原文」视图）。
**不需要 Windows，不需要 Office**，也不需要宿主机的 Python。

## 1. 起服务

```bash
cd cloud
docker compose up -d --build      # 首次构建 5–10 分钟（LibreOffice 层较大）
docker compose ps                 # 等 STATUS 变成 healthy
curl http://127.0.0.1:8910/health # {"status":"ok"}
```

客户端（Electron / Web）默认连的就是 `8910`，**不用改配置**。要换端口：
`NANOWORK_CLOUD_PORT=9000 docker compose up -d`。

> 拉不到 `python:3.12-slim`（内网/镜像源环境常见）时换基础镜像，内容一致：
> ```bash
> BASE_IMAGE=<你的镜像源>/library/python:3.12-slim docker compose build
> ```
>
> 国内构建建议同时换 apt 源（快很多，也躲开 `deb.debian.org` 偶发的 502）：
> ```bash
> APT_MIRROR=mirrors.aliyun.com docker compose build
> ```

## 2. 验一遍（真上传、真转换）

```bash
# 在宿主机上跑，对着已启动的容器（只依赖标准库，装了 pypdf 会顺手核对页数）
python docker/verify.py --file "D:/Downloads/大模型的本地部署和微调.pptx"

# 或者把样本放进数据卷，在容器里跑
docker cp sample.pptx nanowork-cloud:/data/sample.pptx
docker compose exec cloud python docker/verify.py --file /data/sample.pptx
```

期望看到：`入库 N 字 / M 块` → `预览状态 pending` → `转换 ready` → `预览 PDF … 页数 40`
→ `原文件 … 与上传一致 True`。这就是「Linux 上真能转」的判据。

## 3. 数据在哪、怎么备份

| 东西 | 位置 |
| --- | --- |
| SQLite 数据库 | 命名卷 `nanowork-data` → 容器内 `/data/cloud.db` |
| 文档原文件与预览 PDF | 同一个库（`kb_files` 表） |
| 图片资产 | 同一个库（`kb_assets` 表） |

```bash
# 备份（导出成一个 tar，含 WAL）
docker run --rm -v nanowork-cloud_nanowork-data:/data -v "$PWD":/backup \
  alpine tar czf /backup/cloud-backup.tar.gz -C /data .

# 恢复
docker compose down
docker run --rm -v nanowork-cloud_nanowork-data:/data -v "$PWD":/backup \
  alpine sh -c "cd /data && tar xzf /backup/cloud-backup.tar.gz"
docker compose up -d
```

> 想直接用宿主机目录（bind mount）也行，但要把属主改成容器内的 `10001`：
> `sudo chown -R 10001:10001 /srv/nanowork-data`。不改的话 SQLite 写不进去，
> 症状是「上传成功，重启后文档全没了」。

## 4. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NANOWORK_CLOUD_DB_URL` | `sqlite:////data/cloud.db` | 换 Postgres 只改这一处；**四道斜杠**才是绝对路径 |
| `NANOWORK_CLOUD_ORIGINS` | 本地几个 dev server | 从浏览器直连时必填（逗号分隔，写全 `scheme://host:port`）。Electron 走主进程，不受 CORS 限制 |
| `NANOWORK_CLOUD_PORT` | `8910` | 宿主机端口 |

## 5. 和 Windows 版有什么不一样

| | Windows（COM） | 容器（LibreOffice） |
| --- | --- | --- |
| 依赖 | 装 Office + pywin32 | 镜像内自带（LibreOffice 25.2 + Noto CJK + Wine 符号字体），零外部依赖 |
| 保真度 | PowerPoint/Word 自己转，最准 | 文字/位置/配色/分页都在；艺术字、部分 SmartArt、动画有偏移；断行位置偶尔差一两个字 |
| 项目符号 | 原样 | 已处理：`fonts-wine` 提供 Wingdings/Webdings 兼容字形（否则 `●` 会渲染成字母 `l`） |
| 转换耗时 | 40 页课件约 8.7 秒 | 40 页课件约 **2.2 秒**，docx/xlsx 各 0.8 秒 |
| 镜像体积 | —— | 1.1 GB（LibreOffice 约 700MB，其余是 Python + 字体） |
| 能力探测 | `backend() == "com"` | `backend() == "libreoffice"` |

两者产出都是 PDF，前端 pdf.js 那条链路完全一样，接口一个没变。

## 6. 排错

| 症状 | 原因 / 处理 |
| --- | --- |
| 预览状态一直 `unavailable` | 镜像里没有 `soffice`。`docker compose exec cloud which soffice` 应有输出；没有就说明构建时 apt 层失败，重 `--no-cache` 构建 |
| PDF 里中文是方框 | 缺 CJK 字体（正常镜像不会）。`docker compose exec cloud fc-list :lang=zh` 应列出 Noto CJK |
| `转换失败：LibreOffice 没有产出 PDF` | 文件本身坏了，或版式太复杂超时。看 `docker compose logs cloud`；单文件上限 180 秒（`render.RENDER_TIMEOUT_SECONDS`） |
| 上传大文件 413 | 前面有 Nginx 时它默认只放 1MB：`client_max_body_size 16m;` |
| 容器 healthy 但客户端连不上 | 检查 `NANOWORK_CLOUD_PORT` 与客户端配置里的端口是否一致；`curl` 从宿主机打一下 |
| 重启后数据没了 | `NANOWORK_CLOUD_DB_URL` 少了斜杠（变成相对路径），或 bind mount 属主不是 10001 |

## 7. 升级

```bash
git pull                          # 代码更新
docker compose up -d --build      # 重建并滚动替换
docker image prune -f             # 清掉旧层
```

启动时会自动跑 `create_all()` + `ensure_columns()`（只加列不改不删），
老库可以直接用。**仍然建议升级前先备份**（见第 3 节）。

## 8. 放在反向代理后面

镜像已经带 `--proxy-headers --forwarded-allow-ips "*"`，Nginx/Caddy 只需：

```nginx
location / {
    proxy_pass http://127.0.0.1:8910;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 16m;      # 上传是 base64 JSON，实际体积 ≈ 原文件 × 1.34
    proxy_read_timeout 300s;       # 首次转换可能 20 秒以上，别用默认 60 秒
}
```

预览 PDF 与图片都走 `Authorization` 头带票，**不要**给它们配匿名直链缓存。
