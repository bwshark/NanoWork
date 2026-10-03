import type { ConnectionStatus } from '@/types';

/**
 * 侧边栏顶部展示的品牌名（中文主名 + 英文副名）。
 * 与窗口标题栏解耦：桌面端标题栏只放操作图标，品牌名落在侧边栏顶部，
 * 折叠侧边栏后靠托盘图标 / 任务栏标题识别应用。
 */
export const APP_DISPLAY_NAME = 'NanoWork';
export const APP_DISPLAY_SUB = 'Workbench';

/** 完整应用名（「关于」弹窗标题与复制信息用，与侧边栏品牌名保持一致） */
export const APP_NAME = `${APP_DISPLAY_NAME} ${APP_DISPLAY_SUB}`;

/**
 * 渲染层可见的应用版本。
 *
 * ⚠️ **与 `package.json` 的 `version` 是同一份事实的两处镜像**——渲染层跑在浏览器
 * 沙箱里读不到 `package.json`，而 vite 未配置版本注入，故只能在此声明。改版本号时
 * 两处一起改。桌面端以主进程 `app.getVersion()` 为准（见设置弹窗的「关于」分区），
 * 这个常量只作 Web 端与主进程不可用时的兜底。
 */
export const APP_VERSION = '0.1.0';

/**
 * 首选网关端口。
 *
 * ⚠️ **与 `electron/main.ts` 的 `DEFAULT_GATEWAY_PORT` 是同一份事实的两处镜像**——
 * 渲染层与主进程是两个 bundle，主进程 import 本文件会牵进 `@/` 别名（esbuild 未配该别名）。
 * 改端口时两处一起改，与 `APP_VERSION` 同一套约定。
 *
 * 为什么不是 nanobot 自带的 8900：Windows 会把成段端口划入「保留区间」
 * （Hyper-V / WSL 的 winnat 动态保留，`netsh interface ipv4 show excludedportrange
 * protocol=tcp` 可查），落在其中的端口**任何进程都绑不上**，报错是 WSAEACCES(10013)
 * 而不是「端口已占用」的 10048 —— 照「杀旧进程」的思路排障会一直找不到原因。
 * 18900 不在保留区间内，且高于动态端口范围上界（1024 + 13977 = 15000），
 * 不会与出站临时端口撞车。
 *
 * 这仍然只是**首选值**：主进程 bind 失败时会自动顺延（见 `resolveGatewayPort`），
 * 实际端口以主进程为准，渲染层据 `nanobotGatewayInfo` 同步地址。
 */
export const DEFAULT_GATEWAY_PORT = 18900;

/** 默认 nanobot 网关（OpenAI 兼容 API 前缀） */
export const DEFAULT_GATEWAY = `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/v1`;

/**
 * 会话（任务）占位标题：首条消息发送前标题为占位值，
 * 发送时由 sessionsStore.send 自动替换为首条消息摘要。
 */
export const PLACEHOLDER_TITLES = ['新会话', '新任务'] as const;

/** 默认连接状态（启动后由 ConnectionManager 探测并更新） */
export const DEFAULT_STATUS: ConnectionStatus = 'offline';

/**
 * 会话**未绑定专家 Agent** 时的显示名。
 *
 * 「新建任务」按设计不继承全局活跃专家（见 `sessionsStore.createSession` 的
 * `inheritCapabilities`），这类会话的 `agentId` 是空串：应答交给网关自身配置的
 * 默认 Agent，而不是某个具体专家。
 *
 * 列表 / 产物面板据此展示，避免掉进 `?? '未知 Agent'` 那条「像是数据坏了」的分支
 * ——未绑定是**正常状态**，不是缺数据。文案与消息署名（AssistantMessage 的
 * 「助手」）保持一致。
 */
export const UNBOUND_AGENT_LABEL = '助手';

/**
 * 路由路径集中管理。
 *
 * ⚠️ **这里只有「页面级」路由**：打开一个整页、`location.pathname` 随之变化的入口。
 * 设置在 2026-09 从整页改成弹窗后，`plugins` / `memory` / `persona` / `im` 四条路由
 * **已下线**——它们的内容现在是设置弹窗里的分区（见 `stores/settingsUiStore.ts` 的
 * `SettingsSectionId`）。分区状态刻意不进 URL：那是「弹窗翻到第几页」，不是「用户在哪」。
 *
 * `settings` 保留，因为主进程（托盘菜单 / 单实例唤起）会 `navigate('/settings')`；
 * 该路由现在的职责是「打开设置弹窗」，见 `pages/settings/SettingsRoute.tsx`。
 */
export const ROUTES = {
  chat: '/chat',
  agents: '/agents',
  myAgents: '/agents/mine',
  skills: '/skills',
  mcp: '/mcp',
  tasks: '/tasks',
  /**
   * 设置入口路由。**不是设置页**——渲染时立即打开设置弹窗并重定向到聊天页，
   * 只为兼容「从主进程按路径跳转」这一条既有调用链。
   */
  settings: '/settings',
  artifacts: '/artifacts',
  /**
   * 登录 / 注册页（批次 4，FR-10）。
   *
   * **不是受保护页**——它就是登录页本身：未登录时不拦截本地使用，只把入口收在
   * 设置弹窗「账户」分区（或侧边栏底部账户入口）里；点进去才 `navigate('/auth')`。
   */
  auth: '/auth',
} as const;

/**
 * 意见反馈入口（侧边栏账户菜单里那一项）。
 *
 * 走 issue 列表页而不是自建表单：反馈要能被人跟、被回复、被关闭，issue 天生如此，
 * 而本项目还没有收反馈的服务端。
 *
 * ⚠️ 与 `git remote -v` 的仓库地址是**同一份事实的两处镜像**——渲染层读不到 git
 * 配置，只能在此声明。换仓库 / 迁移反馈渠道时两处一起改。
 */
export const FEEDBACK_URL = 'https://github.com/bwshark/nanowork/issues';

/** 持久化存储 key 前缀集中管理 */
export const STORAGE_KEYS = {
  settings: 'nanowork.settings',
  /**
   * 上次打开的会话 id（纯 UI 状态）。
   *
   * 会话数据本身已事件化落盘（`<userData>/projects/<slug>/<sessionId>.jsonl`），
   * 这里只记「光标在哪」，与业务数据无关——故它独立于事件流单独持久化。
   */
  activeSession: 'nanowork.ui.activeSession',
  /**
   * **旧版**会话整块快照的 storage key，已废弃。
   *
   * 会话数据自 D2 Phase E 起只走事件流（`<userData>/projects/<slug>/<id>.jsonl`），
   * 这个键既不再读也不再写。之所以保留常量而非删掉：主进程/Web 各有一条 storage
   * 路由（`<userData>/sessions.json`）需要按它做**一次性清理**——不清理就留下
   * 一个永远读不到的孤儿文件。历史会话已由用户清空，故无需迁移。
   */
  legacySessions: 'nanowork.sessions',
  agents: 'nanowork.agents',
  expertGroups: 'nanowork.expertGroups',
  /**
   * 技能索引与运行时视图（事实缓存 + 覆盖态的合成结果）。
   *
   * ⚠️ **不是同步负载**：它混着磁盘扫描的事实（`path` 等机器专属字段）。用户意图
   * 单独落在 `skillOverrides` 里，见下一条。
   */
  skills: 'nanowork.skills',
  /**
   * 技能覆盖表（用户意图）：`SkillOverrideEntry[]`，独立落 ① `skills/overrides.json`。
   *
   * 与 `skills` 分成两个 key 的原因见 `types/skill.ts` 的 `SkillOverrideEntry`：
   * 技能正文由各设备的磁盘决定、多端自然一致，跨端要同步的只有「用户把它调成了
   * 哪一档、有没有置顶」。整实体同步会把 `Skill.path` 这个机器专属字段带上云
   * （FR-10.5 禁止）。
   */
  skillOverrides: 'nanowork.skillOverrides',
  // ⚠️ 这里**刻意没有** `plugins` 键。插件（FR-3.4）的持久化只有一处：
  // `settings.enabledPlugins`（用户意图）。已安装清单与引擎激活状态都是**事实**，
  // 每次从权威重新读（磁盘扫描 / `GET /v1/plugins`），落盘只会制造第二份可能
  // 过期的真相。且 `~/.nanowork/plugins/` 属用户资产，绝不能被「清空数据」
  // 带走（`knownRouteFiles` 有一条不变量专门守这个）。
  // 日后若真要为插件加持久化状态，先读该不变量再决定落点。
  mcp: 'nanowork.mcp',
  tasks: 'nanowork.tasks',
  artifacts: 'nanowork.artifacts',
  /** 文件级回滚时间线（FR-7.3）：`Record<fileKey, {hash, at, op}[]>` */
  fileBackups: 'nanowork.fileBackups',
  channels: 'nanowork.channels',
  /**
   * 本机的**用户记忆作用域**（`u_<hex>`，记忆 v2）：决定用户级记忆落在
   * `~/.nanowork/user-memory/<scope-id>/` 的哪一份。
   *
   * 值是**裸字符串**——因此在 `electron/storageRoutes.ts` 必须登记为 `text` 路由。
   * 它曾定义在 `memoryPlatformIo.ts` 而不在本表里，于是掉进 `misc/` 的 **json 兜底**：
   * `JSON.parse('u_6fa1…')` 必然抛错（`Unexpected token 'u'`），**写入整条失败**。
   * 症状极具迷惑性：不崩、不报红，只是**每次启动都生成新 scope** → 上一次写的画像与
   * 偏好留在旧目录里，永远读不回来。
   *
   * 放本表的意义：`STORAGE_KEYS` 全部显式登记是 `tests/electron/storageRoutes.test.ts`
   * 的一条不变量，写在这儿才不会再有下次。
   */
  localMemoryScope: 'nanowork.memoryScope',
} as const;

/**
 * 工作区文件记忆（MEMORY.md）相关常量。
 *
 * ⚠️ 自 2026-09 起工作区记忆**不再走 `platform.storage`**：落点是
 * `<工作目录>/.nanowork/memory/` 这个目录（`MEMORY.md` + 若干 `YYYY-MM-DD.md`），
 * 由 `platform.memoryFiles` 承担，目录约定集中在 `src/lib/workspaceMemory.ts`。
 *
 * 下面这条前缀只剩**一个用途**：定位旧落点 `~/.nanowork/memory/<key>.md`，
 * 供一次性懒迁移读取（Web 端见 `storage.web.ts` 的 `migrateLegacy`，
 * Electron 端见 `electron/memoryRoutes.ts` 的 `resolveLegacyMemoryFile`）。
 * 新代码不要再往这个前缀下写东西。
 */
/** 旧记忆单文件在 storage 中的 key 前缀，完整 key = MEMORY_KEY_PREFIX + workspaceKey */
export const MEMORY_KEY_PREFIX = 'nanowork.memory.';

/** 注入 system 段的记忆块起始标签（便于解析与去重） */
export const MEMORY_TAG_OPEN = '<!-- MEMORY -->';

/** 注入 system 段的记忆块结束标签 */
export const MEMORY_TAG_CLOSE = '<!-- /MEMORY -->';

/**
 * 注入段的标签集（design §13.3「三层上下文注入」）。
 *
 * 与 `MEMORY_TAG_*` 用 HTML 注释不同，这里的标签是**真标签**——它们要能被人一眼
 * 从装配结果里读出来「这段是什么」，而 `<!-- -->` 在 Markdown 渲染里是隐藏的。
 * 记忆块保持 `<!-- MEMORY -->` 是刻意的（见 §14.2「现有机制设计良好，予以保留」），
 * 且 `MemoryService.extractFromInjection` 依赖它做还原。
 *
 * ⚠️ `IDENTITY_TAG_*` 与引擎 `nanobot/agent/context.py` 的常量是**同名字符串的两份
 * 镜像**（引擎注入系统提示词、客户端注入用户消息前缀）。改一边必须改另一边。
 */
export const IDENTITY_TAG_OPEN = '<identity_context>';
export const IDENTITY_TAG_CLOSE = '</identity_context>';
export const PRODUCT_IDENTITY_TAG_OPEN = '<product_identity>';
export const PRODUCT_IDENTITY_TAG_CLOSE = '</product_identity>';
export const TONE_STYLE_TAG_OPEN = '<tone_and_style>';
export const TONE_STYLE_TAG_CLOSE = '</tone_and_style>';
export const USER_INSTRUCTIONS_TAG_OPEN = '<user_custom_instructions>';
export const USER_INSTRUCTIONS_TAG_CLOSE = '</user_custom_instructions>';

/**
 * 用户级长期记忆（L2）的存储 key：路由到 `~/.nanowork/MEMORY.md`（跨项目生效）。
 *
 * 刻意**不**复用 `MEMORY_KEY_PREFIX`：那个前缀指向**旧**工作区记忆的单文件落点
 * （`memory/<key>.md`，现仅用于懒迁移读取），而用户级记忆落在 ① 根目录下的
 * `MEMORY.md`，是个静态落点。混用前缀会得到 `memory/user.md`——一个看起来像
 * 工作区记忆、实际谁都不认的孤儿文件。
 */
export const USER_MEMORY_KEY = 'nanowork.userMemory';

/**
 * 身份文件（L4，FR-4.3）的存储 key。
 * 一律落在 ① `~/.nanowork/` 根目录，文件名即用户可见的名字。
 */
export const IDENTITY_STORAGE_KEYS = {
  soul: 'nanowork.identity.soul',
  identity: 'nanowork.identity.identity',
  user: 'nanowork.identity.user',
  /** 一次性引导文件：存在即进入 onboarding 模式，引导完成后删除 */
  bootstrap: 'nanowork.identity.bootstrap',
} as const;

/** 身份文件的磁盘文件名（与 key 的语义映射，主进程路由引用） */
export const IDENTITY_FILENAMES = {
  soul: 'SOUL.md',
  identity: 'IDENTITY.md',
  user: 'USER.md',
  bootstrap: 'BOOTSTRAP.md',
} as const;

/**
 * 提示词模板外置（design §13.4 / FR：提示词可外置修改不重编译）的存储 key 前缀。
 *
 * 完整 key = `PROMPT_KEY_PREFIX + <kind> + '.' + <key>`，路由到
 * `~/.nanowork/prompts/<kind>/<key>.md`（如 `prompts/mode/ask.md`、
 * `prompts/style/style-professional.md`）。
 */
export const PROMPT_KEY_PREFIX = 'nanowork.prompt.';

/**
 * 敏感工具集合：文件读写 / 终端命令 / 网络访问。
 * 命中时触发权限门控（PermissionDialog）。
 */
export const SENSITIVE_TOOLS = ['files', 'shell', 'network'] as const;

/** 判断工具名是否属于敏感类别 */
export function isSensitiveTool(tool: string): boolean {
  return (SENSITIVE_TOOLS as readonly string[]).includes(tool);
}

/**
 * Agent 工具白名单（FR-2.2）的候选项。
 *
 * 这是**输入建议**，不是穷尽清单——引擎里还有 `mcp__<服务>__<工具>` 这类
 * 运行时才知道名字的工具，所以 UI 必须允许自由输入。写死成「只能从列表里选」
 * 会让 MCP 工具永远无法被授予，等于把白名单变成一堵墙。
 *
 * 名单与 `nanobot/agent/tools/` 的注册表对齐，改动时两边一起看。
 */
export const AGENT_TOOL_CATALOG = [
  // 只读
  'read_file',
  'list_dir',
  'find_files',
  'grep',
  'web_search',
  'web_fetch',
  // 写类
  'write_file',
  'edit_file',
  'apply_patch',
  // 执行
  'exec',
  // 删除（FR-8.3：唯一会走系统回收站的删除入口）
  'delete_file',
  // Plan 模式交付物（FR-1.5）
  'submit_plan',
] as const;

/** 工具名的人话说明，用于白名单编辑时的提示（FR-2.2） */
export const AGENT_TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  list_dir: '列目录',
  find_files: '查找文件',
  grep: '内容搜索',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  write_file: '写入文件',
  edit_file: '编辑文件',
  apply_patch: '打补丁改文件',
  exec: '执行终端命令',
  delete_file: '删除（进回收站）',
  submit_plan: '提交计划（Plan 模式）',
};
