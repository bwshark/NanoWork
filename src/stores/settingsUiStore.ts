import { create } from 'zustand';

/**
 * 分区 id（= 左侧菜单项）。**数组是唯一事实源**：`SettingsSectionId` 由它推导，
 * 运行时校验也读它——类型与校验共用一份数据，才不会随时间漂移。
 *
 * 命名与「侧边栏 / 路由」解耦：分区是**弹窗内部**的概念，弹窗关掉它就没了，
 * 因此刻意不放进 `ROUTES`——路由是「用户当前在哪」，分区是「上次翻到设置的第几页」，
 * 把分区塞进 URL 会让「关弹窗」变成一次路由回退，进而和侧边栏高亮打架。
 */
export const SETTINGS_SECTION_IDS = [
  'general',
  'shortcuts',
  'connection',
  'memory',
  'persona',
  'models',
  'assistant',
  'plugins',
  'data',
  // 用量（FR-11.1）：只读报表，回答「这台机器上跑了多少 token」。
  // 挂在「数据与安全」组里而不是「功能」组——它不是一项可以开关的能力，
  // 而是对已发生事实的查看，与「数据管理」同类。
  'usage',
  // 诊断（FR-11.2 / FR-11.3 的出口）：回答「东西在哪 / 有多少 / 怎么带走」。
  // 与「用量」「数据管理」同组：三者看的都是**本机已发生的事实**。
  'diagnostics',
  'account',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

interface SettingsUiState {
  /** 弹窗是否展开 */
  open: boolean;
  /** 当前分区（关闭弹窗后保留，便于「刚才改到哪」的连续性） */
  section: SettingsSectionId;
  /**
   * 打开设置弹窗。
   *
   * 不传分区时**回到「通用」**：这是绝大多数入口的语义（点侧边栏「设置」是想
   * 找设置，不是想续上一次的编辑）。传分区时按传入值定位——给「记忆溢出提示 →
   * 直达记忆分区」这类深链留的出口。
   *
   * 实现上对参数做了运行时校验，见 `isSettingsSectionId`。
   */
  openSettings: (section?: SettingsSectionId) => void;
  closeSettings: () => void;
  setSection: (section: SettingsSectionId) => void;
}

/** 默认分区：与 `openSettings()` 的不传参语义保持一致，避免两处各写一个字面量 */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

/**
 * 校验一个值是否真的是分区 id。
 *
 * 存在的理由不是「防御外部输入」，而是拦住**类型系统看不见的调用错误**：
 * 若把 `openSettings` 直接当 `onClick` 传给按钮（MUI 的 `ListItemButton`
 * 会带着事件对象调用它），`(section?: X) => void` 恰好可以赋值给 `() => void`，
 * 编译期毫无反应；运行期 `section` 变成一个 `MouseEvent`——左侧菜单无高亮
 * （`item.id === section` 恒假）、标题取不到 `label`、右侧 `switch` 落到 `default`
 * 返回 `null`。三处同时坏掉，表现为**一片空白**，且 DOM 查询查不出原因。
 *
 * 与其要求每个调用点都记得别直传，不如在这里把非法值折回默认分区：
 * 最差也不过是落在「通用」，不会给出一片谁也解释不了的空白。
 */
function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return (
    typeof value === 'string' &&
    (SETTINGS_SECTION_IDS as readonly string[]).includes(value)
  );
}

export const useSettingsUiStore = create<SettingsUiState>()((set) => ({
  open: false,
  section: DEFAULT_SETTINGS_SECTION,
  openSettings: (section) =>
    set({
      open: true,
      // 非法值（事件对象 / 未知 id）一律折回「通用」
      section: isSettingsSectionId(section) ? section : DEFAULT_SETTINGS_SECTION,
    }),
  closeSettings: () => set({ open: false }),
  setSection: (section) =>
    set({
      section: isSettingsSectionId(section) ? section : DEFAULT_SETTINGS_SECTION,
    }),
}));
