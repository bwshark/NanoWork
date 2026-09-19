/** 当前连接状态：已直连 / 离线 */
export type ConnectionStatus = 'connected' | 'offline';

// DesktopConfig 定义在 platform/types（主进程与渲染层共用）：
// 先 import 供本文件的 Settings 引用，再转出，方便设置层从 '@/types' 统一取用
import type { DesktopConfig } from '../platform/types';
export type { DesktopConfig };

// 快捷键 id 的联合类型是「有哪些命令」的唯一事实源，定义在 lib/shortcuts；
// 这里只做类型引用，键位默认值与匹配逻辑都不落在 types 层
import type { ShortcutId } from '../lib/shortcuts';

/**
 * 语音转录（STT）配置：走 OpenAI 兼容的 `/audio/transcriptions`。
 * 未启用时 Composer 的语音按钮保持禁用（不申请麦克风权限）。
 */
export interface TranscriptionConfig {
  /** 是否启用语音输入 */
  enabled: boolean;
  /** 转录服务 endpoint（OpenAI 兼容前缀）；留空则复用网关 endpoint */
  endpoint: string;
  /** 转录模型名（如 whisper-1 / whisper-large-v3） */
  model: string;
  /** 转录服务 API Key；留空则复用网关 apiToken */
  apiToken: string;
  /** 语言提示（ISO-639-1，如 zh / en）；留空由服务端自动检测 */
  language: string;
}

/** 全局设置（持久化） */
export interface Settings {
  /** nanobot 网关 endpoint（OpenAI 兼容 API 前缀），默认 http://127.0.0.1:8765/v1 */
  gatewayEndpoint: string;
  /** nanobot apiToken / key */
  apiToken: string;
  /** UI 主题偏好：浅色 / 深色 / 跟随系统 */
  theme: 'light' | 'dark' | 'system';
  /** 是否将 MEMORY.md 以标签块注入 system prompt 末尾（默认 true） */
  memoryEnabled: boolean;
  /** 会话结束时是否自动沉淀摘要（默认 false） */
  autoSummarize: boolean;
  // —— 语音输入（STT）——
  /** 语音转录服务配置：未启用时 Composer 语音按钮禁用 */
  transcription: TranscriptionConfig;
  // —— 桌面端（Electron）——
  /**
   * 系统托盘 / 全局快捷键 / 开机自启等桌面专有行为。
   * Web 端无对应能力，该项仅作占位（保持结构一致，避免 undefined 分支）。
   */
  desktop: DesktopConfig;
  // —— 提示词外置（design §13.1 / §13.4）——
  /**
   * 领域维度模板（`general` / `code` / `design`）的**全局默认**。
   *
   * 与 `promptStyle` 一样只是默认值：Agent 可以用自己的 `promptDomain` 覆盖。
   * 之所以默认放在全局而不是每个 Agent 必填，是因为绝大多数用户只用一个 Agent，
   * 强迫每个 Agent 都选一遍领域是纯粹的负担。
   *
   * 留空 / 非法值 → 组装时回退 `general`（见 promptCatalog 的 DEFAULT_PROMPT_DOMAIN）。
   */
  promptDomain?: string;
  /**
   * 语气风格模板 id（如 `style-professional`）的全局默认。
   * 风格只改表达方式不改事实（§13.1 的内容质量护栏）。
   */
  promptStyle?: string;
  /**
   * 用户自定义指令，注入 `<user_custom_instructions>`。
   *
   * 与 Agent 的 `systemPrompt` 的区别：那是「这个 Agent 是什么」，这是「我这一轮
   * 想额外强调什么」——跨 Agent 生效，适合放「总是用中文」「别给我写总结」这类
   * 与身份无关的长期要求。
   */
  userCustomPrompt?: string;
  // —— 侧边栏工作空间显示名 ——
  /**
   * 工作空间别名表。key 为会话的 workdir（绝对路径），
   * value 为侧边栏分组要展示的显示名。设了别名后，
   * 「重命名工作空间」改的是这张表，绝不会写回 workdir。
   * 存 mapping 而不是每个 session 各自存别名，是因为同一文件夹下的多个 session
   * 应该共享同一别名，否则只重命名单个 session 就破坏了「工作空间」语义。
   * 兜底默认 `{}`，老用户迁移见 settingsStore 的 v6 迁移函数。
   */
  workspaceAliases?: Record<string, string>;
  /**
   * 用过的工作空间路径（用户资产目录，不是「当前有任务的目录」）。
   *
   * ⚠️ **当前没有读取方**。它当初是为了让「0 个任务的工作空间」继续留在侧边栏
   * 分组里（分组本来完全由会话推导，最后一条任务被切走就整组消失，看起来像
   * 「工作空间丢了」）。但产品口径后来改成相反的一条：**工作空间下没有对话记录
   * 就不显示这个分组**（用户明确要求，见 `groupSessionsByWorkdir`），于是侧边栏
   * 不再读这张表。
   *
   * 保留它是因为「用户用过哪些目录」这份留痕本身有价值——后续在工作空间选择器里
   * 列「最近使用」时正好需要它（分配过工作空间的会话会把路径登记进来，见
   * `sessionsStore` 的三处 `rememberWorkspace` 调用）。若确定不做那个入口，
   * 这张表连同三处登记与 `rememberWorkspace`/`forgetWorkspace` 应当整体删除。
   *
   * 与 `workspaceAliases` 分开存：那张表的键只是「重命名过的分组」，
   * 不能兼任登记表（没重命名过的工作空间不在里面）。
   * 兜底默认 `[]`，老用户迁移见 settingsStore 的 v11 迁移函数。
   */
  knownWorkspaces?: string[];
  // —— 窗口外壳 ——
  /**
   * 侧边栏是否收起。桌面端由窗口标题栏最左侧的图标切换，
   * 收起后标题栏改为显示「展开侧边栏 + 新建任务」。
   * 属布局偏好，持久化，重开应用保持上次状态。默认 false。
   */
  sidebarCollapsed?: boolean;
  // —— 侧边栏分组的「从列表中移除」——
  /**
   * 已从侧边栏隐藏的会话 id 列表。
   *
   * 语义是「只从列表里拿掉，不删数据」：会话仍在 sessionsStore 中，
   * 只是不参与侧边栏分组渲染（仍可通过运行记录等方式访问）。
   * 存会话 id 而非分组 key，是因为这样有天然的恢复路径——
   * 定时任务下次执行会生成新的会话 id，不在表内，该分组便自动重新出现。
   *
   * 兜底默认 `[]`，老用户迁移见 settingsStore 的 v8 迁移函数。
   */
  hiddenSessions?: string[];
  // —— 快捷键（设置弹窗「快捷键」分区）——
  /**
   * 用户改键覆盖表：`ShortcutId → 键位串`（格式见 `lib/shortcuts` 的文件头注释）。
   *
   * **只存与默认值不同的项**，因此「表里没有」= 用默认键位，而 `''` 是另一个语义：
   * 用户显式清除该绑定（禁用）。两者不能合并——若用「表里没有」表示禁用，
   * 就再也无法表达「这条命令我还没动过」，日后调整默认键位将无法惠及老用户。
   *
   * 兜底默认 `{}`，老用户迁移见 settingsStore 的 v10 迁移函数。
   *
   * ⚠️ 全局唤起快捷键（`app.wake`）**不在这张表里**：它由 Electron 主进程
   * `globalShortcut` 注册，权威值在 `desktop.hotkey`（accelerator 语法），
   * 主进程启动时就要读它，不可能等渲染层把覆盖表合并完再注册。
   */
  shortcuts?: Partial<Record<ShortcutId, string>>;
  // —— 插件（FR-3.4）——
  /**
   * 用户希望启用的插件清单，形如 `<name>@<marketplace>`（本地安装的包没有
   * 市场后缀，就是裸 `<name>`）。对齐 PRD §12.2 的 `enabledPlugins`。
   *
   * ⚠️ **这是「意图」，不是「事实」**。事实在引擎侧：插件激活标记与包内容
   * **指纹绑定**，换了包内容标记就失效，因此只有引擎能回答「到底激活没有」
   * （`GET /v1/plugins`，见 `runtime.listPlugins()`）。两者不一致时由
   * `pluginsStore` 显式提示，**不静默对齐**——静默对齐会让「用户明明启用了
   * 却没生效」变成一次无痕的自我治愈，问题从此查不出来。
   *
   * 兜底默认 `[]`。字段是**可选**的：老数据里没有它，读取方一律按空表处理
   * （不做版本迁移——空表就是正确语义，没有需要搬运的旧形态）。
   */
  enabledPlugins?: string[];
  // —— 存储（设置弹窗「通用 → 存储」）——
  /**
   * 默认工作空间存储路径：新建任务在用户没有当场指定工作空间时，落在它下面。
   *
   * **可选，且「未设置」与「设置为空串」同义**，都表示「用内置默认」
   * （`<home>/NanoWork`，由主进程现算——渲染层拿不到 home，也不该拼路径）。
   * 因此这里不写默认值：写一个空串进默认集，等于把「用户从没动过」
   * 和「用户主动清空」混成一种状态，日后没法区分。
   *
   * 语义是「新建任务的落点」，不是「数据目录」：**改它不影响已有数据**——
   * 已有会话的 workdir 已经存在会话记录里，不会跟着变。
   */
  defaultWorkspacePath?: string;
}
