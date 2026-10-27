# nanowork 云端服务（Linux 容器）
#
# 单阶段镜像：应用 + LibreOffice。**不需要 Office，也不需要 Windows** ——
# pptx/docx/xlsx → PDF 由容器内的 LibreOffice 完成（`app/kb/office2pdf.py`
# 的 `libreoffice` 后端），前端仍用 pdf.js 渲染，与 Windows 上完全同一套协议。
#
# 为什么不是多阶段：这里没有编译产物（Python 全是源码 + wheel），多阶段只会
# 让「构建时能跑、运行时缺库」这类问题更难查。真正需要隔离的是「装依赖」与
# 「跑服务」两件事，那已经由 apt 顺序 + 非 root 用户保证了。

# 基础镜像可覆盖：默认官方 `python:3.12-slim`；在内网/镜像源环境里
# （比如国内加速器、企业 Harbor）用 `--build-arg BASE_IMAGE=...` 换掉即可，
# 镜像内容一致，只是拉取路径不同。
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/home/app \
    NANOWORK_CLOUD_DB_URL="sqlite:////data/cloud.db"

# ── 系统层 ────────────────────────────────────────────────────────────────────
# LibreOffice 三件套：
#   `libreoffice-impress` → .pptx/.ppt，`-writer` → .docx/.doc，`-calc` → .xlsx/.xls
#   三个都装是因为**转换 filter 是按组件打包的**：只装 core 时 impress 文件会
#   报「no export filter」。`--no-install-recommends` 很关键 —— 推荐依赖会把
#   Java 运行时（~200MB）与 GNOME 集成一并拖进来，无头容器一个都用不上。
#
# 中文字体是硬需求，不是可选优化：缺字体时 LibreOffice 会用方框替代汉字，
# 转出来的 PDF「能打开、但满页豆腐块」，而且**不报任何错**。用 Noto CJK
# （思源黑体的上游）覆盖简繁日韩。
#
# `fonts-wine` 是为了 **Wingdings / Webdings / Symbol / Marlett** 这几个符号字体：
# 中文课件极常见用 Wingdings 的 `l` 当项目符号，缺字体时它会**原样渲染成一个
# 拉丁字母 l**（「l 目前大模型存在的问题」），比缺字更像内容错误。Wine 自带
# 这几个字体的开源兼容实现（LGPL），一个包不到 1MB。
# ⚠️ 它们装在 `/usr/share/wine/fonts`（不在 fontconfig 的默认搜索路径里），
# 所以下面还要显式把该目录登记进去 —— 只装包不登记等于没装。
#
# `tini` 当 PID 1：uvicorn 对 SIGTERM 的处理依赖信号真的送到它手上；
# 不用 init 时，容器里 1 号进程是 uvicorn 本身（能收信号），但子进程
# （LibreOffice）会被孤儿化，`docker stop` 之后可能留一片僵尸进程。
# apt 源可覆盖：默认官方源；国内/内网构建换镜像源能快一个数量级，也躲开
# deb.debian.org 偶发的 502。
#   docker build --build-arg APT_MIRROR=mirrors.aliyun.com -t nanowork-cloud .
ARG APT_MIRROR=""

RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
        sed -i "s|http://deb.debian.org|https://${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
        libreoffice-impress \
        libreoffice-writer \
        libreoffice-calc \
        fonts-noto-cjk \
        fonts-dejavu-core \
        fonts-wine \
        ca-certificates \
        tini; \
    printf '%s\n' \
        '<?xml version="1.0"?>' \
        '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
        '<fontconfig><dir>/usr/share/wine/fonts</dir></fontconfig>' \
        > /etc/fonts/conf.d/99-wine-fonts.conf; \
    fc-cache -f; \
    rm -rf /var/lib/apt/lists/* /usr/share/doc/*; \
    useradd --create-home --uid 10001 --shell /usr/sbin/nologin app; \
    mkdir -p /data; \
    chown -R app:app /data /home/app

# ── 应用层 ────────────────────────────────────────────────────────────────────
WORKDIR /app

# 先拷依赖声明与源码再 install：没有 `requirements.txt`，来源统一是 pyproject.toml
# （两处声明版本必然漂移）。`[parse]` 带上 pypdf —— 知识库要解析 PDF 正文，
# 少了它上传 PDF 会 422，而这里恰恰是「按原格式打开 + 正文检索」都要 PDF 的场景。
COPY pyproject.toml ./
COPY app ./app
COPY docker ./docker
RUN pip install --no-cache-dir ".[parse]"

USER app

# 构建期就验一次 LibreOffice，而且**以运行身份验**：
# - 装失败（缺 impress filter、缺字体）要在构建时炸，而不是等用户上传第一篇课件；
# - 必须放在 `USER app` 之后：以 root 跑 `soffice` 会在 `/home/app/.cache` 留下
#   root 属主的目录，运行用户写不进去 —— 症状是一行 `dconf-CRITICAL` 加
#   「LibreOffice 启动慢/偶发失败」，很难联想到是构建顺序的锅。
# 这一步顺便把 profile/cache 目录按正确属主建好。
RUN soffice --headless --norestore --version

EXPOSE 8910

# 用 python 而不是 curl 做健康检查：少一个包，且判的是应用自己能不能答。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8910/health', timeout=3).status == 200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
# 单 worker：转换互斥（`render._LOCK`）是**进程内**的，多 worker 等于多把锁同时开工，
# LibreOffice 会互相抢 profile。要横向扩容就多开容器。
# `--proxy-headers` 让放在 Nginx/Caddy 后面时能拿到真实客户端 IP 与 scheme。
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8910", \
     "--workers", "1", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
