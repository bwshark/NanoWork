/** 当前连接状态：已直连 / 离线 */
export type ConnectionStatus = 'connected' | 'offline';

// DesktopConfig 定义在 platform/types（主进程与渲染层共用）：
// 先 import 供本文件的 Settings 引用，再转出，方便设置层从 '@/types' 统一取用
import type { DesktopConfig } from '../platform/types';
export type { DesktopConfig };

// 快捷键 id 的联合类型是「有哪些命令」的唯一事实源，定义在 lib/editor/shortcuts；
// 这里只做类型引用，键位默认值与匹配逻辑都不落在 types 层
import type { ShortcutId } from '../lib/editor/shortcuts';

// 过程展示档位是 process 域的一等值（定义在 types/process）；Settings 直接引用它，
// 避免 settings↔process 之间出现反向依赖。
import type { ProcessDetailLevel } from './process';

/**
 * 语音转录（STT）配置。
 *
 * ## 为什么不复用网关
 * 早期设计是「endpoint 留空 → 复用网关 `/audio/transcriptions`」。但引擎的
 * `serve` 进程**没有注册这个路由**（`nanobot/api/server.py` 只有 chat/models/
 * plugins/usage/dream/approvals/config），STT 在引擎侧只服务 channel 消息
 * （`channels/base.py::transcribe_audio`），客户端 HTTP 够不到。
 * 因此默认配置下那条请求**必然 404**。
 *
 * 现在的语义是「直连服务商」：`provider` 决定请求形状与默认 base，
 * `endpoint` 只在自建网关/代理时需要填。
 */
export interface TranscriptionConfig {
  /** 是否启用语音输入 */
  enabled: boolean;
  /**
   * 转录服务商（引擎注册表名，见 `lib/voice/providers.ts`）。
   *
   * 用 `string` 而非字面量联合：目录会随引擎升级增减，写死联合类型会让
   * 「引擎新增一家、客户端老版本」直接编译失败。非法值由 `findTranscriptionProvider`
   * 回退到 `custom`。
   */
  provider: string;
  /** 转录服务 endpoint（OpenAI 兼容前缀）；留空则用 provider 的默认地址 */
  endpoint: string;
  /** 转录模型名（如 whisper-1 / whisper-large-v3） */
  model: string;
  /** 转录服务 API Key（该服务商在公网时必填） */
  apiToken: string;
  /** 语言提示（ISO-639-1，如 zh / en）；留空由服务端自动检测 */
  language: string;
}

/**
 * 语音合成（TTS）配置：语音讨论时把模型回复念出来。
 *
 * ## 为什么单独一段而不是复用 `transcription`
 * 两者服务商可以不同（识别用 A 家、合成用 B 家），配额也是分开的——
 * 实测同一账号下 `qwen-audio-*` 能识别、`qwen3-tts-*` 却 `FreeTierOnly`，
 * 混在同一段配置里就只能「要么都能用要么都不能用」。
 *
 * ## 为什么字段是 `endpoint` + `apiToken` 而不是指向转录配置
 * 大多数部署会把两者指向同一个工作区地址，那时留空即可（解析时回退到
 * `transcription`），但**不能反过来**：一旦有人把 TTS 接到公网合成服务，
 * 回退链会把转录的凭据送出去。
 */
export interface TtsConfig {
  /**
   * 是否启用**云端**语音合成。
   *
   * 关掉之后仍可能听到系统语音（见 `fallbackToSystem`）；两者都关才是纯字幕。
   */
  enabled: boolean;
  /**
   * 合成服务地址。留空 = 地址与凭据一并沿用 `transcription`。
   *
   * 百炼的合成**不在** `/compatible-mode/v1` 下（实测该前缀无 TTS 路由），
   * 解析时会按域名换算到 `/api/v1/services/aigc/multimodal-generation/generation`。
   */
  endpoint: string;
  /** 合成模型（如 qwen3-tts-flash） */
  model: string;
  /** 音色（如 Cherry / Ethan） */
  voice: string;
  /** API Key；留空 = 沿用 `transcription.apiToken` */
  apiToken: string;
  /**
   * 云端失败时是否退回系统语音合成（`speechSynthesis`）。
   *
   * 默认开：额度用尽 / 网络不通时，用户宁可听到机械音也不要「AI 变成哑巴」。
   */
  fallbackToSystem: boolean;
}

/** 全局设置（持久化） */
export interface Settings {
  /** nanobot 网关 endpoint（OpenAI 兼容 API 前缀），默认 http://127.0.0.1:8765/v1 */
  gatewayEndpoint: string;
  /** nanobot apiToken / key */
  apiToken: string;
  /** UI 主题偏好：浅色 / 深色 / 跟随系统 */
  theme: 'light' | 'dark' | 'system';
  /**
   * 「模型工作步骤」的展示详略档位（`result` 聚焦结果 / `key` 关键细节 / `full` 完整过程）。
   *
   * 为什么它是**纯偏好、可跨设备同步**：它只表达「我想看多少细节」，与本机环境无关
   * （不含路径、凭据、端口），在任何一台设备上设置都同样成立——与 `theme` 同一口径，
   * 因此**不进** `SETTINGS_SYNC_OMIT_KEYS`。
   */
  processDetail: ProcessDetailLevel;
  /** 是否将 MEMORY.md 以标签块注入 system prompt 末尾（默认 true） */
  memoryEnabled: boolean;
  /** 会话结束时是否自动沉淀摘要（默认 false） */
  autoSummarize: boolean;
  /**
   * 是否按本轮问题做一次**跨会话召回**（默认 true）。
   *
   * 召回由**客户端按轮触发**（不是模型工具）：本项目没有「客户端向模型注册工具」的
   * 通道，加一个工具就要给引擎打补丁（见 `docs/prd-memory-v2.md` FR-M13a / FR-M25a）。
   * 代价是每轮多一次本机检索，因此给了这个开关——关掉之后只注入长期记忆，不检索历史会话。
   */
  memoryRecall: boolean;
  /**
   * 记忆 v2 的**蒸馏门槛**（FR-M5，记忆 · 进阶）。
   *
   * 嵌套对象：迁移时必须**单独补齐内层默认值**（与 `transcription` 同型）——
   * 浅合并拿不到内层，老用户升级后读 `memoryPolicy.retentionDays` 会拿到 undefined，
   * 而它参与日期运算（`undefined` 会算成 NaN，门槛静默失效）。
   *
   * **不同步**：各设备可以有自己的门槛（一台机器上「30 天才算稳定结论」，
   * 另一台想更激进的策略），它是策略而非事实。
   */
  memoryPolicy: import('./memory').MemoryPolicySettings;
  // —— 语音输入（STT）——
  /** 语音转录服务配置：未启用时 Composer 语音按钮禁用 */
  transcription: TranscriptionConfig;
  /**
   * 语音合成配置（语音讨论的播报）。
   *
   * **可选**：老配置里没有这段，解析时按「跟随 transcription」处理（见
   * `lib/voice/tts.ts::resolveTtsConfig`）。做成必填会逼所有既有测试夹具补字段，
   * 而它本身完全可以从已有配置推导出来。
   */
  tts?: TtsConfig;
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
  // —— 侧边栏菜单自定义顺序 ——
  /**
   * 一级菜单的显示顺序（「自定义菜单栏」拖拽结果）。
   *
   * 存**菜单 id**（见 `lib/ui/sidebarMenu` 的 `PrimaryMenuId`）而不是下标或文案：
   * 下标会在增删菜单项时整体错位，文案会在改文案时全部失效，两者都不报错，
   * 只表现为「顺序莫名其妙变了」。
   *
   * 语义是「用户偏好的排列」，因此它**可同步**（跨设备一致），与本机环境字段不同。
   * 兜底默认 `[]` = 用代码里的默认顺序；读取侧一律过 `normalizeMenuOrder` 补齐，
   * 老用户迁移见 settingsStore 的 v16。
   */
  primaryMenuOrder?: string[];
  /** 「更多」二级菜单的显示顺序，口径与 `primaryMenuOrder` 完全一致 */
  moreMenuOrder?: string[];
  // —— 快捷键（设置弹窗「快捷键」分区）——
  /**
   * 用户改键覆盖表：`ShortcutId → 键位串`（格式见 `lib/editor/shortcuts` 的文件头注释）。
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
