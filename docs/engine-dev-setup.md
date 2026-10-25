# 引擎仓库边界与本地开发约定

> **本文用途**：说清「父仓库」与「引擎仓库」的关系，固定本地开发/测试的可复现步骤，
> 并登记 2026-09-17 的引擎仓库对象库损坏事件与修复方式。
>
> **唯一事实源**：`docs/nanowork-prd-design-v2.md`。本文只写工程约定，不定义需求。

---

## 一、两个仓库的关系（重要）

| 项 | 父仓库（本仓库） | 引擎仓库 |
|---|---|---|
| 路径 | `D:\Workspace\study\nanowork` | `D:\Workspace\study\nanowork\nanobot` |
| 内容 | 渲染层 `src/` + 桌面外壳 `electron/` + 测试 `tests/` + 文档 `docs/` | nanobot 引擎源码（Python）+ 它自带的 `webui/`、`tui/` |
| 版本控制 | 独立 git 仓库 | **同级独立 git 仓库**（上游 `HKUDS/nanobot`） |
| 父仓库是否跟踪 | — | **否**：`.gitignore` 第 8 行忽略 `nanobot/` |
| 是否 submodule | — | **不是**（仓库内无 `.gitmodules`） |

**约定（2026-09-17 确认，用户决定）**：引擎**保持独立仓库**，不转 submodule、不并入父仓库。
原因：当前 `origin` 指向上游 `HKUDS/nanobot`，没有可推送的 fork 远端；转 submodule 会让父仓库指向一个拉不到的 SHA。

> ⚠️ **后果（必须知道）**：父仓库 `clone` 后**拿不到引擎源码**。
> 引擎侧代码、其 104 处 `[LOCAL PATCH]` 改动、以及 V1 的引擎成果，都不在父仓库的版本控制里。
> 详见 `docs/upstream-merge-conflicts.md`。

### 1.1 从零搭建

```bash
# 1) 父仓库
git clone <父仓库地址> nanowork && cd nanowork
npm install                      # 受限环境可加 ELECTRON_SKIP_BINARY_DOWNLOAD=1

# 2) 引擎仓库（独立获取，放在父仓库根下的 nanobot/）
git clone https://github.com/HKUDS/nanobot.git nanobot
cd nanobot
git switch -c sciherd-agent      # 本地的 V1 分支名
git log --oneline -1             # 期望看到 V1 提交（当前 fda6c492）

# 3) 引擎 venv（见下节，路径固定）
```

> ⚠️ 引擎侧的 V1 改动**目前只存在于本机**。新机器上 clone 上游后**不会**有 V1 成果，
> 必须另行同步（打包本机 `nanobot/` 目录，或建一个可推送的 fork 远端）。

---

## 二、引擎 venv 固定约定

**venv 路径：`nanobot/nanobot/.venv`**（注意是**双 nanobot**：仓库根 `/ nanobot 包目录 / .venv`）。
该路径是历史遗留的非标准位置，但**已固定为团队约定**，不要新建第二个 venv。

| 项 | 值 |
|---|---|
| 解释器 | `nanobot/nanobot/.venv/Scripts/python.exe`（Windows） |
| 安装方式 | editable（`pip install -e .`），改源码即生效，无需重装 |
| 缺 `aiohttp` 时 | `serve` 起不来，补 `pip install -e nanobot aiohttp` 或 `pip install -e ".\nanobot[api]"` |
| 建 venv 用的解释器 | 可用 managed Python：`C:\Users\xinmi\.workbuddy\binaries\python\versions\3.13.12\python.exe` |

### 2.1 为什么不用 `python -m pytest` 全局跑

系统 Python（`D:\Tools\miniconda3`）**没有装 pytest**，只有上面那个 venv 有。
所以引擎侧测试**必须**用 venv 的绝对路径调用，不能用裸 `python`。

---

## 三、引擎侧测试

**工作目录必须是 `nanobot/`**（仓库根），不是父仓库根。

```bash
cd nanobot
.\nanobot\.venv\Scripts\python.exe -m pytest tests/security tests/agent/test_agent_tool_policy.py `
  tests/agent/test_session_mode.py tests/agent/test_tool_approval.py tests/agent/test_skill_overrides.py `
  tests/tools/test_safe_delete_tool.py tests/utils/test_prompt_templates.py -q --tb=line -p no:cacheprovider
```

> `pyproject.toml` 的 pytest `addopts` 里带有项目自定义参数，直接用 `python -m pytest` 即可，
> 不要手写裸 `pytest`（会走系统环境）。

**M2/M3 相关测试集的实测基线（2026-09-17）**：341 例 → **340 passed / 1 failed**。
唯一失败：`tests/security/test_workspace_policy.py::test_resolve_allowed_path_blocks_symlink_escape`
—— Windows 下当前用户无创建 symlink 的权限，属**环境类红，非回归**。

**跑全量**（较慢，建议后台跑）：`.\nanobot\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider`

---

## 四、Windows / 工具链已知坑（都是踩过的）

| 坑 | 现象 | 规避 |
|---|---|---|
| PowerShell 管道喂 `git cat-file` | `git rev-list --objects HEAD \| git cat-file --batch-check` 会把**存在的对象也报成 missing**（连 HEAD 自身都报） | 用 `Start-Process -RedirectStandardInput` 写临时文件，或改用 `git fsck` / `git diff` 做判定 |
| 写 `alternates` 用 `Set-Content` | 写成 CRLF，git 把 `\r` 当路径字符 → `fatal: not a git repository` 类错误 | 用 `[System.IO.File]::WriteAllText($p, $s + "`n")` 保证 LF |
| 重定向输出中文乱码 | `$log \| Out-File` 后再读会乱码 | 设 `$env:PYTHONIOENCODING='utf-8'`，并用 `[System.IO.File]::WriteAllLines($p, $lines, [System.Text.UTF8Encoding]::new($false))` 写无 BOM 文件 |
| `Select-String -Path "**\*.py"` | PowerShell 5.1 不递归，只匹配当前层 → **统计数偏小** | 用 `Get-ChildItem -Recurse -Filter *.py \| Select-String`，或直接用 Grep 工具 |
| Bash 工具 | 本机 Git Bash 环境下 `cd /d/...` 等命令不可用 | 一律用 PowerShell 工具 |
| 失败 `fetch` 残留 | `objects/pack/` 留下 `tmp_pack_*` 大文件 | 手工清理（见第五节） |

---

## 五、引擎仓库对象库损坏事件与修复（2026-09-17）

### 5.1 症状

- `git diff --cached` / `git diff HEAD` 报 **`fatal: unable to read <blob>`**。
- `git fsck --full`：**83 blob / 20 tree / 2 commit 缺失**，61 条 `invalid reflog entry`。
- `git fetch` 报 **`pack has 16 unresolved deltas`**（无法基于本地已有对象做增量）。
- `git fetch --refetch` 大包传输两次中断（`curl 56 early EOF` / `SSL_ERROR_SYSCALL`）。

### 5.2 根因

`.git/objects/pack/` 里少了一个 `.pack`：`pack-fddfe489f1540fa878cace346bd36d7a8b3f5f23.pack`
（`.idx` 与 `.rev` 都在，`.pack` 丢失）→ 该 pack 内全部对象「凭空缺失」。
`git fsck` 的 `warning: no corresponding .pack: pack-fddfe489...` 是直接证据。
成因未完全确定（疑为中断的 `gc` / 清理工具 / 杀毒误删），**不是**部分克隆（仓库无 promisor 配置、无 `shallow`、无 `alternates`）。

### 5.3 修复（就地补回，未联网重下）

1. 在本机另一份克隆 `D:\Workspace\study\nanowork\nanobot` 中找到同名 `pack`，
   **比对 `.idx` 的 SHA256 一致**后，把 `.pack` / `.rev` 复制回本仓库 `objects/pack/`。
2. 逐个比对两份仓库的对象清单，找出**备份有而本地缺**的 79 个对象（全部在备份侧是松散对象），
   按 SHA 路径（`objects/ab/cdef...`）**字节复制**回本地。
   > 过程中一个失败的尝试：先挂 `alternates` 再 `git hash-object -w` ——当 alternates 可见时 git 会
   > **跳过写入**，对象根本没落地。结论：**直接复制松散对象文件**最可靠。
3. 清理失败 `fetch` 残留的 `tmp_pack_*`（约 1.4GB），然后 `git gc --quiet`。

### 5.4 验证结果（全部通过）

| 检查 | 结果 |
|---|---|
| `git rev-list --objects HEAD` | **41004 个对象，0 错误**（修复前解析到 192 行即中断） |
| `git fsck --full --no-progress` | **0 错误**（missing / broken / invalid reflog 全部清零） |
| `git gc --quiet` | rc=0；松散对象 0（全部打包） |
| `git fetch origin` | **恢复正常**（不再报 unresolved deltas） |

### 5.5 备份与后续

- `.git` 全量备份：**`D:\Workspace\_backup\nanobot-git-2026-09-17`**（118MB，robocopy /E）。
  对象库修复前建的，可作最后手段。
- 另一份可用克隆：`D:\Workspace\study\nanowork\nanobot`（**fsck 零问题**，本次的修复来源）。
  **建议保留**，作为引擎仓库的第二个可用对象源。
- **教训**：不要把「只有 .idx 没有 .pack」的 pack 目录当成正常状态；`git fsck` 应纳入本地例行检查
  （尤其在做批量清理 / 改 `.git` 之前）。

---

## 六、父仓库 clone 后的 Electron 入口说明

`package.json` 的 `"main": "electron/main.cjs"`，但 `electron/main.cjs` 与 `preload.cjs`
**被 `.gitignore` 排除**（构建产物，由 esbuild 从 `electron/main.ts` / `preload.ts` 打出）。

**这不影响使用**：`npm run electron:serve` 与 `npm run build:electron` 都会**先生成**这两个文件再启动/打包。
但直接 `npx electron .` 在全新 clone 上会失败（`main.cjs` 不存在）——**先跑一次构建脚本**即可。

> 决定了不把产物入库：提交 bundle 会让 diff 淹没真实改动。若将来要「clone 即可 `electron .`」，
> 正确做法是加一个 `prepare`/`postinstall` 钩子生成产物，而不是提交产物。

---

## 七、端口与配置约定

| 项 | 值 | 来源 |
|---|---|---|
| 客户端默认网关 | `http://127.0.0.1:18900` | `src/lib/core/constants.ts` 的 `DEFAULT_GATEWAY_PORT` |
| 桌面端自动挑端口 | 首选端口不可用（被占用 / 落在 Windows 保留区间）时顺延探测，并经 `nanobot:gatewayInfo` 同步地址 | `electron/main.ts` 的 `resolveGatewayPort` |
| 启动网关 | `.\nanobot\nanobot\.venv\Scripts\nanobot.exe serve --config nanowork.config.json --host 127.0.0.1 --port 18900 -v` | 根 `README.md` 第 3.3 节 |
| 配置文件 | `nanowork.config.json`（**已 gitignore，含密钥**） | 根 `README.md` 第 3.2 节 |
| 引擎工作区 / 用户目录 | `resolveNanobotWorkspacePath()`；用户资产在 `~/.nanowork` | ADR-018 / v2 §18.2 |

> **端口不一致会连不上**：`docs/gateway-e2e.md` 曾把网关写成 `8765`，已于 2026-09-17 修正为 `8900`。
> **2026-09-21 再次迁移到 `18900`**：`8900` 落在 Windows 保留端口区间（8807–8906）内，绑不上且报
> `10013`（不是「被占用」的 `10048`）。此后首选端口定为 `18900`，并新增主进程自动顺延 + 地址协商。

---

## 八、相关文档

| 文档 | 关系 |
|---|---|
| `docs/upstream-merge-conflicts.md` | 引擎侧 104 处 `[LOCAL PATCH]` 全量清单与合并步骤 |
| `docs/adr/` | 引擎侧改动的决策依据（尤其 ADR-0021 / ADR-0024 / ADR-0005） |
| `.github/workflows/ci.yml` | 父仓库 CI；**不含引擎侧**（引擎不在父仓库版本控制内，原因见本文第一节） |
| 根 `README.md` | 网关配置、模型预设、Electron 桌面端用法 |
