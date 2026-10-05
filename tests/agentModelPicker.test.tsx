/**
 * 专家模型选择器（FR-2.3）。
 *
 * 只钉**渲染与提示**这一层：优先级与失效拦截的规则在
 * `tests/lib/agentBinding.test.ts` 里逐条覆盖，这里不重复。
 *
 * 三条断言各自对应一个「用户会误解」的场景：
 * 1. 留空显示的是 `Auto · <默认模型名>`（而不是空白）——不然用户不知道留空意味着什么；
 * 2. 选了已失效的预设时，**必须提示它会回落**（而不是安静地显示一个陌生 id）；
 * 3. 目录还没加载时**不能**报失效 —— 冷启动时那只是「还没拉到」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { AgentModelPicker } from '@/components/models/AgentModelPicker';
import { useModelsStore } from '@/stores/modelsStore';
import { click, mount, unmount } from './helpers/reactMount';
import type { ModelInfo } from '@/types';

/**
 * 打开 MUI `Select` 必须派发 **mousedown**（不是 click）：它的开合挂在
 * `onMouseDown` 上，只点 click 时菜单根本不会挂载，随后查 `[role="option"]`
 * 只会拿到空数组——症状看起来像「选项没渲染」，实际是「菜单没打开」。
 */
function openSelect(el: Element | null | undefined): void {
  expect(el).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

const MODELS: ModelInfo[] = [
  { id: 'default', label: '默认', model: 'gpt-4o' },
  { id: 'qwen', label: '通义千问', model: 'qwen-max' },
];

function render(value?: string) {
  const onChange = vi.fn<(m: string) => void>();
  const host = mount(<AgentModelPicker value={value} onChange={onChange} />);
  return { host, onChange };
}

/** MUI Select 的当前显示文本 */
function selectedText(host: HTMLElement): string {
  return (host.querySelector('.MuiSelect-select')?.textContent ?? '').trim();
}

beforeEach(() => {
  useModelsStore.setState({ models: MODELS, loading: false });
  // 打开下拉才会触发目录刷新；jsdom 里它会打到 platform，换掉
  vi.spyOn(useModelsStore.getState(), 'refresh').mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  unmount();
  // MUI 过渡的 setTimeout 不归 React 管，不等就会「全绿但 exit=1」
  await new Promise((r) => setTimeout(r, 400));
});

describe('展示', () => {
  it('留空显示 Auto + 默认模型名（而不是空白）', () => {
    const { host } = render(undefined);
    expect(selectedText(host)).toBe('Auto · gpt-4o');
  });

  it('已绑定的预设按「预设名 · 模型名」显示', () => {
    const { host } = render('qwen');
    expect(selectedText(host)).toBe('通义千问 · qwen-max');
  });

  it('默认态说明写着「留空 = 跟随会话」', () => {
    const { host } = render(undefined);
    expect(host.textContent).toContain('跟随会话选择');
  });
});

describe('失效预设', () => {
  it('绑定了一个不在目录里的预设 → 提示会回落，而不是装作正常', () => {
    const { host } = render('gone');
    expect(host.textContent).toContain('已不在模型目录里');
    expect(host.textContent).toContain('回落到默认模型');
    // 原始值仍然显示出来（不能让用户以为「本来就没绑」）
    expect(selectedText(host)).toContain('gone');
  });

  it('⚠️ 目录还没加载时不判失效', () => {
    // 冷启动瞬间目录为空，此时标红会让每次启应用都吓用户一跳，
    // 而且他什么也做不了（选项还没到）
    useModelsStore.setState({ models: [], loading: true });
    const { host } = render('qwen');
    expect(host.textContent).not.toContain('已不在模型目录里');
    expect(host.textContent).toContain('跟随会话选择');
  });
});

describe('选择', () => {
  it('选中一个预设后回调带回它的 id', () => {
    const { host, onChange } = render(undefined);
    openSelect(host.querySelector(".MuiSelect-select"));
    const items = Array.from(document.querySelectorAll('[role="option"]'));
    const hit = items.find((el) => (el.textContent ?? '').includes('通义千问'));
    expect(hit, `菜单里应有「通义千问」：${items.map((i) => i.textContent).join(' / ')}`).toBeTruthy();

    click(hit);
    expect(onChange).toHaveBeenCalledWith('qwen');
  });

  it('选「Auto」回调带回空串（＝不绑定），而不是 undefined', () => {
    // 约定见 `Agent` 类型注释：清空传空串，`'' ?? b.model` 才能真的清掉
    const { host, onChange } = render('qwen');
    openSelect(host.querySelector(".MuiSelect-select"));
    const items = Array.from(document.querySelectorAll('[role="option"]'));
    const hit = items.find((el) => (el.textContent ?? '').startsWith('Auto'));
    expect(hit).toBeTruthy();

    click(hit);
    expect(onChange).toHaveBeenCalledWith('');
  });
});
