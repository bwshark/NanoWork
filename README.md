# nanowork · 智能办公助手

基于 [HKUDS nanobot](https://github.com/HKUDS/nanobot) 引擎、**对标 WorkBuddy** 的跨端智能体（Agent）客户端。同一套 React 渲染层既能在浏览器运行，也能被 Electron 加载为桌面应用；始终直连真实 nanobot 网关进行端到端对话，连接状态实时探测（connected / offline）。

> 引擎契约：nanobot 暴露 OpenAI 兼容的 `/v1/chat/completions` SSE 接口（`delta.content` 文本流 + 标准 `tool_calls` 增量 + 富产物）。

---

## 特性（P0）

| 编号   | 能力                    | 说明                                                                   |
| ------ | ----------------------- | ---------------------------------------------------------------------- |
| FR-001 | 多 Agent 流式会话       | 会话列表 + 流式 Markdown + 工具调用卡片                                |
| FR-002 | Agent 管理              | 列表 / 增删改 / 启停 / 持久化                                          |
| FR-003 | 技能（Expert Kits）管理 | 技能网格 + 启停 + 能力详情 + 搜索                                      |
| FR-004 | MCP 管理                | CRUD + 连接测试 + 同步状态标签                                         |
| FR-005 | 定时任务管理            | cron / 间隔调度 + 启停 / 删除                                          |
| FR-006 | 设置与连接              | endpoint / token 配置 + 网关可达性探测（connected / offline）          |
| FR-007 | 富产物渲染              | html / svg / 图像 / mermaid / 代码 / md / 视频 + 下载                  |
| FR-008 | 本地持久化              | Zustand `persist`：Web = `localStorage` / Electron = JSON              |
| FR-009 | 敏感操作权限门控        | 文件 / 终端 / 网络前确认弹窗 + 决策记录                                |
| FR-010 | IM 远程控制 UI          | `Agent.imBinding` 结构化（平台 / 账号 / 状态），真实绑定推送待网关能力 |

## 技术栈

- **构建**：Vite 5 + TypeScript 5
- **前端**：React 18 + React Router 7 + MUI v5 + Tailwind CSS
- **状态**：Zustand v4（按域拆分 + `persist` 中间件）
- **桌面**：Electron + electron-builder（共用 `src/`，经 `preload` 桥接）
- **引擎**：nanobot（Python，`serve` 提供 OpenAI 兼容 SSE 网关）

## 架构要点

- **统一 `aiClient` 抽象**：`nanobotClient`（OpenAI 兼容 SSE 解析）直连 nanobot 网关；`ConnectionManager` 探测可达性（connected / offline），`ConnectionBanner` 展示当前状态。
- **跨端隔离**：同一 `src/` 渲染层，环境差异只在 `src/platform/`（Web / Electron 适配器：`writeTextFile` / `nanobotBridge` / `storage`）。渲染层**零 `import 'electron'`**，Electron 经 `preload` 暴露 `window.electronAPI`。
- **状态分层**：`sessions / agents / skills / mcp / tasks / settings / artifacts` 独立 store，持久化接 `platform.storage`。

---

## 本地开发

```bash
cd nanobot
.\nanobot\.venv\Scripts\activate
.\nanobot\.venv\Scripts\python.exe -m pip install -e .
.\nanobot\.venv\Scripts\nanobot.exe agent --classic
```

> venv 位于 `nanobot/nanobot/.venv`（editable 安装直接指向源码 `nanobot/nanobot/`，改源码即生效，无需重装）。
> 完整约定与排错见 `docs/engine-dev-setup.md`。
>
> ⚠️ **`nanobot/` 是独立 git 仓库**（上游 `HKUDS/nanobot`），**被本仓库 `.gitignore` 忽略，且不是 submodule**。
> 也就是说：**clone 本仓库拿不到引擎源码**，需另行获取，步骤见 `docs/engine-dev-setup.md` 第一节。

## 快速开始

### 1. 安装依赖

```bash
cd D:\Workspace\study\nanowork
npm install
```

> 本机装 Electron 二进制会较大；CI / 受限环境下可加 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过，不影响 Web 构建。

### 2. Web 模式

```bash
npm run dev        # 启动 Vite dev server
# 浏览器打开 http://localhost:5173 （若被占用会自动顺延端口，看终端输出）
```

### 3. 连接真实 nanobot 网关

要跑通真实大模型对话，需要本机有一个 nanobot 网关。本项目已把 nanobot 源码与运行环境放在 `nanobot/` 目录（venv 位于 `nanobot/nanobot/.venv`，editable 安装指向源码，隔离、不污染系统 Python）。

#### 3.1 安装 nanobot（已装可跳过）

```bash
# 用隔离的 managed Python 建 venv（也可用你自己的 Python 3.13）
C:\Users\xinmi\.workbuddy\binaries\python\versions\3.13.12\python.exe -m venv nanobot\nanobot\.venv
.\nanobot\nanobot\.venv\Scripts\python.exe -m pip install -U pip
.\nanobot\nanobot\.venv\Scripts\python.exe -m pip install -e nanobot aiohttp   # editable 安装 + serve 需要 aiohttp
.\nanobot\nanobot\.venv\Scripts\python.exe -m pip install -e ".\nanobot[api]"
```

#### 3.2 配置网关

新建 `nanobot.config.json`（**已 gitignore，密钥不出本机**）：

```json
{
  "providers": {
    "dashscope": {
      "api_key": "sk-你的DashScopeKey"
    }
  },
  "agents": {
    "defaults": {
      "model": "qwen3-32b"
    }
  },
  "modelPresets": {
    "qwen3-max": { "label": "Qwen3 Max", "model": "qwen3-max" },
    "qwen-plus": { "label": "Qwen Plus", "model": "qwen-plus" }
  }
}
```

- **模型下拉来源**：前端模型选择器的可选项来自网关 `GET /v1/models`，即本配置的 `modelPresets` + 隐式 `default`（`agents.defaults.model`，固定首位）。新增/修改预设后重启网关即生效，前端打开下拉时自动刷新目录。
- **切换立即生效**：会话/任务选择的模型随每次请求下发，网关按请求级解析（预设名走 `modelPresets`，裸模型名走当前 provider 覆盖），无需改网关默认配置；选 `Auto` 则跟随 `agents.defaults.model`。

> ⚠️ **重要坑（已踩过）**：nanobot 的 dashscope provider **默认不剥离 `dashscope/` 前缀**。若写成 `"dashscope/qwen-max"`，它会把 `dashscope/qwen-max` 原样发给 DashScope，报「model 不存在 / 无权限」。**直接写裸模型名 `qwen-max`** 即可，nanobot 会按 provider 关键字自动路由到 dashscope。

#### 3.3 启动网关 + 前端

```bash
# 终端 A：启动 nanobot 网关（默认监听 127.0.0.1:8900）
.\nanobot\nanobot\.venv\Scripts\nanobot.exe serve --config nanobot.config.json --host 127.0.0.1 --port 8900 -v

# 终端 B：启动前端
npm run dev
```

然后在前端顶部 **ConnectionBanner** 填入网关地址 `http://127.0.0.1:8900` 并连接，选择「通用助手」（默认模型 `qwen3-32b`）发送消息即可。

> 端口冲突（`[winerror 10048]`）：同一端口不能两个进程共用。重启用 `netstat -ano | findstr :8900` 查 PID，`taskkill /PID <pid> /F` 杀掉旧进程再起。

### 4. Electron 桌面端

```bash
npm run electron:serve   # vite build 后用 electron 打开 dist（静态，无热更新）
npm run build:electron   # electron-builder 产出可分发包（dist-electron/）
```

> 带热更新的桌面开发：先 `npm run dev`（5173），再 `npx electron .` 直接加载 dev server。
>
> 桌面端在 `app.whenReady()` 时会**自动尝试拉起本地 nanobot 网关**（`electron/main.ts` 的 `startNanobot`，可用 `NANOBOT_BIN/HOST/PORT` 环境变量或 `userData/nanowork.nanobot.json` 覆盖）；拉起失败不影响主程序，可在界面用 ConnectionBanner 的「拉起 / 停止」按钮手动控制。

---

## 脚本一览

| 命令                     | 作用                                               |
| ------------------------ | -------------------------------------------------- |
| `npm run dev`            | Vite 开发服务器                                    |
| `npm run build`          | `tsc --noEmit` 类型检查 + Vite 生产构建 → `dist/`  |
| `npm run preview`        | 预览生产构建                                       |
| `npm run verify:gateway` | 跑网关集成测试 `tests/gateway.integration.test.ts` |
| `npm run build:electron` | 构建 Electron 可分发包                             |
| `npm run electron:serve` | 构建并以 Electron 打开                             |

## 测试与质量

```bash
npm test                 # 全部单测（vitest）：66 个用例文件 / 1085 个用例全绿
npm run verify:gateway   # 网关链路集成测试（monkeypatch fetch 全链路）
npm run typecheck        # 渲染层 src/ 类型检查
npm run typecheck:electron  # 桌面外壳 electron/
npm run typecheck:tests  # 测试代码 tests/
npm run build            # typecheck + typecheck:electron + vite build
```

测试覆盖：网关集成、事件等价性（实时视图 ≡ 事件投影）、权限 / 工具网关、记忆去重 / 多工作区、cron 校验、会话 / 任务 / 工具调用等。

> 上述四类检查已固化为 CI（`.github/workflows/ci.yml`），另含两条**平台边界检查**：
> `window.electronAPI` 只允许出现在 `src/platform/`（ADR-004 / ADR-010），
> 引擎 wire 字段只允许出现在 `src/ai/runtime/nanobotHttp/`（ADR-020）。
> 引擎侧 pytest **不在 CI 内**——引擎是独立仓库且被本仓库忽略，原因见 `docs/engine-dev-setup.md`。

---

## 目录结构

```
nanowork/
├─ src/                      # 渲染层（Web + Electron 共用）
│  ├─ ai/                    # nanobotClient / connectionManager / builtinSkills / nanobotConfig / sseToolCalls / artifactExtractor
│  ├─ components/            # 通用组件 + chat/ tasks/ 子组件
│  ├─ layout/                # AppLayout / SidebarNav / ConnectionBanner
│  ├─ lib/                   # memory / cron / taskDraft / sse / id / constants
│  ├─ pages/                 # chat / agents / skills / mcp / tasks / memory / settings / artifacts
│  ├─ platform/             # 跨端适配：env / storage.web / storage.electron / nanobotBridge / types
│  ├─ router/               # React Router 7 路由
│  ├─ stores/               # Zustand 按域 store
│  ├─ theme/                # MUI 主题
│  ├─ types/                # 全局类型
│  ├─ App.tsx / main.tsx
├─ electron/                 # 桌面外壳：main / preload / builder.config / storageRoutes / eventStore …
├─ tests/                    # vitest 单测 + 网关集成测试
├─ docs/                     # 文档索引（README.md）+ v2 主文档 + adr/ + 工程约定
├─ .github/workflows/ci.yml  # CI：typecheck ×3 + vitest + build + 平台边界检查
├─ nanobot.config.json       # 真实网关配置（gitignore，含密钥）
├─ nanobot/                  # ⚠️ 独立 git 仓库（上游 HKUDS/nanobot），被 .gitignore 忽略，非 submodule
│  └─ nanobot/.venv/         # 项目级 nanobot 运行环境（gitignore）
├─ package.json / vite.config.ts / tsconfig*.json / tailwind.config.js
└─ OVERVIEW.md               # 交付概览与状态
```

---

## 已知限制 / 遗留项

1. **nanobot 当前不下发 `tool_calls` / `artifacts` 事件**：服务端 SSE 仅返回 `delta.content` 纯文本。客户端已实现标准 OpenAI `tool_calls` 增量解析器（网关/代理下发时自动生效）与文本启发式 artifact 提取（code / mermaid / html 围栏块），对标 WorkBuddy 富产物内联渲染。
2. **MCP 运行时同步**：nanobot 无公开 MCP 注册 HTTP API；当前生成可被 `config.json` 消费的 `mcpServers` 片段（Electron 写用户目录 / Web 触发下载）+ 同步状态机。
3. **IM 真实绑定**：`imBinding` 目前仅本地记录，真实绑定推送待 nanobot 运行时暴露 IM 网关接口后接入。
4. **定时任务 runner**：当前仅配置（cron 校验 / 启停 / 删除），无后台实际调度执行引擎。
5. **次要改进点**（不阻塞）：非敏感工具 `pending` 闪现、Artifact 下载统一 `.txt`、light 主题未联动切换。

## 相关文档

> **唯一事实源是 `docs/nanowork-prd-design-v2.md`**（需求 + 设计 + ADR 总纲）。
> 任何文档与它冲突，以它为准；任何文档与**代码**冲突，以代码为准。索引见 `docs/README.md`。

| 文档 | 用途 |
|---|---|
| `docs/nanowork-prd-design-v2.md` ⭐ | 唯一事实源：需求 + 设计 + ADR |
| `docs/README.md` | 文档索引（登记制 + 一致性看板 + 阅读路径） |
| `docs/adr/` | 架构决策记录（ADR-0001 ~ ADR-0024） |
| `docs/engine-dev-setup.md` | 引擎仓库边界、venv 约定、本地开发与排错 |
| `docs/upstream-merge-conflicts.md` | 上游合并冲突面清单（`[LOCAL PATCH]` 全量） |
| `docs/gateway-e2e.md` | 网关端到端验证指南 |
| `OVERVIEW.md` | 交付概览与迭代状态 |
| `docs/architecture.md` / `docs/chat.md` | **已取代（历史存档）**，文首有横幅，勿作实现依据 |

## License

内部项目，未开源。
# nanowork
