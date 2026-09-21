# 配置项盘点与「可外置」候选清单

> 状态：**现行**（对齐 2026-09-19 的代码事实）
> 目的：回答两个问题——① nanoWork 的配置现在**存在哪、谁能改**；② 有哪些今天写死在代码里、
> 但值得抽成配置项的东西。
> 参照物：WorkBuddy 的设置窗口（左侧 `通用 / 个人主页 / 套餐与积分 / 外观 / 快捷键`、
> `功能：个性化 / 记忆与进化 / 智能体 / 模型 / 助理设置`、`数据与安全：数据管理 / 应用管理 /
> 安全中心`、`关于`）。
>
> 代码落点：`src/types/settings.ts`（类型）、`src/stores/settingsStore.ts`（默认值 + 迁移）、
> `src/lib/constants.ts`（`STORAGE_KEYS` / 路由 / 常量）、`electron/storageRoutes.ts`（key → 文件路由）、
> `src/components/settings/`（设置弹窗 UI）。

---

## 一、配置的四层物理落点

改任何一项配置之前必须先确认它落在哪一层，否则会出现「设置页改了但引擎没变」或反过来。

| # | 落点 | 承载什么 | 谁写 | 特征 |
|---|---|---|---|---|
| ① | `~/.nanowork/`（用户资产） | `settings.json`、`MEMORY.md`、`memory/<ws>.md`、`SOUL/IDENTITY/USER.md`、`prompts/`、`plugins/` | 渲染层 store → 主进程按 key 路由成文件 | **可备份、可手工编辑**；「清空数据」不带走 |
| ② | `<userData>/`（运行时） | 会话事件流 `projects/<slug>/<id>.jsonl`、索引、文件备份、回收站 | 主进程 | 数据而非配置 |
| ③ | 引擎配置目录 | `nanowork.config.json`（网关 bin / host / port）、`config.json`（channels / mcpServers / skills 覆盖 / 定时任务） | 客户端同步写入 + 用户可直接改 | **引擎是权威**，客户端只推片段 |
| ④ | 进程内 / 运行期 | `sessionUiStore`（产物面板、搜索）、`settingsUiStore`（设置弹窗开关与分区） | 渲染层 | 刷新即丢，刻意不持久化 |

`electron/storageRoutes.ts` 是 ① 的**唯一路由表**：一个 storage key 对应一个文件，
新增持久化字段前先读该表与 `STORAGE_KEYS.plugins` 上方那条不变量注释。

---

## 二、现有配置项全量清单

### 2.1 `settings.json`（`STORAGE_KEYS.settings`，zustand persist，version 10）

| 键 | 类型 | 默认值 | 界面位置 | 备注 |
|---|---|---|---|---|
| `gatewayEndpoint` | string | `http://127.0.0.1:18900/v1` | 连接与模型 | 变更后重探连接 + 重拉模型目录；**本机地址会被主进程的实际端口自动对齐**（端口可能顺延，见 `nanobot:gatewayInfo`） |
| `apiToken` | string | `''` | 连接与模型 | 走密码输入框 |
| `theme` | `light/dark/system` | `system` | 通用 · 外观 | 读取侧经 `normalizeTheme` 兜底 |
| `memoryEnabled` | boolean | `true` | 记忆 | 是否把记忆块注入 system |
| `autoSummarize` | boolean | `true` | 记忆 | v9 迁移把旧 `false` 统一抬成 `true` |
| `transcription` | object | 见 `DEFAULT_TRANSCRIPTION` | 连接与模型 · 语音输入 | 嵌套对象，迁移时需单独补齐内层默认值 |
| `desktop` | object | 见 `DEFAULT_DESKTOP` | 通用 · 桌面端（仅 Electron） | 与主进程 `DEFAULT_DESKTOP_CONFIG` 必须对齐；`hotkey` 的界面在**快捷键**分区 |
| `promptDomain` / `promptStyle` | string? | 未设 → 回退内置 | 人格（正文在 `prompts/`） | Agent 级可覆盖 |
| `userCustomPrompt` | string? | 未设 | 人格 | 每轮注入，边打字边生效故走草稿 |
| `workspaceAliases` | `Record<string,string>` | `{}` | 侧边栏分组重命名 | 只存别名，绝不回写 `workdir` |
| `sidebarCollapsed` | boolean | `false` | 标题栏图标 / 快捷键 `Ctrl+B` | 属布局偏好 |
| `hiddenSessions` | `string[]` | `[]` | 会话行「从列表中移除」 | 只隐藏不删数据 |
| `shortcuts` | `Partial<Record<ShortcutId,string>>` | `{}` | 快捷键 | **只存与默认不同的项**；表里没有 = 用默认，`''` = 显式禁用（两者语义不同，见下） |
| `enabledPlugins` | `string[]?` | 未设 → 空表 | 插件 | **是「意图」不是「事实」**，激活状态权威在引擎 |

迁移规则集中在 `settingsStore.migrate`（v1→v10）。**每一次加字段都要在迁移里补默认值**，
嵌套对象必须单独深补一层——浅合并拿不到内层默认值，这是已经踩过两次的坑（transcription / desktop）。

`shortcuts` 的三态语义值得单独记一笔：

| 表内取值 | 含义 | 为什么不能合并 |
|---|---|---|
| **键不存在** | 用默认键位 | 若用「不存在」表示禁用，就再也无法表达「这条命令我还没动过」——日后调整默认键位将无法惠及老用户 |
| `''` | 用户显式清除 = 禁用该快捷键 | 这是用户的主动决定，必须与「没设置过」区分开 |
| 自定义键位串 | 覆盖默认 | 写入与默认**相同**的值会被 `setShortcut` 归一化成删除表项，避免表里留下一条挡住未来默认值的记录 |

键位串的格式、默认值、匹配规则全部收口在 `src/lib/shortcuts.ts`（注册表 + 纯函数），
界面与派发器都只读它——见 `docs/architecture-shortcuts.md`。

### 2.2 其它持久化 key（**不是** `settings.json`）

| Key | 内容 | 说明 |
|---|---|---|
| `nanowork.ui.activeSession` | 上次打开的会话 id | 纯 UI 光标，与业务数据解耦 |
| `nanowork.agents` / `expertGroups` / `skills` / `mcp` / `tasks` / `artifacts` / `channels` | 各域数据 | 属数据不属配置 |
| `nanowork.userMemory` / `nanowork.memory.<ws>` | L2 / L3 记忆正文 | 路由到 markdown 文件 |
| `nanowork.identity.{soul,identity,user,bootstrap}` | 身份文件 | 文件名即 `SOUL/IDENTITY/USER/BOOTSTRAP.md` |
| `nanowork.prompt.<kind>.<key>` | 提示词槽位覆盖 | `prompts/<kind>/<key>.md` |

---

## 三、设置界面的分类映射（对齐 WorkBuddy）

设置从「整页路由」改为**弹窗**（左菜单 + 右内容），分类按下表落地：

| 弹窗分区 | 承载 | WorkBuddy 对应项 |
|---|---|---|
| 通用 | 外观主题、桌面端（托盘常驻 / 开机自启 / Dock） | 通用（开机自启、权限、通知）+ 外观 |
| 快捷键 | 命令键位列表（改键 / 恢复默认 / 全部恢复默认 + 搜索）、全局唤起快捷键 | 快捷键 + 通用 · 全局唤起快捷键 |
| 连接与模型 | 网关 endpoint/token、语音输入（STT） | 模型 + 通用 · 网络代理 |
| 记忆 | 注入开关、自动沉淀 + 记忆正文编辑 | 记忆与进化 |
| 人格 | 身份文件 + 提示词模板 | 个性化 |
| 助理设置 | IM 频道（钉钉/飞书/Lark/微信/企业微信） | 助理设置 |
| 插件 | 插件包安装/卸载/启停与引擎激活状态 | （WorkBuddy 无对应项，本项目特有） |
| 数据管理 | 数据落点说明 + 清空本地数据 | 数据管理 |
| 关于 | 版本、运行环境、复制环境信息 | 关于 |

**入口收敛**：原侧边栏一级入口「插件 / 记忆 / 人格 / 助理」已移入本弹窗；
`ROUTES` 中对应的四条页面路由随之删除，仅保留 `/settings`，其语义改为
「打开弹窗 + 重定向」（见 `src/pages/settings/SettingsRoute.tsx`）。

**「全局唤起快捷键」的位置**：它原先挂在「通用 · 桌面端」卡片里，现随「快捷键」分区一起
迁出（那一行删掉了，不是复制一份）。界面在快捷键列表的「唤起/隐藏主窗口」一行，
但**取值不在 `settings.shortcuts`**，而在 `desktop.hotkey`（Electron accelerator）——
它是主进程 `globalShortcut` 注册的系统级热键，主进程冷启动时就要读它，
不可能等渲染层把覆盖表合并完再注册。两套语义（应用内 keydown / 系统级 accelerator）
对应两个录入器：前者是键盘捕获，后者复用 `components/HotkeyInput.tsx`。

**刻意不做成路由的项**：弹窗内分区（`settingsUiStore.section`）不进 URL。
它表达的是「弹窗翻到第几页」，不是「用户在哪」；进 URL 会让关弹窗变成路由回退，与侧边栏高亮打架。

---

## 四、可抽离为配置项的候选

筛选口径：**今天写死在代码里、且不同用户/环境会想要不同取值**的东西。按落地成本排序。

### P0 —— 环境强相关，改起来收益立刻可见

| # | 候选 | 现状（硬编码点） | 建议落点 | 理由 |
|---|---|---|---|---|
| 1 | **引擎端口族**：serve `18900`（首选，可自动顺延）/ gateway health `18790` / 频道 WS `9900` | `src/lib/constants.ts` `DEFAULT_GATEWAY_PORT`；`electron/main.ts` 同名镜像常量（serve 端口、`isPortInUse(18790)`、WS 9900）多处字面量 | ③ 引擎配置目录 + 「连接与模型 · 高级」 | 端口冲突是本地部署最常见的故障，现在只能改代码重打包。⚠️ 2026-09-21 已加**主进程自动顺延 + 地址协商**（`resolveGatewayPort` + `nanobot:gatewayInfo`）：首选端口被占用或落在 Windows 保留区间（`winerror 10013`）时会自动换端口并同步界面地址 |
| 2 | **网络代理**（直连 / 系统代理 / 手动） | 无（Electron 用默认会话网络栈） | ④ → 主进程 `session.setProxy` | WorkBuddy「通用 · 网络代理」直接对应；企业网下是刚需 |
| 3 | **客户端通知开关 + 提示音** | `src/platform/notification.ts` 只暴露 `notify()`，无开关 | ① `settings.json` | 现状无法静音；WorkBuddy 有「客户端通知 / 通知提示音」两项 |
| 4 | **新任务默认权限策略**（完全访问 / 逐条批准） | 新会话靠**继承当前会话**，无全局默认 | ① `settings.json` | 「每次新建都要重设一遍」是当前明确的操作负担 |

### P1 —— 体验类，成本低但要做就做完整

| # | 候选 | 现状 | 建议落点 | 理由 |
|---|---|---|---|---|
| 5 | **界面语言** | 文案全量硬编码中文 | ① 新 `i18n` 命名空间 | WorkBuddy「通用 · 语言」；现阶段只需接一个 `zh-CN` 字典并留出 `en` 结构 |
| 6 | **字体大小 / 界面密度** | 基准 `fontSize: 14` 写死在 `muiTheme` | ① + 主题工厂接参 | WorkBuddy「通用 · 字体大小」；对长文阅读场景影响明显 |
| 7 | **侧边栏宽度 / 会话列表密度** | `SidebarNav` 内 `width: 240` 字面量 | ① `settings.json` | 与 6 同属「布局偏好」，一起做才有意义 |
| 8 | **大附件处理阈值** | `src/lib/attachments.ts` `PERSIST_DATAURL_LIMIT = 512 * 1024` | ① `settings.json` | 阈值决定「内联持久化」还是「只留路径」，与用户机器性能相关 |
| 9 | **编辑器撤销栈深度** | `src/lib/undoStack.ts` `limit = 50` | ① `settings.json`（或保持常量） | 影响内存占用与「回退够不够久」的体感 |

### P2 —— 建议随功能实现一并外置（现在没有对应功能，不要先造开关）

| # | 候选 | 说明 |
|---|---|---|
| 10 | **技能 / 插件自动更新**、**自动安装可信技能** | WorkBuddy 三项开关（自动更新技能、套件自动更新、自动安装可信技能）。本项目插件与技能目前**无更新链路**，开关先做出来只会是空开关——按「不造空心配置」原则等实现落地再加 |
| 11 | **锁屏 / 熄屏运行策略** | WorkBuddy「允许锁屏运行：熄屏后保持唤醒」。Electron 侧需 `powerSaveBlocker`，当前**无此能力** |
| 12 | **默认工作空间路径** | WorkBuddy「默认工作空间存储路径」。本项目工作空间由会话 `workdir` 决定，改默认路径要动 `createSession` 的语义，属功能改动 |
| 13 | **使用数据 / 遥测开关** | 本地已有 `llm_usage.sqlite3` 用量库；在「是否上报」成为真实分支前不必加开关 |
| 14 | **自动化执行参数**（默认时区、单次执行超时、运行历史保留条数） | 当前由引擎 `jobs.json` 与 `cronRunsPoller` 隐式决定；要外置需先定义语义与清理策略 |

### 明确**不建议**外置

| 项 | 原因 |
|---|---|
| 提示词模板正文（`prompts/`） | 已有外置机制与专门的「人格」分区做结构化编辑；再放进设置页的通用输入框只会让人误改注入正文 |
| 工作空间别名 | 就近操作（在分组头上重命名）比在设置里维护一张路径表直观得多 |
| `hiddenSessions` | 纯 UI 状态，用户的心智模型是「在这个列表里移除」，不是「去设置里配」 |
| 记忆正文 | 同上：内容编辑属于「记忆」分区，不属于「配置」 |
| `enabledPlugins` 的激活状态 | 权威在引擎（指纹绑定），客户端落盘只会制造第二份可能过期的真相 |

---

## 五、与 WorkBuddy 的取舍差异（有意为之）

| WorkBuddy 项 | 本项目 | 差异原因 |
|---|---|---|
| 个人主页 / 套餐与积分 | 无 | 未接入云端账户体系 |
| 安全中心 / 应用管理 | 无独立分区 | 权限门控在引擎侧（ADR-021），客户端无对应管理面 |
| 系统缓存目录「打开目录」 | 只展示落点文字 | 需主进程新增「解析并打开用户资产目录」的 IPC；当前不引这条链 |
| 体验优化计划（数据帮助改进模型） | 无 | 无上报链路，开关无意义 |

---

## 六、维护约定

1. **新增配置项必须同时改三处**：`src/types/settings.ts`（类型）、`settingsStore` 的
   `DEFAULT_SETTINGS` **与** `migrate`（老用户补齐）、设置弹窗对应分区。只改前两处会得到
   「新用户能配、老用户页面崩」。
2. **一项配置只有一个写入方**。同一语义两处可改（如桌面端配置渲染层与主进程都能写）必须
   明确「谁是期望值、谁是生效值」，并在代码里写清回读方向——`GeneralSection` 的 `DesktopCard`
   是既有范式。
3. **不造空心开关**：没有对应能力的配置项不进设置页（见 P2 表）。
4. 引擎侧配置（`config.json`）一律由客户端**推片段**、引擎**合并落盘**，客户端不整体覆盖。
