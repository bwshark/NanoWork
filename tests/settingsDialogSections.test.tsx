/**
 * 设置弹窗的「左菜单 → 右内容」联动。
 *
 * 锁的是一条**真实发生过的失效**：左侧菜单渲染正常，右侧永远是一片空白。
 * 根因不在业务逻辑，而在布局——MUI 的 `MuiDialog-paper`（`scroll="paper"`，默认值）
 * 自带 `display:flex; flex-direction:column`，弹窗的 sx 只覆盖了 `display`，漏了方向，
 * 于是左右两栏变成**上下堆叠**：左侧菜单 `height:100%` 吃掉整高，右侧内容区被
 * `flex:1`（basis 0）压成 0 高，再被 Paper 的 `overflow:hidden` 裁掉。
 *
 * 这类 bug 的可怕之处在于**DOM 是全的**——内容确实渲染了，只是没有高度。
 * 所以断言必须分两层：
 *
 * 1. **内容存在性**：每个菜单项都要渲染出各自的内容（防止分区漏挂组件）；
 * 2. **布局方向**：Paper 的最终 `flex-direction` 必须是 `row`——
 *    只查 DOM 结构永远查不出这个 bug，必须落到计算样式上。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { SETTINGS_NAV_ITEMS } from '@/components/settings/settingsNav';
import { useSettingsUiStore } from '@/stores/settingsUiStore';
import type { SettingsSectionId } from '@/stores/settingsUiStore';
import { click, dialogRoot, flush, mount, unmount } from './helpers/reactMount';

/**
 * 每个分区的**内容锚点**：只出现在右侧内容区、不出现在左侧菜单里的文案。
 * 这样「锚点存在」才等价于「内容渲染了」——若拿菜单标签断言，
 * 左侧菜单自己就能让断言通过，等于什么都没验证。
 */
const CONTENT_ANCHORS: Record<SettingsSectionId, string> = {
  general: '外观',
  // 「按键绑定」是快捷键列表的表头，只出现在右侧内容区
  shortcuts: '按键绑定',
  connection: '网关连接',
  memory: '记忆注入',
  persona: '身份文件与提示词模板都在这里外置维护',
  // 「自定义模型」是卡片标题；左侧菜单项只有「模型」两个字，不会误命中
  models: '自定义模型',
  assistant: '配置 IM 频道',
  plugins: '引擎已激活',
  data: '数据落点',
  // 「账户」分区用 `useNavigate`（未登录入口跳登录页），故弹窗需挂在 Router 下（见 renderDialog）
  account: '跨设备同步',
  about: '运行环境',
};

/**
 * 挂载设置弹窗。
 *
 * 必须包一层 `MemoryRouter`：批次 4 的「账户」分区内含「登录 / 注册」入口，它用
 * `useNavigate()` 跳 `/auth`——没有 Router 上下文会在渲染时抛错，整棵弹窗都渲染不出来。
 */
function renderDialog(): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <SettingsDialog />
    </MemoryRouter>,
  );
}

/** 右侧内容栏 = 左侧菜单 `<nav>` 的兄弟节点（弹窗的两栏是同层 flex 子项） */
function rightPanel(): HTMLElement {
  const nav = dialogRoot().querySelector('nav[aria-label="配置项"]');
  expect(nav, '左侧配置项菜单未渲染').toBeTruthy();
  const panel = nav!.nextElementSibling;
  expect(panel, '右侧内容栏未渲染').toBeTruthy();
  return panel as HTMLElement;
}

/**
 * 按文案取左侧菜单项。
 *
 * 不能复用 `buttonByText`：MUI 的 `ListItemButton` 渲染成 `role="button"` 的 div
 * 而不是 `<button>`，按标签名查会全部落空。
 */
function navItem(label: string): HTMLElement | null {
  const nav = dialogRoot().querySelector('nav[aria-label="配置项"]');
  if (!nav) return null;
  const candidates = Array.from(
    nav.querySelectorAll('[role="button"], button'),
  ) as HTMLElement[];
  return candidates.find((el) => (el.textContent ?? '').trim() === label) ?? null;
}

/** 弹窗 Paper：jsdom 下 role="dialog" 可能落在 Paper 本身或其容器上，两种都兜住 */
function dialogPaper(): HTMLElement {
  const root = dialogRoot();
  return (root.querySelector('.MuiDialog-paper') ?? root) as HTMLElement;
}

beforeEach(() => {
  unmount();
  useSettingsUiStore.setState({ open: true, section: 'general' });
});

describe('设置弹窗分区联动', () => {
  it('左侧菜单按 SETTINGS_NAV_ITEMS 全量渲染', () => {
    renderDialog();
    for (const id of Object.keys(SETTINGS_NAV_ITEMS) as SettingsSectionId[]) {
      expect(navItem(SETTINGS_NAV_ITEMS[id].label), `${id} 菜单项缺失`).toBeTruthy();
    }
  });

  it('点击每个菜单项，右侧都渲染出对应内容', async () => {
    renderDialog();
    await flush();

    for (const id of Object.keys(SETTINGS_NAV_ITEMS) as SettingsSectionId[]) {
      const label = SETTINGS_NAV_ITEMS[id].label;
      click(navItem(label));
      await flush();

      expect(
        useSettingsUiStore.getState().section,
        `点击「${label}」未切到分区 ${id}`,
      ).toBe(id);
      expect(
        rightPanel().textContent,
        `分区「${label}」右侧内容为空（或锚点缺失）`,
      ).toContain(CONTENT_ANCHORS[id]);
    }
  });

  it('弹窗两栏是水平并排，不是上下堆叠', () => {
    renderDialog();
    // 这条正是「左侧有菜单、右侧全空」的根因：column 会把右栏压成 0 高。
    // jsdom 会按 emotion 注入的样式做层叠计算，拿到的就是最终生效值。
    expect(getComputedStyle(dialogPaper()).flexDirection).toBe('row');
  });
});

/**
 * 第二个「左菜单有、右侧全空」的形态——这次不是布局，是 `section` 落了非法值。
 *
 * 失效路径很隐蔽：把 `openSettings` 直接当 `onClick` 传给按钮时，MUI 的
 * `ListItemButton` 会带着 `MouseEvent` 调用它。`(section?: X) => void` 恰好可以
 * 赋值给 `() => void`，**编译期完全看不见多出来的那个实参**；运行期 `section`
 * 变成一个事件对象，于是三处同时坏掉：左侧无高亮（`item.id === section` 恒假）、
 * 标题取不到 `label`、`SectionBody` 落到 `default` 返回 `null`。
 *
 * 断言落在「界面是否可读」而不是「store 里存了什么」——因为真正让用户看见的
 * 是前者，只查 store 也无法解释截图里为什么连标题都是空的。
 */
describe('设置弹窗的默认分区', () => {
  // 先挪到别的分区，才能证明 openSettings 真的把它改回来了
  beforeEach(() => {
    useSettingsUiStore.setState({ open: false, section: 'about' });
  });

  it('不传分区打开 → 回到「通用」，且右侧渲染出通用内容', async () => {
    useSettingsUiStore.getState().openSettings();
    expect(useSettingsUiStore.getState().section).toBe('general');
    expect(useSettingsUiStore.getState().open).toBe(true);

    renderDialog();
    await flush();

    const panel = rightPanel().textContent ?? '';
    expect(panel, '分区标题没显示「通用」').toContain('通用');
    expect(panel, '通用分区内容未渲染').toContain(CONTENT_ANCHORS.general);
  });

  it('被当成 onClick 直传（收到 MouseEvent）也不会打开成空白', async () => {
    const openSettings = useSettingsUiStore.getState().openSettings;
    openSettings(new MouseEvent('click') as unknown as SettingsSectionId);

    renderDialog();
    await flush();

    expect(
      useSettingsUiStore.getState().section,
      '事件对象被当成分区 id 存了下来',
    ).toBe('general');

    const panel = rightPanel().textContent ?? '';
    expect(panel, '右侧面板是空白：标题无文案').toContain('通用');
    expect(panel, '右侧内容区为空').toContain(CONTENT_ANCHORS.general);
  });

  it('未知 id 折回「通用」，合法 id 照常生效（深链不受影响）', () => {
    const openSettings = useSettingsUiStore.getState().openSettings;

    openSettings('nope' as unknown as SettingsSectionId);
    expect(useSettingsUiStore.getState().section).toBe('general');

    openSettings('memory');
    expect(useSettingsUiStore.getState().section).toBe('memory');
  });
});
