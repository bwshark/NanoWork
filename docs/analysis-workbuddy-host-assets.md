# WorkBuddy「宿主资产区」全量对照 & 本项目实现

> 调查对象：`D:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources`（1409 个文件）
> 调查时间：2026-11-01
> 姊妹文档：`docs/analysis-workbuddy-plugins-and-expert-packages.md`（插件与专家包专题）

---

## 〇、TL;DR

三条结论：

1. **`resources/` 不是"插件目录"，是宿主的资产区**。里面装着四类完全不同的东西：**数据资产**（prompt 模板、语气风格、专家推荐位）、**声明式资产**（`plugin.json` / `extension.json`）、**可执行资产**（扩展的 `ui/` + `server/`、DevTools 面板、preload 桥）、**原生二进制**（企业微信 SDK、IM napi）。
2. **本项目已经对齐了其中一半，而且实现方式更"编译期"**：`templates/*.tpl` 那套（模式提醒 / 身份上下文 / 7 种语气 / 场景主 prompt）在本项目对应 `promptAssembly.ts` 的 12 段装配 + `promptCatalog.ts` 的槽位，**语义一致、载体不同**（TS 常量 + `~/.nanowork/prompts` 覆盖 vs Jinja `.tpl`）。
3. **真正的缺口只有一个：`extensions/` 那套扩展体系**——它让第三方能给应用"加一块界面 + 一个后台服务"。本次按"类似"而不是"一样"实现（不引入 Module Federation，改 HTML + `nanowork-ext://` 协议 + `postMessage`），并给出可运行样例。

一句话取舍：**数据资产抄格式，声明式资产抄语义，可执行资产抄边界，原生二进制不抄。**

---

## 一、`resources/` 全量清单与结论

| # | 资产 | 是什么 | 本项目现状 | 结论 |
|---|---|---|---|---|
| 1 | `plugins/workbuddy-builtin/` | 插件市场：技能 / 子代理 / 命令 / 钩子 / MCP / prompt 片段 | ✅ 已有（`~/.nanowork/plugins` + 引擎 `plugins.py`），上一轮又补了"随包专家一键导入" | **已对齐** |
| 2 | `templates/*.tpl`（18 个） | 宿主 prompt 骨架：ask/craft 模式提醒、身份上下文、语气、12 个场景主 prompt | ✅ `promptAssembly.ts` 12 段 + `promptCatalog.ts` 3 模式 × 3 领域 × 7 风格 | **已对齐（载体不同）** |
| 3 | `templates/style/*.md`（7 种） | 语气风格库 | ✅ 7 种一一对应（professional / friendly / efficient / straightforward↔direct / creative / sarcastic↔snarky / socratic） | **已对齐** |
| 4 | `templates/miora/*`（.kiwi/.miora） | 设计画布模板 | ❌ | **不做**（Ardot/Miora 专有格式，无对应产品能力） |
| 5 | `extensions/`（8 个） | 扩展体系：UI 联邦模块 + fork 服务 + 产物预览器 + 设置挂载 + 选择器扩展点 | ❌ 此前完全没有 | **本次实现（类似）** |
| 6 | `builtin-expert-recommendations/curated-experts.json` | 专家推荐位（数据文件，含 priority / scenarios） | ⚠️ 专家目录硬编码在 `ai/builtinAgents.ts`（8 位） | **未做**（见 §6） |
| 7 | `devtools-terminal/`（ghostty wasm） | DevTools 面板里的实时 PTY 终端 | ✅ **系统终端版**（右侧边栏「打开终端」→ 在工作空间目录拉起 `cmd`/`Terminal`）；不做内置 PTY | **已实现（类似）** |
| 8 | `mcp-app-preload.js` | MCP App 的 webview 桥（postMessage ↔ IPC，含 `stopImmediatePropagation` 规避自激） | ⚠️ 有 MCP 连接与工具调用，**没有 MCP App 视图** | **未做**（见 §6） |
| 9 | `tdoc-preview-preload.js`（1761 行） | 腾讯文档预览 webview 桥 | ❌ | **不做**（无该服务） |
| 10 | `lexiang-webview-preload.js` / `oneid-webview-preload.js` | 乐享知识库 / OneID 登录桥 | ❌ | **不做**（无该服务；本项目知识库自带预览） |
| 11 | `client-menu-preload.js` | 客户端菜单桥（自绘菜单 ↔ 主进程） | ✅ `TitleBar.tsx` 自绘菜单 + `main.ts` 原生菜单置空 | **已对齐（不同实现）** |
| 12 | `wecom-agent-confirm/`（dll/dylib/h） | 企业微信「Agent 确认」原生 SDK | ❌ | **不做**（见 §7） |
| 13 | `im-backend-cmd/im-napi.node` | IM 后端命令原生 napi | ❌ | **不做**（见 §7） |
| 14 | `channel-branding/`、`icon*.ico/png`、`trayTemplate*.png` | OEM 品牌资源 + 托盘图 | ✅ `electron/tray.ts` + `build/` 图标 | **已对齐** |

统计：**已对齐 5 项 / 本次实现 1 项 / 未做 3 项 / 明确不做 5 项。**

---

## 二、四类资产的分层模型（决定"抄不抄"的判据）

| 层 | 特征 | 例子 | 借鉴策略 |
|---|---|---|---|
| **数据资产** | 模型看到/听到的文本，改它不用重编译 | `templates/*.tpl`、`style/*.md`、`curated-experts.json` | **抄格式与内容组织**，载体可换（本项目用 TS 常量 + 磁盘覆盖） |
| **声明式资产** | 描述"我提供什么"，宿主按字段装载 | `plugin.json`、`extension.json`、`marketplace.json` | **抄字段语义**，不抄私有扩展键（`.codebuddy-plugin` 双前缀是改名期技术债） |
| **可执行资产** | 会被加载执行的代码 | 扩展 `ui/`+`server/`、DevTools 面板、preload 桥 | **抄边界**（沙箱/白名单/权限档位），不抄运行机制（federation / webview） |
| **原生二进制** | 平台相关 dll/node 插件 | 企业微信 SDK、`im-napi.node` | **不抄**：跨平台构建 + 签名 + 崩溃面都不可控，用 HTTP/协议替代 |

---

## 三、已对齐项：`templates/` ↔ `promptAssembly`

这一块最容易被误判成"缺失"，实际是**同构不同载体**：

| WorkBuddy | 本项目 | 说明 |
|---|---|---|
| `ask-mode-reminder.tpl` / `craft-mode-reminder.tpl` | `promptCatalog.ts` 的 `MODE_SLOTS`（ask/plan/craft） | 本项目多一档 `plan` |
| `user-context-identity.tpl`（Jinja：`{% if WorkspaceIdentityMode %}`） | `promptAssembly.ts` 第 2 段 `<identity_context>` | 变量注入换成纯函数入参 |
| `templates/style/*.md` | `STYLE_SLOTS`（7 种，含质量护栏锚点 `QUALITY_CLAUSE_MARKER`） | 本项目额外用单测钉住"风格不得污染事实" |
| `workbuddy-*-prompt.tpl`（12 个场景主 prompt） | `PRODUCT_IDENTITY_TEXT` + 领域段 + 技能段 | 12 个模板收敛成"身份 + 模式 + 领域 + 技能"四维组合，避免模板爆炸 |
| 磁盘覆盖（无，改 tpl 要发版） | `~/.nanowork/prompts/<kind>/<key>.md` | **本项目更强**：改提示词不用重编译 |

差异要点：WorkBuddy 用 **Jinja 模板 + 变量**；本项目用 **纯函数装配 + 固定段序**。后者可逐段单测（`tests/promptAssembly.test.ts`），前者要靠渲染后的字符串断言。

---

## 四、本次实现：扩展（Extension）体系

### 4.1 与原版的对照

| 维度 | WorkBuddy | 本项目（claude/nanowork） | 为什么不同 |
|---|---|---|---|
| 清单 | `extension.json` + `distribution.json` | 只有 `extension.json` | 本项目无多环境部署（`deploymentProfiles` 会变成没人读的配置） |
| UI 加载 | `ui.entry.url` 指向 Module Federation `remoteEntry.js` | HTML 入口 + `nanowork-ext://<id>/` 自定义协议 | federation 要求宿主暴露共享依赖表，宿主升 React 会让所有扩展一起碎 |
| 与宿主通信 | federation 共享模块 | `postMessage`（`channel: 'nanowork-extension'`，4 种消息） | 扩展自带依赖、跑在自己源里；协议窄到可以逐条审计 |
| 后台服务 | `service.process: 'fork'`，随宿主启动 | 同样 fork，但**用户显式启动** | 第三方 node 常驻不该是默认行为 |
| 产物预览器 | `ui.artifactPreviews[]`（`match.bizType`） | **已接线**（产物头部多一个「用 X 打开」入口） | 不接管内置渲染，只做「另一种看法」 |
| 设置挂载 | `ui.settings[]`（`target` 指向设置分区） | **已接线**（分区底部 + 「扩展」分区汇总） | target 认不出来时不丢，进汇总页 |
| 选择器扩展点 | `ui.pickers[]` | 未做 | 本项目没有命令面板 |
| 权限 | `distribution.json` 的 `grantedPermissions` / `trustedUrls` | 不设声明式权限：靠**沙箱 + 协议 + 服务环境白名单** | 声明式权限要么被强制执行（工作量大），要么只是装饰（更糟） |

### 4.2 落点

| 文件 | 职责 |
|---|---|
| `src/types/extension.ts` | 清单与消息协议的唯一类型声明处 |
| `src/lib/extension/extensionUrl.ts` | 地址换算（主进程与渲染层共用，无 `@/` 依赖） |
| `electron/extensionPackage.ts` | 清单解析 / id 校验 / 路径包含性检查 / 扫描 / **安装** / 装错结构诊断 |
| `electron/extensionProtocol.ts` | `nanowork-ext://` 注册与 handler，响应头带页级 CSP |
| `electron/extensionService.ts` | fork 生命周期（环境白名单 / 环形日志 / 崩溃退避 / 级联清理） |
| `src/stores/extensionsStore.ts` | 运行时视图（不持久化：磁盘即真相） |
| `src/components/extensions/ExtensionFrame.tsx` | iframe 宿主 + 消息桥 + 主题同步 |
| `src/pages/extensions/ExtensionsPage.tsx` | 列表 / 打开界面 / 服务开关 / 日志 / 空态引导 |
| `src/lib/extension/artifactPreview.ts` | 产物 ↔ 预览器的 bizType 匹配（纯函数，含优先级） |
| `src/components/extensions/ExtensionPreviewAction.tsx` | 产物头部入口（懒加载弹层，避免抬高首屏） |
| `src/components/extensions/ExtensionPreviewDialog.tsx` | 预览弹层（宿主 → 扩展递产物元信息与文本快照） |
| `src/components/settings/ExtensionSettings.tsx` | `ui.settings` 的两种呈现（分区内嵌 + 汇总分区） |
| `src/components/agents/ImportableExpertsBar.tsx` | 随包专家 → 专家页直达导入（`curated-experts.json` 的等价落点） |
| `examples/extensions/hello-world/` | 可运行样例（界面 + 服务 + 消息桥三件事） |

### 4.3 安全边界（四层，每一层都有用例或实测）

1. **清单层**：`id` 必须等于目录名（它同时是协议 host）；`url` 只认包内 `.html` 或 `http(s)`；`service.entry` 必须包内且是 js。
2. **路径层**：`resolveInside` 三层判断 —— 绝对路径拒 / **含 `:` 一律拒** / 规范化后 `..` 开头拒，最后 `isInside` 兜底。
   > 实测过的坑：Windows 上 `C:../evil.cjs` 的 `isAbsolute()` 是 `false`，`normalize` 后是 `C:..\evil.cjs`（不以 `../` 开头），但 `resolve(root, …)` 会解到 `C:\ext\evil.cjs` —— **前两层都会放行**。这条规则同时挡掉 NTFS 的 `file.txt:stream` 语法。
3. **渲染层**：iframe `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"`（**没有** `allow-top-navigation` / `allow-modals` / `allow-downloads`）；页面响应头带 CSP（允许联网、禁止嵌套与 object）。
4. **进程层**：`fork` 只传环境白名单（`PATH/HOME/TEMP/LANG…` + `NANOWORK_EXTENSION_ID`），**宿主 API Key 一律不传**；崩溃 3 次后停止自动重启；退出时同步 kill 所有扩展服务。

---

## 五、与 WorkBuddy 的两处"刻意不抄"

| 不抄 | 原因 |
|---|---|
| Module Federation | 共享依赖表把宿主与扩展绑成同一份版本命运；本项目选择"扩展自带依赖"换取宿主可独立升级 |
| `distribution.json` 的环境分发 | 按 `runEnv`/`edition` 换 URL 是 SaaS 多环境部署的产物；本项目只有一个运行环境，加了就是死配置 |

---

## 六、两项已接线（本轮的后续增量）

### 6.1 产物预览器（`ui.artifactPreviews`）

WorkBuddy 的 `bizType` 是它自己的产品类型（`wb/app`、`workbuddy/browser-preview`）。
本项目产物没有那套标识，于是把 bizType 定义成**三种可判定的前缀**：

| 写法 | 匹配依据 | 例子 |
|---|---|---|
| `ext:<扩展名>` | 产物文件名后缀（小写、不含点） | `ext:pdf` / `ext:docx` |
| `lang:<语言>` | 产物上已推断出的高亮语言 | `lang:python` |
| `type:<产物类型>` | `Artifact.type` 原值 | `type:markdown` |

**候选顺序是 ext → lang → type**，越具体越先问。理由：`type:file` 是"所有文件我都要"，
一旦排前面，一个贪心扩展会抢走全部文件产物（`tests/lib/extension/artifactPreview.test.ts`
里有这条用例钉着）。

**不接管内置渲染**：产物面板默认渲染不变，扩展只是头部多一颗「用 X 打开」按钮，
点开是弹层里的 iframe。替换式接管会让"装个扩展就把产物面板改坏"变成默认行为。
预览器是 `lazy()` 加载的——`ArtifactRenderer` 在 `AppLayout` 静态链上，把 iframe 宿主
静态挂上去会直接抬高首屏（本项目有 1.5 MB 预算门禁）。

内容怎么给扩展：iframe 是独立源、读不到 `artifact.path`，所以宿主经
`postMessage`（`type: 'context'`）递过去**元信息 + 文本快照**（上限 256 KB，超了标 `truncated`）。
二进制大文件只给路径与尺寸——真要读字节得由扩展自己的服务去做。

**端到端样例**：`examples/extensions/hello-world/ui/preview.html` 是一个真能用的预览器——
`.log` 按级别着色并统计错误/警告，`.csv` 渲染成表格（含引号内逗号的正确解析）。
内置渲染对这两种文件只会显示纯文本，这正是"扩展补内置做不到的事"的最小证明。
页面逻辑由 `tasks/verify-extension-preview.mjs` 在浏览器里真跑一遍（15 条断言：主题、
表格列数、引号错列、日志着色、无内容提示、主题切换消息）。

**两种入口形态**（都是真机反馈后补的）：

| 产物形态 | 匹配结果 | 按钮 |
|---|---|---|
| `.log` / `.csv` 文件产物（有 `path`） | `ext:log` 自动命中 | 「用 日志查看器 打开」 |
| 回复里直接输出的代码块（`type: 'code'`，标题「代码块 (text) 1」） | **没有文件名，`ext:` 永远匹配不上** | 「用扩展预览 ▾」下拉手选 |

第二形态是必需的：用户最常见的操作就是"让 AI 输出一段日志"，而那**不会**产生文件产物
（`exec` / `Set-Content` 也不在 `FILE_WRITE_TOOLS` 里，只有 `write_file` / `edit_file` /
`edit` / `apply_patch` 才算）。只做自动匹配的话，这个场景永远看不到入口。

### 6.2 设置挂载（`ui.settings`）

两处呈现、一个数据源：

- **分区内嵌**：`ExtensionSettingLinks` 挂在每个设置分区正文之后，只显示 `target`
  命中当前分区的条目（贴近 WorkBuddy 的行为）；
- **「扩展」分区**：设置页新增一档，列出**全部**条目（含 target 对不上的）。

为什么必须两个：本项目分区 id 与 WorkBuddy 不同名（扩展照原样写 `dataManagement`
在本项目不存在）。只做内嵌的话那些条目**永远看不到**，用户会以为"扩展的设置在哪儿
都没出现"——那是最难查的一类静默失败。

点击条目 → 关设置 + 跳扩展页（`?focus=<id>`）。不叠第二个弹窗：设置弹窗上再开一个，
关起来会连环。

### 6.3 专家推荐位（`curated-experts.json`）—— 换了个落点

WorkBuddy 用这个文件做"专家中心的推荐候选"。本项目把等价语义落在**随包专家提示条**：
插件带来的专家在专家页顶部直接给出导入入口（`ImportableExpertsBar`）。

理由：本项目的内置专家目录（8 位）已经是"推荐"本身，再加一份推荐清单没有增量；
真正缺的是"插件带来的专家在专家页看不见，只能去插件页翻"。

判重按**同名**（`Agent.name === displayName`）：不做 id 级登记——插件里的专家没有本地
id，用户改名后它会重新出现，这比"导入过就永久不再提示"更安全（重装场景不会漏）。

---

## 七、仍未做的一项

| 项 | 现状 | 下一步 |
|---|---|---|
| 专家推荐位**数据文件化** | 8 位内置专家仍硬编码在 `ai/builtinAgents.ts` | 如果将来要"不发版就调推荐位"，再把它们搬进 `src/ai/curated-experts.json`（`{id,type,scenarios,description,priority}`）；当前没有这个需求，硬编码反而让 `mergeAgents` 的"代码为真源"更直白 |

### 明确不做的两项

| 项 | 原因 | 替代 |
|---|---|---|
| `devtools-terminal`（ghostty wasm 终端） | 需要引入 ~2MB wasm + 一个 DevTools 扩展宿主，还要自己管一套 shell 会话状态 | **已用系统终端替代**（右侧边栏「打开终端」）：零依赖、零维护，且是真终端（补全/管道/vim 都在）。代价是它不在右栏内，是个独立窗口 |
| MCP App 视图（`mcp-app-preload.js` 那套） | 等价物是"给 MCP 的 HTML 资源一个沙箱视图"。本项目 `ArtifactRenderer` 已有 srcdoc + CSP 的沙箱，接线成本中等但当前没有带 HTML 资源的 MCP 服务器可验 | 等真实 MCP App 出现再做，复用 `ExtensionFrame` 的沙箱思路 |

---

## 七、为什么不做原生二进制

| 资产 | 它解决的问题 | 为什么不做 | 本项目怎么做 |
|---|---|---|---|
| `wecom-agent-confirm/*.dll` | 企业微信「Agent 确认」弹窗（用户点一下才允许 Agent 代表他操作） | 跨平台构建（win dll / mac dylib）+ 代码签名 + 崩溃面全在宿主进程之外，且要腾讯侧配合 | 本项目 IM 走 gateway 的 `POST /v1/turn` + 审批卡（`ChannelApprovalCard`），确认动作在自家界面里完成 |
| `im-backend-cmd/im-napi.node` | 给 IM 后端发命令的原生通道 | 同上；且 napi 版本要跟 Electron 的 ABI 锁死 | 走 HTTP/WebSocket（`/v1/send`、`/v1/cron/reload`） |

判据：**能用协议解决的不要引入二进制**。二进制的代价不是"多一个文件"，而是"每个平台每次升级都要重新验证一遍"。

---

## 八、验证

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` / `:electron` / `:tests` | ✅ 三套 exit=0 |
| 新增单测 | ✅ 6 个文件 **61 用例**（清单解析 21 / 服务纯逻辑 10 / 地址换算 6 / 产物匹配 13 / 随包专家条 6 / 样例扩展守卫 5） |
| 全量 vitest（`--maxWorkers=3 --silent`） | ✅ **313 文件 / 4469 用例全绿、exit=0** |
| `vite build` | ✅ exit=0 |
| 首屏体积 | ✅ 两条预算都在范围内（预览弹层是 `lazy()`，没进首屏） |
| 真机 `tasks/verify-extensions-page.mjs` | ✅ 11 条全过（扩展页降级 / 设置扩展分区 / 专家页无噪音 / 侧边栏可达 / 无页面错误） |
| 真机 `tasks/verify-extension-preview.mjs` | ✅ 15 条全过（主题 / 初始等待态 / CSV 3 列 2 行 / **引号内逗号不错列** / 日志着色与计数 / 无内容提示 / 主题切换） |
| 变异验证 | ✅ 去掉 `resolveInside` 的"含冒号一律拒"→ NTFS ADS 用例变红，还原复绿。**这条变异暴露了真问题**：`C:../evil.cjs` 能绕过前两层判断（详见 §4.3） |
| 样例扩展 | `examples/extensions/hello-world/`：界面 + `fork` 服务 + 消息桥三件事都能跑（手工步骤见其 README） |

### 手工验收（Electron 端，协议与 iframe 只能在真机验）

```bash
mkdir -p ~/.nanowork/extensions
cp -r examples/extensions/hello-world ~/.nanowork/extensions/
# 打开应用 → 侧边栏「能力扩展 → 扩展」→ 重新扫描 → 打开 / 启动服务
```

判据：① 界面能显示宿主传来的 id 与主题；② 界面里 `typeof window.electronAPI === 'undefined'`
（证明拿不到宿主桥）；③ 服务日志第一行有 `listening on http://127.0.0.1:<port>`；
④ `/health` 返回里 `leaked: []`（证明环境白名单生效）。
