/**
 * 扩展（Extension）—— 对齐 WorkBuddy `resources/extensions/` 的那套宿主资产。
 *
 * ## 与「插件（Plugin）」的分工
 *
 * 两者都是"往宿主里装东西"，但补的是完全不同的两层：
 *
 * | | 插件（`~/.nanowork/plugins`） | 扩展（`~/.nanowork/extensions`） |
 * |---|---|---|
 * | 给谁用 | **模型**（技能 / 子代理 / MCP / prompt 片段） | **用户**（一块界面 / 一个后台服务） |
 * | 形态 | 一堆文本资产 + 清单 | `extension.json` + `ui/`（HTML）+ `server/`（node） |
 * | 生效面 | 系统提示词与工具面 | 侧边栏页面、产物预览器、设置项 |
 *
 * 一句话：插件改变"AI 会什么"，扩展改变"这个应用长什么样、能连什么"。
 *
 * ## 与 WorkBuddy 原版的差异（刻意的）
 *
 * 1. **不引入 Module Federation**。原版的 `ui.entry.url` 指向 `remoteEntry.js`，
 *    要求宿主提供 federation 运行时与共享依赖表——好处是扩展能复用宿主的 React，
 *    代价是版本强耦合（宿主升 React，所有扩展一起碎）。本项目改为**HTML 入口 +
 *    postMessage 桥**：扩展自带依赖、跑在自己的源里，宿主只提供"窗口"和几条消息协议。
 * 2. **服务默认不自动启动**。原版 `service.process: 'fork'` 随宿主启动。这里要求
 *    用户显式点「启动」——第三方 node 代码常驻不是默认该发生的事。
 * 3. **不做 `distribution.json` 的环境分发**（按 runEnv/edition 换 URL）。本项目
 *    没有多环境部署，加它只会多一层没人读的配置。
 */

/** 扩展来源：随应用 / 用户目录 */
export type ExtensionSource = 'builtin' | 'user';

/** 扩展清单里的 UI 入口 */
export interface ExtensionUiEntry {
  /** 侧边栏 / 标签页上显示的名字 */
  title: string;
  /** 图标：包内相对路径（图片）或 emoji */
  icon?: string;
  /**
   * 入口地址。两种取值：
   * - **包内相对路径**（必须 `.html`）：由 `nanowork-ext://` 协议提供；
   * - **http(s) 绝对地址**：直接加载（用户自己托管的扩展界面）。
   *
   * 其他协议（`file:` / `javascript:` / `data:`）一律拒绝——它们要么绕过沙箱，
   * 要么在执行上下文里做意料之外的事。
   */
  url: string;
  /** 切走后是否保留页面状态（对应原版的 `keepAlive`） */
  keepAlive: boolean;
}

/** 扩展提供的产物预览器（对应原版 `ui.artifactPreviews`） */
export interface ExtensionArtifactPreview {
  id: string;
  label: string;
  /** 匹配规则：产物 `kind` / `bizType` 命中即用这个预览器 */
  match: { bizType: string };
  /** 预览器页面：包内相对路径或 http(s) */
  url: string;
}

/** 扩展挂到宿主设置页的入口（对应原版 `ui.settings`） */
export interface ExtensionSettingsEntry {
  id: string;
  label: string;
  /** 宿主设置页的分区 id（找不到时界面会如实说明，不静默丢弃） */
  target: string;
}

/** 扩展声明的后台服务（对应原版 `service`） */
export interface ExtensionServiceSpec {
  /** 包内相对路径，必须是 `.cjs` / `.js` / `.mjs` 文件 */
  entry: string;
  /** 目前只支持 `fork`（与宿主同版本的 node 运行时） */
  process: 'fork';
  /**
   * 启动参数。
   *
   * 刻意**只允许字符串数组**、不允许 shell 语法：`fork` 不经过 shell，
   * 但把它当命令行拼字符串的写法会一路传下去，迟早有人在里面写 `&&`。
   */
  args?: string[];
}

/** 扩展清单（`extension.json` 的解析结果） */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  source: ExtensionSource;
  ui?: {
    entry?: ExtensionUiEntry;
    artifactPreviews?: ExtensionArtifactPreview[];
    settings?: ExtensionSettingsEntry[];
  };
  service?: ExtensionServiceSpec;
  /** 清单声明的权限（**仅展示**：真实裁决在宿主的 IPC 白名单与 iframe 沙箱） */
  permissions: string[];
}

/** 磁盘上的一个已安装扩展 */
export interface InstalledExtension {
  manifest: ExtensionManifest;
  /** 包根绝对路径 */
  root: string;
  /** 扫描阶段发现的清单问题（非致命；页面要显示出来） */
  issues: string[];
}

/** 扩展扫描结果 */
export interface ExtensionScanResult {
  extensions: InstalledExtension[];
  /** 有目录但清单坏掉的扩展（目录名） */
  skipped: string[];
  /** 扩展根目录；Web 端为空串 */
  extensionsRoot: string;
  /** 拿不到扩展能力时的原因（Web 端 / 目录不存在） */
  error?: string;
  /**
   * 装错结构的提示（非致命）。
   *
   * 目前只有一种：根目录下直接躺着 `extension.json`（复制时用了 `pkg/*` 而不是
   * `pkg`）。扫描器只遍历子目录，于是"一个扩展都看不见"，而目录里明明有文件——
   * 不说清楚的话用户只会以为功能没做。
   */
  hint?: string;
}

/** 安装扩展的结果（从本地目录复制成 `extensions/<id>`） */
export interface ExtensionInstallResult {
  ok: boolean;
  /** 安装后的扩展 id（= 目录名 = 协议 host） */
  id?: string;
  /** 安装后的绝对路径 */
  root?: string;
  error?: string;
  errorKind?: 'source-missing' | 'manifest-invalid' | 'already-installed' | 'escape' | 'io';
}

/** 后台服务状态 */
export type ExtensionServiceState = 'stopped' | 'starting' | 'running' | 'crashed';

/** 服务状态快照（含最近日志，用于排障） */
export interface ExtensionServiceStatus {
  id: string;
  state: ExtensionServiceState;
  /** 进程号（running 时才有） */
  pid?: number;
  /** 最近若干行输出（stdout + stderr 合并，环形缓冲） */
  log: string[];
  /** 停止原因 / 启动失败原因 */
  error?: string;
  /** 已经因崩溃重启过几次（到上限后不再自动重启） */
  restarts: number;
}

/** 服务动作结果 */
export interface ExtensionActionResult {
  ok: boolean;
  error?: string;
  status?: ExtensionServiceStatus;
}

/**
 * 宿主 ↔ 扩展页面的消息协议（`postMessage`）。
 *
 * 只有四条，刻意保持窄：扩展能拿到的宿主能力越少，出问题的面越小。
 * 所有消息都必须 `channel: 'nanowork-extension'`，其它一律忽略。
 */
export interface ExtensionHostMessage {
  channel: 'nanowork-extension';
  /** 宿主 → 扩展 */
  type: 'theme' | 'ready' | 'context';
  payload?: {
    theme?: 'light' | 'dark';
    extensionId?: string;
    /** 扩展根目录（服务端读写自己的 data 目录时要拼路径） */
    root?: string;
    /**
     * 宿主交给扩展的数据（仅 `type: 'context'` 时有值）。
     *
     * 目前只有一处：产物预览器被打开时，宿主把产物的元信息与正文快照递过去。
     * 扩展**读不到磁盘**（iframe 是独立源，没有文件系统），所以内容必须由宿主给；
     * 但只有文本快照能这么传，二进制大文件除外（见 `ExtensionPreviewAction`）。
     */
    context?: Record<string, unknown>;
  };
}

/** 扩展 → 宿主 */
export interface ExtensionGuestMessage {
  channel: 'nanowork-extension';
  type:
    // 请求把某个 URL 交给系统浏览器
    | 'open-external'
    // 请求调整 iframe 高度（自适应内容）
    | 'resize'
    // 扩展自己报一条状态（宿主在卡片上显示）
    | 'status';
  payload?: { url?: string; height?: number; text?: string };
}

/** 扩展 id 的合法形态：小写字母数字与连字符，首字符必须是字母数字 */
export const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 自定义协议名（iframe 的 src 前缀） */
export const EXTENSION_SCHEME = 'nanowork-ext';

/** 消息通道标识（两端共用，独立常量避免各写一个字面量拼错） */
export const EXTENSION_CHANNEL = 'nanowork-extension';
