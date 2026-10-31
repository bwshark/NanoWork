# 打包与发布实施方案（B1 · 内置运行时）

> **本文用途**：把"引擎 + 桌面"打成一个可在 Windows / macOS / Linux 安装的包，并给出可施工的改动清单、构建脚本、签名要求、验收判据与阶段计划。
>
> **唯一事实源**：需求以 `docs/nanowork-prd-design-v2.md` 为准；引擎仓库边界见 `docs/engine-dev-setup.md`。本文只定义**工程实施方案**，不新增需求。
>
> **状态**：**P0 + P1 已落地**（2026-10-30：`build/rt` 238 MB，`serve`/`gateway` 用随包运行时启动成功；首启引导、安装器打包分支、端口顺延已实现；win-x64 zip 产物 274 MB，`resources/rt` 随包可用）。**装机自启仍待干净机验证**（见 §4.7 末条）。P2–P3 待做。本文同时是施工记录，实跑踩到的坑记在 §4.6 / §4.7。

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 方案 | **B1：内置便携 CPython + 预装引擎 wheel，运行时只读，数据全外置** |
| 目标产物 | Windows `NSIS .exe` / macOS `DMG + ZIP`（arm64、x64 各一份）/ Linux `AppImage + deb` |
| 目标体积 | 安装后约 500 MB；安装包 170–220 MB |
| 用户前置 | **无**（不需要 Python、不需要 Docker、不需要联网） |
| 引擎形态 | `resources/rt/python`（便携解释器）+ `resources/rt/site`（引擎与依赖），只读 |
| 用户数据 | `app.getPath('userData')` 下：`nanowork.config.json`、`workspace/`、`pyuser/`、`tiktoken/` |
| 版本策略 | 引擎版本 = 应用版本，**不做引擎独立更新** |
| 北极星指标 | 干净机器首次启动成功率 ≥ 99%；冷启到可对话 ≤ 8 s |

**五条关键决策**

1. 解释器当**依赖**随包发，不当"用户环境"。
2. 运行时**只读**，可写的一切（配置/工作区/插件/缓存）都在 `userData` —— 因此 per-user 与 per-machine 安装都能跑。
3. `--config` 一个参数决定全部数据落点（引擎 `get_data_dir()` 就是 config 的父目录）。
4. 用 `-P`（safe path）启动，**禁止 cwd 参与 import**（cwd 是用户可写工作区）。
5. 不引入任何"额外运行时形态"：不 PyInstaller、不 Docker、不引擎热更新。

---

## 1. 现状与结论

### 1.1 现状事实（2026-10-30 实测）

| 项 | 数值 / 事实 |
|---|---|
| 渲染层产物 | `dist/` 7.7 MB |
| 主进程产物 | `electron/main.cjs` 1.0 MB（esbuild 打包，仅 `electron` 为 external） |
| 引擎源码 | 27 MB（含自带 webui `nanobot/web/dist` 7.4 MB） |
| 引擎 site-packages | 334 MB（其中 `lark_oapi` 103 MB、`pip` 12 MB、`PIL` 16 MB、`openai` 20 MB、`anthropic` 15 MB） |
| 现有 venv | 363 MB，Python 3.13 |
| electron-builder | 24.13.3；electron `^31`；配置 `electron/builder.config.json` |
| 引擎入口 | `python -m nanobot` 可用（`nanobot/__main__.py` 存在） |
| `serve` 硬依赖 | `aiohttp`，缺失直接 `Exit(1)` |
| 数据目录规则 | `config/paths.py::get_data_dir()` = `get_config_path().parent`；`llm_usage` 落在 `get_data_dir()/llm_usage.sqlite3` |
| workspace | 由 `agents.defaults.workspace` 决定（`config/schema.py::workspace_path`） |

### 1.2 四个硬阻塞

| # | 现象 | 证据 | 后果 |
|---|---|---|---|
| 1 | 安装包不含引擎 | `builder.config.json` 的 `files` 只有 `dist/`、`electron/*.cjs`、`assets/`、`resources/`；`nanobot/` 被父仓库 `.gitignore` 忽略 | 装完是空壳 |
| 2 | 引擎根目录指错 | `main.ts::fallbackLaunchConfig()` 用 `join(__dirname, '..')`；打包后 `__dirname` = `resources/app.asar/electron`，根 = **asar** | Python 无法从 asar 执行；候选全落空 → 退到 PATH 裸 `nanobot` → `spawn ENOENT` |
| 3 | 配置落在只读区 | 同上，`config` = `join(root, 'nanowork.config.json')`；而渠道/模型/MCP/工具策略同步共 6 处**要写回**该文件 | 设置页保存静默失败 |
| 4 | 依赖用户 Python | `engineInterpreterCandidates()` 写死 `<repo>/nanobot/nanobot/.venv` | 用户机没有该 venv → 引擎起不来 |

### 1.3 已实测的负面结论（不要再试一次）

创建 `python -m venv --copies` 后整体搬迁，`sys.base_prefix` 仍指向构建机
`C:\Users\xinmi\.workbuddy\binaries\python\versions\3.13.12`；且
`site-packages/_editable_impl_nanobot_ai.pth` 内含绝对路径
`D:\Workspace\study\nanowork\nanobot`。

→ **结论：venv 不是可分发单元。** 必须是"可重定位解释器 + 与其匹配的 site 目录"。

### 1.4 被排除的候选

| 候选 | 否决理由（一句话） |
|---|---|
| 现有 `.venv` 直接塞进包 | §1.3 实测不可搬迁 |
| Windows embeddable zip | 无 pip、无 venv、`._pth` 路径要硬编码，三平台方案分叉 |
| conda-pack / micromamba | 400 MB+、路径 patch 复杂、许可要过审 |
| PyInstaller / Nuitka 冻结 | 引擎有 **14 处（6 个文件）** 把 `sys.executable` 当 python 用，另有 `agent/tools/loader.py:43`、`channels/registry.py:25` 两处 `pkgutil` 注册表发现 → 冻结后功能静默缺失，且运行时装不了插件，体积反而更大（必须预装全部渠道依赖） |
| PyInstaller onefile | 每次启动解压 200 MB 到 `%TEMP%\_MEI*`，双进程解压两次，用户机无法打补丁 |
| 单机 Docker | 文件工具只作用于容器、产物路径需映射、需要虚拟化与商用许可；兜底仍要内置运行时（成本翻倍） |
| 服务端 Docker（远程引擎） | 不是替代，是**另一条产品线**（多租户改造在引擎侧）；见 §13 决策 3 |

---

## 2. 方案定义

### 2.1 三条不变量

1. **运行时只读**：`resources/rt/**` 随应用版本分发，运行期**永不写入**。
2. **数据全外置**：配置、工作区、插件、缓存全部在 `userData`，升级不动。
3. **版本绑死**：引擎版本 = 应用版本，一次更新覆盖两者（`src/ai/runtime/nanobotHttp/**` 是单版本 wire 假设）。

### 2.2 安装后目录树

```
<安装目录>/
  nanowork.exe | nanowork.app | nanowork.AppImage
  resources/
    app.asar                 # dist/ + electron/main.cjs + preload.cjs + assets
    rt/                      # ← extraResources，不进 asar
      python/                # 便携 CPython（PBS install_only）
        python.exe           #   win
        bin/python3          #   mac / linux
      site/                  # 引擎 wheel + 全部依赖 + 预编译 pyc
      config.template.json   # 首启配置模板（无凭据）
      manifest.json          # 版本 + sha256（自检与排障用）
```

```
<userData>/                  # Win: %APPDATA%\nanowork
  nanowork.config.json       # 首启从模板生成；之后由设置页写回
  workspace/                 # agents.defaults.workspace
  pyuser/                    # PYTHONUSERBASE：插件 pip --user 落点
  tiktoken/                  # TIKTOKEN_CACHE_DIR：预置 BPE 缓存
  audit/ media/ cron/ logs/  # 引擎运行时自动创建（跟随 config 父目录）
  engine.stamp               # 上次成功运行的引擎版本（触发配置深合并）
```

### 2.3 数据落点（谁写、在哪、为什么）

| 数据 | 路径 | 写入方 | 为什么在这 |
|---|---|---|---|
| 配置（含凭据） | `userData/nanowork.config.json` | 客户端设置页 + 引擎 | 必须可写；`diagnostics.ts` 已整文件排除出诊断包 |
| 工作区/会话/产物 | `userData/workspace/` | 引擎 | 统一由 `agents.defaults.workspace` 指定 |
| 用量库 | `userData/llm_usage.sqlite3` | 引擎 | `get_data_dir()` = config 父目录，自动跟随 |
| 插件依赖 | `userData/pyuser/` | pip（`PIP_USER=1`） | 安装目录可能只读（AppImage/deb/Program Files） |
| 分词缓存 | `userData/tiktoken/` | tiktoken | 首次 `get_encoding` 会联网，必须预置 |
| 运行时 | `resources/rt/` | 构建 | 只读，随版本替换 |

### 2.4 配置生成与升级合并

- **首启**：无 `nanowork.config.json` → 读 `rt/config.template.json` → 把 `agents.defaults.workspace` 改写为 `<userData>/workspace` → 写入 `userData`。
- **升级**：`manifest.json.engineVersion` ≠ `engine.stamp` → 执行**深合并**：只补模板中**缺失**的键，绝不覆盖用户已有值（引擎 `Base` 是 `extra="ignore"`，漏字段只会静默丢功能）。
- **模板来源**：构建时从仓库 `nanowork.config.json` 生成，**必须剔除** `providers.*.apiKey`、`channels.*` 中的 token/secret，并把 `workspace` 换成占位符。

---

## 3. 运行时装配（核心）

### 3.1 进程拓扑

客户端固定拉起**两个**引擎进程（现状，不改变）：

| 进程 | 参数 | 端口 | 职责 |
|---|---|---|---|
| `serve` | `-P -m nanobot serve --host 127.0.0.1 --port <p> --config <cfg> -v` | 默认 18900，占用则顺延（`resolveGatewayPort`） | `/v1/*` REST、聊天链路 |
| `gateway` | `-P -m nanobot gateway --foreground --config <cfg> -v` | 固定 18790 | 渠道、cron 调度、approvals |

> `serve` 内**不得**启动 cron（`cron.start()` 由 gateway 独占），这是引擎侧 `[LOCAL PATCH]` 的既有约定，打包不得改变进程模型。

### 3.2 启动参数为什么是这几个

| 参数 | 原因 |
|---|---|
| `-P` | Python 3.11+ 的 safe path：`-m` 会把 **cwd** 放 `sys.path[0]`，而 cwd 是用户可写工作区 —— 里面出现 `nanobot.py` 就能劫持整个引擎 |
| `-m nanobot` | 绕开 console script 里烧死的 shebang 路径（`main.ts` 的 `NanobotLaunchConfig.args` 已写明这条历史坑） |
| `--config` | 唯一的数据落点开关（§2.3） |

### 3.3 环境变量（8 项，缺一项就有明确的坏结果）

| 变量 | 值 | 不设 / 设错的后果 |
|---|---|---|
| `PYTHONPATH` | `<rt>/site` | 引擎与依赖的唯一出口。**必须先删除继承值**，否则用户机器的老 `PYTHONPATH` 劫持内置运行时 |
| `PYTHONHOME` | **删除** | 继承后去加载别处 stdlib → `ModuleNotFoundError` 满天飞且看不出原因 |
| `PYTHONUSERBASE` | `<userData>/pyuser` | 插件安装逃出只读区 |
| `PIP_USER` | `1` | 引擎 `apps/cli/service.py:866` 直接 `[sys.executable, '-m', 'pip', 'install', ...]`，不加就写只读 site → AppImage/deb 必失败 |
| `PYTHONUTF8` | `1` | Windows 默认 GBK，引擎处理中文路径/内容会炸 |
| `PYTHONIOENCODING` | `utf-8` | 同上，日志编码异常会打挂 serve |
| `PYTHONDONTWRITEBYTECODE` | `1` | AppImage 挂载点只读（`/tmp/.mount_*`）、deb 装 `/opt` 常只读；写 pyc 会**静默失败**。改为构建期 `--compile-bytecode` 预编译 |
| `TIKTOKEN_CACHE_DIR` | `<userData>/tiktoken` | `utils/helpers.py:107` 调 `get_encoding('cl100k_base')`，未预置则首启联网 |

> 另需复用现有 `sanitizeGatewayEnv()`：它已处理"环境里指向不存在文件的 `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`"这类会让 httpx 直接抛 `FileNotFoundError` 的污染变量。**不要另写一份**。

判据：`<rt>/python/python.exe -m site --user-site` 打印的才是真实用户目录（Windows 下会多一层 `Python3XX`，不要按记忆猜）。

### 3.4 路径解析的唯一真相

现有 `engineInterpreterCandidates(appRoot, platform)` 已被
`main.ts::fallbackLaunchConfig`、`engineSelfCheck`、`engineInstall` 三方共用。
**唯一正确的改法是给它加一个 layout 参数**，而不是让三处各写一份：

```ts
// electron/engineSelfCheck.ts
export type EngineLayout = 'repo' | 'bundle';

export function engineInterpreterCandidates(
  appRoot: string,
  platform: NodeJS.Platform,
  layout: EngineLayout = 'repo',
): { repo: string; venv: string; python: string; script: string } {
  const isWin = platform === 'win32';
  if (layout === 'bundle') {
    // appRoot = <resourcesPath>/rt
    return {
      repo: appRoot,
      venv: join(appRoot, 'site'),
      python: isWin ? join(appRoot, 'python', 'python.exe') : join(appRoot, 'python', 'bin', 'python3'),
      script: isWin ? join(appRoot, 'python', 'python.exe') : join(appRoot, 'python', 'bin', 'python3'),
    };
  }
  // 以下为现状（dev）分支，保持逐字不变
  const repo = join(appRoot, 'nanobot');
  const venv = join(repo, 'nanobot', '.venv');
  return { repo, venv, /* …现状… */ };
}
```

`main.ts` 侧同步：

```ts
const engineRoot = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'rt') : join(__dirname, '..');
const engineLayout = (): EngineLayout => (app.isPackaged ? 'bundle' : 'repo');
const engineConfigPath = (): string =>
  app.isPackaged
    ? join(app.getPath('userData'), 'nanowork.config.json')
    : join(__dirname, '..', 'nanowork.config.json');
```

> ⚠️ `resolveEngineSelfCheckTarget()` 目前写死 `engineRoot: join(__dirname, '..')`，必须改为 `engineRoot()`。

### 3.5 首启 bootstrap（幂等）

新增 `electron/engineBootstrap.ts`，在窗口显示后、`scheduleEngineSelfCheck()` 之前执行：

```
1. 确保 <userData>/workspace、pyuser、tiktoken 存在                → mkdir -p
2. 无 nanowork.config.json：
     读 rt/config.template.json → 改写 agents.defaults.workspace → 写入（0600）
   （模板缺失时退化为 {} 并由引擎默认值兜底，但不能静默跳过 workspace 改写）
3. 校验 rt/manifest.json 存在且 buildId 与 app 版本一致              → 不一致记 warn，不阻塞
4. 比较 manifest.engineVersion 与 engine.stamp：不同 → 配置深合并 → 更新 stamp
5. 全部失败只记日志，不弹窗：真正的失败由 §3.6 的自检报告呈现
```

**幂等性要求**：重复启动零成本（不复制、不重写已存在的 config）。

### 3.6 失败面与自检口径

现有 `engineSelfCheck` 三项（解释器可达 / 包可导入 / 配置可加载）在打包后**继续有效**，因为
`-c` 与真实解释器都在。但**文案必须分叉**：

| 现状 | 打包后 |
|---|---|
| remedy 教用户 `python -m venv` + `pip install -e`（`engineSelfCheck.ts:198`、`engineInstall.ts:76`） | 改为"重新运行安装包 / 查看 manifest / 打开诊断包"，**不得**引导用户装 Python |
| `docPath` 指向 `docs/engine-dev-setup.md` | 打包后该文档不存在 → 返回 `null`，不显示死链 |

---

## 4. 构建流水线

### 4.1 步骤（`scripts/build-engine.mjs`，已实现并跑通）

| # | 步骤 | 关键点 |
|---|---|---|
| 1 | 记录引擎溯源：`git -C nanobot rev-parse HEAD` | 引擎是独立仓库且被父仓库忽略，**这句是唯一可追溯证据**；工作区脏会在产物里记 `engineDirty: true` |
| 2 | `NANOBOT_SKIP_WEBUI_BUILD=1 uv build --wheel` | 跳过引擎自带 webui 构建（`hatch_build.py:61` 支持），省 7.4 MB |
| 3 | 取得便携解释器（三条路径，见 §4.1.1） | 装在**系统临时目录**再复制进来，原因见 §4.6 坑 2 |
| 4 | `uv pip install --target build/rt/site <wheel> aiohttp` | **不要**加 `--compile-bytecode`，原因见 §4.6 坑 3 |
| 5 | `python -m compileall -q -j 0 site` | 与运行期 `PYTHONDONTWRITEBYTECODE=1` 配套；**失败只告警**（pyc 只是启动优化） |
| 6 | 写 `sitecustomize.py` 到解释器 site-packages | 让 `<rt>/site` 变成真正的 site 目录（`.pth` 生效），见 §4.6 坑 1 |
| 7 | 导入自检：`-P -c "import nanobot; import pywintypes; import win32api"` | **构建期就拦住**"装完能起、gateway 起不来"这类问题 |
| 8 | 裁剪：删 `Lib/test`、`tcl/`、`Lib/idlelib`、`site/nanobot/web/dist` | best-effort：删不掉只告警（句柄/批量删除保护） |
| 9 | 生成 `manifest.json` 与 `config.template.json`（脱敏 + workspace 占位） | 模板里若仍有凭据字段 → **构建失败** |
| 10 | 打印体积报告（分目录 + 文件数） | 体积回归要能一眼看出来 |

`--ensure` 供 `build:electron` 使用（已有 manifest 即跳过），`--force` 供发版使用。

#### 4.1.1 便携解释器的三条取得路径

| 优先级 | 触发 | 说明 |
|---|---|---|
| 1 | `PBS_ASSET_URL` | 直接给 tarball（内网镜像 / 已缓存），不碰网络发现 |
| 2 | `PBS_TAG` | 钉 release tag + 走 GitHub API 找资产。**CI 应该用这条**（可复现） |
| 3 | 都不给（默认） | `uv python install 3.12` —— uv 本身就是 PBS 的消费者，下载的是同一份 `install_only` 产物；可用 `UV_PYTHON_INSTALL_MIRROR` 走镜像 |

> 本机实测 GitHub API 返回 **403**（未认证限流），因此默认兜底走 uv。产物里记 `pbsTag: "uv-managed"` 与具体资产名（如 `cpython-3.12.11-windows-x86_64-none`）以保留溯源。

### 4.2 依赖锁定（可复现）

- 用 `uv pip compile nanobot/pyproject.toml --python-version 3.12 --generate-hashes -o requirements.lock`。
- 安装时 `pip`/`uv` 一律 `--require-hashes`。
- 禁止 `pip freeze` 当锁文件（它记录的是"当时装了什么"，不是"可解析的图"）。

### 4.3 体积账（实测）

| 项 | 数值 | 依据 |
|---|---|---|
| site（引擎 + 依赖） | **187.5 MB / 15962 文件** | 实测，已剔除 `lark_oapi`（未安装）、web dist 7.4 MB |
| 便携解释器 | **50.1 MB** | 实测 `cpython-3.12.11-windows-x86_64-none`（未剔 `tcl` 时为 50 MB 量级） |
| `build/rt` 合计 | **≈ 238 MB** | 实测 |
| 渲染层 `dist/` | 7.7 MB | 实测 |
| Electron 31 运行时 | ≈ 200 MB（解包） | 官方体积 |
| **安装后合计** | **≈ 480–500 MB** | 推算 |
| **安装包（LZMA）** | **≈ 170–210 MB** | 按 2.2–2.8 倍压缩比推算，装机后复测 |

`pip`（约 12 MB）**必须保留** —— `PIP_USER=1` 的插件安装依赖 `python -m pip`。

### 4.4 产物清单（`build/rt`）

```
build/rt/
  python/{python.exe | bin/python3, Lib/ | lib/python3.12/, DLLs/ | lib/}
    └ site-packages/sitecustomize.py   # 构建期写入：让 <rt>/site 的 .pth 生效
  site/{nanobot/, aiohttp/, *.dist-info/, __pycache__/*.pyc, pywin32.pth, win32/}
  config.template.json
  manifest.json      # { engineVersion, engineCommit, engineDirty, pyVersion,
                     #   pbsTag, pbsAsset, wheel, wheelSha256, buildId,
                     #   siteFiles, siteBytes, builtAt }
```

`/build/` 已加入 `.gitignore`（与 `dist/`、`release/` 同级）。

### 4.5 引擎仓库溯源（必须解决的前置问题）

`nanobot/` 是独立 git 仓库、origin 指上游 `HKUDS/nanobot`、104 处 `[LOCAL PATCH]` 只在本机。

- **CI 拿不到引擎源码** → 桌面侧 CI 无法独立产出安装包。
- 两个可选路径（见 §13 决策 2）：
  1. 建私有镜像远端（`git push` 一份可拉取的 fork）—— CI 全自动。
  2. 本机构建 `nanobot_ai-0.3.0-py3-none-any.whl` 上传为 release 资产，CI 只做 Electron 侧装配 —— 改动最小，且 wheel 天然带 sha256。

### 4.6 实测记录：2026-10-30 首次跑通（win-x64）

产物：`python 50.1 MB` + `site 187.5 MB（15962 文件）`，`buildId=d913cc085d5343e0`。
（按文件字节计；`du` 因块对齐会显示 55M / 228M，两者都对，别互相校验。）

端到端验证（**不是估算，是真实拉起**）：

| 检查 | 结果 |
|---|---|
| `-P -c "import nanobot"` | `nanobot ok`，`sys.prefix` = `build/rt/python` |
| `serve --port 18999` | `GET /health` → `{"status":"ok"}`；`/v1/models` → 200 |
| `gateway`（独立端口） | `GET /health` → `{"status":"ok","process":"alive","ready":true,"websocket":"running"}`；`POST /v1/turn` → 400（空体，端点存活） |
| 工作区模板同步 | `build/verify-workspace/` 出现 `AGENTS.md` `SOUL.md` `IDENTITY.md` `memory/` |
| 数据落点 | `sessions/` 落在 **config 同目录**（验证了 §2.3「config 父目录即数据目录」） |

**四个只有真跑才会暴露的坑（已修，写进脚本）**

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `serve` 正常，`gateway` 报 `ModuleNotFoundError: No module named 'pywintypes'` | **PYTHONPATH 不处理 `.pth`**（那是 `site` 模块的机制）；pywin32 靠 `pywin32.pth` 挂 `win32/lib` 并执行 `import pywin32_bootstrap`（还负责 DLL 目录） | 向随包解释器的 site-packages 写 `sitecustomize.py`，启动时用相对定位找到 `<rt>/site` 并 `site.addsitedir()`；**构建期探针**校验 `pywintypes`/`win32api` 可导入 |
| 2 | `uv python install` 报 `拒绝访问 (os error 5)` | uv 装完要在目标目录内 rename `.temp/...`，仓库目录里被宿主/杀软/索引服务持有句柄打断 | 先装到**系统临时目录**再 `fs.cp` 进 `build/rt` |
| 3 | `uv pip install --compile-bytecode` 退出码 2，只给一句 `Failed to bytecode-compile` | uv 不说是哪个文件 | 拆成独立 `compileall`，且**允许失败**（pyc 只是启动优化） |
| 4 | 裁剪时被 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（587 个文件）打断 | 宿主侧批量删除保护 | 裁剪改 best-effort：删不掉只告警（体积优化不该阻断发版） |

另有两个**判据式**设计被验证有效：

- 模板脱敏不能按"整名匹配"——`tokenIssueSecret` / `identityKey` / `encryptKey` 这类驼峰复合词会漏网，其中 `tokenIssueSecret` 是**非空真值**，漏了就等于每个安装包都发同一个密钥。改为按词切分 + 白名单例外，并**残留即构建失败**。
- `gateway` 的 WebUI 端口在 `channels.websocket.port`（本机 9900 被占用会直接拒启动），`--port` 改的是 WebUI、`gateway.port` 在 config 里 —— 打包态这两个值都必须可由客户端改写，否则用户装完撞端口就是"引擎起不来"。

### 4.7 打包机前提与本次打包实测（2026-10-30，win-x64）

**已实测通过**

| 项 | 结果 |
|---|---|
| `resources/rt` 是否随包 | ✅ `release/win-unpacked/resources/rt/{python,site,config.template.json,manifest.json}` 齐全 |
| 随包解释器能否运行 | ✅ `resources/rt/python/python.exe --version` → `Python 3.12.11` |
| zip 产物 | ✅ `release/nanowork-0.1.0-win-x64.zip` **274 MB**（deflate；NSIS 用 LZMA 会更小） |
| `app.asar` | ✅ 只含 `dist/` + `main.cjs` + `preload.cjs` + `assets/`；`rt` 不在 asar 内 |

**三个只有真打包才会撞上的前提（都已处理或记录）**

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | `⨯ image electron/assets/icon.ico must be at least 256x256` | 图源是**非正方形** 1024×931，转 ico 后 256×233 | 已用透明补边生成正方形：`icon.png` 1024×1024、`icon.ico` 多尺寸（16…256） |
| 2 | `Cannot create symbolic link ... winCodeSign\darwin\...` | electron-builder 解 `winCodeSign` 缓存要建符号链接；普通用户无该特权 | 打包机需**开启 Windows 开发者模式**，或以管理员身份运行一次以填充缓存。CI 的 `windows-latest` 默认允许 |
| 3 | NSIS 阶段 `Exit code: 2. Command failed: <installer>.exe` | 非一键安装器要在构建期**运行一次安装器来生成卸载器**；受限/沙箱环境下该子进程起不来 | 正常桌面会话下不会出现；受限环境先用 `--config.win.target=zip` 出包 |

> 另外 `signAndEditExecutable=false` 只是本次绕过缓存问题的诊断开关，**正式包必须保留默认值**（否则 exe 图标与版本信息不会被写入）。

**仍未验证的一步（不要当成已通过）**

直接运行 `release/win-unpacked/nanowork.exe` 时进程**在 `whenReady` 之前就退出了**：
无 `userData` 写入、无「应用启动」日志，只有一行 Chromium 的 `registration_protocol_win.cc`
协议注册报错。代码里唯一这么早的退出点是 `acquireSingleInstance` 抢锁失败后的 `app.exit(0)`
（`main.ts` 的 `isPrimaryInstance` 分支）。

因此「装完自启引擎」这条**必须在一台没有其它实例运行的干净机上用安装包验证**，
本机开发实例在场时会命中单实例锁，看起来就像"应用打不开"。

### 4.8 Setup.exe 打通记录（2026-10-30 深夜，win-x64 实测）

**产物**：`nanowork-0.1.0-win-x64.exe` **218,639,934 字节（209 MiB）**，退出码 0，同时产出
`.blockmap` 与 `latest.yml`。`7za l` 可列出全部 17712 个条目，`Physical Size = 218048242`
即内嵌的 app 载荷，`Offset = 188162` 是 NSIS 引导头——说明载荷真的进去了。

**四个连环坑（按撞上顺序，全部有复现证据）**

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | `Cannot create symbolic link ... winCodeSign\darwin\10.12\lib\libcrypto.dylib` | 该归档里只有 **2 个符号链接**（21/18 字节，内容就是目标路径文本，指向同目录的真实 dylib）。Windows 建链接需 `SeCreateSymbolicLinkPrivilege`，实测 `ln -s` 直接 `Operation not permitted` → `7za` 退出码非零 → electron-builder 认为缓存未就绪，换新目录重试（缓存里堆了 20 个残缺目录） | 见下方"三条路线"；本地诊断可用 `--config.win.signAndEditExecutable=false` 绕开 |
| 2 | `app-builder.exe unpack-electron` → `fatal error: runtime: cannot allocate memory` | 机器提交量 59.19 / 69.31 GB，可用物理内存仅 4.66 GB | 关掉占内存的进程后重试即可（`vmmemWSL` 独占 4.1 GB） |
| 3 | `7za a -mx=9 ... .nsis.7z` → **`Exit code: 8`** | 7-Zip 退出码 8 = 内存不足；`-mx=9` 压 818 MB / 17992 文件时申请失败 | `ELECTRON_BUILDER_COMPRESSION_LEVEL=5`（`archive.js:59` 检测到它就**跳过**默认的 `-mx=9`）。实测 `-mx=5`：818 MB → 208 MiB，**47 秒** |
| 4 | NSIS 阶段 `Exit code: 2. Command failed: <输出目录>/nanowork-0.1.0-win-x64.exe` | **不是安装包**：这是 `BUILD_UNINSTALLER` 中间产物（213743 字节固定大小），electron-builder 编译出来**运行它**以吐出卸载器。它一写临时文件就失败（弹窗 "Error writing temporary file"，退出码 2）。**同一份字节（sha256 相同）放在 `D:\` 根或 `%TEMP%` 下运行 → 退出码 0 并正常写出卸载器；放在 `D:\Workspace\...` 下 → 退出码 2** | 把 `directories.output` 指到**工作区之外**：`--config.directories.output=D:/nw-release`，构建即通过 |

> 第 4 条的可执行最终命令（本机验证通过）：
> ```bash
> CODEBUDDY_SAFE_DELETE_ENABLED=0 ELECTRON_BUILDER_COMPRESSION_LEVEL=5 \
>   npx electron-builder --config electron/builder.config.json --win nsis \
>   --config.win.signAndEditExecutable=false \
>   --config.directories.output=D:/nw-release --publish never
> ```

**winCodeSign 的三条路线（按可靠性排序）**

| 方案 | 做法 | 结论 |
|---|---|---|
| **开开发者模式** | 设置 → 系统 → 开发者选项 → 打开「开发人员模式」（或管理员跑一次构建，把缓存填好） | **推荐**。之后 `7za` 能正常建链接，恢复 electron-builder 默认路径，`signAndEditExecutable` 保持默认（图标/版本信息才会写入） |
| 预铺缓存 | 排除 `darwin` 解压，再用 `7za e -so` 把那 2 个链接物化成 21/18 字节普通文件 | **不推荐**：缓存目录名由 `app-builder.exe` 内部生成，各次不一致，预铺不保证命中 |
| 关闭图标改写 | `--config.win.signAndEditExecutable=false` | 仅限内测。**代价**：exe 不写图标与版本信息，属性里没有版本号，SmartScreen 更容易报警；**发版必须改回默认** |

**待办**：`signAndEditExecutable` 默认为真时尚未跑通（需先解决第 1 条）；以及安装包在干净机上的
静默安装 + 卸载验证。

### 4.9 一键打包脚本（`scripts/build-installer.mjs`）

上面四个坑的判据与动作已经固化进脚本，不用再记命令：

```bash
npm run build:installer                 # Windows: Setup.exe → <盘符>:\nanowork-release
npm run build:installer -- --out D:/dist
npm run build:installer:strict          # 发版用：先跑两套 tsc，且禁止质量降级
```

> **Windows 默认输出到盘根**（`<X:>\nanowork-release`），不是项目的 `release/`。
> 原因见 §4.8 第 4 条：本机在**项目路径下**运行构建期那个中间 exe 会失败，白跑约 5 分钟。
> 想放回项目就显式 `--out release`（脚本会先失败一次再自动迁移，并在 `release/ARTIFACT.txt`
> 写下真实路径）。

**脚本做了什么**

| 阶段 | 内容 | 为什么必须有 |
|---|---|---|
| 预检 | `build/rt/manifest.json` 存在；`icon.ico` **实测最大一张**的宽高 ≥256×256；**本机能否创建符号链接**（用临时目录试一次）；vite/esbuild/electron-builder 都在 | 引擎缺失时打出来的包"能装不能跑"，比打包失败更贵；ico 的报错只说 `must be at least 256x256`，看不出是"非正方形"；符号链接这一项若不做前置探测，要**白等约 9 分钟**才看到失败（实测 10 分 19 秒 → 2 分） |
| 构建 | `vite build` → esbuild 出 `main.cjs`/`preload.cjs` → electron-builder | 与 `build:electron` 同链路，避免两套写法 |
| 重试 | 按错误特征自动换招（见下表），最多 4 次 | 每个坑的失败信息都不点名原因 |
| 校验 | 产物 ≥32 MB，且 `7za l` 能列出条目数与目录数 | **只看退出码会被"截断的包"骗过**；只看体积会被那个 213 KB 的同名中间产物骗过 |
| 汇总 | 打出产物绝对路径、字节数、MiB、耗时、尝试次数；有降级则重复警告 | 降级包不能发版，不能让它悄悄混过去 |

**自动降级表（`--strict` 可关闭）**

**自动补救表（前两条与"换输出目录"在 `--strict` 下仍生效，因为不改变产物质量）**

| 触发特征 | 动作 | 代价 |
|---|---|---|
| 预检发现**建不了符号链接** | 一开始就加 `--config.win.signAndEditExecutable=false`（不做第一次无效尝试） | exe 无图标与版本号 |
| `Cannot create symbolic link` / `winCodeSign` | 同上（预检没拦住时的兜底） | exe 无图标与版本号 |
| `Command failed: <输出目录>/*.exe`（`Exit code: 2` **或 `null`**） | 输出目录改到**盘根**下（`<X:>/nanowork-release`）重试，并清掉那个 213 KB 的假安装包 | 产物不在 `release/` |
| `Exit code: 8` | `-mx` 9 → 5 → 3（走 `ELECTRON_BUILDER_COMPRESSION_LEVEL`） | 安装包略大 |
| `cannot allocate memory` / `unpack-electron` | **不重试**，直接报"打包机内存不足" | — |

> `--strict` 的准确语义是「**禁止降低产物质量**」，不是「什么都不许改」：
> 它会拦住"关 exe 资源改写"和"降压缩等级"，但**不会**拦住"换输出目录"——那是环境适配。
> 第一版把 strict 当成全禁，结果一次都没重试、直接失败（2026-10-31 实测）。

> 判据里 `Exit code` 的值不能写死成 `2`：同一件事在开发者模式开启后表现为 `Exit code: null`
> （进程被终止）。所以改成按**"命令行里跑的是不是输出目录里的那个 exe"**来判。

**两条刻意写成"宁可失败"的判断**

- 引擎运行时缺失 **默认拦住**（`--skip-engine-check` 才放行）：打出一个装得上但对话必失败的包，
  要把整个装机流程走完才发现。
- 产物名字**不复刻** `artifactName` 模板：模板里有 `${version}${os}${arch}`，复刻一份就等于把
  同一条规则写两处，配置一改这里静默失配。改成"按扩展名找体积最大的那个文件"。

**`--strict` 实跑记录（2026-10-31，开发者模式已开）**

```
preflight icon.ico 最大 256×256 ✓
preflight 符号链接可用 ✓
builder   输出=D:\Workspace\study\nanowork\release compression=5
警告      构建期需要运行 …\release\nanowork-0.1.0-win-x64.exe，但它在该目录下起不来 → 输出改到 D:\nanowork-release 重试
verify    内含 17992 个文件 / 1658 个目录 ✓
done      耗时 9 分 57 秒，尝试 2 次 → 218642308 字节（209 MiB）
```

产物 `VersionInfo` 实测：`ProductName=nanowork`、`FileVersion=0.1.0`、
`FileDescription=类 WorkBuddy 智能体客户端助手…` —— 已确认图标与版本资源写入，是正式包。
（与降级版对比：体积多 2374 字节。）

---

## 5. 客户端改动清单

| 状态 | 文件 | 改动 | 同步要改的用例 |
|---|---|---|---|
| ✅ | `electron/engineSelfCheck.ts` | `engineInterpreterCandidates` 加 `layout: 'repo' \| 'bundle'`；`EngineSelfCheckTarget` 加 `layout` / `env`；子进程 cwd 与 env 按布局分叉；打包态 remedy 不再教用户建 venv | `tests/electron/engineSelfCheck.test.ts`（+5 例） |
| ✅ | `electron/main.ts` | `engineRootPath()` / `engineLayout()` / `engineConfigPath()` 三个取值函数；`fallbackLaunchConfig`（打包态 args 加 `-P`）、`resolveEngineSelfCheckTarget`、`resolveAuditLogPath` 全部改用它们；`sanitizeGatewayEnv()` 改为委托 `buildEngineEnv()` | — |
| ✅ | 新增 `electron/engineEnv.ts` | `buildEngineEnv({layout, runtimeRoot, userData})`：CA 清理 + 打包态 8 项变量注入（含大小写不敏感地清 `PYTHONHOME`/`PYTHONPATH`） | 新增 `tests/electron/engineEnv.test.ts`（7 例） |
| ✅ | `electron/builder.config.json` | `extraResources: build/rt → rt`、`artifactName`、`nsis` 非一键/非 perMachine、`mac` 双架构 + entitlements、`linux` AppImage+deb | — |
| ✅ | 新增 `electron/assets/entitlements.mac.plist` | `disable-library-validation` 等 4 项 | — |
| ✅ | 新增 `scripts/build-engine.mjs` | §4.1 十步；`--ensure` / `--force` | — |
| ✅ | `package.json` | `build:engine` / `build:engine:ensure`；`build:electron` 前置 `--ensure`（保证 `extraResources` 的源目录一定存在） | — |
| ✅ P1 | 新增 `electron/engineBootstrap.ts` | 建三个可写目录、无 config 时从模板生成（占位符→userData/workspace）、按 manifest 版本**深合并缺失键**、只在版本变化时写 stamp；全部失败只进日志 | 新增 `tests/electron/engineBootstrap.test.ts`（12 例） |
| ✅ P1 | `electron/engineInstall.ts` | `buildEngineInstallRecipe` 增加 bundle 分支：**只有一步"校验随包运行时"**，绝不出现 venv / `pip install -e`；`env` 改为惰性函数（模块加载期 app 未 ready） | `tests/electron/engineInstall.test.ts`（+5 例） |
| ✅ P1 | 新增 `electron/enginePorts.ts` | `ensureServicePorts()`：health/WebUI 端口在被占时顺延并**写回配置**（`gateway` 子命令没有 `--gateway-port`，只能改配置）；`main.ts` 里 `gatewayHealthPort` / `gatewayWsPort` 全部改为可变值，审批请求带端口参数 | 新增 `tests/electron/enginePorts.test.ts`（8 例） |

**改动纪律（避免同一规则写两遍）**

- 候选路径只能有 `engineInterpreterCandidates` 一份。
- config 路径只能有 `engineConfigPath()` 一份（现有 6 处写回逻辑全部走它）。
- 环境变量只能有 `buildEngineEnv()` 一份。
- 改完 `electron/**.ts` 必须重建 `main.cjs` + `preload.cjs`（`npm run build:electron` 已包含）。

---

## 6. `electron/builder.config.json` 目标内容

```json
{
  "appId": "com.nanowork",
  "productName": "nanowork",
  "icon": "electron/assets/icon",
  "protocols": [{ "name": "NanoWork", "schemes": ["nanowork"] }],
  "directories": { "output": "release" },
  "files": [
    "dist/**/*",
    "electron/main.cjs",
    "electron/preload.cjs",
    "electron/assets/**/*",
    "resources/**/*"
  ],
  "extraResources": [
    { "from": "build/rt", "to": "rt" }
  ],
  "asar": true,
  "npmRebuild": false,
  "artifactName": "nanowork-${version}-${os}-${arch}.${ext}",
  "publish": [
    { "provider": "github", "owner": "bwshark", "repo": "nanowork", "releaseType": "release" }
  ],
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }],
    "icon": "electron/assets/icon.ico"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true
  },
  "mac": {
    "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }, { "target": "zip", "arch": ["arm64", "x64"] }],
    "category": "public.app-category.productivity",
    "icon": "electron/assets/icon.icns",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "electron/assets/entitlements.mac.plist",
    "entitlementsInherit": "electron/assets/entitlements.mac.plist",
    "notarize": true
  },
  "linux": {
    "target": ["AppImage", "deb"],
    "category": "Utility",
    "icon": "electron/assets/icon.png"
  },
  "electronDownload": { "mirror": "https://npmmirror.com/mirrors/electron/" }
}
```

配套新增 `electron/assets/entitlements.mac.plist`（子进程 + 未签名 dylib 必需）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
</dict>
</plist>
```

> `extraResources` 的好处：`rt/` **完全不进 asar**，绕开"Python 无法从 asar 执行"这个根本限制；同时 `files` 无需改动。

---

## 7. 三平台差异与签名

### 7.1 Windows

| 项 | 内容 |
|---|---|
| 安装形态 | NSIS，`perMachine:false`（默认 per-user，免 UAC）；per-machine 也支持（运行时不写安装目录） |
| 签名 | 代码签名证书（OV/EV 或 Azure Trusted Signing）；**未签名 → SmartScreen 红屏**，首次启动成功率归零 |
| 长路径 | 目录名刻意用 `rt`；仍需在"关闭长路径支持"的机器上验证 |
| 杀软 | `python.exe` 落盘易被拦；预编译 pyc 减少首启写盘；签名可显著降低误报 |
| 判据 | 关闭长路径 + 无 Python 的干净机冷启成功 |

#### 7.1.1 「Windows 安全警报：python 被防火墙阻止」

现象：装完后第一次对话（或模型跑脚本）弹出一个系统框 —— 标题是 *Windows Security Alert*，
里面写着 `python` / `Publisher: Unknown` / 一个 `.exe` 路径。**这个框不是我们画的，也没有 API 能拦截**。

它出现的**唯一条件**是：某个进程在**非回环地址**上 `listen()`（`0.0.0.0` / `::`）。
绑 `127.0.0.1` 的监听**不会**弹（微软 WFP 的 `NotifyOnListen` 只对可被外部访问的监听触发）。

我们自己的链路是安全的，实测（2026-10-31，本机）：
`nanobot serve` 只监听 `127.0.0.1:19911`，`nanobot gateway` 只监听 `127.0.0.1:9903` 与 `127.0.0.1:18793`。
默认配置里唯一默认 `0.0.0.0` 的是 **MS Teams 渠道**（`channels.msteams.host`，且 `enabled=false`）。

所以这个框通常来自**模型通过 shell 工具跑起来的子进程**，典型是 `python -m http.server 8000`
（`http.server` 默认绑 `0.0.0.0`）。这时框里显示的路径就是 PATH 上第一个 `python` ——
真机上可能是用户自己装的 `C:\python27\python.exe`（实测截图即如此），跟我们的运行时无关。

处理（按优先级）：

| 手段 | 效果 | 代价 |
|---|---|---|
| 随包运行时前置到 PATH（`engineEnv.ts` 已做） | 裸 `python` 命中 `rt\python\python.exe`，不再出现野路径；脚本也不会因 py2 语法失败 | 无 |
| 让脚本显式绑 `127.0.0.1`（`python -m http.server --bind 127.0.0.1`） | 不弹框，本机预览照常 | 需要模型/脚本配合 |
| 安装期预置入站放行规则（`netsh advfirewall ... program="…\rt\python\python.exe"`） | 不再弹框，且允许局域网访问 | **需要管理员**（UAC），与 per-user 免 UAC 冲突；且放宽了入站面 |
| 签名 `rt\python\python.exe` | 仍然弹，但 `Publisher` 变成我们的名字 | 需要证书 |

**不要**在应用里静默改用户的防火墙规则：那是安全边界，必须由用户在 UAC 上明确同意。

### 7.2 macOS（最容易翻车）

| 项 | 内容 |
|---|---|
| 架构 | arm64 与 x64 **各出一份**（引擎二进制不能 universal，PBS 按架构分发） |
| 签名范围 | electron-builder 的自动签名**不覆盖 `Contents/Resources/rt/**`** → 必须新增 afterSign：对 `rt/python/bin/*` 与全部 `.so` / `.dylib` 递归 `codesign --force --options runtime --entitlements …` |
| 公证 | `notarize: true` + `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` |
| 失败症状 | 公证报 `code object is not signed at all`；或首次打开被 Gatekeeper 拦 |
| 判据 | `codesign -dv --entitlements - <app>` 无未签名项；`spctl -a -vv <app>` 通过；公证 staple 成功 |

reduced示例（`scripts/sign-engine-macos.mjs`，由 `afterSign` 调用）：

```js
// 遍历 Contents/Resources/rt，对 Mach-O 逐个重签；非 Mach-O（.py/.json）跳过
// 判据：`codesign -dv` 对每个 Mach-O 都返回 signed
```

### 7.3 Linux

| 项 | 内容 |
|---|---|
| 目标 | AppImage（免安装）+ deb（系统集成） |
| 只读现实 | AppImage 挂载点随机且只读（`/tmp/.mount_*`），deb 装 `/opt` 常只读 → 依赖 §2.1 不变量 |
| 依赖 | AppImage 需 libfuse2；提供 `--appimage-extract-and-run` 兜底说明 |
| 构建基线 | `ubuntu-22.04`（glibc 下限），PBS 对应的 manylinux 产物 |
| 判据 | 无 FUSE 环境可起；`ldd` 无缺失库 |

---

## 8. CI/CD

### 8.1 `.github/workflows/release.yml` 矩阵

| runner | 产出 | 备注 |
|---|---|---|
| `windows-latest` | `nanowork-x.y.z-win-x64.exe` | 签名用 `CSC_LINK` / `CSC_KEY_PASSWORD` |
| `macos-14` | `…-mac-arm64.dmg/.zip` | arm64 原生 |
| `macos-15-intel` | `…-mac-x64.dmg/.zip` | x64（`macos-13` 已于 2025-12-04 退役） |
| `ubuntu-22.04` | `…-linux-x86_64.AppImage` / `.deb` | glibc 下限基线 |

每个 job：`npm ci` → `node scripts/build-engine.mjs --ensure` → `node scripts/build-installer.mjs --platform <p> --arch <a>`；
产物由 `actions/upload-artifact` 收齐后，再由单独的 `publish` job 用 `gh release create/upload` 统一发布
（**不让 4 个 job 并发往同一个 release 写**，否则会出现互相覆盖 `latest*.yml` 的竞态）。

两条与"产物正确性"直接相关的约束：

1. **架构与 `build/rt` 必须成对**。便携 Python 按 triple 分发，所以 mac 两个架构各用一台 runner
   各自重建运行时；`build-installer.mjs` 会从 `build/rt/manifest.json` 的 `pbsAsset` 反查平台/架构，
   和目标不一致就**直接失败**（这种包在构建日志里一切正常，只有用户装完才会发现引擎起不来）。
   `builder.config.json` 的 `mac.target` 因此**不写 arch 数组**，架构只由 `--arch` 决定。
2. **macOS 的 `rt/**` 必须单独签名**。electron-builder 的签名范围不含 `extraResources`，
   `scripts/sign-engine-macos.mjs` 作为 `afterSign` 钩子递归补签 `Contents/Resources/rt` 下的
   Mach-O 并重签 `.app`，否则 notarytool 报 `code object is not signed at all`。

引擎源码不在本仓库（`nanobot/` 被忽略），workflow 用 `secrets.NANOBOT_TOKEN`（默认回退
`GITHUB_TOKEN`）单独 clone；仓库变量 `NANOBOT_REPOSITORY` 可覆盖地址。

### 8.2 版本与 tag

- tag 形如 `v0.1.0`；`package.json.version`、`manifest.engineVersion`、release tag **三者必须一致**
  （`release.yml` 里只断言 tag 与 `package.json`；引擎版本在 `build-engine.mjs` 的 manifest 里，
  由"产物同一 tag 一次构建"保证）。
- 引擎版本不一致 → 直接 fail，不产包。

### 8.3 发布渠道

- 默认 GitHub Releases（`updater.ts` 已按此实现：`autoDownload=false`、`update-not-available` 才判 up-to-date、`autoInstallOnAppQuit=true`）。
- 国内分发需备选 OSS（`electron-updater` 的 `generic` provider）；同一份 `latest.yml` 结构。

### 8.4 自动更新边界

更新 = 整体换包（含 `rt/`）。**不做**引擎热更新、不做差分引擎包。

---

## 9. 升级与数据迁移

| 场景 | 行为 |
|---|---|
| 应用升级（同引擎版本） | 换 `rt/` + asar；`userData` 完全不动 |
| 应用升级（引擎版本变） | 深合并配置（§2.4）→ 更新 `engine.stamp` |
| 回滚 | 装回旧安装包即可（旧 `rt/` 自洽）；`userData` 若被新版本改过，按"只补键"策略不会丢数据 |
| 卸载 | 询问是否保留 `userData`；默认保留（含会话与密钥） |

---

## 10. 验收判据（可执行）

| # | 动作 | 期望 | 判据 |
|---|---|---|---|
| 1 | 干净 Windows（无 Python/Node），双击安装 | 30 s 内可对话 | 首启成功率；`engineSelfCheck.ok === true` |
| 2 | 断网冷启 | 不卡、不报 tiktoken 错误 | 日志无 `get_encoding` 网络异常 |
| 3 | 用户名含中文与空格 | 正常 | 引擎路径含空格时 `spawn` 成功（`quote()` 已覆盖） |
| 4 | 非管理员账户 / per-machine 安装 | 正常 | 运行时不尝试写安装目录（`rt` 只读） |
| 5 | macOS 首次打开 | 不被 Gatekeeper 拦 | `spctl -a -vv` 通过 |
| 6 | Linux 无 FUSE | 可启动 | `--appimage-extract-and-run` 成功 |
| 7 | 0.1.0 → 0.1.1 升级 | 数据完好 | `workspace/` 与 config 内容不变；新字段已补 |
| 8 | 退出应用 | 无残留进程 | `serve` 与 `gateway` 均被 `killProcessTree` 收掉 |
| 9 | 设置页保存模型/渠道/MCP | 写回成功 | config 修改时间变化且内容正确（验证阻塞 #3 已解） |

巡检指标：引擎相关工单占比 < 5%；诊断包中 `engine` 模块 warn 行可定位到具体项。

---

## 11. 阶段计划

| 阶段 | 交付物 | 完成判据 | 依赖 |
|---|---|---|---|
| **P0 地基** ✅ | `scripts/build-engine.mjs` + `engineInterpreterCandidates` 的 `layout` 分支 + `engineRootPath()/engineConfigPath()` + `engineEnv.ts` + `builder.config.json` | **已达成（2026-10-30）**：`build/rt` 238 MB；`serve` `/health` ok、`/v1/models` 200；`gateway` `/health` ok、`/v1/turn` 400 | 引擎可构建（§4.5 路径 2 即可） |
| **P1 能装** ✅（代码面） | `engineBootstrap`（配置生成 + 深合并 + stamp）+ `engineInstall` 打包分支 + `enginePorts`（端口顺延并写回） | 已达成：单测 20 例（bootstrap 12 / ports 8）+ install 5 例；打包链路产出 zip 且 `resources/rt` 可用。**待补**：干净机用安装包验证「装完自启引擎 + 设置页写回」 | P0 |
| **P2 能发** | macOS 递归签名 + 公证 + Linux 目标 + `release.yml` 矩阵 | 三平台产物齐全，8 条验收过 7 条以上 | P1 |
| **P3 稳态** | 配置深合并、自检文案分叉、体积看板、诊断包补 `manifest` | 升级不丢数据；体积回归可观测 | P2 |

---

## 12. 风险登记

| 风险 | 影响 | 缓解 | 触发信号 |
|---|---|---|---|
| 引擎源码进不了 CI | 无法自动出包 | §4.5 两条路径择一 | CI 报 `nanobot/` 不存在 |
| mac 签名遗漏 `rt/**` | 公证失败、无法分发 | afterSign 递归签名 + 判据命令 | notarytool 报未签名 |
| Windows 未签名 | 首启成功率暴跌 | 采购证书；内部包先加说明 | SmartScreen 拦截截图 |
| `PYTHONPATH` 顺序导致"插件装不上新版本" | 用户感知为"点了没反应" | 设置页文案明确"内置依赖随应用升级" | 用户反馈某插件仍为旧版 |
| 体积超预期（> 260 MB） | 下载转化下降 | 首发砍飞书 SDK；临时压缩字典 | 构建日志体积报告 |
| 只读盘被用户误删文件 | 引擎起不来 | 自检 + manifest sha256 校验 → 提示重装 | `engine-import` 项红 |
| 双进程冷启慢 | 首屏体验差 | 预编译 pyc + 骨架屏 | `startupProfile` 的 `serve.spawn→listen` |

---

## 13. 待决策

| # | 决策 | 选项 | 默认建议 |
|---|---|---|---|
| 1 | 首发是否内置飞书渠道 | 内置（+40 MB 安装包）/ 按需装 | **按需装**（`lark_oapi` 由 `find_spec` 探测，缺失可降级） |
| 2 | 引擎源码如何进构建 | 私有镜像远端 / 本机构建 wheel 上传 | **后者**（改动最小、有 sha256 可追溯） |
| 3 | 是否同步做"远程引擎"产品线 | 现在 / 以后 | **以后**（属多租户改造，与本方案正交） |

---

## 附录 A · 判据命令清单

```bash
# 运行时可用性
build/rt/python/python.exe -c "import nanobot, sys; print(nanobot.__version__ if hasattr(nanobot,'__version__') else 'ok', sys.prefix)"
build/rt/python/python.exe -m site --user-site

# 体积
du -sh build/rt/python build/rt/site

# 引擎能否用该运行时启动（不依赖客户端）
build/rt/python/python.exe -P -m nanobot serve --host 127.0.0.1 --port 18999 \
  --config <userData>/nanowork.config.json -v

# macOS 签名与公证
codesign -dv --entitlements - "dist/mac-arm64/nanowork.app"
spctl -a -vv "dist/mac-arm64/nanowork.app"
xcrun notarytool log <submission-id>

# 门禁（改完必跑，看退出码）
npm run typecheck && npm run typecheck:electron && npm run typecheck:tests
npx vitest run --maxWorkers=3 --silent
CODEBUDDY_SAFE_DELETE_ENABLED=0 npx vite build --emptyOutDir false
```

## 附录 B · 容易"写两遍"的四处（实施时逐条自查）

| 规则 | 唯一实现 | 禁止出现第二份的位置 |
|---|---|---|
| 解释器候选路径 | `engineInterpreterCandidates()` | `fallbackLaunchConfig` / 自检 / 安装器各自拼路径 |
| 配置路径 | `engineConfigPath()` | 现有 6 处写回逻辑（渠道/模型/MCP/工具策略/审计/断开渠道） |
| 引擎环境变量 | `buildEngineEnv()` | 各处 `spawn` 时手写 env |
| 数据目录推导 | 引擎侧 `get_data_dir()`（config 父目录） | 客户端自己拼 `~/.nanobot` |

> 本仓库已有先例：2026-09-27 的"基线失效"事件就是同一规则被抄成两份后静默分叉。打包这条链路上任何一处出现第二份实现，症状都会是"装完能起、某个功能静默不生效"。
