import { create } from 'zustand';

/**
 * 设置弹窗的分区 id（= 左侧菜单项）。
 *
 * 命名与「侧边栏 / 路由」解耦：分区是**弹窗内部**的概念，弹窗关掉它就没了，
 * 因此刻意不放进 `ROUTES`——路由是「用户当前在哪」，分区是「上次翻到设置的第几页」，
 * 把分区塞进 URL 会让「关弹窗」变成一次路由回退，进而和侧边栏高亮打架。
 */
export type SettingsSectionId =
  | 'general'
  | 'shortcuts'
  | 'connection'
  | 'memory'
  | 'persona'
  | 'assistant'
  | 'plugins'
  | 'data'
  | 'about';

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
   */
  openSettings: (section?: SettingsSectionId) => void;
  closeSettings: () => void;
  setSection: (section: SettingsSectionId) => void;
}

/** 默认分区：与 `openSettings()` 的不传参语义保持一致，避免两处各写一个字面量 */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

export const useSettingsUiStore = create<SettingsUiState>()((set) => ({
  open: false,
  section: DEFAULT_SETTINGS_SECTION,
  openSettings: (section) =>
    set({ open: true, section: section ?? DEFAULT_SETTINGS_SECTION }),
  closeSettings: () => set({ open: false }),
  setSection: (section) => set({ section }),
}));
