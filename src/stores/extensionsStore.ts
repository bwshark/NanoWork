import { create } from 'zustand';
import { platform } from '@/platform';
import { toast } from '@/components/Toast';
import type {
  ExtensionServiceStatus,
  InstalledExtension,
} from '@/types/extension';

/**
 * 扩展（Extension）的运行时视图。
 *
 * ## 为什么**不**持久化
 *
 * 插件页的「用户意图」（`enabledPlugins`）要落盘，因为引擎的激活标记是另一份真相，
 * 两边要对账。扩展没有这个维度：**磁盘上有什么就是什么**，没有"启用/停用"这回事
 * （要么打开它的界面，要么不打开）。把扫描结果缓存到 localStorage 只会造出
 * 「删了目录但界面还显示」的假象，而那正是最费劲的一类问题。
 *
 * 唯一有状态的是**服务进程**（运行/停止），而它的真相在主进程里，
 * 这里只是它的一份读缓存（`services`），每次刷新都整体覆盖。
 */
interface ExtensionsState {
  extensions: InstalledExtension[];
  /** 有目录但清单坏掉的扩展（目录名），页面要如实列出来 */
  skipped: string[];
  extensionsRoot: string;
  /** 拿不到扩展能力的原因（Web 端 / 目录不可读） */
  error: string | null;
  /** 装错结构的提示（非致命；目前只有"清单直接躺在根目录"这一种） */
  hint: string | null;
  loaded: boolean;
  refreshing: boolean;
  /** 服务状态：id → 状态（含最近日志） */
  services: Record<string, ExtensionServiceStatus>;

  refresh: () => Promise<void>;
  /**
   * 安装随应用分发的示例扩展（一键就有东西可试）。
   *
   * 存在的理由：扩展能力的第一道门槛是"得先有一个扩展"。让用户自己找目录、
   * 复制、改路径、再回来点重新扫描——任何一步没做对，界面就表现为"功能好像没生效"。
   */
  installSample: () => Promise<void>;
  /**
   * 确保扫描跑过一次（幂等、带单飞）。
   *
   * 产物面板要判断"有没有扩展认领这份产物"，但它出现在消息流里、每个产物都会调一次
   * ——不能每次都发一条 IPC。所以这里只保证「扫过一次」，重复调用共用同一个 promise。
   */
  ensureLoaded: () => Promise<void>;
  refreshServices: () => Promise<void>;
  startService: (extensionId: string) => Promise<void>;
  stopService: (extensionId: string) => Promise<void>;
}

/**
 * 单飞中的扫描 promise（见 `ensureLoaded`）。模块级而不是 store 字段：
 * 它是"正在飞的那一次请求"，不是可观察状态，放进 state 只会多一个没人用的键。
 */
let pendingScan: Promise<void> | null = null;

export const useExtensionsStore = create<ExtensionsState>()((set, get) => ({  extensions: [],
  skipped: [],
  extensionsRoot: '',
  error: null,
  hint: null,
  loaded: false,
  refreshing: false,
  services: {},

  refresh: async () => {
    set({ refreshing: true });
    try {
      const result = await platform.extensionsScan();
      set({
        extensions: result.extensions,
        skipped: result.skipped,
        extensionsRoot: result.extensionsRoot,
        error: result.error ?? null,
        hint: result.hint ?? null,
        loaded: true,
        refreshing: false,
      });
      // 扫描完顺手拉一次服务状态：新装的扩展可能带 service，
      // 不拉的话卡片上的按钮会在"启动/停止"之间闪烁一次
      await get().refreshServices();
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        hint: null,
        loaded: true,
        refreshing: false,
      });
    }
  },

  /**
   * 单飞：并发的 `ensureLoaded` 共用同一个 promise。   *
   * 产物面板里每个产物都会调一次 —— 没有这层去重，一次打开含 20 个产物的会话
   * 会打出 20 条 `extensions:scan`。
   */
  ensureLoaded: async () => {
    if (get().loaded) return;
    if (!pendingScan) pendingScan = get().refresh();
    const shared = pendingScan;
    try {
      await shared;
    } finally {
      if (pendingScan === shared) pendingScan = null;
    }
  },

  installSample: async () => {
    const result = await platform.installSampleExtension();
    if (!result.ok) {
      toast.error(result.error ?? '示例扩展安装失败');
      return;
    }
    toast.success('示例扩展已安装');
    await get().refresh();
  },

  refreshServices: async () => {
    const list = await platform.extensionServiceStatuses();
    const next: Record<string, ExtensionServiceStatus> = {};
    for (const status of list) next[status.id] = status;
    set({ services: next });
  },

  startService: async (extensionId: string) => {
    const result = await platform.startExtensionService(extensionId);
    if (result.status) {
      set((s) => ({ services: { ...s.services, [extensionId]: result.status! } }));
    } else {
      await get().refreshServices();
    }
    if (!result.ok) {
      // 启动失败的原因（越界 / 入口不存在 / fork 报错）必须抛到界面上：
      // 静默失败会让人以为"点了但没反应"，然后反复点。
      toast.error(result.error ?? '扩展服务启动失败');
    }
  },

  stopService: async (extensionId: string) => {
    const result = await platform.stopExtensionService(extensionId);
    if (result.status) {
      set((s) => ({ services: { ...s.services, [extensionId]: result.status! } }));
    } else {
      await get().refreshServices();
    }
    if (!result.ok) toast.error(result.error ?? '扩展服务停止失败');
  },
}));
