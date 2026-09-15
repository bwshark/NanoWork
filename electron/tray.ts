import { Menu, Tray, app, nativeImage } from 'electron';
import { join } from 'node:path';

/**
 * 系统托盘（菜单栏图标）模块。
 *
 * 行为对齐微信/钉钉：关闭窗口不退出进程，应用常驻托盘；
 * 单击托盘图标唤起/隐藏主窗口，右键弹出菜单（设置、开机自启、关于、退出）。
 *
 * 依赖倒置：窗口相关动作全部由外部注入 handlers，本模块不直接依赖 mainWindow，
 * 避免与 main.ts 形成循环引用。
 */

/** 托盘相关配置（与渲染层 DesktopConfig 对应，仅含主进程需要的字段） */
export interface TrayOptions {
  /** 开机/登录时自动启动 */
  openAtLogin: boolean;
  /** 关闭窗口时最小化到托盘而非退出 */
  closeToTray: boolean;
  /** macOS：Dock 中是否显示图标（关闭后仅托盘可唤起） */
  showInDock: boolean;
  /** 当前全局唤起快捷键（展示用；注册由 hotkey.ts 负责） */
  hotkey: string;
}

export const DEFAULT_TRAY_OPTIONS: TrayOptions = {
  openAtLogin: false,
  closeToTray: true,
  showInDock: true,
  hotkey: '',
};

/** 托盘依赖的外部动作集合 */
export interface TrayHandlers {
  /** 主窗口显隐切换（托盘单击与全局快捷键共用同一逻辑） */
  toggleWindow: () => void;
  /** 显示并聚焦主窗口 */
  showWindow: () => void;
  /** 主窗口是否处于可见状态（用于菜单项文案切换） */
  isWindowVisible: () => boolean;
  /** 通知渲染层跳转路由（如托盘「打开设置」） */
  navigate: (path: string) => void;
  /** 通知渲染层打开「关于」弹窗 */
  showAbout: () => void;
  /** 真正退出应用（绕过最小化到托盘） */
  quitApp: () => void;
  /** 菜单勾选变化：渲染层负责持久化，主进程负责立即生效 */
  onOptionsChange: (patch: Partial<TrayOptions>) => void;
}

let tray: Tray | null = null;
let handlers: TrayHandlers | null = null;
let options: TrayOptions = { ...DEFAULT_TRAY_OPTIONS };

/** 托盘图标：从 assets/icon.png 缩放到 16px，避免大图在菜单栏被裁切/模糊 */
function buildTrayIcon(): Electron.NativeImage {
  const iconPath = join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(iconPath);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

/**
 * 构建右键菜单。每次弹出前重建，保证「显示/隐藏」文案与勾选状态为最新；
 * 菜单是快照对象，配置变更后必须重建才能反映到 UI。
 */
function buildContextMenu(): Menu {
  const h = handlers;
  if (!h) return Menu.buildFromTemplate([]);

  const visible = h.isWindowVisible();
  const hotkeyHint = options.hotkey ? ` (${options.hotkey})` : '';
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: visible ? '隐藏窗口' : `显示窗口${hotkeyHint}`,
      click: () => (visible ? h.toggleWindow() : h.showWindow()),
    },
    { type: 'separator' },
    {
      label: '打开设置',
      click: () => {
        h.showWindow();
        h.navigate('/settings');
      },
    },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: options.openAtLogin,
      click: (item) => h.onOptionsChange({ openAtLogin: item.checked }),
    },
    {
      label: '关闭时最小化到托盘',
      type: 'checkbox',
      checked: options.closeToTray,
      click: (item) => h.onOptionsChange({ closeToTray: item.checked }),
    },
    // Dock 仅 macOS 存在，其它平台不展示无关开关
    ...(isMac
      ? [
          {
            label: '在 Dock 中显示图标',
            type: 'checkbox' as const,
            checked: options.showInDock,
            click: (item: { checked: boolean }) =>
              h.onOptionsChange({ showInDock: item.checked }),
          },
        ]
      : []),
    { type: 'separator' },
    {
      label: `关于 ${app.getName()}`,
      click: () => {
        h.showWindow();
        h.showAbout();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => h.quitApp() },
  ];

  return Menu.buildFromTemplate(template);
}

/** 重建菜单（配置或窗口状态变化后调用） */
export function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(buildContextMenu());
}

/** 托盘是否已初始化 */
export function isTrayReady(): boolean {
  return tray !== null;
}

/** 获取当前托盘配置快照 */
export function getTrayOptions(): TrayOptions {
  return { ...options };
}

/**
 * 更新托盘配置并立即生效（开机自启、Dock 显隐）。
 * 快捷键不在此处注册，由调用方经 hotkey.ts 处理，保证单一职责。
 */
export function updateTrayOptions(patch: Partial<TrayOptions>): void {
  const prev = options;
  options = { ...options, ...patch };

  if (patch.openAtLogin !== undefined && patch.openAtLogin !== prev.openAtLogin) {
    // openAsHidden：开机启动时只驻留托盘、不弹窗；仅在"关闭到托盘"开启时才有意义
    app.setLoginItemSettings({
      openAtLogin: options.openAtLogin,
      openAsHidden: options.openAtLogin && options.closeToTray,
    });
  }

  if (patch.showInDock !== undefined && patch.showInDock !== prev.showInDock) {
    if (process.platform === 'darwin') {
      if (options.showInDock) app.dock?.show();
      else app.dock?.hide();
    }
  }

  refreshTrayMenu();
}

/**
 * 初始化托盘。应在 app.whenReady 之后、窗口创建之后调用。
 * 图标资源缺失时降级为不创建托盘（应用仍可正常运行，仅失去后台常驻能力）。
 */
export function initTray(h: TrayHandlers, initialOptions: Partial<TrayOptions> = {}): void {
  if (tray) return;

  handlers = h;
  options = { ...DEFAULT_TRAY_OPTIONS, ...initialOptions };

  const image = buildTrayIcon();
  if (image.isEmpty()) {
    console.warn('[tray] 托盘图标资源缺失，跳过托盘初始化');
    return;
  }

  tray = new Tray(image);
  tray.setToolTip(app.getName());
  refreshTrayMenu();

  // 单击：切换主窗口显隐（Windows/Linux 与 macOS 行为统一，对齐微信）
  tray.on('click', () => {
    handlers?.toggleWindow();
    // 窗口显隐后菜单首项文案需同步，延迟一帧等窗口状态稳定
    setTimeout(refreshTrayMenu, 50);
  });

  // 右键弹出菜单。
  // macOS 由系统自动弹出已设置的 contextMenu，手动再弹一次会造成菜单闪烁/重复；
  // 这里只负责刷新内容，确保"显示窗口/隐藏窗口"文案是最新状态。
  tray.on('right-click', () => {
    refreshTrayMenu();
    if (process.platform !== 'darwin') tray?.popUpContextMenu();
  });

  // 双击兜底：仅 Linux（部分桌面环境如 Unity 不派发 click 事件）。
  // 不能无条件绑定：Windows 上双击会先派发两次 click，再叠加一次 double-click，
  // 导致窗口被反复显隐切换。
  if (process.platform === 'linux') {
    tray.on('double-click', () => handlers?.showWindow());
  }

  // 开机自启与 Dock 显隐：按初始配置立即应用一次
  if (options.openAtLogin) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: options.closeToTray,
    });
  }
  if (process.platform === 'darwin' && !options.showInDock) {
    app.dock?.hide();
  }
}

/** 应用退出前销毁托盘，释放系统资源 */
export function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  handlers = null;
}
