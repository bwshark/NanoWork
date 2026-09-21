# 交付概览 — 类 WorkBuddy 智能体客户端（基于 nanobot 引擎）

> 引擎：nanobot（HKUDS，OpenAI 兼容 API）｜ 对标：WorkBuddy ｜ 平台归口：`web` / `electron`
>
> **本文是交付快照，不是需求依据。** 唯一事实源为 `docs/nanowork-prd-design-v2.md`；文档与代码冲突时**以代码为准**。
> 状态：**增量（每期收口时重写）**。改写口径遵循 v2 第 1.2 节「现状代码基线」。

---

## TL;DR

基于 **nanobot 引擎**、对标 **WorkBuddy** 的跨端智能体客户端。同一套 React 渲染层既可在浏览器运行，也可被 Electron 加载为桌面应用；直连 nanobot 网关（`/v1/chat/completions`，OpenAI 兼容 SSE），连接状态实时探测（connected / offline）。

**V1（工作台成型）尚未整体收口**：M1 引擎与事件地基、M2 安全与执行模式已闭合；M3 扩展与提示词 4/6 批次、M4 自动化与产物 0/6、M5 可观测部分落地。详见下节。

---

## 一、V1 里程碑状态（2026-09-17）

| 里程碑 | 文档口径 | 代码实测 | 说明 |
|---|---|---|---|
| **M1** 引擎契约层 + 事件化会话 | 已完成 | ✅ 闭合 | `src/ai/runtime/` 契约层（D1）、事件模型 + 存储三层（D2：路由 / 索引 / IO + 双实现 + 四个不变量 + Phase C/D/E 全部落地） |
| **M2** 安全与执行模式 | 已闭合 | ✅ 闭合 | 三档决策 `decide_tier`、回收站改道（FR-8.3）、审计留痕（FR-8.9）、Agent 工具白名单（FR-2.2）、`session_mode`、逐条批准（D3） |
| **M3** 扩展与提示词 | 4 批已落 | 🟡 **4/6** | 技能三态 / 连接器 / 插件 / 提示词工程已落；**FR-3.7 市场四档注册表、FR-3.8 版本隔离缓存未开工** |
| **M4** 自动化与产物 | — | ⬜ **0/6 未开工** | 文件快照与回滚（FR-7.3）、结果回推 IM（FR-6.3）、定时任务真实 runner 等 |
| **M5** 可观测 | — | 🟡 部分 | 引擎侧审计留痕已落；`llm_usage.sqlite3` 已存在数据但**前端零消费**，无用量/成本报表（FR-11.1） |

---

## 二、质量门禁（实测，非引用）

| 门禁 | 命令 | 实测结果 |
|---|---|---|
| 渲染层单测 | `npm test` | ✅ 全绿（`tests/` 66 个用例文件，含 gateway 集成、事件等价性、权限、记忆、cron 等） |
| 类型检查（渲染层） | `npm run typecheck` | ✅ 0 错误 |
| 类型检查（桌面外壳） | `npm run typecheck:electron` | ✅ 0 错误 |
| 类型检查（测试代码） | `npm run typecheck:tests` | ✅ 0 错误（**注意：不在 `build` 门禁内**） |
| 生产构建 | `npm run build` | ✅ 绿（= `typecheck` + `typecheck:electron` + `vite build`） |
| 引擎侧 pytest | `nanobot/nanobot/.venv/Scripts/python.exe -m pytest tests/...` | 🟡 340 passed / 1 failed，唯一失败为 `tests/security/test_workspace_policy.py::test_resolve_allowed_path_blocks_symlink_escape`（Windows 无 symlink 权限，属环境类红，非回归） |

> CI 门禁定义见 `.github/workflows/ci.yml`（含平台边界检查）。`typecheck:tests` 是否纳入门禁见该文件注释。

---

## 三、已实现能力（按 v2 第 1.2 节口径）

**引擎接入**
- `src/ai/runtime/` —— 引擎契约层（D1），渲染层与引擎交互的唯一出口：`types.ts`（`AgentRuntime` + 能力声明 + wire 类型）、`index.ts`（`getRuntime()` 工厂）、`nanobotHttp/runtime.ts`、`nanobotHttp/chat.ts`（SSE 客户端，透传 `session_id` / `model` / `workspace` / `access_mode`，支持 multipart 文件上传）、`nanobotHttp/{config,channels,tasks}.ts`（把前端配置反向镜像进引擎 `config.json` / `cron/jobs.json`）、`codec.ts`（camelCase ⇄ snake_case 归一）。
- `src/ai/connectionManager.ts` + `ConnectionBanner` —— 网关可达性探测。
- `src/ai/cronTaskMirror.ts` / `cronMirrorWatcher.ts` / `cronRunsPoller.ts` —— 聊天中 `cron` 工具创建的任务镜像进任务列表、执行留痕轮询。

**会话与交互**
- `src/pages/chat/*` —— `ChatPage` / `MessageStream` / `AssistantMessage`（流式 markdown）/ **`ReasoningBlock` + `ProcessView`（思考过程时间线，`lib/processDigest.ts`）** / `ToolCallCard`。
- `src/components/composer/*` —— 斜杠命令选择器、文件引用选择器、附件栏、内联附件 chip；**`useVoiceInput` + `TranscriptionConfig`（语音输入，走 OpenAI 兼容 `/audio/transcriptions`）**。
- `src/pages/chat/heroPresets.tsx` —— 空状态三级联动：**模式（日常办公 / 代码开发 / 设计创意）→ Skill 技能 → 提示词标签 → 提示词**。

**Agent 与专家**
- `src/pages/agents/{AgentsPage,MyAgentsPage}.tsx` + `stores/agentsStore.ts` —— Agent CRUD / 启停 / 持久化。
- `src/types/expertGroup.ts` + `ai/builtinExpertGroups.ts` —— **专家团**三模式：`sequential`（顺序流水线）/ `parallel`（并行会诊）/ `coordinator`（主从协调）。
- `src/ai/{builtinAgents,builtinSkills,builtinMcps}.ts` —— 内置专家 / 技能 / MCP 目录。

**扩展与运维页**
- `/skills`、`/mcp`（CRUD + 连接测试 + 同步状态）、`/tasks`、`/memory`（用户级 / 工作区级双层）、`/persona`（身份文件 + 提示词模板外置编辑）、`/artifacts`、`/im`。
- `src/lib/{skillParser,skillOverrides,promptCatalog,promptLibrary,identity,promptAssembly,memory}.ts`。

**IM 通道（5 渠道 + 扫码接入）**
- `src/lib/channelMeta.ts` + `src/types/channel.ts` —— **钉钉 / 飞书 / Lark / 微信 / 企业微信**；字段含 `allowFrom`、`groupPolicy`(open/mention)、`topicIsolation`。
- `src/lib/channelScan.ts` + `components/im/ChannelScanPanel.tsx` —— **扫码接入**（**飞书 / Lark / 微信**），走网关 `settings.channel.connect.*` 认证 WebSocket 帧。
- `electron/channelAllowFrom.ts`、`electron/channelDisconnect.ts` —— 主进程侧白名单写入与断开。
- 同步链路：`ChannelConfig[]` → `toNanobotChannels()` → `platform.syncNanobotChannels()` → 主进程合并进 `config.json` + 重启网关（Web 降级为下载片段）。

**自动化**
- `src/types/task.ts` —— `TaskSchedule` = `cron`(5 段 + tz) | `interval`(分钟) | `once`(ISO 时间)；`TaskRunRecord`；`TaskRunOptions`。
- `src/lib/cron.ts` —— `validateCron` + `describeSchedule` + `nextCronRunMs`。
- 镜像：`toNanobotJob()` → `{workspace}/cron/jobs.json`，带 `originMetadata.managedBy='smartagent'` 托管标记与 `sessionKey='api:cron-{taskId}'` 会话绑定。

**安全与权限**
- 会话级 `fullAccess` ↔ 请求参数 `access_mode: 'full' | 'restricted'`；引擎侧三档决策 + 回收站改道 + 审计留痕（`.nanowork/audit/tool-gateway.ndjson`）+ Agent 工具白名单。
- `components/PermissionDialog.tsx` + `types/permission.ts` 的 `PermissionLog` 决策留痕。

**记忆**
- `src/lib/memory.ts`（`MemoryService`）+ `/memory` 页 + `MemoryBar`；`MEMORY.md`、`<!-- MEMORY -->` 注入标签、`<!-- SUMMARY:<hash> -->` 幂等去重、多工作区 `workspaceKey`；身份文件与 `~/.nanowork/prompts/` 外置覆盖。

**跨端与桌面**
- `src/platform/` —— `env` / `storage.web` / `storage.electron` / `nanobotBridge` / `notification` / `types` / `index`；**渲染层零 `import 'electron'`**。
- `electron/` —— `main.ts` 自动拉起 nanobot 网关、`tray.ts`、`hotkey.ts`、`webuiFrames.ts`、`builder.config.json`。
- 根目录 `llm_usage.sqlite3` —— 用量库已存在（**尚未被前端消费**）。

**存储**
- 会话走 **事件日志（JSONL）+ JSON 索引**（D2），`sessionsStore` 已切读；其余域（agents / skills / mcp / tasks / settings / artifacts / channels / expertGroups）仍用 Zustand `persist` → `platform.storage`。

---

## 四、已知限制 / 遗留风险

1. **`SyncMeta` 未落**：`src/types/event.ts` 只有类型声明，无写入点。v2 第 19.2 节明确要求「V1 必须先落 `SyncMeta`」，不补则 V1.5 双向同步要返工。
2. **`FR-8.4`「默认拒绝写入」语义与实现不符**：引擎侧 `default_deny_write: bool = False`（默认放行），实为 opt-in 开关；需改默认值或改名。
3. **`FR-7.3` 文件回滚是「假就绪」**：事件类型已定义，全仓无生产者，UI 亦无入口。
4. **`FR-2.4` 专家团三模式只持久化未真实执行**：`sequential` / `parallel` / `coordinator` 目前是配置态。
5. **子代理结果丢失**（已定位未修）：`/v1` 链路下 `spawn(wait=false)` 的结果必然丢失——`process_direct` 不传 `pending_queue`，且 `serve` 与 `gateway` 是两个进程、各持有自己的 MemoryBus。可用路径为 `spawn(wait=true)`（`run_inline`，`announce=False`，结果当工具结果回注）。
6. **上游耦合**：引擎侧 `[LOCAL PATCH]` 标记散落 28 个文件约 104 处，与 v2 第 2.2 节「不 fork nanobot 主干」存在张力。清单见 `docs/upstream-merge-conflicts.md`。
7. **nanobot 当前不下发 `tool_calls` / `artifacts` 事件**（经源码确认，`_sse_chunk` 仅返回 `delta.content`）：客户端已按标准 OpenAI 协议写好解析层（网关/代理下发即生效），并对完成文本做围栏块启发式产物提取。
8. **次要改进点**（不阻塞）：非敏感工具 `pending` 闪现、Artifact 下载统一 `.txt`、light 主题未联动切换。

---

## 五、仓库构成与运行

### 5.1 两个仓库

`nanobot/` 是**同级独立 git 仓库**（上游 `HKUDS/nanobot`），**被父仓库 `.gitignore` 忽略，不是 submodule**。父仓库 clone 后拿不到引擎源码，需另行获取。约定与初始化步骤见 `docs/engine-dev-setup.md`。

### 5.2 运行

```bash
npm install                       # 若受限环境可加 ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm run dev                       # Web 开发服务器（http://localhost:5173）
npm run build                     # tsc ×2 + vite build → dist/
npm run electron:serve            # 构建并以 Electron 打开
npm run verify:gateway            # 网关链路集成测试（monkeypatch fetch 全链路）
```

真实网关（详见根 `README.md` 第 3 节与 `docs/engine-dev-setup.md`）：

```bash
.\nanobot\nanobot\.venv\Scripts\nanobot.exe serve --config nanowork.config.json --host 127.0.0.1 --port 18900 -v
```

> 客户端默认网关为 `http://127.0.0.1:18900`（`src/lib/constants.ts`）。**端口不一致会连不上**。
> 首选端口被占用或落在 Windows 保留端口区间（`winerror 10013`，如 nanobot 自带的 8900 就落在
> 8807–8906 区间里）时，桌面端主进程会**自动顺延挑一个可用端口**，并经 `nanobot:gatewayInfo`
> 把真实端口同步给渲染层（横幅提示「端口已自动改为 N」）。手工起网关时端口需自己保证可用。

---

## 六、相关文档

| 文档 | 用途 |
|---|---|
| `docs/nanowork-prd-design-v2.md` ⭐ | 唯一事实源：需求 + 设计 + ADR 总纲 |
| `docs/README.md` | 文档索引（登记制 + 一致性看板 + 阅读路径） |
| `docs/adr/` | 架构决策记录（ADR-0001 ~ ADR-0024） |
| `docs/engine-dev-setup.md` | 引擎仓库边界、venv 约定、本地开发与排错 |
| `docs/upstream-merge-conflicts.md` | 上游合并冲突面清单（`[LOCAL PATCH]` 全量） |
| `docs/gateway-e2e.md` | 网关端到端验证手册 |
| `README.md`（根） | 使用入门 |
