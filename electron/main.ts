import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, safeStorage, shell } from 'electron';
import { dirname, extname, join } from 'node:path';
import { promises as fs, existsSync, readFileSync, watch as fsWatch, type Dirent } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { parseWebuiResponseFrame } from './webuiFrames';
import { normalizeEngineChannelAllowFrom } from './channelAllowFrom';
import { disconnectChannelInConfig, resolveWeixinAccountPath, type DisconnectChannelKind } from './channelDisconnect';
import {
  initTray,
  updateTrayOptions,
  destroyTray,
  refreshTrayMenu,
  isTrayReady,
} from './tray';
import { registerHotkey, unregisterAllHotkeys } from './hotkey';
import type {
  ChannelSendParams,
  ChannelSendResult,
  DesktopConfig,
  DesktopConfigResult,
  DiskUsage,
  EventAppendParams,
  EventAppendResult,
  NanobotChannelSessionDetail,
  NanobotChannelSessionSummary,
  NanobotCronHistoryDeleteResult,
  NanobotCronRunRecord,
  NanobotCronSessionDetail,
  StorageInfo,
} from '../src/platform/types';
import {
  DEVICE_ID_STORAGE_KEY,
  knownRouteFiles,
  memoryDir,
  miscDir,
  productDir,
  resolveRoute,
  resolveWriteTarget,
  serializeRouteValue,
  unwrapLegacyValue,
  type StorageRoots,
} from './storageRoutes';
import { createEventStore } from './eventStore';
import { CredentialVault, safeStorageCipher } from './credentialVault';
import { probeMcpServer, type McpProbeRequest } from './mcpProbe';
import {
  installPluginPackage,
  readInstalledPlugins,
  uninstallPluginPackage,
} from './pluginPackage';
import type { SessionMeta } from '../src/types/event';

const isDev = !app.isPackaged;

/** 两个持久化根的来源：① 用户资产取 home，② 运行时数据取 Electron userData */
const STORAGE_ROOTS: StorageRoots = {
  home: app.getPath('home'),
  electronUserData: app.getPath('userData'),
};

/** 设置 store 的持久化 key（与渲染层 STORAGE_KEYS.settings 一致） */
const SETTINGS_STORE_KEY = 'nanowork.settings';

/**
 * 旧版单文件持久化 blob：`{ '<storage key>': '<JSON 字符串>' }`。
 * 仅用于**一次性迁移**（见 migrateLegacyStore）与迁移未完成时的读取回退；
 * 迁移成功后会被改名为 `nanowork-store.json.migrated` 保留备查。
 */
const LEGACY_STORE_FILE = join(app.getPath('userData'), 'nanowork-store.json');

/**
 * 用户本地技能目录：`~/.nanowork/skills`，每个子目录含一份 SKILL.md。
 *
 * 这是 NanoWork 自有目录，与 WorkBuddy 的 `~/.workbuddy/skills` 无关——
 * 刻意不做旧路径回退，避免与外部产品产生隐性耦合（两者技能格式虽同源，
 * 但归属与生命周期各自独立）。用户如需复用既有技能，应显式迁移目录内容。
 */
const USER_SKILLS_DIR = join(productDir(STORAGE_ROOTS), 'skills');

/**
 * 用户级插件目录：`~/.nanowork/plugins`，每个子目录是一个插件包
 * （包根一份 `plugin.json`）。
 *
 * **必须与引擎的 `default_user_plugins_dir()` 指向同一处**，否则会出现
 * 「界面装上了、引擎看不见」——这是本功能最容易踩的坑。引擎的实现读
 * `NANOWORK_HOME` / `CODEBUDDY_HOME` 作为基址（不是 `/.nanowork` 后缀），
 * 这里照抄同一套取法：网关是 Electron 的子进程，环境变量会继承，
 * 用户在 shell 里设了基址时两边仍然一致。
 */
const USER_PLUGINS_DIR = join(
  process.env.NANOWORK_HOME || process.env.CODEBUDDY_HOME || productDir(STORAGE_ROOTS),
  'plugins',
);

/**
 * 连接器凭据保险库：`~/.nanowork/connectors/.credentials.v3.json`。
 *
 * 密钥值只在这里与 `nanowork.config.json`（引擎消费必需）出现，且保险库那份
 * 由 `safeStorage` 加密（OS 凭据库托管密钥，即 PRD §12.7 里 `.master.key` 的角色）。
 * 渲染层的持久化镜像与 IPC 回读**都拿不到值**，只有密钥名清单。
 *
 * 注意落点：`connectors/` 属用户资产，已在 `storageRoutes.ts` 的
 * `CLEAR_EXEMPT_KEYS` 精神之内——「清空存储」不得连带删除凭据。
 */
const CONNECTOR_SECRETS_FILE = join(
  productDir(STORAGE_ROOTS),
  'connectors',
  '.credentials.v3.json',
);

const credentialVault = new CredentialVault({
  filePath: CONNECTOR_SECRETS_FILE,
  cipher: safeStorageCipher({
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (blob) => safeStorage.decryptString(blob),
  }),
});

// ——————————————————————————————————————————————
// 持久化存储：按 key 路由到 ① / ② 的独立文件
//
// 落点规则集中在 electron/storageRoutes.ts（纯模块，有单测覆盖），
// 这里只负责 IO：读文件、写文件、迁移旧 blob。
// ——————————————————————————————————————————————

/** 逐文件串行写队列：避免同文件的 read-modify-write 交叉导致丢失更新 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(filePath: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  // 前一任务失败不应阻断后续写入，故成功/失败分支都续接
  const next = previous.then(task, task);
  writeQueues.set(
    filePath,
    next.catch(() => undefined),
  );
  return next;
}

/** 读取落点文件原文；不存在返回 null，其余错误照抛（不吞 EACCES 等问题） */
async function readRouteFile(key: string): Promise<string | null> {
  const { filePath } = resolveRoute(key, STORAGE_ROOTS);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 按落点写入（自动建父目录 + 按 key 串行化） */
async function writeRouteFile(key: string, value: string): Promise<void> {
  const route = resolveRoute(key, STORAGE_ROOTS);
  let text: string;
  try {
    text = serializeRouteValue(value, route);
  } catch (err) {
    // 值形态与落点不符（典型：裸文本写进了 json 路由）时补上 key 再抛。
    // 裸 JSON.parse 报错只有「position N」这种位置信息，日志里定位不到是谁写的。
    throw new Error(
      `[storage] key「${key}」的值与落点形态不符，无法写入 ${route.filePath}：${err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  await enqueueWrite(route.filePath, async () => {
    await fs.mkdir(dirname(route.filePath), { recursive: true });
    await fs.writeFile(route.filePath, text, 'utf-8');
  });
}

/** 读取持久化值：文件原文即调用方写盘前的文本，原样返回（见 storageRoutes 编解码约定） */
async function readPersistedValue(key: string): Promise<string | null> {
  const text = await readRouteFile(key);
  if (text !== null) return text;
  // 新落点尚未生成：可能是尚未迁移的旧数据，命中则顺手补迁
  const legacy = await readLegacyValue(key);
  if (legacy === undefined) return null;
  try {
    const normalized = unwrapLegacyValue(legacy);
    await writeRouteFile(key, normalized);
    return serializeRouteValue(normalized, resolveRoute(key, STORAGE_ROOTS));
  } catch (err) {
    // 旧值本身损坏（非合法 JSON）时不能让整个读取失败，退回原始值交给上层解析
    console.warn(`[storage] 补迁移 ${key} 失败，本次按旧形态返回：`, err);
    return legacy;
  }
}

/** 旧 blob 的内存缓存；undefined = 未加载，null = 不存在/读取失败 */
let legacyCache: Record<string, string> | null | undefined;

async function loadLegacyStore(): Promise<Record<string, string>> {
  if (legacyCache !== undefined) return legacyCache ?? {};
  try {
    const parsed = JSON.parse(
      await fs.readFile(LEGACY_STORE_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    legacyCache = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    legacyCache = null;
  }
  return legacyCache ?? {};
}

async function readLegacyValue(key: string): Promise<string | undefined> {
  const store = await loadLegacyStore();
  return key in store ? store[key] : undefined;
}

/**
 * 一次性把旧单文件 blob 迁移到新落点。
 *
 * 迁移策略刻意保守：
 * - **不覆盖**新落点已有数据的 key（新数据优先，避免迁移回滚用户后续操作）；
 * - 完成后把旧文件**改名**而非删除（`.migrated` 后缀），保留可回滚的证据；
 * - 单个 key 失败不影响其余 key，仅告警。
 */
async function migrateLegacyStore(): Promise<void> {
  let legacy: Record<string, string>;
  try {
    legacy = JSON.parse(await fs.readFile(LEGACY_STORE_FILE, 'utf-8')) as Record<
      string,
      string
    >;
  } catch {
    return; // 新装用户没有旧文件，属正常情况，不告警
  }

  let migrated = 0;
  let skipped = 0;
  for (const [key, value] of Object.entries(legacy)) {
    if (typeof value !== 'string') continue;
    try {
      if ((await readRouteFile(key)) !== null) {
        skipped += 1;
        continue;
      }
      // 旧值比新契约多一层字符串编码，剥掉后再落盘
      await writeRouteFile(key, unwrapLegacyValue(value));
      migrated += 1;
    } catch (err) {
      console.warn(`[storage] 迁移 ${key} 失败：`, err);
    }
  }

  try {
    await fs.rename(LEGACY_STORE_FILE, `${LEGACY_STORE_FILE}.migrated`);
  } catch (err) {
    console.warn('[storage] 旧存储文件改名失败，下次启动会重试：', err);
    return;
  }
  legacyCache = undefined; // 让回退读取重新落到已改名的文件（即读不到）
  console.log(
    `[storage] 旧存储已迁移：${migrated} 项写入 ①/②，${skipped} 项因新落点已有数据而跳过`,
  );
}

/**
 * 同步读取持久化值（`createWindow` 之前调用，此时异步 IO 尚未就绪）。
 * 优先新落点；若尚未生成则回退旧 blob（并剥掉旧值多余的一层编码），
 * 保证升级后首帧主题/快捷键不丢。
 */
function readPersistedValueSync(key: string): string | null {
  const route = resolveRoute(key, STORAGE_ROOTS);
  try {
    return readFileSync(route.filePath, 'utf-8');
  } catch {
    try {
      const store = JSON.parse(readFileSync(LEGACY_STORE_FILE, 'utf-8')) as Record<
        string,
        string
      >;
      return typeof store[key] === 'string' ? unwrapLegacyValue(store[key]) : null;
    } catch {
      return null;
    }
  }
}

/**
 * 解析设置 store 的持久化文档（zustand persist 包装成 `{ state, version }`）。
 *
 * 新落点里 `settings.json` 就是这个文档本身，解析一次即可；旧 blob 的值多一层
 * 字符串编码，`readPersistedValueSync` 已用 `unwrapLegacyValue` 剥掉，
 * 故这里无需再做「试着多解一层」的猜测。解析失败返回 null 由调用方兜底。
 */
function parseSettingsDocument(raw: string | null): {
  state?: { settings?: { theme?: unknown; desktop?: Partial<DesktopConfig> } };
} | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as {
        state?: { settings?: { theme?: unknown; desktop?: Partial<DesktopConfig> } };
      })
      : null;
  } catch {
    return null;
  }
}

/**
 * 创建窗口前同步读取持久化主题偏好（用于初始背景色，避免冷启动闪烁）。
 * 落点：① `~/.nanowork/settings.json`（见 storageRoutes），内容为 zustand persist
 * 的包装 `{ state: { settings: { theme } }, version }`。仅 light/dark 有效，
 * system/缺失/任何解析异常均返回 null，由调用方回落 nativeTheme。
 */
function readPersistedTheme(): 'light' | 'dark' | null {
  const theme = parseSettingsDocument(readPersistedValueSync(SETTINGS_STORE_KEY))?.state
    ?.settings?.theme;
  return theme === 'light' || theme === 'dark' ? theme : null;
}

/** 初始窗口背景色：持久化偏好优先，其余情况跟随系统外观 */
function pickInitialBackgroundColor(): string {
  const persisted = readPersistedTheme();
  if (persisted === 'light') return '#f5f7fa';
  if (persisted === 'dark') return '#0b1120';
  return nativeTheme.shouldUseDarkColors ? '#0b1120' : '#f5f7fa';
}

// ——————————————————————————————————————————————
// 事件流存储（D2）：append-only 事件流成为事实源
//
// 落点规则见 electron/eventRoutes.ts，索引纯逻辑见 electron/eventIndex.ts，
// IO 层在 electron/eventStore.ts（只依赖 node:fs，有单测覆盖），此处仅持有实例。
// ——————————————————————————————————————————————

const eventStore = createEventStore(STORAGE_ROOTS);

// ——————————————————————————————————————————————
// 桌面端集成：系统托盘 + 全局快捷键
// ——————————————————————————————————————————————

/** 桌面端配置默认值（与渲染层 DEFAULT_DESKTOP 保持一致） */
const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  closeToTray: true,
  hotkey: 'Ctrl+Alt+S',
  openAtLogin: false,
  showInDock: true,
};

/**
 * 冷启动同步读取持久化的桌面端配置（① settings.json → state.settings.desktop）。
 * 必须在建窗前拿到：否则全局快捷键要等渲染层启动后才注册，
 * 中间存在"窗口已隐藏但快捷键唤不起"的空窗期。任何解析异常回落默认值。
 */
function readPersistedDesktopConfig(): DesktopConfig {
  const desktop = parseSettingsDocument(readPersistedValueSync(SETTINGS_STORE_KEY))?.state
    ?.settings?.desktop;
  if (!desktop || typeof desktop !== 'object') return { ...DEFAULT_DESKTOP_CONFIG };
  return {
    closeToTray:
      typeof desktop.closeToTray === 'boolean'
        ? desktop.closeToTray
        : DEFAULT_DESKTOP_CONFIG.closeToTray,
    hotkey: typeof desktop.hotkey === 'string' ? desktop.hotkey : DEFAULT_DESKTOP_CONFIG.hotkey,
    openAtLogin:
      typeof desktop.openAtLogin === 'boolean'
        ? desktop.openAtLogin
        : DEFAULT_DESKTOP_CONFIG.openAtLogin,
    showInDock:
      typeof desktop.showInDock === 'boolean'
        ? desktop.showInDock
        : DEFAULT_DESKTOP_CONFIG.showInDock,
  };
}

/** 当前生效的桌面端配置（运行时可被渲染层热更新） */
let desktopConfig: DesktopConfig = readPersistedDesktopConfig();

/**
 * 是否处于"真正退出"流程。
 * 用于区分「关闭窗口 → 隐藏到托盘」与「托盘菜单退出 / Cmd+Q → 结束进程」：
 * macOS 上 Cmd+Q 同样会派发窗口 close 事件，不设此标志会被拦截导致退不出。
 */
let isQuitting = false;

/** 桌面端配置快照：开机自启取系统真实状态（用户可能在系统设置里改过） */
function desktopConfigSnapshot(): DesktopConfig {
  return { ...desktopConfig, openAtLogin: app.getLoginItemSettings().openAtLogin };
}

let mainWindow: BrowserWindow | null = null;

/** 托盘提示是否已提示过（只在首次隐藏时告知用户，避免反复打扰） */
let trayHintShown = false;

/**
 * 首次隐藏到托盘时给一条系统通知。
 * 关闭按钮行为从"退出"变成"隐藏"是隐性变化，不提示用户会以为程序卡死或退出了。
 */
function trayHintOnce(): void {
  if (trayHintShown) return;
  trayHintShown = true;
  try {
    new Notification({
      title: app.getName(),
      body: '已最小化到系统托盘，点击托盘图标即可重新唤起',
    }).show();
  } catch {
    // 通知不可用（如部分 Linux 桌面环境）时静默降级
  }
}

/** 显示并聚焦主窗口（窗口被隐藏、最小化或失焦时唤起；已销毁则重建） */
function showMainWindow(): void {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * 主窗口显隐切换（托盘单击与全局快捷键共用同一逻辑）：
 * - 已显示且聚焦 → 隐藏到托盘；
 * - 最小化 / 已隐藏 / 失焦 → 恢复显示并聚焦。
 */
function toggleMainWindow(): void {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    // 窗口状态变了，托盘菜单首项文案（显示/隐藏）需同步
    refreshTrayMenu();
    return;
  }
  showMainWindow();
  refreshTrayMenu();
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // 初始背景色：优先读持久化偏好，其次跟随系统外观，避免冷启动闪烁（渲染层后续自行应用主题）
    backgroundColor: pickInitialBackgroundColor(),
    icon: join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 允许从 file:// 页面访问本地 nanobot 网关（http://127.0.0.1:8900），避免 CORS 导致离线
      webSecurity: false,
    },
  });

  if (isDev) {
    mainWindow?.webContents.openDevTools({ mode: 'detach' })
    const devUrl = process.env.ELECTRON_DEV_URL;
    if (devUrl) {
      await mainWindow.loadURL(devUrl);
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
      // 默认加载 vite build 产物（electron:serve / 调试时均走此分支）
      await mainWindow.loadFile(join(__dirname, '../dist/index.html'));
    }
  } else {
    await mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 关闭按钮：默认改为隐藏到托盘（微信/钉钉式后台常驻），真正退出走托盘菜单「退出」。
  // isQuitting 为 true（app.quit / Cmd+Q / 托盘退出）或用户关闭该行为时不拦截。
  mainWindow.on('close', (e) => {
    if (isQuitting || !desktopConfig.closeToTray) return;
    e.preventDefault();
    mainWindow?.hide();
    trayHintOnce();
    refreshTrayMenu();
  });

  // 窗口显隐变化后同步托盘菜单首项文案（显示窗口 / 隐藏窗口）
  mainWindow.on('show', () => refreshTrayMenu());
  mainWindow.on('hide', () => refreshTrayMenu());

  // 最大化状态变化向渲染层推送（驱动自绘标题栏控件图标切换）
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximize-change', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximize-change', false));
}

// ——————————————————————————————————————————————
// nanobot 网关子进程管理（P2：桌面端自动拉起）
// ——————————————————————————————————————————————

/** nanobot API 服务子进程句柄（serve，提供 /v1，单例） */
let nanobotProcess: ChildProcess | null = null;

/**
 * nanobot 网关子进程句柄（gateway，承载 IM channels 与长连接，单例）。
 * serve 只提供 /v1 API、不启动任何 channel；飞书等机器人的长连接
 * 运行在 gateway 进程中，两者必须同时拉起智能体才能与机器人对话。
 */
let nanobotGatewayProcess: ChildProcess | null = null;

/** 应用启动时的首次网关拉起 Promise（channels 同步需等其结束，避免竞态） */
let nanobotStartupPromise: Promise<boolean> | null = null;

/** 最近一次成功启动网关所用的配置文件路径（channels 同步时合并写入该文件） */
let lastNanobotConfigPath: string | undefined;

/** nanobot 启动配置（bin/host/port 与可选的 config.json 路径） */
interface NanobotLaunchConfig {
  bin: string;
  host: string;
  port: string;
  config?: string;
}

/** 项目本地兜底配置：nanobot/nanobot/.venv 里的可执行文件 + 项目根 nanowork.config.json */
function fallbackLaunchConfig(): NanobotLaunchConfig {
  const root = join(__dirname, '..');
  const venvBin =
    process.platform === 'win32'
      ? join(root, 'nanobot', 'nanobot', '.venv', 'Scripts', 'nanobot.exe')
      : join(root, 'nanobot', 'nanobot', '.venv', 'bin', 'nanobot');
  const bin = existsSync(venvBin) ? venvBin : 'nanobot';
  return { bin, host: '127.0.0.1', port: '8900', config: join(root, 'nanowork.config.json') };
}

/**
 * 读取 nanobot 启动配置。
 * 优先级：环境变量 > userData/nanowork.nanobot.json > 项目本地兜底。
 * userData 配置未显式给出 config 时同样回退项目本地 nanowork.config.json，
 * 保证 channels 同步有确定的合并目标。
 */
async function readNanobotConfig(): Promise<NanobotLaunchConfig> {
  const env = {
    bin: process.env.NANOBOT_BIN,
    host: process.env.NANOBOT_HOST,
    port: process.env.NANOBOT_PORT,
  };
  if (env.bin && env.host && env.port) {
    return { bin: env.bin, host: env.host, port: env.port };
  }
  try {
    const cfgPath = join(app.getPath('userData'), 'nanowork.nanobot.json');
    const raw = await fs.readFile(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw) as Partial<{ bin: string; host: string; port: string; config: string }>;
    return {
      bin: cfg.bin ?? 'nanobot',
      host: cfg.host ?? '127.0.0.1',
      port: cfg.port ?? '8900',
      config: cfg.config ?? fallbackLaunchConfig().config,
    };
  } catch {
    return fallbackLaunchConfig();
  }
}

/**
 * 清理传给 nanobot 子进程的环境：
 * 删除指向不存在文件的 CA 证书环境变量（SSL_CERT_FILE / REQUESTS_CA_BUNDLE 等）。
 * 这些变量若指向缺失文件，httpx 建立 HTTPS 连接时会抛
 * `FileNotFoundError: [Errno 2] No such file or directory`，导致对话全部失败。
 * 删掉后 Python 会回退到 venv 内 certifi 自带的有效证书包。
 * 代理变量（HTTPS_PROXY 等）予以保留，避免破坏需要代理才能出网的场景。
 */
function sanitizeGatewayEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const caFileVars = ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTPLIB2_CA_CERTS'];
  for (const key of caFileVars) {
    const val = env[key];
    if (val && !existsSync(val)) delete env[key];
  }
  // SSL_CERT_DIR 是目录，缺失同样会让 ssl 上下文初始化失败
  const certDir = env['SSL_CERT_DIR'];
  if (certDir && !existsSync(certDir)) delete env['SSL_CERT_DIR'];
  return env;
}

/** 探测 host:port 是否已有服务在监听（避免重复拉起 nanobot 造成端口冲突） */
function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.setTimeout(1500, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * 子进程拉起后等待其端口进入监听的默认上限。
 * 实测 `nanobot serve` 从 spawn 到 listen 约 9.4 秒
 * （Python 导入依赖 + 注册工具 + 连接 MCP），留约 3 倍余量。
 */
const LAUNCH_READY_TIMEOUT_MS = 30_000;

/**
 * 轮询等待 host:port 进入监听（服务真正就绪）。
 * spawn 返回只代表进程已创建，nanobot 是 Python 进程还需数秒才会 listen；
 * 此处必须等到端口可连，否则渲染层的首次探测会直接 ECONNREFUSED。
 * @param host 目标主机
 * @param port 目标端口
 * @param timeoutMs 等待上限
 * @param aborted 可选中断判据（如子进程已退出），返回 true 立即放弃等待
 * @returns 是否在超时前进入监听
 */
async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number,
  aborted?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    if (await isPortInUse(host, port)) return true;
    if (aborted?.()) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 启动 nanobot 网关子进程；若本机未安装则记录警告并返回 false（不影响主程序） */
async function startNanobot(): Promise<boolean> {
  if (nanobotProcess) return true;
  const { bin, host, port, config } = await readNanobotConfig();
  lastNanobotConfigPath = config;
  // 端口已被占用（用户手动拉起过 / 上一实例未退出）→ 直接复用，避免 10048 冲突
  if (await isPortInUse(host, Number(port))) {
    console.log(`[nanobot] ${host}:${port} 已有网关在监听，复用既有服务，不重复拉起`);
    return true;
  }
  try {
    const serveArgs = ['serve', '--host', host, '--port', port];
    if (config && existsSync(config)) {
      serveArgs.push('--config', config, '-v');
    }
    nanobotProcess = spawn(bin, serveArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: sanitizeGatewayEnv(),
    });
    nanobotProcess.stdout?.on('data', (d) => console.log(`[nanobot] ${d.toString().trim()}`));
    nanobotProcess.stderr?.on('data', (d) => console.warn(`[nanobot] ${d.toString().trim()}`));
    nanobotProcess.on('exit', (code) => {
      console.log(`[nanobot] 进程退出 code=${code}`);
      nanobotProcess = null;
    });
    // 等到端口真正进入监听再返回：只等固定 800ms 会让渲染层的首次探测
    // 必然 ECONNREFUSED，从而被固化成「网关离线」（子进程却已在运行）。
    const ready = await waitForPort(host, Number(port), LAUNCH_READY_TIMEOUT_MS, () =>
      nanobotProcess === null,
    );
    if (!ready) {
      console.warn(
        `[nanobot] ${host}:${port} 在 ${LAUNCH_READY_TIMEOUT_MS / 1000} 秒内未进入监听（进程可能已退出）`,
      );
    }
    return ready;
  } catch (err) {
    console.warn(`[nanobot] 启动失败（可能未安装 nanobot）：${String(err)}`);
    nanobotProcess = null;
    return false;
  }
}

/**
 * 结束单个 nanobot 子进程（Windows 下经 shell 拉起，需 taskkill 递归结束进程树）。
 * @param proc 目标子进程句柄
 */
function killNanobotProcess(proc: ChildProcess): void {
  const pid = proc.pid;
  try {
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    /* ignore */
  }
}

/** 停止 nanobot API 服务子进程（serve） */
function stopNanobot(): void {
  if (nanobotProcess) {
    killNanobotProcess(nanobotProcess);
    nanobotProcess = null;
  }
}

/** 停止 nanobot 网关子进程（gateway，承载 IM channels 长连接） */
function stopNanobotGateway(): void {
  if (nanobotGatewayProcess) {
    killNanobotProcess(nanobotGatewayProcess);
    nanobotGatewayProcess = null;
  }
}

/**
 * 启动 nanobot 网关子进程（gateway 命令，前台模式）。
 * 与 serve 独立：serve 只提供 /v1 API，gateway 才启动 channels
 * （飞书/钉钉/企微/微信长连接 + websocket 频道 + WebUI 设置路由）。
 * 网关默认监听 18790（health），websocket 频道监听 9900，均不与 serve 的 8900 冲突。
 * @returns 是否成功拉起（端口已被占用视为复用成功）
 */
async function startNanobotGateway(): Promise<boolean> {
  if (nanobotGatewayProcess) return true;
  const { bin, config } = await readNanobotConfig();
  // 网关已在本机运行（用户手动拉起 / 上一实例未退出）→ 复用，不重复拉起
  if (await isPortInUse('127.0.0.1', 18790)) {
    console.log('[nanobot] gateway 18790 已在监听，复用既有网关，不重复拉起');
    return true;
  }
  try {
    const gatewayArgs = ['gateway', '--foreground'];
    if (config && existsSync(config)) gatewayArgs.push('--config', config, '-v');
    nanobotGatewayProcess = spawn(bin, gatewayArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: sanitizeGatewayEnv(),
    });
    nanobotGatewayProcess.stdout?.on('data', (d) =>
      console.log(`[nanobot:gateway] ${d.toString().trim()}`),
    );
    nanobotGatewayProcess.stderr?.on('data', (d) =>
      console.warn(`[nanobot:gateway] ${d.toString().trim()}`),
    );
    nanobotGatewayProcess.on('exit', (code) => {
      console.log(`[nanobot:gateway] 进程退出 code=${code}`);
      nanobotGatewayProcess = null;
    });
    // 同 serve：等到 health 端口真正进入监听再返回，避免"进程在跑但网关未就绪"
    const ready = await waitForPort('127.0.0.1', 18790, LAUNCH_READY_TIMEOUT_MS, () =>
      nanobotGatewayProcess === null,
    );
    if (!ready) {
      console.warn(
        `[nanobot] gateway 18790 在 ${LAUNCH_READY_TIMEOUT_MS / 1000} 秒内未进入监听（进程可能已退出）`,
      );
    }
    return ready;
  } catch (err) {
    console.warn(`[nanobot] gateway 启动失败：${String(err)}`);
    nanobotGatewayProcess = null;
    return false;
  }
}

/** 轮询等待 host:port 释放（重启网关前避免 10048 端口冲突） */
async function waitForPortFree(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(host, port))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !(await isPortInUse(host, port));
}

// ——————————————————————————————————————————————
// nanobot channels 配置同步（IM 频道页自动同步入口）
// 渲染层仅提交 channels 片段 JSON；目标 config.json 路径由主进程决定，
// 合并写入后重启网关使配置生效。路径不接受渲染层指定，杜绝任意路径写入。
// ——————————————————————————————————————————————

/** 前端 IM 频道页托管的渠道集合（合并时整体覆盖，片段中缺失即视为删除） */
const MANAGED_CHANNEL_KEYS = ['dingtalk', 'feishu', 'weixin', 'wecom'];

/** channels 同步结果（渲染层据此决定提示文案） */
interface ChannelSyncResult {
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false，渲染层可据此静默） */
  changed?: boolean;
  /** 配置已写入但网关由外部进程托管，需用户自行重启网关才生效 */
  needsRestart?: boolean;
}

/** 解析待合并的 nanobot config.json 路径（优先最近一次启动所用配置） */
async function resolveNanobotConfigPath(): Promise<string | undefined> {
  if (lastNanobotConfigPath && existsSync(lastNanobotConfigPath)) {
    return lastNanobotConfigPath;
  }
  const { config } = await readNanobotConfig();
  return config;
}

/**
 * 将 channels 片段合并进 nanobot config.json（临时文件 + rename 原子写入）。
 * 托管渠道键以片段为准整体覆盖；websocket 等非托管段原样保留。
 * 幂等：托管段与片段完全一致时不落盘，返回 changed=false（供调用方跳过重启）。
 */
async function mergeChannelsIntoConfig(
  configPath: string,
  channels: Record<string, unknown>,
): Promise<boolean> {
  const raw = existsSync(configPath) ? await fs.readFile(configPath, 'utf-8') : '{}';
  const data = JSON.parse(raw) as Record<string, unknown>;
  const existing =
    typeof data.channels === 'object' && data.channels !== null
      ? (data.channels as Record<string, unknown>)
      : {};

  // 变更检测：仅比较托管渠道键，非托管段（如 websocket）不参与
  const currentManaged: Record<string, unknown> = {};
  for (const key of MANAGED_CHANNEL_KEYS) {
    if (key in existing) currentManaged[key] = existing[key];
  }
  if (JSON.stringify(currentManaged) === JSON.stringify(channels)) return false;

  const merged: Record<string, unknown> = { ...existing };
  for (const key of MANAGED_CHANNEL_KEYS) delete merged[key];
  for (const [key, value] of Object.entries(channels)) merged[key] = value;
  data.channels = merged;
  // 唯一后缀避免与并发的读-改-写链路（如 ensureChannelEnabledInConfig）共用临时名互覆
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, configPath);
  return true;
}

/**
 * 重启本应用托管的 nanobot 网关子进程（channels 配置变更生效）。
 * 只重启 gateway、不触碰 serve：/v1 API 不读取 channels 配置，
 * 重启 serve 只会无谓打断前端会话。
 * @returns 是否成功重新拉起
 */
async function restartNanobotGateway(): Promise<boolean> {
  stopNanobotGateway();
  await waitForPortFree('127.0.0.1', 18790, 5000);
  await startNanobotGateway();
  return nanobotGatewayProcess !== null;
}

// ——————————————————————————————————————————————
// 网关认证 WebSocket 桥（IM 扫码接入：settings.channel.connect.*）
// connect 类操作属于 WebUI mutation：裸 HTTP 一律 405，必须以
// tokenIssueSecret 签发一次性 token 后经 WS 握手标记为 webui 连接，
// 再发 webui_request 帧。桥单例懒加载：连接断开后下次调用重新签发重连。
// ——————————————————————————————————————————————

/** 网关 websocket 频道监听地址（与 serve 8900 / health 18790 均不冲突） */
const GATEWAY_WS_HOST = '127.0.0.1';
const GATEWAY_WS_PORT = 9900;

/** 扫码接入统一返回（不抛异常，错误走 ok=false，风格对齐 sendChannelMessage） */
interface ChannelConnectResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/** 桥单例：认证 WS 连接 + 在途请求表 + 连接建立中的 Promise（防并发重复握手） */
interface GatewayBridge {
  ws: WebSocket;
  pending: Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}
let gatewayBridge: GatewayBridge | null = null;
let gatewayBridgeConnecting: Promise<GatewayBridge> | null = null;

/** 读取 nanobot config.json 的 channels.websocket.tokenIssueSecret（bootstrap 凭证） */
async function readTokenIssueSecret(): Promise<string | null> {
  try {
    const configPath = await resolveNanobotConfigPath();
    if (!configPath || !existsSync(configPath)) return null;
    const data = JSON.parse(await fs.readFile(configPath, 'utf-8')) as {
      channels?: { websocket?: { tokenIssueSecret?: unknown } };
    };
    const secret = data.channels?.websocket?.tokenIssueSecret;
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  } catch (err) {
    console.warn(`[nanobot:bridge] 读取 tokenIssueSecret 失败：${String(err)}`);
    return null;
  }
}

/** 经 /webui/bootstrap 签发一次性握手 token（node http GET，5s 超时） */
function bootstrapGatewayToken(issueSecret: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: GATEWAY_WS_HOST,
        port: GATEWAY_WS_PORT,
        path: '/webui/bootstrap',
        method: 'GET',
        headers: { Authorization: `Bearer ${issueSecret}` },
        timeout: 5000,
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d.toString()));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`bootstrap 返回 ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw) as { token?: string };
            if (parsed.token) resolve(parsed.token);
            else reject(new Error('bootstrap 响应缺少 token'));
          } catch {
            reject(new Error('bootstrap 响应解析失败'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('bootstrap 请求超时')));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * 建立网关认证 WS 桥：签发 token → `ws://127.0.0.1:9900/?token=<token>` 握手。
 * 单例懒加载；并发调用复用同一连接中 Promise；断开后由清理逻辑置空，下次重新签发。
 */
async function getGatewayBridge(): Promise<GatewayBridge> {
  if (gatewayBridge && gatewayBridge.ws.readyState === WebSocket.OPEN) return gatewayBridge;
  if (gatewayBridgeConnecting) return gatewayBridgeConnecting;
  gatewayBridgeConnecting = (async () => {
    const secret = await readTokenIssueSecret();
    if (!secret) throw new Error('config.json 缺少 channels.websocket.tokenIssueSecret');
    const token = await bootstrapGatewayToken(secret);
    const ws = new WebSocket(`ws://${GATEWAY_WS_HOST}:${GATEWAY_WS_PORT}/?token=${token}`);
    const bridge: GatewayBridge = { ws, pending: new Map() };
    // close / error 清理监听在握手前注册：握手失败路径也能清在途请求并释放连接，
    // 避免孤儿连接泄漏。此时 gatewayBridge 尚未赋值，
    // cleanup 内 `if (gatewayBridge === bridge)` 判断天然安全，不会误伤后续新桥。
    let cleaned = false;
    const cleanup = (reason: string) => {
      if (cleaned) return;
      cleaned = true;
      for (const [, waiter] of bridge.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      bridge.pending.clear();
      if (gatewayBridge === bridge) gatewayBridge = null;
    };
    ws.on('close', () => cleanup('网关 WebSocket 连接已断开'));
    ws.on('error', () => cleanup('网关 WebSocket 连接异常'));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('网关 WebSocket 握手超时')), 8000);
        ws.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      // 握手超时 / 错误：剥离全部监听并强制关闭 socket，杜绝孤儿连接后再抛出
      ws.removeAllListeners();
      ws.terminate();
      throw err;
    }
    // 响应帧按 request_id 匹配在途请求；出站帧标识键是 `event`（入站帧才用 `type`），
    // 其它帧（心跳 / 推送）一律忽略（详见 webuiFrames.parseWebuiResponseFrame）
    ws.on('message', (data) => {
      const frame = parseWebuiResponseFrame(data.toString());
      if (!frame) return;
      const waiter = bridge.pending.get(frame.request_id);
      if (!waiter) return;
      bridge.pending.delete(frame.request_id);
      clearTimeout(waiter.timer);
      if (frame.ok === true) {
        waiter.resolve((frame.result ?? {}) as Record<string, unknown>);
      } else {
        waiter.reject(new Error(frame.error?.message ?? `网关返回错误（status=${frame.error?.status ?? '未知'}）`));
      }
    });
    gatewayBridge = bridge;
    return bridge;
  })();
  try {
    return await gatewayBridgeConnecting;
  } finally {
    gatewayBridgeConnecting = null;
  }
}

/**
 * 经认证 WS 桥执行扫码接入动作（start / poll / cancel）。
 * 不抛异常：网关不可达 / 握手失败 / 30s 未收到响应均返回 { ok:false, error }。
 * @param action  connect 动作
 * @param channel 引擎渠道名（feishu / weixin ...）
 * @param params  除 channel 外的参数（网关侧转为查询参数，如 session_id / domain）
 */
async function channelConnectViaGateway(
  action: 'start' | 'poll' | 'cancel',
  channel: string,
  params: Record<string, string>,
): Promise<ChannelConnectResponse> {
  try {
    const bridge = await getGatewayBridge();
    return await new Promise<ChannelConnectResponse>((resolve) => {
      // request_id 契约：[A-Za-z0-9_-]+（去除 uuid 分隔符）
      const requestId = randomUUID().replace(/-/g, '');
      const timer = setTimeout(() => {
        bridge.pending.delete(requestId);
        resolve({ ok: false, error: `网关未在 30s 内响应 ${action} 请求` });
      }, 30000);
      bridge.pending.set(requestId, {
        resolve: (result) => resolve({ ok: true, result }),
        reject: (err) => resolve({ ok: false, error: err.message }),
        timer,
      });
      try {
        bridge.ws.send(
          JSON.stringify({
            type: 'webui_request',
            request_id: requestId,
            action: `settings.channel.connect.${action}`,
            payload: { channel, ...params },
          }),
        );
      } catch (err) {
        bridge.pending.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, error: `发送请求帧失败：${err instanceof Error ? err.message : String(err)}` });
      }
    });
  } catch (err) {
    // bootstrap / 握手失败（含 9900 连不上）：统一提示网关未运行，不抛异常
    return {
      ok: false,
      error: `网关未运行或连接失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 重启网关前确保指定渠道处于启用态（引擎侧 feature enable 缺口的双保险）。
 * - weixin：确保 `channels.weixin.enabled = true`（WeixinConfig.enabled 默认 false，
 *   降级/失败路径可能只写 {token, baseUrl}，重启后网关不会加载微信通道）；已为 true 不落盘；
 * - feishu：确保 `channels.feishu.instances` 中**持有凭证（appId 非空）**的实例
 *   `enabled !== false`（引擎 save_registration_result 已显式写，此处仅兜底）。
 *   注意：只翻有凭证实例——断开功能（disconnectNanobotChannel）会留下「凭证清空且
 *   enabled=false」的合法状态，若误翻会启用无 appId 实例、与前端状态背离；
 * - 其余渠道不处理。
 * 本函数位于 electron/main.ts（依赖 electron 运行时），无法在 vitest 中单测；
 * 白名单归一的可测部分见 normalizeEngineChannelAllowFrom（tests/channelAllowFrom.test.ts）。
 * 同时兜底归一白名单：引擎扫码回写从不写 allowFrom（飞书甚至主动清空），
 * 空白名单 = 纯配对码模式，扫码接入的用户发消息会被配对审批墙拦截；
 * 此处把缺失 / 空数组的 allowFrom 归一为 ["*"]（已有非空精确名单不覆盖），
 * 与前端手动配置路径的 ['*'] 兜底语义一致，消除配对审批墙。
 * 原子写入（临时文件 + rename），风格对齐 mergeChannelsIntoConfig。
 * @returns 是否实际落盘变更；无法处理（渠道段缺失等）时返回 false 不报错，
 * 上游不阻断重启流程。
 */
async function ensureChannelEnabledInConfig(configPath: string, engineChannel: string): Promise<boolean> {
  if (engineChannel !== 'weixin' && engineChannel !== 'feishu') return false;
  if (!existsSync(configPath)) return false;
  const data = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
  const channels =
    typeof data.channels === 'object' && data.channels !== null
      ? (data.channels as Record<string, unknown>)
      : null;
  if (!channels) return false;
  let changed = false;
  if (engineChannel === 'weixin') {
    const weixin = channels.weixin;
    if (typeof weixin === 'object' && weixin !== null && !Array.isArray(weixin)) {
      const cfg = weixin as Record<string, unknown>;
      if (cfg.enabled !== true) {
        cfg.enabled = true;
        changed = true;
      }
    }
  } else {
    const feishu = channels.feishu;
    if (typeof feishu === 'object' && feishu !== null && !Array.isArray(feishu)) {
      const instances = (feishu as Record<string, unknown>).instances;
      if (Array.isArray(instances)) {
        for (const inst of instances) {
          // 下面的 typeof/null 判定已经排除了非对象与 null，故此处直接按对象断言
          const cfg = inst as Record<string, unknown>;
          if (typeof inst !== 'object' || inst === null || cfg.enabled !== false) continue;
          // 只翻持有凭证的实例：与断开功能协同——「凭证清空且 enabled=false」
          // 是断开后的合法状态，误翻会启用无 appId 实例、与前端状态背离
          const appId = cfg.appId;
          if (typeof appId !== 'string' || appId.trim() === '') continue;
          cfg.enabled = true;
          changed = true;
        }
      }
    }
  }
  // 白名单兜底归一（消除配对审批墙）：与 enabled 兜底共用同一次原子落盘，
  // 仅在实际变更时写盘；纯函数原地修改 channels 段
  if (normalizeEngineChannelAllowFrom(channels, engineChannel)) changed = true;
  if (!changed) return false;
  // 唯一后缀避免与并发的读-改-写链路（如 mergeChannelsIntoConfig）共用临时名互覆
  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, configPath);
  return true;
}

/**
 * 强制重启 / 确保网关在运行（扫码成功后绕过 syncChannels 幂等短路的专用通路）。
 * 托管中 → restartNanobotGateway；18790 被外部占用 → needsRestart；否则尝试拉起。
 * @param ensureChannelEnabled 引擎渠道名；非空时在重启前确保该渠道在 config.json 中启用（双保险）
 */
async function restartOrEnsureGateway(ensureChannelEnabled?: string): Promise<{ ok: boolean; message: string; needsRestart?: boolean }> {
  try {
    // 等待启动期首次网关拉起结束，避免与启动流程竞态（重复 spawn / 端口冲突）
    if (nanobotStartupPromise) await nanobotStartupPromise;
    // 重启前确保通道启用（引擎 feature enable 缺口的双保险）；失败仅告警，不阻断重启
    if (ensureChannelEnabled) {
      try {
        const configPath = await resolveNanobotConfigPath();
        if (configPath) await ensureChannelEnabledInConfig(configPath, ensureChannelEnabled);
      } catch (err) {
        console.warn(`[nanobot] 确保渠道启用失败（不阻断重启）：${String(err)}`);
      }
    }
    if (nanobotGatewayProcess) {
      const ok = await restartNanobotGateway();
      return ok
        ? { ok: true, message: '网关已重启，新通道配置已生效' }
        : { ok: false, message: '网关重启失败，请检查 nanowork 日志' };
    }
    if (await isPortInUse('127.0.0.1', 18790)) {
      return { ok: true, needsRestart: true, message: '网关由外部进程托管，请手动重启后生效' };
    }
    const started = await startNanobotGateway();
    if (started && nanobotGatewayProcess) {
      return { ok: true, message: '网关已启动并加载新配置' };
    }
    if (await isPortInUse('127.0.0.1', 18790)) {
      return { ok: true, needsRestart: true, message: '网关由外部进程托管，请手动重启后生效' };
    }
    return { ok: false, message: '网关启动失败，请检查 nanowork 日志' };
  } catch (err) {
    return { ok: false, message: `网关重启失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ——————————————————————————————————————————————
// IM 渠道断开连接（扫码渠道凭证清除 + 停用 + 网关重启）
// 引擎无 disconnect/logout action：断开由应用侧在配置/文件层完成。
// 微信凭证双落盘（config.json 的 token/baseUrl + <config目录>/weixin/account.json，
// 引擎 _load_state 优先读 account.json），两者都必须清除才算断开。
// ——————————————————————————————————————————————

/** 渠道断开结果（不抛异常，错误走 ok=false，风格对齐 restartOrEnsureGateway） */
interface ChannelDisconnectResult {
  ok: boolean;
  message: string;
  /** 配置已清除但网关由外部进程托管，需用户自行重启网关才生效 */
  needsRestart?: boolean;
}

/** 渠道 kind → 展示名（提示文案用） */
const DISCONNECT_KIND_LABEL: Record<DisconnectChannelKind, string> = {
  weixin: '微信',
  feishu: '飞书',
  lark: 'Lark',
};

/**
 * 断开指定扫码渠道的连接（时序：先彻底停旧网关 → 删凭证文件 → 写配置 → 重新拉起）：
 * 1. 托管场景先 stopNanobotGateway() + waitForPortFree 确保旧进程完全退出，
 *    再删微信状态文件——关键：引擎微信渠道优雅关停（非 Windows 的 SIGTERM）
 *    会 _save_state() 把内存活 token 重新写出 account.json，
 *    「先删文件再停进程」会让删除被静默撤销（用户重开 Switch 即免扫码重连）；
 * 2. weixin：删除 account.json（引擎状态文件，_load_state 优先读取；
 *    路径兼容手工配置的 channels.weixin.stateDir / state_dir，见
 *    resolveWeixinAccountPath；不存在不算错误，仅删该文件、保留目录）；
 *    删后补一次 existsSync 校验，若复活则重试删除一次（幂等兜底）；
 * 3. 原子写 config.json（临时文件 + 唯一后缀 + rename，对齐现有模式），
 *    应用 disconnectChannelInConfig 的清洗结果（清凭证 + enabled=false，
 *    保留 allowFrom 等策略字段）；幂等无变更时不落盘；
 * 4. startNanobotGateway() 重新拉起（不调 restartOrEnsureGateway：其内部
 *    含 stop 与重启编排，与此处时序重复）；
 * 5. 外部托管（无本应用托管进程且 18790 被占用，判定对齐 restartOrEnsureGateway）：
 *    无法保证「停止后再删」，仍执行删文件 + 写配置并返回 needsRestart。
 *    残余风险：外部网关关停瞬间引擎 _save_state 可能重建 account.json，
 *    需用户手动重启外部网关后如仍有残留再断开一次；
 * 6. pairing.json 的 approved 残留刻意保留：重连同账号沿用旧审批，体验更好。
 * @param kind 渠道 kind（weixin / feishu / lark；其余渠道无断开路径）
 */
async function disconnectNanobotChannel(kind: string): Promise<ChannelDisconnectResult> {
  try {
    if (kind !== 'weixin' && kind !== 'feishu' && kind !== 'lark') {
      return { ok: false, message: `不支持断开该渠道：${kind}` };
    }
    const label = DISCONNECT_KIND_LABEL[kind as DisconnectChannelKind];
    // 等待应用启动时的首次网关拉起结束，避免与启动流程竞态（重复 spawn / 端口冲突）
    if (nanobotStartupPromise) await nanobotStartupPromise;
    const configPath = await resolveNanobotConfigPath();
    if (!configPath) {
      return { ok: false, message: '未找到 nanowork config.json，无法断开渠道' };
    }
    // 外部托管判定（同 restartOrEnsureGateway）：无托管进程且 18790 被占用。
    // 此时无法保证「停止后再删」，仅删文件 + 写配置并提示手动重启（见函数注释 5）
    const externallyManaged =
      !nanobotGatewayProcess && (await isPortInUse('127.0.0.1', 18790));

    // 托管场景：先彻底停掉旧网关进程并等端口释放，再删凭证文件，
    // 避免引擎优雅关停时 _save_state() 把活 token 写回 account.json 复活断开结果
    if (!externallyManaged) {
      stopNanobotGateway();
      await waitForPortFree('127.0.0.1', 18790, 5000);
    }

    // 读配置：微信需从中解析状态文件路径（stateDir 兼容）；后续清洗基于同一快照落盘
    const raw = existsSync(configPath) ? await fs.readFile(configPath, 'utf-8') : '{}';
    const data = JSON.parse(raw) as Record<string, unknown>;
    const channels =
      typeof data.channels === 'object' && data.channels !== null && !Array.isArray(data.channels)
        ? (data.channels as Record<string, unknown>)
        : {};

    // 微信：删引擎状态文件 account.json（只清 config 不算断开）；
    // 文件不存在视为已断开不报错；真实删除失败（权限等）则中止，避免留下半断开状态。
    // 删除失败时托管网关已被停掉，返回错误后用户重试断开即可（重入安全）
    if (kind === 'weixin') {
      const accountPath = resolveWeixinAccountPath(dirname(configPath), channels.weixin);
      try {
        await fs.unlink(accountPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, message: `删除微信凭证文件失败：${String(err)}` };
        }
      }
      // 幂等兜底：删除后若文件复活（外部托管场景的残余窗口等）再删一次，仍失败不阻断写配置
      if (existsSync(accountPath)) {
        try {
          await fs.unlink(accountPath);
        } catch {
          /* ignore：写配置后断开在引擎侧仍成立（_load_state 无 token 时会回落 config） */
        }
      }
    }

    if (disconnectChannelInConfig(channels, kind as DisconnectChannelKind)) {
      data.channels = channels;
      // 唯一后缀避免与并发的读-改-写链路（如 mergeChannelsIntoConfig）共用临时名互覆
      const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, configPath);
    }

    // 外部托管：配置已清除，由用户手动重启外部网关完成断开（见函数注释 5）
    if (externallyManaged) {
      return {
        ok: true,
        needsRestart: true,
        message: `${label}凭证已清除，网关由外部进程托管，请手动重启网关以完成断开`,
      };
    }

    // 重新拉起网关使断开生效（绝不经 ensureChannelEnabledInConfig，防反向强制启用）
    const started = await startNanobotGateway();
    if (started && nanobotGatewayProcess) {
      return { ok: true, message: `${label}已断开，网关已重启生效，可重新扫码接入` };
    }
    // 拉起失败但端口又被占用：可能被外部进程接管，降级为 needsRestart 提示
    if (await isPortInUse('127.0.0.1', 18790)) {
      return {
        ok: true,
        needsRestart: true,
        message: `${label}凭证已清除，网关由外部进程托管，请手动重启网关以完成断开`,
      };
    }
    return { ok: false, message: `${label}凭证已清除，但网关启动失败，请检查 nanowork 日志` };
  } catch (err) {
    return { ok: false, message: `断开渠道失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 只读回读 nanobot config.json 的 channels 段。
 * 供渲染层在本地 channelsStore 缺失配置时回显（配置可能直接在 nanobot 侧写入）。
 * @returns channels 段对象；config 不存在 / 无 channels 段时返回 null
 */
async function getNanobotChannels(): Promise<Record<string, unknown> | null> {
  const configPath = await resolveNanobotConfigPath();
  if (!configPath || !existsSync(configPath)) return null;
  const raw = await fs.readFile(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const channels = parsed.channels;
  if (typeof channels !== 'object' || channels === null || Array.isArray(channels)) {
    return null;
  }
  // 剥离 websocket 段的长期网关传输凭证（tokenIssueSecret / token），
  // 防止传输密钥暴露到渲染层；保留段内其余字段以维持结构完整。
  // 注意：不得剥离 channels.feishu.instances[].appSecret —— 回读链路需要它防止后续同步抹掉凭证。
  const sanitized = { ...(channels as Record<string, unknown>) };
  const websocket = sanitized.websocket;
  if (typeof websocket === 'object' && websocket !== null && !Array.isArray(websocket)) {
    const {
      tokenIssueSecret: _tokenIssueSecret,
      token: _token,
      ...rest
    } = websocket as Record<string, unknown>;
    sanitized.websocket = rest;
  }
  return sanitized;
}

async function syncNanobotChannels(channelsJson: string): Promise<ChannelSyncResult> {
  try {
    // 等待应用启动时的首次网关拉起结束，避免与启动流程竞态（重复 spawn / 端口冲突）
    if (nanobotStartupPromise) await nanobotStartupPromise;
    // 渲染层提交完整片段 { channels: {...} }；兼容直接提交 channels 对象
    const parsed = JSON.parse(channelsJson) as Record<string, unknown>;
    const channels = (
      typeof parsed.channels === 'object' && parsed.channels !== null ? parsed.channels : parsed
    ) as Record<string, unknown>;
    const configPath = await resolveNanobotConfigPath();
    if (!configPath) {
      return { ok: false, message: '未找到 nanowork config.json，无法同步频道配置' };
    }
    const changed = await mergeChannelsIntoConfig(configPath, channels);
    // 幂等：配置无变化时无需重启网关，避免每次启动都打断既有会话
    if (!changed) {
      // 配置虽无变化，但网关可能尚未拉起（首次启动场景）→ 确保 gateway 在运行
      if (!nanobotGatewayProcess) await startNanobotGateway();
      return { ok: true, changed: false, message: '频道配置与 nanowork 一致，无需变更' };
    }
    if (nanobotProcess || nanobotGatewayProcess) {
      // gateway 未被本应用托管（仅 serve 在跑）→ 以新配置全新拉起；
      // 已托管 → 重启使新配置生效（serve 不读取 channels，无需重启）
      if (nanobotGatewayProcess === null) {
        await startNanobotGateway();
      } else if (!(await restartNanobotGateway())) {
        // 重启失败且端口仍被占用：外部进程接管了网关，配置已落盘但需外部重启
        if (await isPortInUse('127.0.0.1', 18790)) {
          return {
            ok: true,
            message: '频道配置已写入，网关由外部进程托管，请重启该网关后生效',
            needsRestart: true,
          };
        }
        return { ok: false, message: '频道配置已写入，但网关重启失败，请检查 nanowork 日志' };
      }
      // 全新拉起后仍未被本应用托管 → 18790 被外部网关占用，配置需外部重启生效
      if (nanobotGatewayProcess === null) {
        return {
          ok: true,
          message: '频道配置已写入，网关由外部进程托管，请重启该网关后生效',
          needsRestart: true,
        };
      }
      return { ok: true, message: '频道配置已写入 nanowork，网关已重启生效' };
    }
    // 端口被外部网关占用（复用场景）：配置已落盘，但本进程无权重启外部网关
    return {
      ok: true,
      message: '频道配置已写入 nanowork config.json，请重启网关后生效',
      needsRestart: true,
    };
  } catch (err) {
    return { ok: false, message: `频道配置同步失败：${String(err)}` };
  }
}

/**
 * 把保险库里的凭据注入待写入的 `tools.mcpServers` 条目。
 *
 * ## 为什么注入发生在主进程
 *
 * 渲染层提交上来的条目**不含密钥值**（密钥只在保险库与引擎配置里存在），
 * 所以"用哪条 server 的哪份凭据"必须由持有保险库的主进程补齐。渲染层只负责
 * 声明"这个 server 叫什么"，值由这里按名字取——这也是密钥不回传渲染层的代价：
 * 少一处明文，就少一处泄露面。
 *
 * ## 注入位置沿用既有约定
 *
 * - stdio：整体进 `env`（MCP server 从环境变量读 API Key）；
 * - url：`token` → `Authorization: Bearer`，其余键作为同名请求头。
 *
 * 保险库的值**覆盖**条目里已有的同名字段：它是唯一的权威来源，
 * 允许条目自带同名字段会让"保险库改了但配置没变"变成一条静默失效的路径。
 */
async function injectConnectorSecrets(
  servers: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const asObject = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};

  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out[name] = raw;
      continue;
    }
    const entry = asObject(raw);
    const secrets = await credentialVault.read(name);
    if (Object.keys(secrets).length === 0) {
      out[name] = entry;
      continue;
    }
    const isStdio = entry.type === 'stdio' || typeof entry.command === 'string';
    if (isStdio) {
      entry.env = { ...asObject(entry.env), ...secrets };
    } else {
      const headers = asObject(entry.headers);
      for (const [key, value] of Object.entries(secrets)) {
        headers[key === 'token' ? 'Authorization' : key] =
          key === 'token' ? `Bearer ${value}` : value;
      }
      entry.headers = headers;
    }
    out[name] = entry;
  }
  return out;
}

/**
 * 把渲染层提交的 MCP Server 片段合并进 nanobot config.json 的 tools.mcpServers。
 * 幂等：内容一致时不写盘，返回 false。
 *
 * 注意：当前采用「全量替换」语义（覆盖 data.tools.mcpServers）——
 * nanowork 全权托管该字段；若用户在 config.json 中维护了与本应用无关的
 * MCP Server，需先在管理页一并录入后方可保留。
 */
async function mergeMcpIntoConfig(
  configPath: string,
  incomingServers: Record<string, unknown>,
): Promise<boolean> {
  const raw = existsSync(configPath) ? await fs.readFile(configPath, 'utf-8') : '{}';
  const data = JSON.parse(raw) as Record<string, unknown>;
  const existingTools =
    typeof data.tools === 'object' && data.tools !== null ? (data.tools as Record<string, unknown>) : {};
  const existingMcp =
    typeof existingTools.mcpServers === 'object' &&
      existingTools.mcpServers !== null &&
      !Array.isArray(existingTools.mcpServers)
      ? (existingTools.mcpServers as Record<string, unknown>)
      : {};
  if (JSON.stringify(existingMcp) === JSON.stringify(incomingServers)) return false;
  existingTools.mcpServers = incomingServers;
  data.tools = existingTools;
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, configPath);
  return true;
}

/**
 * 回读 nanobot config.json 中的 tools.mcpServers 段，仅供渲染层回显。
 * 不存在或结构不合法时返回 null。
 */
async function getNanobotMcp(): Promise<Record<string, unknown> | null> {
  const configPath = await resolveNanobotConfigPath();
  if (!configPath || !existsSync(configPath)) return null;
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { tools?: { mcpServers?: unknown } };
    const mcp = parsed?.tools?.mcpServers;
    if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) return null;
    return mcp as Record<string, unknown>;
  } catch (err) {
    console.warn(`[nanobot] mcpServers 回读失败：${String(err)}`);
    return null;
  }
}

/**
 * 同步 MCP Server 片段到 nanobot 运行时：
 *   1. 合并写入 config.json 的 tools.mcpServers；
 *   2. 若本进程托管着 serve 子进程，按需重启以加载新工具；
 *   3. serve 不在本进程托管（外部托管 / 仅 gateway）→ 返回 needsRestart。
 */
/**
 * 把技能三态覆盖合并进 `config.json` 的 `agents.defaults.skillOverrides`。
 *
 * 三条容易写错的约定：
 * 1. **键名是 camelCase**。引擎的 pydantic 模型挂了 `alias_generator=to_camel`，
 *    写成 `skill_overrides` 会被当成未知字段直接忽略——覆盖静默失效。
 * 2. **整体替换而不是逐键合并**。渲染层每次送来的都是完整覆盖表
 *    （只含非默认档），逐键合并会让「用户把技能调回启用」永远删不掉旧条目。
 * 3. `agents` / `defaults` 可能是任意非对象值（手改坏了配置），一律重建。
 *
 * @returns 是否实际发生变更
 */
async function mergeSkillOverridesIntoConfig(
  configPath: string,
  overrides: Record<string, unknown>,
): Promise<boolean> {
  const raw = existsSync(configPath) ? await fs.readFile(configPath, 'utf-8') : '{}';
  const data = JSON.parse(raw) as Record<string, unknown>;
  const asObject = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const agents = asObject(data.agents);
  const defaults = asObject(agents.defaults);
  const existing = asObject(defaults.skillOverrides);
  if (JSON.stringify(existing) === JSON.stringify(overrides)) return false;
  defaults.skillOverrides = overrides;
  agents.defaults = defaults;
  data.agents = agents;
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, configPath);
  return true;
}

async function syncNanobotMcp(mcpJson: string): Promise<{
  ok: boolean;
  message: string;
  changed?: boolean;
  needsRestart?: boolean;
}> {
  try {
    if (nanobotStartupPromise) await nanobotStartupPromise;
    const parsed = JSON.parse(mcpJson) as Record<string, unknown>;
    // 兼容两种形态：
    //   - 字典形态：`{ "serverName": {...}, ... }`（renderer 直接发送 toNanobotMCP 结果）
    //   - 包裹形态：`{ "mcpServers": { "serverName": {...} } }`（web 下载片段 / 旧版）
    // 禁止把数组（原始 MCPConfig[]）当字典写入，否则 nanobot 校验失败。
    let mcpServers: Record<string, unknown> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const child = parsed.mcpServers;
      mcpServers =
        child && typeof child === 'object' && !Array.isArray(child)
          ? (child as Record<string, unknown>)
          : (parsed as Record<string, unknown>);
    }
    // 渲染层提交的条目不含密钥值：写入引擎配置前由主进程按 server 名补齐
    // （密钥只存在保险库与这份引擎配置里，见 injectConnectorSecrets 的说明）
    const withSecrets = await injectConnectorSecrets(mcpServers);
    const configPath = await resolveNanobotConfigPath();
    if (!configPath) {
      return { ok: false, message: '未找到 nanowork config.json，无法同步 MCP 配置' };
    }
    const changed = await mergeMcpIntoConfig(configPath, withSecrets);
    if (!changed) {
      return { ok: true, changed: false, message: 'MCP 配置与 nanowork 一致，无需变更' };
    }
    // chat/completions 由 serve 子进程承载；MCP 工具在 serve 启动时加载 → 需重启 serve
    if (nanobotProcess) {
      stopNanobot();
      await waitForPortFree('127.0.0.1', 8900, 5000);
      await startNanobot();
      if (nanobotProcess) {
        return { ok: true, message: 'MCP 配置已写入 config.json.tools.mcpServers，serve 已重启生效' };
      }
      return { ok: false, message: 'MCP 配置已写入，但 serve 重启失败，请检查 nanowork 日志' };
    }
    // serve 不在本进程托管（外部进程或尚未启动）
    const portBusy = await isPortInUse('127.0.0.1', 8900);
    return {
      ok: true,
      message: portBusy
        ? 'MCP 配置已写入 config.json.tools.mcpServers，serve 由外部进程托管，请重启该网关后生效'
        : 'MCP 配置已写入 config.json.tools.mcpServers，请启动 smartagent 后生效',
      needsRestart: true,
    };
  } catch (err) {
    return { ok: false, message: `MCP 同步失败：${String(err)}` };
  }
}

// ——————————————————————————————————————————————
// nanobot 频道会话只读扫描（渲染层「频道」会话列表数据源）
// gateway 将每条 IM 对话以 {base64url(channel:chat_id)}.jsonl 持久化在
// {config 目录}/sessions/{workspace_id}/ 下。此处只做只读解析，绝不写入，
// 与 gateway 的写入通过「原子替换 + 行级 JSON」天然兼容。
// ——————————————————————————————————————————————

/** 视为 IM 频道对话的 key 前缀（api / cli / websocket 等为本地或调试通道，不入列表） */
const IM_CHANNEL_PREFIXES = [
  'feishu',
  'lark',
  'dingtalk',
  'weixin',
  'wecom',
  'telegram',
  'discord',
  'slack',
  'qq',
];

/** 判断 channel 段是否属于 IM 频道（兼容 `feishu.feishu` 这类 domain 变体） */
function isImChannel(channel: string): boolean {
  return IM_CHANNEL_PREFIXES.some(
    (p) => channel === p || channel.startsWith(`${p}.`),
  );
}

/** 单个会话文件解析上限（消息行数），防止超大文件阻塞主进程 */
const MAX_SESSION_RECORDS = 2000;

/** base64url（无填充）文件名 stem → 原始 session key；解码失败返回 null */
function decodeSessionKey(stem: string): string | null {
  try {
    const padded = stem + '='.repeat((4 - (stem.length % 4)) % 4);
    return Buffer.from(padded, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
}

/** 原始 session key → 磁盘文件名 stem（base64url 无填充，与 nanobot 编码规则一致） */
function encodeSessionKey(key: string): string {
  return Buffer.from(key, 'utf-8').toString('base64url').replace(/=+$/, '');
}

/** 提取消息行 content 的可展示文本（兼容字符串与 OpenAI content blocks 数组） */
function recordPreviewText(record: Record<string, unknown>): string {
  const content = record.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** 单个会话 JSONL 的解析结果（内存态，供摘要与详情共用） */
interface ParsedChannelSession {
  createdAt: string;
  updatedAt: string;
  metaTitle: string;
  preview: string;
  messageCount: number;
  messages: Record<string, unknown>[];
}

/**
 * 解析单个会话 JSONL 文件（只读）。
 * 首行通常为 metadata（created_at / updated_at / metadata.title），
 * 其余为消息行（role: user / assistant / tool）或 provider_state 记录。
 * 损坏行静默跳过，与 nanobot 自身的修复策略保持一致的宽容度。
 */
async function parseChannelSessionFile(filePath: string): Promise<ParsedChannelSession | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  let createdAt = '';
  let updatedAt = '';
  let metaTitle = '';
  let preview = '';
  let fallbackPreview = '';
  let messageCount = 0;
  const messages: Record<string, unknown>[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const rec = record as Record<string, unknown>;
    if (rec._type === 'metadata') {
      if (typeof rec.created_at === 'string') createdAt = rec.created_at;
      if (typeof rec.updated_at === 'string') updatedAt = rec.updated_at;
      const meta = rec.metadata;
      if (meta && typeof meta === 'object') {
        const t = (meta as Record<string, unknown>).title;
        if (typeof t === 'string' && t.trim() !== '') metaTitle = t.trim();
      }
      continue;
    }
    if (typeof rec._type === 'string') continue; // provider_state 等内部记录
    messageCount += 1;
    if (messages.length < MAX_SESSION_RECORDS) messages.push(rec);
    if (preview === '') {
      const text = recordPreviewText(rec);
      if (text !== '') {
        if (rec.role === 'user') preview = text;
        else if (fallbackPreview === '') fallbackPreview = text;
      }
    }
  }
  if (messageCount === 0) return null;
  return {
    createdAt,
    updatedAt,
    metaTitle,
    preview: preview || fallbackPreview,
    messageCount,
    messages,
  };
}

/** 解析结果 → 渲染层摘要（标题优先 metadata.title，其次首条用户消息摘要） */
function toChannelSessionSummary(
  key: string,
  parsed: ParsedChannelSession,
): NanobotChannelSessionSummary {
  return {
    key,
    channel: key.split(':')[0],
    title: parsed.metaTitle || parsed.preview.slice(0, 24) || key,
    preview: parsed.preview,
    messageCount: parsed.messageCount,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

/**
 * 候选 sessions 根目录集合：
 * 1) 最近一次 nanobot 启动所用 config 的同级 sessions/（本应用实际写入位置）；
 * 2) ~/.nanobot/sessions（默认位置兜底）。
 */
async function resolveSessionsRoots(): Promise<string[]> {
  const roots: string[] = [];
  const configPath = await resolveNanobotConfigPath();
  if (configPath) roots.push(join(dirname(configPath), 'sessions'));
  roots.push(join(app.getPath('home'), '.nanobot', 'sessions'));
  const existing: string[] = [];
  for (const r of roots) {
    if (await isExistingDir(r)) existing.push(r);
  }
  return existing;
}

/** 异步判断目录是否存在（替代同步 existsSync，避免阻塞主进程） */
async function isExistingDir(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

/** 跨 workspace 目录的同一 key 候选副本（用于"最新者胜出"去重） */
interface ChannelSessionCandidate {
  filePath: string;
  /** metadata.updated_at（ISO 字符串，可能为空） */
  updatedAt: string;
  /** 文件 mtime（毫秒，读取失败为 0，作 updated_at 相同时的兜底） */
  mtimeMs: number;
}

/** updated_at → 数值时间戳；空串/非法格式视为 -Infinity（参与 mtime 兜底） */
function parseTimestampMs(value: string): number {
  if (!value) return -Infinity;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * 判断新候选副本是否比已选副本更新：
 * 优先按 metadata.updated_at 的数值时间戳比较（兼容 Z / +08:00 等时区后缀），
 * 两者相等或均缺失/非法时退化为比较文件 mtime（保持稳定的兜底顺序）。
 */
function isNewerChannelCandidate(next: ChannelSessionCandidate, current: ChannelSessionCandidate): boolean {
  const nextMs = parseTimestampMs(next.updatedAt);
  const currentMs = parseTimestampMs(current.updatedAt);
  if (nextMs !== currentMs) return nextMs > currentMs;
  return next.mtimeMs > current.mtimeMs;
}

/**
 * 轻量读取 JSONL 首行 metadata 的 updated_at（仅供候选比较，不做全量解析）。
 * 文件不可读/首行非 metadata 记录时返回空串。
 */
async function readSessionMetadataUpdatedAt(filePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
  const nl = raw.indexOf('\n');
  const firstLine = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  if (!firstLine) return '';
  try {
    const record = JSON.parse(firstLine) as Record<string, unknown>;
    if (record && record._type === 'metadata' && typeof record.updated_at === 'string') {
      return record.updated_at;
    }
  } catch {
    /* 首行损坏按缺失处理 */
  }
  return '';
}

/** 异步判断常规文件是否存在（替代同步 existsSync，避免阻塞主进程） */
async function isExistingFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * 收集所有 sessions 根目录下全部 workspace 目录中指定文件名的候选副本路径
 * （同一 key 可能因工作区切换在多个目录各存一份），
 * 并轻量读取首行 metadata 与 mtime 供新旧比较（不做全量解析）。
 */
async function collectChannelSessionCandidates(fileName: string): Promise<ChannelSessionCandidate[]> {
  const candidates: ChannelSessionCandidate[] = [];
  for (const root of await resolveSessionsRoots()) {
    let workspaces: Dirent[];
    try {
      workspaces = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const filePath = join(root, ws.name, fileName);
      if (!(await isExistingFile(filePath))) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(filePath)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      candidates.push({
        filePath,
        updatedAt: await readSessionMetadataUpdatedAt(filePath),
        mtimeMs,
      });
    }
  }
  return candidates;
}

/** 从候选副本中选出最新的一份（updated_at 优先，mtime 兜底）；空列表返回 null */
function pickNewestChannelCandidate(candidates: ChannelSessionCandidate[]): ChannelSessionCandidate | null {
  let best: ChannelSessionCandidate | null = null;
  for (const c of candidates) {
    if (!best || isNewerChannelCandidate(c, best)) best = c;
  }
  return best;
}

/**
 * 列出所有 IM 频道会话摘要（跨 workspace 去重，按更新时间倒序）。
 * 单次遍历所有 workspace 目录，以解码后的 session key 为去重键建立
 * 候选索引（不同文件名可能解码出同一 key，一并参与新旧竞争），
 * 每组按"最新者胜出"选出唯一副本：候选比较只读首行 metadata，
 * 仅对胜出文件做一次完整解析，避免字母序靠前的旧工作区冻结副本遮蔽活跃副本。
 */
async function listNanobotChannelSessions(): Promise<NanobotChannelSessionSummary[]> {
  const index = new Map<string, string[]>();
  for (const root of await resolveSessionsRoots()) {
    let workspaces: Dirent[];
    try {
      workspaces = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const wsDir = join(root, ws.name);
      let files: Dirent[];
      try {
        files = await fs.readdir(wsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const key = decodeSessionKey(file.name.slice(0, -'.jsonl'.length));
        if (!key || !isImChannel(key.split(':')[0])) continue;
        const paths = index.get(key);
        if (paths) paths.push(join(wsDir, file.name));
        else index.set(key, [join(wsDir, file.name)]);
      }
    }
  }
  const summaries: NanobotChannelSessionSummary[] = [];
  for (const [key, paths] of index) {
    const candidates: ChannelSessionCandidate[] = [];
    for (const filePath of paths) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(filePath)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      candidates.push({
        filePath,
        updatedAt: await readSessionMetadataUpdatedAt(filePath),
        mtimeMs,
      });
    }
    const best = pickNewestChannelCandidate(candidates);
    if (!best) continue;
    const parsed = await parseChannelSessionFile(best.filePath);
    if (parsed) summaries.push(toChannelSessionSummary(key, parsed));
  }
  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return summaries;
}

/**
 * 按 key 定位并读取单个 IM 频道会话的完整历史；不存在或解析失败返回 null。
 * 收集所有 workspace 目录中该 key 对应的副本后轻量比较，
 * 仅对最新副本做一次完整解析（metadata.updated_at 数值优先，相同/缺失时 mtime 兜底）。
 */
async function getNanobotChannelSession(
  key: string,
): Promise<NanobotChannelSessionDetail | null> {
  if (!isImChannel(key.split(':')[0])) return null;
  const fileName = `${encodeSessionKey(key)}.jsonl`;
  const best = pickNewestChannelCandidate(await collectChannelSessionCandidates(fileName));
  if (!best) return null;
  const parsed = await parseChannelSessionFile(best.filePath);
  if (!parsed) return null;
  return { ...toChannelSessionSummary(key, parsed), messages: parsed.messages };
}

// —— 本地存储桥（渲染层经 window.electronAPI 调用）——
// 每个 key 独立落盘（落点见 electron/storageRoutes.ts），不再整体读写单文件：
// 既避免「改一个 store 重写全部状态」的写放大，也让用户资产可直接打开编辑。
ipcMain.handle('storage:get', async (_e, key: string) => readPersistedValue(key));
ipcMain.handle('storage:set', async (_e, key: string, value: string) => {
  await writeRouteFile(key, value);
});
ipcMain.handle('storage:remove', async (_e, key: string) => {
  const { filePath } = resolveRoute(key, STORAGE_ROOTS);
  await fs.rm(filePath, { force: true });
});

/**
 * 精确清空「存储」类落点。
 *
 * 刻意**不整目录删除**：① 下的 `skills/`、`plugins/`、`connectors/` 是用户资产
 * （技能包、插件、凭据），不属于可一键清空的存储状态；memory 目录也只清
 * `.md` / `.json`，不动用户手工放进去的其它文件。
 */
async function clearStorageFiles(): Promise<void> {
  const files = knownRouteFiles(STORAGE_ROOTS);
  await Promise.all(files.map((filePath) => fs.rm(filePath, { force: true })));
  await clearDirFiles(memoryDir(STORAGE_ROOTS), ['.md', '.json']);
  await fs.rm(miscDir(STORAGE_ROOTS), { recursive: true, force: true });
  await fs.rm(LEGACY_STORE_FILE, { force: true });
  legacyCache = null; // 旧数据已清，避免回退读取把它复活
}

/** 删除目录下指定扩展名的文件（目录不存在视为无事发生） */
async function clearDirFiles(dir: string, extensions: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && extensions.includes(extname(entry.name)))
      .map((entry) => fs.rm(join(dir, entry.name), { force: true })),
  );
}

ipcMain.handle('storage:clear', async () => {
  await clearStorageFiles();
});

// —— 事件流桥（D2：渲染层经 window.electronAPI 调用）——
// 落点规则见 electron/eventRoutes.ts，索引纯逻辑见 electron/eventIndex.ts，
// IO 在 electron/eventStore.ts。IPC 两侧只传领域对象，磁盘格式由 eventStore 独占；
// sessionId / hash 由 eventRoutes 做单层片段安全校验（越界直接抛错）。
ipcMain.handle(
  'events:append',
  async (_e, params: EventAppendParams): Promise<EventAppendResult> =>
    eventStore.append(params),
);
ipcMain.handle('events:read', async (_e, sessionId: string, workdir?: string | null) =>
  eventStore.readEvents(sessionId, workdir),
);
ipcMain.handle('events:remove', async (_e, sessionId: string, workdir?: string | null) => {
  await eventStore.remove(sessionId, workdir);
});
ipcMain.handle('meta:read', async (_e, sessionId: string, workdir?: string | null) =>
  eventStore.readMeta(sessionId, workdir),
);
ipcMain.handle('meta:write', async (_e, meta: SessionMeta) => {
  await eventStore.writeMeta(meta);
});
ipcMain.handle('meta:list', async () => eventStore.listMetas());
ipcMain.handle('index:read', async () => eventStore.readIndex());
ipcMain.handle('index:rebuild', async () => eventStore.rebuildIndex());
ipcMain.handle('file-backup:put', async (_e, hash: string, content: string) => {
  await eventStore.putBackup(hash, content);
});
ipcMain.handle('file-backup:get', async (_e, hash: string) => eventStore.getBackup(hash));

// —— 通知桥 ——
ipcMain.on('app:notify', (_e, title: string, body: string) => {
  new Notification({ title, body }).show();
});

// —— 文本文件写入桥（导出文件）——
// 路径规整与安全校验见 storageRoutes.resolveWriteTarget：
// - 绝对路径：仅允许落在用户主目录 / userData / ① 产品自有目录内；
// - 相对路径：解析到 ① `~/.nanowork/`（如 'MEMORY.md' → `~/.nanowork/MEMORY.md`）。
//   早期实现只做 `startsWith` 校验、不做相对路径解析，导致传纯文件名必然被拒——
//   渲染层的「导出 MEMORY.md」在 Electron 下实际一直失败。
ipcMain.handle('fs:writeTextFile', async (_e, filePath: string, content: string) => {
  const target = resolveWriteTarget(filePath, STORAGE_ROOTS);
  if (!target) {
    throw new Error(`禁止写入非用户目录：${filePath}`);
  }
  // 确保父目录存在
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
});

// —— 本地文件只读桥（复制消息后粘贴恢复附件内容用）——
// 只读不写，风险远低于 writeTextFile；路径由渲染层附件 localPath 提供。
ipcMain.handle('fs:readFileAsBase64', async (_e, filePath: string) => {
  try {
    const buffer = await fs.readFile(join(filePath));
    return { ok: true, base64: buffer.toString('base64'), size: buffer.byteLength };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

// —— 目录选择桥（会话工作空间）——
// 弹出系统原生目录选择对话框，返回所选目录绝对路径；用户取消返回 null。
ipcMain.handle('dialog:pickDirectory', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  //win?.webContents.openDevTools({ mode: 'detach' })
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择工作空间',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ——— 系统 shell 桥（侧边栏「在资源管理器打开」）———
ipcMain.handle('shell:openPath', async (_e, path: string) => {
  const normalized = join(path);
  if (!existsSync(normalized)) return { ok: false, error: `路径不存在：${path}` };
  // shell.openPath 返回空字符串=成功；非空字符串为系统级错误描述
  const errorMessage = await shell.openPath(normalized);
  if (errorMessage) return { ok: false, error: errorMessage };
  return { ok: true };
});

// ——— 本地存储信息（设置「通用 → 存储」卡片）———

/**
 * 内置默认工作空间目录名。
 *
 * 用户未自定义 `settings.defaultWorkspacePath` 时，新建任务的落点。
 * 与 WorkBuddy 的 `<home>/WorkBuddy` 同构。
 */
const DEFAULT_WORKSPACE_DIR_NAME = 'NanoWork';

/**
 * 缓存目录统计的条目上限。
 *
 * 递归统计**必须**有上界：缓存目录里装着会话 JSONL、插件包、文件备份，
 * 用一段时间后动辄几十万个小文件。真按全量走，一次递归就能把主进程的
 * 事件循环占住数秒——期间窗口拖不动、所有 IPC 阻塞，用户看到的是「应用卡死」，
 * 而起因只是在设置里点开了「通用」。
 *
 * 到达上限即停止下钻，返回已统计的值：界面上的数字会偏小，但应用是活的。
 * 这个取舍是刻意的——一个不够精确的容量提示，远好过一个卡死的设置面板。
 */
const CACHE_SCAN_MAX_ENTRIES = 200_000;

/** 递归统计目录占用字节数；目录不存在或读取失败一律按 0（不抛） */
async function directorySize(root: string): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let items: Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // 权限不足 / 统计途中被删：跳过这一层，不让整次统计失败
      continue;
    }
    for (const item of items) {
      if (++seen > CACHE_SCAN_MAX_ENTRIES) return total;
      const child = join(dir, item.name);
      // 不跟随符号链接：跟随会走出缓存目录，遇到环状链接还会无限递归
      if (item.isDirectory()) stack.push(child);
      else if (item.isFile()) {
        try {
          total += (await fs.stat(child)).size;
        } catch {
          // 统计途中文件被删 / 无权限：忽略这一个
        }
      }
    }
  }
  return total;
}

/** 读取路径所在卷的容量；`statfs` 不可用（老运行时 / 特殊挂载）时返回全 0 */
async function diskUsage(target: string): Promise<DiskUsage> {
  try {
    const s = await fs.statfs(target);
    const totalBytes = s.blocks * s.bsize;
    // 可用取 `bavail`（当前用户可写）而不是 `bfree`（含 root 保留块）：
    // 用户关心的是「我还能写多少」，用 bfree 会多报一块他其实用不到的空间。
    const freeBytes = s.bavail * s.bsize;
    return {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
    };
  } catch {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  }
}

ipcMain.handle(
  'app:getStorageInfo',
  async (_e, ensureDefaultWorkspace?: boolean): Promise<StorageInfo> => {
    /**
     * 缓存目录取**产品自有目录** `~/.nanowork/`。
     *
     * 这里换过一次：早先取的是 Electron `userData`，理由是「对话记录与运行缓存
     * 都落在 userData，指 `~/.nanowork` 会变成标签写几 GB、点开只有几 MB」。
     * 但产品对标的 WorkBuddy 标的就是它自己的产品目录 `~/.workbuddy/`——同名同
     * 位置，只差一个前缀。既然 `~/.nanowork` 就是「这个应用自己的目录」，
     * 用户在该目录下找东西的直觉是对的，**以路径的可预期性为准**。
     *
     * 两个根的分工没变，仍在设置「数据管理 → 数据落点」里写明：用户资产（设置、
     * 记忆、技能、插件）在 `~/.nanowork/`，会话事件流与索引在应用数据目录。
     * 因此下面统计的是 `~/.nanowork/` 的体积，不等于「本机全部产品数据」。
     */
    const cacheDir = productDir(STORAGE_ROOTS);
    const defaultWorkspaceDir = join(STORAGE_ROOTS.home, DEFAULT_WORKSPACE_DIR_NAME);

    // 目录按需建出：卡片上的「打开目录」需要一个真实目标，目录不存在时
    // `shell.openPath` 会直接失败，用户看到的是「打不开」而不是「还没有数据」。
    // 两个 mkdir 都是幂等的（userData 由 Electron 启动时创建，这里只是兜底）。
    try {
      await fs.mkdir(cacheDir, { recursive: true });
    } catch {
      // 建不出来（只读盘 / 权限不足）不影响展示：下面统计按 0 处理
    }
    // 内置默认工作空间只在「用户没有自定义路径」时才建（由渲染层传参决定）。
    // 用户自定义的路径一律不建：目录选择器返回的目录必然已存在，不需要代劳；
    // 若用户后来手动删了它，我们也**不该**悄悄重建——那是用户的决定。
    if (ensureDefaultWorkspace) {
      try {
        await fs.mkdir(defaultWorkspaceDir, { recursive: true });
      } catch {
        // 同上：建不出只是少个目录，不影响路径回显
      }
    }

    const [cacheBytes, disk] = await Promise.all([
      directorySize(cacheDir),
      diskUsage(cacheDir),
    ]);
    return { cacheDir, cacheBytes, disk, defaultWorkspaceDir };
  },
);

// ——— 窗口控制（自绘标题栏）———
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.on('window:reload', () => mainWindow?.reload());
ipcMain.on('window:toggle-devtools', () => mainWindow?.webContents.toggleDevTools());
ipcMain.on('window:toggle-fullscreen', () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// ——— 应用元信息（关于弹窗用）———
/**
 * 设备 ID：首次访问生成并落盘（② `<userData>/device-id.txt`），后续复用。
 * 该值是主进程自持的裸文本（不经过渲染层适配器的 JSON 编码），故直接读写文件。
 */
async function readOrCreateDeviceId(): Promise<string> {
  const existing = await readRouteFile(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const route = resolveRoute(DEVICE_ID_STORAGE_KEY, STORAGE_ROOTS);
  const deviceId = randomUUID();
  await fs.mkdir(dirname(route.filePath), { recursive: true });
  await fs.writeFile(route.filePath, deviceId, 'utf-8');
  return deviceId;
}

ipcMain.handle('app:getInfo', async () => {
  const deviceId = await readOrCreateDeviceId();
  return {
    appName: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform as NodeJS.Platform,
    osVersion: typeof process.getSystemVersion === 'function'
      ? process.getSystemVersion()
      : '',
    arch: process.arch,
    deviceId,
  };
});

// ——— 桌面端集成：系统托盘 & 全局快捷键 ———

/**
 * 应用桌面端配置补丁并立即生效（开机自启 / Dock 显隐 / 全局快捷键）。
 * 快捷键是唯一可能失败项：被系统或其它应用占用时，其余配置照常应用，
 * 仅把失败原因回传渲染层提示用户，避免"一个键位失败导致整组设置失效"。
 */
function applyDesktopConfig(patch: Partial<DesktopConfig>): DesktopConfigResult {
  const next = { ...desktopConfig, ...patch };

  if (patch.hotkey !== undefined) {
    const result = registerHotkey(patch.hotkey, toggleMainWindow);
    if (!result.ok) {
      // 注册失败时把 hotkey 记为空串，保证配置状态与实际注册结果一致
      desktopConfig = { ...next, hotkey: '' };
      updateTrayOptions({ ...patch, hotkey: '' });
      return { ok: false, error: result.error, config: desktopConfigSnapshot() };
    }
  }

  desktopConfig = next;
  updateTrayOptions(patch);

  // closeToTray 会影响开机自启的 openAsHidden 策略，开启自启时需重新下发一次
  if (desktopConfig.openAtLogin) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: desktopConfig.closeToTray,
    });
  }

  return { ok: true, config: desktopConfigSnapshot() };
}

ipcMain.handle('app:getDesktopConfig', () => desktopConfigSnapshot());

ipcMain.handle('app:setDesktopConfig', (_e, patch: Partial<DesktopConfig> | undefined) =>
  applyDesktopConfig(patch ?? {}),
);

ipcMain.on('app:showWindow', () => showMainWindow());

/** 真正退出：置 isQuitting 绕过"隐藏到托盘"的 close 拦截 */
ipcMain.on('app:quit', () => {
  isQuitting = true;
  app.quit();
});

// —— nanobot 网关进程桥 ——
ipcMain.handle('nanobot:start', async () => {
  const [serveOk] = await Promise.all([startNanobot(), startNanobotGateway()]);
  return serveOk;
});
ipcMain.handle('nanobot:stop', async () => {
  stopNanobot();
  stopNanobotGateway();
});
ipcMain.handle('nanobot:status', async () => nanobotProcess !== null);
// channels 配置同步：渲染层提交片段 JSON，主进程合并写入 config.json 并重启网关
ipcMain.handle('nanobot:syncChannels', async (_e, channelsJson: string) =>
  syncNanobotChannels(channelsJson),
);
// channels 段只读回读：渲染层本地配置缺失时据此回显（如配置直接在 nanobot 侧写入）
ipcMain.handle('nanobot:getChannels', async () => {
  try {
    return await getNanobotChannels();
  } catch (err) {
    console.warn(`[nanobot] channels 回读失败：${String(err)}`);
    return null;
  }
});
// 扫码接入：经网关认证 WS 桥执行 settings.channel.connect.{start|poll|cancel}
ipcMain.handle(
  'nanobot:channelConnect',
  async (
    _e,
    action: 'start' | 'poll' | 'cancel',
    channel: string,
    params: Record<string, string>,
  ) => channelConnectViaGateway(action, channel, params ?? {}),
);
// 强制重启网关（绕过 syncChannels 幂等短路，确保后端写入的新通道被加载）
// 可选参数为引擎渠道名：重启前确保该渠道处于启用态（引擎 feature enable 缺口双保险）
ipcMain.handle('nanobot:restartGateway', async (_e, engineChannel?: string) =>
  restartOrEnsureGateway(engineChannel),
);
// 渠道断开连接：清除凭证（微信含 account.json 状态文件）+ 停用渠道 + 重启网关（不传 engineChannel）
ipcMain.handle('nanobot:disconnectChannel', async (_e, kind: string) =>
  disconnectNanobotChannel(kind),
);
// MCP 配置同步：合并写入 config.json.tools.mcpServers 并按需重启 serve
ipcMain.handle('nanobot:syncMcp', async (_e, mcpJson: string) => syncNanobotMcp(mcpJson));
// MCP 段只读回读
ipcMain.handle('nanobot:getMcp', async () => {
  try {
    return await getNanobotMcp();
  } catch (err) {
    console.warn(`[nanobot] mcpServers 回读失败：${String(err)}`);
    return null;
  }
});
// MCP 连接探针：真实握手（initialize + tools/list），凭据由主进程从保险库补齐
// （渲染层只传 server 名与地址，**不传密钥**）。探针自身绝不抛异常。
ipcMain.handle('mcp:probe', async (_e, request: McpProbeRequest) => {
  try {
    const name = typeof request?.name === 'string' ? request.name : '';
    const secrets = name ? await credentialVault.read(name) : {};
    return await probeMcpServer({ ...request, secrets });
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      tools: [],
      error: `探针异常：${err instanceof Error ? err.message : String(err)}`,
      latencyMs: 0,
    };
  }
});
// 连接器凭据保险库：只回传可用性与 key 名清单，**密钥值永不出主进程**
ipcMain.handle('secrets:status', () => credentialVault.status());
ipcMain.handle('secrets:keys', async () => {
  try {
    return await credentialVault.keyNames();
  } catch (err) {
    console.warn(`[secrets] 密钥名清单读取失败：${String(err)}`);
    return {};
  }
});
ipcMain.handle(
  'secrets:set',
  async (_e, name: string, secrets: Record<string, string> | null | undefined) => {
    try {
      await credentialVault.write(name, secrets ?? {});
      return { ok: true };
    } catch (err) {
      // 写入失败必须回到界面上：fail-closed 的价值就在于用户看得见
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);
ipcMain.handle('secrets:delete', async (_e, name: string) => {
  try {
    await credentialVault.remove(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
// 频道会话只读扫描：渲染层「频道」列表与历史对话的数据源（失败返回空，不影响主程序）
ipcMain.handle('nanobot:listChannelSessions', async () => {
  try {
    return await listNanobotChannelSessions();
  } catch (err) {
    console.warn(`[nanobot] 频道会话列表读取失败：${String(err)}`);
    return [];
  }
});
ipcMain.handle('nanobot:getChannelSession', async (_e, key: string) => {
  try {
    return await getNanobotChannelSession(key);
  } catch (err) {
    console.warn(`[nanobot] 频道会话读取失败 key=${key}：${String(err)}`);
    return null;
  }
});

/** gateway 出站端点（health server 同端口，仅本地回环监听） */
const GATEWAY_HEALTH_HOST = '127.0.0.1';
const GATEWAY_HEALTH_PORT = 18790;

/**
 * 智能体侧主动发送消息到 IM 频道用户：POST gateway `/v1/send`。
 * gateway 经渠道长连接投递消息并镜像进会话历史；
 * 失败（网关未启动 / 渠道未启用 / 参数非法）返回 ok=false 与原因，不抛异常。
 * @param params channel / chatId / content
 * @returns 发送结果
 */
function sendChannelMessage(params: ChannelSendParams): Promise<ChannelSendResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      channel: params.channel,
      chat_id: params.chatId,
      content: params.content,
    });
    const req = httpRequest(
      {
        host: GATEWAY_HEALTH_HOST,
        port: GATEWAY_HEALTH_PORT,
        path: '/v1/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d.toString()));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ ok: true });
            return;
          }
          let error = `gateway 返回 ${res.statusCode}`;
          try {
            const parsed = JSON.parse(raw) as { error?: string };
            if (parsed.error) error = parsed.error;
          } catch {
            /* 保留默认错误文案 */
          }
          resolve({ ok: false, error });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('gateway /v1/send 超时')));
    req.on('error', (err) =>
      resolve({ ok: false, error: `网关不可达：${err.message}` }),
    );
    req.end(body);
  });
}

// 主动出站：渲染层频道会话发送栏 → 主进程 → gateway /v1/send → IM 用户
ipcMain.handle(
  'nanobot:sendChannelMessage',
  async (_e, params: ChannelSendParams) => sendChannelMessage(params),
);

// ——————————————————————————————————————————————
// nanobot 定时任务同步（自动化页自动同步入口）
// 渲染层仅提交任务片段 JSON；主进程解析 config.json 的 workspace，
// 幂等合并进 {workspace}/cron/jobs.json 并通知 gateway 热加载生效。
// 路径由主进程自行解析，不接受渲染层指定，杜绝任意路径写入。
// ——————————————————————————————————————————————

/** 托管标记值（与渲染层 ai/runtime/nanobotHttp/tasks.ts 的 MANAGED_BY_SMARTAGENT 一致） */
const MANAGED_BY_SMARTAGENT = 'smartagent';

/** 定时任务同步结果（渲染层据此决定提示文案） */
interface TaskSyncResult {
  ok: boolean;
  message: string;
  /** 配置是否实际发生变更（幂等校准时为 false，渲染层可据此静默） */
  changed?: boolean;
}

/**
 * 解析 nanobot 实际使用的 workspace 路径：
 * 读取 config.json 的 `agents.defaults.workspace`（展开 `~`），
 * 缺省回退 `~/.nanobot/workspace`（与引擎 get_workspace_path 一致）。
 */
async function resolveNanobotWorkspacePath(): Promise<string> {
  const configPath = await resolveNanobotConfigPath();
  if (configPath && existsSync(configPath)) {
    try {
      const data = JSON.parse(await fs.readFile(configPath, 'utf-8')) as {
        agents?: { defaults?: { workspace?: string } };
      };
      const ws = data.agents?.defaults?.workspace?.trim();
      if (ws) {
        const expanded = ws.replace(/^~(?=[/\\]|$)/, app.getPath('home'));
        return join(expanded); // 归一化分隔符
      }
    } catch (err) {
      console.warn(`[nanobot] 解析 workspace 失败：${String(err)}`);
    }
  }
  return join(app.getPath('home'), '.nanobot', 'workspace');
}

/** 判断 job 是否由智能体应用托管（payload.originMetadata.managedBy 标记） */
function isManagedJob(job: unknown): boolean {
  if (typeof job !== 'object' || job === null) return false;
  const payload = (job as Record<string, unknown>).payload;
  if (typeof payload !== 'object' || payload === null) return false;
  const meta = (payload as Record<string, unknown>).originMetadata;
  if (typeof meta !== 'object' || meta === null) return false;
  return (meta as Record<string, unknown>).managedBy === MANAGED_BY_SMARTAGENT;
}

/** 提取 job 的「规格」字段（排除引擎动态维护的 state 与时间戳），用于幂等比较 */
function jobSpec(job: Record<string, unknown>): Record<string, unknown> {
  const { state: _state, createdAtMs: _c, updatedAtMs: _u, ...spec } = job;
  return spec;
}

/**
 * 将任务片段幂等合并进 jobs.json（临时文件 + rename 原子写入）：
 * - 非托管任务（dream/heartbeat 系统任务、聊天会话创建的任务）原样保留；
 *   但非托管任务若 id 与入参托管任务相同，视为已被前端收编，不再保留；
 * - 托管任务集合以片段为准整体替换（新增/更新/删除）；
 * - 同 id 任务保留引擎执行状态（runHistory/lastStatus 等），仅更新规格与下次运行时间；
 * - 托管任务规格无变化时不落盘，返回 changed=false（供调用方跳过通知）。
 * 磁盘 jobs.json 损坏时先备份为 .corrupt-<ts> 再重建，绝不静默清空。
 *
 * @param jobsPath `{workspace}/cron/jobs.json` 绝对路径
 * @param incomingJobs 渲染层提交的托管任务数组（完整 CronJob 存储形态）
 * @returns 磁盘内容是否实际变更
 */
async function mergeTasksIntoJobsStore(
  jobsPath: string,
  incomingJobs: Array<Record<string, unknown>>,
): Promise<boolean> {
  let existingJobs: Array<Record<string, unknown>> = [];
  let version = 1;
  if (existsSync(jobsPath)) {
    try {
      const data = JSON.parse(await fs.readFile(jobsPath, 'utf-8')) as {
        version?: number;
        jobs?: Array<Record<string, unknown>>;
      };
      version = data.version ?? 1;
      existingJobs = Array.isArray(data.jobs) ? data.jobs : [];
    } catch {
      const backup = `${jobsPath}.corrupt-${Date.now()}`;
      await fs.rename(jobsPath, backup);
      console.warn(`[nanobot] jobs.json 损坏，已备份至 ${backup}`);
    }
  }

  // 幂等变更检测：仅比较托管任务的规格字段（state 由引擎动态维护，不参与）
  const currentSpec = JSON.stringify(existingJobs.filter(isManagedJob).map(jobSpec));
  const nextSpec = JSON.stringify(incomingJobs.map(jobSpec));
  if (currentSpec === nextSpec) return false;

  // 入参托管任务的 id 集合：用于「同 id 收编」，剔除重复的非托管旧副本
  const incomingIds = new Set(incomingJobs.map((j) => String(j.id ?? '')));

  const kept = existingJobs.filter(
    (j) => !isManagedJob(j) && !incomingIds.has(String(j.id ?? '')),
  );
  const existingManaged = new Map(
    existingJobs
      .filter(isManagedJob)
      .map((j) => [String(j.id ?? ''), j]),
  );

  // 同 id 任务：保留引擎执行状态（runHistory 只由引擎追加，绝不覆盖）
  const mergedManaged = incomingJobs.map((job) => {
    const prev = existingManaged.get(String(job.id ?? ''));
    if (!prev) return job;
    const prevState =
      typeof prev.state === 'object' && prev.state !== null
        ? (prev.state as Record<string, unknown>)
        : {};
    const nextState =
      typeof job.state === 'object' && job.state !== null
        ? (job.state as Record<string, unknown>)
        : {};
    return {
      ...job,
      createdAtMs: prev.createdAtMs ?? job.createdAtMs,
      state: {
        ...prevState,
        ...nextState,
        runHistory: prevState.runHistory ?? [],
      },
    };
  });

  const payload = { version, jobs: [...kept, ...mergedManaged] };
  await fs.mkdir(dirname(jobsPath), { recursive: true });
  const tmp = `${jobsPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tmp, jobsPath);
  return true;
}

/**
 * 通知 gateway 热加载 cron 任务（POST /v1/cron/reload，尽力而为）。
 * 网关未启动或为旧版本（无该端点）时返回 false：不阻塞同步流程，
 * CronService 最迟会在下一个 tick（≤5 分钟）自动重载 jobs.json。
 */
function requestCronReload(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: GATEWAY_HEALTH_HOST,
        port: GATEWAY_HEALTH_PORT,
        path: '/v1/cron/reload',
        method: 'POST',
        headers: { 'Content-Length': 0 },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * 同步定时任务配置：幂等合并进 `{workspace}/cron/jobs.json` 并通知 gateway 热加载。
 * 与 channels 同步不同：cron 存储支持运行期热加载，无需重启网关。
 * @param tasksJson 渲染层提交的任务片段 JSON（{ version, jobs }）
 * @returns 同步结果
 */
async function syncNanobotTasks(tasksJson: string): Promise<TaskSyncResult> {
  try {
    const parsed = JSON.parse(tasksJson) as { jobs?: unknown };
    const jobs = Array.isArray(parsed.jobs)
      ? (parsed.jobs as Array<Record<string, unknown>>)
      : [];
    const workspace = await resolveNanobotWorkspacePath();
    const jobsPath = join(workspace, 'cron', 'jobs.json');
    const changed = await mergeTasksIntoJobsStore(jobsPath, jobs);
    if (!changed) {
      return { ok: true, changed: false, message: '任务配置与 nanowork 一致，无需变更' };
    }
    const reloaded = await requestCronReload();
    return {
      ok: true,
      changed: true,
      message: reloaded
        ? '任务配置已写入 nanowork 并生效'
        : '任务配置已写入 nanowork，将在 5 分钟内自动生效（或重启网关后立即生效）',
    };
  } catch (err) {
    return { ok: false, message: `任务配置同步失败：${String(err)}` };
  }
}

/**
 * 扫描 `{workspace}/cron/runs/` 的 cron 执行审计记录（只读）。
 * 引擎 bound_runner 每次执行写入一个 JSON（queued → ok/error）；
 * 损坏文件静默跳过。按更新时间倒序返回，上限 200 条。
 */
async function listNanobotCronRuns(): Promise<NanobotCronRunRecord[]> {
  const workspace = await resolveNanobotWorkspacePath();
  const runsDir = join(workspace, 'cron', 'runs');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: NanobotCronRunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(join(runsDir, entry.name), 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const status =
        data.status === 'ok' || data.status === 'error' || data.status === 'queued'
          ? data.status
          : 'queued';
      records.push({
        runId: typeof data.run_id === 'string' ? data.run_id : entry.name.slice(0, -5),
        jobId: typeof data.job_id === 'string' ? data.job_id : '',
        jobName: typeof data.job_name === 'string' ? data.job_name : '',
        sessionKey: typeof data.session_key === 'string' ? data.session_key : '',
        status,
        ...(typeof data.error === 'string' && data.error ? { error: data.error } : {}),
        ...(typeof data.response === 'string' ? { response: data.response } : {}),
        updatedAtMs: typeof data.updated_at_ms === 'number' ? data.updated_at_ms : 0,
      });
    } catch {
      continue;
    }
  }
  records.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return records.slice(0, 200);
}

/**
 * 读取定时任务执行会话的完整历史（只读）。
 * 引擎以 `api:cron-{taskId}` 会话键执行任务并落盘 JSONL（sessions 目录），
 * 此处仅允许该前缀的会话键，避免越权读取其他会话；不存在返回 null。
 * @param taskId 定时任务 id（前端 TaskConfig.id）
 */
async function getCronSession(taskId: string): Promise<NanobotCronSessionDetail | null> {
  const safeId = String(taskId).trim();
  if (!safeId || /[:/\\]/.test(safeId)) return null;
  const key = `api:cron-${safeId}`;
  const fileName = `${encodeSessionKey(key)}.jsonl`;
  // 与频道会话同构：跨 workspace 收集全部副本后选最新，仅解析胜出者一次
  const best = pickNewestChannelCandidate(await collectChannelSessionCandidates(fileName));
  if (!best) return null;
  const parsed = await parseChannelSessionFile(best.filePath);
  if (!parsed) return null;
  return {
    key,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    messageCount: parsed.messageCount,
    messages: parsed.messages,
  };
}

/**
 * 删除某个定时任务的全部执行留痕（不可撤销）。
 *
 * 只清「执行痕迹」，不动任务本身——任务仍在 `cron/jobs.json` 里按计划执行，
 * 下次触发会产生全新的审计文件与会话文件。删除范围：
 * 1. `{workspace}/cron/runs/*.json` 中 `job_id === taskId` 的审计文件；
 * 2. sessions 目录下 `api:cron-{taskId}` 的会话 JSONL（跨 workspace 的全部副本 ——
 *    该会话是任务级共享、逐次追加增长，不清掉则新的执行记录会带着历史内容出现）。
 *
 * **为什么必须删审计文件**：渲染层 `fetchCronRuns` 每 15s 以审计目录为唯一数据源
 * 重建执行记录并据此创建侧边栏会话，只删本地会话会在下次轮询或重启后原样复现。
 *
 * @param taskId 定时任务 id（前端 TaskConfig.id）
 * @returns ok=false 表示存在删不掉的文件（error 汇总原因），removed 为实际删除的文件数
 */
async function deleteNanobotCronHistory(
  taskId: string,
): Promise<NanobotCronHistoryDeleteResult> {
  const safeId = String(taskId).trim();
  // 与 getCronSession 同一道闸：id 里出现分隔符即视为非法，避免越权删除他人文件
  if (!safeId || /[:/\\]/.test(safeId)) {
    return { ok: false, removed: 0, error: '任务 id 非法' };
  }
  const failures: string[] = [];
  let removed = 0;

  // 1) 审计文件：逐个读取 job_id，只删命中本任务的（损坏文件跳过，绝不误删）
  try {
    const runsDir = join(await resolveNanobotWorkspacePath(), 'cron', 'runs');
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(runsDir, { withFileTypes: true });
    } catch {
      entries = []; // 目录不存在 = 没有留痕，非错误
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = join(runsDir, entry.name);
      let jobId = '';
      try {
        const data = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>;
        jobId = typeof data.job_id === 'string' ? data.job_id : '';
      } catch {
        continue;
      }
      if (jobId !== safeId) continue;
      try {
        await fs.rm(filePath, { force: true });
        removed += 1;
      } catch (err) {
        failures.push(`${entry.name}: ${String(err)}`);
      }
    }
  } catch (err) {
    failures.push(String(err));
  }

  // 2) 引擎会话文件：sessions/{base64url('api:cron-{taskId}')}.jsonl
  try {
    const fileName = `${encodeSessionKey(`api:cron-${safeId}`)}.jsonl`;
    for (const candidate of await collectChannelSessionCandidates(fileName)) {
      try {
        await fs.rm(candidate.filePath, { force: true });
        removed += 1;
      } catch (err) {
        failures.push(`${candidate.filePath}: ${String(err)}`);
      }
    }
  } catch (err) {
    failures.push(String(err));
  }

  return failures.length > 0
    ? { ok: false, removed, error: failures.join('; ') }
    : { ok: true, removed };
}

// 定时任务同步：渲染层提交片段 JSON，主进程合并写入 jobs.json 并通知热加载
ipcMain.handle('nanobot:syncTasks', async (_e, tasksJson: string) =>
  syncNanobotTasks(tasksJson),
);
// cron 执行审计记录只读扫描：渲染层「运行记录」定时触发条目的数据源
ipcMain.handle('nanobot:listCronRuns', async () => {
  try {
    return await listNanobotCronRuns();
  } catch (err) {
    console.warn(`[nanobot] cron 运行记录读取失败：${String(err)}`);
    return [];
  }
});
// cron 执行会话只读读取：渲染层展开定时触发记录时展示完整执行过程
ipcMain.handle('nanobot:getCronSession', async (_e, taskId: string) => {
  try {
    return await getCronSession(taskId);
  } catch (err) {
    console.warn(`[nanobot] cron 会话读取失败：${String(err)}`);
    return null;
  }
});
// cron 执行留痕删除：渲染层「从列表中移除」自动任务分组时真正清掉执行记录
ipcMain.handle('nanobot:deleteCronHistory', async (_e, taskId: string) => {
  try {
    return await deleteNanobotCronHistory(taskId);
  } catch (err) {
    console.warn(`[nanobot] cron 留痕删除失败：${String(err)}`);
    return { ok: false, removed: 0, error: String(err) };
  }
});

// —— 技能目录扫描桥（FR-3.1） ——
/**
 * 简易 YAML frontmatter 解析：仅取顶层 key 与 metadata.xxx。
 *
 * 必须与渲染层 `src/lib/skillParser.ts` 的解析规则保持一致（含
 * 「key 允许连字符」「块状列表拼回同一 key」两条）——同一份 SKILL.md
 * 在主进程与渲染层被解析成不同的 `allowed-tools`，是最难定位的一类不一致。
 */
function parseFrontMatter(text: string): Record<string, string> {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return {};
  const result: Record<string, string> = {};
  let inMetadata = false;
  /** 上一个「值为空」的顶层 key —— 随后的 `- item` 行都归它 */
  let openListKey: string | null = null;
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && openListKey) {
      const value = item[1].replace(/^["']|["']$/g, '').trim();
      if (value) {
        result[openListKey] = result[openListKey]
          ? `${result[openListKey]},${value}`
          : value;
      }
      continue;
    }

    // key 允许连字符：`allowed-tools` / `user-invocable` 都是合法字段名，
    // 只认 \w 会把它们整行丢掉（静默失效比报错更难查）
    const m = line.match(/^(\s*)([\w.-]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, raw] = m;
    const value = raw.replace(/^["']|["']$/g, '').trim();
    if (indent.length === 0) {
      inMetadata = key === 'metadata';
      result[key] = value;
      openListKey = value === '' ? key : null;
    } else if (inMetadata || key.startsWith('metadata.')) {
      result[`metadata.${key.replace(/^metadata\./, '')}`] = value;
    }
  }
  return result;
}

/** frontmatter 列表字段 → 数组；空值返回 undefined 而不是空数组 */
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** frontmatter 布尔字段：只有明确的 falsy 写法才算 false，缺省按 fallback */
function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  return fallback;
}

/** 扫描结果里的技能形状（与渲染层 `Skill` 对齐；`override`/`enabled` 由 store 派生） */
interface ScannedSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  prompt: string;
  source: 'local';
  scope: 'user' | 'project';
  override: 'on';
  enabled: boolean;
  allowedTools?: string[];
  userInvocable?: boolean;
  version?: string;
  path: string;
  installedAt: string;
}

/**
 * 扫描一个技能根目录（`<root>/<name>/SKILL.md`）。
 *
 * `id` 取**目录名**而不是 frontmatter 的 `name`：目录名才是引擎侧的技能身份
 * （`SkillsLoader._skill_entries_from_dir` 用 `skill_dir.name`），三态覆盖表
 * 也是按这个名字下发给引擎的。取 frontmatter 名会让「写在 frontmatter 里
 * 但目录名不同」的技能永远覆盖不上——而 Agent Skills 规范本就要求两者相同。
 */
async function scanSkillsDir(root: string, scope: 'user' | 'project'): Promise<ScannedSkill[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    // 目录不存在属正常情况（尚未安装任何技能 / 项目里没放技能）；其余错误仅告警。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[skills] 扫描技能目录失败（${root}）：${String(err)}`);
    }
    return [];
  }

  const skills: ScannedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const skillPath = join(root, entry.name);
    const skillFile = join(skillPath, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const text = await fs.readFile(skillFile, 'utf-8');
      const fm = parseFrontMatter(text);
      // id 取目录名：目录名才是引擎侧的技能身份，三态覆盖表按它下发。
      const id = entry.name;
      const name = (fm.name ?? entry.name) as string;
      const description = ((fm.description_zh as string) || (fm.description as string) || '').trim();
      const rawCategory = (fm['metadata.category'] as string) ?? 'other';
      const category = rawCategory.charAt(0).toUpperCase() + rawCategory.slice(1);
      const version = (fm.version as string) ?? '0.1.0';
      const prompt = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim();
      skills.push({
        id,
        name,
        description,
        category,
        icon: '📦',
        prompt: prompt.slice(0, 4000),
        source: 'local',
        scope,
        override: 'on',
        enabled: true,
        allowedTools: parseList(fm['allowed-tools']),
        userInvocable: parseBoolean(fm['user-invocable'], true),
        version,
        path: skillPath,
        installedAt: new Date().toISOString(),
      });
    } catch {
      // 忽略解析失败的单个技能目录
    }
  }
  return skills;
}

// —— 技能目录热加载（FR-3.1）——
/**
 * 已监听的技能目录 → watcher。重复调用 `skills:loadUser` 时不重复加监听。
 * 目录被删掉后 watcher 会自行失活，这里保留条目即可（重建监听的价值很低）。
 */
const skillWatchers = new Map<string, { close: () => void }>();

/** 防抖句柄：编辑器保存 SKILL.md 会连发多次 change，合并成一次通知 */
let skillsChangedTimer: ReturnType<typeof setTimeout> | null = null;

function notifySkillsChanged(): void {
  if (skillsChangedTimer) clearTimeout(skillsChangedTimer);
  skillsChangedTimer = setTimeout(() => {
    skillsChangedTimer = null;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('skills:changed');
    }
  }, 300);
}

/**
 * 给一个技能根目录加变更监听（幂等）。
 *
 * 只监听目录本身（不递归）：技能是「一个子目录一个技能」，
 * 目录的增删会冒泡到父目录，而 SKILL.md 的内容修改会冒泡到技能子目录。
 * 因此这里对每个已知技能子目录也各加一层，才能覆盖「原地改 SKILL.md」。
 */
function watchSkillsRoot(root: string): void {
  if (skillWatchers.has(root)) return;
  if (!existsSync(root)) return;
  try {
    const watcher = fsWatch(root, { persistent: false }, () => notifySkillsChanged());
    skillWatchers.set(root, watcher);
  } catch (err) {
    // 监听失败不影响扫描本身：用户仍可手动重进技能页触发重扫。
    console.warn(`[skills] 监听技能目录失败（${root}）：${String(err)}`);
  }
}

ipcMain.handle('skills:loadUser', async (_e, workspace?: string) => {
  const roots: Array<{ root: string; scope: 'user' | 'project' }> = [
    { root: USER_SKILLS_DIR, scope: 'user' },
  ];
  if (typeof workspace === 'string' && workspace.trim() !== '') {
    // 项目级技能的目录是 `<workspace>/skills` —— 这是引擎真正读取的位置
    // （`SkillsLoader.workspace_skills = workspace / "skills"`）。
    // 扫别的目录只会列出「界面看得见、引擎不认」的技能。
    roots.push({ root: join(workspace, 'skills'), scope: 'project' });
  }

  const skills: ScannedSkill[] = [];
  const seen = new Set<string>();
  for (const { root, scope } of roots) {
    watchSkillsRoot(root);
    for (const skill of await scanSkillsDir(root, scope)) {
      // 先到先得：用户级在前、项目级在后，与 PRD §12.4 的优先级链一致
      // （这里反过来排就变成「项目级被用户级盖掉」）。
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      skills.push(skill);
    }
  }
  return skills;
});

// —— 插件包生命周期（FR-3.4）——
/**
 * 三条 IPC **只做文件系统那一半**（扫 / 装 / 卸）。
 *
 * 刻意的职责切分：**包长什么样、装在不在**是主进程的事（要读盘），
 * **激活没有**是引擎的事（`GET /v1/plugins`，激活标记指纹绑定）。客户端
 * 不复刻引擎的哈希、也不存一份自己的激活真相——两份真相不一致时无法裁决谁对。
 */

/** 扫描：坏包进 `skipped`，其余照常返回（一个坏包不该让页面看起来什么都没装） */
ipcMain.handle('plugins:scan', async () => {
  const { plugins, skipped } = await readInstalledPlugins(USER_PLUGINS_DIR);
  return { plugins, skipped, pluginsRoot: USER_PLUGINS_DIR };
});

/**
 * 安装：把来源目录复制进 `USER_PLUGINS_DIR/<清单 name>`。
 * 校验全部前置（清单非法 / 名字不合规 / 来源在插件根之内）→ 失败时不落盘。
 */
ipcMain.handle(
  'plugins:install',
  async (_e, sourceDir: unknown, overwrite?: unknown) => {
    if (typeof sourceDir !== 'string' || sourceDir.trim() === '') {
      return { ok: false, error: '未指定插件包来源目录', errorKind: 'source-missing' as const };
    }
    return installPluginPackage({
      sourceDir,
      pluginsRoot: USER_PLUGINS_DIR,
      overwrite: overwrite === true,
    });
  },
);

/** 卸载：删除包目录（不可撤销）。名字非法或路径越界一律拒绝。 */
ipcMain.handle('plugins:uninstall', async (_e, name: unknown) => {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: '未指定插件名' };
  }
  const removed = await uninstallPluginPackage(USER_PLUGINS_DIR, name);
  return removed ? { ok: true } : { ok: false, error: `插件「${name}」不存在或名字不合法` };
});

/**
 * 同步技能三态覆盖：幂等合并进 `config.json` 的 `agents.defaults.skillOverrides`。
 *
 * 键名是 camelCase（`skillOverrides`）——引擎的 pydantic 模型挂了
 * `alias_generator=to_camel`，写 snake_case 不会被识别，覆盖会静默失效。
 * 覆盖表变化需要重启网关才对已建立的会话生效；由调用方按 needsRestart 提示。
 */
async function syncNanobotSkills(overridesJson: string): Promise<{
  ok: boolean;
  message: string;
  changed?: boolean;
  needsRestart?: boolean;
}> {
  try {
    if (nanobotStartupPromise) await nanobotStartupPromise;
    const parsed = JSON.parse(overridesJson) as unknown;
    const overrides: Record<string, unknown> =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const configPath = await resolveNanobotConfigPath();
    if (!configPath) {
      return { ok: false, message: '未找到 nanobot config.json，技能覆盖未写入' };
    }
    const changed = await mergeSkillOverridesIntoConfig(configPath, overrides);
    if (!changed) {
      return { ok: true, changed: false, message: '技能覆盖与 nanowork 一致，无需变更' };
    }
    // 覆盖表在 serve 启动时读入 AgentDefaults；改完必须重启才作用于新会话。
    if (nanobotProcess) {
      stopNanobot();
      await waitForPortFree('127.0.0.1', 8900, 5000);
      await startNanobot();
      if (nanobotProcess) {
        return { ok: true, changed: true, message: '技能覆盖已写入并生效' };
      }
      return { ok: false, changed: true, message: '技能覆盖已写入，但 serve 重启失败，请检查 nanowork 日志' };
    }
    const portBusy = await isPortInUse('127.0.0.1', 8900);
    return {
      ok: true,
      changed: true,
      message: portBusy
        ? '技能覆盖已写入 agents.defaults.skillOverrides，serve 由外部进程托管，请重启该网关后生效'
        : '技能覆盖已写入 agents.defaults.skillOverrides，请启动网关后生效',
      needsRestart: true,
    };
  } catch (err) {
    return { ok: false, message: `技能覆盖同步失败：${String(err)}` };
  }
}

ipcMain.handle('nanobot:syncSkills', async (_e, overridesJson: string) => {
  try {
    return await syncNanobotSkills(overridesJson);
  } catch (err) {
    return { ok: false, message: `技能覆盖同步失败：${String(err)}` };
  }
});

// —— 生命周期 ——
app.whenReady().then(async () => {
  // 隐藏系统级原生菜单（自绘菜单栏接管）
  Menu.setApplicationMenu(null);

  // 旧版单文件存储 → ①/② 目录化落点的一次性迁移。
  // 必须早于 createWindow：建窗时会同步读主题偏好，迁移完成后即可直接命中新落点。
  await migrateLegacyStore();

  void createWindow();

  // 托盘 + 全局快捷键：窗口建好后立即初始化，保证冷启动即可用快捷键唤起。
  // 依赖全部以回调注入，托盘模块不反向依赖 mainWindow，避免循环引用。
  try {
    initTray(
      {
        toggleWindow: toggleMainWindow,
        showWindow: showMainWindow,
        isWindowVisible: () => Boolean(mainWindow?.isVisible()),
        navigate: (path) => mainWindow?.webContents.send('app:navigate', path),
        showAbout: () => mainWindow?.webContents.send('app:open-about'),
        quitApp: () => {
          isQuitting = true;
          app.quit();
        },
        onOptionsChange: (patch) => {
          // 托盘菜单勾选变更：主进程立即生效，并回推渲染层同步 UI 与持久化
          void applyDesktopConfig(patch);
          mainWindow?.webContents.send('app:desktop-config-changed', desktopConfigSnapshot());
        },
      },
      desktopConfig,
    );
  } catch (err) {
    console.warn('[tray] 托盘初始化失败：', err);
  }

  // 兜底：托盘不可用时（图标缺失、Linux 缺 libappindicator 等）必须回退为
  // "关闭即退出"，否则用户将彻底失去退出入口（关闭按钮被隐藏逻辑拦截）。
  if (!isTrayReady() && desktopConfig.closeToTray) {
    console.warn('[tray] 托盘不可用，已回退为「关闭窗口即退出」');
    desktopConfig = { ...desktopConfig, closeToTray: false };
  }

  // 注册全局唤起快捷键；被占用时仅告警，不影响主流程（用户可在设置页换键）
  const hotkeyResult = registerHotkey(desktopConfig.hotkey, toggleMainWindow);
  if (!hotkeyResult.ok) console.warn(`[hotkey] ${hotkeyResult.error}`);

  // 桌面端：并行拉起 serve（/v1 API）与 gateway（IM channels 长连接），
  // 两者齐备智能体才能既对话又与飞书等机器人互通（失败不影响主程序，仅记录警告）
  nanobotStartupPromise = Promise.all([startNanobot(), startNanobotGateway()]).then(
    ([serveOk]) => serveOk,
  );
  void nanobotStartupPromise.then((ok) => {
    if (ok) console.log('[nanobot] 网关已在后台启动');
  });
});

app.on('window-all-closed', () => {
  // 窗口被真正关闭（非隐藏到托盘）时：非 macOS 直接退出。
  // macOS 遵循"关闭最后一个窗口不退出应用"的惯例，保留进程等待 activate 重建。
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 置位后窗口 close 拦截会放行，否则 app.quit() 会被"隐藏到托盘"逻辑吃掉，
  // 导致托盘退出 / Cmd+Q / 安装程序升级重启时进程退不干净
  isQuitting = true;
  // 卸载全局快捷键，避免退出过程中残留系统级热键占用
  unregisterAllHotkeys();
  destroyTray();
  // 关闭网关认证 WS 桥连接，避免退出时残留孤儿连接；在途请求随桥一并作废
  gatewayBridge?.ws.terminate();
  gatewayBridge = null;
  stopNanobot();
  stopNanobotGateway();
});

app.on('activate', () => {
  // 点击 Dock 图标 / 任务栏重新激活：窗口可能只是被隐藏到托盘，需重新显示而非重建
  if (mainWindow) showMainWindow();
  else void createWindow();
});
