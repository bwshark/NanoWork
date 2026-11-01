# WorkBuddy 插件体系 & 专家包实现分析（含 nanowork 落地）

> 调查对象：`D:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources`
> 调查时间：2026-11-01
> 关联文档：`docs/analysis-workbuddy-builtin-plugins.md`（2026-10-15，只覆盖 `plugins/workbuddy-builtin`）
> 关联文档：`docs/analysis-workbuddy-host-assets.md`（同一 `resources/` 目录下的**其余**资产全量对照：
> prompt 模板、extension 扩展体系、DevTools 面板、preload 桥、原生 SDK）

---

## 〇、TL;DR

三句话：

1. **`resources/` 是"宿主资产区"**，`plugins/` 只是其中一类；同一个目录里还躺着 **prompt 模板**（`templates/*.tpl`）、**内置扩展**（`extensions/`）、**preload 脚本**、**内置专家推荐位**（`builtin-expert-recommendations/curated-experts.json`）。换句话说：**WorkBuddy 的"能力"几乎全部来自磁盘上的数据文件，而不是编译进应用的代码**。
2. **插件的实现方案是"一份清单 + 七个读者"**。`plugin.json` 声明 `skills / agents / commands / hooks / mcp / prompts`，host 侧各有一个装载器把它挂到同一套虚拟命名空间里（`<plugin-name>/<包内相对路径>`）。
3. **"专家"在 WorkBuddy 里就是一个插件包**。它的产出流程被固化成一个技能包 `skills/expert-manager`（SKILL.md + references/ + scripts/），跑完 `init → validate → register` 之后，专家就出现在"我的专家"里 —— 因为**它本来就是 `~/.workbuddy/plugins/marketplaces/my-experts/plugins/<name>/` 下的一个插件包**。

本次在 nanowork 里补的两条链路（第 5 节）：

- **插件包 → 我的专家**：插件扫描时把包内 `agents/*.md` 解析成可预览的专家，插件页一键导入（此前这些文件只被数了个数）。
- **对话 → 我的专家**：AI 按内置技能 `expert-builder` 的输出规约产出"专家蓝图"，消息里渲染成卡片，点一下落库（这就是"自动创建"的闭环）。

---

## 一、`resources/` 目录结构

```
resources/
├── plugins/                     ← 插件市场（唯一入口，见第 2 节）
│   └── workbuddy-builtin/
│       ├── .codebuddy-plugin/marketplace.json   ← 市场索引（唯一总清单）
│       ├── builtin-plugins/<name>/              ← 能力插件（docx / pptx / sheetagent / 文档 / 支付…）
│       ├── skills/<name>/                       ← 独立技能插件（22 个，expert-manager 在这里）
│       ├── interactionmode/{ask,plan,craft,expert,quick}/
│       ├── welcomemode/{code,work,design}/      ← 首屏根 agent
│       ├── prompt-common/fragments/             ← 跨插件共享的 prompt 片段
│       ├── mcps/{miora-mcp,agently-cli}/        ← MCP app 插件
│       └── hooks/high-credit-gate.cjs           ← 全局钩子
├── templates/*.tpl              ← 系统提示词模板（ask/craft/plan 模式提醒、身份上下文…）
├── extensions/                  ← 宿主扩展（cloud-assistant / im-channels / library / edge-sync…）
├── builtin-expert-recommendations/curated-experts.json  ← 专家中心的"精选"位
├── channel-branding/            ← 渠道 OEM 资源
├── devtools-terminal/           ← 开发者面板（ghostty wasm 终端）
└── *-preload.js                 ← 各类 WebView 的桥接脚本
```

**两处值得注意的分工**：

- `templates/` 与 `plugins/*/prompt-*` 是**两套不同的 prompt 来源**：前者是宿主硬编码的"模式/身份"骨架，后者是可被插件替换的片段。nanowork 早期分析里说的"prompt 双轨"在 WorkBuddy 那边是三轨（宿主模板 + 插件片段 + 交互模式），这恰恰是**不该照搬**的地方。
- `builtin-expert-recommendations/` 说明"专家推荐"是**数据文件**，不是界面里写死的数组。这一点值得抄（换推荐位不用发版）。

---

## 二、插件实现方案

### 2.1 三层清单

| 层级 | 文件 | 作用 |
|---|---|---|
| 市场级 | `<market>/.codebuddy-plugin/marketplace.json` | 有哪些插件、`source` 相对路径、`category`、`dependencies`、统一 `version` |
| 包级 | `<plugin>/.codebuddy-plugin/plugin.json`（或 `.workbuddy-plugin/`） | 这个包提供什么（`skills` / `agents` / `commands` / `hooks` / `mcpServers` / `prompts`） |
| 组件级 | 包内的 `SKILL.md` / `agents/*.md` / `commands/*.md` | 各自 frontmatter 声明元数据（`name` / `description` / `displayName` …） |

> 前缀双写（`.codebuddy-plugin` 与 `.workbuddy-plugin`）是**产品改名期的兼容层**，不是设计意图。nanowork 单前缀 `.nanowork-plugin` 即可，但**读取侧仍应兼容 `.codebuddy-plugin`** —— 用户的旧专家包就是那个布局（见 3.5）。

### 2.2 六类 category

`welcomeMode` / `interaction` / `template` / `skill` / `mcp-app` / `connector`。

关键在于：**`interactionmode-*`、`welcomemode-*`、`prompt-common` 本身也是插件**，host 没有为它们写任何特判。这一点决定了"插件系统"是骨架而不是功能清单。

### 2.3 插件名即命名空间

跨插件引用用 `<plugin-name>/<包内相对路径>`：

```
{% include "interactionmode-craft/fragments/tool-use.md" %}
```

好处：插件可被重排目录、可被版本化缓存、可被远程市场替换，而引用不变。nanowork 已经有版本化缓存（`cache/<market>/<name>/<version>/` + 指针），但**没有命名空间挂载**，这是引擎侧 P0 缺口（见 4.2）。

### 2.4 一份清单，七个读者

`plugin.json` 同时被这些装载器消费：`skill`、`agent`、`command`、`hook`、`mcp`、`prompt`，外加市场的依赖解析。

对 nanowork 的直接启示（2026-10-15 文档已列出，此处只记结论）：**差距不在"有没有插件系统"，而在"清单的读者只有 2 个"**（skills 走目录约定、mcpServers 走字段）。补齐时最容易漏的一步是 `_package_fingerprint` 的覆盖范围 —— 新增了可发现文件的类型却不扩指纹，症状是"改了插件的 prompt 不生效"，极难查。

---

## 三、`expert-manager`：专家包是怎么被造出来的

### 3.1 文件清单

```
skills/expert-manager/
├── SKILL.md                      ← 主规程（工作流 / 分流场景 / 铁律 / 收尾）
├── references/
│   ├── plugin-json-spec.md       ← plugin.json 全字段 + Agent/Team 两套模板
│   ├── agent-md-spec.md          ← Agent MD 的 frontmatter 与正文结构
│   ├── team-spec.md              ← 成员花名规范、4 条正则 + 5 条红线、SOP 编排
│   └── avatar-spec.md            ← 头像生成规范
└── scripts/
    ├── init_expert.py            ← 按模板生成带 [TODO] 的骨架
    ├── validate_expert.py        ← 校验（必填字段、TODO 残留、agents 目录）
    ├── register_expert.py        ← 写 marketplace.json + .created-by-session
    ├── package_expert.py         ← 打包（发给别人）
    └── batch_create.py           ← 批量：串行 init → validate → register
```

### 3.2 七步流程

```
1 收集信息（交互 / 资料转化） → 2 init_expert.py → 3 写文件 → 4 生成头像(ImageGen)
→ 5 validate_expert.py → 6 register_expert.py → 7 package_expert.py
```

三个分流场景写得很清楚：**A 交互模式**（问清 5W）、**B 资料转化模式**（从现有文档反推角色）、**C 修改已有专家**（先读全量再改，禁止改 `name` / `agentName` / 目录名 / MD 文件名 —— 那是专家的唯一标识）。

### 3.3 真正的"可落地"靠的是字段铁律

SKILL.md 里"关键展示字段对应关系"那张表是整份文档的价值核心：

| 展示位 | 字段 | 规则 |
|---|---|---|
| 名字（职业） | `profession` | 卡片标题 |
| 花名 | `displayName` | 可自由改 |
| 类型 | `expertType` | **不可随意指定**：单角色 `agent` / 多角色 `team` |
| 行业分类 | `categoryId` | 12 选 1，须说明理由 |
| 能力介绍 | `displayDescription` | 中文 40-50 字 |
| 擅长领域 | `tags` | **固定 3 个**，满了要提示替换 |
| 试试这样问我 | `quickPrompts` | **固定 3 个**，第一条 = `defaultInitPrompt` |

外加 12 条铁律：`name` kebab-case、`agentName` = MD 文件名、Team 的 `members` 含主理人（`role: lead`）但 `teamInfo.memberAgents` 不含、主理人文件名必须带团队前缀（禁止 `team-lead.md`）、MD frontmatter **禁止声明 tools 字段**……

### 3.4 脚本的职责划分（这条设计最值得学）

**"AI 只写内容，机器只做校验和登记"**：

- `init_expert.py` 产骨架（带 `[TODO]`），AI 只负责把 `[TODO]` 换成真内容；
- `validate_expert.py` 用"`[TODO]` 出现次数 ≤ 2"判"是否有真内容"——粗糙但有效，因为它拦住的正是"AI 只填了名字就交差"；
- `register_expert.py` **自己再校验一遍**，然后把条目写进 `marketplace.json`，并把 `CODEBUDDY_SESSION_ID` 写进 `.created-by-session`（决定"我的专家"里能不能看见）；
- `batch_create.py` 强制串行 `init → validate → register`，**禁止**直接改 `marketplace.json` 绕过注册。

### 3.5 落地的真相：专家就是一个插件包

本机 `~/.workbuddy/plugins/marketplaces/my-experts/` 里是这样：

```
my-experts/
├── .codebuddy-plugin/marketplace.json     ← 两条注册记录
└── plugins/
    ├── ml-python-expert/
    │   ├── .codebuddy-plugin/plugin.json  ← displayName/profession/tags/quickPrompts…
    │   ├── agents/ml-python-expert.md     ← frontmatter + 正文（= 系统提示词）
    │   ├── avatars/expert.png
    │   └── README.md
    └── cesium-gis-expert/…
```

**结论**：所谓"创建专家"= 在专家市场里造一个插件包并注册。"专家中心"只是这个市场的另一个视图。这也解释了为什么 WorkBuddy 能在对话里创建专家（expert-manager 是技能，AI 有文件写权限），而普通表单创建永远做不出"团队 + 头像 + 打包分发"。

**给 nanowork 的关键判断**：nanowork 的专家是**纯客户端实体**（`localStorage` 里的 `Agent` / `ExpertGroup`，带同步元数据、知识库绑定、工具策略），和"磁盘上的一个包"是两种存储模型。所以不照搬"AI 写文件"，而是加一层**可解析的中间格式**（专家蓝图），由界面执行落库 —— 见 5.2。

---

## 四、nanowork 对照

### 4.1 已有的（本次未动）

| 能力 | 落点 | 状态 |
|---|---|---|
| 插件包解析 / 安装 / 版本隔离 | `electron/pluginPackage.ts`、`pluginMarketplace.ts` | ✅ |
| 引擎侧清单字段 | `nanobot/agent/plugins.py`（`prompt_dirs` / `agent_files` / `command_files` / `hook_manifest` / `tool_policy`） | ✅ 已补齐 |
| 钩子生效情况上报 | `GET /v1/plugins` + `lib/agent/pluginHooks.ts` | ✅ |
| 插件页（激活 / 漂移 / 工具收窄 / 资源盘点） | `src/pages/plugins/PluginsPage.tsx` | ✅ |
| 专家包单文件导入导出（FR-3.3） | `lib/agent/expertPackage.ts` + `ExpertPackageImportDialog` | ✅ |

### 4.2 本次补的两条缺口

| 缺口 | 症状（改之前） | 本次做法 |
|---|---|---|
| **G-A 插件带来的专家无法使用** | 插件页只显示"子代理 3"这种计数；包内 `agents/*.md` 是磁盘上的死文件，用户没有任何入口把它变成能召唤的专家 | 扫描时解析成 `PluginExpertPackage`（名字 / 职业 / 提示词正文），插件卡片上「随包专家」一栏可一键导入 |
| **G-B 只能手工表单创建专家** | 用户说不清自己要什么样的专家；即使说得清，也得把生成的角色描述抄进表单 | 内置技能 `expert-builder` 规定蓝图 JSON 规约 → 消息里渲染卡片 → 点「保存」落库 |

---

## 五、本次改动（文件级）

### 5.1 插件包 → 我的专家

| 文件 | 改动 |
|---|---|
| `src/types/plugin.ts` | 新增 `PluginExpertDraft` / `PluginExpertPackage`；`InstalledPlugin.expertPackages`（必填，扫描器总会填） |
| `src/lib/agent/expertAgentMarkdown.ts`（新） | 专家 MD 的 frontmatter + 正文解析。**零 `@/` 别名依赖**，主进程与渲染层共用同一份实现 |
| `electron/pluginPackage.ts` | 新增 `readPluginExpertPackages()`：认 `experts/<dir>/` 与"包根即专家包"两种布局；清单候选含 `.codebuddy-plugin`（兼容 WorkBuddy 旧包） |
| `src/pages/plugins/PluginsPage.tsx` | 卡片新增「随包专家（可一键加入我的专家）」区块 + 导入按钮（保存后变「已导入」） |

三条设计取舍：

1. **扫描时就把内容读出来**，不新增 IPC。渲染层没有文件系统权限，若等用户点「导入」再读就得加一条通道；而扫描本来就在主进程、本来已遍历这些目录。
2. **两种布局都认**：`experts/<dir>/` 是"一个插件带多位专家"，包根 `agents/*.md` 是"这个包就是一位专家"（WorkBuddy `my-experts` 的形态）。
3. **头像不导入**：包里头像是相对路径，渲染层加载不到（`file://` 在页面上下文会被拦），而 dataURL 物化又会让每个导入的专家膨胀几十 KB。落地后按名字派生占位，与新建专家一致。

### 5.2 对话 → 我的专家（自动创建）

| 文件 | 改动 |
|---|---|
| `src/ai/builtinSkills.ts` | 新增内置技能 `expert-builder`（"专家创建"）：信息采集规则 + 蓝图 JSON 规约（单人 / 团队两套） |
| `src/lib/agent/expertBlueprint.ts`（新） | 蓝图解析（`extractExpertBlueprints`）、归一化（`normalizeExpertBlueprint`）、落库（`applyExpertBlueprint`）、插件包→蓝图转换 |
| `src/components/agents/ExpertBlueprintCard.tsx`（新） | 消息内预览卡片：成员列表 / 提示词展开 / 降级说明 / 「保存为专家（团）」 |
| `src/pages/chat/AssistantMessage.tsx` | 检测蓝图 → 正文里把代码块换成一行说明 → 渲染卡片 |
| `src/components/agents/useExpertAutoCreate.ts`（新） | 自动创建接线：新建空白会话 + 挂 `expert-builder` + 带开场白跳对话 |
| `src/components/agents/CreateExpertDialog.tsx`（新） | 创建入口的模式选择（手动 / AI 自动） |
| `src/pages/agents/AgentsPage.tsx`、`MyAgentsPage.tsx` | 创建按钮与「+」卡片统一走模式选择；「我的专家」页补页头创建按钮 |

四条不变量（都有用例钉住）：

1. **坏 JSON 不剥离原文** —— 解析失败往往正是模型写坏了 JSON，那时原文是唯一线索。
2. **技能只收本地装了的** —— 不拦就会造出"卡片显示 3 技能、实际 0 生效"的专家。
3. **落库用 `importAgent` 而不是 `createAgent`** —— 用户只是想存下来，不是现在换人设（`createAgent` 会改 `activeAgentId`）。
4. **自动创建不继承当前专家人设**（`inheritCapabilities: false`）—— 否则模型会顶着别人的身份设计专家。

### 5.3 蓝图格式

单人：

```json
{ "kind": "agent", "name": "…", "role": "…", "description": "…", "icon": "⚖️",
  "systemPrompt": "…", "skillIds": [] }
```

团队：

```json
{ "kind": "team", "name": "…", "role": "…", "description": "…", "icon": "🧩",
  "mode": "coordinator",
  "members": [{ "name": "齐活林", "role": "交付总监", "avatar": "🧭", "systemPrompt": "…" }] }
```

- 围栏语言固定 `nanowork-expert` / `nanowork-expert-team`；
- `members[0]` 即主理人（沿用 `ExpertGroup` "首位是入口/协调者"的约定）；
- `mode` 缺省 `coordinator`。

---

## 六、验证与已知边界

### 6.1 门禁（本次实测）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` / `:electron` / `:tests` | ✅ 三套 exit=0 |
| 新增单测：4 个新文件 + `pluginPackage.test.ts` 追加 5 条 = **34 用例** | ✅ 全绿（`tests/agent/**`、`tests/electron/pluginPackage.test.ts`） |
| 全量 vitest（`--maxWorkers=3 --silent`） | ✅ **307 文件 / 4408 用例全绿、exit=0** |
| `vite build` | ✅ exit=0，`MarkdownRenderer` 仍是独立懒加载 chunk（785 KB，未进首屏） |
| `node tasks/verify-b5-first-paint.mjs` | ✅ 首屏 **1.27 MB**（上限 1.5）· modulepreload 0.63 MB（上限 1.2） |
| 真机 `node tasks/verify-expert-create-modes.mjs` | ✅ 13 条全过（模式弹层 / 手动仍进原表单 / 自动落到对话页且有开场白与技能 chip / 我的专家页有入口 / 专家团同构） |
| 变异验证 | ✅ 去掉"技能白名单过滤" / 去掉 `inheritCapabilities: false` → 对应用例如实变红，还原后复绿 |
| 真实数据回归 | ✅ 用本机 `~/.workbuddy/…/my-experts/plugins/ml-python-expert` 只读跑通（展示名「机器学习专家」、职业「机器学习工程师」、正文 1104 字） |

### 6.2 已知边界

1. **自动创建依赖"专家创建"技能可用**。技能被停用时按钮会报错并要求去技能页启用，**不**静默降级成一条没有规约的会话。
2. **蓝图由模型产出，格式可能不合规**。解析侧一律"能救的救、救不了的丢弃并告警"，最坏情况是"这次没生成卡片"而不是"生成了错误实体"。
3. **插件内的团队专家一律按 `coordinator` 落地**。WorkBuddy 包里有 `teamInfo.leadAgent` 但没有"协作模式"概念，映射到本项目三种模式时选了最贴近"主理人调度"的那一种。
4. **头像不随插件导入**（见 5.1）。
5. **Web 端没有插件扫描**（`pluginsScan` 返回空），因此"随包专家"只在 Electron 下出现。
