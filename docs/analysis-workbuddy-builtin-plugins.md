# WorkBuddy 内置插件机制解剖 & nanowork 借鉴评估

> 调查对象:`D:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources\plugins\workbuddy-builtin`  
> 调查时间:2026-10-15  
> 结论:**能借鉴,而且本项目已经站在同一条主干上**——差距不在"要不要做插件体系",而在"插件清单的读者只有 2 个,WorkBuddy 有 6 个"。

---

## 〇、TL;DR

WorkBuddy 的内置插件体系可以一句话概括:

> **一切皆插件,插件是一份清单 + 一堆文本资产;清单声明"我提供什么",host 负责把声明挂载到虚拟命名空间,再由模板引擎把片段拼成系统提示词。**

它有三个设计支点:

| 支点                | 含义                                                                                       | 本项目是否有                         |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| **一份清单,多个读者**     | 同一个 `plugin.json` 同时被 skill / agent / command / hook / mcp / prompt 六个装载器消费              | ⚠️ 只有 2 个读者(skills、mcpServers) |
| **插件名即命名空间**      | `{% include "interactionmode-craft/fragments/tool-use.md" %}` —— 跨插件引用用 `<插件名>/<包内相对路径>` | ❌ 无                            |
| **prompt 可被插件提供** | 交互模式、共享片段、根 agent 全是插件;prompt 是数据不是代码                                                    | ❌ 无(模板写死在引擎与渲染层)               |

本项目**已经**复用了标准化的 `agent-plugins.org` v1 schema(`$schema` + `extensions['dev.nanobot']`),WorkBuddy 走的是私有分支(无 `$schema`,自定义 `workbuddy` 扩展键)。**两者哲学同源、字段不同**,所以借鉴成本是"扩字段 + 加装载器",不是"换架构"。

---

## 一、WorkBuddy 侧:机制解剖

### 1.1 目录布局

```
workbuddy-builtin/                          ← marketplace 根
├── .codebuddy-plugin/marketplace.json      ← 市场索引(唯一的总清单)
├── builtin-plugins/<name>/                 ← 能力插件(文档/表格/支付/日历…)
├── interactionmode/{ask,plan,craft,expert,quick}/  ← 交互模式插件(5 个)
├── welcomemode/{code,work,design}/         ← 根 agent 插件(3 个)
├── prompt-common/                          ← 共享 prompt 片段插件
├── skills/<name>/                          ← 独立技能插件(22 个)
├── mcps/{miora-mcp,agently-cli}/           ← MCP app 插件
└── hooks/high-credit-gate.cjs              ← 全局 hook(跨插件共享闸门)
```

三处关键观察:

1. **`interactionmode` / `welcomemode` / `prompt-common` 本身也是插件**——不是"特殊目录"。host 没有为它们写任何特判代码。
2. **插件的三个层级**:marketplace 索引(市场级)→ 插件清单(包级)→ 包内承诺(组件级)。
3. **清单前缀双写**:`builtin-plugins/*` 与 `skills/*` 用 `.codebuddy-plugin/`,而 `interactionmode|welcomemode|prompt-common` 用 `.workbuddy-plugin/`。host 两种都认——这是**产品改名期的兼容层**,不是设计意图。

### 1.2 marketplace.json —— 市场索引

`.codebuddy-plugin/marketplace.json`:

```jsonc
{
  "name": "workbuddy-builtin",
  "metadata": { "version": "1.0.0", "phase": "addon-context-orchestration" },
  "plugins": [
    { "name": "welcomemode-code", "source": "./welcomemode/code",
      "category": "welcomeMode", "version": "5.8.2-wb.…" },
    { "name": "welcomemode-design", "source": "./welcomemode/design",
      "category": "welcomeMode", "dependencies": ["mcp-miora", "ardot"] },
    { "name": "interactionmode-craft", "source": "./interactionmode/craft",
      "category": "interaction" }
    // …共 6 类: welcomeMode / interaction / template / skill / mcp-app / connector
  ]
}
```

要点:

- **`name` 是命名空间键**,与 `source` 目录名**不要求一致**(`welcomemode-code` ↔ `./welcomemode/code`)。后面 include 用的是 `name`。
- **`dependencies: ["mcp-miora", "ardot"]`** 是插件级依赖,按**插件名**引用,不是包名。
- `category` 是分类,`version` 是整个 marketplace 的统一构建号(`5.8.2-wb.41111488.gb8f6c953.haebd5991e0e2`),同一次发版里所有插件共用一个版本串。

### 1.3 plugin.json —— 插件的声明面

以 `workbuddy-sheetagent` 为例(字段最全):

```jsonc
{
  "name": "workbuddy-sheetagent",
  "version": "5.8.2-wb.…",
  "description": "由腾讯文档团队出品的电子表格智能助手…",
  "author": { "name": "Tencent Docs SheetAgent Team", "url": "https://docs.qq.com" },
  "keywords": ["spreadsheet", "excel", "xlsx"],
  "commands": "./commands",                    // ① 斜杠命令
  "skills": "./skills",                        // ② 技能(string | string[])
  "hooks": "./hooks/hooks.json",               // ③ 生命周期钩子
  "mcpServers": {                              // ④ 内联 MCP 声明
    "sheetagent": {
      "command": "node",
      "args": ["${CODEBUDDY_PLUGIN_ROOT}/mcp/start.mjs"],
      "env": { "SHEET_API_MODE": "local" },
      "defer_loading": true
    }
  }
}
```

其它插件的补充字段:

| 字段                                      | 出现处                                | 含义            |
| --------------------------------------- | ---------------------------------- | ------------- |
| `agents: ["./agents/doc-writer.md", …]` | workbuddy-docx                     | 子代理定义文件       |
| `defaultEnabled: true`                  | subscription-gate / wecom-a2a-auth | 默认开启          |
| `workbuddy.dependencies`                | welcomemode-code                   | 私有扩展命名空间里的依赖  |
| `workbuddy.welcomeModes: ["design"]`    | mcp-miora                          | **限定只在某模式加载** |
| `workbuddy.runtimeOwner: "agent-cli"`   | mcp-miora                          | 归属哪个运行时       |

**变量插值**:清单里可以写 `${VAR}` / `${VAR:-default}`:  
`${CODEBUDDY_PLUGIN_ROOT}`(包根)、`${CODEBUDDY_PLUGIN_DATA}`(包私有数据目录)、`${WORKBUDDY_BUILD_VERSION}`、`${CALENDAR_MCP_URL:-http://…}`。**这是让同一份清单能在不同环境落地而不分叉的关键**。

### 1.4 【核心】prompt 组合机制

这是 WorkBuddy 与传统"插件 = 加工具"最大的分野。

**第一跳** —— 根 agent 文件 `welcomemode/code/agents/code.md`:

```markdown
---
name: code
description: WorkBuddy code welcomeMode root agent.
---

{% include "welcomemode-code/prompt.tpl" %}
```

**第二跳** —— `welcomemode/code/prompt.tpl` 是一个大型 Jinja2 模板,主角是条件 include:

```jinja
This conversation is powered by {% if workMode == "quick" %}{{ productName }}
{% elif modelId == "fast-model" %}Auto{% else %}{{ modelName }}{% endif %}

{% if workMode == "ask" %}{% include "interactionmode-ask/fragments/interaction.md" %}
{% elif workMode == "plan" %}{% include "interactionmode-plan/fragments/interaction.md" %}
{% elif workMode == "expert" %}{% include "interactionmode-expert/fragments/interaction.md" %}
{% else %}{% include "interactionmode-craft/fragments/interaction.md" %}{% endif %}
…
{% if not productFeatures.DisableMultimodalGeneration %}
- **Multimodal content generation.** 用 **ImageGen** 做文生图…
{%- endif %}
{% if IsWindows %}<windows_command_safety>…</windows_command_safety>{% endif %}
{% if not IsOversea and workMode != "quick" %}<regional_conventions>…</regional_conventions>{% endif %}
```

**关键点:include 路径的第一段是插件 `name`,不是文件系统路径。**  
`interactionmode-craft/fragments/tool-use.md` 在磁盘上是 `interactionmode/craft/fragments/tool-use.md`。说明 host 在内存里建了一个 **`<plugin-name> → 包根` 的虚拟挂载表**,模板 loader 按这张表解析。

**变量上下文由 host 注入**,模板里能读到:`productName`、`modelId`、`workMode`、`material`、`ResponseLanguage`、`IsWindows`、`IsOversea`、`dataFolderName`、`productFeatures.*`、`WorkingMemoryContent`、`UserLocalMemoryContent`、`UserMemoryContent`、`ToolResultPresentationPrompt`、`WecomAgentAvailable` 等。

这就是"**prompt 是数据,host 提供上下文**"的完整形态:插件作者写片段,Jinja 做正交组合,host 决定开关。

### 1.5 交互模式 = 5 个插件,每个是一组正交切片

```
interactionmode/craft/fragments/
├── interaction.md            ← 模式人设 + 【工具白名单】(frontmatter)
├── agent-loop.md             ← agent 循环语义
├── tool-use.md               ← 工具使用规约
├── interaction-tool-use.md   ← 交互式工具规约
├── result-presentation.md    ← 结果呈现(含 present_files 规则)
├── task-management.md        ← 任务清单使用规约
├── browser-computer-use.md   ← 浏览器控制(带 productFeatures 开关)
├── plugin-recommendation.md  ← 连接器/专家推荐策略
└── current-mode.md           ← 0 字节(占位,模式差异为空)
```

`interaction.md` 的 frontmatter **声明了该模式的工具白名单**:

```yaml
---
name: craft
description: WorkBuddy craft work mode fixed fragments and tool policy.
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TaskCreate
  # …约 40 项,含 Defer(ImageGen) / Defer(TeamCreate) 这类延迟加载项
---
```

于是能力矩阵变成"**模式 × 片段**"的二维表:

| 片段                       | ask | plan | craft | expert | quick |
| ------------------------ | --- | ---- | ----- | ------ | ----- |
| interaction.md           | ✅   | ✅    | ✅     | ✅      | ✅     |
| agent-loop.md            | ✅   | ✅    | ✅     | ✅      | ❌     |
| tool-use.md              | ✅   | ✅    | ✅     | ✅      | ❌     |
| task-management.md       | ❌   | ✅    | ✅     | ✅      | ❌     |
| browser-computer-use.md  | ❌   | ❌    | ✅     | ❌      | ❌     |
| plugin-recommendation.md | ❌   | ❌    | ✅     | ❌      | ❌     |

新增一种模式 = 加一个插件目录 + 在 `prompt.tpl` 加一个 `{% elif %}` 分支。**没有任何宿主代码改动**。

### 1.6 hooks 机制

`hooks/hooks.json`(插件清单里 `"hooks": "./hooks/hooks.json"` 指向):

```jsonc
{
  "description": "SheetAgent plugin hooks",
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command",
                    "command": "bash \"${CODEBUDDY_PLUGIN_ROOT}/scripts/wb/local/setup.sh\" </dev/null >/dev/null 2>&1 &",
                    "timeout": 5 }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command",
                    "command": "node \"${CODEBUDDY_PLUGIN_ROOT}/hooks/save-on-subagent-stop.mjs\"",
                    "timeout": 15 }] }
    ],
    "PreToolUse": [
      { "matcher": "^A2A(SendMessage|GetTask|CancelTask)$",
        "hooks": [{ "type": "command",
                    "command": "node \"${CODEBUDDY_PLUGIN_ROOT}/dist/wecom-auth.mjs\"",
                    "timeout": 660 }] }
    ]
  }
}
```

支持的事件(实测出现):`SessionStart`、`UserPromptSubmit`、`UserPromptExpansion`、`PreToolUse`、`SubagentStop`。

**协议契约**(从 `high-credit-gate.cjs` 的头部注释提取,这是最有价值的一份设计文档):

- `matcher` 是正则,匹配工具名;省略则全匹配。
- `type: "command"` → 调外部进程;**stdout 必须是纯净单行 JSON**(上游整体 `JSON.parse`),诊断信息一律走 **stderr**。
- 返回值语义:`{continue: true}` = 放行无意见;`permissionDecision: 'ask'` = 强制弹审批;`deny` = 拒绝。
- **exit code 恒 0**;exit 2 等价于 deny,但那是另一套语义,不用。
- **fail-closed**:任何异常/畸形输入/清单不可用 → 兜底为 `'ask'`。注释里写得很清楚:
  > 上游在 hook 抛错时会 fall-through 到常规权限检查,bypass 下等于**静默放行、零审批扣费** —— 宁可多弹一次窗,不能漏弹。
- **绝不能对非目标工具返回 `'allow'`**:
  > `'allow'` 会让上游直接短路掉整个权限检查流程,绕过所有既有规则 —— 那是安全事故。
- **`defer_loading` 与 hook 的交互是个坑**:走 `DeferExecuteTool` 的延迟加载工具,其前置 `checkPermission` 在 bypass 下直接返回 allow → hook 压根不执行。所以需要审批的工具必须在 `.mcp.json` 显式 `defer_loading: false`。

### 1.7 「一份 JSON 三方消费」—— 高积分闸门

`mcps/miora-mcp/high-credit-tools.json`:

```jsonc
{
  "version": 1,
  "tools": {
    "miora_text_to_image":     { "approvalKind": "imageGen", "group": "miora-image" },
    "miora_text_to_video":     { "approvalKind": "videoGen", "group": "miora-video" },
    "miora_reference_to_video":{" "approvalKind": "videoGen", "group": "miora-video" }
  }
}
```

三个消费者:

1. marketplace 根下的 `hooks/high-credit-gate.cjs` —— 生成审批白名单与文案 kind;
2. daemon(`cli-runtime-hooks.ts`)—— 扫描聚合出 **hook matcher 与分组 env**(matcher 是启动时派生的,不是硬编码);
3. 桌面构建期校验(`electron.vite.config.ts`)。

> 新增/改名计费工具只改插件里那一份 JSON,宿主各层无需改代码。

而且它还留了**边界诚实记录**:

> 单个插件清单在运行期损坏时,该插件的工具会放行 —— hook 无从知道它原本声明了什么(матcher 是 daemon 启动时从同一份清单扫描的)。该场景的防线在**构建期校验与打包完整性**(清单是 asarUnpack 的只读分发件),不在本脚本。

**这条设计极值得抄:运行期无法自证的部分,明确交给构建期+分发完整性,并在注释里写清楚"我知道这里漏"。**

### 1.8 skill / agent / command 三种"文本资产"

**SKILL.md**(技能)—— frontmatter 里用 `description` 承载**触发语义**:

```markdown
---
name: geo-map-compliance-guard
description: >
  ALWAYS TRIGGER map compliance skill for any map generation, visualization,
  routing, or location service request to enforce strict China map data
  compliance rules…
---
```

正文是给模型看的操作规程,可带 `scripts/`、`references/`、`assets/`。

**agent md**(子代理)—— frontmatter 声明身份,正文是完整工作手册,且可以 `include` 模板。`doc-writer.md` 里出现了**显式职责边界**的写法:

> ⚠️ **你的产出是中间态 Markdown,不是面向用户的最终文档。**  
> 本 Agent 不处理:`beautify_only` → 由 doc-formatter 处理;编辑类意图 → 不进本 skill…

**command md**(斜杠命令)—— frontmatter 有 `argument-hint`,正文用 `$ARGUMENTS`:


```markdown
---
description: 唤起表格 AI 助手，用自然语言完成 Excel 表格的读写、查询…
argument-hint: "描述你想对表格做的事情，例如：帮我汇总 Q1 销售额"
---

<user_input>
$ARGUMENTS
</user_input>

---

将此任务委派给 **sheet-agent** 子代理处理。
## 传递给子代理的内容（仅限以下四项）
1. 文件路径  2. 用户输入（原样转发，不做改写）  3. 当前时间  4. 期望返回
```

注意那句「**仅限以下四项**」+「**原样转发，不做改写**」——这是用提示词约束上下文膨胀的手法,值得学。

### 1.9 设计哲学提炼(6 条)

1. **单源声明优于多端硬编码**。凡是被多处消费的事实(计费工具名、工具白名单、模式能力矩阵),都收敛成一份声明式数据。
2. **插件名即命名空间**。跨插件引用靠名字,不靠相对路径——这让插件可被重排、可被版本化缓存、可被远程市场替换。
3. **prompt 是资产而非代码**。改一句条款不需要发版编译器,改一个 md 即可;`{% if %}` 提供正交组合能力。
4. **fail-closed 用于安全, fail-open 用于观察**。闸门宁可多弹窗;观测类钩子坏了不影响主流程。
5. **运行期无法保证的,写清楚交给构建期**。不假装运行时能自证一切。
6. **边界用注释显式记录**。`high-credit-gate.cjs` 与 `plugins.py` 的头注释都是"设计意图 + 已知缺口"的合体。

---

## 二、nanowork 侧:现状对照

### 2.1 已有的家底

| 能力              | 落点                                                                                | 状态                                                                       |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Skill 技能        | `nanobot/agent/skills.py` `SkillsLoader` + `SKILL.md`                             | ✅ 很完整:4 来源、三态覆盖、渐进式加载、`$skill` 显式调用                                      |
| Plugin 插件       | `nanobot/agent/plugins.py`、`electron/pluginPackage.ts`、`pluginMarketplace.ts`     | ✅ 文件模型/版本化缓存/`/v1/plugins` 已齐                                            |
| MCP             | 插件 `mcpServers` + `nanobot/config/schema.py`                                      | ✅                                                                        |
| Expert 专家       | `src/stores/agentsStore.ts` + `src/types/agent.ts`                                | ✅ 纯客户端配置                                                                 |
| ExpertGroup 专家团 | `nanobot/agent/expert_group.py`                                                   | ✅ 三模式真实执行(2026-10-06 落地)                                                 |
| Subagent 子代理    | `nanobot/agent/subagent.py` + `tools/spawn.py`                                    | ✅ `spawn` / `run_inline`                                                 |
| Hook 钩子         | `nanobot/agent/hook.py` + `turn_hooks.py` + `hooks/`                              | ✅ 15 个生命周期点、`before_execute_tool` 可否决、Composite fail-open/fail-closed 双轨 |
| Tool 工具         | `nanobot/agent/tools/loader.py` + `entry_points("nanobot.tools")`                 | ✅ 含外部声明式注册                                                               |
| Prompt(引擎)      | `nanobot/utils/prompt_templates.py` Jinja2 + `OVERRIDABLE_TEMPLATES` 白名单          | ✅ 工作区可覆盖代理层模板                                                            |
| Prompt(渲染层)     | `src/lib/prompt/promptAssembly.ts` 11 段 + `promptCatalog.ts` 槽位 + `~/.nanowork/prompts/` | ✅                                                                        |

**本项目不是"没有插件机制",而是插件机制只覆盖了"技能 + MCP"两个面。**

### 2.2 现有插件清单的解析面

`nanobot/agent/plugins.py`:

```python
AGENT_PLUGIN_SCHEMA   = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

_PLUGIN_MANIFEST_RELPATHS = ("plugin.json", ".nanowork-plugin/plugin.json")
_PLUGIN_MCP_RELPATHS      = ("mcp.json", "mcp/mcp.json")
_MCP_SERVER_FIELDS        = {"type", "command", "args", "env", "cwd"}
```

实际读取的字段只有:`$schema`、`name`、`description`、`repository`、`extensions['dev.nanobot']`、`mcpServers`。

技能**不走 manifest 声明**,走**目录约定**(扫包内 `skills/`)。

对比 WorkBuddy:`skills / agents / commands / hooks / prompts` 全是 manifest 显式声明的。

### 2.3 能力缺口(7 条,按重要性排序)

| #      | 缺口                            | 后果                                                                       |
| ------ | ----------------------------- | ------------------------------------------------------------------------ |
| **G1** | 插件**不能提供 prompt 片段**          | 第三方无法在不改引擎代码的前提下注入领域规程;`promptCatalog` 的槽位是渲染层硬编码的常量                     |
| **G2** | 插件 manifest **不认 `agents`**   | 子代理只能由核心代码/专家团运行时构造,不能由插件随包分发                                            |
| **G3** | 插件 manifest **不认 `commands`** | 无斜杠命令扩展点                                                                 |
| **G4** | 插件 manifest **不认 `hooks`**    | 插件的安全/审批策略必须改引擎代码才能接上                                                    |
| **G5** | **无插件级声明式工具白名单**              | 工具策略散在 `toolsPolicyStore.ts` + 引擎 hook,不是"插件说了算"                         |
| **G6** | **无 marketplace 索引文件**        | `pluginMarketplace.ts` 靠目录扫描;拿不到 `dependencies`、`category` 这类市场级语义       |
| **G7** | **无"插件带 UI 资产"**              | WorkBuddy 的 `category: "mcp-app"` + `assets/*.html` 让插件贡献渲染工件;本项目渲染层无此通道 |

⚠️ 还有一个**跟现有缓存相关的隐患**:`plugins.py` 的 `_SKILL_CACHE` 用 `_package_fingerprint(package.root)` 做失效判据。一旦新增可发现文件类型(prompts/agents),**fingerprint 的覆盖范围必须同步扩大**,否则"改了插件的 prompt 不生效"这类问题会以"缓存击穿"的形态出现,极难查。

---

## 三、借鉴方案(按性价比排序)

### P0 —— 让插件能提供 prompt 片段(直击 G1)

**这是唯一一个"结构性"借鉴点,其它都是锦上添花。**

落点:

1. **manifest 扩字段**(`plugins.py`):加 `prompts`(与 `skills` 同形,string | string[]),指到包内目录。
2. **虚拟挂载表**:`SkillsLoader` 已经有一份"已启用插件 → 包根"的映射(`enabled_agent_plugin_skill_dirs`)。把它提升为一个**按插件 `name` 索引的挂载表**,而不是只服务 skills。
3. **模板 loader 扩源**:`prompt_templates.py` 现在是单个 `FileSystemLoader` + `OVERRIDABLE_TEMPLATES` 白名单覆盖。改成 **ChainLoader**:
   - 第一级:插件虚拟命名空间(`<plugin-name>/<relpath>`)
   - 第二级:工作区覆盖(`<workspace>/prompts/`)
   - 第三级:引擎内置 `templates/`(兜底)
4. **信任分级(必做,否则是安全洞)**:插件片段会进系统提示词。必须区分:
   - `builtin`(随客户端分发)、`trusted`(已签名市场)、`user`(任意安装)
   - 只有前两档允许无条件注入;`user` 档片段包 `<untrusted_content>` 包裹(引擎已有 `_snippets/untrusted_content.md` 可复用)
5. **变量上下文**:直接复用现有 `render_template(name, context)` 的 context,新增字段走同一处注入——**不要**另建一套变量体系。

**最小闭环验证**:写一个 demo 插件,manifest 声明 `prompts`,内含一个 `fragments/domain.md`,在引擎的 `platform_policy.md` 里 `{% include "demo-plugin/fragments/domain.md" %}`,断言系统提示词里出现该文本。一个用例即可证明整条链路。

**注意**:这一步**不要**照搬 WorkBuddy 的 `welcomemode/*/prompt.tpl` 那棵大树。本项目已有"引擎模板 + 渲染层槽位"双轨,再加一棵模板树会变三轨混乱。正确做法是**只扩模板的来源(loader),不改模板的组织结构**。

### P1 —— 清单读取器统一 + 字段补齐(直击 G2/G3/G5)

`plugins.py` 的 `AgentPlugin` dataclass 现在只有 `mcp_servers`,扩成:

```python
@dataclass(frozen=True)
class AgentPlugin:
    ...
    mcp_servers: tuple[str, ...] = ()
    skill_dirs:  tuple[Path, ...] = ()
    agent_files: tuple[Path, ...] = ()      # G2
    command_files: tuple[Path, ...] = ()    # G3
    prompt_dirs: tuple[Path, ...] = ()      # G1
    hook_manifest: Path | None = None       # G4
    tool_policy: tuple[str, ...] = ()       # G5
```

**关键纪律**:所有新字段的路径**必须走同一套 `_contained()` 包含性检查**。`plugins.py` 里现成的注释已经点明了理由:

> 这一层是**遍历防护**,别指望调用方传进来的名字是干净的。

新增字段如果绕过 `_contained`,就是把已有的防路径逃逸能力开了个后门。

### P2 —— 声明式工具白名单(直击 G5)

在**技能 frontmatter** 与**插件 manifest** 两处支持 `tools:` 字段(与 WorkBuddy 的 `interaction.md` frontmatter 同形),装配时叠加为 ToolPolicy。

落点:`nanobot/agent/hooks/agent_tools.py` 已有"Agent 工具白名单"的成熟实现(FR-2.2),**照它的形状再加一个 `plugin_tools.py`**,在 `turn_hooks.py` 的 `build_agent_turn_hook` 基线链里挂上。

风险低、收益直接:**插件从此可以自己收紧自己的工具面**。

⚠️ 但要复刻 WorkBuddy 那条教训——**白名单只能收紧,不能放宽**。基线链里的审批门必须是"交集"语义,不能让插件用 `tools:` 把审批门顶掉。

### P3 —— marketplace 索引(直击 G6)

`pluginMarketplace.ts` 现在靠目录扫描。加一个可选的 `marketplace.json`:

```jsonc
{ "name": "nanowork-builtin",
  "plugins": [{ "name": "…", "source": "./…", "category": "…", "dependencies": ["…"] }] }
```

带来 `dependencies` 解析能力(WorkBuddy 的 `welcomemode-design → [mcp-miora, ardot]` 就是这么表达的)。**没有索引文件时回退到目录扫描**,保持向后兼容。

### P4 —— (暂缓)插件级 hooks 声明

WorkBuddy 走的是**跨进程 shell hook**(`node gate.mjs`),因为它的 host 是 Node。本项目引擎是 Python 进程内 hook,跨进程 shell 的成本与安全面都更差。

**建议**:如果要支持,只做"**声明 → 映射到内建 hook 的启停/参数**",不做"任意脚本执行":

```jsonc
{ "hooks": { "beforeExecuteTool": { "policy": "deny-list", "tools": ["shell"] } } }
```

即把 hook 声明**降维成配置**,而不是升级成插件。真要跑脚本,走 MCP 工具通道(已有沙箱与审批)。

### P5 —— (不建议)插件带 UI 资产

WorkBuddy 的 MCP app 用 `assets/miora-viewer.html` + `mcp-app` category 贡献渲染工件。本项目渲染层没有 iframe 沙箱体系,引入等于开一个 XSS 面。**除非有明确的产品需求,否则不做。**

---

## 四、明确的「不要照抄」清单

| 不要抄                                             | 原因                                            |
| ----------------------------------------------- | --------------------------------------------- |
| 跨进程 shell hook + `${PLUGIN_ROOT}` 拼命令           | 本项目引擎 Python 进程内 hook 已更优;跨进程 = 新攻击面 + 冷启动成本  |
| `welcomemode/*/prompt.tpl` 整棵 Jinja 模板树         | 本项目已有双轨 prompt,再加一棵变三轨                        |
| `.codebuddy-plugin` / `.workbuddy-plugin` 双前缀兼容 | 那是改名期的技术债,不是设计;本项目 `.nanowork-plugin` 单前缀即可   |
| `marketplace.json` 里所有插件共用一个版本串                 | 那是"整包发版"的产物;本项目走版本化缓存+`current` 指针,应保留每插件独立版本 |
| `$(( $(date +%s) - SECONDS ))` 这种 shell 计时技巧    | 可读性极差,注释里都没解释为什么                              |

---

## 五、结论与建议起手式

### 一句话结论

**能借鉴,且本项目已经在正确的 schema 主干上(agent-plugins.org v1)。真正的差距不是"有没有插件系统",而是"插件清单的读者只有 2 个(skills、mcpServers),WorkBuddy 有 6 个"。**

按性价比,建议只做三件事:

1. **P0 —— 让插件能提供 prompt 片段**(扩 `prompts` 字段 + ChainLoader + 信任分级)。这是唯一的结构性缺口,做完之后"第三方插件注入领域规程"这条链路就通了。
2. **P1 —— 统一清单读取器**,补 `agents` / `commands` / `prompt_dirs` / `hook_manifest` 字段,所有新路径走 `_contained()`。
3. **P2 —— 声明式工具白名单**(只收紧不放宽)。

P3 视需要,P4/P5 不做。

### 起手式(P0 的最小闭环)

```
1. plugins.py: AgentPlugin 加 prompts 字段 + 解析(走 _contained)
2. plugins.py: _package_fingerprint 覆盖范围要包含 prompts 目录  ← 容易漏,漏了就是"改了不生效"
3. prompt_templates.py: 单 loader → ChainLoader(插件虚拟命名空间 > 工作区 > 内置)
4. 信任分级: builtin/trusted 直注,user 档包 <untrusted_content>
5. 用例: demo 插件 → 断言系统提示词含片段文本
6. 变异验证: 去掉 ChainLoader 的第一级 → 用例必须变红
```

第 6 步是本项目的既有纪律(「给不可测的接线段留闭包＝埋雷」),务必执行。

---

## 附:机制速查表

| 概念        | WorkBuddy                                         | nanowork 现状                                             |
| --------- | ------------------------------------------------- | ------------------------------------------------------- |
| 市场索引      | `.codebuddy-plugin/marketplace.json`              | ❌ 靠目录扫描                                                 |
| 插件清单      | `<pkg>/.{codebuddy,workbuddy}-plugin/plugin.json` | `plugin.json` / `.nanowork-plugin/plugin.json`          |
| 清单规范      | 私有(无 `$schema`,自定义 `workbuddy` 键)                 | 标准 `agent-plugins.org` v1 + `extensions['dev.nanobot']` |
| 变量插值      | `${CODEBUDDY_PLUGIN_ROOT}` `${VAR:-default}`      | 无                                                       |
| 插件命名空间    | ✅ `<plugin-name>/<relpath>` 虚拟挂载                  | ❌                                                       |
| 技能        | manifest `skills` 声明 + 目录                         | 目录约定 + 三态覆盖(更完善)                                        |
| 子代理       | manifest `agents`                                 | 引擎内建                                                    |
| 命令        | manifest `commands` + `$ARGUMENTS`                | ❌                                                       |
| 钩子        | manifest `hooks` + 跨进程 shell                      | 引擎进程内 Python(更优)                                        |
| prompt 片段 | ✅ 插件提供,Jinja 正交组合                                 | ❌ 写死在双轨                                                 |
| 工具白名单     | fragment frontmatter `tools:`                     | 引擎 hook + 渲染层 store                                     |
| 安全默认      | fail-closed(闸门) / fail-open(观测)                   | 同                                                       |
