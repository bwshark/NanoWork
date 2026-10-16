# WorkBuddy 平台能力全图 \&nanowork 借鉴清单

> 调查对象:`D:\Program Files\WorkBuddy`(整目录,1.3 GB,appVersion 5.8.2)  
> 调查时间:2026-10-15  
> 上一篇:`docs/analysis-workbuddy-builtin-plugins.md`(只覆盖 `resources/plugins/workbuddy-builtin`,即插件机制)  
> 本篇覆盖**其余全部**:运行时、沙箱、原生集成、扩展体系、Guest 桥接、桌面集成、随包运行时。

---

## 〇、TL;DR

把整目录拆完,WorkBuddy 的能力可以分成**五层**。上一篇只拆了最上面一层(插件),本篇补其余四层:

| 层            | 内容                                               | 本项目            | 借鉴价值 |
| ------------ | ------------------------------------------------ | -------------- | ---- |
| **① 插件/扩展层** | builtin 插件、5 种交互模式、prompt 片段矩阵                   | ✅ 大半已有         | 上篇已评 |
| **② 扩展运行时层** | `extensions/` 8 个(fork 服务进程 + MF UI + guest SDK) | ❌ **全空白**      | ⭐⭐⭐  |
| **③ 安全沙箱层**  | tsbx 沙箱、Job Object、三层删除 shim、路径规则文件              | ⚠️ **只到应用层审批** | ⭐⭐⭐⭐ |
| **④ 原生集成层**  | 设备指纹/风控/IM/企微/内核驱动/提权                            | ❌ 不需要          | ⭐    |
| **⑤ 交付工程层**  | 随包运行时、多发行形态、自检修复、性能报告                            | ❌ 空白           | ⭐⭐⭐  |

**最值得抄的不是"它有什么功能",而是两个工程模式:**

1. **fail-closed 的纵深防御**:危险动作(删除、计费、越权)在**每一层**都设卡——内核 Job Object → 沙箱规则 → 进程 shim(bash/node/python 三套)→ broker IPC → 应用层审批。任何一层挂了都**绝不降级放行**。
2. **注释即设计文档**:`high-credit-gate.cjs`、`client-menu-preload.js`、`mcp-app-preload.js` 的头部注释都写「为什么需要它 + 曾经的 bug + 改动前必须通读什么」。这是**可直接抄的团队习惯**。

---

## 一、总体布局(实测)

```
WorkBuddy/                                   1.3 GB
├── WorkBuddy.exe                204 MB   Electron 主程序
├── ffmpeg.dll / dxcompiler.dll / vk_swiftshader.dll   多媒体与图形
├── Resources/
│   ├── app.asar                  94 MB   主进程 + 渲染层 bundle
│   ├── app.asar.unpacked/                 ← 可读部分
│   │   ├── cli/                  agent 运行时(agent-cli / codebuddy-code 2.161.0)
│   │   │   ├── bin/              引导层(codebuddy / daemon-supervisor / no-orphans / windows-job)
│   │   │   ├── builtin/workflows/deep-research.workflow.js
│   │   │   ├── dist/codebuddy-lite-wb.mjs (9.5 MB) + lazy-lite-wb/ (64 chunk)
│   │   │   ├── node_modules/     只剩 koffi + node-pty
│   │   │   └── vendor/           sandbox 5.8.5 / ripgrep / genie-trash / wecom-cli / shim/
│   │   ├── main/preload/fork-preload.cjs (732 KB)  扩展服务进程 preload
│   │   ├── native/               perf-metrics / turing-sdk / wechat-copydata-decoder
│   │   ├── node_modules/         @tencent/{qimei,tencent-docs-ai-engine,wwapi-electron}
│   │   │                         @genie/{im-channels-native,im-channels-sidecar}
│   │   │                         better-sqlite3 / koffi / node-pty
│   │   └── renderer/             index.html + assets/(Monaco + xterm + WASM)
│   ├── install-manifest.json     112 文件自检清单(给 RepairApp.exe)
│   ├── extensions/               8 个内置扩展
│   ├── plugins/workbuddy-builtin/  插件体系(上篇)
│   ├── templates/                16 个 prompt .tpl + miora/ + style/(7 种语气)
│   ├── vendor/                   PortableGit / python(CPython 3.13) / node.zip / genie-trash
│   ├── qm/qm-helper.exe          QmProtector 内核驱动管理
│   ├── elevate.exe               UAC 提权
│   ├── workbuddy-editor-sdk-supervisor.exe   editor_sdk 子进程守护
│   ├── startup-report.html / conversation-report.html   性能诊断报告
│   └── wb-guest-sdk/wb.js        guest 页桥接 SDK
├── share-target/WorkBuddyShareTarget.exe + .msix   Windows 分享目标
├── Assets/ locales/ file-icons/
└── version = 37.10.3-42 (Electron)
```

---

## 二、逐层解剖 + 本项目对比

### 2.1 【层②】扩展运行时 —— 本项目最大的结构性空白

WorkBuddy 有**两套独立**的扩展机制,**不要混淆**:

|      | `plugins/`(上篇)                 | `extensions/`(本篇)                                                |
| ---- | ------------------------------ | ---------------------------------------------------------------- |
| 面向   | 给 **agent** 加能力(技能/子代理/钩子/MCP) | 给 **应用** 加功能(UI + 后台服务)                                          |
| 载体   | `plugin.json` + md/脚本          | `extension.json` + `distribution.json`                           |
| 运行   | 在 agent 进程内/由 agent 调用         | **fork 独立 Node 进程**(`service.entry`, `process: fork`)            |
| UI   | 无(或 MCP app 的 html)            | **Module Federation remote**(`renderer: "mf"`, `remoteEntry.js`) |
| 权限   | 无独立权限模型                        | `grantedPermissions: ["*"]` / `["metrics.record"]`               |
| 生命周期 | 会话内                            | `resident: true` 常驻 / `activationEvents: ["onStartup"]`          |

8 个内置扩展:`cloud-assistant`(云助理) / `community`(灵感社区) / `edge-sync`(端云同步) / `global-search`(全局搜索) / `im-channels`(团队 IM,**required**) / `library`(资料库) / `remote-desktop`(本机 Remote) / `workbuddy-baas-v2`(Genie BaaS)。

**扩展进程的注入机制**(`main/preload/fork-preload.cjs`,732 KB):

```js
// 入口
process.env.WB_EXTENSION_ID;
const userEntry = process.argv[2];
const userModule = require(userEntry);
const activate = resolveActivate(userModule);   // module.activate / default.activate / 默认函数
await runExtension({ extensionId, env, activate });
```

在 `require` 扩展入口**之前**先建立 `transport-process` 桥接 + `service-process-protocol`,注入 host-policy / process-env,再调 `activate(wb)`。暴露的事件面非常细:

```
wb-extension-probe / -ready / -shutdown
wb:conversation:{artifactUpdate,childAgentEvent,configUpdate,contextUsageChanged,
                 creditChanged,historyLoaded,mcpStartupStatus,modeChange,modelChange,
                 permission,planUpdate,pluginRecommendationChanged,queueUpdate,
                 stateChange,timelineEvent,warning,…}
wb:env:snapshot
错误契约:__wbError: true
```

**对比本项目**:

- 本项目 `docs/nanowork-prd-design-v2.md:242` 把 `extensions/` 列为**规划中的「四级扩展生态」**(plugins/skills/connectors/experts/extensions),**零实现**。
- 现有扩展形态只有插件(`electron/pluginPackage.ts`)、技能(`src/lib/skillParser.ts`)、MCP(`electron/mcpProbe.ts`),都是**进程内**的。
- `electron/` 顶层 33 个文件,无任何 fork 服务进程 / MF / extension preload。

**可借鉴的**:不是抄 Module Federation(重、渲染层要改造),而是抄 **「扩展 = 独立 fork 进程 + preload 注入 activate(wb) + 事件订阅面」** 这个模式。对一个"本地优先的 agent 客户端"来说,**进程隔离比 UI 联邦重要得多**——一个扩展崩了不该拖垮主进程。WorkBuddy 自己在 `@tencent/wwapi-electron` 里也是这个思路(`isolation: 'process'`,「把原生 SDK 搬进 utilityProcess worker 做崩溃隔离」)。

---

### 2.2 【层③】安全沙箱 —— 本项目在 Windows 上是裸奔的

#### WorkBuddy 的五道防线

| # | 防线                   | 实现                                                                                                      | 关键设计                                                                               |
| - | -------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 | **内核级进程管控**          | `cli/bin/native/win32-x64/job-object.node` → `ensureKillOnCloseJob()` / `isProcessInJob(pid)`           | Windows Job Object 把 CLI + 全部子进程纳入,**父进程关闭即杀整棵树**,防孤儿。daemon 刻意**不入 job**以保证生命周期独立 |
| 2 | **主机沙箱(tsbx 5.8.5)** | `cli/vendor/sandbox/5.8.5/`(sandbox-cli.exe / tsbx*.dll / betterleaks.exe) + `tsbx_rules.json`          | 文件读写删按 glob 授权;**DNS 域名拦截 + Rust LocalProxy 做 TCP 决策**;进程白名单;敏感信息扫描                |
| 3 | **多语言删除 shim**       | `cli/vendor/shim/`:bash(`safe-bin/`)、Node(`node-safe-delete-shim.cjs`)、Python(`sitecustomize.py` 52 KB) | 三套运行时的删除操作全部劫持到统一 broker                                                           |
| 4 | **统一删除后端**           | `genie-trash/win32-x64.exe`(Rust,`trash-5.2.6`)                                                         | 移入系统回收站;**失败时拒绝降级为硬删除**(fail-closed)                                               |
| 5 | **应用层审批**            | hook `permissionDecision: 'ask'`                                                                        | 计费工具强制弹窗,判定**早于**所有权限规则与 bypass 判定                                                 |

#### `tsbx_rules.json` 的规则格式(这是最有借鉴价值的一份)

```jsonc
{
  "file_rules": [
    { "path": "%USERPROFILE%\\.ssh\\**",  "action": "read=deny|write=deny|delete=deny" },
    { "path": "%USERPROFILE%\\.gnupg\\**","action": "read=deny|write=deny|delete=deny" },
    { "path": "%LOCALAPPDATA%\\npm\\**",  "action": "read=allow|write=allow|delete=allow" }
  ],
  "white_process": ["msedge.exe", "chrome.exe", "firefox.exe", "…"],
  "network_policy": { "enabled": true, "default": "allow",
                      "deny_ips": [], "deny_domains": [] },
  "file_rules_user":    [{ "path": "D:\\openclaw\\proxy-agent\\**", "…": "…" }],
  "network_rules_user": []
}
```

要点:**`action` 是「资源=动作」的复合串**(`read=deny|write=deny|delete=deny`),不是单一布尔。**读、写、删三种权限可以分别授权**——这一点本项目没做到。

#### 本项目现状

- ✅ **引擎侧删除做得比 WorkBuddy 还细**:`nanobot/security/trash.py` 走 `SHFileOperationW`(Win)/`osascript`(mac)/`gio trash`(Linux),fail-closed 抛 `TrashUnavailableError` **绝不降级 `os.remove`**,还有临时目录豁免、批量阈值 `DEFAULT_BULK_THRESHOLD=10`、`safe-delete-report.ndjson` 留痕。shell 里的删除命令也被识别(`is_delete_command`)。
- ✅ **应用层审批完整**:`ToolApprovalHook` 三档裁决(allow / deny / always),超时默认 300s 无通道一律 deny。
- ✅ **凭据保护有硬名单**:`security/workspace_policy.py` 的 `NO_ACCESS_DIR_NAMES`(`.ssh`/`.gnupg`/`.aws`/`.kube`/…)、`NO_ACCESS_FILE_NAMES`。
- ⚠️ **OS 级沙箱只在 Linux 有**:`nanobot/agent/tools/sandbox.py` 只实现了一个后端 `_bwrap()`(bubblewrap),且**配置默认关闭**(`tools.exec.sandbox: ""`)。Windows 上明确降级为警告 `"Sandbox is not supported on Windows; running unsandboxed"`(`shell.py:455`)。
- ⚠️ **macOS App Sandbox 只是「被探测」而非「被创建」**:`workspace_sandbox_status()` 读环境变量判断,默认 `level="application", enforced=False`。
- ❌ **无 Job Object / AppContainer / seccomp / sandbox-exec / firejail**。
- ❌ **主进程自身删除是裸的**:`eventStore.ts`、`pluginPackage.ts`、`main.ts` 多处直接 `fs.rm` / `unlink`,全仓**零 `shell.trashItem`**。(`logStore.ts` 甚至在注释里明说是**刻意**用 unlink+rmdir 规避批量删除守卫。)
- ❌ **无用户可配置的路径级规则文件**。`SecuritySection.tsx` 明确写「这里不做白名单编辑器」,凭据名单「只展示、不提供修改入口」。
- ⚠️ Electron 窗口 `webSecurity: false` 且未设 `sandbox`(`main.ts:555-561`)。

**差距一句话**:本项目把安全做成了**单点(应用层审批)+ 硬编码名单**,WorkBuddy 做成了**纵深五层 + 用户可配置规则**。Windows 平台上你我都是"无 OS 沙箱",但 WorkBuddy 用 Job Object + 沙箱规则 + shim 把应用层防线做厚了。

---

### 2.3 【层③附】进程与终端能力

| 能力           | WorkBuddy                                                                                         | 本项目                              |
| ------------ | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| 真 PTY 终端     | ✅ `@lydell/node-pty` + conpty.dll + OpenConsole.exe,配 `@xterm/headless` + `ink` 做 TUI             | ❌ **无 node-pty**                 |
| 内嵌 ripgrep   | ✅ `vendor/ripgrep/` 双形态:`rg.exe`(子进程)+ `ripgrep.node`(NAPI 内嵌,**免起进程**)                           | ⚠️ 用系统/引擎侧                       |
| 子进程树管控       | ✅ Job Object(内核强制)                                                                                | ⚠️ 仅 `taskkill /pid <pid> /T /F` |
| 进程守护         | ✅ `workbuddy-editor-sdk-supervisor.exe`(Win32 Job Object + stdin JSON `{"command":"force-stop"}`) | ❌ 无 supervisor 模式                |
| FFI 直调系统 API | ✅ `koffi` 2.16.2                                                                                  | ❌                                |

**可借鉴**:①**Job Object 封顶进程树**——这是 Windows 上性价比最高的加固,`taskkill` 是"事后补救",Job Object 是"内核兜底",成本约一个 NAPI 模块或直接调 `taskkill` 之外的原生方式;②**ripgrep 的 NAPI 内嵌形态**——避免每次搜索起子进程。

---

### 2.4 【层④】原生集成 —— 本项目基本不需要

| 模块                                                           | 作用                                                                                                                         | 本项目                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `native/turing-sdk`                                          | 腾讯天御 TuringShield 风控,`fetchDeviceToken()`,variant=domestic                                                                 | ❌ 不需要                                                                     |
| `qimei.dll` + `@tencent/qimei-node` + `main/qimei-helper.js` | Qimei(天象)设备指纹,取 qimei36/uskey,**独立子进程取数避免主进程直接加载**                                                                         | ❌ 不需要                                                                     |
| `qm/qm-helper.exe`                                           | **QmProtector 内核驱动**管理(`uninstall/suspend/resume/status`),校验父进程与 DLL 的腾讯签名链                                                | ❌ 不需要                                                                     |
| `native/wechat-copydata-decoder`                             | 解 `WM_COPYDATA` 指针,**接收微信等客户端的跨进程分享**                                                                                      | ❌ 不需要                                                                     |
| `@tencent/wwapi-electron`                                    | 企微原生(选人/微盘/分享/授权),`isolation:'process'` 崩溃隔离                                                                               | ❌ 不需要                                                                     |
| `WeComAgentConfirmSDK.dll`                                   | 企微「二次确认弹窗」发送端(WM_COPYDATA);用户结果**不回传**                                                                                     | ❌ 不需要                                                                     |
| `@genie/im-channels-native` + `im-napi.node`(10.7 MB Rust)   | 腾讯 IM C SDK + IM 后端 v2 API,**SQLite `client_v2_send` 表做幂等发送日志**(状态机 staged→sending→ready→indexed/failed + Idempotency-Key) | ⚠️ 有 IM 5 渠道但是轻量实现                                                        |
| `elevate.exe`                                                | UAC 提权执行                                                                                                                   | ❌ 不需要                                                                     |
| `better-sqlite3`                                             | 本地 SQLite                                                                                                                  | ⚠️ 本项目引擎用 sqlite(`llm_usage.sqlite3`),主进程**不直读**(Node 20 无 `node:sqlite`) |

**唯一值得看的是那个幂等发送日志设计**:`client_v2_send` 表 + `ON CONFLICT(user_id, client_op_id) DO NOTHING` + `Idempotency-Key` 头。本项目 IM 渠道如果要保证"不重发、不丢"，这是现成的 schema。

---

### 2.5 【层②附】Guest 桥接 SDK 与沙箱预览

#### WorkBuddy 的 `wb-guest-sdk/wb.js`(18.7 KB 单文件)


给 iframe / webview 子页面用的宿主桥接:

```
握手:wb:handshake:request / :response
RPC: wb:invoke:request / :response
事件:wb:event / wb:env:snapshot
生命周期:wb:lifecycle:{activate,data,deactivate,dispose}
窗口:wb:windows:{opened,closed,message,stateChanged}
传输:__wb_port_init__(MessagePort)
错误:WB_BRIDGE_TIMEOUT / WB_BRIDGE_PROTOCOL_VIOLATION / AbortError
```

API 形态:`invoke` / `call` / `bind` / `on` / `onAny` / `resize` / `focus` / `abort`。

#### 两个 preload 的「为什么」写法(可直接抄的注释风格)

`client-menu-preload.js` —— 讲清了一个 Electron 特有问题:

> 菜单页通过 wb SDK 向宿主请求登录态。**在 Web 端**菜单页是 DOM `<iframe>`,`window.parent` 就是宿主 renderer 的 window,宿主能直接收到 postMessage。**但在 Desktop 端**菜单页跑在 Electron `<webview>` 里 —— 这是**独立的 webContents**,`window.postMessage` **不会**冒泡到宿主 window,桌面菜单的鉴权通道就此失效。唯一可靠的桥接:`ipcRenderer.sendToHost`。

`mcp-app-preload.js` —— 讲清了一个更微妙的坑:

> 在 Electron `<webview>` 里 `window.parent === window`。朴素的 preload 监听 `message` 会**看到自己发出去的请求又回来**,把它当成 INCOMING 请求,于是 SDK 回 `-32601 Method not found`,那个错误又被 self-post 回来,correlate 到 pending 的请求上,**在宿主真响应到达之前就 reject 掉 `app.connect()`**。monkey-patch `window.postMessage` 不可靠(某些 Chromium 配置下属性描述符不可写、赋值静默失败)。**所以在 DOM 事件层拦截:注册捕获阶段的 `message` 监听**。

#### `markdown-shared-guest.html` 的 CSP

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; font-src 'self' data:;
connect-src 'none'; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'
```

注释明说 `connect-src 'none'` 是刻意的:guest **不直连磁盘、不发 fetch/XHR**,所有数据经 postMessage 由宿主下发——「这正是它比 miora 暴露面更小的原因」。

#### 本项目现状

- ❌ **无 guest SDK、无 postMessage 协议、无 invoke RPC**(全仓检索 `postMessage` 无生产代码命中)。
- ⚠️ iframe 只用于**产物预览**,单向渲染:HTML 产物用 `srcDoc` + `sandbox="allow-scripts"`(`ArtifactRenderer.tsx:86`),WebTabView 用 `allow-scripts allow-same-origin allow-forms allow-popups allow-modals`。**没有 CSP 收紧**,Markdown 走 React 组件渲染而非隔离文档。
- ❌ 无 `<webview>`(明确弃用,注释在 `WebTabView.tsx:195-208`)。
- 桥接只对**自有渲染层**开放:`window.electronAPI`(约 80 个 key)。

**可借鉴(即使不做第三方扩展)**:

1. **给产物预览加 CSP 收紧**。现在 HTML 产物 iframe 是 `allow-scripts` 且无 CSP,产出的 HTML 里若有恶意脚本能发 fetch 外传数据。抄 `connect-src 'none'` 这一条即可显著收窄暴露面——**成本极低,收益直接**。
2. **那两个 preload 注释里的坑,如果将来用 `<webview>` 一定会踩**。提前记档。

---

### 2.6 【层⑤】Prompt 体系(补充上篇)

上篇讲了插件侧的片段机制(19 个 tpl 中的 3 个)。本篇发现另一套 **16 个扁平 tpl**,在 `resources/templates/`:

```
workbuddy-{mode}-{form}-prompt.tpl 的矩阵:
  mode ∈ { (空) , ask , craft , expert }
  form ∈ { (空) , code , coding , design }
  另有 quick(极简 525 B)

体量分层:quick 525B → ask ~9-11KB(片段+只读强约束)→ craft/expert ~25-32KB(完整系统提示整体覆盖)
```

辅助模板:

- `system-reminder.tpl`(37 B):`<system_reminder></system_reminder>` 空壳包裹
- `ask-mode-reminder.tpl` / `craft-mode-reminder.tpl`:模式切换提示
- `user-context-identity.tpl`:注入 `<identity_context>` + `<product_identity>` + `<tone_and_style>` + `<user_custom_instructions>`,变量含 `{{ SoulPath/SoulContent }}`、`{{ IdentityPath/IdentityContent }}`、`{{ UserPath/UserContent }}`、`{{ BootstrapPath/BootstrapContent }}`、`{{ WorkspaceIdentityMode }}`
- `user-context-expert-identity.tpl`:专家版精简(去掉 SOUL/tone/custom)
- `style/` 下有 **7 种语气档**:creative / efficient / friendly / professional / sarcastic / socratic / straightforward

**与插件侧 3 个 tpl 的关系**:`templates/` 是**预展开的扁平产物**,`welcomemode/*/prompt.tpl` 是**可组合的编排源**;内容有重复(同源不同打包形态)。

**本项目对比**:

- ✅ 引擎侧 Jinja2 `templates/agent/*.md` + `OVERRIDABLE_TEMPLATES` 白名单(工作区可覆盖 5 个:`identity.md` / `tool_contract.md` / `skills_section.md` / `platform_policy.md` / `subagent_system.md`),坏覆盖 fail-open 回退。
- ✅ 渲染层 `assemblePromptSections()` 固定 11 段 + `promptCatalog.ts` 槽位(模式×领域×风格)。
- ✅ 工作区身份四件套 `SOUL.md / IDENTITY.md / USER.md / BOOTSTRAP.md` **完整落地**(`src/lib/identity.ts` + `PersonaPage.tsx`),比 WorkBuddy 展示得更完整。
- ⚠️ 但**风格/语气档没有落成文件**:WorkBuddy 的 `style/*.md` 是 7 个 md 文件,本项目 `promptCatalog` 是渲染层常量。

**可借鉴**:把语气档抽成**用户可编辑的 md 文件**(项目已有 `~/.nanowork/prompts/` 的外置覆盖机制,`promptLibrary.ts` 现在只覆盖 `agent/identity` 等 kind)——**这是低成本高感知的功能**。

---

### 2.7 【层⑤】交付工程:随包运行时 / 多形态 / 自检 / 性能报告

#### 1. 随包运行时(本项目最大缺口之一)

WorkBuddy `resources/vendor/`:

- `PortableGit/`(含 `bash.exe`、`git.exe`、`mingw64/`、`etc/ssh/`)
- `python/`(CPython 3.13 完整发行:python.exe + python313.dll + DLLs/ + Lib/ + Scripts/)
- `node.zip`(37.5 MB,按需解压)
- `genie-trash/`

意义:**agent 拿到一台干净机器就能跑,不需要用户预装任何东西**。

**本项目**:❌ **零随包运行时**。引擎靠 `fallbackLaunchConfig()` 依次找:

1. `NANOBOT_BIN` 环境变量 → 2. `userData\nanowork.nanobot.json` → 3. 项目本地 `nanobot\.venv\Scripts\python.exe` → 4. `PATH` 上的 `nanobot`

`electron/builder.config.json` 的 `files` 只含 `dist/**` + `main.cjs` + `preload.cjs` + `assets/**`,**不含任何 Python 运行时**。用户必须自己建 venv + `pip install`(`docs/engine-dev-setup.md`)。

**可借鉴**:不必一步到位打 CPython(体积代价大)。**先做「运行时自检 + 一键引导」**——启动时检测引擎可用性,不可用则给出可复制的安装命令 + 一键执行。成本低得多。

#### 2. 多发行形态(一套代码)

`cli/product.json`(58 模型 / 20 agent / 62 工具,主基线)+ **4 个 override 补丁**:

| 文件                         | endpoint       | models | agents | 特征                                                                                                                      |
| -------------------------- | -------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `product.json`             | ✅ workbuddy.cn | 58     | 20     | SaaS 官方完整基线                                                                                                             |
| `product.internal.json`    | ✅              | 55     | 19     | 内部版;含 `A2AOutbound`/`EnterpriseCustomModelPolicy`                                                                       |
| `product.ioa.json`         | ✅              | **98** | 19     | 腾讯内网;模型最多;额外 `RemoteControl`/`EnterpriseConsole`;`disabledBuiltinSkills=[buddy-image-processing, workbuddy-smartsheet]` |
| `product.selfhosted.json`  | ❌ **无**        | 1      | 17     | 私有化;单模型 `codewise-chat`;大量 `Disable*`(登录法务链接/帮助反馈/语音输入/签到/积分入口)                                                         |
| `product.cloudhosted.json` | ❌              | 22     | 17     | 云托管;`ImageGen`/`Connector`/`SkillManage`                                                                                |

机制:`patch` 脚本把 `product.*.json` 打成补丁覆盖基线;环境变量 `ACC_PRODUCT_CONFIG_PATH` / `productConfigEnv` 决定加载哪份。

**本项目**:单一 `nanowork.config.json`,无形态概念。  
**可借鉴**:如果要做私有化部署,这是现成的"**基线 + 覆盖补丁 + 环境变量选择**"模式,比维护多份完整配置好。

#### 3. 自检修复

`RepairApp.exe`(.NET 4.6.2,ProductName `WorkBuddy Repair Helper`)+ `install-manifest.json`(112 个文件的清单)。安装后被破坏时可按清单校验修复。

**本项目**:❌ 无。有 `diagnostics.ts` 导出 zip(meta/README/logs/traces),但那是**诊断**不是**修复**。

#### 4. 性能埋点与可视化报告

`resources/startup-report.html` + `conversation-report.html` —— **自包含、零依赖、离线可用**的开发者报告:

- 用法:浏览器双击打开,**把 JSONL 拖进去**即渲染(段耗时条 + 瀑布图 + 概览卡片)
- 数据源:`WorkbuddyPerfLogger` 落盘的 startup JSONL(`startup/<date>/<pid>-<time>.jsonl`)、`~/.workbuddy/logs/<date>/sdk/perf/`
- `conversation-report.html` 分析 **spawnMs / connectMs / TTFT / session-creation**
- 采集端:`native/perf-metrics`(N-API,`collect(onDone)` 在 libuv 线程池跑,遍历进程树)
- 时钟对齐逻辑镜像自生产代码(`packages/workbuddy-server/src/perf/startup-align.ts`)

**本项目**:✅ log/trace/audit 都有(`logStore.ts` / `traceStore.ts` / `audit/`),trace 形状还刻意对齐了 WorkBuddy;❌ **无启动计时、无性能埋点、无可视化报告**。`llm_usage.sqlite3` 有 ttft_ms/generation_ms 字段,但只用于用量展示。

**可借鉴**:⭐⭐⭐⭐ **性价比最高的一项**。「JSONL 落盘 + 自包含 HTML 拖拽可视化」这个模式几乎零成本(一个 html 文件 + 几处 `performance.mark`),但对"启动慢/首 token 慢"这类问题的定位能力是数量级提升。

#### 5. 冷启动快路径(`renderer/index.html`,27 KB)

三段 inline IIFE,都在 **HTML parse 期**同步执行:

1. 从 URL query 解析 `windowTheme`/`colorScheme` → 同步写 `<html data-theme>` → **消除首帧主题闪烁**
2. 解析 `?accountSnapshot=<encoded>` → 挂 `window.__initialAccount` → `main.tsx` 顶部同步 `setAccount()`,**跳过等 daemon getAccount(≈2.6s)**
3. `wbSeedToken` 校验后 `document.write` 引入 `wb-seed://seed/<token>/startup-seed.js`——**token 是安全边界**(防 sandboxed srcdoc iframe 继承 CSP 后拉 uid 元数据外发,BL-CLI-05)

外加 `#skeleton-root` 骨架屏,按真实布局(titlebar 38px / sidebar 220px / statusbar 22px)绘制,区分 settings-loading / conversation-loading。

**本项目**:有 `index.html`(1.5 KB),无骨架屏、无快路径种子、无 token 校验。  
**可借鉴**:②「账号快照种子」和 ③「token 门」思路清晰;**① 和骨架屏**是纯体验收益。

---

### 2.8 桌面集成

| 能力               | WorkBuddy                                                                         | 本项目                                          |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| 托盘               | ✅                                                                                 | ✅ `electron/tray.ts`                         |
| 全局快捷键            | ✅                                                                                 | ✅ `electron/hotkey.ts`                       |
| 开机自启 / Dock      | ✅                                                                                 | ✅                                            |
| 关闭到托盘            | ✅                                                                                 | ✅                                            |
| 系统通知             | ✅                                                                                 | ✅ `app:notify`                               |
| **深链协议**         | ✅ `deepLinkSchemes`                                                               | ❌ 无 `setAsDefaultProtocolClient`             |
| **单实例锁**         | ✅ `win32MutexName="workbuddy"`                                                    | ❌ 无 `requestSingleInstanceLock`              |
| **Windows 分享目标** | ✅ `WorkBuddyShareTarget.msix`(sparse package,`windows.shareTarget` 扩展,只转发 `.zip`) | ❌ 无                                          |
| 文件关联             | 有 AppX 附件                                                                         | ❌ `builder.config.json` 无 `fileAssociations` |
| **自动更新**         | ✅ NSIS 静默更新 + `update-progress.ps1` 进度窗 + `launch-update-progress.vbs` 防闪窗        | ❌ 无 `autoUpdater`                            |
| 应用菜单             | 自建                                                                                | 置空 `Menu.setApplicationMenu(null)`           |

**单实例锁**是这里面最该补的——**成本 3 行代码**,但缺了会导致双击图标开两个实例、两个引擎进程抢端口。它现在的兜底是 `gatewayPort.ts` 的端口探测,不如锁直接。

**`update-progress.ps1` 的一个细节值得记档**:注释里写 `-TimeoutSeconds` **不能在安装器仍运行时关窗**——否则用户以为更新完成,而 NSIS 仍在覆写 `app.asar`(issue #135544)。这类"看似可以优化、实际会出事故"的边界,人家写在注释里了。

---

## 三、可借鉴清单(分级)

### ⭐⭐⭐⭐ 强推(高价值 / 成本低 / 架构契合)

| #      | 项                           | 落点                                                                                                                           | 成本                 | 收益                                        |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------- |
| **B1** | **启动/会话性能埋点 + 自包含 HTML 报告** | 新增 `electron/perfStore.ts` + `resources/perf-report.html`;在 `main.ts` 的 `whenReady→窗口可见`、`gateway spawn→ready`、首 token 处打点   | 低(1 个 html + 若干埋点) | 定位"启动慢/TTFT 高"从靠猜变成看图                     |
| **B2** | **单实例锁 + 深链协议**             | `main.ts` 加 `requestSingleInstanceLock()` + `second-instance` 处理;`builder.config.json` 加 `protocols`                         | 极低                 | 消除双实例抢端口;为"从浏览器/终端唤起"铺路                   |
| **B3** | **产物预览 CSP 收紧**             | `ArtifactRenderer.tsx` / `WebTabView.tsx` 的 iframe 加 `csp` 属性,至少含 `connect-src 'none'`                                       | 极低                 | 堵住产物 HTML 外传数据的通道                         |
| **B4** | **主进程删除统一走回收站**             | 新增 `electron/safeDelete.ts` 封装 `shell.trashItem` + 失败**不降级**;替换 `eventStore.ts` / `pluginPackage.ts` / `main.ts` 里的裸 `fs.rm` | 低                  | 与引擎侧 `trash.py` 的 fail-closed 对齐,补上客户端这半边 |

### ⭐⭐⭐ 推荐(价值明确 / 需设计)

| #      | 项                                        | 落点                                                             | 说明                                                                                 |
| ------ | ---------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **B5** | **Windows Job Object 进程树管控**             | `git` 侧或 NAPI 模块;挂到 `nanobotProcess` 与所有子进程                    | `taskkill /T` 是事后补救,Job Object 是内核兜底。同时解决"引擎崩了留孤儿进程占端口"                            |
| **B6** | **路径级 glob 权限规则文件**                      | 引擎 `security/` 新增规则加载器;`SecuritySection.tsx` 加编辑器              | 抄 `{path, action: "read=deny\|write=deny\|delete=deny"}` 的**复合动作**设计。现在凭据名单硬编码且不可改 |
| **B7** | **语气/风格档落成用户可编辑 md**                     | `~/.nanowork/prompts/style/*.md`,复用 `promptLibrary.ts` 的外置覆盖机制 | 项目已有覆盖骨架,只差把 `promptCatalog` 的常量搬成文件                                               |
| **B8** | **引擎运行时自检 + 一键引导**                       | `main.ts` 的 `fallbackLaunchConfig()` 增加"全失败"分支 → UI 引导         | 不打包 CPython,先把"装不上/找不到引擎"从黑盒变成可操作                                                  |
| **B9** | **扩展 = fork 独立进程 + preload 注入 activate** | 新增 `electron/extensionHost.ts`;`extension.json` 最小 schema      | PRD 已规划四级扩展生态但零实现;**抄进程隔离,不抄 Module Federation**                                   |

### ⭐⭐ 可选(看产品需求)

| #   | 项                                                | 说明                            |
| --- | ------------------------------------------------ | ----------------------------- |
| B10 | PTY 终端(`node-pty` + `@xterm/headless`)           | 只在要做"可交互终端"时才需要               |
| B11 | 内嵌 ripgrep(NAPI 形态)                              | 搜索频繁时有收益,否则免起进程的优势不明显         |
| B12 | 多发行形态(product 基线 + override 补丁)                  | 要做私有化/云托管时再上                  |
| B13 | 账号快照种子 + 骨架屏                                     | 纯体验,取决于当前首屏耗时是否已达标            |
| B14 | Guest 桥接 SDK(postMessage + MessagePort + invoke) | 只在要做"第三方 UI 扩展 / MCP App"时才需要 |
| B15 | IM 幂等发送日志(`client_v2_send` schema)               | 只在 IM 渠道要做到"不重发不丢"时           |

### ❌ 不适用

设备指纹(Qimei)、风控(TuringShield)、内核驱动(QmProtector)、UAC 提权、微信 `WM_COPYDATA` 解码、企微原生 SDK、企业 IM C SDK、Windows 分享目标 msix、NSIS 静默更新链、Module Federation UI 联邦、`elevate.exe`。

> WorkBuddy 有一半能力是**为腾讯生态和企业分发服务的**,这部分与"本地优先的个人 agent 客户端"无关,照抄只会引入无谓的复杂度。



---

## 四、抄「怎么做」比抄「做什么」更值

拆完之后,我认为 WorkBuddy 最值得学的是三个**工程习惯**,它们不依赖任何腾讯基础设施:

### 4.1 fail-closed 必须写在每一层,而且注释要说明白失败场景

`high-credit-gate.cjs`:

> 上游在 hook 抛错时会 fall-through 到常规权限检查,bypass 下等于**静默放行、零审批扣费** —— 宁可多弹一次窗,不能漏弹。  
> 边界(如实记录):单个插件清单在运行期损坏时,该插件的工具会放行 —— hook 无从知道它原本声明了什么。该场景的防线在构建期校验与打包完整性,**不在本脚本**。

`genie-trash`:失败 → `throw 'genie-trash failed; refusing fallback delete'`,**拒绝降级硬删除**。

本项目已有这个基因(`trash.py` 的 `TrashUnavailableError`、`tool_approval` 的超时 deny、`session_mode` 未知值报错而非回落),**但缺"如实记录边界"那半句**——知道自己哪里漏、并且写下来。

### 4.2 注释即设计文档:写「为什么 + 曾经的 bug + 改动前必读」

`mcp-app-preload.js` 用 30 行讲清一个"为什么不能 monkey-patch `window.postMessage`"的深坑。本项目记忆里也有大量这类记录(`.tsx` 逗号运算符 TS1109、`printf '%s\n'` 字面量、`**kwargs` 撞形参),**但散在 memory 与 commit 里,没有落到代码旁**。

建议:凡"非直觉的写法 + 曾踩过的坑",在代码处留段注释,而不是只写在 memory 日誌。

### 4.3 运行期无法自证的事实,明确交给构建期并在注释里点名

> 该场景的防线在**构建期校验与打包完整性**(清单是 asarUnpack 的只读分发件),不在本脚本。

本项目其实已经在做(`electron.vite.config.ts` 的构建期校验、`tests/test_log_placeholder_contract.py` 的 AST 全仓扫描),**但习惯没成型**:大多数"运行期防不住"的点,当前是"不写",而不是"写清楚为什么不写"。

---

## 五、建议的落地顺序

如果只做三件,按此序:

1. **B2 单实例锁 + B4 主进程删除走回收站**(都是一天内的量,一个防事故、一个堵数据丢失)
2. **B1 性能埋点 + HTML 报告**(一次投入,长期受益于"启动慢/TTFT 高"的可诊断性)
3. **B5 Job Object + B6 路径规则文件**(把 Windows 上的安全从"应用层单点"补成"纵深")

B3(预览 CSP)顺手做。B7/B8 视体验诉求。B9(扩展运行时)是唯一需要**先出设计文档**的,建议单独走 ADR。

---

## 附:能力面对照总表

| 能力面          | WorkBuddy              | 本项目                   | 差距        |
| ------------ | ---------------------- | --------------------- | --------- |
| 插件(agent 侧)  | ✅ 6 装载器                | ⚠️ 2 装载器              | 上篇已评      |
| 扩展(应用侧)      | ✅ 8 个 fork + MF        | ❌ 零                   | **结构性**   |
| Guest 桥接 SDK | ✅                      | ❌                     | 结构性       |
| OS 级沙箱       | ✅ tsbx(Win)            | ⚠️ 仅 Linux bwrap(默认关) | **大**     |
| 进程树管控        | ✅ Job Object           | ⚠️ taskkill           | 中         |
| 路径权限规则       | ✅ glob `{path,action}` | ❌ 硬编码                 | **大**     |
| 危险删除(用户文件)   | ✅ 三层 shim              | ✅ 引擎侧完整               | 持平(引擎侧更细) |
| 危险删除(应用数据)   | ✅ safe-delete 链        | ❌ 裸 fs.rm             | 中         |
| PTY 终端       | ✅                      | ❌                     | 中         |
| 工具审批         | ✅ hook                 | ✅ 完整                  | 持平        |
| 执行/访问模式      | ✅                      | ✅                     | 持平        |
| 工作区身份        | ✅                      | ✅ 更完整                 | 领先        |
| 产物体系         | ✅                      | ✅ 完整                  | 持平        |
| 产物预览沙箱       | ✅ CSP 收紧 guest 页       | ⚠️ srcDoc 无 CSP       | 中         |
| Prompt 体系    | ✅ 双形态 + 片段库            | ✅ 双轨                  | 持平        |
| 性能埋点报告       | ✅ 2 个 HTML             | ❌                     | 中         |
| 多发行形态        | ✅ 基线+4 补丁              | ❌                     | 按需        |
| 随包运行时        | ✅ git/python/node      | ❌ 零                   | **大**     |
| 自检修复         | ✅ RepairApp            | ❌                     | 按需        |
| 单实例/深链/自关联   | ✅                      | ❌                     | 小         |
| 自动更新         | ✅                      | ❌                     | 按需        |
| 托盘/快捷键/通知    | ✅                      | ✅                     | 持平        |
