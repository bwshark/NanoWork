/**
 * 插件（Plugin，FR-3.4）。
 *
 * ## 本文件是插件类型的**唯一声明处**
 *
 * 主进程（`electron/pluginPackage.ts`）、契约层（`src/platform/types.ts`）与
 * 界面都从这里取类型，各自不再写第二份。对齐 `McpToolInfo` 的做法：
 * 同一个事实写两遍必然漂移，而漂移的症状是「界面按 A 读、主进程按 B 写」，
 * 最难自查。主进程侧用相对路径 `../src/types/plugin` 做**类型导入**，
 * esbuild 会整段擦除，不会把渲染层代码打进 `main.cjs`。
 *
 * ## 一份清单，两个读者
 *
 * 插件包根只有一份 `plugin.json`（agent-plugins.org 规范）：引擎读它认得的
 * 子集（`$schema` / `name` / `description` / `extensions.dev.nanobot.*`），
 * 客户端读扩展字段（`version` / `category` / `main` / `permissions` /
 * `engines`）。不再造第二套 schema——那会让同一个包出现两份互相矛盾的清单。
 */

/** 声明的权限（展示用，不参与裁决：真实裁决在引擎的工具审批门） */
export interface PluginPermissions {
  /** 声明的工具（如 `Read` / `Write` / `Bash`） */
  tools: string[];
  /** 声明的网络目标（如 `docs.qq.com`） */
  network: string[];
}

/** 解析后的包根清单 */
export interface PluginManifest {
  /** 稳定标识（也是安装后的目录名） */
  name: string;
  /** 展示名，缺省回落 `name` */
  displayName: string;
  /** 语义化版本；清单没写时回落 `0.0.0` */
  version: string;
  /** 是否显式声明过版本（决定「版本锁定」是否可用） */
  versionDeclared: boolean;
  description: string;
  repository: string;
  category: string;
  /** 入口文档，默认 `SKILL.md` */
  main: string;
  permissions: PluginPermissions;
  /** `engines.nanowork` 兼容区间，如 `>=1.0.0`（空串 = 未声明） */
  engineRange: string;
  accentColor?: string;
  /** 打包图标（data URL；已校验格式与大小） */
  logo?: string;
  /** 清单 schema；非 agent-plugins.org 的包根本解析不到这里（会直接被拒） */
  schema: string;
  /** 实际命中的清单相对路径（`plugin.json` / `.nanowork-plugin/plugin.json`） */
  manifestRelPath: string;
}

/** 资源分组标识（PRD §12.2 的能力类别） */
export type PluginResourceId =
  | 'skill'
  | 'agents'
  | 'experts'
  | 'skills'
  | 'commands'
  | 'hooks'
  | 'mcp'
  | 'prompt'
  | 'scripts'
  | 'assets';

/** 一个资源分组的盘点结果 */
export interface PluginResourceGroup {
  id: PluginResourceId;
  /** 中文标签（界面直接展示） */
  label: string;
  count: number;
  /** 条目名（可能被上限截断，见 `truncated`） */
  names: string[];
  /** 是否因条目上限被截断 */
  truncated: boolean;
}

/** 磁盘上的一个已安装插件包 */
export interface InstalledPlugin {
  manifest: PluginManifest;
  /** 包根绝对路径 */
  root: string;
  resources: PluginResourceGroup[];
  /** 安装时间（取自包根 mtime，ISO 字符串） */
  installedAt?: string;
}

/** 安装结果 */
export interface PluginInstallResult {
  ok: boolean;
  /** 安装后的包根 */
  root?: string;
  manifest?: PluginManifest;
  /** 失败原因（面向用户，已本地化） */
  error?: string;
  /** 失败分类，便于界面区分「用户可修」与「包本身有问题」 */
  errorKind?:
    | 'source-missing'
    | 'manifest-invalid'
    | 'already-installed'
    | 'escape'
    | 'io';
}

/**
 * 引擎侧的激活状态（`GET /v1/plugins` 的 `enabled`）。
 *
 * **为什么客户端不自己算**：引擎的激活标记是**指纹绑定**的（包内容变了标记就
 * 失效），客户端复刻这套哈希等于把「唯一权威」变成两份可能不一致的真相。
 * 因此这里只有三态：有答案、没答案、还没问过。
 */
export type PluginActivation = 'active' | 'inactive' | 'unknown';

/**
 * 本地意图（`settings.enabledPlugins`）与引擎实际激活的偏差。
 *
 * 偏差**不自动对齐**，只在界面上显式提示——静默对齐会让「用户明明启用了却
 * 没生效」变成一次无痕的自我治愈，问题从此查不出来（同一教训见技能三态覆盖的
 * `syncError`）。
 */
export type PluginDrift =
  /** 本地想启用、引擎也激活 = 一致 */
  | 'in-sync'
  /** 本地想启用、引擎没激活：多半是包内容变了导致指纹失效，需重新启用 */
  | 'intent-only'
  /** 引擎激活、本地意图里没有：在 WebUI 里启用过 */
  | 'engine-only'
  /** 本地不启用、引擎也不激活 = 一致 */
  | 'both-off'
  /** 问不到引擎（网关没起 / 非 Electron） */
  | 'unknown';

/**
 * 一个插件的**来源与生效版本**（FR-3.8）。
 *
 * 版本隔离之后「装了个插件」不再是一件事而是两件：市场里有哪几个版本
 * （`marketplaces/<m>/<n>/<v>/`）、当前生效的是哪个（`cache/<m>/<n>/<v>/` + 指针）。
 * 界面必须能把这两件事分开讲——否则「升级了但会话还在跑旧版」无从解释。
 *
 * `market: null` = **本地平铺安装**（`plugins/<name>/`），不归任何市场管。
 */
export interface PluginSource {
  market: string | null;
  /** 生效副本的版本；本地安装时就是包自己声明的版本 */
  version: string | null;
}

/** 引擎上报的一条插件 */
export interface PluginEngineEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  enabled: boolean;
  /** 该插件注册进引擎的 MCP server 名（`<plugin>--<server>`） */
  mcpServers: string[];
  /** 该副本来自哪个市场（null = 本地平铺安装） */
  market: string | null;
  /** 该副本的版本（null = 说不上来，不要猜） */
  version: string | null;
}

/** 引擎侧插件索引：一次 `GET /v1/plugins` 的结果 */
export interface PluginEngineIndex {
  /** 是否拿到了权威答案（网关不可达 / 非 Electron 时为 false） */
  available: boolean;
  entries: PluginEngineEntry[];
  /** 拿不到时的原因（`available=false` 时） */
  error?: string;
}

/**
 * 界面用的合并视图：磁盘事实 + 引擎状态 + 意图。
 *
 * 三者刻意分开存：磁盘是「装了什么」，引擎是「实际激活没有」，意图是
 * 「用户想启用吗」。合成一个布尔值会让任何一种不一致都无法表达。
 */
export interface PluginView {
  plugin: InstalledPlugin;
  /** 引擎侧激活状态 */
  activation: PluginActivation;
  /** 本地意图：`settings.enabledPlugins` 里是否含该插件 */
  intended: boolean;
  drift: PluginDrift;
  /** 声明的引擎兼容区间不满足当前客户端版本（`false` = 未声明或满足） */
  engineIncompatible: boolean;
  /**
   * 生效副本的来源与版本。
   *
   * 优先采信引擎上报；引擎不可达时按包路径兜底（见 `sourceFromPath`）。
   * 灰着不渲染，界面只在一张卡片上占一个 chip。
   */
  source: PluginSource;
}

/** 扫描结果（IPC `plugins:scan` 的返回） */
export interface PluginScanResult {
  plugins: InstalledPlugin[];
  /** 解析失败被跳过的目录名（一个坏包不该让界面看起来「什么都没装」） */
  skipped: string[];
  /** 扫描的插件根绝对路径（便于用户定位） */
  pluginsRoot: string;
}

/**
 * 市场来源类型（FR-3.7）。
 *
 * `directory` **永不联网**（本地一个目录就是全部内容）；`remote` 要从 URL 拉 zip，
 * 拉不到时保留上次索引并记 `lastError`——这两种生命周期完全不同，是
 * 「能否离线 / 失败怎么办」的唯一判据。
 */
export type MarketplaceType = 'directory' | 'remote';

/**
 * 写入注册表的输入形状（`addMarket` 的入参）。
 *
 * `lastSyncAt` / `lastError` 是**同步的产出**，由主进程写；界面拿不到也不该伪造——
 * 伪造一个假的 `lastSyncAt` 会让「上次同步」显示成用户从没点过的时刻。
 */
export type MarketplaceInput = Omit<MarketplaceEntry, 'lastSyncAt' | 'lastError'>;

/** 注册表里的一个市场（`~/.nanowork/plugins/registry.json`） */
export interface MarketplaceEntry {
  /** 稳定 id（也是 `marketplaces/` 下的目录名） */
  id: string;
  name: string;
  type: MarketplaceType;
  /** `directory`：绝对目录路径；`remote`：zip 地址 */
  location: string;
  /** 随应用分发（不可删除、不联网） */
  isBuiltIn: boolean;
  /** 启动时自动刷新（false = 只有用户点刷新时才拉） */
  autoUpdate: boolean;
  /** 上次同步成功时刻（ISO）；从未同步过为 null */
  lastSyncAt: string | null;
  /** 上次同步的失败原因；成功为 null */
  lastError: string | null;
}

/** 市场注册表文件形状 */
export interface MarketRegistry {
  version: number;
  markets: MarketplaceEntry[];
}

/** 市场里的一个包（同步后才知道有哪些包、哪一版） */
export interface MarketPackage {
  name: string;
  displayName: string;
  version: string;
  description: string;
  /**
   * 市场索引（`marketplace.json`）给出的分类。
   *
   * **可选**：没有索引文件的市场照样能用，此时为 `undefined`。刻意不落成 `''`——
   * 「市场没写分类」与「分类是空串」在界面上该是两回事（前者不显示徽标）。
   */
  category?: string;
  /**
   * 该插件依赖的**插件名**列表（来自市场索引）。
   *
   * 索引里没有这个包时也是 `undefined`：索引是**可选元数据**，不是白名单
   * ——不认识的包照样按单包安装（见 `resolveInstallOrder` 的注释）。
   */
  dependencies?: string[];
}

/** 一个市场的源侧索引 */
export interface MarketIndex {
  market: string;
  packages: MarketPackage[];
  /** 坏包（清单缺失或不合规）的目录名 */
  skipped: string[];
}

/** 一次市场同步的结果 */
export interface MarketSyncResult {
  ok: boolean;
  market: string;
  synced: number;
  skipped: string[];
  error?: string;
}

/** 从市场安装（materialize 某一版 + 拨指针）的结果 */
export interface MarketInstallResult {
  ok: boolean;
  market: string;
  name: string;
  version: string;
  /** 生效副本的绝对路径（成功时） */
  path: string;
  /**
   * 本次实际安装的清单，**按安装顺序**（依赖在前，目标最后），形如 `['mcp-miora@1.2.0', 'welcomemode-design@1.0.0']`。
   *
   * 只有在市场索引声明了依赖时才会出现多项；没有索引 / 没有依赖时与旧行为一样
   * （一项，就是目标自己）。失败时是**已经装成功的那几项**——那时它比 `error`
   * 更有用：用户要知道「装到一半停在哪了」。
   */
  installed?: string[];
  error?: string;
}

/** 缓存回收结果 */
export interface MarketGcResult {
  removed: string[];
  kept: string[];
}

/** 一次同步的回报（结果 + 回写后的条目，界面据此更新徽标） */
export interface MarketSyncOutcome {
  ok: boolean;
  result: MarketSyncResult;
  entry: MarketplaceEntry;
  error?: string;
}
