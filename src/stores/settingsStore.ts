import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { zustandStorage } from '@/platform';
import {
  DEFAULT_GATEWAY,
  DEFAULT_STATUS,
  STORAGE_KEYS,
} from '@/lib/constants';
import { DEFAULT_BINDINGS, DEFAULT_WAKE_ACCELERATOR } from '@/lib/shortcuts';
import type { ShortcutId } from '@/lib/shortcuts';
import { metaForEdit } from '@/lib/syncStamp';
import type {
  ConnectionStatus,
  DesktopConfig,
  ProcessDetailLevel,
  Settings,
  SyncMeta,
  TranscriptionConfig,
} from '@/types';

interface SettingsState {
  settings: Settings;
  /** 当前连接状态（由 ConnectionManager 同步写入） */
  status: ConnectionStatus;
  /**
   * **同步元数据兄弟切片**（批次 4）。
   *
   * `Settings` 不带 `SyncMeta`（`src/types/settings.ts` 是纯 `Settings`），而引擎
   * `stampOf` 要用实体上的 `rev` / `updatedAt` / `deletedAt` 做 LWW。缺元数据的话
   * 每条 settings 版本的 `updatedAt` 恒为空串 → 服务端按 EPOCH 处理 → **每条 settings
   * push 都被判 stale**。
   *
   * 做成**兄弟切片**（与其它 store 的 `tombstones` 同类）而不是塞进 `Settings`：
   * 后者会污染全局类型；而且「把同步元数据放在实体旁边」是既有形态。
   *
   * **必须持久化**：不做「重启后 `updatedAt = now`」的懒补偿——那会在「设备 A 离线
   * 期间 B 改过设置」时用 A 的当前时间压过 B 的改动（丢改动）。它随
   * `nanowork.settings` 一起落盘（进 `partialize`），**零 electron 改动、零新 key**。
   */
  syncMeta: SyncMeta;
  setSettings: (patch: Partial<Settings>) => void;
  setStatus: (status: ConnectionStatus) => void;
  reset: () => void;
  /**
   * 设置/覆盖工作空间显示别名（侧边栏分组标题）。
   * alias 为空字符串视为清除（恢复为该分组的默认名）。
   * 注意：只改 settings 内的 alias 表，绝不写回任何 session.workdir，
   * 这正是「重命名工作空间」与旧版「编辑路径」的本质差异。
   *
   * `fallback` 传该分组「未设别名时的默认显示名」：与之相同则不占表项。
   * 自动任务分组（key 形如 `__cron__:xxx`）的默认名不是路径末级目录名，
   * 必须显式传入，否则判等会失配、表项永远清不掉。
   * 不传时按 workdir 路径处理（取 dirBasename）。
   */
  setWorkspaceAlias: (workdir: string, alias: string, fallback?: string) => void;
  /**
   * 登记一个「用过的工作空间」，让它在 0 个任务时也留在侧边栏分组里。
   *
   * 幂等：已在表内不重复写入（也不改变它在表中的位置——新登记追加在末尾）。
   * 空串忽略；`undefined` 不能传（没有「未指定」的工作空间可登记）。
   * 判重按**原样字符串**：这里不 import `workspaceLabel` 的路径判等——
   * 那会引入 settingsStore → workspaceLabel → …的依赖，而调用方
   * （`sessionsStore`）拿到的路径本来就来自同一个目录选择结果，字面量一致。
   */
  rememberWorkspace: (workdir: string) => void;
  /**
   * 从侧边栏列表里移除一个工作空间（只删登记，**不删目录、不删会话**）。
   * 目录与文件还在原处，下次给会话分配这个路径时会重新登记。
   */
  forgetWorkspace: (workdir: string) => void;
  /**
   * 把指定会话从侧边栏列表隐藏（「从列表中移除」用）。
   * 幂等：已在表内的 id 不会重复写入；不改动任何会话数据本身。
   */
  hideSessions: (ids: string[]) => void;
  /**
   * 改写某条快捷键的键位。
   *
   * `binding` 传 `null` = **恢复默认**（把表项删掉，而不是写回默认值——写回默认值会让
   * 「表里存着一条与默认完全相同的记录」，日后调整默认键位时这条记录会把新默认挡住）；
   * 传 `''` = **显式禁用**（表项保留，值为空串）；
   * 传与默认相同的键位串同样按恢复默认处理，理由同上。
   */
  setShortcut: (id: ShortcutId, binding: string | null) => void;
  /** 全部快捷键恢复默认（清空覆盖表） */
  resetShortcuts: () => void;
}

/** 语音转录默认配置：默认关闭（需用户显式配置模型后才会启用语音按钮） */
export const DEFAULT_TRANSCRIPTION: TranscriptionConfig = {
  enabled: false,
  endpoint: '',
  model: 'whisper-1',
  apiToken: '',
  language: 'zh',
};

/**
 * 桌面端默认配置（需与 electron/main.ts 的 DEFAULT_DESKTOP_CONFIG 保持一致）。
 * 主进程冷启动时会直接从同一份持久化文件回读，因此默认值两边必须对齐，
 * 否则首次启动（渲染层尚未写入 store 前）快捷键会落到不一致的键位。
 */
export const DEFAULT_DESKTOP: DesktopConfig = {
  // 默认关闭窗口 → 隐藏到托盘（微信/钉钉式后台常驻），符合"运行在后台"的预期
  closeToTray: true,
  // 默认唤起快捷键：Ctrl+Alt+S（S = nanowork）。
  // 字面量取自 `lib/shortcuts` 的 `DEFAULT_WAKE_ACCELERATOR`——注册表里
  // 「唤起/隐藏主窗口」那一行也用它，两处共用同一份事实才不会改一处漏一处。
  hotkey: DEFAULT_WAKE_ACCELERATOR,
  openAtLogin: false,
  showInDock: true,
};

const DEFAULT_SETTINGS: Settings = {
  gatewayEndpoint: DEFAULT_GATEWAY,
  apiToken: '',
  theme: 'system',
  /**
   * 工作步骤展示档位，默认「关键细节」（`key`）。
   *
   * 三档里没有一档能逐像素复刻现状，只能选**扰动最小**者：`key` 保留既有主线
   * 「流式中看到过程、结束后收起」，同时把琐碎读取收敛为一行汇总，对老用户是
   * 唯一「向任一方向移动都成立」的中间档（`full` 会改掉「结束后收起」，
   * `result` 会改掉「流式铺开看到动作」）。
   */
  processDetail: 'key',
  memoryEnabled: true,
  /**
   * 会话结束自动沉淀摘要。**默认开启**。
   *
   * 旧默认是 false，后果不是「少写一点记忆」，而是整个跨会话记忆链路从未被触发过
   * ——用户告诉 AI 自己的名字，新开会话依然一问三不知。自动沉淀是记忆功能的
   * 唯一写入源（另一处手动「记住这条」要用户主动点），把它默认关掉等于默认没有记忆。
   */
  autoSummarize: true,
  transcription: DEFAULT_TRANSCRIPTION,
  desktop: DEFAULT_DESKTOP,
  workspaceAliases: {},
  knownWorkspaces: [],
  sidebarCollapsed: false,
  hiddenSessions: [],
  // 空表 = 全部使用默认键位。刻意不写「默认值全集」：那样任何一次默认键位调整
  // 都会被这张表挡住，老用户永远收不到新的默认值。
  shortcuts: {},
};

/** 合法主题偏好值；未知值兜底为深色（读取侧归一化，防止存储被手工写入非法值） */
export function normalizeTheme(value: unknown): Settings['theme'] {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'dark';
}

/**
 * 合法工作步骤展示档位；未知值兜底为「关键细节」（`key`）。
 *
 * 读取侧归一化，防止存储被手工写入非法值后在渲染层拿到未知档位——缺省与非法
 * 都收敛到默认档，与 `normalizeTheme` 同一写法与口径。
 */
export function normalizeProcessDetail(value: unknown): ProcessDetailLevel {
  return value === 'result' || value === 'key' || value === 'full' ? value : 'key';
}

/**
 * 同步元数据的缺省值（`rev = 0` = 「迁移前的老数据、从未被改写过」）。
 *
 * 每次返回**新对象**而不是共享常量：该对象会被写进 state 并持久化，
 * 共享引用一旦被某处就地改动会串味。
 */
function defaultSyncMeta(): SyncMeta {
  return { rev: 0, updatedAt: '', updatedBy: '', deletedAt: null };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      status: DEFAULT_STATUS,
      syncMeta: defaultSyncMeta(),
      // 改动**可同步字段**（theme / 转录偏好 / 快捷键…）→ bump 同步元数据
      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch }, syncMeta: metaForEdit(s.syncMeta) })),
      // 连接态是**本机事实**，不进同步负载 → 不 bump（否则每次连接探测都涨 rev）
      setStatus: (status) => set({ status }),
      reset: () => set({ settings: DEFAULT_SETTINGS, status: DEFAULT_STATUS }),
      setWorkspaceAlias: (workdir, alias, fallback) =>
        set((s) => {
          const next = { ...(s.settings.workspaceAliases ?? {}) };
          const trimmed = alias.trim();
          // 判等基准：调用方给了 fallback 就用它；否则按路径末级目录名。
          // 一致的默认名不必占用表项，避免 mapping 表无限膨胀。
          const defaultLabel = fallback ?? dirBasename(workdir);
          if (trimmed && trimmed !== defaultLabel) next[workdir] = trimmed;
          else delete next[workdir];
          return { settings: { ...s.settings, workspaceAliases: next } };
        }),
      rememberWorkspace: (workdir) =>
        set((s) => {
          const path = workdir.trim();
          if (!path) return s;
          const current = s.settings.knownWorkspaces ?? [];
          // 幂等：已在表内直接返回原 state（不然每次启动水合都会白写一遍持久化）
          if (current.includes(path)) return s;
          return {
            settings: { ...s.settings, knownWorkspaces: [...current, path] },
          };
        }),
      forgetWorkspace: (workdir) =>
        set((s) => {
          const current = s.settings.knownWorkspaces ?? [];
          if (!current.includes(workdir)) return s;
          return {
            settings: {
              ...s.settings,
              knownWorkspaces: current.filter((p) => p !== workdir),
            },
          };
        }),
      hideSessions: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const current = s.settings.hiddenSessions ?? [];
          const merged = new Set([...current, ...ids]);
          // 幂等：没有新增时返回原 state，避免触发无意义的重渲染
          if (merged.size === current.length) return s;
          return {
            settings: { ...s.settings, hiddenSessions: Array.from(merged) },
          };
        }),
      setShortcut: (id, binding) =>
        set((s) => {
          const next: Partial<Record<ShortcutId, string>> = {
            ...(s.settings.shortcuts ?? {}),
          };
          // 与默认相同 = 恢复默认，删掉表项而不是写回默认值（理由见接口注释）
          if (binding === null || binding === DEFAULT_BINDINGS[id]) delete next[id];
          else next[id] = binding;
          // `shortcuts` 是可同步的「用户偏好」→ bump
          return { settings: { ...s.settings, shortcuts: next }, syncMeta: metaForEdit(s.syncMeta) };
        }),
      resetShortcuts: () =>
        // 清空快捷键表是改动**可同步字段**（对端应收到「恢复默认」）→ bump
        set((s) => ({ settings: { ...s.settings, shortcuts: {} }, syncMeta: metaForEdit(s.syncMeta) })),
    }),
    {
      name: STORAGE_KEYS.settings,
      storage: zustandStorage,
      // v13：新增 `processDetail`（工作步骤展示档位）
      version: 13,
      migrate: (persistedState) => {
        const state = persistedState as Partial<SettingsState> | undefined;
        if (state?.settings?.gatewayEndpoint?.includes(':8765')) {
          state.settings.gatewayEndpoint = DEFAULT_GATEWAY;
        }
        if (state?.settings) {
          // 旧版本可能持久化了已移除的 mode 字段，直接丢弃
          delete (state.settings as Partial<Settings> & { mode?: unknown }).mode;
          // v3：局部字段合并式迁移——保留已有字段值，仅补齐缺失字段的默认值，
          // 并对 theme 做合法性兜底（旧 'light'/'dark' 在新类型下依然合法）
          state.settings = {
            ...DEFAULT_SETTINGS,
            ...state.settings,
            theme: normalizeTheme(state.settings.theme),
          };
          // v4：转录配置是嵌套对象，浅合并拿不到内层默认值，需单独补齐，
          // 否则老用户升级后 settings.transcription 为 undefined，语音面板直接崩
          state.settings.transcription = {
            ...DEFAULT_TRANSCRIPTION,
            ...(state.settings.transcription ?? {}),
          };
          // v5：桌面端配置同为嵌套对象，浅合并同样拿不到内层默认值，需单独补齐，
          // 否则老用户升级后 settings.desktop 为 undefined，设置页与托盘联动会崩
          state.settings.desktop = {
            ...DEFAULT_DESKTOP,
            ...(state.settings.desktop ?? {}),
          };
          // v6：工作空间别名表——老用户从未持久化过这个字段，
          // 不补齐的话 SidebarNav 读出来是 undefined，调用 ?. 也能跑，
          // 但持久化文件里缺字段会让 "重命名后再清空" 这种边界看起来不一致
          state.settings.workspaceAliases = {
            ...(state.settings.workspaceAliases ?? {}),
          };
          // v7：侧边栏折叠状态。老用户没存过，归一化为布尔，
          // 避免持久化里残留 null / 字符串导致 SidebarNav 判定为「已收起」。
          state.settings.sidebarCollapsed = state.settings.sidebarCollapsed === true;
          // v8：侧边栏隐藏会话表。老用户没存过，归一化为数组——
          // SidebarNav 会直接对它做 includes/indexOf，残留 null 会直接抛错。
          state.settings.hiddenSessions = Array.isArray(
            state.settings.hiddenSessions,
          )
            ? state.settings.hiddenSessions
            : [];
          // v9：自动沉淀默认改为开启。老版本的 false 无法区分「用户显式关闭」与
          // 「吃了默认值」——而实际磁盘证据表明从未有任何记忆文件被写出，说明全部
          // 是后者。因此升级时统一提升为 true（migrate 每次版本变更只跑一次，
          // 用户升级后手动关掉不会再被覆盖）。详见 reports/memory-diagnosis-*.md。
          state.settings.autoSummarize = true;
          // v10：快捷键覆盖表。老用户没有这个字段，空表就是正确语义；
          // 仍要显式写入——读侧会对它做 `?? {}` 与展开，残留 null 会在展开时抛错。
          state.settings.shortcuts = {
            ...(state.settings.shortcuts ?? {}),
          };
          // v11：已用工作空间登记表。老用户没存过，空表即可——
          // 真正的补登记发生在 `sessionsStore.loadSessions`：它按现有会话的
          // workdir 逐个 remember，等于把「有任务的工作空间」全部恢复出来。
          state.settings.knownWorkspaces = Array.isArray(
            state.settings.knownWorkspaces,
          )
            ? state.settings.knownWorkspaces
            : [];
          // v13：工作步骤展示档位。它是 settings 内部的展示偏好（非顶层切片），
          // 老用户没有这个字段 → 上面浅合并已补默认 `key`；这里再统一过一遍归一化，
          // 让被手工写入的非法档位收敛到 `key`，避免渲染层拿到未知档位。
          state.settings.processDetail = normalizeProcessDetail(state.settings.processDetail);
        }
        if (state) {
          // v12：同步元数据兄弟切片。老用户没有它 → 补默认值（`rev = 0` = 从未改过）。
          // **不懒补偿成 `updatedAt = now`**：那会在「设备 A 离线期间 B 改过设置」时
          // 用 A 的当前时间压过 B 的改动（丢改动）。缺省即「从未改过」，让对端版本正常胜出。
          state.syncMeta = state.syncMeta ?? defaultSyncMeta();
        }
        return state ?? { settings: DEFAULT_SETTINGS, status: DEFAULT_STATUS, syncMeta: defaultSyncMeta() };
      },
      partialize: (s) => ({ settings: s.settings, status: s.status, syncMeta: s.syncMeta }),
    },
  ),
);

/**
 * 工作空间路径 → 显示名（统一 fallback，避免 SidebarNav 与 settingsStore 各写一份）。
 * 这样 settingsStore 能在「别名与默认名相同时自动剔除表项」，
 * SidebarNav 也能在「aliases 为空 map」时直接拿到 dirBasename，不用重复 split。
 */
function dirBasename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
