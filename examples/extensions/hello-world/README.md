# Hello 扩展（最小可用样例）

对齐 WorkBuddy `resources/extensions/` 的宿主资产机制，但在本项目里用**更窄的协议**实现：

| | WorkBuddy | nanowork |
|---|---|---|
| 界面加载 | Module Federation `remoteEntry.js`（与宿主共享依赖） | 独立 HTML + `nanowork-ext://` 自定义协议 |
| 与宿主通信 | federation 共享模块 | `postMessage`（`channel: 'nanowork-extension'`） |
| 后台服务 | `service.process: 'fork'`，随宿主启动 | 同样 fork，但**用户显式启动** |
| 分发清单 | `extension.json` + `distribution.json`（多环境 URL） | 只有 `extension.json`（本项目无多环境部署） |

## 目录

```
hello-world/
├── extension.json      # 清单：界面入口 / 预览器 / 设置项 / 后台服务
├── ui/index.html       # 扩展界面（自带样式与脚本，不依赖宿主 React）
├── ui/preview.html     # 产物预览器（CSV 表格 / 日志着色）
└── server/index.cjs    # 后台服务（node，监听 127.0.0.1 随机端口）
```

## 安装

**推荐**：打开应用 → 侧边栏「能力扩展 → 扩展」→ 点「安装扩展」→ 选中本目录
（`examples/extensions/hello-world`，**包含 extension.json 的那一层**）。

手工安装要复制**整个目录**，不是目录里的文件——少一层目录就装不上：

```bash
# ✅ 正确：扩展目录下多一个 hello-world/ 子目录
mkdir -p ~/.nanowork/extensions
cp -r examples/extensions/hello-world ~/.nanowork/extensions/

# ❌ 错误：文件直接躺在 extensions/ 根下
cp -r examples/extensions/hello-world/* ~/.nanowork/extensions/
```

装成后者时，扩展页会显示一条黄色提示告诉你结构不对（扫描器只遍历子目录，
所以"一个扩展都看不见"）。修正：

```bash
cd ~/.nanowork/extensions
mkdir hello-world && mv README.md extension.json server ui hello-world/
```

然后回到扩展页点「重新扫描」。

## 试四件事

1. **界面**：卡片上点「打开」。扩展会显示宿主通过 `postMessage` 传来的 id 与主题，
   并证明它拿不到 `window.electronAPI`。
2. **后台服务**：卡片上点「启动服务」→ 展开日志，第一行是
   `hello-world service listening on http://127.0.0.1:<port>`；把端口填进界面里的
   输入（或改 `ui/index.html` 里的 `SERVICE_PORT`）后点「请求 /health」。
   返回里的 `leaked: []` 是**证明宿主没把 API Key 交给扩展**——`buildServiceEnv` 是白名单。
3. **产物预览器**：让 Agent 在会话里写一个 `.log` 或 `.csv` 文件（例如
   `写一个 app.log，随便几行带 INFO/WARN/ERROR 的日志`），产物面板上就会出现
   「用 日志查看器 打开」——点开看到的是**这个扩展渲染的**：日志按级别着色 +
   错误/警告计数，CSV 渲染成表格（含引号内逗号的正确解析）。
   内置渲染只会显示纯文本，这就是「扩展补内置做不到的事」。

   ⚠️ **两种产物要分清**：
   - Agent 用 `write_file` 写出文件 → 产物是 **file 类型**（带路径与扩展名）→
     `ext:log` 自动命中，按钮直接写「用 日志查看器 打开」；
   - Agent 直接在回复里**输出一段日志代码块** → 产物是 **code 类型**，标题是
     「代码块 (text) 1」，**没有文件名**，任何 `ext:` 都匹配不上 → 这时按钮是
     「用扩展预览 ▾」，点开自己挑一个预览器。
4. **设置项**：设置 → 数据管理，底部会多出「Hello 扩展示例设置」（清单里
   `ui.settings[].target = "data"`）；设置 → 扩展 是全部扩展设置项的汇总。
3. **交外链**：点「打开项目主页」。扩展自己 `window.open` 会被 sandbox 拦住，
   发消息给宿主由宿主代开才是正路。

## 写自己的扩展

最少两个文件：

```
my-ext/
├── extension.json
└── ui/index.html
```

```json
{
  "id": "my-ext",
  "name": "我的扩展",
  "version": "0.0.1",
  "description": "一句话说明它做什么",
  "ui": { "entry": { "title": "我的扩展", "url": "./ui/index.html" } }
}
```

清单字段全集见 `src/types/extension.ts`。四条硬规则：

1. `id` 必须等于目录名（它同时是协议 URL 的 host）；
2. `ui.entry.url` 只能是包内 `.html` 相对路径或 `http(s)` 绝对地址；
3. `service.entry` 必须在包内、且是 `.js/.cjs/.mjs`；
4. 所有包内路径不能越出扩展目录（`../` 与 `C:` 一律拒绝）。

## 写自己的产物预览器

`ui.artifactPreviews[].match.bizType` 只认**三种前缀**（越具体越先匹配）：

| 写法 | 匹配依据 | 例子 |
|---|---|---|
| `ext:<扩展名>` | 产物文件名后缀 | `ext:pdf` / `ext:docx` |
| `lang:<语言>` | 产物已推断出的高亮语言 | `lang:python` |
| `type:<产物类型>` | `Artifact.type`（`markdown` / `code` / `html` …） | `type:markdown` |

写成别的值（比如 WorkBuddy 那套 `wb/app`）**清单照样加载、卡片照样显示「N 个预览器」，
但永远不会被匹配到**——`tests/lib/extension/sampleExtension.test.ts` 专门守这一条。

预览器页面从 `postMessage` 拿数据，形态是：

```js
{
  channel: 'nanowork-extension',
  type: 'context',
  payload: {
    context: {
      bizType: 'ext:log',            // 命中的 bizType
      artifact: {
        id, type, title, path, language,
        size,                        // 字节数（可能为 null）
        text,                        // 文本快照，上限 256 KB
        truncated                    // 是否被截断
      }
    }
  }
}
```

⚠️ 两个容易踩的点：

- **二进制 / 超限文件只有元信息**（`text` 为空串）。要读字节得自己起服务去读，
  宿主不替扩展读磁盘；
- 主题在 URL 里（`?theme=dark`）给一次，切换时还会收到 `type: 'theme'` 的消息——
  只用消息的话首帧会白闪。
