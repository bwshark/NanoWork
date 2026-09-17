# nanobot 网关端到端验证

本项目客户端（`NanobotClient`）需要连接 nanobot 的 OpenAI 兼容 `/v1/chat/completions` 才能
跑通真实对话。由于沙箱环境无法安装 nanobot 运行时、也无法绑定端口，提供两套等价/互补的验证方式。

## 1. 协议层端到端测试（推荐，沙箱可用）

`tests/gateway.integration.test.ts` 用 monkeypatch 的 `global.fetch` 模拟「OpenAI 兼容 SSE」网关，
真实跑通 `NanobotClient.sendMessage` 全链路：

- `delta.content` 文本流 → 增量拼接
- `delta.tool_calls`（标准 OpenAI 增量格式）→ `ToolCallAccumulator` 解析 → pending/done 事件
- 流结束 → `extractArtifacts` 启发式提取 mermaid / code 围栏块

运行：
```bash
npm run verify:gateway
# 或直接
npx vitest run tests/gateway.integration.test.ts
```

## 2. 真实 nanobot 网关（生产环境）

```bash
pip install nanobot
nanobot serve --host 127.0.0.1 --port 8900
```

> ⚠️ **端口必须与本项目客户端默认值一致**。客户端默认网关为 **`http://127.0.0.1:8900`**
> （见 `src/lib/constants.ts`）。若把网关起在别的端口（例如 `8765`），必须在 ConnectionBanner
> 里手改 endpoint，否则连接失败。
>
> 本仓库的推荐做法不是 `pip install`，而是用仓库内已就绪的隔离环境（editable 安装，改源码即生效）：
>
> ```bash
> .\nanobot\nanobot\.venv\Scripts\nanobot.exe serve --config nanowork.config.json --host 127.0.0.1 --port 8900 -v
> ```
>
> 详见根 `README.md` 第 3 节 与 `docs/engine-dev-setup.md`。

> 注：经源码确认，nanobot 当前版本的 `/v1/chat/completions` 仅流式返回 `delta.content`
> 纯文本，不含 `tool_calls` / `artifacts` 事件，但支持 `session_id` 隔离与文件上传。
> 客户端的 `tool_calls` 解析层与 `artifact` 提取层已按标准 OpenAI 协议写好，待 nanobot
> 未来版本（或用户在前置代理中补全）下发对应事件时自动生效，无需改动上层。

## 验证清单

- [x] `probe()` 命中 `/v1/models` 返回 `connected`
- [x] `listModels()` 正确解析模型列表
- [x] 文本流增量拼接正确
- [x] `tool_calls` 增量拼接 + 参数 JSON 解析正确
- [x] mermaid / code 围栏块被提取为 artifact
- [x] 文件上传（multipart）分支能解析文本流
