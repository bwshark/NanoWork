/**
 * 「添加模型 → 供应商」下拉的可选中性。
 *
 * 锁的是一条真实发生过的失效（2026-09-21）：下拉能展开、分组标题和供应商项都在，
 * 但**点任何一个供应商都没反应**，而且下拉框本身还是个空框（只剩右侧箭头）。
 *
 * 根因不在业务逻辑，在 MUI 的 SelectInput：它用 `React.Children.toArray` 收子节点，
 * 而 `toArray` **不展开 Fragment**。原先把「分组标题 + 该组 MenuItem」包在一个
 * `<Fragment>` 里返回，于是被 clone 上 `onClick` / `value` / `data-value` 的是那个
 * Fragment 本身，包在里面的 MenuItem 一个都没拿到：
 *
 * - 点击不触发 `onChange` → 选中值永远不变（「点了没反应」）；
 * - `displaySingle` 匹配不到选中项 → 框里渲染的是零宽字符（「内容不显示」）。
 *
 * 所以断言**不能**只看「菜单项渲染了没有」——DOM 本来就是全的。必须落到
 * 「Select 认不认这个子节点」这条判据上，也就是**回显文案**与**点击后的回显**。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { ThemeProvider } from '@mui/material';
import { ModelDialog } from '@/components/settings/ModelDialog';
import { MODEL_PROVIDERS } from '@/lib/modelProviders';
import { muiTheme } from '@/theme/muiTheme';
import { click, flush, mount, unmount } from './helpers/reactMount';

beforeEach(() => unmount());

function mountDialog(): void {
  mount(
    <ThemeProvider theme={muiTheme}>
      <ModelDialog open onClose={() => {}} onSubmit={async () => true} />
    </ThemeProvider>,
  );
}

/** Select 的显示层：MUI 把「被认领的那个选中项」的文案渲染在这里 */
function selectDisplay(): HTMLElement {
  const el = document.querySelector('.MuiSelect-select');
  expect(el, '供应商下拉框未渲染').toBeTruthy();
  return el as HTMLElement;
}

function displayText(): string {
  return (selectDisplay().textContent ?? '').replace(/\u200B/g, '').trim();
}

/**
 * 展开下拉。
 *
 * ⚠️ 必须是 `mousedown`：MUI 的 Select 在 mousedown 上开菜单（hijack 掉原生 focus 行为），
 * 派发 `click` 只会落空。
 */
async function openMenu(): Promise<void> {
  await act(async () => {
    selectDisplay().dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    );
  });
  await flush();
}

/**
 * 展开后的候选项。
 *
 * ⚠️ 不要用裸 `[role="option"]` 计数：Select 会把**所有**子节点都 clone 成
 * `role="option"`，连 `ListSubheader`（分组标题）也一样，于是计数里会多出分组数。
 * 只看真正的菜单项（`MenuItem` 渲染成 `li.MuiMenuItem-root`）。
 */
function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('li.MuiMenuItem-root'));
}

/** 分组标题（展开后必须还在：扁平化不能把分组挤掉） */
function groupHeaders(): string[] {
  return Array.from(document.querySelectorAll('.MuiListSubheader-root')).map(
    (n) => (n.textContent ?? '').trim(),
  );
}

describe('添加模型 · 供应商下拉', () => {
  it('默认供应商要回显出来（旧实现这里是个空框）', () => {
    mountDialog();
    expect(displayText()).toBe('DeepSeek 深度求索');
  });

  it('展开后点一个供应商，回显跟着变（旧实现点了没反应）', async () => {
    mountDialog();
    await openMenu();

    const openai = options().find((o) => (o.textContent ?? '').trim() === 'OpenAI');
    expect(openai, '菜单里没有 OpenAI 这个候选项').toBeTruthy();
    click(openai);
    await flush();

    expect(displayText()).toBe('OpenAI');
  });

  it('候选项一个都不能少：内置目录 + auto + 自定义 API', async () => {
    mountDialog();
    await openMenu();
    // 「自动匹配」「自定义 API」是目录之外的两个分支值，必须和内置供应商一起被认领，
    // 否则编辑 auto/自定义预设时下拉框无处可落（等于被迫改掉用户的路由规则）。
    expect(options()).toHaveLength(MODEL_PROVIDERS.length + 2);
  });

  it('分组标题一个都不能少（扁平化只改结构，不改呈现）', async () => {
    mountDialog();
    await openMenu();
    expect(groupHeaders()).toEqual(['官方直连', '聚合网关', '本地部署', '其他']);
  });
});
